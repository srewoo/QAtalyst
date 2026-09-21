/**
 * Merging crawls.
 *
 * The merger had NO export of any kind — a global via importScripts in the
 * worker, and therefore untestable, which is why a feature that silently
 * produced a wrong graph shipped without coverage.
 *
 * It keyed pages with Object.entries(graph.pages). The crawler emits `pages` as
 * an ARRAY, and Object.entries on an array yields ["0", page] — so pages were
 * keyed by INDEX and merged by POSITION. Page 0 of one crawl "matched" page 0 of
 * the other whatever their URLs, so merging two 2-page graphs produced 2 pages
 * instead of 3 and silently discarded real ones. That is F02 all over again.
 */
const KnowledgeGraphMerger = require('../knowledge-graph-merger.js');

const page = (url, title, features = [], apis = []) => ({ url, title, features, apis });

const APP = {
  appUrl: 'https://app.example.com', totalPages: 2,
  pages: [
    page('https://app.example.com/login', 'Login',
      [{ type: 'button', text: 'Sign In' }],
      [{ method: 'POST', endpoint: '/api/login', url: 'https://app.example.com/api/login' }]),
    page('https://app.example.com/home', 'Home', [{ type: 'button', text: 'Search' }])
  ],
  stats: { totalFeatures: 2, totalApis: 1 }
};

const HELP = {
  appUrl: 'https://help.example.com', totalPages: 2,
  pages: [
    page('https://help.example.com/faq', 'FAQ', [{ type: 'link', text: 'Contact' }]),
    // The SAME page as in APP — this is the only one that should collapse.
    page('https://app.example.com/login', 'Login', [{ type: 'button', text: 'Sign In' }])
  ],
  stats: { totalFeatures: 2, totalApis: 0 }
};

const pagesOf = (g) => (Array.isArray(g.pages) ? g.pages : Object.values(g.pages || {}));
const urlsOf = (g) => (Array.isArray(g.pages) ? g.pages.map(p => p.url) : Object.keys(g.pages || {}));

describe('merging array-shaped graphs', () => {
  let merged;
  beforeAll(async () => { merged = await new KnowledgeGraphMerger().mergeGraphs([APP, HELP]); });

  test('unique pages are preserved and only true duplicates collapse', () => {
    // 4 input pages, 1 shared URL -> 3 unique. Pre-fix this returned 2.
    expect(pagesOf(merged)).toHaveLength(3);
  });

  test('pages are matched by URL, not by array position', () => {
    const urls = urlsOf(merged);
    expect(urls).toContain('https://app.example.com/login');
    expect(urls).toContain('https://app.example.com/home');
    expect(urls).toContain('https://help.example.com/faq');
  });

  test('a page unique to the second graph is not dropped', () => {
    // Position-based matching swallowed it: index 0 of HELP "matched" index 0 of APP.
    expect(urlsOf(merged)).toContain('https://help.example.com/faq');
  });

  test('API evidence survives the merge', () => {
    // Reported totalApis: 0 before, despite the app graph carrying one.
    expect(merged.stats.totalApis).toBeGreaterThan(0);
  });

  test('features from both graphs are counted', () => {
    expect(merged.stats.totalFeatures).toBeGreaterThanOrEqual(3);
  });

  test('the result is marked merged and records its sources', () => {
    expect(merged.isMerged).toBe(true);
    expect(merged.mergeCount).toBe(2);
    expect(merged.sources.map(s => s.url)).toEqual(
      expect.arrayContaining(['https://app.example.com', 'https://help.example.com']));
  });
});

describe('shape tolerance and edges', () => {
  test('map-shaped graphs still merge correctly', async () => {
    const toMap = (g) => ({ ...g, pages: Object.fromEntries(g.pages.map(p => [p.url, p])) });
    const merged = await new KnowledgeGraphMerger().mergeGraphs([toMap(APP), toMap(HELP)]);
    expect(pagesOf(merged)).toHaveLength(3);
  });

  test('a mixed array/map pair merges correctly', async () => {
    const asMap = { ...HELP, pages: Object.fromEntries(HELP.pages.map(p => [p.url, p])) };
    const merged = await new KnowledgeGraphMerger().mergeGraphs([APP, asMap]);
    expect(pagesOf(merged)).toHaveLength(3);
  });

  test('a single graph is returned unchanged', async () => {
    const merged = await new KnowledgeGraphMerger().mergeGraphs([APP]);
    expect(pagesOf(merged)).toHaveLength(2);
  });

  test('merging nothing is an explicit error, not an empty graph', async () => {
    await expect(new KnowledgeGraphMerger().mergeGraphs([])).rejects.toThrow(/No knowledge graphs/);
  });

  test('three graphs merge without losing the third', async () => {
    const third = { appUrl: 'https://docs.example.com', totalPages: 1,
      pages: [page('https://docs.example.com/guide', 'Guide', [{ type: 'link', text: 'Start' }])],
      stats: { totalFeatures: 1, totalApis: 0 } };
    const merged = await new KnowledgeGraphMerger().mergeGraphs([APP, HELP, third]);
    expect(urlsOf(merged)).toContain('https://docs.example.com/guide');
    expect(pagesOf(merged)).toHaveLength(4);
  });

  test('a page with no url does not collapse every other page onto it', async () => {
    const odd = { appUrl: 'https://x.example.com', totalPages: 2,
      pages: [{ title: 'No URL', features: [] }, page('https://x.example.com/a', 'A')],
      stats: {} };
    const merged = await new KnowledgeGraphMerger().mergeGraphs([APP, odd]);
    expect(pagesOf(merged).length).toBeGreaterThanOrEqual(3);
  });
});
