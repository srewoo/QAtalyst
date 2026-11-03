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
    // URLs that failed for good. Not "visited" (they produced no page), but they
    // must not be re-queued every time another page links to them.
    this.failedUrls = new Set();
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
    // F19/F26: the constructor cannot await. Keep the promise so crawl() can wait
    // for it — previously this raced the crawl, so the "previously crawled" set
    // was often still empty when the first pages were queued and incremental mode
    // silently degraded to a full re-crawl.
    this.previousCrawlReady = this.loadPreviousCrawl(config.startUrl)
      .catch(() => { /* no previous crawl is a normal, non-fatal state */ });

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

      // F19: the handler returns the graph under `result`, not at the top level,
      // so this condition was never true — the whole incremental-crawl path was
      // dead and every crawl re-crawled everything from scratch. Accept both
      // shapes so older/newer handler builds both work.
      const graph = (response && response.success)
        ? ((response.result && response.result.knowledgeGraph) || response.knowledgeGraph)
        : null;

      if (graph && graph.pages) {
        // Pages may be an array (raw crawl) or a URL-keyed map (F02).
        const pages = graph.pages;
        const urls = Array.isArray(pages)
          ? pages.map(p => p && p.url).filter(Boolean)
          : Object.keys(pages);
        const pageCount = urls.length;

        if (pageCount > 0) {
          console.log(`📚 Found previous crawl with ${pageCount} pages`);

          // Retain the previous PAGE RECORDS, not just their URLs.
          // Incremental mode skipped a known URL and then built the new graph from
          // freshly-crawled pages only — so every skipped page vanished from the
          // result. Turning on incremental crawling destroyed the evidence it was
          // supposed to preserve. Carry them forward instead.
          this.previousPages = new Map();
          const pageList = Array.isArray(pages) ? pages : Object.values(pages);
          for (const page of pageList) {
            if (page && page.url) this.previousPages.set(page.url, page);
          }
          for (const url of urls) {
            this.previouslyCrawled.add(url);
          }
          // F19: "we have seen this URL before" is NOT "its content is unchanged".
          // Record when the evidence was observed so a caller can decide whether
          // skipping it is still safe.
          this.previousCrawlObservedAt = (response.result && response.result.crawledAt) || graph.crawledAt || null;

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
    // F19/F26: don't start until the previous-crawl load has settled.
    if (this.previousCrawlReady) {
      try { await this.previousCrawlReady; } catch (_) {}
    }

    // F18: install the API interceptor BEFORE the first navigation, so bootstrap
    // requests are captured rather than missed.
    await this.registerEarlyInterceptor(this.startUrl);

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

      // F18: remove the document_start registration, so the interceptor does not
      // keep instrumenting the user's browsing after the crawl.
      await this.unregisterEarlyInterceptor();

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

      // Incremental crawl: re-crawl only what is NEW or CHANGED.
      const incrementalMode = CONFIG.get('crawler.incremental.enabled', true);
      if (incrementalMode && this.previouslyCrawled.has(url)) {
        const decision = await this.shouldRecrawl(url);
        if (!decision.recrawl) {
          console.log(`⏩ Unchanged, reusing previous crawl: ${url} (${decision.reason})`);
          this.carryForwardPage(url);
          this.visited.add(url);
          continue;
        }
        console.log(`🔄 Changed since last crawl, re-crawling: ${url} (${decision.reason})`);
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

        // Incremental crawl: re-crawl only what is NEW or CHANGED (parallel path).
        const incrementalMode = CONFIG.get('crawler.incremental.enabled', true);
        if (incrementalMode && this.previouslyCrawled.has(url)) {
          const decision = await this.shouldRecrawl(url);
          if (!decision.recrawl) {
            console.log(`⏩ Unchanged, reusing previous crawl: ${url} (${decision.reason})`);
            this.carryForwardPage(url);
            this.visited.add(url);
            return Promise.resolve();
          }
          console.log(`🔄 Changed since last crawl, re-crawling: ${url} (${decision.reason})`);
        }

        // CRITICAL FIX: Validate tab before crawling, recreate if invalid
        const tabValid = await this.isTabValid(tabId);
        if (!tabValid) {
          console.warn(`⚠️ Tab ${tabId} invalid, recreating for: ${url}`);
          try {
            // Remove old tab ID from tracking
            this.activeTabs.delete(tabId);
            this.networkMonitor?.removeTab?.(tabId);
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
    // Rejections are not always Error objects; a TypeError here would reject the
    // parallel batch's Promise.all and abort the whole crawl.
    const message = String((error && error.message) || error || 'Unknown error');
    // config.json crawler.retry.{enabled, retryableErrors} used to be ignored here.
    const retryEnabled = CONFIG.get('crawler.retry.enabled', true);
    const retryableErrors = CONFIG.get('crawler.retry.retryableErrors', null) || WebAppCrawler.RETRYABLE_ERRORS;
    const isRetryable = retryEnabled && retryableErrors.some(pattern =>
      message.toLowerCase().includes(String(pattern).toLowerCase())
    );

    if (isRetryable && !this.retryCount[url]) {
      this.retryCount[url] = 0;
    }

    const maxRetries = CONFIG.get('crawler.retry.maxRetries', 3);
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

      this.failedUrls.add(url);
      this.errors.push({
        url,
        error: message,
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

    // F18: open this page's capture window BEFORE navigating, so requests fired
    // during navigation belong to the page that caused them.
    if (this.networkMonitor && typeof this.networkMonitor.beginPage === 'function') {
      this.networkMonitor.beginPage(url, tabId);
    }

    // Navigate to page
    await this.navigate(url, tabId);

    // Wait for page load
    const loadedTab = await this.waitForPageLoad(tabId);

    // Install the MAIN-world fetch/XHR interceptor ASAP so it captures API
    // response bodies fired during the smart-wait / hydration windows below.
    await this.injectNetworkInterceptor(tabId);

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
    if (!scriptInjected && this.isInjectableUrl(actualUrl)) {
      // Usually the page was still settling. Throw so handleCrawlError retries it
      // (up to crawler.retry.maxRetries) instead of silently dropping the page.
      throw new Error(`Script injection failed for ${actualUrl}`);
    }
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

    // Item 3: scroll to trigger lazy-loaded / infinite-scroll content before we
    // snapshot the DOM, so deferred sections are captured rather than missed.
    await this.triggerLazyContent(tabId);

    // Extract data from DOM
    let features = await this.extractPageData(tabId);

    // Drain response bodies captured by the in-page interceptor and merge them
    // into the network monitor before reading the API list (item 5: response bodies).
    await this.drainApiCaptures(tabId);

    // F18: only the API calls captured for THIS page. getApiCalls() returns the
    // whole crawl's cumulative list, so every page after the first was credited
    // with every earlier page's endpoints.
    const apis = typeof this.networkMonitor.takeApiCallsForPage === 'function'
      ? this.networkMonitor.takeApiCallsForPage(tabId)
      : this.networkMonitor.getApiCalls();

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

            // Item 1 + 2: merge interactive features revealed by clicks/hover
            // (forms, inputs, buttons that only appear after interaction) into
            // this page's feature list, de-duplicated against what we already have.
            const revealed = clickDiscoveries.flatMap(d => (d && d.newFeatures) || []);
            if (revealed.length > 0) {
              const before = features.length;
              features = this.mergeDiscoveredFeatures(features, revealed);
              console.log(`✨ Merged ${features.length - before} interaction-revealed feature(s)`);
            }
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
      _pagination: apiSummary.pagination && apiSummary.pagination.length > 0 ? apiSummary.pagination : undefined,
      // Freshness fingerprint, so the NEXT crawl can tell whether this page
      // changed instead of re-crawling it blindly or skipping it blindly.
      _contentHash: WebAppCrawler.hashContent(
        [metadata.title, textContent, JSON.stringify(features || [])].join('\n'))
    };

    // Server-supplied validators are far cheaper to check than a re-render, so
    // capture them when the origin provides them.
    try {
      const head = await fetch(actualUrl, { method: 'HEAD', credentials: 'include' });
      const etag = head.headers.get('etag');
      const lastModified = head.headers.get('last-modified');
      if (etag || lastModified) pageData._validators = { etag, lastModified };
    } catch (_) {
      // Not all origins answer HEAD; the content hash covers those.
    }

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
  // Fallback when config.json has no crawler.retry.retryableErrors.
  static RETRYABLE_ERRORS = ['timeout', 'net::', 'ERR_', 'Failed to fetch', 'Script injection failed'];

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

  /** Stable, cheap content fingerprint (FNV-1a). Not cryptographic — a change detector. */
  static hashContent(text) {
    const s = String(text || '');
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  /** F26: read back a resumable crawl, or null when there is nothing to resume. */
  static async loadResumeState(crawlId) {
    try {
      const key = `crawl_resume_${crawlId}`;
      const all = await chrome.storage.local.get(key);
      return (all && all[key]) || null;
    } catch (_) { return null; }
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
    // F18: a document_start registration outlives the crawl if we do not remove
    // it, and would keep instrumenting the user's own browsing afterwards.
    await this.unregisterEarlyInterceptor();
    await this.resourceBlocker.stop();
    await this.closeAllParallelTabs();
    console.log('⏹️ Crawler stopped');
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
  // The rest of the methods live in these files (the worker importScripts them).
  require('./crawler-page.js');
  require('./crawler-urls.js');
  require('./crawler-graph.js');
  require('./crawler-tuning.js');
}
