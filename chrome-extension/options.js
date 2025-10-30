// Options page script

const modelOptions = {
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o (Recommended)' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini (Fast & Cheap)' },
    { value: 'gpt-4', label: 'GPT-4' }
  ],
  claude: [
    { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.5 Sonnet (Recommended)' },
    { value: 'claude-3-opus-20240229', label: 'Claude 3 Opus (Best Quality)' },
    { value: 'claude-3-sonnet-20240229', label: 'Claude 3 Sonnet' },
    { value: 'claude-3-haiku-20240307', label: 'Claude 3 Haiku (Fast & Cheap)' }
  ],
  gemini: [
    { value: 'gemini-2.0-flash-exp', label: 'Gemini 2.0 Flash Exp (Free, Recommended)' },
    { value: 'gemini-1.5-pro', label: 'Gemini 1.5 Pro' },
    { value: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash (Fast)' }
  ]
};

const keyLinks = {
  openai: 'https://platform.openai.com/api-keys',
  claude: 'https://console.anthropic.com/settings/keys',
  gemini: 'https://aistudio.google.com/app/apikey'
};

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const tabName = tab.dataset.tab;
    
    // Update active tab
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    
    // Update active content
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.getElementById(`${tabName}-tab`).classList.add('active');
  });
});

// Load saved settings
document.addEventListener('DOMContentLoaded', async () => {
  // Test count slider live update
  document.getElementById('testCount')?.addEventListener('input', (e) => {
    document.getElementById('testCountValue').textContent = e.target.value;
  });
  const settings = await chrome.storage.sync.get([
    'llmProvider',
    'llmModel',
    'apiKey',
    'temperature',
    'maxTokens',
    'enableStreaming',
    'enableMultiAgent',
    'testCount',
    'enablePositiveAgent',
    'enableNegativeAgent',
    'enableEdgeAgent',
    'enableRegressionAgent',
    'enableIntegrationAgent',
    'enableReviewAgent',
    'enableEnhanced',
    'positivePercent',
    'negativePercent',
    'edgePercent',
    'integrationPercent',
    'performancePercent',
    'securityPercent',
    'enableEvolution',
    'evolutionIntensity',
    'enableHistoricalMining',
    'historicalMaxResults',
    'historicalJqlFilters',
    'jiraEmail',
    'jiraApiToken',
    'testrailUrl',
    'testrailUsername',
    'testrailApiKey',
    'testrailProjectId',
    'testrailSection',
    'confluenceUrl',
    'confluenceEmail',
    'confluenceToken',
    'figmaToken',
    'googleApiKey'
  ]);
  
  // API Settings
  if (settings.llmProvider) {
    document.getElementById('llmProvider').value = settings.llmProvider;
    updateModelOptions(settings.llmProvider);
    updateKeyLink(settings.llmProvider);
  } else {
    updateModelOptions('openai');
    updateKeyLink('openai');
  }
  
  if (settings.llmModel) {
    document.getElementById('llmModel').value = settings.llmModel;
  }
  
  if (settings.apiKey) {
    document.getElementById('apiKey').value = settings.apiKey;
  }
  
  document.getElementById('temperature').value = settings.temperature || 0.7;
  document.getElementById('maxTokens').value = settings.maxTokens || 4000;
  document.getElementById('enableStreaming').checked = settings.enableStreaming !== false;
  document.getElementById('enableMultiAgent').checked = settings.enableMultiAgent || false;
  
  // Test Count
  const testCount = settings.testCount || 30;
  document.getElementById('testCount').value = testCount;
  document.getElementById('testCountValue').textContent = testCount;
  
  // Agent Configuration
  document.getElementById('enablePositiveAgent').checked = settings.enablePositiveAgent !== false;
  document.getElementById('enableNegativeAgent').checked = settings.enableNegativeAgent !== false;
  document.getElementById('enableEdgeAgent').checked = settings.enableEdgeAgent !== false;
  document.getElementById('enableRegressionAgent').checked = settings.enableRegressionAgent !== false;
  document.getElementById('enableIntegrationAgent').checked = settings.enableIntegrationAgent !== false;
  document.getElementById('enableReviewAgent').checked = settings.enableReviewAgent !== false;
  
  // Test Case Settings
  document.getElementById('enableEnhanced').checked = settings.enableEnhanced !== false;
  document.getElementById('positivePercent').value = settings.positivePercent || 40;
  document.getElementById('negativePercent').value = settings.negativePercent || 25;
  document.getElementById('edgePercent').value = settings.edgePercent || 10;
  document.getElementById('integrationPercent').value = settings.integrationPercent || 5;
  document.getElementById('performancePercent').value = settings.performancePercent || 3;
  document.getElementById('securityPercent').value = settings.securityPercent || 3;
  
  document.getElementById('enableEvolution').checked = settings.enableEvolution || false;
  document.getElementById('evolutionIntensity').value = settings.evolutionIntensity || 'light';

  // Historical Mining
  document.getElementById('enableHistoricalMining').checked = settings.enableHistoricalMining || false;
  document.getElementById('historicalMaxResults').value = settings.historicalMaxResults || 20;
  document.getElementById('historicalJqlFilters').value = settings.historicalJqlFilters || '';
  document.getElementById('jiraEmail').value = settings.jiraEmail || '';
  document.getElementById('jiraApiToken').value = settings.jiraApiToken || '';

  // Integrations
  document.getElementById('testrailUrl').value = settings.testrailUrl || '';
  document.getElementById('testrailUsername').value = settings.testrailUsername || '';
  document.getElementById('testrailApiKey').value = settings.testrailApiKey || '';
  document.getElementById('testrailProjectId').value = settings.testrailProjectId || '';
  document.getElementById('testrailSection').value = settings.testrailSection || 'QAtalyst_Automation';
  document.getElementById('confluenceUrl').value = settings.confluenceUrl || '';
  document.getElementById('confluenceEmail').value = settings.confluenceEmail || '';
  document.getElementById('confluenceToken').value = settings.confluenceToken || '';
  document.getElementById('figmaToken').value = settings.figmaToken || '';
  document.getElementById('googleApiKey').value = settings.googleApiKey || '';
});

// Provider change handler
document.getElementById('llmProvider').addEventListener('change', (e) => {
  updateModelOptions(e.target.value);
  updateKeyLink(e.target.value);
});

function updateModelOptions(provider) {
  const modelSelect = document.getElementById('llmModel');
  modelSelect.innerHTML = '';
  
  const options = modelOptions[provider] || modelOptions.openai;
  options.forEach(opt => {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    modelSelect.appendChild(option);
  });
}

function updateKeyLink(provider) {
  const keyLink = document.getElementById('getKeyLink');
  keyLink.href = keyLinks[provider] || keyLinks.openai;
}

// Save settings
document.getElementById('saveBtn').addEventListener('click', async () => {
  const settings = {
    // API Settings
    llmProvider: document.getElementById('llmProvider').value,
    llmModel: document.getElementById('llmModel').value,
    apiKey: document.getElementById('apiKey').value,
    temperature: parseFloat(document.getElementById('temperature').value),
    maxTokens: parseInt(document.getElementById('maxTokens').value),
    enableStreaming: document.getElementById('enableStreaming').checked,
    enableMultiAgent: document.getElementById('enableMultiAgent').checked,
    testCount: parseInt(document.getElementById('testCount').value),
    
    // Agent Configuration
    enablePositiveAgent: document.getElementById('enablePositiveAgent').checked,
    enableNegativeAgent: document.getElementById('enableNegativeAgent').checked,
    enableEdgeAgent: document.getElementById('enableEdgeAgent').checked,
    enableRegressionAgent: document.getElementById('enableRegressionAgent').checked,
    enableIntegrationAgent: document.getElementById('enableIntegrationAgent').checked,
    enableReviewAgent: document.getElementById('enableReviewAgent').checked,
    
    // Test Case Settings
    enableEnhanced: document.getElementById('enableEnhanced').checked,
    positivePercent: parseInt(document.getElementById('positivePercent').value),
    negativePercent: parseInt(document.getElementById('negativePercent').value),
    edgePercent: parseInt(document.getElementById('edgePercent').value),
    integrationPercent: parseInt(document.getElementById('integrationPercent').value),
    performancePercent: parseInt(document.getElementById('performancePercent').value),
    securityPercent: parseInt(document.getElementById('securityPercent').value),
    
    enableEvolution: document.getElementById('enableEvolution').checked,
    evolutionIntensity: document.getElementById('evolutionIntensity').value,

    // Historical Mining
    enableHistoricalMining: document.getElementById('enableHistoricalMining').checked,
    historicalMaxResults: parseInt(document.getElementById('historicalMaxResults').value),
    historicalJqlFilters: document.getElementById('historicalJqlFilters').value.trim(),
    jiraEmail: document.getElementById('jiraEmail').value.trim(),
    jiraApiToken: document.getElementById('jiraApiToken').value.trim(),

    // Integrations
    testrailUrl: document.getElementById('testrailUrl').value,
    testrailUsername: document.getElementById('testrailUsername').value,
    testrailApiKey: document.getElementById('testrailApiKey').value,
    testrailProjectId: document.getElementById('testrailProjectId').value,
    testrailSection: document.getElementById('testrailSection').value,
    confluenceUrl: document.getElementById('confluenceUrl').value,
    confluenceEmail: document.getElementById('confluenceEmail').value,
    confluenceToken: document.getElementById('confluenceToken').value,
    figmaToken: document.getElementById('figmaToken').value,
    googleApiKey: document.getElementById('googleApiKey').value
  };
  
  await chrome.storage.sync.set(settings);
  
  const statusDiv = document.getElementById('status');
  statusDiv.className = 'status success';
  statusDiv.textContent = '✅ All settings saved successfully!';
  
  setTimeout(() => {
    statusDiv.textContent = '';
  }, 3000);
});

// Reset settings
document.getElementById('resetBtn').addEventListener('click', async () => {
  if (confirm('Are you sure you want to reset all settings to defaults?')) {
    await chrome.storage.sync.clear();
    window.location.reload();
  }
});

// Test Jira Authentication
document.getElementById('testJiraAuth').addEventListener('click', async () => {
  const jiraEmail = document.getElementById('jiraEmail').value.trim();
  const jiraApiToken = document.getElementById('jiraApiToken').value.trim();
  const statusDiv = document.getElementById('authTestStatus');
  const button = document.getElementById('testJiraAuth');

  // Clear previous status
  statusDiv.innerHTML = '';

  // Validate inputs
  if (!jiraEmail || !jiraApiToken) {
    statusDiv.innerHTML = '<div style="color: #dc2626; font-size: 13px;">❌ Please enter both Jira email and API token</div>';
    return;
  }

  // Disable button and show loading
  button.disabled = true;
  button.textContent = '🔄 Testing...';
  statusDiv.innerHTML = '<div style="color: #0ea5e9; font-size: 13px;">⏳ Testing authentication...</div>';

  try {
    // Get Jira base URL from active tab
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    let baseUrl = 'https://mindtickle.atlassian.net'; // Default fallback

    if (tabs[0] && tabs[0].url) {
      const url = new URL(tabs[0].url);
      if (url.hostname.includes('atlassian.net') || url.hostname.includes('jira')) {
        baseUrl = `${url.protocol}//${url.hostname}`;
      }
    }

    // Construct API URL
    const apiUrl = `${baseUrl}/rest/api/3/myself`;

    // Build headers with Basic Auth
    const credentials = btoa(`${jiraEmail}:${jiraApiToken}`);
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Basic ${credentials}`
    };

    console.log('Testing Jira auth to:', apiUrl);

    // Make the request
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: headers,
      credentials: 'omit' // Don't use cookies, only API token
    });

    console.log('Auth test response status:', response.status);

    if (response.ok) {
      const userData = await response.json();
      console.log('Auth test successful:', userData);

      statusDiv.innerHTML = `
        <div style="background: #f0fdf4; border: 1px solid #bbf7d0; padding: 10px; border-radius: 6px; font-size: 13px; color: #16a34a;">
          ✅ <strong>Authentication Successful!</strong><br>
          👤 Logged in as: <strong>${userData.displayName}</strong><br>
          📧 Email: ${userData.emailAddress}<br>
          🔗 Account: ${userData.accountId}
        </div>
      `;
    } else {
      // Authentication failed
      let errorMessage = 'Authentication failed';
      try {
        const errorData = await response.json();
        errorMessage = errorData.errorMessages?.join(', ') || errorData.message || errorMessage;
      } catch (e) {
        try {
          errorMessage = await response.text();
        } catch (textError) {
          // Use default message
        }
      }

      console.error('Auth test failed:', response.status, errorMessage);

      statusDiv.innerHTML = `
        <div style="background: #fef2f2; border: 1px solid #fecaca; padding: 10px; border-radius: 6px; font-size: 13px; color: #dc2626;">
          ❌ <strong>Authentication Failed (${response.status})</strong><br>
          ${errorMessage}<br><br>
          <strong>Troubleshooting:</strong><br>
          ${response.status === 401 ? '• Check if your API token is correct<br>• Ensure email matches your Jira account' : ''}
          ${response.status === 403 ? '• You may not have permission to access this API<br>• Try regenerating your API token' : ''}
          ${response.status === 404 ? '• Jira URL may be incorrect<br>• Detected URL: ' + baseUrl : ''}
        </div>
      `;
    }
  } catch (error) {
    console.error('Auth test error:', error);

    statusDiv.innerHTML = `
      <div style="background: #fef2f2; border: 1px solid #fecaca; padding: 10px; border-radius: 6px; font-size: 13px; color: #dc2626;">
        ❌ <strong>Connection Error</strong><br>
        ${error.message}<br><br>
        <strong>Possible causes:</strong><br>
        • Network connection issues<br>
        • CORS restrictions<br>
        • Jira URL is incorrect<br>
        • Firewall blocking the request
      </div>
    `;
  } finally {
    // Re-enable button
    button.disabled = false;
    button.textContent = '🔐 Test Jira Authentication';
  }
});

document.getElementById('testTestrail').addEventListener('click', () => handleTestIntegration('testrail'));
document.getElementById('testConfluence').addEventListener('click', () => handleTestIntegration('confluence'));
document.getElementById('testFigma').addEventListener('click', () => handleTestIntegration('figma'));
document.getElementById('testGoogle').addEventListener('click', () => handleTestIntegration('google'));

async function handleTestIntegration(type) {
  const statusEl = document.getElementById(`${type}Status`);
  statusEl.textContent = 'Testing...';

  let data = { type };

  if (type === 'testrail') {
    data.url = document.getElementById('testrailUrl').value;
    data.username = document.getElementById('testrailUsername').value;
    data.apiKey = document.getElementById('testrailApiKey').value;
  } else if (type === 'confluence') {
    data.url = document.getElementById('confluenceUrl').value;
    data.email = document.getElementById('confluenceEmail').value;
    data.token = document.getElementById('confluenceToken').value;
  } else if (type === 'figma') {
    data.token = document.getElementById('figmaToken').value;
  } else if (type === 'google') {
    data.apiKey = document.getElementById('googleApiKey').value;
  }

  try {
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'testIntegration', data }, (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        if (response.error) {
          return reject(new Error(response.error));
        }
        resolve(response);
      });
    });

    if (response.success) {
      statusEl.textContent = '✅ Success';
    } else {
      statusEl.textContent = `❌ Error: ${response.message}`;
    }
  } catch (error) {
    statusEl.textContent = `❌ Error: ${error.message}`;
  }
}
