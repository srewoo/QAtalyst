/**
 * Semantic Duplicate Detector - Enhanced duplicate detection using TF-IDF embeddings
 * Uses TF-IDF vectorization + cosine similarity + synonym normalization
 * for true semantic duplicate detection across test cases.
 *
 * Version: 2.0.0
 * Purpose: Catch semantically similar but differently worded tests that
 * Levenshtein distance misses (e.g., "tap save button" ≈ "click save btn")
 */

class SemanticDuplicateDetector {
  constructor(threshold = 0.65) {
    this.threshold = threshold;
    this.cache = new Map();

    // Synonym groups: each word maps to the canonical (first) term
    this.synonymGroups = [
      ['click', 'tap', 'press', 'hit'],
      ['enter', 'type', 'input', 'fill', 'write'],
      ['verify', 'check', 'validate', 'assert', 'confirm', 'ensure'],
      ['navigate', 'go', 'open', 'browse', 'visit'],
      ['select', 'choose', 'pick'],
      ['submit', 'send', 'post'],
      ['delete', 'remove', 'erase', 'clear'],
      ['create', 'add', 'new', 'insert'],
      ['update', 'edit', 'modify', 'change'],
      ['display', 'show', 'render', 'appear', 'visible'],
      ['hide', 'disappear', 'invisible', 'hidden'],
      ['error', 'fail', 'failure', 'exception'],
      ['success', 'succeed', 'passed'],
      ['login', 'signin', 'sign-in', 'log-in', 'authenticate'],
      ['logout', 'signout', 'sign-out', 'log-out'],
      ['upload', 'attach', 'import'],
      ['download', 'export'],
      ['search', 'find', 'query', 'lookup', 'filter'],
      ['message', 'notification', 'alert', 'toast', 'banner'],
      ['user', 'account', 'profile'],
      ['page', 'screen', 'view', 'panel'],
      ['button', 'btn', 'cta'],
      ['form', 'dialog', 'modal', 'popup'],
      ['field', 'textbox', 'textarea'],
      ['valid', 'correct', 'proper', 'accepted'],
      ['invalid', 'incorrect', 'improper', 'rejected', 'wrong'],
      ['redirect', 'forward', 'route'],
      ['load', 'fetch', 'retrieve'],
      ['empty', 'blank', 'null', 'none'],
      ['enable', 'activate', 'turn-on'],
      ['disable', 'deactivate', 'turn-off'],
      ['save', 'store', 'persist'],
      ['cancel', 'abort', 'discard', 'close'],
      ['required', 'mandatory', 'compulsory'],
      ['optional', 'not-required'],
      ['detail', 'information', 'info'],
    ];

    // Build reverse lookup: word → canonical form
    // Also index stemmed forms so "creating" (→"creat") maps to "create"
    this.synonymMap = {};
    for (const group of this.synonymGroups) {
      const canonical = group[0];
      for (const word of group) {
        this.synonymMap[word] = canonical;
        this.synonymMap[word.replace(/-/g, '')] = canonical;
        // Add stemmed form → canonical
        const stemmed = this._basicStem(word);
        if (stemmed !== word) {
          this.synonymMap[stemmed] = canonical;
        }
        // Handle English -e drop: "create" → map "creat" so "creating"→"creat"→"create"
        if (word.endsWith('e') && word.length >= 4) {
          this.synonymMap[word.slice(0, -1)] = canonical;
        }
      }
    }

    // Stopwords: common English words + QA noise that don't carry semantic meaning
    this.stopwords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
      'before', 'after', 'above', 'below', 'between', 'under', 'again',
      'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
      'how', 'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
      'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than',
      'too', 'very', 'just', 'because', 'but', 'and', 'or', 'if', 'while',
      'about', 'up', 'out', 'off', 'over', 'down', 'that', 'this', 'these',
      'those', 'it', 'its', 'he', 'she', 'they', 'them', 'his', 'her',
      'their', 'we', 'our', 'you', 'your', 'who', 'which', 'what',
      'step', 'test', 'case', 'given', 'also', 'using', 'used'
    ]);
  }

  // ========== TF-IDF EMBEDDING ENGINE ==========

  /**
   * Basic stem used during constructor (before stopwords are available).
   * Same logic as stem() but callable before full initialization.
   */
  _basicStem(word) {
    return this.stem(word);
  }

  /**
   * Simple suffix stripping to normalize inflected forms.
   * Handles: -ing, -tion, -sion, -ed, -ly, -es, -s, -ment, -ness, -ity, -able, -ible
   * @param {string} word - Word to stem
   * @returns {string} Stemmed word
   */
  stem(word) {
    if (word.length < 4) return word;

    // Order matters: check longer suffixes first
    const suffixes = [
      { suffix: 'ation', minLen: 6 },
      { suffix: 'tion', minLen: 5 },
      { suffix: 'sion', minLen: 5 },
      { suffix: 'ment', minLen: 5 },
      { suffix: 'ness', minLen: 5 },
      { suffix: 'able', minLen: 5 },
      { suffix: 'ible', minLen: 5 },
      { suffix: 'ying', minLen: 5, replace: 'y' },
      { suffix: 'ting', minLen: 5, replace: 't' },
      { suffix: 'ning', minLen: 5, replace: 'n' },
      { suffix: 'ring', minLen: 5, replace: 'r' },
      { suffix: 'ling', minLen: 5, replace: 'l' },
      { suffix: 'king', minLen: 5, replace: 'k' },
      { suffix: 'ving', minLen: 5, replace: 've' },
      { suffix: 'ding', minLen: 5, replace: 'd' },
      { suffix: 'ging', minLen: 5, replace: 'g' },
      { suffix: 'bing', minLen: 5, replace: 'b' },
      { suffix: 'ping', minLen: 5, replace: 'p' },
      { suffix: 'ing', minLen: 5 },
      { suffix: 'ity', minLen: 5 },
      { suffix: 'ied', minLen: 4, replace: 'y' },
      { suffix: 'eed', minLen: 4 },
      { suffix: 'ted', minLen: 4, replace: 't' },
      { suffix: 'ned', minLen: 4, replace: 'n' },
      { suffix: 'red', minLen: 4, replace: 'r' },
      { suffix: 'sed', minLen: 4, replace: 's' },
      { suffix: 'ded', minLen: 4, replace: 'd' },
      { suffix: 'ged', minLen: 4, replace: 'g' },
      { suffix: 'ved', minLen: 4, replace: 've' },
      { suffix: 'ed', minLen: 4 },
      { suffix: 'ly', minLen: 4 },
      { suffix: 'ies', minLen: 4, replace: 'y' },
      { suffix: 'es', minLen: 4 },
      { suffix: 's', minLen: 4 },
    ];

    for (const { suffix, minLen, replace } of suffixes) {
      if (word.length >= minLen && word.endsWith(suffix)) {
        const stem = word.slice(0, -suffix.length) + (replace || '');
        // Only accept stems that are at least 2 chars
        if (stem.length >= 2) return stem;
      }
    }

    return word;
  }

  /**
   * Strip specific test data values that differ between duplicates but don't indicate intent.
   * Removes emails, URLs, quoted strings, and standalone numbers.
   * @param {string} text - Raw text
   * @returns {string} Cleaned text with structural tokens preserved
   */
  stripSpecificValues(text) {
    if (!text) return '';
    return text
      .replace(/\S+@\S+\.\S+/g, '_email_')                    // emails
      .replace(/https?:\/\/\S+/g, '_url_')                     // URLs
      .replace(/['"][^'"]{2,}['"]/g, '_value_')                 // quoted strings
      .replace(/\b\d{3,}\b/g, '_num_')                          // numbers 3+ digits
      .replace(/\b\d+[KMGkmg][Bb]?\b/g, '_size_');             // file sizes like 500KB
  }

  /**
   * Tokenize text: strip values → lowercase → split → remove stopwords → stem → normalize synonyms
   * @param {string} text - Raw text to tokenize
   * @returns {string[]} Array of normalized tokens
   */
  tokenize(text) {
    if (!text) return [];
    const cleaned = this.stripSpecificValues(text);
    return cleaned.toLowerCase()
      .replace(/[^a-z0-9_\-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2 && !this.stopwords.has(t))
      .map(t => {
        // Stem first, then check synonym map on original, stemmed, and stemmed+e (English -e recovery)
        const stemmed = this.stem(t);
        return this.synonymMap[t] || this.synonymMap[stemmed] || this.synonymMap[stemmed + 'e'] || stemmed;
      });
  }

  /**
   * Generate bigrams from token array for phrase-level matching
   * @param {string[]} tokens - Array of unigram tokens
   * @returns {string[]} Array of "token1_token2" bigram strings
   */
  generateBigrams(tokens) {
    const bigrams = [];
    for (let i = 0; i < tokens.length - 1; i++) {
      bigrams.push(tokens[i] + '_' + tokens[i + 1]);
    }
    return bigrams;
  }

  /**
   * Build a weighted document (token array) from a test case.
   * Focuses on INTENT tokens (title, description) over DETAIL tokens (steps, test data)
   * to capture WHAT is tested rather than HOW, preventing specific values from diluting similarity.
   * @param {Object} testCase - Test case object
   * @returns {string[]} Weighted token array
   */
  buildDocument(testCase) {
    const titleTokens = this.tokenize(testCase.title || '');
    const descTokens = this.tokenize(testCase.description || '');
    const resultTokens = this.tokenize(testCase.expected_result || '');

    // Extract only ACTION VERBS from steps (ignore specific values/targets)
    const stepVerbs = this.extractStepVerbs((testCase.steps || []).join(' '));

    // Intent-focused weighting: title 4x, description 2x, result 1x, step verbs 2x
    const allTokens = [
      ...titleTokens, ...titleTokens, ...titleTokens, ...titleTokens,
      ...descTokens, ...descTokens,
      ...resultTokens,
      ...stepVerbs, ...stepVerbs
    ];

    // Bigrams from title (3x) — strongest intent signal
    const titleBigrams = this.generateBigrams(titleTokens);
    allTokens.push(...titleBigrams, ...titleBigrams, ...titleBigrams);

    // Bigrams from description (1x)
    const descBigrams = this.generateBigrams(descTokens);
    allTokens.push(...descBigrams);

    // Category as a feature
    if (testCase.category) {
      allTokens.push('_cat_' + testCase.category.toLowerCase());
      allTokens.push('_cat_' + testCase.category.toLowerCase());
    }

    return allTokens;
  }

  /**
   * Extract only action verbs from step text (ignoring specific values/targets).
   * Returns canonicalized action tokens for structural comparison.
   * @param {string} stepsText - Combined steps text
   * @returns {string[]} Array of action verb tokens
   */
  extractStepVerbs(stepsText) {
    if (!stepsText) return [];
    const tokens = this.tokenize(stepsText);
    // Keep only known action-related tokens + domain nouns
    const actionTerms = new Set([
      'click', 'enter', 'verify', 'navigate', 'select', 'submit',
      'delete', 'create', 'update', 'display', 'login', 'logout',
      'upload', 'download', 'search', 'save', 'cancel', 'enable',
      'disable', 'load', 'redirect', 'error', 'success', 'valid',
      'invalid', 'empty', 'required', 'button', 'field', 'form',
      'page', 'message', 'user', '_email_', '_url_', '_value_', '_num_'
    ]);
    return tokens.filter(t => actionTerms.has(t) || t.startsWith('_cat_'));
  }

  /**
   * Compute TF-IDF vectors for all test cases in one batch.
   * Uses augmented TF normalization and smoothed IDF.
   * @param {Object[]} testCases - Array of test case objects
   * @returns {{ vectors: Object[], vocabulary: string[], idf: Object }}
   */
  computeCorpusTFIDF(testCases) {
    // Build documents
    const documents = testCases.map(tc => this.buildDocument(tc));
    const N = documents.length;

    // Document frequency: how many documents contain each term
    const df = {};
    for (const doc of documents) {
      const uniqueTerms = new Set(doc);
      for (const term of uniqueTerms) {
        df[term] = (df[term] || 0) + 1;
      }
    }

    // Damped IDF: 1 + log(1 + N/(1+df)) — reduces IDF spread for small corpora
    // so shared terms aren't overly penalized vs unique terms
    const idf = {};
    for (const term in df) {
      idf[term] = 1 + Math.log(1 + N / (1 + df[term]));
    }

    // Compute sparse TF-IDF vector for each document
    const vectors = documents.map(doc => {
      // Term frequency
      const tf = {};
      for (const term of doc) {
        tf[term] = (tf[term] || 0) + 1;
      }

      // Augmented TF normalization: 0.5 + 0.5 * (tf / maxTf)
      const maxTf = Math.max(...Object.values(tf), 1);

      const vector = {};
      for (const term in tf) {
        const normalizedTf = 0.5 + 0.5 * (tf[term] / maxTf);
        vector[term] = normalizedTf * (idf[term] || 1);
      }

      return vector;
    });

    return { vectors, vocabulary: Object.keys(df), idf };
  }

  /**
   * Cosine similarity between two sparse TF-IDF vectors.
   * Iterates over the smaller vector for efficiency.
   * @param {Object} vec1 - Sparse vector { term: tfidf_value }
   * @param {Object} vec2 - Sparse vector { term: tfidf_value }
   * @returns {number} Cosine similarity [0, 1]
   */
  cosineSimilarity(vec1, vec2) {
    let dotProduct = 0;
    let norm1 = 0;
    let norm2 = 0;

    // Iterate over smaller vector for dot product
    const keys1 = Object.keys(vec1);
    const keys2 = Object.keys(vec2);
    const [smaller, larger] = keys1.length <= keys2.length
      ? [vec1, vec2] : [vec2, vec1];

    for (const term in smaller) {
      if (larger[term]) {
        dotProduct += smaller[term] * larger[term];
      }
    }

    for (const term in vec1) {
      norm1 += vec1[term] * vec1[term];
    }
    for (const term in vec2) {
      norm2 += vec2[term] * vec2[term];
    }

    norm1 = Math.sqrt(norm1);
    norm2 = Math.sqrt(norm2);

    if (norm1 === 0 || norm2 === 0) return 0;
    return dotProduct / (norm1 * norm2);
  }

  // ========== DUPLICATE DETECTION (TF-IDF + HEURISTIC) ==========

  /**
   * Detect duplicates using TF-IDF cosine similarity (70%) + heuristic features (30%)
   * @param {Object[]} testCases - Array of test case objects
   * @returns {Object[]} Array of duplicate groups
   */
  detectDuplicates(testCases) {
    if (!testCases || testCases.length < 2) return [];

    // Compute TF-IDF vectors for entire corpus (batch operation)
    const cacheKey = testCases.map(tc => tc.id || tc.title || '').join('|');
    let vectors;
    if (this.cache.has(cacheKey)) {
      vectors = this.cache.get(cacheKey);
    } else {
      const result = this.computeCorpusTFIDF(testCases);
      vectors = result.vectors;
      this.cache.set(cacheKey, vectors);
      // Limit cache size
      if (this.cache.size > 10) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }
    }

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

        // Quick ID check
        if (testCases[i].id && testCases[j].id && testCases[i].id === testCases[j].id) {
          currentGroup.duplicates.push(j);
          currentGroup.similarities.push({
            index: j,
            test: testCases[j],
            lexicalSimilarity: 1.0,
            semanticSimilarity: 1.0,
            combinedSimilarity: 1.0,
            type: 'exact-id'
          });
          processed.add(j);
          continue;
        }

        // TF-IDF cosine similarity (vocabulary/term overlap after synonym normalization)
        const tfidfSim = this.cosineSimilarity(vectors[i], vectors[j]);

        // Heuristic semantic similarity (intent, entities, actions, outcomes)
        const heuristicSim = this.calculateSemanticSimilarity(testCases[i], testCases[j]);

        // Combined: equal weight — TF-IDF captures term overlap, heuristic captures structure
        const combinedSim = (tfidfSim * 0.5) + (heuristicSim * 0.5);

        if (combinedSim >= this.threshold) {
          currentGroup.duplicates.push(j);
          currentGroup.similarities.push({
            index: j,
            test: testCases[j],
            lexicalSimilarity: Math.round(tfidfSim * 100) / 100,
            semanticSimilarity: Math.round(heuristicSim * 100) / 100,
            combinedSimilarity: Math.round(combinedSim * 100) / 100,
            type: tfidfSim > heuristicSim ? 'semantic' : 'heuristic'
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

  // ========== HEURISTIC SEMANTIC FEATURES (secondary signal) ==========

  /**
   * Calculate semantic similarity using heuristic feature extraction
   */
  calculateSemanticSimilarity(test1, test2) {
    const features1 = this.extractSemanticFeatures(test1);
    const features2 = this.extractSemanticFeatures(test2);

    // Intent similarity (40%)
    const intentSim = this.compareIntents(features1.intent, features2.intent);

    // Entity similarity (30%)
    const entitySim = this.compareEntities(features1.entities, features2.entities);

    // Action similarity (20%)
    const actionSim = this.compareActions(features1.actions, features2.actions);

    // Outcome similarity (10%)
    const outcomeSim = this.compareOutcomes(features1.outcome, features2.outcome);

    return (intentSim * 0.4) + (entitySim * 0.3) + (actionSim * 0.2) + (outcomeSim * 0.1);
  }

  extractSemanticFeatures(testCase) {
    const allText = this.combineTestText(testCase);
    return {
      intent: this.extractIntent(testCase),
      entities: this.extractEntities(allText),
      actions: this.extractActions(testCase.steps || []),
      outcome: this.extractOutcome(testCase.expected_result || '')
    };
  }

  combineTestText(testCase) {
    return [
      testCase.title || '',
      testCase.description || '',
      testCase.preconditions || '',
      testCase.expected_result || '',
      ...(testCase.steps || [])
    ].join(' ').toLowerCase();
  }

  extractIntent(testCase) {
    const intent = {
      type: testCase.category?.toLowerCase() || 'unknown',
      polarity: 'positive',
      scenario: 'standard'
    };

    const allText = this.combineTestText(testCase);

    const negativeIndicators = ['fail', 'error', 'invalid', 'incorrect', 'reject', 'deny', 'unable', 'cannot', 'should not'];
    const positiveIndicators = ['success', 'valid', 'correct', 'accept', 'allow', 'able', 'can', 'should work'];

    const hasNegative = negativeIndicators.some(ind => allText.includes(ind));
    const hasPositive = positiveIndicators.some(ind => allText.includes(ind));

    if (hasNegative && !hasPositive) intent.polarity = 'negative';
    else if (hasPositive && !hasNegative) intent.polarity = 'positive';
    else intent.polarity = 'neutral';

    if (allText.includes('boundary') || allText.includes('edge') || allText.includes('limit')) {
      intent.scenario = 'edge';
    } else if (allText.includes('error') || allText.includes('exception')) {
      intent.scenario = 'error';
    } else if (allText.includes('security') || allText.includes('unauthorized') || allText.includes('sql injection')) {
      intent.scenario = 'security';
    }

    return intent;
  }

  extractEntities(text) {
    const entities = { fields: [], buttons: [], apis: [], data: [] };

    const fieldPattern = /(?:field|textbox|box)[\s:]*["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?/gi;
    let match;
    while ((match = fieldPattern.exec(text)) !== null) {
      if (match[1]) entities.fields.push(match[1].toLowerCase());
    }

    const buttonPattern = /(?:button|btn)[\s:]*["']([^"']+)["']/gi;
    while ((match = buttonPattern.exec(text)) !== null) {
      if (match[1]) entities.buttons.push(match[1].toLowerCase());
    }

    const apiPattern = /(?:\/api\/|\/rest\/|endpoint:?)[\s]*([\/a-zA-Z0-9_\-]+)/gi;
    while ((match = apiPattern.exec(text)) !== null) {
      if (match[1]) entities.apis.push(match[1].toLowerCase());
    }

    entities.fields = [...new Set(entities.fields)];
    entities.buttons = [...new Set(entities.buttons)];
    entities.apis = [...new Set(entities.apis)];

    return entities;
  }

  extractActions(steps) {
    // Use tokenize() for synonym normalization: "Tap"→"click", "Type"→"enter", etc.
    const canonicalActions = new Set([
      'click', 'enter', 'verify', 'navigate', 'select', 'submit',
      'delete', 'create', 'update', 'display', 'login', 'logout',
      'upload', 'download', 'search', 'save', 'cancel', 'enable',
      'disable', 'load', 'redirect'
    ]);
    const actions = new Set();
    steps.forEach(step => {
      const tokens = this.tokenize(step);
      tokens.forEach(token => {
        if (canonicalActions.has(token)) actions.add(token);
      });
    });
    return [...actions];
  }

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

  compareIntents(intent1, intent2) {
    let score = 0;
    if (intent1.type === intent2.type) score += 0.5;
    if (intent1.polarity === intent2.polarity) score += 0.3;
    if (intent1.scenario === intent2.scenario) score += 0.2;
    return score;
  }

  compareEntities(entities1, entities2) {
    const allFields1 = new Set([...entities1.fields, ...entities1.buttons, ...entities1.apis]);
    const allFields2 = new Set([...entities2.fields, ...entities2.buttons, ...entities2.apis]);

    // Neutral score when neither test has extractable entities (don't assume match)
    if (allFields1.size === 0 && allFields2.size === 0) return 0.5;
    if (allFields1.size === 0 || allFields2.size === 0) return 0.0;

    const intersection = new Set([...allFields1].filter(x => allFields2.has(x)));
    const union = new Set([...allFields1, ...allFields2]);
    return intersection.size / union.size;
  }

  compareActions(actions1, actions2) {
    if (actions1.length === 0 && actions2.length === 0) return 1.0;
    if (actions1.length === 0 || actions2.length === 0) return 0.0;

    const set1 = new Set(actions1);
    const set2 = new Set(actions2);
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    return intersection.size / union.size;
  }

  compareOutcomes(outcome1, outcome2) {
    const keys = Object.keys(outcome1);
    let matches = 0;
    keys.forEach(key => {
      if (outcome1[key] === outcome2[key]) matches++;
    });
    return matches / keys.length;
  }

  // ========== DUPLICATE REMOVAL & QUALITY SCORING ==========

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
        reductionPercentage: testCases.length > 0
          ? Math.round((removed.length / testCases.length) * 100)
          : 0
      }
    };
  }

  getTestQualityScore(test) {
    let score = 0;

    if (test.description) {
      score += test.description.length / 10;
    }

    if (test.steps && Array.isArray(test.steps)) {
      score += test.steps.length * 5;
      score += test.steps.join('').length / 20;
    }

    if (test.expected_result) {
      score += test.expected_result.length / 10;
    }

    if (test.test_data) score += 10;
    if (test.preconditions) score += 5;

    if (test.priority === 'P0') score += 15;
    else if (test.priority === 'P1') score += 10;
    else if (test.priority === 'P2') score += 5;

    return score;
  }

  // ========== DEPRECATED METHODS (kept for reference) ==========

  /**
   * @deprecated Use TF-IDF cosine similarity via detectDuplicates() instead.
   * Kept for backward compatibility if called directly.
   */
  calculateLexicalSimilarity(test1, test2) {
    if (test1.id && test2.id && test1.id === test2.id) return 1.0;

    const titleSim = this.stringSimilarity(test1.title || '', test2.title || '');
    const stepsSim = this.arraysSimilarity(test1.steps || [], test2.steps || []);
    const resultSim = this.stringSimilarity(test1.expected_result || '', test2.expected_result || '');
    const metaSim = (test1.category === test2.category ? 0.5 : 0) +
      (test1.priority === test2.priority ? 0.5 : 0);

    return (titleSim * 0.4) + (stepsSim * 0.3) + (resultSim * 0.2) + (metaSim * 0.1);
  }

  /** @deprecated Use TF-IDF cosine similarity instead. */
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

  /** @deprecated Use TF-IDF cosine similarity instead. */
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

  /** @deprecated Use TF-IDF cosine similarity instead. */
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
