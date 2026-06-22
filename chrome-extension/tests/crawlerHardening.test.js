/**
 * Tests for the v2 crawler hardening ported from Pathfinder:
 *   - percentile() helper (P90-based adaptive scaling)
 *   - checkAdaptiveScaling() consecutive-error backoff (sheds tabs immediately)
 *   - navigate() honouring a post-login session (sessionAuthenticated)
 *
 * We invoke the REAL shipped prototype methods against a minimal stub `this`,
 * matching the convention in crawlerMethods.test.js.
 */
global.CONFIG = global.CONFIG || { get: (_k, d) => d };
const WebAppCrawler = require('../crawler.js');
const P = WebAppCrawler.prototype;
const call = (method, self, ...args) => P[method].call(self, ...args);

describe('percentile', () => {
  test('returns 0 for an empty array', () => {
    expect(call('percentile', {}, [], 0.9)).toBe(0);
  });

  test('computes the P90 (nearest-rank)', () => {
    const vals = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000];
    expect(call('percentile', {}, vals, 0.9)).toBe(1000);
    expect(call('percentile', {}, vals, 0.5)).toBe(600);
  });

  test('is robust to a single slow outlier (vs the mean)', () => {
    const vals = [100, 100, 100, 100, 100, 100, 100, 100, 100, 9000];
    // mean would be ~990ms; P90 stays at the fast tier.
    expect(call('percentile', {}, vals, 0.9)).toBeLessThanOrEqual(9000);
    expect(call('percentile', {}, vals, 0.8)).toBe(100);
  });
});

describe('checkAdaptiveScaling — error backoff', () => {
  let removed;
  beforeEach(() => {
    removed = [];
    global.chrome = {
      tabs: { remove: (id) => { removed.push(id); return Promise.resolve(); } },
    };
  });
  afterEach(() => { delete global.chrome; });

  test('sheds half the tabs on consecutive errors, bypassing the cooldown', async () => {
    const tabIds = [11, 12, 13, 14, 15, 16];
    const self = {
      adaptiveScaling: true,
      consecutiveErrors: 3,
      errorBackoffThreshold: 2,
      minTabs: 3,
      activeTabs: new Set(tabIds),
      lastScaleCheck: Date.now(), // cooldown active — backoff must ignore it
      pageLoadTimes: [],
      currentTabCount: 6,
    };
    const result = await call('checkAdaptiveScaling', self, tabIds);
    expect(result.length).toBe(3);            // floor(6/2) = 3, clamped at minTabs
    expect(removed.length).toBe(3);
    expect(self.consecutiveErrors).toBe(0);   // reset after acting
  });

  test('does not shed below minTabs', async () => {
    const tabIds = [21, 22, 23];
    const self = {
      adaptiveScaling: true,
      consecutiveErrors: 5,
      errorBackoffThreshold: 2,
      minTabs: 3,
      activeTabs: new Set(tabIds),
      lastScaleCheck: Date.now(),
      pageLoadTimes: [],
      currentTabCount: 3,
    };
    const result = await call('checkAdaptiveScaling', self, tabIds);
    expect(result.length).toBe(3);
    expect(removed.length).toBe(0);
  });
});

describe('navigate — post-login session reuse', () => {
  beforeEach(() => {
    global.chrome = {
      runtime: { lastError: null },
      tabs: { update: (_id, _opts, cb) => cb({ id: _id }) },
    };
  });
  afterEach(() => { delete global.chrome; });

  const baseSelf = () => ({
    siteType: null,
    scriptInjectedTabs: new Set(),
    isAuthUrl: P.isAuthUrl,
    getNavigationTimeout: P.getNavigationTimeout,
  });

  test('rejects an auth URL when not authenticated (default config)', async () => {
    const self = { ...baseSelf(), sessionAuthenticated: false };
    await expect(call('navigate', self, 'https://app.example.com/login', 1))
      .rejects.toThrow(/Authentication required/);
  });

  test('navigates to an auth URL once a login has established the session', async () => {
    const self = { ...baseSelf(), sessionAuthenticated: true };
    const tab = await call('navigate', self, 'https://app.example.com/login', 1);
    expect(tab).toEqual({ id: 1 });
  });
});

describe('mergeDiscoveredFeatures (item 1: interaction-revealed features)', () => {
  test('appends genuinely new features and de-dupes against existing ones', () => {
    const existing = [
      { type: 'form', name: 'Login', fields: [{ name: 'user' }, { name: 'pass' }] },
      { type: 'button', text: 'Submit' },
    ];
    const incoming = [
      { type: 'form', name: 'Login', fields: [{ name: 'user' }, { name: 'pass' }] }, // dup
      { type: 'form', name: 'Invite', fields: [{ name: 'email' }] },                  // new
      { type: 'button', text: 'Add member' },                                          // new
    ];
    const merged = call('mergeDiscoveredFeatures', {}, existing, incoming);
    expect(merged).toHaveLength(4);
    expect(merged.find((f) => f.name === 'Invite')).toBeTruthy();
    expect(merged.filter((f) => f.type === 'form' && f.name === 'Login')).toHaveLength(1);
    // New ones are tagged as interaction-discovered.
    expect(merged.find((f) => f.name === 'Invite')._discoveredVia).toBe('interaction');
  });

  test('skips malformed entries and handles empty inputs', () => {
    expect(call('mergeDiscoveredFeatures', {}, [], [])).toEqual([]);
    const merged = call('mergeDiscoveredFeatures', {}, [{ type: 'form', name: 'A' }], [null, {}, { type: 'button', text: 'X' }]);
    expect(merged).toHaveLength(2);
  });
});
