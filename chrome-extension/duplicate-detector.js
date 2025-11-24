// Duplicate Detection System for QAtalyst
// Provides algorithmic duplicate detection for test cases

class DuplicateDetector {
  constructor(threshold = 0.85) {
    this.threshold = threshold; // 85% similarity threshold by default
  }

  // Calculate overall similarity between two test cases
  calculateSimilarity(test1, test2) {
    // Quick check - if same ID, they're duplicates
    if (test1.id && test2.id && test1.id === test2.id) {
      return 1.0;
    }

    // 1. Title similarity (40% weight) - most important
    const titleSim = this.stringSimilarity(
      test1.title || '',
      test2.title || ''
    );

    // 2. Steps similarity (30% weight) - very important for uniqueness
    const stepsSim = this.arraysSimilarity(
      test1.steps || [],
      test2.steps || []
    );

    // 3. Expected result similarity (20% weight)
    const resultSim = this.stringSimilarity(
      test1.expected_result || '',
      test2.expected_result || ''
    );

    // 4. Category and priority match (10% weight)
    const metaSim =
      (test1.category === test2.category ? 0.5 : 0) +
      (test1.priority === test2.priority ? 0.5 : 0);

    // Weighted average
    const overallSimilarity =
      (titleSim * 0.4) +
      (stepsSim * 0.3) +
      (resultSim * 0.2) +
      (metaSim * 0.1);

    return overallSimilarity;
  }

  // Calculate string similarity using Levenshtein distance
  stringSimilarity(str1, str2) {
    // Handle empty strings
    if (!str1 && !str2) return 1.0;
    if (!str1 || !str2) return 0.0;

    // Normalize strings
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();

    // Exact match
    if (s1 === s2) return 1.0;

    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;

    if (longer.length === 0) return 1.0;

    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  // Levenshtein distance calculation
  levenshteinDistance(str1, str2) {
    const matrix = [];

    // Initialize first column
    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    // Initialize first row
    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    // Calculate distances
    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1      // deletion
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  }

  // Compare arrays of steps or other array fields
  arraysSimilarity(arr1, arr2) {
    if (arr1.length === 0 && arr2.length === 0) return 1.0;
    if (arr1.length === 0 || arr2.length === 0) return 0.0;

    const maxLen = Math.max(arr1.length, arr2.length);
    const minLen = Math.min(arr1.length, arr2.length);

    let totalSim = 0;
    let comparisons = 0;

    // Compare overlapping elements
    for (let i = 0; i < minLen; i++) {
      const item1 = String(arr1[i] || '');
      const item2 = String(arr2[i] || '');
      totalSim += this.stringSimilarity(item1, item2);
      comparisons++;
    }

    // Penalize for length differences
    const lengthPenalty = (maxLen - minLen) / maxLen * 0.5;

    return comparisons > 0 ? (totalSim / comparisons) * (1 - lengthPenalty) : 0;
  }

  // Detect duplicate groups in a test array
  detectDuplicates(testCases) {
    const duplicateGroups = [];
    const processed = new Set();

    for (let i = 0; i < testCases.length; i++) {
      if (processed.has(i)) continue;

      const currentGroup = {
        primary: i,
        primaryTest: testCases[i],
        duplicates: [],
        similarities: []
      };

      for (let j = i + 1; j < testCases.length; j++) {
        if (processed.has(j)) continue;

        const similarity = this.calculateSimilarity(testCases[i], testCases[j]);

        if (similarity >= this.threshold) {
          currentGroup.duplicates.push(j);
          currentGroup.similarities.push({
            index: j,
            test: testCases[j],
            similarity: Math.round(similarity * 100) / 100
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

  // Remove duplicates and return cleaned array
  removeDuplicates(testCases) {
    const duplicateGroups = this.detectDuplicates(testCases);
    const indicesToRemove = new Set();
    const removalReasons = [];

    for (const group of duplicateGroups) {
      // Determine which test to keep (the most detailed one)
      let bestIndex = group.primary;
      let bestScore = this.getTestQualityScore(testCases[bestIndex]);

      // Check all duplicates
      for (const dupInfo of group.similarities) {
        const dupScore = this.getTestQualityScore(testCases[dupInfo.index]);

        if (dupScore > bestScore) {
          // Mark previous best for removal
          indicesToRemove.add(bestIndex);
          removalReasons.push({
            index: bestIndex,
            test: testCases[bestIndex],
            reason: `Duplicate of "${testCases[dupInfo.index].title}" (${dupInfo.similarity * 100}% similar)`
          });

          bestIndex = dupInfo.index;
          bestScore = dupScore;
        } else {
          // Mark duplicate for removal
          indicesToRemove.add(dupInfo.index);
          removalReasons.push({
            index: dupInfo.index,
            test: testCases[dupInfo.index],
            reason: `Duplicate of "${testCases[bestIndex].title}" (${dupInfo.similarity * 100}% similar)`
          });
        }
      }
    }

    // Create cleaned array
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

  // Calculate quality score for a test (used to determine which duplicate to keep)
  getTestQualityScore(test) {
    let score = 0;

    // Detailed description adds value
    if (test.description) {
      score += test.description.length / 10; // Up to ~20 points for 200 char description
    }

    // More steps usually means more detailed test
    if (test.steps && Array.isArray(test.steps)) {
      score += test.steps.length * 5; // 5 points per step
      score += test.steps.join('').length / 20; // Additional points for step detail
    }

    // Specific expected results are valuable
    if (test.expected_result) {
      score += test.expected_result.length / 10;
    }

    // Test data specificity
    if (test.test_data) {
      score += 10;
    }

    // Preconditions add context
    if (test.preconditions) {
      score += 5;
    }

    // Priority weighting (P0 > P1 > P2)
    if (test.priority === 'P0') score += 15;
    else if (test.priority === 'P1') score += 10;
    else if (test.priority === 'P2') score += 5;

    return score;
  }

  // Create semantic signature for quick comparison
  createSemanticSignature(test) {
    const components = [];

    // Extract key actions from title
    if (test.title) {
      const titleWords = test.title.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(word => word.length > 3);
      components.push(...titleWords.slice(0, 3));
    }

    // Extract key actions from steps
    if (test.steps && Array.isArray(test.steps)) {
      const actions = test.steps.join(' ').toLowerCase()
        .match(/\b(click|enter|select|verify|check|validate|submit|upload|delete|create|update|remove)\b/g) || [];
      components.push(...new Set(actions).values());
    }

    // Add category
    if (test.category) {
      components.push(test.category.toLowerCase());
    }

    return components.join('-');
  }

  // Quick check if two tests might be duplicates (for optimization)
  quickDuplicateCheck(test1, test2) {
    // Quick checks before expensive similarity calculation

    // Same ID = definite duplicate
    if (test1.id && test2.id && test1.id === test2.id) {
      return true;
    }

    // Very different titles = probably not duplicates
    if (test1.title && test2.title) {
      const title1Words = new Set(test1.title.toLowerCase().split(/\s+/));
      const title2Words = new Set(test2.title.toLowerCase().split(/\s+/));

      const intersection = new Set([...title1Words].filter(x => title2Words.has(x)));
      const union = new Set([...title1Words, ...title2Words]);

      const jaccard = intersection.size / union.size;
      if (jaccard < 0.2) return false; // Less than 20% word overlap
    }

    // Different categories might still have duplicates, but less likely
    if (test1.category && test2.category && test1.category !== test2.category) {
      // Still check, but with higher threshold
      return this.calculateSimilarity(test1, test2) > 0.95;
    }

    // Default to full check
    return this.calculateSimilarity(test1, test2) >= this.threshold;
  }

  // Analyze duplicate patterns for reporting
  analyzeDuplicatePatterns(testCases) {
    const patterns = {
      byCategory: {},
      byPriority: {},
      commonDuplicateTypes: [],
      recommendations: []
    };

    const duplicateGroups = this.detectDuplicates(testCases);

    // Analyze by category
    for (const group of duplicateGroups) {
      const category = testCases[group.primary].category || 'Unknown';
      patterns.byCategory[category] = (patterns.byCategory[category] || 0) + 1 + group.duplicates.length;
    }

    // Analyze by priority
    for (const group of duplicateGroups) {
      const priority = testCases[group.primary].priority || 'Unknown';
      patterns.byPriority[priority] = (patterns.byPriority[priority] || 0) + 1 + group.duplicates.length;
    }

    // Identify common patterns
    const titlePatterns = {};
    for (const group of duplicateGroups) {
      const primaryTitle = testCases[group.primary].title || '';
      const keywords = primaryTitle.toLowerCase().split(/\s+/).filter(w => w.length > 4);

      for (const keyword of keywords) {
        titlePatterns[keyword] = (titlePatterns[keyword] || 0) + 1;
      }
    }

    // Sort patterns by frequency
    const sortedPatterns = Object.entries(titlePatterns)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    patterns.commonDuplicateTypes = sortedPatterns.map(([keyword, count]) => ({
      keyword,
      occurrences: count,
      recommendation: `Review tests containing "${keyword}" for potential consolidation`
    }));

    // Generate recommendations
    if (Object.keys(patterns.byCategory).length > 0) {
      const highestDupCategory = Object.entries(patterns.byCategory)
        .sort((a, b) => b[1] - a[1])[0];

      patterns.recommendations.push(
        `${highestDupCategory[0]} tests have the most duplicates (${highestDupCategory[1]}). Consider reviewing test generation prompts for this category.`
      );
    }

    if (duplicateGroups.length > testCases.length * 0.15) {
      patterns.recommendations.push(
        'High duplicate rate detected (>15%). Consider implementing pre-generation deduplication checks.'
      );
    }

    return patterns;
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DuplicateDetector;
}

// Also make available globally in browser/service worker context
if (typeof window !== 'undefined') {
  window.DuplicateDetector = DuplicateDetector;
} else if (typeof self !== 'undefined') {
  // Service worker context
  self.DuplicateDetector = DuplicateDetector;
}