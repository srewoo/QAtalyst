/**
 * content-crawler.js — the crawler's in-page side: answers the background
 * crawler's extractDOM / getErrorPatterns / getPageHints / discoverLinks /
 * getMetadata / extractTextContent / detectSPAFramework messages, and shows the
 * crawl-complete modal. Moved verbatim out of content.js.
 *
 * IIFE publishing an explicit api on window (content scripts share one global
 * scope). Depends on DOMExtractor and content-utils.js globals.
 */
(function () {
  'use strict';

  // ============ WEB CRAWLER HANDLERS ============

  /**
   * Extract DOM features from current page
   */
  function handleExtractDOM(sendResponse) {
    try {
      const features = [];

      // Extract forms
      document.querySelectorAll('form').forEach((form, index) => {
        const inputs = Array.from(form.querySelectorAll('input, textarea, select')).map(input => ({
          type: input.type || input.tagName.toLowerCase(),
          name: input.name || input.id || `unnamed-${index}`,
          required: input.required || input.hasAttribute('required'),
          placeholder: input.placeholder || ''
        }));

        features.push({
          type: 'form',
          id: form.id || form.name || `form-${index}`,
          action: form.action || '',
          method: form.method || 'get',
          inputs: inputs,
          buttonCount: form.querySelectorAll('button, input[type="submit"]').length
        });
      });

      // Extract tables
      document.querySelectorAll('table').forEach((table, index) => {
        const headers = Array.from(table.querySelectorAll('th')).map(th => th.textContent.trim());
        const rowCount = table.querySelectorAll('tr').length;

        features.push({
          type: 'table',
          id: table.id || `table-${index}`,
          headers: headers,
          rowCount: rowCount,
          columnCount: headers.length || table.querySelectorAll('td').length
        });
      });

      // Extract buttons
      document.querySelectorAll('button, input[type="button"], input[type="submit"], a[role="button"]').forEach((button, index) => {
        features.push({
          type: 'button',
          id: button.id || `button-${index}`,
          text: button.textContent.trim() || button.value || '',
          classes: button.className || ''
        });
      });

      // Extract navigation
      document.querySelectorAll('nav, [role="navigation"]').forEach((nav, index) => {
        const links = Array.from(nav.querySelectorAll('a')).map(a => ({
          text: a.textContent.trim(),
          href: a.href
        }));

        features.push({
          type: 'navigation',
          id: nav.id || `nav-${index}`,
          linkCount: links.length,
          links: links.slice(0, 20) // Limit to first 20 links
        });
      });

      // Extract modals/dialogs
      document.querySelectorAll('[role="dialog"], .modal, .dialog').forEach((modal, index) => {
        features.push({
          type: 'modal',
          id: modal.id || `modal-${index}`,
          visible: modal.style.display !== 'none' && !modal.hasAttribute('hidden'),
          classes: modal.className || ''
        });
      });

      sendResponse({ features });
    } catch (error) {
      console.error('Error extracting DOM:', error);
      sendResponse({ features: [], error: error.message });
    }
  }

  /**
   * NEW: Handle get error patterns request
   */
  function handleGetErrorPatterns(sendResponse) {
    try {
      const extractor = new DOMExtractor();
      extractor.extract(); // This populates errorPatterns
      const errorPatterns = extractor.getErrorPatterns();
      sendResponse({ errorPatterns });
    } catch (error) {
      console.error('Error getting error patterns:', error);
      sendResponse({ errorPatterns: [], error: error.message });
    }
  }

  /**
   * NEW: Handle get page hints request
   */
  function handleGetPageHints(sendResponse) {
    try {
      const extractor = new DOMExtractor();
      extractor.extract(); // This populates pageHints
      const pageHints = extractor.getPageHints();
      sendResponse({ pageHints });
    } catch (error) {
      console.error('Error getting page hints:', error);
      sendResponse({ pageHints: {}, error: error.message });
    }
  }

  /**
   * Discover links on current page
   */
  function handleDiscoverLinks(baseUrl, sendResponse) {
    try {
      const links = new Set();
      const baseOrigin = new URL(baseUrl).origin;

      document.querySelectorAll('a[href]').forEach(anchor => {
        try {
          const href = anchor.href;

          // Skip non-http(s) links
          if (!href.startsWith('http://') && !href.startsWith('https://')) {
            return;
          }

          const url = new URL(href);

          // Only include same-origin links
          if (url.origin !== baseOrigin) {
            return;
          }

          // Skip common non-page URLs
          if (
            href.includes('#') ||
            href.match(/\.(pdf|jpg|jpeg|png|gif|svg|ico|css|js|zip|tar|gz)$/i) ||
            href.includes('logout') ||
            href.includes('signout')
          ) {
            return;
          }

          // Clean URL (remove hash and query parameters for deduplication)
          const cleanUrl = `${url.origin}${url.pathname}`;
          links.add(cleanUrl);
        } catch (e) {
          // Skip invalid URLs
        }
      });

      sendResponse({ links: Array.from(links) });
    } catch (error) {
      console.error('Error discovering links:', error);
      sendResponse({ links: [], error: error.message });
    }
  }

  /**
   * Get page metadata
   */
  function handleGetMetadata(sendResponse) {
    try {
      const metadata = {
        title: document.title || '',
        description: document.querySelector('meta[name="description"]')?.content || '',
        url: window.location.href,
        loadTime: performance.timing.loadEventEnd - performance.timing.navigationStart || 0
      };

      sendResponse(metadata);
    } catch (error) {
      console.error('Error getting metadata:', error);
      sendResponse({ title: '', description: '', url: window.location.href, loadTime: 0 });
    }
  }

  /**
   * Extract main text content from page
   */
  function handleExtractTextContent(maxLength, sendResponse) {
    console.log('🔧 handleExtractTextContent called');

    try {
      // Check if DOMExtractor is available
      if (typeof DOMExtractor === 'undefined') {
        console.error('❌ DOMExtractor is not defined!');
        sendResponse({ textContent: null, error: 'DOMExtractor not loaded' });
        return;
      }

      const extractor = new DOMExtractor();
      const textContent = extractor.extractTextContent(maxLength || 5000);

      console.log(`📝 Extracted ${textContent ? textContent.length : 0} chars of text content`);

      sendResponse({ textContent: textContent });
    } catch (error) {
      console.error('❌ Error extracting text content:', error);
      console.error('Stack:', error.stack);
      sendResponse({ textContent: null, error: error.message });
    }
  }

  /**
   * Show crawl complete modal notification
   */
  function showCrawlCompleteModal(result) {
    // Remove any existing modal
    const existingModal = document.getElementById('qatalyst-crawl-complete-modal');
    if (existingModal) {
      existingModal.remove();
    }

    // Create modal HTML
    const modal = document.createElement('div');
    modal.id = 'qatalyst-crawl-complete-modal';
    modal.innerHTML = `
      <div class="qatalyst-modal-content">
        <div class="qatalyst-modal-header">
          <span class="qatalyst-modal-icon">✅</span>
          <h3>Crawl Complete!</h3>
          <button class="qatalyst-modal-close" aria-label="Close">&times;</button>
        </div>
        <div class="qatalyst-modal-body">
          <div class="qatalyst-modal-stat">
            <strong>${result.pages}</strong> pages
          </div>
          <div class="qatalyst-modal-stat">
            <strong>${result.features}</strong> features
          </div>
          <div class="qatalyst-modal-stat">
            <strong>${result.apis}</strong> APIs
          </div>
          ${result.embeddings > 0 ? `
            <div class="qatalyst-modal-stat">
              <strong>${result.embeddings}</strong> embeddings ${result.cost > 0 ? '($' + result.cost.toFixed(4) + ')' : '(FREE)'}
            </div>
          ` : ''}
        </div>
        <div class="qatalyst-modal-footer">
          <button class="qatalyst-modal-button">View Results</button>
        </div>
      </div>
    `;

    // Add styles
    const style = document.createElement('style');
    style.textContent = `
      #qatalyst-crawl-complete-modal {
        position: fixed;
        top: 20px;
        right: 20px;
        z-index: 999999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
        animation: qatalystSlideIn 0.3s ease-out;
      }

      @keyframes qatalystSlideIn {
        from {
          transform: translateX(400px);
          opacity: 0;
        }
        to {
          transform: translateX(0);
          opacity: 1;
        }
      }

      @keyframes qatalystSlideOut {
        from {
          transform: translateX(0);
          opacity: 1;
        }
        to {
          transform: translateX(400px);
          opacity: 0;
        }
      }

      .qatalyst-modal-content {
        background: white;
        border-radius: 12px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
        min-width: 320px;
        max-width: 400px;
        overflow: hidden;
      }

      .qatalyst-modal-header {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        padding: 16px 20px;
        display: flex;
        align-items: center;
        gap: 12px;
        position: relative;
      }

      .qatalyst-modal-icon {
        font-size: 24px;
      }

      .qatalyst-modal-header h3 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
        flex: 1;
      }

      .qatalyst-modal-close {
        background: none;
        border: none;
        color: white;
        font-size: 28px;
        line-height: 1;
        cursor: pointer;
        padding: 0;
        width: 28px;
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 4px;
        transition: background 0.2s;
      }

      .qatalyst-modal-close:hover {
        background: rgba(255, 255, 255, 0.2);
      }

      .qatalyst-modal-body {
        padding: 20px;
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }

      .qatalyst-modal-stat {
        flex: 1 1 calc(50% - 6px);
        background: #f7fafc;
        padding: 12px;
        border-radius: 8px;
        text-align: center;
        font-size: 14px;
        color: #4a5568;
      }

      .qatalyst-modal-stat strong {
        display: block;
        font-size: 24px;
        font-weight: 700;
        color: #2d3748;
        margin-bottom: 4px;
      }

      .qatalyst-modal-footer {
        padding: 0 20px 20px;
      }

      .qatalyst-modal-button {
        width: 100%;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        border: none;
        padding: 12px 20px;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: transform 0.2s, box-shadow 0.2s;
      }

      .qatalyst-modal-button:hover {
        transform: translateY(-1px);
        box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
      }

      .qatalyst-modal-button:active {
        transform: translateY(0);
      }
    `;

    // Append to page
    document.body.appendChild(style);
    document.body.appendChild(modal);

    // Add event listeners
    const closeBtn = modal.querySelector('.qatalyst-modal-close');
    const viewBtn = modal.querySelector('.qatalyst-modal-button');

    const closeModal = () => {
      modal.style.animation = 'qatalystSlideOut 0.3s ease-out';
      setTimeout(() => {
        modal.remove();
        style.remove();
      }, 300);
    };

    closeBtn.addEventListener('click', closeModal);
    viewBtn.addEventListener('click', () => {
      // Open extension popup
      chrome.runtime.sendMessage({ action: 'openPopup' });
      closeModal();
    });

    // Auto-close after 10 seconds
    setTimeout(closeModal, 10000);
  }

  /**
   * P2.8: Detect SPA framework (React, Vue, Angular)
   * Used to wait for hydration before extracting data
   */
  function handleDetectSPAFramework(sendResponse) {
    let framework = null;

    // Detect React
    if (window.React || window.__REACT_DEVTOOLS_GLOBAL_HOOK__ || document.querySelector('[data-reactroot], [data-reactid]')) {
      framework = 'React';
    }
    // Detect Vue
    else if (window.Vue || window.__VUE__ || document.querySelector('[data-v-app], [data-v-]')) {
      framework = 'Vue';
    }
    // Detect Angular
    else if (window.angular || window.ng || document.querySelector('[ng-version], [ng-app]')) {
      framework = 'Angular';
    }
    // Detect Svelte
    else if (window.__SVELTE__ || document.querySelector('[svelte-]')) {
      framework = 'Svelte';
    }

    sendResponse({ framework: framework });
  }

  // ============ END WEB CRAWLER HANDLERS ============

  // The crawler injects this file (not content.js) into every page of the app
  // under test; it is also a manifest content script on Jira pages. Injection can
  // repeat on the same document, so register the listener once.
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage && !globalThis.__qatalystCrawlerListener) {
    globalThis.__qatalystCrawlerListener = true;
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'extractDOM') {
        handleExtractDOM(sendResponse);
        return true; // Keep message channel open for async response
      }
      if (request.action === 'discoverLinks') {
        handleDiscoverLinks(request.baseUrl, sendResponse);
        return true; // Keep message channel open for async response
      }
      if (request.action === 'getMetadata') {
        handleGetMetadata(sendResponse);
        return true; // Keep message channel open for async response
      }
      if (request.action === 'extractTextContent') {
        console.log(`📩 Received extractTextContent request (maxLength: ${request.maxLength})`);
        handleExtractTextContent(request.maxLength, sendResponse);
        return true; // Keep message channel open for async response
      }
      if (request.action === 'showCrawlCompleteModal') {
        showCrawlCompleteModal(request.result);
        return true;
      }
      // P2.8: SPA framework detection
      if (request.action === 'detectSPAFramework') {
        handleDetectSPAFramework(sendResponse);
        return true;
      }
      // NEW: Get error patterns from page
      if (request.action === 'getErrorPatterns') {
        handleGetErrorPatterns(sendResponse);
        return true;
      }
      // NEW: Get page hints for testing
      if (request.action === 'getPageHints') {
        handleGetPageHints(sendResponse);
        return true;
      }
    });
  }

  const api = {
    handleExtractDOM,
    handleGetErrorPatterns,
    handleGetPageHints,
    handleDiscoverLinks,
    handleGetMetadata,
    handleExtractTextContent,
    showCrawlCompleteModal,
    handleDetectSPAFramework,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  // content.js (loaded after this file) calls these by bare name.
  if (typeof window !== 'undefined') Object.assign(window, api);
  if (typeof self !== 'undefined') self.QAtalystContentCrawler = api;
})();
