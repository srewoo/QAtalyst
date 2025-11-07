/**
 * Sitemap Parser - Fast URL Discovery
 * Version: 1.0.0
 * Parses sitemap.xml files to instantly discover all URLs
 */

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
  }

  /**
   * Parse sitemap and extract all URLs
   * @returns {Promise<string[]>} Array of discovered URLs
   */
  async parse() {
    console.log('🗺️ Attempting to parse sitemap...');

    try {
      const baseURL = new URL(this.baseUrl);

      // Try each common sitemap path
      for (const path of this.sitemapPaths) {
        const sitemapUrl = `${baseURL.origin}${path}`;

        try {
          console.log(`  📍 Trying: ${sitemapUrl}`);
          const urls = await this.fetchAndParseSitemap(sitemapUrl);

          if (urls.length > 0) {
            console.log(`  ✅ Found ${urls.length} URLs in ${path}`);
            return urls;
          }
        } catch (error) {
          console.log(`  ⏭️ Not found: ${path}`);
          continue;
        }
      }

      // Try robots.txt to find sitemap location
      try {
        const robotsUrl = `${baseURL.origin}/robots.txt`;
        console.log(`  📍 Checking robots.txt for sitemap...`);
        const sitemapFromRobots = await this.findSitemapInRobots(robotsUrl);

        if (sitemapFromRobots) {
          const urls = await this.fetchAndParseSitemap(sitemapFromRobots);
          if (urls.length > 0) {
            console.log(`  ✅ Found ${urls.length} URLs from robots.txt sitemap`);
            return urls;
          }
        }
      } catch (error) {
        // Robots.txt not found or no sitemap
      }

      console.log('  ℹ️ No sitemap found - will use traditional crawling');
      return [];

    } catch (error) {
      console.error('❌ Sitemap parsing error:', error);
      return [];
    }
  }

  /**
   * Fetch and parse a sitemap URL
   */
  async fetchAndParseSitemap(sitemapUrl) {
    const response = await fetch(sitemapUrl);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();

    // Check if it's a sitemap index (contains other sitemaps)
    if (text.includes('<sitemapindex') || text.includes('sitemap_index')) {
      return await this.parseSitemapIndex(text);
    }

    // Regular sitemap
    return this.parseUrlSet(text);
  }

  /**
   * Parse sitemap index (which points to other sitemaps)
   */
  async parseSitemapIndex(xml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xml, 'text/xml');

    const sitemapElements = doc.querySelectorAll('sitemap > loc');
    const allUrls = [];

    console.log(`  📚 Found sitemap index with ${sitemapElements.length} sitemaps`);

    // Parse each sub-sitemap (limit to first 10 to avoid overwhelming)
    const limit = Math.min(sitemapElements.length, 10);

    for (let i = 0; i < limit; i++) {
      const sitemapUrl = sitemapElements[i].textContent.trim();

      try {
        console.log(`    📄 Parsing sub-sitemap ${i + 1}/${limit}...`);
        const urls = await this.fetchAndParseSitemap(sitemapUrl);
        allUrls.push(...urls);
      } catch (error) {
        console.warn(`    ⚠️ Failed to parse sub-sitemap: ${sitemapUrl}`);
      }
    }

    return allUrls;
  }

  /**
   * Parse regular sitemap URL set
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

    for (const element of urlElements) {
      const url = element.textContent.trim();

      // Filter to same origin only
      if (this.isSameOrigin(url)) {
        urls.push(url);
      }
    }

    return urls;
  }

  /**
   * Find sitemap location in robots.txt
   */
  async findSitemapInRobots(robotsUrl) {
    const response = await fetch(robotsUrl);

    if (!response.ok) {
      return null;
    }

    const text = await response.text();
    const lines = text.split('\n');

    for (const line of lines) {
      if (line.toLowerCase().startsWith('sitemap:')) {
        const sitemapUrl = line.substring(8).trim();
        return sitemapUrl;
      }
    }

    return null;
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
