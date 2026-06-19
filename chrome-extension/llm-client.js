/**
 * llm-client.js (v13.3) — non-streaming LLM provider clients extracted from the
 * background service worker (continuing the background.js decomposition).
 *
 * Contains callAI() and the per-provider callers (OpenAI/Gemini/Claude/Bedrock).
 * Streaming variants intentionally remain in background.js for now (they share
 * mutable stream state and lack test coverage; moving them needs streaming tests
 * first). IIFE-wrapped so it adds no global bindings beyond the functions it
 * exposes. Depends on globals provided by the worker at call time: fetch,
 * AbortController, APP_CONFIG, the token-counter functions (checkTokenLimit,
 * estimateMessagesTokens), and the helpers awsSignRequest / parseDataUri /
 * isBedrockOpenAIModel / sleep (all top-level functions in background.js).
 */
(function () {
const _cfg = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG) || (typeof self !== 'undefined' && self.APP_CONFIG) || {};
const MAX_RETRIES = _cfg.MAX_RETRIES != null ? _cfg.MAX_RETRIES : 3;
const REQUEST_TIMEOUT = _cfg.REQUEST_TIMEOUT != null ? _cfg.REQUEST_TIMEOUT : 60000;
const RETRY_DELAY = _cfg.RETRY_DELAY != null ? _cfg.RETRY_DELAY : 1000;
const STREAMING_TIMEOUT_MS = 300000;
const MAX_STREAMING_ITERATIONS = 50000;
// Shared with background.js's stop/diagnostic handlers (same Map instance).
const activeStreams = (typeof self !== 'undefined') ? (self.activeStreams = self.activeStreams || new Map()) : new Map();

async function callBedrock(systemMessage, userContent, settings, retries = MAX_RETRIES) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const model = settings.llmModel || APP_CONFIG.DEFAULT_MODELS.bedrock;
    const region = settings.bedrockRegion || 'us-east-1';
    const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/invoke`;
    const isOpenAI = isBedrockOpenAIModel(model);

    let requestBody;

    if (isOpenAI) {
      // OpenAI models on Bedrock use OpenAI-compatible chat completion format
      const openaiUserContent = [];
      for (const part of userContent) {
        if (typeof part === 'string') {
          openaiUserContent.push({ type: 'text', text: part });
        } else if (part.type === 'text') {
          openaiUserContent.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
          openaiUserContent.push({ type: 'image_url', image_url: { url: part.image_url.url } });
        }
      }

      const openaiMessages = [];
      if (systemMessage) {
        openaiMessages.push({ role: 'system', content: systemMessage });
      }
      openaiMessages.push({ role: 'user', content: openaiUserContent });

      requestBody = JSON.stringify({
        max_tokens: settings.maxTokens || APP_CONFIG.DEFAULT_MAX_TOKENS,
        messages: openaiMessages,
        temperature: settings.temperature || APP_CONFIG.DEFAULT_TEMPERATURE
      });
    } else {
      // Claude/Anthropic models on Bedrock — use system parameter
      const claudeUserContent = [];
      for (const part of userContent) {
        if (typeof part === 'string') {
          claudeUserContent.push({ type: 'text', text: part });
        } else if (part.type === 'text') {
          claudeUserContent.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
          const { base64Data, mediaType } = parseDataUri(part.image_url.url);
          if (base64Data) {
            claudeUserContent.push({
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64Data }
            });
          }
        }
      }

      const bedrockBody = {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: settings.maxTokens || APP_CONFIG.DEFAULT_MAX_TOKENS,
        messages: [{ role: 'user', content: claudeUserContent }],
        temperature: settings.temperature || APP_CONFIG.DEFAULT_TEMPERATURE
      };

      if (systemMessage) {
        bedrockBody.system = [{ type: 'text', text: systemMessage }];
      }

      requestBody = JSON.stringify(bedrockBody);
    }

    const headers = { 'Content-Type': 'application/json' };
    await awsSignRequest({
      method: 'POST',
      url,
      headers,
      body: requestBody,
      region,
      accessKeyId: settings.bedrockAccessKeyId,
      secretAccessKey: settings.bedrockSecretKey,
      sessionToken: settings.bedrockSessionToken,
      service: 'bedrock'
    });

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: requestBody,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.status === 429 && retries > 0) {
      const retryAfter = response.headers.get('Retry-After');
      const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : RETRY_DELAY * Math.pow(2, MAX_RETRIES - retries);
      console.warn(`Bedrock rate limit hit (429), retrying after ${waitTime}ms (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
      await sleep(waitTime);
      return callBedrock(systemMessage, userContent, settings, retries - 1);
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.message || errorData.error?.message || `Bedrock API error: ${response.status}`);
      error.status = response.status;
      error.response = response;
      throw error;
    }

    const data = await response.json();

    // OpenAI models return OpenAI-format response; Claude returns Anthropic format
    if (isOpenAI) {
      if (!data.choices?.[0]?.message?.content) {
        throw new Error('Bedrock OpenAI returned empty or malformed response');
      }
      return data.choices[0].message.content;
    }
    if (!data.content?.[0]?.text) {
      throw new Error('Bedrock Claude returned empty or malformed response');
    }
    return data.content[0].text;

  } catch (error) {
    clearTimeout(timeoutId);

    if (retries > 0 && error.name === 'AbortError') {
      console.log(`Retrying Bedrock request... (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
      await sleep(RETRY_DELAY);
      return callBedrock(systemMessage, userContent, settings, retries - 1);
    }

    if (error.name === 'AbortError') {
      throw new Error(APP_CONFIG.ERRORS.TIMEOUT);
    }

    if (error.status === 429 || error.message.includes('Rate limit') || error.message.includes('ThrottlingException')) {
      throw new Error(APP_CONFIG.ERRORS.RATE_LIMIT);
    }
    if (error.message.includes('network') || error.message.includes('fetch')) {
      throw new Error(APP_CONFIG.ERRORS.NETWORK_ERROR);
    }

    throw error;
  }
}

async function callOpenAI(systemMessage, userContent, settings, retries = MAX_RETRIES) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    // Build OpenAI user message content with proper format for text and images
    const openaiUserContent = [];
    for (const part of userContent) {
      if (typeof part === 'string') {
        openaiUserContent.push({ type: 'text', text: part });
      } else if (part.type === 'text') {
        openaiUserContent.push({ type: 'text', text: part.text });
      } else if (part.type === 'image_url') {
        openaiUserContent.push({ type: 'image_url', image_url: { url: part.image_url.url } });
      }
    }

    // Properly separate system and user messages for better instruction following
    const messages = [];
    if (systemMessage) {
      messages.push({ role: 'system', content: systemMessage });
    }
    messages.push({ role: 'user', content: openaiUserContent });

    // Check token count and warn if approaching limits
    const model = settings.llmModel || 'gpt-4.1';
    const tokenCheck = checkTokenLimit(
      estimateMessagesTokens(messages),
      model,
      settings.maxTokens || APP_CONFIG.DEFAULT_MAX_TOKENS
    );

    if (!tokenCheck.safe) {
      console.error(`❌ ${tokenCheck.warning}`);
      throw new Error(`Token limit exceeded for ${model}. Please reduce input size.`);
    } else if (tokenCheck.warning) {
      console.warn(`⚠️ ${tokenCheck.warning}`);
    }

    const requestBody = {
      model: settings.llmModel || 'gpt-4.1',
      messages: messages,
      temperature: settings.temperature || 0.7,
      max_tokens: settings.maxTokens || APP_CONFIG.DEFAULT_MAX_TOKENS
    };

    // Enable JSON mode when all user content is text (test generation agents)
    const hasImages = userContent.some(p => p.type === 'image_url');
    if (!hasImages && settings._jsonMode) {
      requestBody.response_format = { type: 'json_object' };
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);

    // Handle rate limiting (429) with retry
    if (response.status === 429 && retries > 0) {
      const retryAfter = response.headers.get('Retry-After');
      const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : RETRY_DELAY * Math.pow(2, MAX_RETRIES - retries);

      console.warn(`OpenAI rate limit hit (429), retrying after ${waitTime}ms (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
      await sleep(waitTime);
      return callOpenAI(systemMessage, userContent, settings, retries - 1);
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.error?.message || `OpenAI API error: ${response.status}`);
      error.status = response.status;
      error.response = response;
      throw error;
    }

    const data = await response.json();
    if (!data.choices?.[0]?.message?.content) {
      throw new Error('OpenAI returned empty or malformed response');
    }
    return data.choices[0].message.content;

  } catch (error) {
    clearTimeout(timeoutId);

    // Retry on timeout
    if (retries > 0 && error.name === 'AbortError') {
      console.log(`Retrying OpenAI request... (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
      await sleep(RETRY_DELAY);
      return callOpenAI(systemMessage, userContent, settings, retries - 1);
    }

    if (error.name === 'AbortError') {
      throw new Error(APP_CONFIG.ERRORS.TIMEOUT);
    }

    // Better error messages
    if (error.status === 429 || error.message.includes('Rate limit')) {
      throw new Error(APP_CONFIG.ERRORS.RATE_LIMIT);
    }
    if (error.message.includes('network') || error.message.includes('fetch')) {
      throw new Error(APP_CONFIG.ERRORS.NETWORK_ERROR);
    }

    throw error;
  }
}

async function callGemini(systemMessage, userContent, settings, retries = MAX_RETRIES) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const model = settings.llmModel || 'gemini-2.5-flash-exp';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const geminiContent = userContent.map(part => {
      if (typeof part === 'string') {
        return { text: part };
      } else if (part.type === 'text') {
        return { text: part.text };
      } else if (part.type === 'image_url') {
        const { base64Data, mediaType } = parseDataUri(part.image_url.url);
        if (base64Data) {
          return { inlineData: { mimeType: mediaType, data: base64Data } };
        }
        return { text: '[image unavailable]' };
      }
      return part;
    });

    const requestBody = {
      contents: [{
        parts: geminiContent
      }],
      generationConfig: {
        temperature: settings.temperature || 0.7,
        maxOutputTokens: settings.maxTokens || APP_CONFIG.DEFAULT_MAX_TOKENS
      }
    };

    // Use system_instruction for system message (Gemini's equivalent)
    if (systemMessage) {
      requestBody.system_instruction = {
        parts: [{ text: systemMessage }]
      };
    }

    // Enable JSON response mode for test generation
    if (settings._jsonMode) {
      requestBody.generationConfig.responseMimeType = 'application/json';
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': settings.apiKey
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);

    // Handle rate limiting (429) with retry
    if (response.status === 429 && retries > 0) {
      const retryAfter = response.headers.get('Retry-After');
      const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : RETRY_DELAY * Math.pow(2, MAX_RETRIES - retries);

      console.warn(`Gemini rate limit hit (429), retrying after ${waitTime}ms (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
      await sleep(waitTime);
      return callGemini(systemMessage, userContent, settings, retries - 1);
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.error?.message || `Gemini API error: ${response.status}`);
      error.status = response.status;
      error.response = response;
      throw error;
    }

    const data = await response.json();
    if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
      throw new Error('Gemini returned empty or malformed response');
    }
    return data.candidates[0].content.parts[0].text;

  } catch (error) {
    clearTimeout(timeoutId);

    // Retry on timeout
    if (retries > 0 && error.name === 'AbortError') {
      console.log(`Retrying Gemini request... (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
      await sleep(RETRY_DELAY);
      return callGemini(systemMessage, userContent, settings, retries - 1);
    }

    if (error.name === 'AbortError') {
      throw new Error(APP_CONFIG.ERRORS.TIMEOUT);
    }

    // Better error messages
    if (error.status === 429 || error.message.includes('Rate limit')) {
      throw new Error(APP_CONFIG.ERRORS.RATE_LIMIT);
    }
    if (error.message.includes('network') || error.message.includes('fetch')) {
      throw new Error(APP_CONFIG.ERRORS.NETWORK_ERROR);
    }

    throw error;
  }
}

async function callClaude(systemMessage, userContent, settings, retries = MAX_RETRIES) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    // Build user message content array
    const claudeUserContent = [];
    for (const part of userContent) {
      if (typeof part === 'string') {
        claudeUserContent.push({ type: 'text', text: part });
      } else if (part.type === 'text') {
        claudeUserContent.push({ type: 'text', text: part.text });
      } else if (part.type === 'image_url') {
        const { base64Data, mediaType } = parseDataUri(part.image_url.url);
        if (base64Data) {
          claudeUserContent.push({
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64Data }
          });
        }
      }
    }

    const claudeMessages = [{ role: 'user', content: claudeUserContent }];

    // Build request body with proper system message separation + prompt caching
    const requestBody = {
      model: settings.llmModel || 'claude-sonnet-4-20250514',
      max_tokens: settings.maxTokens || APP_CONFIG.DEFAULT_MAX_TOKENS,
      messages: claudeMessages,
      temperature: settings.temperature || 0.7
    };

    // Use system parameter for system message (enables prompt caching)
    if (systemMessage) {
      requestBody.system = [
        {
          type: 'text',
          text: systemMessage,
          cache_control: { type: 'ephemeral' }
        }
      ];
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);

    // Handle rate limiting (429) with retry
    if (response.status === 429 && retries > 0) {
      const retryAfter = response.headers.get('Retry-After') || response.headers.get('retry-after');
      const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : RETRY_DELAY * Math.pow(2, MAX_RETRIES - retries);

      console.warn(`Claude rate limit hit (429), retrying after ${waitTime}ms (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
      await sleep(waitTime);
      return callClaude(systemMessage, userContent, settings, retries - 1);
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      const error = new Error(errorData.error?.message || `Claude API error: ${response.status}`);
      error.status = response.status;
      error.response = response;
      throw error;
    }

    const data = await response.json();
    if (!data.content?.[0]?.text) {
      throw new Error('Claude returned empty or malformed response');
    }
    return data.content[0].text;

  } catch (error) {
    clearTimeout(timeoutId);

    // Retry on timeout
    if (retries > 0 && error.name === 'AbortError') {
      console.log(`Retrying Claude request... (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
      await sleep(RETRY_DELAY);
      return callClaude(systemMessage, userContent, settings, retries - 1);
    }

    if (error.name === 'AbortError') {
      throw new Error(APP_CONFIG.ERRORS.TIMEOUT);
    }

    // Better error messages
    if (error.status === 429 || error.message.includes('Rate limit')) {
      throw new Error(APP_CONFIG.ERRORS.RATE_LIMIT);
    }
    if (error.message.includes('network') || error.message.includes('fetch')) {
      throw new Error(APP_CONFIG.ERRORS.NETWORK_ERROR);
    }

    throw error;
  }
}

async function callAI(systemMessage, userContent, settings) {
  console.log('🤖 [AI Call] Starting request...', {
    provider: settings.llmProvider,
    model: settings.llmModel,
    hasSystemMessage: !!systemMessage,
    userContentParts: userContent.length
  });

  try {
    let result;
    if (settings.llmProvider === 'openai') {
      result = await callOpenAI(systemMessage, userContent, settings);
    } else if (settings.llmProvider === 'gemini') {
      result = await callGemini(systemMessage, userContent, settings);
    } else if (settings.llmProvider === 'claude') {
      result = await callClaude(systemMessage, userContent, settings);
    } else if (settings.llmProvider === 'bedrock') {
      result = await callBedrock(systemMessage, userContent, settings);
    } else {
      throw new Error(`Unsupported AI provider: ${settings.llmProvider}`);
    }

    console.log('✅ [AI Call] Request successful', {
      provider: settings.llmProvider,
      responseLength: result?.length || 0
    });

    return result;
  } catch (error) {
    console.error('❌ [AI Call] Request failed:', {
      provider: settings.llmProvider,
      model: settings.llmModel,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

async function callBedrockStream(systemMessage, userContent, settings, onChunk, requestId) {
  const controller = new AbortController();
  activeStreams.set(requestId, controller);

  let reader = null;

  try {
    const model = settings.llmModel || APP_CONFIG.DEFAULT_MODELS.bedrock;
    const region = settings.bedrockRegion || 'us-east-1';
    const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/invoke-with-response-stream`;
    const isOpenAI = isBedrockOpenAIModel(model);

    let requestBody;

    if (isOpenAI) {
      // OpenAI models on Bedrock — proper system/user separation
      const openaiUserContent = [];
      for (const part of userContent) {
        if (typeof part === 'string') {
          openaiUserContent.push({ type: 'text', text: part });
        } else if (part.type === 'text') {
          openaiUserContent.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
          openaiUserContent.push({ type: 'image_url', image_url: { url: part.image_url.url } });
        }
      }

      const openaiMessages = [];
      if (systemMessage) {
        openaiMessages.push({ role: 'system', content: systemMessage });
      }
      openaiMessages.push({ role: 'user', content: openaiUserContent });

      requestBody = JSON.stringify({
        max_tokens: settings.maxTokens || APP_CONFIG.DEFAULT_MAX_TOKENS,
        messages: openaiMessages,
        stream: true,
        temperature: settings.temperature || APP_CONFIG.DEFAULT_TEMPERATURE
      });
    } else {
      // Claude/Anthropic models on Bedrock — use system parameter
      const claudeUserContent = [];
      for (const part of userContent) {
        if (typeof part === 'string') {
          claudeUserContent.push({ type: 'text', text: part });
        } else if (part.type === 'text') {
          claudeUserContent.push({ type: 'text', text: part.text });
        } else if (part.type === 'image_url') {
          const { base64Data, mediaType } = parseDataUri(part.image_url.url);
          if (base64Data) {
            claudeUserContent.push({
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64Data }
            });
          }
        }
      }

      const bedrockBody = {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: settings.maxTokens || APP_CONFIG.DEFAULT_MAX_TOKENS,
        messages: [{ role: 'user', content: claudeUserContent }],
        temperature: settings.temperature || APP_CONFIG.DEFAULT_TEMPERATURE
      };

      if (systemMessage) {
        bedrockBody.system = [{ type: 'text', text: systemMessage }];
      }

      requestBody = JSON.stringify(bedrockBody);
    }

    const headers = { 'Content-Type': 'application/json' };
    await awsSignRequest({
      method: 'POST',
      url,
      headers,
      body: requestBody,
      region,
      accessKeyId: settings.bedrockAccessKeyId,
      secretAccessKey: settings.bedrockSecretKey,
      sessionToken: settings.bedrockSessionToken,
      service: 'bedrock'
    });

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: requestBody,
      signal: controller.signal
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || errorData.error?.message || `Bedrock API error: ${response.status}`);
    }

    reader = response.body.getReader();
    const responseChunks = [];
    const streamStartTime = Date.now();

    // AWS Bedrock uses a binary event stream protocol.
    // Each frame: [totalLen:4][headersLen:4][preludeCRC:4][headers:headersLen][payload:N][messageCRC:4]
    // The payload is a JSON string containing the actual streaming event.
    function extractBedrockEvents(binaryBuf) {
      const events = [];
      let offset = 0;
      while (offset + 12 <= binaryBuf.length) {
        const view = new DataView(binaryBuf.buffer, binaryBuf.byteOffset + offset);
        const totalLen = view.getUint32(0, false);
        const headersLen = view.getUint32(4, false);
        if (totalLen < 12 || offset + totalLen > binaryBuf.length) break; // incomplete frame
        const payloadStart = offset + 12 + headersLen;
        const payloadLen = totalLen - 12 - headersLen - 4;
        if (payloadLen > 0) {
          try {
            const payloadBytes = binaryBuf.slice(payloadStart, payloadStart + payloadLen);
            const text = new TextDecoder().decode(payloadBytes);
            events.push(JSON.parse(text));
          } catch (_) { /* skip malformed */ }
        }
        offset += totalLen;
      }
      return { events, remaining: binaryBuf.slice(offset) };
    }

    let binaryBuffer = new Uint8Array(0);

    while (true) {
      if (Date.now() - streamStartTime > STREAMING_TIMEOUT_MS) {
        logger.warn('Bedrock streaming timeout reached');
        break;
      }

      const { done, value } = await reader.read();
      if (done) break;

      // Append incoming bytes
      const merged = new Uint8Array(binaryBuffer.length + value.length);
      merged.set(binaryBuffer);
      merged.set(value, binaryBuffer.length);
      binaryBuffer = merged;

      const { events, remaining } = extractBedrockEvents(binaryBuffer);
      binaryBuffer = remaining;

      for (const rawEvent of events) {
        try {
          // Bedrock wraps the real event payload as {bytes: "<base64>"}.
          // Unwrap it when present; otherwise treat the event as-is.
          let event = rawEvent;
          if (rawEvent.bytes && typeof rawEvent.bytes === 'string') {
            event = JSON.parse(atob(rawEvent.bytes));
          }

          if (isOpenAI) {
            // OpenAI-on-Bedrock: choices[].delta.content
            const chunk = event.choices?.[0]?.delta?.content;
            if (chunk) { responseChunks.push(chunk); onChunk(chunk); }
          } else {
            // Claude-on-Bedrock: content_block_delta → text_delta
            if (event.type === 'content_block_delta') {
              const chunk = event.delta?.text ?? event.delta?.partial_json ?? null;
              if (chunk) { responseChunks.push(chunk); onChunk(chunk); }
            }
          }
        } catch (_) { /* skip malformed events */ }
      }
    }

    return responseChunks.join('');

  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Generation cancelled by user');
    }
    throw error;
  } finally {
    if (reader) {
      try {
        await reader.cancel();
      } catch (e) {
        // Ignore cancel errors
      }
    }
    activeStreams.delete(requestId);
  }
}

async function callOpenAIStream(systemMessage, userContent, settings, onChunk, requestId) {
  const controller = new AbortController();
  activeStreams.set(requestId, controller);

  let reader = null;

  try {
    const messages = [];
    if (systemMessage) {
      messages.push({ role: 'system', content: systemMessage });
    }
    messages.push({ role: 'user', content: userContent });

    const response = await fetch(APP_CONFIG.ENDPOINTS.openai, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        model: settings.llmModel || APP_CONFIG.DEFAULT_MODELS.openai,
        messages: messages,
        stream: true,
        temperature: settings.temperature || APP_CONFIG.DEFAULT_TEMPERATURE,
        max_tokens: settings.maxTokens || APP_CONFIG.DEFAULT_MAX_TOKENS
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `OpenAI API error: ${response.status}`);
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const responseChunks = [];
    const streamStartTime = Date.now();
    let iterationCount = 0;

    while (true) {
      // Timeout safeguard
      if (Date.now() - streamStartTime > STREAMING_TIMEOUT_MS) {
        logger.warn('OpenAI streaming timeout reached');
        break;
      }

      // Iteration safeguard
      if (++iterationCount > MAX_STREAMING_ITERATIONS) {
        logger.warn('OpenAI streaming max iterations reached');
        break;
      }

      const {done, value} = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);
            const chunk = parsed.choices[0]?.delta?.content;
            if (chunk) {
              responseChunks.push(chunk);
              onChunk(chunk);
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }

    return responseChunks.join('');

  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Generation cancelled by user');
    }
    throw error;
  } finally {
    // CRITICAL: Always cleanup resources
    if (reader) {
      try {
        await reader.cancel();
      } catch (e) {
        // Ignore cancel errors
      }
    }
    activeStreams.delete(requestId);
  }
}

async function callClaudeStream(systemMessage, userContent, settings, onChunk, requestId) {
  const controller = new AbortController();
  activeStreams.set(requestId, controller);

  let reader = null;

  try {
    const claudeUserContent = [];
    for (const part of userContent) {
      if (typeof part === 'string') {
        claudeUserContent.push({ type: 'text', text: part });
      } else if (part.type === 'text') {
        claudeUserContent.push({ type: 'text', text: part.text });
      } else if (part.type === 'image_url') {
        const { base64Data, mediaType } = parseDataUri(part.image_url.url);
        if (base64Data) {
          claudeUserContent.push({
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64Data }
          });
        }
      }
    }

    const requestBody = {
      model: settings.llmModel || APP_CONFIG.DEFAULT_MODELS.claude,
      max_tokens: settings.maxTokens || APP_CONFIG.DEFAULT_MAX_TOKENS,
      messages: [{ role: 'user', content: claudeUserContent }],
      temperature: settings.temperature || APP_CONFIG.DEFAULT_TEMPERATURE,
      stream: true
    };

    // Use system parameter with prompt caching
    if (systemMessage) {
      requestBody.system = [
        {
          type: 'text',
          text: systemMessage,
          cache_control: { type: 'ephemeral' }
        }
      ];
    }

    const response = await fetch(APP_CONFIG.ENDPOINTS.claude, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31'
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Claude API error: ${response.status}`);
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const responseChunks = [];
    const streamStartTime = Date.now();
    let iterationCount = 0;

    while (true) {
      // Timeout safeguard
      if (Date.now() - streamStartTime > STREAMING_TIMEOUT_MS) {
        logger.warn('Claude streaming timeout reached');
        break;
      }

      // Iteration safeguard
      if (++iterationCount > MAX_STREAMING_ITERATIONS) {
        logger.warn('Claude streaming max iterations reached');
        break;
      }

      const {done, value} = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);

          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
              const chunk = parsed.delta.text;
              responseChunks.push(chunk);
              onChunk(chunk);
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }

    return responseChunks.join('');

  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Generation cancelled by user');
    }
    throw error;
  } finally {
    // CRITICAL: Always cleanup resources
    if (reader) {
      try {
        await reader.cancel();
      } catch (e) {
        // Ignore cancel errors
      }
    }
    activeStreams.delete(requestId);
  }
}

async function callGeminiStream(systemMessage, userContent, settings, onChunk, requestId) {
  const controller = new AbortController();
  activeStreams.set(requestId, controller);

  let reader = null;

  try {
    const model = settings.llmModel || APP_CONFIG.DEFAULT_MODELS.gemini;
    const url = `${APP_CONFIG.ENDPOINTS.gemini}/${model}:streamGenerateContent?alt=sse`;

    const geminiContent = userContent.map(part => {
      if (typeof part === 'string') {
        return { text: part };
      } else if (part.type === 'text') {
        return { text: part.text };
      } else if (part.type === 'image_url') {
        const { base64Data, mediaType } = parseDataUri(part.image_url.url);
        if (base64Data) {
          return { inlineData: { mimeType: mediaType, data: base64Data } };
        }
        return { text: '[image unavailable]' };
      }
      return part;
    });

    const requestBody = {
      contents: [{
        parts: geminiContent
      }],
      generationConfig: {
        temperature: settings.temperature || APP_CONFIG.DEFAULT_TEMPERATURE,
        maxOutputTokens: settings.maxTokens || APP_CONFIG.DEFAULT_MAX_TOKENS
      }
    };

    if (systemMessage) {
      requestBody.system_instruction = {
        parts: [{ text: systemMessage }]
      };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': settings.apiKey
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Gemini API error: ${response.status}`);
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const responseChunks = [];
    const streamStartTime = Date.now();
    let iterationCount = 0;

    while (true) {
      // Timeout safeguard
      if (Date.now() - streamStartTime > STREAMING_TIMEOUT_MS) {
        logger.warn('Gemini streaming timeout reached');
        break;
      }

      // Iteration safeguard
      if (++iterationCount > MAX_STREAMING_ITERATIONS) {
        logger.warn('Gemini streaming max iterations reached');
        break;
      }

      const {done, value} = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);

          try {
            const parsed = JSON.parse(data);
            const chunk = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
            if (chunk) {
              responseChunks.push(chunk);
              onChunk(chunk);
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }

    return responseChunks.join('');

  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Generation cancelled by user');
    }
    throw error;
  } finally {
    // CRITICAL: Always cleanup resources
    if (reader) {
      try {
        await reader.cancel();
      } catch (e) {
        // Ignore cancel errors
      }
    }
    activeStreams.delete(requestId);
  }
}

async function callAIStream(systemMessage, userContent, settings, onChunk, requestId) {
  console.log('🤖 [AI Stream] Starting request...', {
    provider: settings.llmProvider,
    model: settings.llmModel,
    hasSystemMessage: !!systemMessage,
    userContentParts: userContent.length,
    requestId
  });

  try {
    let result;
    if (settings.llmProvider === 'openai') {
      result = await callOpenAIStream(systemMessage, userContent, settings, onChunk, requestId);
    } else if (settings.llmProvider === 'gemini') {
      result = await callGeminiStream(systemMessage, userContent, settings, onChunk, requestId);
    } else if (settings.llmProvider === 'claude') {
      result = await callClaudeStream(systemMessage, userContent, settings, onChunk, requestId);
    } else if (settings.llmProvider === 'bedrock') {
      result = await callBedrockStream(systemMessage, userContent, settings, onChunk, requestId);
    } else {
      throw new Error(`Unsupported AI provider: ${settings.llmProvider}`);
    }

    console.log('✅ [AI Stream] Request successful', {
      provider: settings.llmProvider,
      requestId,
      responseLength: result?.length || 0
    });

    return result;
  } catch (error) {
    console.error('❌ [AI Stream] Request failed:', {
      provider: settings.llmProvider,
      model: settings.llmModel,
      requestId,
      error: error.message,
      stack: error.stack
    });
    throw error;
  }
}

const __api = { callAI, callOpenAI, callGemini, callClaude, callBedrock, callAIStream, callOpenAIStream, callClaudeStream, callGeminiStream, callBedrockStream, get activeStreams() { return activeStreams; } };
if (typeof module !== 'undefined' && module.exports) module.exports = __api;
if (typeof self !== 'undefined') Object.assign(self, __api);
})();
