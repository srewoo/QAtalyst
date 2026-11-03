/**
 * crawler-urls.js — URL policy: blacklist, injectability, normalisation, queueing, parameterised-URL budgets, crawl-loop protection and priority.
 *
 * Methods of WebAppCrawler, moved verbatim out of crawler.js and installed on its
 * prototype below. Load after crawler.js (importScripts order in background.js;
 * crawler.js requires this file itself under Node).
 */
(function (WebAppCrawler) {

class CrawlerUrlsMethods {
  /**
   * Get active blacklisted domains based on config
   */
  getBlacklistedDomains() {
    const blacklistConfig = CONFIG.get('crawler.blacklist', {});

    // If blacklist is disabled, return empty array
    if (blacklistConfig.enabled === false) {
      return [];
    }

    const categories = blacklistConfig.categories || {
      socialNetworks: true,
      googleServices: true,
      analytics: true,
      cdnAssets: true,
      authProviders: true,
      paymentProviders: true,
      chatSupport: true,
      mediaNews: false,
      developerSites: false,
      majorPlatforms: true
    };

    let domains = [];

    // Add domains from enabled categories
    for (const [category, isEnabled] of Object.entries(categories)) {
      if (isEnabled && WebAppCrawler.BLACKLIST_CATEGORIES[category]) {
        domains.push(...WebAppCrawler.BLACKLIST_CATEGORIES[category]);
      }
    }

    // Add custom domains from config
    const customDomains = blacklistConfig.customDomains || [];
    domains.push(...customDomains);

    // Remove duplicates
    return [...new Set(domains)];
  }

  /**
   * Check if URL is on the blacklist
   */
  isBlacklistedUrl(url) {
    if (!url) return false;

    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname.toLowerCase();

      const blacklistedDomains = this.getBlacklistedDomains();

      // Check exact match and subdomain match
      return blacklistedDomains.some(domain => {
        return hostname === domain || hostname.endsWith('.' + domain);
      });
    } catch (e) {
      return false;
    }
  }

  /**
   * Check if URL can have scripts injected
   */
  isInjectableUrl(url) {
    if (!url) return false;

    // Check blacklist first
    if (this.isBlacklistedUrl(url)) {
      console.log(`🚫 Skipping blacklisted URL: ${url}`);
      return false;
    }

    // URLs that cannot have content scripts injected
    const nonInjectablePatterns = [
      /^chrome:/,
      /^chrome-extension:/,
      /^about:/,
      /^edge:/,
      /^brave:/,
      /^opera:/,
      /^file:/,
      /^data:/,
      /^blob:/,
      /^javascript:/,
      /^view-source:/,
      /^devtools:/,
      /^chrome-search:/,
      /^chrome-untrusted:/
    ];

    // Check for non-injectable URL schemes
    if (nonInjectablePatterns.some(pattern => pattern.test(url))) {
      return false;
    }

    // Check for non-HTML content types (rough check by extension)
    const nonHtmlExtensions = ['.pdf', '.xml', '.json', '.txt', '.csv', '.zip', '.tar', '.gz',
                               '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.ico',
                               '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm',
                               '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'];

    try {
      const urlPath = new URL(url).pathname.toLowerCase();
      if (nonHtmlExtensions.some(ext => urlPath.endsWith(ext))) {
        return false;
      }
    } catch (e) {
      // URL parsing failed, assume injectable
    }

    return true;
  }

  /**
   * Check if URL is already in queue
   */
  isInQueue(url) {
    return this.queue.some(item => item.url === url);
  }

  /**
   * P1.4: Get adaptive navigation timeout based on site type
   * Static sites: 15s, Dynamic sites: 30s, Heavy sites: 60s
   */
  getNavigationTimeout() {
    const timeouts = CONFIG.get('crawler.timeouts.navigation', {
      static: 15000,
      dynamic: 30000,
      heavy: 60000,
      default: 30000
    });

    if (!this.siteType) {
      return timeouts.default;
    }

    return timeouts[this.siteType] || timeouts.default;
  }

  /**
   * P1.5: Check if URL is an authentication/login page
   * Prevents crawling auth pages that would cause redirects
   */
  isAuthUrl(url) {
    const authPatterns = CONFIG.get('crawler.authentication.detectPatterns', [
      '/login',
      '/signin',
      '/sign-in',
      '/auth',
      '/oauth',
      '/sso',
      '/authentication',
      '/login.aspx',
      '/account/login'
    ]);

    const lowerUrl = url.toLowerCase();
    return authPatterns.some(pattern => lowerUrl.includes(pattern));
  }

  /**
   * P2.7: Normalize URL to remove pagination and tracking parameters
   * Prevents infinite queue from parameterized URLs
   */
  normalizeUrl(url) {
    try {
      const urlObj = new URL(url);

      // Remove common pagination and tracking parameters
      const paramsToRemove = CONFIG.get('crawler.urlNormalization.removeParams', [
        'page',
        'offset',
        'limit',
        'timestamp',
        'ts',
        '_t',
        '_requestStartTime',   // SPA timestamp parameter
        '_selfRouting',        // SPA routing parameter
        '_timestamp',          // Generic timestamp
        'cache',               // Cache busting
        'v',                   // Version/cache busting
        'utm_source',
        'utm_medium',
        'utm_campaign',
        'utm_content',
        'utm_term',
        'fbclid',
        'gclid',
        'ref',
        'source'
      ]);

      paramsToRemove.forEach(param => {
        urlObj.searchParams.delete(param);
      });

      // Remove trailing slashes for consistency
      let normalized = urlObj.toString();
      if (normalized.endsWith('/') && urlObj.pathname !== '/') {
        normalized = normalized.slice(0, -1);
      }

      return normalized;
    } catch (e) {
      // If URL parsing fails, return original
      return url;
    }
  }

  /**
   * Check if URL should be added to queue
   * Prevents parameterized URLs from being queued if we already have enough samples
   * @returns {boolean} true if should queue, false if should skip
   */
  shouldQueueUrl(url) {
    // First check if URL is valid and injectable
    if (!url || typeof url !== 'string') {
      return false;
    }

    // Skip non-injectable URLs
    if (!this.isInjectableUrl(url)) {
      return false;
    }

    if (this.failedUrls && this.failedUrls.has(url)) {
      return false;
    }

    // Skip URLs with common non-crawlable patterns
    const skipPatterns = [
      /^mailto:/i,
      /^tel:/i,
      /^sms:/i,
      /^whatsapp:/i,
      /^skype:/i,
      /#$/,  // Hash-only links
      /\.(pdf|zip|rar|exe|dmg|pkg|deb|rpm)(\?|$)/i,  // Direct file downloads
      /logout|signout|sign-out|log-out/i,  // Logout URLs
      /unsubscribe/i,  // Unsubscribe links
      /\?.*utm_/i,  // Skip if only tracking params
    ];

    if (skipPatterns.some(pattern => pattern.test(url))) {
      return false;
    }

    // Skip external social media / third-party links
    try {
      const urlObj = new URL(url);
      const startUrlObj = new URL(this.startUrl);

      // Only crawl same origin
      if (urlObj.origin !== startUrlObj.origin) {
        return false;
      }
    } catch (e) {
      return false; // Invalid URL
    }

    // Faceted-parameter explosion guard: cap distinct query-param variants per
    // path so a faceted-filter UI (?color=red&size=M&sort=...) can't flood the
    // queue. Only affects URLs that carry query params — non-faceted sites are
    // untouched. Records into this.paramBudget and logs when it trims.
    if (this.shouldSkipForParamBudget(url, this.paramBudget)) {
      this.paramBudgetTrimmed++;
      console.log(`⏩ Param budget reached, trimming faceted URL (#${this.paramBudgetTrimmed}): ${url}`);
      return false;
    }

    // Check parameterized URL detection
    if (!this.detectParameterizedUrls) {
      return true; // Detection disabled, queue everything
    }

    const detectedPattern = this.getParameterizedPattern(url);

    if (!detectedPattern) {
      return true; // Not parameterized, queue it
    }

    // Check if we already have enough samples of this pattern
    const currentCount = this.parameterizedUrlTracking.get(detectedPattern) || 0;

    if (currentCount >= this.maxSamplesPerPattern) {
      // Already have enough samples - don't queue
      console.log(`⏩ Not queuing parameterized URL (already have ${currentCount} samples of ${detectedPattern}): ${url}`);
      return false;
    }

    // We need more samples of this pattern - queue it
    return true;
  }

  /**
   * Build the path-level key used by the param-budget guard.
   * Same origin + pathname = same bucket; query string is what we budget.
   * @returns {string|null} path key, or null if the URL has no query params
   *                        (non-faceted URLs are never budgeted)
   */
  getParamBudgetKey(url) {
    try {
      const u = new URL(url);
      if (!u.search || u.searchParams.toString() === '') return null;
      return `${u.origin}${u.pathname}`;
    } catch (e) {
      return null;
    }
  }

  /**
   * Faceted-parameter explosion guard (pure w.r.t. the passed-in seenMap).
   *
   * Decides whether a query-bearing URL should be SKIPPED because we've already
   * crawled too many variants that share its path. Two independent caps:
   *   1. maxParamVariantsPerPath — distinct query strings seen per path.
   *   2. maxValuesPerParamKey    — distinct values seen for any single key.
   * Either cap being exceeded by a NEW variant/value trims the URL.
   *
   * On an allowed URL it RECORDS the variant + key/value pairs into seenMap so
   * subsequent calls converge on the caps. URLs without query params are never
   * budgeted (returns false), so non-faceted sites are unaffected.
   *
   * @param {string} url
   * @param {Map} seenMap  Map<pathKey, { count:number, variants:Set, keys:Map<string,Set> }>
   * @returns {boolean} true if the URL should be skipped
   */
  shouldSkipForParamBudget(url, seenMap) {
    const pathKey = this.getParamBudgetKey(url);
    if (pathKey === null) return false; // no query params → never budgeted

    let params;
    try {
      params = new URL(url).searchParams;
    } catch (e) {
      return false;
    }

    const maxVariants = this.maxParamVariantsPerPath || 25;
    const maxValues = this.maxValuesPerParamKey || 50;

    let bucket = seenMap.get(pathKey);
    if (!bucket) {
      bucket = { count: 0, variants: new Set(), keys: new Map() };
      seenMap.set(pathKey, bucket);
    }

    // Sorted canonical query signature so ?a=1&b=2 == ?b=2&a=1.
    const variant = [...params.entries()]
      .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : (a[0] < b[0] ? -1 : 1)))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    const isNewVariant = !bucket.variants.has(variant);

    // Cap 1: too many distinct variants for this path, and this is a new one.
    if (isNewVariant && bucket.count >= maxVariants) {
      return true;
    }

    // Cap 2: any key whose distinct-value set is already full and this value is new.
    for (const [k, v] of params.entries()) {
      const valueSet = bucket.keys.get(k);
      if (valueSet && valueSet.size >= maxValues && !valueSet.has(v)) {
        return true;
      }
    }

    // Allowed → record it.
    if (isNewVariant) {
      bucket.variants.add(variant);
      bucket.count++;
    }
    for (const [k, v] of params.entries()) {
      let valueSet = bucket.keys.get(k);
      if (!valueSet) {
        valueSet = new Set();
        bucket.keys.set(k, valueSet);
      }
      valueSet.add(v);
    }

    return false;
  }

  /**
   * HYBRID APPROACH: Dynamically detect parameterized URL patterns
   * Part 1: Regex-based immediate detection
   * @returns {string|null} Detected pattern or null
   */
  detectParameterizedPattern(url) {
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname;

      // Pattern 1: Ends with numeric ID (/recording/123, /session/456)
      const numericIdPattern = /\/(\d+)$/;
      if (numericIdPattern.test(path)) {
        return path.replace(numericIdPattern, '/{id}');
      }

      // Pattern 2: Ends with UUID (/session/a1b2c3d4-e5f6-...)
      const uuidPattern = /\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
      if (uuidPattern.test(path)) {
        return path.replace(uuidPattern, '/{uuid}');
      }

      // Pattern 3: Ends with long alphanumeric ID (/call/abc123xyz, /ticket/JIRA-1234)
      const alphanumericPattern = /\/([a-zA-Z0-9_-]{8,})$/;
      if (alphanumericPattern.test(path)) {
        return path.replace(alphanumericPattern, '/{id}');
      }

      // Pattern 4: E-commerce product/item pages
      // /products/product-slug, /items/item-name, /p/product-name
      const ecommercePatterns = [
        /^\/(products?|items?|p|goods|merchandise|shop)\/([^/]+)$/i,
        /^\/(collections?|categories?|c|cat)\/([^/]+)\/([^/]+)$/i,  // /collections/category/product
        /^\/(product|item|p)\/([^/]+)\/([^/]+)$/i  // /product/category/slug
      ];

      for (const pattern of ecommercePatterns) {
        if (pattern.test(path)) {
          // Replace the last segment (product slug) with {slug}
          const segments = path.split('/').filter(s => s.length > 0);
          if (segments.length >= 2) {
            segments[segments.length - 1] = '{slug}';
            return '/' + segments.join('/');
          }
        }
      }

      // Pattern 5: Collection/Category pages with pagination
      // /collections/flowers?page=2, /category/gifts?sort=price
      if (/^\/(collections?|categories?|c|cat|tags?|brands?)\/([^/]+)$/i.test(path)) {
        const segments = path.split('/').filter(s => s.length > 0);
        return '/' + segments[0] + '/{category}';
      }

      // Pattern 6: Blog/Article pages
      // /blog/article-slug, /news/story-title, /posts/post-slug
      if (/^\/(blog|news|posts?|articles?|stories|updates?)\/([^/]+)$/i.test(path)) {
        const segments = path.split('/').filter(s => s.length > 0);
        return '/' + segments[0] + '/{slug}';
      }

      // Pattern 7: ID in middle (/user/123/profile, /recording/456/transcript)
      const segments = path.split('/').filter(s => s.length > 0);
      let hasIdSegment = false;
      const normalizedSegments = segments.map(segment => {
        if (/^\d+$/.test(segment) || /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(segment)) {
          hasIdSegment = true;
          return '{id}';
        }
        return segment;
      });

      if (hasIdSegment) {
        return '/' + normalizedSegments.join('/');
      }

      return null; // Not a parameterized URL
    } catch (e) {
      return null;
    }
  }

  /**
   * HYBRID APPROACH Part 2: Template-based learning
   * Build URL template by replacing variable segments with placeholders
   * This learns patterns dynamically as it crawls
   * @returns {string} URL template
   */
  buildUrlTemplate(url) {
    try {
      const urlObj = new URL(url);
      const path = urlObj.pathname;
      const segments = path.split('/').filter(s => s.length > 0);

      const templateSegments = segments.map(segment => {
        // Numeric segment → {num}
        if (/^\d+$/.test(segment)) {
          return '{num}';
        }

        // UUID segment → {uuid}
        if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(segment)) {
          return '{uuid}';
        }

        // Long alphanumeric (likely ID) → {id}
        if (/^[a-zA-Z0-9_-]{8,}$/.test(segment) && /\d/.test(segment)) {
          return '{id}';
        }

        // Keep as-is (static segment)
        return segment;
      });

      return '/' + templateSegments.join('/');
    } catch (e) {
      return url;
    }
  }

  /**
   * HYBRID APPROACH Part 3: Check if URL matches a parameterized pattern
   * Uses both regex detection and template learning
   * @returns {string|null} Pattern if detected, null otherwise
   */
  getParameterizedPattern(url) {
    // First: Try regex-based immediate detection (fast)
    const regexPattern = this.detectParameterizedPattern(url);
    if (regexPattern) {
      return regexPattern;
    }

    // Second: Build template and check if we've seen similar URLs
    const template = this.buildUrlTemplate(url);

    // If template contains placeholders, it's potentially parameterized
    if (template.includes('{')) {
      // Check if we've seen other URLs with this template
      const existingUrls = this.urlTemplates.get(template) || [];

      if (existingUrls.length > 0) {
        // We've seen this template before with different IDs → parameterized!
        return template;
      } else {
        // First time seeing this template - store it
        this.urlTemplates.set(template, [url]);
        return null; // Not confirmed as parameterized yet (need more samples)
      }
    }

    return null; // Not parameterized
  }

  /**
   * P0.2: Check for infinite queue and warn user
   * Prevents infinite crawl loops (SPAs with infinite scroll, pagination, etc.)
   */
  checkInfiniteQueue() {
    const queueWarningThreshold = CONFIG.get('crawler.limits.queueWarningThreshold', 1500);
    const maxQueueSize = CONFIG.get('crawler.limits.maxQueueSize', 2000);

    // CRITICAL: Hard stop if queue exceeds max
    if (this.queue.length >= maxQueueSize) {
      console.error(`🛑 QUEUE LIMIT REACHED: ${this.queue.length} URLs - pruning queue!`);

      // Prune queue: keep only high-priority unique URLs
      this.pruneQueue();

      // Send warning to UI
      this.sendProgress({
        status: 'warning',
        message: `⚠️ Queue pruned from ${this.queue.length} URLs to prevent overflow`,
        visited: this.visited.size,
        queueSize: this.queue.length,
        warning: 'queue_pruned'
      });

      return true;
    }

    if (this.queue.length >= queueWarningThreshold) {
      console.warn(`⚠️ QUEUE OVERFLOW WARNING: ${this.queue.length} URLs in queue!`);
      console.warn(`   This may indicate infinite crawl patterns (pagination, infinite scroll, etc.)`);
      console.warn(`   Consider stopping the crawl or adjusting maxPages limit`);

      // Send warning to UI
      this.sendProgress({
        status: 'warning',
        message: `⚠️ Queue overflow: ${this.queue.length} URLs (possible infinite crawl)`,
        visited: this.visited.size,
        queueSize: this.queue.length,
        warning: 'infinite_queue'
      });

      return true; // Queue overflow detected
    }

    return false;
  }

  /**
   * Prune queue to remove low-priority and duplicate-pattern URLs
   */
  pruneQueue() {
    const maxQueueSize = CONFIG.get('crawler.limits.maxQueueSize', 2000);
    const targetSize = Math.floor(maxQueueSize * 0.5); // Reduce to 50% of max

    console.log(`🔪 Pruning queue from ${this.queue.length} to ~${targetSize} URLs`);

    // Group URLs by pattern to detect over-represented patterns
    const patternCounts = new Map();
    for (const item of this.queue) {
      const pattern = this.getParameterizedPattern(item.url) || item.url;
      patternCounts.set(pattern, (patternCounts.get(pattern) || 0) + 1);
    }

    // Find patterns with too many URLs (likely pagination/products)
    const overRepresentedPatterns = new Set();
    for (const [pattern, count] of patternCounts) {
      if (count > 10) { // More than 10 URLs of same pattern
        overRepresentedPatterns.add(pattern);
        console.log(`   ⏩ Limiting pattern (${count} URLs): ${pattern}`);
      }
    }

    // Filter queue: limit each pattern to 3 samples
    const patternSamples = new Map();
    const prunedQueue = [];

    for (const item of this.queue) {
      const pattern = this.getParameterizedPattern(item.url) || item.url;

      if (overRepresentedPatterns.has(pattern)) {
        const sampleCount = patternSamples.get(pattern) || 0;
        if (sampleCount < 3) {
          patternSamples.set(pattern, sampleCount + 1);
          prunedQueue.push(item);
        }
        // Skip if already have 3 samples
      } else {
        prunedQueue.push(item);
      }

      // Stop if we've reached target size
      if (prunedQueue.length >= targetSize) break;
    }

    const removedCount = this.queue.length - prunedQueue.length;
    this.queue = prunedQueue;
    console.log(`✅ Pruned ${removedCount} URLs, queue now has ${this.queue.length} URLs`);
  }

  /**
   * WEEK 3: Calculate priority score for a URL
   */
  calculatePriority(url, features = [], apis = []) {
    if (!this.priorityCrawlingEnabled) return 50; // Default priority

    let score = 0;

    // Check URL patterns
    if (url.match(/\/(home|index|dashboard|main)/i)) score += this.priorityScores.navigation || 100;
    if (url.match(/\/(login|signup|register|auth)/i)) score += this.priorityScores.form || 90;
    if (url.match(/\/(api|graphql|rest)/i)) score += this.priorityScores.api || 85;

    // Score based on features
    if (features.some(f => f.type === 'form')) score += this.priorityScores.form || 90;
    if (features.some(f => f.type === 'navigation')) score += this.priorityScores.navigation || 100;
    if (features.some(f => f.type === 'button')) score += this.priorityScores.button || 70;
    if (features.some(f => f.type === 'table')) score += this.priorityScores.table || 60;

    // Score based on APIs
    if (apis && apis.length > 0) score += this.priorityScores.api || 85;

    // Static pages get lowest priority
    if (features.length === 0 && apis.length === 0) {
      score = this.priorityScores.static || 20;
    }

    return score;
  }

  /**
   * WEEK 3: Sort queue by priority
   */
  sortQueueByPriority() {
    if (!this.priorityCrawlingEnabled) return;
    if (!CONFIG.get('crawler.priorityCrawling.sortQueue', true)) return;

    this.queue.sort((a, b) => {
      const priorityA = a.priority || 50;
      const priorityB = b.priority || 50;
      return priorityB - priorityA; // Higher priority first
    });
  }
}

for (const name of Object.getOwnPropertyNames(CrawlerUrlsMethods.prototype)) {
  if (name !== 'constructor') Object.defineProperty(WebAppCrawler.prototype, name, Object.getOwnPropertyDescriptor(CrawlerUrlsMethods.prototype, name));
}
// The class is passed in so moved bodies that say `WebAppCrawler.X` resolve in Node too.
})(typeof WebAppCrawler !== 'undefined' ? WebAppCrawler : require('./crawler.js'));
