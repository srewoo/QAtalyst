/**
 * Tests for the faceted-parameter explosion guard (GAP 1).
 *
 * shouldSkipForParamBudget(url, seenMap) is the enqueue-path gate that stops a
 * faceted-filter UI (?color=red&size=M&sort=...) from flooding the crawl queue
 * with thousands of unique-but-equivalent URLs. It is pure w.r.t. the passed-in
 * seenMap, so we exercise the REAL shipped method via the prototype with a small
 * stub carrying the two caps it reads off `this`.
 */
global.CONFIG = global.CONFIG || { get: (_k, d) => d };
const WebAppCrawler = require('../crawler.js');

// Minimal stub standing in for a constructed crawler: the method only reads the
// two cap fields and getParamBudgetKey (also on the prototype, also pure).
function makeGuard({ maxVariants = 25, maxValues = 50 } = {}) {
  const stub = {
    maxParamVariantsPerPath: maxVariants,
    maxValuesPerParamKey: maxValues,
    getParamBudgetKey: WebAppCrawler.prototype.getParamBudgetKey,
    shouldSkipForParamBudget: WebAppCrawler.prototype.shouldSkipForParamBudget,
  };
  const seen = new Map();
  return {
    seen,
    skip: (url) => stub.shouldSkipForParamBudget(url, seen),
    key: (url) => stub.getParamBudgetKey.call(stub, url),
  };
}

describe('getParamBudgetKey', () => {
  test('returns null for a URL with no query params (never budgeted)', () => {
    const { key } = makeGuard();
    expect(key('https://shop.example.com/products')).toBeNull();
  });

  test('returns origin+pathname for a URL with query params', () => {
    const { key } = makeGuard();
    expect(key('https://shop.example.com/products?color=red')).toBe('https://shop.example.com/products');
  });

  test('returns null for an unparseable URL', () => {
    const { key } = makeGuard();
    expect(key('not a url')).toBeNull();
  });
});

describe('shouldSkipForParamBudget', () => {
  describe('non-faceted behaviour (unchanged)', () => {
    test('never skips URLs without query params', () => {
      const { skip } = makeGuard();
      for (let i = 0; i < 1000; i++) {
        expect(skip(`https://shop.example.com/path/${i}`)).toBe(false);
      }
    });

    test('never skips an unparseable URL', () => {
      const { skip } = makeGuard();
      expect(skip('::::bad')).toBe(false);
    });
  });

  describe('variant cap per path', () => {
    test('allows up to maxParamVariantsPerPath distinct variants then trims', () => {
      const { skip } = makeGuard({ maxVariants: 3 });
      expect(skip('https://s.com/x?color=red')).toBe(false);   // 1
      expect(skip('https://s.com/x?color=blue')).toBe(false);  // 2
      expect(skip('https://s.com/x?color=green')).toBe(false); // 3
      // 4th distinct variant for same path exceeds the cap → trimmed
      expect(skip('https://s.com/x?color=black')).toBe(true);
    });

    test('an already-seen variant is allowed again (dedup, not a new variant)', () => {
      const { skip } = makeGuard({ maxVariants: 2 });
      expect(skip('https://s.com/x?a=1')).toBe(false); // 1
      expect(skip('https://s.com/x?a=2')).toBe(false); // 2 (cap reached)
      // re-seeing ?a=1 is not a NEW variant, so it is not trimmed
      expect(skip('https://s.com/x?a=1')).toBe(false);
      // but a 3rd distinct variant is trimmed
      expect(skip('https://s.com/x?a=3')).toBe(true);
    });

    test('query param order does not create a new variant (canonical signature)', () => {
      const { skip } = makeGuard({ maxVariants: 1 });
      expect(skip('https://s.com/x?a=1&b=2')).toBe(false);
      // same params, reordered → same canonical variant → not trimmed
      expect(skip('https://s.com/x?b=2&a=1')).toBe(false);
    });

    test('caps are independent per path', () => {
      const { skip } = makeGuard({ maxVariants: 1 });
      expect(skip('https://s.com/a?x=1')).toBe(false);
      expect(skip('https://s.com/a?x=2')).toBe(true);  // path /a full
      expect(skip('https://s.com/b?x=1')).toBe(false); // path /b independent
    });

    test('caps are independent per origin', () => {
      const { skip } = makeGuard({ maxVariants: 1 });
      expect(skip('https://a.com/p?x=1')).toBe(false);
      expect(skip('https://b.com/p?x=1')).toBe(false); // different origin, own budget
    });
  });

  describe('distinct-value cap per key', () => {
    test('trims a new value for a key whose value set is already full', () => {
      // high variant cap so only the per-key cap can trigger
      const { skip } = makeGuard({ maxVariants: 10000, maxValues: 2 });
      expect(skip('https://s.com/x?sort=price')).toBe(false);  // sort: {price}
      expect(skip('https://s.com/x?sort=name')).toBe(false);   // sort: {price,name} full
      // new value for the full key → trimmed
      expect(skip('https://s.com/x?sort=rating')).toBe(true);
      // a value already in the set is still allowed
      expect(skip('https://s.com/x?sort=price')).toBe(false);
    });
  });

  describe('explosion scenario', () => {
    test('a faceted grid of many filter combos is bounded by the variant cap', () => {
      const { skip, seen } = makeGuard({ maxVariants: 25 });
      let allowed = 0;
      const colors = ['red', 'blue', 'green', 'black', 'white'];
      const sizes = ['s', 'm', 'l', 'xl'];
      const sorts = ['price', 'name', 'new'];
      for (const c of colors) for (const s of sizes) for (const so of sorts) {
        if (!skip(`https://shop.com/items?color=${c}&size=${s}&sort=${so}`)) allowed++;
      }
      // 60 combos requested, but only the first 25 distinct variants get through
      expect(allowed).toBe(25);
      expect(seen.get('https://shop.com/items').count).toBe(25);
    });
  });
});
