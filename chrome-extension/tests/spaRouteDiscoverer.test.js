/**
 * Tests for SPARouteDiscoverer (spa-route-discoverer.js). It uses module.exports
 * and reads a CONFIG global (stubbed). Most of the discovery logic executes
 * inside chrome.scripting.executeScript injected functions that only run in a
 * real page/extension context, so those are not unit-testable here. We cover
 * what IS tractable: config-driven construction, extractRoutes() (pure), and the
 * graceful-degradation paths of discoverRoutes/discoverRoutesPassive when the
 * chrome.scripting API is unavailable (they catch and return []).
 */
const { createChromeMock } = require('./helpers/chrome-mock.js');

global.chrome = createChromeMock(); // no chrome.scripting -> injection paths fail gracefully
global.CONFIG = {
  get: (key, def) => {
    const overrides = {
      'crawler.spaDiscovery.maxClicksPerPage': 7,
      'crawler.spaDiscovery.clickDelay': 123,
      'crawler.spaDiscovery.timeBudgetMs': 4321,
    };
    return key in overrides ? overrides[key] : def;
  },
};
const SPARouteDiscoverer = require('../spa-route-discoverer.js');

describe('SPARouteDiscoverer construction', () => {
  test('reads click/budget settings from CONFIG', () => {
    const d = new SPARouteDiscoverer();
    expect(d.maxClicksPerPage).toBe(7);
    expect(d.clickDelay).toBe(123);
    expect(d.timeBudgetMs).toBe(4321);
    expect(d.discoveredStates instanceof Map).toBe(true);
  });
});

describe('SPARouteDiscoverer.extractRoutes', () => {
  const d = new SPARouteDiscoverer();

  test('collects URLs whose state url differs from the original', () => {
    const discoveries = [
      { state: { url: 'https://x.com/a', originalUrl: 'https://x.com/', hash: '' } },
      { state: { url: 'https://x.com/b', originalUrl: 'https://x.com/', hash: '' } },
    ];
    const routes = d.extractRoutes(discoveries);
    expect(routes).toContain('https://x.com/a');
    expect(routes).toContain('https://x.com/b');
  });

  test('adds url+hash entries when a hash is present', () => {
    const discoveries = [
      { state: { url: 'https://x.com/page', originalUrl: 'https://x.com/', hash: '#tab2' } },
    ];
    const routes = d.extractRoutes(discoveries);
    expect(routes).toContain('https://x.com/page');
    expect(routes).toContain('https://x.com/page#tab2');
  });

  test('dedupes identical routes via the underlying Set', () => {
    const discoveries = [
      { state: { url: 'https://x.com/dup', originalUrl: 'https://x.com/', hash: '' } },
      { state: { url: 'https://x.com/dup', originalUrl: 'https://x.com/', hash: '' } },
    ];
    expect(d.extractRoutes(discoveries)).toEqual(['https://x.com/dup']);
  });

  test('returns an empty array for no discoveries', () => {
    expect(d.extractRoutes([])).toEqual([]);
  });

  test('includes hover/submenu-revealed URLs (item 2)', () => {
    const discoveries = [
      { type: 'hover-menu', state: { url: 'https://x.com/', revealedUrls: ['https://x.com/sub1', 'https://x.com/sub2'] } },
    ];
    const routes = d.extractRoutes(discoveries);
    expect(routes).toContain('https://x.com/sub1');
    expect(routes).toContain('https://x.com/sub2');
  });

  test('tolerates discoveries with no state object', () => {
    expect(() => d.extractRoutes([{ type: 'spa-route' }, null])).not.toThrow();
  });
});

describe('SPARouteDiscoverer graceful degradation (no chrome.scripting)', () => {
  test('discoverRoutes resolves to [] when injection is unavailable', async () => {
    const d = new SPARouteDiscoverer();
    await expect(d.discoverRoutes(1)).resolves.toEqual([]);
  });

  test('discoverRoutesPassive resolves to [] when injection is unavailable', async () => {
    const d = new SPARouteDiscoverer();
    await expect(d.discoverRoutesPassive(1, 10)).resolves.toEqual([]);
  });
});

describe('SPARouteDiscoverer.discoverRoutes with stubbed scripting result', () => {
  test('returns the injected function result array when scripting succeeds', async () => {
    const fakeDiscoveries = [
      { type: 'spa-route', state: { url: 'https://x.com/settings', hash: '', title: 'Settings' } },
    ];
    // Augment the mock with a chrome.scripting.executeScript that returns the
    // executeScript result envelope the discoverer expects.
    chrome.scripting = {
      executeScript: async () => [{ result: fakeDiscoveries }],
    };
    const d = new SPARouteDiscoverer();
    const out = await d.discoverRoutes(99);
    expect(out).toEqual(fakeDiscoveries);
    delete chrome.scripting;
  });
});
