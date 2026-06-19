/** @vitest-environment happy-dom */
/**
 * Tests for cross-origin iframe recording (GAP 2).
 *
 * DOMExtractor.extractExternalEmbeds() records cross-origin / unreadable iframes
 * (their src + that they're unreadable) into an externalEmbeds list so the
 * knowledge graph knows an embedded widget exists, even though the browser
 * forbids reading its internals. Same-origin iframes are NOT recorded here —
 * they're already crawled in place by querySelectorDeep.
 *
 * We exercise the REAL shipped DOMExtractor against a happy-dom document. CONFIG
 * is stubbed so the recordExternalEmbeds flag defaults to true.
 */
global.CONFIG = global.CONFIG || { get: (_k, d) => d };
// happy-dom eagerly fetches iframe src on insertion; we never read iframe bodies
// in these tests (we classify by src origin), so stub fetch to a never-resolving
// promise to keep the network out of unit tests and the logs clean.
if (typeof window !== 'undefined') {
  window.fetch = () => new Promise(() => {});
}
const DOMExtractor = require('../dom-extractor.js');

function setBody(html) {
  document.body.innerHTML = html;
}

function newExtractor() {
  return new DOMExtractor();
}

describe('extractExternalEmbeds', () => {
  beforeEach(() => {
    setBody('');
  });

  test('records a cross-origin iframe with its src and crossOrigin flag', () => {
    setBody('<iframe src="https://widgets.other-domain.com/chat"></iframe>');
    const ex = newExtractor();
    const embeds = ex.extractExternalEmbeds();
    expect(embeds).toHaveLength(1);
    expect(embeds[0]).toMatchObject({
      type: 'externalEmbed',
      src: 'https://widgets.other-domain.com/chat',
      origin: 'https://widgets.other-domain.com',
      crossOrigin: true,
      readable: false,
    });
  });

  test('does NOT record a same-origin iframe', () => {
    const sameOrigin = `${location.origin}/embedded-page`;
    setBody(`<iframe src="${sameOrigin}"></iframe>`);
    const ex = newExtractor();
    const embeds = ex.extractExternalEmbeds();
    // same-origin frames are pierced elsewhere, not recorded as external embeds
    expect(embeds.filter(e => e.origin === location.origin)).toHaveLength(0);
  });

  test('records only the cross-origin frame in a mixed page', () => {
    setBody(`
      <iframe src="${location.origin}/local-widget"></iframe>
      <iframe src="https://maps.example.org/embed?id=42" title="Map"></iframe>
    `);
    const ex = newExtractor();
    const embeds = ex.extractExternalEmbeds();
    expect(embeds).toHaveLength(1);
    expect(embeds[0].src).toBe('https://maps.example.org/embed?id=42');
    expect(embeds[0].origin).toBe('https://maps.example.org');
  });

  test('captures the iframe title when present', () => {
    setBody('<iframe src="https://video.example.net/player" title="Promo Video"></iframe>');
    const ex = newExtractor();
    const embeds = ex.extractExternalEmbeds();
    expect(embeds[0].title).toBe('Promo Video');
  });

  test('omits the title field when the iframe has none', () => {
    setBody('<iframe src="https://video.example.net/player"></iframe>');
    const ex = newExtractor();
    const embeds = ex.extractExternalEmbeds();
    expect(embeds[0]).not.toHaveProperty('title');
  });

  test('records multiple distinct cross-origin embeds', () => {
    setBody(`
      <iframe src="https://a.example.com/x"></iframe>
      <iframe src="https://b.example.com/y"></iframe>
    `);
    const ex = newExtractor();
    const embeds = ex.extractExternalEmbeds();
    expect(embeds.map(e => e.origin).sort()).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  test('returns an empty list when the page has no iframes', () => {
    setBody('<div>no embeds here</div>');
    const ex = newExtractor();
    expect(ex.extractExternalEmbeds()).toEqual([]);
  });

  test('respects the recordExternalEmbeds=false config flag', () => {
    global.CONFIG = { get: (k, d) => (k === 'domExtraction.recordExternalEmbeds' ? false : d) };
    setBody('<iframe src="https://widgets.other-domain.com/chat"></iframe>');
    const ex = newExtractor();
    expect(ex.extractExternalEmbeds()).toEqual([]);
    global.CONFIG = { get: (_k, d) => d }; // restore default
  });

  test('getExternalEmbeds returns the last recorded list', () => {
    setBody('<iframe src="https://widgets.other-domain.com/chat"></iframe>');
    const ex = newExtractor();
    ex.extractExternalEmbeds();
    expect(ex.getExternalEmbeds()).toHaveLength(1);
  });
});

describe('getEmbedOrigin', () => {
  test('resolves an absolute src to its origin', () => {
    const ex = newExtractor();
    expect(ex.getEmbedOrigin('https://cdn.example.com/widget.html')).toBe('https://cdn.example.com');
  });

  test('returns null for empty src', () => {
    const ex = newExtractor();
    expect(ex.getEmbedOrigin('')).toBeNull();
  });
});

describe('extract() integration', () => {
  test('surfaces external embeds into pageHints.externalEmbeds', () => {
    document.body.innerHTML = '<iframe src="https://widgets.other-domain.com/chat" title="Support"></iframe>';
    const ex = newExtractor();
    ex.extract();
    const hints = ex.getPageHints();
    expect(hints.externalEmbeds).toBeDefined();
    expect(hints.externalEmbeds).toHaveLength(1);
    expect(hints.externalEmbeds[0].src).toBe('https://widgets.other-domain.com/chat');
  });

  test('does not add externalEmbeds to pageHints when none are present', () => {
    document.body.innerHTML = '<div>plain page</div>';
    const ex = newExtractor();
    ex.extract();
    expect(ex.getPageHints().externalEmbeds).toBeUndefined();
  });
});
