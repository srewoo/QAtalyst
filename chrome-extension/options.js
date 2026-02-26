// Options page script

// Model options - keep in sync with popup.js
const modelOptions = {
  openai: [
    { value: 'gpt-4.1',      label: 'GPT-4.1 (Recommended) — 1M ctx, 32K output' },
    { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini (Fast & Cheap) — 1M ctx' },
    { value: 'gpt-4.1-nano', label: 'GPT-4.1 Nano (Cheapest) — 1M ctx' },
    { value: 'o1',           label: 'O1 (Reasoning)' }
  ],
  claude: [
    { value: 'claude-sonnet-4-20250514', label: 'Claude 4.5 Sonnet (Latest)' },
    { value: 'claude-sonnet-4-20250111', label: 'Claude 4.1 Sonnet' },
    { value: 'claude-3-5-sonnet-20241022', label: 'Claude 3.7 Sonnet' }
  ],
  gemini: [
    { value: 'gemini-2.5-pro-exp-03', label: 'Gemini 2.5 Pro (Recommended)' },
    { value: 'gemini-2.5-flash-exp', label: 'Gemini 2.5 Flash (Fast & Cheap)' }
  ],
  bedrock: [
    // ── Global Inference Profiles — callable from any AWS region incl. ap-southeast-1 ──
    // These are the IDs shown as "Global" in the Bedrock console
    { value: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0', label: 'Claude Sonnet 4.5 — Global ✓ All regions incl. Singapore' },
    { value: 'global.anthropic.claude-sonnet-4-6',                label: 'Claude Sonnet 4.6 — Global ✓ All regions incl. Singapore' },
    { value: 'global.anthropic.claude-sonnet-4-20250514-v1:0',    label: 'Claude Sonnet 4 — Global ✓ All regions incl. Singapore' },
    { value: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',   label: 'Claude Haiku 4.5 — Global ✓ All regions incl. Singapore' },
    { value: 'global.anthropic.claude-opus-4-5-20251101-v1:0',    label: 'Claude Opus 4.5 — Global ✓ All regions incl. Singapore' },
    { value: 'global.anthropic.claude-opus-4-6-v1',               label: 'Claude Opus 4.6 — Global ✓ All regions incl. Singapore' },
    // ── US Cross-Region Inference Profiles (us-east-1, us-east-2, us-west-2 only) ──
    { value: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', label: 'Claude Sonnet 4.5 — US regions only' },
    { value: 'us.anthropic.claude-sonnet-4-6',                label: 'Claude Sonnet 4.6 — US regions only' },
    { value: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',   label: 'Claude Haiku 4.5 — US regions only' },
    { value: 'us.anthropic.claude-opus-4-5-20251101-v1:0',    label: 'Claude Opus 4.5 — US regions only' },
    { value: 'us.anthropic.claude-3-5-sonnet-20241022-v2:0',  label: 'Claude 3.5 Sonnet v2 — US regions only' },
    { value: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',   label: 'Claude 3.5 Haiku — US regions only' },
    // ── EU Cross-Region Inference Profiles (eu-west-1, eu-central-1 etc.) ──
    { value: 'eu.anthropic.claude-3-7-sonnet-20250219-v1:0',  label: 'Claude 3.7 Sonnet — EU regions only' },
    { value: 'eu.anthropic.claude-3-5-sonnet-20241022-v2:0',  label: 'Claude 3.5 Sonnet v2 — EU regions only' },
    { value: 'eu.anthropic.claude-3-5-haiku-20241022-v1:0',   label: 'Claude 3.5 Haiku — EU regions only' },
    // ── Direct Model IDs (only in the model's home region, typically us-east-1) ──
    { value: 'anthropic.claude-sonnet-4-5-20250929-v1:0',    label: 'Claude Sonnet 4.5 — Direct (us-east-1)' },
    { value: 'anthropic.claude-3-5-sonnet-20241022-v2:0',    label: 'Claude 3.5 Sonnet v2 — Direct' },
    { value: 'anthropic.claude-3-5-haiku-20241022-v1:0',     label: 'Claude 3.5 Haiku — Direct' },
    // ── OpenAI OSS on Bedrock (US/EU/Tokyo/Mumbai only, not ap-southeast-1) ──
    { value: 'openai.gpt-oss-120b-1:0', label: 'GPT OSS 120B (US/EU/Tokyo/Mumbai only)' },
    { value: 'openai.gpt-oss-20b-1:0',  label: 'GPT OSS 20B (US/EU/Tokyo/Mumbai only)' }
  ]
};

const keyLinks = {
  openai: 'https://platform.openai.com/api-keys',
  claude: 'https://console.anthropic.com/settings/keys',
  gemini: 'https://aistudio.google.com/app/apikey',
  bedrock: 'https://docs.aws.amazon.com/bedrock/latest/userguide/setting-up.html'
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
  // Handle URL hash to switch to specific tab (e.g., options.html#help)
  const hash = window.location.hash.replace('#', '');
  if (hash) {
    const targetTab = document.querySelector(`.tab[data-tab="${hash}"]`);
    const targetContent = document.getElementById(`${hash}-tab`);
    if (targetTab && targetContent) {
      // Remove active from all tabs and content
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      // Activate the target tab
      targetTab.classList.add('active');
      targetContent.classList.add('active');
    }
  }

  // Test count slider live update
  document.getElementById('testCount')?.addEventListener('input', (e) => {
    document.getElementById('testCountValue').textContent = e.target.value;
  });
  const settings = await chrome.storage.sync.get([
    'llmProvider',
    'llmModel',
    'apiKey',
    'bedrockAccessKeyId',
    'bedrockSecretKey',
    'bedrockSessionToken',
    'bedrockRegion',
    'temperature',
    'maxTokens',
    'enableStreaming',
    'enableMultiAgent',
    'testCount',
    'enableContextAnalysisAgent',
    'enableRequirementAnalysisAgent',
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
    'jiraBaseUrl',
    'jiraEmail',
    'jiraApiToken',
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
    'fieldMappings',
    'confluenceUrl',
    'confluenceEmail',
    'confluenceToken',
    'figmaToken',
    'figmaImageMode',
    'googleApiKey',
    'googleAuthMode',
    'googleClientId',
    'googleClientSecret',
    'googleProjectId',
    'enableDuplicateDetection',
    'detectParameterizedUrls',
    'maxSamplesPerPattern',
    'useCrawledDataForTests'
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
  if (settings.bedrockSecretKey) {
    settings.bedrockSecretKey = await securityManager.decryptApiKeyFromStorage(settings.bedrockSecretKey);
  }
  if (settings.bedrockSessionToken) {
    settings.bedrockSessionToken = await securityManager.decryptApiKeyFromStorage(settings.bedrockSessionToken);
  }

  // API Settings
  if (settings.llmProvider) {
    document.getElementById('llmProvider').value = settings.llmProvider;
    updateModelOptions(settings.llmProvider);
    updateKeyLink(settings.llmProvider);
    toggleBedrockFields(settings.llmProvider);
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
  if (settings.bedrockAccessKeyId) {
    document.getElementById('bedrockAccessKeyId').value = settings.bedrockAccessKeyId;
    // Show warning hint if it's a temporary credential (ASIA prefix)
    toggleSessionTokenHint(settings.bedrockAccessKeyId);
  }
  if (settings.bedrockSecretKey) {
    document.getElementById('bedrockSecretKey').value = settings.bedrockSecretKey;
  }
  if (settings.bedrockSessionToken) {
    document.getElementById('bedrockSessionToken').value = settings.bedrockSessionToken;
  }
  if (settings.bedrockRegion) {
    document.getElementById('bedrockRegion').value = settings.bedrockRegion;
  }
  
  document.getElementById('temperature').value = settings.temperature || 0.7;
  document.getElementById('maxTokens').value = settings.maxTokens || 32768;
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
  document.getElementById('enableContextAnalysisAgent').checked = settings.enableContextAnalysisAgent !== false;
  document.getElementById('enableRequirementAnalysisAgent').checked = settings.enableRequirementAnalysisAgent !== false;
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
  document.getElementById('jiraBaseUrl').value = settings.jiraBaseUrl || '';
  document.getElementById('jiraEmail').value = settings.jiraEmail || '';
  document.getElementById('jiraApiToken').value = settings.jiraApiToken || '';

  // Test Management Platform
  const testMgmtPlatform = settings.testMgmtPlatform || 'none';
  document.getElementById('testMgmtPlatform').value = testMgmtPlatform;

  // Show/hide platform-specific configs
  document.querySelectorAll('.test-mgmt-config').forEach(el => el.style.display = 'none');
  if (testMgmtPlatform !== 'none') {
    const configId = testMgmtPlatform + '-config';
    const configEl = document.getElementById(configId);
    if (configEl) configEl.style.display = 'block';
    document.getElementById('field-mapping-section').style.display = 'block';
  }

  // TestRail
  document.getElementById('testrailUrl').value = settings.testrailUrl || '';
  document.getElementById('testrailUsername').value = settings.testrailUsername || '';
  document.getElementById('testrailApiKey').value = settings.testrailApiKey || '';
  document.getElementById('testrailProjectId').value = settings.testrailProjectId || '';
  document.getElementById('testrailSection').value = settings.testrailSection || 'QAtalyst_Automation';

  // Zephyr Scale
  document.getElementById('zephyrScaleApiToken').value = settings.zephyrScaleApiToken || '';
  document.getElementById('zephyrScaleProjectKey').value = settings.zephyrScaleProjectKey || '';
  document.getElementById('zephyrScaleFolderId').value = settings.zephyrScaleFolderId || '';

  // Zephyr Squad
  document.getElementById('zephyrSquadJiraUrl').value = settings.zephyrSquadJiraUrl || '';
  document.getElementById('zephyrSquadUsername').value = settings.zephyrSquadUsername || '';
  document.getElementById('zephyrSquadApiToken').value = settings.zephyrSquadApiToken || '';
  document.getElementById('zephyrSquadProjectKey').value = settings.zephyrSquadProjectKey || '';
  document.getElementById('zephyrSquadVersionId').value = settings.zephyrSquadVersionId || '-1';

  // Xray
  const xrayIsCloud = settings.xrayIsCloud !== false;
  if (xrayIsCloud) {
    document.getElementById('xrayCloud').checked = true;
    document.getElementById('xrayCloudConfig').style.display = 'block';
    document.getElementById('xrayServerConfig').style.display = 'none';
  } else {
    document.getElementById('xrayServer').checked = true;
    document.getElementById('xrayCloudConfig').style.display = 'none';
    document.getElementById('xrayServerConfig').style.display = 'block';
  }
  document.getElementById('xrayJiraUrl').value = settings.xrayJiraUrl || '';
  document.getElementById('xrayUsername').value = settings.xrayUsername || '';
  document.getElementById('xrayApiToken').value = settings.xrayApiToken || '';
  document.getElementById('xrayClientId').value = settings.xrayClientId || '';
  document.getElementById('xrayClientSecret').value = settings.xrayClientSecret || '';
  document.getElementById('xrayProjectKey').value = settings.xrayProjectKey || '';

  // qMetry
  const qmetryIsCloud = settings.qmetryIsCloud !== false;
  if (qmetryIsCloud) {
    document.getElementById('qmetryCloud').checked = true;
    document.getElementById('qmetryCloudConfig').style.display = 'block';
    document.getElementById('qmetryOnPremiseConfig').style.display = 'none';
  } else {
    document.getElementById('qmetryOnPremise').checked = true;
    document.getElementById('qmetryCloudConfig').style.display = 'none';
    document.getElementById('qmetryOnPremiseConfig').style.display = 'block';
  }
  document.getElementById('qmetryApiUrl').value = settings.qmetryApiUrl || '';
  document.getElementById('qmetryApiKey').value = settings.qmetryApiKey || '';
  document.getElementById('qmetryUsername').value = settings.qmetryUsername || '';
  document.getElementById('qmetryPassword').value = settings.qmetryPassword || '';
  document.getElementById('qmetryProjectId').value = settings.qmetryProjectId || '';
  document.getElementById('qmetryReleaseId').value = settings.qmetryReleaseId || '';

  // Load custom field mappings
  loadFieldMappings(settings.fieldMappings);

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

  // Crawler Settings (enabled by default)
  document.getElementById('enableDuplicateDetection').checked = settings.enableDuplicateDetection !== false;
  document.getElementById('detectParameterizedUrls').checked = settings.detectParameterizedUrls !== false;
  document.getElementById('maxSamplesPerPattern').value = settings.maxSamplesPerPattern || 1;
  document.getElementById('useCrawledDataForTests').checked = settings.useCrawledDataForTests !== false;

});

// Provider change handler
document.getElementById('llmProvider').addEventListener('change', (e) => {
  updateModelOptions(e.target.value);
  updateKeyLink(e.target.value);
  toggleBedrockFields(e.target.value);
});

function toggleBedrockFields(provider) {
  const apiKeyGroup = document.getElementById('apiKeyGroup');
  const bedrockGroup = document.getElementById('bedrockCredentialsGroup');
  if (provider === 'bedrock') {
    apiKeyGroup.style.display = 'none';
    bedrockGroup.style.display = 'block';
  } else {
    apiKeyGroup.style.display = 'block';
    bedrockGroup.style.display = 'none';
  }
}

// Show/hide the session token warning hint based on Access Key ID prefix
function toggleSessionTokenHint(accessKeyId) {
  const hint = document.getElementById('bedrockSessionTokenHint');
  if (!hint) return;
  // ASIA prefix = temporary STS credentials, session token is required
  hint.style.display = accessKeyId && accessKeyId.trim().toUpperCase().startsWith('ASIA') ? 'block' : 'none';
}

// Live hint toggle as user types the Access Key ID
document.getElementById('bedrockAccessKeyId').addEventListener('input', (e) => {
  toggleSessionTokenHint(e.target.value);
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

// Test Connection
document.getElementById('testConnectionBtn').addEventListener('click', async () => {
  const btn = document.getElementById('testConnectionBtn');
  const icon = document.getElementById('testConnectionIcon');
  const result = document.getElementById('testConnectionResult');

  const provider = document.getElementById('llmProvider').value;
  const model = document.getElementById('llmModel').value;

  // Collect credentials directly from UI (no need to save first)
  const credentials = {
    provider,
    model,
    apiKey: document.getElementById('apiKey').value.trim(),
    bedrockAccessKeyId: document.getElementById('bedrockAccessKeyId').value.trim(),
    bedrockSecretKey: document.getElementById('bedrockSecretKey').value.trim(),
    bedrockSessionToken: document.getElementById('bedrockSessionToken').value.trim(),
    bedrockRegion: document.getElementById('bedrockRegion').value
  };

  // Basic validation before sending
  if (provider === 'bedrock') {
    if (!credentials.bedrockAccessKeyId || !credentials.bedrockSecretKey) {
      showTestResult(result, false, 'Please enter your AWS Access Key ID and Secret Access Key.');
      return;
    }
    const isTemp = credentials.bedrockAccessKeyId.toUpperCase().startsWith('ASIA');
    if (isTemp && !credentials.bedrockSessionToken) {
      showTestResult(result, false, 'Temporary credentials (ASIA...) require a Session Token. Please enter it above.');
      return;
    }
  } else {
    if (!credentials.apiKey) {
      showTestResult(result, false, 'Please enter your API key.');
      return;
    }
  }

  // Show loading state
  btn.disabled = true;
  icon.textContent = '⏳';
  btn.style.opacity = '0.7';
  result.style.display = 'none';

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'testAIConnection',
      data: credentials
    });

    if (response && response.success) {
      showTestResult(result, true, response.message || 'Connection successful! Credentials are valid.');
    } else {
      showTestResult(result, false, response?.message || 'Connection failed. Please check your credentials.');
    }
  } catch (err) {
    showTestResult(result, false, `Error: ${err.message}`);
  } finally {
    btn.disabled = false;
    icon.textContent = '🔌';
    btn.style.opacity = '1';
  }
});

function showTestResult(el, success, message) {
  el.style.display = 'block';
  el.textContent = (success ? '✅ ' : '❌ ') + message;
  el.style.background = success ? '#f0fdf4' : '#fef2f2';
  el.style.color = success ? '#166534' : '#991b1b';
  el.style.borderColor = success ? '#86efac' : '#fca5a5';
}

// Save settings
document.getElementById('saveBtn').addEventListener('click', async () => {
  const settings = {
    // API Settings
    llmProvider: document.getElementById('llmProvider').value,
    llmModel: document.getElementById('llmModel').value,
    apiKey: document.getElementById('apiKey').value,
    bedrockAccessKeyId: document.getElementById('bedrockAccessKeyId').value,
    bedrockSecretKey: document.getElementById('bedrockSecretKey').value,
    bedrockSessionToken: document.getElementById('bedrockSessionToken').value,
    bedrockRegion: document.getElementById('bedrockRegion').value,
    temperature: parseFloat(document.getElementById('temperature').value),
    maxTokens: parseInt(document.getElementById('maxTokens').value),
    enableStreaming: document.getElementById('enableStreaming').checked,
    enableMultiAgent: document.getElementById('enableMultiAgent').checked,
    testCount: parseInt(document.getElementById('testCount').value),

    // Agent Configuration
    enableContextAnalysisAgent: document.getElementById('enableContextAnalysisAgent').checked,
    enableRequirementAnalysisAgent: document.getElementById('enableRequirementAnalysisAgent').checked,
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
    jiraBaseUrl: document.getElementById('jiraBaseUrl').value.trim(),
    jiraEmail: document.getElementById('jiraEmail').value.trim(),
    jiraApiToken: document.getElementById('jiraApiToken').value.trim(),

    // Test Management Integrations
    testMgmtPlatform: document.getElementById('testMgmtPlatform').value,
    testrailUrl: document.getElementById('testrailUrl').value,
    testrailUsername: document.getElementById('testrailUsername').value,
    testrailApiKey: document.getElementById('testrailApiKey').value,
    testrailProjectId: document.getElementById('testrailProjectId').value,
    testrailSection: document.getElementById('testrailSection').value,
    zephyrScaleApiToken: document.getElementById('zephyrScaleApiToken').value,
    zephyrScaleProjectKey: document.getElementById('zephyrScaleProjectKey').value,
    zephyrScaleFolderId: document.getElementById('zephyrScaleFolderId').value,
    zephyrSquadJiraUrl: document.getElementById('zephyrSquadJiraUrl').value,
    zephyrSquadUsername: document.getElementById('zephyrSquadUsername').value,
    zephyrSquadApiToken: document.getElementById('zephyrSquadApiToken').value,
    zephyrSquadProjectKey: document.getElementById('zephyrSquadProjectKey').value,
    zephyrSquadVersionId: document.getElementById('zephyrSquadVersionId').value,
    xrayIsCloud: document.getElementById('xrayCloud').checked,
    xrayJiraUrl: document.getElementById('xrayJiraUrl').value,
    xrayUsername: document.getElementById('xrayUsername').value,
    xrayApiToken: document.getElementById('xrayApiToken').value,
    xrayClientId: document.getElementById('xrayClientId').value,
    xrayClientSecret: document.getElementById('xrayClientSecret').value,
    xrayProjectKey: document.getElementById('xrayProjectKey').value,
    qmetryIsCloud: document.getElementById('qmetryCloud').checked,
    qmetryApiUrl: document.getElementById('qmetryApiUrl').value,
    qmetryApiKey: document.getElementById('qmetryApiKey').value,
    qmetryUsername: document.getElementById('qmetryUsername').value,
    qmetryPassword: document.getElementById('qmetryPassword').value,
    qmetryProjectId: document.getElementById('qmetryProjectId').value,
    qmetryReleaseId: document.getElementById('qmetryReleaseId').value,

    // Custom field mappings
    fieldMappings: JSON.stringify(getFieldMappings()),

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
    googleProjectId: document.getElementById('googleProjectId').value,

    // Crawler Settings
    enableDuplicateDetection: document.getElementById('enableDuplicateDetection').checked,
    detectParameterizedUrls: document.getElementById('detectParameterizedUrls').checked,
    maxSamplesPerPattern: parseInt(document.getElementById('maxSamplesPerPattern').value),
    useCrawledDataForTests: document.getElementById('useCrawledDataForTests').checked
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

  const jiraBaseUrlValidation = InputValidator.validateUrl(settings.jiraBaseUrl);
  if (!jiraBaseUrlValidation.valid) {
    validationErrors.push(`Jira Base URL: ${jiraBaseUrlValidation.error}`);
  } else if (jiraBaseUrlValidation.value) {
    settings.jiraBaseUrl = jiraBaseUrlValidation.value;
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
  if (settings.bedrockSecretKey && settings.bedrockSecretKey.trim()) {
    settings.bedrockSecretKey = await securityManager.encryptApiKeyForStorage(settings.bedrockSecretKey.trim());
  }
  if (settings.bedrockSessionToken && settings.bedrockSessionToken.trim()) {
    settings.bedrockSessionToken = await securityManager.encryptApiKeyForStorage(settings.bedrockSessionToken.trim());
  }

  // Debug logging before saving
  console.log('💾 Saving QAtalyst Settings:', {
    enableMultiAgent: settings.enableMultiAgent,
    enableEvolution: settings.enableEvolution,
    enableContextAnalysisAgent: settings.enableContextAnalysisAgent,
    enableRequirementAnalysisAgent: settings.enableRequirementAnalysisAgent,
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
  const jiraBaseUrl = document.getElementById('jiraBaseUrl').value.trim();
  const jiraEmail = document.getElementById('jiraEmail').value.trim();
  let jiraApiToken = document.getElementById('jiraApiToken').value.trim();
  const statusDiv = document.getElementById('authTestStatus');
  const button = document.getElementById('testJiraAuth');

  // Clear previous status
  statusDiv.innerHTML = '';

  // Validate inputs
  if (!jiraBaseUrl) {
    statusDiv.innerHTML = '<div style="color: #dc2626; font-size: 13px;">❌ Please enter Jira Base URL</div>';
    return;
  }
  if (!jiraEmail || !jiraApiToken) {
    statusDiv.innerHTML = '<div style="color: #dc2626; font-size: 13px;">❌ Please enter both Jira email and API token</div>';
    return;
  }

  // Validate email format
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(jiraEmail.trim())) {
    statusDiv.innerHTML = '<div style="color: #dc2626; font-size: 13px;">❌ Invalid email format. Please enter a valid email address.</div>';
    return;
  }

  // Validate token format (should start with ATATT for Atlassian tokens)
  const cleanToken = jiraApiToken.replace(/[\r\n\t]/g, '').trim();
  if (!cleanToken.startsWith('ATATT') && !cleanToken.startsWith('enc:')) {
    statusDiv.innerHTML = `
      <div style="background: #fef2f2; border: 1px solid #fecaca; padding: 10px; border-radius: 6px; font-size: 13px; color: #dc2626;">
        ⚠️ <strong>Warning: Token format looks incorrect</strong><br>
        Atlassian API tokens should start with <strong>"ATATT"</strong>.<br>
        Your token starts with: <strong>"${cleanToken.substring(0, 6)}..."</strong><br><br>
        <strong>Please verify:</strong><br>
        • You copied the entire token<br>
        • You're using an Atlassian API token (not a Zephyr or other token)<br>
        • Get it from: <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" style="color: #dc2626; text-decoration: underline;">Atlassian API Tokens</a><br><br>
        Click "Test Jira Authentication" again to continue anyway.
      </div>
    `;
    return;
  }

  // Check if the token is encrypted and decrypt it
  if (securityManager.isEncrypted(jiraApiToken)) {
    console.log('🔓 Token is encrypted, decrypting...');
    jiraApiToken = await securityManager.decryptApiKeyFromStorage(jiraApiToken);
  }

  // Validate URL format
  let baseUrl;
  try {
    baseUrl = new URL(jiraBaseUrl).origin;
  } catch (e) {
    statusDiv.innerHTML = '<div style="color: #dc2626; font-size: 13px;">❌ Invalid URL format. Use https://your-company.atlassian.net</div>';
    return;
  }

  // Disable button and show loading
  button.disabled = true;
  button.textContent = '🔄 Testing...';
  statusDiv.innerHTML = '<div style="color: #0ea5e9; font-size: 13px;">⏳ Testing authentication...</div>';

  try {

    // Construct API URL
    const apiUrl = `${baseUrl}/rest/api/3/myself`;

    // Build headers with Basic Auth
    let credentials;
    try {
      // Ensure token doesn't have any hidden characters
      const cleanToken = jiraApiToken.replace(/[\r\n\t]/g, '').trim();
      const cleanEmail = jiraEmail.replace(/[\r\n\t]/g, '').trim();

      credentials = btoa(`${cleanEmail}:${cleanToken}`);

      console.log('🔍 Testing Jira auth to:', apiUrl);
      console.log('📧 Email:', cleanEmail);
      console.log('🔑 Token length:', cleanToken.length);
      console.log('🔑 Token starts with:', cleanToken.substring(0, 10) + '...');
      console.log('🔑 Token ends with:', '...' + cleanToken.substring(cleanToken.length - 10));
    } catch (encodingError) {
      statusDiv.innerHTML = '<div style="color: #dc2626; font-size: 13px;">❌ Token encoding error: Please copy the token again without any extra characters</div>';
      return;
    }

    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'Authorization': `Basic ${credentials}`
    };

    // Make the request
    const response = await fetch(apiUrl, {
      method: 'GET',
      headers: headers,
      credentials: 'omit' // Don't use cookies, only API token
    });

    console.log('Auth test response status:', response.status);
    console.log('Auth test response headers:', {
      'content-type': response.headers.get('content-type'),
      'www-authenticate': response.headers.get('www-authenticate')
    });

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
          ${response.status === 401 ? `
            <strong style="color: #b91c1c;">⚠️ Most Common Issue - Email Mismatch:</strong><br>
            <div style="background: #fff; border-left: 3px solid #dc2626; padding: 8px; margin: 8px 0;">
              The email you entered (<strong>${jiraEmail.replace(/[\r\n\t]/g, '').trim()}</strong>) must <em>exactly</em> match your Atlassian account email.<br><br>
              <strong>To verify your email:</strong><br>
              1. Go to <a href="https://id.atlassian.com/manage-profile/profile-and-visibility" target="_blank" style="color: #dc2626; text-decoration: underline;">Atlassian Profile</a><br>
              2. Check the email address shown there<br>
              3. Use that <em>exact</em> email in this field<br>
              4. If your Atlassian account uses a different email (e.g., personal email instead of work email), you must use that one
            </div><br>
            <strong>Other Possible Issues:</strong><br>
            • <strong>Regenerate API token:</strong> Go to <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" style="color: #dc2626; text-decoration: underline;">Atlassian API Tokens</a>, delete the old token, and create a new one<br>
            • <strong>Token format:</strong> Should start with "ATATT3xFfG..." (not "enc:")<br>
            • <strong>Copy/paste carefully:</strong> Copy the entire token without any extra spaces or line breaks<br>
            • <strong>Base URL:</strong> Verify "${baseUrl}" is correct
          ` : ''}
          ${response.status === 403 ? '• You may not have permission to access this API<br>• Try regenerating your API token' : ''}
          ${response.status === 404 ? '• Jira URL may be incorrect<br>• Using URL: ' + baseUrl : ''}
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

// Test Management Platform Event Listeners

// Platform selector - show/hide platform configs
document.getElementById('testMgmtPlatform')?.addEventListener('change', (e) => {
  const platform = e.target.value;

  // Hide all platform configs
  document.querySelectorAll('.test-mgmt-config').forEach(el => el.style.display = 'none');

  // Show selected platform config
  if (platform !== 'none') {
    const configId = platform + '-config';
    const configEl = document.getElementById(configId);
    if (configEl) configEl.style.display = 'block';
    document.getElementById('field-mapping-section').style.display = 'block';
  }
});

// Xray platform toggle (Cloud vs Server)
document.querySelectorAll('input[name="xrayPlatform"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    const isCloud = e.target.value === 'cloud';
    document.getElementById('xrayCloudConfig').style.display = isCloud ? 'block' : 'none';
    document.getElementById('xrayServerConfig').style.display = isCloud ? 'none' : 'block';
  });
});

// qMetry platform toggle (Cloud vs On-Premise)
document.querySelectorAll('input[name="qmetryPlatform"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    const isCloud = e.target.value === 'cloud';
    document.getElementById('qmetryCloudConfig').style.display = isCloud ? 'block' : 'none';
    document.getElementById('qmetryOnPremiseConfig').style.display = isCloud ? 'none' : 'block';
  });
});

// Figma Image Mode toggle
document.querySelectorAll('input[name="figmaImageMode"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    const mode = e.target.value;
    const singleInfo = document.getElementById('figmaSingleModeInfo');
    const childrenInfo = document.getElementById('figmaChildrenModeInfo');

    if (mode === 'children') {
      if (singleInfo) singleInfo.style.display = 'none';
      if (childrenInfo) childrenInfo.style.display = 'block';
    } else {
      if (singleInfo) singleInfo.style.display = 'block';
      if (childrenInfo) childrenInfo.style.display = 'none';
    }
  });
});

// Google Auth Mode toggle
document.querySelectorAll('input[name="googleAuthMode"]').forEach(radio => {
  radio.addEventListener('change', (e) => {
    const mode = e.target.value;
    const publicMode = document.getElementById('googlePublicMode');
    const oauth2Mode = document.getElementById('googleOAuth2Mode');

    if (mode === 'oauth2') {
      if (publicMode) publicMode.style.display = 'none';
      if (oauth2Mode) oauth2Mode.style.display = 'block';
    } else {
      if (publicMode) publicMode.style.display = 'block';
      if (oauth2Mode) oauth2Mode.style.display = 'none';
    }
  });
});

// Test connection buttons for each platform

// TestRail
document.getElementById('testTestrail')?.addEventListener('click', async () => {
  const statusEl = document.getElementById('testrailStatus');
  statusEl.textContent = 'Testing connection...';
  statusEl.style.color = '#0ea5e9';

  const settings = {
    testrailUrl: document.getElementById('testrailUrl').value,
    testrailUsername: document.getElementById('testrailUsername').value,
    testrailApiKey: document.getElementById('testrailApiKey').value
  };

  if (!settings.testrailUrl || !settings.testrailUsername || !settings.testrailApiKey) {
    statusEl.textContent = '❌ Please fill in all required fields';
    statusEl.style.color = '#dc3545';
    return;
  }

  try {
    const integration = new TestRailIntegration(settings);
    await integration.testConnection();
    statusEl.textContent = '✅ Connection successful!';
    statusEl.style.color = '#28a745';
  } catch (error) {
    statusEl.textContent = `❌ ${error.message}`;
    statusEl.style.color = '#dc3545';
  }
});

// Zephyr Scale
document.getElementById('testZephyrScale')?.addEventListener('click', async () => {
  const statusEl = document.getElementById('zephyrScaleStatus');
  statusEl.textContent = 'Testing connection...';
  statusEl.style.color = '#0ea5e9';

  const settings = {
    zephyrScaleApiToken: document.getElementById('zephyrScaleApiToken').value,
    zephyrScaleProjectKey: document.getElementById('zephyrScaleProjectKey').value
  };

  if (!settings.zephyrScaleApiToken || !settings.zephyrScaleProjectKey) {
    statusEl.textContent = '❌ Please fill in all required fields';
    statusEl.style.color = '#dc3545';
    return;
  }

  try {
    const integration = new ZephyrScaleIntegration(settings);
    await integration.testConnection();
    statusEl.innerHTML = '<div style="color: #28a745;">✅ Connection successful!</div>';
  } catch (error) {
    // Format multi-line error messages nicely
    const errorHtml = error.message.replace(/\n/g, '<br>');
    statusEl.innerHTML = `
      <div style="background: #fef2f2; border: 1px solid #fecaca; padding: 12px; border-radius: 6px; font-size: 13px; color: #dc2626; white-space: pre-wrap;">
        ${errorHtml}
      </div>
    `;
  }
});

// Zephyr Squad
document.getElementById('testZephyrSquad')?.addEventListener('click', async () => {
  const statusEl = document.getElementById('zephyrSquadStatus');
  statusEl.textContent = 'Testing connection...';
  statusEl.style.color = '#0ea5e9';

  const settings = {
    zephyrSquadJiraUrl: document.getElementById('zephyrSquadJiraUrl').value,
    zephyrSquadUsername: document.getElementById('zephyrSquadUsername').value,
    zephyrSquadApiToken: document.getElementById('zephyrSquadApiToken').value,
    zephyrSquadProjectKey: document.getElementById('zephyrSquadProjectKey').value
  };

  if (!settings.zephyrSquadJiraUrl || !settings.zephyrSquadUsername || !settings.zephyrSquadApiToken) {
    statusEl.textContent = '❌ Please fill in all required fields';
    statusEl.style.color = '#dc3545';
    return;
  }

  try {
    const integration = new ZephyrSquadIntegration(settings);
    await integration.testConnection();
    statusEl.textContent = '✅ Connection successful!';
    statusEl.style.color = '#28a745';
  } catch (error) {
    statusEl.textContent = `❌ ${error.message}`;
    statusEl.style.color = '#dc3545';
  }
});

// Xray
document.getElementById('testXray')?.addEventListener('click', async () => {
  const statusEl = document.getElementById('xrayStatus');
  statusEl.textContent = 'Testing connection...';
  statusEl.style.color = '#0ea5e9';

  const isCloud = document.getElementById('xrayCloud').checked;
  const settings = {
    xrayIsCloud: isCloud,
    xrayJiraUrl: document.getElementById('xrayJiraUrl').value,
    xrayUsername: document.getElementById('xrayUsername').value,
    xrayApiToken: document.getElementById('xrayApiToken').value,
    xrayClientId: document.getElementById('xrayClientId').value,
    xrayClientSecret: document.getElementById('xrayClientSecret').value
  };

  if (isCloud && (!settings.xrayClientId || !settings.xrayClientSecret)) {
    statusEl.textContent = '❌ Please fill in Client ID and Secret for Cloud';
    statusEl.style.color = '#dc3545';
    return;
  }

  if (!isCloud && (!settings.xrayJiraUrl || !settings.xrayUsername || !settings.xrayApiToken)) {
    statusEl.textContent = '❌ Please fill in all required fields for Server';
    statusEl.style.color = '#dc3545';
    return;
  }

  try {
    const integration = new XrayIntegration(settings);
    await integration.testConnection();
    statusEl.textContent = '✅ Connection successful!';
    statusEl.style.color = '#28a745';
  } catch (error) {
    statusEl.textContent = `❌ ${error.message}`;
    statusEl.style.color = '#dc3545';
  }
});

// qMetry
document.getElementById('testQmetry')?.addEventListener('click', async () => {
  const statusEl = document.getElementById('qmetryStatus');
  statusEl.textContent = 'Testing connection...';
  statusEl.style.color = '#0ea5e9';

  const isCloud = document.getElementById('qmetryCloud').checked;
  const settings = {
    qmetryIsCloud: isCloud,
    qmetryApiUrl: document.getElementById('qmetryApiUrl').value,
    qmetryApiKey: document.getElementById('qmetryApiKey').value,
    qmetryUsername: document.getElementById('qmetryUsername').value,
    qmetryPassword: document.getElementById('qmetryPassword').value
  };

  if (isCloud && !settings.qmetryApiKey) {
    statusEl.textContent = '❌ Please enter API Key for Cloud';
    statusEl.style.color = '#dc3545';
    return;
  }

  if (!isCloud && (!settings.qmetryUsername || !settings.qmetryPassword)) {
    statusEl.textContent = '❌ Please fill in username and password for On-Premise';
    statusEl.style.color = '#dc3545';
    return;
  }

  try {
    const integration = new QmetryIntegration(settings);
    await integration.testConnection();
    statusEl.textContent = '✅ Connection successful!';
    statusEl.style.color = '#28a745';
  } catch (error) {
    statusEl.textContent = `❌ ${error.message}`;
    statusEl.style.color = '#dc3545';
  }
});

// Store fetched custom fields globally
let fetchedCustomFields = [];

// Fetch Custom Fields button
document.getElementById('fetchCustomFields')?.addEventListener('click', async () => {
  const statusEl = document.getElementById('fetchFieldsStatus');
  statusEl.textContent = 'Fetching custom fields...';
  statusEl.style.color = '#0ea5e9';

  const platform = document.getElementById('testMgmtPlatform').value;

  if (platform === 'none') {
    statusEl.textContent = '❌ Please select a test management platform first';
    statusEl.style.color = '#dc3545';
    return;
  }

  try {
    let integration;
    let fields;

    switch (platform) {
      case 'testrail':
        integration = new TestRailIntegration({
          testrailUrl: document.getElementById('testrailUrl').value,
          testrailUsername: document.getElementById('testrailUsername').value,
          testrailApiKey: document.getElementById('testrailApiKey').value
        });
        fields = await integration.getCustomFields();
        break;

      case 'zephyr-scale':
        integration = new ZephyrScaleIntegration({
          zephyrScaleApiToken: document.getElementById('zephyrScaleApiToken').value,
          zephyrScaleProjectKey: document.getElementById('zephyrScaleProjectKey').value
        });
        fields = await integration.getCustomFields();
        break;

      case 'zephyr-squad':
        integration = new ZephyrSquadIntegration({
          zephyrSquadJiraUrl: document.getElementById('zephyrSquadJiraUrl').value,
          zephyrSquadUsername: document.getElementById('zephyrSquadUsername').value,
          zephyrSquadApiToken: document.getElementById('zephyrSquadApiToken').value,
          zephyrSquadProjectKey: document.getElementById('zephyrSquadProjectKey').value
        });
        fields = await integration.getCustomFields();
        break;

      case 'xray':
        integration = new XrayIntegration({
          xrayIsCloud: document.getElementById('xrayCloud').checked,
          xrayJiraUrl: document.getElementById('xrayJiraUrl').value,
          xrayUsername: document.getElementById('xrayUsername').value,
          xrayApiToken: document.getElementById('xrayApiToken').value,
          xrayClientId: document.getElementById('xrayClientId').value,
          xrayClientSecret: document.getElementById('xrayClientSecret').value
        });
        fields = await integration.getCustomFields();
        break;

      case 'qmetry':
        integration = new QmetryIntegration({
          qmetryIsCloud: document.getElementById('qmetryCloud').checked,
          qmetryApiUrl: document.getElementById('qmetryApiUrl').value,
          qmetryApiKey: document.getElementById('qmetryApiKey').value,
          qmetryUsername: document.getElementById('qmetryUsername').value,
          qmetryPassword: document.getElementById('qmetryPassword').value,
          qmetryProjectId: document.getElementById('qmetryProjectId').value
        });
        fields = await integration.getCustomFields();
        break;
    }

    // Store fetched fields
    fetchedCustomFields = fields;

    // Display available fields in console and status
    console.log(`Available custom fields for ${platform}:`, fields);
    statusEl.textContent = `✅ Found ${fields.length} custom fields - Auto-populated in table below`;
    statusEl.style.color = '#28a745';

    // Auto-populate table with all fetched fields
    autoPopulateFieldMappings(fields);

  } catch (error) {
    statusEl.textContent = `❌ ${error.message}`;
    statusEl.style.color = '#dc3545';
  }
});

// Auto-populate table with all fetched custom fields
function autoPopulateFieldMappings(fields) {
  const table = document.getElementById('fieldMappingsTable');

  // Clear existing rows
  table.innerHTML = '';

  // Create a row for each custom field
  fields.forEach(field => {
    // Handle different API response formats
    const fieldName = field.name || field.label || field.system_name || field.key || field.id;
    // Prioritize system_name for TestRail custom fields (e.g., "custom_regression_case")
    const fieldId = field.system_name || field.key || field.name || field.id;

    // Convert field name to snake_case for QAtalyst field
    // e.g., "Automated Mobile Platform" → "automated_mobile_platform"
    const qatalystFieldName = normalizeFieldName(fieldName);

    const newRow = document.createElement('tr');
    newRow.setAttribute('data-mapping-id', qatalystFieldName);
    newRow.innerHTML = `
      <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">
        <input type="text" class="qatalyst-field-name" value="${qatalystFieldName}" placeholder="QAtalyst field name" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 4px;">
        <div style="font-size: 11px; color: #64748b; margin-top: 4px;">Original: ${fieldName}</div>
      </td>
      <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; text-align: center;">→</td>
      <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">
        <input type="text" class="testmgmt-field-input" value="${fieldId}" placeholder="Test management field ID" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 4px; display: block;">
        <div style="font-size: 11px; color: #64748b; margin-top: 4px;">
          ${field.type ? `Type: ${field.type}` : ''}
          ${field.description ? ` - ${field.description}` : ''}
        </div>
      </td>
      <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">
        <input type="text" class="field-value" placeholder="e.g., Android, Yes, API" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 4px;">
        <div style="font-size: 11px; color: #64748b; margin-top: 4px;">Value to use when uploading tests</div>
      </td>
      <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; text-align: center;">
        <button type="button" class="btn-remove-mapping" style="background: #ef4444; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;">Remove</button>
      </td>
    `;

    table.appendChild(newRow);
  });

  // Show a message if no fields were found
  if (fields.length === 0) {
    const emptyRow = document.createElement('tr');
    emptyRow.innerHTML = `
      <td colspan="5" style="padding: 24px; text-align: center; color: #64748b;">
        No custom fields found. Click "+ Add Custom Mapping" to add manual mappings.
      </td>
    `;
    table.appendChild(emptyRow);
  }
}

// Normalize field name to snake_case
function normalizeFieldName(name) {
  return name
    .toString()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_') // Replace non-alphanumeric with underscore
    .replace(/^_+|_+$/g, ''); // Remove leading/trailing underscores
}

// Handle dropdown change - show/hide text input
document.addEventListener('change', (e) => {
  if (e.target.classList.contains('testmgmt-field-select')) {
    const row = e.target.closest('tr');
    const textInput = row.querySelector('.testmgmt-field-input');

    if (e.target.value === '__custom__' || e.target.value === '') {
      textInput.style.display = 'block';
    } else {
      textInput.style.display = 'none';
      textInput.value = e.target.value; // Sync value
    }
  }
});

// Add Custom Mapping button
document.getElementById('addCustomMapping')?.addEventListener('click', () => {
  const table = document.getElementById('fieldMappingsTable');

  // Remove empty state message if it exists
  const emptyState = table.querySelector('tr td[colspan="5"]');
  if (emptyState) {
    table.innerHTML = '';
  }

  const newId = `mapping_${Date.now()}`;

  const newRow = document.createElement('tr');
  newRow.setAttribute('data-mapping-id', newId);
  newRow.innerHTML = `
    <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">
      <input type="text" class="qatalyst-field-name" placeholder="Enter QAtalyst field name" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 4px;">
    </td>
    <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; text-align: center;">→</td>
    <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">
      <input type="text" class="testmgmt-field-input" placeholder="Enter test management field ID" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 4px; display: block;">
    </td>
    <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">
      <input type="text" class="field-value" placeholder="e.g., Android, Yes, API" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 4px;">
    </td>
    <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; text-align: center;">
      <button type="button" class="btn-remove-mapping" style="background: #ef4444; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;">Remove</button>
    </td>
  `;

  table.appendChild(newRow);
});

// Remove mapping row
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('btn-remove-mapping')) {
    const row = e.target.closest('tr');
    row.remove();
  }
});

// Get all field mappings for saving
function getFieldMappings() {
  const mappings = {};
  const rows = document.querySelectorAll('#fieldMappingsTable tr');

  rows.forEach(row => {
    const qatalystField = row.querySelector('.qatalyst-field-name')?.value.trim();
    const select = row.querySelector('.testmgmt-field-select');
    const textInput = row.querySelector('.testmgmt-field-input');
    const valueInput = row.querySelector('.field-value');

    if (!qatalystField) return; // Skip if no QAtalyst field name

    // Get value from dropdown or text input
    let testMgmtField = '';
    if (select && select.value && select.value !== '__custom__' && select.value !== '') {
      testMgmtField = select.value;
    } else if (textInput && textInput.value.trim()) {
      testMgmtField = textInput.value.trim();
    }

    if (testMgmtField) {
      mappings[qatalystField] = {
        field: testMgmtField,
        value: valueInput ? valueInput.value.trim() : ''
      };
    }
  });

  return mappings;
}

// Load saved field mappings
function loadFieldMappings(fieldMappingsJson) {
  const table = document.getElementById('fieldMappingsTable');

  if (!fieldMappingsJson) {
    // Show empty state message
    showEmptyFieldMappingsState();
    return;
  }

  try {
    const mappings = JSON.parse(fieldMappingsJson);

    // Clear existing rows
    table.innerHTML = '';

    // If no mappings saved, show empty state
    if (Object.keys(mappings).length === 0) {
      showEmptyFieldMappingsState();
      return;
    }

    // Create rows for each saved mapping
    Object.entries(mappings).forEach(([qatalystField, mapping]) => {
      // Handle both old format (string) and new format (object with field and value)
      let testMgmtField, fieldValue;
      if (typeof mapping === 'string') {
        // Old format: just the field ID
        testMgmtField = mapping;
        fieldValue = '';
      } else {
        // New format: object with field and value
        testMgmtField = mapping.field || mapping;
        fieldValue = mapping.value || '';
      }

      const newRow = document.createElement('tr');
      newRow.setAttribute('data-mapping-id', qatalystField);
      newRow.innerHTML = `
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">
          <input type="text" class="qatalyst-field-name" value="${qatalystField}" placeholder="QAtalyst field name" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 4px;">
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; text-align: center;">→</td>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">
          <input type="text" class="testmgmt-field-input" value="${testMgmtField}" placeholder="Test management field ID" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 4px; display: block;">
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0;">
          <input type="text" class="field-value" value="${fieldValue}" placeholder="e.g., Android, Yes, API" style="width: 100%; padding: 8px; border: 1px solid #cbd5e1; border-radius: 4px;">
        </td>
        <td style="padding: 12px; border-bottom: 1px solid #e2e8f0; text-align: center;">
          <button type="button" class="btn-remove-mapping" style="background: #ef4444; color: white; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;">Remove</button>
        </td>
      `;

      table.appendChild(newRow);
    });
  } catch (error) {
    console.error('Failed to load field mappings:', error);
    showEmptyFieldMappingsState();
  }
}

// Show empty state for field mappings
function showEmptyFieldMappingsState() {
  const table = document.getElementById('fieldMappingsTable');
  table.innerHTML = `
    <tr>
      <td colspan="5" style="padding: 32px; text-align: center; color: #64748b; background: #f8fafc;">
        <div style="font-size: 14px; font-weight: 500; margin-bottom: 8px;">No field mappings yet</div>
        <div style="font-size: 13px;">Click "Fetch Custom Fields" to auto-populate from your test management system,<br>or click "+ Add Custom Mapping" to add manually.</div>
      </td>
    </tr>
  `;
}
