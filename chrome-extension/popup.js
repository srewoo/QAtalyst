// Popup script — crawler + how-to-use only.
// AI provider, API keys, and external integrations now live exclusively in
// Advanced Settings (options.html); the popup intentionally no longer renders
// or persists them.

// Open full options page (where AI provider, API key & integrations are set)
document.getElementById('openOptionsBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ── "No AI provider set" notice ──────────────────────────────────────────────
// AI config lives only in Advanced Settings now, so a first-time user may open
// the popup before configuring a key. Surface a dismissible-by-action nudge that
// links straight to the options page. Considered configured if a standard API
// key OR a Bedrock secret key has been stored.
async function checkApiKeyConfigured() {
  const notice = document.getElementById('noApiKeyNotice');
  if (!notice) return;
  try {
    const { apiKey, bedrockSecretKey } = await chrome.storage.sync.get(['apiKey', 'bedrockSecretKey']);
    const configured = Boolean((apiKey && apiKey.trim()) || (bedrockSecretKey && bedrockSecretKey.trim()));
    notice.style.display = configured ? 'none' : 'block';
  } catch (_) {
    // If storage can't be read, fail closed (show the nudge) — it's harmless.
    notice.style.display = 'block';
  }
}

const noApiKeyNoticeEl = document.getElementById('noApiKeyNotice');
if (noApiKeyNoticeEl) {
  const openSettings = () => chrome.runtime.openOptionsPage();
  noApiKeyNoticeEl.addEventListener('click', openSettings);
  noApiKeyNoticeEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSettings(); }
  });
}

// ============ WEB CRAWLER FUNCTIONALITY ============

// Load crawled apps on startup
async function loadCrawledApps() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getAllApps' });

    if (response && response.success && response.apps && response.apps.length > 0) {
      displayCrawledApps(response.apps);
    }
  } catch (error) {
    // Silently ignore "Receiving end does not exist" errors during initialization
    if (!error.message.includes('Receiving end does not exist')) {
      console.error('Error loading crawled apps:', error);
    }
  }
}

// Helper function to extract clean domain name from URL
function getCleanDomain(url) {
  try {
    const urlObj = new URL(url);
    // Remove 'www.' prefix if present for cleaner display
    let domain = urlObj.hostname;
    if (domain.startsWith('www.')) {
      domain = domain.substring(4);
    }
    return domain;
  } catch (e) {
    // If URL parsing fails, return the original URL
    return url;
  }
}

// Display crawled apps list
function displayCrawledApps(apps) {
  const appsList = document.getElementById('crawledAppsList');
  const appsGroup = document.getElementById('crawledAppsGroup');

  if (apps.length === 0) {
    appsGroup.style.display = 'none';
    return;
  }

  appsGroup.style.display = 'block';
  appsList.innerHTML = apps.map(app => `
    <div class="app-list-item">
      <div>
        <div class="app-url" title="${app.url}">${getCleanDomain(app.url)}</div>
        <div class="app-meta">${app.pages || 0} pages • ${app.features || 0} features • ${app.crawledAt}</div>
      </div>
      <div>
        <button class="btn-crawl-action" data-url="${app.url}" data-action="export">Export</button>
        <button class="btn-crawl-action danger" data-url="${app.url}" data-action="delete">Delete</button>
      </div>
    </div>
  `).join('');

  // Add event listeners for export/delete buttons
  appsList.querySelectorAll('.btn-crawl-action').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const action = e.target.dataset.action;
      const url = e.target.dataset.url;

      if (action === 'export') {
        await exportEmbeddings(url);
      } else if (action === 'delete') {
        if (confirm(`Delete embeddings for ${getCleanDomain(url)}?`)) {
          await deleteEmbeddings(url);
        }
      }
    });
  });
}

// Export embeddings
async function exportEmbeddings(appUrl) {
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'exportEmbeddings',
      data: { appUrl, format: 'json' }
    });

    if (response.success) {
      showCrawlStatus(`✅ Exported: ${response.filename}`, 'success');
    } else {
      showCrawlStatus(`❌ Export failed: ${response.error}`, 'error');
    }
  } catch (error) {
    showCrawlStatus(`❌ Export failed: ${error.message}`, 'error');
  }
}

// Delete embeddings
async function deleteEmbeddings(appUrl) {
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'deleteEmbeddings',
      data: { appUrl }
    });

    if (response.success) {
      showCrawlStatus('✅ Embeddings deleted', 'success');
      await loadCrawledApps(); // Reload list
    } else {
      showCrawlStatus(`❌ Delete failed: ${response.error}`, 'error');
    }
  } catch (error) {
    showCrawlStatus(`❌ Delete failed: ${error.message}`, 'error');
  }
}

// Crawl button handler
document.getElementById('crawlAppBtn').addEventListener('click', async () => {
  const crawlBtn = document.getElementById('crawlAppBtn');
  const statusDiv = document.getElementById('crawlStatus');

  try {
    // Get current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab || !tab.url) {
      showCrawlStatus('❌ No active tab found', 'error');
      return;
    }

    // Check if it's a valid URL
    if (!tab.url.startsWith('http://') && !tab.url.startsWith('https://')) {
      showCrawlStatus('❌ Please navigate to a web page first', 'error');
      return;
    }

    // Open persistent progress window
    const progressWindow = await chrome.windows.create({
      url: chrome.runtime.getURL('crawler-progress.html'),
      type: 'popup',
      width: 540,
      height: 450,
      focused: true
    });

    console.log('Progress window opened:', progressWindow.id);

    // Mark crawl as active
    await chrome.storage.local.set({
      activeCrawl: {
        startUrl: tab.url,
        startTime: new Date().toISOString()
      }
    });

    console.log('🕷️ Starting crawler - knowledge graph only');

    // Check if user wants to use current session for authenticated crawling
    const useCurrentSession = document.getElementById('useCurrentSession')?.checked || false;

    // Start crawl (non-blocking)
    chrome.runtime.sendMessage({
      action: 'startCrawl',
      data: {
        startUrl: tab.url,
        progressWindowId: progressWindow.id,
        useCurrentSession: useCurrentSession
      }
    });

    // Show active crawl status
    showActiveCrawlStatus(tab.url);

    // Show info message
    showCrawlStatus('🕷️ Crawl started! Progress window opened.', 'success');

    // Close popup after a short delay so user sees the message
    setTimeout(() => {
      window.close();
    }, 1000);

  } catch (error) {
    showCrawlStatus(`❌ Error: ${error.message}`, 'error');
  }
});

// Show crawl progress
function showCrawlProgress() {
  const statusDiv = document.getElementById('crawlStatus');
  statusDiv.style.display = 'block';
  statusDiv.className = 'crawl-progress';
  statusDiv.innerHTML = `
    <div>🕷️ Crawling web application...</div>
    <div class="progress-bar">
      <div class="progress-fill" id="progressFill" style="width: 0%"></div>
    </div>
    <div class="progress-text" id="progressText">Initializing...</div>
  `;
}

// Show crawl status
function showCrawlStatus(message, type) {
  const statusDiv = document.getElementById('crawlStatus');
  statusDiv.style.display = 'block';
  statusDiv.className = type === 'error' ? 'status error' : 'status success';
  statusDiv.textContent = message;

  setTimeout(() => {
    statusDiv.style.display = 'none';
  }, 5000);
}

// Show popup notification (for modals and general messages)
function showPopupNotification(message, type = 'info') {
  // Remove existing notification if any
  const existing = document.querySelector('.popup-notification');
  if (existing) existing.remove();

  const notification = document.createElement('div');
  notification.className = 'popup-notification';
  notification.style.cssText = `
    position: fixed;
    top: 10px;
    left: 50%;
    transform: translateX(-50%);
    padding: 10px 16px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    z-index: 10001;
    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
    animation: slideIn 0.3s ease;
    background: ${type === 'error' ? '#fee2e2' : type === 'warning' ? '#fef3c7' : '#dbeafe'};
    color: ${type === 'error' ? '#dc2626' : type === 'warning' ? '#d97706' : '#2563eb'};
    border: 1px solid ${type === 'error' ? '#fecaca' : type === 'warning' ? '#fde68a' : '#bfdbfe'};
  `;
  notification.textContent = message;
  document.body.appendChild(notification);

  setTimeout(() => {
    notification.style.opacity = '0';
    notification.style.transition = 'opacity 0.3s ease';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

// Listen for crawl progress updates
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'crawlProgress') {
    const progress = message.progress;

    if (progress.status === 'crawling') {
      const progressFill = document.getElementById('progressFill');
      const progressText = document.getElementById('progressText');

      if (progressFill && progressText) {
        const percentage = Math.round((progress.visited / progress.total) * 100);
        progressFill.style.width = `${percentage}%`;
        progressText.textContent = `${progress.visited}/${progress.total} pages • Current: ${progress.currentUrl || 'Loading...'}`;
      }
    }
  }

});

// Import embeddings button handler
document.getElementById('importEmbeddingsBtn').addEventListener('click', async () => {
  try {
    // Create file input
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';

    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      try {
        const reader = new FileReader();
        reader.onload = async (event) => {
          try {
            const data = JSON.parse(event.target.result);

            // Validate data structure
            if (!data.appUrl || !data.embeddings || !data.knowledgeGraph) {
              showCrawlStatus('❌ Invalid embedding file format', 'error');
              return;
            }

            // Import directly to IndexedDB (bypasses message size limit)
            showCrawlStatus('⏳ Importing large file...', 'success');

            // Ensure CONFIG is loaded
            await CONFIG.load();

            const storageManager = new StorageManager();
            await storageManager.init();
            await storageManager.saveEmbeddings(data.appUrl, data);

            showCrawlStatus(`✅ Imported ${data.embeddings.length} embeddings for ${getCleanDomain(data.appUrl)}`, 'success');
            await loadCrawledApps(); // Reload list
          } catch (error) {
            showCrawlStatus(`❌ Failed to parse file: ${error.message}`, 'error');
          }
        };
        reader.readAsText(file);
      } catch (error) {
        showCrawlStatus(`❌ Import error: ${error.message}`, 'error');
      }
    };

    input.click();
  } catch (error) {
    showCrawlStatus(`❌ Error: ${error.message}`, 'error');
  }
});

// Export all crawl data button handler
document.getElementById('exportAllEmbeddingsBtn').addEventListener('click', async () => {
  try {
    const response = await chrome.runtime.sendMessage({
      action: 'exportAllEmbeddings'
    });

    if (response.success) {
      if (response.count === 0) {
        showCrawlStatus('⚠️ No crawl data to export. Run a crawl first.', 'error');
      } else {
        const msg = response.count === 1
          ? '✅ Exported 1 crawl'
          : `✅ Exported ${response.count} crawls`;
        showCrawlStatus(msg, 'success');
      }
    } else {
      showCrawlStatus(`❌ Export failed: ${response.error}`, 'error');
    }
  } catch (error) {
    showCrawlStatus(`❌ Error: ${error.message}`, 'error');
  }
});

// Delete all data button handler
document.getElementById('deleteAllDataBtn').addEventListener('click', () => {
  // Show confirmation modal
  const modal = document.getElementById('deleteConfirmModal');
  modal.style.display = 'flex';
});

// Cancel delete
document.getElementById('cancelDeleteBtn').addEventListener('click', () => {
  const modal = document.getElementById('deleteConfirmModal');
  modal.style.display = 'none';
});

// Confirm delete
document.getElementById('confirmDeleteBtn').addEventListener('click', async () => {
  const modal = document.getElementById('deleteConfirmModal');
  const confirmBtn = document.getElementById('confirmDeleteBtn');

  try {
    // Disable button and show loading
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Deleting...';
    confirmBtn.style.background = '#9ca3af';

    // Send delete request
    const response = await chrome.runtime.sendMessage({
      action: 'deleteAllEmbeddings'
    });

    // Hide modal
    modal.style.display = 'none';

    if (response.success) {
      showCrawlStatus(`✅ Successfully deleted all data (${response.deletedCount} items)`, 'success');

      // Reload the crawled apps list
      await loadCrawledApps();

      // Hide the crawled apps section if empty
      const crawledAppsGroup = document.getElementById('crawledAppsGroup');
      crawledAppsGroup.style.display = 'none';
    } else {
      showCrawlStatus(`❌ Delete failed: ${response.error}`, 'error');
    }
  } catch (error) {
    modal.style.display = 'none';
    showCrawlStatus(`❌ Error: ${error.message}`, 'error');
  } finally {
    // Reset button
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Delete Everything';
    confirmBtn.style.background = '#dc2626';
  }
});

// Merge knowledge graphs button handler
document.getElementById('mergeGraphsBtn').addEventListener('click', async () => {
  try {
    // Get list of available apps to merge
    const response = await chrome.runtime.sendMessage({
      action: 'getMergeableApps'
    });

    if (!response.success || !response.apps || response.apps.length < 2) {
      showCrawlStatus('⚠️ Need at least 2 crawled apps to merge', 'error');
      return;
    }

    // Show merge selection UI
    showMergeSelectionUI(response.apps);
  } catch (error) {
    showCrawlStatus(`❌ Error: ${error.message}`, 'error');
  }
});

// Show merge selection UI
function showMergeSelectionUI(apps) {
  // Create modal-like overlay
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0,0,0,0.5);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
  `;

  const modal = document.createElement('div');
  modal.style.cssText = `
    background: white;
    border-radius: 8px;
    padding: 20px;
    max-width: 450px;
    width: 100%;
    max-height: 80vh;
    overflow-y: auto;
  `;

  modal.innerHTML = `
    <h2 style="margin: 0 0 16px 0; font-size: 18px; color: #1e293b;">🔀 Merge Knowledge Graphs</h2>
    <p style="margin: 0 0 16px 0; font-size: 13px; color: #64748b;">
      Select 2 or more crawls to merge. Great for combining help site documentation with actual app implementation!
    </p>
    <div id="mergeAppsList" style="margin-bottom: 16px;">
      ${apps.map((app, index) => `
        <label style="display: flex; align-items: center; padding: 12px; background: #f8fafc; border-radius: 4px; margin-bottom: 8px; cursor: pointer; gap: 12px;">
          <input type="checkbox" class="merge-app-checkbox" value="${app.url}" style="flex-shrink: 0; width: 16px; height: 16px; min-width: 16px; margin: 0; padding: 0;">
          <div style="flex: 1; min-width: 0;">
            <div style="font-size: 14px; font-weight: 500; color: #1e293b; margin-bottom: 4px;" title="${app.url}">${getCleanDomain(app.url)}${app.isMerged ? ' 🔀' : ''}</div>
            <div style="font-size: 12px; color: #64748b;">${app.pages || 0} pages • ${app.features || 0} features</div>
          </div>
        </label>
      `).join('')}
    </div>
    <div style="display: flex; gap: 8px;">
      <button id="confirmMergeBtn" class="btn-primary" style="flex: 1; margin: 0;">Merge Selected</button>
      <button id="cancelMergeBtn" class="btn-secondary" style="flex: 1; margin: 0;">Cancel</button>
    </div>
  `;

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Event handlers
  document.getElementById('confirmMergeBtn').addEventListener('click', async () => {
    const checkboxes = modal.querySelectorAll('.merge-app-checkbox:checked');
    if (checkboxes.length < 2) {
      showPopupNotification('Please select at least 2 apps to merge', 'warning');
      return;
    }

    const selectedUrls = Array.from(checkboxes).map(cb => cb.value);
    document.body.removeChild(overlay);

    // Perform merge
    await performMerge(selectedUrls);
  });

  document.getElementById('cancelMergeBtn').addEventListener('click', () => {
    document.body.removeChild(overlay);
  });

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      document.body.removeChild(overlay);
    }
  });
}

// Perform the actual merge
async function performMerge(appUrls) {
  try {
    showCrawlStatus('🔀 Merging knowledge graphs...', 'success');

    const response = await chrome.runtime.sendMessage({
      action: 'mergeKnowledgeGraphs',
      data: { appUrls }
    });

    if (response.success) {
      const report = response.report;

      // Build success message
      let message = `✅ Merged ${report.totalGraphs} graphs → ${report.totalPages} pages, ${report.stats.totalFeatures} features`;

      // Add embedding info if available
      if (report.embeddings && report.embeddings.total > 0) {
        const costMsg = report.embeddings.totalCost > 0
          ? `($${report.embeddings.totalCost.toFixed(4)})`
          : '(FREE)';
        message += `, ${report.embeddings.total} embeddings ${costMsg}`;
      }

      message += '!';

      showCrawlStatus(message, 'success');

      // Reload app list
      await loadCrawledApps();
    } else {
      showCrawlStatus(`❌ Merge failed: ${response.error}`, 'error');
    }
  } catch (error) {
    showCrawlStatus(`❌ Error: ${error.message}`, 'error');
  }
}

// Load last crawl summary
async function loadLastCrawlSummary() {
  try {
    const { lastCrawlResult } = await chrome.storage.local.get(['lastCrawlResult']);

    if (lastCrawlResult) {
      const summaryDiv = document.getElementById('lastCrawlSummary');
      const detailsDiv = document.getElementById('lastCrawlDetails');
      const timeDiv = document.getElementById('lastCrawlTime');

      // Format the summary
      let summary = `<strong>${lastCrawlResult.pages} pages</strong> • ${lastCrawlResult.features} features • ${lastCrawlResult.apis} APIs`;

      if (lastCrawlResult.embeddings > 0) {
        const costMsg = lastCrawlResult.cost > 0 ? `($${lastCrawlResult.cost.toFixed(4)})` : '(FREE)';
        summary += ` • ${lastCrawlResult.embeddings} embeddings ${costMsg}`;
      }

      // Format time
      const crawlTime = new Date(lastCrawlResult.timestamp);
      const now = new Date();
      const diffMs = now - crawlTime;
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      let timeText;
      if (diffMins < 1) {
        timeText = 'Just now';
      } else if (diffMins < 60) {
        timeText = `${diffMins} minute${diffMins > 1 ? 's' : ''} ago`;
      } else if (diffHours < 24) {
        timeText = `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
      } else {
        timeText = `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
      }

      const durationText = lastCrawlResult.duration
        ? ` • Took ${(lastCrawlResult.duration / 1000).toFixed(1)}s`
        : '';

      detailsDiv.innerHTML = summary;
      timeDiv.textContent = `${timeText}${durationText}`;
      summaryDiv.style.display = 'block';
    }
  } catch (error) {
    console.error('Error loading last crawl summary:', error);
  }
}

/**
 * Reflect crawl-in-progress state on the Start button so reopening the popup
 * mid-crawl clearly shows a crawl is running (and can't launch a second one).
 * Idempotent: stashes the original label once in a data attribute.
 */
function setCrawlButtonRunning(isRunning) {
  const btn = document.getElementById('crawlAppBtn');
  if (!btn) return;
  if (isRunning) {
    if (!btn.dataset.idleLabel) btn.dataset.idleLabel = btn.textContent;
    btn.textContent = '🕷️ Crawling in progress…';
    btn.disabled = true;
    btn.style.opacity = '0.7';
    btn.style.cursor = 'not-allowed';
  } else {
    btn.textContent = btn.dataset.idleLabel || 'Start Full Application Crawl';
    btn.disabled = false;
    btn.style.opacity = '';
    btn.style.cursor = '';
  }
}

// Show active crawl status
function showActiveCrawlStatus(url) {
  const activeCrawlDiv = document.getElementById('activeCrawlStatus');
  const detailsDiv = document.getElementById('activeCrawlDetails');

  detailsDiv.innerHTML = `
    <div style="margin-bottom: 6px;">
      <strong>URL:</strong> ${url}
    </div>
    <div>A progress window has been opened. Switch to it to see real-time crawl progress.</div>
  `;

  activeCrawlDiv.style.display = 'block';
  // Keep the primary Start button in sync with the active-crawl banner.
  setCrawlButtonRunning(true);
}

// Hide active crawl status
function hideActiveCrawlStatus() {
  const activeCrawlDiv = document.getElementById('activeCrawlStatus');
  activeCrawlDiv.style.display = 'none';
  setCrawlButtonRunning(false);
}

// Check for active crawl
async function checkActiveCrawl() {
  try {
    const { activeCrawl } = await chrome.storage.local.get(['activeCrawl']);

    if (activeCrawl && activeCrawl.startUrl) {
      // Check if the crawl is actually running or just a stale flag
      const startTime = new Date(activeCrawl.startTime);
      const now = new Date();
      const hoursSinceStart = (now - startTime) / (1000 * 60 * 60);

      // If crawl started more than 2 hours ago, it's likely stale
      if (hoursSinceStart > 2) {
        console.warn('⚠️ Stale crawl flag detected (started ' + hoursSinceStart.toFixed(1) + ' hours ago), clearing...');
        await chrome.storage.local.remove('activeCrawl');
        hideActiveCrawlStatus();
        return;
      }

      // Verify crawler is actually running by pinging background
      try {
        const response = await chrome.runtime.sendMessage({
          action: 'checkCrawlerStatus'
        });

        if (response && response.isRunning) {
          // Crawler is actually running, show status
          showActiveCrawlStatus(activeCrawl.startUrl);
        } else {
          // Crawler is not running, clear the stale flag
          console.warn('⚠️ Crawler flag set but no active crawler, clearing stale flag');
          await chrome.storage.local.remove('activeCrawl');
          hideActiveCrawlStatus();
        }
      } catch (error) {
        // If we can't verify, show status anyway but add a clear button
        showActiveCrawlStatus(activeCrawl.startUrl);
      }
    }
  } catch (error) {
    console.error('Error checking active crawl:', error);
  }
}

// Stop crawl button handler
document.getElementById('stopCrawlBtn').addEventListener('click', async () => {
  const stopBtn = document.getElementById('stopCrawlBtn');

  try {
    stopBtn.disabled = true;
    stopBtn.textContent = '⏸️ Working...';

    // Send stop message to background
    const response = await chrome.runtime.sendMessage({
      action: 'stopCrawl'
    });

    if (response && response.success) {
      showCrawlStatus('⏹️ Crawl stopped by user', 'success');
      hideActiveCrawlStatus();

      // Clear active crawl flag
      await chrome.storage.local.remove('activeCrawl');
    } else if (response && response.error === 'No active crawler') {
      // No active crawler but flag is set - clear the stale flag
      console.warn('⚠️ No active crawler found, clearing stale status flag');
      await chrome.storage.local.remove('activeCrawl');
      hideActiveCrawlStatus();
      showCrawlStatus('✅ Cleared stale crawl status', 'success');
    } else {
      showCrawlStatus('❌ Failed: ' + (response?.error || 'Unknown error'), 'error');
      stopBtn.disabled = false;
      stopBtn.textContent = '⏹️ Stop / Clear';
    }
  } catch (error) {
    showCrawlStatus('❌ Error: ' + error.message, 'error');
    stopBtn.disabled = false;
    stopBtn.textContent = '⏹️ Stop / Clear';
  }
});

// Listen for crawl completion to hide active status
chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'crawlComplete' || message.action === 'crawlError' || message.action === 'crawlStopped') {
    // Clear active crawl flag - errors are non-critical for cleanup
    chrome.storage.local.remove('activeCrawl').catch(err => {
      if (typeof logger !== 'undefined') {
        logger.warn('Failed to clear activeCrawl flag:', err.message);
      }
    });
    hideActiveCrawlStatus();

    // Show appropriate status message
    if (message.action === 'crawlStopped') {
      showCrawlStatus('⏹️ Crawl stopped by user', 'success');
    }
  }
});

// Load crawled apps when popup opens
loadCrawledApps();
loadLastCrawlSummary();
checkActiveCrawl();
checkApiKeyConfigured();
