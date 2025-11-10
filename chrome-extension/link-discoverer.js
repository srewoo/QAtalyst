/**
 * Link Discoverer - Find and filter links for crawling
 * Version: 11.0.0
 * Discovers links on pages and filters them for same-origin crawling
 */

class LinkDiscoverer {
  constructor(baseUrl) {
    this.baseUrl = new URL(baseUrl);
    this.origin = this.baseUrl.origin;
  }

  /**
   * Discover all crawlable links on current page
   * @returns {Array<string>} Array of URLs to crawl
   */
  discoverLinks() {
    const links = new Set();
    const anchors = document.querySelectorAll('a[href]');

    for (const anchor of anchors) {
      try {
        const href = anchor.getAttribute('href');
        if (!href) continue;

        // Resolve relative URLs
        const absoluteUrl = new URL(href, window.location.href);

        // Filter links
        if (this.shouldCrawl(absoluteUrl)) {
          // Normalize URL (remove hash and trailing slash)
          const normalizedUrl = this.normalizeUrl(absoluteUrl);
          links.add(normalizedUrl);
        }
      } catch (error) {
        // Invalid URL, skip
        continue;
      }
    }

    // Also check for SPA routes in buttons/divs with data-href or onclick
    this.discoverSPARoutes(links);

    console.log(`🔍 Link Discovery: Found ${links.size} crawlable links`);
    return Array.from(links);
  }

  /**
   * Discover SPA routes from JavaScript navigation
   */
  discoverSPARoutes(links) {
    // Look for elements with data-href, data-url, etc.
    const elements = document.querySelectorAll('[data-href], [data-url], [data-route]');

    for (const el of elements) {
      const route = el.getAttribute('data-href') ||
                    el.getAttribute('data-url') ||
                    el.getAttribute('data-route');

      if (route) {
        try {
          const absoluteUrl = new URL(route, window.location.href);
          if (this.shouldCrawl(absoluteUrl)) {
            links.add(this.normalizeUrl(absoluteUrl));
          }
        } catch {
          // Invalid URL, skip
        }
      }
    }

    // Check for React Router / Vue Router patterns in the page
    this.discoverRouterPatterns(links);
  }

  /**
   * Discover common SPA router patterns
   */
  discoverRouterPatterns(links) {
    // Look for common route patterns in script content
    const scripts = document.querySelectorAll('script:not([src])');
    const routePatterns = [
      /path:\s*['"]([^'"]+)['"]/g,
      /route:\s*['"]([^'"]+)['"]/g,
      /<Route\s+path=['"]([^'"]+)['"]/g
    ];

    for (const script of scripts) {
      const content = script.textContent;
      for (const pattern of routePatterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
          const route = match[1];
          if (route && route.startsWith('/')) {
            try {
              const url = new URL(route, this.origin);
              if (this.shouldCrawl(url)) {
                links.add(this.normalizeUrl(url));
              }
            } catch {
              // Invalid URL, skip
            }
          }
        }
      }
    }
  }

  /**
   * Check if URL should be crawled
   */
  shouldCrawl(url) {
    // Must be same origin (configurable)
    const followSameOriginOnly = CONFIG.get('crawler.features.followSameOriginOnly', true);
    if (followSameOriginOnly && url.origin !== this.origin) {
      return false;
    }

    // Skip common non-page URLs from config
    const excludeExtensions = CONFIG.get('crawler.exclusions.extensions', [
      'jpg', 'jpeg', 'png', 'gif', 'svg', 'ico', 'pdf', 'zip', 'exe', 'dmg'
    ]);
    const excludePatterns = CONFIG.get('crawler.exclusions.patterns', [
      '/api/', '/download/', '/logout', '/signout', 'mailto:', 'tel:', 'javascript:'
    ]);

    // Build regex patterns
    const extensionPattern = new RegExp(`\\.(${excludeExtensions.join('|')})$`, 'i');
    const pathPatterns = excludePatterns.map(p => new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    const pathname = url.pathname + url.search;

    // Check extensions
    if (extensionPattern.test(pathname)) {
      return false;
    }

    // Check patterns
    if (pathPatterns.some(pattern => pattern.test(pathname))) {
      return false;
    }

    // Skip URLs with many query parameters (likely search/filter)
    const maxQueryLength = CONFIG.get('crawler.exclusions.maxQueryLength', 200);
    const params = new URLSearchParams(url.search);
    if (params.toString().length > maxQueryLength) {
      return false;
    }

    return true;
  }

  /**
   * Normalize URL for consistency
   */
  normalizeUrl(url) {
    // Remove hash
    url.hash = '';

    // Remove trailing slash
    let pathname = url.pathname;
    if (pathname !== '/' && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1);
    }
    url.pathname = pathname;

    return url.toString();
  }

  /**
   * Get links filtered by pattern
   */
  getLinksMatching(pattern) {
    const allLinks = this.discoverLinks();
    const regex = new RegExp(pattern);
    return allLinks.filter(link => regex.test(link));
  }

  /**
   * Get internal vs external link counts
   */
  getLinkStats() {
    const all = document.querySelectorAll('a[href]');
    let internal = 0;
    let external = 0;
    let other = 0;

    for (const anchor of all) {
      try {
        const url = new URL(anchor.href, window.location.href);
        if (url.origin === this.origin) {
          internal++;
        } else if (url.protocol === 'http:' || url.protocol === 'https:') {
          external++;
        } else {
          other++;
        }
      } catch {
        other++;
      }
    }

    return { internal, external, other, total: all.length };
  }
}

// Export for use in content script
if (typeof module !== 'undefined' && module.exports) {
  module.exports = LinkDiscoverer;
}
