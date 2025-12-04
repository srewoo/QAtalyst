// Multi-Agent Test Generation System
// Client-side agent orchestration for QAtalyst

// Import DuplicateDetector if available
// Check if DuplicateDetector is already defined (e.g., in service worker context)
if (typeof DuplicateDetector === 'undefined') {
  try {
    // Try to load the duplicate detector if it exists
    if (typeof require !== 'undefined') {
      DuplicateDetector = require('./duplicate-detector.js');
    } else if (typeof window !== 'undefined' && window.DuplicateDetector) {
      // Will be loaded via script tag in browser
      DuplicateDetector = window.DuplicateDetector;
    }
  } catch (e) {
    // Duplicate detector not available
    console.log('DuplicateDetector not available:', e.message);
  }
}

/**
 * Robust JSON parser that handles common AI-generated JSON errors
 */
function parseRobustJSON(jsonString) {
  // Try direct parse first
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    // Attempt to fix common issues
    let fixed = jsonString;

    // Remove trailing commas before } or ]
    fixed = fixed.replace(/,(\s*[}\]])/g, '$1');

    // Add missing commas between properties (common error)
    fixed = fixed.replace(/"\s*\n\s*"/g, '",\n"');

    // Fix missing commas after closing arrays/objects
    fixed = fixed.replace(/(\]|\})\s*\n\s*"/g, '$1,\n"');

    // Remove comments (if AI added them)
    fixed = fixed.replace(/\/\/.*/g, '');
    fixed = fixed.replace(/\/\*[\s\S]*?\*\//g, '');

    try {
      return JSON.parse(fixed);
    } catch (e2) {
      // Last resort: try to extract valid JSON portion
      const match = fixed.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch (e3) {
          throw new Error(`JSON parsing failed: ${e.message} at ${e2.message}`);
        }
      }
      throw e2;
    }
  }
}

class AgentOrchestrator {
  constructor(settings, onProgress) {
    this.settings = settings;
    this.onProgress = onProgress;
    this.agents = this.initializeAgents();
  }
  
  initializeAgents() {
    return [
      new ContextAnalysisAgent(),
      new RequirementAnalysisAgent(),
      new PositiveTestAgent(),
      new NegativeTestAgent(),
      new EdgeCaseAgent(),
      new RegressionTestAgent(),
      new IntegrationTestAgent(),
      new AIFeatureTestAgent(),
      new ReviewAgent()
    ];
  }
  
  async executeAgents(ticketData, analysisContext = null, appContext = null) {
    const results = {
      analysis: analysisContext || null,
      testCases: [],
      agentResults: {},
      statistics: {},
      appContext: appContext || null // Store app context in results
    };

    // Check if we have knowledge graph to analyze
    if (appContext && appContext.knowledgeGraph) {
      console.log(`[ORCHESTRATOR] 📊 Knowledge graph available with ${Object.keys(appContext.knowledgeGraph.pages || {}).length} pages`);
    } else {
      console.log(`[ORCHESTRATOR] ℹ️ No knowledge graph available (running without crawled data)`);
    }

    // Detect AI features in ticket
    const aiDetection = AIFeatureTestAgent.detectAIFeatures(ticketData);
    if (aiDetection.isAIFeature) {
      console.log(`[ORCHESTRATOR] 🤖 AI features detected (${aiDetection.confidence} confidence):`, aiDetection.keywords);
      // Enable AIFeatureTestAgent by setting flag
      const aiAgent = this.agents.find(a => a instanceof AIFeatureTestAgent);
      if (aiAgent) {
        aiAgent.hasAIFeatures = true;
      }
    } else {
      console.log(`[ORCHESTRATOR] ℹ️ No AI features detected - AIFeatureTestAgent will be skipped`);
    }

    const enabledAgents = this.agents.filter(agent => agent.isEnabled(this.settings));

    for (let i = 0; i < enabledAgents.length; i++) {
      const agent = enabledAgents[i];

      // Report progress
      if (this.onProgress) {
        this.onProgress({
          agent: agent.name,
          step: i + 1,
          total: enabledAgents.length,
          status: 'running',
          description: agent.description
        });
      }

      try {
        // Use batched execution for test agents to prevent timeouts
        const isTestAgent = agent instanceof PositiveTestAgent ||
                           agent instanceof NegativeTestAgent ||
                           agent instanceof EdgeCaseAgent ||
                           agent instanceof RegressionTestAgent ||
                           agent instanceof IntegrationTestAgent ||
                           agent instanceof AIFeatureTestAgent;

        let agentResult;
        if (isTestAgent) {
          // Use batched execution: 4 batches of 3 tests each = 12 tests per agent
          agentResult = await agent.executeBatched(ticketData, results, this.settings, appContext, {
            batches: 4,
            testsPerBatch: 3
          });
        } else {
          // Regular execution for non-test agents (Context, Requirements, Review)
          agentResult = await agent.execute(ticketData, results, this.settings, appContext);
        }

        // Store agent results
        results.agentResults[agent.name] = agentResult;

        // Context Analysis stores context summary
        if (agent instanceof ContextAnalysisAgent) {
          results.contextSummary = agentResult.summary;
          console.log(`[ORCHESTRATOR] 📝 Context summary created: ${agentResult.summary?.length || 0} chars`);
        }
        // Requirement Analysis stores analysis
        else if (agent instanceof RequirementAnalysisAgent) {
          results.analysis = agentResult;
        }
        // Review Agent stores review
        else if (agent instanceof ReviewAgent) {
          results.review = agentResult;
        }
        // Test agents add test cases
        else if (Array.isArray(agentResult)) {
          results.testCases.push(...agentResult);
        }
        
        // Report completion
        if (this.onProgress) {
          this.onProgress({
            agent: agent.name,
            step: i + 1,
            total: enabledAgents.length,
            status: 'completed',
            count: Array.isArray(agentResult) ? agentResult.length : 0
          });
        }
      } catch (error) {
        console.error(`Agent ${agent.name} failed:`, error);
        if (this.onProgress) {
          this.onProgress({
            agent: agent.name,
            step: i + 1,
            total: enabledAgents.length,
            status: 'error',
            error: error.message
          });
        }
      }
    }
    
    // Calculate statistics
    results.statistics = this.calculateStatistics(results.testCases);
    
    return results;
  }
  
  calculateStatistics(testCases) {
    return {
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
  }
}

// Base Agent class
class BaseAgent {
  constructor(name, description, defaultEnabled = true) {
    this.name = name;
    this.description = description;
    this.defaultEnabled = defaultEnabled;
  }
  
  isEnabled(settings) {
    const key = `enable${this.name}Agent`;
    return settings[key] !== false;
  }
  
  async execute(ticketData, previousResults, settings, appContext = null) {
    const systemMessage = this.getSystemMessage(previousResults);
    const userMessage = this.getUserMessage(ticketData, previousResults, appContext);

    // Call AI (will use callAI from background.js context)
    const response = await this.callAI(systemMessage, userMessage, settings);

    return this.parseResponse(response);
  }

  // Batched execution to prevent timeouts on large requests
  // Splits the work into smaller batches and aggregates results
  async executeBatched(ticketData, previousResults, settings, appContext = null, batchConfig = null) {
    // Default batch configuration
    const config = batchConfig || {
      batches: 3,           // Number of batches
      testsPerBatch: 3      // Tests to generate per batch
    };

    console.log(`[${this.name}] 🔄 Using batched execution: ${config.batches} batches × ${config.testsPerBatch} tests each`);

    const allResults = [];

    for (let i = 0; i < config.batches; i++) {
      console.log(`[${this.name}] 📦 Batch ${i + 1}/${config.batches}...`);

      try {
        const systemMessage = this.getSystemMessage(previousResults, i + 1, config.batches, config.testsPerBatch);
        const userMessage = this.getUserMessageBatched(ticketData, previousResults, appContext, i + 1, config.batches, config.testsPerBatch);

        // Call AI for this batch
        const response = await this.callAI(systemMessage, userMessage, settings);
        const batchResults = this.parseResponse(response);

        // Accumulate results
        if (Array.isArray(batchResults)) {
          allResults.push(...batchResults);
          console.log(`[${this.name}] ✅ Batch ${i + 1} complete: ${batchResults.length} tests generated`);
        }
      } catch (error) {
        console.error(`[${this.name}] ❌ Batch ${i + 1} failed:`, error.message);
        // Continue with next batch even if one fails
      }
    }

    console.log(`[${this.name}] 🎉 All batches complete: ${allResults.length} total tests`);
    return allResults;
  }

  // Override this in subclasses to customize batch messages
  // Default implementation: modifies the regular getUserMessage to request fewer tests
  getUserMessageBatched(ticketData, previousResults, appContext, batchNum, totalBatches, testsPerBatch) {
    const originalMessage = this.getUserMessage(ticketData, previousResults, appContext);

    // Replace any "Generate X test cases" with "Generate testsPerBatch test cases"
    // This is a smart default that works for most agents
    const batchMessage = originalMessage.replace(
      /Generate \d+ (?:UNIQUE )?(?:positive|negative|edge|regression|integration)? ?test cases/gi,
      `Generate ${testsPerBatch} test cases (batch ${batchNum}/${totalBatches})`
    );

    return batchMessage;
  }

  getSystemMessage(previousResults) {
    throw new Error('Must implement getSystemMessage in subclass');
  }

  getUserMessage(ticketData, previousResults, appContext = null) {
    throw new Error('Must implement getUserMessage in subclass');
  }
  
  parseResponse(response) {
    // Default: return raw response
    return response;
  }
  
  // This will be set by background.js to use its callAI function
  async callAI(systemMessage, userMessage, settings) {
    throw new Error('callAI must be bound from background.js');
  }

  // Format app context for inclusion in prompts
  // NOTE: Prefers intelligent context summary over raw JSON (massive size reduction!)
  formatAppContext(appContext, previousResults = null) {
    // First, check if we have an intelligent context summary (generated by ContextAnalysisAgent)
    // This is MUCH better than raw JSON - it's concise, focused, and already analyzed
    if (previousResults && previousResults.contextSummary) {
      let formatted = '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      formatted += '📱 APPLICATION CONTEXT (Intelligent Feature Summary)\n';
      formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
      formatted += previousResults.contextSummary;
      formatted += '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      formatted += '💡 Use the ACTUAL field names, API endpoints, and UI components mentioned above.\n';
      formatted += '   Reference specific forms, fields, and APIs when writing test cases.\n';
      formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      return formatted;
    }

    // Fallback: If no summary, use raw appContext (legacy behavior)
    if (!appContext) {
      return '';
    }

    // NEW: Handle knowledge graph directly if present (when ContextAnalysisAgent is disabled)
    if (appContext.knowledgeGraph) {
      const kg = appContext.knowledgeGraph;
      let formatted = '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      formatted += '📱 APPLICATION CONTEXT (From Crawled Knowledge Graph)\n';
      formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

      formatted += `🌐 Application: ${appContext.appUrl || 'Unknown'}\n`;
      formatted += `📄 Total Pages Crawled: ${appContext.pageCount || Object.keys(kg.pages || {}).length}\n\n`;

      // Add forms from knowledge graph
      if (kg.forms && kg.forms.length > 0) {
        formatted += '📝 FORMS FOUND:\n';
        kg.forms.slice(0, 5).forEach((form, index) => {
          formatted += `\n${index + 1}. Form on ${form.url}\n`;
          formatted += `   • ID: ${form.id || 'N/A'}\n`;
          formatted += `   • Action: ${form.action || 'N/A'}\n`;
          formatted += `   • Method: ${form.method}\n`;
          if (form.inputs && form.inputs.length > 0) {
            formatted += `   • Fields:\n`;
            form.inputs.slice(0, 10).forEach(input => {
              const required = input.required ? ' (required)' : '';
              formatted += `     - ${input.name || input.id}: ${input.type}${required}\n`;
            });
          }
        });
        if (kg.forms.length > 5) {
          formatted += `\n   ... and ${kg.forms.length - 5} more forms\n`;
        }
        formatted += '\n';
      }

      // Add APIs from knowledge graph
      if (kg.apis && kg.apis.length > 0) {
        formatted += '🔌 API ENDPOINTS DETECTED:\n';
        kg.apis.slice(0, 10).forEach((api, index) => {
          formatted += `\n${index + 1}. ${api.method} ${api.endpoint}\n`;
          formatted += `   • Page: ${api.url}\n`;
        });
        if (kg.apis.length > 10) {
          formatted += `\n   ... and ${kg.apis.length - 10} more API endpoints\n`;
        }
        formatted += '\n';
      }

      // Add stats summary
      if (kg.stats) {
        formatted += '📊 CRAWL STATISTICS:\n';
        formatted += `   • Total Features: ${kg.stats.totalFeatures || 0}\n`;
        formatted += `   • Total APIs: ${kg.stats.totalApis || 0}\n`;
        formatted += `   • Total Forms: ${kg.stats.totalForms || 0}\n`;
        formatted += '\n';
      }

      formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      formatted += '💡 Use the ACTUAL field names, button labels, and API endpoints from above.\n';
      formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      return formatted;
    }

    let formatted = '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    formatted += '📱 APPLICATION CONTEXT (From Crawled Knowledge Graph)\n';
    formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    formatted += `🌐 Application: ${appContext.appUrl}\n`;
    formatted += `📄 Total Pages Crawled: ${appContext.totalPages}\n\n`;

    // Add forms
    if (appContext.forms && appContext.forms.length > 0) {
      formatted += '📝 FORMS FOUND:\n';
      appContext.forms.slice(0, 5).forEach((form, index) => {
        formatted += `\n${index + 1}. Form on ${form.url}\n`;
        formatted += `   • ID: ${form.id || 'N/A'}\n`;
        formatted += `   • Action: ${form.action || 'N/A'}\n`;
        formatted += `   • Method: ${form.method}\n`;
        if (form.inputs && form.inputs.length > 0) {
          formatted += `   • Fields:\n`;
          form.inputs.slice(0, 10).forEach(input => {
            const required = input.required ? ' (required)' : '';
            formatted += `     - ${input.name || input.id}: ${input.type}${required}\n`;
          });
        }
      });
      if (appContext.forms.length > 5) {
        formatted += `\n   ... and ${appContext.forms.length - 5} more forms\n`;
      }
      formatted += '\n';
    }

    // Add APIs
    if (appContext.apis && appContext.apis.length > 0) {
      formatted += '🔌 API ENDPOINTS DETECTED:\n';
      appContext.apis.slice(0, 10).forEach((api, index) => {
        formatted += `\n${index + 1}. ${api.method} ${api.endpoint}\n`;
        formatted += `   • Page: ${api.url}\n`;
        if (api.payload) {
          formatted += `   • Payload: ${JSON.stringify(api.payload)}\n`;
        }
      });
      if (appContext.apis.length > 10) {
        formatted += `\n   ... and ${appContext.apis.length - 10} more API endpoints\n`;
      }
      formatted += '\n';
    }

    // Add buttons
    if (appContext.features && appContext.features.length > 0) {
      const buttons = appContext.features.filter(f => f.type === 'button');
      if (buttons.length > 0) {
        formatted += '🔘 BUTTONS FOUND:\n';
        buttons.slice(0, 10).forEach((btn, index) => {
          formatted += `   ${index + 1}. "${btn.text || btn.id}" on ${btn.url}\n`;
        });
        if (buttons.length > 10) {
          formatted += `   ... and ${buttons.length - 10} more buttons\n`;
        }
        formatted += '\n';
      }
    }

    formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    formatted += '💡 Use the above ACTUAL implementation details when generating test cases.\n';
    formatted += 'Include real field names, API endpoints, and button labels in your tests.\n';
    formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

    return formatted;
  }
}

// 0. Context Analysis Agent - NEW! Understands crawled app data
class ContextAnalysisAgent extends BaseAgent {
  constructor() {
    super('ContextAnalysis', 'Analyzes crawled application data and creates intelligent summary', true);
  }

  getSystemMessage() {
    return `You are an expert application analyst specializing in understanding web applications from their structure.

Your task: Analyze the crawled knowledge graph data (forms, APIs, pages) and create an intelligent, concise feature summary for the given Jira ticket.

**Your summary MUST include these 4 key sections:**

1. **MAIN PURPOSE** 🎯
   - What is the primary purpose of this feature?
   - What problem does it solve for users?
   - What is the business value?

2. **HOW IT WORKS** ⚙️
   - What is the user workflow/journey?
   - What forms/fields does the user interact with?
   - What API endpoints are called and in what sequence?
   - How do different components connect together?
   - What data flows between systems?

3. **UI COMPONENTS** 🎨
   - What forms are present and what fields do they contain?
   - What buttons/actions are available?
   - What pages/screens are involved?
   - How does the user navigate through the feature?
   - What validation rules are in place?

4. **SECURITY & PERFORMANCE CONSIDERATIONS** 🔒⚡
   - What authentication/authorization is required?
   - What sensitive data is handled (PII, passwords, tokens)?
   - What are the performance-critical operations?
   - What are potential bottlenecks (large data sets, file uploads)?
   - What rate limiting or throttling exists?
   - What error states and edge cases are handled?

**CRITICAL**:
- Keep it concise (300-600 words) but comprehensive
- Reference ACTUAL form fields, button names, and API endpoints from the data
- Be specific and technical - use real field names and endpoints
- Identify security risks and performance concerns explicitly
- Write in clear, structured format with the 4 sections above

**Output Format**: Plain text summary with clear sections, NOT test cases.`;
  }

  getUserMessage(ticketData, previousResults, appContext) {
    // Extract knowledge graph from appContext
    const knowledgeGraph = appContext?.knowledgeGraph;

    if (!knowledgeGraph || !knowledgeGraph.pages) {
      return 'No application context available. Skip this analysis.';
    }

    const pageCount = Object.keys(knowledgeGraph.pages).length;
    const formCount = knowledgeGraph.forms?.length || 0;
    const apiCount = knowledgeGraph.apis?.length || 0;

    // Build concise context representation
    let contextStr = `**JIRA TICKET TO ANALYZE**\n`;
    contextStr += `Key: ${ticketData.key}\n`;
    contextStr += `Summary: ${ticketData.summary}\n`;
    contextStr += `Description: ${ticketData.description || 'N/A'}\n\n`;

    contextStr += `**CRAWLED APPLICATION DATA** (${pageCount} pages analyzed):\n\n`;

    // Forms with detailed field information
    if (formCount > 0) {
      contextStr += `📝 **FORMS DETECTED** (${formCount} forms):\n`;
      knowledgeGraph.forms.slice(0, 10).forEach((form, i) => {
        contextStr += `\n${i + 1}. Page: ${form.url}\n`;
        contextStr += `   Form ID: ${form.id || 'N/A'}\n`;
        contextStr += `   Action: ${form.action || 'N/A'}\n`;
        contextStr += `   Method: ${form.method}\n`;
        if (form.inputs && form.inputs.length > 0) {
          contextStr += `   Fields detected:\n`;
          form.inputs.slice(0, 10).forEach(input => {
            const req = input.required ? ' (required)' : '';
            contextStr += `     • ${input.name || input.id}: ${input.type}${req}\n`;
          });
        }
      });
      contextStr += '\n';
    }

    // API endpoints with payload information
    if (apiCount > 0) {
      contextStr += `🔌 **API ENDPOINTS DETECTED** (${apiCount} endpoints):\n`;
      knowledgeGraph.apis.slice(0, 15).forEach((api, i) => {
        contextStr += `\n${i + 1}. ${api.method} ${api.endpoint}\n`;
        contextStr += `   Called from: ${api.url}\n`;
        if (api.payload) {
          const payloadKeys = Object.keys(api.payload).slice(0, 5).join(', ');
          contextStr += `   Payload fields: ${payloadKeys}\n`;
        }
        if (api.response) {
          contextStr += `   Response: ${JSON.stringify(api.response).substring(0, 100)}...\n`;
        }
      });
      contextStr += '\n';
    }

    contextStr += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    contextStr += `**YOUR TASK:**\n\n`;
    contextStr += `Analyze the above application data in the context of the Jira ticket.\n`;
    contextStr += `Create a feature summary with these 3 sections:\n\n`;
    contextStr += `**1. MAIN PURPOSE** 🎯\n`;
    contextStr += `Explain what this feature does and why it exists.\n\n`;
    contextStr += `**2. HOW IT WORKS** ⚙️\n`;
    contextStr += `Describe the user workflow, which forms/fields are used, which APIs are called, and in what sequence.\n\n`;
    contextStr += `**3. UI COMPONENTS** 🎨\n`;
    contextStr += `List the actual forms, fields, buttons, and pages involved.\n\n`;
    contextStr += `**IMPORTANT:**\n`;
    contextStr += `- Reference ACTUAL field names, endpoints, and form IDs from the data above\n`;
    contextStr += `- Be specific and technical\n`;
    contextStr += `- Keep it 200-500 words total\n`;
    contextStr += `- This summary will be used by test generation agents`;

    return contextStr;
  }

  parseResponse(response) {
    // Return the summary as-is (it's already formatted text)
    return {
      summary: response,
      type: 'context-summary'
    };
  }
}

// 1. Requirement Analysis Agent
class RequirementAnalysisAgent extends BaseAgent {
  constructor() {
    super('RequirementAnalysis', 'Analyzes and structures requirements from Jira ticket', true);
  }
  
  getSystemMessage(previousResults) {
    const hasContext = previousResults?.contextSummary;

    return `You are a senior business analyst specializing in requirement analysis.
Analyze Jira tickets and extract structured requirements for test case generation.

${hasContext ? '**CRITICAL**: You have access to the actual application context. Cross-reference requirements with the real implementation to identify gaps or discrepancies.' : ''}

Focus on:
1. Feature overview and objectives
2. Functional requirements (what the system should do)
3. UI/UX specifications ${hasContext ? '(validate against actual UI components)' : ''}
4. Integration points and dependencies ${hasContext ? '(verify against actual APIs)' : ''}
5. Acceptance criteria
6. Edge cases and constraints
7. Business rules and validations
8. ${hasContext ? 'Implementation gaps (requirements not yet implemented)' : 'Potential implementation challenges'}
9. ${hasContext ? 'Additional features found (implemented but not in requirements)' : 'Assumptions and risks'}

${hasContext ? 'VALIDATION TASK: Compare the requirements with the Context Summary. Note any differences between what is requested and what is actually implemented.' : ''}

Provide a well-structured analysis in markdown format with clear sections.`;
  }
  
  getUserMessage(ticketData, previousResults, appContext = null) {
    const contextSection = previousResults?.contextSummary
      ? `\n**APPLICATION CONTEXT (From Crawled Data):**\n${previousResults.contextSummary}\n\n**TASK: Cross-reference the requirements below with the actual implementation above.**\n\n`
      : '';

    return `Analyze this Jira ticket comprehensively:
${contextSection}
**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary || 'N/A'}
**Type:** ${ticketData.type || 'N/A'}
**Description:**
${ticketData.description || 'No description provided'}

**Comments:** ${ticketData.comments?.length || 0} comments available
**Attachments:** ${ticketData.attachments?.length || 0} files attached
**Linked Pages:** ${ticketData.linkedPages?.length || 0} pages linked

Provide a comprehensive requirement analysis.`;
  }
}

// 2. Positive Test Agent (40% of tests)
class PositiveTestAgent extends BaseAgent {
  constructor() {
    super('PositiveTest', 'Generates user story-aligned functional and UI test scenarios', true);
  }

  getSystemMessage(previousResults) {
    // Check if images are available for visual analysis
    const hasVisualContext = this.hasImages?.figma || this.hasImages?.jira;

    const visualAnalysisSection = hasVisualContext ? `
**🎨 FIGMA/UI DESIGN ANALYSIS (CRITICAL - Images Attached):**
You have Figma designs or screenshots attached. Generate BOTH functional AND visual validation tests.

**PART A: FUNCTIONAL UI TESTS (Test interactions)**
Extract every interactive element and create tests for:
- Buttons: Click actions, hover states, disabled states
- Input fields: Valid input, placeholder text, focus states
- Modals/Dialogs: Open, close, action buttons
- Dropdowns: Open, select options, close
- Checkboxes/Toggles: Check, uncheck, visual state change

**PART B: VISUAL VALIDATION TESTS (Test appearance - IMPORTANT!)**
For each screen/component in the Figma design, create visual tests:

1. **Element Presence Tests:**
   - "Verify 'Start Recording' button is visible on the modal"
   - "Verify 'Meeting Title' label is displayed above the input field"
   - "Verify consent checkbox is present before the submit button"

2. **Text/Label Tests:**
   - "Verify modal title displays 'Record a Live Meeting'"
   - "Verify placeholder text shows 'Enter meeting title'"
   - "Verify button text is 'Start Recording' not 'Submit'"

3. **Color/Style Tests (if colors visible in design):**
   - "Verify 'Start Recording' button has primary color (blue/green)"
   - "Verify error messages display in red color"
   - "Verify disabled button appears grayed out"

4. **Layout/Position Tests:**
   - "Verify 'Cancel' button is positioned to the left of 'Start Recording'"
   - "Verify consent checkbox appears below participant selection"
   - "Verify modal is centered on screen"

5. **State Appearance Tests:**
   - "Verify button shows loading spinner when clicked"
   - "Verify input field border turns red on validation error"
   - "Verify success state shows green checkmark icon"

**STEP 3: Use EXACT element names from design:**
- WRONG: "Click submit button"
- RIGHT: "Click 'Start Recording' button"
- WRONG: "Check the box"
- RIGHT: "Check 'I confirm all participants have given consent' checkbox"

**🎯 AT LEAST 30% OF TESTS SHOULD BE VISUAL VALIDATION TESTS when Figma is attached.**
` : '';

    return `You are a SENIOR QA ENGINEER who generates test cases DIRECTLY FROM USER STORIES.

**🚨 CRITICAL RULE: EVERY TEST MUST HAVE A "storyReference" FIELD 🚨**
Each test MUST include a "storyReference" field that quotes or paraphrases the EXACT requirement from the user story that this test validates. If you cannot identify a specific story requirement for a test, DO NOT generate that test.

**YOUR PRIMARY MISSION:**
Generate test cases that validate EVERY SCENARIO mentioned in the user story.
DO NOT generate generic tests. ONLY generate tests that trace back to specific requirements.

**BEFORE GENERATING ANY TEST, ASK YOURSELF:**
1. "Which EXACT sentence/requirement in the user story does this test validate?"
2. "Can I quote the story requirement in the storyReference field?"
3. If the answer to #2 is NO → DO NOT generate this test

**SCENARIO TYPES TO FIND IN THE STORY:**
- "As a... I want... so that..." statements → Main flows to test
- Bullet points or numbered requirements → Individual test cases
- "should/must/will" statements → Acceptance criteria to verify
- Different user types mentioned (internal/external/host/participant) → Test each
- Failure/recovery scenarios mentioned → Error handling tests
- Integration mentions (bot, API, service) → Integration points
${visualAnalysisSection}

**REQUIRED TEST CASE FORMAT (includes storyReference):**
{
  "id": "TC-POS-001",
  "title": "[Action] [specific feature from user story]",
  "category": "Positive",
  "priority": "P0",
  "storyReference": "QUOTE or PARAPHRASE the exact requirement from user story this test validates",
  "description": "Verify that [exact scenario from user story]. The user should be able to [specific action] and the system should [expected behavior].",
  "preconditions": "[Specific setup needed for this scenario]",
  "steps": [
    "Step with EXACT field names/button text from Figma or story",
    "Step referencing SPECIFIC values from user story",
    "Verification step"
  ],
  "expected_result": "[Specific outcome that validates the story requirement]",
  "test_data": "[Realistic data that matches the scenario]"
}

**🚫 REJECTED TEST PATTERNS (DO NOT GENERATE THESE):**
❌ "Verify form validation works" → Too generic, not story-specific
❌ "Test SQL injection in input field" → Security test not in story
❌ "Verify empty field handling" → Generic validation, not in story
❌ "Test with 255 characters" → Arbitrary limit not from story
❌ "Performance under load" → Not mentioned in story
❌ Any test where storyReference would be empty or vague

**✅ CORRECT TEST PATTERNS:**
✅ storyReference: "record meetings initiated without a prior calendar invite"
✅ storyReference: "internal impromptu meetings hosted by internal participant"
✅ storyReference: "bot was kicked-out from the meeting" (recovery scenario)
✅ storyReference: "verbal consent after initial denial"

Generate test cases in this EXACT JSON format:
{
  "testCases": [
    {
      "id": "TC-POS-001",
      "title": "Specific title from story",
      "category": "Positive",
      "priority": "P0|P1|P2",
      "storyReference": "EXACT quote or paraphrase from user story",
      "description": "Detailed description referencing story requirement",
      "preconditions": "Specific setup",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "expected_result": "Outcome from story",
      "test_data": "Scenario-specific data"
    }
  ]
}

Return ONLY valid JSON, no markdown formatting.`;
  }
  
  getUserMessage(ticketData, previousResults, appContext = null) {
    // Use positivePercent from settings, default to 40%
    const percentage = (this.settings?.positivePercent || 40) / 100;
    const testCount = Math.floor((this.settings?.testCount || 30) * percentage);
    const existingTests = previousResults.testCases?.map(tc => `- ${tc.title}`).join('\n') || 'None yet';

    // Format app context if available (prefers intelligent summary over raw JSON)
    const appContextSection = this.formatAppContext(appContext || previousResults.appContext, previousResults);

    // Check for visual context
    const hasVisualContext = this.hasImages?.figma || this.hasImages?.jira;
    const visualContextNote = hasVisualContext
      ? `\n**📷 FIGMA DESIGNS ATTACHED - GENERATE VISUAL TESTS:**
You MUST generate BOTH functional AND visual validation tests:

**FUNCTIONAL TESTS:** Test clicking buttons, entering text, selecting options
**VISUAL VALIDATION TESTS (30% minimum):**
- Element presence: "Verify 'Start Recording' button is visible"
- Text/labels: "Verify modal title shows 'Record a Live Meeting'"
- Colors: "Verify primary button is blue/green color"
- Layout: "Verify Cancel is left of Start Recording"
- States: "Verify disabled state shows grayed button"

Use EXACT text from the Figma design in your test cases.`
      : '';

    // Extract scenarios from user story for emphasis
    const userStoryScenarios = this.extractUserStoryScenarios(ticketData);

    return `**═══════════════════════════════════════════════════════════════**
**📋 USER STORY TO TEST (READ THIS CAREFULLY - THIS IS YOUR PRIMARY INPUT)**
**═══════════════════════════════════════════════════════════════**

**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}

**FULL USER STORY / DESCRIPTION:**
${ticketData.description || 'No description provided'}

**═══════════════════════════════════════════════════════════════**
**🎯 EXTRACTED SCENARIOS TO TEST (You MUST cover these):**
**═══════════════════════════════════════════════════════════════**
${userStoryScenarios}

${visualContextNote}
${appContextSection}

**═══════════════════════════════════════════════════════════════**
**📊 REQUIREMENT ANALYSIS (from previous agent):**
**═══════════════════════════════════════════════════════════════**
${previousResults.analysis || 'No prior analysis available'}

**Already Generated Tests (DO NOT duplicate):**
${existingTests}

**═══════════════════════════════════════════════════════════════**
**🎯 YOUR TASK: Generate ${testCount} STORY-ALIGNED Test Cases**
**═══════════════════════════════════════════════════════════════**

**MANDATORY COVERAGE:**
1. Generate tests for EACH scenario extracted from the user story above
2. Include tests for ALL user types mentioned (internal users, external users, etc.)
3. Include tests for ALL flows mentioned (happy path, recovery, edge cases)
4. If Figma is attached:
   - Include FUNCTIONAL UI tests (click buttons, enter text)
   - Include VISUAL VALIDATION tests (element presence, text labels, colors, layout)
   - At least 30% should be visual validation tests
5. Include tests for integration points mentioned in the story
6. EVERY test must have a "storyReference" field quoting the requirement it validates

**DO NOT GENERATE:**
- Generic form validation (empty fields, special characters)
- SQL injection or security tests (unless mentioned in story)
- Performance tests (unless mentioned in story)
- Tests that don't trace back to a specific requirement in the user story
- Tests without a clear "storyReference"

Return as JSON array.`;
  }

  // Extract key scenarios from user story description
  extractUserStoryScenarios(ticketData) {
    const description = ticketData.description || '';
    const summary = ticketData.summary || '';
    const fullText = `${summary}\n${description}`;

    const scenarios = [];

    // Look for "As a... I want... so that..." patterns
    const asAMatches = fullText.match(/as\s+a[n]?\s+[^,\.]+[,\.]?\s*i\s+want\s+[^,\.]+/gi);
    if (asAMatches) {
      asAMatches.forEach(match => scenarios.push(`• User Story: ${match.trim()}`));
    }

    // Look for bullet points or numbered lists (likely requirements)
    const bulletPoints = fullText.match(/^[\-\•\*]\s+.+$/gm);
    if (bulletPoints) {
      bulletPoints.slice(0, 10).forEach(point => scenarios.push(`• Requirement: ${point.trim()}`));
    }

    // Look for "should" statements (acceptance criteria)
    const shouldStatements = fullText.match(/(?:system|user|bot|feature|it)\s+should\s+[^\.]+/gi);
    if (shouldStatements) {
      shouldStatements.slice(0, 5).forEach(stmt => scenarios.push(`• Acceptance Criteria: ${stmt.trim()}`));
    }

    // Look for flow keywords
    const flowKeywords = ['internal', 'external', 'impromptu', 'scheduled', 'recovery', 'kicked', 'denied', 'failed', 'consent', 'waiting room'];
    flowKeywords.forEach(keyword => {
      if (fullText.toLowerCase().includes(keyword)) {
        const sentences = fullText.split(/[.!?]+/).filter(s => s.toLowerCase().includes(keyword));
        sentences.slice(0, 2).forEach(s => {
          if (s.trim().length > 20) {
            scenarios.push(`• Scenario (${keyword}): ${s.trim()}`);
          }
        });
      }
    });

    // Look for "For X, ..." patterns
    const forPatterns = fullText.match(/for\s+\w+\s+\w+\s+[^,\.]+[,\.]/gi);
    if (forPatterns) {
      forPatterns.slice(0, 5).forEach(pattern => scenarios.push(`• Flow: ${pattern.trim()}`));
    }

    if (scenarios.length === 0) {
      return '⚠️ No explicit scenarios found. Analyze the description to identify implicit requirements.';
    }

    // Deduplicate and return
    return [...new Set(scenarios)].slice(0, 15).join('\n');
  }

  // Batched version - asks for specific number of tests per batch
  getUserMessageBatched(ticketData, previousResults, appContext, batchNum, totalBatches, testsPerBatch) {
    const existingTests = previousResults.testCases?.map(tc => `- ${tc.title}`).join('\n') || 'None yet';
    const appContextSection = this.formatAppContext(appContext || previousResults.appContext, previousResults);

    // Check for visual context
    const hasVisualContext = this.hasImages?.figma || this.hasImages?.jira;
    const visualContextNote = hasVisualContext
      ? '\n**📷 FIGMA DESIGNS ATTACHED:** Generate UI test cases with EXACT element names from the designs.'
      : '';

    // Extract scenarios from user story
    const userStoryScenarios = this.extractUserStoryScenarios(ticketData);

    // Batch-specific focus areas
    const batchFocus = {
      1: 'PRIMARY USER FLOWS - Core happy path scenarios from the user story',
      2: 'ALTERNATIVE FLOWS - Different user types and paths mentioned in the story',
      3: 'RECOVERY SCENARIOS - Error handling, edge cases, and recovery flows from the story',
      4: 'UI/UX VALIDATION - Interface tests based on Figma designs (if available) or story UI mentions'
    };

    return `**═══════════════════════════════════════════════════════════════**
**📋 USER STORY (Batch ${batchNum}/${totalBatches})**
**═══════════════════════════════════════════════════════════════**

**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}

**FULL DESCRIPTION:**
${ticketData.description || 'No description provided'}

**EXTRACTED SCENARIOS:**
${userStoryScenarios}

${visualContextNote}
${appContextSection}

**Already Generated Tests (DO NOT duplicate):**
${existingTests}

**═══════════════════════════════════════════════════════════════**
**🎯 BATCH ${batchNum} FOCUS: ${batchFocus[batchNum] || 'Additional story scenarios'}**
**═══════════════════════════════════════════════════════════════**

Generate ${testsPerBatch} STORY-ALIGNED test cases for this batch.

**REQUIREMENTS:**
- Each test MUST trace to a specific scenario from the user story
- Use EXACT UI element names from Figma (if attached)
- Cover the batch focus area above
- NO generic form validation or security tests

Return as JSON array.`;
  }

  parseResponse(response) {
    try {
      const jsonMatch = response.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');

      const parsed = parseRobustJSON(jsonMatch[0]);
      return parsed.testCases || [];
    } catch (error) {
      console.error('Failed to parse positive test cases:', error);
      console.error('Response preview:', response.substring(0, 500));
      return [];
    }
  }
  
  extractKeywords(ticketData) {
    const text = `${ticketData.summary || ''} ${ticketData.description || ''}`.toLowerCase();
    const domainKeywords = ['api', 'auth', 'login', 'signup', 'payment', 'dashboard', 'admin', 'user', 'oauth', 'database', 'notification', 'email', 'mobile', 'ui', 'ux', 'button', 'form', 'validation', 'search', 'filter', 'upload', 'download', 'export', 'import', 'integration', 'webhook', 'token', 'session', 'permission', 'role'];
    return domainKeywords.filter(kw => text.includes(kw)).slice(0, 5) || ['feature'];
  }
  
  inferPersonas(ticketData) {
    const text = `${ticketData.summary || ''} ${ticketData.description || ''}`.toLowerCase();
    const personas = [];
    if (text.includes('admin') || text.includes('administrator')) personas.push('Admin User');
    if (text.includes('customer') || text.includes('client')) personas.push('Customer');
    if (text.includes('guest') || text.includes('anonymous')) personas.push('Guest User');
    if (personas.length === 0) personas.push('End User');
    return personas;
  }
}

// 3. Negative Test Agent (30% of tests)
class NegativeTestAgent extends BaseAgent {
  constructor() {
    super('NegativeTest', 'Generates story-aligned error handling and failure recovery scenarios', true);
  }

  getSystemMessage(previousResults) {
    // Check if images are available
    const hasVisualContext = this.hasImages?.figma || this.hasImages?.jira;

    const visualSection = hasVisualContext ? `
**🎨 FIGMA/UI CONTEXT (Images Attached):**
Analyze the UI designs to identify:
- Error states and validation messages shown in designs
- Disabled states and their conditions
- Loading/error UI patterns
- Form validation indicators
Use EXACT element names from designs in your test steps.
` : '';

    return `You are a SENIOR QA ENGINEER generating STORY-ALIGNED negative test cases.

**🚨 CRITICAL RULE: EVERY TEST MUST HAVE A "storyReference" FIELD 🚨**
Each test MUST include a "storyReference" field that quotes the EXACT failure/error scenario from the user story. If the failure scenario is NOT mentioned in the story, DO NOT generate the test.

**YOUR PRIMARY MISSION:**
Generate negative tests ONLY for failure scenarios EXPLICITLY MENTIONED in the user story.
DO NOT generate generic security or validation tests.

**BEFORE GENERATING ANY NEGATIVE TEST, ASK:**
1. "Is this failure scenario MENTIONED in the user story?"
2. "Can I quote where the story mentions this error condition?"
3. If NO → DO NOT generate this test

**FAILURE SCENARIOS TO LOOK FOR IN STORY:**
- "fails/failed/failure" mentions → Test that failure case
- "denied/rejected/kicked" mentions → Test denial handling
- "error/issue/problem" mentions → Test error states
- "cannot/unable/not allowed" mentions → Test restriction handling
- "recovery/retry" mentions → Test recovery flows
- "consent" mentions → Test consent failure scenarios
${visualSection}

**🚫 REJECTED TEST PATTERNS (DO NOT GENERATE):**
❌ "SQL injection attempt" → Generic security, not in story
❌ "XSS attack prevention" → Generic security, not in story
❌ "Empty field validation" → Generic validation, not in story
❌ "Invalid email format" → Generic validation, not in story
❌ "Session timeout" → Generic, not in story
❌ Any test without a clear storyReference

**REQUIRED TEST CASE FORMAT:**
{
  "id": "TC-NEG-001",
  "title": "[Failure from story] handling",
  "category": "Negative",
  "priority": "P0|P1|P2",
  "storyReference": "QUOTE the exact failure scenario from story (e.g., 'bot was kicked-out from the meeting')",
  "description": "Verify that when [failure from story] occurs, the system [expected behavior]. This tests the requirement: [quote story].",
  "preconditions": "[Setup for failure]",
  "steps": ["Steps to trigger failure"],
  "expected_result": "[Recovery/error handling from story]",
  "test_data": "[Data for failure scenario]"
}

**✅ EXAMPLES OF VALID storyReference:**
✅ "bot was kicked-out from the meeting"
✅ "bot was not allowed to join from the waiting room"
✅ "technical issue on Call AI or recall's end"
✅ "someone didn't provide consent initially"

Generate test cases in this EXACT JSON format:
{
  "testCases": [...]
}

Return ONLY valid JSON, no markdown formatting.`;
  }

  getUserMessage(ticketData, previousResults, appContext = null) {
    const appContextSection = this.formatAppContext(appContext || previousResults.appContext, previousResults);
    const percentage = (this.settings?.negativePercent || 25) / 100;
    const testCount = Math.floor((this.settings?.testCount || 30) * percentage);
    const existingTests = previousResults.testCases?.map(tc => `- ${tc.title}`).join('\n') || 'None yet';

    // Extract failure scenarios from user story
    const failureScenarios = this.extractFailureScenarios(ticketData);

    // Check for visual context
    const hasVisualContext = this.hasImages?.figma || this.hasImages?.jira;
    const visualNote = hasVisualContext
      ? '\n**📷 FIGMA DESIGNS ATTACHED:** Reference error states and validation UI from the designs.'
      : '';

    return `**═══════════════════════════════════════════════════════════════**
**📋 USER STORY - IDENTIFY FAILURE SCENARIOS**
**═══════════════════════════════════════════════════════════════**

**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}

**FULL DESCRIPTION:**
${ticketData.description || 'No description provided'}

**═══════════════════════════════════════════════════════════════**
**🚨 EXTRACTED FAILURE/ERROR SCENARIOS FROM STORY:**
**═══════════════════════════════════════════════════════════════**
${failureScenarios}

${visualNote}
${appContextSection}

**Requirement Analysis:**
${previousResults.analysis || 'No prior analysis available'}

**Already Generated Tests (DO NOT duplicate):**
${existingTests}

**═══════════════════════════════════════════════════════════════**
**🎯 YOUR TASK: Generate ${testCount} STORY-ALIGNED Negative Tests**
**═══════════════════════════════════════════════════════════════**

**MANDATORY:**
- Each test MUST address a failure scenario from the user story
- Test what happens when specific features FAIL
- Include recovery mechanisms mentioned in the story
- Use EXACT UI elements from Figma (if attached)

**DO NOT GENERATE:**
- Generic SQL injection, XSS, CSRF tests
- Generic empty field validation
- Generic timeout/performance tests
- Any test that doesn't trace to the user story

Return as JSON array.`;
  }

  // Extract failure/error scenarios from user story
  extractFailureScenarios(ticketData) {
    const description = ticketData.description || '';
    const summary = ticketData.summary || '';
    const fullText = `${summary}\n${description}`;

    const scenarios = [];

    // Look for failure keywords
    const failureKeywords = ['fail', 'error', 'denied', 'kicked', 'rejected', 'invalid', 'unable', 'cannot', 'issue', 'problem', 'not allowed', 'waiting room', 'consent', 'recovery', 'technical issue'];

    failureKeywords.forEach(keyword => {
      if (fullText.toLowerCase().includes(keyword)) {
        const sentences = fullText.split(/[.!?]+/).filter(s => s.toLowerCase().includes(keyword));
        sentences.slice(0, 2).forEach(s => {
          if (s.trim().length > 20) {
            scenarios.push(`• Failure (${keyword}): ${s.trim()}`);
          }
        });
      }
    });

    // Look for "should not" or "must not" patterns
    const negativePatterns = fullText.match(/(?:should|must|cannot|can't|won't|will not)\s+not?\s+[^\.]+/gi);
    if (negativePatterns) {
      negativePatterns.slice(0, 3).forEach(p => scenarios.push(`• Constraint: ${p.trim()}`));
    }

    // Look for conditional failures ("if...then error", "when...fails")
    const conditionalFailures = fullText.match(/(?:if|when)\s+[^,]+(?:fail|error|denied|reject|invalid)[^\.]+/gi);
    if (conditionalFailures) {
      conditionalFailures.slice(0, 3).forEach(c => scenarios.push(`• Conditional: ${c.trim()}`));
    }

    if (scenarios.length === 0) {
      return '⚠️ No explicit failure scenarios found. Identify implicit error conditions from the features being built.';
    }

    return [...new Set(scenarios)].slice(0, 10).join('\n');
  }

  parseResponse(response) {
    try {
      const jsonMatch = response.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');

      const parsed = parseRobustJSON(jsonMatch[0]);
      return parsed.testCases || [];
    } catch (error) {
      console.error('Failed to parse negative test cases:', error);
      console.error('Response preview:', response.substring(0, 500));
      return [];
    }
  }
}

// 4. Edge Case Agent (20% of tests)
class EdgeCaseAgent extends BaseAgent {
  constructor() {
    super('EdgeCase', 'Generates story-specific edge cases and boundary scenarios', true);
  }

  getSystemMessage(previousResults) {
    const hasVisualContext = this.hasImages?.figma || this.hasImages?.jira;

    const visualSection = hasVisualContext ? `
**🎨 FIGMA/UI CONTEXT (Images Attached):**
Analyze UI designs for edge cases:
- Maximum content in UI elements (long names, descriptions)
- Empty states shown in designs
- Multiple items/selections
- Responsive breakpoints
` : '';

    return `You are a SENIOR QA ENGINEER generating STORY-ALIGNED edge case tests.

**🚨 CRITICAL RULE: EVERY TEST MUST HAVE A "storyReference" FIELD 🚨**
Each test MUST include a "storyReference" field linking to a SPECIFIC feature/entity from the user story. Edge cases must be for story-specific features, not generic boundaries.

**YOUR PRIMARY MISSION:**
Generate edge cases for SPECIFIC FEATURES and ENTITIES mentioned in the user story.
DO NOT generate generic boundary tests (255 chars, file size limits, etc.).

**BEFORE GENERATING ANY EDGE TEST, ASK:**
1. "What feature/entity from the story does this edge case test?"
2. "Can I reference where the story mentions this feature?"
3. If NO → DO NOT generate this test

**STORY-SPECIFIC EDGE CASES TO FIND:**
- Multiple/many of something mentioned → Test with 0, 1, many
- User types mentioned → Test edge cases for each type
- Actions mentioned → Test simultaneous/rapid actions
- States mentioned → Test unusual state combinations
${visualSection}

**🚫 REJECTED TEST PATTERNS:**
❌ "255 character limit" → Arbitrary, not from story
❌ "10MB file upload" → Generic limit, not from story
❌ "1000 concurrent users" → Generic load, not from story
❌ Any edge case for features NOT in the story

**REQUIRED TEST CASE FORMAT:**
{
  "id": "TC-EDG-001",
  "title": "[Edge condition] for [story feature]",
  "category": "Edge",
  "priority": "P1|P2",
  "storyReference": "QUOTE the feature/entity from story this tests (e.g., 'internal and external impromptu meetings')",
  "description": "Verify that [story feature] handles [edge condition]. This tests the boundary where [situation].",
  "preconditions": "[Setup]",
  "steps": ["Steps"],
  "expected_result": "[Edge behavior]",
  "test_data": "[Edge data]"
}

**✅ EXAMPLES OF VALID EDGE CASES FOR "Impromptu Meeting" STORY:**
✅ storyReference: "internal impromptu meetings" → Edge: Host leaves immediately after starting
✅ storyReference: "external impromptu meetings" → Edge: All external participants, no internal
✅ storyReference: "bot joining meeting" → Edge: Bot joins when meeting is ending
✅ storyReference: "verbal consent" → Edge: Consent given then immediately revoked

Return ONLY valid JSON, no markdown formatting.`;
  }

  getUserMessage(ticketData, previousResults, appContext = null) {
    const appContextSection = this.formatAppContext(appContext || previousResults.appContext, previousResults);
    const percentage = (this.settings?.edgePercent || 10) / 100;
    const testCount = Math.floor((this.settings?.testCount || 30) * percentage);
    const existingTests = previousResults.testCases?.map(tc => `- ${tc.title}`).join('\n') || 'None yet';

    // Extract edge case opportunities from story
    const edgeOpportunities = this.extractEdgeOpportunities(ticketData);

    const hasVisualContext = this.hasImages?.figma || this.hasImages?.jira;
    const visualNote = hasVisualContext
      ? '\n**📷 FIGMA DESIGNS ATTACHED:** Identify edge cases from UI (empty states, max content, etc.).'
      : '';

    return `**═══════════════════════════════════════════════════════════════**
**📋 USER STORY - IDENTIFY EDGE CASE OPPORTUNITIES**
**═══════════════════════════════════════════════════════════════**

**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}

**FULL DESCRIPTION:**
${ticketData.description || 'No description provided'}

**═══════════════════════════════════════════════════════════════**
**🔍 EDGE CASE OPPORTUNITIES FROM STORY:**
**═══════════════════════════════════════════════════════════════**
${edgeOpportunities}

${visualNote}
${appContextSection}

**Requirement Analysis:**
${previousResults.analysis || 'No prior analysis available'}

**Already Generated Tests (DO NOT duplicate):**
${existingTests}

**═══════════════════════════════════════════════════════════════**
**🎯 YOUR TASK: Generate ${testCount} STORY-ALIGNED Edge Cases**
**═══════════════════════════════════════════════════════════════**

**THINK ABOUT:**
- What if there are 100 participants? What if there are 0?
- What if two users do the same action simultaneously?
- What if the user switches between states rapidly?
- What unusual but valid combinations exist for this feature?

**DO NOT GENERATE:**
- Generic character limit tests
- Generic file size tests
- Edge cases not relevant to this specific feature

Return as JSON array.`;
  }

  // Extract edge case opportunities from user story
  extractEdgeOpportunities(ticketData) {
    const description = ticketData.description || '';
    const summary = ticketData.summary || '';
    const fullText = `${summary}\n${description}`;

    const opportunities = [];

    // Look for quantity words that suggest edge cases
    const quantityWords = ['multiple', 'many', 'all', 'any', 'both', 'either', 'each', 'various', 'different'];
    quantityWords.forEach(word => {
      if (fullText.toLowerCase().includes(word)) {
        opportunities.push(`• Quantity edge: What if there are MANY vs ONE vs ZERO?`);
      }
    });

    // Look for user types that might have edge cases
    const userTypes = fullText.match(/(?:internal|external|host|participant|user|admin|guest)\s+\w+/gi);
    if (userTypes) {
      opportunities.push(`• User type edges: ${[...new Set(userTypes)].slice(0, 3).join(', ')}`);
    }

    // Look for state transitions
    const stateWords = ['initiated', 'started', 'stopped', 'joined', 'left', 'kicked', 'denied', 'allowed'];
    stateWords.forEach(word => {
      if (fullText.toLowerCase().includes(word)) {
        opportunities.push(`• State edge (${word}): What if action happens during transition?`);
      }
    });

    // Look for timing-related edge cases
    if (fullText.toLowerCase().includes('impromptu') || fullText.toLowerCase().includes('scheduled')) {
      opportunities.push(`• Timing edge: Impromptu vs scheduled timing differences`);
    }

    // Look for recovery scenarios (these are edge cases)
    if (fullText.toLowerCase().includes('recovery') || fullText.toLowerCase().includes('retry')) {
      opportunities.push(`• Recovery edge: Multiple recovery attempts, rapid retries`);
    }

    if (opportunities.length === 0) {
      return '⚠️ Analyze the features in the story to identify quantity, timing, and state edge cases.';
    }

    return [...new Set(opportunities)].slice(0, 8).join('\n');
  }

  parseResponse(response) {
    try {
      const jsonMatch = response.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');

      const parsed = parseRobustJSON(jsonMatch[0]);
      return parsed.testCases || [];
    } catch (error) {
      console.error('Failed to parse edge case test cases:', error);
      console.error('Response preview:', response.substring(0, 500));
      return [];
    }
  }
}

// 5. Regression Test Agent (5% of tests)
class RegressionTestAgent extends BaseAgent {
  constructor() {
    super('RegressionTest', 'Generates regression tests for existing features impacted by new story', true);
  }

  getSystemMessage(previousResults) {
    return `You are a SENIOR QA ENGINEER generating STORY-AWARE regression tests.

**🚨 CRITICAL RULE: EVERY TEST MUST HAVE A "storyReference" FIELD 🚨**
Each regression test MUST reference the NEW feature from the story AND the EXISTING feature it protects.

**YOUR PRIMARY MISSION:**
Identify EXISTING FEATURES that could be IMPACTED by the new feature in the user story.
Generate regression tests to ensure those existing features still work.

**BEFORE GENERATING ANY REGRESSION TEST, ASK:**
1. "What NEW feature from the story could impact existing functionality?"
2. "What EXISTING feature shares components with this new feature?"
3. If you can't identify both → DO NOT generate this test

**EXAMPLES OF STORY-AWARE REGRESSION:**
- New feature: "Impromptu meeting recording"
  → storyReference: "impromptu meetings" impacts "scheduled meeting recording"
  → storyReference: "impromptu meetings" impacts "recording list/history"

**WHAT TO TEST:**
- Features that SHARE components with the new story feature
- Workflows that the new feature EXTENDS or MODIFIES
- Data/APIs that the new feature TOUCHES

**🚫 REJECTED PATTERNS:**
❌ Generic "login still works" (unless story touches auth)
❌ Regression for unrelated features
❌ Tests without clear story connection

**REQUIRED TEST CASE FORMAT:**
{
  "id": "TC-REG-001",
  "title": "Existing [feature] works after [story feature]",
  "category": "Regression",
  "priority": "P0|P1",
  "storyReference": "New feature '[quote from story]' could impact existing '[related feature]'",
  "description": "Verify that [existing feature] continues to work after [new feature from story]. This protects against regression in [specific area].",
  "preconditions": "[Existing feature setup]",
  "steps": ["Steps for existing workflow"],
  "expected_result": "[Existing behavior preserved]",
  "test_data": "[Data that worked before]"
}

Return ONLY valid JSON, no markdown formatting.`;
  }

  getUserMessage(ticketData, previousResults, appContext = null) {
    const appContextSection = this.formatAppContext(appContext || previousResults.appContext, previousResults);
    const testCount = Math.floor((this.settings?.testCount || 30) * 0.05) || 2;

    // Extract what features might be impacted
    const impactAnalysis = this.analyzeRegressionImpact(ticketData);

    return `**═══════════════════════════════════════════════════════════════**
**📋 NEW FEATURE BEING BUILT (From User Story)**
**═══════════════════════════════════════════════════════════════**

**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}

**FULL DESCRIPTION:**
${ticketData.description || 'No description provided'}

**═══════════════════════════════════════════════════════════════**
**🔄 POTENTIAL REGRESSION IMPACT AREAS:**
**═══════════════════════════════════════════════════════════════**
${impactAnalysis}

${appContextSection}

**Requirement Analysis:**
${previousResults.analysis || 'No prior analysis available'}

**═══════════════════════════════════════════════════════════════**
**🎯 YOUR TASK: Generate ${testCount} REGRESSION Tests**
**═══════════════════════════════════════════════════════════════**

**THINK ABOUT:**
- What EXISTING features could this new feature break?
- What workflows SHARE components with this new feature?
- What data/APIs does this feature TOUCH that existing features use?

Generate regression tests for existing features that could be impacted.

Return as JSON array.`;
  }

  // Analyze what existing features might be impacted
  analyzeRegressionImpact(ticketData) {
    const description = ticketData.description || '';
    const summary = ticketData.summary || '';
    const fullText = `${summary}\n${description}`;

    const impacts = [];

    // Common feature areas and their related existing features
    const featureAreas = {
      'meeting': ['existing meeting list', 'meeting history', 'meeting notifications', 'meeting calendar'],
      'recording': ['existing recordings', 'recording playback', 'recording storage', 'recording list'],
      'user': ['user authentication', 'user profile', 'user permissions', 'user settings'],
      'notification': ['existing notifications', 'email delivery', 'in-app alerts'],
      'consent': ['existing consent flows', 'consent records', 'consent verification'],
      'bot': ['existing bot functionality', 'bot joining flows', 'bot status'],
      'calendar': ['calendar sync', 'scheduled events', 'calendar integration']
    };

    Object.entries(featureAreas).forEach(([area, relatedFeatures]) => {
      if (fullText.toLowerCase().includes(area)) {
        impacts.push(`• ${area.toUpperCase()} area touched - Check: ${relatedFeatures.slice(0, 2).join(', ')}`);
      }
    });

    // Look for integration points
    if (fullText.toLowerCase().includes('api') || fullText.toLowerCase().includes('integration')) {
      impacts.push('• API/Integration changes - Existing API consumers may be affected');
    }

    // Look for UI changes
    if (fullText.toLowerCase().includes('button') || fullText.toLowerCase().includes('modal') || fullText.toLowerCase().includes('ui')) {
      impacts.push('• UI changes - Existing UI elements in same area may be affected');
    }

    if (impacts.length === 0) {
      return '⚠️ Analyze the story to identify which existing features share components with this new feature.';
    }

    return impacts.slice(0, 5).join('\n');
  }

  parseResponse(response) {
    try {
      const jsonMatch = response.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');

      const parsed = parseRobustJSON(jsonMatch[0]);
      return parsed.testCases || [];
    } catch (error) {
      console.error('Failed to parse regression test cases:', error);
      console.error('Response preview:', response.substring(0, 500));
      return [];
    }
  }
}

// 6. Integration Test Agent (5% of tests)
class IntegrationTestAgent extends BaseAgent {
  constructor() {
    super('IntegrationTest', 'Generates story-specific integration tests for mentioned systems', true);
  }

  getSystemMessage(previousResults) {
    return `You are a SENIOR QA ENGINEER generating STORY-ALIGNED integration tests.

**🚨 CRITICAL RULE: EVERY TEST MUST HAVE A "storyReference" FIELD 🚨**
Each test MUST quote the EXACT integration point mentioned in the user story. If the integration is NOT mentioned in the story, DO NOT generate the test.

**YOUR PRIMARY MISSION:**
Generate integration tests ONLY for systems/services EXPLICITLY mentioned in the user story.
DO NOT generate generic API or database tests.

**BEFORE GENERATING ANY INTEGRATION TEST, ASK:**
1. "Where exactly does the story mention this integration?"
2. "Can I quote the story's reference to this system/service?"
3. If NO → DO NOT generate this test

**INTEGRATION KEYWORDS TO FIND IN STORY:**
- Service names: "bot", "recall", "calendar", "notification"
- Integration verbs: "joins", "syncs", "sends", "receives"
- System mentions: "API", "webhook", "service", "platform"

**🚫 REJECTED PATTERNS:**
❌ "Test POST /api/users" → Generic API, not from story
❌ "Database CRUD operations" → Generic, not from story
❌ Any integration not explicitly mentioned in story

**REQUIRED TEST CASE FORMAT:**
{
  "id": "TC-INT-001",
  "title": "[System A] ↔ [System B] for [story feature]",
  "category": "Integration",
  "priority": "P1|P2",
  "storyReference": "QUOTE where story mentions this integration (e.g., 'bot didn't join due to technical issue on recall's end')",
  "description": "Verify that [integration from story] works. When [trigger], the system should [behavior].",
  "preconditions": "[Setup]",
  "steps": ["Integration steps"],
  "expected_result": "[Integration outcome]",
  "test_data": "[Data between systems]"
}

**✅ VALID storyReference EXAMPLES for "Impromptu Meeting" story:**
✅ "bot didn't join...technical issue on Call AI or recall's end"
✅ "bot was kicked-out from the meeting"
✅ "bot was not allowed to join...waiting room"

Return ONLY valid JSON, no markdown formatting.`;
  }

  getUserMessage(ticketData, previousResults, appContext = null) {
    const appContextSection = this.formatAppContext(appContext || previousResults.appContext, previousResults);
    const percentage = (this.settings?.integrationPercent || 5) / 100;
    const testCount = Math.floor((this.settings?.testCount || 30) * percentage) || 2;

    // Extract integration points from story
    const integrationPoints = this.extractIntegrationPoints(ticketData);

    return `**═══════════════════════════════════════════════════════════════**
**📋 USER STORY - IDENTIFY INTEGRATION POINTS**
**═══════════════════════════════════════════════════════════════**

**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}

**FULL DESCRIPTION:**
${ticketData.description || 'No description provided'}

**═══════════════════════════════════════════════════════════════**
**🔗 INTEGRATION POINTS MENTIONED IN STORY:**
**═══════════════════════════════════════════════════════════════**
${integrationPoints}

${appContextSection}

**Requirement Analysis:**
${previousResults.analysis || 'No prior analysis available'}

**═══════════════════════════════════════════════════════════════**
**🎯 YOUR TASK: Generate ${testCount} STORY-ALIGNED Integration Tests**
**═══════════════════════════════════════════════════════════════**

**FOCUS ON:**
- Integration points MENTIONED in the story
- Data flows BETWEEN systems described
- Third-party services REFERENCED

**DO NOT GENERATE:**
- Generic REST API CRUD tests
- Generic database integration tests
- Integrations not mentioned in the story

Return as JSON array.`;
  }

  // Extract integration points from user story
  extractIntegrationPoints(ticketData) {
    const description = ticketData.description || '';
    const summary = ticketData.summary || '';
    const fullText = `${summary}\n${description}`;

    const integrations = [];

    // Common integration keywords and their meanings
    const integrationPatterns = {
      'bot': 'Bot ↔ Meeting platform integration',
      'recall': 'System ↔ Recall API integration',
      'calendar': 'Calendar service integration',
      'consent': 'Consent verification service',
      'notification': 'Notification service integration',
      'email': 'Email service integration',
      'api': 'API endpoint integration',
      'webhook': 'Webhook integration',
      'third-party': 'Third-party service integration',
      'sync': 'Data synchronization',
      'meeting platform': 'Meeting platform (Zoom/Meet/Teams) integration'
    };

    Object.entries(integrationPatterns).forEach(([keyword, integration]) => {
      if (fullText.toLowerCase().includes(keyword)) {
        integrations.push(`• ${integration}`);
      }
    });

    // Look for specific integration mentions
    const integrationMentions = fullText.match(/(?:integrat|connect|sync|communicate|call|send to|receive from)\s+(?:with\s+)?[^\.]+/gi);
    if (integrationMentions) {
      integrationMentions.slice(0, 3).forEach(mention => {
        integrations.push(`• Mentioned: ${mention.trim()}`);
      });
    }

    // Look for service names
    const serviceNames = fullText.match(/(?:call ai|recall|zoom|teams|meet|slack|salesforce|hubspot)\b/gi);
    if (serviceNames) {
      [...new Set(serviceNames)].forEach(service => {
        integrations.push(`• Service: ${service} integration`);
      });
    }

    if (integrations.length === 0) {
      return '⚠️ No explicit integration points found. Check if the story involves any external systems or services.';
    }

    return [...new Set(integrations)].slice(0, 8).join('\n');
  }

  parseResponse(response) {
    try {
      const jsonMatch = response.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');

      const parsed = parseRobustJSON(jsonMatch[0]);
      return parsed.testCases || [];
    } catch (error) {
      console.error('Failed to parse integration test cases:', error);
      console.error('Response preview:', response.substring(0, 500));
      return [];
    }
  }
}

// 7. Review Agent
class ReviewAgent extends BaseAgent {
  constructor() {
    super('Review', 'Reviews generated tests for story alignment and coverage gaps', true);
    // Initialize duplicate detector if available
    this.duplicateDetector = DuplicateDetector ? new DuplicateDetector(0.85) : null;
  }

  getSystemMessage(previousResults) {
    return `You are a principal QA architect performing STORY ALIGNMENT review.

**YOUR PRIMARY MISSION:**
Verify that generated tests actually cover the USER STORY requirements.
Identify tests that are GENERIC and don't trace to the story.

Your review must be THOROUGH and ACTIONABLE, focusing on:

1. **STORY ALIGNMENT CHECK (40% focus):**
   - Does each test trace back to a specific requirement in the user story?
   - Are there scenarios in the story that have NO tests?
   - Identify GENERIC tests that should be removed (SQL injection, generic validation, etc.)
   - Check if Figma UI elements are correctly referenced

2. **Coverage Analysis (30% focus):**
   - Map tests to requirements - what % is covered?
   - Identify untested features or workflows FROM THE STORY
   - Check for missing user types mentioned in story
   - Verify all acceptance criteria have tests

3. **Quality Assessment (30% focus):**
   - Check if descriptions are DETAILED (50+ words minimum)
   - Identify duplicate or near-duplicate tests
   - Validate priority assignments match story criticality
   - Ensure steps reference actual UI elements from Figma/story

**STORY ALIGNMENT ISSUES TO FLAG:**
- "This test doesn't trace to any requirement in the story"
- "Generic security test - story doesn't mention security concerns"
- "Generic form validation - not specific to story features"
- "Missing test for: [specific scenario from story]"

Return your analysis in this EXACT JSON format:
{
  "storyAlignmentScore": 75,
  "storyAlignmentIssues": [
    "TC-XXX-001: Generic SQL injection test - not relevant to meeting recording story",
    "TC-YYY-002: Generic empty field validation - story doesn't specify field validations"
  ],
  "missingStoryScenarios": [
    "No test for: Bot kicked out recovery (mentioned in story)",
    "No test for: External host impromptu meeting (mentioned in story)"
  ],
  "coverageAssessment": "Detailed coverage analysis with specific examples",
  "coverageScore": 85,
  "criticalGaps": [
    "Specific missing test scenario from the story"
  ],
  "qualityIssues": [
    "Specific quality issue found in tests"
  ],
  "duplicateTests": [
    "Test titles that are duplicates or near-duplicates"
  ],
  "suggestedTests": [
    {
      "title": "Test title that maps to story requirement",
      "rationale": "Required by story: [quote from story]",
      "priority": "P0|P1|P2",
      "category": "Positive|Negative|Edge"
    }
  ],
  "testsToRemove": [
    {
      "id": "TC-XXX-001",
      "reason": "Generic test not relevant to this story"
    }
  ]
}

Be specific about story alignment. Flag generic tests that don't belong.
Return ONLY valid JSON.`;
  }
  
  getUserMessage(ticketData, previousResults, appContext = null) {
    // Perform duplicate detection if detector is available
    let duplicateInfo = '';
    let duplicateAnalysis = null;

    if (this.duplicateDetector && previousResults.testCases.length > 0) {
      duplicateAnalysis = this.duplicateDetector.detectDuplicates(previousResults.testCases);

      if (duplicateAnalysis.length > 0) {
        const duplicateDetails = duplicateAnalysis.map(group => {
          const primaryTest = previousResults.testCases[group.primary];
          const duplicateList = group.similarities.map(dup =>
            `  - "${dup.test.title}" (${Math.round(dup.similarity * 100)}% similar)`
          ).join('\n');

          return `- "${primaryTest.title}" has duplicates:\n${duplicateList}`;
        }).join('\n\n');

        duplicateInfo = `\n**Detected Duplicate Tests (${duplicateAnalysis.length} groups):**
${duplicateDetails}\n`;
      }
    }

    const testCasesSummary = previousResults.testCases.map((tc, idx) =>
      `${idx + 1}. [${tc.category}] ${tc.title}`
    ).join('\n');

    return `**═══════════════════════════════════════════════════════════════**
**📋 ORIGINAL USER STORY (Compare tests against this)**
**═══════════════════════════════════════════════════════════════**

**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}

**FULL DESCRIPTION:**
${ticketData.description || 'Not provided'}

**═══════════════════════════════════════════════════════════════**
**📊 GENERATED TEST CASES (${previousResults.testCases.length} total)**
**═══════════════════════════════════════════════════════════════**

${testCasesSummary}

**Categories:**
- Positive: ${previousResults.testCases.filter(tc => tc.category === 'Positive').length}
- Negative: ${previousResults.testCases.filter(tc => tc.category === 'Negative').length}
- Edge: ${previousResults.testCases.filter(tc => tc.category === 'Edge').length}
- Regression: ${previousResults.testCases.filter(tc => tc.category === 'Regression').length}
- Integration: ${previousResults.testCases.filter(tc => tc.category === 'Integration').length}

**Security Tests:** ${previousResults.testCases.filter(tc => tc.security_risk).length}
**Performance Tests:** ${previousResults.testCases.filter(tc => tc.performance_impact === 'yes').length}
${duplicateInfo}

**Requirement Analysis:**
${previousResults.analysis || 'Not available'}

**═══════════════════════════════════════════════════════════════**
**🎯 YOUR REVIEW TASK:**
**═══════════════════════════════════════════════════════════════**

1. **CHECK STORY ALIGNMENT:**
   - Compare each test against the user story
   - Flag tests that are GENERIC (don't trace to story)
   - Identify story scenarios with NO tests

2. **IDENTIFY GAPS:**
   - What story requirements have no tests?
   - What user types/flows are missing?

3. **SUGGEST IMPROVEMENTS:**
   - Suggest tests for missing story scenarios
   - Recommend removing generic tests

Return your analysis as specified JSON format.`;
  }

  // Override parseResponse to handle JSON parsing
  parseResponse(response) {
    if (typeof response === 'string') {
      try {
        // Remove any markdown code blocks if present
        const cleanedJson = response.replace(/```json\s*|\s*```/gi, '').trim();
        return JSON.parse(cleanedJson);
      } catch (error) {
        console.error('Failed to parse ReviewAgent response as JSON:', error);
        console.error('Raw response:', response);
        // Return a default review structure if parsing fails
        return {
          coverageAssessment: "Unable to parse review response",
          coverageScore: 0,
          criticalGaps: [],
          qualityIssues: [],
          descriptionQualityIssues: [],
          duplicateTests: [],
          suggestedTests: [],
          securityConcerns: [],
          performanceConcerns: [],
          riskAreas: []
        };
      }
    }
    return response;
  }

  // Override execute to include duplicate removal
  async execute(ticketData, previousResults, settings, appContext = null) {
    // If duplicate detector is available, clean the tests first
    if (this.duplicateDetector && previousResults.testCases.length > 0) {
      const duplicateAnalysis = this.duplicateDetector.removeDuplicates(previousResults.testCases);

      // Store the duplicate analysis for reference
      this.lastDuplicateAnalysis = duplicateAnalysis;

      // Log duplicate removal
      if (duplicateAnalysis.removed.length > 0) {
        console.log(`ReviewAgent: Removed ${duplicateAnalysis.removed.length} duplicate tests`);
        console.log('Duplicate groups:', duplicateAnalysis.duplicateGroups);
      }

      // Update previousResults with cleaned tests
      previousResults = {
        ...previousResults,
        testCases: duplicateAnalysis.cleaned,
        duplicatesRemoved: duplicateAnalysis.removed,
        duplicateGroups: duplicateAnalysis.duplicateGroups
      };
    }

    // Call parent execute with cleaned tests - parseResponse will handle JSON parsing
    const result = await super.execute(ticketData, previousResults, settings, appContext);

    // Add duplicate information to the result object (result is already parsed by parseResponse)
    if (this.lastDuplicateAnalysis && typeof result === 'object' && result !== null) {
      result.duplicateAnalysis = this.lastDuplicateAnalysis.summary;
      result.duplicatesRemoved = this.lastDuplicateAnalysis.removed.map(t => t.title);
    }

    return result;
  }
}

// 8. AI Feature Test Agent (15% of tests, only for AI/LLM features)
class AIFeatureTestAgent extends BaseAgent {
  constructor() {
    super('AIFeature', 'Generates AI/LLM/ML-specific test scenarios', true);
  }

  /**
   * Detect if ticket involves AI/LLM/ML features using semantic analysis
   * Goes beyond simple keyword matching to understand context and reduce false positives
   */
  static detectAIFeatures(ticketData) {
    const allText = [
      ticketData.summary || '',
      ticketData.description || '',
      ticketData.acceptance_criteria || '',
      ...(ticketData.feature_list || [])
    ].join(' ').toLowerCase();

    // ========== SEMANTIC DETECTION SYSTEM ==========

    // HIGH CONFIDENCE patterns - these strongly indicate AI features
    const highConfidencePatterns = [
      // Explicit AI/LLM references
      /\b(llm|large language model)\b/i,
      /\b(gpt-?[34]|gpt-?4o|claude|gemini|bard|palm|openai|anthropic|chatgpt)\b/i,
      /\b(machine learning|deep learning|neural network)\b/i,
      /\bartificial intelligence\b/i,

      // AI-specific operations
      /\b(prompt|prompting)\s+(engineering|injection|template|design)\b/i,
      /\b(text|content|response)\s+generation\b/i,
      /\bgenerat(e|ing|ion)\s+(text|response|content|summary|insight)\b/i,
      /\b(embeddings?|vector)\s+(search|store|database|index)\b/i,
      /\b(rag|retrieval.augmented)\b/i,
      /\bfine.?tun(e|ing)\b/i,
      /\bmodel\s+(training|inference|serving|deployment)\b/i,

      // AI concerns
      /\bhallucination\b/i,
      /\b(token|context)\s+(limit|window|count)\b/i,
      /\b(temperature|top.?p|top.?k)\s*(=|:|\s+\d)/i,
      /\bai\s+(bias|safety|ethics|moderation)\b/i,

      // AI-specific features
      /\bsemantic\s+(search|similarity|understanding)\b/i,
      /\bnatural\s+language\s+(processing|understanding|generation)\b/i,
      /\b(chatbot|conversational\s+ai|ai\s+assistant)\b/i,
      /\bsentiment\s+(analysis|detection)\b/i,
      /\b(summariz|translat)(e|ing|ion)\s+(using|with|via)\s+(ai|llm|model)\b/i
    ];

    // MEDIUM CONFIDENCE patterns - may indicate AI but need context
    const mediumConfidencePatterns = [
      /\bai\s+(feature|functionality|capability|integration)\b/i,
      /\b(intelligent|smart)\s+(search|recommendation|suggestion)\b/i,
      /\bmodel\s+(response|output|prediction)\b/i,
      /\b(nlp|ml)\b/i,
      /\bprediction\s+(model|engine|service)\b/i,
      /\bclassification\s+(model|algorithm)\b/i,
      /\b(auto|ai).?(generat|complet|suggest)\b/i,
      /\bcontent\s+moderation\b/i,
      /\b(chat|conversation)\s+(context|history|memory)\b/i
    ];

    // LOW CONFIDENCE patterns - common words that MIGHT indicate AI in context
    const lowConfidencePatterns = [
      /\bgeneration\b/i,  // Could be "lead generation", "report generation"
      /\bmodel\b/i,       // Could be "data model", "business model"
      /\btraining\b/i,    // Could be "user training", "employee training"
      /\bprompt\b/i,      // Could be "prompt user to...", UI prompt
      /\bagent\b/i,       // Could be "support agent", "agent application"
      /\bassistant\b/i,   // Could be "assistant role", "office assistant"
      /\bintelligent\b/i  // Could be "intelligent design", generic use
    ];

    // FALSE POSITIVE exclusion patterns - when these are present, lower confidence
    const falsePositivePatterns = [
      /\b(support|customer\s+service)\s+agent\b/i,  // Human agent
      /\b(office|personal|admin)\s+assistant\b/i,    // Human assistant
      /\b(data|database|business|domain)\s+model\b/i, // Non-AI model
      /\b(user|employee|staff)\s+training\b/i,        // Human training
      /\b(lead|report|invoice|pdf)\s+generation\b/i,  // Document generation
      /\bprompt\s+(user|dialog|message|alert)\b/i,    // UI prompts
      /\b(test|dev|staging)\s+model\b/i               // Non-AI context
    ];

    // Calculate semantic score
    let score = 0;
    let matchedPatterns = [];
    let matchedKeywords = [];

    // Check high confidence patterns (+30 points each)
    highConfidencePatterns.forEach(pattern => {
      const match = allText.match(pattern);
      if (match) {
        score += 30;
        matchedPatterns.push({ pattern: pattern.source, match: match[0], confidence: 'HIGH' });
        matchedKeywords.push(match[0]);
      }
    });

    // Check medium confidence patterns (+15 points each)
    mediumConfidencePatterns.forEach(pattern => {
      const match = allText.match(pattern);
      if (match) {
        score += 15;
        matchedPatterns.push({ pattern: pattern.source, match: match[0], confidence: 'MEDIUM' });
        matchedKeywords.push(match[0]);
      }
    });

    // Check low confidence patterns (+5 points each, only if no false positive)
    lowConfidencePatterns.forEach(pattern => {
      const match = allText.match(pattern);
      if (match) {
        // Check for false positives
        const isFalsePositive = falsePositivePatterns.some(fp => fp.test(allText));
        if (!isFalsePositive) {
          score += 5;
          matchedPatterns.push({ pattern: pattern.source, match: match[0], confidence: 'LOW' });
          matchedKeywords.push(match[0]);
        }
      }
    });

    // Apply false positive penalty (-20 points for each)
    falsePositivePatterns.forEach(pattern => {
      if (pattern.test(allText)) {
        score -= 20;
        matchedPatterns.push({ pattern: pattern.source, confidence: 'FALSE_POSITIVE' });
      }
    });

    // Ensure score doesn't go negative
    score = Math.max(0, score);

    // Determine confidence level based on semantic score
    let confidence;
    let isAIFeature;

    if (score >= 50) {
      confidence = 'HIGH';
      isAIFeature = true;
    } else if (score >= 25) {
      confidence = 'MEDIUM';
      isAIFeature = true;
    } else if (score >= 10) {
      confidence = 'LOW';
      isAIFeature = true;  // Still enable but with warning
    } else {
      confidence = 'NONE';
      isAIFeature = false;
    }

    // Deduplicate keywords
    const uniqueKeywords = [...new Set(matchedKeywords)];

    console.log(`🤖 [AI Detection] Semantic analysis complete:`, {
      score,
      confidence,
      isAIFeature,
      patterns: matchedPatterns.length,
      keywords: uniqueKeywords
    });

    return {
      isAIFeature,
      keywords: uniqueKeywords,
      confidence,
      score,
      patterns: matchedPatterns,
      analysis: {
        highConfidenceMatches: matchedPatterns.filter(p => p.confidence === 'HIGH').length,
        mediumConfidenceMatches: matchedPatterns.filter(p => p.confidence === 'MEDIUM').length,
        lowConfidenceMatches: matchedPatterns.filter(p => p.confidence === 'LOW').length,
        falsePositiveMatches: matchedPatterns.filter(p => p.confidence === 'FALSE_POSITIVE').length
      }
    };
  }

  /**
   * Only enable this agent if AI features are detected
   */
  isEnabled(settings) {
    // Agent can be disabled in settings
    if (settings.disableAIFeatureAgent === true) {
      return false;
    }

    // Check if ticket has AI features (this will be set by orchestrator)
    return this.hasAIFeatures === true;
  }

  getSystemMessage(previousResults) {
    return `You are a QA engineer specializing in AI/LLM/ML feature testing.
Create comprehensive test scenarios specifically for AI-powered features, covering reliability, safety, and quality aspects.

EXAMPLE HIGH-QUALITY AI TEST CASE:
{
  "id": "TC-AI-001",
  "title": "LLM generates consistent responses for identical prompts",
  "category": "AIFeature",
  "priority": "P1",
  "description": "Verify that the AI model produces consistent and deterministic responses when given the same prompt multiple times with temperature=0. Ensure that the system maintains response consistency across multiple invocations, and the output format, structure, and key content remain stable. This validates the reliability and predictability of the AI feature for production use cases where consistency is critical.",
  "preconditions": "AI model configured with temperature=0, API endpoint accessible",
  "steps": [
    "Send identical prompt 'Summarize the key benefits of cloud computing' to AI endpoint",
    "Record the response",
    "Wait 5 seconds",
    "Send the same prompt again",
    "Record the second response",
    "Repeat 3 more times (total 5 requests)",
    "Compare all 5 responses for consistency"
  ],
  "expected_result": "All 5 responses should be identical or near-identical (95%+ similarity), maintaining same structure and key points",
  "test_data": "Prompt: 'Summarize the key benefits of cloud computing', Temperature: 0, Model: gpt-4",
  "ai_test_type": "Consistency"
}

**AI Test Categories:**

1. **Prompt Testing** (20%)
   - Prompt injection attacks (jailbreaking, system prompt leakage)
   - Prompt manipulation and adversarial inputs
   - Multi-turn conversation context maintenance
   - Prompt format variations (JSON, XML, plain text)
   - Edge case prompts (very long, very short, special characters)

2. **Hallucination Detection** (25%)
   - Factual accuracy validation (verifiable claims)
   - Citation and source verification
   - Detection of fabricated data/references
   - Grounding to provided context only
   - Confidence scoring and uncertainty handling

3. **Consistency & Reliability** (20%)
   - Response consistency for identical prompts
   - Deterministic behavior with temperature=0
   - Output format stability (JSON schema adherence)
   - API reliability under load
   - Timeout and retry handling

4. **Bias & Safety** (15%)
   - Bias detection (gender, racial, cultural)
   - Toxicity and harmful content filtering
   - PII (Personal Identifiable Information) leakage prevention
   - Content moderation and guardrails
   - Ethical AI behavior

5. **Token & Context Limits** (10%)
   - Context window boundary testing
   - Token limit handling (input and output)
   - Truncation behavior
   - Streaming response handling
   - Cost optimization (token usage)

6. **Model Parameter Validation** (10%)
   - Temperature, top-p, top-k parameter effects
   - Max tokens configuration
   - Stop sequences and delimiters
   - System prompt effectiveness
   - Model version consistency

**CRITICAL REQUIREMENTS:**

1. **Detailed Descriptions (minimum 60 words):**
   - Start with "Verify that the AI/LLM/model..."
   - Explain WHAT is being tested and WHY it matters for AI
   - Mention specific AI concerns (hallucination, bias, consistency, etc.)
   - Include expected AI behavior and failure modes
   - Pattern: "Verify that the AI [feature] correctly [behavior] when [context]. Ensure that [AI-specific validations] including [checks for hallucination/bias/consistency]. The model should [expected AI behavior] and prevent [AI failure mode]. This validates [AI quality aspect]."

2. **AI-Specific Test Data:**
   - Include actual prompts/inputs to test
   - Specify model parameters (temperature, max_tokens, etc.)
   - Define expected output formats
   - Include adversarial/edge case examples

3. **Measurable Success Criteria:**
   - Quantify consistency (e.g., "95%+ similarity")
   - Define acceptable hallucination rates (e.g., "0 fabricated citations")
   - Specify performance thresholds (e.g., "response within 5 seconds")
   - Measure bias metrics where applicable

Generate test cases in this EXACT JSON format:
{
  "testCases": [
    {
      "id": "TC-AI-001",
      "title": "Clear AI test case title",
      "category": "AIFeature",
      "priority": "P0|P1|P2|P3",
      "description": "Detailed 60+ word description starting with 'Verify that the AI/LLM/model...'",
      "preconditions": "AI model setup, API access, test environment",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "expected_result": "Expected AI behavior with measurable criteria",
      "test_data": "Prompts, parameters, model configuration",
      "ai_test_type": "PromptTesting|Hallucination|Consistency|Bias|TokenLimits|Parameters"
    }
  ]
}

**IMPORTANT:** Only generate tests relevant to the ACTUAL AI features mentioned in the ticket. Do not create generic tests.

Return ONLY valid JSON, no markdown formatting.`;
  }

  getUserMessage(ticketData, previousResults, appContext = null) {
    const testCount = Math.floor((this.settings?.testCount || 30) * 0.15); // 15% of total tests
    const existingTests = previousResults.testCases?.map(tc => `- ${tc.title}`).join('\n') || 'None yet';

    // Extract AI-specific context
    const aiDetection = AIFeatureTestAgent.detectAIFeatures(ticketData);
    const aiKeywords = aiDetection.keywords.join(', ');

    // Format app context if available
    const appContextSection = this.formatAppContext(appContext || previousResults.appContext, previousResults);

    // Extract specific AI feature mentions from story
    const aiFeatures = this.extractAIFeatures(ticketData);

    return `**═══════════════════════════════════════════════════════════════**
**📋 AI/LLM FEATURE FROM USER STORY**
**═══════════════════════════════════════════════════════════════**

**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}

**FULL DESCRIPTION:**
${ticketData.description || 'Not provided'}

**═══════════════════════════════════════════════════════════════**
**🤖 AI FEATURES DETECTED IN STORY:**
**═══════════════════════════════════════════════════════════════**
${aiFeatures}

**AI Keywords:** ${aiKeywords}
**Detection Confidence:** ${aiDetection.confidence}

${appContextSection}

**Existing Test Cases:**
${existingTests}

**═══════════════════════════════════════════════════════════════**
**🎯 YOUR TASK: Generate ${testCount} STORY-ALIGNED AI Tests**
**═══════════════════════════════════════════════════════════════**

**TEST THE AI FEATURES MENTIONED IN THE STORY:**
- Prompt handling for the SPECIFIC use case in the story
- Hallucination risks for THIS feature's outputs
- Consistency requirements for THIS AI feature
- Safety concerns relevant to THIS feature

**DO NOT GENERATE:**
- Generic AI tests not related to the story
- Tests for AI capabilities not mentioned
- Generic prompt injection tests (unless security is mentioned)

Return as JSON array with "testCases" key.`;
  }

  // Extract specific AI features from the story
  extractAIFeatures(ticketData) {
    const description = ticketData.description || '';
    const summary = ticketData.summary || '';
    const fullText = `${summary}\n${description}`;

    const features = [];

    // Look for specific AI feature mentions
    const aiPatterns = [
      { pattern: /generat\w*\s+(?:text|content|response|summary)/gi, feature: 'Text/Content Generation' },
      { pattern: /llm|language model/gi, feature: 'LLM Integration' },
      { pattern: /prompt/gi, feature: 'Prompt Handling' },
      { pattern: /ai\s+(?:feature|assistant|agent)/gi, feature: 'AI Assistant/Agent' },
      { pattern: /summar\w+/gi, feature: 'Summarization' },
      { pattern: /recommend\w*/gi, feature: 'AI Recommendations' },
      { pattern: /classif\w*/gi, feature: 'Classification' },
      { pattern: /predict\w*/gi, feature: 'Prediction' }
    ];

    aiPatterns.forEach(({ pattern, feature }) => {
      if (pattern.test(fullText)) {
        features.push(`• ${feature}`);
      }
    });

    // Extract sentences mentioning AI
    const aiSentences = fullText.split(/[.!?]+/).filter(s =>
      /\b(ai|llm|model|generat|prompt)\b/i.test(s)
    );
    aiSentences.slice(0, 3).forEach(s => {
      if (s.trim().length > 20) {
        features.push(`• Mentioned: ${s.trim().substring(0, 100)}...`);
      }
    });

    if (features.length === 0) {
      return '⚠️ AI features detected by keywords but no specific mentions found in description.';
    }

    return [...new Set(features)].slice(0, 6).join('\n');
  }

  parseResponse(response) {
    try {
      const jsonMatch = response.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');

      const parsed = parseRobustJSON(jsonMatch[0]);
      return parsed.testCases || [];
    } catch (error) {
      console.error('Failed to parse AI feature test cases:', error);
      console.error('Response preview:', response.substring(0, 500));
      return [];
    }
  }
}
