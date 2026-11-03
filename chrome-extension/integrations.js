// External Integrations System for QAtalyst — core: CircuitBreaker + IntegrationManager.
// The integrations themselves live in integrations-docs.js (Confluence, Figma,
// Google Docs), integrations-testrail.js and integrations-testmgmt.js (Zephyr,
// Xray, Qmetry). Load order: this file first, then those three.

/**
 * Lightweight Circuit Breaker for Chrome Extension
 * Prevents cascading failures by stopping requests after repeated failures
 */
class CircuitBreaker {
  constructor(options = {}) {
    this.name = options.name || 'unnamed';
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 120000; // 2 minutes
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.successCount = 0;
  }

  async execute(fn) {
    // Check circuit state
    if (this.state === 'OPEN') {
      // Check if we should try half-open
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        console.log(`[CircuitBreaker ${this.name}] Attempting half-open state`);
        this.state = 'HALF_OPEN';
      } else {
        const waitSeconds = Math.ceil((this.resetTimeout - (Date.now() - this.lastFailureTime)) / 1000);
        throw new Error(`Circuit breaker open for ${this.name}: Too many failures. Try again in ${waitSeconds} seconds.`);
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

  recordSuccess() {
    this.successCount++;
    if (this.state === 'HALF_OPEN') {
      console.log(`[CircuitBreaker ${this.name}] Circuit closed after successful half-open test`);
      this.state = 'CLOSED';
      this.failureCount = 0;
    }
  }

  recordFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.state === 'HALF_OPEN') {
      console.log(`[CircuitBreaker ${this.name}] Circuit reopened after half-open failure`);
      this.state = 'OPEN';
    } else if (this.failureCount >= this.failureThreshold) {
      console.log(`[CircuitBreaker ${this.name}] Circuit opened after ${this.failureCount} failures`);
      this.state = 'OPEN';
    }
  }

  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime
    };
  }
}

class IntegrationManager {
  constructor(settings) {
    this.settings = settings;
    this.confluence = new ConfluenceIntegration(settings);
    this.figma = new FigmaIntegration(settings);
    this.googleDocs = new GoogleDocsIntegration(settings);
  }

  /**
   * Fetch multiple Confluence pages in parallel with concurrency control
   */
  async fetchConfluencePages(urls) {
    console.log(`📄 [IntegrationManager] fetchConfluencePages called with ${urls.length} URLs`);
    console.log(`📄 [IntegrationManager] Confluence URLs to fetch:`, urls);
    const results = [];
    const concurrencyLimit = 3; // Max 3 concurrent requests

    // Process URLs in batches
    for (let i = 0; i < urls.length; i += concurrencyLimit) {
      const batch = urls.slice(i, i + concurrencyLimit);
      const batchPromises = batch.map(async (url) => {
        try {
          const content = await this.confluence.fetchPage(url);
          if (content && !content.content.startsWith('Error:')) {
            console.log(`IntegrationManager: Fetched Confluence content for ${url}`);
            return content;
          } else {
            console.warn(`IntegrationManager: Skipped Confluence page (fetch failed or empty): ${url}`);
            return {
              url: url,
              name: 'Confluence page (unavailable)',
              content: null,
              error: 'Fetch returned empty or error content'
            };
          }
        } catch (error) {
          console.error('IntegrationManager: Confluence fetch failed for', url, ':', error.message);
          return {
            url: url,
            name: 'Confluence page (unavailable)',
            content: null,
            error: error.message
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults.filter(r => r !== null));
    }

    return results;
  }

  /**
   * Fetch multiple Figma files with rate limiting
   */
  async fetchFigmaFiles(urls) {
    console.log(`🎨 [IntegrationManager] fetchFigmaFiles called with ${urls.length} URLs`);
    console.log(`🎨 [IntegrationManager] Figma URLs to fetch:`, urls);
    const results = [];

    for (let i = 0; i < urls.length; i++) {
      try {
        // Add delay between requests to respect rate limits
        if (i > 0) {
          await new Promise(resolve =>
            setTimeout(resolve, typeof CONFIG !== 'undefined' ? CONFIG.FIGMA_RATE_LIMIT_DELAY : 1000)
          );
        }

        const fileKey = this.figma.extractFileKey(urls[i]);
        const content = await this.figma.fetchFile(urls[i]);

        if (content && !content.specifications.startsWith('Error:')) {
          // Fetch images for identified nodes
          let images = [];
          if (fileKey && content.nodesForImageExport && content.nodesForImageExport.length > 0) {
            images = await this.figma.fetchNodeImages(fileKey, content.nodesForImageExport);
            console.log(`IntegrationManager: Fetched ${images.length} images for Figma file ${urls[i]}`);
          }

          results.push({ ...content, images });
          console.log(`IntegrationManager: Fetched Figma content for ${urls[i]}`);
        } else {
          console.warn(`IntegrationManager: Skipped Figma file (fetch failed or empty): ${urls[i]}`);
        }
      } catch (error) {
        console.error('IntegrationManager: Figma fetch failed for', urls[i], ':', error.message);
        results.push({
          url: urls[i],
          name: 'Figma design (unavailable)',
          specifications: `Could not fetch Figma content. Reason: ${error.message}`,
          lastModified: null,
          version: null,
          images: []
        });
      }
    }

    return results;
  }

  /**
   * Fetch multiple Google Docs in parallel with concurrency control
   */
  async fetchGoogleDocs(urls) {
    const results = [];
    const concurrencyLimit = 3; // Max 3 concurrent requests

    // Process URLs in batches
    for (let i = 0; i < urls.length; i += concurrencyLimit) {
      const batch = urls.slice(i, i + concurrencyLimit);
      const batchPromises = batch.map(async (url) => {
        try {
          const content = await this.googleDocs.fetchDocument(url);
          if (content && !content.content.startsWith('Error:')) {
            console.log(`IntegrationManager: Fetched Google Docs content for ${url}`);
            return content;
          } else {
            console.warn(`IntegrationManager: Skipped Google Doc (fetch failed or empty): ${url}`);
            return {
              url: url,
              name: 'Google Doc (unavailable)',
              content: null,
              error: 'Fetch returned empty or error content'
            };
          }
        } catch (error) {
          console.error('IntegrationManager: Google Docs fetch failed for', url, ':', error.message);
          return {
            url: url,
            name: 'Google Doc (unavailable)',
            content: null,
            error: error.message
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults.filter(r => r !== null));
    }

    return results;
  }

  async fetchAllLinkedContent(ticketData) {
    console.log('🔗 [IntegrationManager] Starting fetchAllLinkedContent');
    console.log('🔗 [IntegrationManager] Settings configured:', {
      hasConfluence: !!(this.settings.confluenceUrl && this.settings.confluenceEmail && this.settings.confluenceToken),
      hasFigma: !!this.settings.figmaToken,
      hasGoogleDocs: true  // Public docs work without an API key via the export endpoint
    });

    // Log detailed configuration status for debugging
    if (!this.settings.confluenceUrl || !this.settings.confluenceEmail || !this.settings.confluenceToken) {
      console.warn('⚠️ [IntegrationManager] Confluence not fully configured:', {
        hasUrl: !!this.settings.confluenceUrl,
        hasEmail: !!this.settings.confluenceEmail,
        hasToken: !!this.settings.confluenceToken
      });
    }
    if (!this.settings.figmaToken) {
      console.warn('⚠️ [IntegrationManager] Figma not configured (missing token)');
    }

    const results = {
      confluence: [],
      figma: [],
      googleDocs: [],
      enrichedDescription: ticketData.description || ''
    };

    // First, try to use linkedPages if available (these are extracted from DOM)
    let confluenceUrls = [];
    let figmaUrls = [];
    let googleDocsUrls = [];

    if (ticketData.linkedPages && Array.isArray(ticketData.linkedPages)) {
      console.log('🔗 [IntegrationManager] Using linkedPages from DOM:', ticketData.linkedPages.length);

      // Extract URLs from linkedPages based on their type
      confluenceUrls = ticketData.linkedPages
        .filter(page => page.type === 'confluence')
        .map(page => page.url);

      figmaUrls = ticketData.linkedPages
        .filter(page => page.type === 'figma')
        .map(page => page.url);

      googleDocsUrls = ticketData.linkedPages
        .filter(page => page.type === 'google_docs' || page.type === 'google_drive')
        .map(page => page.url);
    }

    // F25: ALWAYS scan the ticket text too, and union per integration.
    //
    // This used to run only when ALL THREE lists were empty — so a single
    // Confluence link in linkedPages suppressed discovery of a Figma URL that
    // existed solely in a comment, and of a Google Doc linked in the description.
    // Discovery for one source must not depend on what another source found.
    {
      const allText = [
        ticketData.description || '',
        ...(ticketData.comments || []).map(c => c.text || c.body || '')
      ].join('\n');
      console.log('🔗 [IntegrationManager] Scanning ticket text for links, length:', allText.length);

      const union = (a, b) => {
        const seen = new Set();
        const out = [];
        for (const u of [...(a || []), ...(b || [])]) {
          // Normalize so the same page linked in the DOM and in text is one source.
          const key = String(u || '').trim().replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          out.push(u);
        }
        return out;
      };

      confluenceUrls = union(confluenceUrls, this.confluence.extractUrls(allText));
      figmaUrls = union(figmaUrls, this.figma.extractUrls(allText));
      googleDocsUrls = union(googleDocsUrls, this.googleDocs.extractUrls(allText));
    }

    console.log('🔗 [IntegrationManager] Extracted URLs:', {
      confluence: confluenceUrls.length,
      figma: figmaUrls.length,
      googleDocs: googleDocsUrls.length
    });

    if (confluenceUrls.length > 0) console.log('  📄 Confluence URLs:', confluenceUrls);
    if (figmaUrls.length > 0) console.log('  🎨 Figma URLs:', figmaUrls);
    if (googleDocsUrls.length > 0) console.log('  📝 Google Docs URLs:', googleDocsUrls);

    // Fetch from all integrations in parallel
    const fetchTasks = [];

    if (confluenceUrls.length > 0) {
      console.log(`📄 [IntegrationManager] Processing ${confluenceUrls.length} Confluence URLs`);
      // Never log any part of a credential — a token prefix is still token
      // material, and these logs are readable by anything with console access.
      console.log(`📄 [IntegrationManager] Confluence configuration:`, {
        hasUrl: !!this.settings.confluenceUrl,
        hasEmail: !!this.settings.confluenceEmail,
        hasToken: !!this.settings.confluenceToken
      });

      // Only fetch if Confluence is properly configured
      if (this.settings.confluenceUrl && this.settings.confluenceEmail && this.settings.confluenceToken) {
        console.log('✅ [IntegrationManager] Confluence configured, adding fetch task');
        fetchTasks.push(this.fetchConfluencePages(confluenceUrls));
      } else {
        console.error('❌ [IntegrationManager] Confluence URLs found but integration not properly configured');
        console.error('   Required: confluenceUrl, confluenceEmail, and confluenceToken');
        console.error('   Settings keys present:', Object.keys(this.settings));
      }
    }
    if (figmaUrls.length > 0) {
      console.log(`🎨 [IntegrationManager] Processing ${figmaUrls.length} Figma URLs`);
      console.log(`🎨 [IntegrationManager] Figma token present:`, !!this.settings.figmaToken);

      // Only fetch if Figma is properly configured
      if (this.settings.figmaToken) {
        console.log('✅ [IntegrationManager] Figma configured, adding fetch task');
        fetchTasks.push(this.fetchFigmaFiles(figmaUrls));
      } else {
        console.error('❌ [IntegrationManager] Figma URLs found but integration not configured (missing figmaToken)');
        console.error('   Settings keys present:', Object.keys(this.settings));
      }
    }
    if (googleDocsUrls.length > 0) {
      // Public Google Docs work without an API key (uses the public export endpoint).
      // Fetch whenever URLs are found — no credential gate needed.
      fetchTasks.push(this.fetchGoogleDocs(googleDocsUrls));
    }

    // Track which tasks were actually added (to properly map results)
    const taskTypes = [];
    if (confluenceUrls.length > 0 && this.settings.confluenceUrl && this.settings.confluenceEmail && this.settings.confluenceToken) {
      taskTypes.push('confluence');
    }
    if (figmaUrls.length > 0 && this.settings.figmaToken) {
      taskTypes.push('figma');
    }
    if (googleDocsUrls.length > 0) {
      taskTypes.push('googleDocs');
    }

    // Wait for all integrations to complete (use allSettled to not fail on errors)
    const fetchResults = await Promise.allSettled(fetchTasks);

    // Process results - match by task type, not URL presence
    const errors = [];

    taskTypes.forEach((taskType, index) => {
      const result = fetchResults[index];
      if (!result) return;

      if (result.status === 'fulfilled') {
        if (taskType === 'confluence') {
          results.confluence = result.value;
          console.log('✅ [IntegrationManager] Confluence fetch successful:', results.confluence.length, 'pages');
        } else if (taskType === 'figma') {
          results.figma = result.value;
          console.log('✅ [IntegrationManager] Figma fetch successful:', results.figma.length, 'files');
        } else if (taskType === 'googleDocs') {
          results.googleDocs = result.value;
          console.log('✅ [IntegrationManager] Google Docs fetch successful:', results.googleDocs.length, 'documents');
        }
      } else {
        console.error(`❌ [IntegrationManager] ${taskType} fetch failed:`, result.reason);
        errors.push({ type: taskType, error: result.reason?.message || 'Unknown error' });
      }
    });
    
    // Log any errors
    if (errors.length > 0) {
      console.warn('⚠️ [IntegrationManager] Some integrations failed:', errors);
    }
    
    // Enrich description with external content
    if (results.confluence.length > 0) {
      results.enrichedDescription += '\n\n## Confluence Requirements:\n' +
        results.confluence.map(c => c.content).join('\n\n');
    }
    
    if (results.figma.length > 0) {
      results.enrichedDescription += '\n\n## Figma Design Specifications:\n' +
        results.figma.map(f => f.specifications).join('\n\n');
    }
    
    if (results.googleDocs.length > 0) {
      results.enrichedDescription += '\n\n## Google Docs Content:\n' +
        results.googleDocs.map(d => d.content).join('\n\n');
    }

    console.log('✅ [IntegrationManager] Final results:', {
      confluence: results.confluence.length,
      figma: results.figma.length,
      googleDocs: results.googleDocs.length,
      enrichedDescriptionLength: results.enrichedDescription.length,
      errors: errors.length
    });
    
    return results;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  // Export the core BEFORE requiring the integration files: they require this
  // file back for CircuitBreaker / IntegrationManager.
  module.exports = { CircuitBreaker, IntegrationManager };
  const docs = require('./integrations-docs.js');
  Object.assign(module.exports, docs, require('./integrations-testrail.js'), require('./integrations-testmgmt.js'));
  // IntegrationManager's constructor resolves the doc integrations by bare name;
  // in the browser they are globals, in Node give it the same view.
  Object.assign(globalThis, docs);
} else {
  Object.assign(globalThis, { CircuitBreaker, IntegrationManager });
}
