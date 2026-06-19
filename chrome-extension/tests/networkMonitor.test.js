/**
 * Tests for NetworkMonitor (network-monitor.js). It uses module.exports, reads a
 * CONFIG global (stubbed), and touches chrome.webRequest in start()/stop() — we
 * supply chrome via the shared createChromeMock(). URL/TextDecoder are provided
 * by the Node global scope (default vitest environment), so no DOM is required.
 *
 * The tests drive the recording pipeline by calling handleRequest/handleResponse
 * directly with webRequest-shaped detail objects — that's the data shape the
 * monitor accumulates in production.
 */
const { createChromeMock } = require('./helpers/chrome-mock.js');

global.chrome = createChromeMock();
global.CONFIG = global.CONFIG || { get: (_k, d) => d };
const NetworkMonitor = require('../network-monitor.js');

function newMonitor() {
  const m = new NetworkMonitor();
  m.isMonitoring = true; // handleRequest/handleResponse bail out when false
  return m;
}

describe('NetworkMonitor.isApiRequest', () => {
  const m = new NetworkMonitor();
  test('matches /api/ and /graphql and .json, rejects plain pages', () => {
    expect(m.isApiRequest('https://x.com/api/users')).toBe(true);
    expect(m.isApiRequest('https://x.com/graphql')).toBe(true);
    expect(m.isApiRequest('https://x.com/data.json')).toBe(true);
    expect(m.isApiRequest('https://x.com/about')).toBe(false);
    expect(m.isApiRequest('not a url')).toBe(false);
  });
});

describe('NetworkMonitor request/response recording', () => {
  test('records an API request and merges the response details', () => {
    const m = newMonitor();
    m.handleRequest({
      requestId: '1', url: 'https://x.com/api/users', method: 'GET',
      type: 'xmlhttprequest', timeStamp: 1000, requestBody: null,
    });
    expect(m.requests).toHaveLength(1);

    m.handleResponse({
      requestId: '1', statusCode: 200, timeStamp: 1150,
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    });

    const req = m.requests[0];
    expect(req.statusCode).toBe(200);
    expect(req.responseTime).toBe(150);
    expect(req.responseHeaders['content-type']).toBe('application/json');
  });

  test('ignores non-API requests', () => {
    const m = newMonitor();
    m.handleRequest({ requestId: '2', url: 'https://x.com/home', method: 'GET', timeStamp: 1 });
    expect(m.requests).toHaveLength(0);
  });

  test('does nothing while not monitoring', () => {
    const m = new NetworkMonitor(); // isMonitoring defaults to false
    m.handleRequest({ requestId: '3', url: 'https://x.com/api/x', method: 'GET', timeStamp: 1 });
    expect(m.requests).toHaveLength(0);
  });
});

describe('NetworkMonitor.getApiCalls / getApiByEndpoint', () => {
  function seed() {
    const m = newMonitor();
    m.handleRequest({ requestId: 'a', url: 'https://x.com/api/items?page=1', method: 'GET', timeStamp: 0 });
    m.handleResponse({ requestId: 'a', statusCode: 200, timeStamp: 100, responseHeaders: [] });
    m.handleRequest({ requestId: 'b', url: 'https://x.com/api/items', method: 'POST', timeStamp: 0 });
    m.handleResponse({ requestId: 'b', statusCode: 201, timeStamp: 50, responseHeaders: [] });
    return m;
  }

  test('getApiCalls returns a flattened shape per request', () => {
    const calls = seed().getApiCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveProperty('url');
    expect(calls[0]).toHaveProperty('method');
    expect(calls[0]).toHaveProperty('statusCode');
  });

  test('getApiByEndpoint groups by pathname with method set and counts', () => {
    const grouped = seed().getApiByEndpoint();
    const ep = grouped['/api/items'];
    expect(ep.count).toBe(2);
    expect(ep.methods.sort()).toEqual(['GET', 'POST']);
    expect(ep.statusCodes['200']).toBe(1);
    expect(ep.statusCodes['201']).toBe(1);
  });
});

describe('NetworkMonitor.getStats', () => {
  test('aggregates counts by method/status and average response time', () => {
    const m = newMonitor();
    m.handleRequest({ requestId: '1', url: 'https://x.com/api/a', method: 'GET', timeStamp: 0 });
    m.handleResponse({ requestId: '1', statusCode: 200, timeStamp: 100, responseHeaders: [] });
    m.handleRequest({ requestId: '2', url: 'https://x.com/api/b', method: 'GET', timeStamp: 0 });
    m.handleResponse({ requestId: '2', statusCode: 500, timeStamp: 300, responseHeaders: [] });

    const stats = m.getStats();
    expect(stats.totalRequests).toBe(2);
    expect(stats.byMethod.GET).toBe(2);
    expect(stats.byStatus['200']).toBe(1);
    expect(stats.byStatus['500']).toBe(1);
    expect(stats.avgResponseTime).toBe(200);
  });
});

describe('NetworkMonitor schema inference + error/pagination cataloging', () => {
  test('inferSchema describes objects, arrays and special string formats', () => {
    const m = new NetworkMonitor();
    const s = m.inferSchema({ id: 1, email: 'a@b.com', when: '2024-01-02', tags: ['x'] });
    expect(s.type).toBe('object');
    expect(s.properties.id.type).toBe('integer');
    expect(s.properties.email).toEqual({ type: 'string', format: 'email' });
    expect(s.properties.when).toEqual({ type: 'string', format: 'date' });
    expect(s.properties.tags.type).toBe('array');
  });

  test('catalogErrorResponse records 4xx/5xx with a category', () => {
    const m = new NetworkMonitor();
    m.catalogErrorResponse('/api/x', 'GET', 404, JSON.stringify({ message: 'Not found' }));
    const errors = m.getErrorResponses();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('Not found');
    expect(errors[0].category).toBe('not-found');
  });

  test('catalogErrorResponse ignores 2xx', () => {
    const m = new NetworkMonitor();
    m.catalogErrorResponse('/api/x', 'GET', 200, '{}');
    expect(m.getErrorResponses()).toHaveLength(0);
  });

  test('detectPaginationPattern records pagination type by param', () => {
    const m = new NetworkMonitor();
    m.detectPaginationPattern('/api/items', new URLSearchParams('page=2'));
    m.detectPaginationPattern('/api/feed', new URLSearchParams('cursor=abc'));
    const patterns = m.getPaginationPatterns();
    const byEp = Object.fromEntries(patterns.map(p => [p.endpoint, p.type]));
    expect(byEp['/api/items']).toBe('page-number');
    expect(byEp['/api/feed']).toBe('cursor');
  });

  test('categorizeHttpError maps status codes', () => {
    const m = new NetworkMonitor();
    expect(m.categorizeHttpError(401)).toBe('unauthorized');
    expect(m.categorizeHttpError(429)).toBe('rate-limit');
    expect(m.categorizeHttpError(503)).toBe('server-error');
  });
});

describe('NetworkMonitor.clear', () => {
  test('resets requests and all derived catalogs', () => {
    const m = newMonitor();
    m.handleRequest({ requestId: '1', url: 'https://x.com/api/a', method: 'GET', timeStamp: 0 });
    m.handleResponse({ requestId: '1', statusCode: 404, timeStamp: 1, responseHeaders: [] });
    expect(m.requests.length).toBeGreaterThan(0);
    m.clear();
    expect(m.requests).toHaveLength(0);
    expect(m.getErrorResponses()).toHaveLength(0);
    expect(m.getPaginationPatterns()).toHaveLength(0);
  });
});

describe('NetworkMonitor.start/stop with chrome.webRequest', () => {
  test('toggles monitoring flag and tracks tab id without throwing', async () => {
    // The shared chrome mock's webRequest listeners only expose addListener;
    // stop() calls removeListener, so add no-op removeListener stubs on the
    // mock object (not the harness file) for this test only.
    chrome.webRequest.onBeforeRequest.removeListener = () => {};
    chrome.webRequest.onCompleted.removeListener = () => {};

    const m = new NetworkMonitor();
    await m.start(42);
    expect(m.isMonitoring).toBe(true);
    expect(m.tabId).toBe(42);
    m.stop();
    expect(m.isMonitoring).toBe(false);
  });
});
