/**
 * @vitest-environment happy-dom
 *
 * Tests for SitemapParser (sitemap-parser.js). It uses module.exports, reads a
 * CONFIG global (stubbed), parses XML with DOMParser (provided by happy-dom),
 * and fetches over the network (we stub global.fetch with canned responses).
 */
import { vi } from 'vitest';

global.CONFIG = global.CONFIG || { get: (_k, d) => d };
const SitemapParser = require('../sitemap-parser.js');

const BASE = 'https://app.example.com/';

function xmlResponse(body, { ok = true, status = 200 } = {}) {
  return Promise.resolve({
    ok,
    status,
    text: () => Promise.resolve(body),
  });
}

const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://app.example.com/</loc></url>
  <url><loc>https://app.example.com/about</loc></url>
  <url><loc>https://other.com/external</loc></url>
</urlset>`;

const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://app.example.com/sitemap-pages.xml</loc></sitemap>
</sitemapindex>`;

afterEach(() => {
  vi.restoreAllMocks();
  delete global.fetch;
});

describe('SitemapParser.parseUrlSet', () => {
  test('extracts <loc> URLs and filters to same origin', () => {
    const p = new SitemapParser(BASE);
    const urls = p.parseUrlSet(URLSET);
    expect(urls).toContain('https://app.example.com/');
    expect(urls).toContain('https://app.example.com/about');
    expect(urls).not.toContain('https://other.com/external');
  });

  test('throws on invalid XML', () => {
    const p = new SitemapParser(BASE);
    // happy-dom emits a <parsererror> node for malformed XML
    expect(() => p.parseUrlSet('<urlset><url><loc>oops')).toThrow();
  });
});

describe('SitemapParser.isSameOrigin', () => {
  const p = new SitemapParser(BASE);
  test('true for same origin, false otherwise', () => {
    expect(p.isSameOrigin('https://app.example.com/x')).toBe(true);
    expect(p.isSameOrigin('https://other.com/x')).toBe(false);
    expect(p.isSameOrigin('not a url')).toBe(false);
  });
});

describe('SitemapParser.fetchAndParseSitemap', () => {
  test('parses a plain urlset fetched over the network', async () => {
    global.fetch = vi.fn(() => xmlResponse(URLSET));
    const p = new SitemapParser(BASE);
    const urls = await p.fetchAndParseSitemap('https://app.example.com/sitemap.xml');
    expect(urls).toEqual(['https://app.example.com/', 'https://app.example.com/about']);
  });

  test('throws when the response is not ok', async () => {
    global.fetch = vi.fn(() => xmlResponse('', { ok: false, status: 404 }));
    const p = new SitemapParser(BASE);
    await expect(p.fetchAndParseSitemap('https://app.example.com/sitemap.xml'))
      .rejects.toThrow(/HTTP 404/);
  });

  test('follows a sitemap index to its sub-sitemaps', async () => {
    global.fetch = vi.fn((url) => {
      if (url.includes('sitemap-pages.xml')) return xmlResponse(URLSET);
      return xmlResponse(SITEMAP_INDEX);
    });
    const p = new SitemapParser(BASE);
    const urls = await p.fetchAndParseSitemap('https://app.example.com/sitemap.xml');
    expect(urls).toContain('https://app.example.com/about');
  });
});

describe('SitemapParser.parse', () => {
  test('returns URLs from the first sitemap path that yields results', async () => {
    global.fetch = vi.fn((url) => {
      if (url.endsWith('/sitemap.xml')) return xmlResponse(URLSET);
      return xmlResponse('', { ok: false, status: 404 });
    });
    const p = new SitemapParser(BASE);
    const urls = await p.parse();
    expect(urls).toContain('https://app.example.com/about');
  });

  test('returns [] when every sitemap path and robots.txt fail', async () => {
    global.fetch = vi.fn(() => xmlResponse('', { ok: false, status: 404 }));
    const p = new SitemapParser(BASE);
    const urls = await p.parse();
    expect(urls).toEqual([]);
  });

  test('falls back to robots.txt Sitemap: directive', async () => {
    global.fetch = vi.fn((url) => {
      if (url.endsWith('robots.txt')) {
        return xmlResponse('User-agent: *\nSitemap: https://app.example.com/custom-sitemap.xml');
      }
      if (url.includes('custom-sitemap.xml')) return xmlResponse(URLSET);
      return xmlResponse('', { ok: false, status: 404 });
    });
    const p = new SitemapParser(BASE);
    const urls = await p.parse();
    expect(urls).toContain('https://app.example.com/about');
  });
});

describe('SitemapParser.findSitemapInRobots', () => {
  test('extracts the Sitemap: URL from robots.txt', async () => {
    global.fetch = vi.fn(() =>
      xmlResponse('User-agent: *\nDisallow:\nSitemap: https://app.example.com/sm.xml'));
    const p = new SitemapParser(BASE);
    const found = await p.findSitemapInRobots('https://app.example.com/robots.txt');
    expect(found).toBe('https://app.example.com/sm.xml');
  });

  test('returns null when robots.txt has no Sitemap directive', async () => {
    global.fetch = vi.fn(() => xmlResponse('User-agent: *\nDisallow: /private'));
    const p = new SitemapParser(BASE);
    const found = await p.findSitemapInRobots('https://app.example.com/robots.txt');
    expect(found).toBeNull();
  });
});
