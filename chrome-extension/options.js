// Options page script

const modelOptions = {
  openai: [
    { value: 'gpt-4o', label: 'GPT-4o (Recommended)' },
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini (Fast & Cheap)' },
    { value: 'o1', label: 'O1 (Reasoning)' }
  ],
  claude: [
    { value: 'claude-sonnet-4-20250514', label: 'Claude 4.5 Sonnet (Latest)' },
    { value: 'claude-sonnet-4-20250111', label: 'Claude 4.1 Sonnet' },
    { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.7 Sonnet' }
  ],
  gemini: [
    { value: 'gemini-2.5-pro-exp-03', label: 'Gemini 2.5 Pro (Recommended)' },
    { value: 'gemini-2.5-flash-exp', label: 'Gemini 2.5 Flash (Fast & Cheap)' }
  ]
};

const keyLinks = {
  openai: 'https://platform.openai.com/api-keys',
  claude: 'https://console.anthropic.com/settings/keys',
  gemini: 'https://aistudio.google.com/app/apikey'
};

// Input validation utilities
const InputValidator = {
  validateUrl(url, requireHttps = true) {
    if (!url || url.trim() === '') {
      return { valid: true }; // Empty is okay
    }

    url = url.trim();

    try {
      const parsed = new URL(url);

      if (requireHttps && parsed.protocol !== 'https:') {
        return { valid: false, error: 'URL must use HTTPS for security' };
      }

      return { valid: true, value: url };
    } catch (e) {
      return { valid: false, error: 'Invalid URL format. Must be a valid URL (e.g., https://example.com)' };
    }
  },

  validateApiKey(key) {
    if (!key || key.trim() === '') {
      return { valid: true }; // Empty is okay (optional fields)
    }

    key = key.trim();

    // Check for common issues
    if (key.length < 10) {
      return { valid: false, error: 'API key seems too short (minimum 10 characters)' };
    }

    if (key.includes(' ')) {
      return { valid: false, error: 'API key should not contain spaces' };
    }

    // Check for placeholder text
    if (key.toLowerCase().includes('your') || key.toLowerCase().includes('key') || key === 'xxx') {
      return { valid: false, error: 'Please enter your actual API key, not a placeholder' };
    }

    return { valid: true, value: key };
  },

  validateEmail(email) {
    if (!email || email.trim() === '') {
      return { valid: true }; // Empty is okay
    }

    email = email.trim();

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return { valid: false, error: 'Invalid email format' };
    }

    return { valid: true, value: email };
  },

  validateProjectId(projectId) {
    if (!projectId || projectId.trim() === '') {
      return { valid: true }; // Empty is okay
    }

    projectId = projectId.trim();

    // TestRail project IDs are typically numeric
    if (!/^\d+$/.test(projectId)) {
      return { valid: false, error: 'Project ID should be a number' };
    }

    return { valid: true, value: projectId };
  }
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
    'figmaImageMode',
    'googleApiKey',
    'googleAuthMode',
    'googleClientId',
    'googleClientSecret',
    'googleProjectId'
  ]);

  // Decrypt sensitive tokens when loading
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
  if (settings.googleClientSecret) {
    settings.googleClientSecret = await securityManager.decryptApiKeyFromStorage(settings.googleClientSecret);
  }
  if (settings.testrailApiKey) {
    settings.testrailApiKey = await securityManager.decryptApiKeyFromStorage(settings.testrailApiKey);
  }
  
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
  document.getElementById('maxTokens').value = settings.maxTokens || 16000;
  document.getElementById('enableStreaming').checked = settings.enableStreaming !== false;
  document.getElementById('enableMultiAgent').checked = settings.enableMultiAgent || false;

  // Debug logging
  console.log('📖 Loaded Multi-Agent Settings:', {
    enableMultiAgent: settings.enableMultiAgent,
    checkboxValue: document.getElementById('enableMultiAgent').checked
  });
  
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
  
  // Figma Image Mode settings
  const figmaImageMode = settings.figmaImageMode || 'single';
  const figmaImageSingle = document.getElementById('figmaImageSingle');
  const figmaImageChildren = document.getElementById('figmaImageChildren');
  const figmaSingleModeInfo = document.getElementById('figmaSingleModeInfo');
  const figmaChildrenModeInfo = document.getElementById('figmaChildrenModeInfo');
  
  if (figmaImageMode === 'children') {
    if (figmaImageChildren) figmaImageChildren.checked = true;
    if (figmaSingleModeInfo) figmaSingleModeInfo.style.display = 'none';
    if (figmaChildrenModeInfo) figmaChildrenModeInfo.style.display = 'block';
  } else {
    if (figmaImageSingle) figmaImageSingle.checked = true;
    if (figmaSingleModeInfo) figmaSingleModeInfo.style.display = 'block';
    if (figmaChildrenModeInfo) figmaChildrenModeInfo.style.display = 'none';
  }
  
  document.getElementById('googleApiKey').value = settings.googleApiKey || '';
  
  // Google Docs OAuth2 settings
  const googleAuthMode = settings.googleAuthMode || 'public';
  const googleAuthPublic = document.getElementById('googleAuthPublic');
  const googleAuthOAuth2 = document.getElementById('googleAuthOAuth2');
  const googlePublicMode = document.getElementById('googlePublicMode');
  const googleOAuth2Mode = document.getElementById('googleOAuth2Mode');
  const googleClientId = document.getElementById('googleClientId');
  const googleClientSecret = document.getElementById('googleClientSecret');
  const googleProjectId = document.getElementById('googleProjectId');
  
  if (googleAuthMode === 'oauth2') {
    if (googleAuthOAuth2) googleAuthOAuth2.checked = true;
    if (googlePublicMode) googlePublicMode.style.display = 'none';
    if (googleOAuth2Mode) googleOAuth2Mode.style.display = 'block';
  } else {
    if (googleAuthPublic) googleAuthPublic.checked = true;
    if (googlePublicMode) googlePublicMode.style.display = 'block';
    if (googleOAuth2Mode) googleOAuth2Mode.style.display = 'none';
  }
  
  if (googleClientId) googleClientId.value = settings.googleClientId || '';
  if (googleClientSecret) googleClientSecret.value = settings.googleClientSecret || '';
  if (googleProjectId) googleProjectId.value = settings.googleProjectId || '';
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
    figmaImageMode: document.querySelector('input[name="figmaImageMode"]:checked')?.value || 'single',
    googleApiKey: document.getElementById('googleApiKey').value,
    
    // Google Docs OAuth2 settings
    googleAuthMode: document.getElementById('googleAuthPublic').checked ? 'public' : 'oauth2',
    googleClientId: document.getElementById('googleClientId').value,
    googleClientSecret: document.getElementById('googleClientSecret').value,
    googleProjectId: document.getElementById('googleProjectId').value
  };

  // Validate settings before saving
  const validationErrors = [];

  // Validate URLs
  const confluenceUrlValidation = InputValidator.validateUrl(settings.confluenceUrl);
  if (!confluenceUrlValidation.valid) {
    validationErrors.push(`Confluence URL: ${confluenceUrlValidation.error}`);
  } else if (confluenceUrlValidation.value) {
    settings.confluenceUrl = confluenceUrlValidation.value;
  }

  const testrailUrlValidation = InputValidator.validateUrl(settings.testrailUrl);
  if (!testrailUrlValidation.valid) {
    validationErrors.push(`TestRail URL: ${testrailUrlValidation.error}`);
  } else if (testrailUrlValidation.value) {
    settings.testrailUrl = testrailUrlValidation.value;
  }

  // Validate API Keys
  const apiKeyValidation = InputValidator.validateApiKey(settings.apiKey);
  if (!apiKeyValidation.valid) {
    validationErrors.push(`LLM API Key: ${apiKeyValidation.error}`);
  } else if (apiKeyValidation.value) {
    settings.apiKey = apiKeyValidation.value;
  }

  const jiraApiTokenValidation = InputValidator.validateApiKey(settings.jiraApiToken);
  if (!jiraApiTokenValidation.valid) {
    validationErrors.push(`Jira API Token: ${jiraApiTokenValidation.error}`);
  } else if (jiraApiTokenValidation.value) {
    settings.jiraApiToken = jiraApiTokenValidation.value;
  }

  const confluenceTokenValidation = InputValidator.validateApiKey(settings.confluenceToken);
  if (!confluenceTokenValidation.valid) {
    validationErrors.push(`Confluence Token: ${confluenceTokenValidation.error}`);
  } else if (confluenceTokenValidation.value) {
    settings.confluenceToken = confluenceTokenValidation.value;
  }

  const figmaTokenValidation = InputValidator.validateApiKey(settings.figmaToken);
  if (!figmaTokenValidation.valid) {
    validationErrors.push(`Figma Token: ${figmaTokenValidation.error}`);
  } else if (figmaTokenValidation.value) {
    settings.figmaToken = figmaTokenValidation.value;
  }

  const googleApiKeyValidation = InputValidator.validateApiKey(settings.googleApiKey);
  if (!googleApiKeyValidation.valid) {
    validationErrors.push(`Google API Key: ${googleApiKeyValidation.error}`);
  } else if (googleApiKeyValidation.value) {
    settings.googleApiKey = googleApiKeyValidation.value;
  }

  const testrailApiKeyValidation = InputValidator.validateApiKey(settings.testrailApiKey);
  if (!testrailApiKeyValidation.valid) {
    validationErrors.push(`TestRail API Key: ${testrailApiKeyValidation.error}`);
  } else if (testrailApiKeyValidation.value) {
    settings.testrailApiKey = testrailApiKeyValidation.value;
  }

  // Validate emails
  const jiraEmailValidation = InputValidator.validateEmail(settings.jiraEmail);
  if (!jiraEmailValidation.valid) {
    validationErrors.push(`Jira Email: ${jiraEmailValidation.error}`);
  } else if (jiraEmailValidation.value) {
    settings.jiraEmail = jiraEmailValidation.value;
  }

  const confluenceEmailValidation = InputValidator.validateEmail(settings.confluenceEmail);
  if (!confluenceEmailValidation.valid) {
    validationErrors.push(`Confluence Email: ${confluenceEmailValidation.error}`);
  } else if (confluenceEmailValidation.value) {
    settings.confluenceEmail = confluenceEmailValidation.value;
  }

  const testrailUsernameValidation = InputValidator.validateEmail(settings.testrailUsername);
  if (!testrailUsernameValidation.valid) {
    validationErrors.push(`TestRail Username: ${testrailUsernameValidation.error}`);
  } else if (testrailUsernameValidation.value) {
    settings.testrailUsername = testrailUsernameValidation.value;
  }

  // Validate project ID
  const projectIdValidation = InputValidator.validateProjectId(settings.testrailProjectId);
  if (!projectIdValidation.valid) {
    validationErrors.push(`TestRail Project ID: ${projectIdValidation.error}`);
  } else if (projectIdValidation.value) {
    settings.testrailProjectId = projectIdValidation.value;
  }

  // Show validation errors if any
  if (validationErrors.length > 0) {
    const statusDiv = document.getElementById('status');
    statusDiv.className = 'status error';
    statusDiv.innerHTML = '<strong>❌ Validation Errors:</strong><br>' + validationErrors.join('<br>');
    setTimeout(() => {
      statusDiv.textContent = '';
    }, 8000);
    return; // Don't save if there are validation errors
  }

  // Encrypt sensitive tokens before saving
  if (settings.apiKey && settings.apiKey.trim()) {
    settings.apiKey = await securityManager.encryptApiKeyForStorage(settings.apiKey.trim());
  }
  if (settings.jiraApiToken && settings.jiraApiToken.trim()) {
    settings.jiraApiToken = await securityManager.encryptApiKeyForStorage(settings.jiraApiToken.trim());
  }
  if (settings.confluenceToken && settings.confluenceToken.trim()) {
    settings.confluenceToken = await securityManager.encryptApiKeyForStorage(settings.confluenceToken.trim());
  }
  if (settings.figmaToken && settings.figmaToken.trim()) {
    settings.figmaToken = await securityManager.encryptApiKeyForStorage(settings.figmaToken.trim());
  }
  if (settings.googleApiKey && settings.googleApiKey.trim()) {
    settings.googleApiKey = await securityManager.encryptApiKeyForStorage(settings.googleApiKey.trim());
  }
  if (settings.googleClientSecret && settings.googleClientSecret.trim()) {
    settings.googleClientSecret = await securityManager.encryptApiKeyForStorage(settings.googleClientSecret.trim());
  }
  if (settings.testrailApiKey && settings.testrailApiKey.trim()) {
    settings.testrailApiKey = await securityManager.encryptApiKeyForStorage(settings.testrailApiKey.trim());
  }

  // Debug logging before saving
  console.log('💾 Saving QAtalyst Settings:', {
    enableMultiAgent: settings.enableMultiAgent,
    enableEvolution: settings.enableEvolution,
    enableRegressionAgent: settings.enableRegressionAgent,
    enablePositiveAgent: settings.enablePositiveAgent,
    enableNegativeAgent: settings.enableNegativeAgent,
    enableEdgeAgent: settings.enableEdgeAgent,
    testCount: settings.testCount
  });

  // Debug: Check type before saving
  console.log('💾 Type of enableMultiAgent before save:', typeof settings.enableMultiAgent);
  console.log('💾 Checkbox element value:', document.getElementById('enableMultiAgent').checked);

  await chrome.storage.sync.set(settings);

  // Verify what was actually saved
  const verification = await chrome.storage.sync.get(['enableMultiAgent', 'enableEvolution', 'testCount']);
  console.log('✅ Settings saved and verified:', verification);
  console.log('✅ Type of verified enableMultiAgent:', typeof verification.enableMultiAgent);

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

document.getElementById('testTestrail')?.addEventListener('click', () => handleTestIntegration('testrail'));
document.getElementById('testConfluence')?.addEventListener('click', () => handleTestIntegration('confluence'));
document.getElementById('testFigma')?.addEventListener('click', () => handleTestIntegration('figma'));
document.getElementById('testGoogle')?.addEventListener('click', () => handleTestIntegration('google'));

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

// Figma Image Mode Toggle
document.getElementById('figmaImageSingle')?.addEventListener('change', function() {
  if (this.checked) {
    document.getElementById('figmaSingleModeInfo').style.display = 'block';
    document.getElementById('figmaChildrenModeInfo').style.display = 'none';
  }
});

document.getElementById('figmaImageChildren')?.addEventListener('change', function() {
  if (this.checked) {
    document.getElementById('figmaSingleModeInfo').style.display = 'none';
    document.getElementById('figmaChildrenModeInfo').style.display = 'block';
  }
});

// Google Docs Auth Mode Toggle
// Google Docs authentication mode toggle
document.getElementById('googleAuthPublic')?.addEventListener('change', function() {
  if (this.checked) {
    document.getElementById('googlePublicMode').style.display = 'block';
    document.getElementById('googleOAuth2Mode').style.display = 'none';
  }
});

document.getElementById('googleAuthOAuth2')?.addEventListener('change', function() {
  if (this.checked) {
    document.getElementById('googlePublicMode').style.display = 'none';
    document.getElementById('googleOAuth2Mode').style.display = 'block';
  }
});

// Initialize visibility based on saved settings (called after loadSettings)
function updateGoogleAuthModeVisibility() {
  const publicRadio = document.getElementById('googleAuthPublic');
  const oauth2Radio = document.getElementById('googleAuthOAuth2');
  const publicMode = document.getElementById('googlePublicMode');
  const oauth2Mode = document.getElementById('googleOAuth2Mode');
  
  if (publicRadio && oauth2Radio && publicMode && oauth2Mode) {
    if (publicRadio.checked) {
      publicMode.style.display = 'block';
      oauth2Mode.style.display = 'none';
    } else if (oauth2Radio.checked) {
      publicMode.style.display = 'none';
      oauth2Mode.style.display = 'block';
    }
  }
}

// Show Redirect URI button
document.getElementById('showRedirectUri')?.addEventListener('click', () => {
  const redirectUri = chrome.identity.getRedirectURL();
  const displayEl = document.getElementById('redirectUriDisplay');
  
  if (displayEl) {
    displayEl.textContent = redirectUri;
    displayEl.style.display = 'block';
    
    // Copy to clipboard
    navigator.clipboard.writeText(redirectUri).then(() => {
      const button = document.getElementById('showRedirectUri');
      const originalText = button.textContent;
      button.textContent = '✅ Copied to Clipboard!';
      button.style.background = '#10b981';
      button.style.color = 'white';
      
      setTimeout(() => {
        button.textContent = originalText;
        button.style.background = '';
        button.style.color = '';
      }, 2000);
    }).catch(err => {
      console.error('Failed to copy:', err);
    });
  }
  
  console.log('📋 [OAuth2] Your Redirect URI:', redirectUri);
  console.log('📋 [OAuth2] Add this to Google Cloud Console → Credentials → OAuth 2.0 Client IDs → Authorized redirect URIs');
});

// Test OAuth2 credentials
document.getElementById('testGoogleOAuth')?.addEventListener('click', async () => {
  const clientId = document.getElementById('googleClientId').value.trim();
  const clientSecret = document.getElementById('googleClientSecret').value.trim();
  const projectId = document.getElementById('googleProjectId').value.trim();
  const statusEl = document.getElementById('googleOAuthStatus');
  
  // Clear previous status
  statusEl.textContent = '';
  statusEl.className = '';
  
  // Validate inputs
  if (!clientId || !clientSecret) {
    statusEl.textContent = '❌ Please enter both Client ID and Client Secret';
    statusEl.style.color = '#dc3545';
    return;
  }
  
  // Validate Client ID format
  if (!clientId.includes('.apps.googleusercontent.com')) {
    statusEl.textContent = '❌ Invalid Client ID format (should end with .apps.googleusercontent.com)';
    statusEl.style.color = '#dc3545';
    return;
  }
  
  // Validate Client Secret format
  if (!clientSecret.startsWith('GOCSPX-')) {
    statusEl.textContent = '⚠️ Warning: Client Secret should typically start with GOCSPX-';
    statusEl.style.color = '#ff9800';
  }
  
  statusEl.textContent = '🔄 Testing OAuth2 configuration...';
  statusEl.style.color = '#007bff';
  
  try {
    // Attempt to initiate OAuth2 flow using chrome.identity
    // Note: This requires the OAuth2 client to be properly configured in Google Cloud Console
    const redirectUrl = chrome.identity.getRedirectURL();
    
    console.log('🔐 [OAuth2 Test] Extension Redirect URI:', redirectUrl);
    console.log('📋 [OAuth2 Test] Copy this URI to Google Cloud Console:');
    console.log(`   ${redirectUrl}`);
    
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', redirectUrl);
    authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/documents.readonly https://www.googleapis.com/auth/userinfo.email');
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    
    console.log('🔐 [OAuth2 Test] Initiating flow...', {
      clientId,
      redirectUrl,
      authUrl: authUrl.toString()
    });
    
    // Launch OAuth2 flow
    chrome.identity.launchWebAuthFlow(
      {
        url: authUrl.toString(),
        interactive: true
      },
      async (responseUrl) => {
        if (chrome.runtime.lastError) {
          console.error('❌ [OAuth2 Test] Error:', chrome.runtime.lastError);
          
          // Check if it's a redirect URI mismatch error
          if (chrome.runtime.lastError.message.includes('redirect_uri') || 
              chrome.runtime.lastError.message.includes('404')) {
            statusEl.innerHTML = `
              ❌ <strong>Redirect URI Not Configured</strong><br>
              <span style="font-size: 11px;">
                Add this URI to Google Cloud Console:<br>
                <code style="background: #fee; padding: 4px 8px; border-radius: 4px; display: inline-block; margin-top: 4px;">${redirectUrl}</code><br>
                <a href="https://console.cloud.google.com/apis/credentials" target="_blank" style="color: #0ea5e9;">Open Google Cloud Console →</a>
              </span>
            `;
          } else {
            statusEl.textContent = `❌ OAuth2 Error: ${chrome.runtime.lastError.message}`;
          }
          statusEl.style.color = '#dc3545';
          return;
        }
        
        if (!responseUrl) {
          statusEl.textContent = '❌ OAuth2 flow cancelled or failed';
          statusEl.style.color = '#dc3545';
          return;
        }
        
        // Extract authorization code
        const url = new URL(responseUrl);
        const code = url.searchParams.get('code');
        
        if (!code) {
          statusEl.textContent = '❌ No authorization code received';
          statusEl.style.color = '#dc3545';
          return;
        }
        
        console.log('✅ [OAuth2 Test] Authorization code received');
        
        // Exchange code for tokens
        try {
          const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
              code: code,
              client_id: clientId,
              client_secret: clientSecret,
              redirect_uri: redirectUrl,
              grant_type: 'authorization_code'
            })
          });
          
          if (!tokenResponse.ok) {
            const error = await tokenResponse.json();
            console.error('❌ [OAuth2 Test] Token exchange failed:', error);
            statusEl.textContent = `❌ Token Error: ${error.error_description || error.error}`;
            statusEl.style.color = '#dc3545';
            return;
          }
          
          const tokens = await tokenResponse.json();
          console.log('✅ [OAuth2 Test] Tokens received:', {
            hasAccessToken: !!tokens.access_token,
            hasRefreshToken: !!tokens.refresh_token,
            expiresIn: tokens.expires_in
          });
          
          // Test the access token with userinfo API call
          const testResponse = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
            headers: {
              'Authorization': `Bearer ${tokens.access_token}`
            }
          });
          
          if (testResponse.ok) {
            const userInfo = await testResponse.json();
            statusEl.textContent = `✅ OAuth2 working! Authenticated as: ${userInfo.email}`;
            statusEl.style.color = '#28a745';
            
            // Store tokens securely
            const securityManager = new SecurityManager();
            await chrome.storage.sync.set({
              googleAccessToken: await securityManager.encryptApiKeyForStorage(tokens.access_token),
              googleRefreshToken: tokens.refresh_token ? await securityManager.encryptApiKeyForStorage(tokens.refresh_token) : null,
              googleTokenExpiry: Date.now() + (tokens.expires_in * 1000)
            });
            
            console.log('✅ [OAuth2 Test] Tokens stored securely');
            console.log('✅ [OAuth2 Test] Access token has the following scopes:', tokens.scope);
          } else {
            const errorData = await testResponse.json().catch(() => ({}));
            console.error('❌ [OAuth2 Test] Token validation failed:', {
              status: testResponse.status,
              statusText: testResponse.statusText,
              error: errorData
            });
            statusEl.textContent = `❌ Token validation failed: ${testResponse.status} ${testResponse.statusText}`;
            statusEl.style.color = '#dc3545';
          }
        } catch (error) {
          console.error('❌ [OAuth2 Test] Token exchange error:', error);
          statusEl.textContent = `❌ Error: ${error.message}`;
          statusEl.style.color = '#dc3545';
        }
      }
    );
  } catch (error) {
    console.error('❌ [OAuth2 Test] Setup error:', error);
    statusEl.textContent = `❌ Error: ${error.message}`;
    statusEl.style.color = '#dc3545';
  }
});
