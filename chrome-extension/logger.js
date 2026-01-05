// Logger utility for QAtalyst
// Provides structured logging with levels and production mode support

// Prevent redeclaration errors if script is injected multiple times
if (typeof Logger === 'undefined') {
  const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
    NONE: 4
  };

  class Logger {
    constructor(module = 'QAtalyst') {
      this.module = module;
      this.level = LOG_LEVELS.INFO; // Default to INFO level
      this.enabled = true;
      this.productionMode = false;
    }

    /**
     * Set the minimum log level
     * @param {string} level - 'debug', 'info', 'warn', 'error', 'none'
     */
    setLevel(level) {
      const normalizedLevel = level.toUpperCase();
      if (LOG_LEVELS.hasOwnProperty(normalizedLevel)) {
        this.level = LOG_LEVELS[normalizedLevel];
      }
    }

    /**
     * Enable or disable all logging
     * @param {boolean} enabled
     */
    setEnabled(enabled) {
      this.enabled = enabled;
    }

    /**
     * Enable production mode (only errors logged)
     * @param {boolean} production
     */
    setProductionMode(production) {
      this.productionMode = production;
      if (production) {
        this.level = LOG_LEVELS.ERROR;
      }
    }

    /**
     * Create a child logger with a specific module name
     * @param {string} module - Module name for prefixing logs
     * @returns {Logger}
     */
    createChild(module) {
      const child = new Logger(module);
      child.level = this.level;
      child.enabled = this.enabled;
      child.productionMode = this.productionMode;
      return child;
    }

    /**
     * Format the log message with timestamp and module
     * @private
     */
    _format(level, args) {
      const timestamp = new Date().toISOString().substr(11, 12);
      const prefix = `[${timestamp}] [${this.module}]`;
      return [prefix, ...args];
    }

    /**
     * Check if the given level should be logged
     * @private
     */
    _shouldLog(level) {
      return this.enabled && level >= this.level;
    }

    /**
     * Debug level logging - for development only
     */
    debug(...args) {
      if (this._shouldLog(LOG_LEVELS.DEBUG)) {
        console.log(...this._format('DEBUG', args));
      }
    }

    /**
     * Info level logging - general information
     */
    info(...args) {
      if (this._shouldLog(LOG_LEVELS.INFO)) {
        console.log(...this._format('INFO', args));
      }
    }

    /**
     * Warning level logging - potential issues
     */
    warn(...args) {
      if (this._shouldLog(LOG_LEVELS.WARN)) {
        console.warn(...this._format('WARN', args));
      }
    }

    /**
     * Error level logging - always logged unless disabled
     */
    error(...args) {
      if (this._shouldLog(LOG_LEVELS.ERROR)) {
        console.error(...this._format('ERROR', args));
      }
    }

    /**
     * Group related logs together
     */
    group(label) {
      if (this._shouldLog(LOG_LEVELS.DEBUG)) {
        console.group(`[${this.module}] ${label}`);
      }
    }

    /**
     * End a log group
     */
    groupEnd() {
      if (this._shouldLog(LOG_LEVELS.DEBUG)) {
        console.groupEnd();
      }
    }

    /**
     * Log with custom emoji prefix (common pattern in this codebase)
     */
    emoji(emoji, ...args) {
      if (this._shouldLog(LOG_LEVELS.INFO)) {
        console.log(emoji, ...this._format('INFO', args));
      }
    }
  }

  // Create singleton instance
  const logger = new Logger('QAtalyst');

  // Load log level from config if available
  if (typeof CONFIG !== 'undefined' && CONFIG.get) {
    try {
      const configLevel = CONFIG.get('logging.level', 'info');
      const productionMode = CONFIG.get('logging.productionMode', false);
      logger.setLevel(configLevel);
      logger.setProductionMode(productionMode);
    } catch (e) {
      // CONFIG not ready yet, use defaults
    }
  }

  // Make globally available
  if (typeof window !== 'undefined') {
    window.Logger = Logger;
    window.logger = logger;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.Logger = Logger;
    globalThis.logger = logger;
  }
}
