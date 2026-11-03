/**
 * crawler-tuning.js — Adaptive behaviour: parallel tab pool and scaling, site-type waits, duplicate-page detection, memory and cache cleanup.
 *
 * Methods of WebAppCrawler, moved verbatim out of crawler.js and installed on its
 * prototype below. Load after crawler.js (importScripts order in background.js;
 * crawler.js requires this file itself under Node).
 */
(function (WebAppCrawler) {

class CrawlerTuningMethods {
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
    // Without this the network monitor never sees this tab's API calls.
    this.networkMonitor?.addTab?.(tab.id);
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
            this.networkMonitor?.removeTab?.(tabToRemove);
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
            this.networkMonitor?.removeTab?.(tabToRemove);
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
}

for (const name of Object.getOwnPropertyNames(CrawlerTuningMethods.prototype)) {
  if (name !== 'constructor') Object.defineProperty(WebAppCrawler.prototype, name, Object.getOwnPropertyDescriptor(CrawlerTuningMethods.prototype, name));
}
// The class is passed in so moved bodies that say `WebAppCrawler.X` resolve in Node too.
})(typeof WebAppCrawler !== 'undefined' ? WebAppCrawler : require('./crawler.js'));
