/**
 * Smart Wait - Intelligent Page Load Detection
 * Version: 1.0.0
 * Waits for network idle, specific elements, and framework hydration
 */

class SmartWait {
  constructor() {
    this.defaultTimeout = 30000; // 30 seconds max
  }

  /**
   * Wait for page to be fully loaded using multiple strategies
   * @param {number} tabId - Tab to wait for
   * @param {Object} options - Wait options
   * @returns {Promise<Object>} Wait result with timing info
   */
  async waitForPage(tabId, options = {}) {
    const startTime = Date.now();

    const config = {
      waitForNetworkIdle: options.waitForNetworkIdle ?? CONFIG.get('crawler.smartWait.networkIdle', true),
      waitForElements: options.waitForElements ?? CONFIG.get('crawler.smartWait.waitForElements', true),
      waitForFrameworks: options.waitForFrameworks ?? CONFIG.get('crawler.smartWait.frameworks', true),
      timeout: options.timeout ?? CONFIG.get('crawler.smartWait.timeout', 30000),
      minWait: options.minWait ?? CONFIG.get('crawler.smartWait.minWait', 500),
      networkIdleTime: options.networkIdleTime ?? CONFIG.get('crawler.smartWait.networkIdleTime', 500)
    };

    console.log(`⏱️ Smart wait started with config:`, config);

    try {
      // Always wait minimum time for initial rendering
      await this.sleep(config.minWait);

      // Run wait strategies in parallel
      const strategies = [];

      if (config.waitForNetworkIdle) {
        strategies.push(this.waitForNetworkIdle(tabId, config.networkIdleTime, config.timeout));
      }

      if (config.waitForElements) {
        strategies.push(this.waitForDOMStable(tabId, config.timeout));
      }

      if (config.waitForFrameworks) {
        strategies.push(this.waitForFrameworkHydration(tabId, config.timeout));
      }

      // Wait for all strategies or timeout
      if (strategies.length > 0) {
        await Promise.race([
          Promise.all(strategies),
          this.sleep(config.timeout)
        ]);
      }

      const duration = Date.now() - startTime;
      console.log(`✅ Smart wait completed in ${duration}ms`);

      return {
        success: true,
        duration: duration,
        timedOut: duration >= config.timeout
      };

    } catch (error) {
      const duration = Date.now() - startTime;
      console.warn(`⚠️ Smart wait error after ${duration}ms:`, error.message);

      return {
        success: false,
        duration: duration,
        error: error.message
      };
    }
  }

  /**
   * Wait for network to be idle (no pending requests)
   */
  async waitForNetworkIdle(tabId, idleTime = 500, timeout = 30000) {
    const startTime = Date.now();

    try {
      // Inject script to monitor network activity
      const result = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function(idleTime, timeout) {
          return new Promise((resolve) => {
            const startTime = Date.now();
            let lastActivityTime = startTime;
            let pendingRequests = 0;
            let checkInterval;

            const observer = new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                if (entry.entryType === 'resource') {
                  if (!entry.responseEnd) {
                    pendingRequests++;
                    lastActivityTime = Date.now();
                  } else {
                    pendingRequests = Math.max(0, pendingRequests - 1);
                    lastActivityTime = Date.now();
                  }
                }
              }
            });

            try {
              observer.observe({ entryTypes: ['resource'] });
            } catch (e) {
              resolve(idleTime);
              return;
            }

            checkInterval = setInterval(() => {
              const now = Date.now();
              const timeSinceActivity = now - lastActivityTime;
              const totalTime = now - startTime;

              if (totalTime >= timeout) {
                clearInterval(checkInterval);
                observer.disconnect();
                resolve(timeout);
                return;
              }

              if (pendingRequests === 0 && timeSinceActivity >= idleTime) {
                clearInterval(checkInterval);
                observer.disconnect();
                resolve(totalTime);
                return;
              }
            }, 100);
          });
        },
        args: [idleTime, timeout]
      });

      if (result && result[0]) {
        console.log(`🌐 Network idle after ${result[0].result}ms`);
        return result[0].result;
      }

      return Date.now() - startTime;
    } catch (error) {
      console.warn('Network idle detection failed:', error);
      return Date.now() - startTime;
    }
  }

  /**
   * Monitor network idle IN THE PAGE CONTEXT
   * Uses PerformanceObserver to track network requests
   */
  static monitorNetworkIdleInPage(idleTime, timeout) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let lastActivityTime = startTime;
      let pendingRequests = 0;
      let checkInterval;

      // Track active fetch/XHR requests using PerformanceObserver
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.entryType === 'resource') {
            // Request started
            if (!entry.responseEnd) {
              pendingRequests++;
              lastActivityTime = Date.now();
            }
            // Request completed
            else {
              pendingRequests = Math.max(0, pendingRequests - 1);
              lastActivityTime = Date.now();
            }
          }
        }
      });

      try {
        observer.observe({ entryTypes: ['resource'] });
      } catch (e) {
        // PerformanceObserver not supported, use timeout fallback
        resolve(idleTime);
        return;
      }

      // Check for idle state
      checkInterval = setInterval(() => {
        const now = Date.now();
        const timeSinceActivity = now - lastActivityTime;
        const totalTime = now - startTime;

        // Timeout reached
        if (totalTime >= timeout) {
          clearInterval(checkInterval);
          observer.disconnect();
          resolve(timeout);
          return;
        }

        // Network is idle
        if (pendingRequests === 0 && timeSinceActivity >= idleTime) {
          clearInterval(checkInterval);
          observer.disconnect();
          resolve(totalTime);
          return;
        }
      }, 100);
    });
  }

  /**
   * Wait for DOM to be stable (no mutations)
   */
  async waitForDOMStable(tabId, timeout = 30000) {
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function(timeout) {
          return new Promise((resolve) => {
            const startTime = Date.now();
            let lastMutationTime = startTime;
            const stableTime = 300;
            let timeoutId;

            const observer = new MutationObserver((mutations) => {
              if (mutations.length > 2) {
                lastMutationTime = Date.now();
                if (timeoutId) clearTimeout(timeoutId);

                timeoutId = setTimeout(() => {
                  const now = Date.now();
                  if (now - lastMutationTime >= stableTime) {
                    observer.disconnect();
                    resolve(now - startTime);
                  }
                }, stableTime);
              }
            });

            observer.observe(document.body, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: ['class', 'style']
            });

            setTimeout(() => {
              observer.disconnect();
              if (timeoutId) clearTimeout(timeoutId);
              resolve(timeout);
            }, timeout);

            timeoutId = setTimeout(() => {
              const now = Date.now();
              if (now - lastMutationTime >= stableTime) {
                observer.disconnect();
                resolve(now - startTime);
              }
            }, stableTime);
          });
        },
        args: [timeout]
      });

      if (result && result[0]) {
        console.log(`📄 DOM stable after ${result[0].result}ms`);
        return result[0].result;
      }

      return 0;
    } catch (error) {
      console.warn('DOM stable detection failed:', error);
      return 0;
    }
  }

  /**
   * Monitor DOM stability IN THE PAGE CONTEXT
   * Waits for mutations to stop
   */
  static monitorDOMStableInPage(timeout) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let lastMutationTime = startTime;
      const stableTime = 300; // DOM stable for 300ms
      let timeoutId;

      const observer = new MutationObserver((mutations) => {
        // Ignore minor mutations
        if (mutations.length > 2) {
          lastMutationTime = Date.now();

          // Reset stable check
          if (timeoutId) clearTimeout(timeoutId);

          timeoutId = setTimeout(() => {
            const now = Date.now();
            if (now - lastMutationTime >= stableTime) {
              observer.disconnect();
              resolve(now - startTime);
            }
          }, stableTime);
        }
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style']
      });

      // Timeout protection
      setTimeout(() => {
        observer.disconnect();
        if (timeoutId) clearTimeout(timeoutId);
        resolve(timeout);
      }, timeout);

      // Initial stable check
      timeoutId = setTimeout(() => {
        const now = Date.now();
        if (now - lastMutationTime >= stableTime) {
          observer.disconnect();
          resolve(now - startTime);
        }
      }, stableTime);
    });
  }

  /**
   * Wait for React/Vue/Angular hydration
   */
  async waitForFrameworkHydration(tabId, timeout = 30000) {
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: function(timeout) {
          return new Promise((resolve) => {
            const startTime = Date.now();
            let checkInterval;

            const detectFramework = () => {
              // React
              if (window.React || window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
                const reactRoot = document.querySelector('[data-reactroot], [data-reactid]');
                if (reactRoot) {
                  return { detected: true, name: 'React', time: Date.now() - startTime };
                }
              }

              // Vue
              if (window.Vue || document.querySelector('[data-v-]')) {
                return { detected: true, name: 'Vue', time: Date.now() - startTime };
              }

              // Angular
              if (window.ng || document.querySelector('[ng-version]')) {
                return { detected: true, name: 'Angular', time: Date.now() - startTime };
              }

              // Next.js
              if (window.__NEXT_DATA__ && document.querySelector('#__next')) {
                return { detected: true, name: 'Next.js', time: Date.now() - startTime };
              }

              // Nuxt
              if (window.$nuxt) {
                return { detected: true, name: 'Nuxt', time: Date.now() - startTime };
              }

              return null;
            };

            // Check immediately
            const immediate = detectFramework();
            if (immediate) {
              resolve(immediate);
              return;
            }

            // Poll for framework hydration
            checkInterval = setInterval(() => {
              const result = detectFramework();
              const elapsed = Date.now() - startTime;

              if (result) {
                clearInterval(checkInterval);
                resolve(result);
              } else if (elapsed >= timeout) {
                clearInterval(checkInterval);
                resolve({ detected: false, time: elapsed });
              }
            }, 100);
          });
        },
        args: [timeout]
      });

      if (result && result[0]) {
        const framework = result[0].result;
        if (framework && framework.detected) {
          console.log(`⚛️ ${framework.name} hydrated after ${framework.time}ms`);
        }
        return framework?.time || 0;
      }

      return 0;
    } catch (error) {
      console.warn('Framework hydration detection failed:', error);
      return 0;
    }
  }

  /**
   * Detect framework hydration IN THE PAGE CONTEXT
   */
  static detectFrameworkHydrationInPage(timeout) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let checkInterval;

      const detectFramework = () => {
        // React
        if (window.React || window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
          // Check if React has rendered
          const reactRoot = document.querySelector('[data-reactroot], [data-reactid]');
          if (reactRoot) {
            return { detected: true, name: 'React', time: Date.now() - startTime };
          }
        }

        // Vue
        if (window.Vue || document.querySelector('[data-v-]')) {
          return { detected: true, name: 'Vue', time: Date.now() - startTime };
        }

        // Angular
        if (window.ng || document.querySelector('[ng-version]')) {
          return { detected: true, name: 'Angular', time: Date.now() - startTime };
        }

        // Next.js
        if (window.__NEXT_DATA__ && document.querySelector('#__next')) {
          return { detected: true, name: 'Next.js', time: Date.now() - startTime };
        }

        // Nuxt
        if (window.$nuxt) {
          return { detected: true, name: 'Nuxt', time: Date.now() - startTime };
        }

        return null;
      };

      // Check immediately
      const immediate = detectFramework();
      if (immediate) {
        resolve(immediate);
        return;
      }

      // Poll for framework hydration
      checkInterval = setInterval(() => {
        const result = detectFramework();
        const elapsed = Date.now() - startTime;

        if (result) {
          clearInterval(checkInterval);
          resolve(result);
        } else if (elapsed >= timeout) {
          clearInterval(checkInterval);
          resolve({ detected: false, time: elapsed });
        }
      }, 100);
    });
  }

  /**
   * Wait for specific selector to appear
   */
  async waitForSelector(tabId, selector, timeout = 10000) {
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: tabId },
        func: (sel, maxWait) => {
          return new Promise((resolve) => {
            const startTime = Date.now();

            const check = () => {
              const element = document.querySelector(sel);
              if (element) {
                resolve({ found: true, time: Date.now() - startTime });
                return;
              }

              if (Date.now() - startTime >= maxWait) {
                resolve({ found: false, time: maxWait });
                return;
              }

              setTimeout(check, 100);
            };

            check();
          });
        },
        args: [selector, timeout]
      });

      if (result && result[0]) {
        return result[0].result;
      }

      return { found: false, time: timeout };
    } catch (error) {
      console.warn('Selector wait failed:', error);
      return { found: false, time: 0 };
    }
  }

  /**
   * Simple sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export for use in crawler
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SmartWait;
}
