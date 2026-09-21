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

describe('NetworkMonitor.ingestResponseBody (item 5: response bodies)', () => {
  test('attaches a captured response body to a matching webRequest record', () => {
    const m = newMonitor();
    m.handleRequest({ requestId: '1', url: 'https://app.io/api/users', method: 'GET', type: 'xmlhttprequest', timeStamp: 1000, requestBody: null });
    m.handleResponse({ requestId: '1', statusCode: 200, responseHeaders: [], timeStamp: 1100 });

    m.ingestResponseBody({ url: 'https://app.io/api/users', method: 'GET', status: 200, body: { users: [{ id: 1, name: 'Ada' }] } });

    const call = m.getApiCalls().find((c) => c.url === 'https://app.io/api/users');
    expect(call.responseBody).toEqual({ users: [{ id: 1, name: 'Ada' }] });
    const schema = m.getApiSchemas().find((s) => s.endpoint === '/api/users');
    expect(schema.responseSchema).toBeTruthy();
  });

  test('records a new API entry when the interceptor saw a call webRequest missed', () => {
    const m = newMonitor();
    m.ingestResponseBody({ url: 'https://app.io/api/orders', method: 'POST', status: 201, body: { id: 9 }, requestBody: { sku: 'X' } });
    const call = m.getApiCalls().find((c) => c.url === 'https://app.io/api/orders');
    expect(call).toBeTruthy();
    expect(call.method).toBe('POST');
    expect(call.responseBody).toEqual({ id: 9 });
  });

  test('catalogs an error response body for 4xx/5xx', () => {
    const m = newMonitor();
    m.ingestResponseBody({ url: 'https://app.io/api/thing', method: 'GET', status: 404, body: { message: 'Not found', code: 'E404' } });
    expect(m.getErrorResponses().some((e) => e.endpoint === '/api/thing' && e.statusCode === 404 && /Not found/.test(e.message))).toBe(true);
  });

  test('ignores non-API URLs', () => {
    const m = newMonitor();
    m.ingestResponseBody({ url: 'https://app.io/about', method: 'GET', status: 200, body: '<html></html>' });
    expect(m.getApiCalls()).toHaveLength(0);
  });

  test('truncateBody clips oversized strings and keeps small objects', () => {
    const m = new NetworkMonitor();
    const big = 'x'.repeat(50000);
    const clipped = m.truncateBody(big);
    expect(clipped.length).toBeLessThan(big.length);
    expect(clipped).toMatch(/truncated/);
    expect(m.truncateBody({ a: 1 })).toEqual({ a: 1 });
    expect(m.truncateBody(null)).toBeNull();
  });
});

describe('NetworkMonitor.start/stop with chrome.webRequest', () => {
  test('toggles monitoring flag and tracks tab id without throwing', async () => {
    // The shared chrome mock's webRequest listeners only expose addListener;
    // The chrome mock's webRequest events now track listeners faithfully, so the
    // old no-op removeListener stubs are gone — they permanently replaced the
    // mock's method and left every later test unable to detach anything.
    const m = new NetworkMonitor();
    await m.start(42);
    expect(m.isMonitoring).toBe(true);
    expect(m.tabId).toBe(42);
    m.stop();
    expect(m.isMonitoring).toBe(false);
  });
});

describe('F18 — observation lifecycle and attribution', () => {
  function listenerCounts() {
    return {
      before: chrome.webRequest.onBeforeRequest._listeners?.length ?? 0,
      completed: chrome.webRequest.onCompleted._listeners?.length ?? 0
    };
  }

  test('repeated start/stop leaves no extra listeners', async () => {
    const m = new NetworkMonitor();
    const base = listenerCounts();
    for (let i = 0; i < 3; i++) { await m.start(1); m.stop(); }
    const after = listenerCounts();
    // Pre-fix: stop() passed the UNBOUND prototype method to removeListener, so
    // it matched nothing and every cycle leaked a pair.
    expect(after.before).toBe(base.before);
    expect(after.completed).toBe(base.completed);
  });

  test('a second start() without a stop() does not stack listeners', async () => {
    const m = new NetworkMonitor();
    const base = listenerCounts();
    await m.start(1);
    await m.start(1);
    const during = listenerCounts();
    expect(during.before - base.before).toBe(1);
    m.stop();
    expect(listenerCounts().before).toBe(base.before);
  });

  test("page A's API is not attributed to page B", () => {
    const m = newMonitor();
    const hit = (id, url) => m.handleRequest({ requestId: id, url, method: 'GET', type: 'xmlhttprequest', timeStamp: Date.now() });

    m.beginPage('https://app/a');
    hit('1', 'https://app/api/alpha');
    const pageA = m.takeApiCallsForPage();

    m.beginPage('https://app/b');
    hit('2', 'https://app/api/beta');
    const pageB = m.takeApiCallsForPage();

    expect(pageA.map(a => a.url)).toEqual(['https://app/api/alpha']);
    // Pre-fix crawlPage read the cumulative list, so page B claimed alpha too.
    expect(pageB.map(a => a.url)).toEqual(['https://app/api/beta']);
  });

  test('without a page boundary the full list is still returned', () => {
    const m = newMonitor();
    m.handleRequest({ requestId: '1', url: 'https://app/api/x', method: 'GET', type: 'xmlhttprequest', timeStamp: 1 });
    expect(m.getApiCalls()).toHaveLength(1);
  });

  test('a bare /graphql path is treated as an API by both layers', () => {
    const m = new NetworkMonitor();
    expect(m.isApiRequest('https://x.com/graphql')).toBe(true);
    // The MAIN-world interceptor's matcher previously required a trailing slash.
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'network-interceptor.js'), 'utf8');
    const match = src.match(/function isApiish[\s\S]*?\n  \}/);
    expect(match).toBeTruthy();
    const isApiish = new Function('location', 'URL', `${match[0]}; return isApiish;`)(
      { href: 'https://x.com/' }, URL);
    expect(isApiish('https://x.com/graphql')).toBe(true);
    expect(isApiish('https://x.com/api/users')).toBe(true);
    expect(isApiish('https://x.com/about')).toBe(false);
  });
});
