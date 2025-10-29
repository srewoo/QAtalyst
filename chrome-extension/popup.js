// Popup script for quick settings

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

// Load saved settings
document.addEventListener('DOMContentLoaded', async () => {
  const settings = await chrome.storage.sync.get([
    'llmProvider',
    'llmModel',
    'apiKey',
    'testrailUrl',
    'confluenceUrl'
  ]);
  
  if (settings.llmProvider) {
    document.getElementById('llmProvider').value = settings.llmProvider;
    updateModelOptions(settings.llmProvider);
  } else {
    updateModelOptions('openai');
  }
  
  if (settings.llmModel) {
    document.getElementById('llmModel').value = settings.llmModel;
  }
  
  if (settings.apiKey) {
    document.getElementById('apiKey').value = settings.apiKey;
  }
  
  if (settings.testrailUrl) {
    document.getElementById('testrailUrl').value = settings.testrailUrl;
  }
  
  if (settings.confluenceUrl) {
    document.getElementById('confluenceUrl').value = settings.confluenceUrl;
  }
});

// Provider change handler
document.getElementById('llmProvider').addEventListener('change', (e) => {
  updateModelOptions(e.target.value);
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

// Save settings
document.getElementById('saveBtn').addEventListener('click', async () => {
  const settings = {
    llmProvider: document.getElementById('llmProvider').value,
    llmModel: document.getElementById('llmModel').value,
    apiKey: document.getElementById('apiKey').value,
    testrailUrl: document.getElementById('testrailUrl').value,
    confluenceUrl: document.getElementById('confluenceUrl').value
  };
  
  await chrome.storage.sync.set(settings);
  
  const statusDiv = document.getElementById('status');
  statusDiv.className = 'status success';
  statusDiv.textContent = '✅ Settings saved successfully!';
  
  setTimeout(() => {
    statusDiv.textContent = '';
  }, 3000);
});

// Open full options page
document.getElementById('openOptionsBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
