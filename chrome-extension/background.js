// Background service worker for QAtalyst
// Direct API calls to OpenAI, Claude, and Gemini with streaming support
// Multi-agent test generation system

// Import configuration loader (must be first)
importScripts('config-loader.js');

// Import configuration and utilities
importScripts('config.js');
importScripts('logger.js');
importScripts('security.js');
importScripts('rate-limiter.js');
importScripts('token-counter.js');
importScripts('context-manager.js');
importScripts('graph-filter.js');
importScripts('bm25.js');
importScripts('json-parser.js');
importScripts('text-similarity.js');
importScripts('embeddings.js');
importScripts('background-utils.js');
importScripts('llm-client.js');
importScripts('prompts.js');
importScripts('integrations.js');
importScripts('historical-mining.js');

// Import NEW validation and quality systems
importScripts('context-checker.js');
importScripts('semantic-duplicate-detector.js');
importScripts('coverage-mapper.js');

// Agentic test-generation core (planner loop + grounded verification + acceptance gate)
// Load order matters: verifier/distribution have no deps; acceptance-gate needs
// GroundedVerifier + SemanticDuplicateDetector; agent-loop uses DynamicDistribution.
importScripts('grounded-verifier.js');
importScripts('dynamic-distribution.js');
importScripts('acceptance-gate.js');
importScripts('agent-tools.js');
importScripts('agent-loop.js');

// Import web crawler modules
importScripts('crawler-auth.js');
importScripts('crawler.js');
importScripts('dom-extractor.js');
importScripts('link-discoverer.js');
importScripts('network-monitor.js');
importScripts('sitemap-parser.js');
importScripts('resource-blocker.js');
importScripts('spa-route-discoverer.js');
importScripts('smart-wait.js');
importScripts('storage-manager.js');
importScripts('knowledge-graph-merger.js');
importScripts('crawler-handlers.js');

// Use constants from legacy config
const REQUEST_TIMEOUT = APP_CONFIG.REQUEST_TIMEOUT;
const MAX_RETRIES = APP_CONFIG.MAX_RETRIES;
const RETRY_DELAY = APP_CONFIG.RETRY_DELAY;

// Streaming safeguards
const STREAMING_TIMEOUT_MS = 300000; // 5 minutes max for streaming
const MAX_STREAMING_ITERATIONS = 50000; // Max chunks to prevent infinite loops

// Safe data URI parser for image parts
function parseDataUri(dataUri) {
  if (!dataUri || typeof dataUri !== 'string') {
    return { base64Data: null, mediaType: 'image/png' };
  }
  const commaIdx = dataUri.indexOf(',');
  const base64Data = commaIdx >= 0 ? dataUri.substring(commaIdx + 1) : null;
  let mediaType = 'image/png';
  const colonIdx = dataUri.indexOf(':');
  const semicolonIdx = dataUri.indexOf(';');
  if (colonIdx >= 0 && semicolonIdx > colonIdx) {
    mediaType = dataUri.substring(colonIdx + 1, semicolonIdx) || 'image/png';
  }
  return { base64Data, mediaType };
}

// Active streaming controllers for cancellation
const activeStreams = (typeof self !== 'undefined') ? (self.activeStreams = self.activeStreams || new Map()) : new Map();

// Active test management integration (for cancellation)
let activeIntegration = null;

// Active multi-agent orchestrator (for cancellation)

// Active agentic planner abort handles (a Set so Epic Mode's concurrent
// per-story generations can ALL be cancelled by a single stop, not just the
// most-recently-started one).
const activeAgenticAborts = new Set();

// Web Crawler state management - initialize AFTER config loads
let activeCrawler = null;
let storageManager = null; // Will be created after config loads
const globalResourceBlocker = new ResourceBlocker();

// Promise that resolves when storage is ready
let storageReady = null;

// Load configuration on startup, THEN initialize storage
storageReady = CONFIG.load().then(() => {
  console.log('✅ QAtalyst configuration loaded');

  // NOW create and initialize storage manager (after config is loaded)
  storageManager = new StorageManager();
  return storageManager.init();
}).then(() => {
  console.log('✅ Storage manager initialized');
  return true;
}).catch(err => {
  console.error('❌ Failed to load configuration or initialize storage:', err);
  throw err;
});

// Helper to ensure storage is ready before use
async function ensureStorageReady() {
  await storageReady;
  if (!storageManager) {
    throw new Error('Storage manager failed to initialize');
  }
  return storageManager;
}

// Initialize resource blocker and cleanup any leftover rules
globalResourceBlocker.initialize().catch(err => console.error('Resource blocker init failed:', err));

// Clear any stale crawl flags on startup
// This handles cases where extension was reloaded during a crawl
chrome.storage.local.get(['activeCrawl'], (result) => {
  if (result.activeCrawl) {
    logger.warn('Found stale crawl flag on startup, clearing...');
    chrome.storage.local.remove('activeCrawl').catch(err => {
      logger.error('Failed to clear stale crawl flag:', err.message);
    });
  }
});

// P0.3: Service Worker Heartbeat - Prevent service worker crashes during long crawls
// Persists crawl state every 10 seconds to allow auto-resume if service worker restarts
let heartbeatInterval = null;

function startCrawlHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  console.log('💓 Starting crawl heartbeat (checkpoint every 10s)');

  heartbeatInterval = setInterval(async () => {
    if (!activeCrawler) {
      console.log('💓 No active crawler, stopping heartbeat');
      stopCrawlHeartbeat();
      return;
    }

    try {
      // MEMORY OPTIMIZATION: Save minimal checkpoint to avoid quota issues
      const checkpoint = createCheckpoint(activeCrawler);

      await chrome.storage.local.set({ crawlCheckpoint: checkpoint });
      logger.debug(`Heartbeat: checkpoint saved (${checkpoint.visitedCount} visited, ${checkpoint.queueSize} queued)`);
    } catch (error) {
      logger.error('Failed to save heartbeat checkpoint:', error.message);
      // If storage quota exceeded, try clearing old data
      if (error.message?.includes('QUOTA')) {
        logger.warn('Storage quota exceeded, clearing old checkpoints...');
        chrome.storage.local.remove('crawlCheckpoint').catch(clearErr => {
          logger.error('Failed to clear checkpoint:', clearErr.message);
        });
      }
    }
  }, 10000); // Every 10 seconds
}

function stopCrawlHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    logger.debug('Stopped crawl heartbeat');
  }

  // Clear checkpoint - non-critical cleanup
  chrome.storage.local.remove('crawlCheckpoint').catch(err => {
    logger.warn('Failed to clear crawl checkpoint:', err.message);
  });
}

/**
 * MEMORY OPTIMIZATION: Reduce checkpoint size
 * Only save essential data to prevent storage quota issues
 */
function createCheckpoint(crawler) {
  return {
    crawlId: crawler.crawlId,
    startUrl: crawler.startUrl,
    startTime: crawler.startTime,
    visitedCount: crawler.visited.size,
    queueSize: Math.min(crawler.queue.length, 50), // Only save first 50 queue items
    pagesCount: crawler.pages.length,
    batchNumber: crawler.batchNumber,
    timestamp: Date.now()
  };
}

// Diagnostic function for troubleshooting
async function runDiagnostics() {
  console.log('🔍 ========== QAtalyst Diagnostics ==========');
  
  try {
    // Check settings
    const settings = await chrome.storage.sync.get([
      'llmProvider', 'llmModel', 'apiKey', 'enableStreaming',
      'confluenceUrl', 'confluenceEmail', 'confluenceToken', 'figmaToken', 'googleApiKey'
    ]);
    
    console.log('⚙️ Settings Check:');
    console.log('  Provider:', settings.llmProvider || '❌ NOT SET');
    console.log('  Model:', settings.llmModel || '❌ NOT SET');
    // Never log any portion of the secret — presence only.
    console.log('  API Key:', settings.apiKey ? '✅ SET' : '❌ NOT SET');
    console.log('  Streaming:', settings.enableStreaming !== false ? '✅ Enabled' : '⚠️ Disabled');
    
    console.log('\n🔗 Integrations Check:');
    console.log('  Confluence:', settings.confluenceUrl && settings.confluenceEmail && settings.confluenceToken ? '✅ Configured' : '⚠️ Not configured (needs URL, email, and token)');
    console.log('  Figma:', settings.figmaToken ? '✅ Configured' : '⚠️ Not configured');
    console.log('  Google Docs:', settings.googleApiKey ? '✅ Configured' : '⚠️ Not configured');
    
    // Check active streams
    console.log('\n🌊 Active Streams:', activeStreams.size);
    if (activeStreams.size > 0) {
      console.log('  Request IDs:', Array.from(activeStreams.keys()));
    }
    
    // Check extension version
    const manifest = chrome.runtime.getManifest();
    console.log('\n📦 Extension Info:');
    console.log('  Name:', manifest.name);
    console.log('  Version:', manifest.version);
    console.log('  Manifest Version:', manifest.manifest_version);
    
    // Test API key validation
    if (settings.apiKey && settings.llmProvider) {
      const isValid = securityManager.validateApiKey(settings.apiKey, settings.llmProvider);
      console.log('\n🔑 API Key Validation:', isValid ? '✅ Valid format' : '❌ Invalid format');
    }
    
    console.log('\n✅ Diagnostics complete!');
    console.log('💡 Tip: If you see issues, try reloading the extension at chrome://extensions');
    
    return {
      success: true,
      settings,
      activeStreams: activeStreams.size,
      version: manifest.version
    };
  } catch (error) {
    console.error('❌ Diagnostics failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Make diagnostics available globally for console access
globalThis.QAtalystDiagnostics = runDiagnostics;

// Helper function to safely send messages to tabs (ignores if tab/content script doesn't exist)
function safeSendMessageToTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(error => {
    // Silently ignore "Receiving end does not exist" errors
    if (!error.message?.includes('Receiving end does not exist')) {
      console.error('Error sending message to tab:', error);
    }
  });
}

/**
 * Fetch image from URL using background script's broader permissions
 * This bypasses CORS restrictions that content scripts face
 * @param {string} url - Image URL to fetch
 * @returns {object} - {success, data (base64), mimeType} or {success: false, error}
 */
async function fetchImageFromBackground(url) {
  console.log(`📷 [Background] Fetching image: ${url.substring(0, 80)}...`);

  try {
    // Build headers — add Basic Auth for Jira/Atlassian URLs if credentials are stored
    const fetchHeaders = { 'Accept': 'image/*, */*' };
    const isJiraUrl = url.includes('atlassian.net') || url.includes('atlassian.com') || url.includes('jira.com');
    if (isJiraUrl) {
      const { jiraEmail, jiraApiToken } = await chrome.storage.sync.get(['jiraEmail', 'jiraApiToken']);
      if (jiraEmail && jiraApiToken) {
        let token = jiraApiToken;
        try {
          const sm = globalThis.securityManager;
          if (sm && sm.decryptApiKeyFromStorage) {
            token = await sm.decryptApiKeyFromStorage(jiraApiToken);
          }
        } catch (_) { /* use raw token if decrypt fails */ }
        fetchHeaders['Authorization'] = 'Basic ' + btoa(`${jiraEmail}:${token}`);
      }
    }

    const response = await fetch(url, {
      credentials: 'include',
      headers: fetchHeaders
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const blob = await response.blob();

    // Check if it's actually an image
    if (!blob.type.startsWith('image/')) {
      throw new Error(`Not an image: ${blob.type}`);
    }

    // Skip very small images (less than 1KB)
    if (blob.size < 1024) {
      throw new Error(`Image too small: ${blob.size} bytes`);
    }

    // Convert to base64
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });

    console.log(`✅ [Background] Fetched image (${(blob.size / 1024).toFixed(2)} KB)`);

    return {
      success: true,
      data: base64,
      mimeType: blob.type,
      size: blob.size
    };
  } catch (error) {
    console.warn(`⚠️ [Background] Failed to fetch image: ${error.message}`);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Fetch a Jira attachment and extract its text content.
 * Supports: PDF (raw text extraction), TXT, MD, CSV, plain text formats.
 * Returns extracted text — NOT base64 — so it can be sent as context to the LLM.
 */
async function fetchAndExtractDocument(url, fileName, jiraEmail, jiraApiToken) {
  console.log(`📄 [Background] Extracting document: ${fileName}`);
  try {
    const fetchHeaders = { 'Accept': '*/*' };
    const isJiraUrl = url.includes('atlassian.net') || url.includes('atlassian.com') || url.includes('jira.com');
    if (isJiraUrl && jiraEmail && jiraApiToken) {
      fetchHeaders['Authorization'] = 'Basic ' + btoa(`${jiraEmail}:${jiraApiToken}`);
    }

    const response = await fetch(url, { credentials: 'include', headers: fetchHeaders });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = response.headers.get('content-type') || '';
    const ext = (fileName.split('.').pop() || '').toLowerCase();

    // Plain-text formats — read directly as text
    if (['txt', 'md', 'csv', 'log', 'json', 'xml', 'yaml', 'yml'].includes(ext) ||
        contentType.includes('text/')) {
      const text = await response.text();
      return { success: true, text: text.slice(0, 20000), fileName, type: 'text' };
    }

    // PDF — extract text from raw bytes using regex (no external lib needed)
    if (ext === 'pdf' || contentType.includes('pdf')) {
      const arrayBuffer = await response.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      const raw = new TextDecoder('latin1').decode(bytes);

      // Extract text from PDF stream objects using simple pattern matching
      // Works for most non-scanned PDFs that have embedded text streams
      const textChunks = [];
      const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
      let match;
      while ((match = streamRegex.exec(raw)) !== null) {
        const streamContent = match[1];
        // Extract text operators: (text)Tj / [(text)]TJ / BT...ET blocks
        const textOps = streamContent.match(/\(([^)\\]|\\.)*\)\s*Tj|\[(([^[\]\\]|\\.)*)\]\s*TJ/g) || [];
        for (const op of textOps) {
          // Decode escaped PDF string literals
          const inner = op.replace(/^\[?\s*|\s*\]?\s*TJ$|\s*Tj$/g, '');
          const decoded = inner.replace(/\(([^)\\]|\\.)*\)/g, m => {
            return m.slice(1, -1)
              .replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
              .replace(/\\\\/g, '\\').replace(/\\(.)/g, '$1');
          }).replace(/\s+/g, ' ');
          if (decoded.trim().length > 1) textChunks.push(decoded.trim());
        }
      }

      const extracted = textChunks.join(' ').replace(/\s+/g, ' ').trim();
      if (extracted.length > 50) {
        return { success: true, text: extracted.slice(0, 20000), fileName, type: 'pdf' };
      }
      // Scanned/image-only PDF — no embedded text streams found.
      // Return the raw bytes as base64 so a vision-capable LLM can read it.
      console.warn(`⚠️ [Background] ${fileName}: no text streams found, returning as base64 for vision LLM`);
      const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
      return {
        success: true,
        text: '',          // no text to inject as markdown
        base64,            // caller may pass this as an image part to a vision model
        mimeType: 'application/pdf',
        isScannedPdf: true,
        fileName,
        type: 'scanned-pdf'
      };
    }

    // DOCX — extract from XML content inside zip (basic extraction)
    if (ext === 'docx' || contentType.includes('officedocument')) {
      // We can't unzip in a service worker without a library, so note it
      return { success: false, error: 'DOCX files require a zip parser. Consider converting to PDF or TXT.', fileName };
    }

    return { success: false, error: `Unsupported document type: ${ext}`, fileName };
  } catch (error) {
    console.warn(`⚠️ [Background] Document extraction failed: ${error.message}`);
    return { success: false, error: error.message, fileName };
  }
}

// Message handler
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Fetch image from URL (background script has broader permissions)
  // Used for CORS-blocked images in Jira
  if (request.action === 'fetchImage') {
    fetchImageFromBackground(request.url)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'fetchDocument') {
    fetchAndExtractDocument(request.url, request.fileName, request.jiraEmail, request.jiraApiToken)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // Get filtered crawl data based on Jira ticket keywords
  if (request.action === 'getFilteredCrawlData') {
    getFilteredCrawlData(request.keywords, request.maxSizeKB)
      .then(result => sendResponse({ success: true, summary: result.summary, matchedPages: result.matchedPages }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // Get crawl data from storage (populated by Settings page crawler)
  if (request.action === 'getCrawlData') {
    getCrawlDataFromStorage()
      .then(data => sendResponse({ success: true, data: data }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'analyzeRequirements') {
    handleAnalyzeRequirements(request.data)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  if (request.action === 'generateTestScope') {
    handleGenerateTestScope(request.data)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  if (request.action === 'generateTestCases') {
    handleGenerateTestCases(request.data)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  // Streaming actions — immediately ACK to release the message channel,
  // then deliver the final result via safeSendMessageToTab('streamComplete').
  // This prevents "message channel closed before response" in MV3 service workers.
  if (request.action === 'analyzeRequirementsStream') {
    const tabId = sender.tab.id;
    sendResponse({ started: true }); // release channel immediately
    handleAnalyzeRequirementsStream(request.data, tabId)
      .then(result => safeSendMessageToTab(tabId, { action: 'streamComplete', streamType: 'analyze', result }))
      .catch(error => safeSendMessageToTab(tabId, { action: 'streamError', streamType: 'analyze', error: error.message }));
    return false;
  }

  if (request.action === 'generateTestScopeStream') {
    const tabId = sender.tab.id;
    sendResponse({ started: true });
    handleGenerateTestScopeStream(request.data, tabId)
      .then(result => safeSendMessageToTab(tabId, { action: 'streamComplete', streamType: 'scope', result }))
      .catch(error => safeSendMessageToTab(tabId, { action: 'streamError', streamType: 'scope', error: error.message }));
    return false;
  }

  if (request.action === 'generateTestCasesStream') {
    const tabId = sender.tab.id;
    sendResponse({ started: true });
    handleGenerateTestCasesStream(request.data, tabId)
      .then(result => safeSendMessageToTab(tabId, { action: 'streamComplete', streamType: 'testcases', result }))
      .catch(error => safeSendMessageToTab(tabId, { action: 'streamError', streamType: 'testcases', error: error.message }));
    return false;
  }
  
  if (request.action === 'stopGeneration') {
    const cancelled = cancelStream(request.requestId);
    sendResponse({ success: cancelled });
    return true;
  }

  if (request.action === 'stopMultiAgentGeneration') {
    let stopped = false;
    for (const abort of activeAgenticAborts) { abort.cancelled = true; stopped = true; }
    sendResponse(stopped ? { success: true } : { success: false, message: 'No active generation' });
    return true;
  }

  if (request.type === 'EXPORT_TO_TEST_MANAGEMENT') {
    handleExportToTestManagement(request.testCases, request.jiraTicket)
      .then(sendResponse)
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.type === 'CANCEL_UPLOAD') {
    if (activeIntegration && typeof activeIntegration.cancelUpload === 'function') {
      activeIntegration.cancelUpload();
      sendResponse({ success: true, message: 'Upload cancellation requested' });
    } else {
      sendResponse({ success: false, message: 'No active upload to cancel' });
    }
    return true;
  }

  if (request.type === 'GET_UPLOAD_PROGRESS') {
    if (activeIntegration && typeof activeIntegration.getProgress === 'function') {
      sendResponse({ success: true, progress: activeIntegration.getProgress() });
    } else {
      sendResponse({ success: false, progress: null });
    }
    return true;
  }

  // Agentic planner-driven generation (grounded, coverage-feedback, no duplicates)
  if (request.action === 'generateTestCasesAgentic') {
    handleGenerateTestCasesAgentic(request.data, sender.tab.id)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  // Open options page
  if (request.action === 'openOptions') {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return true;
  }

  // Open options page with specific tab (e.g., help)
  if (request.action === 'openOptionsPage') {
    const tab = request.tab || 'api';
    // Open options page with tab parameter in URL hash
    const optionsUrl = chrome.runtime.getURL(`options.html#${tab}`);
    chrome.tabs.create({ url: optionsUrl });
    sendResponse({ success: true });
    return true;
  }
  
  // Run diagnostics
  if (request.action === 'runDiagnostics') {
    runDiagnostics()
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // Regenerate with user review
  if (request.action === 'regenerateWithReview') {
    handleRegenerateWithReview(request.data)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  // Web Crawler actions
  if (request.action === 'startCrawl') {
    handleStartCrawl(request.data)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === 'stopCrawl') {
    handleStopCrawl()
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === 'checkCrawlerStatus') {
    // Check if crawler is actually running
    const isRunning = activeCrawler !== null;
    sendResponse({ isRunning: isRunning });
    return true;
  }

  // Incremental page processing for progressive crawling
  if (request.action === 'processPageIncremental') {
    handleProcessPageIncremental(request.pageData, request.crawlId, request.crawlStartTime)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === 'pauseCrawl') {
    handlePauseCrawl()
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === 'loadEmbeddings') {
    handleLoadEmbeddings(request.data)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === 'searchEmbeddings') {
    handleSearchEmbeddings(request.data)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === 'getAppContext') {
    handleGetAppContext(request.data)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === 'exportEmbeddings') {
    handleExportEmbeddings(request.data)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === 'getAllApps') {
    handleGetAllApps()
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === 'deleteEmbeddings') {
    handleDeleteEmbeddings(request.data)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === 'importEmbeddings') {
    handleImportEmbeddings(request.data)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === 'exportAllEmbeddings') {
    handleExportAllEmbeddings()
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === 'deleteAllEmbeddings') {
    handleDeleteAllEmbeddings()
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === 'getCrawlerStats') {
    handleGetCrawlerStats()
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === 'mergeKnowledgeGraphs') {
    handleMergeKnowledgeGraphs(request.data)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === 'getMergeableApps') {
    handleGetMergeableApps()
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === 'testIntegration') {
    (async () => {
      try {
        const result = await handleTestIntegration(request.data);
        sendResponse(result);
      } catch (error) {
        sendResponse({ success: false, message: error.message });
      }
    })();
    return true; // Keep the message channel open for async response
  }

  if (request.action === 'testAIConnection') {
    (async () => {
      try {
        const result = await handleTestAIConnection(request.data);
        sendResponse(result);
      } catch (error) {
        sendResponse({ success: false, message: error.message });
      }
    })();
    return true;
  }

  if (request.action === 'stopResourceBlocker') {
    (async () => {
      try {
        await globalResourceBlocker.stop();
        sendResponse({ success: true, message: 'Resource blocker stopped' });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  return false;
});

async function handleTestIntegration(data) {
  const { type, ...credentials } = data;

  switch (type) {
    case 'confluence':
      return testConfluence(credentials);
    case 'figma':
      return testFigma(credentials);
    case 'google':
      return testGoogle(credentials);
    case 'testrail':
      return testTestRail(credentials);
    default:
      return { success: false, message: 'Unknown integration type' };
  }
}

/**
 * Test AI provider connection using lightweight/free API endpoints
 * - OpenAI:  GET /v1/models (no tokens used)
 * - Claude:  GET /v1/models (no tokens used)
 * - Gemini:  GET /v1beta/models (no tokens used)
 * - Bedrock: InvokeModel with max_tokens=1 (minimal cost, confirms auth + model access)
 */
async function handleTestAIConnection({ provider, model, apiKey, bedrockAccessKeyId, bedrockSecretKey, bedrockSessionToken, bedrockRegion }) {
  switch (provider) {
    case 'openai':
      return testOpenAIConnection(apiKey);
    case 'claude':
      return testClaudeConnection(apiKey);
    case 'gemini':
      return testGeminiConnection(apiKey);
    case 'bedrock':
      return testBedrockConnection({ model, bedrockAccessKeyId, bedrockSecretKey, bedrockSessionToken, bedrockRegion });
    default:
      return { success: false, message: `Unknown provider: ${provider}` };
  }
}

async function testOpenAIConnection(apiKey) {
  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
    if (response.ok) {
      const data = await response.json();
      const count = data.data?.length || 0;
      return { success: true, message: `OpenAI connection successful! ${count} models available.` };
    }
    const err = await response.json().catch(() => ({}));
    return { success: false, message: err.error?.message || `OpenAI returned HTTP ${response.status}. Check your API key.` };
  } catch (e) {
    return { success: false, message: `Network error: ${e.message}` };
  }
}

async function testClaudeConnection(apiKey) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/models', {
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      }
    });
    if (response.ok) {
      const data = await response.json();
      const count = data.data?.length || 0;
      return { success: true, message: `Anthropic Claude connection successful! ${count} models available.` };
    }
    const err = await response.json().catch(() => ({}));
    return { success: false, message: err.error?.message || `Claude returned HTTP ${response.status}. Check your API key.` };
  } catch (e) {
    return { success: false, message: `Network error: ${e.message}` };
  }
}

async function testGeminiConnection(apiKey) {
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
      method: 'GET'
    });
    if (response.ok) {
      const data = await response.json();
      const count = data.models?.length || 0;
      return { success: true, message: `Google Gemini connection successful! ${count} models available.` };
    }
    const err = await response.json().catch(() => ({}));
    return { success: false, message: err.error?.message || `Gemini returned HTTP ${response.status}. Check your API key.` };
  } catch (e) {
    return { success: false, message: `Network error: ${e.message}` };
  }
}

async function testBedrockConnection({ model, bedrockAccessKeyId, bedrockSecretKey, bedrockSessionToken, bedrockRegion }) {
  try {
    const region = bedrockRegion || 'us-east-1';
    // Global inference profiles work from any AWS region (shown as "Global" in Bedrock console).
    // US-specific profiles only work in us-east-1/us-east-2/us-west-2.
    const usRegions = ['us-east-1', 'us-east-2', 'us-west-2'];
    const defaultPrefix = usRegions.includes(region) ? 'us.' : 'global.';
    const testModel = model || `${defaultPrefix}anthropic.claude-sonnet-4-5-20250929-v1:0`;
    const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(testModel)}/invoke`;

    // Minimal payload — 1 token max to confirm auth + model access at near-zero cost
    const requestBody = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
    });

    const headers = { 'Content-Type': 'application/json' };
    await awsSignRequest({
      method: 'POST',
      url,
      headers,
      body: requestBody,
      region,
      accessKeyId: bedrockAccessKeyId,
      secretAccessKey: bedrockSecretKey,
      sessionToken: bedrockSessionToken,
      service: 'bedrock'
    });

    const response = await fetch(url, { method: 'POST', headers, body: requestBody });

    if (response.ok) {
      return { success: true, message: `AWS Bedrock connection successful! Model "${testModel}" is accessible in ${region}.` };
    }

    const err = await response.json().catch(() => ({}));
    const msg = err.message || err.Message || `Bedrock returned HTTP ${response.status}`;

    if (response.status === 403) {
      return { success: false, message: `Access denied (403): ${msg}. Check IAM permissions or Session Token.` };
    }
    if (response.status === 400) {
      // Direct model IDs (e.g. anthropic.claude-...) don't work in most regions.
      // Models shown as "Global" in the Bedrock console require global.* inference profiles.
      const isDirectId = !testModel.startsWith('global.') && !testModel.startsWith('us.') && !testModel.startsWith('eu.');
      const hint = isDirectId
        ? ` — Use a "Global" inference profile ID instead (e.g. "global.${testModel}"). Select one from the Model dropdown.`
        : '';
      return { success: false, message: `HTTP 400: ${msg}${hint}` };
    }
    return { success: false, message: `HTTP ${response.status}: ${msg}` };
  } catch (e) {
    return { success: false, message: `Network error: ${e.message}` };
  }
}

async function testConfluence({ url, email, token }) {
  if (!url || !email || !token) {
    return { success: false, message: 'URL, email, and token are required' };
  }
  try {
    const credentials = btoa(`${email}:${token}`);
    const response = await fetch(`${url}/wiki/rest/api/space`, {
      headers: { 
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json'
      },
    });
    if (response.ok) {
      return { success: true };
    } else {
      return { success: false, message: `Failed with status: ${response.status}` };
    }
  } catch (error) {
    return { success: false, message: error.message };
  }
}

async function testFigma({ token }) {
  if (!token) {
    return { success: false, message: 'Token is required' };
  }
  try {
    const response = await fetch('https://api.figma.com/v1/me', {
      headers: { 'X-Figma-Token': token },
    });
    if (response.ok) {
      return { success: true };
    } else {
      return { success: false, message: `Failed with status: ${response.status}` };
    }
  } catch (error) {
    return { success: false, message: error.message };
  }
}

async function testGoogle({ apiKey }) {
  if (!apiKey) {
    return { success: false, message: 'API key is required' };
  }
  try {
    const response = await fetch(`https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=017576662512468239146:omuauf_lfve&q=testrail`);
    if (response.ok) {
      return { success: true };
    } else {
      return { success: false, message: `Failed with status: ${response.status}` };
    }
  } catch (error) {
    return { success: false, message: error.message };
  }
}

async function testTestRail({ url, username, apiKey }) {
  if (!url || !username || !apiKey) {
    return { success: false, message: 'URL, username, and API key are required' };
  }
  try {
    const response = await fetch(`${url}/index.php?/api/v2/get_statuses`, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + btoa(`${username}:${apiKey}`),
      },
    });
    if (response.ok) {
      return { success: true };
    } else {
      return { success: false, message: `Failed with status: ${response.status}` };
    }
  } catch (error) {
    return { success: false, message: error.message };
  }
}

// Sleep utility for retry delays
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ AWS SigV4 Signing for Bedrock ============

async function hmacSha256(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? new TextEncoder().encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, typeof data === 'string' ? new TextEncoder().encode(data) : data));
}

async function sha256(data) {
  const encoded = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * SigV4 URI encoding per AWS spec:
 * Encode every character except the unreserved set: A-Z a-z 0-9 - . _ ~
 * This is stricter than encodeURIComponent — it also encodes ! ' ( ) *
 * Critically, it encodes '%' itself (as %25), so an already-encoded %3A becomes %253A,
 * which is exactly what AWS expects in the canonical URI.
 */
function sigV4UriEncode(str) {
  return str.replace(/[^A-Za-z0-9\-._~]/g, c => {
    return '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
  });
}

/**
 * Build the SigV4 canonical URI from a URL pathname.
 * Each path segment is individually SigV4-encoded; '/' separators are preserved.
 */
function buildCanonicalUri(pathname) {
  return pathname.split('/').map(sigV4UriEncode).join('/');
}

async function awsSignRequest({ method, url, headers, body, region, accessKeyId, secretAccessKey, sessionToken, service = 'bedrock' }) {
  const parsedUrl = new URL(url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.substring(0, 8);

  headers['x-amz-date'] = amzDate;
  headers['host'] = parsedUrl.host;

  // Required for temporary credentials (ASIA... Access Key ID)
  if (sessionToken && sessionToken.trim()) {
    headers['x-amz-security-token'] = sessionToken.trim();
  }

  const payloadHash = toHex(await sha256(body || ''));
  headers['x-amz-content-sha256'] = payloadHash;

  // Canonical headers - must be sorted by lowercase key
  const signedHeaderKeys = Object.keys(headers).map(k => k.toLowerCase()).sort();
  const canonicalHeaders = signedHeaderKeys.map(k => `${k}:${headers[Object.keys(headers).find(h => h.toLowerCase() === k)].trim()}`).join('\n') + '\n';
  const signedHeaders = signedHeaderKeys.join(';');

  // Canonical request — path must be SigV4-encoded (e.g. %3A → %253A)
  const canonicalRequest = [
    method,
    buildCanonicalUri(parsedUrl.pathname),
    parsedUrl.search ? parsedUrl.search.substring(1) : '',
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    toHex(await sha256(canonicalRequest))
  ].join('\n');

  // Derive signing key
  const kDate = await hmacSha256('AWS4' + secretAccessKey, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, 'aws4_request');

  const signature = toHex(await hmacSha256(kSigning, stringToSign));

  headers['Authorization'] = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return headers;
}

// Call AWS Bedrock API (Claude models)
// Detect if a Bedrock model ID is an OpenAI model
function isBedrockOpenAIModel(modelId) {
  // Real Bedrock OpenAI model IDs are openai.gpt-oss-* (not us.openai.*)
  return modelId && modelId.startsWith('openai.');
}

// callBedrock is provided by llm-client.js (importScripts above).

// Streaming version of Bedrock API (Claude + OpenAI models)
// callBedrockStream is provided by llm-client.js (importScripts above).

// Call OpenAI API directly
// callOpenAI is provided by llm-client.js (importScripts above).

// Call Gemini API directly
// callGemini is provided by llm-client.js (importScripts above).

// Call Claude (Anthropic) API directly
// callClaude is provided by llm-client.js (importScripts above).

// Streaming version of OpenAI API
// callOpenAIStream is provided by llm-client.js (importScripts above).

// Streaming version of Claude API
// callClaudeStream is provided by llm-client.js (importScripts above).

// Streaming version of Gemini API (Note: Gemini uses SSE differently)
// callGeminiStream is provided by llm-client.js (importScripts above).

// Unified streaming AI call function
// callAIStream is provided by llm-client.js (importScripts above).

// Cancel active stream
function cancelStream(requestId) {
  const controller = activeStreams.get(requestId);
  if (controller) {
    controller.abort();
    activeStreams.delete(requestId);
    return true;
  }
  return false;
}

// Unified AI call function (non-streaming - kept for backward compatibility)
// callAI is provided by llm-client.js (importScripts above).

// validateSettings is provided by background-utils.js (importScripts above).

/**
 * Get filtered crawl data based on Jira ticket keywords
 * Intelligently queries crawl data JSON and creates a focused 5-10 KB summary
 * @param {Array} keywords - Keywords extracted from Jira ticket
 * @param {number} maxSizeKB - Maximum summary size in KB
 * @returns {Promise<Object>} - { summary: string, matchedPages: number }
 */
async function getFilteredCrawlData(keywords, maxSizeKB = 10) {
  try {
    // Ensure storage manager is ready
    await storageReady;

    if (!storageManager) {
      console.log('ℹ️ Storage manager not initialized');
      return { summary: null, matchedPages: 0 };
    }

    // Get all stored apps with their knowledge graphs
    const allApps = await storageManager.getAllEmbeddings();

    if (!allApps || allApps.length === 0) {
      console.log('ℹ️ No crawled apps in storage');
      return { summary: null, matchedPages: 0 };
    }

    console.log(`📦 Found ${allApps.length} crawled app(s) in storage`);

    // Extract all pages from all knowledge graphs
    const crawledPages = [];
    for (const app of allApps) {
      console.log(`🔍 Checking app: ${app.appUrl}`);
      console.log(`   - Has knowledgeGraph: ${!!app.knowledgeGraph}`);

      if (app.knowledgeGraph) {
        console.log(`   - knowledgeGraph.pages type: ${typeof app.knowledgeGraph.pages}`);
        console.log(`   - Is array: ${Array.isArray(app.knowledgeGraph.pages)}`);

        if (app.knowledgeGraph.pages) {
          // Ensure pages is actually an array
          if (Array.isArray(app.knowledgeGraph.pages)) {
            console.log(`   - Adding ${app.knowledgeGraph.pages.length} pages`);
            crawledPages.push(...app.knowledgeGraph.pages);
          } else {
            console.warn('⚠️ app.knowledgeGraph.pages is not an array:', typeof app.knowledgeGraph.pages);
            // Try to convert it to an array if it's an object
            if (typeof app.knowledgeGraph.pages === 'object' && app.knowledgeGraph.pages !== null) {
              const pagesArray = Object.values(app.knowledgeGraph.pages);
              console.log(`   - Converted object to array: ${pagesArray.length} pages`);
              crawledPages.push(...pagesArray);
            }
          }
        }
      }
    }

    if (crawledPages.length === 0) {
      console.log('ℹ️ No pages found in crawl data. Please crawl your app first using Settings → Web App Crawler');
      return { summary: null, matchedPages: 0 };
    }

    console.log(`🔍 Filtering ${crawledPages.length} pages from ${allApps.length} app(s) with BM25 (${keywords.length} keywords)`);

    // Build a per-app BM25 index map (load from IndexedDB or build lazily)
    const appBm25Map = new Map(); // appUrl → BM25Index
    for (const app of allApps) {
      if (!app.knowledgeGraph?.pages) continue;
      try {
        const saved = await storageManager.loadBm25Index(app.appUrl);
        if (saved) {
          appBm25Map.set(app.appUrl, BM25Index.deserialize(saved));
          console.log(`[BM25] Loaded index for ${app.appUrl}`);
        } else {
          const bm25 = BM25Index.build(app.knowledgeGraph.pages);
          appBm25Map.set(app.appUrl, bm25);
          storageManager.saveBm25Index(app.appUrl, bm25.serialize())
            .catch(e => console.warn('[BM25] Failed to persist index:', e.message));
        }
      } catch (e) {
        console.warn(`[BM25] Index unavailable for ${app.appUrl}, will use keyword fallback:`, e.message);
      }
    }

    const queryText = keywords.join(' ');

    // Score pages: BM25 where index is available, keyword fallback otherwise
    const scoredPages = crawledPages.map(page => {
      const pageUrl = page.url || page.metadata?.url || '';
      // Find which app owns this page
      const ownerApp = allApps.find(a => pageUrl.startsWith(a.appUrl));
      const bm25 = ownerApp ? appBm25Map.get(ownerApp.appUrl) : null;

      if (bm25) {
        // BM25: score this single doc against the query
        const queryTerms = BM25Index.tokenize(queryText);
        return { page, score: bm25.scoreDoc(pageUrl, queryTerms) };
      }

      // Keyword fallback for pages without an index
      let score = 0;
      const description = page.description || page.metadata?.description || '';
      keywords.forEach(kw => {
        const k = kw.toLowerCase();
        if (pageUrl.toLowerCase().includes(k)) score += 10;
        if ((page.title || '').toLowerCase().includes(k)) score += 5;
        if (description.toLowerCase().includes(k)) score += 3;
        (page.forms || []).forEach(f => (f.fields || []).forEach(fi => {
          if ((fi.name || '').toLowerCase().includes(k)) score += 2;
        }));
      });
      return { page, score };
    });

    // Sort by BM25 score (descending)
    scoredPages.sort((a, b) => b.score - a.score);

    // Filter pages with score > 0 (at least one keyword match)
    const relevantPages = scoredPages.filter(p => p.score > 0);

    if (relevantPages.length === 0) {
      console.log('ℹ️ No keyword-matched pages found, providing general crawl summary');
      // Fallback: Return a basic summary of available crawl data
      const topPages = scoredPages.slice(0, 10);
      if (topPages.length > 0) {
        let fallbackSummary = `\n\n## 🌐 Application Context (General Overview)\n\n`;
        fallbackSummary += `**Note:** No pages specifically matched ticket keywords, showing general app structure\n`;
        fallbackSummary += `**Total Crawled Pages:** ${crawledPages.length}\n\n`;

        topPages.forEach(({ page }) => {
          fallbackSummary += `- **${page.title || page.url}**`;
          if (page.forms && page.forms.length > 0) {
            fallbackSummary += ` (${page.forms.length} forms)`;
          }
          fallbackSummary += `\n`;
        });

        return { summary: fallbackSummary, matchedPages: topPages.length, fallback: true };
      }
      return { summary: null, matchedPages: 0 };
    }

    console.log(`✅ Found ${relevantPages.length} relevant pages (top score: ${relevantPages[0]?.score || 0})`);

    // Build focused summary within size limit
    const maxBytes = maxSizeKB * 1024;
    const encoder = new TextEncoder(); // Reuse encoder instance
    let summary = `\n\n## 🌐 Application Context (Filtered from Crawl Data)\n\n`;
    summary += `**Relevance:** Found ${relevantPages.length} pages matching ticket keywords\n`;
    summary += `**Keywords Used:** ${keywords.slice(0, 10).join(', ')}${keywords.length > 10 ? ` +${keywords.length - 10} more` : ''}\n\n`;

    let includedPages = 0;
    let currentSize = encoder.encode(summary).length;

    // Add pages in order of relevance until size limit reached
    for (const { page, score } of relevantPages) {
      const pageSection = buildPageSection(page, score);
      const sectionSize = encoder.encode(pageSection).length;

      if (currentSize + sectionSize > maxBytes && includedPages > 0) {
        // Size limit reached, add summary note
        const remaining = relevantPages.length - includedPages;
        if (remaining > 0) {
          summary += `\n_... and ${remaining} more relevant pages (omitted for size limit)_\n`;
        }
        break;
      }

      summary += pageSection;
      currentSize += sectionSize;
      includedPages++;
    }

    console.log(`📊 Generated summary: ${currentSize} bytes (${(currentSize / 1024).toFixed(1)} KB), ${includedPages} pages`);

    return {
      summary: summary,
      matchedPages: includedPages
    };

  } catch (error) {
    console.error('❌ Error filtering crawl data:', error);
    return { summary: null, matchedPages: 0 };
  }
}

/**
 * Build a formatted section for a single page
 * @param {Object} page - Page data
 * @param {number} score - Relevance score
 * @returns {string} - Formatted page section
 */
function buildPageSection(page, score) {
  let section = `### 📄 ${page.title || 'Untitled Page'} (Relevance: ${score})\n`;
  section += `- **URL:** ${page.url}\n`;

  const description = page.description || page.metadata?.description;
  if (description) {
    section += `- **Description:** ${description.substring(0, 200)}${description.length > 200 ? '...' : ''}\n`;
  }

  // Forms
  if (page.forms && page.forms.length > 0) {
    section += `- **Forms:** ${page.forms.length} form(s)\n`;
    page.forms.slice(0, 2).forEach((form, idx) => {
      section += `  - Form ${idx + 1}: `;
      if (form.fields && form.fields.length > 0) {
        const fieldNames = form.fields.slice(0, 5).map(f => f.name || f.type).filter(Boolean);
        section += `${form.fields.length} fields (${fieldNames.join(', ')})`;
        if (form.fields.length > 5) section += ` +${form.fields.length - 5} more`;
      }
      section += `\n`;
    });
  }

  // Interactions
  if (page.interactions && page.interactions.length > 0) {
    section += `- **Interactive Elements:** ${page.interactions.length} (`;
    const interactionTypes = {};
    page.interactions.forEach(i => {
      interactionTypes[i.type] = (interactionTypes[i.type] || 0) + 1;
    });
    section += Object.entries(interactionTypes).map(([type, count]) => `${count} ${type}`).join(', ');
    section += `)\n`;
  }

  // APIs/Endpoints if available
  if (page.apis && page.apis.length > 0) {
    section += `- **API Endpoints:** ${page.apis.slice(0, 3).join(', ')}${page.apis.length > 3 ? ` +${page.apis.length - 3} more` : ''}\n`;
  }

  section += `\n`;
  return section;
}

// Get crawl data from existing storage (populated by Settings page crawler)
async function getCrawlDataFromStorage() {
  try {
    // Ensure storage manager is ready
    await storageReady;

    if (!storageManager) {
      console.log('ℹ️ Storage manager not initialized');
      return null;
    }

    // Get all crawled pages from storage
    const crawledPages = await storageManager.getAllPages();

    if (!crawledPages || crawledPages.length === 0) {
      console.log('ℹ️ No crawl data in storage. Run crawler from Settings page first.');
      return null;
    }

    // Get knowledge graph for additional context
    const knowledgeGraph = await storageManager.getKnowledgeGraph();

    // Build context data from stored crawl
    const contextData = {
      pages: [],
      pagesCount: crawledPages.length,
      featuresCount: 0,
      apisCount: 0
    };

    // Extract and format page data
    for (const page of crawledPages) {
      contextData.pages.push({
        url: page.url,
        title: page.title,
        description: page.metadata?.description || '',
        forms: page.forms || [],
        interactions: page.interactions || [],
        keywords: page.metadata?.keywords || []
      });

      // Count features and APIs
      if (page.forms) contextData.featuresCount += page.forms.length;
      if (page.interactions) contextData.featuresCount += page.interactions.length;
    }

    // Count APIs from knowledge graph
    if (knowledgeGraph && knowledgeGraph.apis) {
      contextData.apisCount = knowledgeGraph.apis.length || 0;
    }

    console.log(`📊 Retrieved crawl data: ${contextData.pagesCount} pages, ${contextData.featuresCount} features, ${contextData.apisCount} APIs`);
    return contextData;

  } catch (error) {
    console.error('❌ Error retrieving crawl data from storage:', error);
    return null;
  }
}

// Shared helper: Fetch and merge external content (Confluence, Figma, Google Docs)
async function enrichTicketWithExternalContent(ticketData, settings) {
  if (!settings.confluenceUrl && !settings.figmaToken && !settings.googleApiKey) {
    return { enrichedTicketData: ticketData, externalContent: null, externalSources: null };
  }

  const integrationManager = new IntegrationManager(settings);
  const externalContent = await integrationManager.fetchAllLinkedContent(ticketData);

  const externalSources = {
    confluence: externalContent.confluence.length,
    figma: externalContent.figma.length,
    googleDocs: externalContent.googleDocs.length
  };

  // Build linkedPages from fetched content
  const fetchedLinkedPages = [];
  const typeMap = [
    { key: 'confluence', titleField: 'title', defaultTitle: 'Confluence Page', type: 'confluence' },
    { key: 'figma', titleField: 'name', defaultTitle: 'Figma File', type: 'figma' },
    { key: 'googleDocs', titleField: 'title', defaultTitle: 'Google Doc', type: 'google_docs' }
  ];

  for (const { key, titleField, defaultTitle, type } of typeMap) {
    externalContent[key].forEach((item, i) => {
      fetchedLinkedPages.push({
        id: `${type === 'google_docs' ? 'googledocs' : key}-${i}`,
        title: item[titleField] || defaultTitle,
        url: item.url || '',
        type: type,
        fetched: true
      });
    });
  }

  // Merge with existing linked pages (deduplicate by URL)
  const existingUrls = new Set((ticketData.linkedPages || []).map(p => p.url));
  const mergedLinkedPages = [
    ...(ticketData.linkedPages || []),
    ...fetchedLinkedPages.filter(p => !existingUrls.has(p.url))
  ];

  const enrichedTicketData = {
    ...ticketData,
    description: externalContent.enrichedDescription || ticketData.description,
    linkedPages: mergedLinkedPages,
    externalSources
  };

  return { enrichedTicketData, externalContent, externalSources };
}

// API call handlers
async function handleAnalyzeRequirements(data) {
  validateSettings(data.settings);

  const { ticketKey, ticketData, settings } = data;

  // Fetch external content if integrations are configured
  let enrichedTicketData = ticketData;
  let externalContent = null;
  const enrichResult = await enrichTicketWithExternalContent(ticketData, settings);
  enrichedTicketData = enrichResult.enrichedTicketData;
  externalContent = enrichResult.externalContent;
  if (enrichResult.externalSources) {
    console.log('📄 [Analyze] Enriched ticket with external sources:', enrichResult.externalSources);
  }

  const systemMessage = PROMPTS.analyzeSystem();

  const userMessage = `Analyze this Jira ticket:

**Ticket:** ${ticketKey}
**Summary:** ${enrichedTicketData.summary || 'N/A'}
**Description:** ${enrichedTicketData.description || 'N/A'}
**Comments:** ${enrichedTicketData.comments?.length || 0} comments
**Attachments:** ${enrichedTicketData.attachments?.length || 0} files
**Linked Pages:** ${enrichedTicketData.linkedPages?.length || 0} pages
${enrichedTicketData.externalSources ? `**External Sources:** ${enrichedTicketData.externalSources.confluence} Confluence, ${enrichedTicketData.externalSources.figma} Figma, ${enrichedTicketData.externalSources.googleDocs} Google Docs` : ''}
${data.crawledContext || ''}

Provide comprehensive requirement analysis.`;

  const userContent = [
    { type: 'text', text: userMessage }
  ];

  // Add Figma images if available
  if (externalContent && externalContent.figma) {
    externalContent.figma.forEach(figmaFile => {
      if (figmaFile.images && figmaFile.images.length > 0) {
        figmaFile.images.forEach(base64Image => {
          userContent.push({ type: 'image_url', image_url: { url: base64Image } });
        });
      }
    });
  }

  // Add Jira image attachments if available
  if (enrichedTicketData.imageAttachments && enrichedTicketData.imageAttachments.length > 0) {
    console.log(`📷 Adding ${enrichedTicketData.imageAttachments.length} Jira image attachments to analysis`);
    enrichedTicketData.imageAttachments.forEach(image => {
      userContent.push({ type: 'image_url', image_url: { url: image.data } });
    });
  }

  const analysis = await callAI(systemMessage, userContent, settings);

  return {
    analysis,
    externalSources: enrichedTicketData.externalSources
  };
}

async function handleGenerateTestScope(data) {
  console.log('🔍 [Test Scope] Starting generation (non-streaming)...', {
    ticketKey: data.ticketKey,
    hasTicketData: !!data.ticketData,
    provider: data.settings?.llmProvider,
    model: data.settings?.llmModel,
    hasIntegrations: !!(data.settings?.confluenceUrl || data.settings?.figmaToken || data.settings?.googleApiKey)
  });

  try {
    validateSettings(data.settings);

    const { ticketKey, ticketData, settings } = data;

    // Validate ticket data
    if (!ticketData || (!ticketData.summary && !ticketData.description)) {
      console.error('❌ [Test Scope] Invalid ticket data:', ticketData);
      throw new Error('Ticket data is missing or incomplete. Please ensure the Jira ticket has a summary or description.');
    }

    // Fetch external content if integrations are configured
    let enrichedTicketData = ticketData;
    let currentExternalSources = null;
    let externalContent = null;
    try {
      const enrichResult = await enrichTicketWithExternalContent(ticketData, settings);
      enrichedTicketData = enrichResult.enrichedTicketData;
      externalContent = enrichResult.externalContent;
      currentExternalSources = enrichResult.externalSources;
      if (currentExternalSources) {
        console.log('📝 [Test Scope] Enriched ticket with external sources:', currentExternalSources);
      }
    } catch (integrationError) {
      console.warn('⚠️ [Test Scope] Integration fetch failed, continuing with ticket data only:', integrationError.message);
    }

    const systemMessage = PROMPTS.testScopeSystem();

    const userMessage = `Create test scope for:

**Ticket:** ${ticketKey}
**Summary:** ${enrichedTicketData.summary || 'N/A'}
**Description:** ${enrichedTicketData.description || 'N/A'}
${currentExternalSources ? `**External Sources:** ${currentExternalSources.confluence} Confluence, ${currentExternalSources.figma} Figma, ${currentExternalSources.googleDocs} Google Docs` : ''}
${data.crawledContext || ''}

Provide detailed test scope covering all aspects.`;

    const userContent = [
      { type: 'text', text: userMessage }
    ];

    // Add Figma images if available
    if (externalContent && externalContent.figma) {
      externalContent.figma.forEach(figmaFile => {
        if (figmaFile.images && figmaFile.images.length > 0) {
          figmaFile.images.forEach(base64Image => {
            userContent.push({ type: 'image_url', image_url: { url: base64Image } });
          });
        }
      });
    }

    // Add Jira image attachments if available
    if (enrichedTicketData.imageAttachments && enrichedTicketData.imageAttachments.length > 0) {
      console.log(`📷 [Test Scope] Adding ${enrichedTicketData.imageAttachments.length} Jira image attachments`);
      enrichedTicketData.imageAttachments.forEach(image => {
        userContent.push({ type: 'image_url', image_url: { url: image.data } });
      });
    }

    console.log('🤖 [Test Scope] Calling AI provider with', userContent.length, 'user content parts...');
    const scope = await callAI(systemMessage, userContent, settings);

    // Validate response
    if (!scope || scope.trim() === '') {
      console.error('❌ [Test Scope] AI returned empty response');
      throw new Error('AI provider returned an empty response. Please try again or check your API quota.');
    }

    console.log('✅ [Test Scope] Generation successful', {
      length: scope.length,
      preview: scope.substring(0, 100) + '...'
    });

    return { scope, externalSources: currentExternalSources };
  } catch (error) {
    console.error('❌ [Test Scope] Generation failed:', error);
    throw error;
  }
}

async function handleGenerateTestCases(data) {
  validateSettings(data.settings);

  const { ticketKey, ticketData, settings } = data;
  const crawledContext = data.crawledContext || formatAppContextAsCrawledContext(data.appContext);

  // Fetch external content if integrations are configured
  let enrichedTicketData = ticketData;
  let currentExternalSources = null;
  let externalContent = null;
  try {
    const enrichResult = await enrichTicketWithExternalContent(ticketData, settings);
    enrichedTicketData = enrichResult.enrichedTicketData;
    externalContent = enrichResult.externalContent;
    currentExternalSources = enrichResult.externalSources;
    if (currentExternalSources) {
      console.log('📝 [Test Cases] Enriched ticket with external sources:', currentExternalSources);
    }
  } catch (integrationError) {
    console.warn('⚠️ [Test Cases] Integration fetch failed, continuing with ticket data only:', integrationError.message);
  }

  const systemMessage = PROMPTS.testCasesSystem();

  const userMessage = `Generate test cases for:

**Ticket:** ${ticketKey}
**Summary:** ${enrichedTicketData.summary || 'N/A'}
**Description:** ${enrichedTicketData.description || 'N/A'}
${crawledContext}

Return test cases as JSON array: [{"id":"TC-POS-001","title":"...","category":"Positive","priority":"P0","steps":["step1","step2"],"expectedResult":"...","preconditions":"...","testData":"..."}]`;

  const userContent = [
    { type: 'text', text: userMessage }
  ];

  // Add Figma images if available
  if (externalContent && externalContent.figma) {
    externalContent.figma.forEach(figmaFile => {
      if (figmaFile.images && figmaFile.images.length > 0) {
        figmaFile.images.forEach(base64Image => {
          userContent.push({ type: 'image_url', image_url: { url: base64Image } });
        });
      }
    });
  }

  // Add Jira image attachments if available
  if (enrichedTicketData.imageAttachments && enrichedTicketData.imageAttachments.length > 0) {
    console.log(`📷 [Test Cases] Adding ${enrichedTicketData.imageAttachments.length} Jira image attachments`);
    enrichedTicketData.imageAttachments.forEach(image => {
      userContent.push({ type: 'image_url', image_url: { url: image.data } });
    });
  }

  const response = await callAI(systemMessage, userContent, settings);
  
  // Parse JSON from response
  try {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('Could not parse test cases from AI response');
    }
    
    const testCases = JSON.parse(jsonMatch[0]);
    
    // Count categories
    const stats = {
      totalCount: testCases.length,
      positiveCount: testCases.filter(tc => tc.category === 'Positive').length,
      negativeCount: testCases.filter(tc => tc.category === 'Negative').length,
      edgeCaseCount: testCases.filter(tc => tc.category === 'Edge').length
    };
    
    return {
      testCases,
      ...stats,
      externalSources: currentExternalSources
    };
  } catch (error) {
    throw new Error(`Failed to parse test cases: ${error.message}`);
  }
}

// Streaming handlers - send chunks back to content script in real-time

/**
 * Ensure content fits within model limits using ContextManager
 * Uses graceful truncation to prioritize important content
 */
function ensureContentFitsLimits(contentParts, settings) {
  const model = settings.llmModel || 'gpt-4.1';
  const ctx = new ContextManager(model);

  // Separate text and image parts
  const textParts = contentParts.filter(p => p.type === 'text');
  const imageParts = contentParts.filter(p => p.type === 'image_url');

  // Add text content with priority (system message first, then user message)
  textParts.forEach((part, index) => {
    const priority = index === 0 ? CONTENT_PRIORITY.JIRA_SUMMARY : CONTENT_PRIORITY.JIRA_DESCRIPTION;
    ctx.addContext(part.text, priority, `TextPart-${index}`);
  });

  // Add images
  imageParts.forEach((part, index) => {
    ctx.addImage(part.image_url.url, `Image-${index}`, CONTENT_PRIORITY.FIGMA_IMAGES);
  });

  // Build context with automatic truncation
  const result = ctx.buildContext();

  if (result.stats.truncated) {
    console.warn('⚠️ [Context Manager] Content truncated to fit model limits:', {
      model,
      originalTokens: result.stats.totalTokens,
      available: result.stats.available,
      truncationLog: result.stats.truncationLog
    });
  } else {
    console.log('✅ [Context Manager] Content fits within limits:', {
      model,
      tokens: result.stats.totalTokens,
      available: result.stats.available,
      usage: `${((result.stats.totalTokens / result.stats.available) * 100).toFixed(1)}%`
    });
  }

  return result.contentParts;
}

async function handleAnalyzeRequirementsStream(data, tabId) {
  validateSettings(data.settings);

  const { ticketKey, ticketData, settings } = data;
  const requestId = `analyze-${Date.now()}`;

  // Fetch external content if integrations are configured
  let enrichedTicketData = ticketData;
  let currentExternalSources = null;
  let externalContent = null; // Declare at function scope
  if (settings.confluenceUrl || settings.figmaToken || settings.googleApiKey) {
    const integrationManager = new IntegrationManager(settings);
    externalContent = await integrationManager.fetchAllLinkedContent(ticketData);

    // Set external sources count (always, regardless of description change)
    currentExternalSources = {
      confluence: externalContent.confluence.length,
      figma: externalContent.figma.length,
      googleDocs: externalContent.googleDocs.length
    };

    // Use enriched description if external content was found
    if (externalContent.enrichedDescription !== ticketData.description) {
      enrichedTicketData = {
        ...ticketData,
        description: externalContent.enrichedDescription,
      };
    }
  }

  const systemMessage = PROMPTS.analyzeSystem();

  const userMessage = `Analyze this Jira ticket:

**Ticket:** ${ticketKey}
**Summary:** ${enrichedTicketData.summary || 'N/A'}
**Description:** ${enrichedTicketData.description || 'N/A'}
**Comments:** ${enrichedTicketData.comments?.length || 0} comments
**Attachments:** ${enrichedTicketData.attachments?.length || 0} files
**Linked Pages:** ${enrichedTicketData.linkedPages?.length || 0} pages
${currentExternalSources ? `**External Sources:** ${currentExternalSources.confluence} Confluence, ${currentExternalSources.figma} Figma, ${currentExternalSources.googleDocs} Google Docs` : ''}
${data.crawledContext || ''}

Provide comprehensive requirement analysis.`;

  const userContent = [
    { type: 'text', text: userMessage }
  ];

  // Add Figma images if available
  if (externalContent && externalContent.figma) {
    externalContent.figma.forEach(figmaFile => {
      if (figmaFile.images && figmaFile.images.length > 0) {
        figmaFile.images.forEach(base64Image => {
          userContent.push({ type: 'image_url', image_url: { url: base64Image } });
        });
      }
    });
  }

  // Add Jira image attachments if available (vision models only)
  if (enrichedTicketData.imageAttachments && enrichedTicketData.imageAttachments.length > 0) {
    console.log(`📷 Adding ${enrichedTicketData.imageAttachments.length} Jira image attachments to streaming analysis`);
    enrichedTicketData.imageAttachments.forEach(image => {
      userContent.push({ type: 'image_url', image_url: { url: image.data } });
    });
  }

  // Inject extracted document text (PDF, TXT, CSV…) as additional context
  if (enrichedTicketData.documentAttachments && enrichedTicketData.documentAttachments.length > 0) {
    const textDocs = enrichedTicketData.documentAttachments.filter(d => !d.isScannedPdf && d.text);
    const scannedDocs = enrichedTicketData.documentAttachments.filter(d => d.isScannedPdf && d.base64);

    if (textDocs.length > 0) {
      console.log(`📄 Injecting text from ${textDocs.length} document(s)`);
      const docContext = textDocs.map(doc =>
        `\n\n--- Attached document: ${doc.fileName} ---\n${doc.text}`
      ).join('\n');
      userContent.push({ type: 'text', text: `\n\n## Attachment Content\n${docContext}` });
    }

    // For scanned/image-based PDFs, send as vision input if the model supports it
    if (scannedDocs.length > 0) {
      const isVisionModel = settings.llmModel && (
        APP_CONFIG.VISION_MODELS || ['gpt-4', 'claude-3', 'claude-sonnet', 'claude-opus', 'anthropic.claude', 'global.anthropic', 'gemini']
      ).some(m => settings.llmModel.includes(m));

      if (isVisionModel) {
        console.log(`📄 Sending ${scannedDocs.length} scanned PDF(s) as vision input`);
        scannedDocs.forEach(doc => {
          userContent.push({
            type: 'image_url',
            image_url: { url: `data:${doc.mimeType};base64,${doc.base64}` }
          });
        });
        userContent.push({
          type: 'text',
          text: `\n\nThe above attachment(s) are scanned PDF documents (${scannedDocs.map(d => d.fileName).join(', ')}). Please read and incorporate their content in your analysis.`
        });
      } else {
        console.warn(`⚠️ Scanned PDF(s) skipped — current model is not vision-capable: ${settings.llmModel}`);
        userContent.push({
          type: 'text',
          text: `\n\nNote: The following attachment(s) are scanned PDFs and could not be read automatically: ${scannedDocs.map(d => d.fileName).join(', ')}. Switch to a vision-capable model (Claude Sonnet/Opus, gpt-4.1) to extract their content.`
        });
      }
    }
  }

  // Ensure content fits within model limits (with graceful truncation)
  const fittedUserContent = ensureContentFitsLimits(userContent, settings);

  const analysis = await callAIStream(systemMessage, fittedUserContent, settings, (chunk) => {
    // Send each chunk to content script
    safeSendMessageToTab(tabId, {
      action: 'streamChunk',
      requestId: requestId,
      chunk: chunk
    });
  }, requestId);
  
  return { 
    analysis,
    externalSources: currentExternalSources,
    requestId 
  };
}

async function handleGenerateTestScopeStream(data, tabId) {
  console.log('🔍 [Test Scope Stream] Starting generation...', {
    ticketKey: data.ticketKey,
    hasTicketData: !!data.ticketData,
    provider: data.settings?.llmProvider,
    model: data.settings?.llmModel,
    hasIntegrations: !!(data.settings?.confluenceUrl || data.settings?.figmaToken || data.settings?.googleApiKey)
  });

  try {
    validateSettings(data.settings);

    const { ticketKey, ticketData, settings } = data;
    const requestId = `scope-${Date.now()}`;

    // Validate ticket data
    if (!ticketData || (!ticketData.summary && !ticketData.description)) {
      console.error('❌ [Test Scope Stream] Invalid ticket data:', ticketData);
      throw new Error('Ticket data is missing or incomplete. Please ensure the Jira ticket has a summary or description.');
    }

    // Fetch external content if integrations are configured
    let enrichedTicketData = ticketData;
    let currentExternalSources = null;
    let externalContent = null; // Declare at function scope
    if (settings.confluenceUrl || settings.figmaToken || settings.googleApiKey) {
      console.log('🔗 [Test Scope Stream] Fetching external integrations...');
      try {
        const integrationManager = new IntegrationManager(settings);
        externalContent = await integrationManager.fetchAllLinkedContent(ticketData);

        // Set external sources count (always, regardless of description change)
        currentExternalSources = {
          confluence: externalContent.confluence.length,
          figma: externalContent.figma.length,
          googleDocs: externalContent.googleDocs.length
        };

        console.log('✅ [Test Scope Stream] External sources fetched:', currentExternalSources);

        // Use enriched description if external content was found
        if (externalContent.enrichedDescription !== ticketData.description) {
          enrichedTicketData = {
            ...ticketData,
            description: externalContent.enrichedDescription,
          };
          console.log('📝 [Test Scope Stream] Using enriched description');
        }
      } catch (integrationError) {
        console.warn('⚠️ [Test Scope Stream] Integration fetch failed, continuing with ticket data only:', integrationError.message);
        // Continue with original ticket data
      }
    }
  
    const systemMessage = `You are a test planning expert creating comprehensive test scope documents.`;

    const userMessage = `Create a test scope document for:

**Ticket:** ${ticketKey}
**Summary:** ${enrichedTicketData.summary || 'N/A'}
**Description:** ${enrichedTicketData.description || 'N/A'}
${currentExternalSources ? `**External Sources:** ${currentExternalSources.confluence} Confluence, ${currentExternalSources.figma} Figma, ${currentExternalSources.googleDocs} Google Docs` : ''}
${data.crawledContext || ''}

Provide detailed test scope covering all aspects.`;

    const userContent = [
      { type: 'text', text: userMessage }
    ];

    // Add Figma images if available
    if (externalContent && externalContent.figma) {
      externalContent.figma.forEach(figmaFile => {
        if (figmaFile.images && figmaFile.images.length > 0) {
          figmaFile.images.forEach(base64Image => {
            userContent.push({ type: 'image_url', image_url: { url: base64Image } });
          });
        }
      });
    }

    // Add Jira image attachments if available
    if (enrichedTicketData.imageAttachments && enrichedTicketData.imageAttachments.length > 0) {
      console.log(`📷 [Test Scope Stream] Adding ${enrichedTicketData.imageAttachments.length} Jira image attachments`);
      enrichedTicketData.imageAttachments.forEach(image => {
        userContent.push({ type: 'image_url', image_url: { url: image.data } });
      });
    }

    // Ensure content fits within model limits (with graceful truncation)
    const fittedUserContent = ensureContentFitsLimits(userContent, settings);

    console.log('🤖 [Test Scope Stream] Calling AI provider with', fittedUserContent.length, 'content parts...');
    const testScope = await callAIStream(systemMessage, fittedUserContent, settings, (chunk) => {
      safeSendMessageToTab(tabId, {
        action: 'streamChunk',
        requestId: requestId,
        chunk: chunk
      });
    }, requestId);

    // Validate response
    if (!testScope || testScope.trim() === '') {
      console.error('❌ [Test Scope Stream] AI returned empty response');
      throw new Error('AI provider returned an empty response. Please try again or check your API quota.');
    }

    console.log('✅ [Test Scope Stream] Generation successful', {
      length: testScope.length,
      preview: testScope.substring(0, 100) + '...'
    });
    
    return { testScope, externalSources: currentExternalSources, requestId };
  } catch (error) {
    console.error('❌ [Test Scope Stream] Generation failed:', error);
    throw error;
  }
}

/**
 * Convert a loaded appContext (knowledge graph) to a compact markdown
 * crawledContext string so it can be injected into single-agent prompts.
 * This bridges the gap between the two different crawl data formats.
 */
function formatAppContextAsCrawledContext(appContext) {
  if (!appContext) return '';
  const lines = [
    `\n\n## 🌐 Application Context (from Crawled Data)`,
    `**App:** ${appContext.appUrl || 'Unknown'}`,
    `**Total Pages Crawled:** ${appContext.totalPages || 0}`,
  ];

  // Top relevant pages
  const pages = appContext.pages || [];
  if (pages.length > 0) {
    lines.push(`\n### Relevant Pages (${pages.length})`);
    pages.slice(0, 10).forEach(p => {
      const url   = p.url || p.metadata?.url || '';
      const title = p.title || p.metadata?.title || url;
      lines.push(`- **${title}** — ${url}`);
    });
  }

  // Forms
  const forms = appContext.forms || [];
  if (forms.length > 0) {
    lines.push(`\n### Key Forms (${forms.length})`);
    forms.slice(0, 8).forEach(f => {
      const fields = (f.fields || []).map(fi => fi.label || fi.name).filter(Boolean).join(', ');
      lines.push(`- ${f.action || 'Form'}: ${fields || '(no fields)'}`);
    });
  }

  // APIs
  const apis = appContext.apis || [];
  if (apis.length > 0) {
    lines.push(`\n### API Endpoints (${apis.length})`);
    apis.slice(0, 12).forEach(a => {
      lines.push(`- ${a.method || 'GET'} ${a.url || a.endpoint || ''}`);
    });
  }

  return lines.join('\n');
}

async function handleGenerateTestCasesStream(data, tabId) {
  validateSettings(data.settings);

  const { ticketKey, ticketData, settings } = data;

  // Resolve crawled context: prefer explicit crawledContext string; fall back to
  // formatting the appContext knowledge graph object that the test gen path sends.
  const crawledContext = data.crawledContext || formatAppContextAsCrawledContext(data.appContext);
  const requestId = `testcases-${Date.now()}`;

  // Fetch external content if integrations are configured
  let enrichedTicketData = ticketData;
  let currentExternalSources = null;
  let externalContent = null;
  try {
    const enrichResult = await enrichTicketWithExternalContent(ticketData, settings);
    enrichedTicketData = enrichResult.enrichedTicketData;
    externalContent = enrichResult.externalContent;
    currentExternalSources = enrichResult.externalSources;
    if (currentExternalSources) {
      console.log('📝 [Test Cases Stream] Enriched ticket with external sources:', currentExternalSources);
    }
  } catch (integrationError) {
    console.warn('⚠️ [Test Cases Stream] Integration fetch failed, continuing with ticket data only:', integrationError.message);
  }

  const systemMessage = `You are an expert QA engineer generating comprehensive test cases.

**IMPORTANT: Write DETAILED descriptions (2-3 sentences) that:**
- Start with "Verify that..."
- Explain what functionality is being tested
- Mention what the user is able to do (or unable to do for negative tests)
- Include the expected behavior or outcome
- Use phrases like: "works correctly", "user is able to", "ensure that", "confirm that", "correctly handles"

Example descriptions:
- Positive: "Verify that the feature flag works correctly and user is able to toggle LLM functionality on/off at the site level. Ensure the toggle persists across sessions and affects all users in the site."
- Negative: "Verify that the system correctly validates file upload size and user is unable to upload files exceeding the 10MB limit. Ensure that appropriate error message is displayed and the system prevents the upload."
- Edge: "Verify that the system correctly handles concurrent user sessions and user is able to perform actions simultaneously from multiple devices. Ensure that data consistency is maintained and no conflicts occur."

Generate test cases in this EXACT JSON format:
{
  "testCases": [
    {
      "id": "TC-XXX-001",
      "title": "Clear test case title",
      "category": "Positive|Negative|Edge|Integration",
      "priority": "P0|P1|P2|P3",
      "description": "Detailed 2-3 sentence description starting with 'Verify that...'",
      "preconditions": "Setup required",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "expected_result": "Expected outcome",
      "test_data": "Required test data"
    }
  ]
}

Distribution: 40% Positive, 30% Negative, 20% Edge, 10% Integration
Generate ${settings.testCount || 30} test cases total.`;

  const userMessage = `Generate test cases for:

**Ticket:** ${ticketKey}
**Summary:** ${enrichedTicketData.summary || 'N/A'}
**Description:** ${enrichedTicketData.description || 'N/A'}
${currentExternalSources ? `**External Sources:** ${currentExternalSources.confluence} Confluence, ${currentExternalSources.figma} Figma, ${currentExternalSources.googleDocs} Google Docs` : ''}
${crawledContext}`;

  const userContent = [
    { type: 'text', text: userMessage }
  ];

  // Add Figma images if available
  if (externalContent && externalContent.figma) {
    externalContent.figma.forEach(figmaFile => {
      if (figmaFile.images && figmaFile.images.length > 0) {
        figmaFile.images.forEach(base64Image => {
          userContent.push({ type: 'image_url', image_url: { url: base64Image } });
        });
      }
    });
  }

  // Add Jira image attachments if available
  if (enrichedTicketData.imageAttachments && enrichedTicketData.imageAttachments.length > 0) {
    console.log(`📷 [Test Cases Stream] Adding ${enrichedTicketData.imageAttachments.length} Jira image attachments`);
    enrichedTicketData.imageAttachments.forEach(image => {
      userContent.push({ type: 'image_url', image_url: { url: image.data } });
    });
  }

  // Ensure content fits within model limits (with graceful truncation)
  const fittedUserContent = ensureContentFitsLimits(userContent, settings);

  console.log('🤖 [Test Cases Stream] Calling AI provider with', fittedUserContent.length, 'content parts...');
  let accumulatedText = '';

  const testCasesResponse = await callAIStream(systemMessage, fittedUserContent, settings, (chunk) => {
    accumulatedText += chunk;
    safeSendMessageToTab(tabId, {
      action: 'streamChunk',
      requestId: requestId,
      chunk: chunk
    });
  }, requestId);
  
  // Parse the final response
  try {
    const jsonMatch = testCasesResponse.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No valid JSON found in response');
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    const testCases = parsed.testCases;
    
    if (!Array.isArray(testCases)) {
      throw new Error('testCases is not an array');
    }
    
    const stats = {
      total: testCases.length,
      byCategory: testCases.reduce((acc, tc) => {
        acc[tc.category] = (acc[tc.category] || 0) + 1;
        return acc;
      }, {}),
      byPriority: testCases.reduce((acc, tc) => {
        acc[tc.priority] = (acc[tc.priority] || 0) + 1;
        return acc;
      }, {})
    };
    
    return { testCases, ...stats, externalSources: currentExternalSources, requestId };
  } catch (error) {
    throw new Error(`Failed to parse test cases: ${error.message}`);
  }
}

// Multi-agent test generation handler
/**
 * Agentic test-case generation.
 *
 * A planner LLM drives an observe→decide→act loop over a tool registry (BM25
 * search, element inspection, coverage check, grounded test proposal, …). Every
 * proposed test passes the AcceptanceGate (grounding + relevance + dedup) before
 * it counts, and coverage is re-measured each round and fed back into the next
 * decision. The result is a grounded, non-duplicate, relevant suite whose size
 * is driven by coverage of the real app rather than a fixed count.
 *
 * Falls back transparently: with no crawl data, grounding is "not applicable" and
 * the gate enforces relevance + dedup against the ticket alone.
 */
// deriveAdaptiveThresholds + round2 are provided by background-utils.js.

async function handleGenerateTestCasesAgentic(data, tabId) {
  validateSettings(data.settings);
  const { ticketData, settings } = data;
  const knowledgeGraph = data.appContext || null;

  // Enrich with external content (Confluence/Figma/Docs) when not pre-supplied.
  let enrichedTicketData = ticketData;
  if (!data.externalSources) {
    try {
      const enrichResult = await enrichTicketWithExternalContent(ticketData, settings);
      enrichedTicketData = enrichResult.enrichedTicketData || ticketData;
    } catch (e) {
      console.warn('[Agentic] external enrichment skipped:', e.message);
    }
  }

  const progress = (event) => safeSendMessageToTab(tabId, { action: 'agentProgress', progress: agenticProgressView(event) });

  // ── Build the grounding + relevance + dedup gate ──
  const verifier = new GroundedVerifier(knowledgeGraph);
  const coverageMapper = knowledgeGraph ? new CoverageMapper(knowledgeGraph) : null;
  const adaptive = deriveAdaptiveThresholds(enrichedTicketData, knowledgeGraph, settings);
  console.log(`[Agentic] adaptive thresholds → dedup ${adaptive.dedupThreshold}, relevance ${adaptive.relevanceThreshold}`);
  const gate = new AcceptanceGate({
    knowledgeGraph,
    ticketData: enrichedTicketData,
    deps: { GroundedVerifier, SemanticDuplicateDetector },
    dedupThreshold: adaptive.dedupThreshold,
    relevanceThreshold: adaptive.relevanceThreshold
  });

  // ── BM25 index over the knowledge graph (best-effort) ──
  let bm25 = null;
  try {
    if (knowledgeGraph && knowledgeGraph.appUrl) {
      const saved = await storageManager.loadBm25Index(knowledgeGraph.appUrl);
      if (saved) bm25 = BM25Index.deserialize(saved);
    }
    if (!bm25 && knowledgeGraph && knowledgeGraph.pages) bm25 = BM25Index.build(knowledgeGraph.pages);
  } catch (e) { console.warn('[Agentic] BM25 unavailable:', e.message); }

  // ── Dynamic distribution from ticket shape ──
  const enabledCategories = Array.isArray(settings.enabledCategories) ? settings.enabledCategories : undefined;
  const distribution = deriveDistribution(enrichedTicketData, { enabledCategories });
  console.log(`[Agentic] ticket shape: ${distribution.primary}; distribution:`, distribution.weights);

  // ── Tool registry wiring existing capabilities ──
  // NOTE: inspect_element grounds against the crawled knowledge graph, NOT the
  // active Jira tab (the tab is the ticket page, not the app under test).
  const tools = new AgentToolRegistry({
    callAI,
    settings,
    ticketData: enrichedTicketData,
    knowledgeGraph,
    bm25,
    coverageMapper,
    verifierIndex: verifier.index,
    getAcceptedTests: () => gate.getAccepted(),
    jiraSearch: makeAgenticJiraSearch(settings),
    confluenceFetch: makeAgenticConfluenceFetch(settings)
  });

  // ── Budget: derive from the test-count slider ──
  const maxTests = clampInt(settings.testCount || settings.maxTestCases || 30, 8, 100);
  const abort = { cancelled: false };
  activeAgenticAborts.add(abort);

  const planner = new PlannerAgent({
    callAI, settings, tools, gate,
    ticketData: enrichedTicketData,
    distribution,
    allocateCounts: (self.DynamicDistribution && self.DynamicDistribution.allocateCounts) || undefined,
    onProgress: progress,
    isCancelled: () => abort.cancelled,
    budget: {
      maxTests,
      maxSteps: Math.min(40, Math.ceil(maxTests * 0.9) + 6),
      coverageTarget: clampInt(settings.coverageTarget || 80, 40, 100),
      maxNoProgress: 4
    }
  });

  const keepAlive = setInterval(() => safeSendMessageToTab(tabId, { action: 'keepAlive', timestamp: Date.now() }), 5000);
  try {
    const result = await planner.run();

    // Surface a real reason when nothing was produced, instead of a silent "0 tests".
    if (!result.testCases || result.testCases.length === 0) {
      const aiErr = result.stats?.aiError?.error;
      const rb = rejectionBreakdown(result.rejected);
      const rejectedCount = (result.rejected || []).length;
      let reason;
      if (aiErr) {
        reason = `Test generation failed: the AI provider returned an error (${aiErr}). Check that your selected model ("${settings.llmModel}") is valid for your ${settings.llmProvider} API key.`;
      } else if (rejectedCount > 0) {
        reason = `Generated ${rejectedCount} candidate test(s), but all were filtered out by the quality gate (${JSON.stringify(rb)}). Try crawling the app first, lowering the relevance/dedup thresholds, or adding more detail to the ticket.`;
      } else {
        reason = 'No test cases were generated. The AI returned no parseable test cases — check the service-worker console (chrome://extensions → QAtalyst → service worker) for details.';
      }
      console.error('[Agentic] 0 tests produced:', reason, result.stats);
      return { error: reason };
    }

    return {
      success: true,
      mode: 'agentic',
      testCases: result.testCases,
      coverage: result.coverage,
      distribution: result.distribution,
      statistics: {
        total: result.testCases.length,
        ...result.stats,
        rejectedCount: (result.rejected || []).length,
        rejectionBreakdown: rejectionBreakdown(result.rejected)
      },
      rejected: (result.rejected || []).slice(0, 50).map(r => ({ title: r.test?.title, stage: r.stage, reason: r.reason }))
    };
  } finally {
    clearInterval(keepAlive);
    activeAgenticAborts.delete(abort);
  }
}

/** Map a planner event to the progress shape the content UI expects (agent/step/total/status/count). */
function agenticProgressView(event) {
  if (!event) return { agent: 'Planner', step: 0, total: 1, status: 'running' };
  const total = Number.isFinite(event.maxSteps) ? event.maxSteps : undefined;
  const step = Number.isFinite(event.step) ? event.step : undefined;
  const count = Number.isFinite(event.acceptedSoFar) ? event.acceptedSoFar
    : (Number.isFinite(event.accepted) ? event.accepted : undefined);
  const base = { agent: 'Planner', step, total, count };

  switch (event.phase) {
    case 'start':
      return { ...base, step: 0, status: 'running', description: 'Planning grounded test coverage…' };
    case 'step':
      return { ...base, status: 'running', description: `${event.tool}${event.thought ? ' — ' + event.thought : ''}` };
    case 'observation':
      return { ...base, status: 'running', description: `${event.tool}: ${event.summary || ''}` };
    case 'rescue':
      return { ...base, status: 'running', description: 'Generating targeted tests…' };
    case 'stop':
    case 'finish':
    case 'done':
      return { ...base, step: total || step, status: 'completed', count: count, description: event.reason || 'Generation complete' };
    case 'cancelled':
      return { ...base, status: 'error', error: 'Generation cancelled' };
    default:
      return { ...base, status: 'running', description: event.phase };
  }
}

// rejectionBreakdown is provided by background-utils.js.

/** Jira search adapter for the query_jira tool. Returns undefined if not available. */
function makeAgenticJiraSearch(settings) {
  if (typeof HistoricalMiningEngine === 'undefined') return undefined;
  return async (jql) => {
    try {
      const engine = new HistoricalMiningEngine(settings);
      if (typeof engine.searchJiraIssues === 'function') {
        const res = await engine.searchJiraIssues(jql);
        return Array.isArray(res) ? res : (res?.issues || []);
      }
    } catch (e) { console.warn('[Agentic] jira search failed:', e.message); }
    return [];
  };
}

/** Confluence fetch adapter for the fetch_confluence tool. Returns undefined if not configured. */
function makeAgenticConfluenceFetch(settings) {
  if (!settings || !settings.confluenceUrl || !settings.confluenceToken) return undefined;
  if (typeof IntegrationManager === 'undefined') return undefined;
  return async (url) => {
    try {
      const mgr = new IntegrationManager(settings);
      const content = await mgr.confluence.fetchPage(url);
      return typeof content === 'string' ? content : (content?.content || content?.text || '');
    } catch (e) { console.warn('[Agentic] confluence fetch failed:', e.message); return ''; }
  };
}

// clampInt is provided by background-utils.js.

// Handle regeneration with user review
async function handleRegenerateWithReview(data) {
  validateSettings(data.settings);

  const { type, originalContent, userReview, settings } = data;

  // Construct prompts based on type
  let systemMessage = '';
  let userMessage = '';

  if (type === 'analysis') {
    systemMessage = `You are a senior business analyst. You previously generated a requirement analysis, and the user has provided feedback to improve it.
Your task is to incorporate the user's feedback and generate an improved, more comprehensive version.`;

    userMessage = `Here is the original requirement analysis you generated:

---
${originalContent}
---

The user provided this feedback:
"${userReview}"

Please regenerate the requirement analysis incorporating the user's feedback. Maintain the same structured markdown format but enhance it based on the feedback provided.`;

  } else if (type === 'testScope') {
    systemMessage = `You are a test planning expert. You previously generated a test scope document, and the user has provided feedback to improve it.
Your task is to incorporate the user's feedback and generate an improved, more comprehensive version.`;

    userMessage = `Here is the original test scope you generated:

---
${originalContent}
---

The user provided this feedback:
"${userReview}"

Please regenerate the test scope incorporating the user's feedback. Maintain the same structured markdown format but enhance it based on the feedback provided.`;

  } else if (type === 'testCases') {
    systemMessage = `You are an expert QA engineer. You previously generated test cases, and the user has provided feedback to improve them.
Your task is to incorporate the user's feedback and generate improved test cases.

Generate test cases in this EXACT JSON format:
{
  "testCases": [
    {
      "id": "TC-XXX-001",
      "title": "Clear test case title",
      "category": "Positive|Negative|Edge|Integration",
      "priority": "P0|P1|P2|P3",
      "description": "What this test validates",
      "preconditions": "Setup required",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "expected_result": "Expected outcome",
      "test_data": "Required test data"
    }
  ]
}`;

    userMessage = `Here are the original test cases you generated:

---
${originalContent}
---

The user provided this feedback:
"${userReview}"

Please regenerate the test cases incorporating the user's feedback. Return the result as a JSON object with a "testCases" array. You can add new test cases, modify existing ones, or remove inadequate ones based on the feedback.`;
  } else {
    throw new Error(`Unknown regeneration type: ${type}`);
  }

  // Call AI with properly separated system/user messages
  const userContent = [
    { type: 'text', text: userMessage }
  ];
  const improvedResponse = await callAI(systemMessage, userContent, settings);

  // Handle test cases specially (need JSON parsing)
  if (type === 'testCases') {
    try {
      const jsonMatch = improvedResponse.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No valid JSON found in improved response');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const improvedTestCases = parsed.testCases;

      if (!Array.isArray(improvedTestCases)) {
        throw new Error('testCases is not an array');
      }

      return { improvedTestCases };
    } catch (error) {
      throw new Error(`Failed to parse improved test cases: ${error.message}`);
    }
  } else {
    // For analysis and test scope, return the improved content directly
    return { improvedContent: improvedResponse };
  }
}

// Test Management Export Handler
async function handleExportToTestManagement(testCases, jiraTicket) {
  try {
    // Get settings from storage
    const settings = await chrome.storage.sync.get([
      'testMgmtPlatform',
      'testrailUrl',
      'testrailUsername',
      'testrailApiKey',
      'testrailProjectId',
      'testrailSection',
      'zephyrScaleApiToken',
      'zephyrScaleProjectKey',
      'zephyrScaleFolderId',
      'zephyrSquadJiraUrl',
      'zephyrSquadUsername',
      'zephyrSquadApiToken',
      'zephyrSquadProjectKey',
      'zephyrSquadVersionId',
      'xrayIsCloud',
      'xrayJiraUrl',
      'xrayUsername',
      'xrayApiToken',
      'xrayClientId',
      'xrayClientSecret',
      'xrayProjectKey',
      'qmetryIsCloud',
      'qmetryApiUrl',
      'qmetryApiKey',
      'qmetryUsername',
      'qmetryPassword',
      'qmetryProjectId',
      'qmetryReleaseId',
      'fieldMappings'
    ]);

    const platform = settings.testMgmtPlatform;

    if (!platform || platform === 'none') {
      throw new Error('No test management platform configured. Please configure one in Settings > Integrations.');
    }

    let integration;
    let results;
    let fieldMappings = {};

    // Parse field mappings if available
    if (settings.fieldMappings) {
      try {
        fieldMappings = JSON.parse(settings.fieldMappings);
      } catch (e) {
        console.warn('Failed to parse field mappings:', e);
      }
    }

    // Create integration instance based on platform
    switch (platform) {
      case 'testrail':
        integration = new TestRailIntegration({
          testrailUrl: settings.testrailUrl,
          testrailUsername: settings.testrailUsername,
          testrailApiKey: settings.testrailApiKey,
          testrailProjectId: settings.testrailProjectId,
          testrailSection: settings.testrailSection
        });
        // Store for cancellation
        activeIntegration = integration;
        results = await integration.uploadTestCases(testCases, jiraTicket, null, fieldMappings);
        break;

      case 'zephyr-scale':
        integration = new ZephyrScaleIntegration({
          zephyrScaleApiToken: settings.zephyrScaleApiToken,
          zephyrScaleProjectKey: settings.zephyrScaleProjectKey,
          zephyrScaleFolderId: settings.zephyrScaleFolderId
        });
        results = await integration.uploadTestCases(testCases, jiraTicket, `QAtalyst: ${jiraTicket}`, { customFields: fieldMappings });
        break;

      case 'zephyr-squad':
        integration = new ZephyrSquadIntegration({
          zephyrSquadJiraUrl: settings.zephyrSquadJiraUrl,
          zephyrSquadUsername: settings.zephyrSquadUsername,
          zephyrSquadApiToken: settings.zephyrSquadApiToken,
          zephyrSquadProjectKey: settings.zephyrSquadProjectKey,
          zephyrSquadVersionId: settings.zephyrSquadVersionId
        });
        results = await integration.uploadTestCases(testCases, jiraTicket, null, { customFields: fieldMappings });
        break;

      case 'xray':
        integration = new XrayIntegration({
          xrayIsCloud: settings.xrayIsCloud,
          xrayJiraUrl: settings.xrayJiraUrl,
          xrayUsername: settings.xrayUsername,
          xrayApiToken: settings.xrayApiToken,
          xrayClientId: settings.xrayClientId,
          xrayClientSecret: settings.xrayClientSecret,
          xrayProjectKey: settings.xrayProjectKey
        });
        results = await integration.uploadTestCases(testCases, jiraTicket, null, { customFields: fieldMappings });
        break;

      case 'qmetry':
        integration = new QmetryIntegration({
          qmetryIsCloud: settings.qmetryIsCloud,
          qmetryApiUrl: settings.qmetryApiUrl,
          qmetryApiKey: settings.qmetryApiKey,
          qmetryUsername: settings.qmetryUsername,
          qmetryPassword: settings.qmetryPassword,
          qmetryProjectId: settings.qmetryProjectId,
          qmetryReleaseId: settings.qmetryReleaseId
        });
        results = await integration.uploadTestCases(testCases, jiraTicket, `QAtalyst: ${jiraTicket}`, { customFields: fieldMappings });
        break;

      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }

    // Return success response with results
    return {
      success: true,
      platform: getPlatformDisplayName(platform),
      results: results
    };

  } catch (error) {
    console.error('Export to test management failed:', error);
    throw error;
  }
}

function getPlatformDisplayName(platform) {
  const displayNames = {
    'testrail': 'TestRail',
    'zephyr-scale': 'Zephyr Scale',
    'zephyr-squad': 'Zephyr Squad',
    'xray': 'Xray',
    'qmetry': 'qMetry'
  };
  return displayNames[platform] || platform;
}

// Installation handler
chrome.runtime.onInstalled.addListener(() => {
  console.log('QAtalyst extension installed with multi-agent system');
});

