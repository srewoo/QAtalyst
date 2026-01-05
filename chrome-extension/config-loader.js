/**
 * Config Loader - Load and manage configuration from config.json
 * Version: 11.0.0
 * Provides centralized access to all extension configuration
 */

class ConfigLoader {
  constructor() {
    this.config = null;
    this.isLoaded = false;
  }

  /**
   * Load configuration from config.json
   */
  async load() {
    if (this.isLoaded) {
      return this.config;
    }

    try {
      // Fetch config.json from extension directory
      const response = await fetch(chrome.runtime.getURL('config.json'));

      if (!response.ok) {
        throw new Error(`Failed to load config.json: ${response.status}`);
      }

      this.config = await response.json();
      this.isLoaded = true;

      // Initialize logger with config settings
      this._initializeLogger();

      return this.config;
    } catch (error) {
      // Use console.error directly here since logger may not be initialized yet
      console.error('[ConfigLoader] Failed to load configuration:', error.message);

      // Return default configuration as fallback
      this.config = this.getDefaultConfig();
      this.isLoaded = true;

      return this.config;
    }
  }

  /**
   * Get configuration value by path
   * @param {string} path - Dot notation path (e.g., "crawler.limits.maxPages")
   * @param {*} defaultValue - Default value if path not found
   */
  get(path, defaultValue = null) {
    if (!this.isLoaded) {
      return defaultValue;
    }

    const keys = path.split('.');
    let value = this.config;

    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = value[key];
      } else {
        return defaultValue;
      }
    }

    return value;
  }

  /**
   * Set configuration value (in memory only, not persisted)
   * @param {string} path - Dot notation path
   * @param {*} value - Value to set
   */
  set(path, value) {
    if (!this.isLoaded) {
      return;
    }

    const keys = path.split('.');
    let obj = this.config;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i];
      if (!(key in obj) || typeof obj[key] !== 'object') {
        obj[key] = {};
      }
      obj = obj[key];
    }

    obj[keys[keys.length - 1]] = value;
  }

  /**
   * Get entire configuration object
   */
  getAll() {
    return this.config;
  }

  /**
   * Get default configuration (fallback)
   */
  getDefaultConfig() {
    return {
      version: "11.0.0",
      appName: "QAtalyst - AI Test Case Generator",

      crawler: {
        enabled: true,
        limits: {
          maxPages: 1000,
          maxDepth: 10,
          maxQueueSize: 5000,
          timeout: 300000,
          pageTimeout: 30000
        },
        delays: {
          betweenPages: 1000,
          pageLoad: 2000,
          dynamicContent: 1500,
          retryDelay: 3000
        },
        features: {
          recursiveCrawl: true,
          followSameOriginOnly: true,
          detectSPARoutes: true,
          useSitemap: true,
          captureScreenshots: false,
          monitorNetwork: true,
          extractForms: true,
          extractTables: true,
          extractButtons: true,
          extractNavigation: true,
          extractModals: true
        },
        exclusions: {
          extensions: [
            "jpg", "jpeg", "png", "gif", "svg", "ico",
            "pdf", "zip", "exe", "dmg", "mp4", "mp3",
            "woff", "woff2", "ttf", "eot", "css", "js"
          ],
          patterns: [
            "/api/",
            "/download/",
            "/logout",
            "/signout",
            "mailto:",
            "tel:",
            "javascript:"
          ],
          maxQueryLength: 200
        }
      },

      embeddings: {
        enabled: false,
        provider: {
          default: "openai",
          options: ["openai", "chrome-ai"],
          fallbackOrder: ["openai", "chrome-ai"]
        },
        models: {
          openai: {
            model: "text-embedding-3-small",
            dimensions: 1536,
            batchSize: 100,
            costPer1MTokens: 0.02
          },
          chromeAI: {
            model: "gemini-nano",
            dimensions: 768,
            enabled: false
          }
        },
        search: {
          topK: 5,
          minScore: 0.3,
          maxResults: 10,
          cacheEnabled: true,
          cacheSize: 100
        }
      },

      network: {
        enabled: true,
        capture: {
          requests: true,
          responses: true,
          headers: true,
          payloads: true,
          timing: true
        },
        filters: {
          captureAPIs: true,
          captureGraphQL: true,
          captureREST: true,
          ignoreStatic: true,
          maxPayloadSize: 10240
        },
        endpoints: {
          apiPatterns: ["/api/", "/rest/", "/graphql", "/v1/", "/v2/"],
          excludePatterns: [
            "google-analytics",
            "doubleclick",
            "facebook.com",
            "twitter.com",
            "hotjar",
            "mixpanel",
            "segment.io"
          ]
        }
      },

      domExtraction: {
        enabled: true,
        features: {
          forms: {
            enabled: true,
            maxForms: 10,
            captureValidation: true,
            captureFields: true
          },
          tables: {
            enabled: true,
            maxTables: 10,
            captureHeaders: true,
            captureActions: true,
            minRows: 1
          },
          buttons: {
            enabled: true,
            maxButtons: 50,
            captureDisabled: true,
            captureActions: false
          },
          navigation: {
            enabled: true,
            maxItems: 20,
            captureSubmenus: true
          },
          modals: {
            enabled: true,
            maxModals: 5,
            captureHidden: false
          },
          cards: {
            enabled: true,
            maxCards: 20,
            maxContentLength: 100
          },
          lists: {
            enabled: true,
            maxLists: 10,
            minItems: 3,
            maxItemsPerList: 10
          }
        }
      },

      storage: {
        storageType: "indexeddb",
        dbName: "QAtalystEmbeddings",
        dbVersion: 1,
        maxStorageSize: 52428800,
        compressionEnabled: true
      },

      performance: {
        timeouts: {
          request: 90000,
          retry: 2000,
          maxRetries: 2
        },
        limits: {
          maxTextExtractLength: 30000,
          maxConcurrentRequests: 5
        },
        cache: {
          enabled: true,
          ttl: 3600000,
          maxSize: 100
        }
      }
    };
  }

  /**
   * Initialize logger with configuration settings
   * @private
   */
  _initializeLogger() {
    if (typeof logger !== 'undefined' && logger) {
      const logLevel = this.get('logging.level', 'warn');
      const productionMode = this.get('logging.productionMode', true);
      const enabled = this.get('logging.enabled', true);

      logger.setLevel(logLevel);
      logger.setProductionMode(productionMode);
      logger.setEnabled(enabled);
    }
  }

  /**
   * Validate configuration structure
   */
  validate() {
    if (!this.isLoaded) {
      return false;
    }

    // Check required top-level keys
    const requiredKeys = ['version', 'crawler', 'embeddings', 'network', 'storage'];
    for (const key of requiredKeys) {
      if (!(key in this.config)) {
        if (typeof logger !== 'undefined') {
          logger.error(`Missing required config key: ${key}`);
        }
        return false;
      }
    }

    return true;
  }

  /**
   * Reload configuration (for testing/development)
   */
  async reload() {
    this.isLoaded = false;
    this.config = null;
    return await this.load();
  }
}

// Global singleton instance
const CONFIG = new ConfigLoader();

// Export for use in all modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ConfigLoader, CONFIG };
}
