// QAtalyst Configuration Constants
// Application-level constants (legacy)
// Note: For crawler/embedding config, see config.json and config-loader.js

// Prevent redeclaration errors if script is injected multiple times
if (typeof APP_CONFIG === 'undefined') {
  // API Request Configuration
  var APP_CONFIG = {
  // Timeouts
  REQUEST_TIMEOUT: 120000, // 120 seconds (2 minutes) for AI responses - Increased to handle large batch requests
  RETRY_DELAY: 2000, // 2 seconds between retries
  MAX_RETRIES: 2,

  // Text Extraction Limits
  MAX_TEXT_EXTRACT_LENGTH: 30000, // 30,000 characters

  // Figma Image Extraction Limits
  MAX_FIGMA_IMAGES: 50, // Increased from 20 to capture more screens
  MIN_FIGMA_IMAGE_SIZE_KB: 5, // 5 KB

  // Rate Limiting
  FIGMA_RATE_LIMIT_DELAY: 1000, // 1 second between Figma requests
  MAX_CONCURRENT_REQUESTS: 5,

  // AI Provider Defaults
  DEFAULT_TEMPERATURE: 0.7,
  DEFAULT_MAX_TOKENS: 32768, // GPT-4.1 / Claude 3.5 max output (previously 16000 for gpt-4o)
  DEFAULT_TEST_COUNT: 30,
  MIN_TEST_COUNT: 20,
  MAX_TEST_COUNT: 100,

  // Model Defaults
  DEFAULT_MODELS: {
    openai: 'gpt-5.2',
    claude: 'claude-sonnet-4-6',
    gemini: 'gemini-2.5-flash',
    bedrock: 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'
  },

  // Vision models that support image inputs (single source of truth)
  VISION_MODELS: [
    'gpt-5.2', 'gpt-5.2-mini', 'gpt-5', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano', 'o3', 'o4-mini', 'o1',
    'claude-opus-4', 'claude-sonnet-4', 'claude-haiku-4', 'claude-3-7-sonnet', 'claude-3-5-sonnet', 'claude-3-opus', 'claude-3-sonnet',
    'gemini-pro-vision', 'gemini-1.5-pro', 'gemini-2.5-pro', 'gemini-2.5-flash',
    'anthropic.claude', 'global.anthropic.claude', 'us.anthropic.claude', 'eu.anthropic.claude',
    'openai.gpt-oss'
  ],

  // API Endpoints
  ENDPOINTS: {
    openai: 'https://api.openai.com/v1/chat/completions',
    claude: 'https://api.anthropic.com/v1/messages',
    gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
    bedrock: 'https://bedrock-runtime.{region}.amazonaws.com'
  },

  // Evolution Settings
  EVOLUTION_INTENSITY: {
    light: { generations: 3, populationSize: 3, mutationRate: 0.3 },
    balanced: { generations: 5, populationSize: 5, mutationRate: 0.4 },
    intensive: { generations: 8, populationSize: 7, mutationRate: 0.5 },
    exhaustive: { generations: 10, populationSize: 10, mutationRate: 0.6 }
  },

  // Test Distribution
  TEST_DISTRIBUTION: {
    positive: 0.40,    // 40%
    negative: 0.30,    // 30%
    edge: 0.20,        // 20%
    regression: 0.05,  // 5%
    integration: 0.05  // 5%
  },

  // UI Configuration
  UI: {
    PANEL_WIDTH: '400px',
    ANIMATION_DURATION: 300,
    DEBOUNCE_DELAY: 500,
    MAX_DISPLAY_LENGTH: 10000 // Max characters to display in UI
  },

  // Storage Keys
  STORAGE_KEYS: {
    API_KEY: 'apiKey',
    LLM_PROVIDER: 'llmProvider',
    LLM_MODEL: 'llmModel',
    TEMPERATURE: 'temperature',
    MAX_TOKENS: 'maxTokens',
    TEST_COUNT: 'testCount',
    ENABLE_STREAMING: 'enableStreaming',
    ENABLE_MULTI_AGENT: 'enableMultiAgent',
    ENABLE_EVOLUTION: 'enableEvolution',
    ENABLE_ENHANCED: 'enableEnhanced',
    EVOLUTION_INTENSITY: 'evolutionIntensity',
    CONFLUENCE_URL: 'confluenceUrl',
    CONFLUENCE_TOKEN: 'confluenceToken',
    FIGMA_TOKEN: 'figmaToken',
    GOOGLE_API_KEY: 'googleApiKey',
    ENCRYPTED_KEYS: 'encryptedKeys', // For encrypted API keys
    ENCRYPTION_SALT: 'encryptionSalt',
    BEDROCK_ACCESS_KEY_ID: 'bedrockAccessKeyId',
    BEDROCK_SECRET_KEY: 'bedrockSecretKey',
    BEDROCK_REGION: 'bedrockRegion'
  },

  // Error Messages
  ERRORS: {
    NO_API_KEY: 'API Key is required. Please configure it in extension settings.',
    NO_PROVIDER: 'LLM Provider is required. Please select one in settings.',
    NO_MODEL: 'LLM Model is required. Please select one in settings.',
    TIMEOUT: 'Request timeout - AI is taking too long. Please try again.',
    PARSE_ERROR: 'Failed to parse AI response. Please try again.',
    NETWORK_ERROR: 'Network error. Please check your connection and try again.',
    RATE_LIMIT: 'Rate limit exceeded. Please wait a moment and try again.',
    INVALID_RESPONSE: 'Invalid response from AI. Please try again.'
  },

  // Security
  SECURITY: {
    ENCRYPTION_ALGORITHM: 'AES-GCM',
    KEY_LENGTH: 256,
    IV_LENGTH: 12,
    SALT_LENGTH: 16,
    PBKDF2_ITERATIONS: 100000,
    // Allowed HTML tags for sanitization
    ALLOWED_HTML_TAGS: ['p', 'br', 'strong', 'em', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'code', 'pre', 'a', 'span', 'div'],
    ALLOWED_ATTRIBUTES: ['class', 'id', 'href', 'target']
  },

  // Complexity Scaling
  COMPLEXITY_THRESHOLDS: {
    low: 30,      // < 30: Simple ticket
    medium: 60,   // 30-60: Medium complexity
    high: 80,     // 60-80: High complexity
    veryHigh: 100 // > 80: Very high complexity
  },

  // Gap Analysis
  GAP_CATEGORIES: [
    'Security Testing',
    'Performance Testing',
    'Accessibility Testing',
    'Error Handling',
    'Data Validation',
    'Integration Points',
    'Edge Cases',
    'User Experience'
  ]
  };

  // Freeze the config to prevent modifications
  Object.freeze(APP_CONFIG);
  Object.freeze(APP_CONFIG.EVOLUTION_INTENSITY);
  Object.freeze(APP_CONFIG.TEST_DISTRIBUTION);
  Object.freeze(APP_CONFIG.UI);
  Object.freeze(APP_CONFIG.STORAGE_KEYS);
  Object.freeze(APP_CONFIG.ERRORS);
  Object.freeze(APP_CONFIG.SECURITY);
  Object.freeze(APP_CONFIG.COMPLEXITY_THRESHOLDS);
  Object.freeze(APP_CONFIG.GAP_CATEGORIES);
  Object.freeze(APP_CONFIG.DEFAULT_MODELS);
  Object.freeze(APP_CONFIG.ENDPOINTS);
  Object.freeze(APP_CONFIG.VISION_MODELS);

  // Make globally available (works in both window and service worker contexts)
  if (typeof window !== 'undefined') {
    window.APP_CONFIG = APP_CONFIG;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.APP_CONFIG = APP_CONFIG;
  }
}
