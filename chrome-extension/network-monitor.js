/**
 * Network Monitor - Capture API calls and network requests
 * Version: 11.0.0
 * Monitors fetch/XHR requests to capture API endpoints
 */

class NetworkMonitor {
  constructor() {
    this.requests = [];
    this.isMonitoring = false;
    this.tabId = null;
  }

  /**
   * Start monitoring network requests
   * @param {number} tabId - Chrome tab ID to monitor
   */
  async start(tabId) {
    this.tabId = tabId;
    this.isMonitoring = true;
    this.requests = [];

    console.log('🌐 Network monitoring started');

    // Set up webRequest listeners
    if (chrome.webRequest && chrome.webRequest.onBeforeRequest) {
      chrome.webRequest.onBeforeRequest.addListener(
        this.handleRequest.bind(this),
        { urls: ["<all_urls>"], tabId: this.tabId },
        ["requestBody"]
      );

      chrome.webRequest.onCompleted.addListener(
        this.handleResponse.bind(this),
        { urls: ["<all_urls>"], tabId: this.tabId },
        ["responseHeaders"]
      );
    }
  }

  /**
   * Stop monitoring network requests
   */
  stop() {
    this.isMonitoring = false;
    console.log(`🌐 Network monitoring stopped: Captured ${this.requests.length} requests`);

    // Remove listeners
    if (chrome.webRequest && chrome.webRequest.onBeforeRequest) {
      chrome.webRequest.onBeforeRequest.removeListener(this.handleRequest);
      chrome.webRequest.onCompleted.removeListener(this.handleResponse);
    }
  }

  /**
   * Handle network request
   */
  handleRequest(details) {
    if (!this.isMonitoring) return;

    // Only capture API-like requests
    if (this.isApiRequest(details.url)) {
      const request = {
        id: details.requestId,
        url: details.url,
        method: details.method,
        type: details.type,
        timestamp: details.timeStamp,
        requestBody: this.extractRequestBody(details.requestBody)
      };

      // Store request
      const index = this.requests.findIndex(r => r.id === details.requestId);
      if (index >= 0) {
        this.requests[index] = { ...this.requests[index], ...request };
      } else {
        this.requests.push(request);
      }
    }
  }

  /**
   * Handle network response
   */
  handleResponse(details) {
    if (!this.isMonitoring) return;

    const index = this.requests.findIndex(r => r.id === details.requestId);
    if (index >= 0) {
      this.requests[index] = {
        ...this.requests[index],
        statusCode: details.statusCode,
        responseHeaders: this.extractHeaders(details.responseHeaders),
        responseTime: details.timeStamp - this.requests[index].timestamp
      };
    }
  }

  /**
   * Check if URL is an API request
   */
  isApiRequest(url) {
    try {
      const urlObj = new URL(url);

      // Common API patterns from config
      const apiPatternsConfig = CONFIG.get('network.endpoints.apiPatterns', [
        '/api/', '/rest/', '/graphql', '/v1/', '/v2/'
      ]);

      // Convert string patterns to regex
      const apiPatterns = apiPatternsConfig.map(pattern => {
        if (pattern.includes('\\d+')) {
          return new RegExp(pattern);
        }
        return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      });

      // Additional patterns
      apiPatterns.push(/\.json$/, /\/ajax\//i);

      // API file extensions
      const apiExtensions = ['.json', '.xml'];

      // Check patterns
      if (apiPatterns.some(pattern => pattern.test(urlObj.pathname))) {
        return true;
      }

      // Check extensions
      if (apiExtensions.some(ext => urlObj.pathname.endsWith(ext))) {
        return true;
      }

      // Check for fetch/XHR content types
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Extract request body
   */
  extractRequestBody(requestBody) {
    if (!requestBody) return null;

    try {
      if (requestBody.formData) {
        return { type: 'formData', data: requestBody.formData };
      }

      if (requestBody.raw) {
        const decoder = new TextDecoder('utf-8');
        const bodyText = decoder.decode(requestBody.raw[0].bytes);
        try {
          return { type: 'json', data: JSON.parse(bodyText) };
        } catch {
          return { type: 'text', data: bodyText };
        }
      }
    } catch (error) {
      console.error('Error extracting request body:', error);
    }

    return null;
  }

  /**
   * Extract headers
   */
  extractHeaders(headers) {
    if (!headers) return {};

    const headerObj = {};
    for (const header of headers) {
      headerObj[header.name.toLowerCase()] = header.value;
    }
    return headerObj;
  }

  /**
   * Get all captured API calls
   */
  getApiCalls() {
    return this.requests.map(req => ({
      url: req.url,
      method: req.method,
      statusCode: req.statusCode,
      responseTime: req.responseTime,
      requestBody: req.requestBody,
      contentType: req.responseHeaders?.['content-type'] || 'unknown'
    }));
  }

  /**
   * Get API calls grouped by endpoint
   */
  getApiByEndpoint() {
    const grouped = {};

    for (const req of this.requests) {
      try {
        const url = new URL(req.url);
        const endpoint = url.pathname;

        if (!grouped[endpoint]) {
          grouped[endpoint] = {
            endpoint,
            methods: new Set(),
            count: 0,
            avgResponseTime: 0,
            statusCodes: {}
          };
        }

        grouped[endpoint].methods.add(req.method);
        grouped[endpoint].count++;
        grouped[endpoint].avgResponseTime += req.responseTime || 0;

        const status = req.statusCode || 'unknown';
        grouped[endpoint].statusCodes[status] = (grouped[endpoint].statusCodes[status] || 0) + 1;
      } catch {
        continue;
      }
    }

    // Convert sets to arrays and calculate averages
    Object.values(grouped).forEach(g => {
      g.methods = Array.from(g.methods);
      g.avgResponseTime = Math.round(g.avgResponseTime / g.count);
    });

    return grouped;
  }

  /**
   * Get GraphQL queries
   */
  getGraphQLQueries() {
    return this.requests
      .filter(req => req.url.includes('graphql') || req.url.includes('graph'))
      .map(req => ({
        url: req.url,
        query: req.requestBody?.data?.query || null,
        variables: req.requestBody?.data?.variables || null
      }))
      .filter(q => q.query);
  }

  /**
   * Get REST endpoints summary
   */
  getRESTEndpoints() {
    const endpoints = this.getApiByEndpoint();
    return Object.values(endpoints).map(e => ({
      endpoint: e.endpoint,
      methods: e.methods,
      callCount: e.count,
      avgResponseTime: e.avgResponseTime
    }));
  }

  /**
   * Clear captured requests
   */
  clear() {
    this.requests = [];
    console.log('🗑️ Network monitor cleared');
  }

  /**
   * Get monitoring statistics
   */
  getStats() {
    const stats = {
      totalRequests: this.requests.length,
      byMethod: {},
      byStatus: {},
      avgResponseTime: 0
    };

    for (const req of this.requests) {
      // Count by method
      stats.byMethod[req.method] = (stats.byMethod[req.method] || 0) + 1;

      // Count by status
      const status = req.statusCode || 'unknown';
      stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;

      // Sum response times
      stats.avgResponseTime += req.responseTime || 0;
    }

    // Calculate average
    if (this.requests.length > 0) {
      stats.avgResponseTime = Math.round(stats.avgResponseTime / this.requests.length);
    }

    return stats;
  }
}

// Export for use in background script
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NetworkMonitor;
}
