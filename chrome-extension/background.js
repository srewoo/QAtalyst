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
importScripts('duplicate-detector.js');
importScripts('agents.js');
importScripts('ai-feature-agent.js');
importScripts('evolution.js');
importScripts('integrations.js');
importScripts('enhancements.js');
importScripts('historical-mining.js');

// Import NEW validation and quality systems
importScripts('test-validator.js');
importScripts('context-checker.js');
importScripts('semantic-duplicate-detector.js');
importScripts('coverage-mapper.js');

// Import web crawler modules
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
const activeStreams = new Map();

// Active test management integration (for cancellation)
let activeIntegration = null;

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
    console.log('  API Key:', settings.apiKey ? '✅ SET (' + settings.apiKey.substring(0, 10) + '...)' : '❌ NOT SET');
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
    const response = await fetch(url, {
      credentials: 'include',
      headers: {
        'Accept': 'image/*'
      }
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
  
  // Streaming actions
  if (request.action === 'analyzeRequirementsStream') {
    handleAnalyzeRequirementsStream(request.data, sender.tab.id)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  if (request.action === 'generateTestScopeStream') {
    handleGenerateTestScopeStream(request.data, sender.tab.id)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  if (request.action === 'generateTestCasesStream') {
    handleGenerateTestCasesStream(request.data, sender.tab.id)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  if (request.action === 'stopGeneration') {
    const cancelled = cancelStream(request.requestId);
    sendResponse({ success: cancelled });
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

  // Multi-agent test generation
  if (request.action === 'generateTestCasesMultiAgent') {
    handleGenerateTestCasesMultiAgent(request.data, sender.tab.id)
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

async function awsSignRequest({ method, url, headers, body, region, accessKeyId, secretAccessKey, service = 'bedrock' }) {
  const parsedUrl = new URL(url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.substring(0, 8);

  headers['x-amz-date'] = amzDate;
  headers['host'] = parsedUrl.host;

  const payloadHash = toHex(await sha256(body || ''));
  headers['x-amz-content-sha256'] = payloadHash;

  // Canonical headers - must be sorted by lowercase key
  const signedHeaderKeys = Object.keys(headers).map(k => k.toLowerCase()).sort();
  const canonicalHeaders = signedHeaderKeys.map(k => `${k}:${headers[Object.keys(headers).find(h => h.toLowerCase() === k)].trim()}`).join('\n') + '\n';
  const signedHeaders = signedHeaderKeys.join(';');

  // Canonical request
  const canonicalRequest = [
    method,
    parsedUrl.pathname,
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
  return modelId && (modelId.includes('openai.gpt') || modelId.includes('openai.o3') || modelId.includes('openai.o1'));
}

async function callBedrock(contentParts, settings, retries = MAX_RETRIES) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const model = settings.llmModel || APP_CONFIG.DEFAULT_MODELS.bedrock;
    const region = settings.bedrockRegion || 'us-east-1';
    const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/invoke`;
    const isOpenAI = isBedrockOpenAIModel(model);

    let requestBody;

    if (isOpenAI) {
      // OpenAI models on Bedrock use OpenAI-compatible chat completion format
      const openaiMessages = [{ role: 'user', content: [] }];
      for (const part of contentParts) {
        if (typeof part === 'string') {
          openaiMessages[0].content.push({ type: 'text', text: part });
        } else if (part.type === 'text') {
          openaiMessages[0].content.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
          openaiMessages[0].content.push({ type: 'image_url', image_url: { url: part.image_url.url } });
        }
      }

      requestBody = JSON.stringify({
        max_tokens: settings.maxTokens || APP_CONFIG.DEFAULT_MAX_TOKENS,
        messages: openaiMessages,
        temperature: settings.temperature || APP_CONFIG.DEFAULT_TEMPERATURE
      });
    } else {
      // Claude/Anthropic models on Bedrock
      const claudeMessages = [{ role: 'user', content: [] }];
      for (const part of contentParts) {
        if (typeof part === 'string') {
          claudeMessages[0].content.push({ type: 'text', text: part });
        } else if (part.type === 'text') {
          claudeMessages[0].content.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
          const { base64Data, mediaType } = parseDataUri(part.image_url.url);
          if (base64Data) {
            claudeMessages[0].content.push({
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64Data }
            });
          }
        }
      }

      requestBody = JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: settings.maxTokens || APP_CONFIG.DEFAULT_MAX_TOKENS,
        messages: claudeMessages,
        temperature: settings.temperature || APP_CONFIG.DEFAULT_TEMPERATURE
      });
    }

    const headers = { 'Content-Type': 'application/json' };
    await awsSignRequest({
      method: 'POST',
      url,
      headers,
      body: requestBody,
      region,
      accessKeyId: settings.bedrockAccessKeyId,
      secretAccessKey: settings.bedrockSecretKey,
      service: 'bedrock'
    });

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: requestBody,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.status === 429 && retries > 0) {
      const retryAfter = response.headers.get('Retry-After');
      const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : RETRY_DELAY * Math.pow(2, MAX_RETRIES - retries);
      console.warn(`Bedrock rate limit hit (429), retrying after ${waitTime}ms (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
      await sleep(waitTime);
      return callBedrock(contentParts, settings, retries - 1);
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.message || errorData.error?.message || `Bedrock API error: ${response.status}`);
      error.status = response.status;
      error.response = response;
      throw error;
    }

    const data = await response.json();

    // OpenAI models return OpenAI-format response; Claude returns Anthropic format
    if (isOpenAI) {
      if (!data.choices?.[0]?.message?.content) {
        throw new Error('Bedrock OpenAI returned empty or malformed response');
      }
      return data.choices[0].message.content;
    }
    if (!data.content?.[0]?.text) {
      throw new Error('Bedrock Claude returned empty or malformed response');
    }
    return data.content[0].text;

  } catch (error) {
    clearTimeout(timeoutId);

    if (retries > 0 && error.name === 'AbortError') {
      console.log(`Retrying Bedrock request... (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
      await sleep(RETRY_DELAY);
      return callBedrock(contentParts, settings, retries - 1);
    }

    if (error.name === 'AbortError') {
      throw new Error(APP_CONFIG.ERRORS.TIMEOUT);
    }

    if (error.status === 429 || error.message.includes('Rate limit') || error.message.includes('ThrottlingException')) {
      throw new Error(APP_CONFIG.ERRORS.RATE_LIMIT);
    }
    if (error.message.includes('network') || error.message.includes('fetch')) {
      throw new Error(APP_CONFIG.ERRORS.NETWORK_ERROR);
    }

    throw error;
  }
}

// Streaming version of Bedrock API (Claude + OpenAI models)
async function callBedrockStream(contentParts, settings, onChunk, requestId) {
  const controller = new AbortController();
  activeStreams.set(requestId, controller);

  let reader = null;

  try {
    const model = settings.llmModel || APP_CONFIG.DEFAULT_MODELS.bedrock;
    const region = settings.bedrockRegion || 'us-east-1';
    const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/invoke-with-response-stream`;
    const isOpenAI = isBedrockOpenAIModel(model);

    let requestBody;

    if (isOpenAI) {
      // OpenAI models on Bedrock use OpenAI-compatible format
      const openaiMessages = [{ role: 'user', content: [] }];
      for (const part of contentParts) {
        if (typeof part === 'string') {
          openaiMessages[0].content.push({ type: 'text', text: part });
        } else if (part.type === 'text') {
          openaiMessages[0].content.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
          openaiMessages[0].content.push({ type: 'image_url', image_url: { url: part.image_url.url } });
        }
      }

      requestBody = JSON.stringify({
        max_tokens: settings.maxTokens || APP_CONFIG.DEFAULT_MAX_TOKENS,
        messages: openaiMessages,
        stream: true,
        temperature: settings.temperature || APP_CONFIG.DEFAULT_TEMPERATURE
      });
    } else {
      // Claude/Anthropic models on Bedrock
      const claudeMessages = [{ role: 'user', content: [] }];
      for (const part of contentParts) {
        if (typeof part === 'string') {
          claudeMessages[0].content.push({ type: 'text', text: part });
        } else if (part.type === 'text') {
          claudeMessages[0].content.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
          const { base64Data, mediaType } = parseDataUri(part.image_url.url);
          if (base64Data) {
            claudeMessages[0].content.push({
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64Data }
            });
          }
        }
      }

      requestBody = JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: settings.maxTokens || APP_CONFIG.DEFAULT_MAX_TOKENS,
        messages: claudeMessages,
        temperature: settings.temperature || APP_CONFIG.DEFAULT_TEMPERATURE
      });
    }

    const headers = { 'Content-Type': 'application/json' };
    await awsSignRequest({
      method: 'POST',
      url,
      headers,
      body: requestBody,
      region,
      accessKeyId: settings.bedrockAccessKeyId,
      secretAccessKey: settings.bedrockSecretKey,
      service: 'bedrock'
    });

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: requestBody,
      signal: controller.signal
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || errorData.error?.message || `Bedrock API error: ${response.status}`);
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const responseChunks = [];
    const streamStartTime = Date.now();
    let iterationCount = 0;

    while (true) {
      if (Date.now() - streamStartTime > STREAMING_TIMEOUT_MS) {
        logger.warn('Bedrock streaming timeout reached');
        break;
      }
      if (++iterationCount > MAX_STREAMING_ITERATIONS) {
        logger.warn('Bedrock streaming max iterations reached');
        break;
      }

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          if (isOpenAI) {
            // OpenAI streaming format: SSE data lines
            if (trimmed.startsWith('data: ')) {
              const data = trimmed.slice(6);
              if (data === '[DONE]') continue;
              const parsed = JSON.parse(data);
              const chunk = parsed.choices?.[0]?.delta?.content;
              if (chunk) {
                responseChunks.push(chunk);
                onChunk(chunk);
              }
            } else {
              // Try parsing as JSON directly (Bedrock event wrapper)
              const event = JSON.parse(trimmed);
              if (event.bytes) {
                const decoded = JSON.parse(atob(event.bytes));
                const chunk = decoded.choices?.[0]?.delta?.content;
                if (chunk) {
                  responseChunks.push(chunk);
                  onChunk(chunk);
                }
              }
            }
          } else {
            // Claude streaming format: Bedrock event stream
            const event = JSON.parse(trimmed);
            if (event.bytes) {
              const decoded = JSON.parse(atob(event.bytes));
              if (decoded.type === 'content_block_delta' && decoded.delta?.text) {
                responseChunks.push(decoded.delta.text);
                onChunk(decoded.delta.text);
              }
            } else if (event.type === 'content_block_delta' && event.delta?.text) {
              responseChunks.push(event.delta.text);
              onChunk(event.delta.text);
            }
          }
        } catch (e) {
          // Skip unparseable chunks
        }
      }
    }

    return responseChunks.join('');

  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Generation cancelled by user');
    }
    throw error;
  } finally {
    if (reader) {
      try {
        await reader.cancel();
      } catch (e) {
        // Ignore cancel errors
      }
    }
    activeStreams.delete(requestId);
  }
}

// Call OpenAI API directly
async function callOpenAI(contentParts, settings, retries = MAX_RETRIES) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    // Build OpenAI message content with proper format for text and images
    const openaiContent = [];
    for (const part of contentParts) {
      if (typeof part === 'string') {
        openaiContent.push({ type: 'text', text: part });
      } else if (part.type === 'text') {
        openaiContent.push({ type: 'text', text: part.text });
      } else if (part.type === 'image_url') {
        openaiContent.push({ type: 'image_url', image_url: { url: part.image_url.url } });
      }
    }

    const messages = [
      { role: 'user', content: openaiContent }
    ];

    // Check token count and warn if approaching limits
    const model = settings.llmModel || 'gpt-4.1';
    const tokenCheck = checkTokenLimit(
      estimateMessagesTokens(messages),
      model,
      settings.maxTokens || 16000
    );

    if (!tokenCheck.safe) {
      console.error(`❌ ${tokenCheck.warning}`);
      throw new Error(`Token limit exceeded for ${model}. Please reduce input size.`);
    } else if (tokenCheck.warning) {
      console.warn(`⚠️ ${tokenCheck.warning}`);
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        model: settings.llmModel || 'gpt-4.1',
        messages: messages,
        temperature: settings.temperature || 0.7,
        max_tokens: settings.maxTokens || 16000
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);

    // Handle rate limiting (429) with retry
    if (response.status === 429 && retries > 0) {
      const retryAfter = response.headers.get('Retry-After');
      const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : RETRY_DELAY * Math.pow(2, MAX_RETRIES - retries);

      console.warn(`OpenAI rate limit hit (429), retrying after ${waitTime}ms (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
      await sleep(waitTime);
      return callOpenAI(contentParts, settings, retries - 1);
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.error?.message || `OpenAI API error: ${response.status}`);
      error.status = response.status;
      error.response = response;
      throw error;
    }

    const data = await response.json();
    if (!data.choices?.[0]?.message?.content) {
      throw new Error('OpenAI returned empty or malformed response');
    }
    return data.choices[0].message.content;

  } catch (error) {
    clearTimeout(timeoutId);

    // Retry on timeout
    if (retries > 0 && error.name === 'AbortError') {
      console.log(`Retrying OpenAI request... (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
      await sleep(RETRY_DELAY);
      return callOpenAI(contentParts, settings, retries - 1);
    }

    if (error.name === 'AbortError') {
      throw new Error(APP_CONFIG.ERRORS.TIMEOUT);
    }

    // Better error messages
    if (error.status === 429 || error.message.includes('Rate limit')) {
      throw new Error(APP_CONFIG.ERRORS.RATE_LIMIT);
    }
    if (error.message.includes('network') || error.message.includes('fetch')) {
      throw new Error(APP_CONFIG.ERRORS.NETWORK_ERROR);
    }

    throw error;
  }
}

// Call Gemini API directly
async function callGemini(contentParts, settings, retries = MAX_RETRIES) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  
  try {
    const model = settings.llmModel || 'gemini-2.5-flash-exp';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const geminiContent = contentParts.map(part => {
      if (typeof part === 'string') {
        return { text: part };
      } else if (part.type === 'image_url') {
        const { base64Data, mediaType } = parseDataUri(part.image_url.url);
        if (base64Data) {
          return { inlineData: { mimeType: mediaType, data: base64Data } };
        }
        return { text: '[image unavailable]' };
      }
      return part;
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': settings.apiKey
      },
      body: JSON.stringify({
        contents: [{
          parts: geminiContent
        }],
        generationConfig: {
          temperature: settings.temperature || 0.7,
          maxOutputTokens: settings.maxTokens || 16000
        }
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);

    // Handle rate limiting (429) with retry
    if (response.status === 429 && retries > 0) {
      const retryAfter = response.headers.get('Retry-After');
      const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : RETRY_DELAY * Math.pow(2, MAX_RETRIES - retries);

      console.warn(`Gemini rate limit hit (429), retrying after ${waitTime}ms (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
      await sleep(waitTime);
      return callGemini(contentParts, settings, retries - 1);
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.error?.message || `Gemini API error: ${response.status}`);
      error.status = response.status;
      error.response = response;
      throw error;
    }

    const data = await response.json();
    if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
      throw new Error('Gemini returned empty or malformed response');
    }
    return data.candidates[0].content.parts[0].text;

  } catch (error) {
    clearTimeout(timeoutId);

    // Retry on timeout
    if (retries > 0 && error.name === 'AbortError') {
      console.log(`Retrying Gemini request... (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
      await sleep(RETRY_DELAY);
      return callGemini(contentParts, settings, retries - 1);
    }

    if (error.name === 'AbortError') {
      throw new Error(APP_CONFIG.ERRORS.TIMEOUT);
    }

    // Better error messages
    if (error.status === 429 || error.message.includes('Rate limit')) {
      throw new Error(APP_CONFIG.ERRORS.RATE_LIMIT);
    }
    if (error.message.includes('network') || error.message.includes('fetch')) {
      throw new Error(APP_CONFIG.ERRORS.NETWORK_ERROR);
    }

    throw error;
  }
}

// Call Claude (Anthropic) API directly
async function callClaude(contentParts, settings, retries = MAX_RETRIES) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  
  try {
    const claudeMessages = [
      { role: 'user', content: [] }
    ];

    for (const part of contentParts) {
      if (typeof part === 'string') {
        claudeMessages[0].content.push({ type: 'text', text: part });
      } else if (part.type === 'text') {
        claudeMessages[0].content.push({ type: 'text', text: part.text });
      } else if (part.type === 'image_url') {
        const { base64Data, mediaType } = parseDataUri(part.image_url.url);
        if (base64Data) {
          claudeMessages[0].content.push({
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64Data }
          });
        }
      }
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: settings.llmModel || 'claude-sonnet-4-20250514',
        max_tokens: settings.maxTokens || 16000,
        messages: claudeMessages,
        temperature: settings.temperature || 0.7
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);

    // Handle rate limiting (429) with retry
    if (response.status === 429 && retries > 0) {
      const retryAfter = response.headers.get('Retry-After') || response.headers.get('retry-after');
      const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : RETRY_DELAY * Math.pow(2, MAX_RETRIES - retries);

      console.warn(`Claude rate limit hit (429), retrying after ${waitTime}ms (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
      await sleep(waitTime);
      return callClaude(contentParts, settings, retries - 1);
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.error?.message || `Claude API error: ${response.status}`);
      error.status = response.status;
      error.response = response;
      throw error;
    }

    const data = await response.json();
    if (!data.content?.[0]?.text) {
      throw new Error('Claude returned empty or malformed response');
    }
    return data.content[0].text;

  } catch (error) {
    clearTimeout(timeoutId);

    // Retry on timeout
    if (retries > 0 && error.name === 'AbortError') {
      console.log(`Retrying Claude request... (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
      await sleep(RETRY_DELAY);
      return callClaude(contentParts, settings, retries - 1);
    }

    if (error.name === 'AbortError') {
      throw new Error(APP_CONFIG.ERRORS.TIMEOUT);
    }

    // Better error messages
    if (error.status === 429 || error.message.includes('Rate limit')) {
      throw new Error(APP_CONFIG.ERRORS.RATE_LIMIT);
    }
    if (error.message.includes('network') || error.message.includes('fetch')) {
      throw new Error(APP_CONFIG.ERRORS.NETWORK_ERROR);
    }

    throw error;
  }
}

// Streaming version of OpenAI API
async function callOpenAIStream(contentParts, settings, onChunk, requestId) {
  const controller = new AbortController();
  activeStreams.set(requestId, controller);

  let reader = null;

  try {
    const messages = [
      { role: 'user', content: contentParts }
    ];

    const response = await fetch(APP_CONFIG.ENDPOINTS.openai, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        model: settings.llmModel || APP_CONFIG.DEFAULT_MODELS.openai,
        messages: messages,
        stream: true,
        temperature: settings.temperature || APP_CONFIG.DEFAULT_TEMPERATURE,
        max_tokens: settings.maxTokens || APP_CONFIG.DEFAULT_MAX_TOKENS
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `OpenAI API error: ${response.status}`);
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const responseChunks = [];
    const streamStartTime = Date.now();
    let iterationCount = 0;

    while (true) {
      // Timeout safeguard
      if (Date.now() - streamStartTime > STREAMING_TIMEOUT_MS) {
        logger.warn('OpenAI streaming timeout reached');
        break;
      }

      // Iteration safeguard
      if (++iterationCount > MAX_STREAMING_ITERATIONS) {
        logger.warn('OpenAI streaming max iterations reached');
        break;
      }

      const {done, value} = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const chunk = parsed.choices[0]?.delta?.content;
            if (chunk) {
              responseChunks.push(chunk);
              onChunk(chunk);
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }

    return responseChunks.join('');

  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Generation cancelled by user');
    }
    throw error;
  } finally {
    // CRITICAL: Always cleanup resources
    if (reader) {
      try {
        await reader.cancel();
      } catch (e) {
        // Ignore cancel errors
      }
    }
    activeStreams.delete(requestId);
  }
}

// Streaming version of Claude API
async function callClaudeStream(contentParts, settings, onChunk, requestId) {
  const controller = new AbortController();
  activeStreams.set(requestId, controller);

  let reader = null;

  try {
    const claudeMessages = [
      { role: 'user', content: [] }
    ];

    for (const part of contentParts) {
      if (typeof part === 'string') {
        claudeMessages[0].content.push({ type: 'text', text: part });
      } else if (part.type === 'text') {
        claudeMessages[0].content.push({ type: 'text', text: part.text });
      } else if (part.type === 'image_url') {
        const { base64Data, mediaType } = parseDataUri(part.image_url.url);
        if (base64Data) {
          claudeMessages[0].content.push({
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64Data }
          });
        }
      }
    }

    const response = await fetch(APP_CONFIG.ENDPOINTS.claude, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: settings.llmModel || APP_CONFIG.DEFAULT_MODELS.claude,
        max_tokens: settings.maxTokens || APP_CONFIG.DEFAULT_MAX_TOKENS,
        messages: claudeMessages,
        temperature: settings.temperature || APP_CONFIG.DEFAULT_TEMPERATURE,
        stream: true
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Claude API error: ${response.status}`);
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const responseChunks = [];
    const streamStartTime = Date.now();
    let iterationCount = 0;

    while (true) {
      // Timeout safeguard
      if (Date.now() - streamStartTime > STREAMING_TIMEOUT_MS) {
        logger.warn('Claude streaming timeout reached');
        break;
      }

      // Iteration safeguard
      if (++iterationCount > MAX_STREAMING_ITERATIONS) {
        logger.warn('Claude streaming max iterations reached');
        break;
      }

      const {done, value} = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);

          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              const chunk = parsed.delta.text;
              responseChunks.push(chunk);
              onChunk(chunk);
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }

    return responseChunks.join('');

  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Generation cancelled by user');
    }
    throw error;
  } finally {
    // CRITICAL: Always cleanup resources
    if (reader) {
      try {
        await reader.cancel();
      } catch (e) {
        // Ignore cancel errors
      }
    }
    activeStreams.delete(requestId);
  }
}

// Streaming version of Gemini API (Note: Gemini uses SSE differently)
async function callGeminiStream(contentParts, settings, onChunk, requestId) {
  const controller = new AbortController();
  activeStreams.set(requestId, controller);

  let reader = null;

  try {
    const model = settings.llmModel || APP_CONFIG.DEFAULT_MODELS.gemini;
    const url = `${APP_CONFIG.ENDPOINTS.gemini}/${model}:streamGenerateContent?alt=sse`;

    const geminiContent = contentParts.map(part => {
      if (typeof part === 'string') {
        return { text: part };
      } else if (part.type === 'image_url') {
        const { base64Data, mediaType } = parseDataUri(part.image_url.url);
        if (base64Data) {
          return { inlineData: { mimeType: mediaType, data: base64Data } };
        }
        return { text: '[image unavailable]' };
      }
      return part;
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': settings.apiKey
      },
      body: JSON.stringify({
        contents: [{
          parts: geminiContent
        }],
        generationConfig: {
          temperature: settings.temperature || APP_CONFIG.DEFAULT_TEMPERATURE,
          maxOutputTokens: settings.maxTokens || APP_CONFIG.DEFAULT_MAX_TOKENS
        }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Gemini API error: ${response.status}`);
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const responseChunks = [];
    const streamStartTime = Date.now();
    let iterationCount = 0;

    while (true) {
      // Timeout safeguard
      if (Date.now() - streamStartTime > STREAMING_TIMEOUT_MS) {
        logger.warn('Gemini streaming timeout reached');
        break;
      }

      // Iteration safeguard
      if (++iterationCount > MAX_STREAMING_ITERATIONS) {
        logger.warn('Gemini streaming max iterations reached');
        break;
      }

      const {done, value} = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);

          try {
            const parsed = JSON.parse(data);
            const chunk = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
            if (chunk) {
              responseChunks.push(chunk);
              onChunk(chunk);
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }

    return responseChunks.join('');

  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Generation cancelled by user');
    }
    throw error;
  } finally {
    // CRITICAL: Always cleanup resources
    if (reader) {
      try {
        await reader.cancel();
      } catch (e) {
        // Ignore cancel errors
      }
    }
    activeStreams.delete(requestId);
  }
}

// Unified streaming AI call function
async function callAIStream(contentParts, settings, onChunk, requestId) {
  console.log('🤖 [AI Stream] Starting request...', {
    provider: settings.llmProvider,
    model: settings.llmModel,
    contentParts: contentParts.length,
    requestId
  });

  try {
    let result;
    if (settings.llmProvider === 'openai') {
      result = await callOpenAIStream(contentParts, settings, onChunk, requestId);
    } else if (settings.llmProvider === 'gemini') {
      result = await callGeminiStream(contentParts, settings, onChunk, requestId);
    } else if (settings.llmProvider === 'claude') {
      result = await callClaudeStream(contentParts, settings, onChunk, requestId);
    } else if (settings.llmProvider === 'bedrock') {
      result = await callBedrockStream(contentParts, settings, onChunk, requestId);
    } else {
      throw new Error(`Unsupported AI provider: ${settings.llmProvider}`);
    }

    console.log('✅ [AI Stream] Request successful', {
      provider: settings.llmProvider,
      requestId,
      responseLength: result?.length || 0
    });

    return result;
  } catch (error) {
    console.error('❌ [AI Stream] Request failed:', {
      provider: settings.llmProvider,
      model: settings.llmModel,
      requestId,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

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
async function callAI(contentParts, settings) {
  console.log('🤖 [AI Call] Starting request...', {
    provider: settings.llmProvider,
    model: settings.llmModel,
    contentParts: contentParts.length
  });

  try {
    let result;
    if (settings.llmProvider === 'openai') {
      result = await callOpenAI(contentParts, settings);
    } else if (settings.llmProvider === 'gemini') {
      result = await callGemini(contentParts, settings);
    } else if (settings.llmProvider === 'claude') {
      result = await callClaude(contentParts, settings);
    } else if (settings.llmProvider === 'bedrock') {
      result = await callBedrock(contentParts, settings);
    } else {
      throw new Error(`Unsupported AI provider: ${settings.llmProvider}`);
    }

    console.log('✅ [AI Call] Request successful', {
      provider: settings.llmProvider,
      responseLength: result?.length || 0
    });

    return result;
  } catch (error) {
    console.error('❌ [AI Call] Request failed:', {
      provider: settings.llmProvider,
      model: settings.llmModel,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

// Validate settings before API calls
function validateSettings(settings) {
  const errors = [];

  if (!settings.llmProvider) {
    errors.push(APP_CONFIG.ERRORS.NO_PROVIDER);
  }

  if (!settings.llmModel) {
    errors.push(APP_CONFIG.ERRORS.NO_MODEL);
  }

  if (settings.llmProvider === 'bedrock') {
    if (!settings.bedrockAccessKeyId || settings.bedrockAccessKeyId.trim() === '') {
      errors.push('AWS Access Key ID is required for Bedrock. Please configure it in extension settings.');
    } else if (!securityManager.validateApiKey(settings.bedrockAccessKeyId, 'bedrock')) {
      errors.push('Invalid AWS Access Key ID format. It should start with AKIA or ASIA and be 20 characters.');
    }
    if (!settings.bedrockSecretKey || settings.bedrockSecretKey.trim() === '') {
      errors.push('AWS Secret Access Key is required for Bedrock. Please configure it in extension settings.');
    }
  } else {
    if (!settings.apiKey || settings.apiKey.trim() === '') {
      errors.push(APP_CONFIG.ERRORS.NO_API_KEY);
    } else {
      if (!securityManager.validateApiKey(settings.apiKey, settings.llmProvider)) {
        errors.push(`Invalid API key format for ${settings.llmProvider}. Please check your API key.`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}

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

    console.log(`🔍 Filtering ${crawledPages.length} pages from ${allApps.length} app(s) with ${keywords.length} keywords`);

    // Score and rank pages by relevance
    const scoredPages = crawledPages.map(page => {
      let score = 0;
      const description = page.description || page.metadata?.description || '';
      const pageText = `${page.title || ''} ${page.url || ''} ${description} ${page.metadata?.keywords?.join(' ') || ''}`.toLowerCase();

      // Calculate relevance score based on keyword matches
      keywords.forEach(keyword => {
        const keywordLower = keyword.toLowerCase();

        // URL match (highest weight)
        if (page.url && page.url.toLowerCase().includes(keywordLower)) {
          score += 10;
        }

        // Title match (high weight)
        if (page.title && page.title.toLowerCase().includes(keywordLower)) {
          score += 5;
        }

        // Description match (medium weight)
        if (description && description.toLowerCase().includes(keywordLower)) {
          score += 3;
        }

        // Form field names match
        if (page.forms) {
          page.forms.forEach(form => {
            if (form.fields) {
              form.fields.forEach(field => {
                if (field.name && field.name.toLowerCase().includes(keywordLower)) {
                  score += 2;
                }
              });
            }
          });
        }

        // General content match (low weight)
        if (pageText.includes(keywordLower)) {
          score += 1;
        }
      });

      return { page, score };
    });

    // Sort by relevance score (descending)
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

// API call handlers
async function handleAnalyzeRequirements(data) {
  validateSettings(data.settings);

  const { ticketKey, ticketData, settings } = data;

  // Fetch external content if integrations are configured
  let enrichedTicketData = ticketData;
  let externalContent = null; // Declare at function scope
  if (settings.confluenceUrl || settings.figmaToken || settings.googleApiKey) {
    const integrationManager = new IntegrationManager(settings);
    externalContent = await integrationManager.fetchAllLinkedContent(ticketData);

    // Build linkedPages from fetched content for context checker
    const fetchedLinkedPages = [];
    if (externalContent.confluence.length > 0) {
      externalContent.confluence.forEach((page, i) => {
        fetchedLinkedPages.push({
          id: `confluence-${i}`,
          title: page.title || 'Confluence Page',
          url: page.url || '',
          type: 'confluence',
          fetched: true
        });
      });
    }
    if (externalContent.figma.length > 0) {
      externalContent.figma.forEach((file, i) => {
        fetchedLinkedPages.push({
          id: `figma-${i}`,
          title: file.name || 'Figma File',
          url: file.url || '',
          type: 'figma',
          fetched: true
        });
      });
    }
    if (externalContent.googleDocs.length > 0) {
      externalContent.googleDocs.forEach((doc, i) => {
        fetchedLinkedPages.push({
          id: `googledocs-${i}`,
          title: doc.title || 'Google Doc',
          url: doc.url || '',
          type: 'google_docs',
          fetched: true
        });
      });
    }

    // Merge fetched pages with existing linked pages
    const existingUrls = new Set((ticketData.linkedPages || []).map(p => p.url));
    const mergedLinkedPages = [
      ...(ticketData.linkedPages || []),
      ...fetchedLinkedPages.filter(p => !existingUrls.has(p.url))
    ];

    // ALWAYS update enrichedTicketData with fetched content info
    enrichedTicketData = {
      ...ticketData,
      description: externalContent.enrichedDescription || ticketData.description,
      linkedPages: mergedLinkedPages,
      externalSources: {
        confluence: externalContent.confluence.length,
        figma: externalContent.figma.length,
        googleDocs: externalContent.googleDocs.length
      }
    };

    console.log('📄 [Analyze] Enriched ticket with external sources:', {
      linkedPages: mergedLinkedPages.length,
      confluence: externalContent.confluence.length,
      figma: externalContent.figma.length,
      googleDocs: externalContent.googleDocs.length
    });
  }

  const systemMessage = `You are a senior business analyst and requirements quality expert specializing in requirement analysis.
Analyze Jira tickets and extract structured requirements for test case generation.

Your analysis must be CRITICAL and identify quality issues:

**Primary Focus:**
1. Feature overview and objectives
2. Functional requirements (what the system should do)
3. UI/UX specifications
4. Integration points and dependencies
5. Acceptance criteria
6. Edge cases and constraints

**Critical Analysis (VERY IMPORTANT):**
7. **REQUIREMENT GAPS:** Identify missing information, undefined behaviors, unstated assumptions, missing error handling, incomplete workflows
8. **AMBIGUITIES:** Flag vague terms (e.g., "fast", "user-friendly"), unclear pronouns, multiple interpretations, subjective criteria
9. **UNTESTABLE REQUIREMENTS:** Identify requirements without measurable criteria, vague quality attributes, unverifiable claims
10. **CONFLICTING REQUIREMENTS:** Highlight contradictions or inconsistencies
11. **TESTABILITY SCORE:** Rate each requirement's testability (High/Medium/Low) with justification

**Output Format (Markdown):**

## 📋 Requirements Overview
[Summary of what this feature does]

## ✅ Functional Requirements
[List clear, testable functional requirements]

## 🎨 UI/UX Specifications
[User interface and experience requirements]

## 🔗 Integration Points
[External systems, APIs, dependencies]

## ✓ Acceptance Criteria
[Clear, measurable success criteria]

## 🚨 **CRITICAL: Quality Analysis**

### ⚠️ Requirement Gaps (Missing Information)
- [ ] **Gap:** [What's missing]
  - **Impact:** [How this affects testing]
  - **Recommended Action:** [What needs clarification]

### ❓ Ambiguities (Unclear/Vague Requirements)
- [ ] **Ambiguity:** [Vague statement]
  - **Issue:** [Why it's ambiguous]
  - **Needs Clarification:** [Specific questions to ask]

### 🚫 Untestable Requirements
- [ ] **Untestable:** [Requirement that can't be verified]
  - **Reason:** [Why it's untestable]
  - **Suggested Revision:** [How to make it testable]

### ⚡ Conflicting Requirements
- [ ] **Conflict:** [Contradictory statements]

### 📊 Testability Summary
| Requirement | Testability | Reason |
|-------------|-------------|--------|
| [Req 1] | High/Medium/Low | [Justification] |

## 🎯 Recommendations
1. Questions to ask stakeholders
2. Required clarifications before testing
3. Assumptions that need validation

Provide comprehensive, critical analysis. Be honest about gaps and ambiguities - they're better found now than during testing!`;

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

  const contentParts = [
    { type: 'text', text: systemMessage },
    { type: 'text', text: userMessage }
  ];

  // Add Figma images if available
  if (externalContent && externalContent.figma) {
    externalContent.figma.forEach(figmaFile => {
      if (figmaFile.images && figmaFile.images.length > 0) {
        figmaFile.images.forEach(base64Image => {
          contentParts.push({ type: 'image_url', image_url: { url: base64Image } });
        });
      }
    });
  }

  // Add Jira image attachments if available
  if (enrichedTicketData.imageAttachments && enrichedTicketData.imageAttachments.length > 0) {
    console.log(`📷 Adding ${enrichedTicketData.imageAttachments.length} Jira image attachments to analysis`);
    enrichedTicketData.imageAttachments.forEach(image => {
      contentParts.push({ type: 'image_url', image_url: { url: image.data } });
    });
  }

  const analysis = await callAI(contentParts, settings);
  
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
    let externalContent = null; // Declare at function scope
    if (settings.confluenceUrl || settings.figmaToken || settings.googleApiKey) {
      console.log('🔗 [Test Scope] Fetching external integrations...');
      try {
        const integrationManager = new IntegrationManager(settings);
        externalContent = await integrationManager.fetchAllLinkedContent(ticketData);

        // Set external sources count (always, regardless of description change)
        currentExternalSources = {
          confluence: externalContent.confluence.length,
          figma: externalContent.figma.length,
          googleDocs: externalContent.googleDocs.length
        };

        console.log('✅ [Test Scope] External sources fetched:', currentExternalSources);

        // Build linkedPages from fetched content
        const fetchedLinkedPages = [];
        if (externalContent.confluence.length > 0) {
          externalContent.confluence.forEach((page, i) => {
            fetchedLinkedPages.push({
              id: `confluence-${i}`,
              title: page.title || 'Confluence Page',
              url: page.url || '',
              type: 'confluence',
              fetched: true
            });
          });
        }
        if (externalContent.figma.length > 0) {
          externalContent.figma.forEach((file, i) => {
            fetchedLinkedPages.push({
              id: `figma-${i}`,
              title: file.name || 'Figma File',
              url: file.url || '',
              type: 'figma',
              fetched: true
            });
          });
        }
        if (externalContent.googleDocs.length > 0) {
          externalContent.googleDocs.forEach((doc, i) => {
            fetchedLinkedPages.push({
              id: `googledocs-${i}`,
              title: doc.title || 'Google Doc',
              url: doc.url || '',
              type: 'google_docs',
              fetched: true
            });
          });
        }

        // Merge fetched pages with existing linked pages
        const existingUrls = new Set((ticketData.linkedPages || []).map(p => p.url));
        const mergedLinkedPages = [
          ...(ticketData.linkedPages || []),
          ...fetchedLinkedPages.filter(p => !existingUrls.has(p.url))
        ];

        // ALWAYS update enrichedTicketData with fetched content info
        enrichedTicketData = {
          ...ticketData,
          description: externalContent.enrichedDescription || ticketData.description,
          linkedPages: mergedLinkedPages,
          externalSources: currentExternalSources
        };
        console.log('📝 [Test Scope] Enriched ticket with external sources:', mergedLinkedPages.length, 'linked pages');
      } catch (integrationError) {
        console.warn('⚠️ [Test Scope] Integration fetch failed, continuing with ticket data only:', integrationError.message);
        // Continue with original ticket data
      }
    }
    
    const systemMessage = `You are a senior test architect. Create comprehensive test scope for Jira tickets.

Include:
1. Test objectives
2. In-scope features
3. Out-of-scope items
4. Test types needed (functional, integration, regression, etc.)
5. Test data requirements
6. Environment needs
7. Estimated test count by category

Format as structured markdown.`;

    const userMessage = `Create test scope for:

**Ticket:** ${ticketKey}
**Summary:** ${enrichedTicketData.summary || 'N/A'}
**Description:** ${enrichedTicketData.description || 'N/A'}
${currentExternalSources ? `**External Sources:** ${currentExternalSources.confluence} Confluence, ${currentExternalSources.figma} Figma, ${currentExternalSources.googleDocs} Google Docs` : ''}
${data.crawledContext || ''}

Provide detailed test scope covering all aspects.`;

    const contentParts = [
      { type: 'text', text: systemMessage },
      { type: 'text', text: userMessage }
    ];

    // Add Figma images if available
    if (externalContent && externalContent.figma) {
      externalContent.figma.forEach(figmaFile => {
        if (figmaFile.images && figmaFile.images.length > 0) {
          figmaFile.images.forEach(base64Image => {
            contentParts.push({ type: 'image_url', image_url: { url: base64Image } });
          });
        }
      });
    }

    // Add Jira image attachments if available
    if (enrichedTicketData.imageAttachments && enrichedTicketData.imageAttachments.length > 0) {
      console.log(`📷 [Test Scope] Adding ${enrichedTicketData.imageAttachments.length} Jira image attachments`);
      enrichedTicketData.imageAttachments.forEach(image => {
        contentParts.push({ type: 'image_url', image_url: { url: image.data } });
      });
    }

    console.log('🤖 [Test Scope] Calling AI provider with', contentParts.length, 'content parts...');
    const scope = await callAI(contentParts, settings);

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

  // Fetch external content if integrations are configured
  let enrichedTicketData = ticketData;
  let currentExternalSources = null;
  let externalContent = null;
  if (settings.confluenceUrl || settings.figmaToken || settings.googleApiKey) {
    console.log('🔗 [Test Cases] Fetching external integrations...');
    try {
      const integrationManager = new IntegrationManager(settings);
      externalContent = await integrationManager.fetchAllLinkedContent(ticketData);

      // Set external sources count
      currentExternalSources = {
        confluence: externalContent.confluence.length,
        figma: externalContent.figma.length,
        googleDocs: externalContent.googleDocs.length
      };

      console.log('✅ [Test Cases] External sources fetched:', currentExternalSources);

      // Use enriched description if external content was found
      if (externalContent.enrichedDescription !== ticketData.description) {
        enrichedTicketData = {
          ...ticketData,
          description: externalContent.enrichedDescription,
        };
        console.log('📝 [Test Cases] Using enriched description with external content');
      }
    } catch (integrationError) {
      console.warn('⚠️ [Test Cases] Integration fetch failed, continuing with ticket data only:', integrationError.message);
      // Continue with original ticket data
    }
  }

  const systemMessage = `You are an expert test engineer. Generate detailed, executable test cases.

For each test case include:
- Unique ID (TC-XXX-NNN format)
- Clear title
- Category (Positive/Negative/Edge/Integration)
- Priority (P0/P1/P2/P3)
- Preconditions
- Test steps (numbered)
- Expected result
- Test data

Generate 20-30 comprehensive test cases covering:
- Happy path scenarios (40%)
- Negative scenarios (30%)
- Edge cases (20%)
- Integration scenarios (10%)

Format as JSON array.`;

  const userMessage = `Generate test cases for:

**Ticket:** ${ticketKey}
**Summary:** ${enrichedTicketData.summary || 'N/A'}
**Description:** ${enrichedTicketData.description || 'N/A'}

Return test cases as JSON array: [{"id":"TC-POS-001","title":"...","category":"Positive","priority":"P0","steps":["step1","step2"],"expectedResult":"...","preconditions":"...","testData":"..."}]`;

  const contentParts = [
    { type: 'text', text: systemMessage },
    { type: 'text', text: userMessage }
  ];

  // Add Figma images if available
  if (externalContent && externalContent.figma) {
    externalContent.figma.forEach(figmaFile => {
      if (figmaFile.images && figmaFile.images.length > 0) {
        figmaFile.images.forEach(base64Image => {
          contentParts.push({ type: 'image_url', image_url: { url: base64Image } });
        });
      }
    });
  }

  // Add Jira image attachments if available
  if (enrichedTicketData.imageAttachments && enrichedTicketData.imageAttachments.length > 0) {
    console.log(`📷 [Test Cases] Adding ${enrichedTicketData.imageAttachments.length} Jira image attachments`);
    enrichedTicketData.imageAttachments.forEach(image => {
      contentParts.push({ type: 'image_url', image_url: { url: image.data } });
    });
  }

  const response = await callAI(contentParts, settings);
  
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

  const systemMessage = `You are a senior business analyst and requirements quality expert specializing in requirement analysis.
Analyze Jira tickets and extract structured requirements for test case generation.

Your analysis must be CRITICAL and identify quality issues:

**Primary Focus:**
1. Feature overview and objectives
2. Functional requirements (what the system should do)
3. UI/UX specifications
4. Integration points and dependencies
5. Acceptance criteria
6. Edge cases and constraints

**Critical Analysis (VERY IMPORTANT):**
7. **REQUIREMENT GAPS:** Identify missing information, undefined behaviors, unstated assumptions, missing error handling, incomplete workflows
8. **AMBIGUITIES:** Flag vague terms (e.g., "fast", "user-friendly"), unclear pronouns, multiple interpretations, subjective criteria
9. **UNTESTABLE REQUIREMENTS:** Identify requirements without measurable criteria, vague quality attributes, unverifiable claims
10. **CONFLICTING REQUIREMENTS:** Highlight contradictions or inconsistencies
11. **TESTABILITY SCORE:** Rate each requirement's testability (High/Medium/Low) with justification

**Output Format (Markdown):**

## 📋 Requirements Overview
[Summary of what this feature does]

## ✅ Functional Requirements
[List clear, testable functional requirements]

## 🎨 UI/UX Specifications
[User interface and experience requirements]

## 🔗 Integration Points
[External systems, APIs, dependencies]

## ✓ Acceptance Criteria
[Clear, measurable success criteria]

## 🚨 **CRITICAL: Quality Analysis**

### ⚠️ Requirement Gaps (Missing Information)
- [ ] **Gap:** [What's missing]
  - **Impact:** [How this affects testing]
  - **Recommended Action:** [What needs clarification]

### ❓ Ambiguities (Unclear/Vague Requirements)
- [ ] **Ambiguity:** [Vague statement]
  - **Issue:** [Why it's ambiguous]
  - **Needs Clarification:** [Specific questions to ask]

### 🚫 Untestable Requirements
- [ ] **Untestable:** [Requirement that can't be verified]
  - **Reason:** [Why it's untestable]
  - **Suggested Revision:** [How to make it testable]

### ⚡ Conflicting Requirements
- [ ] **Conflict:** [Contradictory statements]

### 📊 Testability Summary
| Requirement | Testability | Reason |
|-------------|-------------|--------|
| [Req 1] | High/Medium/Low | [Justification] |

## 🎯 Recommendations
1. Questions to ask stakeholders
2. Required clarifications before testing
3. Assumptions that need validation

Provide comprehensive, critical analysis. Be honest about gaps and ambiguities - they're better found now than during testing!`;

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

  const contentParts = [
    { type: 'text', text: systemMessage },
    { type: 'text', text: userMessage }
  ];

  // Add Figma images if available
  if (externalContent && externalContent.figma) {
    externalContent.figma.forEach(figmaFile => {
      if (figmaFile.images && figmaFile.images.length > 0) {
        figmaFile.images.forEach(base64Image => {
          contentParts.push({ type: 'image_url', image_url: { url: base64Image } });
        });
      }
    });
  }

  // Add Jira image attachments if available
  if (enrichedTicketData.imageAttachments && enrichedTicketData.imageAttachments.length > 0) {
    console.log(`📷 Adding ${enrichedTicketData.imageAttachments.length} Jira image attachments to streaming analysis`);
    enrichedTicketData.imageAttachments.forEach(image => {
      contentParts.push({ type: 'image_url', image_url: { url: image.data } });
    });
  }

  // Ensure content fits within model limits (with graceful truncation)
  const fittedContentParts = ensureContentFitsLimits(contentParts, settings);

  const analysis = await callAIStream(fittedContentParts, settings, (chunk) => {
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

    const contentParts = [
      { type: 'text', text: systemMessage },
      { type: 'text', text: userMessage }
    ];

    // Add Figma images if available
    if (externalContent && externalContent.figma) {
      externalContent.figma.forEach(figmaFile => {
        if (figmaFile.images && figmaFile.images.length > 0) {
          figmaFile.images.forEach(base64Image => {
            contentParts.push({ type: 'image_url', image_url: { url: base64Image } });
          });
        }
      });
    }

    // Add Jira image attachments if available
    if (enrichedTicketData.imageAttachments && enrichedTicketData.imageAttachments.length > 0) {
      console.log(`📷 [Test Scope Stream] Adding ${enrichedTicketData.imageAttachments.length} Jira image attachments`);
      enrichedTicketData.imageAttachments.forEach(image => {
        contentParts.push({ type: 'image_url', image_url: { url: image.data } });
      });
    }

    // Ensure content fits within model limits (with graceful truncation)
    const fittedContentParts = ensureContentFitsLimits(contentParts, settings);

    console.log('🤖 [Test Scope Stream] Calling AI provider with', fittedContentParts.length, 'content parts...');
    const testScope = await callAIStream(fittedContentParts, settings, (chunk) => {
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

async function handleGenerateTestCasesStream(data, tabId) {
  validateSettings(data.settings);

  const { ticketKey, ticketData, settings } = data;
  const requestId = `testcases-${Date.now()}`;

  // Fetch external content if integrations are configured
  let enrichedTicketData = ticketData;
  let currentExternalSources = null;
  let externalContent = null;
  if (settings.confluenceUrl || settings.figmaToken || settings.googleApiKey) {
    console.log('🔗 [Test Cases Stream] Fetching external integrations...');
    try {
      const integrationManager = new IntegrationManager(settings);
      externalContent = await integrationManager.fetchAllLinkedContent(ticketData);

      currentExternalSources = {
        confluence: externalContent.confluence.length,
        figma: externalContent.figma.length,
        googleDocs: externalContent.googleDocs.length
      };

      console.log('✅ [Test Cases Stream] External sources fetched:', currentExternalSources);

      if (externalContent.enrichedDescription !== ticketData.description) {
        enrichedTicketData = {
          ...ticketData,
          description: externalContent.enrichedDescription,
        };
        console.log('📝 [Test Cases Stream] Using enriched description');
      }
    } catch (integrationError) {
      console.warn('⚠️ [Test Cases Stream] Integration fetch failed, continuing with ticket data only:', integrationError.message);
    }
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
${data.crawledContext || ''}`;

  const contentParts = [
    { type: 'text', text: systemMessage },
    { type: 'text', text: userMessage }
  ];

  // Add Figma images if available
  if (externalContent && externalContent.figma) {
    externalContent.figma.forEach(figmaFile => {
      if (figmaFile.images && figmaFile.images.length > 0) {
        figmaFile.images.forEach(base64Image => {
          contentParts.push({ type: 'image_url', image_url: { url: base64Image } });
        });
      }
    });
  }

  // Add Jira image attachments if available
  if (enrichedTicketData.imageAttachments && enrichedTicketData.imageAttachments.length > 0) {
    console.log(`📷 [Test Cases Stream] Adding ${enrichedTicketData.imageAttachments.length} Jira image attachments`);
    enrichedTicketData.imageAttachments.forEach(image => {
      contentParts.push({ type: 'image_url', image_url: { url: image.data } });
    });
  }

  // Ensure content fits within model limits (with graceful truncation)
  const fittedContentParts = ensureContentFitsLimits(contentParts, settings);

  console.log('🤖 [Test Cases Stream] Calling AI provider with', fittedContentParts.length, 'content parts...');
  let accumulatedText = '';

  const testCasesResponse = await callAIStream(fittedContentParts, settings, (chunk) => {
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
async function handleGenerateTestCasesMultiAgent(data, tabId) {
  console.log('🎯 Background: handleGenerateTestCasesMultiAgent called');
  console.log('🎯 Background: data received:', { ticketKey: data.ticketKey, hasSettings: !!data.settings });
  console.log('🎯 Background: settings.llmProvider:', data.settings?.llmProvider);
  console.log('🎯 Background: settings.enableMultiAgent:', data.settings?.enableMultiAgent);

  validateSettings(data.settings);
  console.log('✅ Background: settings validated');

  const { ticketKey, ticketData, settings, externalSources: initialExternalSources } = data;

  // Fetch external content if integrations are configured and not already provided
  let enrichedTicketData = ticketData;
  let currentExternalSources = initialExternalSources;
  let externalContent = null; // Store at function scope for agent access

  if (!currentExternalSources && (settings.confluenceUrl || settings.figmaToken || settings.googleApiKey)) {
    const integrationManager = new IntegrationManager(settings);
    externalContent = await integrationManager.fetchAllLinkedContent(ticketData);

    // Set external sources count (always, regardless of description change)
    currentExternalSources = {
      confluence: externalContent.confluence.length,
      figma: externalContent.figma.length,
      googleDocs: externalContent.googleDocs.length
    };

    // Build linkedPages from fetched content for context checker
    // This ensures the context quality assessment reflects actually fetched content
    const fetchedLinkedPages = [];
    if (externalContent.confluence.length > 0) {
      externalContent.confluence.forEach((page, i) => {
        fetchedLinkedPages.push({
          id: `confluence-${i}`,
          title: page.title || 'Confluence Page',
          url: page.url || '',
          type: 'confluence',
          fetched: true
        });
      });
    }
    if (externalContent.figma.length > 0) {
      externalContent.figma.forEach((file, i) => {
        fetchedLinkedPages.push({
          id: `figma-${i}`,
          title: file.name || 'Figma File',
          url: file.url || '',
          type: 'figma',
          fetched: true
        });
      });
    }
    if (externalContent.googleDocs.length > 0) {
      externalContent.googleDocs.forEach((doc, i) => {
        fetchedLinkedPages.push({
          id: `googledocs-${i}`,
          title: doc.title || 'Google Doc',
          url: doc.url || '',
          type: 'google_docs',
          fetched: true
        });
      });
    }

    // Merge fetched pages with existing linked pages (avoid duplicates)
    const existingUrls = new Set((ticketData.linkedPages || []).map(p => p.url));
    const mergedLinkedPages = [
      ...(ticketData.linkedPages || []),
      ...fetchedLinkedPages.filter(p => !existingUrls.has(p.url))
    ];

    // ALWAYS update enrichedTicketData with fetched content info
    enrichedTicketData = {
      ...ticketData,
      description: externalContent.enrichedDescription || ticketData.description,
      linkedPages: mergedLinkedPages,
      fetchedExternalSources: currentExternalSources
    };

    console.log('📄 [Multi-Agent] Enriched ticket with external sources:', {
      linkedPages: mergedLinkedPages.length,
      confluence: currentExternalSources.confluence,
      figma: currentExternalSources.figma,
      googleDocs: currentExternalSources.googleDocs
    });
  }

  // Vision models that support image inputs (from centralized config)
  const visionModels = APP_CONFIG.VISION_MODELS;

  // Start keep-alive heartbeat to prevent timeout
  // Send a message every 5 seconds to keep the message port alive
  const keepAliveInterval = setInterval(() => {
    safeSendMessageToTab(tabId, {
      action: 'keepAlive',
      timestamp: Date.now()
    });
  }, 5000);

  // Bind callAI to all agents
  const bindCallAI = (agent) => {
    // Agents call with (systemMessage, userMessage, settings)
    // but callAI expects (contentParts, settings)
    agent.callAI = async (systemMessage, userMessage, agentSettings) => {
      const contentParts = [
        { type: 'text', text: systemMessage },
        { type: 'text', text: userMessage }
      ];

      // Add images for vision-capable models
      const currentSettings = agentSettings || settings;
      const isVisionModel = visionModels.some(model => currentSettings.llmModel?.includes(model));

      if (isVisionModel) {
        let imageCount = 0;

        // Add Figma images if available (for UI/UX test generation)
        if (externalContent && externalContent.figma) {
          externalContent.figma.forEach(figmaFile => {
            if (figmaFile.images && figmaFile.images.length > 0) {
              figmaFile.images.forEach(base64Image => {
                contentParts.push({ type: 'image_url', image_url: { url: base64Image } });
                imageCount++;
              });
            }
          });
          if (imageCount > 0) {
            console.log(`🎨 Adding ${imageCount} Figma images to ${agent.name} agent API call`);
          }
        }

        // Add Jira image attachments if available
        if (enrichedTicketData.imageAttachments && enrichedTicketData.imageAttachments.length > 0) {
          console.log(`📷 Adding ${enrichedTicketData.imageAttachments.length} Jira image attachments to ${agent.name} agent API call`);
          enrichedTicketData.imageAttachments.forEach(image => {
            contentParts.push({ type: 'image_url', image_url: { url: image.data } });
          });
        }
      }

      return await callAI(contentParts, currentSettings);
    };
    agent.settings = settings;

    // Pass image availability info to agent for prompt customization
    agent.hasImages = {
      figma: externalContent?.figma?.some(f => f.images?.length > 0) || false,
      jira: enrichedTicketData.imageAttachments?.length > 0 || false
    };
  };

  // Create orchestrator with progress callback
  const orchestrator = new AgentOrchestrator(settings, (progress) => {
    // Send progress updates to content script
    safeSendMessageToTab(tabId, {
      action: 'agentProgress',
      progress: progress
    });
  });
  
  // Bind callAI to all agents
  orchestrator.agents.forEach(bindCallAI);

  try {
    // ========== NEW: CHECK CONTEXT QUALITY BEFORE GENERATION ==========
    console.log('🔍 [QualityCheck] Checking context quality...');
    const contextChecker = new ContextQualityChecker();
    const contextAssessment = contextChecker.checkContext(data.appContext, enrichedTicketData);

    // Send context quality assessment to UI
    safeSendMessageToTab(tabId, {
      action: 'contextQualityAssessment',
      assessment: contextAssessment
    });

    console.log('📊 [QualityCheck] Context quality:', contextAssessment.qualityLevel, `(${contextAssessment.qualityScore}/100)`);

    // Warn if insufficient context (but allow generation to proceed)
    if (contextAssessment.shouldWarn) {
      console.warn('⚠️ [QualityCheck] Low context quality - tests may be generic');
      console.log(contextChecker.formatAssessmentForDisplay(contextAssessment));
    }

    // First, analyze requirements if not already done
    let analysis = data.analysis;
    if (!analysis) {
      const analysisAgent = new RequirementAnalysisAgent();
      bindCallAI(analysisAgent);
      analysis = await analysisAgent.execute(enrichedTicketData, {}, settings);
    }

    // Execute all agents with app context
    const results = await orchestrator.executeAgents(enrichedTicketData, analysis, data.appContext);

    // Apply enhancements (gap analysis, complexity scaling)
    let enhancementResults = null;
    if (settings.enableEnhanced !== false) {
      safeSendMessageToTab(tabId, {
        action: 'enhancementProgress',
        status: 'analyzing'
      });

      // Create wrapper for EnhancementEngine that converts 3-param to 2-param callAI
      const enhancerCallAI = async (systemMessage, userMessage, enhancerSettings) => {
        const contentParts = [
          { type: 'text', text: systemMessage },
          { type: 'text', text: userMessage }
        ];

        // Add Jira image attachments if available and using vision model
        const currentSettings = enhancerSettings || settings;
        const isVisionModel = visionModels.some(model => currentSettings.llmModel?.includes(model));
        if (isVisionModel && enrichedTicketData.imageAttachments && enrichedTicketData.imageAttachments.length > 0) {
          console.log(`📷 Adding ${enrichedTicketData.imageAttachments.length} Jira images to EnhancementEngine API call`);
          enrichedTicketData.imageAttachments.forEach(image => {
            contentParts.push({ type: 'image_url', image_url: { url: image.data } });
          });
        }

        return await callAI(contentParts, currentSettings);
      };
      const enhancer = new EnhancementEngine(settings, enhancerCallAI);
      enhancementResults = await enhancer.enhance(results.testCases, enrichedTicketData, results.analysis);

      // Add gap-filling tests if any
      if (enhancementResults.additionalTests && enhancementResults.additionalTests.length > 0) {
        results.testCases.push(...enhancementResults.additionalTests);
      }

      safeSendMessageToTab(tabId, {
        action: 'enhancementProgress',
        status: 'completed'
      });
    }

    // Apply historical mining if enabled
    let historicalResults = null;
    if (settings.enableHistoricalMining) {
      console.log('Starting historical mining...');

      safeSendMessageToTab(tabId, {
        action: 'historicalMiningProgress',
        status: 'analyzing'
      });

      // Create wrapper for HistoricalMiningEngine that converts 3-param to 2-param callAI
      const historicalCallAI = async (systemMessage, userMessage, historicalSettings) => {
        const contentParts = [
          { type: 'text', text: systemMessage },
          { type: 'text', text: userMessage }
        ];

        // Add Jira image attachments if available and using vision model
        const currentSettings = historicalSettings || settings;
        const isVisionModel = visionModels.some(model => currentSettings.llmModel?.includes(model));
        if (isVisionModel && enrichedTicketData.imageAttachments && enrichedTicketData.imageAttachments.length > 0) {
          console.log(`📷 Adding ${enrichedTicketData.imageAttachments.length} Jira images to HistoricalMiningEngine API call`);
          enrichedTicketData.imageAttachments.forEach(image => {
            contentParts.push({ type: 'image_url', image_url: { url: image.data } });
          });
        }

        return await callAI(contentParts, currentSettings);
      };
      const historicalMiner = new HistoricalMiningEngine(settings, historicalCallAI, data.baseUrl);
      historicalResults = await historicalMiner.mineAndEnhance(enrichedTicketData, results.testCases);

      // Replace testCases with enhanced version
      if (historicalResults && historicalResults.enhancedTests) {
        results.testCases = historicalResults.enhancedTests;
        console.log(`Historical mining complete: ${historicalResults.enhancedTests.length} tests`);
      }

      safeSendMessageToTab(tabId, {
        action: 'historicalMiningProgress',
        status: 'completed'
      });
    }

    // Store original test count for comparison
    const originalTestCount = results.testCases.length;

    // ========== NEW: VALIDATE TESTS AGAINST KNOWLEDGE GRAPH ==========
    console.log('✅ [Validation] Validating generated tests against knowledge graph...');
    const validator = new TestCaseValidator(data.appContext?.knowledgeGraph);
    const validationResults = validator.validateTestSuite(results.testCases);
    const validationReport = validator.generateReport(validationResults);

    console.log('📊 [Validation] Validation complete:', {
      total: validationResults.total,
      highConfidence: validationResults.highConfidence,
      lowConfidence: validationResults.lowConfidence,
      hallucinations: validationResults.totalHallucinations
    });

    // Log validation warnings
    validationResults.testValidations.forEach(v => {
      if (v.warnings.length > 0 || v.hallucinations.length > 0) {
        console.warn(`⚠️ [Validation] Test "${v.testId}":`, {
          confidence: v.confidence,
          warnings: v.warnings,
          hallucinations: v.hallucinations
        });
      }
    });

    // Attach validation info to each test case
    results.testCases.forEach((testCase, index) => {
      const validation = validationResults.testValidations[index];
      if (validation) {
        testCase.validation = {
          confidence: validation.confidence,
          warnings: validation.warnings,
          hallucinations: validation.hallucinations,
          grounding: validation.grounding
        };
      }
    });

    // ========== NEW: SEMANTIC DUPLICATE DETECTION ==========
    console.log('🔍 [Duplicates] Running semantic duplicate detection...');
    const semanticDetector = new SemanticDuplicateDetector(0.65);
    const duplicateAnalysis = semanticDetector.removeDuplicates(results.testCases);

    console.log('📊 [Duplicates] Duplicate detection complete:', duplicateAnalysis.summary);

    // Replace with deduplicated tests
    if (duplicateAnalysis.cleaned.length < results.testCases.length) {
      console.log(`🗑️ [Duplicates] Removed ${duplicateAnalysis.removedCount} duplicate tests`);
      results.testCases = duplicateAnalysis.cleaned;
    }

    // ========== NEW: COVERAGE MAPPING ==========
    console.log('📊 [Coverage] Mapping test coverage to knowledge graph...');
    const coverageMapper = new CoverageMapper(data.appContext?.knowledgeGraph);
    const coverageAnalysis = coverageMapper.mapCoverage(results.testCases);
    const coverageReport = coverageMapper.generateReport(coverageAnalysis);

    console.log('📊 [Coverage] Coverage analysis complete:', {
      overall: `${coverageAnalysis.overall.coveragePercentage}%`,
      forms: `${coverageAnalysis.forms.percentage}%`,
      apis: `${coverageAnalysis.apis.percentage}%`
    });

    // Send validation and coverage reports to UI
    safeSendMessageToTab(tabId, {
      action: 'qualityReports',
      reports: {
        validation: validationReport,
        coverage: coverageReport,
        duplicates: duplicateAnalysis.summary,
        contextQuality: contextAssessment
      }
    });

    // Return base results immediately (don't wait for evolution)
    const baseResponse = {
      testCases: results.testCases,
      ...results.statistics,
      analysis: results.analysis,
      review: results.review,
      agentResults: results.agentResults,
      evolved: false,
      evolutionPending: settings.enableEvolution && results.testCases.length > 0,
      originalCount: originalTestCount,
      enhancements: enhancementResults,
      historicalInsights: historicalResults?.insights || null,
      historicalBugs: historicalResults?.historicalBugs || [],
      externalSources: currentExternalSources,
      // NEW: Add validation and coverage data
      validation: validationReport,
      coverage: coverageReport,
      duplicatesRemoved: duplicateAnalysis.removedCount,
      contextQuality: contextAssessment
    };

    // Start evolution in background (non-blocking)
    if (settings.enableEvolution && results.testCases.length > 0) {
      runEvolutionInBackground(results.testCases, enrichedTicketData, settings, tabId, originalTestCount);
    }

    return baseResponse;
  } finally {
    // Always clear keep-alive interval
    clearInterval(keepAliveInterval);
    console.log('✅ Keep-alive heartbeat stopped');
  }
}

// Run evolutionary optimization in background without blocking
async function runEvolutionInBackground(baseTests, ticketData, settings, tabId, originalCount) {
  try {
    console.log('Starting background evolution with', settings.evolutionIntensity, 'intensity');

    const evolution = new EvolutionaryOptimizer(settings, (progress) => {
      // Send evolution progress to content script
      safeSendMessageToTab(tabId, {
        action: 'evolutionProgress',
        progress: progress
      });
    });

    // Create wrapper for EvolutionaryOptimizer that converts 3-param to 2-param callAI
    const visionModels = APP_CONFIG.VISION_MODELS;
    const evolutionCallAI = async (systemMessage, userMessage, evolutionSettings) => {
      const contentParts = [
        { type: 'text', text: systemMessage },
        { type: 'text', text: userMessage }
      ];

      // Add Jira image attachments if available and using vision model
      const currentSettings = evolutionSettings || settings;
      const isVisionModel = visionModels.some(model => currentSettings.llmModel?.includes(model));
      if (isVisionModel && ticketData.imageAttachments && ticketData.imageAttachments.length > 0) {
        console.log(`📷 Adding ${ticketData.imageAttachments.length} Jira images to EvolutionaryOptimizer API call`);
        ticketData.imageAttachments.forEach(image => {
          contentParts.push({ type: 'image_url', image_url: { url: image.data } });
        });
      }

      return await callAI(contentParts, currentSettings);
    };
    // Overall safety timeout (6 minutes) — evolution.evolve has its own 5-minute timeout,
    // this catches edge cases like the evolve() method itself hanging before entering the loop
    const EVOLUTION_SAFETY_TIMEOUT = 6 * 60 * 1000;
    const evolvedTests = await Promise.race([
      evolution.evolve(baseTests, ticketData, evolutionCallAI),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Evolution timed out after 6 minutes')), EVOLUTION_SAFETY_TIMEOUT)
      )
    ]);

    // Calculate new statistics
    const statistics = {
      total: evolvedTests.length,
      byCategory: evolvedTests.reduce((acc, tc) => {
        acc[tc.category] = (acc[tc.category] || 0) + 1;
        return acc;
      }, {}),
      byPriority: evolvedTests.reduce((acc, tc) => {
        acc[tc.priority] = (acc[tc.priority] || 0) + 1;
        return acc;
      }, {})
    };

    console.log('Evolution complete:', evolvedTests.length, 'tests (was', originalCount, ')');

    // Send completion message to update UI
    safeSendMessageToTab(tabId, {
      action: 'evolutionComplete',
      data: {
        testCases: evolvedTests,
        statistics: statistics,
        originalCount: originalCount,
        improvement: evolvedTests.length - originalCount
      }
    });
  } catch (error) {
    console.error('Evolution background error:', error);

    // Send error message to UI
    safeSendMessageToTab(tabId, {
      action: 'evolutionError',
      error: error.message
    });
  }
}

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

  // Call AI with the combined prompt
  const contentParts = [
    { type: 'text', text: systemMessage },
    { type: 'text', text: userMessage }
  ];
  const improvedResponse = await callAI(contentParts, settings);

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

