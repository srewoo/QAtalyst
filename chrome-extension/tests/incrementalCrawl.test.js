/**
 * Incremental crawl: only NEW or CHANGED pages are crawled and re-indexed.
 *
 * Two defects made the existing "incremental" mode worse than useless:
 *   1. It skipped on URL alone, so a page whose content had been rewritten was
 *      never re-crawled and the graph kept describing an app that no longer
 *      existed. A URL is an identifier, not a version.
 *   2. Skipped pages were added to `visited` but never carried into the new
 *      graph — so enabling incremental mode DELETED every page it skipped.
 */
const WebAppCrawler = require('../crawler.js');
require('../bm25.js');
const BM25Index = globalThis.BM25Index;

global.CONFIG = global.CONFIG || { get: (_k, d) => d };

/** A crawler with just enough state to exercise the incremental decisions. */
function crawlerWith(previousPages, overrides = {}) {
  const c = Object.create(WebAppCrawler.prototype);
  return Object.assign(c, {
    previousPages: new Map(previousPages.map(p => [p.url, p])),
    previouslyCrawled: new Set(previousPages.map(p => p.url)),
    previousCrawlObservedAt: Date.now(),
    pages: [],
    visited: new Set(),
    reusedPageCount: 0,
    ...overrides
  });
}

const PAGE = {
  url: 'https://app/invoices', title: 'Invoices', timestamp: Date.now(),
  features: [{ type: 'button', text: 'Export' }], apis: [],
  _contentHash: 'abc123', _validators: { etag: 'W/"v1"', lastModified: null }
};

describe('change detection', () => {
  test('a 304 response means unchanged — no re-crawl', async () => {
    global.fetch = async () => ({ status: 304, ok: false, headers: { get: () => null } });
    const d = await crawlerWith([PAGE]).shouldRecrawl(PAGE.url);
    expect(d.recrawl).toBe(false);
    expect(d.reason).toMatch(/304/);
  });

  test('an unchanged ETag means unchanged', async () => {
    global.fetch = async () => ({ status: 200, ok: true, headers: { get: (h) => h === 'etag' ? 'W/"v1"' : null } });
    const d = await crawlerWith([PAGE]).shouldRecrawl(PAGE.url);
    expect(d.recrawl).toBe(false);
  });

  test('a CHANGED ETag triggers a re-crawl', async () => {
    global.fetch = async () => ({ status: 200, ok: true, headers: { get: (h) => h === 'etag' ? 'W/"v2"' : null } });
    const d = await crawlerWith([PAGE]).shouldRecrawl(PAGE.url);
    // Pre-fix the page was skipped forever on URL match alone.
    expect(d.recrawl).toBe(true);
    expect(d.reason).toMatch(/ETag changed/);
  });

  test('a content-hash change is detected when the server sends no validators', async () => {
    const noValidators = { ...PAGE, _validators: undefined };
    global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => 'brand new content' });
    const d = await crawlerWith([noValidators]).shouldRecrawl(noValidators.url);
    expect(d.recrawl).toBe(true);
    expect(d.reason).toMatch(/content hash changed/);
  });

  test('a matching content hash means unchanged', async () => {
    const body = 'stable content';
    const hashed = { ...PAGE, _validators: undefined, _contentHash: WebAppCrawler.hashContent(body) };
    global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => body });
    const d = await crawlerWith([hashed]).shouldRecrawl(hashed.url);
    expect(d.recrawl).toBe(false);
  });

  test('a page never crawled before is always crawled', async () => {
    const d = await crawlerWith([PAGE]).shouldRecrawl('https://app/brand-new');
    expect(d.recrawl).toBe(true);
    expect(d.reason).toMatch(/no previous record/);
  });

  test('a failed freshness probe errs toward re-crawling', async () => {
    global.fetch = async () => { throw new Error('network down'); };
    const d = await crawlerWith([PAGE]).shouldRecrawl(PAGE.url);
    // Unprovable freshness must not be treated as proven freshness.
    expect(d.recrawl).toBe(true);
  });

  test('evidence older than the TTL is refreshed even if it looks unchanged', async () => {
    const old = { ...PAGE, timestamp: Date.now() - 40 * 86400000 };
    global.CONFIG = { get: (k, d) => k === 'crawler.incremental.maxAgeDays' ? 14 : d };
    const d = await crawlerWith([old]).shouldRecrawl(old.url);
    expect(d.recrawl).toBe(true);
    expect(d.reason).toMatch(/older than 14 days/);
    global.CONFIG = { get: (_k, d) => d };
  });

  test('a page that errored last time is re-crawled', async () => {
    const errored = { ...PAGE, error: 'HTTP 500' };
    const d = await crawlerWith([errored]).shouldRecrawl(errored.url);
    expect(d.recrawl).toBe(true);
  });
});

describe('unchanged pages are PRESERVED, not discarded', () => {
  test('carrying a page forward keeps it in the new graph', () => {
    const c = crawlerWith([PAGE]);
    expect(c.carryForwardPage(PAGE.url)).toBe(true);
    // Pre-fix, skipping meant the page simply vanished from the result.
    expect(c.pages).toHaveLength(1);
    expect(c.pages[0].url).toBe(PAGE.url);
    expect(c.pages[0]._reused).toBe(true);
    expect(c.pages[0].features).toEqual(PAGE.features);
  });

  test('carrying forward an unknown page is a no-op, not a crash', () => {
    const c = crawlerWith([PAGE]);
    expect(c.carryForwardPage('https://app/nope')).toBe(false);
    expect(c.pages).toHaveLength(0);
  });
});

describe('only changed pages are re-vectorised', () => {
  const pages = [
    { url: '/a', title: 'Invoice export', textContent: 'export invoices to csv' },
    { url: '/b', title: 'Login', textContent: 'sign in with email' },
    { url: '/c', title: 'Profile', textContent: 'edit your profile name' }
  ];

  test('an incremental update equals a full rebuild', () => {
    const full = BM25Index.build(pages);
    const incremental = BM25Index.build([pages[0]]);
    BM25Index.update(incremental, [pages[1], pages[2]]);

    expect(incremental.N).toBe(full.N);
    expect(Math.abs(incremental.avgdl - full.avgdl)).toBeLessThan(0.001);
    // Document frequencies are the part a naive upsert gets wrong.
    expect(incremental.df).toEqual(full.df);
    expect(incremental.search('invoice export', 5).map(r => r.url))
      .toEqual(full.search('invoice export', 5).map(r => r.url));
  });

  test('replacing a page removes its old terms from the corpus statistics', () => {
    const index = BM25Index.build(pages);
    BM25Index.update(index, [{ url: '/b', title: 'Login', textContent: 'passkey authentication only' }]);
    expect(index.N).toBe(3);                  // replaced, not duplicated
    expect(index.df.email).toBeUndefined();   // the stale term is gone
    expect(index.df.passkey).toBe(1);
  });

  test('removing a page drops it from the index', () => {
    const index = BM25Index.build(pages);
    BM25Index.update(index, [], ['/c']);
    expect(index.N).toBe(2);
    expect(index.docs['/c']).toBeUndefined();
    expect(index.df.profile).toBeUndefined();
  });

  test('updating a missing index falls back to a full build', () => {
    const built = BM25Index.update(null, pages);
    expect(built.N).toBe(3);
  });
});

describe('content fingerprint', () => {
  test('is stable and distinguishes different content', () => {
    expect(WebAppCrawler.hashContent('same')).toBe(WebAppCrawler.hashContent('same'));
    expect(WebAppCrawler.hashContent('one')).not.toBe(WebAppCrawler.hashContent('two'));
  });

  test('tolerates empty and non-string input', () => {
    expect(() => WebAppCrawler.hashContent(null)).not.toThrow();
    expect(() => WebAppCrawler.hashContent(undefined)).not.toThrow();
  });
});
