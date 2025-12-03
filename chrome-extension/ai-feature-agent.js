/**
 * AI Feature Test Agent - Specialized agent for AI/LLM/ML feature testing
 * Only activates when AI-related features are detected in Jira tickets
 *
 * Version: 1.0.0
 * Purpose: Generate AI-specific test cases (prompt testing, hallucination, consistency, bias, etc.)
 */

class AIFeatureTestAgent extends BaseAgent {
  constructor() {
    super('AIFeature', 'Generates AI/LLM/ML-specific test scenarios', true);
  }

  /**
   * Detect if ticket involves AI/LLM/ML features
   */
  static detectAIFeatures(ticketData) {
    const aiKeywords = [
      // Core AI/ML terms
      'ai', 'artificial intelligence', 'machine learning', 'ml', 'deep learning',
      'llm', 'large language model', 'language model', 'gpt', 'claude', 'gemini',
      'openai', 'anthropic', 'chatgpt', 'bard', 'palm',

      // AI features
      'prompt', 'completion', 'generation', 'inference', 'prediction',
      'embeddings', 'vector', 'semantic search', 'rag', 'retrieval augmented',
      'fine-tuning', 'training', 'model',

      // AI-specific functionality
      'natural language', 'nlp', 'text generation', 'content generation',
      'sentiment analysis', 'classification', 'summarization', 'translation',
      'conversation', 'chatbot', 'assistant', 'agent',

      // AI concerns
      'hallucination', 'bias', 'toxicity', 'moderation', 'safety',
      'grounding', 'factual', 'accuracy', 'consistency', 'reliability',
      'token', 'context window', 'temperature', 'top-p', 'parameters'
    ];

    const allText = [
      ticketData.summary || '',
      ticketData.description || '',
      ticketData.acceptance_criteria || '',
      ...(ticketData.feature_list || [])
    ].join(' ').toLowerCase();

    // Check if any AI keywords are present
    const foundKeywords = aiKeywords.filter(keyword =>
      allText.includes(keyword)
    );

    return {
      isAIFeature: foundKeywords.length > 0,
      keywords: foundKeywords,
      confidence: foundKeywords.length >= 2 ? 'HIGH' : foundKeywords.length === 1 ? 'MEDIUM' : 'NONE'
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

    return `Based on this AI feature requirement:

**Ticket Summary:** ${ticketData.summary}

**Description:** ${ticketData.description || 'Not provided'}

**AI Keywords Detected:** ${aiKeywords}

**Acceptance Criteria:**
${ticketData.acceptance_criteria || 'Not provided'}

**Feature List:**
${ticketData.feature_list?.join('\n') || 'Not provided'}

${appContextSection}

**Existing Test Cases:**
${existingTests}

**YOUR TASK:**
Generate ${testCount} AI-specific test cases that cover:
1. **Prompt Testing** - Injection, manipulation, context handling
2. **Hallucination Detection** - Factual accuracy, grounding, citations
3. **Consistency** - Response stability, deterministic behavior
4. **Bias & Safety** - Fairness, toxicity, PII protection
5. **Token Limits** - Context windows, truncation
6. **Parameters** - Temperature, top-p, model configuration

**CRITICAL:**
- Focus ONLY on AI/LLM aspects of the feature
- Use ACTUAL AI keywords from the ticket: ${aiKeywords}
- Every test must have 60+ word description
- Include specific prompts, model parameters, and measurable success criteria
- DO NOT generate generic tests - only AI-specific scenarios
${appContextSection ? '\n**Use ACTUAL field names, API endpoints, and model configurations from the Application Context above.**' : ''}

Return as JSON array with "testCases" key.`;
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

// Export for use in agents.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AIFeatureTestAgent;
}

// Make available globally
if (typeof window !== 'undefined') {
  window.AIFeatureTestAgent = AIFeatureTestAgent;
} else if (typeof self !== 'undefined') {
  self.AIFeatureTestAgent = AIFeatureTestAgent;
}
