/**
 * Cache Manager for External Integrations
 * Based on JiraShastra's NodeCache implementation
 */

class CacheManager {
  constructor(options = {}) {
    this.cache = new Map();
    this.publicCache = new Map();
    this.ttl = options.ttl || 3600000; // 1 hour default
    this.checkInterval = options.checkInterval || 600000; // 10 minutes
    this.maxSize = options.maxSize || 100; // Maximum cache entries

    // Start cleanup interval
    this.startCleanup();
  }

  /**
   * Get item from cache
   * @param {string} key - Cache key
   * @param {boolean} isPublic - Whether to use public cache
   * @returns {*} - Cached value or null
   */
  get(key, isPublic = false) {
    const cache = isPublic ? this.publicCache : this.cache;
    const item = cache.get(key);

    if (!item) {
      return null;
    }

    // Check if expired
    if (Date.now() > item.expires) {
      cache.delete(key);
      return null;
    }

    // Update last accessed time for LRU
    item.lastAccessed = Date.now();
    return item.data;
  }

  /**
   * Set item in cache
   * @param {string} key - Cache key
   * @param {*} data - Data to cache
   * @param {number} ttl - Optional TTL in milliseconds
   * @param {boolean} isPublic - Whether to use public cache
   */
  set(key, data, ttl = null, isPublic = false) {
    const cache = isPublic ? this.publicCache : this.cache;

    // Enforce max size using LRU
    if (cache.size >= this.maxSize) {
      this.evictLRU(cache);
    }

    cache.set(key, {
      data: data,
      expires: Date.now() + (ttl || this.ttl),
      lastAccessed: Date.now()
    });
  }

  /**
   * Check if cache has a valid entry
   * @param {string} key - Cache key
   * @param {boolean} isPublic - Whether to use public cache
   * @returns {boolean} - True if has valid entry
   */
  has(key, isPublic = false) {
    return this.get(key, isPublic) !== null;
  }

  /**
   * Delete item from cache
   * @param {string} key - Cache key
   * @param {boolean} isPublic - Whether to use public cache
   */
  delete(key, isPublic = false) {
    const cache = isPublic ? this.publicCache : this.cache;
    cache.delete(key);
  }

  /**
   * Clear cache
   * @param {boolean} isPublic - Whether to clear public cache
   */
  clear(isPublic = false) {
    if (isPublic) {
      this.publicCache.clear();
    } else {
      this.cache.clear();
    }
  }

  /**
   * Clear all caches
   */
  clearAll() {
    this.cache.clear();
    this.publicCache.clear();
  }

  /**
   * Evict least recently used item
   * @param {Map} cache - Cache to evict from
   */
  evictLRU(cache) {
    let oldestKey = null;
    let oldestTime = Date.now();

    for (const [key, item] of cache.entries()) {
      if (item.lastAccessed < oldestTime) {
        oldestTime = item.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      cache.delete(oldestKey);
      console.log(`[Cache] Evicted LRU item: ${oldestKey}`);
    }
  }

  /**
   * Start cleanup interval
   */
  startCleanup() {
    setInterval(() => {
      this.cleanup();
    }, this.checkInterval);
  }

  /**
   * Cleanup expired entries
   */
  cleanup() {
    const now = Date.now();
    let cleanedCount = 0;

    // Clean main cache
    for (const [key, item] of this.cache.entries()) {
      if (now > item.expires) {
        this.cache.delete(key);
        cleanedCount++;
      }
    }

    // Clean public cache
    for (const [key, item] of this.publicCache.entries()) {
      if (now > item.expires) {
        this.publicCache.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`[Cache] Cleaned up ${cleanedCount} expired entries`);
    }
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      mainCacheSize: this.cache.size,
      publicCacheSize: this.publicCache.size,
      maxSize: this.maxSize,
      ttl: this.ttl
    };
  }

  /**
   * Generate cache key for integration content
   * @param {string} service - Service name (confluence, figma, googledocs)
   * @param {string} id - Document/page ID or URL
   * @returns {string} - Cache key
   */
  static getCacheKey(service, id) {
    // Create a consistent cache key
    const cleanId = id.replace(/[^a-zA-Z0-9-_]/g, '_').substring(0, 50);
    return `${service}:${cleanId}`;
  }
}

// Export singleton instance
const cacheManager = new CacheManager({
  ttl: 3600000, // 1 hour
  checkInterval: 600000, // 10 minutes
  maxSize: 100 // Maximum 100 entries per cache
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = cacheManager;
}