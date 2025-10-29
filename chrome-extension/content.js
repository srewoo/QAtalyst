// Content script - Injects QAtalyst panel into Jira pages

(function() {
  'use strict';
  
  // Streaming state
  let currentStreamingRequestId = null;
  let streamingContent = '';
  let isStreaming = false;
  
  // Listen for streaming chunks, agent progress, evolution progress, and enhancement progress
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'streamChunk') {
      handleStreamChunk(request.requestId, request.chunk);
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
  });
  
  function handleStreamChunk(requestId, chunk) {
    if (requestId !== currentStreamingRequestId) return;
    
    streamingContent += chunk;
    const resultsContainer = document.getElementById('results-container');
    if (resultsContainer) {
      // Display streaming content with typing effect
      resultsContainer.innerHTML = `
        <div class="qatalyst-streaming">
          <div class="stream-header">
            <span class="stream-status">✨ Generating...</span>
            <button class="stop-btn" id="stop-stream-btn">⏹ Stop</button>
          </div>
          <div class="stream-content">${formatStreamingContent(streamingContent)}</div>
        </div>
      `;
      
      // Add stop button listener
      const stopBtn = document.getElementById('stop-stream-btn');
      if (stopBtn && !stopBtn.hasAttribute('data-listener')) {
        stopBtn.setAttribute('data-listener', 'true');
        stopBtn.addEventListener('click', stopStreaming);
      }
      
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
      
      // Update UI
      const resultsContainer = document.getElementById('results-container');
      if (resultsContainer) {
        resultsContainer.innerHTML = `
          <div class="qatalyst-warning">
            ⚠️ Generation stopped by user
            <div style="margin-top: 10px;">
              ${formatStreamingContent(streamingContent)}
            </div>
          </div>
        `;
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
          <strong>${agent}</strong>
          ${status === 'running' ? `<span class="agent-desc">${description}</span>` : ''}
          ${status === 'completed' && count ? `<span class="agent-count">Generated ${count} tests</span>` : ''}
          ${status === 'error' ? `<span class="agent-error">${error}</span>` : ''}
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
        <h3>🚀 QAtalyst</h3>
        <button class="qatalyst-close" id="qatalyst-close">×</button>
      </div>
      <div class="qatalyst-content">
        <div class="qatalyst-ticket-info">
          <strong>Ticket:</strong> ${ticketKey}
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
  
  // Extract ticket data
  async function extractTicketData() {
    const data = {
      key: extractTicketKey(),
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
    
    // Extract description
    const descEl = document.querySelector('[data-testid="issue.views.issue-base.foundation.description.description-content"]') ||
                  document.querySelector('#description-val');
    if (descEl) {
      data.description = descEl.textContent.trim();
    }
    
    // Extract comments
    data.comments = extractComments();
    
    // Extract attachments
    data.attachments = extractAttachments();
    
    // Extract linked pages (Confluence, external links)
    data.linkedPages = extractLinkedPages();
    
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
        comments.push({
          id: index + 1,
          author: authorEl ? authorEl.textContent.trim() : 'Unknown',
          text: bodyEl.textContent.trim(),
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
        attachments.push({
          id: index + 1,
          name: nameEl ? nameEl.textContent.trim() : 'Unknown',
          url: linkEl.href || '',
          type: extractFileType(nameEl ? nameEl.textContent : '')
        });
      }
    });
    
    return attachments;
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
  
  // Setup event listeners
  function setupEventListeners(ticketKey, ticketData) {
    // Close button
    document.getElementById('qatalyst-close')?.addEventListener('click', () => {
      document.getElementById('qatalyst-panel').style.display = 'none';
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
      const settings = await chrome.storage.sync.get(['llmProvider', 'llmModel', 'apiKey', 'enableStreaming']);
      
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
        
        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: 'analyzeRequirementsStream',
            data: {
              ticketKey,
              ticketData,
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
        
        // Stream is complete
        isStreaming = false;
        currentStreamingRequestId = null;
        displayAnalysisResults(response);
      } else {
        // Regular non-streaming
        resultsContainer.innerHTML = '<div class="qatalyst-loading">🔍 Analyzing requirements with AI...</div>';
        
        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: 'analyzeRequirements',
            data: {
              ticketKey,
              ticketData,
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
        
        displayAnalysisResults(response);
      }
      
    } catch (error) {
      isStreaming = false;
      currentStreamingRequestId = null;
      resultsContainer.innerHTML = `<div class="qatalyst-error">❌ ${error.message.replace(/\\n/g, '<br>')}</div>`;
    } finally {
      btn.disabled = false;
    }
  }
  
  // Handle test scope generation
  async function handleTestScope(ticketKey, ticketData) {
    const resultsContainer = document.getElementById('results-container');
    const btn = document.getElementById('test-scope-btn');
    btn.disabled = true;
    
    try {
      const settings = await chrome.storage.sync.get(['llmProvider', 'llmModel', 'apiKey', 'enableStreaming']);
      
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
        
        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: 'generateTestScopeStream',
            data: {
              ticketKey,
              ticketData,
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
        
        // Stream is complete
        isStreaming = false;
        currentStreamingRequestId = null;
        displayTestScopeResults(response);
      } else {
        // Regular non-streaming
        resultsContainer.innerHTML = '<div class="qatalyst-loading">📋 Generating comprehensive test scope...</div>';
        
        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: 'generateTestScope',
            data: {
              ticketKey,
              ticketData,
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
        
        displayTestScopeResults(response);
      }
      
    } catch (error) {
      isStreaming = false;
      currentStreamingRequestId = null;
      resultsContainer.innerHTML = `<div class="qatalyst-error">❌ ${error.message.replace(/\\n/g, '<br>')}</div>`;
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
      const settings = await chrome.storage.sync.get([
        'llmProvider', 'llmModel', 'apiKey', 'enableStreaming', 'enableMultiAgent',
        'enableEvolution', 'evolutionIntensity',
        'enableRegression', 'testDistribution', 'testCount',
        'enablePositiveAgent', 'enableNegativeAgent', 'enableEdgeAgent',
        'enableRegressionAgent', 'enableIntegrationAgent', 'enableReviewAgent'
      ]);
      
      // Validate settings
      const validationErrors = validateSettingsUI(settings);
      if (validationErrors.length > 0) {
        throw new Error(
          validationErrors.join('\\n') + 
          '\\n\\n🔧 Please configure your settings by clicking the Settings button below.'
        );
      }
      
      // Use multi-agent if enabled
      if (settings.enableMultiAgent) {
        resultsContainer.innerHTML = '<div class="qatalyst-loading">🧬 Initializing multi-agent system...</div>';
        
        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: 'generateTestCasesMultiAgent',
            data: {
              ticketKey,
              ticketData,
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
        
        // Stream is complete
        isStreaming = false;
        currentStreamingRequestId = null;
        displayTestCasesResults(response);
      } else {
        // Regular non-streaming
        resultsContainer.innerHTML = '<div class="qatalyst-loading">🤖 Generating test cases with multi-agent AI system...</div>';
        
        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: 'generateTestCases',
            data: {
              ticketKey,
              ticketData,
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
        
        displayTestCasesResults(response);
      }
      
    } catch (error) {
      isStreaming = false;
      currentStreamingRequestId = null;
      resultsContainer.innerHTML = `<div class="qatalyst-error">❌ ${error.message.replace(/\\n/g, '<br>')}</div>`;
    } finally {
      btn.disabled = false;
    }
  }
  
  // Display functions
  function displayAnalysisResults(data) {
    const container = document.getElementById('results-container');
    
    // Show external sources badge if any were fetched
    let externalSourcesBadge = '';
    if (data.externalSources) {
      const total = (data.externalSources.confluence || 0) + 
                    (data.externalSources.figma || 0) + 
                    (data.externalSources.googleDocs || 0);
      if (total > 0) {
        externalSourcesBadge = `
          <div class="external-sources-badge">
            🔗 Enriched with ${total} external source${total > 1 ? 's' : ''}:
            ${data.externalSources.confluence ? `${data.externalSources.confluence} Confluence ` : ''}
            ${data.externalSources.figma ? `${data.externalSources.figma} Figma ` : ''}
            ${data.externalSources.googleDocs ? `${data.externalSources.googleDocs} Google Docs` : ''}
          </div>
        `;
      }
    }
    
    container.innerHTML = `
      <div class="qatalyst-result">
        <h4>📊 Requirements Analysis</h4>
        ${externalSourcesBadge}
        <div class="result-content">
          ${formatAnalysis(data.analysis)}
        </div>
        <button class="qatalyst-btn small" onclick="this.parentElement.querySelector('.result-content').classList.toggle('expanded')">View Full Analysis</button>
      </div>
    `;
  }
  
  function displayTestScopeResults(data) {
    const container = document.getElementById('results-container');
    container.innerHTML = `
      <div class="qatalyst-result">
        <h4>📋 Test Scope</h4>
        <div class="result-content">
          ${formatTestScope(data.scope)}
        </div>
      </div>
    `;
  }
  
  function displayTestCasesResults(data) {
    const container = document.getElementById('results-container');
    
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
    
    container.innerHTML = `
      <div class="qatalyst-result">
        <h4>✅ Generated Test Cases</h4>
        ${enhancementBadges}
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
        <button class="qatalyst-btn primary" id="add-to-jira-btn">Add to Jira</button>
      </div>
    `;
    
    // Add to Jira button handler
    document.getElementById('add-to-jira-btn')?.addEventListener('click', () => {
      addTestCasesToJira(data.testCases);
    });
  }
  
  // Format functions
  function formatAnalysis(analysis) {
    return `<pre>${analysis}</pre>`;
  }
  
  function formatTestScope(scope) {
    return `<pre>${scope}</pre>`;
  }
  
  function formatTestCases(testCases) {
    return testCases.map((tc, idx) => {
      // Handle both camelCase and snake_case property names
      const expectedResult = tc.expected_result || tc.expectedResult || 'Not specified';
      
      return `
      <div class="test-case" data-testid="test-case-${idx}">
        <div class="tc-header">
          <span class="tc-id">${tc.id}</span>
          <span class="tc-priority ${tc.priority}">${tc.priority}</span>
          <span class="tc-category">${tc.category}</span>
        </div>
        <div class="tc-title">${tc.title}</div>
        <div class="tc-expected">
          <strong>Expected Result:</strong> ${expectedResult}
        </div>
      </div>
    `;
    }).join('');
  }
  
  function addTestCasesToJira(testCases) {
    const formatted = testCases.map(tc => {
      const expectedResult = tc.expected_result || tc.expectedResult || 'Not specified';
      
      return `
**${tc.id}: ${tc.title}**
Priority: ${tc.priority} | Type: ${tc.category}
Expected Result: ${expectedResult}
      `;
    }).join('\n---\n');
    
    // Copy to clipboard
    navigator.clipboard.writeText(formatted).then(() => {
      alert('✅ Test cases copied to clipboard! Paste them into Jira comments.');
    });
  }
  
  function showHelp() {
    alert('QAtalyst Help\n\n1. Click "Analyse Requirements" to extract requirements\n2. Generate Test Scope for comprehensive planning\n3. Generate Test Cases with multi-agent AI\n4. Export to TestRail\n\nFor full documentation, visit Settings.');
  }
  
  // Initialize
  if (window.location.pathname.includes('/browse/')) {
    injectPanel();
  }
  
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
