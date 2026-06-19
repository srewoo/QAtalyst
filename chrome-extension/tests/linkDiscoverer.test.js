/**
 * @vitest-environment happy-dom
 *
 * Tests for LinkDiscoverer (link-discoverer.js). It uses module.exports of the
 * class, references a CONFIG global directly (we stub it on global), and reads
 * the live document/window supplied by happy-dom. Its normalizeUrl(urlObject)
 * takes a URL *object* (not a string) and strips hash + trailing slash — this
 * differs from crawler.js's string-based normalizeUrl, so it gets its own tests.
 */
global.CONFIG = global.CONFIG || { get: (_k, d) => d };
const LinkDiscoverer = require('../link-discoverer.js');

const BASE = 'https://app.example.com/';

beforeEach(() => {
  // happy-dom lets us set the document location so relative URLs resolve.
  window.happyDOM?.setURL?.(BASE);
  document.body.innerHTML = '';
});

describe('LinkDiscoverer.normalizeUrl', () => {
  const ld = new LinkDiscoverer(BASE);

  test('strips the hash fragment', () => {
    const u = new URL('https://app.example.com/page#section');
    expect(ld.normalizeUrl(u)).toBe('https://app.example.com/page');
  });

  test('removes a trailing slash from a non-root path', () => {
    const u = new URL('https://app.example.com/users/');
    expect(ld.normalizeUrl(u)).toBe('https://app.example.com/users');
  });

  test('preserves the root slash', () => {
    const u = new URL('https://app.example.com/');
    expect(ld.normalizeUrl(u)).toBe('https://app.example.com/');
  });

  test('keeps query string while dropping hash', () => {
    const u = new URL('https://app.example.com/search?q=test#top');
    expect(ld.normalizeUrl(u)).toBe('https://app.example.com/search?q=test');
  });
});

describe('LinkDiscoverer.shouldCrawl', () => {
  const ld = new LinkDiscoverer(BASE);

  test('accepts a same-origin page URL', () => {
    expect(ld.shouldCrawl(new URL('https://app.example.com/dashboard'))).toBe(true);
  });

  test('rejects a cross-origin URL when followSameOriginOnly is on', () => {
    expect(ld.shouldCrawl(new URL('https://other.com/page'))).toBe(false);
  });

  test('rejects excluded file extensions', () => {
    expect(ld.shouldCrawl(new URL('https://app.example.com/logo.png'))).toBe(false);
    expect(ld.shouldCrawl(new URL('https://app.example.com/doc.pdf'))).toBe(false);
  });

  test('rejects excluded path patterns like /api/ and /logout', () => {
    expect(ld.shouldCrawl(new URL('https://app.example.com/api/users'))).toBe(false);
    expect(ld.shouldCrawl(new URL('https://app.example.com/logout'))).toBe(false);
  });
});

describe('LinkDiscoverer.discoverLinks', () => {
  test('collects crawlable same-origin links and normalizes them', () => {
    window.happyDOM?.setURL?.(BASE);
    document.body.innerHTML = `
      <a href="/home/">Home</a>
      <a href="/about#team">About</a>
      <a href="https://external.com/x">External</a>
      <a href="/logo.png">Image</a>
      <a href="/api/data">API</a>
      <a href="">empty</a>
    `;
    const ld = new LinkDiscoverer(BASE);
    const links = ld.discoverLinks();

    expect(links).toContain('https://app.example.com/home');
    expect(links).toContain('https://app.example.com/about');
    expect(links).not.toContain('https://external.com/x');
    expect(links.some(l => l.endsWith('.png'))).toBe(false);
    expect(links.some(l => l.includes('/api/'))).toBe(false);
  });

  test('dedupes links that normalize to the same value', () => {
    window.happyDOM?.setURL?.(BASE);
    document.body.innerHTML = `
      <a href="/items/">A</a>
      <a href="/items">B</a>
      <a href="/items#x">C</a>
    `;
    const ld = new LinkDiscoverer(BASE);
    const links = ld.discoverLinks();
    const itemLinks = links.filter(l => l === 'https://app.example.com/items');
    expect(itemLinks).toHaveLength(1);
  });

  test('discovers SPA routes from data-href / data-route attributes', () => {
    window.happyDOM?.setURL?.(BASE);
    document.body.innerHTML = `
      <div data-href="/settings">Settings</div>
      <span data-route="/profile">Profile</span>
    `;
    const ld = new LinkDiscoverer(BASE);
    const links = ld.discoverLinks();
    expect(links).toContain('https://app.example.com/settings');
    expect(links).toContain('https://app.example.com/profile');
  });
});

describe('LinkDiscoverer.getLinkStats', () => {
  test('classifies anchors as internal / external / other', () => {
    window.happyDOM?.setURL?.(BASE);
    document.body.innerHTML = `
      <a href="/a">internal1</a>
      <a href="/b">internal2</a>
      <a href="https://other.com/x">external</a>
      <a href="mailto:hi@x.com">mail</a>
    `;
    const ld = new LinkDiscoverer(BASE);
    const stats = ld.getLinkStats();
    expect(stats.internal).toBe(2);
    expect(stats.external).toBe(1);
    expect(stats.other).toBe(1);
    expect(stats.total).toBe(4);
  });
});

describe('LinkDiscoverer.getLinksMatching', () => {
  test('returns only links matching the supplied pattern', () => {
    window.happyDOM?.setURL?.(BASE);
    document.body.innerHTML = `
      <a href="/admin/users">u</a>
      <a href="/admin/roles">r</a>
      <a href="/public/home">h</a>
    `;
    const ld = new LinkDiscoverer(BASE);
    const matches = ld.getLinksMatching('/admin/');
    expect(matches.every(l => l.includes('/admin/'))).toBe(true);
    expect(matches).toHaveLength(2);
  });
});
