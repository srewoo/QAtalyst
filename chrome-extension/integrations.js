// External Integrations System for QAtalyst
// Fetch requirements from Confluence, Figma, and Google Docs

/**
 * Lightweight Circuit Breaker for Chrome Extension
 * Prevents cascading failures by stopping requests after repeated failures
 */
class CircuitBreaker {
  constructor(options = {}) {
    this.name = options.name || 'unnamed';
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 120000; // 2 minutes
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.successCount = 0;
  }

  async execute(fn) {
    // Check circuit state
    if (this.state === 'OPEN') {
      // Check if we should try half-open
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        console.log(`[CircuitBreaker ${this.name}] Attempting half-open state`);
        this.state = 'HALF_OPEN';
      } else {
        const waitSeconds = Math.ceil((this.resetTimeout - (Date.now() - this.lastFailureTime)) / 1000);
        throw new Error(`Circuit breaker open for ${this.name}: Too many failures. Try again in ${waitSeconds} seconds.`);
      }
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  recordSuccess() {
    this.successCount++;
    if (this.state === 'HALF_OPEN') {
      console.log(`[CircuitBreaker ${this.name}] Circuit closed after successful half-open test`);
      this.state = 'CLOSED';
      this.failureCount = 0;
    }
  }

  recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      console.log(`[CircuitBreaker ${this.name}] Circuit reopened after half-open failure`);
      this.state = 'OPEN';
    } else if (this.failureCount >= this.failureThreshold) {
      console.log(`[CircuitBreaker ${this.name}] Circuit opened after ${this.failureCount} failures`);
      this.state = 'OPEN';
    }
  }

  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime
    };
  }
}

class IntegrationManager {
  constructor(settings) {
    this.settings = settings;
    this.confluence = new ConfluenceIntegration(settings);
    this.figma = new FigmaIntegration(settings);
    this.googleDocs = new GoogleDocsIntegration(settings);
  }

  /**
   * Fetch multiple Confluence pages in parallel with concurrency control
   */
  async fetchConfluencePages(urls) {
    console.log(`📄 [IntegrationManager] fetchConfluencePages called with ${urls.length} URLs`);
    console.log(`📄 [IntegrationManager] Confluence URLs to fetch:`, urls);
    const results = [];
    const concurrencyLimit = 3; // Max 3 concurrent requests

    // Process URLs in batches
    for (let i = 0; i < urls.length; i += concurrencyLimit) {
      const batch = urls.slice(i, i + concurrencyLimit);
      const batchPromises = batch.map(async (url) => {
        try {
          const content = await this.confluence.fetchPage(url);
          if (content && !content.content.startsWith('Error:')) {
            console.log(`IntegrationManager: Fetched Confluence content for ${url}`);
            return content;
          } else {
            console.warn(`IntegrationManager: Skipped Confluence page (fetch failed or empty): ${url}`);
            return null;
          }
        } catch (error) {
          console.error('IntegrationManager: Confluence fetch failed for', url, ':', error.message);
          return {
            url: url,
            title: 'Confluence page (unavailable)',
            content: `Could not fetch Confluence content. Reason: ${error.message}`,
            version: 0
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults.filter(r => r !== null));
    }

    return results;
  }

  /**
   * Fetch multiple Figma files with rate limiting
   */
  async fetchFigmaFiles(urls) {
    console.log(`🎨 [IntegrationManager] fetchFigmaFiles called with ${urls.length} URLs`);
    console.log(`🎨 [IntegrationManager] Figma URLs to fetch:`, urls);
    const results = [];

    for (let i = 0; i < urls.length; i++) {
      try {
        // Add delay between requests to respect rate limits
        if (i > 0) {
          await new Promise(resolve =>
            setTimeout(resolve, typeof CONFIG !== 'undefined' ? CONFIG.FIGMA_RATE_LIMIT_DELAY : 1000)
          );
        }

        const fileKey = this.figma.extractFileKey(urls[i]);
        const content = await this.figma.fetchFile(urls[i]);

        if (content && !content.specifications.startsWith('Error:')) {
          // Fetch images for identified nodes
          let images = [];
          if (fileKey && content.nodesForImageExport && content.nodesForImageExport.length > 0) {
            images = await this.figma.fetchNodeImages(fileKey, content.nodesForImageExport);
            console.log(`IntegrationManager: Fetched ${images.length} images for Figma file ${urls[i]}`);
          }

          results.push({ ...content, images });
          console.log(`IntegrationManager: Fetched Figma content for ${urls[i]}`);
        } else {
          console.warn(`IntegrationManager: Skipped Figma file (fetch failed or empty): ${urls[i]}`);
        }
      } catch (error) {
        console.error('IntegrationManager: Figma fetch failed for', urls[i], ':', error.message);
        results.push({
          url: urls[i],
          name: 'Figma design (unavailable)',
          specifications: `Could not fetch Figma content. Reason: ${error.message}`,
          lastModified: null,
          version: null,
          images: []
        });
      }
    }

    return results;
  }

  /**
   * Fetch multiple Google Docs in parallel with concurrency control
   */
  async fetchGoogleDocs(urls) {
    const results = [];
    const concurrencyLimit = 3; // Max 3 concurrent requests

    // Process URLs in batches
    for (let i = 0; i < urls.length; i += concurrencyLimit) {
      const batch = urls.slice(i, i + concurrencyLimit);
      const batchPromises = batch.map(async (url) => {
        try {
          const content = await this.googleDocs.fetchDocument(url);
          if (content && !content.content.startsWith('Error:')) {
            console.log(`IntegrationManager: Fetched Google Docs content for ${url}`);
            return content;
          } else {
            console.warn(`IntegrationManager: Skipped Google Doc (fetch failed or empty): ${url}`);
            return null;
          }
        } catch (error) {
          console.error('IntegrationManager: Google Docs fetch failed for', url, ':', error.message);
          return {
            url: url,
            title: 'Google Doc (unavailable)',
            content: `Could not fetch Google Docs content. Reason: ${error.message}`,
            revisionId: null
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults.filter(r => r !== null));
    }

    return results;
  }

  async fetchAllLinkedContent(ticketData) {
    console.log('🔗 [IntegrationManager] Starting fetchAllLinkedContent');
    console.log('🔗 [IntegrationManager] Settings configured:', {
      hasConfluence: !!(this.settings.confluenceUrl && this.settings.confluenceEmail && this.settings.confluenceToken),
      hasFigma: !!this.settings.figmaToken,
      hasGoogleDocs: !!this.settings.googleApiKey
    });

    // Log detailed configuration status for debugging
    if (!this.settings.confluenceUrl || !this.settings.confluenceEmail || !this.settings.confluenceToken) {
      console.warn('⚠️ [IntegrationManager] Confluence not fully configured:', {
        hasUrl: !!this.settings.confluenceUrl,
        hasEmail: !!this.settings.confluenceEmail,
        hasToken: !!this.settings.confluenceToken
      });
    }
    if (!this.settings.figmaToken) {
      console.warn('⚠️ [IntegrationManager] Figma not configured (missing token)');
    }

    const results = {
      confluence: [],
      figma: [],
      googleDocs: [],
      enrichedDescription: ticketData.description || ''
    };

    // First, try to use linkedPages if available (these are extracted from DOM)
    let confluenceUrls = [];
    let figmaUrls = [];
    let googleDocsUrls = [];

    if (ticketData.linkedPages && Array.isArray(ticketData.linkedPages)) {
      console.log('🔗 [IntegrationManager] Using linkedPages from DOM:', ticketData.linkedPages.length);

      // Extract URLs from linkedPages based on their type
      confluenceUrls = ticketData.linkedPages
        .filter(page => page.type === 'confluence')
        .map(page => page.url);

      figmaUrls = ticketData.linkedPages
        .filter(page => page.type === 'figma')
        .map(page => page.url);

      googleDocsUrls = ticketData.linkedPages
        .filter(page => page.type === 'google_docs' || page.type === 'google_drive')
        .map(page => page.url);
    }

    // Fallback: Extract URLs from ticket description and comments if no linkedPages
    if (confluenceUrls.length === 0 && figmaUrls.length === 0 && googleDocsUrls.length === 0) {
      console.log('🔗 [IntegrationManager] No linkedPages found, extracting from text');
      const allText = [
        ticketData.description || '',
        ...(ticketData.comments || []).map(c => c.text || '') // Use c.text for comment content
      ].join('\n');
      console.log('🔗 [IntegrationManager] Extracted text length:', allText.length);

      // Extract all URLs using regex patterns
      confluenceUrls = this.confluence.extractUrls(allText);
      figmaUrls = this.figma.extractUrls(allText);
      googleDocsUrls = this.googleDocs.extractUrls(allText);
    }

    console.log('🔗 [IntegrationManager] Extracted URLs:', {
      confluence: confluenceUrls.length,
      figma: figmaUrls.length,
      googleDocs: googleDocsUrls.length
    });

    if (confluenceUrls.length > 0) console.log('  📄 Confluence URLs:', confluenceUrls);
    if (figmaUrls.length > 0) console.log('  🎨 Figma URLs:', figmaUrls);
    if (googleDocsUrls.length > 0) console.log('  📝 Google Docs URLs:', googleDocsUrls);

    // Fetch from all integrations in parallel
    const fetchTasks = [];

    if (confluenceUrls.length > 0) {
      console.log(`📄 [IntegrationManager] Processing ${confluenceUrls.length} Confluence URLs`);
      console.log(`📄 [IntegrationManager] Confluence configuration:`, {
        hasUrl: !!this.settings.confluenceUrl,
        hasEmail: !!this.settings.confluenceEmail,
        hasToken: !!this.settings.confluenceToken,
        url: this.settings.confluenceUrl || 'undefined',
        email: this.settings.confluenceEmail || 'undefined',
        tokenFirst10: this.settings.confluenceToken ? this.settings.confluenceToken.substring(0, 10) + '...' : 'undefined'
      });

      // Only fetch if Confluence is properly configured
      if (this.settings.confluenceUrl && this.settings.confluenceEmail && this.settings.confluenceToken) {
        console.log('✅ [IntegrationManager] Confluence configured, adding fetch task');
        fetchTasks.push(this.fetchConfluencePages(confluenceUrls));
      } else {
        console.error('❌ [IntegrationManager] Confluence URLs found but integration not properly configured');
        console.error('   Required: confluenceUrl, confluenceEmail, and confluenceToken');
        console.error('   Settings keys present:', Object.keys(this.settings));
      }
    }
    if (figmaUrls.length > 0) {
      console.log(`🎨 [IntegrationManager] Processing ${figmaUrls.length} Figma URLs`);
      console.log(`🎨 [IntegrationManager] Figma token present:`, !!this.settings.figmaToken);
      console.log(`🎨 [IntegrationManager] Figma token value (first 10 chars):`, this.settings.figmaToken ? this.settings.figmaToken.substring(0, 10) + '...' : 'undefined');

      // Only fetch if Figma is properly configured
      if (this.settings.figmaToken) {
        console.log('✅ [IntegrationManager] Figma configured, adding fetch task');
        fetchTasks.push(this.fetchFigmaFiles(figmaUrls));
      } else {
        console.error('❌ [IntegrationManager] Figma URLs found but integration not configured (missing figmaToken)');
        console.error('   Settings keys present:', Object.keys(this.settings));
      }
    }
    if (googleDocsUrls.length > 0) {
      // Only fetch if Google Docs is properly configured
      if (this.settings.googleApiKey) {
        fetchTasks.push(this.fetchGoogleDocs(googleDocsUrls));
      } else {
        console.error('❌ [IntegrationManager] Google Docs URLs found but integration not configured (missing googleApiKey)');
      }
    }

    // Wait for all integrations to complete (use allSettled to not fail on errors)
    const fetchResults = await Promise.allSettled(fetchTasks);

    // Process results
    let taskIndex = 0;
    const errors = [];
    
    if (confluenceUrls.length > 0) {
      if (fetchResults[taskIndex].status === 'fulfilled') {
        results.confluence = fetchResults[taskIndex].value;
        console.log('✅ [IntegrationManager] Confluence fetch successful:', results.confluence.length, 'pages');
      } else {
        console.error('❌ [IntegrationManager] Confluence fetch failed:', fetchResults[taskIndex].reason);
        errors.push({ type: 'Confluence', error: fetchResults[taskIndex].reason?.message || 'Unknown error' });
      }
      taskIndex++;
    }
    if (figmaUrls.length > 0) {
      if (fetchResults[taskIndex].status === 'fulfilled') {
        results.figma = fetchResults[taskIndex].value;
        console.log('✅ [IntegrationManager] Figma fetch successful:', results.figma.length, 'files');
      } else {
        console.error('❌ [IntegrationManager] Figma fetch failed:', fetchResults[taskIndex].reason);
        errors.push({ type: 'Figma', error: fetchResults[taskIndex].reason?.message || 'Unknown error' });
      }
      taskIndex++;
    }
    if (googleDocsUrls.length > 0) {
      if (fetchResults[taskIndex].status === 'fulfilled') {
        results.googleDocs = fetchResults[taskIndex].value;
        console.log('✅ [IntegrationManager] Google Docs fetch successful:', results.googleDocs.length, 'documents');
      } else {
        console.error('❌ [IntegrationManager] Google Docs fetch failed:', fetchResults[taskIndex].reason);
        errors.push({ type: 'Google Docs', error: fetchResults[taskIndex].reason?.message || 'Unknown error' });
      }
      taskIndex++;
    }
    
    // Log any errors
    if (errors.length > 0) {
      console.warn('⚠️ [IntegrationManager] Some integrations failed:', errors);
    }
    
    // Enrich description with external content
    if (results.confluence.length > 0) {
      results.enrichedDescription += '\n\n## Confluence Requirements:\n' +
        results.confluence.map(c => c.content).join('\n\n');
    }
    
    if (results.figma.length > 0) {
      results.enrichedDescription += '\n\n## Figma Design Specifications:\n' +
        results.figma.map(f => f.specifications).join('\n\n');
    }
    
    if (results.googleDocs.length > 0) {
      results.enrichedDescription += '\n\n## Google Docs Content:\n' +
        results.googleDocs.map(d => d.content).join('\n\n');
    }

    console.log('✅ [IntegrationManager] Final results:', {
      confluence: results.confluence.length,
      figma: results.figma.length,
      googleDocs: results.googleDocs.length,
      enrichedDescriptionLength: results.enrichedDescription.length,
      errors: errors.length
    });
    
    return results;
  }
}

// Confluence Integration
class ConfluenceIntegration {
  constructor(settings) {
    this.baseUrl = settings.confluenceUrl;
    this.email = settings.confluenceEmail;
    this.token = settings.confluenceToken;

    console.log('📄 [Confluence] Integration initialized with:', {
      hasBaseUrl: !!this.baseUrl,
      hasEmail: !!this.email,
      hasToken: !!this.token,
      settingsKeys: Object.keys(settings)
    });
  }
  
  extractUrls(text) {
    // Multiple patterns to support Cloud, Server, and Data Center
    const patterns = [
      // Cloud format: https://company.atlassian.net/wiki/spaces/... (title is optional)
      /https:\/\/[A-Za-z0-9.-]+\.atlassian\.net\/wiki\/spaces\/[~A-Za-z0-9]+\/pages\/\d+(?:\/[A-Za-z0-9+%-]+)?/gi,

      // Server/Data Center format: https://confluence.company.com/display/...
      /https:\/\/[A-Za-z0-9.-]+\/confluence\/display\/[A-Za-z0-9]+\/[^\/\s<>"']+/gi,

      // Server/Data Center format: https://confluence.company.com/pages/viewpage.action?pageId=...
      /https:\/\/[A-Za-z0-9.-]+\/confluence\/pages\/viewpage\.action\?pageId=\d+/gi,

      // Direct server format: https://wiki.company.com/display/...
      /https:\/\/wiki\.[A-Za-z0-9.-]+\/display\/[A-Za-z0-9]+\/[^\/\s<>"']+/gi,

      // Short links: https://company.atlassian.net/wiki/x/...
      /https:\/\/[A-Za-z0-9.-]+\.atlassian\.net\/wiki\/x\/[A-Za-z0-9_-]+/gi
    ];

    let allMatches = [];
    patterns.forEach(pattern => {
      const matches = text.match(pattern) || [];
      allMatches = allMatches.concat(matches);
    });

    // Clean up any trailing punctuation or HTML entities
    const cleanedUrls = allMatches.map(url => url.replace(/[<>"'\s]+$/, ''));
    return [...new Set(cleanedUrls)]; // Remove duplicates
  }
  
  async fetchPage(url) {
    console.log(`📄 [Confluence] fetchPage called for URL: ${url}`);
    console.log(`📄 [Confluence] Configuration status:`, {
      hasBaseUrl: !!this.baseUrl,
      hasEmail: !!this.email,
      hasToken: !!this.token,
      baseUrl: this.baseUrl || 'undefined',
      email: this.email || 'undefined',
      tokenFirst10: this.token ? this.token.substring(0, 10) + '...' : 'undefined'
    });

    if (!this.baseUrl || !this.email || !this.token) {
      console.error('❌ [Confluence] Missing configuration:', {
        baseUrl: this.baseUrl,
        email: this.email,
        token: this.token ? 'present' : 'missing'
      });
      throw new Error('Confluence integration is not configured. Please add Confluence URL, email, and API token in extension settings.');
    }

    try {
      // Extract page ID from URL
      const pageId = this.extractPageId(url);
      if (!pageId) {
        throw new Error('Invalid Confluence URL format. Could not extract page ID.');
      }

      console.log(`📄 Confluence - Extracted page ID: ${pageId} from URL: ${url}`);

      // Check cache first (cacheManager is optional)
      if (typeof cacheManager !== 'undefined' && cacheManager) {
        const cacheKey = cacheManager.constructor.getCacheKey('confluence', pageId);
        const cached = cacheManager.get(cacheKey);
        if (cached) {
          console.log(`Using cached Confluence page: ${pageId}`);
          return cached;
        }
      }

      // Fetch page content with retry logic
      const fetchPageWithRetry = async () => {
        // Confluence Cloud uses /wiki/rest/api, Server/Data Center uses /rest/api
        const isCloud = this.baseUrl.includes('atlassian.net');
        const apiPath = isCloud ? '/wiki/rest/api/content' : '/rest/api/content';
        const apiUrl = `${this.baseUrl}${apiPath}/${pageId}?expand=body.storage,version`;
        console.log(`🌐 Confluence API request: ${apiUrl}`);

        const response = await fetch(apiUrl, {
          headers: {
            'Authorization': 'Basic ' + btoa(`${this.email}:${this.token}`),
            'Accept': 'application/json'
          }
        });

        if (!response.ok) {
          if (response.status === 401) {
            throw new Error('Confluence authentication failed. Please check your API token.');
          } else if (response.status === 403) {
            throw new Error('Access denied. You do not have permission to view this Confluence page.');
          } else if (response.status === 404) {
            throw new Error('Confluence page not found. It may have been deleted or moved.');
          } else if (response.status === 429) {
            // Rate limited - this is retryable
            const retryAfter = response.headers.get('Retry-After') || '60';
            const error = new Error(`Rate limited. Retry after ${retryAfter} seconds.`);
            error.response = { status: 429 };
            throw error;
          } else {
            throw new Error(`Confluence API returned error ${response.status}.`);
          }
        }

        const data = await response.json();

        return {
          url: url,
          title: data.title,
          content: this.parseHtml(data.body.storage.value),
          version: data.version.number
        };
      };

      // Use retry helper if available, otherwise just execute once
      let result;
      if (typeof retryHelper !== 'undefined' && retryHelper) {
        result = await retryHelper.forService('confluence', 'fetchPage', fetchPageWithRetry, {
          maxRetries: 3,
          baseDelay: 1000
        });
      } else {
        result = await fetchPageWithRetry();
      }

      // Cache the result (cacheManager is optional)
      if (typeof cacheManager !== 'undefined' && cacheManager && result) {
        const cacheKey = cacheManager.constructor.getCacheKey('confluence', pageId);
        cacheManager.set(cacheKey, result);
        console.log(`Cached Confluence page: ${pageId}`);
      }

      return result;
    } catch (error) {
      console.error('Confluence fetch error:', error);
      throw error; // Re-throw to be handled by IntegrationManager
    }
  }
  
  extractPageId(url) {
    // Try to extract page ID from various Confluence URL formats
    const patterns = [
      /\/pages\/(\d+)\//,                        // /pages/123456/
      /pageId=(\d+)/,                            // ?pageId=123456
      /\/(\d+)$/,                                // ending with /123456
      /\/wiki\/spaces\/[^\/]+\/pages\/(\d+)/,   // Cloud URL: /wiki/spaces/PROJ/pages/123456
      /\/display\/[^\/]+\/(\d+)/,                // Display format: /display/SPACE/123456
      /\/pages\/viewpage\.action\?pageId=(\d+)/, // View page action: ?pageId=123456
      /\/confluence\/pages\/(\d+)/,              // Server: /confluence/pages/123456
      /\/wiki\/display\/[^\/]+\/(\d+)/          // Wiki server: /wiki/display/SPACE/123456
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    // Check for short link format /x/shortId
    const shortLinkMatch = url.match(/\/x\/([A-Za-z0-9_-]+)/);
    if (shortLinkMatch && shortLinkMatch[1]) {
      // For short links, we would need to resolve them via API
      // For now, log a warning
      console.warn('Short link detected, resolution not yet implemented:', url);
      return null;
    }

    return null;
  }
  
  parseHtml(html) {
    // Service worker context - can't use DOM APIs for sanitization
    // Instead, use regex-based HTML stripping (safe since we're only extracting text)

    // Remove script and style tags with their content
    let text = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')

      // Convert common block elements to line breaks
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n')
      .replace(/<li>/gi, '- ')

      // Extract URLs from anchor tags before removing them
      .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi, '$2 ($1)')

      // Remove all remaining HTML tags
      .replace(/<[^>]+>/g, '')

      // Decode HTML entities
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")

      // Clean up whitespace
      .replace(/\n{3,}/g, '\n\n')  // Max 2 consecutive newlines
      .trim();
    
    if (text.length > CONFIG.MAX_TEXT_EXTRACT_LENGTH) {
      console.warn(`Confluence content truncated from ${text.length} to ${CONFIG.MAX_TEXT_EXTRACT_LENGTH} characters.`);
      text = text.substring(0, CONFIG.MAX_TEXT_EXTRACT_LENGTH) + '... [Content truncated]';
    }

    return text;
  }
}

// Figma Integration
// Rate Limits: https://developers.figma.com/docs/rest-api/rate-limits/
// - Personal Access Token: 1,000 requests per minute (shared across all files)
// - OAuth: 2,000 requests per minute per app
// Handles 429 responses with Retry-After header
class FigmaIntegration {
  constructor(settings) {
    this.token = settings.figmaToken;
    this.imageMode = settings.figmaImageMode || 'single'; // 'single' or 'children'

    console.log('🎨 [Figma] Integration initialized with:', {
      hasToken: !!this.token,
      imageMode: this.imageMode,
      settingsKeys: Object.keys(settings)
    });
  }
  
  extractUrls(text) {
    // Match Figma URLs - support file, design, and proto with query parameters
    // Include ? for query strings and capture node-id parameter
    const pattern = /https:\/\/(?:www\.)?figma\.com\/(?:file|design|proto)\/[A-Za-z0-9]+(?:\/[A-Za-z0-9-._~!$&'()*+,;=:@%?#]*)*/gi;
    const matches = text.match(pattern) || [];
    // Clean up any trailing punctuation or HTML entities
    return [...new Set(matches.map(url => url.replace(/[<>"'\s]+$/, '')))];
  }
  
  /**
   * Extract child nodes (frames/components) from a Figma node
   * @param {array} children - Array of child nodes from Figma API
   * @returns {array} - Array of {id, name, type} objects for frames and components
   */
  extractChildNodes(children) {
    const childNodes = [];
    const validTypes = ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE'];
    
    const traverse = (nodes) => {
      for (const node of nodes) {
        // Include frames and components
        if (validTypes.includes(node.type)) {
          childNodes.push({
            id: node.id,
            name: node.name,
            type: node.type
          });
        }
        
        // Recursively check children (but only go 2 levels deep to avoid too many images)
        if (node.children && childNodes.length < CONFIG.MAX_FIGMA_IMAGES) {
          traverse(node.children);
        }
      }
    };
    
    traverse(children);
    
    // Limit to MAX_FIGMA_IMAGES
    return childNodes.slice(0, CONFIG.MAX_FIGMA_IMAGES);
  }
  
  /**
   * Parse Figma URL to extract file key and node ID
   * @param {string} url - Full Figma URL
   * @returns {object} - {fileKey, nodeId}
   */
  parseFigmaURL(url) {
    const fileKeyMatch = url.match(/\/(?:file|design|proto)\/([a-zA-Z0-9]+)/) || url.match(/figma\.com\/(?:file|design|proto)\/([a-zA-Z0-9]+)/);
    const nodeIdMatch = url.match(/node-id=([\d:-]+)/);
    
    return {
      fileKey: fileKeyMatch ? fileKeyMatch[1] : null,
      nodeId: nodeIdMatch ? nodeIdMatch[1].replace(/-/g, ':') : null // Convert "1-41" → "1:41"
    };
  }
  
  async fetchFile(url, retries = 3) {
    console.log(`🎨 [Figma] fetchFile called for URL: ${url}`);
    console.log(`🎨 [Figma] Token present: ${!!this.token}`);

    if (!this.token) {
      console.error('❌ [Figma] No token found. Token value:', this.token);
      throw new Error('Figma integration is not configured. Please add your Figma Personal Access Token in extension settings.');
    }

    try {
      const { fileKey, nodeId } = this.parseFigmaURL(url);
      
      if (!fileKey) {
        throw new Error('Invalid Figma URL format. Could not extract file key.');
      }

      console.log(`🎨 Figma - Extracted file key: ${fileKey}, node ID: ${nodeId || 'none'} from URL: ${url}`);

      let nodesForImageExport = [];
      let specifications = '';
      let fileName = 'Figma Design';

      // If URL has a specific node-id, use it directly for image export
      if (nodeId) {
        console.log(`🎯 Figma - Using specific node from URL: ${nodeId}`);
        
        // Fetch minimal metadata for this specific node
        const nodeApiUrl = `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${nodeId}`;
        console.log(`🌐 Figma API request (node metadata): ${nodeApiUrl}`);
        
        const nodeResponse = await fetch(nodeApiUrl, {
          headers: { 'X-Figma-Token': this.token }
        });

        if (nodeResponse.ok) {
          const nodeData = await nodeResponse.json();
          const nodeInfo = nodeData.nodes?.[nodeId];
          
          if (nodeInfo) {
            fileName = nodeInfo.document?.name || 'Figma Design';
            specifications = `# ${fileName}\n\n- Node ID: ${nodeId}\n- Type: ${nodeInfo.document?.type || 'Unknown'}`;
            
            // Check image mode setting
            if (this.imageMode === 'children' && nodeInfo.document?.children) {
              // Extract all child frames/components
              const children = this.extractChildNodes(nodeInfo.document.children);
              if (children.length > 0) {
                nodesForImageExport = children.map(child => child.id);
                console.log(`🖼️ Figma - Extracting ${children.length} child images from node: ${fileName}`);
                specifications += `\n- Child Nodes: ${children.length} frames/components`;
              } else {
                // No children found, fallback to single node
                nodesForImageExport = [nodeId];
                console.log(`⚠️ Figma - No children found, using single node image`);
              }
            } else {
              // Use this specific node for image export (single mode)
              nodesForImageExport = [nodeId];
              console.log(`✅ Figma - Found node: ${fileName} (single image mode)`);
            }
          }
        } else {
          console.warn(`⚠️ Figma - Could not fetch node metadata, will still try to export image`);
          nodesForImageExport = [nodeId];
        }
      } else {
        // No specific node-id in URL, fetch file metadata to find top-level frames
        console.log(`📄 Figma - No node-id in URL, fetching file metadata...`);
        
        const apiUrl = `https://api.figma.com/v1/files/${fileKey}`;
        console.log(`🌐 Figma API request: ${apiUrl}`);

        const response = await fetch(apiUrl, {
          headers: { 'X-Figma-Token': this.token }
        });

        // Handle rate limiting (429 Too Many Requests)
        if (response.status === 429) {
          if (retries > 0) {
            const retryAfter = response.headers.get('Retry-After');
            const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 2000;
            console.warn(`Figma rate limit hit, retrying after ${waitTime}ms...`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return await this.fetchFile(url, retries - 1);
          } else {
            throw new Error('Figma API rate limit exceeded (1000 requests/minute). Please wait a moment and try again.');
          }
        }

        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            throw new Error('Figma authentication failed. Please check your Personal Access Token.');
          } else if (response.status === 404) {
            throw new Error('Figma file not found. Please check the URL and your access permissions.');
          } else {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || `Figma API returned error ${response.status}.`);
          }
        }

        const data = await response.json();

        if (data.status && data.status >= 400) {
          throw new Error(data.err || `Figma API returned error status ${data.status}`);
        }

        fileName = data.name;
        specifications = this.extractSpecifications(data);

        // Identify nodes for image export (top-level frames, components)
        if (data.document && data.document.children) {
          for (const page of data.document.children) {
            if (page.type === 'CANVAS' && page.children) {
              for (const child of page.children) {
                if (child.type === 'FRAME' || child.type === 'COMPONENT') {
                  nodesForImageExport.push(child.id);
                  if (nodesForImageExport.length >= CONFIG.MAX_FIGMA_IMAGES) break;
                }
              }
            }
            if (nodesForImageExport.length >= CONFIG.MAX_FIGMA_IMAGES) break;
          }
        }
      }

      return {
        url: url,
        name: fileName,
        specifications: specifications,
        lastModified: null,
        version: null,
        nodesForImageExport: nodesForImageExport
      };
    } catch (error) {
      console.error('Figma fetch error:', error);
      throw error;
    }
  }
  
  extractFileKey(url) {
    // Support file, design, and proto URLs
    const match = url.match(/figma\.com\/(file|design|proto)\/([^\/\?]+)/);
    return match ? match[2] : null;
  }
  
  extractSpecifications(figmaData) {
    let specs = [];
    
    // Extract basic information
    specs.push(`# ${figmaData.name}`);
    
    // Extract pages and frames
    if (figmaData.document && figmaData.document.children) {
      figmaData.document.children.forEach(page => {
        specs.push(`\n## Page: ${page.name}`);
        
        if (page.children) {
          page.children.forEach(frame => {
            specs.push(`\n### Frame: ${frame.name}`);
            specs.push(`- Type: ${frame.type}`);
            
            if (frame.absoluteBoundingBox) {
              specs.push(`- Size: ${Math.round(frame.absoluteBoundingBox.width)}x${Math.round(frame.absoluteBoundingBox.height)}`);
            }
            
            // Extract components
            if (frame.children && frame.children.length > 0) {
              specs.push(`- Components: ${frame.children.length}`);
              
              // List component types
              const componentTypes = {};
              frame.children.forEach(child => {
                componentTypes[child.type] = (componentTypes[child.type] || 0) + 1;
              });
              
              Object.entries(componentTypes).forEach(([type, count]) => {
                specs.push(`  - ${type}: ${count}`);
              });
            }
          });
        }
      });
    }
    
    let finalSpecs = specs.join('\n');
    if (finalSpecs.length > CONFIG.MAX_TEXT_EXTRACT_LENGTH) {
      console.warn(`Figma specifications truncated from ${finalSpecs.length} to ${CONFIG.MAX_TEXT_EXTRACT_LENGTH} characters.`);
      finalSpecs = finalSpecs.substring(0, CONFIG.MAX_TEXT_EXTRACT_LENGTH) + '... [Content truncated]';
    }
    
    return finalSpecs;
  }

  async fetchNodeImages(fileKey, nodeIds) {
    if (!this.token || !fileKey || nodeIds.length === 0) {
      return [];
    }

    try {
      const imageUrlsApi = `https://api.figma.com/v1/images/${fileKey}?ids=${nodeIds.join(',')}&format=png&scale=2`;
      
      console.log(`📸 [Figma] Fetching image URLs for ${nodeIds.length} nodes...`);
      console.log(`🔧 [Figma] CURL command to test manually:`);
      console.log(`curl -H "X-Figma-Token: YOUR_TOKEN" "${imageUrlsApi}"`);
      
      const response = await fetch(imageUrlsApi, {
        headers: { 'X-Figma-Token': this.token }
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ [Figma] Image URL fetch failed:', response.status, errorText);
        console.log(`🔧 [Figma] Test this curl command with your token to debug:`);
        console.log(`curl -H "X-Figma-Token: YOUR_TOKEN" "${imageUrlsApi}"`);
        return [];
      }

      const data = await response.json();
      const images = [];
      const minSizeInBytes = CONFIG.MIN_FIGMA_IMAGE_SIZE_KB * 1024;

      for (const nodeId of nodeIds) {
        if (images.length >= CONFIG.MAX_FIGMA_IMAGES) {
          console.warn(`Figma image extraction limit (${CONFIG.MAX_FIGMA_IMAGES}) reached. Skipping further images.`);
          break;
        }

        const imageUrl = data.images[nodeId];
        if (imageUrl) {
          try {
            console.log(`⬇️ [Figma] Downloading image for node ${nodeId}...`);
            console.log(`🔧 [Figma] CURL to download: curl "${imageUrl}" --output ${nodeId.replace(':', '_')}.png`);
            
            const imageResponse = await fetch(imageUrl);
            if (imageResponse.ok) {
              const blob = await imageResponse.blob();
              if (blob.size < minSizeInBytes) {
                console.warn(`⚠️ [Figma] Skipping image ${nodeId} (size ${Math.round(blob.size / 1024)}KB) - smaller than ${CONFIG.MIN_FIGMA_IMAGE_SIZE_KB}KB`);
                continue;
              }
              const base64 = await new Promise(resolve => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.readAsDataURL(blob);
              });
              images.push(base64);
              console.log(`✅ [Figma] Downloaded and converted image ${nodeId} (${Math.round(blob.size / 1024)}KB)`);
            } else {
              console.warn(`❌ [Figma] Failed to fetch image from ${imageUrl}: ${imageResponse.status}`);
            }
          } catch (imgError) {
            console.error(`❌ [Figma] Error fetching or converting image ${imageUrl}:`, imgError);
          }
        } else {
          console.warn(`⚠️ [Figma] No image URL returned for node ${nodeId}`);
        }
      }
      return images;
    } catch (error) {
      console.error('Error in fetchNodeImages:', error);
      return [];
    }
  }
}

// Google Docs Integration
// NOTE: Google Docs API requires OAuth2, not API keys
// For now, we'll use a simpler approach: fetch the public HTML export
class GoogleDocsIntegration {
  constructor(settings) {
    this.apiKey = settings.googleApiKey; // Keep for backward compatibility, but not used
  }
  
  extractUrls(text) {
    // Match Google Docs URLs with optional /edit suffix and query parameters
    const pattern = /https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+(?:\/edit)?(?:\?[A-Za-z0-9=&_-]+)?/gi;
    const matches = text.match(pattern) || [];
    return [...new Set(matches)];
  }
  
  async fetchDocument(url) {
    try {
      const docId = this.extractDocId(url);
      if (!docId) {
        throw new Error('Invalid Google Docs URL format. Could not extract document ID.');
      }

      console.log(`📄 [Google Docs] Fetching document: ${docId}`);
      console.log(`⚠️ [Google Docs] Note: Using public export method (Google Docs API requires OAuth2)`);
      
      // Use the public export URL instead of API
      // This works for publicly shared documents without authentication
      const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
      
      console.log(`🔧 [Google Docs] CURL command to test manually:`);
      console.log(`curl -L "${exportUrl}"`);
      console.log(`\n💡 Note: Document must be shared as "Anyone with the link can view"`);

      const response = await fetch(exportUrl, {
        method: 'GET',
        redirect: 'follow'
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ [Google Docs] Fetch failed:`, response.status, errorText);
        console.log(`🔧 [Google Docs] Test this curl command:`);
        console.log(`curl -L "https://docs.google.com/document/d/${docId}/export?format=txt"`);
        
        if (response.status === 401 || response.status === 403) {
          throw new Error('Google Docs access denied. Please share the document as "Anyone with the link can view".');
        } else if (response.status === 404) {
          throw new Error('Google Doc not found. The document may have been deleted or the link is incorrect.');
        } else {
          throw new Error(`Google Docs export failed with status ${response.status}.`);
        }
      }
      
      console.log(`✅ [Google Docs] Successfully fetched document ${docId}`);

      // Get plain text content from export
      const content = await response.text();
      
      // Truncate if too long
      let finalContent = content;
      if (finalContent.length > CONFIG.MAX_TEXT_EXTRACT_LENGTH) {
        console.warn(`Google Docs content truncated from ${finalContent.length} to ${CONFIG.MAX_TEXT_EXTRACT_LENGTH} characters.`);
        finalContent = finalContent.substring(0, CONFIG.MAX_TEXT_EXTRACT_LENGTH) + '... [Content truncated]';
      }

      return {
        url: url,
        title: `Google Doc ${docId}`,
        content: finalContent,
        revisionId: null
      };
    } catch (error) {
      console.error('Google Docs fetch error:', error);
      throw error; // Re-throw to be handled by IntegrationManager
    }
  }
  
  extractDocId(url) {
    const match = url.match(/\/document\/d\/([^\/]+)/);
    return match ? match[1] : null;
  }
}

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
  async getExistingTestCases(sectionId) {
    try {
      const response = await this.rateLimitedFetch(
        `${this.baseUrl}/index.php?/api/v2/get_cases/${this.projectId}&section_id=${sectionId}&limit=250`,
        { headers: this.getAuthHeaders() }
      );

      if (!response.ok) {
        console.warn('⚠️  Failed to fetch existing test cases for deduplication, will skip deduplication');
        return [];
      }

      const data = await response.json();
      return Array.isArray(data) ? data : (data.cases || []);
    } catch (error) {
      console.warn('⚠️  Error fetching existing test cases, will skip deduplication:', error.message);
      return [];
    }
  }

  /**
   * Deduplicate test cases by checking existing titles
   */
  async deduplicateTestCases(sectionId, testCases) {
    console.log('🔍 Checking for duplicate test cases...');

    const existingCases = await this.getExistingTestCases(sectionId);

    if (existingCases.length === 0) {
      console.log('✅ No existing test cases found, will upload all');
      return { toAdd: testCases, skipped: [] };
    }

    // Create map of existing titles (case-insensitive)
    const caseMap = new Map(
      existingCases.map(c => [c.title.toLowerCase().trim(), c])
    );

    const toAdd = [];
    const skipped = [];

    testCases.forEach(testCase => {
      const normalizedTitle = (testCase.title || '').toLowerCase().trim();
      if (caseMap.has(normalizedTitle)) {
        const existing = caseMap.get(normalizedTitle);
        skipped.push({
          title: testCase.title,
          existingId: existing.id,
          existingUrl: `${this.baseUrl}/index.php?/cases/view/${existing.id}`,
          reason: 'Duplicate title'
        });
      } else {
        toAdd.push(testCase);
      }
    });

    console.log(`✅ Deduplication complete: ${toAdd.length} to add, ${skipped.length} skipped as duplicates`);

    if (skipped.length > 0) {
      console.log(`⚠️  Skipped duplicate test cases:`);
      skipped.forEach(s => console.log(`   - "${s.title}" (ID: ${s.existingId})`));
    }

    return { toAdd, skipped };
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
      const response = await this.rateLimitedFetch(`${this.baseUrl}/projects/${this.projectKey}`, {
        headers: this.getAuthHeaders()
      });

      if (!response.ok) {
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

      // Add Xray-specific custom fields
      payload.fields['customfield_10020'] = 'Manual'; // Test Type (customfield ID may vary)

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
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    IntegrationManager,
    ConfluenceIntegration,
    FigmaIntegration,
    GoogleDocsIntegration,
    TestRailIntegration,
    ZephyrScaleIntegration,
    ZephyrSquadIntegration,
    XrayIntegration,
    QmetryIntegration
  };
}
