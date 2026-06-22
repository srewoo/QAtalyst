/**
 * Web App Crawler - Main Orchestrator
 * Version: 11.0.0
 * Manages crawling workflow, page navigation, and data collection
 */

class WebAppCrawler {
  constructor(config) {
    this.startUrl = config.startUrl;
    this.maxPages = config.maxPages || CONFIG.get('crawler.limits.maxPages', 1000);
    this.maxDepth = config.maxDepth || CONFIG.get('crawler.limits.maxDepth', 10);
    this.delay = config.delay || CONFIG.get('crawler.delays.betweenPages', 500); // ms between requests
    this.tabId = config.tabId;

    this.visited = new Set();
    this.queue = [{ url: this.startUrl, depth: 0 }];
    this.pages = [];
    this.errors = [];
    this.retryCount = {}; // Track retry attempts per URL
    this.startTime = Date.now();

    // P0.1: Streaming save (prevents memory exhaustion on large crawls)
    this.crawlId = `${this.startUrl}_${this.startTime}`; // Unique identifier for this crawl
    this.batchSize = CONFIG.get('crawler.streamingSave.batchSize', 1000); // Save every 1,000 pages
    this.batchNumber = 0; // Current batch number
    this.streamingSaveEnabled = CONFIG.get('crawler.streamingSave.enabled', true);

    this.domExtractor = new DOMExtractor();
    this.linkDiscoverer = new LinkDiscoverer(this.startUrl);
    this.networkMonitor = new NetworkMonitor();
    this.sitemapParser = new SitemapParser(this.startUrl);
    this.resourceBlocker = new ResourceBlocker();
    this.spaDiscoverer = new SPARouteDiscoverer();
    this.smartWait = new SmartWait();

    this.isPaused = false;
    this.isStopped = false;

    // Parallel crawling with adaptive scaling
    this.parallelEnabled = CONFIG.get('crawler.parallel.enabled', true);
    this.maxConcurrentTabs = CONFIG.get('crawler.parallel.maxConcurrentTabs', 6);
    this.adaptiveScaling = CONFIG.get('crawler.parallel.adaptiveScaling', true);
    this.minTabs = CONFIG.get('crawler.parallel.minTabs', 3);
    this.maxTabs = CONFIG.get('crawler.parallel.maxTabs', 10);
    this.currentTabCount = this.maxConcurrentTabs; // Start with default
    this.activeTabs = new Set();
    this.tabQueue = [];

    // Track which tabs have content scripts injected to avoid duplicates
    this.scriptInjectedTabs = new Set();

    // Set true once an automated login succeeds. From that point the crawl runs
    // on the established session, so navigate() should treat it like
    // useCurrentSession (and not refuse auth-section URLs).
    this.sessionAuthenticated = false;

    // Performance tracking for adaptive scaling
    this.pageLoadTimes = [];
    this.avgLoadTime = 0;
    this.scaleUpThreshold = CONFIG.get('crawler.parallel.scaleUpThreshold', 1.5); // seconds
    this.scaleDownThreshold = CONFIG.get('crawler.parallel.scaleDownThreshold', 3.0); // seconds
    this.lastScaleCheck = Date.now();
    this.scaleCheckInterval = 10; // Check every 10 pages
    // Adaptive concurrency hardening (ported from Pathfinder): scale on the P90
    // load time rather than the mean so a few slow outliers don't drag tab count
    // down, and back off aggressively on consecutive crawl errors (a server
    // starting to fail under load should shed tabs immediately, not in 30s).
    this.usePercentileScaling = CONFIG.get('crawler.parallel.usePercentileScaling', true);
    this.consecutiveErrors = 0;
    this.errorBackoffThreshold = CONFIG.get('crawler.parallel.errorBackoffThreshold', 2);

    // Site detection (Week 2)
    this.siteType = null; // Will be detected: 'static', 'dynamic', or 'heavy'
    this.siteDetectionEnabled = CONFIG.get('crawler.siteDetection.enabled', true);
    this.siteDetectionSampleSize = CONFIG.get('crawler.siteDetection.sampleSize', 10);

    // Priority crawling (Week 3)
    this.priorityCrawlingEnabled = CONFIG.get('crawler.priorityCrawling.enabled', true);
    this.priorityScores = CONFIG.get('crawler.priorityCrawling.scoring', {});

    // Duplicate detection (Week 3)
    this.duplicateDetectionEnabled = CONFIG.get('crawler.duplicateDetection.enabled', true);
    this.similarityThreshold = CONFIG.get('crawler.duplicateDetection.similarityThreshold', 0.98);
    this.pageSignatures = new Map(); // Store page signatures for duplicate detection

    // Faceted-parameter explosion guard: cap how many distinct query-param
    // variants we crawl per path (e.g. ?color=red&size=M&sort=...). Without this
    // a faceted-filter UI can generate thousands of unique-but-equivalent URLs.
    this.maxParamVariantsPerPath = CONFIG.get('crawler.limits.maxParamVariantsPerPath', 25);
    this.maxValuesPerParamKey = CONFIG.get('crawler.limits.maxValuesPerParamKey', 50);
    this.paramBudget = new Map(); // Map<pathKey, { count, keys: Map<key, Set<value>> }>
    this.paramBudgetTrimmed = 0; // Count of URLs trimmed by the budget (for logging/metrics)

    // Parameterized URL pattern tracking (e.g., /recording/123, /recording/456 = same pattern)
    this.parameterizedUrlTracking = new Map(); // Map<pattern, count> - tracks samples per URL pattern
    this.urlTemplates = new Map(); // Map<template, [urls]> - for template-based learning
    this.detectParameterizedUrls = CONFIG.get('crawler.duplicateDetection.detectParameterizedUrls', true);
    this.maxSamplesPerPattern = CONFIG.get('crawler.duplicateDetection.maxSamplesPerPattern', 1);

    // Caching (Week 4)
    this.cachingEnabled = CONFIG.get('crawler.caching.enabled', true);
    this.featureCache = new Map();
    this.apiCache = new Map();

    // Selective crawling
    this.selectiveEnabled = CONFIG.get('crawler.selective.enabled', true);
    this.minFeaturesRequired = CONFIG.get('crawler.selective.minFeaturesRequired', 1);

    // Incremental crawl: Load previously crawled pages if available
    this.previouslyCrawled = new Set();
    this.loadPreviousCrawl(config.startUrl);

    // MEMORY OPTIMIZATION: Track cleanup intervals
    this.lastMemoryCleanup = Date.now();
    this.memoryCleanupInterval = 500; // Cleanup every 500 pages
    this.lastCacheCleanup = Date.now();
    this.cacheCleanupInterval = 100; // Clean cache every 100 pages
  }

  /**
   * Load previously crawled pages for incremental crawling
   */
  async loadPreviousCrawl(appUrl) {
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'loadEmbeddings',
        data: { appUrl }
      });

      if (response && response.success && response.knowledgeGraph && response.knowledgeGraph.pages) {
        const pages = response.knowledgeGraph.pages;
        const pageCount = Object.keys(pages).length;

        if (pageCount > 0) {
          console.log(`📚 Found previous crawl with ${pageCount} pages`);

          // Store previously crawled URLs
          for (const url of Object.keys(pages)) {
            this.previouslyCrawled.add(url);
          }

          // Ask user if they want incremental crawl
          const incrementalMode = CONFIG.get('crawler.incremental.enabled', true);
          if (incrementalMode) {
            console.log(`🔄 Incremental crawl enabled: Will skip ${pageCount} previously crawled pages`);
          }
        }
      }
    } catch (error) {
      // No previous crawl found or error loading - proceed with full crawl
      console.log('ℹ️ No previous crawl found - starting fresh');
    }
  }

  /**
   * Start the crawling process
   * @returns {Promise<Object>} Crawl results with knowledge graph
   */
  async crawl() {
    console.log(`🕷️ Starting crawl from ${this.startUrl}`);
    console.log(`📊 Config: maxPages=${this.maxPages}, maxDepth=${this.maxDepth}`);
    console.log(`⚡ Optimizations: Parallel=${this.parallelEnabled}, Selective=${this.selectiveEnabled}`);

    this.sendProgress({
      status: 'starting',
      message: 'Initializing crawler...',
      visited: 0,
      total: this.maxPages
    });

    try {
      // Start resource blocking for faster page loads
      // IMPORTANT: Pass the target domain to only block resources from the crawled site
      // This prevents breaking other open tabs
      if (CONFIG.get('crawler.resourceBlocking.enabled', false)) {
        await this.resourceBlocker.start(this.startUrl);
        console.log(`🎯 Resource blocking active for domain: ${new URL(this.startUrl).hostname}`);
      }

      // Automated login (v13.3): if configured, log in before crawling so the
      // session cookies carry through. Failure degrades to an unauthenticated
      // crawl rather than aborting.
      const autoLogin = CONFIG.get('crawler.authentication.autoLogin', null);
      if (autoLogin && autoLogin.enabled) {
        const r = await this.performLogin(autoLogin);
        if (r.success) this.sessionAuthenticated = true;
        console.log(r.success ? `🔐 Auto-login succeeded` : `⚠️ Auto-login failed: ${r.reason} — crawling unauthenticated`);
      }

      // Parse sitemap first for instant URL discovery
      if (CONFIG.get('crawler.sitemap.enabled', true)) {
        await this.parseSitemap();
      }

      // Start network monitoring
      await this.networkMonitor.start(this.tabId);

      // Choose crawling mode based on config
      if (this.parallelEnabled && this.maxConcurrentTabs > 1) {
        await this.crawlParallel();
      } else {
        await this.crawlSequential();
      }

      const result = await this.buildKnowledgeGraph();

      console.log(`✅ Crawl complete: ${this.visited.size} pages in ${((Date.now() - this.startTime) / 1000).toFixed(1)}s`);

      // Send only summary to avoid "Message length exceeded" error
      // Don't send full knowledge graph - it can be huge with thousands of pages
      this.sendProgress({
        status: 'complete',
        message: `Successfully crawled ${this.visited.size} pages`,
        visited: this.visited.size,
        total: this.visited.size,
        summary: {
          totalPages: result.totalPages,
          totalErrors: result.totalErrors,
          duration: result.duration,
          stats: result.stats,
          performance: result.performance
        }
      });

      return result;

    } finally {
      // ALWAYS cleanup - even if crawl errors or is stopped
      console.log('🧹 Cleaning up crawler resources...');

      // Stop network monitoring
      this.networkMonitor.stop();

      // Stop resource blocking
      await this.resourceBlocker.stop();

      // Close ALL tabs opened during crawling (including original tab if used)
      await this.closeAllParallelTabs();

      console.log('✅ Cleanup complete - all crawler tabs closed');
    }
  }

  /**
   * Sequential crawling (original method - one page at a time)
   */
  async crawlSequential() {
    console.log('🔄 Using sequential crawling mode');

    while (this.queue.length > 0 && this.visited.size < this.maxPages && !this.isStopped) {
      // Handle pause
      while (this.isPaused && !this.isStopped) {
        await this.sleep(500);
      }

      if (this.isStopped) break;

      const { url, depth } = this.queue.shift();

      // Skip if already visited or too deep
      if (this.visited.has(url) || depth > this.maxDepth) {
        continue;
      }

      // Incremental crawl: Skip if previously crawled
      const incrementalMode = CONFIG.get('crawler.incremental.enabled', true);
      if (incrementalMode && this.previouslyCrawled.has(url)) {
        console.log(`⏩ Skipping previously crawled: ${url}`);
        this.visited.add(url);
        continue;
      }

      try {
        await this.crawlPage(url, depth, this.tabId);
        await this.sleep(this.delay);
      } catch (error) {
        await this.handleCrawlError(url, depth, error);
      }

      this.sendProgress({
        status: 'crawling',
        message: `Crawled ${this.visited.size} pages`,
        visited: this.visited.size,
        total: this.maxPages,
        currentUrl: url,
        queueSize: this.queue.length
      });
    }
  }

  /**
   * Parallel crawling (multiple pages at once in separate tabs)
   */
  async crawlParallel() {
    console.log(`⚡ Using parallel crawling mode (${this.maxConcurrentTabs} concurrent tabs)`);

    // Create initial tabs - USE LET for adaptive scaling reassignment
    let tabIds = [this.tabId]; // Use the original tab

    // DON'T track the original tab - we don't want to close the user's tab!
    // Only close the EXTRA tabs we create for parallel crawling

    for (let i = 1; i < this.maxConcurrentTabs; i++) {
      const tabId = await this.createParallelTab();
      tabIds.push(tabId);
    }

    console.log(`✅ Created ${tabIds.length - 1} extra tabs for parallel crawling (+ original tab)`);

    while (this.queue.length > 0 && this.visited.size < this.maxPages && !this.isStopped) {
      // Handle pause
      while (this.isPaused && !this.isStopped) {
        await this.sleep(500);
      }

      if (this.isStopped) break;

      // Get up to N items from queue (one per tab)
      const batch = [];
      for (let i = 0; i < tabIds.length && this.queue.length > 0; i++) {
        const item = this.queue.shift();
        if (item) batch.push(item);
      }

      if (batch.length === 0) break;

      // Crawl all pages in parallel
      const promises = batch.map(async (item, index) => {
        let tabId = tabIds[index];
        const { url, depth } = item;

        // Skip if already visited or too deep
        if (this.visited.has(url) || depth > this.maxDepth) {
          return Promise.resolve();
        }

        // Incremental crawl: Skip if previously crawled
        const incrementalMode = CONFIG.get('crawler.incremental.enabled', true);
        if (incrementalMode && this.previouslyCrawled.has(url)) {
          console.log(`⏩ Skipping previously crawled: ${url}`);
          this.visited.add(url);
          return Promise.resolve();
        }

        // CRITICAL FIX: Validate tab before crawling, recreate if invalid
        const tabValid = await this.isTabValid(tabId);
        if (!tabValid) {
          console.warn(`⚠️ Tab ${tabId} invalid, recreating for: ${url}`);
          try {
            // Remove old tab ID from tracking
            this.activeTabs.delete(tabId);
            this.scriptInjectedTabs.delete(tabId);

            // Create new tab
            const newTabId = await this.createParallelTab();
            tabIds[index] = newTabId; // Update the tabIds array
            tabId = newTabId;
            console.log(`✅ Created replacement tab ${newTabId}`);
          } catch (error) {
            console.error(`❌ Failed to recreate tab:`, error);
            return this.handleCrawlError(url, depth, error);
          }
        }

        // Crawl the page
        return this.crawlPage(url, depth, tabId)
          .catch(error => this.handleCrawlError(url, depth, error));
      });

      // Wait for all pages in batch to complete
      await Promise.all(promises);

      // WEEK 1: Check adaptive scaling every batch
      tabIds = await this.checkAdaptiveScaling(tabIds);

      // P0.2: Check for infinite queue (potential crawl loop)
      this.checkInfiniteQueue();

      // Small delay between batches (reduced from config)
      await this.sleep(this.delay);

      this.sendProgress({
        status: 'crawling',
        message: `Crawled ${this.visited.size} pages (parallel mode, ${tabIds.length} tabs)`,
        visited: this.visited.size,
        total: this.maxPages,
        queueSize: this.queue.length,
        tabCount: tabIds.length,
        avgLoadTime: this.avgLoadTime ? Math.round(this.avgLoadTime) : null
      });
    }
  }

  /**
   * Handle crawl errors with retry logic
   */
  async handleCrawlError(url, depth, error) {
    console.error(`❌ Failed to crawl ${url}:`, error);

    // Feed the adaptive-concurrency error backoff: a run of failures means the
    // server (or our tab pool) is overloaded — checkAdaptiveScaling sheds tabs.
    this.consecutiveErrors++;

    // Retry logic for timeout and network errors
    const retryableErrors = ['timeout', 'net::', 'ERR_', 'Failed to fetch'];
    const isRetryable = retryableErrors.some(pattern =>
      error.message.toLowerCase().includes(pattern.toLowerCase())
    );

    if (isRetryable && !this.retryCount[url]) {
      this.retryCount[url] = 0;
    }

    const maxRetries = CONFIG.get('crawler.retry.maxRetries', 2);
    if (isRetryable && this.retryCount[url] < maxRetries) {
      this.retryCount[url]++;
      console.log(`🔄 Retry ${this.retryCount[url]}/${maxRetries} for ${url}`);

      // Add back to queue for retry
      this.queue.push({ url, depth });

      // Wait longer before retry
      const retryDelay = CONFIG.get('crawler.retry.retryDelay', 2000);
      await this.sleep(retryDelay);
    } else {
      // Max retries reached or non-retryable error
      if (isRetryable) {
        console.error(`❌ Max retries (${maxRetries}) reached for ${url}`);
      }

      this.errors.push({
        url,
        error: error.message,
        retries: this.retryCount[url] || 0,
        timestamp: Date.now()
      });
    }
  }

  /**
   * Validate that a tab still exists and is usable
   * @param {number} tabId - Tab ID to validate
   * @returns {Promise<boolean>} true if valid, false if not
   */
  async isTabValid(tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      return tab && !tab.discarded;
    } catch (error) {
      return false;
    }
  }

  /**
   * Crawl a single page
   * @param {string} url - Page URL to crawl
   * @param {number} depth - Current crawl depth
   * @param {number} tabId - Tab ID to use for crawling
   */
  async crawlPage(url, depth, tabId) {
    console.log(`📄 Crawling: ${url} (depth: ${depth}, queue: ${this.queue.length}) [tab ${tabId}]`);

    // Validate URL before crawling
    if (!this.isInjectableUrl(url)) {
      console.warn(`⚠️ Skipping non-injectable URL: ${url}`);
      this.visited.add(url);
      return;
    }

    // CRITICAL FIX: Validate tab before using it
    const tabValid = await this.isTabValid(tabId);
    if (!tabValid) {
      console.error(`❌ Tab ${tabId} is invalid or closed, skipping page: ${url}`);
      throw new Error(`Tab ${tabId} no longer exists`);
    }

    // Navigate to page
    await this.navigate(url, tabId);

    // Wait for page load
    const loadedTab = await this.waitForPageLoad(tabId);

    // Verify we're on the correct URL (handle redirects)
    const actualUrl = loadedTab.url || url;
    if (actualUrl !== url) {
      console.log(`  ↪ Redirected to: ${actualUrl}`);
      // Check if we already visited the redirect target
      if (this.visited.has(actualUrl)) {
        console.log(`  ⏭ Skipping: Already visited redirect target`);
        this.visited.add(url); // Mark original URL as visited too
        return;
      }
    }

    // WEEK 2: Adaptive smart wait based on detected site type
    const useSmartWait = CONFIG.get('crawler.smartWait.enabled', true) && this.shouldUseSmartWait();
    if (useSmartWait) {
      await this.smartWait.waitForPage(tabId);
    } else {
      // WEEK 2: Use adaptive wait time based on site type
      const adaptiveWaitTime = this.getAdaptiveWaitTime();
      await this.sleep(adaptiveWaitTime);
    }

    // Verify content script is loaded BEFORE trying to communicate with it
    const scriptInjected = await this.verifyContentScript(tabId);
    if (!scriptInjected) {
      console.warn(`⚠️ Could not inject content script for ${actualUrl}, skipping page`);
      this.visited.add(url);
      if (actualUrl !== url) {
        this.visited.add(actualUrl);
      }
      this.stats.errors++;
      return;
    }

    // P2.8: Wait for SPA framework hydration (React, Vue, Angular)
    // Must be AFTER verifyContentScript since it sends messages to content script
    const isSPA = await this.waitForSPAHydration(tabId);

    // Extract data from DOM
    const features = await this.extractPageData(tabId);

    // Get API calls captured during page load
    const apis = this.networkMonitor.getApiCalls();

    // Discover new links (traditional)
    const links = await this.discoverLinks(tabId);

    // SPA Route Discovery
    const spaEnabled = CONFIG.get('crawler.spaDiscovery.enabled', true);
    const passiveEnabled = CONFIG.get('crawler.spaDiscovery.passiveEnabled', true);
    // Auto-tune (v13.3): click-based discovery is expensive, so it's off by
    // default — BUT when this page is detected as a real SPA (framework +
    // hydration), auto-enable it so single-page apps actually get their
    // click-only routes crawled. Explicit config still wins/forces it.
    const clickConfigured = CONFIG.get('crawler.spaDiscovery.clickEnabled', false);
    const autoClickOnSpa = CONFIG.get('crawler.spaDiscovery.autoClickOnSpa', true);
    const clickEnabled = clickConfigured || (autoClickOnSpa && isSPA);
    if (clickEnabled && !clickConfigured) {
      console.log('🤖 SPA detected — auto-enabling click-based route discovery for this page');
    }
    let spaDiscoveries = [];
    if (spaEnabled) {
      // CRITICAL FIX: Validate tab before SPA discovery
      const tabValidBeforeSPA = await this.isTabValid(tabId);
      if (!tabValidBeforeSPA) {
        console.warn(`⚠️ Tab ${tabId} closed before SPA discovery, skipping`);
      } else {
        try {
          // Phase 1: Passive discovery (zero overhead — intercepts History API calls)
          if (passiveEnabled) {
            const passiveRoutes = await this.spaDiscoverer.discoverRoutesPassive(tabId, 2000);
            if (passiveRoutes.length > 0) {
              spaDiscoveries.push(...passiveRoutes);
              const newUrls = passiveRoutes.map(r => r.url).filter(Boolean);
              links.push(...newUrls);
              console.log(`🔍 Passive SPA: discovered ${newUrls.length} routes via History API`);
            }
          }

          // Phase 2: Click-based discovery (optional — more thorough but uses memory)
          if (clickEnabled) {
            console.log('🔍 Starting click-based SPA route discovery...');
            const clickDiscoveries = await this.spaDiscoverer.discoverRoutes(tabId);
            spaDiscoveries.push(...clickDiscoveries);

            // Extract unique routes from click discoveries
            const spaRoutes = this.spaDiscoverer.extractRoutes(clickDiscoveries);
            console.log(`✅ Click SPA discovery found ${spaRoutes.length} new routes`);
            links.push(...spaRoutes);
          }

          if (spaDiscoveries.length > 0) {
            console.log(`✅ SPA discovery total: ${spaDiscoveries.length} routes found`);
          }

          // Re-verify content script after SPA discovery (clicks may have disrupted it)
          this.scriptInjectedTabs.delete(tabId);

          const tabValidAfterSPA = await this.isTabValid(tabId);
          if (tabValidAfterSPA) {
            await this.verifyContentScript(tabId);
          }
        } catch (error) {
          console.error(`❌ SPA discovery failed for tab ${tabId}:`, error.message);
          // Continue without SPA routes
        }
      }
    }

    // Get page metadata
    const metadata = await this.getPageMetadata(tabId);

    // Extract text content (for help articles, documentation)
    let textContent = null;
    const textContentEnabled = CONFIG.get('domExtraction.textContent.enabled', true);

    if (textContentEnabled) {
      // For SPAs, add extra wait for content to update after navigation
      if (isSPA) {
        console.log('⏳ Waiting for SPA content to update...');

        // Wait for title to change (good indicator of content load)
        const initialTitle = metadata.title;
        let titleChangeWait = 0;
        const maxWait = 4000;

        while (titleChangeWait < maxWait) {
          await this.sleep(500);
          titleChangeWait += 500;

          const currentMeta = await this.getPageMetadata(tabId);
          if (currentMeta.title !== initialTitle && currentMeta.title !== '') {
            console.log(`  ✓ Title changed after ${titleChangeWait}ms: "${currentMeta.title}"`);
            metadata.title = currentMeta.title; // Update with new title
            break;
          }
        }

        // Additional wait for content to render after title change
        await this.sleep(1000);
      }

      textContent = await this.extractTextContent(tabId);

      // Log first 100 chars of extracted text (after skipping nav) for debugging
      if (textContent && textContent.length > 200) {
        const uniquePart = textContent.substring(200, 300);
        console.log(`  📄 Text preview (chars 200-300): "${uniquePart.substring(0, 100)}..."`);
      }
    }

    // NEW: Get enhanced data from DOM extractor
    const errorPatterns = await this.getErrorPatterns(tabId);
    const pageHints = await this.getPageHints(tabId);

    // NEW: Get enhanced API data (with null safety)
    let apiSummary = { endpoints: [], errors: [], pagination: [] };
    try {
      if (this.networkMonitor && typeof this.networkMonitor.getEnhancedApiSummary === 'function') {
        apiSummary = this.networkMonitor.getEnhancedApiSummary() || apiSummary;
      }
    } catch (e) {
      console.warn('⚠️ Failed to get API summary:', e.message);
    }

    // Store page data (use actual URL if redirected)
    const pageData = {
      url: actualUrl,
      originalUrl: url !== actualUrl ? url : undefined,
      depth,
      title: metadata.title,
      description: metadata.description,
      textContent: textContent, // Main article/page text content
      features,
      apis: apis.filter(api => this.isRelevantApi(api)),
      links,
      spaDiscoveries: spaDiscoveries.length > 0 ? spaDiscoveries : undefined,
      timestamp: Date.now(),
      loadTime: metadata.loadTime,
      // NEW: Enhanced metadata (optional fields prefixed with _)
      _errorPatterns: errorPatterns && errorPatterns.length > 0 ? errorPatterns : undefined,
      _pageHints: pageHints && Object.keys(pageHints).length > 0 ? pageHints : undefined,
      _apiSchemas: apiSummary.endpoints && apiSummary.endpoints.length > 0 ? apiSummary.endpoints : undefined,
      _apiErrors: apiSummary.errors && apiSummary.errors.length > 0 ? apiSummary.errors : undefined,
      _pagination: apiSummary.pagination && apiSummary.pagination.length > 0 ? apiSummary.pagination : undefined
    };

    // WEEK 1: Track page load time for adaptive scaling
    this.trackPageLoadTime(metadata.loadTime || 1000);

    // WEEK 3: Check for duplicate pages
    if (this.isDuplicatePage(pageData)) {
      this.visited.add(actualUrl);
      if (url !== actualUrl) {
        this.visited.add(url);
      }
      // Still queue links for discovery
      for (const link of links) {
        const normalizedLink = this.normalizeUrl(link);
        if (!this.visited.has(normalizedLink) && !this.isInQueue(normalizedLink) && this.shouldQueueUrl(normalizedLink)) {
          const priority = this.calculatePriority(normalizedLink, [], []);
          this.queue.push({ url: normalizedLink, depth: depth + 1, priority });
        }
      }
      return;
    }

    // Selective crawling: Check if page has interactive elements
    const isInteractive = this.isPageInteractive(features, apis);

    if (!isInteractive && this.selectiveEnabled) {
      console.log(`  ⏭️ Skipping non-interactive page (${features.length} features)`);
      this.visited.add(actualUrl);
      if (url !== actualUrl) {
        this.visited.add(url);
      }
      // Still queue links for discovery, but don't save this page
      for (const link of links) {
        const normalizedLink = this.normalizeUrl(link);
        if (!this.visited.has(normalizedLink) && !this.isInQueue(normalizedLink) && this.shouldQueueUrl(normalizedLink)) {
          const priority = this.calculatePriority(normalizedLink, [], []);
          this.queue.push({ url: normalizedLink, depth: depth + 1, priority });
        }
      }
      return;
    }

    this.pages.push(pageData);
    this.visited.add(actualUrl);
    if (url !== actualUrl) {
      this.visited.add(url); // Mark both URLs as visited
    }

    // Send page data immediately for incremental processing
    this.sendPageData(pageData);

    // P0.1: Streaming save - save batch and clear memory when threshold reached
    await this.checkAndSaveBatch();

    // MEMORY OPTIMIZATION: Periodic cleanup
    this.performMemoryCleanup();
    this.performCacheCleanup();

    // MEMORY OPTIMIZATION: Check for memory pressure
    const criticalMemory = await this.checkMemoryPressure();
    if (criticalMemory) {
      console.error('❌ CRITICAL MEMORY: Stopping crawl to prevent crash');
      this.isStopped = true;
      throw new Error('Memory limit exceeded - crawl stopped to prevent crash');
    }

    // WEEK 3: Queue new links with priority scoring
    for (const link of links) {
      // P2.7: Normalize URL to prevent duplicate crawling (pagination, tracking params)
      const normalizedLink = this.normalizeUrl(link);

      if (!this.visited.has(normalizedLink) && !this.isInQueue(normalizedLink) && this.shouldQueueUrl(normalizedLink)) {
        const priority = this.calculatePriority(normalizedLink, features, apis);
        this.queue.push({ url: normalizedLink, depth: depth + 1, priority });
      }
    }

    // WEEK 3: Sort queue by priority after adding new links
    if (this.queue.length > 10) { // Only sort if queue is large enough
      this.sortQueueByPriority();
    }

    console.log(`  ✓ Found ${features.length} features, ${apis.length} APIs, ${links.length} links`);
  }

  /**
   * Run automated form login before the crawl (v13.3). Wires CrawlerAuth to the
   * real browser APIs. Returns { success, reason } and never throws.
   */
  async performLogin(authConfig) {
    if (typeof CrawlerAuth === 'undefined') {
      return { success: false, reason: 'CrawlerAuth module not loaded' };
    }
    const tabId = this.tabId;
    const auth = new CrawlerAuth(authConfig, {
      // Direct navigation that bypasses the isAuthUrl guard (the login URL is, by
      // definition, an auth URL).
      navigate: (url) => new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('login navigation timeout')), this.getNavigationTimeout());
        chrome.tabs.update(tabId, { url }, () => {
          clearTimeout(t);
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else setTimeout(resolve, 1200); // let the login page settle
        });
      }),
      fillAndSubmit: async (steps) => {
        await chrome.scripting.executeScript({
          target: { tabId },
          args: [steps],
          func: (fillSteps) => {
            const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));
            for (const s of fillSteps) {
              const el = document.querySelector(s.selector);
              if (!el) continue;
              if (s.action === 'fill') {
                el.focus(); el.value = s.value; fire(el, 'input'); fire(el, 'change');
              } else if (s.action === 'click') {
                el.click();
              } else if (s.action === 'enter') {
                el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
                if (el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
              }
            }
          },
        });
      },
      getCurrentUrl: () => new Promise((resolve) => {
        chrome.tabs.get(tabId, (tab) => resolve(tab && tab.url ? tab.url : null));
      }),
      sleep: (ms) => this.sleep(ms),
    });
    return auth.authenticate();
  }

  /**
   * Navigate to URL in the target tab
   * P1.4: Uses adaptive timeout based on detected site type
   */
  async navigate(url, tabId) {
    // P1.5: Check for authentication redirect (skip if using current session).
    // A successful auto-login means we're now ON the session, so honour it too.
    const useCurrentSession = this.sessionAuthenticated || CONFIG.get('crawler.authentication.useCurrentSession', false);
    if (!useCurrentSession && this.isAuthUrl(url)) {
      console.warn(`⚠️ Skipping authentication URL: ${url}`);
      throw new Error(`Authentication required: ${url}`);
    }

    // Clear script injection tracking for this tab when navigating to new page
    // Each navigation creates a new page context, so scripts need to be re-injected
    this.scriptInjectedTabs.delete(tabId);

    return new Promise((resolve, reject) => {
      // P1.4: Adaptive timeout based on site type
      const adaptiveTimeout = this.getNavigationTimeout();
      const timeout = setTimeout(() => {
        reject(new Error(`Navigation timeout after ${adaptiveTimeout / 1000}s: ${url}`));
      }, adaptiveTimeout);

      chrome.tabs.update(tabId, { url }, (tab) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(tab);
        }
      });
    });
  }

  /**
   * Wait for page to fully load using event-based detection
   */
  async waitForPageLoad(tabId) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Page load timeout after 30s'));
      }, 30000);

      const onUpdated = (updatedTabId, changeInfo, tab) => {
        // Only listen to our target tab
        if (updatedTabId !== tabId) return;

        // Check if page is fully loaded
        if (changeInfo.status === 'complete') {
          cleanup();
          resolve(tab);
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
      };

      // Start listening
      chrome.tabs.onUpdated.addListener(onUpdated);

      // Also check if page is already complete (race condition)
      chrome.tabs.get(tabId, (tab) => {
        if (tab && tab.status === 'complete') {
          cleanup();
          resolve(tab);
        }
      });
    });
  }

  /**
   * Blacklisted domains by category - never crawl these
   */
  static BLACKLIST_CATEGORIES = {
    socialNetworks: [
      'facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.com', 'fbcdn.net',
      'linkedin.com', 'www.linkedin.com',
      'twitter.com', 'www.twitter.com', 'x.com', 'www.x.com',
      'instagram.com', 'www.instagram.com',
      'pinterest.com', 'www.pinterest.com', 'pin.it',
      'tiktok.com', 'www.tiktok.com',
      'snapchat.com', 'www.snapchat.com',
      'reddit.com', 'www.reddit.com', 'old.reddit.com',
      'tumblr.com', 'www.tumblr.com',
      'threads.net', 'www.threads.net',
      'whatsapp.com', 'web.whatsapp.com',
      'telegram.org', 'web.telegram.org',
      'discord.com', 'discord.gg'
    ],

    googleServices: [
      'google.com', 'www.google.com',
      'google.co.uk', 'google.de', 'google.fr', 'google.es', 'google.it',
      'google.ca', 'google.com.au', 'google.co.in', 'google.co.jp',
      'youtube.com', 'www.youtube.com', 'm.youtube.com',
      'maps.google.com', 'mail.google.com', 'drive.google.com',
      'play.google.com', 'news.google.com', 'calendar.google.com',
      'translate.google.com', 'photos.google.com'
    ],

    analytics: [
      'googletagmanager.com', 'google-analytics.com', 'analytics.google.com',
      'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
      'facebook.net', 'connect.facebook.net',
      'hotjar.com', 'mixpanel.com', 'segment.com', 'segment.io',
      'newrelic.com', 'nr-data.net',
      'sentry.io', 'browser.sentry-cdn.com',
      'amplitude.com', 'heapanalytics.com', 'fullstory.com',
      'clarity.ms', 'mouseflow.com', 'crazyegg.com',
      'optimizely.com', 'launchdarkly.com'
    ],

    cdnAssets: [
      'cloudflare.com', 'cdn.cloudflare.com', 'cdnjs.cloudflare.com',
      'amazonaws.com', 's3.amazonaws.com', 'cloudfront.net',
      'akamai.net', 'akamaihd.net', 'akamaized.net',
      'fastly.net', 'fastly.com',
      'unpkg.com', 'jsdelivr.net', 'bootstrapcdn.com',
      'fontawesome.com', 'fonts.googleapis.com', 'fonts.gstatic.com',
      'gravatar.com', 'wp.com', 'staticflickr.com'
    ],

    authProviders: [
      'auth0.com', 'okta.com', 'onelogin.com',
      'login.microsoftonline.com', 'accounts.google.com',
      'appleid.apple.com', 'id.apple.com',
      'cognito-idp.amazonaws.com', 'cognito-identity.amazonaws.com',
      'firebase.google.com', 'firebaseapp.com'
    ],

    paymentProviders: [
      'stripe.com', 'js.stripe.com', 'm.stripe.com',
      'paypal.com', 'www.paypal.com', 'paypalobjects.com',
      'braintreegateway.com', 'braintree-api.com',
      'checkout.shopify.com', 'square.com', 'squareup.com',
      'adyen.com', 'checkout.adyen.com'
    ],

    chatSupport: [
      'intercom.io', 'widget.intercom.io', 'intercomcdn.com',
      'zendesk.com', 'zopim.com', 'zdassets.com',
      'drift.com', 'driftt.com',
      'crisp.chat', 'tawk.to',
      'livechatinc.com', 'livechat.com',
      'freshdesk.com', 'freshchat.com',
      'hubspot.com', 'hs-scripts.com', 'hsforms.com'
    ],

    mediaNews: [
      'cnn.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com', 'theguardian.com',
      'forbes.com', 'bloomberg.com', 'reuters.com', 'wsj.com',
      'washingtonpost.com', 'huffpost.com', 'buzzfeed.com',
      'techcrunch.com', 'theverge.com', 'wired.com', 'arstechnica.com'
    ],

    developerSites: [
      'github.com', 'www.github.com', 'raw.githubusercontent.com',
      'gitlab.com', 'www.gitlab.com',
      'bitbucket.org', 'www.bitbucket.org',
      'stackoverflow.com', 'www.stackoverflow.com', 'stackexchange.com',
      'medium.com', 'www.medium.com',
      'dev.to', 'www.dev.to',
      'hashnode.com', 'hashnode.dev'
    ],

    majorPlatforms: [
      'apple.com', 'www.apple.com',
      'microsoft.com', 'www.microsoft.com',
      'amazon.com', 'www.amazon.com',
      'ebay.com', 'www.ebay.com',
      'yahoo.com', 'www.yahoo.com',
      'bing.com', 'www.bing.com',
      'baidu.com', 'www.baidu.com',
      'aliexpress.com', 'alibaba.com'
    ]
  };

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
   * Verify content script is loaded before sending messages
   */
  async verifyContentScript(tabId) {
    if (this.scriptInjectedTabs.has(tabId)) {
      return true;
    }

    // CRITICAL FIX: Validate tab before injection
    const tabValid = await this.isTabValid(tabId);
    if (!tabValid) {
      console.error(`Cannot inject content script: Tab ${tabId} is invalid`);
      return false;
    }

    // Get tab URL to check if injectable
    let tabUrl = '';
    try {
      const tab = await chrome.tabs.get(tabId);
      tabUrl = tab.url || '';

      if (!this.isInjectableUrl(tabUrl)) {
        console.warn(`⚠️ Cannot inject into non-injectable URL: ${tabUrl}`);
        return false;
      }
    } catch (e) {
      console.warn(`⚠️ Failed to get tab URL:`, e.message);
    }

    // Retry logic for script injection
    const maxRetries = 2;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ['config.js', 'security.js', 'dom-extractor.js', 'content.js']
        });

        await this.sleep(300);
        this.scriptInjectedTabs.add(tabId);
        return true;
      } catch (error) {
        lastError = error;
        console.warn(`⚠️ Script injection attempt ${attempt}/${maxRetries} failed:`, error.message);

        // Check for specific error types
        if (error.message.includes('Cannot access') ||
            error.message.includes('Extension manifest must request permission')) {
          // Permission issue - won't be fixed by retry
          console.error(`❌ Permission denied for ${tabUrl}`);
          break;
        }

        if (error.message.includes('No frame with id') ||
            error.message.includes('No tab with id')) {
          // Tab/frame no longer exists
          console.error(`❌ Tab ${tabId} no longer exists`);
          break;
        }

        if (error.message.includes('Cannot access a chrome://') ||
            error.message.includes('Cannot access contents of url')) {
          // Special URL that can't be accessed
          console.warn(`⚠️ Skipping non-accessible URL: ${tabUrl}`);
          break;
        }

        // Wait before retry
        if (attempt < maxRetries) {
          await this.sleep(500 * attempt);
        }
      }
    }

    console.error(`❌ Failed to inject content script in tab ${tabId} after ${maxRetries} attempts:`, lastError?.message);
    return false;
  }

  /**
   * Extract page data using DOM extractor
   */
  async extractPageData(tabId) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn('⚠️ extractDOM timeout, returning empty features');
        resolve([]);
      }, 10000);

      chrome.tabs.sendMessage(tabId, {
        action: 'extractDOM'
      }, (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          console.warn('⚠️ extractDOM error:', chrome.runtime.lastError.message);
          resolve([]);
        } else {
          resolve(response?.features || []);
        }
      });
    });
  }

  /**
   * Discover links on current page
   */
  async discoverLinks(tabId) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn('⚠️ discoverLinks timeout, returning empty links');
        resolve([]);
      }, 10000);

      chrome.tabs.sendMessage(tabId, {
        action: 'discoverLinks',
        baseUrl: this.startUrl
      }, (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          console.warn('⚠️ discoverLinks error:', chrome.runtime.lastError.message);
          resolve([]);
        } else {
          resolve(response?.links || []);
        }
      });
    });
  }

  /**
   * Get page metadata
   */
  async getPageMetadata(tabId) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn('⚠️ getMetadata timeout, returning empty metadata');
        resolve({ title: '', description: '', url: '', loadTime: 0 });
      }, 10000);

      chrome.tabs.sendMessage(tabId, {
        action: 'getMetadata'
      }, (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          console.warn('⚠️ getMetadata error:', chrome.runtime.lastError.message);
          resolve({ title: '', description: '', url: '', loadTime: 0 });
        } else {
          resolve(response || { title: '', description: '', url: '', loadTime: 0 });
        }
      });
    });
  }

  /**
   * Extract main text content from page
   */
  async extractTextContent(tabId) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn('⚠️ extractTextContent timeout, returning null');
        resolve(null);
      }, 10000);

      const maxLength = CONFIG.get('domExtraction.textContent.maxLength', 5000);

      console.log(`📝 Requesting text extraction (max ${maxLength} chars)...`);

      chrome.tabs.sendMessage(tabId, {
        action: 'extractTextContent',
        maxLength: maxLength
      }, (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          console.warn('⚠️ extractTextContent error:', chrome.runtime.lastError.message);
          resolve(null);
        } else {
          const textContent = response?.textContent || null;
          if (textContent) {
            console.log(`  ✓ Extracted ${textContent.length} chars`);
          } else {
            console.warn(`  ⚠️ No text content extracted`, response?.error || 'Unknown reason');
          }
          resolve(textContent);
        }
      });
    });
  }

  /**
   * NEW: Get error patterns from DOM extractor
   */
  async getErrorPatterns(tabId) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve([]);
      }, 5000);

      chrome.tabs.sendMessage(tabId, {
        action: 'getErrorPatterns'
      }, (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          resolve([]);
        } else {
          resolve(response?.errorPatterns || []);
        }
      });
    });
  }

  /**
   * NEW: Get page hints from DOM extractor
   */
  async getPageHints(tabId) {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve({});
      }, 5000);

      chrome.tabs.sendMessage(tabId, {
        action: 'getPageHints'
      }, (response) => {
        clearTimeout(timeout);
        if (chrome.runtime.lastError) {
          resolve({});
        } else {
          resolve(response?.pageHints || {});
        }
      });
    });
  }

  /**
   * Check if URL is already in queue
   */
  isInQueue(url) {
    return this.queue.some(item => item.url === url);
  }

  /**
   * Filter relevant API calls
   */
  isRelevantApi(api) {
    // Filter out common third-party APIs from config
    const ignorePatterns = CONFIG.get('network.endpoints.excludePatterns', [
      'google-analytics',
      'doubleclick',
      'facebook.com',
      'twitter.com',
      'hotjar',
      'mixpanel',
      'segment.io'
    ]);

    return !ignorePatterns.some(pattern => api.url.includes(pattern));
  }

  /**
   * Build knowledge graph from crawled pages
   * P0.1: Loads all batches from IndexedDB if streaming save was used
   */
  async buildKnowledgeGraph() {
    // P0.1: Load all page batches from IndexedDB if streaming save was enabled
    let allPages = this.pages; // Start with pages in memory

    if (this.streamingSaveEnabled && this.batchNumber > 0) {
      console.log(`📦 Loading ${this.batchNumber} saved batches from IndexedDB...`);
      const savedPages = await storageManager.loadPageBatches(this.crawlId);

      // Combine saved pages with current pages in memory
      allPages = [...savedPages, ...this.pages];

      console.log(`📊 Total pages: ${allPages.length} (${savedPages.length} from batches + ${this.pages.length} in memory)`);
    }

    const totalFeatures = allPages.reduce((sum, p) => sum + p.features.length, 0);
    const totalApis = [...new Set(allPages.flatMap(p => p.apis.map(a => a.url)))].length;
    const avgLoadTime = allPages.reduce((sum, p) => sum + (p.loadTime || 0), 0) / allPages.length;
    const duration = Date.now() - this.startTime;
    const pagesPerMinute = (allPages.length / (duration / 60000)).toFixed(1);

    // Performance metrics
    console.log('\n📊 Performance Metrics:');
    console.log(`  Pages/minute: ${pagesPerMinute}`);
    console.log(`  Avg load time: ${Math.round(avgLoadTime)}ms`);
    console.log(`  Site type: ${this.siteType || 'not detected'}`);
    console.log(`  Max tabs used: ${this.currentTabCount || this.maxConcurrentTabs}`);
    console.log(`  Duplicates skipped: ${this.pageSignatures.size - allPages.length}`);

    // Show parameterized URL pattern stats
    if (this.detectParameterizedUrls && this.parameterizedUrlTracking.size > 0) {
      console.log(`  Parameterized URL patterns detected:`);
      for (const [pattern, count] of this.parameterizedUrlTracking.entries()) {
        console.log(`    ${pattern}: crawled ${count} sample(s)`);
      }
    }

    console.log(`  Total duration: ${(duration / 1000).toFixed(1)}s`);

    // P0.1: Cleanup - delete page batches from IndexedDB after building graph
    if (this.streamingSaveEnabled && this.batchNumber > 0) {
      console.log(`🗑️ Cleaning up ${this.batchNumber} page batches...`);
      await storageManager.clearPageBatches(this.crawlId);
    }

    return {
      appUrl: this.startUrl,
      crawledAt: Date.now(),
      duration: duration,
      totalPages: allPages.length,
      totalErrors: this.errors.length,
      pages: allPages,
      errors: this.errors,
      stats: {
        totalFeatures,
        totalApis,
        avgLoadTime: Math.round(avgLoadTime),
        maxDepthReached: Math.max(...allPages.map(p => p.depth)),
        featureTypes: this.getFeatureTypeCounts(allPages),
        apiMethods: this.getApiMethodCounts(allPages)
      },
      performance: {
        pagesPerMinute: parseFloat(pagesPerMinute),
        siteType: this.siteType,
        maxTabsUsed: this.currentTabCount || this.maxConcurrentTabs,
        duplicatesSkipped: this.pageSignatures.size - allPages.length,
        adaptiveScalingEnabled: this.adaptiveScaling
      }
    };
  }

  /**
   * Get feature type counts
   * P0.1: Updated to accept pages parameter for batch loading support
   */
  getFeatureTypeCounts(pages = this.pages) {
    const counts = {};
    for (const page of pages) {
      for (const feature of page.features) {
        counts[feature.type] = (counts[feature.type] || 0) + 1;
      }
    }
    return counts;
  }

  /**
   * Get API method counts
   * P0.1: Updated to accept pages parameter for batch loading support
   */
  getApiMethodCounts(pages = this.pages) {
    const counts = {};
    for (const page of pages) {
      for (const api of page.apis) {
        counts[api.method] = (counts[api.method] || 0) + 1;
      }
    }
    return counts;
  }

  /**
   * Send progress update to UI
   */
  sendProgress(progress) {
    // Send progress update, ignore if no receiver (popup may be closed)
    chrome.runtime.sendMessage({
      action: 'crawlProgress',
      progress
    }).catch(error => {
      // Silently ignore "Receiving end does not exist" errors
      if (!error.message.includes('Receiving end does not exist')) {
        console.error('Error sending progress update:', error);
      }
    });
  }

  /**
   * Send individual page data for incremental processing
   * This allows background worker to save data as we crawl
   */
  sendPageData(pageData) {
    // Send to background worker for incremental processing
    chrome.runtime.sendMessage({
      action: 'processPageIncremental',
      pageData: pageData,
      crawlId: this.startUrl, // Use startUrl as crawl identifier
      crawlStartTime: this.startTime
    }).catch(error => {
      // Silently ignore "Receiving end does not exist" errors
      if (!error.message.includes('Receiving end does not exist')) {
        console.error('Error sending page data:', error);
      }
    });
  }

  /**
   * P0.1: Check if batch save is needed and save if threshold reached
   * Prevents memory exhaustion on large crawls (10,000+ pages)
   */
  async checkAndSaveBatch() {
    if (!this.streamingSaveEnabled) return;

    // Check if we've reached batch size
    if (this.pages.length >= this.batchSize) {
      console.log(`💾 Batch size reached (${this.pages.length} pages), saving to IndexedDB...`);

      // Check storage quota before saving (P1.6)
      const quotaInfo = await storageManager.checkStorageQuota();
      if (!quotaInfo.available) {
        console.error(`❌ Storage quota exceeded (${quotaInfo.percentUsed}% used)`);
        throw new Error(`Storage quota exceeded: ${quotaInfo.usageGB}GB / ${quotaInfo.quotaGB}GB used`);
      }

      if (quotaInfo.warning) {
        console.warn(`⚠️ Storage quota warning: ${quotaInfo.percentUsed}% used (${quotaInfo.usageGB}GB / ${quotaInfo.quotaGB}GB)`);
      }

      // Save current batch to IndexedDB
      await storageManager.savePageBatch(this.crawlId, this.batchNumber, this.pages);

      // Clear pages from memory
      this.pages = [];
      this.batchNumber++;

      console.log(`✅ Batch ${this.batchNumber} saved and memory cleared`);
    }
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
   * P2.8: Wait for SPA framework hydration
   * Detects React, Vue, Angular and waits for hydration to complete
   */
  async waitForSPAHydration(tabId) {
    if (!CONFIG.get('crawler.spaDetection.enabled', true)) {
      return false;
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve(false); // Timeout, continue anyway
      }, 5000); // Max 5s wait for hydration

      chrome.tabs.sendMessage(tabId, {
        action: 'detectSPAFramework'
      }, (response) => {
        clearTimeout(timeout);

        if (chrome.runtime.lastError) {
          // Content script wasn't reachable yet (common right after navigation on
          // an SPA that hasn't booted). Bailing with zero wait means we extract an
          // empty shell — give the page a brief settle window first.
          const fallbackWait = CONFIG.get('crawler.spaDetection.fallbackWait', 1500);
          setTimeout(() => resolve(false), fallbackWait);
          return;
        }

        if (response && response.framework) {
          console.log(`✨ Detected ${response.framework} framework, waiting for hydration...`);

          // Additional wait for hydration
          setTimeout(() => {
            resolve(true);
          }, CONFIG.get('crawler.spaDetection.hydrationWait', 2000)); // Extra 2s for hydration
        } else {
          resolve(false);
        }
      });
    });
  }

  /**
   * Pause crawling
   */
  pause() {
    this.isPaused = true;
    console.log('⏸️ Crawler paused');
  }

  /**
   * Resume crawling
   */
  resume() {
    this.isPaused = false;
    console.log('▶️ Crawler resumed');
  }

  /**
   * Stop crawling
   */
  async stop() {
    this.isStopped = true;
    this.networkMonitor.stop();
    await this.resourceBlocker.stop();
    await this.closeAllParallelTabs();
    console.log('⏹️ Crawler stopped');
  }

  /**
   * Parse sitemap to discover URLs instantly
   */
  async parseSitemap() {
    try {
      const urls = await this.sitemapParser.parse();

      if (urls.length > 0) {
        console.log(`🗺️ Sitemap parsed: Found ${urls.length} URLs`);

        // Add all URLs to queue with depth 1 (after start URL)
        for (const url of urls) {
          const normalizedUrl = this.normalizeUrl(url);
          if (normalizedUrl !== this.startUrl && !this.isInQueue(normalizedUrl) && this.shouldQueueUrl(normalizedUrl)) {
            this.queue.push({ url: normalizedUrl, depth: 1 });
          }
        }

        console.log(`  ✅ Added ${urls.length} URLs to queue from sitemap`);
      }
    } catch (error) {
      console.log('ℹ️ Sitemap parsing failed, using traditional crawling');
    }
  }

  /**
   * Check if page has interactive elements (forms, APIs, buttons, tables)
   */
  isPageInteractive(features, apis) {
    // If page has APIs, it's definitely interactive
    if (apis && apis.length > 0) {
      return true;
    }

    // Check for interactive feature types
    const requiredTypes = CONFIG.get('crawler.selective.requiredFeatures', [
      'form', 'button', 'table', 'navigation'
    ]);

    const interactiveFeatures = features.filter(f =>
      requiredTypes.includes(f.type)
    );

    return interactiveFeatures.length >= this.minFeaturesRequired;
  }

  /**
   * Close all EXTRA tabs created during parallel crawling
   * Note: Does NOT close the original tab where user started the crawl
   */
  async closeAllParallelTabs() {
    if (this.activeTabs.size === 0) {
      console.log('ℹ️ No extra tabs to close');
      return;
    }

    console.log(`🗑️ Closing ${this.activeTabs.size} extra crawling tabs...`);

    for (const tabId of this.activeTabs) {
      try {
        // Get tab info to show what we're closing
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab) {
          console.log(`  Closing tab: ${tab.url || 'about:blank'}`);
        }
        await chrome.tabs.remove(tabId);
      } catch (error) {
        // Tab might already be closed, that's ok
        console.log(`  Tab ${tabId} already closed`);
      }
    }

    this.activeTabs.clear();
    console.log('✅ All extra crawling tabs closed (original tab preserved)');
  }

  /**
   * Create a new tab for parallel crawling
   */
  async createParallelTab() {
    const tab = await chrome.tabs.create({
      url: 'about:blank',
      active: false // Don't switch to it
    });

    this.activeTabs.add(tab.id);
    return tab.id;
  }

  /**
   * WEEK 1: Track page load time for adaptive scaling
   */
  trackPageLoadTime(loadTime) {
    this.pageLoadTimes.push(loadTime);

    // Keep only last 20 load times for rolling average
    if (this.pageLoadTimes.length > 20) {
      this.pageLoadTimes.shift();
    }

    // Calculate rolling average
    this.avgLoadTime = this.pageLoadTimes.reduce((a, b) => a + b, 0) / this.pageLoadTimes.length;

    // A successful page resets the consecutive-error backoff counter.
    this.consecutiveErrors = 0;
  }

  /**
   * Nearest-rank percentile of a numeric array (e.g. p=0.9 → P90).
   * Returns 0 for an empty array. Pure helper used by adaptive scaling.
   */
  percentile(values, p) {
    if (!values || values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
    return sorted[idx];
  }

  /**
   * WEEK 1: Check if we should scale tabs up or down
   */
  async checkAdaptiveScaling(tabIds) {
    if (!this.adaptiveScaling) return tabIds;

    // ── Error backoff (bypasses the cooldown) ────────────────────────────────
    // A burst of consecutive failures means the target is struggling under our
    // load. Shed tabs immediately rather than waiting out the 30s scale window.
    if (this.consecutiveErrors >= this.errorBackoffThreshold && tabIds.length > this.minTabs) {
      const newTabCount = Math.max(this.minTabs, Math.floor(tabIds.length / 2));
      const tabsToRemove = tabIds.length - newTabCount;
      console.warn(`🛑 Error backoff: ${this.consecutiveErrors} consecutive errors — shedding ${tabsToRemove} tab(s) to ${newTabCount}`);
      for (let i = 0; i < tabsToRemove; i++) {
        const tabToRemove = tabIds.pop();
        if (tabToRemove && this.activeTabs.has(tabToRemove)) {
          try {
            await chrome.tabs.remove(tabToRemove);
            this.activeTabs.delete(tabToRemove);
          } catch (error) {
            // Tab might already be closed
          }
        }
      }
      this.currentTabCount = newTabCount;
      this.consecutiveErrors = 0; // Reset after acting so we don't thrash
      this.lastScaleCheck = Date.now();
      return tabIds;
    }

    // Only check every N pages
    if (this.pageLoadTimes.length < this.scaleCheckInterval) return tabIds;
    if (Date.now() - this.lastScaleCheck < 30000) return tabIds; // Min 30s between checks

    // Scale on P90 (robust to a few slow outliers) when enabled, else the mean.
    const decisionMs = this.usePercentileScaling
      ? this.percentile(this.pageLoadTimes, 0.9)
      : this.avgLoadTime;
    const avgLoadTime = decisionMs / 1000; // Convert to seconds
    const currentTabs = tabIds.length;

    const metricLabel = this.usePercentileScaling ? 'P90' : 'avg';
    console.log(`📊 Adaptive Scaling Check: ${currentTabs} tabs, ${avgLoadTime.toFixed(2)}s ${metricLabel} load time`);

    // Scale UP if pages load quickly
    if (avgLoadTime < this.scaleUpThreshold && currentTabs < this.maxTabs) {
      const newTabCount = Math.min(currentTabs + 2, this.maxTabs);
      const tabsToAdd = newTabCount - currentTabs;

      console.log(`⬆️ Scaling UP: Adding ${tabsToAdd} tabs (fast site detected)`);

      for (let i = 0; i < tabsToAdd; i++) {
        const newTabId = await this.createParallelTab();
        tabIds.push(newTabId);
      }

      this.currentTabCount = newTabCount;
      this.lastScaleCheck = Date.now();
    }
    // Scale DOWN if pages load slowly
    else if (avgLoadTime > this.scaleDownThreshold && currentTabs > this.minTabs) {
      const newTabCount = Math.max(currentTabs - 1, this.minTabs);
      const tabsToRemove = currentTabs - newTabCount;

      console.log(`⬇️ Scaling DOWN: Removing ${tabsToRemove} tab (slow site detected)`);

      for (let i = 0; i < tabsToRemove; i++) {
        const tabToRemove = tabIds.pop();
        if (tabToRemove && this.activeTabs.has(tabToRemove)) {
          try {
            await chrome.tabs.remove(tabToRemove);
            this.activeTabs.delete(tabToRemove);
          } catch (error) {
            // Tab might already be closed
          }
        }
      }

      this.currentTabCount = newTabCount;
      this.lastScaleCheck = Date.now();
    }

    return tabIds;
  }

  /**
   * WEEK 2: Detect site type based on first N pages
   */
  detectSiteType() {
    if (!this.siteDetectionEnabled) return 'dynamic'; // Default

    // Wait for enough samples
    if (this.pages.length < this.siteDetectionSampleSize) return this.siteType || 'dynamic';

    // Already detected
    if (this.siteType) return this.siteType;

    // Analyze first N pages
    const samplePages = this.pages.slice(0, this.siteDetectionSampleSize);
    const avgLoadTime = samplePages.reduce((sum, p) => sum + (p.loadTime || 0), 0) / samplePages.length;

    // Count pages with dynamic content (SPAs, heavy JS)
    const dynamicPages = samplePages.filter(p =>
      (p.spaDiscoveries && p.spaDiscoveries.length > 0) ||
      (p.apis && p.apis.length > 0) ||
      (p.features && p.features.some(f => f.type === 'modal' || f.type === 'form'))
    ).length;

    const dynamicRatio = dynamicPages / samplePages.length;

    // Classify site
    if (avgLoadTime < 1500 && dynamicRatio < 0.3) {
      this.siteType = 'static';
      console.log('🌐 Site Type: STATIC (documentation/help site) - Using aggressive crawling');
    } else if (avgLoadTime > 4000 || dynamicRatio > 0.7) {
      this.siteType = 'heavy';
      console.log('🌐 Site Type: HEAVY (e-commerce/complex SPA) - Using careful crawling');
    } else {
      this.siteType = 'dynamic';
      console.log('🌐 Site Type: DYNAMIC (standard web app) - Using balanced crawling');
    }

    return this.siteType;
  }

  /**
   * WEEK 2: Get optimal wait time based on detected site type
   */
  getAdaptiveWaitTime() {
    const siteType = this.detectSiteType();
    const siteConfig = CONFIG.get(`crawler.siteDetection.types.${siteType}`, {});
    return siteConfig.pageLoadDelay || CONFIG.get('crawler.delays.pageLoad', 1000);
  }

  /**
   * WEEK 2: Check if smart wait should be used for this site type
   */
  shouldUseSmartWait() {
    const siteType = this.detectSiteType();
    const siteConfig = CONFIG.get(`crawler.siteDetection.types.${siteType}`, {});
    return siteConfig.smartWaitEnabled !== false;
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

  /**
   * WEEK 3: Check if page is a duplicate
   */
  isDuplicatePage(pageData) {
    if (!this.duplicateDetectionEnabled) return false;

    // Check pagination patterns first
    if (CONFIG.get('crawler.duplicateDetection.skipPagination', true)) {
      const patterns = CONFIG.get('crawler.duplicateDetection.paginationPatterns', []);
      if (patterns.some(pattern => pageData.url.includes(pattern))) {
        console.log(`⏩ Skipping pagination URL: ${pageData.url}`);
        return true;
      }
    }

    // HYBRID DYNAMIC DETECTION: Check if URL matches a parameterized pattern
    // Uses regex + template learning to automatically detect patterns
    if (this.detectParameterizedUrls) {
      const detectedPattern = this.getParameterizedPattern(pageData.url);

      if (detectedPattern) {
        // Get or initialize count for this pattern
        const currentCount = this.parameterizedUrlTracking.get(detectedPattern) || 0;

        if (currentCount >= this.maxSamplesPerPattern) {
          // Already crawled enough samples of this pattern - skip as duplicate
          console.log(`⏩ Skipping parameterized URL (already crawled ${currentCount} samples of ${detectedPattern}): ${pageData.url}`);
          return true;
        } else {
          // This is one of the first samples - crawl it and increment counter
          this.parameterizedUrlTracking.set(detectedPattern, currentCount + 1);
          console.log(`✅ Crawling parameterized URL sample ${currentCount + 1}/${this.maxSamplesPerPattern} for pattern ${detectedPattern}: ${pageData.url}`);

          // Still store signature for comparison with non-parameterized pages
          const signature = this.createPageSignature(pageData);
          this.pageSignatures.set(pageData.url, signature);
          return false;
        }
      }
    }

    // Create page signature for regular duplicate detection
    const signature = this.createPageSignature(pageData);

    // Check against existing signatures
    for (const [url, existingSig] of this.pageSignatures.entries()) {
      const similarity = this.calculateSimilarity(signature, existingSig);
      if (similarity >= this.similarityThreshold) {
        // Additional check: if text length is exactly the same (like 1102), it might be SPA with unloaded content
        if (signature.textLength === existingSig.textLength && signature.textLength > 1000) {
          console.warn(`⚠️ Warning: Pages have identical text length (${signature.textLength} chars) - might be SPA content not updating`);
        }

        console.log(`⏩ Skipping duplicate page: ${pageData.url} (${(similarity * 100).toFixed(1)}% similar to ${url})`);
        console.log(`  📊 Comparison: Title match: ${signature.title === existingSig.title}, Features: ${signature.featureCount} vs ${existingSig.featureCount}, Text length: ${signature.textLength} chars`);
        return true;
      }
    }

    // Store signature
    this.pageSignatures.set(pageData.url, signature);
    return false;
  }

  /**
   * WEEK 3: Create page signature for duplicate detection
   */
  createPageSignature(pageData) {
    const fullText = pageData.textContent || '';

    // Use larger text sample (1000 chars instead of 200) to get past shared header/nav content
    // Also use middle portion of text for better uniqueness
    let textSample = '';
    if (fullText.length > 500) {
      // Take from middle portion (skip first 200 chars to avoid shared header/nav)
      textSample = fullText.substring(200, 1200);
    } else {
      // For shorter content, use it all
      textSample = fullText;
    }

    // Structural fingerprint: summarize DOM structure from extracted features
    // This catches pages with identical layouts but different text content
    const structuralFingerprint = this.buildStructuralFingerprint(pageData);

    return {
      title: pageData.title || '',
      featureCount: pageData.features?.length || 0,
      featureTypes: (pageData.features || []).map(f => f.type).sort().join(','),
      apiCount: pageData.apis?.length || 0,
      textLength: fullText.length,
      textSample: textSample,
      structuralFingerprint: structuralFingerprint
    };
  }

  /**
   * Build a structural fingerprint from page features.
   * Captures the "shape" of the page: what types of UI elements exist and how many.
   * Two pages with identical fingerprints have the same DOM structure.
   */
  buildStructuralFingerprint(pageData) {
    const parts = [];
    const features = pageData.features || [];

    // Count feature types
    const typeCounts = {};
    features.forEach(f => {
      const type = f.type || 'unknown';
      typeCounts[type] = (typeCounts[type] || 0) + 1;
    });

    // Sort for consistent fingerprinting
    Object.keys(typeCounts).sort().forEach(type => {
      parts.push(`${type}:${typeCounts[type]}`);
    });

    // Include form field structure (field names + types)
    const forms = features.filter(f => f.type === 'form');
    forms.forEach((form, i) => {
      if (form.fields) {
        const fieldSig = form.fields.map(f => `${f.type || 'text'}`).sort().join(',');
        parts.push(`form${i}[${fieldSig}]`);
      }
    });

    // Include button count and intents
    const buttons = features.filter(f => f.type === 'button');
    if (buttons.length > 0) {
      const intents = buttons.map(b => b.intent || 'unknown').sort().join(',');
      parts.push(`btns[${intents}]`);
    }

    return parts.join('|');
  }

  /**
   * WEEK 3: Calculate similarity between two page signatures
   */
  calculateSimilarity(sig1, sig2) {
    let matches = 0;
    let total = 0;

    // Title similarity (15% weight)
    if (CONFIG.get('crawler.duplicateDetection.compareTitle', true)) {
      total += 15;
      if (sig1.title === sig2.title && sig1.title.length > 0) matches += 15;
    }

    // Structural fingerprint similarity (20% weight) — catches pages with identical layouts
    if (sig1.structuralFingerprint && sig2.structuralFingerprint) {
      total += 20;
      if (sig1.structuralFingerprint === sig2.structuralFingerprint) {
        matches += 20; // Identical DOM structure
      }
    }

    // Feature similarity (20% weight)
    if (CONFIG.get('crawler.duplicateDetection.compareFeatures', true)) {
      total += 20;
      if (sig1.featureTypes === sig2.featureTypes && sig1.featureTypes.length > 0) {
        matches += 20;
      } else if (sig1.featureCount === sig2.featureCount) {
        matches += 10;
      }
    }

    // Text content similarity (45% weight) - CRITICAL for pages with same structure but different content
    if (CONFIG.get('crawler.duplicateDetection.compareText', true)) {
      total += 45;

      // If both pages have meaningful text content (>100 chars)
      if (sig1.textLength > 100 && sig2.textLength > 100) {
        // Compare text samples
        if (sig1.textSample === sig2.textSample) {
          matches += 45; // Identical text samples = very likely duplicate
        } else {
          // Text samples differ - calculate character-level similarity
          const sampleSimilarity = this.calculateTextSimilarity(sig1.textSample, sig2.textSample);
          matches += sampleSimilarity * 45;
        }
      } else if (sig1.textLength === 0 && sig2.textLength === 0) {
        // Both have no text - structure comparison is sufficient
        matches += 22;
      } else {
        // One has text, one doesn't - definitely different
        matches += 0;
      }
    }

    return total > 0 ? matches / total : 0;
  }

  /**
   * Calculate character-level text similarity
   * Returns a value between 0 (completely different) and 1 (identical)
   */
  calculateTextSimilarity(text1, text2) {
    if (text1 === text2) return 1;
    if (!text1 || !text2) return 0;

    // Simple character overlap calculation
    const set1 = new Set(text1.toLowerCase().split(' '));
    const set2 = new Set(text2.toLowerCase().split(' '));
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);

    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * MEMORY OPTIMIZATION: Periodic memory cleanup
   * Clears old entries from Maps to prevent unbounded growth
   */
  performMemoryCleanup() {
    const visited = this.visited.size;

    // Only cleanup every N pages
    if (visited - this.lastMemoryCleanup < this.memoryCleanupInterval) {
      return;
    }

    console.log(`🧹 Performing memory cleanup at ${visited} pages...`);
    const startSize = this.pageSignatures.size + this.parameterizedUrlTracking.size + this.urlTemplates.size;

    // Clear old page signatures if too many (keep last 500)
    if (this.pageSignatures.size > 500) {
      const entries = Array.from(this.pageSignatures.entries());
      const toKeep = entries.slice(-500);
      this.pageSignatures.clear();
      toKeep.forEach(([url, sig]) => this.pageSignatures.set(url, sig));
      console.log(`  🗑️ Cleared ${entries.length - 500} old page signatures`);
    }

    // Clear urlTemplates if too large (keep last 100)
    if (this.urlTemplates.size > 100) {
      const entries = Array.from(this.urlTemplates.entries());
      const toKeep = entries.slice(-100);
      this.urlTemplates.clear();
      toKeep.forEach(([template, urls]) => this.urlTemplates.set(template, urls));
      console.log(`  🗑️ Cleared ${entries.length - 100} old URL templates`);
    }

    // Clean up script injection tracking for closed tabs
    this.cleanupClosedTabsFromTracking();

    const endSize = this.pageSignatures.size + this.parameterizedUrlTracking.size + this.urlTemplates.size;
    console.log(`  ✅ Memory cleanup complete: ${startSize} -> ${endSize} Map entries`);

    this.lastMemoryCleanup = visited;
  }

  /**
   * MEMORY OPTIMIZATION: Clean cache periodically
   * Removes old cache entries when cache grows too large
   */
  performCacheCleanup() {
    const visited = this.visited.size;

    // Only cleanup every N pages
    if (visited - this.lastCacheCleanup < this.cacheCleanupInterval) {
      return;
    }

    const maxCacheSize = CONFIG.get('crawler.caching.maxCacheSize', 200);

    // Clear feature cache if exceeding limit
    if (this.featureCache.size > maxCacheSize) {
      const excess = this.featureCache.size - maxCacheSize;
      const entries = Array.from(this.featureCache.keys());
      // Remove oldest entries (FIFO)
      entries.slice(0, excess).forEach(key => this.featureCache.delete(key));
      console.log(`🧹 Cleared ${excess} old feature cache entries`);
    }

    // Clear API cache if exceeding limit
    if (this.apiCache.size > maxCacheSize) {
      const excess = this.apiCache.size - maxCacheSize;
      const entries = Array.from(this.apiCache.keys());
      entries.slice(0, excess).forEach(key => this.apiCache.delete(key));
      console.log(`🧹 Cleared ${excess} old API cache entries`);
    }

    this.lastCacheCleanup = visited;
  }

  /**
   * MEMORY OPTIMIZATION: Clean up closed tabs from tracking
   */
  async cleanupClosedTabsFromTracking() {
    const closedTabs = [];

    for (const tabId of this.scriptInjectedTabs) {
      try {
        await chrome.tabs.get(tabId);
        // Tab exists, keep it
      } catch (error) {
        // Tab doesn't exist anymore
        closedTabs.push(tabId);
      }
    }

    closedTabs.forEach(tabId => this.scriptInjectedTabs.delete(tabId));

    if (closedTabs.length > 0) {
      console.log(`  🗑️ Removed ${closedTabs.length} closed tabs from tracking`);
    }
  }

  /**
   * MEMORY OPTIMIZATION: Check memory usage and warn if high
   * Returns true if memory is critically low
   */
  async checkMemoryPressure() {
    // Use performance.memory if available (Chrome only)
    if (performance.memory) {
      const usedMB = performance.memory.usedJSHeapSize / (1024 * 1024);
      const limitMB = performance.memory.jsHeapSizeLimit / (1024 * 1024);
      const percentUsed = (usedMB / limitMB) * 100;

      if (percentUsed > 90) {
        console.error(`❌ CRITICAL: Memory usage at ${percentUsed.toFixed(1)}% (${usedMB.toFixed(0)}MB / ${limitMB.toFixed(0)}MB)`);
        return true;
      } else if (percentUsed > 75) {
        console.warn(`⚠️ WARNING: Memory usage at ${percentUsed.toFixed(1)}% (${usedMB.toFixed(0)}MB / ${limitMB.toFixed(0)}MB)`);
      } else if (this.visited.size % 100 === 0) {
        console.log(`💾 Memory usage: ${percentUsed.toFixed(1)}% (${usedMB.toFixed(0)}MB / ${limitMB.toFixed(0)}MB)`);
      }
    }

    return false;
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export for use in background script
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WebAppCrawler;
}
