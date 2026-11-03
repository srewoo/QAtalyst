/**
 * integrations-testmgmt.js — Jira-native test management: Zephyr Scale, Zephyr Squad, Xray and Qmetry.
 * Split out of integrations.js, which keeps CircuitBreaker + IntegrationManager.
 *
 * Load after integrations.js. The classes are published on the global object so
 * background.js / options.js keep using them by bare name.
 */
(function () {
  // Browser: integrations.js published these on the global. Node (tests): require it.
  const { CircuitBreaker, IntegrationManager } =
    (typeof module !== 'undefined' && module.exports) ? require('./integrations.js') : globalThis;

/**
 * Zephyr Scale Integration (Jira Cloud)
 * API Docs: https://support.smartbear.com/zephyr-scale-cloud/api-docs/
 */
class ZephyrScaleIntegration {
  constructor(settings) {
    this.baseUrl = settings.zephyrScaleUrl || 'https://api.zephyrscale.smartbear.com/v2';
    this.apiToken = settings.zephyrScaleApiToken;
    this.projectKey = settings.zephyrScaleProjectKey;
    this.folderId = settings.zephyrScaleFolderId;

    // Rate limiting
    this.lastRequestTime = 0;
    this.minRequestInterval = 1000; // 1 second between requests
    this.requestQueue = Promise.resolve();

    // Circuit breaker for resilience
    this.circuitBreaker = new CircuitBreaker({
      name: 'ZephyrScale',
      failureThreshold: 5,
      resetTimeout: 120000 // 2 minutes
    });
  }

  /**
   * Parse retry delay from response (header or error message)
   */
  async parseRetryDelay(response, attempt) {
    const retryAfterHeader = response.headers.get('Retry-After');
    if (retryAfterHeader) {
      return parseInt(retryAfterHeader) * 1000;
    }

    // Default exponential backoff with jitter
    const baseDelay = Math.pow(2, attempt) * 1000;
    const jitter = Math.random() * baseDelay * 0.1;
    return baseDelay + jitter;
  }

  /**
   * Enhanced rate-limited fetch with circuit breaker and smart retry
   */
  async rateLimitedFetch(url, options, retries = 3) {
    return this.circuitBreaker.execute(async () => {
      return this.requestQueue = this.requestQueue.then(async () => {
        for (let attempt = 0; attempt < retries; attempt++) {
          try {
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastRequestTime;
            if (timeSinceLastRequest < this.minRequestInterval) {
              await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest));
            }

            this.lastRequestTime = Date.now();
            const response = await fetch(url, options);

            if (response.status === 429) {
              const waitTime = await this.parseRetryDelay(response, attempt);
              console.warn(`⏱️  Rate limited by Zephyr Scale. Waiting ${Math.round(waitTime/1000)}s before retry (attempt ${attempt + 1}/${retries})`);
              await new Promise(resolve => setTimeout(resolve, waitTime));
              continue;
            }

            return response;
          } catch (error) {
            if (attempt === retries - 1) {
              throw error;
            }
            const baseDelay = Math.pow(2, attempt) * 1000;
            const jitter = Math.random() * baseDelay * 0.1;
            const waitTime = baseDelay + jitter;
            console.warn(`⚠️  Request failed, retrying in ${Math.round(waitTime)}ms... (attempt ${attempt + 1}/${retries})`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        }
      });
    });
  }

  /**
   * Get authentication headers for Zephyr Scale API
   */
  getAuthHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiToken}`
    };
  }

  /**
   * Test connection to Zephyr Scale
   */
  async testConnection() {
    if (!this.apiToken || !this.projectKey) {
      throw new Error('Zephyr Scale API token and project key are required');
    }

    try {
      const response = await this.rateLimitedFetch(`${this.baseUrl}/folders?projectKey=${this.projectKey}&folderType=TEST_CASE&maxResults=1`, {
        headers: this.getAuthHeaders()
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error(
            `Authentication failed (401). ⚠️ IMPORTANT: You must use a Zephyr Scale API token, NOT an Atlassian API token!\n\n` +
            `How to get the correct token:\n` +
            `1. Open Jira and go to Zephyr Scale\n` +
            `2. Click Settings (⚙️) → API Access Tokens\n` +
            `3. Click "Create Access Token"\n` +
            `4. Copy the generated token (starts with "eyJ..." in JWT format)\n` +
            `5. Use that token here\n\n` +
            `Note: This is different from the Atlassian API token (which starts with "ATATT").`
          );
        }
        throw new Error(`Connection test failed with status: ${response.status}`);
      }

      return { success: true };
    } catch (error) {
      throw new Error(`Zephyr Scale connection failed: ${error.message}`);
    }
  }

  /**
   * Get or create a folder for organizing test cases
   */
  async getOrCreateFolder(folderName = 'QAtalyst Generated Tests') {
    try {
      // Get existing folders
      const response = await this.rateLimitedFetch(
        `${this.baseUrl}/folders?projectKey=${this.projectKey}&folderType=TEST_CASE`,
        { headers: this.getAuthHeaders() }
      );

      if (!response.ok) {
        throw new Error(`Failed to get folders: ${response.status}`);
      }

      const data = await response.json();
      const folders = data.values || [];

      // Find existing folder
      const existingFolder = folders.find(f => f.name === folderName);
      if (existingFolder) {
        return existingFolder.id;
      }

      // Create new folder
      const createResponse = await this.rateLimitedFetch(
        `${this.baseUrl}/folders`,
        {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify({
            projectKey: this.projectKey,
            name: folderName,
            folderType: 'TEST_CASE'
          })
        }
      );

      if (!createResponse.ok) {
        throw new Error(`Failed to create folder: ${createResponse.status}`);
      }

      const newFolder = await createResponse.json();
      return newFolder.id;
    } catch (error) {
      throw new Error(`Folder management failed: ${error.message}`);
    }
  }

  /**
   * Upload a single test case to Zephyr Scale
   */
  async uploadTestCase(testCase, fieldMappings = {}) {
    try {
      // Format test script (steps)
      const testScript = {
        type: 'STEP_BY_STEP',
        steps: testCase.steps.map((step, index) => ({
          index: index,
          description: typeof step === 'string' ? step : step.action || step,
          expectedResult: testCase.expected_result || ''
        }))
      };

      // Build base payload
      const payload = {
        projectKey: this.projectKey,
        name: testCase.title || testCase.id,
        objective: testCase.description || '',
        precondition: testCase.preconditions || '',
        status: 'Draft',
        priority: this.getPriorityName(testCase.priority),
        labels: [testCase.category || 'Functional'],
        testScript: testScript
      };

      // Add folder if specified
      if (this.folderId) {
        payload.folderId = this.folderId;
      }

      // Apply custom field mappings
      if (fieldMappings.customFields) {
        payload.customFields = {};
        for (const [qatalystField, zephyrField] of Object.entries(fieldMappings.customFields)) {
          if (testCase[qatalystField] !== undefined && testCase[qatalystField] !== null) {
            payload.customFields[zephyrField] = testCase[qatalystField];
          }
        }
      }

      // Link to Jira issue if available
      if (testCase.jiraTicket) {
        payload.issueLinks = [testCase.jiraTicket];
      }

      // Create test case
      const response = await this.rateLimitedFetch(
        `${this.baseUrl}/testcases`,
        {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify(payload)
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`Failed to create test case: ${response.status} - ${errorData.message || 'Unknown error'}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Failed to upload test case "${testCase.title}":`, error);
      throw error;
    }
  }

  /**
   * Upload multiple test cases to Zephyr Scale
   */
  async uploadTestCases(testCases, jiraTicket = null, folderName = null, fieldMappings = {}) {
    if (!this.apiToken || !this.projectKey) {
      throw new Error('Zephyr Scale is not properly configured. Please check your settings.');
    }

    try {
      // Get or create folder if needed
      if (folderName) {
        this.folderId = await this.getOrCreateFolder(folderName);
      }

      // Upload test cases
      const results = {
        success: [],
        failed: [],
        total: testCases.length
      };

      for (const testCase of testCases) {
        try {
          const uploaded = await this.uploadTestCase({ ...testCase, jiraTicket }, fieldMappings);
          results.success.push({
            id: uploaded.key,
            title: testCase.title,
            url: uploaded.url || `${this.baseUrl.replace('/v2', '')}/testcase/${uploaded.key}`
          });
        } catch (error) {
          results.failed.push({
            title: testCase.title,
            error: error.message
          });
        }
      }

      return results;
    } catch (error) {
      throw new Error(`Zephyr Scale upload failed: ${error.message}`);
    }
  }

  /**
   * Map priority to Zephyr Scale priority name
   */
  getPriorityName(priority) {
    const priorityMap = {
      'P0': 'High',
      'P1': 'High',
      'P2': 'Medium',
      'P3': 'Low'
    };
    return priorityMap[priority] || 'Medium';
  }

  /**
   * Fetch custom fields from Zephyr Scale
   */
  async getCustomFields() {
    try {
      const response = await this.rateLimitedFetch(
        `${this.baseUrl}/customfields`,
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
}

/**
 * Zephyr Squad Integration (Jira Server/Data Center)
 * API Docs: https://zfjsw.docs.apiary.io/
 */
class ZephyrSquadIntegration {
  constructor(settings) {
    this.jiraUrl = settings.zephyrSquadJiraUrl;
    this.username = settings.zephyrSquadUsername;
    this.apiToken = settings.zephyrSquadApiToken;
    this.projectKey = settings.zephyrSquadProjectKey;
    this.versionId = settings.zephyrSquadVersionId || -1; // -1 = Unscheduled

    // Rate limiting
    this.lastRequestTime = 0;
    this.minRequestInterval = 1000; // 1 second between requests
    this.requestQueue = Promise.resolve();

    // Circuit breaker for resilience
    this.circuitBreaker = new CircuitBreaker({
      name: 'ZephyrSquad',
      failureThreshold: 5,
      resetTimeout: 120000 // 2 minutes
    });
  }

  /**
   * Parse retry delay from response (header or error message)
   */
  async parseRetryDelay(response, attempt) {
    const retryAfterHeader = response.headers.get('Retry-After');
    if (retryAfterHeader) {
      return parseInt(retryAfterHeader) * 1000;
    }

    // Default exponential backoff with jitter
    const baseDelay = Math.pow(2, attempt) * 1000;
    const jitter = Math.random() * baseDelay * 0.1;
    return baseDelay + jitter;
  }

  /**
   * Enhanced rate-limited fetch with circuit breaker and smart retry
   */
  async rateLimitedFetch(url, options, retries = 3) {
    return this.circuitBreaker.execute(async () => {
      return this.requestQueue = this.requestQueue.then(async () => {
        for (let attempt = 0; attempt < retries; attempt++) {
          try {
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastRequestTime;
            if (timeSinceLastRequest < this.minRequestInterval) {
              await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest));
            }

            this.lastRequestTime = Date.now();
            const response = await fetch(url, options);

            if (response.status === 429) {
              const waitTime = await this.parseRetryDelay(response, attempt);
              console.warn(`⏱️  Rate limited by Zephyr Squad. Waiting ${Math.round(waitTime/1000)}s before retry (attempt ${attempt + 1}/${retries})`);
              await new Promise(resolve => setTimeout(resolve, waitTime));
              continue;
            }

            return response;
          } catch (error) {
            if (attempt === retries - 1) {
              throw error;
            }
            const baseDelay = Math.pow(2, attempt) * 1000;
            const jitter = Math.random() * baseDelay * 0.1;
            const waitTime = baseDelay + jitter;
            console.warn(`⚠️  Request failed, retrying in ${Math.round(waitTime)}ms... (attempt ${attempt + 1}/${retries})`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        }
      });
    });
  }

  /**
   * Get authentication headers for Zephyr Squad API
   */
  getAuthHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + btoa(`${this.username}:${this.apiToken}`)
    };
  }

  /**
   * Test connection to Zephyr Squad
   */
  async testConnection() {
    if (!this.jiraUrl || !this.username || !this.apiToken) {
      throw new Error('Jira URL, username, and API token are required');
    }

    try {
      const response = await this.rateLimitedFetch(`${this.jiraUrl}/rest/zapi/latest/util/project-list`, {
        headers: this.getAuthHeaders()
      });

      if (!response.ok) {
        throw new Error(`Connection test failed with status: ${response.status}`);
      }

      return { success: true };
    } catch (error) {
      throw new Error(`Zephyr Squad connection failed: ${error.message}`);
    }
  }

  /**
   * Get or create a test cycle
   */
  async getOrCreateCycle(cycleName = 'QAtalyst Generated Tests') {
    try {
      // Get project ID from project key
      const projectResponse = await this.rateLimitedFetch(
        `${this.jiraUrl}/rest/api/2/project/${this.projectKey}`,
        { headers: this.getAuthHeaders() }
      );

      if (!projectResponse.ok) {
        throw new Error(`Failed to get project: ${projectResponse.status}`);
      }

      const project = await projectResponse.json();
      const projectId = project.id;

      // Get existing cycles
      const response = await this.rateLimitedFetch(
        `${this.jiraUrl}/rest/zapi/latest/cycle?projectId=${projectId}&versionId=${this.versionId}`,
        { headers: this.getAuthHeaders() }
      );

      if (!response.ok) {
        throw new Error(`Failed to get cycles: ${response.status}`);
      }

      const cycles = await response.json();

      // Find existing cycle
      for (const [cycleId, cycleData] of Object.entries(cycles)) {
        if (cycleData.name === cycleName) {
          return cycleId;
        }
      }

      // Create new cycle
      const createResponse = await this.rateLimitedFetch(
        `${this.jiraUrl}/rest/zapi/latest/cycle`,
        {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify({
            name: cycleName,
            projectId: projectId,
            versionId: this.versionId,
            description: 'Test cases generated by QAtalyst AI'
          })
        }
      );

      if (!createResponse.ok) {
        throw new Error(`Failed to create cycle: ${createResponse.status}`);
      }

      const newCycle = await createResponse.json();
      return newCycle.id;
    } catch (error) {
      throw new Error(`Cycle management failed: ${error.message}`);
    }
  }

  /**
   * Create a Jira issue of type "Test"
   */
  async createTestIssue(testCase, fieldMappings = {}) {
    try {
      // Format description with steps
      let description = testCase.description || '';

      if (testCase.preconditions) {
        description += `\n\n*Preconditions:*\n${testCase.preconditions}`;
      }

      description += '\n\n*Test Steps:*\n';
      testCase.steps.forEach((step, index) => {
        const stepText = typeof step === 'string' ? step : step.action || step;
        description += `${index + 1}. ${stepText}\n`;
      });

      if (testCase.expected_result) {
        description += `\n*Expected Result:*\n${testCase.expected_result}`;
      }

      // Build base payload
      const payload = {
        fields: {
          project: { key: this.projectKey },
          summary: testCase.title || testCase.id,
          description: description,
          issuetype: { name: 'Test' },
          priority: { name: this.getPriorityName(testCase.priority) },
          labels: [testCase.category || 'Functional', 'QAtalyst']
        }
      };

      // Apply custom field mappings
      if (fieldMappings.customFields) {
        for (const [qatalystField, jiraField] of Object.entries(fieldMappings.customFields)) {
          if (testCase[qatalystField] !== undefined && testCase[qatalystField] !== null) {
            payload.fields[jiraField] = testCase[qatalystField];
          }
        }
      }

      // Link to Jira issue if available
      if (testCase.jiraTicket) {
        payload.fields.labels.push(testCase.jiraTicket);
      }

      // Create test issue
      const response = await this.rateLimitedFetch(
        `${this.jiraUrl}/rest/api/2/issue`,
        {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify(payload)
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`Failed to create test issue: ${response.status} - ${errorData.errorMessages?.join(', ') || 'Unknown error'}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Failed to create test issue "${testCase.title}":`, error);
      throw error;
    }
  }

  /**
   * Upload multiple test cases to Zephyr Squad
   */
  async uploadTestCases(testCases, jiraTicket = null, cycleName = null, fieldMappings = {}) {
    if (!this.jiraUrl || !this.username || !this.apiToken || !this.projectKey) {
      throw new Error('Zephyr Squad is not properly configured. Please check your settings.');
    }

    try {
      // Upload test cases
      const results = {
        success: [],
        failed: [],
        total: testCases.length
      };

      for (const testCase of testCases) {
        try {
          const uploaded = await this.createTestIssue({ ...testCase, jiraTicket }, fieldMappings);
          results.success.push({
            id: uploaded.key,
            title: testCase.title,
            url: `${this.jiraUrl}/browse/${uploaded.key}`
          });
        } catch (error) {
          results.failed.push({
            title: testCase.title,
            error: error.message
          });
        }
      }

      return results;
    } catch (error) {
      throw new Error(`Zephyr Squad upload failed: ${error.message}`);
    }
  }

  /**
   * Map priority to Jira priority name
   */
  getPriorityName(priority) {
    const priorityMap = {
      'P0': 'Highest',
      'P1': 'High',
      'P2': 'Medium',
      'P3': 'Low'
    };
    return priorityMap[priority] || 'Medium';
  }

  /**
   * Fetch custom fields from Jira
   */
  async getCustomFields() {
    try {
      const response = await this.rateLimitedFetch(
        `${this.jiraUrl}/rest/api/2/field`,
        { headers: this.getAuthHeaders() }
      );

      if (!response.ok) {
        throw new Error(`Failed to get custom fields: ${response.status}`);
      }

      const fields = await response.json();
      // Filter for custom fields only
      return fields.filter(f => f.custom);
    } catch (error) {
      throw new Error(`Failed to fetch custom fields: ${error.message}`);
    }
  }
}

/**
 * Xray Test Management Integration (Jira Cloud & Server)
 * API Docs: https://docs.getxray.app/display/XRAYCLOUD/REST+API
 */
class XrayIntegration {
  constructor(settings) {
    this.jiraUrl = settings.xrayJiraUrl;
    this.isCloud = settings.xrayIsCloud || false;
    this.username = settings.xrayUsername;
    this.apiToken = settings.xrayApiToken;
    this.clientId = settings.xrayClientId; // For Cloud
    this.clientSecret = settings.xrayClientSecret; // For Cloud
    this.projectKey = settings.xrayProjectKey;
    this.testTypeFieldId = settings.xrayTestTypeFieldId || 'customfield_10020';
    this.cloudToken = null; // Cached authentication token for Cloud

    // Rate limiting
    this.lastRequestTime = 0;
    this.minRequestInterval = 1000; // 1 second between requests
    this.requestQueue = Promise.resolve();

    // Circuit breaker for resilience
    this.circuitBreaker = new CircuitBreaker({
      name: 'Xray',
      failureThreshold: 5,
      resetTimeout: 120000 // 2 minutes
    });
  }

  /**
   * Parse retry delay from response (header or error message)
   */
  async parseRetryDelay(response, attempt) {
    const retryAfterHeader = response.headers.get('Retry-After');
    if (retryAfterHeader) {
      return parseInt(retryAfterHeader) * 1000;
    }

    // Default exponential backoff with jitter
    const baseDelay = Math.pow(2, attempt) * 1000;
    const jitter = Math.random() * baseDelay * 0.1;
    return baseDelay + jitter;
  }

  /**
   * Enhanced rate-limited fetch with circuit breaker and smart retry
   */
  async rateLimitedFetch(url, options, retries = 3) {
    return this.circuitBreaker.execute(async () => {
      return this.requestQueue = this.requestQueue.then(async () => {
        for (let attempt = 0; attempt < retries; attempt++) {
          try {
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastRequestTime;
            if (timeSinceLastRequest < this.minRequestInterval) {
              await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest));
            }

            this.lastRequestTime = Date.now();
            const response = await fetch(url, options);

            if (response.status === 429) {
              const waitTime = await this.parseRetryDelay(response, attempt);
              console.warn(`⏱️  Rate limited by Xray. Waiting ${Math.round(waitTime/1000)}s before retry (attempt ${attempt + 1}/${retries})`);
              await new Promise(resolve => setTimeout(resolve, waitTime));
              continue;
            }

            return response;
          } catch (error) {
            if (attempt === retries - 1) {
              throw error;
            }
            const baseDelay = Math.pow(2, attempt) * 1000;
            const jitter = Math.random() * baseDelay * 0.1;
            const waitTime = baseDelay + jitter;
            console.warn(`⚠️  Request failed, retrying in ${Math.round(waitTime)}ms... (attempt ${attempt + 1}/${retries})`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        }
      });
    });
  }

  /**
   * Get authentication headers for Xray API
   */
  async getAuthHeaders() {
    if (this.isCloud) {
      // Xray Cloud uses separate authentication
      if (!this.cloudToken) {
        await this.authenticateCloud();
      }
      return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.cloudToken}`
      };
    } else {
      // Xray Server/Data Center uses Jira authentication
      return {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + btoa(`${this.username}:${this.apiToken}`)
      };
    }
  }

  /**
   * Authenticate with Xray Cloud and get access token
   */
  async authenticateCloud() {
    try {
      const response = await this.rateLimitedFetch('https://xray.cloud.getxray.app/api/v2/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: this.clientId,
          client_secret: this.clientSecret
        })
      });

      if (!response.ok) {
        throw new Error(`Authentication failed with status: ${response.status}`);
      }

      this.cloudToken = await response.text();
      this.cloudToken = this.cloudToken.replace(/"/g, ''); // Remove quotes
    } catch (error) {
      throw new Error(`Xray Cloud authentication failed: ${error.message}`);
    }
  }

  /**
   * Test connection to Xray
   */
  async testConnection() {
    if (this.isCloud && (!this.clientId || !this.clientSecret)) {
      throw new Error('Xray Cloud client ID and secret are required');
    }
    if (!this.isCloud && (!this.jiraUrl || !this.username || !this.apiToken)) {
      throw new Error('Jira URL, username, and API token are required');
    }

    try {
      if (this.isCloud) {
        await this.authenticateCloud();
        return { success: true };
      } else {
        // Test Jira connection for Server/Data Center
        const response = await this.rateLimitedFetch(`${this.jiraUrl}/rest/api/2/myself`, {
          headers: await this.getAuthHeaders()
        });

        if (!response.ok) {
          throw new Error(`Connection test failed with status: ${response.status}`);
        }

        return { success: true };
      }
    } catch (error) {
      throw new Error(`Xray connection failed: ${error.message}`);
    }
  }

  /**
   * Create a Test issue in Xray
   */
  async createTestIssue(testCase, fieldMappings = {}) {
    try {
      const headers = await this.getAuthHeaders();

      // Format test steps for Xray
      const steps = testCase.steps.map((step, index) => {
        const stepText = typeof step === 'string' ? step : step.action || step;
        return {
          index: index + 1,
          step: stepText,
          data: testCase.test_data || '',
          result: testCase.expected_result || ''
        };
      });

      // Build base payload
      const payload = {
        fields: {
          project: { key: this.projectKey },
          summary: testCase.title || testCase.id,
          description: testCase.description || '',
          issuetype: { name: 'Test' },
          priority: { name: this.getPriorityName(testCase.priority) },
          labels: [testCase.category || 'Functional', 'QAtalyst']
        }
      };

      // Add Xray-specific custom fields (configurable via settings.xrayTestTypeFieldId)
      payload.fields[this.testTypeFieldId] = 'Manual';

      // Apply custom field mappings
      if (fieldMappings.customFields) {
        for (const [qatalystField, xrayField] of Object.entries(fieldMappings.customFields)) {
          if (testCase[qatalystField] !== undefined && testCase[qatalystField] !== null) {
            payload.fields[xrayField] = testCase[qatalystField];
          }
        }
      }

      // Create test issue
      const response = await this.rateLimitedFetch(
        `${this.jiraUrl}/rest/api/2/issue`,
        {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(payload)
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`Failed to create test issue: ${response.status} - ${errorData.errorMessages?.join(', ') || 'Unknown error'}`);
      }

      const createdIssue = await response.json();

      // Add test steps using Xray API
      await this.addTestSteps(createdIssue.key, steps, headers);

      // Link preconditions if available
      if (testCase.preconditions) {
        await this.addPrecondition(createdIssue.key, testCase.preconditions, headers);
      }

      return createdIssue;
    } catch (error) {
      console.error(`Failed to create test issue "${testCase.title}":`, error);
      throw error;
    }
  }

  /**
   * Add test steps to an Xray test using the Xray API
   */
  async addTestSteps(testKey, steps, headers) {
    try {
      const endpoint = this.isCloud
        ? `https://xray.cloud.getxray.app/api/v2/test/${testKey}/steps`
        : `${this.jiraUrl}/rest/raven/1.0/api/test/${testKey}/step`;

      const payload = this.isCloud
        ? { steps: steps }
        : { steps: steps };

      const response = await this.rateLimitedFetch(endpoint, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        console.warn(`Failed to add test steps: ${response.status}`);
      }
    } catch (error) {
      console.warn(`Failed to add test steps: ${error.message}`);
    }
  }

  /**
   * Add precondition to a test
   */
  async addPrecondition(testKey, preconditionText, headers) {
    try {
      // Create a precondition issue
      const payload = {
        fields: {
          project: { key: this.projectKey },
          summary: `Precondition for ${testKey}`,
          description: preconditionText,
          issuetype: { name: 'Precondition' }
        }
      };

      const response = await this.rateLimitedFetch(
        `${this.jiraUrl}/rest/api/2/issue`,
        {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(payload)
        }
      );

      if (!response.ok) {
        console.warn(`Failed to create precondition: ${response.status}`);
        return;
      }

      const precondition = await response.json();

      // Link precondition to test
      const linkPayload = {
        type: { name: 'Precondition' },
        inwardIssue: { key: testKey },
        outwardIssue: { key: precondition.key }
      };

      await this.rateLimitedFetch(
        `${this.jiraUrl}/rest/api/2/issueLink`,
        {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(linkPayload)
        }
      );
    } catch (error) {
      console.warn(`Failed to add precondition: ${error.message}`);
    }
  }

  /**
   * Upload multiple test cases to Xray
   */
  async uploadTestCases(testCases, jiraTicket = null, testPlanKey = null, fieldMappings = {}) {
    if (this.isCloud && (!this.clientId || !this.clientSecret)) {
      throw new Error('Xray Cloud is not properly configured. Please check your settings.');
    }
    if (!this.isCloud && (!this.jiraUrl || !this.username || !this.apiToken)) {
      throw new Error('Xray Server is not properly configured. Please check your settings.');
    }

    try {
      // Upload test cases
      const results = {
        success: [],
        failed: [],
        total: testCases.length
      };

      for (const testCase of testCases) {
        try {
          const uploaded = await this.createTestIssue({ ...testCase, jiraTicket }, fieldMappings);
          results.success.push({
            id: uploaded.key,
            title: testCase.title,
            url: `${this.jiraUrl}/browse/${uploaded.key}`
          });

          // Link to test plan if specified
          if (testPlanKey) {
            await this.linkToTestPlan(uploaded.key, testPlanKey);
          }

          // Link to Jira ticket if specified
          if (jiraTicket) {
            await this.linkToJiraTicket(uploaded.key, jiraTicket);
          }
        } catch (error) {
          results.failed.push({
            title: testCase.title,
            error: error.message
          });
        }
      }

      return results;
    } catch (error) {
      throw new Error(`Xray upload failed: ${error.message}`);
    }
  }

  /**
   * Link test to a test plan
   */
  async linkToTestPlan(testKey, testPlanKey) {
    try {
      const headers = await this.getAuthHeaders();
      const endpoint = this.isCloud
        ? `https://xray.cloud.getxray.app/api/v2/testplan/${testPlanKey}/test`
        : `${this.jiraUrl}/rest/raven/1.0/api/testplan/${testPlanKey}/test`;

      const payload = this.isCloud
        ? { add: [testKey] }
        : { add: [testKey] };

      await this.rateLimitedFetch(endpoint, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload)
      });
    } catch (error) {
      console.warn(`Failed to link to test plan: ${error.message}`);
    }
  }

  /**
   * Link test to a Jira ticket
   */
  async linkToJiraTicket(testKey, jiraTicket) {
    try {
      const headers = await this.getAuthHeaders();
      const payload = {
        type: { name: 'Test' },
        inwardIssue: { key: jiraTicket },
        outwardIssue: { key: testKey }
      };

      await this.rateLimitedFetch(
        `${this.jiraUrl}/rest/api/2/issueLink`,
        {
          method: 'POST',
          headers: headers,
          body: JSON.stringify(payload)
        }
      );
    } catch (error) {
      console.warn(`Failed to link to Jira ticket: ${error.message}`);
    }
  }

  /**
   * Map priority to Jira priority name
   */
  getPriorityName(priority) {
    const priorityMap = {
      'P0': 'Highest',
      'P1': 'High',
      'P2': 'Medium',
      'P3': 'Low'
    };
    return priorityMap[priority] || 'Medium';
  }

  /**
   * Fetch custom fields from Jira
   */
  async getCustomFields() {
    try {
      const headers = await this.getAuthHeaders();
      const response = await this.rateLimitedFetch(
        `${this.jiraUrl}/rest/api/2/field`,
        { headers: headers }
      );

      if (!response.ok) {
        throw new Error(`Failed to get custom fields: ${response.status}`);
      }

      const fields = await response.json();
      // Filter for custom fields only
      return fields.filter(f => f.custom);
    } catch (error) {
      throw new Error(`Failed to fetch custom fields: ${error.message}`);
    }
  }
}

/**
 * qMetry Test Management Integration (Cloud & On-Premise)
 * API Docs: https://api.qmetry.com/qtm4j/docs/
 */
class QmetryIntegration {
  constructor(settings) {
    this.isCloud = settings.qmetryIsCloud !== false;
    this.apiUrl = settings.qmetryApiUrl || 'https://api.qmetry.com/qtm4j/api/v1';
    this.apiKey = settings.qmetryApiKey;
    this.username = settings.qmetryUsername;
    this.password = settings.qmetryPassword;
    this.projectId = settings.qmetryProjectId;
    this.releaseId = settings.qmetryReleaseId;

    // Rate limiting
    this.lastRequestTime = 0;
    this.minRequestInterval = 1000; // 1 second between requests
    this.requestQueue = Promise.resolve();

    // Circuit breaker for resilience
    this.circuitBreaker = new CircuitBreaker({
      name: 'qMetry',
      failureThreshold: 5,
      resetTimeout: 120000 // 2 minutes
    });
  }

  /**
   * Parse retry delay from response (header or error message)
   */
  async parseRetryDelay(response, attempt) {
    const retryAfterHeader = response.headers.get('Retry-After');
    if (retryAfterHeader) {
      return parseInt(retryAfterHeader) * 1000;
    }

    // Default exponential backoff with jitter
    const baseDelay = Math.pow(2, attempt) * 1000;
    const jitter = Math.random() * baseDelay * 0.1;
    return baseDelay + jitter;
  }

  /**
   * Enhanced rate-limited fetch with circuit breaker and smart retry
   */
  async rateLimitedFetch(url, options, retries = 3) {
    return this.circuitBreaker.execute(async () => {
      return this.requestQueue = this.requestQueue.then(async () => {
        for (let attempt = 0; attempt < retries; attempt++) {
          try {
            const now = Date.now();
            const timeSinceLastRequest = now - this.lastRequestTime;
            if (timeSinceLastRequest < this.minRequestInterval) {
              await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest));
            }

            this.lastRequestTime = Date.now();
            const response = await fetch(url, options);

            if (response.status === 429) {
              const waitTime = await this.parseRetryDelay(response, attempt);
              console.warn(`⏱️  Rate limited by qMetry. Waiting ${Math.round(waitTime/1000)}s before retry (attempt ${attempt + 1}/${retries})`);
              await new Promise(resolve => setTimeout(resolve, waitTime));
              continue;
            }

            return response;
          } catch (error) {
            if (attempt === retries - 1) {
              throw error;
            }
            const baseDelay = Math.pow(2, attempt) * 1000;
            const jitter = Math.random() * baseDelay * 0.1;
            const waitTime = baseDelay + jitter;
            console.warn(`⚠️  Request failed, retrying in ${Math.round(waitTime)}ms... (attempt ${attempt + 1}/${retries})`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        }
      });
    });
  }

  /**
   * Get authentication headers for qMetry API
   */
  getAuthHeaders() {
    if (this.isCloud) {
      // qMetry Cloud uses API Key authentication
      return {
        'Content-Type': 'application/json',
        'apiKey': this.apiKey
      };
    } else {
      // qMetry On-Premise uses Basic authentication
      return {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + btoa(`${this.username}:${this.password}`)
      };
    }
  }

  /**
   * Test connection to qMetry
   */
  async testConnection() {
    if (this.isCloud && !this.apiKey) {
      throw new Error('qMetry Cloud API key is required');
    }
    if (!this.isCloud && (!this.username || !this.password)) {
      throw new Error('qMetry username and password are required');
    }

    try {
      const response = await this.rateLimitedFetch(`${this.apiUrl}/projects`, {
        headers: this.getAuthHeaders()
      });

      if (!response.ok) {
        throw new Error(`Connection test failed with status: ${response.status}`);
      }

      return { success: true };
    } catch (error) {
      throw new Error(`qMetry connection failed: ${error.message}`);
    }
  }

  /**
   * Get or create a test suite
   */
  async getOrCreateTestSuite(suiteName = 'QAtalyst Generated Tests') {
    try {
      // Get existing test suites
      const response = await this.rateLimitedFetch(
        `${this.apiUrl}/testsuites?projectId=${this.projectId}`,
        { headers: this.getAuthHeaders() }
      );

      if (!response.ok) {
        throw new Error(`Failed to get test suites: ${response.status}`);
      }

      const suites = await response.json();

      // Find existing suite
      const existingSuite = suites.find(s => s.name === suiteName);
      if (existingSuite) {
        return existingSuite.id;
      }

      // Create new suite
      const createResponse = await this.rateLimitedFetch(
        `${this.apiUrl}/testsuites`,
        {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify({
            projectId: this.projectId,
            name: suiteName,
            description: 'Test cases generated by QAtalyst AI',
            releaseId: this.releaseId
          })
        }
      );

      if (!createResponse.ok) {
        throw new Error(`Failed to create test suite: ${createResponse.status}`);
      }

      const newSuite = await createResponse.json();
      return newSuite.id;
    } catch (error) {
      throw new Error(`Test suite management failed: ${error.message}`);
    }
  }

  /**
   * Create a test case in qMetry
   */
  async createTestCase(testCase, fieldMappings = {}) {
    try {
      // Format test steps for qMetry
      const steps = testCase.steps.map((step, index) => {
        const stepText = typeof step === 'string' ? step : step.action || step;
        return {
          stepNumber: index + 1,
          stepDescription: stepText,
          expectedResult: testCase.expected_result || '',
          testData: testCase.test_data || ''
        };
      });

      // Build base payload
      const payload = {
        projectId: this.projectId,
        name: testCase.title || testCase.id,
        description: testCase.description || '',
        testCaseType: this.getTestType(testCase.category),
        priority: this.getPriorityName(testCase.priority),
        status: 'Active',
        estimatedTime: 0,
        testSteps: steps
      };

      // Add preconditions if available
      if (testCase.preconditions) {
        payload.precondition = testCase.preconditions;
      }

      // Add release if specified
      if (this.releaseId) {
        payload.releaseId = this.releaseId;
      }

      // Apply custom field mappings
      if (fieldMappings.customFields) {
        payload.customFields = {};
        for (const [qatalystField, qmetryField] of Object.entries(fieldMappings.customFields)) {
          if (testCase[qatalystField] !== undefined && testCase[qatalystField] !== null) {
            payload.customFields[qmetryField] = testCase[qatalystField];
          }
        }
      }

      // Create test case
      const response = await this.rateLimitedFetch(
        `${this.apiUrl}/testcases`,
        {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify(payload)
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`Failed to create test case: ${response.status} - ${errorData.message || 'Unknown error'}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Failed to create test case "${testCase.title}":`, error);
      throw error;
    }
  }

  /**
   * Upload multiple test cases to qMetry
   */
  async uploadTestCases(testCases, jiraTicket = null, suiteName = null, fieldMappings = {}) {
    if (this.isCloud && !this.apiKey) {
      throw new Error('qMetry Cloud is not properly configured. Please check your settings.');
    }
    if (!this.isCloud && (!this.username || !this.password)) {
      throw new Error('qMetry is not properly configured. Please check your settings.');
    }

    try {
      // Get or create test suite
      let suiteId = null;
      if (suiteName) {
        suiteId = await this.getOrCreateTestSuite(suiteName);
      }

      // Upload test cases
      const results = {
        success: [],
        failed: [],
        total: testCases.length
      };

      for (const testCase of testCases) {
        try {
          const uploaded = await this.createTestCase({ ...testCase, jiraTicket }, fieldMappings);
          results.success.push({
            id: uploaded.id || uploaded.testCaseKey,
            title: testCase.title,
            url: uploaded.webUrl || `${this.apiUrl.replace('/api/v1', '')}/testcase/${uploaded.id}`
          });

          // Link to test suite if created
          if (suiteId && uploaded.id) {
            await this.linkTestCaseToSuite(uploaded.id, suiteId);
          }

          // Link to Jira issue if specified
          if (jiraTicket && uploaded.id) {
            await this.linkToJiraTicket(uploaded.id, jiraTicket);
          }
        } catch (error) {
          results.failed.push({
            title: testCase.title,
            error: error.message
          });
        }
      }

      return results;
    } catch (error) {
      throw new Error(`qMetry upload failed: ${error.message}`);
    }
  }

  /**
   * Link test case to test suite
   */
  async linkTestCaseToSuite(testCaseId, suiteId) {
    try {
      await this.rateLimitedFetch(
        `${this.apiUrl}/testsuites/${suiteId}/testcases`,
        {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify({
            testCaseIds: [testCaseId]
          })
        }
      );
    } catch (error) {
      console.warn(`Failed to link test case to suite: ${error.message}`);
    }
  }

  /**
   * Link test case to Jira issue
   */
  async linkToJiraTicket(testCaseId, jiraTicket) {
    try {
      await this.rateLimitedFetch(
        `${this.apiUrl}/testcases/${testCaseId}/requirements`,
        {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify({
            requirementKeys: [jiraTicket]
          })
        }
      );
    } catch (error) {
      console.warn(`Failed to link to Jira ticket: ${error.message}`);
    }
  }

  /**
   * Map category to qMetry test type
   */
  getTestType(category) {
    const typeMap = {
      'Positive': 'Functional',
      'Negative': 'Functional',
      'Edge': 'Boundary',
      'Integration': 'Integration',
      'Performance': 'Performance',
      'Security': 'Security',
      'Regression': 'Regression'
    };
    return typeMap[category] || 'Functional';
  }

  /**
   * Map priority to qMetry priority name
   */
  getPriorityName(priority) {
    const priorityMap = {
      'P0': 'Critical',
      'P1': 'High',
      'P2': 'Medium',
      'P3': 'Low'
    };
    return priorityMap[priority] || 'Medium';
  }

  /**
   * Fetch custom fields from qMetry
   */
  async getCustomFields() {
    try {
      const response = await this.rateLimitedFetch(
        `${this.apiUrl}/projects/${this.projectId}/customfields`,
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
}

// Export for use in background.js

  const api = { ZephyrScaleIntegration, ZephyrSquadIntegration, XrayIntegration, QmetryIntegration };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(globalThis, api);
})();
