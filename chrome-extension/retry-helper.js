/**
 * Retry Helper with Circuit Breaker Pattern
 * Based on JiraShastra's enterprise implementation
 */

class RetryHelper {
  constructor() {
    this.circuitBreakers = new Map();
    this.retryConfigs = new Map();
  }

  /**
   * Create a circuit breaker for a service
   * @param {string} serviceName - Name of the service
   * @param {Object} options - Circuit breaker options
   * @returns {CircuitBreaker} - Circuit breaker instance
   */
  createCircuitBreaker(serviceName, options = {}) {
    const breaker = new CircuitBreaker({
      name: serviceName,
      failureThreshold: options.failureThreshold || 3,
      resetTimeout: options.resetTimeout || 120000, // 2 minutes
      monitorInterval: options.monitorInterval || 30000 // 30 seconds
    });

    this.circuitBreakers.set(serviceName, breaker);
    return breaker;
  }

  /**
   * Execute a function with retry logic
   * @param {string} serviceName - Name of the service
   * @param {string} operationName - Name of the operation
   * @param {Function} fn - Function to execute
   * @param {Object} options - Retry options
   * @returns {Promise} - Result of the function
   */
  async forService(serviceName, operationName, fn, options = {}) {
    const maxRetries = options.maxRetries || 3;
    const baseDelay = options.baseDelay || 1000;
    const maxDelay = options.maxDelay || 30000;
    const shouldRetry = options.shouldRetry || this.isRetryableError;

    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        console.log(`[${serviceName}] ${operationName}: Attempt ${attempt + 1}/${maxRetries + 1}`);

        // Execute the function
        const result = await fn();

        // Reset failure count on success
        const breaker = this.circuitBreakers.get(serviceName);
        if (breaker) {
          breaker.recordSuccess();
        }

        return result;

      } catch (error) {
        lastError = error;

        // Record failure in circuit breaker
        const breaker = this.circuitBreakers.get(serviceName);
        if (breaker) {
          breaker.recordFailure();
        }

        // Check if we should retry
        if (!shouldRetry(error)) {
          console.error(`[${serviceName}] ${operationName}: Non-retryable error:`, error.message);
          throw error;
        }

        // Check if we have retries left
        if (attempt === maxRetries) {
          console.error(`[${serviceName}] ${operationName}: Max retries exceeded`);
          throw error;
        }

        // Calculate delay with exponential backoff
        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);

        // Add jitter to prevent thundering herd
        const jitter = Math.random() * delay * 0.1;
        const totalDelay = delay + jitter;

        console.log(`[${serviceName}] ${operationName}: Retrying in ${Math.round(totalDelay)}ms...`);
        await new Promise(resolve => setTimeout(resolve, totalDelay));
      }
    }

    throw lastError || new Error(`${serviceName}: ${operationName} failed after ${maxRetries} retries`);
  }

  /**
   * Check if an error is retryable
   * @param {Error} error - The error to check
   * @returns {boolean} - True if the error is retryable
   */
  isRetryableError(error) {
    // Network errors
    if (error.code === 'ECONNRESET' ||
        error.code === 'ETIMEDOUT' ||
        error.code === 'ENOTFOUND' ||
        error.code === 'ECONNREFUSED') {
      return true;
    }

    // HTTP status codes that are retryable
    if (error.response) {
      const status = error.response.status;

      // Rate limiting - always retry
      if (status === 429) {
        return true;
      }

      // Server errors - usually retryable
      if (status >= 500 && status < 600) {
        return true;
      }

      // Request timeout
      if (status === 408) {
        return true;
      }
    }

    // Specific error messages
    if (error.message && (
        error.message.includes('ECONNRESET') ||
        error.message.includes('socket hang up') ||
        error.message.includes('timeout') ||
        error.message.includes('network')
    )) {
      return true;
    }

    return false;
  }
}

/**
 * Circuit Breaker implementation
 */
class CircuitBreaker {
  constructor(options = {}) {
    this.name = options.name || 'unnamed';
    this.failureThreshold = options.failureThreshold || 3;
    this.resetTimeout = options.resetTimeout || 120000; // 2 minutes
    this.monitorInterval = options.monitorInterval || 30000; // 30 seconds

    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.successCount = 0;

    // Start monitoring
    this.startMonitoring();
  }

  /**
   * Execute a function through the circuit breaker
   * @param {Function} fn - Function to execute
   * @returns {Promise} - Result of the function
   */
  async execute(fn) {
    // Check circuit state
    if (this.state === 'OPEN') {
      // Check if we should try half-open
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        console.log(`[CircuitBreaker ${this.name}] Attempting half-open state`);
        this.state = 'HALF_OPEN';
      } else {
        throw new Error(`Circuit breaker open for ${this.name}: Too many failures`);
      }
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /**
   * Record a successful execution
   */
  recordSuccess() {
    this.successCount++;

    if (this.state === 'HALF_OPEN') {
      // Success in half-open state, close the circuit
      console.log(`[CircuitBreaker ${this.name}] Circuit closed after successful half-open test`);
      this.state = 'CLOSED';
      this.failureCount = 0;
    }
  }

  /**
   * Record a failed execution
   */
  recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      // Failed in half-open state, reopen the circuit
      console.log(`[CircuitBreaker ${this.name}] Circuit reopened after half-open failure`);
      this.state = 'OPEN';
    } else if (this.failureCount >= this.failureThreshold) {
      // Too many failures, open the circuit
      console.log(`[CircuitBreaker ${this.name}] Circuit opened after ${this.failureCount} failures`);
      this.state = 'OPEN';
    }
  }

  /**
   * Start monitoring the circuit breaker
   */
  startMonitoring() {
    setInterval(() => {
      if (this.state === 'OPEN' && Date.now() - this.lastFailureTime > this.resetTimeout) {
        console.log(`[CircuitBreaker ${this.name}] Reset timeout reached, ready for half-open`);
      }
    }, this.monitorInterval);
  }

  /**
   * Get current circuit state
   */
  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime
    };
  }
}

// Export singleton instance
const retryHelper = new RetryHelper();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = retryHelper;
}