/**
 * Coverage tests for WebAppCrawler — Part C.
 *
 * Targets the lifecycle / stats / queue-management / scaling / cleanup methods
 * not covered by crawlerMethods.test.js. We invoke the REAL shipped methods via
 * WebAppCrawler.prototype.<m>.call(stub, ...) with minimal stubs, plus a real
 * chrome mock where chrome.* / messaging is exercised. CONFIG returns defaults.
 */
const { createChromeMock } = require('./helpers/chrome-mock.js');
global.CONFIG = global.CONFIG || { get: (_k, d) => d };
const WebAppCrawler = require('../crawler.js');
const P = WebAppCrawler.prototype;
const call = (method, self, ...args) => P[method].call(self, ...args);

describe('buildKnowledgeGraph', () => {
  function makeSelf() {
    return {
      pages: [
        { url: 'a', depth: 0, loadTime: 1000, features: [{ type: 'form' }, { type: 'button' }],
          apis: [{ url: 'https://x/api/1', method: 'GET' }] },
        { url: 'b', depth: 2, loadTime: 3000, features: [{ type: 'form' }],
          apis: [{ url: 'https://x/api/1', method: 'POST' }, { url: 'https://x/api/2', method: 'GET' }] },
      ],
      errors: [{ url: 'c', error: 'boom' }],
      streamingSaveEnabled: false,
      batchNumber: 0,
      startUrl: 'https://x.com/',
      startTime: Date.now() - 60000,
      siteType: 'dynamic',
      currentTabCount: 3,
      maxConcurrentTabs: 5,
      adaptiveScaling: true,
      pageSignatures: new Map([['a', {}], ['b', {}]]),
      detectParameterizedUrls: false,
      parameterizedUrlTracking: new Map(),
      getFeatureTypeCounts: P.getFeatureTypeCounts,
      getApiMethodCounts: P.getApiMethodCounts,
    };
  }

  test('assembles a knowledge graph with aggregated stats and performance block', async () => {
    const graph = await call('buildKnowledgeGraph', makeSelf());
    expect(graph.appUrl).toBe('https://x.com/');
    expect(graph.totalPages).toBe(2);
    expect(graph.totalErrors).toBe(1);
    expect(graph.stats.totalFeatures).toBe(3); // 2 + 1
    expect(graph.stats.totalApis).toBe(2);     // 2 distinct api URLs
    expect(graph.stats.maxDepthReached).toBe(2);
    expect(graph.stats.featureTypes).toEqual({ form: 2, button: 1 });
    expect(graph.stats.apiMethods).toEqual({ GET: 2, POST: 1 });
    expect(graph.stats.avgLoadTime).toBe(2000);
    expect(graph.performance.siteType).toBe('dynamic');
    expect(graph.performance.adaptiveScalingEnabled).toBe(true);
    expect(graph.performance.maxTabsUsed).toBe(3);
    expect(typeof graph.performance.pagesPerMinute).toBe('number');
  });
});

describe('checkInfiniteQueue', () => {
  function makeSelf(queueLen, overrides = {}) {
    const queue = Array.from({ length: queueLen }, (_, i) => ({ url: `https://x.com/p${i}`, depth: 1 }));
    return {
      queue,
      visited: new Set(),
      sendProgress: () => {},
      pruneQueue: P.pruneQueue,
      getParameterizedPattern: P.getParameterizedPattern,
      detectParameterizedPattern: P.detectParameterizedPattern,
      buildUrlTemplate: P.buildUrlTemplate,
      urlTemplates: new Map(),
      checkInfiniteQueue: P.checkInfiniteQueue,
      ...overrides,
    };
  }

  test('returns false for a small queue', () => {
    expect(call('checkInfiniteQueue', makeSelf(10))).toBe(false);
  });

  test('returns true and warns at the overflow warning threshold', () => {
    // default warning threshold 1500, max 2000
    const self = makeSelf(1600);
    expect(call('checkInfiniteQueue', self)).toBe(true);
  });

  test('hard-stops and prunes the queue at the max size', () => {
    const self = makeSelf(2000);
    const before = self.queue.length;
    expect(call('checkInfiniteQueue', self)).toBe(true);
    // pruneQueue runs, reducing the queue toward ~50% of max
    expect(self.queue.length).toBeLessThan(before);
  });
});

describe('parseSitemap', () => {
  function makeSelf(urls) {
    return {
      sitemapParser: { parse: () => Promise.resolve(urls) },
      startUrl: 'https://app.example.com/',
      queue: [],
      detectParameterizedUrls: false,
      parameterizedUrlTracking: new Map(),
      urlTemplates: new Map(),
      paramBudget: new Map(),
      paramBudgetTrimmed: 0,
      maxParamVariantsPerPath: 25,
      maxValuesPerParamKey: 50,
      normalizeUrl: P.normalizeUrl,
      isInQueue: P.isInQueue,
      shouldQueueUrl: P.shouldQueueUrl,
      getBlacklistedDomains: P.getBlacklistedDomains,
      isBlacklistedUrl: P.isBlacklistedUrl,
      isInjectableUrl: P.isInjectableUrl,
      getParamBudgetKey: P.getParamBudgetKey,
      shouldSkipForParamBudget: P.shouldSkipForParamBudget,
      getParameterizedPattern: P.getParameterizedPattern,
      detectParameterizedPattern: P.detectParameterizedPattern,
      buildUrlTemplate: P.buildUrlTemplate,
      parseSitemap: P.parseSitemap,
    };
  }

  test('adds same-origin sitemap URLs to the queue at depth 1', async () => {
    const self = makeSelf(['https://app.example.com/a', 'https://app.example.com/b']);
    await call('parseSitemap', self);
    expect(self.queue.map(q => q.url).sort()).toEqual([
      'https://app.example.com/a', 'https://app.example.com/b',
    ]);
    expect(self.queue.every(q => q.depth === 1)).toBe(true);
  });

  test('skips the start URL and cross-origin entries', async () => {
    const self = makeSelf(['https://app.example.com/', 'https://other.com/x', 'https://app.example.com/keep']);
    await call('parseSitemap', self);
    expect(self.queue.map(q => q.url)).toEqual(['https://app.example.com/keep']);
  });

  test('swallows a parser failure without throwing', async () => {
    const self = makeSelf([]);
    self.sitemapParser.parse = () => Promise.reject(new Error('no sitemap'));
    await expect(call('parseSitemap', self)).resolves.toBeUndefined();
    expect(self.queue).toEqual([]);
  });
});

describe('createParallelTab / closeAllParallelTabs', () => {
  test('createParallelTab opens an inactive tab and tracks it', async () => {
    const created = [];
    global.chrome = { tabs: { create: (opts) => { created.push(opts); return Promise.resolve({ id: 7 }); } } };
    const self = { activeTabs: new Set() };
    const id = await call('createParallelTab', self);
    expect(id).toBe(7);
    expect(self.activeTabs.has(7)).toBe(true);
    expect(created[0]).toMatchObject({ url: 'about:blank', active: false });
    delete global.chrome;
  });

  test('closeAllParallelTabs removes every tracked tab and clears the set', async () => {
    const removed = [];
    global.chrome = {
      tabs: {
        get: () => Promise.resolve({ url: 'https://x.com' }),
        remove: (id) => { removed.push(id); return Promise.resolve(); },
      },
    };
    const self = { activeTabs: new Set([11, 12]), closeAllParallelTabs: P.closeAllParallelTabs };
    await call('closeAllParallelTabs', self);
    expect(removed.sort()).toEqual([11, 12]);
    expect(self.activeTabs.size).toBe(0);
    delete global.chrome;
  });

  test('closeAllParallelTabs is a no-op when there are no extra tabs', async () => {
    const self = { activeTabs: new Set() };
    await expect(call('closeAllParallelTabs', self)).resolves.toBeUndefined();
  });
});

describe('checkAdaptiveScaling', () => {
  function baseSelf(overrides = {}) {
    return {
      adaptiveScaling: true,
      pageLoadTimes: new Array(10).fill(1000),
      scaleCheckInterval: 5,
      lastScaleCheck: 0, // long ago
      avgLoadTime: 1000,
      scaleUpThreshold: 2,   // seconds
      scaleDownThreshold: 5, // seconds
      minTabs: 1,
      maxTabs: 6,
      activeTabs: new Set(),
      currentTabCount: 2,
      createParallelTab: () => Promise.resolve(99),
      checkAdaptiveScaling: P.checkAdaptiveScaling,
      ...overrides,
    };
  }

  test('returns tabIds unchanged when adaptive scaling is disabled', async () => {
    const self = baseSelf({ adaptiveScaling: false });
    const tabIds = [1, 2];
    expect(await call('checkAdaptiveScaling', self, tabIds)).toBe(tabIds);
    expect(tabIds).toEqual([1, 2]);
  });

  test('scales UP when pages load quickly and below the tab cap', async () => {
    let nextId = 100;
    const self = baseSelf({ avgLoadTime: 800, createParallelTab: () => Promise.resolve(nextId++) });
    const tabIds = [1, 2];
    const result = await call('checkAdaptiveScaling', self, tabIds);
    expect(result.length).toBe(4); // +2 tabs added
    expect(self.currentTabCount).toBe(4);
  });

  test('scales DOWN when pages load slowly and above the tab floor', async () => {
    const removed = [];
    global.chrome = { tabs: { remove: (id) => { removed.push(id); return Promise.resolve(); } } };
    const self = baseSelf({ avgLoadTime: 9000, activeTabs: new Set([1, 2, 3]) });
    const tabIds = [1, 2, 3];
    const result = await call('checkAdaptiveScaling', self, tabIds);
    expect(result.length).toBe(2); // one tab removed
    expect(removed).toHaveLength(1);
    delete global.chrome;
  });

  test('does nothing before enough load-time samples are collected', async () => {
    const self = baseSelf({ pageLoadTimes: [1000] }); // < scaleCheckInterval
    const tabIds = [1, 2];
    expect(await call('checkAdaptiveScaling', self, tabIds)).toBe(tabIds);
    expect(tabIds.length).toBe(2);
  });
});

describe('performCacheCleanup', () => {
  test('evicts oldest cache entries beyond the max size (FIFO)', () => {
    const featureCache = new Map();
    for (let i = 0; i < 250; i++) featureCache.set(`f${i}`, i);
    const apiCache = new Map();
    for (let i = 0; i < 210; i++) apiCache.set(`a${i}`, i);
    const self = {
      visited: new Set(Array.from({ length: 100 }, (_, i) => i)),
      lastCacheCleanup: 0,
      cacheCleanupInterval: 50,
      featureCache,
      apiCache,
    };
    call('performCacheCleanup', self);
    // default maxCacheSize 200 -> both caches trimmed to 200
    expect(self.featureCache.size).toBe(200);
    expect(self.apiCache.size).toBe(200);
    // oldest evicted first: f0 gone, newest f249 kept
    expect(self.featureCache.has('f0')).toBe(false);
    expect(self.featureCache.has('f249')).toBe(true);
    expect(self.lastCacheCleanup).toBe(100);
  });

  test('no-op before the cleanup interval is reached', () => {
    const self = {
      visited: new Set([1, 2, 3]),
      lastCacheCleanup: 0,
      cacheCleanupInterval: 50,
      featureCache: new Map([['x', 1]]),
      apiCache: new Map(),
    };
    call('performCacheCleanup', self);
    expect(self.featureCache.size).toBe(1);
    expect(self.lastCacheCleanup).toBe(0); // unchanged
  });
});

describe('performMemoryCleanup', () => {
  test('trims page signatures and url templates and updates lastMemoryCleanup', async () => {
    const pageSignatures = new Map();
    for (let i = 0; i < 600; i++) pageSignatures.set(`u${i}`, { i });
    const urlTemplates = new Map();
    for (let i = 0; i < 150; i++) urlTemplates.set(`t${i}`, [i]);
    const self = {
      visited: new Set(Array.from({ length: 500 }, (_, i) => i)),
      lastMemoryCleanup: 0,
      memoryCleanupInterval: 100,
      pageSignatures,
      parameterizedUrlTracking: new Map(),
      urlTemplates,
      scriptInjectedTabs: new Set(),
      cleanupClosedTabsFromTracking: () => Promise.resolve(),
    };
    call('performMemoryCleanup', self);
    expect(self.pageSignatures.size).toBe(500);
    expect(self.urlTemplates.size).toBe(100);
    expect(self.pageSignatures.has('u599')).toBe(true); // newest kept
    expect(self.pageSignatures.has('u0')).toBe(false);  // oldest dropped
    expect(self.lastMemoryCleanup).toBe(500);
  });

  test('no-op before the cleanup interval is reached', () => {
    const self = {
      visited: new Set([1]),
      lastMemoryCleanup: 0,
      memoryCleanupInterval: 100,
      pageSignatures: new Map(),
      parameterizedUrlTracking: new Map(),
      urlTemplates: new Map(),
      scriptInjectedTabs: new Set(),
      cleanupClosedTabsFromTracking: () => Promise.resolve(),
    };
    call('performMemoryCleanup', self);
    expect(self.lastMemoryCleanup).toBe(0);
  });
});

describe('cleanupClosedTabsFromTracking', () => {
  test('drops tabs that no longer exist, keeps live ones', async () => {
    global.chrome = {
      tabs: { get: (id) => (id === 5 ? Promise.resolve({ id }) : Promise.reject(new Error('gone'))) },
    };
    const self = { scriptInjectedTabs: new Set([5, 6, 7]) };
    await call('cleanupClosedTabsFromTracking', self);
    expect([...self.scriptInjectedTabs]).toEqual([5]);
    delete global.chrome;
  });
});

describe('sendProgress / sendPageData', () => {
  test('sendProgress posts a crawlProgress message via chrome.runtime', () => {
    const sent = [];
    global.chrome = { runtime: { sendMessage: (m) => { sent.push(m); return Promise.resolve(); } } };
    call('sendProgress', {}, { status: 'crawling', visited: 3 });
    expect(sent[0].action).toBe('crawlProgress');
    expect(sent[0].progress).toEqual({ status: 'crawling', visited: 3 });
    delete global.chrome;
  });

  test('sendPageData posts incremental page data keyed by the crawl start URL', () => {
    const sent = [];
    global.chrome = { runtime: { sendMessage: (m) => { sent.push(m); return Promise.resolve(); } } };
    const self = { startUrl: 'https://x.com/', startTime: 123 };
    call('sendPageData', self, { url: 'https://x.com/a' });
    expect(sent[0].action).toBe('processPageIncremental');
    expect(sent[0].crawlId).toBe('https://x.com/');
    expect(sent[0].crawlStartTime).toBe(123);
    delete global.chrome;
  });
});

describe('pause / resume / sleep', () => {
  test('pause sets the paused flag and resume clears it', () => {
    const self = { isPaused: false };
    call('pause', self);
    expect(self.isPaused).toBe(true);
    call('resume', self);
    expect(self.isPaused).toBe(false);
  });

  test('sleep resolves after the requested delay', async () => {
    const start = Date.now();
    await call('sleep', {}, 10);
    expect(Date.now() - start).toBeGreaterThanOrEqual(0);
  });
});
