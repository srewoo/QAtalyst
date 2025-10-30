// Historical Test Case Mining System
// Intelligently searches Jira for similar past bugs to enhance test generation

class HistoricalMiningEngine {
  constructor(settings, callAI, baseUrl) {
    this.settings = settings;
    this.callAI = callAI;
    this.baseUrl = baseUrl;
    this.cache = new Map();
  }

  /**
   * Main entry point - mines historical data and enhances test cases
   */
  async mineAndEnhance(ticketData, baseTestCases) {
    console.log('Starting historical mining for:', ticketData.key);

    try {
      // Step 1: Extract features from current ticket
      const features = await this.extractFeatures(ticketData);
      console.log('Extracted features:', features);

      // Step 2: Search Jira for similar bugs
      const historicalBugs = await this.searchHistoricalBugs(features);
      console.log('Found historical bugs:', historicalBugs.length);

      if (historicalBugs.length === 0) {
        console.log('No historical bugs found, skipping enhancement');
        return {
          enhancedTests: baseTestCases,
          insights: null,
          historicalBugs: []
        };
      }

      // Step 3: Analyze historical bugs for patterns
      const insights = await this.analyzeHistoricalData(features, historicalBugs, ticketData);
      console.log('Generated insights:', insights);

      // Step 4: Enhance test cases with historical insights
      const enhancedTests = await this.enhanceTestCases(baseTestCases, insights, ticketData);
      console.log('Enhanced test cases:', enhancedTests.length);

      return {
        enhancedTests,
        insights,
        historicalBugs
      };
    } catch (error) {
      console.error('Historical mining failed:', error);
      // Return base tests if mining fails
      return {
        enhancedTests: baseTestCases,
        insights: null,
        historicalBugs: [],
        error: error.message
      };
    }
  }

  /**
   * Step 1: Extract searchable features from ticket using AI
   */
  async extractFeatures(ticketData) {
    const systemMessage = `You are a feature extraction specialist for test case mining.
Extract key features, functionality, and technical components from this Jira ticket
that can be used to search for similar bugs in Jira history.

Focus on:
- Main feature/functionality being developed
- Key technical terms and components
- User actions and workflows
- Data entities being manipulated
- Integration points

Return a JSON object with searchable keywords prioritized by relevance.`;

    const userMessage = `Extract searchable features from this ticket:

Ticket: ${ticketData.key}
Summary: ${ticketData.summary || 'N/A'}
Description: ${ticketData.description || 'N/A'}

Return JSON in this format:
{
  "mainFeature": "Primary feature name",
  "keywords": ["keyword1", "keyword2", "keyword3"],
  "technicalComponents": ["component1", "component2"],
  "userActions": ["action1", "action2"],
  "searchTerms": ["high priority terms for Jira search"]
}`;

    try {
      const response = await this.callAI(systemMessage, userMessage, this.settings);

      // Extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const features = JSON.parse(jsonMatch[0]);
        return features;
      }

      // Fallback: extract from summary and description
      return this.extractFeaturesBasic(ticketData);
    } catch (error) {
      console.error('Feature extraction failed:', error);
      return this.extractFeaturesBasic(ticketData);
    }
  }

  /**
   * Fallback feature extraction using basic text analysis
   */
  extractFeaturesBasic(ticketData) {
    const text = `${ticketData.summary} ${ticketData.description}`.toLowerCase();

    // Extract common technical terms
    const commonTerms = ['login', 'authentication', 'api', 'database', 'user',
                         'payment', 'search', 'upload', 'download', 'integration',
                         'email', 'notification', 'session', 'token', 'validation'];

    const foundTerms = commonTerms.filter(term => text.includes(term));

    // Extract words from summary (simple approach)
    const summaryWords = (ticketData.summary || '')
      .split(/\s+/)
      .filter(word => word.length > 3)
      .slice(0, 5);

    return {
      mainFeature: ticketData.summary || 'Unknown',
      keywords: foundTerms.length > 0 ? foundTerms : summaryWords,
      technicalComponents: [],
      userActions: [],
      searchTerms: foundTerms.slice(0, 5)
    };
  }

  /**
   * Step 2: Search Jira for historical bugs (MODIFIED per user request)
   * Search across ALL projects for bugs in last 365 days
   */
  async searchHistoricalBugs(features) {
    const { searchTerms, keywords, mainFeature } = features;

    // Build search terms
    const allSearchTerms = [...new Set([
      ...searchTerms,
      ...keywords.slice(0, 3)
    ])].slice(0, 5); // Limit to top 5 terms

    if (allSearchTerms.length === 0) {
      console.log('No search terms available');
      return [];
    }

    // Build JQL query - NO PROJECT FILTER, search all projects
    // Filter: type = Bug AND created in last 365 days
    const jql = this.buildBugSearchJQL(allSearchTerms);
    console.log('Executing JQL:', jql);

    try {
      const bugs = await this.searchJiraIssues(jql, 3); // Try v3 first
      console.log(`Found ${bugs.length} historical bugs`);
      return bugs;
    } catch (error) {
      // If v3 fails with 410, try v2 automatically
      if (error.message.includes('410')) {
        console.warn('⚠️ API v3 failed with 410, trying v2 fallback...');
        try {
          const bugs = await this.searchJiraIssues(jql, 2); // Fallback to v2
          console.log(`✅ Found ${bugs.length} historical bugs using API v2`);
          return bugs;
        } catch (v2Error) {
          console.error('Jira search failed (both v3 and v2):', v2Error);
          return [];
        }
      }

      console.error('Jira search failed:', error);
      return [];
    }
  }

  /**
   * Build JQL query for bug search with custom filters
   */
  buildBugSearchJQL(searchTerms) {
    // Create text search conditions for each term
    const textConditions = searchTerms.map(term => `text ~ "${term}"`).join(' OR ');

    // Get custom JQL filters from settings, or use defaults
    const customFilters = this.settings.historicalJqlFilters?.trim();
    const defaultFilters = 'issuetype = Bug AND created >= -365d AND status in (Done, Resolved, Closed)';

    const filters = customFilters || defaultFilters;

    // Build final JQL: keyword search AND custom filters
    const jql = `(${textConditions}) AND ${filters} ORDER BY created DESC`;

    console.log('📝 Built JQL query with custom filters:', jql);

    return jql;
  }

  /**
   * Execute Jira search using REST API v3 (Jira Cloud) or v2 (Jira Server) fallback
   * Supports both cookie-based and API token authentication
   * @param {string} jql - The JQL query to execute
   * @param {number} apiVersion - API version to use (2 or 3), defaults to 3
   */
  async searchJiraIssues(jql, apiVersion = 3) {
    const baseUrl = this.baseUrl;
    const maxResults = this.settings.historicalMaxResults || 20;

    // Use provided version or setting override
    const version = this.settings.jiraApiVersion || apiVersion;

    // Jira Cloud has migrated to /search/jql endpoint (CHANGE-2046)
    // Old: /rest/api/3/search
    // New: /rest/api/3/search/jql
    const searchEndpoint = version === '3' || version === 3 ? 'search/jql' : 'search';
    const url = `${baseUrl}/rest/api/${version}/${searchEndpoint}?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=key,summary,description,status,resolution,created,priority,issuetype,project`;

    // Build headers based on authentication method
    const headers = {
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    };

    // If API token is provided, use Basic Auth instead of cookies
    if (this.settings.jiraEmail && this.settings.jiraApiToken) {
      const credentials = btoa(`${this.settings.jiraEmail}:${this.settings.jiraApiToken}`);
      headers['Authorization'] = `Basic ${credentials}`;
      console.log('📡 Using API token authentication for:', this.settings.jiraEmail);
    } else {
      console.log('📡 Using cookie-based authentication (browser session)');
      console.warn('⚠️ WARNING: Cookie-based authentication from background script may not work!');
      console.warn('⚠️ SOLUTION: Please provide Jira Email and API Token in Historical Mining settings');
      console.warn('⚠️ Get your token at: https://id.atlassian.com/manage-profile/security/api-tokens');
    }

    console.log(`📡 Attempting Jira REST API v${version} search (endpoint: /${searchEndpoint})`);
    console.log('📡 URL:', url);
    console.log('📡 Base URL:', baseUrl);
    console.log('📡 JQL:', jql);
    console.log('📡 Auth method:', this.settings.jiraApiToken ? 'API Token' : 'Browser Cookies (may fail)');
    console.log('📡 Headers:', JSON.stringify(headers, null, 2));

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: headers,
        credentials: 'include'  // Always include cookies (even though background script may not have access)
      });

      console.log('📡 Jira API response status:', response.status);
      console.log('📡 Response headers:', JSON.stringify([...response.headers.entries()], null, 2));

      if (!response.ok) {
        // Provide detailed error information
        let errorDetails = `HTTP ${response.status}`;
        let errorBody = null;

        try {
          errorBody = await response.json();
          // Convert error body to readable string
          const errorMessage = errorBody.errorMessages?.join(', ') || errorBody.message || '';
          errorDetails += `: ${errorMessage}`;

          // Log the full error object as JSON string
          console.error('Jira API error details (JSON):', JSON.stringify(errorBody, null, 2));
        } catch (e) {
          try {
            const errorText = await response.text();
            errorDetails += `: ${errorText}`;
            console.error('Jira API error text:', errorText);
          } catch (textError) {
            console.error('Could not read error response');
          }
        }

        // Check for common error codes with detailed messages
        if (response.status === 410) {
          const fullError = errorBody ? JSON.stringify(errorBody, null, 2) : 'No error details available';

          // Check if it's the specific Jira Cloud migration message
          if (errorBody && errorBody.errorMessages && errorBody.errorMessages[0]?.includes('/search/jql')) {
            throw new Error(`Jira Cloud API Migration Error (410).

🔍 DIAGNOSIS: Jira Cloud has migrated from /search to /search/jql endpoint (CHANGE-2046).

⚠️ This should be automatically handled by the extension. If you see this error, please report it as a bug.

Current URL: ${url}
Full error: ${fullError}`);
          }

          throw new Error(`Jira API endpoint removed (410).

🔍 DIAGNOSIS: This usually means authentication failed or the endpoint is deprecated.

Possible causes:
1. Background scripts cannot access browser cookies
2. API endpoint has been deprecated
3. Authentication token is missing or invalid

✅ SOLUTION: Provide API Token Authentication
   1. Go to: https://id.atlassian.com/manage-profile/security/api-tokens
   2. Click "Create API token"
   3. Copy the token
   4. Open QAtalyst Settings → Historical Mining section
   5. Enter your Jira email: (e.g., your-email@company.com)
   6. Paste the API token
   7. Save settings and try again

Current URL: ${url}
Full error: ${fullError}`);
        } else if (response.status === 403) {
          throw new Error(`Permission denied (403).

Possible causes:
1. You don't have permission to search across all Jira projects
2. Authentication failed (background script cannot access cookies)

✅ SOLUTION: Use API Token Authentication
   Go to: https://id.atlassian.com/manage-profile/security/api-tokens
   Add your Jira email and API token in Historical Mining settings

Details: ${errorDetails}`);
        } else if (response.status === 401) {
          throw new Error(`Authentication required (401).

⚠️ ROOT CAUSE: Background scripts cannot access browser cookies!

✅ SOLUTION: Use API Token Authentication
   1. Go to: https://id.atlassian.com/manage-profile/security/api-tokens
   2. Create an API token
   3. Add it to Historical Mining settings in QAtalyst

Details: ${errorDetails}`);
        } else if (response.status === 400) {
          throw new Error(`Bad request (400). The JQL query may be invalid.

Check the JQL query in settings. Current query:
${jql}

Details: ${errorDetails}`);
        } else {
          throw new Error(`Jira API v3 error: ${errorDetails}`);
        }
      }

      const data = await response.json();

      if (!data.issues || !Array.isArray(data.issues)) {
        console.warn('No issues found in Jira response');
        return [];
      }

      console.log(`✅ Found ${data.issues.length} historical bugs`);

      // Format issues for easier processing
      return data.issues.map(issue => ({
        key: issue.key,
        summary: issue.fields.summary,
        description: issue.fields.description || '',
        status: issue.fields.status.name,
        resolution: issue.fields.resolution?.name || 'Unresolved',
        created: issue.fields.created,
        priority: issue.fields.priority?.name || 'Medium',
        project: issue.fields.project.key,
        url: `${baseUrl}/browse/${issue.key}`
      }));
    } catch (error) {
      console.error('Jira API call failed:', error);
      throw error;
    }
  }

  /**
   * Helper: Extract plain text from description (handles both string and ADF object)
   */
  extractDescriptionText(description) {
    if (!description) {
      return 'No description';
    }

    // If it's already a string, return it
    if (typeof description === 'string') {
      return description;
    }

    // If it's an Atlassian Document Format (ADF) object
    if (typeof description === 'object' && description.content) {
      // Extract text from ADF recursively
      const extractText = (node) => {
        if (node.text) {
          return node.text;
        }
        if (node.content && Array.isArray(node.content)) {
          return node.content.map(extractText).join(' ');
        }
        return '';
      };

      const text = extractText(description);
      return text.trim() || 'No text content';
    }

    // Fallback: try to stringify
    try {
      return JSON.stringify(description);
    } catch (e) {
      return 'Unable to parse description';
    }
  }

  /**
   * Step 3: Analyze historical bugs for patterns and insights
   */
  async analyzeHistoricalData(features, historicalBugs, ticketData) {
    const systemMessage = `You are a QA pattern analyzer specializing in bug analysis.
Analyze historical bug reports to extract:
1. Common bug patterns and failure scenarios
2. Edge cases that caused bugs
3. Recommended test scenarios to prevent similar bugs
4. Root causes and testing gaps

Return actionable insights for test case generation.`;

    const userMessage = `Current Ticket Context:
Feature: ${features.mainFeature}
Keywords: ${features.keywords.join(', ')}

Historical Bugs Found (${historicalBugs.length} bugs from last year):
${historicalBugs.slice(0, 10).map(bug => {
  const descText = this.extractDescriptionText(bug.description);
  return `
Bug: ${bug.key} (${bug.project})
Summary: ${bug.summary}
Status: ${bug.status}
Created: ${new Date(bug.created).toLocaleDateString()}
Description: ${descText.substring(0, 200)}...
`;
}).join('\n---\n')}

Analyze these bugs and return JSON:
{
  "bugPatterns": [
    {
      "pattern": "Pattern description",
      "frequency": "high/medium/low",
      "affectedIssues": ["BUG-123", "BUG-456"],
      "testRecommendation": "What to test"
    }
  ],
  "commonFailures": ["Failure scenario 1", "Failure scenario 2"],
  "edgeCases": ["Edge case 1", "Edge case 2"],
  "recommendedTests": [
    {
      "title": "Test case title",
      "category": "Positive/Negative/Edge/Security/Performance",
      "priority": "P0/P1/P2/P3",
      "reason": "Why this test is needed based on history",
      "historicalReference": "BUG-123"
    }
  ],
  "riskAreas": ["High risk area 1", "High risk area 2"]
}`;

    try {
      const response = await this.callAI(systemMessage, userMessage, this.settings);

      // Extract JSON from response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const insights = JSON.parse(jsonMatch[0]);

        // Add metadata
        insights.totalBugsAnalyzed = historicalBugs.length;
        insights.analysisDate = new Date().toISOString();

        return insights;
      }

      return this.createBasicInsights(historicalBugs);
    } catch (error) {
      console.error('Historical analysis failed:', error);
      return this.createBasicInsights(historicalBugs);
    }
  }

  /**
   * Create basic insights without AI
   */
  createBasicInsights(historicalBugs) {
    return {
      bugPatterns: [],
      commonFailures: [],
      edgeCases: [],
      recommendedTests: historicalBugs.slice(0, 5).map(bug => ({
        title: `Test scenario related to: ${bug.summary}`,
        category: 'Negative',
        priority: 'P1',
        reason: `Similar bug found: ${bug.key}`,
        historicalReference: bug.key
      })),
      riskAreas: [],
      totalBugsAnalyzed: historicalBugs.length,
      analysisDate: new Date().toISOString()
    };
  }

  /**
   * Clean and fix common JSON errors
   */
  cleanJSON(jsonString) {
    let cleaned = jsonString;

    // Remove trailing commas before closing brackets/braces
    cleaned = cleaned.replace(/,(\s*[\]}])/g, '$1');

    // Fix unescaped quotes in strings (basic attempt)
    // This is tricky and may not catch all cases

    // Remove any text before the first [ or {
    const startMatch = cleaned.match(/[\[{]/);
    if (startMatch) {
      cleaned = cleaned.substring(cleaned.indexOf(startMatch[0]));
    }

    // Remove any text after the last ] or }
    const endMatch = cleaned.match(/[\]}]/g);
    if (endMatch) {
      const lastBracket = cleaned.lastIndexOf(endMatch[endMatch.length - 1]);
      cleaned = cleaned.substring(0, lastBracket + 1);
    }

    return cleaned;
  }

  /**
   * Step 4: Enhance test cases with historical insights
   * SIMPLIFIED to avoid JSON parsing issues
   */
  async enhanceTestCases(baseTestCases, insights, ticketData) {
    if (!insights || !insights.recommendedTests || insights.recommendedTests.length === 0) {
      console.log('No historical insights to enhance with');
      return baseTestCases;
    }

    console.log('Enhancing test cases with historical insights (using simple combination)');

    // Skip AI enhancement and use simple combination to avoid JSON parsing errors
    // This is more reliable and faster
    return this.combineTestsSimple(baseTestCases, insights);
  }

  /**
   * Simple combination of base tests + historical recommendations
   */
  combineTestsSimple(baseTestCases, insights) {
    const historicalTests = insights.recommendedTests.map((rec, idx) => ({
      id: `TC-HIST-${idx + 1}`,
      title: `🛡️ ${rec.title}`,
      category: rec.category,
      priority: rec.priority,
      description: rec.reason,
      preconditions: 'None',
      steps: ['Execute test based on historical bug pattern'],
      expected_result: 'Bug scenario prevented',
      test_data: 'Based on historical data',
      source: 'historical',
      historicalReference: rec.historicalReference,
      preventionReason: rec.reason
    }));

    return [...baseTestCases, ...historicalTests];
  }
}

// Export for use in background.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { HistoricalMiningEngine };
}
