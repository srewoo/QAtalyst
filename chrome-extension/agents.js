// Multi-Agent Test Generation System
// Client-side agent orchestration for QAtalyst

class AgentOrchestrator {
  constructor(settings, onProgress) {
    this.settings = settings;
    this.onProgress = onProgress;
    this.agents = this.initializeAgents();
  }
  
  initializeAgents() {
    return [
      // NOTE: ContextAnalysisAgent runs in BACKGROUND script (not here!)
      // It creates the summary before data reaches content script
      new RequirementAnalysisAgent(),
      new PositiveTestAgent(),
      new NegativeTestAgent(),
      new EdgeCaseAgent(),
      new RegressionTestAgent(),
      new IntegrationTestAgent(),
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

    // NEW v11.2.0: If appContext has contextSummary (from background), store it
    if (appContext && appContext.contextSummary) {
      results.contextSummary = appContext.contextSummary;
      console.log(`[ORCHESTRATOR] 📝 Context summary available: ${appContext.contextSummary.length} chars`);
    } else {
      console.log(`[ORCHESTRATOR] ℹ️ No context summary available (running without crawled data)`);
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
        const agentResult = await agent.execute(ticketData, results, this.settings, appContext);

        // Store agent results
        results.agentResults[agent.name] = agentResult;

        // Requirement Analysis stores analysis
        if (agent instanceof RequirementAnalysisAgent) {
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

**Your summary MUST include these 3 key sections:**

1. **MAIN PURPOSE** 🎯
   - What is the primary purpose of this feature?
   - What problem does it solve for users?
   - What is the business value?

2. **HOW IT WORKS** ⚙️
   - What is the user workflow/journey?
   - What forms/fields does the user interact with?
   - What API endpoints are called and in what sequence?
   - How do different components connect together?

3. **UI COMPONENTS** 🎨
   - What forms are present and what fields do they contain?
   - What buttons/actions are available?
   - What pages/screens are involved?
   - How does the user navigate through the feature?

**CRITICAL**:
- Keep it concise (200-500 words) but informative
- Reference ACTUAL form fields, button names, and API endpoints from the data
- Be specific and technical - use real field names and endpoints
- Write in clear, structured format with the 3 sections above

**Output Format**: Plain text summary with clear sections, NOT test cases.`;
  }

  getUserMessage(ticketData, previousResults, appContext) {
    if (!appContext || !appContext.pages) {
      return 'No application context available. Skip this analysis.';
    }

    const pageCount = Object.keys(appContext.pages).length;
    const formCount = appContext.forms?.length || 0;
    const apiCount = appContext.apis?.length || 0;

    // Build concise context representation
    let contextStr = `**JIRA TICKET TO ANALYZE**\n`;
    contextStr += `Key: ${ticketData.key}\n`;
    contextStr += `Summary: ${ticketData.summary}\n`;
    contextStr += `Description: ${ticketData.description || 'N/A'}\n\n`;

    contextStr += `**CRAWLED APPLICATION DATA** (${pageCount} pages analyzed):\n\n`;

    // Forms with detailed field information
    if (formCount > 0) {
      contextStr += `📝 **FORMS DETECTED** (${formCount} forms):\n`;
      appContext.forms.slice(0, 10).forEach((form, i) => {
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
      appContext.apis.slice(0, 15).forEach((api, i) => {
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
    return `You are a senior business analyst specializing in requirement analysis.
Analyze Jira tickets and extract structured requirements for test case generation.

Focus on:
1. Feature overview and objectives
2. Functional requirements (what the system should do)
3. UI/UX specifications
4. Integration points and dependencies
5. Acceptance criteria
6. Edge cases and constraints
7. Business rules and validations

Provide a well-structured analysis in markdown format with clear sections.`;
  }
  
  getUserMessage(ticketData, previousResults, appContext = null) {
    return `Analyze this Jira ticket comprehensively:

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
    super('PositiveTest', 'Generates happy path and valid input test scenarios', true);
  }
  
  getSystemMessage(previousResults) {
    return `You are a QA engineer specializing in positive test case generation.
Create comprehensive happy path test scenarios that validate normal, expected behavior.

EXAMPLE HIGH-QUALITY TEST CASE:
{
  "id": "TC-POS-001",
  "title": "User successfully logs in with valid credentials",
  "category": "Positive",
  "priority": "P0",
  "description": "Verify that the user can successfully authenticate with correct email and password. Ensure the login process works correctly, user is able to enter credentials, and the system validates and grants access. Confirm that session is created and user is redirected to the appropriate landing page.",
  "preconditions": "User account exists with email: test@example.com and password set",
  "steps": [
    "Navigate to login page",
    "Enter email: test@example.com",
    "Enter password: ValidPass123!",
    "Click 'Login' button"
  ],
  "expected_result": "User redirected to dashboard, welcome message displayed with user name, session token generated",
  "test_data": "Email: test@example.com, Password: ValidPass123!"
}

Focus on:
- Clear, actionable steps with specific values
- Detailed expected results
- Realistic test data
- Complete preconditions
- Normal user workflows and common use cases
- Valid input combinations
- Successful operations

**IMPORTANT: Write DETAILED descriptions (2-3 sentences) that:**
- Start with "Verify that..."
- Explain what functionality is being tested
- Mention what the user is able to do
- Include the expected behavior or outcome
- Use phrases like: "works correctly", "user is able to", "ensure that", "confirm that"

Example: "Verify that the feature flag works correctly and user is able to toggle LLM functionality on/off at the site level. Ensure the toggle persists across sessions and affects all users in the site."

Generate test cases in this EXACT JSON format:
{
  "testCases": [
    {
      "id": "TC-POS-001",
      "title": "Clear test case title",
      "category": "Positive",
      "priority": "P0|P1|P2|P3",
      "description": "Detailed 2-3 sentence description starting with 'Verify that...'",
      "preconditions": "Setup required",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "expected_result": "Expected outcome",
      "test_data": "Required test data"
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
    const keywords = this.extractKeywords(ticketData);
    const personas = this.inferPersonas(ticketData);

    // Format app context if available (prefers intelligent summary over raw JSON)
    const appContextSection = this.formatAppContext(appContext || previousResults.appContext, previousResults);

    return `Based on this requirement analysis:

${previousResults.analysis || 'No prior analysis available'}
${appContextSection}
**Domain Context:**
- Keywords: ${keywords.join(', ')}
- User Personas: ${personas.join(', ')}

**Already Generated Tests:**
${existingTests}

**Important:** Do NOT duplicate existing tests. Generate NEW, complementary scenarios.

**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}

Generate ${testCount} UNIQUE positive test cases covering:
- All happy path scenarios
- Valid input combinations
- Expected user workflows for ${personas.join(' and ')}
- Standard feature usage
- Use domain-specific terminology: ${keywords.join(', ')}
${appContextSection ? '\n**CRITICAL:** Use the ACTUAL field names, button labels, and API endpoints from the Application Context above. Do not make up field names or endpoints.' : ''}

Return as JSON array.`;
  }

  parseResponse(response) {
    try {
      const jsonMatch = response.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.testCases || [];
    } catch (error) {
      console.error('Failed to parse positive test cases:', error);
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
    super('NegativeTest', 'Generates error handling and validation test scenarios', true);
  }
  
  getSystemMessage(previousResults) {
    return `You are a QA engineer specializing in negative test case generation.
Create comprehensive negative test scenarios that validate error handling and system robustness.

EXAMPLE HIGH-QUALITY NEGATIVE TEST:
{
  "id": "TC-NEG-001",
  "title": "Login fails with invalid password and shows appropriate error",
  "category": "Negative",
  "priority": "P0",
  "description": "Verify that the system correctly rejects login attempts with incorrect password and user is unable to gain unauthorized access. Ensure that appropriate error message is displayed and the system maintains security by not revealing whether the email exists. Confirm that no session is created and user remains on the login page.",
  "preconditions": "User account exists with email: test@example.com",
  "steps": [
    "Navigate to login page",
    "Enter valid email: test@example.com",
    "Enter incorrect password: WrongPassword123",
    "Click 'Login' button"
  ],
  "expected_result": "Login rejected, error message 'Invalid email or password' displayed, user remains on login page, no session created",
  "test_data": "Email: test@example.com, Password: WrongPassword123",
  "security_risk": "Medium"
}

Focus on:
- Invalid input combinations
- Boundary violations
- Missing required data
- Unauthorized access attempts
- **Security vulnerabilities (SQL injection, XSS, CSRF)**
- **Performance issues (timeout, large payloads)**
- Error messages and handling
- System resilience

**IMPORTANT: Write DETAILED descriptions (2-3 sentences) that:**
- Start with "Verify that..."
- Explain what error condition is being tested
- Mention what the user is unable to do (security/validation)
- Include the expected error handling behavior
- Use phrases like: "correctly rejects", "user is unable to", "prevents", "validates", "handles error"

Example: "Verify that the system correctly validates file upload size and user is unable to upload files exceeding the 10MB limit. Ensure that appropriate error message is displayed and the system prevents the upload. Confirm that no partial files are stored."

Generate test cases in this EXACT JSON format:
{
  "testCases": [
    {
      "id": "TC-NEG-001",
      "title": "Clear test case title",
      "category": "Negative",
      "priority": "P0|P1|P2|P3",
      "description": "Detailed 2-3 sentence description starting with 'Verify that...'",
      "preconditions": "Setup required",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "expected_result": "Expected error or rejection",
      "test_data": "Invalid test data",
      "security_risk": "High|Medium|Low (if applicable)"
    }
  ]
}

Return ONLY valid JSON, no markdown formatting.`;
  }
  
  getUserMessage(ticketData, previousResults, appContext = null) {
    // Format app context if available (prefers intelligent summary over raw JSON)
    const appContextSection = this.formatAppContext(appContext || previousResults.appContext, previousResults);
    // Use negativePercent from settings, default to 25%
    const percentage = (this.settings?.negativePercent || 25) / 100;
    const testCount = Math.floor((this.settings?.testCount || 30) * percentage);
    const existingTests = previousResults.testCases?.map(tc => `- ${tc.title}`).join('\n') || 'None yet';
    const keywords = this.extractKeywords(ticketData);

    return `Based on this requirement analysis:

${previousResults.analysis || 'No prior analysis available'}
${appContextSection}
**Domain Context:**
- Keywords: ${keywords.join(', ')}

**Already Generated Tests:**
${existingTests}

**Important:** Do NOT duplicate existing tests. Generate NEW error scenarios.

**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}

Generate ${testCount} UNIQUE negative test cases covering:
- Invalid inputs and data
- Missing required fields
- Boundary violations
- Error handling scenarios
- Authorization failures
- **Security tests: SQL injection, XSS, CSRF attempts**
- **Performance issues: Large payloads, timeouts**
${appContextSection ? '\n**CRITICAL:** Use the ACTUAL field names, button labels, and API endpoints from the Application Context above. Do not make up field names or endpoints.' : ''}

Return as JSON array.`;
  }
  
  parseResponse(response) {
    try {
      const jsonMatch = response.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.testCases || [];
    } catch (error) {
      console.error('Failed to parse negative test cases:', error);
      return [];
    }
  }
  
  extractKeywords(ticketData) {
    const text = `${ticketData.summary || ''} ${ticketData.description || ''}`.toLowerCase();
    const domainKeywords = ['api', 'auth', 'login', 'signup', 'payment', 'dashboard', 'admin', 'user', 'oauth', 'database', 'notification', 'email', 'mobile', 'ui', 'ux', 'button', 'form', 'validation', 'search', 'filter', 'upload', 'download', 'export', 'import', 'integration', 'webhook', 'token', 'session', 'permission', 'role'];
    return domainKeywords.filter(kw => text.includes(kw)).slice(0, 5) || ['feature'];
  }
}

// 4. Edge Case Agent (20% of tests)
class EdgeCaseAgent extends BaseAgent {
  constructor() {
    super('EdgeCase', 'Generates boundary and corner case test scenarios', true);
  }
  
  getSystemMessage(previousResults) {
    return `You are a QA engineer specializing in edge case and boundary condition testing.
Create test scenarios that explore system limits and unusual situations.

EXAMPLE HIGH-QUALITY EDGE CASE TEST:
{
  "id": "TC-EDG-001",
  "title": "Form submission with maximum allowed character count (255 chars)",
  "category": "Edge",
  "priority": "P1",
  "description": "Verify that the system correctly handles input at the exact maximum boundary of 255 characters and user is able to save the form without errors. Ensure that all characters are preserved without truncation and the system displays the complete text. Confirm that no performance degradation occurs at this boundary value.",
  "preconditions": "User logged in, form field has 255 character limit",
  "steps": [
    "Navigate to profile edit page",
    "Enter exactly 255 characters in bio field",
    "Click 'Save' button"
  ],
  "expected_result": "Form saves successfully, bio displays all 255 characters, no truncation or error",
  "test_data": "Bio: [255-character string]",
  "performance_impact": "no"
}

Focus on:
- Boundary values (min, max, zero, null)
- Empty states and missing data
- Large data volumes
- Concurrent operations
- Unusual but valid scenarios
- System limits
- **Performance boundaries (max file size, timeout limits)**

**IMPORTANT: Write DETAILED descriptions (2-3 sentences) that:**
- Start with "Verify that..."
- Explain what boundary/edge condition is being tested
- Mention what the user is able to do at this edge case
- Include the expected system behavior
- Use phrases like: "correctly handles", "at the boundary", "edge condition", "system maintains", "without degradation"

Example: "Verify that the system correctly handles concurrent user sessions and user is able to perform actions simultaneously from multiple devices. Ensure that data consistency is maintained and no conflicts occur. Confirm that session management works correctly across all active sessions."

Generate test cases in this EXACT JSON format:
{
  "testCases": [
    {
      "id": "TC-EDG-001",
      "title": "Clear test case title",
      "category": "Edge",
      "priority": "P1|P2|P3",
      "description": "Detailed 2-3 sentence description starting with 'Verify that...'",
      "preconditions": "Setup required",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "expected_result": "Expected behavior at boundary",
      "test_data": "Boundary test data",
      "performance_impact": "yes|no"
    }
  ]
}

Return ONLY valid JSON, no markdown formatting.`;
  }
  
  getUserMessage(ticketData, previousResults, appContext = null) {
    // Format app context if available (prefers intelligent summary over raw JSON)
    const appContextSection = this.formatAppContext(appContext || previousResults.appContext, previousResults);
    // Use edgePercent from settings, default to 10%
    const percentage = (this.settings?.edgePercent || 10) / 100;
    const testCount = Math.floor((this.settings?.testCount || 30) * percentage);
    const existingTests = previousResults.testCases?.map(tc => `- ${tc.title}`).join('\n') || 'None yet';

    return `Based on this requirement analysis:

${previousResults.analysis || 'No prior analysis available'}
${appContextSection}
**Already Generated Tests:**
${existingTests}

**Important:** Do NOT duplicate existing tests. Find NEW boundaries to test.

**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}

Generate ${testCount} edge case test cases covering:
- Boundary values and limits
- Empty/null states
- Maximum/minimum conditions
- Concurrent operations
- Unusual but valid scenarios
${appContextSection ? '\n**CRITICAL:** Use the ACTUAL field names, button labels, and API endpoints from the Application Context above. Do not make up field names or endpoints.' : ''}

Return as JSON array.`;
  }
  
  parseResponse(response) {
    try {
      const jsonMatch = response.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.testCases || [];
    } catch (error) {
      console.error('Failed to parse edge case test cases:', error);
      return [];
    }
  }
}

// 5. Regression Test Agent (5% of tests)
class RegressionTestAgent extends BaseAgent {
  constructor() {
    super('RegressionTest', 'Generates tests to ensure existing functionality remains intact', true);
  }
  
  getSystemMessage(previousResults) {
    return `You are a QA engineer specializing in regression testing.
Create test scenarios that validate existing functionality is not broken by new changes.

Focus on:
- Core existing features
- Previously working workflows
- Backward compatibility
- Integration points
- Critical user paths

Generate test cases in this EXACT JSON format:
{
  "testCases": [
    {
      "id": "TC-REG-001",
      "title": "Clear test case title",
      "category": "Regression",
      "priority": "P0|P1|P2",
      "description": "What existing functionality this validates",
      "preconditions": "Setup required",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "expected_result": "Existing functionality works as before",
      "test_data": "Test data"
    }
  ]
}

Return ONLY valid JSON, no markdown formatting.`;
  }
  
  getUserMessage(ticketData, previousResults, appContext = null) {
    // Format app context if available (prefers intelligent summary over raw JSON)
    const appContextSection = this.formatAppContext(appContext || previousResults.appContext, previousResults);
    const testCount = Math.floor((this.settings?.testCount || 30) * 0.05) || 2;

    return `Based on this requirement analysis:

${previousResults.analysis || 'No prior analysis available'}
${appContextSection}
**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}

Generate ${testCount} regression test cases to ensure:
- Existing features still work
- No breaking changes introduced
- Backward compatibility maintained
- Critical paths remain functional
${appContextSection ? '\n**CRITICAL:** Use the ACTUAL field names, button labels, and API endpoints from the Application Context above. Do not make up field names or endpoints.' : ''}

Return as JSON array.`;
  }
  
  parseResponse(response) {
    try {
      const jsonMatch = response.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.testCases || [];
    } catch (error) {
      console.error('Failed to parse regression test cases:', error);
      return [];
    }
  }
}

// 6. Integration Test Agent (5% of tests)
class IntegrationTestAgent extends BaseAgent {
  constructor() {
    super('IntegrationTest', 'Generates tests for API and system integration points', true);
  }
  
  getSystemMessage(previousResults) {
    return `You are a QA engineer specializing in integration testing.
Create test scenarios that validate system integrations and API interactions.

Focus on:
- API endpoint testing
- Third-party integrations
- Database interactions
- Service-to-service communication
- Data flow between components

Generate test cases in this EXACT JSON format:
{
  "testCases": [
    {
      "id": "TC-INT-001",
      "title": "Clear test case title",
      "category": "Integration",
      "priority": "P1|P2|P3",
      "description": "What integration this validates",
      "preconditions": "Setup required",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "expected_result": "Integration works correctly",
      "test_data": "Test data"
    }
  ]
}

Return ONLY valid JSON, no markdown formatting.`;
  }

  getUserMessage(ticketData, previousResults, appContext = null) {
    // Format app context if available (prefers intelligent summary over raw JSON)
    const appContextSection = this.formatAppContext(appContext || previousResults.appContext, previousResults);
    // Use integrationPercent from settings, default to 5%
    const percentage = (this.settings?.integrationPercent || 5) / 100;
    const testCount = Math.floor((this.settings?.testCount || 30) * percentage) || 2;

    return `Based on this requirement analysis:

${previousResults.analysis || 'No prior analysis available'}
${appContextSection}
**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}

Generate ${testCount} integration test cases covering:
- API endpoints and responses
- Third-party service integration
- Data synchronization
- Service communication
- Database operations
${appContextSection ? '\n**CRITICAL:** Use the ACTUAL field names, button labels, and API endpoints from the Application Context above. Do not make up field names or endpoints.' : ''}

Return as JSON array.`;
  }
  
  parseResponse(response) {
    try {
      const jsonMatch = response.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.testCases || [];
    } catch (error) {
      console.error('Failed to parse integration test cases:', error);
      return [];
    }
  }
}

// 7. Review Agent
class ReviewAgent extends BaseAgent {
  constructor() {
    super('Review', 'Reviews generated tests for quality and coverage gaps', true);
  }
  
  getSystemMessage(previousResults) {
    return `You are a senior QA lead reviewing test cases for quality and completeness.

Analyze the generated test cases and provide a comprehensive review.

Return your analysis in this EXACT JSON format:
{
  "coverageAssessment": "Summary of what areas are well covered",
  "coverageScore": 85,
  "criticalGaps": [
    "Specific missing test scenario 1",
    "Specific missing test scenario 2"
  ],
  "qualityIssues": [
    "Duplicate or unclear test issue"
  ],
  "suggestedTests": [
    {
      "title": "Specific test case title",
      "rationale": "Why this test is needed",
      "priority": "P0|P1|P2",
      "category": "Positive|Negative|Edge|Security|Performance"
    }
  ],
  "securityConcerns": [
    "Security test gap or concern"
  ],
  "performanceConcerns": [
    "Performance test gap or concern"
  ],
  "riskAreas": [
    "High-risk area not adequately covered"
  ]
}

Provide actionable, specific feedback. Suggest 3-5 concrete new test cases to fill gaps.
Return ONLY valid JSON.`;
  }
  
  getUserMessage(ticketData, previousResults, appContext = null) {
    const testCasesSummary = previousResults.testCases.map((tc, idx) =>
      `${idx + 1}. [${tc.category}] ${tc.title}`
    ).join('\n');

    return `Review these generated test cases for completeness:

**Requirement Analysis:**
${previousResults.analysis || 'Not available'}

**Generated Test Cases (${previousResults.testCases.length} total):**
${testCasesSummary}

**Categories:**
- Positive: ${previousResults.testCases.filter(tc => tc.category === 'Positive').length}
- Negative: ${previousResults.testCases.filter(tc => tc.category === 'Negative').length}
- Edge: ${previousResults.testCases.filter(tc => tc.category === 'Edge').length}
- Regression: ${previousResults.testCases.filter(tc => tc.category === 'Regression').length}
- Integration: ${previousResults.testCases.filter(tc => tc.category === 'Integration').length}

**Security Tests:** ${previousResults.testCases.filter(tc => tc.security_risk).length}
**Performance Tests:** ${previousResults.testCases.filter(tc => tc.performance_impact === 'yes').length}

Provide a comprehensive quality review with specific gap-filling test suggestions.`;
  }
}
