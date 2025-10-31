// Background service worker for QAtalyst
// Direct API calls to OpenAI, Claude, and Gemini with streaming support
// Multi-agent test generation system

// Import configuration and utilities
importScripts('config.js');
importScripts('security.js');
importScripts('agents.js');
importScripts('evolution.js');
importScripts('integrations.js');
importScripts('enhancements.js');
importScripts('historical-mining.js');

// Use constants from config
const REQUEST_TIMEOUT = CONFIG.REQUEST_TIMEOUT;
const MAX_RETRIES = CONFIG.MAX_RETRIES;
const RETRY_DELAY = CONFIG.RETRY_DELAY;

// Active streaming controllers for cancellation
const activeStreams = new Map();

// Message handler
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'analyzeRequirements') {
    handleAnalyzeRequirements(request.data)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  if (request.action === 'generateTestScope') {
    handleGenerateTestScope(request.data)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  if (request.action === 'generateTestCases') {
    handleGenerateTestCases(request.data)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  // Streaming actions
  if (request.action === 'analyzeRequirementsStream') {
    handleAnalyzeRequirementsStream(request.data, sender.tab.id)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  if (request.action === 'generateTestScopeStream') {
    handleGenerateTestScopeStream(request.data, sender.tab.id)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  if (request.action === 'generateTestCasesStream') {
    handleGenerateTestCasesStream(request.data, sender.tab.id)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  if (request.action === 'stopGeneration') {
    const cancelled = cancelStream(request.requestId);
    sendResponse({ success: cancelled });
    return true;
  }
  
  // Multi-agent test generation
  if (request.action === 'generateTestCasesMultiAgent') {
    handleGenerateTestCasesMultiAgent(request.data, sender.tab.id)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  // Open options page
  if (request.action === 'openOptions') {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return true;
  }

  // Regenerate with user review
  if (request.action === 'regenerateWithReview') {
    handleRegenerateWithReview(request.data)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === 'testIntegration') {
    (async () => {
      try {
        const result = await handleTestIntegration(request.data);
        sendResponse(result);
      } catch (error) {
        sendResponse({ success: false, message: error.message });
      }
    })();
    return true; // Keep the message channel open for async response
  }

  return false;
});

async function handleTestIntegration(data) {
  const { type, ...credentials } = data;

  switch (type) {
    case 'confluence':
      return testConfluence(credentials);
    case 'figma':
      return testFigma(credentials);
    case 'google':
      return testGoogle(credentials);
    case 'testrail':
      return testTestRail(credentials);
    default:
      return { success: false, message: 'Unknown integration type' };
  }
}

async function testConfluence({ url, email, token }) {
  if (!url || !email || !token) {
    return { success: false, message: 'URL, email, and token are required' };
  }
  try {
    const credentials = btoa(`${email}:${token}`);
    const response = await fetch(`${url}/wiki/rest/api/space`, {
      headers: { 
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/json'
      },
    });
    if (response.ok) {
      return { success: true };
    } else {
      return { success: false, message: `Failed with status: ${response.status}` };
    }
  } catch (error) {
    return { success: false, message: error.message };
  }
}

async function testFigma({ token }) {
  if (!token) {
    return { success: false, message: 'Token is required' };
  }
  try {
    const response = await fetch('https://api.figma.com/v1/me', {
      headers: { 'X-Figma-Token': token },
    });
    if (response.ok) {
      return { success: true };
    } else {
      return { success: false, message: `Failed with status: ${response.status}` };
    }
  } catch (error) {
    return { success: false, message: error.message };
  }
}

async function testGoogle({ apiKey }) {
  if (!apiKey) {
    return { success: false, message: 'API key is required' };
  }
  try {
    const response = await fetch(`https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=017576662512468239146:omuauf_lfve&q=testrail`);
    if (response.ok) {
      return { success: true };
    } else {
      return { success: false, message: `Failed with status: ${response.status}` };
    }
  } catch (error) {
    return { success: false, message: error.message };
  }
}

async function testTestRail({ url, username, apiKey }) {
  if (!url || !username || !apiKey) {
    return { success: false, message: 'URL, username, and API key are required' };
  }
  try {
    const response = await fetch(`${url}/index.php?/api/v2/get_statuses`, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + btoa(`${username}:${apiKey}`),
      },
    });
    if (response.ok) {
      return { success: true };
    } else {
      return { success: false, message: `Failed with status: ${response.status}` };
    }
  } catch (error) {
    return { success: false, message: error.message };
  }
}

// Sleep utility for retry delays
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Call OpenAI API directly
async function callOpenAI(contentParts, settings, retries = MAX_RETRIES) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  
  try {
    const messages = [
      { role: 'user', content: contentParts }
    ];

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        model: settings.llmModel || 'gpt-4o',
        messages: messages,
        temperature: settings.temperature || 0.7,
        max_tokens: settings.maxTokens || 4000
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `OpenAI API error: ${response.status}`);
    }
    
    const data = await response.json();
    return data.choices[0].message.content;
    
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (retries > 0 && error.name === 'AbortError') {
      console.log(`Retrying OpenAI request... (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
      await sleep(RETRY_DELAY);
      return callOpenAI(contentParts, settings, retries - 1);
    }

    if (error.name === 'AbortError') {
      throw new Error(CONFIG.ERRORS.TIMEOUT);
    }

    // Better error messages
    if (error.message.includes('Rate limit')) {
      throw new Error(CONFIG.ERRORS.RATE_LIMIT);
    }
    if (error.message.includes('network') || error.message.includes('fetch')) {
      throw new Error(CONFIG.ERRORS.NETWORK_ERROR);
    }

    throw error;
  }
}

// Call Gemini API directly
async function callGemini(contentParts, settings, retries = MAX_RETRIES) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  
  try {
    const model = settings.llmModel || 'gemini-2.0-flash-exp';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.apiKey}`;
    
    const geminiContent = contentParts.map(part => {
      if (typeof part === 'string') {
        return { text: part };
      } else if (part.type === 'image_url') {
        // Gemini expects { inlineData: { mimeType: 'image/png', data: 'base64string' } }
        const base64Data = part.image_url.url.split(',')[1];
        const mimeType = part.image_url.url.split(':')[1].split(';')[0];
        return { inlineData: { mimeType: mimeType, data: base64Data } };
      }
      return part; // Return as is if other types are introduced
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: geminiContent
        }],
        generationConfig: {
          temperature: settings.temperature || 0.7,
          maxOutputTokens: settings.maxTokens || 4000
        }
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Gemini API error: ${response.status}`);
    }
    
    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
    
  } catch (error) {
    clearTimeout(timeoutId);

    if (retries > 0 && error.name === 'AbortError') {
      console.log(`Retrying Gemini request... (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
      await sleep(RETRY_DELAY);
      return callGemini(contentParts, settings, retries - 1);
    }

    if (error.name === 'AbortError') {
      throw new Error(CONFIG.ERRORS.TIMEOUT);
    }

    // Better error messages
    if (error.message.includes('Rate limit')) {
      throw new Error(CONFIG.ERRORS.RATE_LIMIT);
    }
    if (error.message.includes('network') || error.message.includes('fetch')) {
      throw new Error(CONFIG.ERRORS.NETWORK_ERROR);
    }

    throw error;
  }
}

// Call Claude (Anthropic) API directly
async function callClaude(contentParts, settings, retries = MAX_RETRIES) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  
  try {
    const claudeMessages = [
      { role: 'user', content: [] }
    ];

    for (const part of contentParts) {
      if (typeof part === 'string') {
        claudeMessages[0].content.push({ type: 'text', text: part });
      } else if (part.type === 'image_url') {
        // Claude expects { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'base64string' } }
        const base64Data = part.image_url.url.split(',')[1];
        const mediaType = part.image_url.url.split(':')[1].split(';')[0];
        claudeMessages[0].content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: base64Data
          }
        });
      }
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: settings.llmModel || 'claude-3-5-sonnet-20241022',
        max_tokens: settings.maxTokens || 4000,
        messages: claudeMessages,
        temperature: settings.temperature || 0.7
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Claude API error: ${response.status}`);
    }
    
    const data = await response.json();
    return data.content[0].text;
    
  } catch (error) {
    clearTimeout(timeoutId);

    if (retries > 0 && error.name === 'AbortError') {
      console.log(`Retrying Claude request... (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
      await sleep(RETRY_DELAY);
      return callClaude(contentParts, settings, retries - 1);
    }

    if (error.name === 'AbortError') {
      throw new Error(CONFIG.ERRORS.TIMEOUT);
    }

    // Better error messages
    if (error.message.includes('Rate limit')) {
      throw new Error(CONFIG.ERRORS.RATE_LIMIT);
    }
    if (error.message.includes('network') || error.message.includes('fetch')) {
      throw new Error(CONFIG.ERRORS.NETWORK_ERROR);
    }

    throw error;
  }
}

// Streaming version of OpenAI API
async function callOpenAIStream(contentParts, settings, onChunk, requestId) {
  const controller = new AbortController();
  activeStreams.set(requestId, controller);

  let reader = null;

  try {
    const messages = [
      { role: 'user', content: contentParts }
    ];

    const response = await fetch(CONFIG.ENDPOINTS.openai, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        model: settings.llmModel || CONFIG.DEFAULT_MODELS.openai,
        messages: messages,
        stream: true,
        temperature: settings.temperature || CONFIG.DEFAULT_TEMPERATURE,
        max_tokens: settings.maxTokens || CONFIG.DEFAULT_MAX_TOKENS
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
    let fullResponse = '';

    while (true) {
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
              fullResponse += chunk;
              onChunk(chunk);
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }

    return fullResponse;

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

// Streaming version of Claude API
async function callClaudeStream(contentParts, settings, onChunk, requestId) {
  const controller = new AbortController();
  activeStreams.set(requestId, controller);

  let reader = null;

  try {
    const claudeMessages = [
      { role: 'user', content: [] }
    ];

    for (const part of contentParts) {
      if (typeof part === 'string') {
        claudeMessages[0].content.push({ type: 'text', text: part });
      } else if (part.type === 'image_url') {
        const base64Data = part.image_url.url.split(',')[1];
        const mediaType = part.image_url.url.split(':')[1].split(';')[0];
        claudeMessages[0].content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: mediaType,
            data: base64Data
          }
        });
      }
    }

    const response = await fetch(CONFIG.ENDPOINTS.claude, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: settings.llmModel || CONFIG.DEFAULT_MODELS.claude,
        max_tokens: settings.maxTokens || CONFIG.DEFAULT_MAX_TOKENS,
        messages: claudeMessages,
        temperature: settings.temperature || CONFIG.DEFAULT_TEMPERATURE,
        stream: true
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Claude API error: ${response.status}`);
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullResponse = '';

    while (true) {
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
              fullResponse += chunk;
              onChunk(chunk);
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }

    return fullResponse;

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

// Streaming version of Gemini API (Note: Gemini uses SSE differently)
async function callGeminiStream(contentParts, settings, onChunk, requestId) {
  const controller = new AbortController();
  activeStreams.set(requestId, controller);

  let reader = null;

  try {
    const model = settings.llmModel || CONFIG.DEFAULT_MODELS.gemini;
    const url = `${CONFIG.ENDPOINTS.gemini}/${model}:streamGenerateContent?key=${settings.apiKey}&alt=sse`;

    const geminiContent = contentParts.map(part => {
      if (typeof part === 'string') {
        return { text: part };
      } else if (part.type === 'image_url') {
        const base64Data = part.image_url.url.split(',')[1];
        const mimeType = part.image_url.url.split(':')[1].split(';')[0];
        return { inlineData: { mimeType: mimeType, data: base64Data } };
      }
      return part; // Return as is if other types are introduced
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: geminiContent
        }],
        generationConfig: {
          temperature: settings.temperature || CONFIG.DEFAULT_TEMPERATURE,
          maxOutputTokens: settings.maxTokens || CONFIG.DEFAULT_MAX_TOKENS
        }
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Gemini API error: ${response.status}`);
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullResponse = '';

    while (true) {
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
              fullResponse += chunk;
              onChunk(chunk);
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }
      }
    }

    return fullResponse;

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

// Unified streaming AI call function
async function callAIStream(contentParts, settings, onChunk, requestId) {
  if (settings.llmProvider === 'openai') {
    return await callOpenAIStream(contentParts, settings, onChunk, requestId);
  } else if (settings.llmProvider === 'gemini') {
    return await callGeminiStream(contentParts, settings, onChunk, requestId);
  } else if (settings.llmProvider === 'claude') {
    return await callClaudeStream(contentParts, settings, onChunk, requestId);
  } else {
    throw new Error(`Unsupported AI provider: ${settings.llmProvider}`);
  }
}

// Cancel active stream
function cancelStream(requestId) {
  const controller = activeStreams.get(requestId);
  if (controller) {
    controller.abort();
    activeStreams.delete(requestId);
    return true;
  }
  return false;
}

// Unified AI call function (non-streaming - kept for backward compatibility)
async function callAI(contentParts, settings) {
  if (settings.llmProvider === 'openai') {
    return await callOpenAI(contentParts, settings);
  } else if (settings.llmProvider === 'gemini') {
    return await callGemini(contentParts, settings);
  } else if (settings.llmProvider === 'claude') {
    return await callClaude(contentParts, settings);
  } else {
    throw new Error(`Unsupported AI provider: ${settings.llmProvider}`);
  }
}

// Validate settings before API calls
function validateSettings(settings) {
  const errors = [];

  if (!settings.apiKey || settings.apiKey.trim() === '') {
    errors.push(CONFIG.ERRORS.NO_API_KEY);
  } else {
    // Validate API key format
    if (!securityManager.validateApiKey(settings.apiKey, settings.llmProvider)) {
      errors.push(`Invalid API key format for ${settings.llmProvider}. Please check your API key.`);
    }
  }

  if (!settings.llmProvider) {
    errors.push(CONFIG.ERRORS.NO_PROVIDER);
  }

  if (!settings.llmModel) {
    errors.push(CONFIG.ERRORS.NO_MODEL);
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}

// API call handlers
async function handleAnalyzeRequirements(data) {
  validateSettings(data.settings);

  const { ticketKey, ticketData, settings } = data;

  // Fetch external content if integrations are configured
  let enrichedTicketData = ticketData;
  let externalContent = null; // Declare at function scope
  if (settings.confluenceUrl || settings.figmaToken || settings.googleApiKey) {
    const integrationManager = new IntegrationManager(settings);
    externalContent = await integrationManager.fetchAllLinkedContent(ticketData);

    // Use enriched description if external content was found
    if (externalContent.enrichedDescription !== ticketData.description) {
      enrichedTicketData = {
        ...ticketData,
        description: externalContent.enrichedDescription,
        externalSources: {
          confluence: externalContent.confluence.length,
          figma: externalContent.figma.length,
          googleDocs: externalContent.googleDocs.length
        }
      };
    }
  }

  const systemMessage = `You are a senior business analyst and requirements quality expert specializing in requirement analysis.
Analyze Jira tickets and extract structured requirements for test case generation.

Your analysis must be CRITICAL and identify quality issues:

**Primary Focus:**
1. Feature overview and objectives
2. Functional requirements (what the system should do)
3. UI/UX specifications
4. Integration points and dependencies
5. Acceptance criteria
6. Edge cases and constraints

**Critical Analysis (VERY IMPORTANT):**
7. **REQUIREMENT GAPS:** Identify missing information, undefined behaviors, unstated assumptions, missing error handling, incomplete workflows
8. **AMBIGUITIES:** Flag vague terms (e.g., "fast", "user-friendly"), unclear pronouns, multiple interpretations, subjective criteria
9. **UNTESTABLE REQUIREMENTS:** Identify requirements without measurable criteria, vague quality attributes, unverifiable claims
10. **CONFLICTING REQUIREMENTS:** Highlight contradictions or inconsistencies
11. **TESTABILITY SCORE:** Rate each requirement's testability (High/Medium/Low) with justification

**Output Format (Markdown):**

## 📋 Requirements Overview
[Summary of what this feature does]

## ✅ Functional Requirements
[List clear, testable functional requirements]

## 🎨 UI/UX Specifications
[User interface and experience requirements]

## 🔗 Integration Points
[External systems, APIs, dependencies]

## ✓ Acceptance Criteria
[Clear, measurable success criteria]

## 🚨 **CRITICAL: Quality Analysis**

### ⚠️ Requirement Gaps (Missing Information)
- [ ] **Gap:** [What's missing]
  - **Impact:** [How this affects testing]
  - **Recommended Action:** [What needs clarification]

### ❓ Ambiguities (Unclear/Vague Requirements)
- [ ] **Ambiguity:** [Vague statement]
  - **Issue:** [Why it's ambiguous]
  - **Needs Clarification:** [Specific questions to ask]

### 🚫 Untestable Requirements
- [ ] **Untestable:** [Requirement that can't be verified]
  - **Reason:** [Why it's untestable]
  - **Suggested Revision:** [How to make it testable]

### ⚡ Conflicting Requirements
- [ ] **Conflict:** [Contradictory statements]

### 📊 Testability Summary
| Requirement | Testability | Reason |
|-------------|-------------|--------|
| [Req 1] | High/Medium/Low | [Justification] |

## 🎯 Recommendations
1. Questions to ask stakeholders
2. Required clarifications before testing
3. Assumptions that need validation

Provide comprehensive, critical analysis. Be honest about gaps and ambiguities - they're better found now than during testing!`;

  const userMessage = `Analyze this Jira ticket:

**Ticket:** ${ticketKey}
**Summary:** ${enrichedTicketData.summary || 'N/A'}
**Description:** ${enrichedTicketData.description || 'N/A'}
**Comments:** ${enrichedTicketData.comments?.length || 0} comments
**Attachments:** ${enrichedTicketData.attachments?.length || 0} files
**Linked Pages:** ${enrichedTicketData.linkedPages?.length || 0} pages
${enrichedTicketData.externalSources ? `**External Sources:** ${enrichedTicketData.externalSources.confluence} Confluence, ${enrichedTicketData.externalSources.figma} Figma, ${enrichedTicketData.externalSources.googleDocs} Google Docs` : ''}

Provide comprehensive requirement analysis.`;

  const contentParts = [
    { type: 'text', text: systemMessage },
    { type: 'text', text: userMessage }
  ];

  // Add Figma images if available
  if (externalContent && externalContent.figma) {
    externalContent.figma.forEach(figmaFile => {
      if (figmaFile.images && figmaFile.images.length > 0) {
        figmaFile.images.forEach(base64Image => {
          contentParts.push({ type: 'image_url', image_url: { url: base64Image } });
        });
      }
    });
  }

  // Add Jira image attachments if available
  if (enrichedTicketData.imageAttachments && enrichedTicketData.imageAttachments.length > 0) {
    console.log(`📷 Adding ${enrichedTicketData.imageAttachments.length} Jira image attachments to analysis`);
    enrichedTicketData.imageAttachments.forEach(image => {
      contentParts.push({ type: 'image_url', image_url: { url: image.data } });
    });
  }

  const analysis = await callAI(contentParts, settings);
  
  return { 
    analysis,
    externalSources: enrichedTicketData.externalSources
  };
}

async function handleGenerateTestScope(data) {
  validateSettings(data.settings);

  const { ticketKey, ticketData, settings } = data;

  // Fetch external content if integrations are configured
  let enrichedTicketData = ticketData;
  let currentExternalSources = null;
  let externalContent = null; // Declare at function scope
  if (settings.confluenceUrl || settings.figmaToken || settings.googleApiKey) {
    const integrationManager = new IntegrationManager(settings);
    externalContent = await integrationManager.fetchAllLinkedContent(ticketData);

    // Use enriched description if external content was found
    if (externalContent.enrichedDescription !== ticketData.description) {
      enrichedTicketData = {
        ...ticketData,
        description: externalContent.enrichedDescription,
      };
      currentExternalSources = {
        confluence: externalContent.confluence.length,
        figma: externalContent.figma.length,
        googleDocs: externalContent.googleDocs.length
      };
    }
  }
  
  const systemMessage = `You are a senior test architect. Create comprehensive test scope for Jira tickets.

Include:
1. Test objectives
2. In-scope features
3. Out-of-scope items
4. Test types needed (functional, integration, regression, etc.)
5. Test data requirements
6. Environment needs
7. Estimated test count by category

Format as structured markdown.`;

  const userMessage = `Create test scope for:

**Ticket:** ${ticketKey}
**Summary:** ${enrichedTicketData.summary || 'N/A'}
**Description:** ${enrichedTicketData.description || 'N/A'}
${currentExternalSources ? `**External Sources:** ${currentExternalSources.confluence} Confluence, ${currentExternalSources.figma} Figma, ${currentExternalSources.googleDocs} Google Docs` : ''}

Provide detailed test scope covering all aspects.`;

  const contentParts = [
    { type: 'text', text: systemMessage },
    { type: 'text', text: userMessage }
  ];

  // Add Figma images if available
  if (externalContent && externalContent.figma) {
    externalContent.figma.forEach(figmaFile => {
      if (figmaFile.images && figmaFile.images.length > 0) {
        figmaFile.images.forEach(base64Image => {
          contentParts.push({ type: 'image_url', image_url: { url: base64Image } });
        });
      }
    });
  }

  // Add Jira image attachments if available
  if (enrichedTicketData.imageAttachments && enrichedTicketData.imageAttachments.length > 0) {
    console.log(`📷 Adding ${enrichedTicketData.imageAttachments.length} Jira image attachments to scope generation`);
    enrichedTicketData.imageAttachments.forEach(image => {
      contentParts.push({ type: 'image_url', image_url: { url: image.data } });
    });
  }

  const scope = await callAI(contentParts, settings);

  return { scope, externalSources: currentExternalSources };
}

async function handleGenerateTestCases(data) {
  validateSettings(data.settings);
  
  const { ticketKey, ticketData, settings } = data;
  
  const systemMessage = `You are an expert test engineer. Generate detailed, executable test cases.

For each test case include:
- Unique ID (TC-XXX-NNN format)
- Clear title
- Category (Positive/Negative/Edge/Integration)
- Priority (P0/P1/P2/P3)
- Preconditions
- Test steps (numbered)
- Expected result
- Test data

Generate 20-30 comprehensive test cases covering:
- Happy path scenarios (40%)
- Negative scenarios (30%)
- Edge cases (20%)
- Integration scenarios (10%)

Format as JSON array.`;

  const userMessage = `Generate test cases for:

**Ticket:** ${ticketKey}
**Summary:** ${ticketData.summary || 'N/A'}
**Description:** ${ticketData.description || 'N/A'}

Return test cases as JSON array: [{"id":"TC-POS-001","title":"...","category":"Positive","priority":"P0","steps":["step1","step2"],"expectedResult":"...","preconditions":"...","testData":"..."}]`;

  const contentParts = [
    { type: 'text', text: systemMessage },
    { type: 'text', text: userMessage }
  ];
  const response = await callAI(contentParts, settings);
  
  // Parse JSON from response
  try {
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('Could not parse test cases from AI response');
    }
    
    const testCases = JSON.parse(jsonMatch[0]);
    
    // Count categories
    const stats = {
      totalCount: testCases.length,
      positiveCount: testCases.filter(tc => tc.category === 'Positive').length,
      negativeCount: testCases.filter(tc => tc.category === 'Negative').length,
      edgeCaseCount: testCases.filter(tc => tc.category === 'Edge').length
    };
    
    return { testCases, ...stats };
  } catch (error) {
    throw new Error(`Failed to parse test cases: ${error.message}`);
  }
}

// Streaming handlers - send chunks back to content script in real-time
async function handleAnalyzeRequirementsStream(data, tabId) {
  validateSettings(data.settings);

  const { ticketKey, ticketData, settings } = data;
  const requestId = `analyze-${Date.now()}`;

  // Fetch external content if integrations are configured
  let enrichedTicketData = ticketData;
  let currentExternalSources = null;
  let externalContent = null; // Declare at function scope
  if (settings.confluenceUrl || settings.figmaToken || settings.googleApiKey) {
    const integrationManager = new IntegrationManager(settings);
    externalContent = await integrationManager.fetchAllLinkedContent(ticketData);

    // Use enriched description if external content was found
    if (externalContent.enrichedDescription !== ticketData.description) {
      enrichedTicketData = {
        ...ticketData,
        description: externalContent.enrichedDescription,
      };
      currentExternalSources = {
        confluence: externalContent.confluence.length,
        figma: externalContent.figma.length,
        googleDocs: externalContent.googleDocs.length
      };
    }
  }

  const systemMessage = `You are a senior business analyst and requirements quality expert specializing in requirement analysis.
Analyze Jira tickets and extract structured requirements for test case generation.

Your analysis must be CRITICAL and identify quality issues:

**Primary Focus:**
1. Feature overview and objectives
2. Functional requirements (what the system should do)
3. UI/UX specifications
4. Integration points and dependencies
5. Acceptance criteria
6. Edge cases and constraints

**Critical Analysis (VERY IMPORTANT):**
7. **REQUIREMENT GAPS:** Identify missing information, undefined behaviors, unstated assumptions, missing error handling, incomplete workflows
8. **AMBIGUITIES:** Flag vague terms (e.g., "fast", "user-friendly"), unclear pronouns, multiple interpretations, subjective criteria
9. **UNTESTABLE REQUIREMENTS:** Identify requirements without measurable criteria, vague quality attributes, unverifiable claims
10. **CONFLICTING REQUIREMENTS:** Highlight contradictions or inconsistencies
11. **TESTABILITY SCORE:** Rate each requirement's testability (High/Medium/Low) with justification

**Output Format (Markdown):**

## 📋 Requirements Overview
[Summary of what this feature does]

## ✅ Functional Requirements
[List clear, testable functional requirements]

## 🎨 UI/UX Specifications
[User interface and experience requirements]

## 🔗 Integration Points
[External systems, APIs, dependencies]

## ✓ Acceptance Criteria
[Clear, measurable success criteria]

## 🚨 **CRITICAL: Quality Analysis**

### ⚠️ Requirement Gaps (Missing Information)
- [ ] **Gap:** [What's missing]
  - **Impact:** [How this affects testing]
  - **Recommended Action:** [What needs clarification]

### ❓ Ambiguities (Unclear/Vague Requirements)
- [ ] **Ambiguity:** [Vague statement]
  - **Issue:** [Why it's ambiguous]
  - **Needs Clarification:** [Specific questions to ask]

### 🚫 Untestable Requirements
- [ ] **Untestable:** [Requirement that can't be verified]
  - **Reason:** [Why it's untestable]
  - **Suggested Revision:** [How to make it testable]

### ⚡ Conflicting Requirements
- [ ] **Conflict:** [Contradictory statements]

### 📊 Testability Summary
| Requirement | Testability | Reason |
|-------------|-------------|--------|
| [Req 1] | High/Medium/Low | [Justification] |

## 🎯 Recommendations
1. Questions to ask stakeholders
2. Required clarifications before testing
3. Assumptions that need validation

Provide comprehensive, critical analysis. Be honest about gaps and ambiguities - they're better found now than during testing!`;

  const userMessage = `Analyze this Jira ticket:

**Ticket:** ${ticketKey}
**Summary:** ${enrichedTicketData.summary || 'N/A'}
**Description:** ${enrichedTicketData.description || 'N/A'}
**Comments:** ${enrichedTicketData.comments?.length || 0} comments
**Attachments:** ${enrichedTicketData.attachments?.length || 0} files
**Linked Pages:** ${enrichedTicketData.linkedPages?.length || 0} pages
${currentExternalSources ? `**External Sources:** ${currentExternalSources.confluence} Confluence, ${currentExternalSources.figma} Figma, ${currentExternalSources.googleDocs} Google Docs` : ''}

Provide comprehensive requirement analysis.`;

  const contentParts = [
    { type: 'text', text: systemMessage },
    { type: 'text', text: userMessage }
  ];

  // Add Figma images if available
  if (externalContent && externalContent.figma) {
    externalContent.figma.forEach(figmaFile => {
      if (figmaFile.images && figmaFile.images.length > 0) {
        figmaFile.images.forEach(base64Image => {
          contentParts.push({ type: 'image_url', image_url: { url: base64Image } });
        });
      }
    });
  }

  // Add Jira image attachments if available
  if (enrichedTicketData.imageAttachments && enrichedTicketData.imageAttachments.length > 0) {
    console.log(`📷 Adding ${enrichedTicketData.imageAttachments.length} Jira image attachments to streaming analysis`);
    enrichedTicketData.imageAttachments.forEach(image => {
      contentParts.push({ type: 'image_url', image_url: { url: image.data } });
    });
  }

  const analysis = await callAIStream(contentParts, settings, (chunk) => {
    // Send each chunk to content script
    chrome.tabs.sendMessage(tabId, {
      action: 'streamChunk',
      requestId: requestId,
      chunk: chunk
    });
  }, requestId);
  
  return { 
    analysis,
    externalSources: currentExternalSources,
    requestId 
  };
}

async function handleGenerateTestScopeStream(data, tabId) {
  validateSettings(data.settings);

  const { ticketKey, ticketData, settings } = data;
  const requestId = `scope-${Date.now()}`;

  // Fetch external content if integrations are configured
  let enrichedTicketData = ticketData;
  let currentExternalSources = null;
  let externalContent = null; // Declare at function scope
  if (settings.confluenceUrl || settings.figmaToken || settings.googleApiKey) {
    const integrationManager = new IntegrationManager(settings);
    externalContent = await integrationManager.fetchAllLinkedContent(ticketData);

    // Use enriched description if external content was found
    if (externalContent.enrichedDescription !== ticketData.description) {
      enrichedTicketData = {
        ...ticketData,
        description: externalContent.enrichedDescription,
      };
      currentExternalSources = {
        confluence: externalContent.confluence.length,
        figma: externalContent.figma.length,
        googleDocs: externalContent.googleDocs.length
      };
    }
  }
  
  const systemMessage = `You are a test planning expert creating comprehensive test scope documents.`;

  const userMessage = `Create a test scope document for:

**Ticket:** ${ticketKey}
**Summary:** ${enrichedTicketData.summary || 'N/A'}
**Description:** ${enrichedTicketData.description || 'N/A'}
${currentExternalSources ? `**External Sources:** ${currentExternalSources.confluence} Confluence, ${currentExternalSources.figma} Figma, ${currentExternalSources.googleDocs} Google Docs` : ''}

Provide detailed test scope covering all aspects.`;

  const contentParts = [
    { type: 'text', text: systemMessage },
    { type: 'text', text: userMessage }
  ];

  // Add Figma images if available
  if (externalContent && externalContent.figma) {
    externalContent.figma.forEach(figmaFile => {
      if (figmaFile.images && figmaFile.images.length > 0) {
        figmaFile.images.forEach(base64Image => {
          contentParts.push({ type: 'image_url', image_url: { url: base64Image } });
        });
      }
    });
  }

  const testScope = await callAIStream(contentParts, settings, (chunk) => {
    chrome.tabs.sendMessage(tabId, {
      action: 'streamChunk',
      requestId: requestId,
      chunk: chunk
    });
  }, requestId);
  
  return { testScope, externalSources: currentExternalSources, requestId };
}

async function handleGenerateTestCasesStream(data, tabId) {
  validateSettings(data.settings);
  
  const { ticketKey, ticketData, settings } = data;
  const requestId = `testcases-${Date.now()}`;
  
  const systemMessage = `You are an expert QA engineer generating comprehensive test cases.

Generate test cases in this EXACT JSON format:
{
  "testCases": [
    {
      "id": "TC-XXX-001",
      "title": "Clear test case title",
      "category": "Positive|Negative|Edge|Integration",
      "priority": "P0|P1|P2|P3",
      "description": "What this test validates",
      "preconditions": "Setup required",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "expected_result": "Expected outcome",
      "test_data": "Required test data"
    }
  ]
}

Distribution: 40% Positive, 30% Negative, 20% Edge, 10% Integration
Generate ${settings.testCount || 30} test cases total.`;

  const userMessage = `Generate test cases for:

**Ticket:** ${ticketKey}
**Summary:** ${ticketData.summary || 'N/A'}
**Description:** ${ticketData.description || 'N/A'}`;

  let accumulatedText = '';
  
  const testCasesResponse = await callAIStream(systemMessage, userMessage, settings, (chunk) => {
    accumulatedText += chunk;
    chrome.tabs.sendMessage(tabId, {
      action: 'streamChunk',
      requestId: requestId,
      chunk: chunk
    });
  }, requestId);
  
  // Parse the final response
  try {
    const jsonMatch = testCasesResponse.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No valid JSON found in response');
    }
    
    const parsed = JSON.parse(jsonMatch[0]);
    const testCases = parsed.testCases;
    
    if (!Array.isArray(testCases)) {
      throw new Error('testCases is not an array');
    }
    
    const stats = {
      total: testCases.length,
      byCategory: testCases.reduce((acc, tc) => {
        acc[tc.category] = (acc[tc.category] || 0) + 1;
        return acc;
      }, {}),
      byPriority: testCases.reduce((acc, tc) => {
        acc[tc.priority] = (acc[tc.priority] || 0) + 1;
        return acc;
      }, {})
    };
    
    return { testCases, ...stats, requestId };
  } catch (error) {
    throw new Error(`Failed to parse test cases: ${error.message}`);
  }
}

// Multi-agent test generation handler
async function handleGenerateTestCasesMultiAgent(data, tabId) {
  console.log('🎯 Background: handleGenerateTestCasesMultiAgent called');
  console.log('🎯 Background: data received:', { ticketKey: data.ticketKey, hasSettings: !!data.settings });
  console.log('🎯 Background: settings.llmProvider:', data.settings?.llmProvider);
  console.log('🎯 Background: settings.enableMultiAgent:', data.settings?.enableMultiAgent);

  validateSettings(data.settings);
  console.log('✅ Background: settings validated');

  const { ticketKey, ticketData, settings, externalSources: initialExternalSources } = data;
  
  // Fetch external content if integrations are configured and not already provided
  let enrichedTicketData = ticketData;
  let currentExternalSources = initialExternalSources;

  if (!currentExternalSources && (settings.confluenceUrl || settings.figmaToken || settings.googleApiKey)) {
    const integrationManager = new IntegrationManager(settings);
    const externalContent = await integrationManager.fetchAllLinkedContent(ticketData);

    if (externalContent.enrichedDescription !== ticketData.description) {
      enrichedTicketData = {
        ...ticketData,
        description: externalContent.enrichedDescription,
      };
      currentExternalSources = {
        confluence: externalContent.confluence.length,
        figma: externalContent.figma.length,
        googleDocs: externalContent.googleDocs.length
      };
    }
  }

  // Bind callAI to all agents
  const bindCallAI = (agent) => {
    // Agents call with (systemMessage, userMessage, settings)
    // but callAI expects (contentParts, settings)
    agent.callAI = async (systemMessage, userMessage, agentSettings) => {
      const contentParts = [
        { type: 'text', text: systemMessage },
        { type: 'text', text: userMessage }
      ];
      return await callAI(contentParts, agentSettings || settings);
    };
    agent.settings = settings;
  };
  
  // Create orchestrator with progress callback
  const orchestrator = new AgentOrchestrator(settings, (progress) => {
    // Send progress updates to content script
    chrome.tabs.sendMessage(tabId, {
      action: 'agentProgress',
      progress: progress
    });
  });
  
  // Bind callAI to all agents
  orchestrator.agents.forEach(bindCallAI);
  
  // First, analyze requirements if not already done
  let analysis = data.analysis;
  if (!analysis) {
    const analysisAgent = new RequirementAnalysisAgent();
    bindCallAI(analysisAgent);
    analysis = await analysisAgent.execute(enrichedTicketData, {}, settings);
  }
  
  // Execute all agents
  const results = await orchestrator.executeAgents(enrichedTicketData, analysis);
  
  // Apply enhancements (gap analysis, complexity scaling)
  let enhancementResults = null;
  if (settings.enableEnhanced !== false) {
    chrome.tabs.sendMessage(tabId, {
      action: 'enhancementProgress',
      status: 'analyzing'
    });

    // Create wrapper for EnhancementEngine that converts 3-param to 2-param callAI
    const enhancerCallAI = async (systemMessage, userMessage, enhancerSettings) => {
      const contentParts = [
        { type: 'text', text: systemMessage },
        { type: 'text', text: userMessage }
      ];
      return await callAI(contentParts, enhancerSettings || settings);
    };
    const enhancer = new EnhancementEngine(settings, enhancerCallAI);
    enhancementResults = await enhancer.enhance(results.testCases, enrichedTicketData, results.analysis);

    // Add gap-filling tests if any
    if (enhancementResults.additionalTests && enhancementResults.additionalTests.length > 0) {
      results.testCases.push(...enhancementResults.additionalTests);
    }

    chrome.tabs.sendMessage(tabId, {
      action: 'enhancementProgress',
      status: 'completed'
    });
  }

  // Apply historical mining if enabled
  let historicalResults = null;
  if (settings.enableHistoricalMining) {
    console.log('Starting historical mining...');

    chrome.tabs.sendMessage(tabId, {
      action: 'historicalMiningProgress',
      status: 'analyzing'
    });

    // Create wrapper for HistoricalMiningEngine that converts 3-param to 2-param callAI
    const historicalCallAI = async (systemMessage, userMessage, historicalSettings) => {
      const contentParts = [
        { type: 'text', text: systemMessage },
        { type: 'text', text: userMessage }
      ];
      return await callAI(contentParts, historicalSettings || settings);
    };
    const historicalMiner = new HistoricalMiningEngine(settings, historicalCallAI, data.baseUrl);
    historicalResults = await historicalMiner.mineAndEnhance(enrichedTicketData, results.testCases);

    // Replace testCases with enhanced version
    if (historicalResults && historicalResults.enhancedTests) {
      results.testCases = historicalResults.enhancedTests;
      console.log(`Historical mining complete: ${historicalResults.enhancedTests.length} tests`);
    }

    chrome.tabs.sendMessage(tabId, {
      action: 'historicalMiningProgress',
      status: 'completed'
    });
  }

  // Store original test count for comparison
  const originalTestCount = results.testCases.length;

  // Return base results immediately (don't wait for evolution)
  const baseResponse = {
    testCases: results.testCases,
    ...results.statistics,
    analysis: results.analysis,
    review: results.review,
    agentResults: results.agentResults,
    evolved: false,
    evolutionPending: settings.enableEvolution && results.testCases.length > 0,
    originalCount: originalTestCount,
    enhancements: enhancementResults,
    historicalInsights: historicalResults?.insights || null,
    historicalBugs: historicalResults?.historicalBugs || [],
    externalSources: currentExternalSources // Include external sources in the response
  };

  // Start evolution in background (non-blocking)
  if (settings.enableEvolution && results.testCases.length > 0) {
    runEvolutionInBackground(results.testCases, enrichedTicketData, settings, tabId, originalTestCount);
  }

  return baseResponse;
}

// Run evolutionary optimization in background without blocking
async function runEvolutionInBackground(baseTests, ticketData, settings, tabId, originalCount) {
  try {
    console.log('Starting background evolution with', settings.evolutionIntensity, 'intensity');

    const evolution = new EvolutionaryOptimizer(settings, (progress) => {
      // Send evolution progress to content script
      chrome.tabs.sendMessage(tabId, {
        action: 'evolutionProgress',
        progress: progress
      });
    });

    // Create wrapper for EvolutionaryOptimizer that converts 3-param to 2-param callAI
    const evolutionCallAI = async (systemMessage, userMessage, evolutionSettings) => {
      const contentParts = [
        { type: 'text', text: systemMessage },
        { type: 'text', text: userMessage }
      ];
      return await callAI(contentParts, evolutionSettings || settings);
    };
    const evolvedTests = await evolution.evolve(baseTests, ticketData, evolutionCallAI);

    // Calculate new statistics
    const statistics = {
      total: evolvedTests.length,
      byCategory: evolvedTests.reduce((acc, tc) => {
        acc[tc.category] = (acc[tc.category] || 0) + 1;
        return acc;
      }, {}),
      byPriority: evolvedTests.reduce((acc, tc) => {
        acc[tc.priority] = (acc[tc.priority] || 0) + 1;
        return acc;
      }, {})
    };

    console.log('Evolution complete:', evolvedTests.length, 'tests (was', originalCount, ')');

    // Send completion message to update UI
    chrome.tabs.sendMessage(tabId, {
      action: 'evolutionComplete',
      data: {
        testCases: evolvedTests,
        statistics: statistics,
        originalCount: originalCount,
        improvement: evolvedTests.length - originalCount
      }
    });
  } catch (error) {
    console.error('Evolution background error:', error);

    // Send error message to UI
    chrome.tabs.sendMessage(tabId, {
      action: 'evolutionError',
      error: error.message
    });
  }
}

// Handle regeneration with user review
async function handleRegenerateWithReview(data) {
  validateSettings(data.settings);

  const { type, originalContent, userReview, settings } = data;

  // Construct prompts based on type
  let systemMessage = '';
  let userMessage = '';

  if (type === 'analysis') {
    systemMessage = `You are a senior business analyst. You previously generated a requirement analysis, and the user has provided feedback to improve it.
Your task is to incorporate the user's feedback and generate an improved, more comprehensive version.`;

    userMessage = `Here is the original requirement analysis you generated:

---
${originalContent}
---

The user provided this feedback:
"${userReview}"

Please regenerate the requirement analysis incorporating the user's feedback. Maintain the same structured markdown format but enhance it based on the feedback provided.`;

  } else if (type === 'testScope') {
    systemMessage = `You are a test planning expert. You previously generated a test scope document, and the user has provided feedback to improve it.
Your task is to incorporate the user's feedback and generate an improved, more comprehensive version.`;

    userMessage = `Here is the original test scope you generated:

---
${originalContent}
---

The user provided this feedback:
"${userReview}"

Please regenerate the test scope incorporating the user's feedback. Maintain the same structured markdown format but enhance it based on the feedback provided.`;

  } else if (type === 'testCases') {
    systemMessage = `You are an expert QA engineer. You previously generated test cases, and the user has provided feedback to improve them.
Your task is to incorporate the user's feedback and generate improved test cases.

Generate test cases in this EXACT JSON format:
{
  "testCases": [
    {
      "id": "TC-XXX-001",
      "title": "Clear test case title",
      "category": "Positive|Negative|Edge|Integration",
      "priority": "P0|P1|P2|P3",
      "description": "What this test validates",
      "preconditions": "Setup required",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "expected_result": "Expected outcome",
      "test_data": "Required test data"
    }
  ]
}`;

    userMessage = `Here are the original test cases you generated:

---
${originalContent}
---

The user provided this feedback:
"${userReview}"

Please regenerate the test cases incorporating the user's feedback. Return the result as a JSON object with a "testCases" array. You can add new test cases, modify existing ones, or remove inadequate ones based on the feedback.`;
  } else {
    throw new Error(`Unknown regeneration type: ${type}`);
  }

  // Call AI with the combined prompt
  const improvedResponse = await callAI(systemMessage, userMessage, settings);

  // Handle test cases specially (need JSON parsing)
  if (type === 'testCases') {
    try {
      const jsonMatch = improvedResponse.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No valid JSON found in improved response');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const improvedTestCases = parsed.testCases;

      if (!Array.isArray(improvedTestCases)) {
        throw new Error('testCases is not an array');
      }

      return { improvedTestCases };
    } catch (error) {
      throw new Error(`Failed to parse improved test cases: ${error.message}`);
    }
  } else {
    // For analysis and test scope, return the improved content directly
    return { improvedContent: improvedResponse };
  }
}

// Installation handler
chrome.runtime.onInstalled.addListener(() => {
  console.log('QAtalyst extension installed with multi-agent system');
});

