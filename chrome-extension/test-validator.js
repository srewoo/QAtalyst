/**
 * Test Case Validator - Validates generated tests against knowledge graph
 * Prevents hallucinations by checking if referenced fields/APIs/buttons exist
 *
 * Version: 1.0.0
 * Purpose: Address hallucination and grounding issues in test generation
 */

class TestCaseValidator {
  constructor(knowledgeGraph) {
    this.knowledgeGraph = knowledgeGraph;
    this.validationCache = new Map();

    // Build searchable indices from knowledge graph
    this.indices = this.buildIndices();
  }

  /**
   * Build searchable indices from knowledge graph for fast lookups
   */
  buildIndices() {
    const indices = {
      fields: new Set(),
      formIds: new Set(),
      buttons: new Set(),
      apis: new Set(),
      pages: new Set(),
      textContent: new Set() // Common UI text/labels
    };

    if (!this.knowledgeGraph) {
      return indices;
    }

    // Extract form fields
    if (this.knowledgeGraph.forms) {
      this.knowledgeGraph.forms.forEach(form => {
        if (form.id) indices.formIds.add(form.id.toLowerCase());
        if (form.action) indices.apis.add(this.normalizeApiPath(form.action));

        if (form.inputs) {
          form.inputs.forEach(input => {
            if (input.name) indices.fields.add(input.name.toLowerCase());
            if (input.id) indices.fields.add(input.id.toLowerCase());
            if (input.placeholder) indices.textContent.add(input.placeholder.toLowerCase());
          });
        }
      });
    }

    // Extract API endpoints
    if (this.knowledgeGraph.apis) {
      this.knowledgeGraph.apis.forEach(api => {
        if (api.endpoint) {
          indices.apis.add(this.normalizeApiPath(api.endpoint));
        }
      });
    }

    // Extract buttons
    if (this.knowledgeGraph.features) {
      this.knowledgeGraph.features.forEach(feature => {
        if (feature.type === 'button' && feature.text) {
          indices.buttons.add(feature.text.toLowerCase());
        }
      });
    }

    // Extract pages
    if (this.knowledgeGraph.pages) {
      Object.keys(this.knowledgeGraph.pages).forEach(url => {
        indices.pages.add(url.toLowerCase());
        const page = this.knowledgeGraph.pages[url];
        if (page.title) indices.textContent.add(page.title.toLowerCase());
      });
    }

    console.log('📊 [TestValidator] Indices built:', {
      fields: indices.fields.size,
      formIds: indices.formIds.size,
      buttons: indices.buttons.size,
      apis: indices.apis.size,
      pages: indices.pages.size,
      textContent: indices.textContent.size
    });

    return indices;
  }

  /**
   * Normalize API paths for comparison (remove domain, query params)
   */
  normalizeApiPath(path) {
    if (!path) return '';

    try {
      // If it's a full URL, extract pathname
      if (path.startsWith('http')) {
        const url = new URL(path);
        return url.pathname.toLowerCase();
      }
      // Remove query params
      return path.split('?')[0].toLowerCase();
    } catch (e) {
      return path.toLowerCase();
    }
  }

  /**
   * Validate a single test case against knowledge graph
   * Returns validation result with warnings and confidence score
   */
  validateTestCase(testCase) {
    // Check cache first
    const cacheKey = testCase.id || testCase.title;
    if (this.validationCache.has(cacheKey)) {
      return this.validationCache.get(cacheKey);
    }

    const validation = {
      testId: testCase.id,
      isValid: true,
      confidence: 'HIGH',
      warnings: [],
      hallucinations: [],
      matches: {
        fields: [],
        buttons: [],
        apis: []
      },
      grounding: {
        hasContext: !!this.knowledgeGraph,
        totalReferences: 0,
        matchedReferences: 0,
        unmatchedReferences: []
      }
    };

    // If no knowledge graph, mark as low confidence
    if (!this.knowledgeGraph || this.indices.fields.size === 0) {
      validation.confidence = 'LOW';
      validation.warnings.push('No application context available - test may be generic');
      this.validationCache.set(cacheKey, validation);
      return validation;
    }

    // Extract references from test case
    const references = this.extractReferences(testCase);
    validation.grounding.totalReferences = references.fields.length + references.buttons.length + references.apis.length;

    // Validate field references
    references.fields.forEach(field => {
      if (this.indices.fields.has(field.toLowerCase())) {
        validation.matches.fields.push(field);
        validation.grounding.matchedReferences++;
      } else {
        // Fuzzy match check
        const fuzzyMatch = this.findFuzzyMatch(field, Array.from(this.indices.fields));
        if (fuzzyMatch) {
          validation.warnings.push(`Field "${field}" not found - did you mean "${fuzzyMatch}"?`);
          validation.grounding.matchedReferences++; // Count as partial match
        } else {
          validation.hallucinations.push(`Field "${field}" not found in application`);
          validation.grounding.unmatchedReferences.push(field);
        }
      }
    });

    // Validate button references
    references.buttons.forEach(button => {
      const normalized = button.toLowerCase();
      if (this.indices.buttons.has(normalized) || this.indices.textContent.has(normalized)) {
        validation.matches.buttons.push(button);
        validation.grounding.matchedReferences++;
      } else {
        const fuzzyMatch = this.findFuzzyMatch(button, Array.from(this.indices.buttons));
        if (fuzzyMatch) {
          validation.warnings.push(`Button "${button}" not found - did you mean "${fuzzyMatch}"?`);
          validation.grounding.matchedReferences++;
        } else {
          validation.hallucinations.push(`Button "${button}" not found in application`);
          validation.grounding.unmatchedReferences.push(button);
        }
      }
    });

    // Validate API references
    references.apis.forEach(api => {
      const normalized = this.normalizeApiPath(api);
      if (this.indices.apis.has(normalized)) {
        validation.matches.apis.push(api);
        validation.grounding.matchedReferences++;
      } else {
        const fuzzyMatch = this.findFuzzyMatch(normalized, Array.from(this.indices.apis));
        if (fuzzyMatch) {
          validation.warnings.push(`API "${api}" not found - did you mean "${fuzzyMatch}"?`);
          validation.grounding.matchedReferences++;
        } else {
          validation.hallucinations.push(`API endpoint "${api}" not found in application`);
          validation.grounding.unmatchedReferences.push(api);
        }
      }
    });

    // Calculate confidence score
    validation.confidence = this.calculateConfidence(validation.grounding);

    // Mark as invalid if too many hallucinations
    if (validation.hallucinations.length > 2) {
      validation.isValid = false;
      validation.warnings.push(`Test contains ${validation.hallucinations.length} potential hallucinations`);
    }

    this.validationCache.set(cacheKey, validation);
    return validation;
  }

  /**
   * Extract field, button, and API references from test case
   */
  extractReferences(testCase) {
    const references = {
      fields: [],
      buttons: [],
      apis: []
    };

    // Combine all text from test case
    const allText = [
      testCase.title || '',
      testCase.description || '',
      testCase.preconditions || '',
      testCase.expected_result || '',
      ...(testCase.steps || [])
    ].join(' ');

    // Extract field references (common patterns)
    // Examples: "email field", "emailInput", "username_field", "password input"
    const fieldPatterns = [
      /(?:field|input|textbox|textarea)[\s:]*["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?/gi,
      /(?:enter|type|input).*?in(?:to)?[\s]+["']?([a-zA-Z_][a-zA-Z0-9_]+)["']?/gi,
      /["']([a-zA-Z_][a-zA-Z0-9_]*(?:Input|Field|Box|Area))["']/gi
    ];

    fieldPatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(allText)) !== null) {
        if (match[1] && match[1].length > 1) {
          references.fields.push(match[1]);
        }
      }
    });

    // Extract button references
    // Examples: "Login button", "Click 'Submit'", "press the Save button"
    const buttonPatterns = [
      /(?:button|btn)[\s:]*["']([^"']+)["']/gi,
      /(?:click|press|tap)[\s]+(?:the)?[\s]*["']([^"']+)["']/gi,
      /["']([^"']+)["'][\s]+(?:button|btn)/gi
    ];

    buttonPatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(allText)) !== null) {
        if (match[1] && match[1].length > 1) {
          references.buttons.push(match[1]);
        }
      }
    });

    // Extract API endpoint references
    // Examples: "/api/login", "POST /users", "endpoint: /auth/token"
    const apiPatterns = [
      /(?:GET|POST|PUT|DELETE|PATCH)[\s]+([\/a-zA-Z0-9_\-\.]+)/gi,
      /(?:endpoint|api|url)[\s:]+["']?([\/a-zA-Z0-9_\-\.]+)["']?/gi,
      /(?:calls?|invokes?)[\s]+["']?([\/a-zA-Z0-9_\-\.]+)["']?/gi
    ];

    apiPatterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(allText)) !== null) {
        if (match[1] && match[1].startsWith('/')) {
          references.apis.push(match[1]);
        }
      }
    });

    // Deduplicate
    references.fields = [...new Set(references.fields)];
    references.buttons = [...new Set(references.buttons)];
    references.apis = [...new Set(references.apis)];

    return references;
  }

  /**
   * Find fuzzy match for a string in a set (typo tolerance)
   */
  findFuzzyMatch(target, candidates) {
    if (!target || candidates.length === 0) return null;

    const targetLower = target.toLowerCase();
    let bestMatch = null;
    let bestScore = 0;

    for (const candidate of candidates) {
      const score = this.calculateSimilarity(targetLower, candidate.toLowerCase());
      if (score > 0.8 && score > bestScore) {
        bestMatch = candidate;
        bestScore = score;
      }
    }

    return bestMatch;
  }

  /**
   * Calculate string similarity (Jaro-Winkler inspired)
   */
  calculateSimilarity(s1, s2) {
    if (s1 === s2) return 1.0;
    if (!s1 || !s2) return 0.0;

    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;

    if (longer.length === 0) return 1.0;

    // Check if shorter is contained in longer
    if (longer.includes(shorter)) return 0.85;

    // Levenshtein distance
    const editDistance = this.levenshteinDistance(s1, s2);
    return (longer.length - editDistance) / longer.length;
  }

  levenshteinDistance(str1, str2) {
    const matrix = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  }

  /**
   * Calculate confidence score based on grounding metrics
   */
  calculateConfidence(grounding) {
    if (!grounding.hasContext) return 'NONE';
    if (grounding.totalReferences === 0) return 'MEDIUM'; // No specific references

    const matchRate = grounding.matchedReferences / grounding.totalReferences;

    if (matchRate >= 0.8) return 'HIGH';
    if (matchRate >= 0.5) return 'MEDIUM';
    return 'LOW';
  }

  /**
   * Validate all test cases in a test suite
   */
  validateTestSuite(testCases) {
    const results = {
      total: testCases.length,
      valid: 0,
      invalid: 0,
      highConfidence: 0,
      mediumConfidence: 0,
      lowConfidence: 0,
      noneConfidence: 0,
      totalHallucinations: 0,
      testValidations: []
    };

    testCases.forEach(testCase => {
      const validation = this.validateTestCase(testCase);
      results.testValidations.push(validation);

      if (validation.isValid) results.valid++;
      else results.invalid++;

      if (validation.confidence === 'HIGH') results.highConfidence++;
      else if (validation.confidence === 'MEDIUM') results.mediumConfidence++;
      else if (validation.confidence === 'LOW') results.lowConfidence++;
      else results.noneConfidence++;

      results.totalHallucinations += validation.hallucinations.length;
    });

    return results;
  }

  /**
   * Generate validation report
   */
  generateReport(validationResults) {
    const report = {
      summary: {
        totalTests: validationResults.total,
        validTests: validationResults.valid,
        invalidTests: validationResults.invalid,
        overallConfidence: this.calculateOverallConfidence(validationResults)
      },
      breakdown: {
        highConfidence: validationResults.highConfidence,
        mediumConfidence: validationResults.mediumConfidence,
        lowConfidence: validationResults.lowConfidence,
        noConfidence: validationResults.noneConfidence
      },
      issues: {
        totalHallucinations: validationResults.totalHallucinations,
        testsWithHallucinations: validationResults.testValidations
          .filter(v => v.hallucinations.length > 0)
          .map(v => ({
            testId: v.testId,
            count: v.hallucinations.length,
            details: v.hallucinations
          }))
      },
      recommendations: []
    };

    // Add recommendations
    if (validationResults.lowConfidence + validationResults.noneConfidence > validationResults.total * 0.3) {
      report.recommendations.push('HIGH RISK: Over 30% of tests have low confidence. Consider crawling the application or adding more context.');
    }

    if (validationResults.totalHallucinations > validationResults.total * 0.5) {
      report.recommendations.push('HALLUCINATION WARNING: Many test cases reference non-existent fields/buttons. Review and regenerate tests with better context.');
    }

    if (validationResults.highConfidence > validationResults.total * 0.7) {
      report.recommendations.push('GOOD: Over 70% of tests have high confidence. Tests are well-grounded in actual application.');
    }

    return report;
  }

  calculateOverallConfidence(validationResults) {
    const total = validationResults.total;
    if (total === 0) return 'NONE';

    const score = (
      (validationResults.highConfidence * 1.0) +
      (validationResults.mediumConfidence * 0.6) +
      (validationResults.lowConfidence * 0.3)
    ) / total;

    if (score >= 0.7) return 'HIGH';
    if (score >= 0.4) return 'MEDIUM';
    return 'LOW';
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = TestCaseValidator;
}

// Make available globally in browser/service worker context
if (typeof window !== 'undefined') {
  window.TestCaseValidator = TestCaseValidator;
} else if (typeof self !== 'undefined') {
  self.TestCaseValidator = TestCaseValidator;
}
