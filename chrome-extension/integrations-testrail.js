/**
 * integrations-testrail.js — TestRail: push suites/cases, read existing suites for de-duplication.
 * Split out of integrations.js, which keeps CircuitBreaker + IntegrationManager.
 *
 * Load after integrations.js. The classes are published on the global object so
 * background.js / options.js keep using them by bare name.
 */
(function () {
  // Browser: integrations.js published these on the global. Node (tests): require it.
  const { CircuitBreaker, IntegrationManager } =
    (typeof module !== 'undefined' && module.exports) ? require('./integrations.js') : globalThis;

// TestRail Integration
class TestRailIntegration {
  /**
   * Field length limits for TestRail API
   */
  static FIELD_LIMITS = {
    title: 250,
    refs: 250,
    custom_steps: 5000,
    custom_expected: 5000,
    custom_preconds: 5000,
    custom_testdata: 5000
  };

  constructor(settings) {
    this.baseUrl = settings.testrailUrl;
    this.username = settings.testrailUsername;
    this.apiKey = settings.testrailApiKey;
    this.projectId = settings.testrailProjectId;
    this.sectionName = settings.testrailSection || 'QAtalyst_Automation';
    this.suiteMode = null; // Will be detected: 1 = single suite, 2 = single suite + baselines, 3 = multiple suites

    // Pre-encode authentication header (encode ONCE, reuse for all API calls)
    // Using HTTP Basic Authentication: Authorization: Basic base64(username:apiKey)
    this.authHeader = 'Basic ' + btoa(`${this.username}:${this.apiKey}`);

    // Caching to reduce API calls
    this.suiteCache = new Map(); // suiteName -> suiteId
    this.sectionCache = new Map(); // `${suiteId}:${sectionName}` -> sectionId

    // Rate limiting
    this.lastRequestTime = 0;
    this.minRequestInterval = 3000; // Minimum 3 seconds between requests (conservative for strict instances)
    this.requestQueue = Promise.resolve();

    // Batch upload configuration (ultra-conservative for strict TestRail instances)
    this.batchSize = 1; // Upload 1 test case at a time (prevents concurrent auth attempts)
    this.batchDelay = 10000; // 10 seconds delay between batches (prevents account lockout)

    // Circuit breaker for resilience
    this.circuitBreaker = new CircuitBreaker({
      name: 'TestRail',
      failureThreshold: 5,
      resetTimeout: 120000 // 2 minutes
    });

    // Upload cancellation and progress tracking
    this.cancelFlag = false;
    this.uploadProgress = {
      current: 0,
      total: 0,
      phase: 'idle'
    };
  }

  /**
   * Cancel ongoing upload
   */
  cancelUpload() {
    this.cancelFlag = true;
    console.log('🛑 Upload cancellation requested');
  }

  /**
   * Reset cancellation flag
   */
  resetCancellation() {
    this.cancelFlag = false;
  }

  /**
   * Get current upload progress
   */
  getProgress() {
    return { ...this.uploadProgress };
  }

  /**
   * Update progress and notify UI
   */
  updateProgress(current, total, phase = 'uploading') {
    this.uploadProgress = { current, total, phase };

    // Send progress update to background script for UI notification
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({
        type: 'UPLOAD_PROGRESS',
        progress: { current, total, phase }
      }).catch(() => {
        // Ignore if no listeners
      });
    }
  }

  /**
   * Parse retry delay from response (header or error message)
   * TestRail returns "Retry after X seconds" in error messages
   */
  async parseRetryDelay(response, attempt) {
    // Check Retry-After header first
    const retryAfterHeader = response.headers.get('Retry-After');
    if (retryAfterHeader) {
      return parseInt(retryAfterHeader) * 1000;
    }

    // Parse from error message (TestRail pattern: "Retry after X seconds")
    try {
      const errorData = await response.clone().json();
      const errorMsg = errorData.error || '';
      const retryMatch = errorMsg.match(/Retry after (\d+) seconds/);

      if (retryMatch && retryMatch[1]) {
        return parseInt(retryMatch[1], 10) * 1000;
      }
    } catch (e) {
      // JSON parse failed, use default
    }

    // Default exponential backoff with jitter
    const baseDelay = Math.pow(2, attempt) * 1000;
    const jitter = Math.random() * baseDelay * 0.1; // ±10% jitter
    return baseDelay + jitter;
  }

  /**
   * Enhanced rate-limited fetch with circuit breaker and smart retry
   */
  async rateLimitedFetch(url, options, retries = 3, timeout = 30000) {
    // Wrap with circuit breaker for resilience
    return this.circuitBreaker.execute(async () => {
      // Queue the request to ensure sequential execution
      return this.requestQueue = this.requestQueue.then(async () => {
        for (let attempt = 0; attempt < retries; attempt++) {
          let timeoutId;
          try {
            // Wait for rate limit
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastRequestTime;
            if (timeSinceLastRequest < this.minRequestInterval) {
              await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest));
            }

            this.lastRequestTime = Date.now();

            // Create abort controller for timeout
            const controller = new AbortController();
            timeoutId = setTimeout(() => controller.abort(), timeout);

            const response = await fetch(url, {
              ...options,
              signal: controller.signal
            });

            clearTimeout(timeoutId);

            // Handle rate limiting (429) with smart retry delay parsing
            if (response.status === 429) {
              const waitTime = await this.parseRetryDelay(response, attempt);
              console.warn(`⏱️  Rate limited by TestRail. Waiting ${Math.round(waitTime/1000)}s before retry (attempt ${attempt + 1}/${retries})`);
              await new Promise(resolve => setTimeout(resolve, waitTime));
              continue;
            }

            // Handle 401 authentication errors (don't retry)
            if (response.status === 401) {
              const errorText = await response.text();
              let errorDetail = 'Invalid credentials';
              try {
                const errorJson = JSON.parse(errorText);
                errorDetail = errorJson.error || errorDetail;
              } catch (e) {
                // Not JSON
              }

              // Check if it's a rate limit lockout
              if (errorDetail.includes('maximum number of failed login attempts') || errorDetail.includes('try again in')) {
                throw new Error(`TestRail account temporarily locked: ${errorDetail}\n\n🔒 Your TestRail account has been locked due to rate limiting.\n\n✅ What to do:\n1. Wait 10-15 minutes for the lockout to expire\n2. Do NOT retry immediately - this will extend the lockout\n3. When retrying, export in smaller batches (5-10 test cases max)\n4. Check your credentials are correct in Settings > Integrations\n\n💡 Note: Some test cases were not uploaded. You can re-export just the failed ones after waiting.`);
              }

              throw new Error(`Authentication failed: ${errorDetail}\n\nPlease verify your TestRail credentials in Settings > Integrations.`);
            }

            return response;
          } catch (error) {
            // Clear timeout on error
            if (timeoutId) {
              clearTimeout(timeoutId);
            }

            // Handle timeout errors
            if (error.name === 'AbortError') {
              console.warn(`⏱️  Request timeout after ${timeout}ms (attempt ${attempt + 1}/${retries})`);
              if (attempt === retries - 1) {
                throw new Error(`Request timeout after ${timeout}ms. TestRail API may be slow or unresponsive.`);
              }
              // Retry on timeout
              const baseDelay = Math.pow(2, attempt) * 1000;
              const jitter = Math.random() * baseDelay * 0.1;
              const waitTime = baseDelay + jitter;
              await new Promise(resolve => setTimeout(resolve, waitTime));
              continue;
            }

            // Don't retry authentication or lockout errors
            if (attempt === retries - 1 || error.message.includes('Authentication failed') || error.message.includes('TestRail account temporarily locked')) {
              throw error;
            }

            // Exponential backoff with jitter for network errors
            const baseDelay = Math.pow(2, attempt) * 1000;
            const jitter = Math.random() * baseDelay * 0.1; // ±10% jitter
            const waitTime = baseDelay + jitter;
            console.warn(`⚠️  Request failed, retrying in ${Math.round(waitTime)}ms... (attempt ${attempt + 1}/${retries})`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        }
      });
    });
  }

  /**
   * Sanitize text by removing problematic characters
   * @param {string} text - Text to sanitize
   * @returns {string} Sanitized text
   */
  static sanitizeText(text) {
    if (!text || typeof text !== 'string') {
      return text;
    }

    // Remove control characters (except newlines and tabs)
    let sanitized = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // Replace problematic Unicode characters
    sanitized = sanitized.replace(/[\u2028\u2029]/g, '\n'); // Line/paragraph separators

    // Replace smart quotes and other special characters with standard ones
    sanitized = sanitized
      .replace(/[\u2018\u2019]/g, "'") // Smart single quotes
      .replace(/[\u201C\u201D]/g, '"') // Smart double quotes
      .replace(/\u2013/g, '-') // En dash
      .replace(/\u2014/g, '--') // Em dash
      .replace(/\u2026/g, '...') // Ellipsis
      .replace(/\u00A0/g, ' '); // Non-breaking space

    // Trim excessive whitespace
    sanitized = sanitized.replace(/\s+/g, ' ').trim();

    return sanitized;
  }

  /**
   * Truncate text to specified length
   * @param {string} text - Text to truncate
   * @param {number} maxLength - Maximum length
   * @param {boolean} addEllipsis - Whether to add ellipsis
   * @returns {string} Truncated text
   */
  static truncateText(text, maxLength, addEllipsis = true) {
    if (!text || text.length <= maxLength) {
      return text;
    }

    const ellipsis = addEllipsis ? '...' : '';
    const truncateLength = maxLength - ellipsis.length;

    // Try to truncate at a word boundary
    let truncated = text.substring(0, truncateLength);
    const lastSpace = truncated.lastIndexOf(' ');

    if (lastSpace > truncateLength * 0.8) {
      truncated = truncated.substring(0, lastSpace);
    }

    return truncated + ellipsis;
  }

  /**
   * Validate and sanitize test case data
   * @param {Object} testCase - Test case data to validate
   * @returns {Object} Validated and sanitized test case data
   */
  static validateTestCaseData(testCase) {
    const validated = { ...testCase };

    // Sanitize and truncate title
    if (validated.title) {
      const originalTitle = validated.title;
      validated.title = this.sanitizeText(validated.title);
      validated.title = this.truncateText(validated.title, this.FIELD_LIMITS.title);

      if (originalTitle.length > this.FIELD_LIMITS.title) {
        console.warn(`⚠️  Title truncated from ${originalTitle.length} to ${this.FIELD_LIMITS.title} characters: "${validated.title}"`);
      }
    } else {
      validated.title = 'Untitled Test Case';
    }

    // Sanitize and truncate text fields
    const textFields = ['steps', 'expected', 'custom_test_steps', 'custom_expected_results',
                       'custom_steps', 'custom_expected', 'custom_preconds', 'custom_testdata',
                       'refs', 'reference'];

    for (const field of textFields) {
      if (validated[field]) {
        validated[field] = this.sanitizeText(validated[field]);

        // Apply field-specific length limits
        if (field === 'refs' || field === 'reference') {
          validated[field] = this.truncateText(validated[field], this.FIELD_LIMITS.refs, false);
        } else if (field.includes('steps')) {
          const originalLength = validated[field].length;
          validated[field] = this.truncateText(validated[field], this.FIELD_LIMITS.custom_steps);
          if (originalLength > this.FIELD_LIMITS.custom_steps) {
            console.warn(`⚠️  ${field} truncated from ${originalLength} to ${this.FIELD_LIMITS.custom_steps} characters`);
          }
        } else if (field.includes('expected')) {
          const originalLength = validated[field].length;
          validated[field] = this.truncateText(validated[field], this.FIELD_LIMITS.custom_expected);
          if (originalLength > this.FIELD_LIMITS.custom_expected) {
            console.warn(`⚠️  ${field} truncated from ${originalLength} to ${this.FIELD_LIMITS.custom_expected} characters`);
          }
        } else if (field === 'custom_preconds') {
          validated[field] = this.truncateText(validated[field], this.FIELD_LIMITS.custom_preconds);
        } else if (field === 'custom_testdata') {
          validated[field] = this.truncateText(validated[field], this.FIELD_LIMITS.custom_testdata);
        }
      }
    }

    // Ensure required fields have at least "NA"
    const requiredFields = ['custom_test_steps', 'custom_expected_results', 'steps', 'expected'];
    for (const field of requiredFields) {
      if (!validated[field] || validated[field].trim() === '') {
        validated[field] = 'NA';
      }
    }

    return validated;
  }

  /**
   * Get authentication headers for TestRail API
   * Uses pre-encoded auth header from constructor (no re-encoding)
   */
  getAuthHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': this.authHeader
    };
  }

  /**
   * F14: fetch existing test cases for this project so generation can dedupe
   * against them (avoid re-proposing what the team already maintains). Returns
   * [{ id, title }]. Best-effort: returns [] on any error or missing config.
   * Handles both the paginated ({cases:[...]}) and legacy (array) responses.
   */
  /**
   * Fetch the existing suite for deduplication.
   *
   * F14: this made ONE request and kept only title + preconditions. TestRail
   * paginates get_cases at 250, so on any real project the "existing suite" was
   * its first page — a duplicate on page two was never detected. And it mapped
   * every failure (auth, 500, network) onto `[]`, which downstream read as
   * "the team has no existing tests", the most dangerous possible default.
   *
   * Now: follows pagination to exhaustion, keeps the fields needed to compare
   * BEHAVIOUR rather than only titles, and reports failure as failure.
   *
   * @returns {Promise<{cases: object[], ok: boolean, error?: string, pages: number}>}
   */
  async getCases(suiteId, { maxPages = 40 } = {}) {
    if (!this.baseUrl || !this.projectId) {
      return { cases: [], ok: false, error: 'TestRail is not configured', pages: 0 };
    }
    const out = [];
    let offset = 0, pages = 0;
    const LIMIT = 250;

    try {
      while (pages < maxPages) {
        let url = `${this.baseUrl}/index.php?/api/v2/get_cases/${this.projectId}&limit=${LIMIT}&offset=${offset}`;
        if (suiteId) url += `&suite_id=${suiteId}`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const response = await fetch(url, { method: 'GET', headers: this.getAuthHeaders(), signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
          const error = `TestRail get_cases failed: HTTP ${response.status}`;
          console.warn(`⚠️ ${error}`);
          // Partial results are still usable, but the caller MUST know the
          // import was incomplete so it doesn't claim uniqueness it can't prove.
          return { cases: out, ok: false, error, pages };
        }

        const data = await response.json();
        const batch = Array.isArray(data) ? data : (Array.isArray(data.cases) ? data.cases : []);
        out.push(...batch);
        pages++;

        // TestRail returns {_links:{next}} on paginated responses; older
        // instances return a bare array (no pagination at all).
        const hasNext = !Array.isArray(data) && data._links && data._links.next;
        if (!hasNext && batch.length < LIMIT) break;
        offset += LIMIT;
      }

      return { cases: out.map(c => TestRailIntegration.normalizeExistingCase(c)).filter(c => c.title), ok: true, pages };
    } catch (e) {
      console.warn('⚠️ TestRail get_cases error:', e.message);
      return { cases: out.map(c => TestRailIntegration.normalizeExistingCase(c)).filter(c => c.title), ok: false, error: e.message, pages };
    }
  }

  /**
   * F14: map a TestRail case onto the canonical fields the duplicate checks read,
   * so an existing case can be compared by BEHAVIOUR (steps, outcome) and not
   * just by an exactly matching title.
   */
  static normalizeExistingCase(c) {
    if (!c || typeof c !== 'object') return { title: '' };
    // TestRail stores steps either as a text blob or as a structured
    // custom_steps_separated array of {content, expected}.
    const sep = Array.isArray(c.custom_steps_separated) ? c.custom_steps_separated : [];
    const steps = sep.length
      ? sep.map(s => String(s.content || '').trim()).filter(Boolean)
      : String(c.custom_steps || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const expected = sep.length
      ? sep.map(s => String(s.expected || '').trim()).filter(Boolean).join('; ')
      : String(c.custom_expected || '');
    return {
      id: c.id ? `C${c.id}` : '',
      title: c.title || '',
      description: c.custom_preconds || '',
      preconditions: c.custom_preconds || '',
      steps,
      expected_result: expected,
      refs: c.refs || '',
      sectionId: c.section_id,
      suiteId: c.suite_id,
      _source: 'testrail'
    };
  }

  /**
   * Test connection to TestRail with simple API call
   * Uses direct fetch (no retries, no circuit breaker) to avoid counting as multiple auth attempts
   */
  async testConnection() {
    if (!this.baseUrl || !this.username || !this.apiKey) {
      throw new Error('TestRail URL, username, and API key are required');
    }

    try {
      // Use simple fetch with 10-second timeout (no retries, no circuit breaker)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(`${this.baseUrl}/index.php?/api/v2/get_user`, {
        method: 'GET',
        headers: this.getAuthHeaders(),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        let errorDetail = `HTTP ${response.status}`;

        try {
          const errorData = await response.json();
          errorDetail = errorData.error || errorDetail;
        } catch (e) {
          // Not JSON, use text
          try {
            errorDetail = await response.text() || errorDetail;
          } catch (e2) {
            // Can't read body
          }
        }

        if (response.status === 401) {
          throw new Error(`❌ Authentication Failed (401)\n\n${errorDetail}\n\nPlease verify:\n✓ Username is your TestRail email address\n✓ API Key is from TestRail > My Settings > API Keys\n✓ API Key is not expired\n✓ Account has API access enabled`);
        }

        if (response.status === 403) {
          throw new Error(`❌ Access Forbidden (403)\n\n${errorDetail}\n\nYour account may not have API access permissions.`);
        }

        if (response.status === 404) {
          throw new Error(`❌ TestRail Not Found (404)\n\nPlease check the TestRail URL is correct:\n${this.baseUrl}`);
        }

        throw new Error(`Connection test failed (${response.status}): ${errorDetail}`);
      }

      // Success - return user info to confirm auth worked
      const userData = await response.json();
      console.log(`✅ TestRail connection successful - authenticated as: ${userData.email || userData.name || 'user'}`);

      return {
        success: true,
        user: userData.email || userData.name,
        message: 'Connection successful'
      };

    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Connection timeout after 10 seconds. Please check:\n- TestRail URL is correct\n- You have network access to TestRail\n- TestRail is not down');
      }

      // Re-throw our custom errors as-is
      if (error.message.includes('Authentication Failed') || error.message.includes('Access Forbidden')) {
        throw error;
      }

      // Network or other errors
      throw new Error(`TestRail connection failed: ${error.message}\n\nPlease check your network connection and TestRail URL.`);
    }
  }

  /**
   * Detect project's suite mode
   * @returns {number} 1 = single suite, 2 = single suite + baselines, 3 = multiple suites
   */
  async detectSuiteMode() {
    if (this.suiteMode !== null) {
      return this.suiteMode; // Already detected
    }

    try {
      const response = await this.rateLimitedFetch(
        `${this.baseUrl}/index.php?/api/v2/get_project/${this.projectId}`,
        { headers: this.getAuthHeaders() }
      );

      if (!response.ok) {
        const errorText = await response.text();

        // Handle authentication errors specifically
        if (response.status === 401) {
          let errorDetail = errorText;
          try {
            const errorJson = JSON.parse(errorText);
            errorDetail = errorJson.error || errorText;
          } catch (e) {
            // Not JSON
          }
          throw new Error(`Authentication failed: ${errorDetail}\n\nPlease verify your TestRail credentials in Settings > Integrations.`);
        }

        console.warn(`Failed to get project info: ${response.status}, defaulting to mode detection via API calls`);
        return null;
      }

      const project = await response.json();
      this.suiteMode = project.suite_mode || 1;
      console.log(`TestRail project suite_mode detected: ${this.suiteMode}`);
      return this.suiteMode;
    } catch (error) {
      // Re-throw authentication errors, log others as warnings
      if (error.message.includes('Authentication failed')) {
        throw error;
      }
      console.warn(`Failed to detect suite mode: ${error.message}, will try to detect during upload`);
      return null;
    }
  }

  /**
   * Get or create a test suite for the project
   */
  async getOrCreateSuite(suiteName = 'QAtalyst Generated Tests') {
    // Check cache first
    if (this.suiteCache.has(suiteName)) {
      console.log(`Using cached suite ID for "${suiteName}"`);
      return this.suiteCache.get(suiteName);
    }

    try {
      // Get existing suites
      const response = await this.rateLimitedFetch(
        `${this.baseUrl}/index.php?/api/v2/get_suites/${this.projectId}`,
        { headers: this.getAuthHeaders() }
      );

      if (!response.ok) {
        const errorText = await response.text();

        // Handle authentication errors
        if (response.status === 401) {
          let errorDetail = errorText;
          try {
            const errorJson = JSON.parse(errorText);
            errorDetail = errorJson.error || errorText;
          } catch (e) {
            // errorText is not JSON, use as-is
          }
          throw new Error(`Authentication failed: ${errorDetail}\n\nPlease verify your TestRail credentials in Settings > Integrations:\n- Username should be your TestRail email\n- API Key should be generated from TestRail > My Settings > API Keys`);
        }

        // If project uses single repository mode (no suites), return null
        if (response.status === 400 || response.status === 403 || errorText.includes('single repository') || errorText.includes('single suite')) {
          console.log('TestRail project uses single repository mode (no suites)');
          this.suiteCache.set(suiteName, null);
          return null;
        }
        throw new Error(`Failed to get suites: ${response.status} - ${errorText}`);
      }

      const data = await response.json();

      // Handle different response formats
      let suites = data;
      if (!Array.isArray(data)) {
        // Response might be wrapped in an object
        if (data.suites && Array.isArray(data.suites)) {
          suites = data.suites;
        } else if (data._embedded && Array.isArray(data._embedded.suites)) {
          suites = data._embedded.suites;
        } else {
          throw new Error('Unexpected API response format: suites is not an array');
        }
      }

      // Find existing suite
      const existingSuite = suites.find(s => s.name === suiteName);
      if (existingSuite) {
        this.suiteCache.set(suiteName, existingSuite.id);
        return existingSuite.id;
      }

      // Try to create new suite
      const createResponse = await this.rateLimitedFetch(
        `${this.baseUrl}/index.php?/api/v2/add_suite/${this.projectId}`,
        {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify({
            name: suiteName,
            description: 'Test cases generated by QAtalyst AI'
          })
        }
      );

      if (!createResponse.ok) {
        const errorText = await createResponse.text();

        // If creation fails with 403, the project is in single repository mode
        if (createResponse.status === 403 || errorText.includes('single suite') || errorText.includes('not permitted')) {
          console.log('TestRail project uses single repository mode - cannot create suites');
          this.suiteCache.set(suiteName, null);
          return null;
        }

        throw new Error(`Failed to create suite: ${createResponse.status} - ${errorText}`);
      }

      const newSuite = await createResponse.json();
      this.suiteCache.set(suiteName, newSuite.id);
      return newSuite.id;
    } catch (error) {
      // If error message indicates single repository mode, return null instead of throwing
      if (error.message.includes('single suite') || error.message.includes('not permitted')) {
        console.log('TestRail project uses single repository mode');
        this.suiteCache.set(suiteName, null);
        return null;
      }
      throw new Error(`Suite management failed: ${error.message}`);
    }
  }

  /**
   * Get or create a section within a suite
   */
  async getOrCreateSection(suiteId, sectionName) {
    // Check cache first
    const cacheKey = `${suiteId}:${sectionName}`;
    if (this.sectionCache.has(cacheKey)) {
      console.log(`Using cached section ID for suite ${suiteId}, section "${sectionName}"`);
      return this.sectionCache.get(cacheKey);
    }

    try {
      // Build URL - for single repository mode (suiteId = null), don't include suite_id
      let url = `${this.baseUrl}/index.php?/api/v2/get_sections/${this.projectId}`;
      if (suiteId !== null) {
        url += `&suite_id=${suiteId}`;
      }

      // Get existing sections
      const response = await this.rateLimitedFetch(url, { headers: this.getAuthHeaders() });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to get sections: ${response.status} - ${errorText}`);
      }

      const data = await response.json();

      // Handle different response formats
      let sections = data;
      if (!Array.isArray(data)) {
        // Response might be wrapped in an object
        if (data.sections && Array.isArray(data.sections)) {
          sections = data.sections;
        } else if (data._embedded && Array.isArray(data._embedded.sections)) {
          sections = data._embedded.sections;
        } else {
          throw new Error('Unexpected API response format: sections is not an array');
        }
      }

      // Find existing section
      const existingSection = sections.find(s => s.name === sectionName);
      if (existingSection) {
        this.sectionCache.set(cacheKey, existingSection.id);
        return existingSection.id;
      }

      // Create new section
      const createPayload = {
        name: sectionName,
        description: 'Test cases generated by QAtalyst AI'
      };

      // Only add suite_id if not in single repository mode
      if (suiteId !== null) {
        createPayload.suite_id = suiteId;
      }

      const createResponse = await this.rateLimitedFetch(
        `${this.baseUrl}/index.php?/api/v2/add_section/${this.projectId}`,
        {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify(createPayload)
        }
      );

      if (!createResponse.ok) {
        const errorText = await createResponse.text();
        throw new Error(`Failed to create section: ${createResponse.status} - ${errorText}`);
      }

      const newSection = await createResponse.json();
      this.sectionCache.set(cacheKey, newSection.id);
      return newSection.id;
    } catch (error) {
      throw new Error(`Section management failed: ${error.message}`);
    }
  }

  /**
   * Upload a single test case to TestRail
   */
  async uploadTestCase(sectionId, testCase) {
    try {
      // Validate and sanitize test case data first
      const validated = TestRailIntegration.validateTestCaseData({
        title: testCase.title || testCase.id,
        custom_preconds: testCase.preconditions || '',
        refs: testCase.jiraTicket || ''
      });

      // Format steps for TestRail
      const steps = testCase.steps.map((step, index) => ({
        content: typeof step === 'string' ? step : step.action || step,
        expected: testCase.expected_result || ''
      }));

      // Create test case
      const response = await this.rateLimitedFetch(
        `${this.baseUrl}/index.php?/api/v2/add_case/${sectionId}`,
        {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify({
            title: validated.title,
            template_id: 1, // Test Case (Steps)
            type_id: this.getTestTypeId(testCase.category),
            priority_id: this.getPriorityId(testCase.priority),
            custom_steps_separated: steps,
            custom_preconds: validated.custom_preconds,
            refs: validated.refs
          })
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`Failed to create test case: ${response.status} - ${errorData.error || 'Unknown error'}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Failed to upload test case "${testCase.title}":`, error);
      throw error;
    }
  }

  /**
   * Bulk upload multiple test cases to TestRail (reduces API calls)
   */
  async bulkUploadTestCases(sectionId, testCases, jiraTicket = null, fieldMappings = {}) {
    try {
      // Format all test cases for bulk upload
      const casesPayload = testCases.map(testCase => {
        // Validate and sanitize test case data first
        const validated = TestRailIntegration.validateTestCaseData({
          title: testCase.title || testCase.id,
          custom_preconds: testCase.preconditions || '',
          refs: jiraTicket || testCase.jiraTicket || ''
        });

        const steps = testCase.steps.map((step, index) => ({
          content: typeof step === 'string' ? step : step.action || step,
          expected: testCase.expected_result || ''
        }));

        const payload = {
          title: validated.title,
          template_id: 1, // Test Case (Steps)
          type_id: this.getTestTypeId(testCase.category),
          priority_id: this.getPriorityId(testCase.priority),
          custom_steps_separated: steps,
          custom_preconds: validated.custom_preconds,
          refs: validated.refs
        };

        // Apply custom field mappings
        for (const [qatalystField, mapping] of Object.entries(fieldMappings)) {
          // Handle both old format (string) and new format (object with field and value)
          let testrailField, fieldValue;
          if (typeof mapping === 'string') {
            // Old format: just the field ID
            testrailField = mapping;
            fieldValue = testCase[qatalystField];
          } else {
            // New format: object with field and value
            testrailField = mapping.field;
            // Use default value if specified, otherwise use test case value
            fieldValue = mapping.value || testCase[qatalystField];
          }

          if (fieldValue !== undefined && fieldValue !== null && fieldValue !== '') {
            // Convert boolean-like strings to actual booleans for boolean fields
            payload[testrailField] = this.convertFieldValue(fieldValue, testrailField);
          }
        }

        return payload;
      });

      // Use bulk add_cases API
      const response = await this.rateLimitedFetch(
        `${this.baseUrl}/index.php?/api/v2/add_cases/${sectionId}`,
        {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify({ cases: casesPayload })
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg = errorData.error || 'Unknown error';

        // Check if bulk API is not supported (older TestRail versions)
        if (response.status === 404 && errorMsg.includes('Unknown method')) {
          console.warn('TestRail bulk upload not supported, will use individual uploads');
          throw new Error('BULK_NOT_SUPPORTED'); // Special error code for graceful fallback
        }

        throw new Error(`Failed to bulk create test cases: ${response.status} - ${errorMsg}`);
      }

      return await response.json();
    } catch (error) {
      console.error('Failed to bulk upload test cases:', error);
      throw error;
    }
  }

  /**
   * Get existing test cases in a section for deduplication
   */
  /**
   * F14: paginated, and it reports whether the import actually completed.
   * Previously a single 250-case page, with every failure mapped to `[]` — so a
   * duplicate on page two was uploaded again, and an auth failure looked exactly
   * like an empty project.
   * @returns {Promise<{cases: object[], ok: boolean, error?: string}>}
   */
  async getExistingTestCases(sectionId, { maxPages = 40 } = {}) {
    const out = [];
    let offset = 0, pages = 0;
    const LIMIT = 250;
    try {
      while (pages < maxPages) {
        const response = await this.rateLimitedFetch(
          `${this.baseUrl}/index.php?/api/v2/get_cases/${this.projectId}&section_id=${sectionId}&limit=${LIMIT}&offset=${offset}`,
          { headers: this.getAuthHeaders() }
        );

        if (!response.ok) {
          const error = `HTTP ${response.status} fetching existing test cases`;
          console.warn(`⚠️  ${error}`);
          return { cases: out, ok: false, error };
        }

        const data = await response.json();
        const batch = Array.isArray(data) ? data : (data.cases || []);
        out.push(...batch);
        pages++;

        const hasNext = !Array.isArray(data) && data._links && data._links.next;
        if (!hasNext && batch.length < LIMIT) break;
        offset += LIMIT;
      }
      // F14: normalize here too. This path used to return RAW TestRail objects
      // while getCases() returned mapped ones, so the duplicate checks saw
      // title-only cases on the upload path and could never compare behaviour.
      // One import shape, one set of comparison rules.
      return { cases: out.map(c => TestRailIntegration.normalizeExistingCase(c)), ok: true };
    } catch (error) {
      console.warn('⚠️  Error fetching existing test cases:', error.message);
      return { cases: out.map(c => TestRailIntegration.normalizeExistingCase(c)), ok: false, error: error.message };
    }
  }

  /**
   * Deduplicate test cases by checking existing titles
   */
  async deduplicateTestCases(sectionId, testCases) {
    console.log('🔍 Checking for duplicate test cases...');

    // F14: consult the export ledger FIRST. A case we already confirmed writing
    // is skipped without a second request, and a case whose previous write timed
    // out is verified against the destination rather than blindly re-sent.
    let ledgerPlan = null, ledger = null;
    const LedgerCtor = (typeof ExportLedger !== 'undefined') ? ExportLedger
      : (typeof self !== 'undefined' && self.ExportLedger);
    if (LedgerCtor && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      try {
        ledger = new LedgerCtor(chrome.storage.local, `testrail:${this.projectId}:${sectionId}`);
        await ledger.load();
        ledgerPlan = ledger.plan(testCases);
      } catch (e) { console.warn('[TestRail] export ledger unavailable:', e.message); }
    }

    const res = await this.getExistingTestCases(sectionId);
    const existingCases = Array.isArray(res) ? res : (res.cases || []);
    const importOk = Array.isArray(res) ? true : res.ok;

    // F14: an import FAILURE is not an empty suite. Saying "no existing cases"
    // after a 401 is how the same case gets uploaded twice.
    if (!importOk) {
      console.warn('⚠️  Existing-case import was incomplete — duplicates may not be detected.');
    }

    if (existingCases.length === 0) {
      console.log(importOk
        ? '✅ No existing test cases found, will upload all'
        : '⚠️  Could not read existing test cases — uploading all, duplicates possible');
      return { toAdd: testCases, skipped: [], importOk, importError: importOk ? undefined : (res && res.error) };
    }

    // Create map of existing titles (case-insensitive)
    const caseMap = new Map(
      existingCases.map(c => [c.title.toLowerCase().trim(), c])
    );

    const toAdd = [];
    const skipped = [];

    // F14: reconcile uncertain writes against what the destination actually
    // holds before deciding to retry them.
    let candidates = testCases;
    if (ledgerPlan && ledger) {
      for (const done of ledgerPlan.alreadyExported) {
        skipped.push({
          title: done.testCase.title, existingId: done.remoteId,
          existingUrl: done.remoteId ? `${this.baseUrl}/index.php?/cases/view/${String(done.remoteId).replace(/^C/, '')}` : '',
          reason: 'Already exported in a previous run'
        });
      }
      const { confirmed, toSend } = ledger.reconcile(ledgerPlan.needsVerification, existingCases);
      for (const c of confirmed) {
        skipped.push({
          title: c.testCase.title, existingId: c.remoteId,
          existingUrl: '', reason: 'A previous export was uncertain but the case exists — not created again'
        });
      }
      candidates = ledgerPlan.toSend.concat(toSend);
      await ledger.save();
    }

    candidates.forEach(testCase => {
      const normalizedTitle = (testCase.title || '').toLowerCase().trim();
      if (caseMap.has(normalizedTitle)) {
        const existing = caseMap.get(normalizedTitle);
        skipped.push({
          title: testCase.title,
          existingId: existing.id,
          existingUrl: existing.id ? `${this.baseUrl}/index.php?/cases/view/${String(existing.id).replace(/^C/, '')}` : '',
          reason: 'Duplicate title'
        });
        return;
      }

      // F14: exact-title matching alone missed a paraphrase of a case already in
      // the suite ("User logs in" vs "Successful user login"). Fall back to the
      // shipped scenario-equivalence check, which also refuses to collapse
      // provably distinct pairs (opposite outcome, different actor/boundary).
      const equivalent = this.findEquivalentExisting(testCase, existingCases);
      if (equivalent) {
        skipped.push({
          title: testCase.title,
          existingId: equivalent.id,
          existingUrl: equivalent.id ? `${this.baseUrl}/index.php?/cases/view/${String(equivalent.id).replace(/^C/, '')}` : '',
          reason: 'Equivalent to an existing case'
        });
        return;
      }

      toAdd.push(testCase);
      // F14: extend the map with what we are about to upload, so two duplicates
      // WITHIN one batch don't both get created.
      if (normalizedTitle) caseMap.set(normalizedTitle, { id: '(this batch)', title: testCase.title });
      existingCases.push(testCase);
    });

    console.log(`✅ Deduplication complete: ${toAdd.length} to add, ${skipped.length} skipped as duplicates`);

    if (skipped.length > 0) {
      console.log(`⚠️  Skipped duplicate test cases:`);
      skipped.forEach(s => console.log(`   - "${s.title}" (ID: ${s.existingId})`));
    }

    return { toAdd, skipped, importOk, ledger };
  }

  /**
   * F14: find an existing case that already covers this scenario, beyond an
   * exactly matching title. Uses the shipped SemanticDuplicateDetector so the
   * export path applies the SAME equivalence rules as generation — including the
   * hard distinction checks, so an existing "Owner can delete" never suppresses
   * a new "Viewer cannot delete".
   * Returns null when the detector is unavailable (worker-only module).
   */
  findEquivalentExisting(testCase, existingCases) {
    const Detector = (typeof SemanticDuplicateDetector !== 'undefined') ? SemanticDuplicateDetector
      : (typeof self !== 'undefined' && self.SemanticDuplicateDetector);
    if (!Detector || !testCase) return null;
    const det = new Detector(0.75); // stricter than generation: this suppresses an upload
    for (const existing of existingCases) {
      if (!existing || !existing.title) continue;
      if (typeof Detector.distinctionReason === 'function' && Detector.distinctionReason(testCase, existing)) continue;
      const groups = det.detectDuplicates([testCase, existing]) || [];
      if (groups.some(g => (g.duplicates || []).length > 0)) return existing;
    }
    return null;
  }

  /**
   * Upload multiple test cases to TestRail
   */
  async uploadTestCases(testCases, jiraTicket = null, suiteName = null, fieldMappings = {}) {
    if (!this.baseUrl || !this.username || !this.apiKey || !this.projectId) {
      throw new Error('TestRail is not properly configured. Please check your settings.');
    }

    try {
      // Reset cancellation flag and initialize progress
      this.resetCancellation();
      this.updateProgress(0, testCases.length, 'initializing');

      // Warn about large uploads
      if (testCases.length > 10) {
        const estimatedTime = Math.ceil((testCases.length / this.batchSize) * this.batchDelay / 1000 / 60);
        console.warn(`⚠️  Uploading ${testCases.length} test cases will take approximately ${estimatedTime} minutes to prevent account lockout.`);
        console.warn(`💡 TestRail has strict rate limits. If upload fails, wait 10 minutes before retrying.`);
      }

      // Detect suite mode first (also validates credentials)
      const suiteMode = await this.detectSuiteMode();
      console.log(`Using TestRail suite mode: ${suiteMode || 'auto-detect'}`);

      let suiteId = null;

      // Handle based on suite mode
      if (suiteMode === 1 || suiteMode === 2) {
        // Single suite mode (with or without baselines) - no suite needed
        console.log('TestRail project uses single suite mode - skipping suite creation');
        suiteId = null;
      } else if (suiteMode === 3) {
        // Multiple suites mode - create or get suite
        console.log('TestRail project uses multiple suites mode - creating/finding suite');
        suiteId = await this.getOrCreateSuite(suiteName || `Jira Ticket: ${jiraTicket || 'Unknown'}`);
      } else {
        // Mode not detected, try to create suite and fall back if it fails
        console.log('Suite mode not detected - attempting suite creation with fallback');
        try {
          suiteId = await this.getOrCreateSuite(suiteName || `Jira Ticket: ${jiraTicket || 'Unknown'}`);
          if (suiteId === null) {
            console.log('Suite creation returned null - using single suite mode');
            this.suiteMode = 1; // Cache detection
          } else {
            this.suiteMode = 3; // Cache detection
          }
        } catch (error) {
          if (error.message.includes('not permitted') || error.message.includes('single suite')) {
            console.log('Suite creation failed - falling back to single suite mode');
            suiteId = null;
            this.suiteMode = 1; // Cache detection
          } else {
            throw error; // Re-throw if it's a different error
          }
        }
      }

      // Get or create section
      const sectionId = await this.getOrCreateSection(suiteId, this.sectionName);

      // Deduplicate test cases before uploading
      this.updateProgress(0, testCases.length, 'checking-duplicates');
      const { toAdd, skipped } = await this.deduplicateTestCases(sectionId, testCases);

      // Upload test cases using bulk API to reduce API calls
      const results = {
        success: [],
        failed: [],
        skipped: skipped,
        total: testCases.length
      };

      // If all test cases are duplicates, return early
      if (toAdd.length === 0) {
        console.log(`✅ All ${testCases.length} test cases already exist in TestRail (duplicates skipped)`);
        this.updateProgress(testCases.length, testCases.length, 'completed');
        return results;
      }

      console.log(`📤 Uploading ${toAdd.length} new test cases (${skipped.length} duplicates skipped)`);

      let accountLocked = false;

      try {
        // Bulk upload all test cases in a single API call with custom field mappings
        this.updateProgress(0, toAdd.length, 'bulk-uploading');
        console.log(`🚀 Attempting bulk upload of ${toAdd.length} test cases...`);

        const bulkResponse = await this.bulkUploadTestCases(sectionId, toAdd, jiraTicket, fieldMappings);

        // bulkResponse should be an array of created test cases
        const createdCases = Array.isArray(bulkResponse) ? bulkResponse : (bulkResponse.cases || []);

        createdCases.forEach((uploaded, index) => {
          results.success.push({
            id: uploaded.id,
            title: testCases[index]?.title || uploaded.title,
            url: `${this.baseUrl}/index.php?/cases/view/${uploaded.id}`
          });
        });

        // If some cases failed (less created than requested)
        if (createdCases.length < testCases.length) {
          for (let i = createdCases.length; i < testCases.length; i++) {
            results.failed.push({
              title: testCases[i].title,
              error: 'Failed to create (bulk upload partially succeeded)'
            });
          }
        }

        console.log(`✅ Bulk upload complete: ${createdCases.length}/${toAdd.length} succeeded`);
      } catch (error) {
        // If bulk upload fails entirely, fall back to batch uploads
        if (error.message !== 'BULK_NOT_SUPPORTED') {
          console.warn('Bulk upload failed, falling back to batch uploads:', error.message);
        }

        const totalBatches = Math.ceil(toAdd.length / this.batchSize);
        const estimatedTime = Math.ceil((totalBatches * this.batchDelay) / 1000 / 60); // minutes

        console.log(`📤 Uploading ${toAdd.length} test cases in batches of ${this.batchSize}`);
        console.log(`⏱️  Estimated time: ~${estimatedTime} minutes (${totalBatches} batches × ${this.batchDelay/1000}s delay)`);
        console.log(`💡 Tip: You can continue working while upload runs in background`);

        // Split test cases into batches
        for (let i = 0; i < toAdd.length; i += this.batchSize) {
          // Check if upload was cancelled
          if (this.cancelFlag) {
            console.warn(`🛑 Upload cancelled by user. ${toAdd.length - i} test cases remaining.`);
            this.updateProgress(results.success.length, toAdd.length, 'cancelled');
            break;
          }

          // Stop if account got locked
          if (accountLocked) {
            console.warn(`⚠️  Upload stopped due to rate limit. ${toAdd.length - i} test cases remaining.`);
            this.updateProgress(results.success.length, toAdd.length, 'rate-limited');
            break;
          }

          const batch = toAdd.slice(i, i + this.batchSize);
          const batchNumber = Math.floor(i / this.batchSize) + 1;
          const progress = Math.round((i / toAdd.length) * 100);

          // Update progress
          this.updateProgress(results.success.length, toAdd.length, 'uploading');

          console.log(`📦 Batch ${batchNumber}/${totalBatches} (${progress}% complete) - Uploading ${batch.length} test cases...`);

          // Upload all test cases in this batch concurrently (they'll be queued by rateLimitedFetch)
          const batchPromises = batch.map(async (testCase) => {
            try {
              let uploaded;
              if (fieldMappings && Object.keys(fieldMappings).length > 0) {
                uploaded = await this.uploadTestCaseWithCustomFields(sectionId, { ...testCase, jiraTicket }, fieldMappings);
              } else {
                uploaded = await this.uploadTestCase(sectionId, { ...testCase, jiraTicket });
              }
              return {
                success: true,
                locked: false,
                data: {
                  id: uploaded.id,
                  title: testCase.title,
                  url: `${this.baseUrl}/index.php?/cases/view/${uploaded.id}`
                }
              };
            } catch (uploadError) {
              // Check if account is locked
              const isLocked = uploadError.message.includes('temporarily locked') ||
                             uploadError.message.includes('maximum number of failed login attempts');

              return {
                success: false,
                locked: isLocked,
                data: {
                  title: testCase.title,
                  error: uploadError.message
                }
              };
            }
          });

          // Wait for all test cases in this batch to complete
          const batchResults = await Promise.all(batchPromises);

          // Process batch results
          batchResults.forEach(result => {
            if (result.locked) {
              accountLocked = true;
            }

            if (result.success) {
              results.success.push(result.data);
            } else {
              results.failed.push(result.data);
            }
          });

          console.log(`✅ Batch ${batchNumber} complete: ${batchResults.filter(r => r.success).length}/${batch.length} succeeded`);

          // Stop if account locked
          if (accountLocked) {
            break;
          }

          // Wait before starting next batch (unless this is the last batch)
          if (i + this.batchSize < toAdd.length) {
            console.log(`⏳ Waiting ${this.batchDelay/1000} seconds before next batch...`);
            await new Promise(resolve => setTimeout(resolve, this.batchDelay));
          }
        }

        const finalProgress = Math.round(((results.success.length + results.skipped.length) / testCases.length) * 100);
        console.log(`\n🎉 Upload ${accountLocked ? 'paused' : this.cancelFlag ? 'cancelled' : 'complete'}: ${results.success.length}/${toAdd.length} uploaded, ${results.skipped.length} skipped as duplicates (${finalProgress}% total)`);

        if (accountLocked) {
          console.warn(`⚠️  TestRail account locked. Wait 10 minutes then re-export to upload remaining ${toAdd.length - results.success.length - results.failed.length} test cases.`);
        }
      }

      // Update final progress
      const finalPhase = this.cancelFlag ? 'cancelled' : accountLocked ? 'rate-limited' : 'completed';
      this.updateProgress(results.success.length + results.skipped.length, testCases.length, finalPhase);

      return results;
    } catch (error) {
      throw new Error(`TestRail upload failed: ${error.message}`);
    }
  }

  /**
   * Convert field value to appropriate type based on field name
   */
  convertFieldValue(value, fieldName) {
    // If already a boolean, return as-is
    if (typeof value === 'boolean') {
      return value;
    }

    // Convert string values to appropriate types
    const stringValue = String(value).toLowerCase().trim();

    // Detect boolean fields (common patterns in TestRail)
    const isBooleanField = fieldName.toLowerCase().includes('is') ||
                          fieldName.toLowerCase().includes('automated') ||
                          fieldName.toLowerCase().includes('_flag') ||
                          fieldName.toLowerCase().includes('enable');

    if (isBooleanField) {
      // Convert common boolean representations
      if (stringValue === 'true' || stringValue === 'yes' || stringValue === '1' || stringValue === 'on') {
        return true;
      }
      if (stringValue === 'false' || stringValue === 'no' || stringValue === '0' || stringValue === 'off' || stringValue === '') {
        return false;
      }
    }

    // Try to convert to integer if it looks like one
    if (/^\d+$/.test(stringValue)) {
      return parseInt(stringValue, 10);
    }

    // Return original value for strings, arrays, objects
    return value;
  }

  /**
   * Map test case category to TestRail test type ID
   */
  getTestTypeId(category) {
    const typeMap = {
      'Positive': 1,      // Functional
      'Negative': 1,      // Functional
      'Edge': 7,          // Other
      'Integration': 2,   // Integration
      'Performance': 4,   // Performance
      'Security': 5,      // Security
      'Regression': 6     // Regression
    };
    return typeMap[category] || 1; // Default to Functional
  }

  /**
   * Map test case priority to TestRail priority ID
   */
  getPriorityId(priority) {
    const priorityMap = {
      'P0': 4, // Critical
      'P1': 3, // High
      'P2': 2, // Medium
      'P3': 1  // Low
    };
    return priorityMap[priority] || 2; // Default to Medium
  }

  /**
   * Fetch custom fields from TestRail
   */
  async getCustomFields() {
    try {
      const response = await this.rateLimitedFetch(
        `${this.baseUrl}/index.php?/api/v2/get_case_fields`,
        { headers: this.getAuthHeaders() }
      );

      if (!response.ok) {
        throw new Error(`Failed to get custom fields: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      throw new Error(`Failed to fetch custom fields: ${error.message}`);
    }
  }

  /**
   * Upload test case with custom field mappings
   */
  async uploadTestCaseWithCustomFields(sectionId, testCase, fieldMappings = {}) {
    try {
      // Validate and sanitize test case data first
      const validated = TestRailIntegration.validateTestCaseData({
        title: testCase.title || testCase.id,
        custom_preconds: testCase.preconditions || '',
        refs: testCase.jiraTicket || ''
      });

      // Format steps for TestRail
      const steps = testCase.steps.map((step, index) => ({
        content: typeof step === 'string' ? step : step.action || step,
        expected: testCase.expected_result || ''
      }));

      // Build base payload
      const payload = {
        title: validated.title,
        template_id: 1, // Test Case (Steps)
        type_id: this.getTestTypeId(testCase.category),
        priority_id: this.getPriorityId(testCase.priority),
        custom_steps_separated: steps,
        custom_preconds: validated.custom_preconds,
        refs: validated.refs
      };

      // Apply custom field mappings
      for (const [qatalystField, mapping] of Object.entries(fieldMappings)) {
        // Handle both old format (string) and new format (object with field and value)
        let testrailField, fieldValue;
        if (typeof mapping === 'string') {
          // Old format: just the field ID
          testrailField = mapping;
          fieldValue = testCase[qatalystField];
        } else {
          // New format: object with field and value
          testrailField = mapping.field;
          // Use default value if specified, otherwise use test case value
          fieldValue = mapping.value || testCase[qatalystField];
        }

        if (fieldValue !== undefined && fieldValue !== null && fieldValue !== '') {
          // Convert boolean-like strings to actual booleans for boolean fields
          payload[testrailField] = this.convertFieldValue(fieldValue, testrailField);
        }
      }

      // Create test case
      const response = await this.rateLimitedFetch(
        `${this.baseUrl}/index.php?/api/v2/add_case/${sectionId}`,
        {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify(payload)
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`Failed to create test case: ${response.status} - ${errorData.error || 'Unknown error'}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Failed to upload test case "${testCase.title}":`, error);
      throw error;
    }
  }
}

  const api = { TestRailIntegration };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(globalThis, api);
})();
