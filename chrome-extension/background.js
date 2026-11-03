// Background service worker for QAtalyst
// Direct API calls to OpenAI, Claude, and Gemini with streaming support
// Multi-agent test generation system

// Import configuration loader (must be first)
importScripts('config-loader.js');

// Import configuration and utilities
importScripts('config.js');
importScripts('logger.js');
importScripts('security.js');
importScripts('host-permissions.js');
importScripts('rate-limiter.js');
importScripts('token-counter.js');
importScripts('context-manager.js');
importScripts('graph-filter.js');
importScripts('bm25.js');
importScripts('json-parser.js');
importScripts('assertion-critic.js');
importScripts('text-similarity.js');
importScripts('embeddings.js');
importScripts('background-utils.js');
importScripts('llm-client.js');
importScripts('prompts.js');
importScripts('figma-design-kg.js');
importScripts('integrations.js');
importScripts('integrations-docs.js');
importScripts('integrations-testrail.js');
importScripts('integrations-testmgmt.js');
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
importScripts('test-case-finalizer.js');
importScripts('document-extractor.js');
importScripts('requirement-model.js');
importScripts('assertion-specifics.js');
importScripts('coverage-judge.js');
importScripts('test-steps.js');
importScripts('test-runner.js');
importScripts('export-ledger.js');
importScripts('readiness.js');
importScripts('review-memory.js');
importScripts('settings-schema.js');
importScripts('contract-import.js');
// Model capabilities (reasoning vs chat parameter shapes) + discovery helpers.
importScripts('model-registry.js');
importScripts('agent-tools.js');
importScripts('agent-loop.js');

// Import web crawler modules
importScripts('crawler-auth.js');
importScripts('crawler.js');
importScripts('crawler-page.js');
importScripts('crawler-urls.js');
importScripts('crawler-graph.js');
importScripts('crawler-tuning.js');
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
// Handlers split out of this file (plain scripts: their functions stay globals).
importScripts('bg-connections.js');
importScripts('bg-context.js');
importScripts('bg-generation.js');
importScripts('bg-agentic.js');
importScripts('bg-export.js');

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
    const buffer = await response.arrayBuffer();

    // F24: real extraction (document-extractor.js). The old inline implementation
    // regex-scanned RAW PDF bytes for `(text)Tj`, which matches nothing once the
    // content streams are FlateDecode-compressed — i.e. on essentially every real
    // PDF — and then declared the file "scanned". DOCX was rejected outright.
    const result = await extractDocument(buffer, fileName, contentType);

    // Every outcome is reported, including the ones with no text, so the caller
    // can tell the user which attachment could not be read and why.
    return {
      success: result.status === 'extracted',
      status: result.status,
      text: result.text || '',
      note: result.note || '',
      base64: result.base64,
      mimeType: result.mimeType,
      isScannedPdf: result.status === 'no_text_layer' && result.type === 'pdf',
      fileName,
      type: result.type,
      error: result.status === 'extracted' ? undefined : (result.note || result.status)
    };
  } catch (error) {
    console.warn(`⚠️ [Background] Document extraction failed: ${error.message}`);
    return { success: false, status: 'fetch_failed', error: error.message, fileName, text: '' };
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
    // F28: these actions are tab-bound. A message from the popup/options page has
    // no sender.tab, so guard instead of throwing an uncaught TypeError.
    if (!sender.tab || sender.tab.id == null) { sendResponse({ error: 'This action must be triggered from a Jira tab.' }); return false; }
    const tabId = sender.tab.id;
    sendResponse({ started: true }); // release channel immediately
    handleAnalyzeRequirementsStream(request.data, tabId)
      .then(result => safeSendMessageToTab(tabId, { action: 'streamComplete', streamType: 'analyze', ticketKey: request.data?.ticketKey, result }))
      .catch(error => safeSendMessageToTab(tabId, { action: 'streamError', streamType: 'analyze', ticketKey: request.data?.ticketKey, error: error.message }));
    return false;
  }

  if (request.action === 'generateTestScopeStream') {
    if (!sender.tab || sender.tab.id == null) { sendResponse({ error: 'This action must be triggered from a Jira tab.' }); return false; }
    const tabId = sender.tab.id;
    sendResponse({ started: true });
    handleGenerateTestScopeStream(request.data, tabId)
      .then(result => safeSendMessageToTab(tabId, { action: 'streamComplete', streamType: 'scope', ticketKey: request.data?.ticketKey, result }))
      .catch(error => safeSendMessageToTab(tabId, { action: 'streamError', streamType: 'scope', ticketKey: request.data?.ticketKey, error: error.message }));
    return false;
  }

  if (request.action === 'generateTestCasesStream') {
    if (!sender.tab || sender.tab.id == null) { sendResponse({ error: 'This action must be triggered from a Jira tab.' }); return false; }
    const tabId = sender.tab.id;
    sendResponse({ started: true });
    handleGenerateTestCasesStream(request.data, tabId)
      .then(result => safeSendMessageToTab(tabId, { action: 'streamComplete', streamType: 'testcases', ticketKey: request.data?.ticketKey, result }))
      .catch(error => safeSendMessageToTab(tabId, { action: 'streamError', streamType: 'testcases', ticketKey: request.data?.ticketKey, error: error.message }));
    return false;
  }
  
  if (request.action === 'stopGeneration') {
    const cancelled = cancelStream(request.requestId);
    sendResponse({ success: cancelled });
    return true;
  }

  if (request.action === 'stopMultiAgentGeneration') {
    let stopped = false;
    for (const abort of activeAgenticAborts) {
      abort.cancelled = true;
      // F17: cancellation was a boolean checked BETWEEN planner iterations, so a
      // cancel during a long provider call waited for that call (and its retries)
      // to finish before taking effect. Abort the in-flight request too.
      try { abort.controller && abort.controller.abort(); } catch (_) {}
      stopped = true;
    }
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
    if (!sender.tab || sender.tab.id == null) { sendResponse({ error: 'This action must be triggered from a Jira tab.' }); return false; }
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
  // A content script cannot read chrome.storage.session, so it asks the worker to
  // open passphrase-sealed values. Only our own extension's scripts can message us,
  // and only "encp:" values are handled here.
  if (request.action === 'decryptSecret') {
    if (!sender || sender.id !== chrome.runtime.id || typeof request.value !== 'string' || !request.value.startsWith('encp:')) {
      sendResponse({ error: 'not allowed' });
      return false;
    }
    securityManager.decryptApiKeyFromStorage(request.value)
      .then(value => sendResponse({ value }))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  // "Verify in app": replay generated tests in a background tab (test-runner.js).
  if (request.action === 'runTestsInApp') {
    const tabId = sender && sender.tab && sender.tab.id;
    const d = request.data || {};
    self.TestRunner.runTestsInApp(d.tests || [], {
      knowledgeGraph: d.knowledgeGraph || null,
      allowDestructive: d.allowDestructive === true,
      startUrl: typeof d.startUrl === 'string' && /^https?:\/\//.test(d.startUrl) ? d.startUrl : null,
      onProgress: (done, total, result) => safeSendMessageToTab(tabId, { action: 'runTestsProgress', done, total, result })
    })
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

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

  // §15.1: record what a reviewer decided about a case, so the decision survives
  // the next run instead of having to be made again.
  if (request.action === 'recordReviewDecision') {
    (async () => {
      try {
        const { testCase, verdict, meta, project } = request.data || {};
        if (typeof ReviewMemory !== 'function') { sendResponse({ success: false, error: 'review memory unavailable' }); return; }
        const memory = await new ReviewMemory(chrome.storage.local, project || 'default').load();
        memory.record(testCase, verdict, meta || {});
        await memory.save();
        sendResponse({ success: true });
      } catch (e) { sendResponse({ success: false, error: e.message }); }
    })();
    return true;
  }

  // §14: accept imported evidence files (OpenAPI, role/state profile, PR diff,
  // execution results, runtime errors) and report what each one yielded.
  if (request.action === 'importEvidence') {
    (async () => {
      try {
        const parsed = buildImportedEvidence(request.data || {});
        if (!parsed) { sendResponse({ success: false, error: 'No usable evidence in the supplied files' }); return; }
        await chrome.storage.local.set({ qatalyst_imported_evidence: request.data });
        sendResponse({
          success: true,
          obligations: parsed.obligations.length,
          sources: parsed.sources.map(s => s.source),
          failures: parsed.failures
        });
      } catch (e) { sendResponse({ success: false, error: e.message }); }
    })();
    return true;
  }

  // F17: let the panel recover a partial suite from an interrupted or cancelled run.
  if (request.action === 'getRecoverableRuns') {
    listRecoverableRuns(request.data && request.data.ticketKey)
      .then(runs => sendResponse({ success: true, runs }))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (request.action === 'discardRecoverableRun') {
    const key = request.data && request.data.key;
    if (!key || !String(key).startsWith('agentic_ckpt_')) {
      sendResponse({ success: false, error: 'invalid checkpoint key' });
      return false;
    }
    chrome.storage.session.remove(key)
      .then(() => sendResponse({ success: true }))
      .catch(e => sendResponse({ success: false, error: e.message }));
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

  // Combine already-filtered graphs for one generation run, without storing a
  // merged app. Generation needs the app AND the docs together; persisting a new
  // merged graph every time a ticket is generated would be a side effect nobody
  // asked for.
  if (request.action === 'mergeGraphsInMemory') {
    (async () => {
      try {
        const graphs = (request.data && request.data.graphs) || [];
        if (graphs.length < 2) {
          sendResponse({ success: true, knowledgeGraph: graphs[0] || null });
          return;
        }
        if (typeof KnowledgeGraphMerger === 'undefined') {
          sendResponse({ success: false, error: 'merger unavailable' });
          return;
        }
        const merged = await new KnowledgeGraphMerger().mergeGraphs(graphs);
        sendResponse({ success: true, knowledgeGraph: merged });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    })();
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

