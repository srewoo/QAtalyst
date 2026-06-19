/**
 * Coverage tests for WebAppCrawler's content-script messaging wrappers.
 *
 * extractPageData / discoverLinks / getPageMetadata / extractTextContent /
 * getErrorPatterns / getPageHints each wrap chrome.tabs.sendMessage in a
 * timeout-guarded Promise, unwrapping a response field and degrading gracefully
 * to a safe default on chrome.runtime.lastError. We drive the REAL methods with
 * a chrome stub whose sendMessage synchronously invokes the callback.
 */
global.CONFIG = global.CONFIG || { get: (_k, d) => d };
const WebAppCrawler = require('../crawler.js');
const P = WebAppCrawler.prototype;
const call = (method, self, ...args) => P[method].call(self, ...args);

// Build a chrome whose tabs.sendMessage replies with `response` (and optionally
// sets lastError before invoking the callback).
function chromeReplying(response, { lastError = null } = {}) {
  return {
    runtime: { lastError },
    tabs: {
      sendMessage: (_id, _msg, cb) => { cb(response); },
    },
  };
}

afterEach(() => { delete global.chrome; });

describe('extractPageData', () => {
  test('returns the features array from the response', async () => {
    global.chrome = chromeReplying({ features: [{ type: 'form' }] });
    expect(await call('extractPageData', {}, 1)).toEqual([{ type: 'form' }]);
  });
  test('returns [] when the content script errors', async () => {
    global.chrome = chromeReplying(undefined, { lastError: { message: 'no receiver' } });
    expect(await call('extractPageData', {}, 1)).toEqual([]);
  });
});

describe('discoverLinks', () => {
  test('returns the links array and forwards the base URL', async () => {
    const seen = [];
    global.chrome = { runtime: { lastError: null }, tabs: { sendMessage: (_i, msg, cb) => { seen.push(msg); cb({ links: ['a', 'b'] }); } } };
    const self = { startUrl: 'https://x.com/' };
    expect(await call('discoverLinks', self, 1)).toEqual(['a', 'b']);
    expect(seen[0]).toMatchObject({ action: 'discoverLinks', baseUrl: 'https://x.com/' });
  });
  test('returns [] on error', async () => {
    global.chrome = chromeReplying(undefined, { lastError: { message: 'boom' } });
    expect(await call('discoverLinks', { startUrl: 'https://x.com/' }, 1)).toEqual([]);
  });
});

describe('getPageMetadata', () => {
  test('returns the response when present', async () => {
    global.chrome = chromeReplying({ title: 'Home', description: 'd', url: 'u', loadTime: 5 });
    expect(await call('getPageMetadata', {}, 1)).toMatchObject({ title: 'Home', loadTime: 5 });
  });
  test('returns an empty-metadata shape on error', async () => {
    global.chrome = chromeReplying(undefined, { lastError: { message: 'x' } });
    expect(await call('getPageMetadata', {}, 1)).toEqual({ title: '', description: '', url: '', loadTime: 0 });
  });
});

describe('extractTextContent', () => {
  test('returns the textContent string from the response', async () => {
    global.chrome = chromeReplying({ textContent: 'hello world' });
    expect(await call('extractTextContent', {}, 1)).toBe('hello world');
  });
  test('returns null when no text content is present', async () => {
    global.chrome = chromeReplying({ textContent: null, error: 'empty' });
    expect(await call('extractTextContent', {}, 1)).toBeNull();
  });
  test('returns null on error', async () => {
    global.chrome = chromeReplying(undefined, { lastError: { message: 'x' } });
    expect(await call('extractTextContent', {}, 1)).toBeNull();
  });
});

describe('getErrorPatterns', () => {
  test('returns the errorPatterns array', async () => {
    global.chrome = chromeReplying({ errorPatterns: [{ type: 'required' }] });
    expect(await call('getErrorPatterns', {}, 1)).toEqual([{ type: 'required' }]);
  });
  test('returns [] on error', async () => {
    global.chrome = chromeReplying(undefined, { lastError: { message: 'x' } });
    expect(await call('getErrorPatterns', {}, 1)).toEqual([]);
  });
});

describe('getPageHints', () => {
  test('returns the pageHints object', async () => {
    global.chrome = chromeReplying({ pageHints: { hasModals: true } });
    expect(await call('getPageHints', {}, 1)).toEqual({ hasModals: true });
  });
  test('returns {} on error', async () => {
    global.chrome = chromeReplying(undefined, { lastError: { message: 'x' } });
    expect(await call('getPageHints', {}, 1)).toEqual({});
  });
});

describe('isTabValid', () => {
  test('true for a present, non-discarded tab', async () => {
    global.chrome = { tabs: { get: () => Promise.resolve({ id: 1, discarded: false }) } };
    expect(await call('isTabValid', {}, 1)).toBe(true);
  });
  test('false for a discarded tab', async () => {
    global.chrome = { tabs: { get: () => Promise.resolve({ id: 1, discarded: true }) } };
    expect(await call('isTabValid', {}, 1)).toBe(false);
  });
  test('false when the tab lookup throws', async () => {
    global.chrome = { tabs: { get: () => Promise.reject(new Error('no tab')) } };
    expect(await call('isTabValid', {}, 1)).toBe(false);
  });
});

describe('checkAndSaveBatch', () => {
  test('does nothing when streaming save is disabled', async () => {
    const self = { streamingSaveEnabled: false, pages: new Array(5000) };
    await expect(call('checkAndSaveBatch', self)).resolves.toBeUndefined();
  });

  test('returns early when below the batch threshold', async () => {
    const self = { streamingSaveEnabled: true, batchSize: 1000, pages: [{}, {}] };
    await call('checkAndSaveBatch', self);
    expect(self.pages.length).toBe(2); // not cleared
  });

  test('saves and clears the batch when the threshold is reached', async () => {
    const saved = [];
    global.storageManager = {
      checkStorageQuota: () => Promise.resolve({ available: true, warning: false }),
      savePageBatch: (id, n, pages) => { saved.push({ id, n, count: pages.length }); return Promise.resolve(); },
    };
    const self = {
      streamingSaveEnabled: true, batchSize: 2, crawlId: 'c1', batchNumber: 0,
      pages: [{ a: 1 }, { a: 2 }, { a: 3 }],
    };
    await call('checkAndSaveBatch', self);
    expect(saved[0]).toEqual({ id: 'c1', n: 0, count: 3 });
    expect(self.pages).toEqual([]);
    expect(self.batchNumber).toBe(1);
    delete global.storageManager;
  });

  test('throws when the storage quota is exceeded', async () => {
    global.storageManager = {
      checkStorageQuota: () => Promise.resolve({ available: false, percentUsed: 99, usageGB: 9, quotaGB: 10 }),
    };
    const self = { streamingSaveEnabled: true, batchSize: 1, pages: [{}, {}], crawlId: 'c', batchNumber: 0 };
    await expect(call('checkAndSaveBatch', self)).rejects.toThrow(/quota/i);
    delete global.storageManager;
  });
});
