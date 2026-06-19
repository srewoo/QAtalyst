/**
 * Unified Rate Limiter for QAtalyst
 * Handles rate limiting across all API integrations with exponential backoff
 * and retry-after header support
 *
 * NOTE: Currently UNUSED — loaded via importScripts but getRateLimiter() is never called.
 * Each API function (callOpenAI, callClaude, callGemini, callBedrock) implements
 * its own retry logic with exponential backoff instead.
 * TODO: Wire into API calls or remove to reduce service worker load.
 */

class RateLimiter {
  constructor(options = {}) {
    this.requestsPerMinute = options.requestsPerMinute || 60;
    this.maxConcurrent = options.maxConcurrent || 5;
    this.retryAttempts = options.retryAttempts || 3;
    this.baseBackoffMs = options.baseBackoffMs || 1000;

    // Queue and state management
    this.queue = [];
    this.activeRequests = 0;
    this.processing = false;
    this.requestTimestamps = [];
  }

  /**
   * Execute a function with rate limiting
   * @param {Function} fn - Async function to execute
   * @param {Object} options - Execution options
   * @returns {Promise} - Result of the function
   */
  async execute(fn, options = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        fn,
        resolve,
        reject,
        retries: options.retries !== undefined ? options.retries : this.retryAttempts,
        priority: options.priority || 0
      });

      // Sort queue by priority (higher priority first)
      this.queue.sort((a, b) => b.priority - a.priority);

      this.processQueue();
    });
  }

  /**
   * Process the request queue
   */
  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0 && this.activeRequests < this.maxConcurrent) {
      // Check if we're within rate limit
      if (!this.canMakeRequest()) {
        const waitTime = this.getWaitTime();
        await this.sleep(waitTime);
        continue;
      }

      const task = this.queue.shift();
      this.activeRequests++;
      this.requestTimestamps.push(Date.now());

      // Execute the task with retry logic
      this.executeWithRetry(task)
        .then(result => {
          task.resolve(result);
        })
        .catch(error => {
          task.reject(error);
        })
        .finally(() => {
          this.activeRequests--;
          this.processQueue(); // Continue processing queue
        });
    }

    this.processing = false;
  }

  /**
   * Execute a task with exponential backoff retry logic
   * @param {Object} task - Task object with fn and retry count
   * @returns {Promise} - Result of the function
   */
  async executeWithRetry(task) {
    let lastError = null;
    let attempt = 0;

    while (attempt <= task.retries) {
      try {
        const result = await task.fn();
        return result;
      } catch (error) {
        lastError = error;
        attempt++;

        // Check if it's a rate limit error (429)
        if (this.isRateLimitError(error) && attempt <= task.retries) {
          const retryAfter = this.getRetryAfterFromError(error);
          const backoffTime = retryAfter || this.calculateBackoff(attempt);

          console.warn(`Rate limit hit, retrying after ${backoffTime}ms (attempt ${attempt}/${task.retries})`);
          await this.sleep(backoffTime);
          continue;
        }

        // For other errors, apply exponential backoff
        if (attempt <= task.retries) {
          const backoffTime = this.calculateBackoff(attempt);
          console.warn(`Request failed, retrying after ${backoffTime}ms (attempt ${attempt}/${task.retries})`);
          await this.sleep(backoffTime);
          continue;
        }

        // Max retries exceeded
        break;
      }
    }

    throw lastError;
  }

  /**
   * Check if we can make a request within the rate limit
   * @returns {boolean} - True if we can make a request
   */
  canMakeRequest() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;

    // Remove timestamps older than 1 minute
    this.requestTimestamps = this.requestTimestamps.filter(ts => ts > oneMinuteAgo);

    return this.requestTimestamps.length < this.requestsPerMinute;
  }

  /**
   * Calculate how long to wait before making next request
   * @returns {number} - Wait time in milliseconds
   */
  getWaitTime() {
    if (this.requestTimestamps.length === 0) {
      return 0;
    }

    const oldestTimestamp = this.requestTimestamps[0];
    const timeSinceOldest = Date.now() - oldestTimestamp;
    const timeToWait = Math.max(0, 60000 - timeSinceOldest + 100); // Add 100ms buffer

    return timeToWait;
  }

  /**
   * Calculate exponential backoff time
   * @param {number} attempt - Retry attempt number
   * @returns {number} - Backoff time in milliseconds
   */
  calculateBackoff(attempt) {
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s...
    const backoff = this.baseBackoffMs * Math.pow(2, attempt - 1);
    // Add jitter (random 0-20% variation) to prevent thundering herd
    const jitter = backoff * 0.2 * Math.random();
    return Math.min(backoff + jitter, 60000); // Cap at 60 seconds
  }

  /**
   * Check if error is a rate limit error
   * @param {Error} error - Error object
   * @returns {boolean} - True if rate limit error
   */
  isRateLimitError(error) {
    if (!error) return false;

    // Check for 429 status code
    if (error.status === 429 || error.statusCode === 429) {
      return true;
    }

    // Check error message
    const message = error.message || error.toString();
    return message.includes('rate limit') ||
           message.includes('too many requests') ||
           message.includes('429');
  }

  /**
   * Extract Retry-After value from error
   * @param {Error} error - Error object
   * @returns {number|null} - Retry-after time in milliseconds, or null
   */
  getRetryAfterFromError(error) {
    // Try to get Retry-After from response headers
    if (error.response && error.response.headers) {
      const retryAfter = error.response.headers.get('Retry-After') ||
                        error.response.headers.get('retry-after');

      if (retryAfter) {
        // Can be either seconds or HTTP date
        const seconds = parseInt(retryAfter);
        if (!isNaN(seconds)) {
          return seconds * 1000;
        }

        // Try parsing as date
        const date = new Date(retryAfter);
        if (!isNaN(date.getTime())) {
          return Math.max(0, date.getTime() - Date.now());
        }
      }
    }

    return null;
  }

  /**
   * Sleep for specified milliseconds
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise} - Resolves after sleep
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get current queue status
   * @returns {Object} - Status object
   */
  getStatus() {
    return {
      queueLength: this.queue.length,
      activeRequests: this.activeRequests,
      requestsInLastMinute: this.requestTimestamps.length,
      canMakeRequest: this.canMakeRequest()
    };
  }

  /**
   * Clear the queue and reset state
   */
  clear() {
    this.queue = [];
    this.activeRequests = 0;
    this.requestTimestamps = [];
    this.processing = false;
  }
}

/**
 * Rate limiter instances for different services
 */
const rateLimiters = {
  openai: new RateLimiter({
    requestsPerMinute: 3500,
    maxConcurrent: 5,
    retryAttempts: 3
  }),
  claude: new RateLimiter({
    requestsPerMinute: 50, // Conservative - actual limit is 50,000 TPM
    maxConcurrent: 5,
    retryAttempts: 3
  }),
  gemini: new RateLimiter({
    requestsPerMinute: 60, // Conservative - actual limit is 10,000/min
    maxConcurrent: 5,
    retryAttempts: 3
  }),
  bedrock: new RateLimiter({
    requestsPerMinute: 50, // Conservative - varies by provisioned throughput
    maxConcurrent: 5,
    retryAttempts: 3
  }),
  figma: new RateLimiter({
    requestsPerMinute: 60, // Conservative - actual limit is 1,000/min
    maxConcurrent: 3,
    retryAttempts: 3
  }),
  confluence: new RateLimiter({
    requestsPerMinute: 50, // Conservative - actual limit is 60/min
    maxConcurrent: 3,
    retryAttempts: 3
  }),
  googleDocs: new RateLimiter({
    requestsPerMinute: 50,
    maxConcurrent: 3,
    retryAttempts: 3
  }),
  evolution: new RateLimiter({
    requestsPerMinute: 30, // Conservative for evolution calls
    maxConcurrent: 5,
    retryAttempts: 3
  })
};

/**
 * Get rate limiter for a specific service
 * @param {string} service - Service name
 * @returns {RateLimiter} - Rate limiter instance
 */
function getRateLimiter(service) {
  return rateLimiters[service] || new RateLimiter();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RateLimiter, getRateLimiter, rateLimiters };
}
