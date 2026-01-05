/**
 * Network Monitor - Capture API calls and network requests
 * Version: 12.0.0 - Enhanced with schema inference and error cataloging
 * Monitors fetch/XHR requests to capture API endpoints
 */

class NetworkMonitor {
  constructor() {
    this.requests = [];
    this.isMonitoring = false;
    this.tabId = null;
    // NEW: Schema inference tracking
    this.endpointSchemas = new Map();
    this.errorResponses = [];
    this.paginationPatterns = new Map();
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
      const request = this.requests[index];
      this.requests[index] = {
        ...request,
        statusCode: details.statusCode,
        responseHeaders: this.extractHeaders(details.responseHeaders),
        responseTime: details.timeStamp - request.timestamp
      };

      // NEW: Update endpoint schema with this request
      try {
        const urlObj = new URL(request.url);
        const endpoint = urlObj.pathname;

        // Update schema inference
        this.updateEndpointSchema(
          endpoint,
          request.method,
          request.requestBody,
          null, // Response body not available in webRequest API
          details.statusCode
        );

        // Detect pagination patterns
        this.detectPaginationPattern(request.url, urlObj.searchParams);

        // Catalog error responses
        if (details.statusCode >= 400) {
          this.catalogErrorResponse(endpoint, request.method, details.statusCode, null);
        }
      } catch (e) {
        // URL parsing failed, skip
      }
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
    this.endpointSchemas.clear();
    this.errorResponses = [];
    this.paginationPatterns.clear();
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

  /**
   * NEW: Infer schema from request/response body
   */
  inferSchema(data, depth = 0) {
    if (depth > 3) return { type: 'object', truncated: true };

    if (data === null) return { type: 'null' };
    if (data === undefined) return { type: 'undefined' };

    const type = typeof data;

    if (type === 'string') {
      // Detect special string formats
      if (data.match(/^\d{4}-\d{2}-\d{2}/)) return { type: 'string', format: 'date' };
      if (data.match(/^[^@]+@[^@]+\.[^@]+$/)) return { type: 'string', format: 'email' };
      if (data.match(/^https?:\/\//)) return { type: 'string', format: 'url' };
      if (data.match(/^[a-f0-9-]{36}$/i)) return { type: 'string', format: 'uuid' };
      return { type: 'string', example: data.substring(0, 50) };
    }

    if (type === 'number') {
      return { type: Number.isInteger(data) ? 'integer' : 'number', example: data };
    }

    if (type === 'boolean') return { type: 'boolean' };

    if (Array.isArray(data)) {
      if (data.length === 0) return { type: 'array', items: { type: 'unknown' } };
      return {
        type: 'array',
        items: this.inferSchema(data[0], depth + 1),
        length: data.length
      };
    }

    if (type === 'object') {
      const properties = {};
      const keys = Object.keys(data).slice(0, 20); // Limit to 20 properties
      for (const key of keys) {
        properties[key] = this.inferSchema(data[key], depth + 1);
      }
      return {
        type: 'object',
        properties,
        propertyCount: Object.keys(data).length
      };
    }

    return { type };
  }

  /**
   * NEW: Update endpoint schema with new request data
   */
  updateEndpointSchema(endpoint, method, requestBody, responseBody, statusCode) {
    const key = `${method} ${endpoint}`;

    if (!this.endpointSchemas.has(key)) {
      this.endpointSchemas.set(key, {
        endpoint,
        method,
        requestSchemas: [],
        responseSchemas: [],
        statusCodes: new Set(),
        sampleCount: 0
      });
    }

    const schema = this.endpointSchemas.get(key);
    schema.sampleCount++;
    schema.statusCodes.add(statusCode);

    // Infer request schema (limit samples)
    if (requestBody && schema.requestSchemas.length < 3) {
      try {
        const reqSchema = this.inferSchema(
          typeof requestBody === 'string' ? JSON.parse(requestBody) : requestBody.data || requestBody
        );
        if (!this.schemaExists(schema.requestSchemas, reqSchema)) {
          schema.requestSchemas.push(reqSchema);
        }
      } catch (e) {
        // Not JSON, skip
      }
    }

    // Infer response schema (limit samples)
    if (responseBody && schema.responseSchemas.length < 3) {
      try {
        const respSchema = this.inferSchema(
          typeof responseBody === 'string' ? JSON.parse(responseBody) : responseBody
        );
        if (!this.schemaExists(schema.responseSchemas, respSchema)) {
          schema.responseSchemas.push(respSchema);
        }
      } catch (e) {
        // Not JSON, skip
      }
    }
  }

  /**
   * Check if similar schema already exists
   */
  schemaExists(schemas, newSchema) {
    if (schemas.length === 0) return false;
    // Simple check based on top-level properties
    const newProps = newSchema.properties ? Object.keys(newSchema.properties).sort().join(',') : '';
    return schemas.some(s => {
      const existingProps = s.properties ? Object.keys(s.properties).sort().join(',') : '';
      return existingProps === newProps;
    });
  }

  /**
   * NEW: Get inferred API schemas
   */
  getApiSchemas() {
    const schemas = [];
    for (const [key, schema] of this.endpointSchemas) {
      schemas.push({
        endpoint: schema.endpoint,
        method: schema.method,
        sampleCount: schema.sampleCount,
        statusCodes: Array.from(schema.statusCodes),
        requestSchema: schema.requestSchemas[0] || null,
        responseSchema: schema.responseSchemas[0] || null,
        hasMultipleSchemas: schema.requestSchemas.length > 1 || schema.responseSchemas.length > 1
      });
    }
    return schemas;
  }

  /**
   * NEW: Catalog error responses
   */
  catalogErrorResponse(endpoint, method, statusCode, errorBody) {
    if (statusCode >= 400) {
      let errorMessage = '';
      let errorCode = '';

      try {
        const parsed = typeof errorBody === 'string' ? JSON.parse(errorBody) : errorBody;
        errorMessage = parsed.message || parsed.error || parsed.detail || JSON.stringify(parsed).substring(0, 100);
        errorCode = parsed.code || parsed.errorCode || '';
      } catch (e) {
        errorMessage = typeof errorBody === 'string' ? errorBody.substring(0, 100) : 'Unknown error';
      }

      // Avoid duplicates
      const exists = this.errorResponses.some(e =>
        e.endpoint === endpoint && e.statusCode === statusCode && e.message === errorMessage
      );

      if (!exists && this.errorResponses.length < 50) {
        this.errorResponses.push({
          endpoint,
          method,
          statusCode,
          message: errorMessage,
          code: errorCode,
          category: this.categorizeHttpError(statusCode),
          timestamp: Date.now()
        });
      }
    }
  }

  /**
   * Categorize HTTP error
   */
  categorizeHttpError(statusCode) {
    if (statusCode === 400) return 'bad-request';
    if (statusCode === 401) return 'unauthorized';
    if (statusCode === 403) return 'forbidden';
    if (statusCode === 404) return 'not-found';
    if (statusCode === 409) return 'conflict';
    if (statusCode === 422) return 'validation';
    if (statusCode === 429) return 'rate-limit';
    if (statusCode >= 500) return 'server-error';
    return 'client-error';
  }

  /**
   * NEW: Get cataloged error responses
   */
  getErrorResponses() {
    return this.errorResponses;
  }

  /**
   * NEW: Detect pagination patterns
   */
  detectPaginationPattern(endpoint, queryParams) {
    if (!queryParams) return;

    const paginationParams = ['page', 'offset', 'limit', 'skip', 'cursor', 'after', 'before', 'start', 'count'];

    for (const param of paginationParams) {
      if (queryParams.has(param)) {
        const baseEndpoint = endpoint.split('?')[0];

        if (!this.paginationPatterns.has(baseEndpoint)) {
          this.paginationPatterns.set(baseEndpoint, {
            endpoint: baseEndpoint,
            type: this.detectPaginationType(param),
            params: new Set()
          });
        }

        this.paginationPatterns.get(baseEndpoint).params.add(param);
      }
    }
  }

  /**
   * Detect pagination type from parameter
   */
  detectPaginationType(param) {
    if (['cursor', 'after', 'before'].includes(param)) return 'cursor';
    if (['offset', 'skip', 'start'].includes(param)) return 'offset';
    if (param === 'page') return 'page-number';
    return 'unknown';
  }

  /**
   * NEW: Get detected pagination patterns
   */
  getPaginationPatterns() {
    const patterns = [];
    for (const [endpoint, pattern] of this.paginationPatterns) {
      patterns.push({
        endpoint: pattern.endpoint,
        type: pattern.type,
        params: Array.from(pattern.params)
      });
    }
    return patterns;
  }

  /**
   * NEW: Get enhanced API summary with schemas
   */
  getEnhancedApiSummary() {
    return {
      endpoints: this.getApiSchemas(),
      errors: this.getErrorResponses(),
      pagination: this.getPaginationPatterns(),
      stats: this.getStats()
    };
  }
}

// Export for use in background script
if (typeof module !== 'undefined' && module.exports) {
  module.exports = NetworkMonitor;
}
