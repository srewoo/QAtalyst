/**
 * Coverage tests for the WebAppCrawler constructor + loadPreviousCrawl.
 *
 * The constructor instantiates several collaborators (DOMExtractor,
 * LinkDiscoverer, …) as globals and reads ~40 CONFIG keys. We supply trivial
 * class stubs for the collaborators and a real chrome mock so we can build a
 * genuine instance and assert the wired-up defaults, then drive a few real
 * instance methods end-to-end.
 */
const { createChromeMock } = require('./helpers/chrome-mock.js');

// Collaborator stubs — the constructor only `new`s them; behaviour is exercised
// elsewhere. Each records construction args we care about.
class DOMExtractor {}
class LinkDiscoverer { constructor(u) { this.startUrl = u; } }
class NetworkMonitor { stop() {} }
class SitemapParser { constructor(u) { this.startUrl = u; } parse() { return Promise.resolve([]); } }
class ResourceBlocker { stop() { return Promise.resolve(); } }
class SPARouteDiscoverer {}
class SmartWait {}

beforeAll(() => {
  global.CONFIG = { get: (_k, d) => d };
  global.DOMExtractor = DOMExtractor;
  global.LinkDiscoverer = LinkDiscoverer;
  global.NetworkMonitor = NetworkMonitor;
  global.SitemapParser = SitemapParser;
  global.ResourceBlocker = ResourceBlocker;
  global.SPARouteDiscoverer = SPARouteDiscoverer;
  global.SmartWait = SmartWait;
});

afterAll(() => {
  for (const k of ['DOMExtractor', 'LinkDiscoverer', 'NetworkMonitor', 'SitemapParser',
    'ResourceBlocker', 'SPARouteDiscoverer', 'SmartWait', 'chrome']) {
    delete global[k];
  }
});

const WebAppCrawler = require('../crawler.js');

function newCrawler(overrides = {}) {
  return new WebAppCrawler({ startUrl: 'https://app.example.com/', tabId: 1, ...overrides });
}

describe('WebAppCrawler constructor', () => {
  beforeEach(() => { global.chrome = createChromeMock(); });

  test('seeds the queue with the start URL at depth 0 and applies config defaults', () => {
    const c = newCrawler();
    expect(c.startUrl).toBe('https://app.example.com/');
    expect(c.queue).toEqual([{ url: 'https://app.example.com/', depth: 0 }]);
    expect(c.maxPages).toBe(1000);
    expect(c.maxDepth).toBe(10);
    expect(c.visited.size).toBe(0);
    expect(c.pages).toEqual([]);
    expect(c.errors).toEqual([]);
    expect(c.isPaused).toBe(false);
    expect(c.isStopped).toBe(false);
  });

  test('honours explicit overrides over config defaults', () => {
    const c = newCrawler({ maxPages: 5, maxDepth: 2, delay: 42 });
    expect(c.maxPages).toBe(5);
    expect(c.maxDepth).toBe(2);
    expect(c.delay).toBe(42);
  });

  test('wires up collaborators with the start URL where relevant', () => {
    const c = newCrawler();
    expect(c.domExtractor).toBeInstanceOf(DOMExtractor);
    expect(c.linkDiscoverer).toBeInstanceOf(LinkDiscoverer);
    expect(c.linkDiscoverer.startUrl).toBe('https://app.example.com/');
    expect(c.sitemapParser.startUrl).toBe('https://app.example.com/');
    expect(c.networkMonitor).toBeInstanceOf(NetworkMonitor);
  });

  test('initialises empty tracking maps and a unique crawl id', () => {
    const c = newCrawler();
    expect(c.pageSignatures).toBeInstanceOf(Map);
    expect(c.paramBudget).toBeInstanceOf(Map);
    expect(c.urlTemplates).toBeInstanceOf(Map);
    expect(c.featureCache.size).toBe(0);
    expect(c.crawlId.startsWith('https://app.example.com/_')).toBe(true);
  });

  test('a real instance can run its pure helper methods', () => {
    const c = newCrawler();
    expect(c.isAuthUrl('https://app.example.com/login')).toBe(true);
    expect(c.shouldQueueUrl('https://app.example.com/dashboard')).toBe(true);
    expect(c.shouldQueueUrl('https://other.com/x')).toBe(false);
    expect(c.calculatePriority('https://app.example.com/p', [{ type: 'form' }], [])).toBeGreaterThan(0);
  });
});

describe('loadPreviousCrawl', () => {
  test('records previously crawled URLs from a prior knowledge graph', async () => {
    const chrome = createChromeMock();
    chrome.runtime.sendMessage = () => Promise.resolve({
      success: true,
      knowledgeGraph: { pages: { 'https://app.example.com/a': {}, 'https://app.example.com/b': {} } },
    });
    global.chrome = chrome;
    const c = newCrawler();
    await c.loadPreviousCrawl('https://app.example.com/');
    expect(c.previouslyCrawled.has('https://app.example.com/a')).toBe(true);
    expect(c.previouslyCrawled.has('https://app.example.com/b')).toBe(true);
  });

  test('proceeds cleanly when no previous crawl exists', async () => {
    const chrome = createChromeMock();
    chrome.runtime.sendMessage = () => Promise.reject(new Error('not found'));
    global.chrome = chrome;
    const c = newCrawler();
    await expect(c.loadPreviousCrawl('https://app.example.com/')).resolves.toBeUndefined();
  });
});
