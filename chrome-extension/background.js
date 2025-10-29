// Background service worker for QAtalyst
// Direct API calls to OpenAI, Claude, and Gemini with streaming support
// Multi-agent test generation system

const REQUEST_TIMEOUT = 90000; // 90 seconds for AI responses
const MAX_RETRIES = 2;
const RETRY_DELAY = 2000; // 2 seconds

// Active streaming controllers for cancellation
const activeStreams = new Map();

// Import agent system, evolution, integrations, and enhancements
importScripts('agents.js');
importScripts('evolution.js');
importScripts('integrations.js');
importScripts('enhancements.js');

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
  
  return false;
});

// Sleep utility for retry delays
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Call OpenAI API directly
async function callOpenAI(messages, settings, retries = MAX_RETRIES) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  
  try {
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
      return callOpenAI(messages, settings, retries - 1);
    }
    
    if (error.name === 'AbortError') {
      throw new Error('Request timeout - AI is taking too long. Please try again.');
    }
    throw error;
  }
}

// Call Gemini API directly
async function callGemini(prompt, settings, retries = MAX_RETRIES) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  
  try {
    const model = settings.llmModel || 'gemini-2.0-flash-exp';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${settings.apiKey}`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
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
      return callGemini(prompt, settings, retries - 1);
    }
    
    if (error.name === 'AbortError') {
      throw new Error('Request timeout - AI is taking too long. Please try again.');
    }
    throw error;
  }
}

// Call Claude (Anthropic) API directly
async function callClaude(messages, settings, retries = MAX_RETRIES) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  
  try {
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
        system: messages[0].role === 'system' ? messages[0].content : undefined,
        messages: messages.filter(m => m.role !== 'system').map(m => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content
        })),
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
      return callClaude(messages, settings, retries - 1);
    }
    
    if (error.name === 'AbortError') {
      throw new Error('Request timeout - AI is taking too long. Please try again.');
    }
    throw error;
  }
}

// Streaming version of OpenAI API
async function callOpenAIStream(messages, settings, onChunk, requestId) {
  const controller = new AbortController();
  activeStreams.set(requestId, controller);
  
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        model: settings.llmModel || 'gpt-4o',
        messages: messages,
        stream: true,
        temperature: settings.temperature || 0.7,
        max_tokens: settings.maxTokens || 4000
      }),
      signal: controller.signal
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `OpenAI API error: ${response.status}`);
    }
    
    const reader = response.body.getReader();
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
    
    activeStreams.delete(requestId);
    return fullResponse;
    
  } catch (error) {
    activeStreams.delete(requestId);
    if (error.name === 'AbortError') {
      throw new Error('Generation cancelled by user');
    }
    throw error;
  }
}

// Streaming version of Claude API
async function callClaudeStream(messages, settings, onChunk, requestId) {
  const controller = new AbortController();
  activeStreams.set(requestId, controller);
  
  try {
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
        system: messages[0].role === 'system' ? messages[0].content : undefined,
        messages: messages.filter(m => m.role !== 'system').map(m => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          content: m.content
        })),
        temperature: settings.temperature || 0.7,
        stream: true
      }),
      signal: controller.signal
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Claude API error: ${response.status}`);
    }
    
    const reader = response.body.getReader();
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
    
    activeStreams.delete(requestId);
    return fullResponse;
    
  } catch (error) {
    activeStreams.delete(requestId);
    if (error.name === 'AbortError') {
      throw new Error('Generation cancelled by user');
    }
    throw error;
  }
}

// Streaming version of Gemini API (Note: Gemini uses SSE differently)
async function callGeminiStream(prompt, settings, onChunk, requestId) {
  const controller = new AbortController();
  activeStreams.set(requestId, controller);
  
  try {
    const model = settings.llmModel || 'gemini-2.0-flash-exp';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${settings.apiKey}&alt=sse`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: prompt }]
        }],
        generationConfig: {
          temperature: settings.temperature || 0.7,
          maxOutputTokens: settings.maxTokens || 4000
        }
      }),
      signal: controller.signal
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error?.message || `Gemini API error: ${response.status}`);
    }
    
    const reader = response.body.getReader();
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
    
    activeStreams.delete(requestId);
    return fullResponse;
    
  } catch (error) {
    activeStreams.delete(requestId);
    if (error.name === 'AbortError') {
      throw new Error('Generation cancelled by user');
    }
    throw error;
  }
}

// Unified streaming AI call function
async function callAIStream(systemMessage, userMessage, settings, onChunk, requestId) {
  if (settings.llmProvider === 'openai') {
    return await callOpenAIStream([
      { role: 'system', content: systemMessage },
      { role: 'user', content: userMessage }
    ], settings, onChunk, requestId);
  } else if (settings.llmProvider === 'gemini') {
    const fullPrompt = `${systemMessage}\n\nUser Request: ${userMessage}`;
    return await callGeminiStream(fullPrompt, settings, onChunk, requestId);
  } else if (settings.llmProvider === 'claude') {
    return await callClaudeStream([
      { role: 'system', content: systemMessage },
      { role: 'user', content: userMessage }
    ], settings, onChunk, requestId);
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
async function callAI(systemMessage, userMessage, settings) {
  if (settings.llmProvider === 'openai') {
    return await callOpenAI([
      { role: 'system', content: systemMessage },
      { role: 'user', content: userMessage }
    ], settings);
  } else if (settings.llmProvider === 'gemini') {
    const fullPrompt = `${systemMessage}\n\nUser Request: ${userMessage}`;
    return await callGemini(fullPrompt, settings);
  } else if (settings.llmProvider === 'claude') {
    return await callClaude([
      { role: 'system', content: systemMessage },
      { role: 'user', content: userMessage }
    ], settings);
  } else {
    throw new Error(`Unsupported AI provider: ${settings.llmProvider}`);
  }
}

// Validate settings before API calls
function validateSettings(settings) {
  const errors = [];
  
  if (!settings.apiKey || settings.apiKey.trim() === '') {
    errors.push('API Key is required. Please configure it in extension settings.');
  }
  
  if (!settings.llmProvider) {
    errors.push('LLM Provider is required. Please select one in settings.');
  }
  
  if (!settings.llmModel) {
    errors.push('LLM Model is required. Please select one in settings.');
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
  if (settings.confluenceUrl || settings.figmaToken || settings.googleApiKey) {
    const integrationManager = new IntegrationManager(settings);
    const externalContent = await integrationManager.fetchAllLinkedContent(ticketData);
    
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
  
  const systemMessage = `You are a senior business analyst specializing in requirement analysis.
Analyze Jira tickets and extract structured requirements for test case generation.

Focus on:
1. Feature overview and objectives
2. Functional requirements (what the system should do)
3. UI/UX specifications
4. Integration points and dependencies  
5. Acceptance criteria
6. Edge cases and constraints

Provide a well-structured analysis in markdown format.`;

  const userMessage = `Analyze this Jira ticket:

**Ticket:** ${ticketKey}
**Summary:** ${enrichedTicketData.summary || 'N/A'}
**Description:** ${enrichedTicketData.description || 'N/A'}
**Comments:** ${enrichedTicketData.comments?.length || 0} comments
**Attachments:** ${enrichedTicketData.attachments?.length || 0} files
**Linked Pages:** ${enrichedTicketData.linkedPages?.length || 0} pages
${enrichedTicketData.externalSources ? `**External Sources:** ${enrichedTicketData.externalSources.confluence} Confluence, ${enrichedTicketData.externalSources.figma} Figma, ${enrichedTicketData.externalSources.googleDocs} Google Docs` : ''}

Provide comprehensive requirement analysis.`;

  const analysis = await callAI(systemMessage, userMessage, settings);
  
  return { 
    analysis,
    externalSources: enrichedTicketData.externalSources
  };
}

async function handleGenerateTestScope(data) {
  validateSettings(data.settings);
  
  const { ticketKey, ticketData, settings } = data;
  
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
**Summary:** ${ticketData.summary || 'N/A'}
**Description:** ${ticketData.description || 'N/A'}

Provide detailed test scope covering all aspects.`;

  const scope = await callAI(systemMessage, userMessage, settings);
  
  return { scope };
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

  const response = await callAI(systemMessage, userMessage, settings);
  
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
  
  const systemMessage = `You are a senior business analyst specializing in requirement analysis.
Analyze Jira tickets and extract structured requirements for test case generation.

Focus on:
1. Feature overview and objectives
2. Functional requirements (what the system should do)
3. UI/UX specifications
4. Integration points and dependencies  
5. Acceptance criteria
6. Edge cases and constraints

Provide a well-structured analysis in markdown format.`;

  const userMessage = `Analyze this Jira ticket:

**Ticket:** ${ticketKey}
**Summary:** ${ticketData.summary || 'N/A'}
**Description:** ${ticketData.description || 'N/A'}
**Comments:** ${ticketData.comments?.length || 0} comments
**Attachments:** ${ticketData.attachments?.length || 0} files
**Linked Pages:** ${ticketData.linkedPages?.length || 0} pages

Provide comprehensive requirement analysis.`;

  const analysis = await callAIStream(systemMessage, userMessage, settings, (chunk) => {
    // Send each chunk to content script
    chrome.tabs.sendMessage(tabId, {
      action: 'streamChunk',
      requestId: requestId,
      chunk: chunk
    });
  }, requestId);
  
  return { analysis, requestId };
}

async function handleGenerateTestScopeStream(data, tabId) {
  validateSettings(data.settings);
  
  const { ticketKey, ticketData, settings } = data;
  const requestId = `scope-${Date.now()}`;
  
  const systemMessage = `You are a test planning expert creating comprehensive test scope documents.`;

  const userMessage = `Create a test scope document for:

**Ticket:** ${ticketKey}
**Summary:** ${ticketData.summary || 'N/A'}
**Description:** ${ticketData.description || 'N/A'}

Include:
1. Testing objectives
2. In-scope features
3. Out-of-scope items
4. Test approach
5. Risk assessment
6. Success criteria`;

  const testScope = await callAIStream(systemMessage, userMessage, settings, (chunk) => {
    chrome.tabs.sendMessage(tabId, {
      action: 'streamChunk',
      requestId: requestId,
      chunk: chunk
    });
  }, requestId);
  
  return { testScope, requestId };
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
  validateSettings(data.settings);
  
  const { ticketKey, ticketData, settings } = data;
  
  // Bind callAI to all agents
  const bindCallAI = (agent) => {
    agent.callAI = callAI.bind(null);
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
    analysis = await analysisAgent.execute(ticketData, {}, settings);
  }
  
  // Execute all agents
  const results = await orchestrator.executeAgents(ticketData, analysis);
  
  // Apply enhancements (gap analysis, complexity scaling)
  let enhancementResults = null;
  if (settings.enableEnhanced !== false) {
    chrome.tabs.sendMessage(tabId, {
      action: 'enhancementProgress',
      status: 'analyzing'
    });
    
    const enhancer = new EnhancementEngine(settings, callAI.bind(null));
    enhancementResults = await enhancer.enhance(results.testCases, ticketData, results.analysis);
    
    // Add gap-filling tests if any
    if (enhancementResults.additionalTests && enhancementResults.additionalTests.length > 0) {
      results.testCases.push(...enhancementResults.additionalTests);
    }
    
    chrome.tabs.sendMessage(tabId, {
      action: 'enhancementProgress',
      status: 'completed'
    });
  }
  
  // Apply evolutionary optimization if enabled
  let finalTestCases = results.testCases;
  if (settings.enableEvolution && results.testCases.length > 0) {
    const evolution = new EvolutionaryOptimizer(settings, (progress) => {
      // Send evolution progress to content script
      chrome.tabs.sendMessage(tabId, {
        action: 'evolutionProgress',
        progress: progress
      });
    });
    
    finalTestCases = await evolution.evolve(
      results.testCases,
      ticketData,
      callAI.bind(null)
    );
    
    // Recalculate statistics
    results.statistics = {
      total: finalTestCases.length,
      byCategory: finalTestCases.reduce((acc, tc) => {
        acc[tc.category] = (acc[tc.category] || 0) + 1;
        return acc;
      }, {}),
      byPriority: finalTestCases.reduce((acc, tc) => {
        acc[tc.priority] = (acc[tc.priority] || 0) + 1;
        return acc;
      }, {})
    };
  }
  
  return {
    testCases: finalTestCases,
    ...results.statistics,
    analysis: results.analysis,
    review: results.review,
    agentResults: results.agentResults,
    evolved: settings.enableEvolution,
    enhancements: enhancementResults
  };
}

// Installation handler
chrome.runtime.onInstalled.addListener(() => {
  console.log('QAtalyst extension installed with multi-agent system');
});
