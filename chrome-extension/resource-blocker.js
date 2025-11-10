/**
 * Resource Blocker - Speed Up Crawling
 * Version: 1.0.0
 * Blocks heavy resources (images, fonts, CSS) during crawling
 */

class ResourceBlocker {
  constructor() {
    this.isActive = false;
    this.ruleId = 100000; // High ID to avoid conflicts
  }

  /**
   * Initialize and cleanup any leftover rules from previous sessions
   * Should be called on extension startup
   */
  async initialize() {
    try {
      // Remove any leftover blocking rules from previous sessions
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [this.ruleId]
      });

      this.isActive = false;
      console.log('✅ Resource blocker initialized - removed any leftover rules');
    } catch (error) {
      console.warn('⚠️ Failed to cleanup resource blocker rules:', error);
    }
  }

  /**
   * Start blocking resources for crawling
   * @param {string} targetDomain - Domain to block resources for (e.g., "example.com")
   */
  async start(targetDomain = null) {
    if (this.isActive) {
      console.log('⚠️ Resource blocker already active');
      return;
    }

    const config = {
      blockImages: CONFIG.get('crawler.resourceBlocking.blockImages', true),
      blockFonts: CONFIG.get('crawler.resourceBlocking.blockFonts', true),
      blockCSS: CONFIG.get('crawler.resourceBlocking.blockCSS', false),
      blockMedia: CONFIG.get('crawler.resourceBlocking.blockMedia', true),
      allowScripts: CONFIG.get('crawler.resourceBlocking.allowScripts', true)
    };

    console.log('🚫 Starting resource blocker:', config);

    // Extract domain from URL if provided
    let domain = targetDomain;
    if (domain && domain.includes('://')) {
      try {
        domain = new URL(domain).hostname;
      } catch (e) {
        console.warn('Invalid domain URL:', domain);
        domain = null;
      }
    }

    if (!domain) {
      console.warn('⚠️ No target domain specified - resource blocking will affect ALL sites!');
      console.warn('⚠️ This can break other open tabs. Highly recommended to specify a domain.');
    }

    try {
      // Build resource types to block
      const resourceTypes = [];

      if (config.blockImages) {
        resourceTypes.push('image');
      }
      if (config.blockFonts) {
        resourceTypes.push('font');
      }
      if (config.blockCSS) {
        resourceTypes.push('stylesheet');
      }
      if (config.blockMedia) {
        resourceTypes.push('media');
      }

      if (resourceTypes.length === 0) {
        console.log('ℹ️ No resources to block');
        return;
      }

      // Create blocking rule with domain filter
      const condition = {
        resourceTypes: resourceTypes,
        // Exclude localhost/127.0.0.1 to allow local testing
        excludedInitiatorDomains: ['localhost', '127.0.0.1']
      };

      // CRITICAL: Only block resources from the target domain
      // This prevents breaking other open tabs
      if (domain) {
        condition.requestDomains = [domain];
        console.log(`🎯 Resource blocking limited to domain: ${domain}`);
      } else {
        console.warn('🌍 GLOBAL resource blocking active - ALL tabs affected!');
      }

      const rules = [{
        id: this.ruleId,
        priority: 1,
        action: { type: 'block' },
        condition: condition
      }];

      // Add the rule using declarativeNetRequest
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: rules,
        removeRuleIds: [this.ruleId] // Remove if already exists
      });

      this.isActive = true;
      console.log(`✅ Resource blocker active - blocking ${resourceTypes.join(', ')}`);

    } catch (error) {
      console.error('❌ Failed to start resource blocker:', error);
      // Fallback: Try to use tab-specific settings
      this.isActive = false;
    }
  }

  /**
   * Stop blocking resources
   */
  async stop() {
    if (!this.isActive) {
      return;
    }

    console.log('🟢 Stopping resource blocker...');

    try {
      // Remove the blocking rule
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [this.ruleId]
      });

      this.isActive = false;
      console.log('✅ Resource blocker stopped');

    } catch (error) {
      console.error('❌ Failed to stop resource blocker:', error);
    }
  }

  /**
   * Check if blocker is active
   */
  isBlocking() {
    return this.isActive;
  }

  /**
   * Get estimated bandwidth savings
   */
  getEstimatedSavings() {
    if (!this.isActive) {
      return 0;
    }

    // Rough estimates:
    // - Images: ~2MB per page average
    // - CSS: ~200KB per page
    // - Fonts: ~300KB per page
    // - Media: ~1MB per page

    const config = {
      blockImages: CONFIG.get('crawler.resourceBlocking.blockImages', true),
      blockFonts: CONFIG.get('crawler.resourceBlocking.blockFonts', true),
      blockCSS: CONFIG.get('crawler.resourceBlocking.blockCSS', true),
      blockMedia: CONFIG.get('crawler.resourceBlocking.blockMedia', true)
    };

    let savingsPerPage = 0;

    if (config.blockImages) savingsPerPage += 2 * 1024 * 1024; // 2MB
    if (config.blockCSS) savingsPerPage += 200 * 1024; // 200KB
    if (config.blockFonts) savingsPerPage += 300 * 1024; // 300KB
    if (config.blockMedia) savingsPerPage += 1024 * 1024; // 1MB

    return savingsPerPage;
  }

  /**
   * Alternative: Set content settings for specific tab (fallback method)
   * Note: This requires "contentSettings" permission in manifest
   */
  async setTabContentSettings(tabId, enable) {
    try {
      const settings = {
        images: enable ? 'block' : 'allow',
        javascript: 'allow' // Always allow JS for dynamic content
      };

      // This would require contentSettings API which needs special permissions
      // Keeping this as a placeholder for potential future use
      console.log('ℹ️ Tab-specific content settings not implemented (requires additional permissions)');

    } catch (error) {
      console.warn('Content settings not available:', error);
    }
  }
}

// Export for use in crawler
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ResourceBlocker;
}
