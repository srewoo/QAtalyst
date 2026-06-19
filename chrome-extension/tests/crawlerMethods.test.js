/**
 * Coverage tests for WebAppCrawler pure / near-pure methods (Part B).
 *
 * These methods read config via the global CONFIG and otherwise depend only on
 * their arguments and a handful of `this` fields. We invoke the REAL shipped
 * methods via WebAppCrawler.prototype.<m>.call(stub, ...) with a minimal stub
 * standing in for a constructed crawler — avoiding the heavy constructor (which
 * needs DOMExtractor, LinkDiscoverer, … as globals). CONFIG returns defaults.
 */
global.CONFIG = global.CONFIG || { get: (_k, d) => d };
const WebAppCrawler = require('../crawler.js');
const P = WebAppCrawler.prototype;

// Helper: invoke a prototype method bound to a stub `this`.
const call = (method, self, ...args) => P[method].call(self, ...args);

describe('isAuthUrl', () => {
  test.each([
    'https://app.example.com/login',
    'https://app.example.com/account/login',
    'https://app.example.com/auth/callback',
    'https://app.example.com/sso',
    'https://app.example.com/oauth2/authorize',
  ])('detects auth URL: %s', (url) => {
    expect(call('isAuthUrl', {}, url)).toBe(true);
  });

  test.each([
    'https://app.example.com/dashboard',
    'https://app.example.com/products/123',
    'https://app.example.com/settings',
  ])('passes non-auth URL: %s', (url) => {
    expect(call('isAuthUrl', {}, url)).toBe(false);
  });
});

describe('getNavigationTimeout', () => {
  test('returns default timeout when site type is unknown', () => {
    expect(call('getNavigationTimeout', { siteType: null })).toBe(30000);
  });

  test('returns static timeout for static sites', () => {
    expect(call('getNavigationTimeout', { siteType: 'static' })).toBe(15000);
  });

  test('returns heavy timeout for heavy sites', () => {
    expect(call('getNavigationTimeout', { siteType: 'heavy' })).toBe(60000);
  });

  test('falls back to default for an unrecognised site type', () => {
    expect(call('getNavigationTimeout', { siteType: 'martian' })).toBe(30000);
  });
});

describe('isInQueue', () => {
  test('true when URL is present in the queue', () => {
    const self = { queue: [{ url: 'https://a.com/x' }, { url: 'https://a.com/y' }] };
    expect(call('isInQueue', self, 'https://a.com/y')).toBe(true);
  });
  test('false when URL is absent', () => {
    const self = { queue: [{ url: 'https://a.com/x' }] };
    expect(call('isInQueue', self, 'https://a.com/z')).toBe(false);
  });
});

describe('isRelevantApi', () => {
  test('rejects known third-party analytics endpoints', () => {
    expect(call('isRelevantApi', {}, { url: 'https://google-analytics.com/collect' })).toBe(false);
    expect(call('isRelevantApi', {}, { url: 'https://api.mixpanel.com/track' })).toBe(false);
  });
  test('accepts first-party API endpoints', () => {
    expect(call('isRelevantApi', {}, { url: 'https://app.example.com/api/v1/users' })).toBe(true);
  });
});

describe('isBlacklistedUrl / getBlacklistedDomains', () => {
  const self = { getBlacklistedDomains: P.getBlacklistedDomains };

  test('blacklists a social-network domain by default', () => {
    expect(call('isBlacklistedUrl', self, 'https://www.facebook.com/page')).toBe(true);
  });
  test('blacklists a subdomain of a blacklisted domain', () => {
    expect(call('isBlacklistedUrl', self, 'https://m.facebook.com/x')).toBe(true);
  });
  test('does not blacklist an arbitrary app domain', () => {
    expect(call('isBlacklistedUrl', self, 'https://app.example.com/x')).toBe(false);
  });
  test('returns false for an invalid URL', () => {
    expect(call('isBlacklistedUrl', self, 'not a url')).toBe(false);
  });
  test('getBlacklistedDomains returns a de-duplicated non-empty list by default', () => {
    const domains = call('getBlacklistedDomains', {});
    expect(Array.isArray(domains)).toBe(true);
    expect(domains.length).toBeGreaterThan(0);
    expect(new Set(domains).size).toBe(domains.length);
  });
});

describe('isInjectableUrl', () => {
  const self = { getBlacklistedDomains: P.getBlacklistedDomains, isBlacklistedUrl: P.isBlacklistedUrl };

  test('rejects empty / nullish URLs', () => {
    expect(call('isInjectableUrl', self, '')).toBe(false);
    expect(call('isInjectableUrl', self, null)).toBe(false);
  });
  test('rejects chrome:// and other non-injectable schemes', () => {
    expect(call('isInjectableUrl', self, 'chrome://settings')).toBe(false);
    expect(call('isInjectableUrl', self, 'about:blank')).toBe(false);
    expect(call('isInjectableUrl', self, 'data:text/html,hi')).toBe(false);
  });
  test('rejects non-HTML file extensions', () => {
    expect(call('isInjectableUrl', self, 'https://app.example.com/report.pdf')).toBe(false);
    expect(call('isInjectableUrl', self, 'https://app.example.com/img.png')).toBe(false);
  });
  test('rejects blacklisted domains', () => {
    expect(call('isInjectableUrl', self, 'https://twitter.com/foo')).toBe(false);
  });
  test('accepts a normal HTML app URL', () => {
    expect(call('isInjectableUrl', self, 'https://app.example.com/dashboard')).toBe(true);
  });
});

describe('calculatePriority', () => {
  const self = { priorityCrawlingEnabled: true, priorityScores: {} };

  test('returns fixed default when priority crawling is disabled', () => {
    expect(call('calculatePriority', { priorityCrawlingEnabled: false }, 'https://x.com/y')).toBe(50);
  });
  test('navigation-style URLs score higher than static pages (with features present)', () => {
    // NOTE: a featureless+api-less page is forced to the static floor (20)
    // regardless of URL, so we give both pages a feature to compare URL scoring.
    const dash = call('calculatePriority', self, 'https://x.com/dashboard', [{ type: 'button' }], []);
    const stat = call('calculatePriority', self, 'https://x.com/about', [{ type: 'button' }], []);
    expect(dash).toBeGreaterThan(stat);
  });
  test('pages with form features score above featureless pages', () => {
    const withForm = call('calculatePriority', self, 'https://x.com/p', [{ type: 'form' }], []);
    const empty = call('calculatePriority', self, 'https://x.com/p', [], []);
    expect(withForm).toBeGreaterThan(empty);
  });
  test('presence of APIs raises the score', () => {
    const withApi = call('calculatePriority', self, 'https://x.com/p', [], [{ url: 'a' }]);
    const empty = call('calculatePriority', self, 'https://x.com/p', [], []);
    expect(withApi).toBeGreaterThan(empty);
  });
  test('a featureless, api-less page gets the static floor score (20)', () => {
    expect(call('calculatePriority', self, 'https://x.com/about', [], [])).toBe(20);
  });
});

describe('sortQueueByPriority', () => {
  test('orders queue by descending priority', () => {
    const self = { priorityCrawlingEnabled: true, queue: [
      { url: 'a', priority: 10 }, { url: 'b', priority: 90 }, { url: 'c', priority: 50 },
    ] };
    call('sortQueueByPriority', self);
    expect(self.queue.map(q => q.url)).toEqual(['b', 'c', 'a']);
  });
  test('no-op when priority crawling disabled', () => {
    const self = { priorityCrawlingEnabled: false, queue: [{ url: 'a', priority: 1 }, { url: 'b', priority: 9 }] };
    call('sortQueueByPriority', self);
    expect(self.queue.map(q => q.url)).toEqual(['a', 'b']); // untouched
  });
});

describe('detectParameterizedPattern', () => {
  test('numeric id at the end → /{id}', () => {
    expect(call('detectParameterizedPattern', {}, 'https://x.com/recording/123')).toBe('/recording/{id}');
  });
  test('uuid at the end → /{uuid}', () => {
    expect(call('detectParameterizedPattern', {}, 'https://x.com/session/a1b2c3d4-e5f6-47a8-89b0-c1d2e3f4a5b6'))
      .toBe('/session/{uuid}');
  });
  test('long alphanumeric blog slug is caught by the generic alphanumeric rule (→ /blog/{id})', () => {
    // Pattern 3 (alphanumeric 8+ chars) fires before the blog-specific rule for
    // long slugs — both collapse the variable segment; assert the real output.
    expect(call('detectParameterizedPattern', {}, 'https://x.com/blog/my-first-post')).toBe('/blog/{id}');
  });
  test('short blog slug falls through to the blog-specific rule (→ /blog/{slug})', () => {
    expect(call('detectParameterizedPattern', {}, 'https://x.com/blog/hi')).toBe('/blog/{slug}');
  });
  test('id in the middle of the path is normalised', () => {
    expect(call('detectParameterizedPattern', {}, 'https://x.com/user/123/profile')).toBe('/user/{id}/profile');
  });
  test('plain static path returns null', () => {
    expect(call('detectParameterizedPattern', {}, 'https://x.com/about')).toBeNull();
  });
});

describe('buildUrlTemplate', () => {
  test('replaces numeric segments with {num}', () => {
    expect(call('buildUrlTemplate', {}, 'https://x.com/order/42/items')).toBe('/order/{num}/items');
  });
  test('replaces uuid segments with {uuid}', () => {
    expect(call('buildUrlTemplate', {}, 'https://x.com/s/a1b2c3d4-e5f6-47a8-89b0-c1d2e3f4a5b6'))
      .toBe('/s/{uuid}');
  });
  test('keeps purely static paths intact', () => {
    expect(call('buildUrlTemplate', {}, 'https://x.com/help/getting-started')).toBe('/help/getting-started');
  });
});

describe('calculateTextSimilarity', () => {
  test('identical text → 1', () => {
    expect(call('calculateTextSimilarity', {}, 'the quick brown fox', 'the quick brown fox')).toBe(1);
  });
  test('disjoint text → 0', () => {
    expect(call('calculateTextSimilarity', {}, 'alpha beta', 'gamma delta')).toBe(0);
  });
  test('empty input → 0', () => {
    expect(call('calculateTextSimilarity', {}, '', 'anything')).toBe(0);
  });
  test('partial overlap is between 0 and 1', () => {
    const s = call('calculateTextSimilarity', {}, 'the quick brown fox', 'the slow brown dog');
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
});

describe('calculateSimilarity', () => {
  const sig = (o = {}) => ({
    title: 'T', structuralFingerprint: 'form:1|btns[submit]', featureTypes: 'button,form',
    featureCount: 2, textLength: 500, textSample: 'lorem ipsum dolor sit amet', ...o,
  });

  const simSelf = { calculateTextSimilarity: P.calculateTextSimilarity };
  test('identical signatures score ~1', () => {
    expect(call('calculateSimilarity', simSelf, sig(), sig())).toBeCloseTo(1, 5);
  });
  test('different structure + text scores well below 1', () => {
    const a = sig();
    const b = sig({ title: 'X', structuralFingerprint: 'table:3', featureTypes: 'table',
      featureCount: 1, textSample: 'completely unrelated words here now' });
    expect(call('calculateSimilarity', simSelf, a, b)).toBeLessThan(0.5);
  });
});

describe('createPageSignature', () => {
  test('summarises title / counts / text length from page data', () => {
    const self = { buildStructuralFingerprint: P.buildStructuralFingerprint };
    const sig = call('createPageSignature', self, {
      title: 'Dashboard',
      textContent: 'x'.repeat(2000),
      features: [{ type: 'form', fields: [{ type: 'email' }] }, { type: 'button', intent: 'submit' }],
      apis: [{ url: 'a' }],
    });
    expect(sig.title).toBe('Dashboard');
    expect(sig.featureCount).toBe(2);
    expect(sig.featureTypes).toBe('button,form'); // sorted
    expect(sig.apiCount).toBe(1);
    expect(sig.textLength).toBe(2000);
    expect(typeof sig.structuralFingerprint).toBe('string');
  });

  test('handles missing optional fields gracefully', () => {
    const self = { buildStructuralFingerprint: P.buildStructuralFingerprint };
    const sig = call('createPageSignature', self, {});
    expect(sig.title).toBe('');
    expect(sig.featureCount).toBe(0);
    expect(sig.apiCount).toBe(0);
    expect(sig.textLength).toBe(0);
  });
});

describe('isPageInteractive', () => {
  const self = { minFeaturesRequired: 1 };
  test('any API makes a page interactive', () => {
    expect(call('isPageInteractive', self, [], [{ url: 'a' }])).toBe(true);
  });
  test('interactive feature types count toward interactivity', () => {
    expect(call('isPageInteractive', self, [{ type: 'form' }], [])).toBe(true);
  });
  test('a page with no APIs and no interactive features is not interactive', () => {
    expect(call('isPageInteractive', self, [{ type: 'paragraph' }], [])).toBe(false);
  });
});

describe('getFeatureTypeCounts / getApiMethodCounts', () => {
  const pages = [
    { features: [{ type: 'form' }, { type: 'button' }], apis: [{ method: 'GET' }] },
    { features: [{ type: 'form' }], apis: [{ method: 'POST' }, { method: 'GET' }] },
  ];
  test('feature counts aggregate across pages', () => {
    expect(call('getFeatureTypeCounts', {}, pages)).toEqual({ form: 2, button: 1 });
  });
  test('api method counts aggregate across pages', () => {
    expect(call('getApiMethodCounts', {}, pages)).toEqual({ GET: 2, POST: 1 });
  });
});

describe('trackPageLoadTime', () => {
  test('updates the rolling average load time', () => {
    const self = { pageLoadTimes: [], avgLoadTime: 0 };
    call('trackPageLoadTime', self, 1000);
    call('trackPageLoadTime', self, 3000);
    expect(self.avgLoadTime).toBe(2000);
  });
  test('caps the rolling window at 20 samples', () => {
    const self = { pageLoadTimes: [], avgLoadTime: 0 };
    for (let i = 0; i < 30; i++) call('trackPageLoadTime', self, 100);
    expect(self.pageLoadTimes.length).toBe(20);
  });
});

describe('detectSiteType', () => {
  test('returns dynamic default when detection disabled', () => {
    expect(call('detectSiteType', { siteDetectionEnabled: false })).toBe('dynamic');
  });
  test('returns the cached site type once detected', () => {
    expect(call('detectSiteType', { siteDetectionEnabled: true, siteType: 'heavy', pages: [] })).toBe('heavy');
  });
  test('classifies a fast, low-dynamic sample as static', () => {
    const self = {
      siteDetectionEnabled: true, siteType: null, siteDetectionSampleSize: 2,
      pages: [
        { loadTime: 500, features: [{ type: 'paragraph' }], apis: [] },
        { loadTime: 600, features: [{ type: 'list' }], apis: [] },
      ],
    };
    expect(call('detectSiteType', self)).toBe('static');
  });
  test('classifies a slow, highly-dynamic sample as heavy', () => {
    const self = {
      siteDetectionEnabled: true, siteType: null, siteDetectionSampleSize: 2,
      pages: [
        { loadTime: 5000, features: [{ type: 'form' }], apis: [{ url: 'a' }] },
        { loadTime: 6000, features: [{ type: 'modal' }], apis: [{ url: 'b' }] },
      ],
    };
    expect(call('detectSiteType', self)).toBe('heavy');
  });
});

describe('getAdaptiveWaitTime / shouldUseSmartWait', () => {
  test('getAdaptiveWaitTime falls back to default page-load delay', () => {
    const self = { detectSiteType: () => 'dynamic' };
    expect(call('getAdaptiveWaitTime', self)).toBe(1000);
  });
  test('shouldUseSmartWait defaults to true when not explicitly disabled', () => {
    const self = { detectSiteType: () => 'dynamic' };
    expect(call('shouldUseSmartWait', self)).toBe(true);
  });
});

describe('getParameterizedPattern (template learning)', () => {
  function makeSelf() {
    return {
      urlTemplates: new Map(),
      getParameterizedPattern: P.getParameterizedPattern,
      detectParameterizedPattern: P.detectParameterizedPattern,
      buildUrlTemplate: P.buildUrlTemplate,
    };
  }
  test('regex detection short-circuits for an obvious numeric id', () => {
    expect(call('getParameterizedPattern', makeSelf(), 'https://x.com/order/123')).toBe('/order/{id}');
  });
  test('regex detection catches a long alphanumeric trailing id', () => {
    expect(call('getParameterizedPattern', makeSelf(), 'https://x.com/shop/abc12345')).toBe('/shop/{id}');
  });
  test('a purely static path is never parameterized', () => {
    expect(call('getParameterizedPattern', makeSelf(), 'https://x.com/pricing')).toBeNull();
  });
});

describe('isDuplicatePage', () => {
  function makeSelf(overrides = {}) {
    return {
      duplicateDetectionEnabled: true,
      detectParameterizedUrls: true,
      maxSamplesPerPattern: 1,
      similarityThreshold: 0.98,
      pageSignatures: new Map(),
      parameterizedUrlTracking: new Map(),
      urlTemplates: new Map(),
      isDuplicatePage: P.isDuplicatePage,
      getParameterizedPattern: P.getParameterizedPattern,
      detectParameterizedPattern: P.detectParameterizedPattern,
      buildUrlTemplate: P.buildUrlTemplate,
      createPageSignature: P.createPageSignature,
      buildStructuralFingerprint: P.buildStructuralFingerprint,
      calculateSimilarity: P.calculateSimilarity,
      calculateTextSimilarity: P.calculateTextSimilarity,
      ...overrides,
    };
  }
  test('returns false when duplicate detection is disabled', () => {
    expect(call('isDuplicatePage', makeSelf({ duplicateDetectionEnabled: false }), { url: 'https://x.com/a' })).toBe(false);
  });
  test('first sample of a parameterized pattern is crawled, second is a duplicate', () => {
    const self = makeSelf();
    const first = call('isDuplicatePage', self, { url: 'https://x.com/recording/111', features: [], apis: [] });
    expect(first).toBe(false);
    const second = call('isDuplicatePage', self, { url: 'https://x.com/recording/222', features: [], apis: [] });
    expect(second).toBe(true); // pattern budget (maxSamplesPerPattern=1) reached
  });
  test('two structurally + textually identical pages are detected as duplicates', () => {
    const self = makeSelf({ detectParameterizedUrls: false });
    const page = (url) => ({
      url, title: 'Same', features: [{ type: 'button', intent: 'submit' }], apis: [],
      textContent: 'shared body text '.repeat(40),
    });
    expect(call('isDuplicatePage', self, page('https://x.com/p1'))).toBe(false);
    expect(call('isDuplicatePage', self, page('https://x.com/p2'))).toBe(true);
  });
});

describe('shouldQueueUrl (end-to-end enqueue gate)', () => {
  // Full stub wiring the real collaborator methods shouldQueueUrl delegates to.
  function makeSelf(overrides = {}) {
    return {
      startUrl: 'https://app.example.com/',
      detectParameterizedUrls: true,
      maxSamplesPerPattern: 1,
      maxParamVariantsPerPath: 25,
      maxValuesPerParamKey: 50,
      parameterizedUrlTracking: new Map(),
      urlTemplates: new Map(),
      paramBudget: new Map(),
      paramBudgetTrimmed: 0,
      getBlacklistedDomains: P.getBlacklistedDomains,
      isBlacklistedUrl: P.isBlacklistedUrl,
      isInjectableUrl: P.isInjectableUrl,
      getParamBudgetKey: P.getParamBudgetKey,
      shouldSkipForParamBudget: P.shouldSkipForParamBudget,
      getParameterizedPattern: P.getParameterizedPattern,
      detectParameterizedPattern: P.detectParameterizedPattern,
      buildUrlTemplate: P.buildUrlTemplate,
      shouldQueueUrl: P.shouldQueueUrl,
      ...overrides,
    };
  }

  test('queues a normal same-origin HTML page', () => {
    expect(call('shouldQueueUrl', makeSelf(), 'https://app.example.com/dashboard')).toBe(true);
  });
  test('rejects null / non-string input', () => {
    expect(call('shouldQueueUrl', makeSelf(), null)).toBe(false);
    expect(call('shouldQueueUrl', makeSelf(), 123)).toBe(false);
  });
  test('rejects a cross-origin URL', () => {
    expect(call('shouldQueueUrl', makeSelf(), 'https://other.com/x')).toBe(false);
  });
  test('rejects mailto: and tel: links', () => {
    expect(call('shouldQueueUrl', makeSelf(), 'mailto:hi@x.com')).toBe(false);
    expect(call('shouldQueueUrl', makeSelf(), 'tel:+15551234')).toBe(false);
  });
  test('rejects logout / unsubscribe URLs', () => {
    expect(call('shouldQueueUrl', makeSelf(), 'https://app.example.com/logout')).toBe(false);
    expect(call('shouldQueueUrl', makeSelf(), 'https://app.example.com/unsubscribe')).toBe(false);
  });
  test('rejects direct file downloads', () => {
    expect(call('shouldQueueUrl', makeSelf(), 'https://app.example.com/report.pdf')).toBe(false);
  });
  test('caps faceted-filter URL explosion via the param budget', () => {
    const self = makeSelf({ maxParamVariantsPerPath: 2 });
    expect(call('shouldQueueUrl', self, 'https://app.example.com/items?color=red')).toBe(true);
    expect(call('shouldQueueUrl', self, 'https://app.example.com/items?color=blue')).toBe(true);
    // 3rd distinct variant for the same path is trimmed by the budget guard
    expect(call('shouldQueueUrl', self, 'https://app.example.com/items?color=green')).toBe(false);
    expect(self.paramBudgetTrimmed).toBe(1);
  });
});

describe('pruneQueue', () => {
  test('limits an over-represented parameterized pattern to a few samples', () => {
    const self = {
      queue: [],
      getParameterizedPattern: P.getParameterizedPattern,
      detectParameterizedPattern: P.detectParameterizedPattern,
      buildUrlTemplate: P.buildUrlTemplate,
      urlTemplates: new Map(),
      pruneQueue: P.pruneQueue,
    };
    // 20 product-id URLs sharing one pattern + a few unique static pages
    for (let i = 0; i < 20; i++) self.queue.push({ url: `https://shop.com/products/${1000 + i}`, depth: 1 });
    self.queue.push({ url: 'https://shop.com/about', depth: 1 });
    self.queue.push({ url: 'https://shop.com/contact', depth: 1 });

    call('pruneQueue', self);

    // The over-represented /products/{id} pattern is capped to 3 samples; the
    // two unique static pages survive.
    const productCount = self.queue.filter(q => q.url.includes('/products/')).length;
    expect(productCount).toBeLessThanOrEqual(3);
    expect(self.queue.some(q => q.url.endsWith('/about'))).toBe(true);
    expect(self.queue.length).toBeLessThan(22);
  });
});
