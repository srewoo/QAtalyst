/**
 * crawler-page.js — In-page side of a crawl: content-script injection, DOM/text/metadata extraction, API interceptors, lazy content and SPA hydration waits.
 *
 * Methods of WebAppCrawler, moved verbatim out of crawler.js and installed on its
 * prototype below. Load after crawler.js (importScripts order in background.js;
 * crawler.js requires this file itself under Node).
 */
(function (WebAppCrawler) {

class CrawlerPageMethods {
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
          files: ['config.js', 'security.js', 'dom-extractor.js', 'content-crawler.js']
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
   * Inject the MAIN-world fetch/XHR interceptor (network-interceptor.js) so the
   * crawler can capture API response bodies (webRequest can't read them).
   * Idempotent in-page; safe to call once per page load. Best-effort.
   */
  /**
   * F18: register the interceptor to run at DOCUMENT_START for the crawl's own
   * origin, before any page script executes.
   *
   * Per-page injection happens after waitForPageLoad(), so every request the page
   * fires while loading — which on most apps is the bootstrap data fetch, i.e.
   * the most informative call on the page — had already completed before the
   * interceptor existed. Its response body was therefore never captured, and the
   * knowledge graph recorded the endpoint with `responseBody: null`.
   *
   * Best-effort: registration can fail on restricted origins, and the per-page
   * injection below remains as the fallback.
   */
  async registerEarlyInterceptor(startUrl) {
    if (CONFIG.get('network.responseBodyCapture.enabled', true) === false) return;
    if (!chrome.scripting || !chrome.scripting.registerContentScripts) return;
    try {
      const origin = new URL(startUrl).origin;
      this._earlyScriptId = `qatalyst-net-${Date.now()}`;
      await chrome.scripting.registerContentScripts([{
        id: this._earlyScriptId,
        matches: [`${origin}/*`],
        js: ['network-interceptor.js'],
        runAt: 'document_start',
        world: 'MAIN',
        persistAcrossSessions: false
      }]);
      console.log(`🌐 Early API interceptor registered for ${origin} (document_start)`);
    } catch (error) {
      this._earlyScriptId = null;
      console.debug?.(`Early interceptor registration skipped: ${error.message}`);
    }
  }

  /** F18: remove the document_start registration when the crawl ends. */
  async unregisterEarlyInterceptor() {
    if (!this._earlyScriptId || !chrome.scripting || !chrome.scripting.unregisterContentScripts) return;
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [this._earlyScriptId] });
    } catch (error) {
      console.debug?.(`Early interceptor cleanup skipped: ${error.message}`);
    }
    this._earlyScriptId = null;
  }

  async injectNetworkInterceptor(tabId) {
    if (CONFIG.get('network.responseBodyCapture.enabled', true) === false) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['network-interceptor.js'],
        world: 'MAIN',
      });
    } catch (error) {
      // MAIN-world injection can fail on restricted pages — non-fatal.
      console.debug?.(`Network interceptor injection skipped for tab ${tabId}: ${error.message}`);
    }
  }

  /**
   * Read and clear the in-page capture buffer the interceptor populated, then
   * feed each captured response into the network monitor. Best-effort.
   */
  async drainApiCaptures(tabId) {
    if (CONFIG.get('network.responseBodyCapture.enabled', true) === false) return;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const buf = window.__qatalystApiCaptures || [];
          window.__qatalystApiCaptures = [];
          return buf;
        },
      });
      const captures = (results && results[0] && results[0].result) || [];
      for (const cap of captures) {
        try { this.networkMonitor.ingestResponseBody(cap, tabId); } catch (_) { /* skip one bad capture */ }
      }
      if (captures.length > 0) {
        console.log(`🌐 Ingested ${captures.length} response bodies from interceptor`);
      }
    } catch (error) {
      console.debug?.(`Drain API captures skipped for tab ${tabId}: ${error.message}`);
    }
  }

  /**
   * Trigger lazy-loaded / infinite-scroll content by scrolling the page in
   * bounded steps until the document stops growing (item 3). Runs in MAIN world.
   * No-op unless the page hints at lazy/infinite content. Best-effort.
   */
  async triggerLazyContent(tabId) {
    if (CONFIG.get('crawler.scrollTrigger.enabled', true) === false) return;
    const maxSteps = CONFIG.get('crawler.scrollTrigger.maxSteps', 8);
    const stepDelayMs = CONFIG.get('crawler.scrollTrigger.stepDelayMs', 400);
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [maxSteps, stepDelayMs],
        func: (steps, delayMs) => new Promise((resolve) => {
          // Only bother if the page looks lazy/infinite; otherwise return fast.
          const hinted = !!document.querySelector(
            '[data-infinite-scroll],[class*="infinite"],[data-next-page],' +
            'img[loading="lazy"],img[data-src],img.lazyload,[data-lazy]'
          );
          if (!hinted) { resolve(false); return; }
          let i = 0;
          let lastHeight = document.body ? document.body.scrollHeight : 0;
          const tick = () => {
            if (i >= steps) { resolve(true); return; }
            window.scrollTo(0, document.body.scrollHeight);
            i++;
            setTimeout(() => {
              const h = document.body ? document.body.scrollHeight : 0;
              if (h <= lastHeight && i > 1) { resolve(true); return; } // stopped growing
              lastHeight = h;
              tick();
            }, delayMs);
          };
          tick();
        }),
      });
    } catch (error) {
      console.debug?.(`Lazy-content scroll skipped for tab ${tabId}: ${error.message}`);
    }
  }

  /**
   * Merge features discovered after interaction (clicks/hover) into the page's
   * feature list, de-duplicated by a structural signature so the same form/button
   * isn't recorded twice (item 1). Pure given its args. Returns the merged array.
   */
  mergeDiscoveredFeatures(existing, incoming) {
    const sig = (f) => [f.type, f.name || '', f.action || '', f.selector || '',
      (f.fields ? f.fields.length : ''), (f.text || '').slice(0, 40)].join('|');
    const seen = new Set((existing || []).map(sig));
    const merged = [...(existing || [])];
    for (const f of incoming || []) {
      if (!f || !f.type) continue;
      const s = sig(f);
      if (seen.has(s)) continue;
      seen.add(s);
      merged.push({ ...f, _discoveredVia: f._discoveredVia || 'interaction' });
    }
    return merged;
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
}

for (const name of Object.getOwnPropertyNames(CrawlerPageMethods.prototype)) {
  if (name !== 'constructor') Object.defineProperty(WebAppCrawler.prototype, name, Object.getOwnPropertyDescriptor(CrawlerPageMethods.prototype, name));
}
// The class is passed in so moved bodies that say `WebAppCrawler.X` resolve in Node too.
})(typeof WebAppCrawler !== 'undefined' ? WebAppCrawler : require('./crawler.js'));
