/**
 * Crawler reliability in parallel mode (the default).
 *
 * 1. The network monitor filtered webRequest to the ORIGINAL tab only, so API
 *    calls made by the extra parallel tabs were never captured, and one shared
 *    page cursor let concurrent pages claim each other's calls.
 * 2. A page that failed for good was re-queued every time another page linked
 *    to it, and failed again each time.
 * 3. A non-Error rejection crashed handleCrawlError, rejecting the batch's
 *    Promise.all and aborting the crawl.
 */
const { createChromeMock } = require('./helpers/chrome-mock.js');
global.chrome = global.chrome || createChromeMock();
global.CONFIG = global.CONFIG || { get: (_k, d) => d };
const NetworkMonitor = require('../network-monitor.js');
const WebAppCrawler = require('../crawler.js');
const P = WebAppCrawler.prototype;

const req = (id, url, tabId) => ({ requestId: id, url, method: 'GET', type: 'xmlhttprequest', timeStamp: 1, tabId });

describe('network capture across parallel tabs', () => {
  test('requests from an added worker tab are captured; foreign tabs are not', async () => {
    const m = new NetworkMonitor();
    await m.start(1);
    m.addTab(2);
    m.handleRequest(req('a', 'https://app.example.com/api/one', 1));
    m.handleRequest(req('b', 'https://app.example.com/api/two', 2));
    m.handleRequest(req('c', 'https://app.example.com/api/user-tab', 99)); // user's own browsing
    m.handleRequest(req('d', 'https://app.example.com/api/head', -1));     // worker's own fetch
    expect(m.getApiCalls().map(r => r.url)).toEqual([
      'https://app.example.com/api/one', 'https://app.example.com/api/two']);
    m.stop();
  });

  test('concurrent pages each get only their own tab\'s calls', async () => {
    const m = new NetworkMonitor();
    await m.start(1);
    m.addTab(2);
    m.beginPage('https://app.example.com/a', 1);
    m.beginPage('https://app.example.com/b', 2);
    m.handleRequest(req('1', 'https://app.example.com/api/alpha', 1));
    m.handleRequest(req('2', 'https://app.example.com/api/beta', 2));
    m.handleRequest(req('3', 'https://app.example.com/api/alpha2', 1));
    expect(m.takeApiCallsForPage(2).map(r => r.url)).toEqual(['https://app.example.com/api/beta']);
    expect(m.takeApiCallsForPage(1).map(r => r.url)).toEqual([
      'https://app.example.com/api/alpha', 'https://app.example.com/api/alpha2']);
    m.stop();
  });

  test('interceptor captures are attributed to the tab they were drained from', async () => {
    const m = new NetworkMonitor();
    await m.start(1);
    m.addTab(2);
    m.beginPage('https://app.example.com/b', 2);
    m.ingestResponseBody({ url: 'https://app.example.com/api/only-in-page', method: 'GET', status: 200, body: { ok: 1 } }, 2);
    expect(m.takeApiCallsForPage(2).map(r => r.url)).toEqual(['https://app.example.com/api/only-in-page']);
    expect(m.takeApiCallsForPage(1)).toEqual([]);
    m.stop();
  });

  test('the crawler registers every parallel tab with the monitor', async () => {
    const added = [];
    const self = { activeTabs: new Set(), networkMonitor: { addTab: (id) => added.push(id) } };
    const created = await P.createParallelTab.call(self);
    expect(added).toEqual([created]);
  });
});

describe('failed pages', () => {
  const stub = () => ({
    consecutiveErrors: 0, retryCount: {}, queue: [], errors: [], failedUrls: new Set(),
    sleep: async () => {}
  });

  test('a page that failed for good is not queued again', async () => {
    const self = stub();
    await P.handleCrawlError.call(self, 'https://app.example.com/broken', 1, new Error('Cannot read page'));
    expect(self.failedUrls.has('https://app.example.com/broken')).toBe(true);
    // shouldQueueUrl short-circuits on failedUrls before any other check.
    expect(P.shouldQueueUrl.call({ ...self, isInjectableUrl: () => true }, 'https://app.example.com/broken')).toBe(false);
  });

  test('a retryable failure is retried, not marked failed', async () => {
    const self = stub();
    await P.handleCrawlError.call(self, 'https://app.example.com/slow', 1, new Error('Navigation timeout'));
    expect(self.queue).toEqual([{ url: 'https://app.example.com/slow', depth: 1 }]);
    expect(self.failedUrls.size).toBe(0);
  });

  test('a transient failure is retried 3 times, then marked failed', async () => {
    const self = stub();
    const url = 'https://app.example.com/flaky';
    for (let i = 0; i < 4; i++) {
      await P.handleCrawlError.call(self, url, 1, new Error('Navigation timeout'));
    }
    expect(self.retryCount[url]).toBe(3);
    expect(self.queue).toHaveLength(3);          // re-queued once per retry
    expect(self.failedUrls.has(url)).toBe(true); // the 4th failure is final
    expect(self.errors).toEqual([expect.objectContaining({ url, retries: 3 })]);
  });

  test('a script-injection failure is retried like any transient error', async () => {
    const self = stub();
    await P.handleCrawlError.call(self, 'https://app.example.com/slow-spa', 1,
      new Error('Script injection failed for https://app.example.com/slow-spa'));
    expect(self.queue).toHaveLength(1);
    expect(self.failedUrls.size).toBe(0);
  });

  test('retries can be switched off in config', async () => {
    const saved = global.CONFIG;
    global.CONFIG = { get: (k, d) => (k === 'crawler.retry.enabled' ? false : d) };
    try {
      const self = stub();
      await P.handleCrawlError.call(self, 'https://app.example.com/x', 1, new Error('Navigation timeout'));
      expect(self.queue).toHaveLength(0);
      expect(self.failedUrls.has('https://app.example.com/x')).toBe(true);
    } finally {
      global.CONFIG = saved;
    }
  });

  test('a non-Error rejection is recorded instead of crashing the batch', async () => {
    const self = stub();
    await expect(P.handleCrawlError.call(self, 'https://app.example.com/x', 1, 'tab was closed')).resolves.toBeUndefined();
    await expect(P.handleCrawlError.call(self, 'https://app.example.com/y', 1, undefined)).resolves.toBeUndefined();
    expect(self.errors.map(e => e.error)).toEqual(['tab was closed', 'Unknown error']);
  });
});
