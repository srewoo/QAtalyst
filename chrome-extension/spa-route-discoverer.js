/**
 * SPA Route Discoverer - Click-Based Discovery for Single Page Applications
 * Version: 1.0.0
 * Discovers routes triggered by clicks, tabs, modals, accordions, etc.
 */

class SPARouteDiscoverer {
  constructor() {
    this.discoveredStates = new Map(); // URL -> Set of state hashes
    this.clickedElements = new WeakSet();
    this.maxClicksPerPage = CONFIG.get('crawler.spaDiscovery.maxClicksPerPage', 20);
    this.clickDelay = CONFIG.get('crawler.spaDiscovery.clickDelay', 500);
    this.timeBudgetMs = CONFIG.get('crawler.spaDiscovery.timeBudgetMs', 5000);
  }

  /**
   * Passive route discovery: intercept History API calls (pushState/replaceState)
   * and popstate/hashchange events without clicking anything.
   * Runs for a configurable time budget, collecting any routes triggered by
   * the page's own JavaScript (lazy loading, auto-navigation, etc.).
   * @param {number} tabId - Tab to monitor
   * @param {number} durationMs - How long to listen (default: 3000ms)
   * @returns {Promise<Array>} Discovered routes
   */
  async discoverRoutesPassive(tabId, durationMs = 3000) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: function(duration) {
          return new Promise((resolve) => {
            const routes = [];
            const seen = new Set();
            seen.add(window.location.href);

            // Monkey-patch pushState
            const origPushState = history.pushState.bind(history);
            history.pushState = function(...args) {
              origPushState(...args);
              const url = window.location.href;
              if (!seen.has(url)) {
                seen.add(url);
                routes.push({ type: 'pushState', url, title: document.title, timestamp: Date.now() });
              }
            };

            // Monkey-patch replaceState
            const origReplaceState = history.replaceState.bind(history);
            history.replaceState = function(...args) {
              origReplaceState(...args);
              const url = window.location.href;
              if (!seen.has(url)) {
                seen.add(url);
                routes.push({ type: 'replaceState', url, title: document.title, timestamp: Date.now() });
              }
            };

            // Listen for popstate (back/forward) and hashchange
            const onPopstate = () => {
              const url = window.location.href;
              if (!seen.has(url)) {
                seen.add(url);
                routes.push({ type: 'popstate', url, title: document.title, timestamp: Date.now() });
              }
            };
            const onHashchange = () => {
              const url = window.location.href;
              if (!seen.has(url)) {
                seen.add(url);
                routes.push({ type: 'hashchange', url, title: document.title, timestamp: Date.now() });
              }
            };

            window.addEventListener('popstate', onPopstate);
            window.addEventListener('hashchange', onHashchange);

            // Cleanup after duration
            setTimeout(() => {
              history.pushState = origPushState;
              history.replaceState = origReplaceState;
              window.removeEventListener('popstate', onPopstate);
              window.removeEventListener('hashchange', onHashchange);
              resolve(routes);
            }, duration);
          });
        },
        args: [durationMs]
      });

      if (results && results[0] && results[0].result) {
        const routes = results[0].result;
        if (routes.length > 0) {
          console.log(`🔍 Passive SPA discovery: found ${routes.length} routes via History API`);
        }
        return routes;
      }
      return [];
    } catch (error) {
      console.warn('⚠️ Passive SPA discovery failed:', error.message);
      return [];
    }
  }

  /**
   * Discover SPA routes by clicking interactive elements
   * @param {number} tabId - Tab to perform discovery in
   * @returns {Promise<Array>} Discovered states/routes
   */
  async discoverRoutes(tabId) {
    console.log('🔍 Starting SPA route discovery...');

    try {
      // Inject the discovery script into the page
      // NOTE: Pass static method code as string to avoid serialization issues
      const maxClicks = this.maxClicksPerPage;
      const clickDelay = this.clickDelay;

      const results = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function(maxClicks, clickDelay) {
          // This code runs in the page context
          return (async function performClickDiscovery() {
            const discoveries = [];
            const clickedElements = new Set();
            let clickCount = 0;

            // ── Visibility + lightweight feature snapshot (items 1 & 2) ──────────
            const isVisible = (el) => {
              try {
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return false;
                const s = window.getComputedStyle(el);
                return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) !== 0;
              } catch (e) { return false; }
            };
            const cssPath = (el) => {
              if (el.id) return '#' + el.id;
              let p = el.tagName ? el.tagName.toLowerCase() : 'node';
              if (el.className && typeof el.className === 'string') {
                const c = el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.');
                if (c) p += '.' + c;
              }
              return p;
            };
            // Capture interactive features (forms/buttons) currently in the DOM
            // as lightweight records, each with a stable signature for diffing.
            const featureSig = (f) => [f.type, f.name || '', f.action || '',
              (f.fields ? f.fields.length : ''), (f.text || '').slice(0, 40)].join('|');
            const snapshotFeatures = () => {
              const out = [];
              try {
                const forms = document.querySelectorAll('form');
                for (let i = 0; i < forms.length && out.length < 40; i++) {
                  const form = forms[i];
                  if (!isVisible(form)) continue;
                  const fields = Array.from(form.querySelectorAll('input, select, textarea'))
                    .filter((f) => (f.type || '') !== 'hidden')
                    .slice(0, 30)
                    .map((f) => ({ name: f.name || f.id || f.placeholder || '', type: f.type || f.tagName.toLowerCase() }));
                  if (fields.length === 0) continue;
                  out.push({ type: 'form', name: form.name || form.id || ('Form ' + (i + 1)),
                    action: form.action || '', fields, selector: cssPath(form), _discoveredVia: 'click' });
                }
                const btns = document.querySelectorAll('button, [role="button"]');
                for (let i = 0; i < btns.length && out.length < 60; i++) {
                  const b = btns[i];
                  if (!isVisible(b)) continue;
                  const text = (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 50);
                  if (text) out.push({ type: 'button', text, selector: cssPath(b), _discoveredVia: 'click' });
                }
              } catch (e) { /* snapshot best-effort */ }
              return out;
            };
            // Baseline of features present before any interaction — only NEW ones
            // (revealed by clicks/hover) are reported back as newFeatures.
            const seenFeatureSigs = new Set(snapshotFeatures().map(featureSig));
            const collectNewFeatures = () => {
              const fresh = [];
              for (const f of snapshotFeatures()) {
                const s = featureSig(f);
                if (seenFeatureSigs.has(s)) continue;
                seenFeatureSigs.add(s);
                fresh.push(f);
              }
              return fresh;
            };

            // ── Hover pass (item 2): reveal CSS/JS submenus, then record links ───
            const hoverReveal = async () => {
              const parents = [];
              const sel = '[aria-haspopup], [class*="dropdown"], [class*="menu"], nav li, [class*="has-sub"]';
              try { parents.push(...document.querySelectorAll(sel)); } catch (e) { /* ignore */ }
              const fire = (el, type) => { try { el.dispatchEvent(new MouseEvent(type, { bubbles: true })); } catch (e) {} };
              for (const el of parents.slice(0, 15)) {
                if (!isVisible(el)) continue;
                fire(el, 'mouseover'); fire(el, 'mouseenter');
                try { if (el.focus) el.focus(); } catch (e) {}
                await new Promise((r) => setTimeout(r, 120));
              }
              // Any internal anchors now visible are candidate routes.
              const revealedUrls = new Set();
              try {
                document.querySelectorAll('a[href]').forEach((a) => {
                  const href = a.getAttribute('href') || '';
                  if (!href || href.startsWith('#') || /^(https?:|mailto:|tel:|javascript:)/i.test(href)) return;
                  if (!isVisible(a)) return;
                  try { revealedUrls.add(new URL(href, location.href).href); } catch (e) {}
                });
              } catch (e) { /* ignore */ }
              const newFeatures = collectNewFeatures();
              if (revealedUrls.size > 0 || newFeatures.length > 0) {
                discoveries.push({
                  type: 'hover-menu',
                  trigger: { element: 'hover', text: 'submenu/hover reveal' },
                  state: { url: window.location.href, hash: window.location.hash, title: document.title,
                    revealedUrls: Array.from(revealedUrls).slice(0, 50), changed: { dom: newFeatures.length > 0 } },
                  newFeatures,
                  timestamp: Date.now()
                });
              }
            };

            // Get initial page state
            const getPageState = () => {
              return {
                url: window.location.href,
                hash: window.location.hash,
                title: document.title,
                bodyHash: document.body.innerHTML.substring(0, 1000),
                visibleText: document.body.innerText.substring(0, 500)
              };
            };

            // Calculate simple hash
            const hashState = (state) => {
              const str = state.url + state.hash + state.title + state.bodyHash;
              let hash = 0;
              for (let i = 0; i < str.length; i++) {
                const char = str.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash;
              }
              return hash;
            };

            // Find clickable elements
            const findClickableElements = () => {
              const selectors = [
                'nav a:not([href^="http"]):not([href^="mailto"]):not([href^="tel"])',
                '[role="tab"]', '[role="button"]',
                'button:not([type="submit"]):not([disabled])',
                '.tab:not(.active)', '.tabs a',
                '[data-toggle="tab"]', '[data-toggle="collapse"]',
                '.accordion-button', '[role="menuitem"]',
                '[data-toggle="modal"]', '.dropdown-item'
              ];

              const elements = [];
              for (const selector of selectors) {
                try {
                  elements.push(...document.querySelectorAll(selector));
                } catch (e) {
                  // Invalid selector syntax - skip silently as this is expected for some dynamic selectors
                }
              }

              return elements.filter(el => {
                if (clickedElements.has(el)) return false;
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) return false;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;

                // Skip logout/signout buttons
                const text = (el.innerText || el.textContent || '').toLowerCase();
                const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
                const href = (el.getAttribute('href') || '').toLowerCase();
                const className = (el.className || '').toLowerCase();
                const id = (el.id || '').toLowerCase();

                const logoutKeywords = ['logout', 'log out', 'signout', 'sign out', 'log-out', 'sign-out'];
                const hasLogoutKeyword = logoutKeywords.some(keyword =>
                  text.includes(keyword) ||
                  ariaLabel.includes(keyword) ||
                  href.includes(keyword) ||
                  className.includes(keyword) ||
                  id.includes(keyword)
                );

                if (hasLogoutKeyword) return false;

                return true;
              });
            };

            // Click and detect change
            const clickAndDetectChange = async (element, initialState) => {
              return new Promise((resolve) => {
                const initialHash = hashState(initialState);
                let domChanged = false;
                let urlChanged = false;

                const observer = new MutationObserver((mutations) => {
                  if (mutations.length > 5) domChanged = true;
                });

                observer.observe(document.body, {
                  childList: true, subtree: true, attributes: true,
                  attributeFilter: ['class', 'style']
                });

                const hashChangeHandler = () => { urlChanged = true; };
                window.addEventListener('hashchange', hashChangeHandler);

                try {
                  element.scrollIntoView({ behavior: 'instant', block: 'center' });
                  element.click();
                  clickedElements.add(element);
                  clickCount++;

                  setTimeout(() => {
                    observer.disconnect();
                    window.removeEventListener('hashchange', hashChangeHandler);

                    const newState = getPageState();
                    const newHash = hashState(newState);

                    if (newHash !== initialHash || urlChanged || domChanged) {
                      resolve({
                        type: 'spa-route',
                        trigger: {
                          element: element.tagName.toLowerCase(),
                          text: (element.innerText || element.getAttribute('aria-label') || '').substring(0, 50)
                        },
                        state: {
                          url: newState.url,
                          hash: newState.hash,
                          title: newState.title,
                          changed: { url: urlChanged, dom: domChanged, hash: newHash !== initialHash }
                        },
                        // Item 1: capture forms/buttons the click revealed (only when
                        // the DOM actually changed) so they become testable features.
                        newFeatures: domChanged ? collectNewFeatures() : [],
                        timestamp: Date.now()
                      });
                    } else {
                      resolve(null);
                    }
                  }, clickDelay);
                } catch (error) {
                  observer.disconnect();
                  window.removeEventListener('hashchange', hashChangeHandler);
                  resolve(null);
                }
              });
            };

            // Main discovery
            const initialState = getPageState();
            // Item 2: hover pass first — open submenus/dropdowns so their items
            // are visible to the click loop below and their links get recorded.
            try { await hoverReveal(); } catch (e) { /* best-effort */ }
            while (clickCount < maxClicks) {
              const clickableElements = findClickableElements();
              if (clickableElements.length === 0) break;

              for (const element of clickableElements.slice(0, 5)) {
                if (clickCount >= maxClicks) break;
                const discovery = await clickAndDetectChange(element, initialState);
                if (discovery) discoveries.push(discovery);
              }

              if (clickCount > 0 && discoveries.length === 0) break;
            }

            return discoveries;
          })();
        },
        args: [maxClicks, clickDelay]
      });

      if (results && results[0] && results[0].result) {
        const discoveries = results[0].result;
        console.log(`✅ SPA Discovery: Found ${discoveries.length} new states`);
        return discoveries;
      }

      return [];
    } catch (error) {
      console.error('❌ SPA discovery failed:', error);
      return [];
    }
  }

  /**
   * This function runs IN THE PAGE CONTEXT (content script)
   * Discovers routes by clicking elements and detecting state changes
   */
  static performClickDiscovery(maxClicks, clickDelay) {
    const discoveries = [];
    const clickedElements = new Set();
    let clickCount = 0;

    // Get initial page state
    const getPageState = () => {
      return {
        url: window.location.href,
        hash: window.location.hash,
        title: document.title,
        bodyHash: document.body.innerHTML.substring(0, 1000), // First 1KB
        visibleText: document.body.innerText.substring(0, 500)
      };
    };

    // Calculate simple hash for state comparison
    const hashState = (state) => {
      const str = state.url + state.hash + state.title + state.bodyHash;
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      return hash;
    };

    // Find clickable elements that might trigger SPA routes
    const findClickableElements = () => {
      const selectors = [
        // Navigation
        'nav a:not([href^="http"]):not([href^="mailto"]):not([href^="tel"])',
        '[role="tab"]',
        '[role="button"]',

        // Buttons (excluding submit buttons to avoid form submission)
        'button:not([type="submit"]):not([disabled])',
        'a[role="button"]',

        // Tab-like elements
        '.tab:not(.active)',
        '.tabs a',
        '[class*="tab"]:not([class*="table"])',
        '[data-tab]',
        '[data-toggle="tab"]',

        // Accordion/Collapsible
        '[data-toggle="collapse"]',
        '.accordion-button',
        '[class*="accordion"]',
        'summary', // HTML5 details/summary

        // Menu items
        '[role="menuitem"]',
        '.menu-item a',
        '.nav-item a',

        // Modal triggers
        '[data-toggle="modal"]',
        '[data-modal]',

        // Dropdown items
        '.dropdown-item',
        '[role="option"]',

        // Generic clickable with route hints
        '[data-route]',
        '[data-link]',
        '[data-navigate]',
        '[ng-click]', // Angular
        '[v-on\\:click]', // Vue
        '[onclick]'
      ];

      const elements = [];

      for (const selector of selectors) {
        try {
          const found = document.querySelectorAll(selector);
          elements.push(...Array.from(found));
        } catch (e) {
          // Invalid selector, skip
        }
      }

      // Filter out already clicked and hidden elements
      return elements.filter(el => {
        if (clickedElements.has(el)) return false;

        // Check if visible
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return false;

        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        if (parseFloat(style.opacity) === 0) return false;

        return true;
      });
    };

    // Click an element and detect state change
    const clickAndDetectChange = async (element, initialState) => {
      return new Promise((resolve) => {
        const initialHash = hashState(initialState);

        // Set up mutation observer for DOM changes
        let domChanged = false;
        const observer = new MutationObserver((mutations) => {
          if (mutations.length > 5) { // Significant changes
            domChanged = true;
          }
        });

        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['class', 'style']
        });

        // Set up URL/hash change listener
        let urlChanged = false;
        const hashChangeHandler = () => { urlChanged = true; };
        window.addEventListener('hashchange', hashChangeHandler);

        try {
          // Scroll element into view
          element.scrollIntoView({ behavior: 'instant', block: 'center' });

          // Click the element
          element.click();

          clickedElements.add(element);
          clickCount++;

          // Wait for state to settle
          setTimeout(() => {
            observer.disconnect();
            window.removeEventListener('hashchange', hashChangeHandler);

            const newState = getPageState();
            const newHash = hashState(newState);

            // Check if state changed significantly
            if (newHash !== initialHash || urlChanged || domChanged) {
              const discovery = {
                type: 'spa-route',
                trigger: {
                  element: element.tagName.toLowerCase(),
                  text: element.innerText?.substring(0, 50) || element.getAttribute('aria-label') || '',
                  selector: getElementSelector(element),
                  classes: Array.from(element.classList),
                  role: element.getAttribute('role')
                },
                state: {
                  url: newState.url,
                  hash: newState.hash,
                  title: newState.title,
                  changed: {
                    url: urlChanged,
                    dom: domChanged,
                    hash: newHash !== initialHash
                  }
                },
                timestamp: Date.now()
              };

              resolve(discovery);
            } else {
              resolve(null);
            }
          }, clickDelay);

        } catch (error) {
          observer.disconnect();
          window.removeEventListener('hashchange', hashChangeHandler);
          resolve(null);
        }
      });
    };

    // Get a unique CSS selector for an element
    const getElementSelector = (element) => {
      if (element.id) {
        return '#' + element.id;
      }

      const path = [];
      let current = element;

      while (current && current.nodeType === Node.ELEMENT_NODE) {
        let selector = current.nodeName.toLowerCase();

        if (current.className) {
          const classes = Array.from(current.classList)
            .filter(c => !c.match(/^(active|selected|open|show|in)$/)) // Exclude state classes
            .slice(0, 2)
            .join('.');
          if (classes) {
            selector += '.' + classes;
          }
        }

        path.unshift(selector);

        if (path.length > 3) break; // Keep selector reasonably short

        current = current.parentElement;
      }

      return path.join(' > ');
    };

    // Main discovery loop - executed synchronously in page context
    const runDiscovery = async () => {
      const initialState = getPageState();

      while (clickCount < maxClicks) {
        const clickableElements = findClickableElements();

        if (clickableElements.length === 0) {
          console.log('🔍 No more clickable elements found');
          break;
        }

        // Try clicking elements one by one
        for (const element of clickableElements.slice(0, 5)) { // Process 5 at a time
          if (clickCount >= maxClicks) break;

          const discovery = await clickAndDetectChange(element, initialState);

          if (discovery) {
            discoveries.push(discovery);
            console.log('✅ Found new SPA state:', discovery.state.title || discovery.state.url);
          }
        }

        // If we haven't found anything new in this batch, stop
        if (clickCount > 0 && discoveries.length === 0) {
          break;
        }
      }

      return discoveries;
    };

    // Return a promise that resolves with discoveries
    // Note: We can't use async/await in executeScript, so we use IIFE
    return (async () => {
      try {
        return await runDiscovery();
      } catch (error) {
        console.error('SPA discovery error:', error);
        return [];
      }
    })();
  }

  /**
   * Extract unique routes from discoveries
   */
  extractRoutes(discoveries) {
    const routes = new Set();

    for (const discovery of discoveries) {
      const state = discovery && discovery.state;
      if (!state) continue;

      if (state.url !== state.originalUrl) {
        routes.add(state.url);
      }

      if (state.hash) {
        routes.add(state.url + state.hash);
      }

      // Item 2: URLs surfaced by the hover/submenu reveal pass.
      if (Array.isArray(state.revealedUrls)) {
        for (const u of state.revealedUrls) routes.add(u);
      }
    }

    return Array.from(routes);
  }
}

// Export for use in crawler
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SPARouteDiscoverer;
}
