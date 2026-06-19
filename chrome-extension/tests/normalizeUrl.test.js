/**
 * Tests for normalizeUrl.
 * This function is the deduplication keyspace — a wrong normalization means
 * either missing duplicate pages (wasted crawl budget) or dropping unique pages.
 *
 * normalizeUrl uses browser URL API. Node >= 10 ships a compatible URL implementation.
 */

// ---------------------------------------------------------------------------
// Import the REAL shipped method from crawler.js (WebAppCrawler.normalizeUrl).
// It reads its remove-param list from CONFIG.get(key, default); we stub CONFIG
// to return the default list so the test exercises the production defaults. The
// method uses no `this`, so we call it via the prototype.
// ---------------------------------------------------------------------------
global.CONFIG = global.CONFIG || { get: (_k, d) => d };
const WebAppCrawler = require('../crawler.js');
const normalizeUrl = (url) => WebAppCrawler.prototype.normalizeUrl.call(null, url);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('normalizeUrl', () => {
  describe('pagination parameter removal', () => {
    test('removes ?page=2 query parameter', () => {
      expect(normalizeUrl('https://app.example.com/items?page=2')).toBe('https://app.example.com/items');
    });

    test('removes ?offset=20&limit=10', () => {
      expect(normalizeUrl('https://app.example.com/items?offset=20&limit=10')).toBe('https://app.example.com/items');
    });

    test('preserves non-pagination parameters', () => {
      const result = normalizeUrl('https://app.example.com/items?category=books&page=3');
      expect(result).toContain('category=books');
      expect(result).not.toContain('page=');
    });
  });

  describe('tracking parameter removal', () => {
    test('removes UTM parameters', () => {
      const url = 'https://app.example.com/blog?utm_source=email&utm_medium=cpc&utm_campaign=q4';
      const result = normalizeUrl(url);
      expect(result).not.toContain('utm_');
      expect(result).toBe('https://app.example.com/blog');
    });

    test('removes fbclid and gclid', () => {
      const url = 'https://app.example.com/landing?fbclid=abc123&gclid=xyz789';
      const result = normalizeUrl(url);
      expect(result).not.toContain('fbclid');
      expect(result).not.toContain('gclid');
    });

    test('removes SPA timestamp parameters', () => {
      const url = 'https://app.example.com/dashboard?_requestStartTime=1625000000&_selfRouting=true';
      const result = normalizeUrl(url);
      expect(result).not.toContain('_requestStartTime');
      expect(result).not.toContain('_selfRouting');
    });

    test('removes cache-busting v parameter', () => {
      const url = 'https://app.example.com/page?v=20250101';
      expect(normalizeUrl(url)).toBe('https://app.example.com/page');
    });
  });

  describe('trailing slash normalization', () => {
    test('removes trailing slash from paths', () => {
      expect(normalizeUrl('https://app.example.com/users/')).toBe('https://app.example.com/users');
    });

    test('preserves root trailing slash', () => {
      // Root "/" must keep the slash (urlObj.pathname === '/')
      expect(normalizeUrl('https://app.example.com/')).toBe('https://app.example.com/');
    });

    test('normalizes URL with both trailing slash and query params', () => {
      const result = normalizeUrl('https://app.example.com/users/?page=2');
      expect(result).not.toContain('page=');
      // Trailing slash on path removed
      expect(result).toBe('https://app.example.com/users');
    });
  });

  describe('URL structure preservation', () => {
    test('preserves protocol, host, and path', () => {
      const result = normalizeUrl('https://app.example.com/admin/users?ref=email');
      expect(result).toContain('https://');
      expect(result).toContain('app.example.com');
      expect(result).toContain('/admin/users');
    });

    test('preserves hash fragments', () => {
      const result = normalizeUrl('https://app.example.com/page#section');
      expect(result).toContain('#section');
    });

    test('preserves port numbers', () => {
      const result = normalizeUrl('https://app.example.com:8080/api?page=1');
      expect(result).toContain(':8080');
    });

    test('preserves multiple non-tracking query params', () => {
      const result = normalizeUrl('https://app.example.com/search?q=test&sort=asc&filter=active&page=2');
      expect(result).toContain('q=test');
      expect(result).toContain('sort=asc');
      expect(result).toContain('filter=active');
      expect(result).not.toContain('page=');
    });
  });

  describe('robustness', () => {
    test('returns original string for invalid URL', () => {
      const invalid = 'not a url at all';
      expect(normalizeUrl(invalid)).toBe(invalid);
    });

    test('returns original string for empty string', () => {
      expect(normalizeUrl('')).toBe('');
    });

    test('handles URL with no query params', () => {
      expect(normalizeUrl('https://app.example.com/users')).toBe('https://app.example.com/users');
    });

    test('handles relative paths gracefully (returns as-is since URL() throws)', () => {
      const relative = '/relative/path?page=1';
      // URL() throws on relative paths — function returns original
      expect(normalizeUrl(relative)).toBe(relative);
    });
  });

  describe('deduplication equivalence', () => {
    test('two URLs differing only in ?page= normalize to the same value', () => {
      const page1 = normalizeUrl('https://app.example.com/items?page=1');
      const page2 = normalizeUrl('https://app.example.com/items?page=2');
      expect(page1).toBe(page2);
    });

    test('two URLs differing only in UTM params normalize to the same value', () => {
      const emailUrl = normalizeUrl('https://app.example.com/landing?utm_source=email');
      const socialUrl = normalizeUrl('https://app.example.com/landing?utm_source=social');
      expect(emailUrl).toBe(socialUrl);
    });

    test('two URLs with different non-tracking params remain distinct', () => {
      const cat1 = normalizeUrl('https://app.example.com/items?category=shoes');
      const cat2 = normalizeUrl('https://app.example.com/items?category=hats');
      expect(cat1).not.toBe(cat2);
    });
  });
});
