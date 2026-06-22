/**
 * Sitemap Parser - Fast URL Discovery
 * Version: 2.0.0
 * Parses sitemap.xml files to instantly discover all URLs.
 *
 * v2.0.0 (coverage hardening, ported from Pathfinder's recursive sitemap
 * discovery): instead of returning the FIRST sitemap that yields any URLs, we
 * now UNION every candidate — all robots.txt `Sitemap:` directives plus the
 * common well-known paths — and recurse through nested sitemap indexes with a
 * cycle guard. The old code stopped at the first hit (so a 5-URL /sitemap.xml
 * would mask a 5,000-URL /sitemap_index.xml) and capped indexes at 10
 * sub-sitemaps. Both were silent coverage killers.
 */

/** Binary/asset extensions that are never crawlable HTML pages. */
const BINARY_EXT = /\.(pdf|jpg|jpeg|png|gif|svg|webp|ico|mp4|webm|mp3|zip|tar|gz|exe|dmg|css|js|json|xml)$/i;

class SitemapParser {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.urls = new Set();
    this.sitemapPaths = CONFIG.get('crawler.sitemap.paths', [
      '/sitemap.xml',
      '/sitemap_index.xml',
      '/sitemap-index.xml',
      '/sitemap.php',
      '/sitemap_index.php'
    ]);
    // Coverage bounds — keep a huge crawl from exhausting memory while still
    // discovering far more than the old hard-coded 10 sub-sitemap cap allowed.
    this.maxUrls = CONFIG.get('crawler.sitemap.maxUrls', 5000);
    this.maxSitemaps = CONFIG.get('crawler.sitemap.maxSitemaps', 50);
    // Cycle guard shared across the recursive walk for a single parse() run.
    this._visitedSitemaps = new Set();
    this._sitemapsParsed = 0;
  }

  /**
   * Parse sitemaps and extract all URLs.
   *
   * Unions every source rather than returning on the first hit:
   *   1. ALL `Sitemap:` directives in robots.txt
   *   2. ALL common well-known sitemap paths
   * Nested sitemap indexes are followed recursively (cycle-guarded), and the
   * combined result is de-duplicated and capped at `maxUrls`.
   *
   * @returns {Promise<string[]>} De-duplicated array of discovered page URLs
   */
  async parse() {
    console.log('🗺️ Attempting to parse sitemap (recursive union)...');

    // Reset per-run state so a reused instance doesn't carry stale visited sets.
    this._visitedSitemaps = new Set();
    this._sitemapsParsed = 0;
    const discovered = new Set();

    try {
      const baseURL = new URL(this.baseUrl);

      // 1. Collect candidate sitemap URLs from robots.txt (all directives).
      const candidates = [];
      try {
        const fromRobots = await this.findAllSitemapsInRobots(`${baseURL.origin}/robots.txt`);
        if (fromRobots.length > 0) {
          console.log(`  📍 robots.txt referenced ${fromRobots.length} sitemap(s)`);
          candidates.push(...fromRobots);
        }
      } catch (_) {
        // robots.txt missing/unreadable is non-fatal.
      }

      // 2. Add the well-known paths.
      for (const path of this.sitemapPaths) {
        candidates.push(`${baseURL.origin}${path}`);
      }

      // 3. Walk every candidate, unioning the URLs they yield.
      for (const candidate of [...new Set(candidates)]) {
        if (discovered.size >= this.maxUrls) break;
        try {
          const urls = await this.fetchAndParseSitemap(candidate);
          for (const u of urls) {
            if (discovered.size >= this.maxUrls) break;
            discovered.add(u);
          }
          if (urls.length > 0) {
            console.log(`  ✅ ${candidate} → ${urls.length} URLs (total unique: ${discovered.size})`);
          }
        } catch (_) {
          // Individual candidate failure (404/invalid) is expected — keep going.
        }
      }

      if (discovered.size === 0) {
        console.log('  ℹ️ No sitemap found - will use traditional crawling');
      } else {
        console.log(`  🗺️ Sitemap discovery complete: ${discovered.size} unique URLs from ${this._sitemapsParsed} sitemap document(s)`);
      }
      return [...discovered];

    } catch (error) {
      console.error('❌ Sitemap parsing error:', error);
      return [...discovered];
    }
  }

  /**
   * Fetch and parse a sitemap URL. Detects sitemap indexes and recurses into
   * their sub-sitemaps. Cycle-guarded so a self-referential index can't loop.
   * @returns {Promise<string[]>} page URLs discovered under this sitemap
   */
  async fetchAndParseSitemap(sitemapUrl) {
    // Cycle / re-fetch guard for the recursive walk.
    if (this._visitedSitemaps.has(sitemapUrl)) return [];
    this._visitedSitemaps.add(sitemapUrl);
    if (this._sitemapsParsed >= this.maxSitemaps) return [];

    const response = await fetch(sitemapUrl);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    this._sitemapsParsed++;

    // Check if it's a sitemap index (contains other sitemaps)
    if (text.includes('<sitemapindex') || text.includes('sitemap_index')) {
      return await this.parseSitemapIndex(text);
    }

    // Regular sitemap
    return this.parseUrlSet(text);
  }

  /**
   * Parse a sitemap index (which points to other sitemaps) and recurse into
   * each sub-sitemap. No longer capped at 10 — bounded instead by `maxSitemaps`
   * and `maxUrls` so large multi-sitemap sites are fully discovered.
   */
  async parseSitemapIndex(xml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');

    const sitemapElements = doc.querySelectorAll('sitemap > loc');
    const allUrls = new Set();

    console.log(`  📚 Found sitemap index with ${sitemapElements.length} sub-sitemaps`);

    for (const element of sitemapElements) {
      if (allUrls.size >= this.maxUrls || this._sitemapsParsed >= this.maxSitemaps) break;
      const subUrl = element.textContent.trim();
      if (!subUrl || this._visitedSitemaps.has(subUrl)) continue;

      try {
        const urls = await this.fetchAndParseSitemap(subUrl);
        for (const u of urls) {
          if (allUrls.size >= this.maxUrls) break;
          allUrls.add(u);
        }
      } catch (error) {
        console.warn(`    ⚠️ Failed to parse sub-sitemap: ${subUrl}`);
      }
    }

    return [...allUrls];
  }

  /**
   * Parse a regular sitemap URL set. Same-origin only, de-duplicated, and with
   * binary/asset URLs filtered out (they aren't crawlable HTML pages).
   */
  parseUrlSet(xml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');

    // Check for XML parsing errors
    const parserError = doc.querySelector('parsererror');
    if (parserError) {
      throw new Error('Invalid XML format');
    }

    const urlElements = doc.querySelectorAll('url > loc');
    const urls = [];
    const seen = new Set();

    for (const element of urlElements) {
      const url = element.textContent.trim();
      if (!url || seen.has(url)) continue;

      // Same origin only, and skip non-HTML asset URLs.
      if (this.isSameOrigin(url) && !this.isBinaryUrl(url)) {
        seen.add(url);
        urls.push(url);
      }
    }

    return urls;
  }

  /** True when a URL points at a binary/asset rather than a crawlable page. */
  isBinaryUrl(url) {
    try {
      return BINARY_EXT.test(new URL(url).pathname);
    } catch {
      return false;
    }
  }

  /**
   * Find ALL sitemap locations declared in robots.txt (a site may list several).
   * @returns {Promise<string[]>}
   */
  async findAllSitemapsInRobots(robotsUrl) {
    const response = await fetch(robotsUrl);
    if (!response.ok) return [];

    const text = await response.text();
    const found = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.toLowerCase().startsWith('sitemap:')) {
        const sitemapUrl = trimmed.substring(8).trim();
        if (sitemapUrl) found.push(sitemapUrl);
      }
    }
    return found;
  }

  /**
   * Find the first sitemap location in robots.txt.
   * Retained for backwards compatibility; prefer findAllSitemapsInRobots.
   */
  async findSitemapInRobots(robotsUrl) {
    const all = await this.findAllSitemapsInRobots(robotsUrl);
    return all.length > 0 ? all[0] : null;
  }

  /**
   * Check if URL is same origin as base URL
   */
  isSameOrigin(url) {
    try {
      const baseURL = new URL(this.baseUrl);
      const testURL = new URL(url);
      return baseURL.origin === testURL.origin;
    } catch {
      return false;
    }
  }
}

// Export for use in crawler
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SitemapParser;
}
