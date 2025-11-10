/**
 * Crawler Progress Window
 * Persistent window that shows crawl progress and stays open during crawling
 */

let crawlComplete = false;
let totalPages = 0;
let totalFeatures = 0;
let totalApis = 0;
let totalEmbeddings = 0;
let userHasInteracted = false;

// Listen for progress updates from background script
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'crawlProgress') {
    handleCrawlProgress(message.progress);
  }

  if (message.action === 'embeddingProgress') {
    handleEmbeddingProgress(message.progress);
  }

  if (message.action === 'crawlComplete') {
    handleCrawlComplete(message.result);
  }

  if (message.action === 'crawlError') {
    handleCrawlError(message.error);
  }

  if (message.action === 'crawlStopped') {
    handleCrawlStopped(message.message);
  }
});

// Handle crawl progress updates
function handleCrawlProgress(progress) {
  const statusMessage = document.getElementById('statusMessage');
  const progressFill = document.getElementById('progressFill');
  const progressPercentage = document.getElementById('progressPercentage');
  const pagesCrawled = document.getElementById('pagesCrawled');
  const currentUrl = document.getElementById('currentUrl');

  if (progress.status === 'starting') {
    statusMessage.className = 'status-message crawling';
    statusMessage.innerHTML = '<span class="spinner"></span>' + progress.message;
  }

  if (progress.status === 'crawling') {
    const percentage = progress.total > 0
      ? Math.round((progress.visited / progress.total) * 100)
      : 0;

    statusMessage.className = 'status-message crawling';
    statusMessage.innerHTML = '<span class="spinner"></span>Crawling web application...';

    progressFill.style.width = `${percentage}%`;
    progressPercentage.textContent = `${percentage}%`;
    pagesCrawled.textContent = `${progress.visited} / ${progress.total}`;

    if (progress.currentUrl) {
      currentUrl.textContent = `Current: ${progress.currentUrl}`;
    }
  }

  if (progress.status === 'complete') {
    totalPages = progress.visited || 0;
    // Use summary instead of result to avoid message size limit
    totalFeatures = progress.summary?.stats?.totalFeatures || 0;
    totalApis = progress.summary?.stats?.totalApis || 0;

    // Update display
    document.getElementById('featuresFound').textContent = totalFeatures;
    document.getElementById('apisFound').textContent = totalApis;
  }
}

// Handle embedding progress updates
function handleEmbeddingProgress(progress) {
  const statusMessage = document.getElementById('statusMessage');
  const progressFill = document.getElementById('progressFill');
  const progressPercentage = document.getElementById('progressPercentage');
  const embeddingsGenerated = document.getElementById('embeddingsGenerated');

  if (progress.status === 'generating') {
    statusMessage.className = 'status-message embedding';
    statusMessage.innerHTML = '<span class="spinner"></span>Generating embeddings...';

    progressFill.style.width = `${progress.percentage}%`;
    progressPercentage.textContent = `${progress.percentage}%`;

    document.getElementById('currentUrl').textContent =
      `Processing batch ${progress.current} of ${progress.total}`;
  }
}

// Handle crawl completion
function handleCrawlComplete(result) {
  crawlComplete = true;

  const statusMessage = document.getElementById('statusMessage');
  const closeBtn = document.getElementById('closeBtn');
  const currentUrl = document.getElementById('currentUrl');

  // Update final stats
  document.getElementById('pagesCrawled').textContent = `${result.pages} / ${result.pages}`;
  document.getElementById('featuresFound').textContent = result.features;
  document.getElementById('apisFound').textContent = result.apis;
  document.getElementById('embeddingsGenerated').textContent = result.embeddings || 0;

  // Update progress bar to 100%
  document.getElementById('progressFill').style.width = '100%';
  document.getElementById('progressPercentage').textContent = '100%';

  // Show success message
  let message = `✅ Crawl complete! ${result.pages} pages, ${result.features} features, ${result.apis} APIs`;

  if (result.embeddings > 0) {
    const costMsg = result.cost > 0 ? `($${result.cost.toFixed(4)})` : '(FREE)';
    message += `, ${result.embeddings} embeddings ${costMsg}`;
  }

  statusMessage.className = 'status-message complete';
  statusMessage.innerHTML = message;
  currentUrl.textContent = 'Crawl finished successfully';

  // Enable close button
  closeBtn.disabled = false;
  closeBtn.textContent = 'Close Window';

  // Focus this window to bring attention
  try {
    chrome.windows.update(chrome.windows.WINDOW_ID_CURRENT, { focused: true });
  } catch (e) {
    // Ignore if can't focus
  }

  // Play a subtle notification sound (optional)
  try {
    const audio = new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdJivrJBhNjVgodDbq2EcBj+a2/LDciUFLIHO8tiJNwgZaLvt559NEAxQp+PwtmMcBjiR1/LMeSwFJHfH8N2QQAoUXrTp66hVFApGn+DyvmwhBTGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwiBDGN0/LPejMGJXnG8N+RQAoWYLPo66xVFApJoeDyvmwhBTKP1PLTeTUGKHvK8N+RQAoWYLPo66xVFApJoeDyvmwhBTKP1PLTeTUGKHvK8N+RQAoWYLPo66xVFApJoeDyvmwhBTKP1PLTeTUGKHvK8N+RQAoWYLPo66xVFApJoeDyvmwhBTKP1PLTeTUGKHvK8N+RQAoWYLPo66xVFApJoeDyvmwhBTKP1PLTeTUGKHvK8N+RQAoWYLPo66xVFApJoeDyvmwhBTKP1PLTeTUGKHvK8N+RQAoWYLPo66xVFApJoeDyvmwhBTKP1PLTeTUGKHvK8N+RQAoWYLPo66xVFApJoeDyvmwhBTKP1PLTeTUGKHvK8N+RQAoWYLPo66xVFApJoeDyvmwhBTKP1PLTeTUGKHvK8N+RQAoWYLPo66xVFApJoeD==');
    audio.volume = 0.3;
    audio.play().catch(() => {});
  } catch (e) {
    // Ignore audio errors
  }
}

// Handle crawl errors
function handleCrawlError(error) {
  crawlComplete = true;

  const statusMessage = document.getElementById('statusMessage');
  const closeBtn = document.getElementById('closeBtn');
  const currentUrl = document.getElementById('currentUrl');

  statusMessage.className = 'status-message error';
  statusMessage.innerHTML = `❌ Crawl failed: ${error}`;
  currentUrl.textContent = 'Error occurred';

  // Enable close button
  closeBtn.disabled = false;
  closeBtn.textContent = 'Close Window';
}

// Handle crawl stopped by user
function handleCrawlStopped(message) {
  crawlComplete = true;

  const statusMessage = document.getElementById('statusMessage');
  const closeBtn = document.getElementById('closeBtn');
  const currentUrl = document.getElementById('currentUrl');

  statusMessage.className = 'status-message';
  statusMessage.style.background = '#fff7ed';
  statusMessage.style.borderColor = '#fed7aa';
  statusMessage.style.color = '#ea580c';
  statusMessage.innerHTML = `⏹️ ${message || 'Crawl stopped by user'}`;
  currentUrl.textContent = 'Crawl stopped';

  // Enable close button
  closeBtn.disabled = false;
  closeBtn.textContent = 'Close Window';
}

// Close button handler
document.getElementById('closeBtn').addEventListener('click', () => {
  window.close();
});

// Track user interaction to enable beforeunload confirmation
// Chrome requires a user gesture before showing beforeunload dialogs
function trackUserInteraction() {
  if (!userHasInteracted) {
    userHasInteracted = true;
    console.log('User interaction detected - beforeunload enabled');
  }
}

// Listen for any user interaction
['click', 'keydown', 'mousedown', 'touchstart'].forEach(eventType => {
  document.addEventListener(eventType, trackUserInteraction, { once: true, passive: true });
});

// Prevent accidental closing during crawl (only after user interaction)
window.addEventListener('beforeunload', (e) => {
  // Only show confirmation if:
  // 1. Crawl is not complete AND
  // 2. User has interacted with the page (to comply with Chrome's policy)
  if (!crawlComplete && userHasInteracted) {
    e.preventDefault();
    e.returnValue = 'Crawl is still in progress. Are you sure you want to close?';
    return e.returnValue;
  }
});

// Initialize
console.log('Crawler progress window initialized');
