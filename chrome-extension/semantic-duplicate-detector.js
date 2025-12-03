/**
 * Semantic Duplicate Detector - Enhanced duplicate detection using semantic similarity
 * Goes beyond string matching to understand test intent
 *
 * Version: 1.0.0
 * Purpose: Improve duplicate detection to catch semantically similar but differently worded tests
 */

class SemanticDuplicateDetector {
  constructor(threshold = 0.85) {
    this.threshold = threshold;
    this.semanticThreshold = 0.75; // Lower threshold for semantic similarity
    this.cache = new Map();
  }

  /**
   * Detect duplicates using both lexical and semantic similarity
   */
  detectDuplicates(testCases) {
    const duplicateGroups = [];
    const processed = new Set();

    for (let i = 0; i < testCases.length; i++) {
      if (processed.has(i)) continue;

      const currentGroup = {
        primary: i,
        primaryTest: testCases[i],
        duplicates: [],
        similarities: [],
        semanticMatches: []
      };

      for (let j = i + 1; j < testCases.length; j++) {
        if (processed.has(j)) continue;

        // Calculate lexical similarity (traditional)
        const lexicalSim = this.calculateLexicalSimilarity(testCases[i], testCases[j]);

        // Calculate semantic similarity
        const semanticSim = this.calculateSemanticSimilarity(testCases[i], testCases[j]);

        // Combined similarity (weighted average)
        const combinedSim = (lexicalSim * 0.6) + (semanticSim * 0.4);

        if (combinedSim >= this.threshold) {
          currentGroup.duplicates.push(j);
          currentGroup.similarities.push({
            index: j,
            test: testCases[j],
            lexicalSimilarity: Math.round(lexicalSim * 100) / 100,
            semanticSimilarity: Math.round(semanticSim * 100) / 100,
            combinedSimilarity: Math.round(combinedSim * 100) / 100,
            type: semanticSim > lexicalSim ? 'semantic' : 'lexical'
          });
          processed.add(j);
        }
      }

      if (currentGroup.duplicates.length > 0) {
        duplicateGroups.push(currentGroup);
        processed.add(i);
      }
    }

    return duplicateGroups;
  }

  /**
   * Calculate lexical similarity (traditional string-based)
   */
  calculateLexicalSimilarity(test1, test2) {
    // Quick check - same ID
    if (test1.id && test2.id && test1.id === test2.id) {
      return 1.0;
    }

    // Title similarity (40%)
    const titleSim = this.stringSimilarity(
      test1.title || '',
      test2.title || ''
    );

    // Steps similarity (30%)
    const stepsSim = this.arraysSimilarity(
      test1.steps || [],
      test2.steps || []
    );

    // Expected result similarity (20%)
    const resultSim = this.stringSimilarity(
      test1.expected_result || '',
      test2.expected_result || ''
    );

    // Metadata match (10%)
    const metaSim =
      (test1.category === test2.category ? 0.5 : 0) +
      (test1.priority === test2.priority ? 0.5 : 0);

    return (titleSim * 0.4) + (stepsSim * 0.3) + (resultSim * 0.2) + (metaSim * 0.1);
  }

  /**
   * Calculate semantic similarity (intent-based)
   */
  calculateSemanticSimilarity(test1, test2) {
    // Extract semantic features
    const features1 = this.extractSemanticFeatures(test1);
    const features2 = this.extractSemanticFeatures(test2);

    let score = 0;
    let totalWeight = 0;

    // Intent similarity (40%)
    const intentSim = this.compareIntents(features1.intent, features2.intent);
    score += intentSim * 0.4;
    totalWeight += 0.4;

    // Entity similarity (30%) - what is being tested
    const entitySim = this.compareEntities(features1.entities, features2.entities);
    score += entitySim * 0.3;
    totalWeight += 0.3;

    // Action similarity (20%) - what actions are taken
    const actionSim = this.compareActions(features1.actions, features2.actions);
    score += actionSim * 0.2;
    totalWeight += 0.2;

    // Outcome similarity (10%) - expected result
    const outcomeSim = this.compareOutcomes(features1.outcome, features2.outcome);
    score += outcomeSim * 0.1;
    totalWeight += 0.1;

    return score / totalWeight;
  }

  /**
   * Extract semantic features from test case
   */
  extractSemanticFeatures(testCase) {
    const allText = this.combineTestText(testCase);

    return {
      intent: this.extractIntent(testCase),
      entities: this.extractEntities(allText),
      actions: this.extractActions(testCase.steps || []),
      outcome: this.extractOutcome(testCase.expected_result || '')
    };
  }

  /**
   * Combine all text from test case
   */
  combineTestText(testCase) {
    return [
      testCase.title || '',
      testCase.description || '',
      testCase.preconditions || '',
      testCase.expected_result || '',
      ...(testCase.steps || [])
    ].join(' ').toLowerCase();
  }

  /**
   * Extract test intent (positive, negative, edge, etc.)
   */
  extractIntent(testCase) {
    const intent = {
      type: testCase.category?.toLowerCase() || 'unknown',
      polarity: 'positive', // positive, negative, neutral
      scenario: 'standard'   // standard, edge, error, security
    };

    const allText = this.combineTestText(testCase);

    // Determine polarity
    const negativeIndicators = ['fail', 'error', 'invalid', 'incorrect', 'reject', 'deny', 'unable', 'cannot', 'should not'];
    const positiveIndicators = ['success', 'valid', 'correct', 'accept', 'allow', 'able', 'can', 'should work'];

    const hasNegative = negativeIndicators.some(ind => allText.includes(ind));
    const hasPositive = positiveIndicators.some(ind => allText.includes(ind));

    if (hasNegative && !hasPositive) intent.polarity = 'negative';
    else if (hasPositive && !hasNegative) intent.polarity = 'positive';
    else intent.polarity = 'neutral';

    // Determine scenario
    if (allText.includes('boundary') || allText.includes('edge') || allText.includes('limit')) {
      intent.scenario = 'edge';
    } else if (allText.includes('error') || allText.includes('exception')) {
      intent.scenario = 'error';
    } else if (allText.includes('security') || allText.includes('unauthorized') || allText.includes('sql injection')) {
      intent.scenario = 'security';
    }

    return intent;
  }

  /**
   * Extract entities (fields, buttons, APIs, data)
   */
  extractEntities(text) {
    const entities = {
      fields: [],
      buttons: [],
      apis: [],
      data: []
    };

    // Extract field names (emailInput, password_field, etc.)
    const fieldPattern = /(?:field|input|textbox|box)[\s:]*["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?/gi;
    let match;
    while ((match = fieldPattern.exec(text)) !== null) {
      if (match[1]) entities.fields.push(match[1].toLowerCase());
    }

    // Extract button names
    const buttonPattern = /(?:button|btn)[\s:]*["']([^"']+)["']/gi;
    while ((match = buttonPattern.exec(text)) !== null) {
      if (match[1]) entities.buttons.push(match[1].toLowerCase());
    }

    // Extract API paths
    const apiPattern = /(?:\/api\/|\/rest\/|endpoint:?)[\s]*([\/a-zA-Z0-9_\-]+)/gi;
    while ((match = apiPattern.exec(text)) !== null) {
      if (match[1]) entities.apis.push(match[1].toLowerCase());
    }

    // Deduplicate
    entities.fields = [...new Set(entities.fields)];
    entities.buttons = [...new Set(entities.buttons)];
    entities.apis = [...new Set(entities.apis)];

    return entities;
  }

  /**
   * Extract actions from steps
   */
  extractActions(steps) {
    const actions = [];
    const actionVerbs = ['click', 'enter', 'type', 'select', 'choose', 'submit', 'navigate', 'open', 'close', 'verify', 'check', 'validate', 'upload', 'download', 'delete', 'create', 'update', 'edit'];

    steps.forEach(step => {
      const stepLower = step.toLowerCase();
      actionVerbs.forEach(verb => {
        if (stepLower.includes(verb)) {
          actions.push(verb);
        }
      });
    });

    return [...new Set(actions)];
  }

  /**
   * Extract outcome from expected result
   */
  extractOutcome(expectedResult) {
    const outcome = {
      success: false,
      failure: false,
      data: false,
      navigation: false,
      message: false
    };

    const text = expectedResult.toLowerCase();

    outcome.success = text.includes('success') || text.includes('should work') || text.includes('accepted');
    outcome.failure = text.includes('fail') || text.includes('reject') || text.includes('error');
    outcome.data = text.includes('data') || text.includes('display') || text.includes('show');
    outcome.navigation = text.includes('redirect') || text.includes('navigate') || text.includes('page');
    outcome.message = text.includes('message') || text.includes('alert') || text.includes('notification');

    return outcome;
  }

  /**
   * Compare intents
   */
  compareIntents(intent1, intent2) {
    let score = 0;

    // Type match (50%)
    if (intent1.type === intent2.type) score += 0.5;

    // Polarity match (30%)
    if (intent1.polarity === intent2.polarity) score += 0.3;

    // Scenario match (20%)
    if (intent1.scenario === intent2.scenario) score += 0.2;

    return score;
  }

  /**
   * Compare entities using Jaccard similarity
   */
  compareEntities(entities1, entities2) {
    const allFields1 = new Set([
      ...entities1.fields,
      ...entities1.buttons,
      ...entities1.apis
    ]);

    const allFields2 = new Set([
      ...entities2.fields,
      ...entities2.buttons,
      ...entities2.apis
    ]);

    if (allFields1.size === 0 && allFields2.size === 0) return 1.0;
    if (allFields1.size === 0 || allFields2.size === 0) return 0.0;

    const intersection = new Set([...allFields1].filter(x => allFields2.has(x)));
    const union = new Set([...allFields1, ...allFields2]);

    return intersection.size / union.size;
  }

  /**
   * Compare actions using Jaccard similarity
   */
  compareActions(actions1, actions2) {
    if (actions1.length === 0 && actions2.length === 0) return 1.0;
    if (actions1.length === 0 || actions2.length === 0) return 0.0;

    const set1 = new Set(actions1);
    const set2 = new Set(actions2);

    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);

    return intersection.size / union.size;
  }

  /**
   * Compare outcomes
   */
  compareOutcomes(outcome1, outcome2) {
    const keys = Object.keys(outcome1);
    let matches = 0;

    keys.forEach(key => {
      if (outcome1[key] === outcome2[key]) matches++;
    });

    return matches / keys.length;
  }

  // String similarity methods (reused from original)
  stringSimilarity(str1, str2) {
    if (!str1 && !str2) return 1.0;
    if (!str1 || !str2) return 0.0;

    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();

    if (s1 === s2) return 1.0;

    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;

    if (longer.length === 0) return 1.0;

    const editDistance = this.levenshteinDistance(longer, shorter);
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

  arraysSimilarity(arr1, arr2) {
    if (arr1.length === 0 && arr2.length === 0) return 1.0;
    if (arr1.length === 0 || arr2.length === 0) return 0.0;

    const maxLen = Math.max(arr1.length, arr2.length);
    const minLen = Math.min(arr1.length, arr2.length);

    let totalSim = 0;
    for (let i = 0; i < minLen; i++) {
      totalSim += this.stringSimilarity(String(arr1[i] || ''), String(arr2[i] || ''));
    }

    const lengthPenalty = (maxLen - minLen) / maxLen * 0.5;
    return (totalSim / minLen) * (1 - lengthPenalty);
  }

  /**
   * Remove duplicates keeping best quality test
   */
  removeDuplicates(testCases) {
    const duplicateGroups = this.detectDuplicates(testCases);
    const indicesToRemove = new Set();
    const removalReasons = [];

    for (const group of duplicateGroups) {
      let bestIndex = group.primary;
      let bestScore = this.getTestQualityScore(testCases[bestIndex]);

      for (const dupInfo of group.similarities) {
        const dupScore = this.getTestQualityScore(testCases[dupInfo.index]);

        if (dupScore > bestScore) {
          indicesToRemove.add(bestIndex);
          removalReasons.push({
            index: bestIndex,
            test: testCases[bestIndex],
            reason: `Duplicate of "${testCases[dupInfo.index].title}" (${Math.round(dupInfo.combinedSimilarity * 100)}% similar, ${dupInfo.type} match)`
          });

          bestIndex = dupInfo.index;
          bestScore = dupScore;
        } else {
          indicesToRemove.add(dupInfo.index);
          removalReasons.push({
            index: dupInfo.index,
            test: testCases[dupInfo.index],
            reason: `Duplicate of "${testCases[bestIndex].title}" (${Math.round(dupInfo.combinedSimilarity * 100)}% similar, ${dupInfo.type} match)`
          });
        }
      }
    }

    const cleaned = testCases.filter((_, idx) => !indicesToRemove.has(idx));
    const removed = Array.from(indicesToRemove).map(idx => testCases[idx]);

    return {
      cleaned,
      removed,
      removedCount: removed.length,
      duplicateGroups,
      removalReasons,
      summary: {
        original: testCases.length,
        duplicates: removed.length,
        unique: cleaned.length,
        reductionPercentage: Math.round((removed.length / testCases.length) * 100)
      }
    };
  }

  getTestQualityScore(test) {
    let score = 0;

    // Description quality
    if (test.description) {
      score += test.description.length / 10;
    }

    // Steps detail
    if (test.steps && Array.isArray(test.steps)) {
      score += test.steps.length * 5;
      score += test.steps.join('').length / 20;
    }

    // Expected result specificity
    if (test.expected_result) {
      score += test.expected_result.length / 10;
    }

    // Test data
    if (test.test_data) score += 10;

    // Preconditions
    if (test.preconditions) score += 5;

    // Priority
    if (test.priority === 'P0') score += 15;
    else if (test.priority === 'P1') score += 10;
    else if (test.priority === 'P2') score += 5;

    return score;
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SemanticDuplicateDetector;
}

// Make available globally
if (typeof window !== 'undefined') {
  window.SemanticDuplicateDetector = SemanticDuplicateDetector;
} else if (typeof self !== 'undefined') {
  self.SemanticDuplicateDetector = SemanticDuplicateDetector;
}
