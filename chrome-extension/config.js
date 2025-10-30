// QAtalyst Configuration Constants
// Centralized configuration for the extension

// API Request Configuration
const CONFIG = {
  // Timeouts
  REQUEST_TIMEOUT: 90000, // 90 seconds for AI responses
  RETRY_DELAY: 2000, // 2 seconds between retries
  MAX_RETRIES: 2,

  // Rate Limiting
  FIGMA_RATE_LIMIT_DELAY: 1000, // 1 second between Figma requests
  MAX_CONCURRENT_REQUESTS: 5,

  // AI Provider Defaults
  DEFAULT_TEMPERATURE: 0.7,
  DEFAULT_MAX_TOKENS: 4000,
  DEFAULT_TEST_COUNT: 30,
  MIN_TEST_COUNT: 20,
  MAX_TEST_COUNT: 100,

  // Model Defaults
  DEFAULT_MODELS: {
    openai: 'gpt-4o',
    claude: 'claude-3-5-sonnet-20241022',
    gemini: 'gemini-2.0-flash-exp'
  },

  // API Endpoints
  ENDPOINTS: {
    openai: 'https://api.openai.com/v1/chat/completions',
    claude: 'https://api.anthropic.com/v1/messages',
    gemini: 'https://generativelanguage.googleapis.com/v1beta/models'
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
    ENCRYPTION_SALT: 'encryptionSalt'
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
Object.freeze(CONFIG);
Object.freeze(CONFIG.EVOLUTION_INTENSITY);
Object.freeze(CONFIG.TEST_DISTRIBUTION);
Object.freeze(CONFIG.UI);
Object.freeze(CONFIG.STORAGE_KEYS);
Object.freeze(CONFIG.ERRORS);
Object.freeze(CONFIG.SECURITY);
Object.freeze(CONFIG.COMPLEXITY_THRESHOLDS);
Object.freeze(CONFIG.GAP_CATEGORIES);
Object.freeze(CONFIG.DEFAULT_MODELS);
Object.freeze(CONFIG.ENDPOINTS);
