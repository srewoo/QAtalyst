/**
 * Token Counter and Monitoring for QAtalyst
 * Provides token estimation and warnings for LLM API calls
 */

/**
 * Token limits for different models (exact match lookup)
 */
const TOKEN_LIMITS = {
  // OpenAI GPT-5.x family
  'gpt-5.2':      { max: 400000, safe: 380000 },
  'gpt-5.2-mini': { max: 400000, safe: 380000 },
  // OpenAI reasoning models
  'o3':           { max: 200000, safe: 190000 },
  'o4-mini':      { max: 200000, safe: 190000 },
  // OpenAI GPT-4.1 family — 1M context window, 32K max output (released April 2025)
  'gpt-4.1':      { max: 1047576, safe: 1000000 },
  'gpt-4.1-mini': { max: 1047576, safe: 1000000 },
  'gpt-4.1-nano': { max: 1047576, safe: 1000000 },
  // Legacy OpenAI models
  'gpt-4-turbo': { max: 128000, safe: 120000 },
  'gpt-4':       { max: 8192,   safe: 7500    },
  'gpt-3.5-turbo': { max: 16385, safe: 15000 },

  // Claude
  'claude-sonnet-4-20250514': { max: 200000, safe: 190000 },
  'claude-3-5-sonnet-20241022': { max: 200000, safe: 190000 },
  'claude-3-opus-20240229': { max: 200000, safe: 190000 },

  // Gemini
  'gemini-2.5-pro-exp-03': { max: 1000000, safe: 950000 },
  'gemini-2.5-flash-exp': { max: 1000000, safe: 950000 },
  'gemini-2.0-flash-exp': { max: 1000000, safe: 950000 },
  'gemini-1.5-pro': { max: 2000000, safe: 1900000 },

  // Bedrock Claude models
  'anthropic.claude-sonnet-4-5-20250514-v1:0': { max: 200000, safe: 190000 },
  'anthropic.claude-3-5-sonnet-20241022-v2:0': { max: 200000, safe: 190000 },
  'anthropic.claude-3-opus-20240229-v1:0': { max: 200000, safe: 190000 },

  // Bedrock OpenAI models
  'us.openai.gpt-4.1-2025-04-14-v1:0': { max: 128000, safe: 120000 },
  'us.openai.o3-2025-04-16-v1:0': { max: 200000, safe: 190000 }
};

/**
 * Prefix-based fallback for model families not in TOKEN_LIMITS
 */
const MODEL_FAMILY_LIMITS = [
  { prefix: 'anthropic.claude',      limits: { max: 200000,  safe: 190000  } },
  { prefix: 'global.anthropic',      limits: { max: 200000,  safe: 190000  } },
  { prefix: 'us.openai.o3',         limits: { max: 200000,  safe: 190000  } },
  { prefix: 'openai.gpt-oss',       limits: { max: 128000,  safe: 120000  } },
  { prefix: 'us.openai.gpt',        limits: { max: 128000,  safe: 120000  } },
  { prefix: 'claude-',              limits: { max: 200000,  safe: 190000  } },
  { prefix: 'gpt-5',               limits: { max: 400000,  safe: 380000  } },
  { prefix: 'o3',                  limits: { max: 200000,  safe: 190000  } },
  { prefix: 'o4',                  limits: { max: 200000,  safe: 190000  } },
  // gpt-4.1 family has 1M context; keep gpt-4 (legacy) separate below
  { prefix: 'gpt-4.1',             limits: { max: 1047576, safe: 1000000 } },
  { prefix: 'gpt-4',               limits: { max: 128000,  safe: 120000  } },
  { prefix: 'gpt-3',               limits: { max: 16385,   safe: 15000   } },
  { prefix: 'gemini-',             limits: { max: 1000000, safe: 950000  } },
];

/**
 * Get token limits for a model, with prefix-matching fallback
 * @param {string} model - Model name/ID
 * @returns {{ max: number, safe: number }}
 */
function getModelLimits(model) {
  if (!model) return { max: 128000, safe: 120000 };

  // Exact match first
  if (TOKEN_LIMITS[model]) return TOKEN_LIMITS[model];

  // Prefix-based family matching
  for (const { prefix, limits } of MODEL_FAMILY_LIMITS) {
    if (model.startsWith(prefix)) return limits;
  }

  // Safe default (128K covers most modern models)
  return { max: 128000, safe: 120000 };
}

/**
 * Estimate token count from text
 * Uses ~4 characters per token approximation (standard BPE heuristic)
 *
 * @param {string} text - Text to estimate tokens for
 * @returns {number} - Estimated token count
 */
function estimateTokenCount(text) {
  if (!text || typeof text !== 'string') {
    return 0;
  }

  // Standard BPE approximation: ~4 characters per token for English text
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens for messages array (OpenAI/Claude format)
 * @param {Array} messages - Array of message objects
 * @returns {number} - Estimated token count
 */
function estimateMessagesTokens(messages) {
  if (!Array.isArray(messages)) {
    return 0;
  }

  let total = 0;

  messages.forEach(msg => {
    // Count role tokens
    total += 4; // Overhead for message structure

    if (typeof msg.content === 'string') {
      total += estimateTokenCount(msg.content);
    } else if (Array.isArray(msg.content)) {
      msg.content.forEach(part => {
        if (part.type === 'text') {
          total += estimateTokenCount(part.text);
        } else if (part.type === 'image' || part.type === 'image_url') {
          // Images typically count as ~1000-2000 tokens depending on size
          total += 1500;
        }
      });
    }
  });

  return total;
}

/**
 * Check if token count is safe for the model
 * @param {number} tokenCount - Estimated token count
 * @param {string} model - Model name
 * @param {number} maxOutputTokens - Max output tokens requested
 * @returns {Object} - { safe: boolean, limit: number, warning: string }
 */
function checkTokenLimit(tokenCount, model, maxOutputTokens = 4000) {
  const limits = getModelLimits(model);
  const totalRequired = tokenCount + maxOutputTokens;

  if (totalRequired > limits.max) {
    return {
      safe: false,
      limit: limits.max,
      warning: `Token limit exceeded! Input: ${tokenCount}, Output: ${maxOutputTokens}, Total: ${totalRequired} > Limit: ${limits.max}. Request will fail.`
    };
  }

  if (totalRequired > limits.safe) {
    return {
      safe: true,
      limit: limits.max,
      warning: `Token count is high. Input: ${tokenCount}, Output: ${maxOutputTokens}, Total: ${totalRequired}. Approaching limit: ${limits.max}. Consider reducing content.`
    };
  }

  return {
    safe: true,
    limit: limits.max,
    warning: null
  };
}

/**
 * Log token usage statistics
 * @param {string} operation - Operation name
 * @param {number} inputTokens - Estimated input tokens
 * @param {number} outputTokens - Estimated output tokens
 * @param {string} model - Model name
 */
function logTokenUsage(operation, inputTokens, outputTokens, model) {
  const total = inputTokens + outputTokens;
  const limits = getModelLimits(model);
  const percentage = ((total / limits.max) * 100).toFixed(1);

  console.log(`📊 Token Usage [${operation}]:`, {
    model,
    input: inputTokens,
    output: outputTokens,
    total: total,
    limit: limits.max,
    usage: `${percentage}%`
  });

  // Warn if approaching limits
  if (total > limits.safe) {
    console.warn(`⚠️ High token usage for ${operation}: ${total}/${limits.max} tokens (${percentage}%)`);
  }
}

/**
 * Truncate text to fit within token limit
 * @param {string} text - Text to truncate
 * @param {number} maxTokens - Maximum tokens allowed
 * @returns {string} - Truncated text
 */
function truncateToTokenLimit(text, maxTokens) {
  const estimatedTokens = estimateTokenCount(text);

  if (estimatedTokens <= maxTokens) {
    return text;
  }

  // Calculate how many characters to keep (~4 chars per token, with 5% safety margin)
  const targetChars = Math.floor(maxTokens * 4 * 0.95);

  const truncated = text.substring(0, targetChars);
  console.warn(`⚠️ Text truncated from ${estimatedTokens} to ~${maxTokens} tokens`);

  return truncated + '\n\n[... content truncated due to token limit ...]';
}

/**
 * Get token statistics for current request
 * @param {Object} requestData - Request data
 * @param {string} model - Model name
 * @returns {Object} - Statistics object
 */
function getTokenStatistics(requestData, model) {
  let inputTokens = 0;

  if (typeof requestData === 'string') {
    inputTokens = estimateTokenCount(requestData);
  } else if (Array.isArray(requestData)) {
    // Could be messages or content parts
    if (requestData.length > 0 && requestData[0].role) {
      // Messages format
      inputTokens = estimateMessagesTokens(requestData);
    } else {
      // Content parts
      requestData.forEach(part => {
        if (typeof part === 'string') {
          inputTokens += estimateTokenCount(part);
        } else if (part.type === 'text') {
          inputTokens += estimateTokenCount(part.text);
        } else if (part.type === 'image' || part.type === 'image_url') {
          inputTokens += 1500;
        }
      });
    }
  } else if (typeof requestData === 'object') {
    // Stringify and estimate
    inputTokens = estimateTokenCount(JSON.stringify(requestData));
  }

  const limits = getModelLimits(model);

  return {
    inputTokens,
    model,
    limit: limits.max,
    safeLimit: limits.safe,
    percentage: ((inputTokens / limits.max) * 100).toFixed(1),
    remaining: limits.max - inputTokens
  };
}
