/**
 * Token Counter and Monitoring for QAtalyst
 * Provides token estimation and warnings for LLM API calls
 */

/**
 * Token limits for different models
 */
const TOKEN_LIMITS = {
  // OpenAI
  'gpt-4.1': { max: 128000, safe: 120000 },
  'gpt-4.1-mini': { max: 128000, safe: 120000 },
  'gpt-4-turbo': { max: 128000, safe: 120000 },
  'gpt-4': { max: 8192, safe: 7500 },
  'gpt-3.5-turbo': { max: 16385, safe: 15000 },

  // Claude
  'claude-sonnet-4-20250514': { max: 200000, safe: 190000 },
  'claude-3-5-sonnet-20241022': { max: 200000, safe: 190000 },
  'claude-3-opus-20240229': { max: 200000, safe: 190000 },

  // Gemini
  'gemini-2.5-flash-exp': { max: 1000000, safe: 950000 },
  'gemini-2.0-flash-exp': { max: 1000000, safe: 950000 },
  'gemini-1.5-pro': { max: 2000000, safe: 1900000 }
};

/**
 * Estimate token count from text
 * Uses a rough approximation: ~4 characters per token for English text
 * This is not perfect but good enough for warnings
 *
 * @param {string} text - Text to estimate tokens for
 * @returns {number} - Estimated token count
 */
function estimateTokenCount(text) {
  if (!text || typeof text !== 'string') {
    return 0;
  }

  // Basic estimation: 4 characters ≈ 1 token for English
  // Adjust for whitespace and common patterns
  const chars = text.length;
  const words = text.split(/\s+/).length;

  // More sophisticated estimation
  // Average: 0.75 tokens per word, plus overhead for formatting
  const estimated = Math.ceil((words * 0.75) + (chars / 100));

  return estimated;
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
  const limits = TOKEN_LIMITS[model] || { max: 8000, safe: 7000 };
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
  const limits = TOKEN_LIMITS[model] || { max: 8000, safe: 7000 };
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

  // Calculate how many characters to keep (rough approximation)
  const ratio = maxTokens / estimatedTokens;
  const targetChars = Math.floor(text.length * ratio * 0.95); // 95% to be safe

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

  const limits = TOKEN_LIMITS[model] || { max: 8000, safe: 7000 };

  return {
    inputTokens,
    model,
    limit: limits.max,
    safeLimit: limits.safe,
    percentage: ((inputTokens / limits.max) * 100).toFixed(1),
    remaining: limits.max - inputTokens
  };
}
