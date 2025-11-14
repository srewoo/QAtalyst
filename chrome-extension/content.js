// Content script - Injects QAtalyst panel into Jira pages

(function() {
  'use strict';

  // Streaming state
  let currentStreamingRequestId = null;
  let streamingContent = '';
  let isStreaming = false;

  /**
   * Escape HTML special characters to prevent XSS
   * @param {string} text - Text to escape
   * @returns {string} - Escaped text
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Create safe error message element
   * @param {string} message - Error message to display
   * @returns {HTMLElement} - Safe error element
   */
  function createSafeErrorMessage(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'qatalyst-error';

    const icon = document.createTextNode('❌ ');
    errorDiv.appendChild(icon);

    // Split by newlines and create separate lines
    const lines = message.split('\n');
    lines.forEach((line, index) => {
      if (index > 0) {
        errorDiv.appendChild(document.createElement('br'));
      }
      errorDiv.appendChild(document.createTextNode(line));
    });

    return errorDiv;
  }

  /**
   * Safely format and sanitize content for display
   * Prevents XSS by using textContent and controlled DOM creation
   * @param {string} content - Content to format
   * @returns {HTMLElement} - Safe DOM element
   */
  function createSafeFormattedContent(content) {
    const container = document.createElement('div');

    // Split content by lines
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      const lineDiv = document.createElement('div');

      // Process bold text **text**
      const boldRegex = /\*\*(.*?)\*\*/g;
      let lastIndex = 0;
      let match;

      while ((match = boldRegex.exec(line)) !== null) {
        // Add text before match
        if (match.index > lastIndex) {
          const textNode = document.createTextNode(line.substring(lastIndex, match.index));
          lineDiv.appendChild(textNode);
        }

        // Add bold text
        const strongElem = document.createElement('strong');
        strongElem.textContent = match[1];
        lineDiv.appendChild(strongElem);

        lastIndex = match.index + match[0].length;
      }

      // Add remaining text
      if (lastIndex < line.length) {
        const textNode = document.createTextNode(line.substring(lastIndex));
        lineDiv.appendChild(textNode);
      }

      // Handle bullet points
      if (line.trim().startsWith('- ')) {
        lineDiv.style.paddingLeft = '20px';
        lineDiv.textContent = '• ' + line.substring(2);
      }

      // If line is empty, add space
      if (line.trim() === '') {
        lineDiv.innerHTML = '&nbsp;';
      }

      container.appendChild(lineDiv);
    }

    return container;
  }

  // Listen for streaming chunks, agent progress, evolution progress, enhancement progress, and historical mining progress
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'streamChunk') {
      handleStreamChunk(request.requestId, request.chunk);
    }
    if (request.action === 'keepAlive') {
      // Keep-alive heartbeat to prevent timeout - no action needed
      console.log('💓 Keep-alive heartbeat received');
    }
    if (request.action === 'agentProgress') {
      handleAgentProgress(request.progress);
    }
    if (request.action === 'evolutionProgress') {
      handleEvolutionProgress(request.progress);
    }
    if (request.action === 'enhancementProgress') {
      handleEnhancementProgress(request.status);
    }
    if (request.action === 'historicalMiningProgress') {
      handleHistoricalMiningProgress(request.status);
    }
    if (request.type === 'UPLOAD_PROGRESS') {
      handleUploadProgress(request.progress);
    }
    if (request.action === 'evolutionComplete') {
      handleEvolutionComplete(request.data);
    }
    if (request.action === 'evolutionError') {
      handleEvolutionError(request.error);
    }

    // Web Crawler handlers
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
  });

  // Helper function to load and decrypt settings
  async function loadAndDecryptSettings(keys) {
    const settings = await chrome.storage.sync.get(keys);

    // Decrypt sensitive tokens using the wrapper method that handles plain text gracefully
    if (settings.apiKey) {
      settings.apiKey = await securityManager.decryptApiKeyFromStorage(settings.apiKey);
    }
    if (settings.jiraApiToken) {
      settings.jiraApiToken = await securityManager.decryptApiKeyFromStorage(settings.jiraApiToken);
    }
    if (settings.confluenceToken) {
      settings.confluenceToken = await securityManager.decryptApiKeyFromStorage(settings.confluenceToken);
    }
    if (settings.figmaToken) {
      settings.figmaToken = await securityManager.decryptApiKeyFromStorage(settings.figmaToken);
    }
    if (settings.googleApiKey) {
      settings.googleApiKey = await securityManager.decryptApiKeyFromStorage(settings.googleApiKey);
    }
    if (settings.testrailApiKey) {
      settings.testrailApiKey = await securityManager.decryptApiKeyFromStorage(settings.testrailApiKey);
    }

    return settings;
  }

  // Fetch ticket data from Jira REST API
  async function fetchTicketDataFromAPI(ticketKey) {
    try {
      // Load Jira credentials
      const settings = await loadAndDecryptSettings(['jiraEmail', 'jiraApiToken']);

      if (!settings.jiraEmail || !settings.jiraApiToken) {
        console.log('🔑 Jira API credentials not configured, will use DOM scraping');
        return null;
      }

      // Get Jira base URL from current page
      const jiraBaseUrl = window.location.origin;

      console.log('🌐 Fetching ticket data from Jira API:', ticketKey);

      // Fetch ticket data
      const response = await fetch(`${jiraBaseUrl}/rest/api/3/issue/${ticketKey}`, {
        method: 'GET',
        headers: {
          'Authorization': 'Basic ' + btoa(`${settings.jiraEmail}:${settings.jiraApiToken}`),
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        console.warn(`⚠️ Jira API request failed: ${response.status} ${response.statusText}`);
        return null;
      }

      const issueData = await response.json();
      console.log('✅ Successfully fetched ticket data from Jira API');

      // Extract and format data
      const data = {
        key: issueData.key,
        summary: issueData.fields.summary || '',
        description: extractTextFromADF(issueData.fields.description) || '',
        comments: [],
        attachments: [],
        linkedPages: []
      };

      // Extract comments
      if (issueData.fields.comment && issueData.fields.comment.comments) {
        data.comments = issueData.fields.comment.comments.map((comment, index) => ({
          id: index + 1,
          author: comment.author?.displayName || 'Unknown',
          text: extractTextFromADF(comment.body) || '',
          timestamp: comment.created || ''
        }));
      }

      // Extract attachments
      if (issueData.fields.attachment) {
        data.attachments = issueData.fields.attachment.map((att, index) => ({
          id: index + 1,
          fileName: att.filename || 'Unknown',
          url: att.content || '',
          mimeType: att.mimeType || '',
          size: att.size || 0
        }));
      }

      return data;
    } catch (error) {
      console.error('❌ Error fetching from Jira API:', error);
      return null;
    }
  }

  // Extract all visible text from DOM using TreeWalker
  function extractVisibleText(rootElement = document.body) {
    const walker = document.createTreeWalker(rootElement, NodeFilter.SHOW_TEXT, {
      acceptNode: function(node) {
        // Skip text nodes inside invisible elements
        if (!node.parentElement) return NodeFilter.FILTER_REJECT;
        const style = window.getComputedStyle(node.parentElement);
        if (style.visibility === 'hidden' || style.display === 'none') {
          return NodeFilter.FILTER_REJECT;
        }
        // Skip empty or whitespace-only nodes
        if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    let text = '';

    while ((node = walker.nextNode())) {
      text += node.textContent.trim() + ' ';
    }

    return text.trim();
  }

  // Extract plain text with URLs from Jira's ADF (Atlassian Document Format)
  function extractTextFromADF(adfContent) {
    if (!adfContent) return '';
    if (typeof adfContent === 'string') return adfContent;

    let text = '';

    function traverse(node) {
      if (!node) return;

      // Extract text content
      if (node.type === 'text') {
        text += node.text || '';
      }

      // Extract URLs from links
      if (node.type === 'text' && node.marks) {
        const linkMark = node.marks.find(m => m.type === 'link');
        if (linkMark && linkMark.attrs && linkMark.attrs.href) {
          // If text doesn't match URL, append URL in parentheses
          if (node.text !== linkMark.attrs.href) {
            text += ` (${linkMark.attrs.href})`;
          }
        }
      }

      // Handle media/images
      if (node.type === 'media' || node.type === 'mediaInline') {
        if (node.attrs && node.attrs.url) {
          text += node.attrs.url + ' ';
        }
      }

      // Handle code blocks
      if (node.type === 'codeBlock' && node.content) {
        text += '\n```\n';
        node.content.forEach(traverse);
        text += '\n```\n';
        return;
      }

      // Add line breaks for paragraphs and headings
      if (['paragraph', 'heading'].includes(node.type)) {
        if (text && !text.endsWith('\n')) {
          text += '\n';
        }
      }

      // Recursively process child nodes
      if (node.content && Array.isArray(node.content)) {
        node.content.forEach(traverse);
      }

      // Add line break after paragraphs
      if (['paragraph', 'heading'].includes(node.type)) {
        text += '\n';
      }
    }

    traverse(adfContent);
    return text.trim();
  }

  function handleStreamChunk(requestId, chunk) {
    if (requestId !== currentStreamingRequestId) return;
    
    streamingContent += chunk;
    const resultsContainer = document.getElementById('results-container');
    if (resultsContainer) {
      // Clear and rebuild with safe DOM manipulation
      resultsContainer.innerHTML = '';

      const streamingDiv = document.createElement('div');
      streamingDiv.className = 'qatalyst-streaming';

      const headerDiv = document.createElement('div');
      headerDiv.className = 'stream-header';

      const statusSpan = document.createElement('span');
      statusSpan.className = 'stream-status';
      statusSpan.textContent = '✨ Generating...';

      const stopBtn = document.createElement('button');
      stopBtn.className = 'stop-btn';
      stopBtn.id = 'stop-stream-btn';
      stopBtn.textContent = '⏹ Stop';
      stopBtn.addEventListener('click', stopStreaming);

      headerDiv.appendChild(statusSpan);
      headerDiv.appendChild(stopBtn);

      const contentDiv = document.createElement('div');
      contentDiv.className = 'stream-content';
      contentDiv.appendChild(createSafeFormattedContent(streamingContent));

      streamingDiv.appendChild(headerDiv);
      streamingDiv.appendChild(contentDiv);
      resultsContainer.appendChild(streamingDiv);

      // Auto-scroll to bottom
      resultsContainer.scrollTop = resultsContainer.scrollHeight;
    }
  }
  
  function formatStreamingContent(content) {
    // Simple markdown-like formatting for streaming display
    return content
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>')
      .replace(/^- /gm, '• ');
  }
  
  function stopStreaming() {
    if (currentStreamingRequestId) {
      chrome.runtime.sendMessage({
        action: 'stopGeneration',
        requestId: currentStreamingRequestId
      });
      isStreaming = false;
      currentStreamingRequestId = null;
      
      // Update UI with safe DOM manipulation
      const resultsContainer = document.getElementById('results-container');
      if (resultsContainer) {
        resultsContainer.innerHTML = '';

        const warningDiv = document.createElement('div');
        warningDiv.className = 'qatalyst-warning';
        warningDiv.textContent = '⚠️ Generation stopped by user';

        const contentWrapper = document.createElement('div');
        contentWrapper.style.marginTop = '10px';
        contentWrapper.appendChild(createSafeFormattedContent(streamingContent));

        warningDiv.appendChild(contentWrapper);
        resultsContainer.appendChild(warningDiv);
      }
    }
  }
  
  function handleAgentProgress(progress) {
    const resultsContainer = document.getElementById('results-container');
    if (!resultsContainer) return;
    
    const { agent, step, total, status, description, count, error } = progress;
    
    // Update agent progress display
    const agentProgressHTML = `
      <div class="agent-progress-container">
        <div class="agent-progress-header">
          <h3>🧬 Multi-Agent Test Generation</h3>
          <div class="agent-progress-stats">Agent ${step}/${total}</div>
        </div>
        <div class="agent-progress-bar">
          <div class="agent-progress-fill" style="width: ${(step / total) * 100}%"></div>
        </div>
        <div class="agent-current">
          ${status === 'running' ? '⚡' : status === 'completed' ? '✅' : '❌'}
          <strong>${escapeHtml(agent)}</strong>
          ${status === 'running' ? `<span class="agent-desc">${escapeHtml(description)}</span>` : ''}
          ${status === 'completed' && count ? `<span class="agent-count">Generated ${escapeHtml(String(count))} tests</span>` : ''}
          ${status === 'error' ? `<span class="agent-error">${escapeHtml(error)}</span>` : ''}
        </div>
      </div>
    `;
    
    resultsContainer.innerHTML = agentProgressHTML;
  }
  
  function handleEvolutionProgress(progress) {
    const resultsContainer = document.getElementById('results-container');
    if (!resultsContainer) return;
    
    const { generation, total, status, bestFitness } = progress;
    
    // Update evolution progress display
    const evolutionProgressHTML = `
      <div class="evolution-progress-container">
        <div class="evolution-header">
          <h3>🧬 Evolutionary Optimization</h3>
          <div class="evolution-status ${status}">${status === 'completed' ? '✅ Complete' : '⚡ Evolving'}</div>
        </div>
        <div class="evolution-info">
          <div class="evolution-stat">
            <span class="stat-label">Generation:</span>
            <span class="stat-value">${generation}/${total}</span>
          </div>
          <div class="evolution-stat">
            <span class="stat-label">Best Fitness:</span>
            <span class="stat-value">${bestFitness}/100</span>
          </div>
        </div>
        <div class="evolution-progress-bar">
          <div class="evolution-progress-fill" style="width: ${(generation / total) * 100}%"></div>
        </div>
        <div class="evolution-desc">
          Applying genetic algorithm mutations to improve test coverage...
        </div>
      </div>
    `;
    
    resultsContainer.innerHTML = evolutionProgressHTML;
  }
  
  function handleEnhancementProgress(status) {
    const resultsContainer = document.getElementById('results-container');
    if (!resultsContainer) return;

    const enhancementHTML = `
      <div class="enhancement-progress-container">
        <div class="enhancement-header">
          <h3>🎯 Enhanced Features</h3>
          <div class="enhancement-status ${status}">
            ${status === 'analyzing' ? '⚡ Analyzing gaps & complexity...' : '✅ Analysis complete'}
          </div>
        </div>
        <div class="enhancement-info">
          <div class="enhancement-item">
            <span class="enhancement-icon">🔍</span>
            <span>Gap Analysis</span>
          </div>
          <div class="enhancement-item">
            <span class="enhancement-icon">📊</span>
            <span>Complexity Scaling</span>
          </div>
          <div class="enhancement-item">
            <span class="enhancement-icon">🎯</span>
            <span>Context-Aware Generation</span>
          </div>
        </div>
      </div>
    `;

    resultsContainer.innerHTML = enhancementHTML;
  }

  function handleHistoricalMiningProgress(status) {
    const resultsContainer = document.getElementById('results-container');
    if (!resultsContainer) return;

    const historicalHTML = `
      <div class="historical-mining-progress-container">
        <div class="historical-mining-header">
          <h3>🧠 Historical Test Case Mining</h3>
          <div class="historical-mining-status ${status}">
            ${status === 'analyzing' ? '⚡ Mining historical bugs...' : '✅ Mining complete'}
          </div>
        </div>
        <div class="historical-mining-info">
          <div class="historical-mining-item">
            <span class="historical-mining-icon">🔍</span>
            <span>Extracting Features</span>
          </div>
          <div class="historical-mining-item">
            <span class="historical-mining-icon">🐛</span>
            <span>Searching Historical Bugs</span>
          </div>
          <div class="historical-mining-item">
            <span class="historical-mining-icon">📊</span>
            <span>Analyzing Patterns</span>
          </div>
          <div class="historical-mining-item">
            <span class="historical-mining-icon">🛡️</span>
            <span>Generating Prevention Tests</span>
          </div>
        </div>
      </div>
    `;

    resultsContainer.innerHTML = historicalHTML;
  }

  // Wait for Jira page to load
  function waitForJiraLoad() {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const issueView = document.querySelector('[data-testid="issue.views.issue-base.foundation.summary.heading"]') ||
                         document.querySelector('#summary-val') ||
                         document.querySelector('.issue-header');
        
        if (issueView) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 500);
    });
  }
  
  // Inject the JiraShastra panel
  async function injectPanel() {
    await waitForJiraLoad();
    
    // Check if already injected
    if (document.getElementById('qatalyst-panel')) {
      return;
    }
    
    // Create panel container
    const panel = document.createElement('div');
    panel.id = 'qatalyst-panel';
    panel.className = 'qatalyst-panel';
    
    // Get ticket data
    const ticketKey = extractTicketKey();
    const ticketData = await extractTicketData();
    
    // Create panel HTML
    panel.innerHTML = `
      <div class="qatalyst-header">
        <div style="display: flex; align-items: center; gap: 8px;">
          <img src="${chrome.runtime.getURL('icons/icon16.png')}" alt="QAtalyst" style="width: 20px; height: 20px;">
          <h3>QAtalyst</h3>
        </div>
        <div class="qatalyst-header-buttons">
          <button class="qatalyst-expand" id="qatalyst-expand" title="Expand/Collapse">⇔</button>
          <button class="qatalyst-close" id="qatalyst-close">×</button>
        </div>
      </div>
      <div class="qatalyst-content">
        <div class="qatalyst-ticket-info">
          <strong>Ticket:</strong> ${escapeHtml(ticketKey)}
        </div>

        <div class="qatalyst-actions">
          <button class="qatalyst-btn primary" id="analyze-btn" data-testid="analyze-requirements-btn">
            <span class="btn-icon">🔍</span>
            <span>Analyse Requirements</span>
          </button>
          
          <button class="qatalyst-btn" id="test-scope-btn" data-testid="generate-test-scope-btn">
            <span class="btn-icon">📋</span>
            <span>Generate Test Scope</span>
          </button>
          
          <button class="qatalyst-btn" id="test-cases-btn" data-testid="generate-test-cases-btn">
            <span class="btn-icon">✓</span>
            <span>Generate Test Cases</span>
          </button>
        </div>
        
        <div class="qatalyst-results" id="results-container" data-testid="results-container">
          <div class="qatalyst-placeholder">
            <p>Select any action above to get started. Each feature works independently.</p>
            <ul style="text-align: left; margin-top: 10px; font-size: 12px;">
              <li>🔍 <strong>Analyse Requirements</strong> - Extract and structure ticket requirements</li>
              <li>📋 <strong>Generate Test Scope</strong> - Create comprehensive test planning document</li>
              <li>✓ <strong>Generate Test Cases</strong> - Generate 20-30 detailed, executable test cases</li>
            </ul>
          </div>
        </div>
        
        <div class="qatalyst-footer">
          <button class="qatalyst-btn secondary" id="settings-btn" data-testid="settings-btn">
            <span class="btn-icon">⚙️</span>
            <span>Settings</span>
          </button>
          <button class="qatalyst-btn secondary" id="help-btn" data-testid="help-btn">
            <span class="btn-icon">❓</span>
            <span>Help</span>
          </button>
        </div>
      </div>
    `;
    
    // Append to Jira page
    document.body.appendChild(panel);
    
    // Setup event listeners
    setupEventListeners(ticketKey, ticketData);
  }
  
  // Extract ticket key from URL
  function extractTicketKey() {
    const match = window.location.pathname.match(/\/browse\/([A-Z]+-\d+)/);
    return match ? match[1] : 'Unknown';
  }

  // Debug helper: Find description element on page
  window.debugDescriptionSelector = function() {
    console.log('🔍 Searching for description element...');
    const selectors = [
      '[data-testid="issue.views.issue-base.foundation.description.description-content"]',
      '#description-val',
      '[data-test-id="issue.views.field.rich-text.description"]',
      '.description-content',
      '.user-content-block',
      '[data-testid*="description"]',
      '[id*="description"]',
      '.ak-renderer-document'
    ];

    selectors.forEach(sel => {
      const el = document.querySelector(sel);
      if (el) {
        console.log(`✅ Found with selector: "${sel}"`);
        console.log('   Text preview:', el.innerText?.substring(0, 100) || el.textContent?.substring(0, 100));
      } else {
        console.log(`❌ Not found: "${sel}"`);
      }
    });

    // Also search for any element with "description" in data attributes
    const allWithDesc = document.querySelectorAll('[data-testid*="description"], [data-test-id*="description"]');
    console.log(`\n📊 Found ${allWithDesc.length} elements with "description" in data attributes:`);
    allWithDesc.forEach((el, i) => {
      console.log(`  ${i + 1}. ${el.tagName} - testid: ${el.getAttribute('data-testid') || el.getAttribute('data-test-id')}`);
    });
  };
  
  // Extract ticket data
  async function extractTicketData() {
    const ticketKey = extractTicketKey();

    // Try Jira API first
    console.log('🔄 Attempting to fetch ticket data from Jira API...');
    const apiData = await fetchTicketDataFromAPI(ticketKey);

    if (apiData) {
      console.log('✅ Using data from Jira API');

      // Debug logging
      console.log('========== JIRA API DATA DEBUG ==========');
      console.log('📝 Description from API:');
      console.log(apiData.description);
      console.log('\n💬 Comments from API:', apiData.comments.length);
      if (apiData.comments.length > 0) {
        apiData.comments.forEach((comment, index) => {
          console.log(`\n--- Comment ${index + 1} ---`);
          console.log(`Author: ${comment.author}`);
          console.log(`Text:`);
          console.log(comment.text);
        });
      }
      console.log('========================================');

      return apiData;
    }

    // Fallback to TreeWalker extraction (gets all visible text including URLs)
    console.log('⚠️ Falling back to TreeWalker text extraction');

    const data = {
      key: ticketKey,
      summary: '',
      description: '',
      comments: [],
      attachments: [],
      linkedPages: []
    };

    // Extract summary
    const summaryEl = document.querySelector('[data-testid="issue.views.issue-base.foundation.summary.heading"]') ||
                     document.querySelector('#summary-val');
    if (summaryEl) {
      data.summary = summaryEl.textContent.trim();
    }

    // Use TreeWalker to extract all visible text from the issue content area
    const issueContent = document.querySelector('[data-testid="issue.views.issue-base.foundation.details.issue-base"]') ||
                        document.querySelector('#issue-content') ||
                        document.querySelector('.issue-container') ||
                        document.querySelector('main') ||
                        document.body;

    console.log('📍 Extracting visible text from:', issueContent.tagName, issueContent.className);

    const extractedText = extractVisibleText(issueContent);

    data.description = extractedText;

    console.log('========== TREEWALKER EXTRACTION DEBUG ==========');
    console.log('📝 Extracted visible text:');
    console.log(data.description);
    console.log('\nText length:', data.description.length, 'characters');
    console.log('========================================');

    // Try to extract comments separately
    data.comments = extractComments();

    // Extract attachments
    data.attachments = extractAttachments();

    // Extract linked pages
    data.linkedPages = extractLinkedPages();

    // Final summary
    console.log('========== TICKET DATA SUMMARY ==========');
    console.log('Ticket Key:', data.key);
    console.log('Summary:', data.summary);
    console.log('Description Length:', data.description.length, 'characters');
    console.log('Comments Count:', data.comments.length);
    console.log('Attachments Count:', data.attachments.length);
    console.log('Linked Pages Count:', data.linkedPages.length);
    console.log('========================================');

    return data;
  }
  
  // Extract comments from ticket
  function extractComments() {
    const comments = [];
    
    // Try multiple selectors for different Jira versions
    const commentElements = document.querySelectorAll(
      '[data-testid="issue.activity.comment"],' +
      '.activity-comment,' +
      '.issue-data-block-comment'
    );
    
    commentElements.forEach((commentEl, index) => {
      const authorEl = commentEl.querySelector('[data-testid="issue.activity.comment.author"]') ||
                      commentEl.querySelector('.comment-author') ||
                      commentEl.querySelector('.author');
      
      const bodyEl = commentEl.querySelector('[data-testid="issue.activity.comment.body"]') ||
                    commentEl.querySelector('.comment-body') ||
                    commentEl.querySelector('.action-body');
      
      if (bodyEl) {
        // Use innerText to preserve URL format
        const commentText = bodyEl.innerText || bodyEl.textContent.trim();
        comments.push({
          id: index + 1,
          author: authorEl ? authorEl.textContent.trim() : 'Unknown',
          text: commentText,
          timestamp: extractCommentTimestamp(commentEl)
        });
      }
    });
    
    return comments;
  }
  
  // Extract comment timestamp
  function extractCommentTimestamp(commentEl) {
    const timeEl = commentEl.querySelector('time') ||
                   commentEl.querySelector('[data-testid="issue.activity.comment.timestamp"]') ||
                   commentEl.querySelector('.comment-time');
    
    return timeEl ? timeEl.getAttribute('datetime') || timeEl.textContent.trim() : '';
  }
  
  // Extract attachments from ticket
  function extractAttachments() {
    const attachments = [];

    // Try multiple selectors for different Jira versions
    const attachmentElements = document.querySelectorAll(
      '[data-testid="issue.views.field.rich-text.attachments.attachment-item"],' +
      '.attachment-content,' +
      '.attachment-item,' +
      '[data-testid="media-card-view"]'
    );

    attachmentElements.forEach((attachEl, index) => {
      const linkEl = attachEl.querySelector('a') ||
                    attachEl.querySelector('[data-testid="media-card-link"]');

      const nameEl = attachEl.querySelector('.attachment-title') ||
                    attachEl.querySelector('[data-testid="media-card-title"]') ||
                    linkEl;

      if (linkEl) {
        const fileName = nameEl ? nameEl.textContent.trim() : 'Unknown';
        const fileType = extractFileType(fileName);

        attachments.push({
          id: index + 1,
          name: fileName,
          url: linkEl.href || '',
          type: fileType,
          isImage: fileType === 'image'
        });
      }
    });

    return attachments;
  }

  // Fetch image attachments as base64 (for vision models)
  async function fetchImageAttachments(attachments) {
    const imageAttachments = attachments.filter(att => att.isImage);
    const imageData = [];

    console.log(`📷 Found ${imageAttachments.length} image attachments to fetch`);

    for (const attachment of imageAttachments) {
      try {
        console.log(`📥 Fetching image: ${attachment.name}`);
        const response = await fetch(attachment.url);

        if (!response.ok) {
          console.warn(`⚠️ Failed to fetch ${attachment.name}: ${response.status}`);
          continue;
        }

        const blob = await response.blob();
        const base64 = await blobToBase64(blob);

        imageData.push({
          name: attachment.name,
          data: base64,
          mimeType: blob.type
        });

        console.log(`✅ Fetched ${attachment.name} (${(blob.size / 1024).toFixed(2)} KB)`);
      } catch (error) {
        console.warn(`⚠️ Error fetching ${attachment.name}:`, error.message);
      }
    }

    return imageData;
  }

  // Convert blob to base64
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  
  // Extract file type from filename
  function extractFileType(filename) {
    const extension = filename.split('.').pop().toLowerCase();
    const imageTypes = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'];
    const docTypes = ['pdf', 'doc', 'docx', 'txt', 'md'];
    
    if (imageTypes.includes(extension)) return 'image';
    if (docTypes.includes(extension)) return 'document';
    return extension || 'unknown';
  }
  
  // Extract linked pages (Confluence, external URLs)
  function extractLinkedPages() {
    const linkedPages = [];
    const processedUrls = new Set();
    
    // Find all links in description and comments
    const linkElements = document.querySelectorAll(
      '[data-testid="issue.views.issue-base.foundation.description.description-content"] a,' +
      '.user-content-block a,' +
      '.description a,' +
      '.comment-body a'
    );
    
    linkElements.forEach((linkEl, index) => {
      const url = linkEl.href;
      const text = linkEl.textContent.trim();
      
      // Filter out internal Jira links and duplicates
      if (url && !processedUrls.has(url) && !url.includes('/browse/')) {
        processedUrls.add(url);
        
        const pageType = determinePageType(url);
        
        linkedPages.push({
          id: index + 1,
          title: text || url,
          url: url,
          type: pageType
        });
      }
    });
    
    return linkedPages;
  }
  
  // Determine the type of linked page
  function determinePageType(url) {
    if (url.includes('confluence') || url.includes('atlassian.net/wiki')) {
      return 'confluence';
    } else if (url.includes('figma.com')) {
      return 'figma';
    } else if (url.includes('docs.google.com')) {
      return 'google_docs';
    } else if (url.includes('drive.google.com')) {
      return 'google_drive';
    } else if (url.includes('github.com')) {
      return 'github';
    }
    return 'external';
  }

  /**
   * Extract important keywords from Jira ticket for intelligent crawl data filtering
   * @param {Object} ticketData - Jira ticket data
   * @returns {Array} - Array of keywords
   */
  function extractTicketKeywords(ticketData) {
    const keywords = new Set();
    const text = `${ticketData.summary || ''} ${ticketData.description || ''}`.toLowerCase();

    // Common words to ignore
    const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'may', 'might', 'must', 'can']);

    // Extract words (3+ characters, not stop words)
    const words = text.match(/\b[a-z]{3,}\b/g) || [];
    words.forEach(word => {
      if (!stopWords.has(word)) {
        keywords.add(word);
      }
    });

    // Extract camelCase and kebab-case terms
    const compoundWords = text.match(/[a-z]+(?:[A-Z][a-z]+)+|[a-z]+-[a-z-]+/g) || [];
    compoundWords.forEach(word => keywords.add(word.toLowerCase()));

    return Array.from(keywords);
  }

  /**
   * Get intelligently filtered crawl context based on Jira ticket keywords
   * Queries crawl data JSON and creates 5-10 KB focused summary
   * @param {Object} ticketData - Jira ticket data for keyword extraction
   * @returns {Promise<string|null>} - Filtered context summary
   */
  async function getCrawledContextSummary(ticketData) {
    try {
      // Extract keywords from Jira ticket
      const keywords = extractTicketKeywords(ticketData);

      if (keywords.length === 0) {
        console.log('ℹ️ No keywords extracted from ticket for crawl data filtering');
        return null;
      }

      console.log(`🔍 Extracted ${keywords.length} keywords from ticket:`, keywords.slice(0, 10));

      // Request filtered crawl data from background
      const response = await chrome.runtime.sendMessage({
        action: 'getFilteredCrawlData',
        keywords: keywords,
        maxSizeKB: 10 // Limit summary to 10 KB
      });

      if (!response || !response.success || !response.summary) {
        console.log('ℹ️ No relevant crawl data found. Use Settings > Web App Crawler to crawl your application.');
        return null;
      }

      console.log(`✅ Using filtered crawl context (${response.summary.length} bytes, ${response.matchedPages} relevant pages)`);
      return response.summary;

    } catch (error) {
      console.warn('⚠️ Could not fetch filtered crawl data:', error);
      return null;
    }
  }

  // Setup event listeners
  function setupEventListeners(ticketKey, ticketData) {
    // Close button
    document.getElementById('qatalyst-close')?.addEventListener('click', () => {
      document.getElementById('qatalyst-panel').style.display = 'none';
    });

    // Expand button
    document.getElementById('qatalyst-expand')?.addEventListener('click', () => {
      const panel = document.getElementById('qatalyst-panel');
      panel.classList.toggle('expanded');
    });

    // Analyze button
    document.getElementById('analyze-btn')?.addEventListener('click', async () => {
      await handleAnalyze(ticketKey, ticketData);
    });

    // Test scope button
    document.getElementById('test-scope-btn')?.addEventListener('click', async () => {
      await handleTestScope(ticketKey, ticketData);
    });

    // Test cases button
    document.getElementById('test-cases-btn')?.addEventListener('click', async () => {
      await handleTestCases(ticketKey, ticketData);
    });
    
    // Settings button
    document.getElementById('settings-btn')?.addEventListener('click', () => {
      // Send message to background to open options page
      chrome.runtime.sendMessage({ action: 'openOptions' });
    });
    
    // Help button
    document.getElementById('help-btn')?.addEventListener('click', () => {
      showHelp();
    });
  }
  
  // Validate settings before operations
  function validateSettingsUI(settings) {
    const errors = [];
    
    if (!settings.apiKey || settings.apiKey.trim() === '') {
      errors.push('⚠️ API Key is missing');
    }
    
    if (!settings.llmProvider) {
      errors.push('⚠️ LLM Provider not selected');
    }
    
    if (!settings.llmModel) {
      errors.push('⚠️ LLM Model not selected');
    }
    
    return errors;
  }
  
  // Handle analyze requirements
  async function handleAnalyze(ticketKey, ticketData) {
    const resultsContainer = document.getElementById('results-container');
    const btn = document.getElementById('analyze-btn');
    btn.disabled = true;

    try {
      const settings = await loadAndDecryptSettings([
        'llmProvider', 'llmModel', 'apiKey', 'enableStreaming',
        'confluenceUrl', 'confluenceEmail', 'confluenceToken',
        'figmaToken', 'googleApiKey'
      ]);

      // Fetch Jira image attachments if model supports vision
      const visionModels = ['gpt-4o', 'gpt-4o-mini', 'claude-3-opus', 'claude-3-sonnet', 'gemini-pro-vision', 'gemini-1.5-pro'];
      if (visionModels.some(model => settings.llmModel?.includes(model)) && ticketData.attachments?.length > 0) {
        console.log('📷 Vision model detected, fetching Jira image attachments...');
        ticketData.imageAttachments = await fetchImageAttachments(ticketData.attachments);
      }
      
      // Validate settings
      const validationErrors = validateSettingsUI(settings);
      if (validationErrors.length > 0) {
        throw new Error(
          validationErrors.join('\\n') + 
          '\\n\\n🔧 Please configure your settings by clicking the Settings button below.'
        );
      }
      
      // Use streaming or regular based on settings
      if (settings.enableStreaming !== false) {
        // Initialize streaming
        streamingContent = '';
        isStreaming = true;
        currentStreamingRequestId = `analyze-${Date.now()}`;
        resultsContainer.innerHTML = '<div class="qatalyst-loading">🔍 Analyzing requirements with AI (streaming enabled)...</div>';
        
        const crawledContext = await getCrawledContextSummary(ticketData);

        // Update currentAppContext for UI display
        if (crawledContext) {
          currentAppContext = { hasCrawledData: true };
        } else {
          currentAppContext = null;
        }

        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: 'analyzeRequirementsStream',
            data: {
              ticketKey,
              ticketData,
              settings,
              crawledContext: crawledContext
            }
          }, response => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (!response) {
              reject(new Error('No response received from extension'));
            } else if (response.error) {
              reject(new Error(response.error));
            } else {
              resolve(response);
            }
          });
        });

        // Stream is complete
        isStreaming = false;
        currentStreamingRequestId = null;
        displayAnalysisResults(response);
      } else {
        // Regular non-streaming
        resultsContainer.innerHTML = '<div class="qatalyst-loading">🔍 Analyzing requirements with AI...</div>';
        
        const crawledContext = await getCrawledContextSummary(ticketData);

        // Update currentAppContext for UI display
        if (crawledContext) {
          currentAppContext = { hasCrawledData: true };
        } else {
          currentAppContext = null;
        }

        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: 'analyzeRequirements',
            data: {
              ticketKey,
              ticketData,
              settings,
              crawledContext: crawledContext
            }
          }, response => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (!response) {
              reject(new Error('No response received from extension'));
            } else if (response.error) {
              reject(new Error(response.error));
            } else {
              resolve(response);
            }
          });
        });

        displayAnalysisResults(response);
      }
      
    } catch (error) {
      isStreaming = false;
      currentStreamingRequestId = null;
      resultsContainer.innerHTML = '';
      resultsContainer.appendChild(createSafeErrorMessage(error.message));
    } finally {
      btn.disabled = false;
    }
  }
  
  // Handle test scope generation
  async function handleTestScope(ticketKey, ticketData) {
    const resultsContainer = document.getElementById('results-container');
    const btn = document.getElementById('test-scope-btn');
    
    if (!ticketData) {
      resultsContainer.innerHTML = `
        <div class="qatalyst-error">
          ❌ Could not extract ticket data. Please try refreshing the page or analyzing requirements first.
        </div>
      `;
      return;
    }
    
    btn.disabled = true;
    
    try {
      const settings = await loadAndDecryptSettings([
        'llmProvider', 'llmModel', 'apiKey', 'enableStreaming',
        'confluenceUrl', 'confluenceEmail', 'confluenceToken',
        'figmaToken', 'googleApiKey'
      ]);

      // Fetch Jira image attachments if model supports vision
      const visionModels = ['gpt-4o', 'gpt-4o-mini', 'claude-3-opus', 'claude-3-sonnet', 'gemini-pro-vision', 'gemini-1.5-pro'];
      if (visionModels.some(model => settings.llmModel?.includes(model)) && ticketData.attachments?.length > 0) {
        console.log('📷 Vision model detected, fetching Jira image attachments...');
        ticketData.imageAttachments = await fetchImageAttachments(ticketData.attachments);
      }

      // Validate settings
      const validationErrors = validateSettingsUI(settings);
      if (validationErrors.length > 0) {
        throw new Error(
          validationErrors.join('\\n') + 
          '\\n\\n🔧 Please configure your settings by clicking the Settings button below.'
        );
      }
      
      // Use streaming or regular based on settings
      if (settings.enableStreaming !== false) {
        // Initialize streaming
        streamingContent = '';
        isStreaming = true;
        currentStreamingRequestId = `scope-${Date.now()}`;
        resultsContainer.innerHTML = '<div class="qatalyst-loading">📋 Generating comprehensive test scope (streaming enabled)...</div>';
        
        const crawledContext = await getCrawledContextSummary(ticketData);

        // Update currentAppContext for UI display
        if (crawledContext) {
          currentAppContext = { hasCrawledData: true };
        } else {
          currentAppContext = null;
        }

        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: 'generateTestScopeStream',
            data: {
              ticketKey,
              ticketData,
              settings,
              crawledContext: crawledContext
            }
          }, response => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (!response) {
              reject(new Error('No response received from extension'));
            } else if (response.error) {
              reject(new Error(response.error));
            } else {
              resolve(response);
            }
          });
        });

        // Stream is complete
        isStreaming = false;
        currentStreamingRequestId = null;
        displayTestScopeResults(response);
      } else {
        // Regular non-streaming
        resultsContainer.innerHTML = '<div class="qatalyst-loading">📋 Generating comprehensive test scope...</div>';

        const crawledContext = await getCrawledContextSummary(ticketData);

        // Update currentAppContext for UI display
        if (crawledContext) {
          currentAppContext = { hasCrawledData: true };
        } else {
          currentAppContext = null;
        }

        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: 'generateTestScope',
            data: {
              ticketKey,
              ticketData,
              settings,
              crawledContext: crawledContext
            }
          }, response => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (!response) {
              reject(new Error('No response received from extension'));
            } else if (response.error) {
              reject(new Error(response.error));
            } else {
              resolve(response);
            }
          });
        });

        displayTestScopeResults(response);
      }
      
    } catch (error) {
      isStreaming = false;
      currentStreamingRequestId = null;
      resultsContainer.innerHTML = '';
      resultsContainer.appendChild(createSafeErrorMessage(error.message));
    } finally {
      btn.disabled = false;
    }
  }
  
  // Handle test cases generation
  async function handleTestCases(ticketKey, ticketData) {
    const resultsContainer = document.getElementById('results-container');
    const btn = document.getElementById('test-cases-btn');
    btn.disabled = true;
    
    try {
      const settings = await loadAndDecryptSettings([
        'llmProvider', 'llmModel', 'apiKey', 'enableStreaming', 'enableMultiAgent',
        'enableEvolution', 'evolutionIntensity', 'testCount',
        'positivePercent', 'negativePercent', 'edgePercent', 'integrationPercent',
        'enablePositiveAgent', 'enableNegativeAgent', 'enableEdgeAgent',
        'enableRegressionAgent', 'enableIntegrationAgent', 'enableReviewAgent',
        'enableHistoricalMining', 'historicalMaxResults', 'historicalJqlFilters',
        'jiraEmail', 'jiraApiToken'
      ]);

      // Fetch Jira image attachments if model supports vision
      const visionModels = ['gpt-4o', 'gpt-4o-mini', 'claude-3-opus', 'claude-3-sonnet', 'gemini-pro-vision', 'gemini-1.5-pro'];
      if (visionModels.some(model => settings.llmModel?.includes(model)) && ticketData.attachments?.length > 0) {
        console.log('📷 Vision model detected, fetching Jira image attachments...');
        ticketData.imageAttachments = await fetchImageAttachments(ticketData.attachments);
      }

      // Extract app context from crawled knowledge graphs (if enabled)
      let appContext = null;
      if (settings.useCrawledDataForTests !== false) { // Enabled by default
        console.log('🔍 [CRAWL DATA] Feature enabled - extracting app context from crawled data...');
        appContext = await extractAppContext(ticketData);
        currentAppContext = appContext; // Store globally for UI display
        if (appContext) {
          console.log(`✅ [CRAWL DATA] Successfully extracted app context:`);
          console.log(`   📱 App URL: ${appContext.appUrl}`);
          console.log(`   📄 Total Pages: ${appContext.totalPages || 0}`);
          console.log(`   📝 Forms: ${appContext.forms?.length || 0}`);
          console.log(`   🔌 APIs: ${appContext.apis?.length || 0}`);
          console.log(`   📄 Page details: ${appContext.pages?.length || 0}`);
          console.log(`   🔘 Features: ${appContext.features?.length || 0}`);
        } else {
          console.log('⚠️ [CRAWL DATA] No crawled app context found - proceeding without it');
          console.log('   💡 Tip: Crawl your app first using the popup or settings page');
        }
      } else {
        console.log('❌ [CRAWL DATA] Feature disabled in settings - skipping app context extraction');
        console.log('   💡 Enable in Settings → Crawler Settings → "Use Crawled Data in Test Generation"');
        currentAppContext = null;
      }

      // Debug logging for settings
      console.log('🔍 QAtalyst Settings Loaded:', {
        enableMultiAgent: settings.enableMultiAgent,
        enableEvolution: settings.enableEvolution,
        enableRegressionAgent: settings.enableRegressionAgent,
        enablePositiveAgent: settings.enablePositiveAgent,
        enableNegativeAgent: settings.enableNegativeAgent,
        enableEdgeAgent: settings.enableEdgeAgent,
        testCount: settings.testCount,
        llmProvider: settings.llmProvider,
        llmModel: settings.llmModel
      });

      // Debug: Direct storage check to verify what's actually stored
      chrome.storage.sync.get(['enableMultiAgent'], (result) => {
        console.log('🔍 Direct storage check for enableMultiAgent:', result);
        console.log('🔍 Type of enableMultiAgent:', typeof result.enableMultiAgent);
        console.log('🔍 Value is truthy?', !!result.enableMultiAgent);
      });

      // Validate settings
      const validationErrors = validateSettingsUI(settings);
      if (validationErrors.length > 0) {
        throw new Error(
          validationErrors.join('\\n') +
          '\\n\\n🔧 Please configure your settings by clicking the Settings button below.'
        );
      }

      // Use multi-agent if enabled
      console.log('🔍 Checking multi-agent enabled:', settings.enableMultiAgent);
      if (settings.enableMultiAgent) {
        console.log('✅ Multi-agent is enabled, using multi-agent system');
      } else {
        console.log('❌ Multi-agent is NOT enabled, using single-agent system');
      }

      if (settings.enableMultiAgent) {
        console.log('🚀 Starting multi-agent test case generation...');
        resultsContainer.innerHTML = '<div class="qatalyst-loading">🧬 Initializing multi-agent system...</div>';

        console.log('📤 Sending message to background script...');
        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: 'generateTestCasesMultiAgent',
            data: {
              ticketKey,
              ticketData,
              settings,
              baseUrl: window.location.origin,
              externalSources: currentAnalysisData?.externalSources, // Pass external sources if available
              appContext: appContext // Add crawled app context
            }
          }, response => {
            console.log('📥 Received response from background script:', response);
            if (chrome.runtime.lastError) {
              console.error('❌ Chrome runtime error:', chrome.runtime.lastError);
              reject(new Error(chrome.runtime.lastError.message));
            } else if (!response) {
              console.error('❌ No response received');
              reject(new Error('No response received from extension'));
            } else if (response.error) {
              console.error('❌ Response contains error:', response.error);
              reject(new Error(response.error));
            } else {
              console.log('✅ Response successful, displaying results');
              resolve(response);
            }
          });
        });

        displayTestCasesResults(response);
      }
      // Use streaming or regular based on settings
      else if (settings.enableStreaming !== false) {
        // Initialize streaming
        streamingContent = '';
        isStreaming = true;
        currentStreamingRequestId = `testcases-${Date.now()}`;
        resultsContainer.innerHTML = '<div class="qatalyst-loading">🤖 Generating test cases (streaming enabled)...</div>';
        
        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: 'generateTestCasesStream',
            data: {
              ticketKey,
              ticketData,
              settings,
              appContext: appContext // Add crawled app context
            }
          }, response => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (!response) {
              reject(new Error('No response received from extension'));
            } else if (response.error) {
              reject(new Error(response.error));
            } else {
              resolve(response);
            }
          });
        });
        
        // Stream is complete
        isStreaming = false;
        currentStreamingRequestId = null;
        displayTestCasesResults(response);
      } else {
        // Regular non-streaming (single-agent)
        resultsContainer.innerHTML = '<div class="qatalyst-loading">🤖 Generating test cases...</div>';
        
        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: 'generateTestCases',
            data: {
              ticketKey,
              ticketData,
              settings,
              appContext: appContext // Add crawled app context
            }
          }, response => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (!response) {
              reject(new Error('No response received from extension'));
            } else if (response.error) {
              reject(new Error(response.error));
            } else {
              resolve(response);
            }
          });
        });
        
        displayTestCasesResults(response);
      }
      
    } catch (error) {
      isStreaming = false;
      currentStreamingRequestId = null;
      resultsContainer.innerHTML = '';
      resultsContainer.appendChild(createSafeErrorMessage(error.message));
    } finally {
      btn.disabled = false;
    }
  }
  
  // Store current results for review feature
  let currentAnalysisData = null;
  let currentTestScopeData = null;
  let currentTestCasesData = null;
  let currentAppContext = null; // Store crawled app context for UI display

  // Display functions
  function displayAnalysisResults(data) {
    const container = document.getElementById('results-container');
    currentAnalysisData = data; // Store for review

    // Render context summary box
    const contextSummaryHtml = renderContextSummaryBox(data.externalSources || {}, currentAppContext);

    container.innerHTML = `
      <div class="qatalyst-result">
        <h4>📊 Requirements Analysis</h4>
        ${contextSummaryHtml}
        <div class="result-content">
          ${formatAnalysis(data.analysis)}
        </div>
        <button class="qatalyst-btn small" onclick="this.parentElement.querySelector('.result-content').classList.toggle('expanded')">View Full Analysis</button>

        <!-- User Review Section -->
        <div class="qatalyst-review-section">
          <h5>💬 Provide Feedback (Optional)</h5>
          <p style="font-size: 12px; color: #666; margin-bottom: 8px;">
            Add your feedback below and click "Regenerate" to get an improved version based on your input.
          </p>
          <textarea
            id="analysis-review-input"
            class="qatalyst-review-textarea"
            placeholder="Example: Add more details about security requirements, focus on API integration points, etc."
            rows="3"
          ></textarea>
          <button class="qatalyst-btn primary" id="regenerate-analysis-btn" style="margin-top: 8px;">
            <span class="btn-icon">🔄</span>
            <span>Regenerate with Feedback</span>
          </button>
        </div>

        <button class="qatalyst-btn primary" id="add-analysis-to-jira-btn" style="margin-top: 12px;">
          <span class="btn-icon">📝</span>
          <span>Add to Jira</span>
        </button>
      </div>
    `;

    // Add event listeners
    document.getElementById('regenerate-analysis-btn')?.addEventListener('click', async () => {
      const review = document.getElementById('analysis-review-input').value.trim();
      if (!review) {
        alert('⚠️ Please provide some feedback before regenerating.');
        return;
      }
      await handleRegenerateAnalysis(review);
    });

    document.getElementById('add-analysis-to-jira-btn')?.addEventListener('click', () => {
      addAnalysisToJira(data.analysis);
    });
  }
  
  function displayTestScopeResults(data) {
    const container = document.getElementById('results-container');
    currentTestScopeData = data; // Store for review

    // Handle both 'scope' and 'testScope' properties for backward compatibility
    const scopeContent = data.scope || data.testScope || 'No scope generated';
    
    // Check if scope is undefined, null, empty, or the string "undefined"
    if (!scopeContent || scopeContent === 'undefined' || scopeContent.trim() === '' || scopeContent === 'No scope generated') {
      container.innerHTML = `
        <div class="qatalyst-error">
          <h4>❌ Test Scope Generation Failed</h4>
          <p>The AI provider did not return a valid test scope. This may be due to:</p>
          <ul style="text-align: left; margin: 15px 0; padding-left: 20px;">
            <li><strong>Extension Cache Issue:</strong> Try reloading the extension
              <br><small style="color: #666;">Go to <code>chrome://extensions</code> and click the reload button</small>
            </li>
            <li><strong>API Configuration:</strong> Verify your API key is valid and has sufficient quota</li>
            <li><strong>Integration Errors:</strong> Check browser console for detailed error messages</li>
            <li><strong>Ticket Data:</strong> Ensure the Jira ticket has sufficient description content</li>
          </ul>
          <button class="qatalyst-btn primary" onclick="location.reload();" style="margin-top: 10px;">
            🔄 Reload Page
          </button>
        </div>
      `;
      return;
    }
    
    container.innerHTML = `
      <div class="qatalyst-result">
        <h4>📋 Test Scope</h4>
        <div class="result-content">
          ${formatTestScope(scopeContent)}
        </div>

        <!-- User Review Section -->
        <div class="qatalyst-review-section">
          <h5>💬 Provide Feedback (Optional)</h5>
          <p style="font-size: 12px; color: #666; margin-bottom: 8px;">
            Add your feedback below and click "Regenerate" to get an improved test scope based on your input.
          </p>
          <textarea
            id="scope-review-input"
            class="qatalyst-review-textarea"
            placeholder="Example: Add more focus on performance testing, include mobile test scenarios, etc."
            rows="3"
          ></textarea>
          <button class="qatalyst-btn primary" id="regenerate-scope-btn" style="margin-top: 8px;">
            <span class="btn-icon">🔄</span>
            <span>Regenerate with Feedback</span>
          </button>
        </div>

        <button class="qatalyst-btn primary" id="add-scope-to-jira-btn" style="margin-top: 12px;">
          <span class="btn-icon">📝</span>
          <span>Add to Jira</span>
        </button>
      </div>
    `;

    // Add event listeners
    document.getElementById('regenerate-scope-btn')?.addEventListener('click', async () => {
      const review = document.getElementById('scope-review-input').value.trim();
      if (!review) {
        alert('⚠️ Please provide some feedback before regenerating.');
        return;
      }
      await handleRegenerateTestScope(review);
    });

    document.getElementById('add-scope-to-jira-btn')?.addEventListener('click', () => {
      addTestScopeToJira(scopeContent);
    });
  }
  
  function displayTestCasesResults(data) {
    const container = document.getElementById('results-container');
    currentTestCasesData = data; // Store for review

    // Render context summary box
    const contextSummaryHtml = renderContextSummaryBox(data.externalSources || {}, currentAppContext);

    // Calculate statistics from test cases
    const stats = {
      total: data.total || data.testCases?.length || 0,
      positive: data.byCategory?.Positive || data.testCases?.filter(tc => tc.category === 'Positive').length || 0,
      negative: data.byCategory?.Negative || data.testCases?.filter(tc => tc.category === 'Negative').length || 0,
      edge: data.byCategory?.Edge || data.testCases?.filter(tc => tc.category === 'Edge').length || 0,
      regression: data.byCategory?.Regression || data.testCases?.filter(tc => tc.category === 'Regression').length || 0,
      integration: data.byCategory?.Integration || data.testCases?.filter(tc => tc.category === 'Integration').length || 0
    };

    // Enhancement badges
    let enhancementBadges = '';
    if (data.enhancements) {
      const badges = [];

      if (data.enhancements.gaps && data.enhancements.gaps.length > 0) {
        badges.push(`<div class="enhancement-badge gap">
          🔍 ${data.enhancements.gaps.length} gaps identified
        </div>`);
      }

      if (data.enhancements.scalingApplied) {
        const diff = data.enhancements.scaledCount - data.enhancements.originalCount;
        const sign = diff > 0 ? '+' : '';
        badges.push(`<div class="enhancement-badge scaling">
          📊 Complexity scaled: ${sign}${diff} tests (Score: ${data.enhancements.complexityScore}/100)
        </div>`);
      }

      if (data.enhancements.additionalTests && data.enhancements.additionalTests.length > 0) {
        badges.push(`<div class="enhancement-badge additional">
          ✨ ${data.enhancements.additionalTests.length} gap-filling tests added
        </div>`);
      }

      if (badges.length > 0) {
        enhancementBadges = `<div class="enhancement-badges">${badges.join('')}</div>`;
      }
    }

    // Historical insights badge
    let historicalBadge = '';
    if (data.historicalInsights) {
      const insights = data.historicalInsights;
      const historicalTestCount = data.testCases.filter(tc => tc.source === 'historical').length;

      if (historicalTestCount > 0 || insights.bugPatterns.length > 0) {
        historicalBadge = `
          <div class="historical-insights-section">
            <h5>🧠 Historical Insights (from ${insights.totalBugsAnalyzed} past bugs)</h5>
            <div class="historical-stats">
              ${historicalTestCount > 0 ? `<span class="hist-stat">🛡️ ${historicalTestCount} bug-prevention tests added</span>` : ''}
              ${insights.bugPatterns.length > 0 ? `<span class="hist-stat">📊 ${insights.bugPatterns.length} bug patterns identified</span>` : ''}
              ${insights.riskAreas.length > 0 ? `<span class="hist-stat">⚠️ ${insights.riskAreas.length} risk areas detected</span>` : ''}
            </div>

            ${data.historicalBugs && data.historicalBugs.length > 0 ? `
              <details class="historical-details">
                <summary>View ${data.historicalBugs.length} analyzed bugs</summary>
                <ul class="historical-bugs-list">
                  ${data.historicalBugs.slice(0, 10).map(bug => `
                    <li>
                      <a href="${bug.url}" target="_blank">${bug.key}</a>: ${bug.summary}
                      <span class="bug-date">(${new Date(bug.created).toLocaleDateString()})</span>
                    </li>
                  `).join('')}
                </ul>
              </details>
            ` : ''}
          </div>
        `;
      }
    }

    // Evolution status badge
    let evolutionBadge = '';
    if (data.evolutionPending && !data.finalEvolution) {
      evolutionBadge = `
        <div class="evolution-pending-badge">
          ⏳ Evolutionary optimization in progress... Base test cases shown below.
        </div>
      `;
    } else if (data.finalEvolution) {
      evolutionBadge = `
        <div class="evolution-complete-badge">
          ✨ Enhanced with evolutionary optimization ${data.improvement ? `(+${data.improvement} tests)` : ''}
        </div>
      `;
    }

    container.innerHTML = `
      <div class="qatalyst-result">
        <h4>✅ Generated Test Cases</h4>
        ${contextSummaryHtml}
        ${evolutionBadge}
        ${enhancementBadges}
        ${historicalBadge}
        <div class="test-stats">
          <span class="stat">Total: ${stats.total}</span>
          <span class="stat">Positive: ${stats.positive}</span>
          <span class="stat">Negative: ${stats.negative}</span>
          <span class="stat">Edge: ${stats.edge}</span>
          <span class="stat">Regression: ${stats.regression}</span>
          <span class="stat">Integration: ${stats.integration}</span>
        </div>
        <div class="result-content test-cases">
          ${formatTestCases(data.testCases)}
        </div>

        <!-- User Review Section -->
        <div class="qatalyst-review-section">
          <h5>💬 Provide Feedback (Optional)</h5>
          <p style="font-size: 12px; color: #666; margin-bottom: 8px;">
            Add your feedback below and click "Regenerate" to get improved test cases based on your input.
          </p>
          <textarea
            id="testcases-review-input"
            class="qatalyst-review-textarea"
            placeholder="Example: Add more security tests, include performance test cases, focus more on edge cases, etc."
            rows="3"
          ></textarea>
          <button class="qatalyst-btn primary" id="regenerate-testcases-btn" style="margin-top: 8px;">
            <span class="btn-icon">🔄</span>
            <span>Regenerate with Feedback</span>
          </button>
        </div>

        <div style="display: flex; gap: 8px; margin-top: 12px;">
          <button class="qatalyst-btn primary" id="add-to-jira-btn" style="flex: 1;">
            <span class="btn-icon">📝</span>
            <span>Add to Jira</span>
          </button>
          <button class="qatalyst-btn secondary" id="export-csv-btn" style="flex: 1;">
            <span class="btn-icon">📥</span>
            <span>Export to CSV</span>
          </button>
        </div>
        <div style="display: flex; gap: 8px; margin-top: 8px;">
          <button class="qatalyst-btn primary" id="export-to-test-mgmt-btn" style="flex: 1; background: linear-gradient(135deg, #10b981 0%, #059669 100%);">
            <span class="btn-icon">🚀</span>
            <span>Export to Test Management <span style="background: #3b82f6; color: white; font-size: 9px; font-weight: 600; padding: 2px 6px; border-radius: 3px; margin-left: 6px; vertical-align: middle;">BETA</span></span>
          </button>
          <button class="qatalyst-btn" id="cancel-upload-btn" style="display: none; background: #ef4444; color: white;">
            <span class="btn-icon">🛑</span>
            <span>Cancel</span>
          </button>
        </div>
      </div>
    `;

    // Add event listeners
    document.getElementById('add-to-jira-btn')?.addEventListener('click', () => {
      addTestCasesToJira(data.testCases);
    });

    document.getElementById('export-csv-btn')?.addEventListener('click', () => {
      exportTestCasesToCSV(data.testCases);
    });

    document.getElementById('export-to-test-mgmt-btn')?.addEventListener('click', async () => {
      await exportToTestManagement(data.testCases);
    });

    document.getElementById('cancel-upload-btn')?.addEventListener('click', async () => {
      const response = await chrome.runtime.sendMessage({ type: 'CANCEL_UPLOAD' });
      if (response.success) {
        const cancelBtn = document.getElementById('cancel-upload-btn');
        if (cancelBtn) {
          cancelBtn.disabled = true;
          cancelBtn.innerHTML = '<span class="btn-icon">⏳</span><span>Cancelling...</span>';
        }
      }
    });

    document.getElementById('regenerate-testcases-btn')?.addEventListener('click', async () => {
      const review = document.getElementById('testcases-review-input').value.trim();
      if (!review) {
        alert('⚠️ Please provide some feedback before regenerating.');
        return;
      }
      await handleRegenerateTestCases(review);
    });
  }
  
  function renderContextSummaryBox(externalSources, appContext = null) {
    const jiraStatus = '✅ Yes'; // Jira is always the primary context
    const confluenceStatus = externalSources.confluence > 0 ? '✅ Yes' : '❌ No';
    const figmaStatus = externalSources.figma > 0 ? '✅ Yes' : '❌ No';
    const googleDocsStatus = externalSources.googleDocs > 0 ? '✅ Yes' : '❌ No';

    // Check if crawled data is available (filtered by keywords)
    const knowledgeGraphStatus = (appContext && (appContext.knowledgeGraph || appContext.hasCrawledData)) ? '✅ Yes' : '❌ No';

    // Build details for knowledge graph tooltip
    let kgDetails = '';
    if (appContext && appContext.knowledgeGraph) {
      const pages = Object.keys(appContext.knowledgeGraph.pages || {}).length;
      const forms = appContext.knowledgeGraph.forms?.length || 0;
      const apis = appContext.knowledgeGraph.apis?.length || 0;
      kgDetails = `${pages} pages, ${forms} forms, ${apis} APIs`;
    }

    return `
      <div class="context-summary-box">
        <div class="context-summary-item">
          <span class="status-icon">jira:</span>
          <span class="status-text">${jiraStatus}</span>
        </div>
        <div class="context-summary-item">
          <span class="status-icon">confluence:</span>
          <span class="status-text">${confluenceStatus}</span>
        </div>
        <div class="context-summary-item">
          <span class="status-icon">figma:</span>
          <span class="status-text">${figmaStatus}</span>
        </div>
        <div class="context-summary-item">
          <span class="status-icon">google doc:</span>
          <span class="status-text">${googleDocsStatus}</span>
        </div>
        <div class="context-summary-item" ${appContext ? `title="${kgDetails}"` : ''}>
          <span class="status-icon">🕷️ crawled app:</span>
          <span class="status-text">${knowledgeGraphStatus}</span>
        </div>
      </div>
    `;
  }
  
  // Format functions
  function formatAnalysis(analysis) {
    return `<pre>${analysis}</pre>`;
  }
  
  function formatTestScope(scope) {
    if (!scope || scope === 'undefined' || scope === 'null') {
      return '<p class="qatalyst-warning">⚠️ No test scope was generated. Please try again.</p>';
    }
    return `<pre>${scope}</pre>`;
  }
  
  function formatTestCases(testCases) {
    return testCases.map((tc, idx) => {
      // Handle both camelCase and snake_case property names
      const expectedResult = tc.expected_result || tc.expectedResult || 'Not specified';
      const description = tc.description || 'Not specified';

      // Add historical badge
      const sourceBadge = tc.source === 'historical'
        ? `<span class="source-badge historical">🛡️ Bug Prevention</span>`
        : '';

      const historicalInfo = tc.historicalReference
        ? `<div class="historical-ref">📚 Based on: <a href="${window.location.origin}/browse/${tc.historicalReference}" target="_blank">${tc.historicalReference}</a></div>`
        : '';

      return `
      <div class="test-case ${tc.source === 'historical' ? 'historical-test' : ''}" data-testid="test-case-${idx}">
        <div class="tc-header">
          <span class="tc-id">${tc.id}</span>
          <span class="tc-priority ${tc.priority}">${tc.priority}</span>
          <span class="tc-category">${tc.category}</span>
          ${sourceBadge}
        </div>
        <div class="tc-title">${tc.title}</div>
        ${tc.preventionReason ? `<div class="prevention-reason">🛡️ ${tc.preventionReason}</div>` : ''}
        ${historicalInfo}
        <div class="tc-description">
          <strong>Description:</strong> ${description}
        </div>
        <div class="tc-expected">
          <strong>Expected Result:</strong> ${expectedResult}
        </div>
      </div>
    `;
    }).join('');
  }
  
  function exportTestCasesToCSV(testCases) {
    try {
      // Define CSV headers
      const headers = ['ID', 'Title', 'Category', 'Priority', 'Description', 'Expected Result'];
      
      // Convert test cases to CSV rows
      const rows = testCases.map(tc => {
        const id = tc.id || '';
        const title = (tc.title || '').replace(/"/g, '""'); // Escape quotes
        const category = tc.category || '';
        const priority = tc.priority || '';
        const description = (tc.description || '').replace(/"/g, '""'); // Escape quotes
        const expectedResult = (tc.expected_result || tc.expectedResult || '').replace(/"/g, '""'); // Escape quotes
        
        // Wrap fields in quotes to handle commas and newlines
        return [
          `"${id}"`,
          `"${title}"`,
          `"${category}"`,
          `"${priority}"`,
          `"${description}"`,
          `"${expectedResult}"`
        ].join(',');
      });
      
      // Combine headers and rows
      const csvContent = [headers.join(','), ...rows].join('\n');
      
      // Create blob and download
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      
      // Generate filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const ticketKey = extractTicketKey() || 'test-cases';
      const filename = `${ticketKey}_test_cases_${timestamp}.csv`;
      
      link.setAttribute('href', url);
      link.setAttribute('download', filename);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      // Show success message
      const btn = document.getElementById('export-csv-btn');
      if (btn) {
        const originalHTML = btn.innerHTML;
        btn.innerHTML = '<span class="btn-icon">✅</span><span>Exported!</span>';
        btn.disabled = true;
        setTimeout(() => {
          btn.innerHTML = originalHTML;
          btn.disabled = false;
        }, 2000);
      }
      
      console.log(`✅ Exported ${testCases.length} test cases to ${filename}`);
    } catch (error) {
      console.error('❌ Error exporting to CSV:', error);
      alert('Failed to export test cases to CSV. Please try again.');
    }
  }

  function handleUploadProgress(progress) {
    const btn = document.getElementById('export-to-test-mgmt-btn');
    if (!btn) return;

    const { current, total, phase } = progress;

    if (phase === 'initializing') {
      btn.innerHTML = '<span class="btn-icon">🔄</span><span>Initializing...</span>';
    } else if (phase === 'checking-duplicates') {
      btn.innerHTML = '<span class="btn-icon">🔍</span><span>Checking duplicates...</span>';
    } else if (phase === 'bulk-uploading') {
      btn.innerHTML = '<span class="btn-icon">🚀</span><span>Bulk uploading...</span>';
    } else if (phase === 'uploading') {
      const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
      btn.innerHTML = `<span class="btn-icon">📤</span><span>Uploading ${current}/${total} (${percentage}%)</span>`;
    } else if (phase === 'completed') {
      btn.innerHTML = '<span class="btn-icon">✅</span><span>Completed!</span>';
    } else if (phase === 'cancelled') {
      btn.innerHTML = '<span class="btn-icon">🛑</span><span>Cancelled</span>';
    } else if (phase === 'rate-limited') {
      btn.innerHTML = '<span class="btn-icon">⚠️</span><span>Rate Limited</span>';
    }
  }

  async function exportToTestManagement(testCases) {
    const btn = document.getElementById('export-to-test-mgmt-btn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="btn-icon">⏳</span><span>Exporting...</span>';
    }

    // Show cancel button
    const cancelBtn = document.getElementById('cancel-upload-btn');
    if (cancelBtn) {
      cancelBtn.style.display = 'inline-block';
    }

    try {
      // Get Jira ticket key
      const ticketKey = extractTicketKey();

      // Send message to background script to handle the export
      const response = await chrome.runtime.sendMessage({
        type: 'EXPORT_TO_TEST_MANAGEMENT',
        testCases: testCases,
        jiraTicket: ticketKey
      });

      // Hide cancel button
      if (cancelBtn) {
        cancelBtn.style.display = 'none';
        cancelBtn.disabled = false;
        cancelBtn.innerHTML = '<span class="btn-icon">🛑</span><span>Cancel</span>';
      }

      if (response.success) {
        // Show success feedback
        if (btn) {
          btn.innerHTML = '<span class="btn-icon">✅</span><span>Exported!</span>';
          setTimeout(() => {
            btn.innerHTML = '<span class="btn-icon">🚀</span><span>Export to Test Management <span style="background: #3b82f6; color: white; font-size: 9px; font-weight: 600; padding: 2px 6px; border-radius: 3px; margin-left: 6px; vertical-align: middle;">BETA</span></span>';
            btn.disabled = false;
          }, 3000);
        }

        // Show detailed results
        const successCount = response.results.success.length;
        const failedCount = response.results.failed.length;
        const skippedCount = response.results.skipped ? response.results.skipped.length : 0;
        const platform = response.platform;

        let message = `Successfully exported ${successCount} test case(s) to ${platform}`;

        if (skippedCount > 0) {
          message += `\n${skippedCount} duplicate(s) skipped (already exist in ${platform})`;
        }

        if (failedCount > 0) {
          message += `\n\nFailed to export ${failedCount} test case(s):`;
          response.results.failed.forEach(fail => {
            message += `\n- ${fail.title}: ${fail.error}`;
          });
        }

        if (skippedCount > 0) {
          message += '\n\nSkipped duplicates:';
          response.results.skipped.forEach(skip => {
            message += `\n- ${skip.title} (already exists: ${skip.existingId})`;
          });
        }

        if (successCount > 0) {
          message += '\n\nSuccessfully exported:';
          response.results.success.forEach(success => {
            message += `\n- ${success.title} (${success.id})`;
          });
        }

        alert(message);
        console.log('✅ Export results:', response.results);
      } else {
        throw new Error(response.error || 'Export failed');
      }
    } catch (error) {
      console.error('❌ Error exporting to test management:', error);

      // Hide cancel button
      const cancelBtn = document.getElementById('cancel-upload-btn');
      if (cancelBtn) {
        cancelBtn.style.display = 'none';
        cancelBtn.disabled = false;
        cancelBtn.innerHTML = '<span class="btn-icon">🛑</span><span>Cancel</span>';
      }

      // Show error feedback
      if (btn) {
        btn.innerHTML = '<span class="btn-icon">❌</span><span>Export Failed</span>';
        setTimeout(() => {
          btn.innerHTML = '<span class="btn-icon">🚀</span><span>Export to Test Management <span style="background: #3b82f6; color: white; font-size: 9px; font-weight: 600; padding: 2px 6px; border-radius: 3px; margin-left: 6px; vertical-align: middle;">BETA</span></span>';
          btn.disabled = false;
        }, 3000);
      }

      alert(`Failed to export to test management: ${error.message}\n\nPlease check your Test Management settings in the extension options.`);
    }
  }

  async function addAnalysisToJira(analysis) {
    const btn = document.getElementById('add-analysis-to-jira-btn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="btn-icon">⏳</span><span>Posting to Jira...</span>';
    }

    try {
      const baseUrl = window.location.origin;
      const ticketKey = extractTicketKey();

      // Format analysis for Jira comment
      const formattedComment = formatAnalysisForJiraComment(analysis);

      const response = await fetch(`${baseUrl}/rest/api/2/issue/${ticketKey}/comment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({
          body: formattedComment
        })
      });

      if (response.ok) {
        if (btn) {
          btn.innerHTML = '<span class="btn-icon">✅</span><span>Posted to Jira!</span>';
          setTimeout(() => {
            btn.disabled = false;
            btn.innerHTML = '<span class="btn-icon">📝</span><span>Add to Jira</span>';
          }, 3000);
        }

        showNotification('✅ Requirements analysis successfully posted to Jira comments!', 'success');

        setTimeout(() => {
          window.location.reload();
        }, 2000);
      } else {
        throw new Error(`Failed to post comment: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.error('Failed to post to Jira:', error);

      try {
        await navigator.clipboard.writeText(analysis);
        showNotification('⚠️ Could not post directly to Jira. Requirements analysis copied to clipboard - please paste manually.', 'warning');
      } catch (clipboardError) {
        showNotification('❌ Failed to post to Jira and copy to clipboard. Please try again.', 'error');
      }

      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span class="btn-icon">📝</span><span>Add to Jira</span>';
      }
    }
  }

  async function addTestScopeToJira(testScope) {
    const btn = document.getElementById('add-scope-to-jira-btn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="btn-icon">⏳</span><span>Posting to Jira...</span>';
    }

    try {
      const baseUrl = window.location.origin;
      const ticketKey = extractTicketKey();

      // Format test scope for Jira comment
      const formattedComment = formatTestScopeForJiraComment(testScope);

      const response = await fetch(`${baseUrl}/rest/api/2/issue/${ticketKey}/comment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({
          body: formattedComment
        })
      });

      if (response.ok) {
        if (btn) {
          btn.innerHTML = '<span class="btn-icon">✅</span><span>Posted to Jira!</span>';
          setTimeout(() => {
            btn.disabled = false;
            btn.innerHTML = '<span class="btn-icon">📝</span><span>Add to Jira</span>';
          }, 3000);
        }

        showNotification('✅ Test scope successfully posted to Jira comments!', 'success');

        setTimeout(() => {
          window.location.reload();
        }, 2000);
      } else {
        throw new Error(`Failed to post comment: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.error('Failed to post to Jira:', error);

      try {
        await navigator.clipboard.writeText(testScope);
        showNotification('⚠️ Could not post directly to Jira. Test scope copied to clipboard - please paste manually.', 'warning');
      } catch (clipboardError) {
        showNotification('❌ Failed to post to Jira and copy to clipboard. Please try again.', 'error');
      }

      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span class="btn-icon">📝</span><span>Add to Jira</span>';
      }
    }
  }

  async function addTestCasesToJira(testCases) {
    const btn = document.getElementById('add-to-jira-btn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="btn-icon">⏳</span><span>Posting to Jira...</span>';
    }

    try {
      // Get Jira site URL from current page
      const baseUrl = window.location.origin;
      const ticketKey = extractTicketKey();

      // Format test cases for Jira comment (using Jira markdown)
      const formattedComment = formatTestCasesForJiraComment(testCases);

      // Try to post comment using Jira REST API
      const response = await fetch(`${baseUrl}/rest/api/2/issue/${ticketKey}/comment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        credentials: 'include', // Include cookies for authentication
        body: JSON.stringify({
          body: formattedComment
        })
      });

      if (response.ok) {
        if (btn) {
          btn.innerHTML = '<span class="btn-icon">✅</span><span>Posted to Jira!</span>';
          setTimeout(() => {
            btn.disabled = false;
            btn.innerHTML = '<span class="btn-icon">📝</span><span>Add to Jira</span>';
          }, 3000);
        }

        // Show success notification
        showNotification('✅ Test cases successfully posted to Jira comments!', 'success');

        // Reload comments section to show new comment
        setTimeout(() => {
          window.location.reload();
        }, 2000);
      } else {
        throw new Error(`Failed to post comment: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.error('Failed to post to Jira:', error);

      // Fallback to copy to clipboard
      const formatted = formatTestCasesForClipboard(testCases);
      try {
        await navigator.clipboard.writeText(formatted);
        showNotification('⚠️ Could not post directly to Jira. Test cases copied to clipboard - please paste manually.', 'warning');
      } catch (clipboardError) {
        showNotification('❌ Failed to post to Jira and copy to clipboard. Please try again.', 'error');
      }

      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span class="btn-icon">📝</span><span>Add to Jira</span>';
      }
    }
  }

  function formatAnalysisForJiraComment(analysis) {
    const header = `h2. 📊 QAtalyst Requirements Analysis
_Generated on ${new Date().toLocaleString()}_

----

`;

    // Convert markdown-style formatting to Jira wiki markup
    let jiraFormatted = analysis
      .replace(/^### (.*$)/gm, 'h3. $1') // h3 headers
      .replace(/^## (.*$)/gm, 'h2. $1')  // h2 headers
      .replace(/^# (.*$)/gm, 'h1. $1')   // h1 headers
      .replace(/\*\*(.*?)\*\*/g, '*$1*') // bold
      .replace(/^\* /gm, '* ')           // bullet lists
      .replace(/^- /gm, '* ');           // convert - to *

    return header + jiraFormatted;
  }

  function formatTestScopeForJiraComment(testScope) {
    const header = `h2. 📋 QAtalyst Test Scope Document
_Generated on ${new Date().toLocaleString()}_

----

`;

    // Convert markdown-style formatting to Jira wiki markup
    let jiraFormatted = testScope
      .replace(/^### (.*$)/gm, 'h3. $1') // h3 headers
      .replace(/^## (.*$)/gm, 'h2. $1')  // h2 headers
      .replace(/^# (.*$)/gm, 'h1. $1')   // h1 headers
      .replace(/\*\*(.*?)\*\*/g, '*$1*') // bold
      .replace(/^\* /gm, '* ')           // bullet lists
      .replace(/^- /gm, '* ');           // convert - to *

    return header + jiraFormatted;
  }

  function formatTestCasesForJiraComment(testCases) {
    const header = `h2. 🤖 QAtalyst Generated Test Cases (${testCases.length} tests)
_Generated on ${new Date().toLocaleString()}_

----

`;

    const testCaseBlocks = testCases.map((tc, idx) => {
      const expectedResult = tc.expected_result || tc.expectedResult || 'Not specified';
      const steps = tc.steps || [];
      const preconditions = tc.preconditions || tc.precondition || 'None';
      const testData = tc.testData || tc.test_data || 'Not specified';

      const stepsFormatted = steps.length > 0
        ? steps.map((step, i) => `# ${step}`).join('\n')
        : 'Not specified';

      return `h3. ${tc.id}: ${tc.title}
*Priority:* {color:${getPriorityColor(tc.priority)}}${tc.priority}{color} | *Category:* {color:${getCategoryColor(tc.category)}}${tc.category}{color}

*Preconditions:*
${preconditions}

*Test Steps:*
${stepsFormatted}

*Expected Result:*
${expectedResult}

*Test Data:*
${testData}

----
`;
    }).join('\n');

    return header + testCaseBlocks;
  }

  function formatTestCasesForClipboard(testCases) {
    return testCases.map(tc => {
      const expectedResult = tc.expected_result || tc.expectedResult || 'Not specified';
      return `**${tc.id}: ${tc.title}**
Priority: ${tc.priority} | Type: ${tc.category}
Expected Result: ${expectedResult}`;
    }).join('\n---\n');
  }

  function getPriorityColor(priority) {
    const colors = {
      'P0': '#d32f2f',
      'P1': '#f57c00',
      'P2': '#fbc02d',
      'P3': '#1976d2'
    };
    return colors[priority] || '#666';
  }

  function getCategoryColor(category) {
    const colors = {
      'Positive': '#388e3c',
      'Negative': '#d32f2f',
      'Edge': '#f57c00',
      'Regression': '#7b1fa2',
      'Integration': '#1976d2'
    };
    return colors[category] || '#666';
  }

  function showNotification(message, type = 'success') {
    const container = document.getElementById('results-container');
    if (!container) return;

    const notification = document.createElement('div');
    notification.className = type === 'success' ? 'qatalyst-success' :
                           type === 'warning' ? 'qatalyst-warning' :
                           'qatalyst-error';
    notification.style.position = 'fixed';
    notification.style.top = '20px';
    notification.style.right = '460px';
    notification.style.zIndex = '1000000';
    notification.style.maxWidth = '400px';
    notification.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
    notification.innerHTML = message;

    document.body.appendChild(notification);

    setTimeout(() => {
      notification.remove();
    }, 5000);
  }
  
  // Regeneration handlers for user review feature
  async function handleRegenerateAnalysis(userReview) {
    const resultsContainer = document.getElementById('results-container');
    const btn = document.getElementById('regenerate-analysis-btn');
    if (btn) btn.disabled = true;

    try {
      const settings = await loadAndDecryptSettings(['llmProvider', 'llmModel', 'apiKey']);

      // Check if AI provider is configured
      if (!settings.llmProvider) {
        throw new Error('Please select an AI provider in the extension settings first');
      }

      if (!settings.apiKey) {
        throw new Error('Please add your API key in the extension settings first');
      }

      resultsContainer.innerHTML = '<div class="qatalyst-loading">🔄 Regenerating analysis based on your feedback...</div>';

      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'regenerateWithReview',
          data: {
            type: 'analysis',
            originalContent: currentAnalysisData.analysis,
            userReview: userReview,
            settings
          }
        }, response => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!response) {
            reject(new Error('No response received from extension'));
          } else if (response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response);
          }
        });
      });

      // Update current data and display
      currentAnalysisData.analysis = response.improvedContent;
      displayAnalysisResults(currentAnalysisData);

    } catch (error) {
      resultsContainer.innerHTML = `<div class="qatalyst-error">❌ ${error.message.replace(/\\n/g, '<br>')}</div>`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function handleRegenerateTestScope(userReview) {
    const resultsContainer = document.getElementById('results-container');
    const btn = document.getElementById('regenerate-scope-btn');
    if (btn) btn.disabled = true;

    try {
      const settings = await loadAndDecryptSettings(['llmProvider', 'llmModel', 'apiKey']);

      // Check if AI provider is configured
      if (!settings.llmProvider) {
        throw new Error('Please select an AI provider in the extension settings first');
      }

      if (!settings.apiKey) {
        throw new Error('Please add your API key in the extension settings first');
      }

      resultsContainer.innerHTML = '<div class="qatalyst-loading">🔄 Regenerating test scope based on your feedback...</div>';

      const scopeContent = currentTestScopeData.scope || currentTestScopeData.testScope;

      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'regenerateWithReview',
          data: {
            type: 'testScope',
            originalContent: scopeContent,
            userReview: userReview,
            settings
          }
        }, response => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!response) {
            reject(new Error('No response received from extension'));
          } else if (response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response);
          }
        });
      });

      // Update current data and display
      currentTestScopeData.scope = response.improvedContent;
      displayTestScopeResults(currentTestScopeData);

    } catch (error) {
      resultsContainer.innerHTML = `<div class="qatalyst-error">❌ ${error.message.replace(/\\n/g, '<br>')}</div>`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function handleRegenerateTestCases(userReview) {
    const resultsContainer = document.getElementById('results-container');
    const btn = document.getElementById('regenerate-testcases-btn');
    if (btn) btn.disabled = true;

    try {
      const settings = await loadAndDecryptSettings(['llmProvider', 'llmModel', 'apiKey', 'testCount']);

      // Check if AI provider is configured
      if (!settings.llmProvider) {
        throw new Error('Please select an AI provider in the extension settings first');
      }

      if (!settings.apiKey) {
        throw new Error('Please add your API key in the extension settings first');
      }

      resultsContainer.innerHTML = '<div class="qatalyst-loading">🔄 Regenerating test cases based on your feedback...</div>';

      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'regenerateWithReview',
          data: {
            type: 'testCases',
            originalContent: JSON.stringify(currentTestCasesData.testCases),
            userReview: userReview,
            settings
          }
        }, response => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!response) {
            reject(new Error('No response received from extension'));
          } else if (response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response);
          }
        });
      });

      // Update current data and display
      currentTestCasesData.testCases = response.improvedTestCases;
      displayTestCasesResults(currentTestCasesData);

    } catch (error) {
      resultsContainer.innerHTML = `<div class="qatalyst-error">❌ ${error.message.replace(/\\n/g, '<br>')}</div>`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function showHelp() {
    const helpContent = `
╔══════════════════════════════════════════╗
║        🚀 QAtalyst v11.2.1 - Help        ║
╚══════════════════════════════════════════╝

📋 CORE FEATURES:

1️⃣  Analyse Requirements
   • AI-powered extraction of requirements from Jira tickets
   • Enriched with Confluence, Figma, and Google Docs
   • Structured analysis ready for test planning

2️⃣  Generate Test Scope
   • Comprehensive test planning document
   • Test objectives, in-scope/out-scope items
   • Risk assessment and success criteria

3️⃣  Generate Test Cases
   • Multi-agent AI system generates 20-30 test cases
   • Distributed across categories: Positive, Negative, Edge, Regression, Integration
   • Includes preconditions, steps, expected results, test data

🎯 ADVANCED FEATURES:

🧬 Multi-Agent System (Settings → Enable Multi-Agent)
   • Specialized AI agents for each test category
   • Review agent validates test quality
   • Parallel generation for faster results

🔬 Evolutionary Optimization (Settings → Enable Evolution)
   • Genetic algorithm improves test coverage
   • Intensity levels: Light, Balanced, Intensive, Exhaustive
   • Adds optimized tests through mutation & crossover

🎯 Enhanced Features (Settings → Enable Enhanced)
   • Gap Analysis: Identifies missing test scenarios
   • Complexity Scaling: Adjusts test count based on ticket complexity
   • Context-Aware Generation: Uses ticket patterns

💬 USER REVIEW & FEEDBACK:
   • Provide feedback after generation
   • Click "Regenerate with Feedback" to improve results
   • AI incorporates your suggestions

📝 ADD TO JIRA:
   • Direct posting to Jira comments via REST API
   • Rich formatting with color-coded priorities
   • Automatic fallback to clipboard if needed
   • Works for Requirements, Test Scope, and Test Cases

⚙️ SETTINGS:

LLM Provider Options:
   • OpenAI (GPT-4o, GPT-4o-mini)
   • Google Gemini (2.0 Flash, 1.5 Pro)
   • Anthropic Claude (Sonnet, Opus)

External Integrations:
   • Confluence API for linked pages
   • Figma API for design specs
   • Google Docs API for requirement docs

🎨 CUSTOMIZATION:

Test Distribution:
   • Adjust percentage for each category
   • Set total test count (10-100)

Evolution Intensity:
   • Light: 2 generations, quick results
   • Balanced: 3 generations, good quality
   • Intensive: 5 generations, thorough
   • Exhaustive: 7 generations, maximum coverage

Agent Selection:
   • Enable/disable individual agents
   • Customize test generation strategy

📊 PROGRESS TRACKING:
   • Real-time agent progress indicators
   • Evolution generation tracking
   • Enhancement analysis status
   • Visual progress bars

✨ TIPS:
   • Start with "Analyse Requirements" for best results
   • Use feedback feature to refine outputs
   • Enable evolution for comprehensive coverage
   • Configure external integrations for enriched context

🔧 TROUBLESHOOTING:
   • Ensure API key is configured in Settings
   • Check Jira permissions for posting comments
   • Use clipboard fallback if direct posting fails
   • See browser console for detailed errors

    `.trim();

    // Create modal for better formatting
    const modal = document.createElement('div');
    modal.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: white;
      padding: 30px;
      border-radius: 12px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      z-index: 10000000;
      max-width: 700px;
      max-height: 80vh;
      overflow-y: auto;
      font-family: 'Courier New', monospace;
      font-size: 12px;
      line-height: 1.6;
      white-space: pre-wrap;
    `;

    modal.innerHTML = `
      <div style="position: relative;">
        <button id="close-help-modal" style="
          position: absolute;
          top: -10px;
          right: -10px;
          background: #ef4444;
          color: white;
          border: none;
          width: 30px;
          height: 30px;
          border-radius: 50%;
          cursor: pointer;
          font-size: 18px;
          font-weight: bold;
        ">×</button>
        <pre style="margin: 0; font-family: 'Courier New', monospace; font-size: 12px;">${helpContent}</pre>
      </div>
    `;

    document.body.appendChild(modal);

    // Add backdrop
    const backdrop = document.createElement('div');
    backdrop.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.5);
      z-index: 9999999;
    `;
    document.body.appendChild(backdrop);

    // Close handlers
    const closeModal = () => {
      modal.remove();
      backdrop.remove();
    };

    document.getElementById('close-help-modal').addEventListener('click', closeModal);
    backdrop.addEventListener('click', closeModal);
  }

  // Handle evolution completion
  function handleEvolutionComplete(data) {
    console.log('Evolution complete, updating UI with evolved tests');

    if (!currentTestCasesData) {
      console.warn('No current test cases data to update');
      return;
    }

    // Update current data with evolved results
    currentTestCasesData.testCases = data.testCases;
    currentTestCasesData.total = data.statistics.total;
    currentTestCasesData.byCategory = data.statistics.byCategory;
    currentTestCasesData.byPriority = data.statistics.byPriority;
    currentTestCasesData.evolved = true;
    currentTestCasesData.finalEvolution = true;
    currentTestCasesData.improvement = data.improvement;

    // Re-display results with evolved tests
    displayTestCasesResults(currentTestCasesData);

    // Show success notification
    const container = document.getElementById('results-container');
    if (container) {
      const notification = document.createElement('div');
      notification.className = 'qatalyst-success';
      notification.style.marginBottom = '16px';
      notification.innerHTML = `
        ✅ <strong>Evolutionary Optimization Complete!</strong><br>
        ${data.improvement > 0 ? `Added ${data.improvement} optimized tests through genetic algorithm.` : 'Test suite optimized for better coverage.'}
      `;

      container.insertBefore(notification, container.firstChild);

      // Auto-remove after 5 seconds
      setTimeout(() => notification.remove(), 5000);
    }
  }

  // Handle evolution error
  function handleEvolutionError(error) {
    console.error('Evolution error:', error);

    const container = document.getElementById('results-container');
    if (!container) return;

    // Replace evolution progress with error message
    const existing = container.querySelector('.evolution-progress-container');
    if (existing) {
      const notification = document.createElement('div');
      notification.className = 'qatalyst-warning';
      notification.innerHTML = `
        ⚠️ <strong>Evolution Optimization Failed</strong><br>
        ${error}<br>
        <small>Base test cases are still available and valid.</small>
      `;
      existing.replaceWith(notification);
    }
  }

  // Initialize
  if (window.location.pathname.includes('/browse/')) {
    injectPanel();
  }
  
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
   * Extract app context from crawled knowledge graphs
   * This enriches test case generation with real implementation details
   */
  async function extractAppContext(ticketData) {
    try {
      console.log('🔍 [CRAWL DATA] Checking for crawled app context...');

      // Get all crawled apps from background script (which has access to extension's IndexedDB)
      console.log('[CRAWL DATA] 📡 Requesting app list from background script...');
      const response = await chrome.runtime.sendMessage({
        action: 'getAllApps'
      });

      if (!response || !response.success || !response.apps || response.apps.length === 0) {
        console.log('⚠️ [CRAWL DATA] No crawled apps found in database');
        console.log('   💡 Use the popup or settings page to crawl your application first');
        return null;
      }

      console.log(`📚 [CRAWL DATA] Found ${response.apps.length} crawled app(s):`);
      response.apps.forEach((app, i) => {
        console.log(`   ${i + 1}. ${app.url} - ${app.pages} pages, ${app.features} features`);
      });

      // ALWAYS use crawled data if available (intelligent matching with fallback)
      const matchedApp = findMatchingApp(response.apps, ticketData);

      if (!matchedApp) {
        console.error('❌ [CRAWL DATA] ERROR: findMatchingApp returned null despite apps existing!');
        console.error('   This should never happen. Please report this bug.');
        return null;
      }

      console.log(`✅ Matched crawled app: ${matchedApp.url}`);

      // Load the knowledge graph from background script
      // Pass ticketData for smart keyword-based filtering
      console.log('[CRAWL DATA] 📡 Requesting knowledge graph with ticket context...');

      const kgResponse = await chrome.runtime.sendMessage({
        action: 'loadEmbeddings',
        data: {
          appUrl: matchedApp.url,
          ticketData: ticketData // Pass ticket for smart filtering
        }
      });

      if (!kgResponse || !kgResponse.success) {
        console.error('❌ [CRAWL DATA] Failed to load knowledge graph');
        console.error('   Response:', kgResponse);
        return null;
      }

      // Receive knowledge graph from background (will be analyzed by ContextAnalysisAgent in orchestrator)
      const knowledgeGraph = kgResponse.result.knowledgeGraph;
      const hasContext = kgResponse.result.hasContext;

      console.log('[CRAWL DATA] 📨 Received knowledge graph from background');

      if (hasContext) {
        console.log(`✅ [CRAWL DATA] Knowledge graph available`);
        console.log(`   App URL: ${kgResponse.result.appUrl}`);
        console.log(`   Pages: ${kgResponse.result.transferPageCount} / ${kgResponse.result.pageCount}`);
        console.log(`   Graph pages: ${Object.keys(knowledgeGraph.pages || {}).length}`);
      } else {
        console.log('ℹ️ [CRAWL DATA] No knowledge graph available');
      }

      // Create app context with raw knowledge graph
      // ContextAnalysisAgent will analyze this in the orchestrator (Agent 1/8)
      const context = {
        appUrl: kgResponse.result.appUrl,
        knowledgeGraph: knowledgeGraph,
        hasContext: hasContext,
        crawledAt: kgResponse.result.crawledAt,
        pageCount: kgResponse.result.pageCount,
        transferPageCount: kgResponse.result.transferPageCount
      };

      console.log('✅ [CRAWL DATA] App context prepared successfully:');
      console.log('   Context available:', hasContext);
      console.log('   Pages:', context.pageCount || 0);
      return context;

    } catch (error) {
      console.error('❌ Error extracting app context:', error);
      return null;
    }
  }

  /**
   * Find matching crawled app based on ticket content
   */
  function findMatchingApp(apps, ticketData) {
    // Strategy 1: Look for URLs in ticket description
    const ticketText = `${ticketData.summary} ${ticketData.description}`.toLowerCase();

    for (const app of apps) {
      try {
        // Skip merged graphs for URL matching (they don't have real URLs)
        if (app.url.startsWith('merged_')) {
          continue;
        }

        const appDomain = new URL(app.url).hostname.toLowerCase();

        // Check if exact domain is mentioned in ticket
        if (ticketText.includes(appDomain)) {
          console.log(`✅ Matched app by exact domain: ${appDomain}`);
          return app;
        }

        // Extract base domain (e.g., "mindtickle.com" from "jellyvission.integration.mindtickle.com")
        const domainParts = appDomain.split('.');
        let baseDomain = appDomain;

        // Handle cases like: subdomain.staging.example.com → example.com
        if (domainParts.length >= 2) {
          // Get last 2 parts (example.com)
          baseDomain = domainParts.slice(-2).join('.');

          // Check if base domain is mentioned (environment-agnostic)
          if (ticketText.includes(baseDomain)) {
            console.log(`✅ Matched app by base domain: ${baseDomain} (from ${appDomain})`);
            return app;
          }
        }

        // Extract product name from base domain (e.g., "mindtickle" from "mindtickle.com")
        const productName = domainParts[domainParts.length - 2];
        if (productName && productName.length > 3 && ticketText.includes(productName)) {
          console.log(`✅ Matched app by product name: ${productName}`);
          return app;
        }

        // Check first subdomain only if it's meaningful (not env names)
        const firstPart = domainParts[0];
        const envKeywords = ['staging', 'prod', 'dev', 'test', 'qa', 'integration', 'uat', 'demo', 'sandbox'];
        if (firstPart.length > 3 && !envKeywords.includes(firstPart) && ticketText.includes(firstPart)) {
          console.log(`✅ Matched app by subdomain: ${firstPart}`);
          return app;
        }
      } catch (e) {
        continue;
      }
    }

    // Strategy 2: ALWAYS use crawled data when feature is enabled
    // Prioritize based on data quality, not URL matching

    // If only one app exists, use it
    if (apps.length === 1) {
      console.log(`📌 Auto-using crawled app: ${apps[0].url} (${apps[0].pages} pages, ${apps[0].features} features)`);
      return apps[0];
    }

    // Strategy 3: Prefer merged graphs (most comprehensive across environments)
    const mergedApps = apps.filter(app => app.url.startsWith('merged_'));
    if (mergedApps.length === 1) {
      console.log(`📌 Auto-using merged graph: ${mergedApps[0].url} (${mergedApps[0].pages} pages, ${mergedApps[0].features} features)`);
      return mergedApps[0];
    }

    // Strategy 4: Use the largest merged app (most comprehensive)
    if (mergedApps.length > 1) {
      const largestMerged = mergedApps.reduce((prev, current) =>
        (current.pages > prev.pages) ? current : prev
      );
      console.log(`📌 Auto-using largest merged graph: ${largestMerged.url} (${largestMerged.pages} pages, ${largestMerged.features} features)`);
      return largestMerged;
    }

    // Strategy 5: Use the largest app by page count (most data = best context)
    const largestApp = apps.reduce((prev, current) =>
      (current.pages > prev.pages) ? current : prev
    );
    console.log(`📌 Auto-using largest crawled app: ${largestApp.url} (${largestApp.pages} pages, ${largestApp.features} features)`);
    return largestApp;
  }

  /**
   * Extract keywords from ticket for intelligent filtering
   */
  function extractTicketKeywords(ticketData) {
    const text = `${ticketData.summary || ''} ${ticketData.description || ''}`.toLowerCase();

    // Remove common words
    const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'been', 'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'what', 'which', 'who', 'when', 'where', 'why', 'how', 'error', 'issue', 'bug', 'problem', 'fix', 'update', 'add', 'remove', 'while', 'after', 'before'];

    // Extract words (3+ chars, not stop words)
    const words = text.match(/\b[a-z]{3,}\b/g) || [];
    const keywords = [...new Set(words.filter(w => !stopWords.includes(w)))];

    // Also extract quoted phrases and brackets
    const phrases = text.match(/\[([^\]]+)\]/g) || [];
    const quotedPhrases = text.match(/"([^"]+)"/g) || [];

    const allKeywords = [
      ...keywords,
      ...phrases.map(p => p.replace(/[\[\]]/g, '').toLowerCase()),
      ...quotedPhrases.map(p => p.replace(/"/g, '').toLowerCase())
    ];

    return [...new Set(allKeywords)];
  }

  /**
   * Calculate relevance score for a page/URL based on keywords
   */
  function calculateRelevanceScore(url, title, description, keywords) {
    let score = 0;
    const searchText = `${url} ${title || ''} ${description || ''}`.toLowerCase();

    keywords.forEach(keyword => {
      if (searchText.includes(keyword)) {
        // URL matches are most important
        if (url.toLowerCase().includes(keyword)) {
          score += 10;
        }
        // Title matches are very important
        if (title && title.toLowerCase().includes(keyword)) {
          score += 5;
        }
        // Description matches are somewhat important
        if (description && description.toLowerCase().includes(keyword)) {
          score += 2;
        }
      }
    });

    return score;
  }

  /**
   * Extract relevant context from knowledge graph (SMART FILTERING)
   */
  function extractRelevantContext(kgData, ticketData) {
    console.log('[EXTRACT] Starting smart context extraction...');
    console.log('[EXTRACT] kgData keys:', Object.keys(kgData));

    // Handle different response formats
    let knowledgeGraph;

    if (kgData.result && kgData.result.knowledgeGraph) {
      knowledgeGraph = kgData.result.knowledgeGraph;
      console.log('[EXTRACT] Using kgData.result.knowledgeGraph');
    } else if (kgData.knowledgeGraph) {
      knowledgeGraph = kgData.knowledgeGraph;
      console.log('[EXTRACT] Using kgData.knowledgeGraph');
    } else if (kgData.result) {
      knowledgeGraph = kgData.result;
      console.log('[EXTRACT] Using kgData.result as knowledgeGraph');
    } else {
      console.error('[EXTRACT] ERROR: Cannot find knowledge graph in response!');
      console.log('[EXTRACT] Available keys:', Object.keys(kgData));
      return null;
    }

    console.log('[EXTRACT] knowledgeGraph keys:', Object.keys(knowledgeGraph));

    if (!knowledgeGraph.pages) {
      console.error('[EXTRACT] ERROR: knowledgeGraph.pages is missing!');
      console.log('[EXTRACT] knowledgeGraph structure:', knowledgeGraph);
      return null;
    }

    const totalPages = Object.keys(knowledgeGraph.pages).length;
    console.log('[EXTRACT] ✅ Found pages object with', totalPages, 'pages');

    // Extract keywords from ticket for smart filtering
    const keywords = extractTicketKeywords(ticketData);
    console.log('[EXTRACT] 🔍 Extracted keywords from ticket:', keywords.slice(0, 10));

    const context = {
      appUrl: knowledgeGraph.appUrl || kgData.appUrl,
      totalPages: knowledgeGraph.totalPages || 0,
      forms: [],
      apis: [],
      pages: [],
      features: []
    };

    // Score and filter pages by relevance
    const pages = Object.entries(knowledgeGraph.pages || {});
    const scoredPages = pages.map(([url, page]) => {
      const score = calculateRelevanceScore(
        url,
        page.metadata?.title,
        page.metadata?.description,
        keywords
      );
      return { url, page, score };
    });

    // Sort by relevance (highest score first)
    scoredPages.sort((a, b) => b.score - a.score);

    // Log relevance distribution
    const relevantPages = scoredPages.filter(p => p.score > 0);
    console.log(`[EXTRACT] 📊 Relevance Analysis:`);
    console.log(`   Total pages: ${totalPages}`);
    console.log(`   Relevant pages (score > 0): ${relevantPages.length}`);
    console.log(`   Irrelevant pages: ${totalPages - relevantPages.length}`);

    if (relevantPages.length > 0) {
      console.log(`[EXTRACT] 🎯 Top 5 most relevant pages:`);
      relevantPages.slice(0, 5).forEach((p, i) => {
        console.log(`   ${i + 1}. ${p.url} (score: ${p.score})`);
      });
    }

    // Prioritize: Process relevant pages first, then fill with others if needed
    const pagesToProcess = [
      ...relevantPages,
      ...scoredPages.filter(p => p.score === 0)
    ];

    for (const { url, page, score } of pagesToProcess) {
      // Collect forms (with relevance score)
      if (page.features) {
        const forms = page.features.filter(f => f.type === 'form');
        forms.forEach(form => {
          context.forms.push({
            url: url,
            id: form.id,
            action: form.action,
            method: form.method || 'POST',
            inputs: form.inputs || [],
            _relevanceScore: score // Track relevance
          });
        });

        // Collect other features
        const otherFeatures = page.features.filter(f => f.type !== 'form');
        otherFeatures.forEach(feature => {
          context.features.push({
            url: url,
            type: feature.type,
            ...feature,
            _relevanceScore: score // Track relevance
          });
        });
      }

      // Collect APIs (with relevance score)
      if (page.apis && page.apis.length > 0) {
        page.apis.forEach(api => {
          context.apis.push({
            url: url,
            method: api.method,
            endpoint: api.endpoint,
            payload: api.payload,
            _relevanceScore: score // Track relevance
          });
        });
      }

      // Collect page metadata
      if (page.metadata) {
        context.pages.push({
          url: url,
          title: page.metadata.title,
          description: page.metadata.description,
          _relevanceScore: score // Track relevance
        });
      }
    }

    // Sort all collected data by relevance score (highest first)
    context.forms.sort((a, b) => b._relevanceScore - a._relevanceScore);
    context.apis.sort((a, b) => b._relevanceScore - a._relevanceScore);
    context.features.sort((a, b) => b._relevanceScore - a._relevanceScore);
    context.pages.sort((a, b) => b._relevanceScore - a._relevanceScore);

    console.log('[EXTRACT] ✅ Context extraction complete:');
    console.log(`   Forms: ${context.forms.length} (top score: ${context.forms[0]?._relevanceScore || 0})`);
    console.log(`   APIs: ${context.apis.length} (top score: ${context.apis[0]?._relevanceScore || 0})`);
    console.log(`   Features: ${context.features.length} (top score: ${context.features[0]?._relevanceScore || 0})`);
    console.log(`   Pages: ${context.pages.length} (top score: ${context.pages[0]?._relevanceScore || 0})`);

    return context;
  }

  /**
   * Format app context for LLM prompt (with relevance indicators)
   */
  function formatAppContextForPrompt(appContext) {
    if (!appContext) {
      return '';
    }

    let formatted = '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    formatted += '📱 APPLICATION CONTEXT (From Crawled Knowledge Graph)\n';
    formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    formatted += `🌐 Application: ${appContext.appUrl}\n`;
    formatted += `📄 Total Pages Crawled: ${appContext.totalPages}\n`;

    // Add relevance summary
    const relevantForms = appContext.forms?.filter(f => f._relevanceScore > 0).length || 0;
    const relevantAPIs = appContext.apis?.filter(a => a._relevanceScore > 0).length || 0;
    if (relevantForms + relevantAPIs > 0) {
      formatted += `\n🎯 SMART FILTERING: Showing most relevant data first based on ticket keywords\n`;
      formatted += `   Relevant Forms: ${relevantForms}/${appContext.forms?.length || 0}\n`;
      formatted += `   Relevant APIs: ${relevantAPIs}/${appContext.apis?.length || 0}\n`;
    }
    formatted += '\n';

    // Add forms (with relevance indicators)
    if (appContext.forms && appContext.forms.length > 0) {
      formatted += '📝 FORMS FOUND (sorted by relevance):\n';
      appContext.forms.slice(0, 5).forEach((form, index) => {
        const relevanceIndicator = form._relevanceScore > 0 ? '⭐ ' : '';
        formatted += `\n${index + 1}. ${relevanceIndicator}Form on ${form.url}\n`;
        formatted += `   • ID: ${form.id || 'N/A'}\n`;
        formatted += `   • Action: ${form.action || 'N/A'}\n`;
        formatted += `   • Method: ${form.method}\n`;
        if (form.inputs && form.inputs.length > 0) {
          formatted += `   • Fields:\n`;
          form.inputs.slice(0, 10).forEach(input => {
            const required = input.required ? ' (required)' : '';
            formatted += `     - ${input.name || input.id}: ${input.type}${required}\n`;
          });
        }
      });
      if (appContext.forms.length > 5) {
        formatted += `\n   ... and ${appContext.forms.length - 5} more forms\n`;
      }
      formatted += '\n';
    }

    // Add APIs (with relevance indicators)
    if (appContext.apis && appContext.apis.length > 0) {
      formatted += '🔌 API ENDPOINTS DETECTED (sorted by relevance):\n';
      appContext.apis.slice(0, 10).forEach((api, index) => {
        const relevanceIndicator = api._relevanceScore > 0 ? '⭐ ' : '';
        formatted += `\n${index + 1}. ${relevanceIndicator}${api.method} ${api.endpoint}\n`;
        formatted += `   • Page: ${api.url}\n`;
        if (api.payload) {
          formatted += `   • Payload: ${JSON.stringify(api.payload)}\n`;
        }
      });
      if (appContext.apis.length > 10) {
        formatted += `\n   ... and ${appContext.apis.length - 10} more API endpoints\n`;
      }
      formatted += '\n';
    }

    // Add buttons and other features
    if (appContext.features && appContext.features.length > 0) {
      const buttons = appContext.features.filter(f => f.type === 'button');
      if (buttons.length > 0) {
        formatted += '🔘 BUTTONS FOUND:\n';
        buttons.slice(0, 10).forEach((btn, index) => {
          formatted += `   ${index + 1}. "${btn.text || btn.id}" on ${btn.url}\n`;
        });
        if (buttons.length > 10) {
          formatted += `   ... and ${buttons.length - 10} more buttons\n`;
        }
        formatted += '\n';
      }
    }

    // Add page titles
    if (appContext.pages && appContext.pages.length > 0) {
      formatted += '📄 KEY PAGES:\n';
      appContext.pages.slice(0, 5).forEach((page, index) => {
        formatted += `   ${index + 1}. ${page.title || 'Untitled'}\n`;
        formatted += `      URL: ${page.url}\n`;
        if (page.description) {
          formatted += `      ${page.description.substring(0, 100)}...\n`;
        }
      });
      if (appContext.pages.length > 5) {
        formatted += `   ... and ${appContext.pages.length - 5} more pages\n`;
      }
    }

    formatted += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    formatted += '💡 Use the above ACTUAL implementation details when generating test cases.\n';
    formatted += 'Include real field names, API endpoints, and button labels in your tests.\n';
    formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    return formatted;
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

  // Handle Jira SPA navigation
  let lastUrl = window.location.href;
  new MutationObserver(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      if (currentUrl.includes('/browse/')) {
        setTimeout(injectPanel, 1000);
      }
    }
  }).observe(document, { subtree: true, childList: true });

})();
