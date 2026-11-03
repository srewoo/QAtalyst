/**
 * crawler-graph.js — Results: knowledge-graph build, incremental re-crawl decisions, resume state, batched saving and progress messages.
 *
 * Methods of WebAppCrawler, moved verbatim out of crawler.js and installed on its
 * prototype below. Load after crawler.js (importScripts order in background.js;
 * crawler.js requires this file itself under Node).
 */
(function (WebAppCrawler) {

class CrawlerGraphMethods {
  /**
   * Build knowledge graph from crawled pages
   * P0.1: Loads all batches from IndexedDB if streaming save was used
   */
  /**
   * F26: drop the streamed page batches. Call ONLY after the assembled knowledge
   * graph has been committed — until then the batches are the crawl's only
   * durable record.
   */
  /**
   * Has this page CHANGED since the last crawl?
   *
   * Incremental mode previously skipped any URL it had seen before, so a page
   * whose content had been rewritten was never re-crawled and the graph kept
   * describing an app that no longer existed. A URL is an identifier, not a
   * version.
   *
   * The check is deliberately cheap — a conditional HTTP request, no tab, no
   * render — so skipping stays much faster than crawling. It errs toward
   * RE-CRAWLING: when we cannot prove a page is unchanged we crawl it, because a
   * redundant crawl costs seconds and stale evidence costs correctness.
   *
   * @returns {Promise<{recrawl: boolean, reason: string}>}
   */
  async shouldRecrawl(url) {
    const previous = this.previousPages && this.previousPages.get(url);
    if (!previous) return { recrawl: true, reason: 'no previous record' };

    // A page that errored last time has no usable evidence to reuse.
    if (previous.error) return { recrawl: true, reason: 'previous crawl failed for this page' };

    // Refresh anything older than the configured TTL, so a site without
    // validators still gets revisited eventually.
    const maxAgeDays = CONFIG.get('crawler.incremental.maxAgeDays', 14);
    const observedAt = previous.timestamp || this.previousCrawlObservedAt;
    if (observedAt && Date.now() - observedAt > maxAgeDays * 86400000) {
      return { recrawl: true, reason: `evidence older than ${maxAgeDays} days` };
    }

    // Conditional request: the server tells us whether it changed.
    const validators = previous._validators;
    if (validators && (validators.etag || validators.lastModified)) {
      try {
        const headers = {};
        if (validators.etag) headers['If-None-Match'] = validators.etag;
        if (validators.lastModified) headers['If-Modified-Since'] = validators.lastModified;
        const res = await fetch(url, { method: 'GET', headers, credentials: 'include', cache: 'no-cache' });
        if (res.status === 304) return { recrawl: false, reason: 'server reported 304 Not Modified' };
        if (res.ok) {
          const etag = res.headers.get('etag');
          const lastMod = res.headers.get('last-modified');
          if (etag && validators.etag && etag === validators.etag) {
            return { recrawl: false, reason: 'ETag unchanged' };
          }
          if (!etag && lastMod && validators.lastModified === lastMod) {
            return { recrawl: false, reason: 'Last-Modified unchanged' };
          }
          return { recrawl: true, reason: etag ? 'ETag changed' : 'content validators changed' };
        }
      } catch (e) {
        // A failed probe proves nothing — crawl rather than assume unchanged.
        return { recrawl: true, reason: `could not verify freshness (${e.message})` };
      }
    }

    // Content hash as a fallback for servers that send no validators.
    if (previous._contentHash) {
      try {
        const res = await fetch(url, { credentials: 'include', cache: 'no-cache' });
        if (!res.ok) return { recrawl: true, reason: `freshness probe returned HTTP ${res.status}` };
        const body = await res.text();
        const hash = WebAppCrawler.hashContent(body);
        return hash === previous._contentHash
          ? { recrawl: false, reason: 'content hash unchanged' }
          : { recrawl: true, reason: 'content hash changed' };
      } catch (e) {
        return { recrawl: true, reason: `could not fetch to compare (${e.message})` };
      }
    }

    // Nothing to compare against — an SPA route, or a record from before
    // fingerprinting existed. Re-crawl once so it gains a fingerprint.
    return { recrawl: true, reason: 'no freshness fingerprint stored' };
  }

  /**
   * Reuse a previous page record unchanged, so an incremental crawl PRESERVES
   * evidence instead of quietly discarding everything it skipped.
   */
  carryForwardPage(url) {
    const previous = this.previousPages && this.previousPages.get(url);
    if (!previous) return false;
    this.pages.push({ ...previous, _reused: true, _reusedAt: Date.now() });
    this.reusedPageCount = (this.reusedPageCount || 0) + 1;
    return true;
  }

  /**
   * F26: a RESUMABLE checkpoint — the queue and the visited set, not a count.
   *
   * The previous checkpoint saved page/queue COUNTS, which cannot restart
   * anything: on resume there was no way to know which URLs were done or what
   * was still pending, and no reader existed anyway. This persists the state a
   * resume actually needs, bounded so a large crawl cannot blow the quota.
   */
  async saveResumeState() {
    if (!this.crawlId) return;
    try {
      const MAX = 2000;
      await chrome.storage.local.set({
        [`crawl_resume_${this.crawlId}`]: {
          crawlId: this.crawlId,
          startUrl: this.startUrl,
          savedAt: Date.now(),
          visited: [...this.visited].slice(-MAX),
          queue: this.queue.slice(0, MAX).map(q => ({ url: q.url, depth: q.depth, priority: q.priority })),
          batchNumber: this.batchNumber,
          // Truthful about its own limits: a bounded snapshot is not the whole
          // crawl, and a resume must not claim pages it cannot account for.
          truncated: this.visited.size > MAX || this.queue.length > MAX,
          pagesInMemory: this.pages.length
        }
      });
    } catch (e) {
      console.warn('⚠️ Could not save resume state:', e.message);
    }
  }

  /** F26: drop the resume state once the crawl has been committed. */
  async clearResumeState() {
    if (!this.crawlId) return;
    try { await chrome.storage.local.remove(`crawl_resume_${this.crawlId}`); } catch (_) {}
  }

  async releasePageBatches() {
    if (!this.pendingBatchCleanup) return;
    try {
      console.log(`🗑️ Cleaning up ${this.batchNumber} page batches (graph committed)…`);
      await storageManager.clearPageBatches(this.crawlId);
      this.pendingBatchCleanup = false;
    } catch (e) {
      // Leaving batches behind is safe; deleting them early is not.
      console.warn('⚠️ Page-batch cleanup failed, leaving them in place:', e.message);
    }
  }

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

    // F26: do NOT delete the page batches here. This ran BEFORE the caller
    // committed the assembled graph, so a failure in that final save destroyed
    // both the graph and the only durable copy of the pages it was built from —
    // an entire crawl lost at the last step. The caller cleans up once the graph
    // is safely stored (see releasePageBatches()).
    this.pendingBatchCleanup = this.streamingSaveEnabled && this.batchNumber > 0;

    // F19: a crawl is a PARTIAL observation. Pages we deliberately did not visit
    // — sampled-out URL patterns, structural duplicates, depth/budget cutoffs —
    // are recorded as explicit exploration gaps. Without this, "not in the graph"
    // and "does not exist in the app" were indistinguishable, and grounding
    // treated an unexplored variant as a hallucination.
    const reused = allPages.filter(p => p && p._reused).length;
    if (reused) {
      console.log(`♻️  Reused ${reused} unchanged page(s) from the previous crawl; ${allPages.length - reused} were new or changed.`);
    }

    const explorationGaps = [];
    if (this.parameterizedUrlTracking && this.parameterizedUrlTracking.size) {
      for (const [pattern, count] of this.parameterizedUrlTracking.entries()) {
        explorationGaps.push({
          kind: 'sampled_url_pattern', pattern, sampled: count,
          note: `Only ${count} sample(s) of this URL pattern were crawled; other instances were not observed.`
        });
      }
    }
    const dupSkipped = Math.max(0, this.pageSignatures.size - allPages.length);
    if (dupSkipped) {
      explorationGaps.push({
        kind: 'structural_duplicates', count: dupSkipped,
        note: `${dupSkipped} page(s) were skipped as structurally similar to an already-crawled page — their specific content was not observed.`
      });
    }
    if (this.queue && this.queue.length) {
      explorationGaps.push({
        kind: 'budget_cutoff', remaining: this.queue.length,
        note: `${this.queue.length} discovered page(s) were never visited because the page or depth budget was reached.`
      });
    }
    // F19: roles/states are never enumerated by a single authenticated session.
    explorationGaps.push({
      kind: 'unexplored_dimensions',
      note: 'This crawl observed one session: one role, one viewport, one feature-flag state. Permission, responsive and flag variants were not explored.'
    });

    return {
      appUrl: this.startUrl,
      crawledAt: Date.now(),
      explorationGaps,
      // Incremental crawl accounting, so "50 pages" cannot hide the fact that
      // only 3 were actually looked at this time.
      incremental: {
        reusedPages: reused,
        freshPages: allPages.length - reused,
        previousCrawlObservedAt: this.previousCrawlObservedAt || null
      },
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
    // F26: the queue/visited snapshot is written alongside the page batch, so a
    // recovered batch always has the crawl state that explains it. Best-effort:
    // the BATCH is the durable record, and a snapshot failure must never cost us
    // the pages themselves.
    if (this.streamingSaveEnabled && typeof this.saveResumeState === 'function') {
      try { await this.saveResumeState(); } catch (e) {
        console.warn('⚠️ Resume snapshot skipped:', e.message);
      }
    }
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
}

for (const name of Object.getOwnPropertyNames(CrawlerGraphMethods.prototype)) {
  if (name !== 'constructor') Object.defineProperty(WebAppCrawler.prototype, name, Object.getOwnPropertyDescriptor(CrawlerGraphMethods.prototype, name));
}
// The class is passed in so moved bodies that say `WebAppCrawler.X` resolve in Node too.
})(typeof WebAppCrawler !== 'undefined' ? WebAppCrawler : require('./crawler.js'));
