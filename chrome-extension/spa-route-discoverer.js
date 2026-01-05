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
      if (discovery.state.url !== discovery.state.originalUrl) {
        routes.add(discovery.state.url);
      }

      if (discovery.state.hash) {
        routes.add(discovery.state.url + discovery.state.hash);
      }
    }

    return Array.from(routes);
  }
}

// Export for use in crawler
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SPARouteDiscoverer;
}
