// Enhanced Features System for QAtalyst
// Gap Analysis, Smart Complexity Scaling, Context-Aware Generation

class EnhancementEngine {
  constructor(settings, callAIFunc) {
    this.settings = settings;
    this.callAI = callAIFunc;
    this.gapAnalyzer = new GapAnalyzer(callAIFunc);
    this.complexityScaler = new ComplexityScaler();
    this.contextAnalyzer = new ContextAnalyzer(callAIFunc);
  }
  
  async enhance(testCases, ticketData, analysis) {
    const enhancements = {
      gaps: [],
      additionalTests: [],
      scalingApplied: false,
      contextEnhanced: false
    };
    
    // 1. Gap Analysis - Identify missing coverage
    if (this.settings.enableEnhanced !== false) {
      const gaps = await this.gapAnalyzer.analyzeGaps(testCases, ticketData, analysis, this.settings);
      enhancements.gaps = gaps.gaps;
      enhancements.additionalTests = gaps.additionalTests;
    }
    
    // 2. Smart Complexity Scaling - Adjust test count based on complexity
    if (this.settings.enableEnhanced !== false) {
      const scaledCount = this.complexityScaler.calculateOptimalTestCount(
        ticketData,
        analysis,
        this.settings.testCount || 30
      );
      
      enhancements.scalingApplied = true;
      enhancements.originalCount = this.settings.testCount || 30;
      enhancements.scaledCount = scaledCount;
      enhancements.complexityScore = this.complexityScaler.lastComplexityScore;
    }
    
    // 3. Context-Aware Generation - Use project context
    if (this.settings.enableEnhanced !== false) {
      const contextEnhancements = await this.contextAnalyzer.analyzeContext(
        ticketData,
        testCases,
        this.settings
      );
      
      enhancements.contextEnhanced = true;
      enhancements.contextInsights = contextEnhancements;
    }
    
    return enhancements;
  }
}

// Gap Analysis - Identifies missing test coverage
class GapAnalyzer {
  constructor(callAIFunc) {
    this.callAI = callAIFunc;
  }
  
  async analyzeGaps(testCases, ticketData, analysis, settings) {
    const systemMessage = `You are a QA coverage analyst. Identify gaps in test coverage.

Analyze the existing test cases and identify:
1. Missing test scenarios
2. Uncovered requirements
3. Missing edge cases
4. Insufficient negative tests
5. Integration gaps
6. Performance/security concerns not tested

Return JSON with:
{
  "gaps": [
    {
      "category": "Functional|Integration|Edge|Performance|Security",
      "description": "What's missing",
      "severity": "Critical|High|Medium|Low",
      "recommendation": "What test to add"
    }
  ],
  "coverageScore": 0-100
}`;

    const userMessage = `Analyze coverage gaps for:

**Ticket:** ${ticketData.key} - ${ticketData.summary}
**Requirements:** ${analysis?.substring(0, 500) || 'Not available'}

**Existing Tests (${testCases.length}):**
${testCases.slice(0, 10).map((tc, idx) => `${idx + 1}. [${tc.category}|${tc.priority}] ${tc.title}`).join('\n')}
${testCases.length > 10 ? `... and ${testCases.length - 10} more tests` : ''}

**Test Distribution:**
- Positive: ${testCases.filter(tc => tc.category === 'Positive').length}
- Negative: ${testCases.filter(tc => tc.category === 'Negative').length}
- Edge: ${testCases.filter(tc => tc.category === 'Edge').length}
- Integration: ${testCases.filter(tc => tc.category === 'Integration').length}
- Regression: ${testCases.filter(tc => tc.category === 'Regression').length}

Identify coverage gaps and return as JSON.`;

    try {
      const response = await this.callAI(systemMessage, userMessage, settings);
      
      const jsonMatch = response.match(/\{[\s\S]*"gaps"[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in gap analysis');
      }
      
      const gapAnalysis = JSON.parse(jsonMatch[0]);
      
      // Generate additional tests for critical/high gaps
      const additionalTests = await this.generateGapFillerTests(
        gapAnalysis.gaps.filter(g => g.severity === 'Critical' || g.severity === 'High'),
        ticketData,
        settings
      );
      
      return {
        gaps: gapAnalysis.gaps,
        coverageScore: gapAnalysis.coverageScore,
        additionalTests: additionalTests
      };
    } catch (error) {
      console.error('Gap analysis failed:', error);
      return {
        gaps: [],
        coverageScore: 75, // Default reasonable score
        additionalTests: []
      };
    }
  }
  
  async generateGapFillerTests(criticalGaps, ticketData, settings) {
    if (criticalGaps.length === 0) {
      return [];
    }
    
    const systemMessage = `You are a QA engineer filling coverage gaps.
Generate targeted test cases to address the identified gaps.

Return test cases in JSON format:
{
  "testCases": [
    {
      "id": "TC-GAP-001",
      "title": "Test title",
      "category": "Category",
      "priority": "P0|P1|P2",
      "description": "What gap this fills",
      "preconditions": "Setup",
      "steps": ["Step 1", "Step 2"],
      "expected_result": "Expected outcome",
      "test_data": "Test data",
      "fillsGap": "Gap description"
    }
  ]
}`;

    const userMessage = `Generate tests to fill these coverage gaps:

${criticalGaps.map((gap, idx) => `
${idx + 1}. **${gap.category}** (${gap.severity})
   ${gap.description}
   Recommendation: ${gap.recommendation}
`).join('\n')}

**Ticket:** ${ticketData.key} - ${ticketData.summary}

Generate ${Math.min(criticalGaps.length * 2, 10)} test cases.`;

    try {
      const response = await this.callAI(systemMessage, userMessage, settings);
      
      const jsonMatch = response.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
      if (!jsonMatch) {
        return [];
      }
      
      const parsed = JSON.parse(jsonMatch[0]);
      return parsed.testCases || [];
    } catch (error) {
      console.error('Gap filler test generation failed:', error);
      return [];
    }
  }
}

// Smart Complexity Scaling - Adjusts test count based on ticket complexity
class ComplexityScaler {
  constructor() {
    this.lastComplexityScore = 0;
  }
  
  calculateOptimalTestCount(ticketData, analysis, baseCount) {
    // Calculate complexity score (0-100)
    let complexityScore = 0;
    
    // 1. Description length factor (0-20 points)
    const descLength = (ticketData.description || '').length;
    complexityScore += Math.min(20, descLength / 100);
    
    // 2. Number of requirements (0-20 points)
    const requirementCount = this.countRequirements(analysis);
    complexityScore += Math.min(20, requirementCount * 2);
    
    // 3. Integration complexity (0-20 points)
    const integrationScore = this.assessIntegrationComplexity(ticketData, analysis);
    complexityScore += integrationScore;
    
    // 4. Technical complexity keywords (0-20 points)
    const technicalScore = this.assessTechnicalComplexity(ticketData, analysis);
    complexityScore += technicalScore;
    
    // 5. User story complexity (0-20 points)
    const storyComplexity = this.assessStoryComplexity(ticketData);
    complexityScore += storyComplexity;
    
    this.lastComplexityScore = Math.round(complexityScore);
    
    // Scale test count based on complexity
    // Low (0-30): 0.7x
    // Medium (31-60): 1.0x
    // High (61-80): 1.3x
    // Very High (81-100): 1.5x
    
    let multiplier = 1.0;
    if (complexityScore <= 30) {
      multiplier = 0.7;
    } else if (complexityScore <= 60) {
      multiplier = 1.0;
    } else if (complexityScore <= 80) {
      multiplier = 1.3;
    } else {
      multiplier = 1.5;
    }
    
    return Math.round(baseCount * multiplier);
  }
  
  countRequirements(analysis) {
    if (!analysis) return 5; // Default
    
    // Count bullet points, numbered lists, and "must/should" statements
    const bullets = (analysis.match(/^[-*•]\s/gm) || []).length;
    const numbered = (analysis.match(/^\d+\.\s/gm) || []).length;
    const musts = (analysis.match(/\b(must|should|shall|will)\b/gi) || []).length;
    
    return bullets + numbered + Math.floor(musts / 2);
  }
  
  assessIntegrationComplexity(ticketData, analysis) {
    const text = `${ticketData.description || ''} ${analysis || ''}`.toLowerCase();
    
    const integrationKeywords = [
      'api', 'integration', 'microservice', 'service', 'endpoint',
      'database', 'cache', 'queue', 'webhook', 'third-party',
      'external', 'rest', 'graphql', 'grpc', 'soap'
    ];
    
    let score = 0;
    integrationKeywords.forEach(keyword => {
      if (text.includes(keyword)) {
        score += 2;
      }
    });
    
    return Math.min(20, score);
  }
  
  assessTechnicalComplexity(ticketData, analysis) {
    const text = `${ticketData.description || ''} ${analysis || ''}`.toLowerCase();
    
    const complexityKeywords = [
      'algorithm', 'optimization', 'performance', 'security',
      'authentication', 'authorization', 'encryption', 'validation',
      'transaction', 'concurrency', 'async', 'real-time',
      'migration', 'refactor', 'architecture'
    ];
    
    let score = 0;
    complexityKeywords.forEach(keyword => {
      if (text.includes(keyword)) {
        score += 2;
      }
    });
    
    return Math.min(20, score);
  }
  
  assessStoryComplexity(ticketData) {
    const summary = (ticketData.summary || '').toLowerCase();
    const description = (ticketData.description || '').toLowerCase();
    
    let score = 10; // Base score
    
    // Epic/large feature indicators
    if (summary.includes('epic') || summary.includes('feature')) {
      score += 5;
    }
    
    // Multiple components
    if (description.includes('and') || description.includes('also')) {
      score += 3;
    }
    
    // Complex operations
    const complexWords = ['complex', 'advanced', 'sophisticated', 'comprehensive'];
    complexWords.forEach(word => {
      if (summary.includes(word) || description.includes(word)) {
        score += 2;
      }
    });
    
    return Math.min(20, score);
  }
}

// Context-Aware Generation - Uses project/domain context
class ContextAnalyzer {
  constructor(callAIFunc) {
    this.callAI = callAIFunc;
  }
  
  async analyzeContext(ticketData, testCases, settings) {
    // Extract project context from ticket data
    const projectContext = this.extractProjectContext(ticketData);
    
    // Analyze if tests are context-appropriate
    const systemMessage = `You are a QA context analyst. Evaluate if test cases are appropriate for the project context.

Analyze:
1. Are tests using correct terminology?
2. Are tests considering the right user personas?
3. Are tests aligned with the domain?
4. Are there domain-specific edge cases missing?

Return JSON:
{
  "contextScore": 0-100,
  "insights": [
    {
      "type": "Terminology|Personas|Domain|EdgeCases",
      "observation": "What was noticed",
      "recommendation": "How to improve"
    }
  ]
}`;

    const userMessage = `Analyze context-awareness of tests:

**Project:** ${ticketData.key}
**Type:** ${ticketData.type || 'Unknown'}
**Project Context:**
${projectContext}

**Sample Tests:**
${testCases.slice(0, 5).map(tc => `- ${tc.title}`).join('\n')}

Evaluate context-awareness and return JSON.`;

    try {
      const response = await this.callAI(systemMessage, userMessage, settings);
      
      const jsonMatch = response.match(/\{[\s\S]*"contextScore"[\s\S]*\}/);
      if (!jsonMatch) {
        return { contextScore: 75, insights: [] };
      }
      
      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      console.error('Context analysis failed:', error);
      return {
        contextScore: 75,
        insights: []
      };
    }
  }
  
  extractProjectContext(ticketData) {
    // Extract key information about the project
    const context = [];
    
    // Project key often indicates domain
    const projectKey = ticketData.key?.split('-')[0];
    if (projectKey) {
      context.push(`Project: ${projectKey}`);
    }
    
    // Ticket type
    if (ticketData.type) {
      context.push(`Type: ${ticketData.type}`);
    }
    
    // Labels provide context
    if (ticketData.labels && ticketData.labels.length > 0) {
      context.push(`Labels: ${ticketData.labels.join(', ')}`);
    }
    
    // Components
    if (ticketData.components && ticketData.components.length > 0) {
      context.push(`Components: ${ticketData.components.join(', ')}`);
    }
    
    return context.join('\n') || 'No specific context available';
  }
}

// Export for use in background.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { EnhancementEngine, GapAnalyzer, ComplexityScaler, ContextAnalyzer };
}
