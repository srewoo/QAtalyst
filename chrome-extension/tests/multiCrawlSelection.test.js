/**
 * @vitest-environment happy-dom
 *
 * With more than one stored crawl, generation must use ALL the relevant ones —
 * and must not let a documentation site outrank the product.
 *
 * Observed with two real crawls (help.mindtickle.com, 257 pages; and
 * jellyvision.integration.mindtickle.com, 70 pages): only ONE was ever loaded,
 * and first-match-wins on base domain picked the HELP SITE, because both hosts
 * end in mindtickle.com and it happened to be first in the list. UI tests were
 * then grounded against documentation containing none of the app's controls,
 * which is a large part of why every candidate was rejected.
 */
global.window = global.window || { location: { origin: 'https://x' } };
const { rankMatchingApps, isDocsSite, findMatchingApp } = require('../content-utils.js');

const APPS = [
  { url: 'https://help.mindtickle.com', pages: 257, features: 1329 },
  { url: 'https://jellyvision.integration.mindtickle.com', pages: 70, features: 440 }
];
const TICKET = {
  summary: 'Multi-Chat: View List of Chat Sessions',
  description: 'A persistent sidebar should display a chronological list of chat sessions in the Seller Copilot interface.'
};

describe('a help site must not outrank the application', () => {
  test('the app is ranked above the docs site', () => {
    const ranked = rankMatchingApps(APPS, TICKET);
    expect(ranked[0].url).toContain('jellyvision');
  });

  test('the same holds when the docs site is listed first', () => {
    // Pre-fix this was decided purely by array order.
    expect(rankMatchingApps([...APPS].reverse(), TICKET)[0].url).toContain('jellyvision');
  });

  test('findMatchingApp agrees with the ranking', () => {
    expect(findMatchingApp(APPS, TICKET).url).toContain('jellyvision');
  });

  test('common documentation hosts are recognised', () => {
    for (const u of ['https://help.x.com', 'https://docs.x.com', 'https://support.x.com',
                     'https://kb.x.com', 'https://x.zendesk.com/hc']) {
      expect(isDocsSite(u)).toBe(true);
    }
    expect(isDocsSite('https://app.x.com')).toBe(false);
    expect(isDocsSite('https://jellyvision.integration.mindtickle.com')).toBe(false);
  });

  test('a host named explicitly in the ticket wins outright', () => {
    const ticket = { summary: 'Fix search', description: 'Broken on help.mindtickle.com specifically.' };
    // An explicit mention is stronger evidence than the docs-site penalty.
    expect(rankMatchingApps(APPS, ticket)[0].url).toContain('help.mindtickle.com');
  });

  test('a docs site is still ranked, not discarded', () => {
    // A rule may be written down only in the help centre.
    expect(rankMatchingApps(APPS, TICKET).map(a => a.url)).toContain('https://help.mindtickle.com');
  });
});

describe('all relevant crawls are offered to generation', () => {
  test('ranking returns every crawl, best first', () => {
    const ranked = rankMatchingApps(APPS, TICKET);
    // Only the top one used to be loaded; the other was silently ignored.
    expect(ranked).toHaveLength(2);
  });

  test('the content script loads more than one crawl', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'content.js'), 'utf8');
    expect(src).toContain('rankMatchingApps');
    expect(src).toMatch(/for \(const app of toLoad\)/);
    expect(src).toContain('mergeGraphsInMemory');
  });

  test('combining is bounded and skips crawls with no relevant pages', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'content.js'), 'utf8');
    expect(src).toMatch(/ranked\.slice\(0, 3\)/);      // bounded
    expect(src).toMatch(/no ticket-relevant pages, skipped/);
  });

  test('merging for a run does not persist a new stored app', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'background.js'), 'utf8');
    const handler = src.slice(src.indexOf("request.action === 'mergeGraphsInMemory'"));
    // Persisting a merged graph on every generation would be an unasked-for side effect.
    expect(handler.slice(0, 900)).not.toContain('saveEmbeddings');
  });

  test('a single crawl still works unchanged', () => {
    const one = [APPS[1]];
    expect(rankMatchingApps(one, TICKET)).toHaveLength(1);
    expect(findMatchingApp(one, TICKET).url).toBe(APPS[1].url);
  });
});
