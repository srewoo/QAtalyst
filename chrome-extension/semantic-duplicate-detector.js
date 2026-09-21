/**
 * Semantic Duplicate Detector - Enhanced duplicate detection using TF-IDF embeddings
 * Uses TF-IDF vectorization + cosine similarity + synonym normalization
 * for true semantic duplicate detection across test cases.
 *
 * Version: 2.0.0
 * Purpose: Catch semantically similar but differently worded tests that
 * Levenshtein distance misses (e.g., "tap save button" ≈ "click save btn")
 */

/** Evaluate a similarity call, treating any failure as "no evidence" (0). */
function safeNum(fn) { try { const v = fn(); return Number.isFinite(v) ? v : 0; } catch (_) { return 0; } }

class SemanticDuplicateDetector {
  constructor(threshold = 0.62) {
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

        // F04: a shared id is NOT proof of duplicate content. Models reuse ids
        // ("TC-001") across entirely different scenarios, and this shortcut
        // deleted the second one without ever comparing what it tested.
        // Identity is the scenario, not the label — fall through to the real
        // comparison below.

        // TF-IDF cosine similarity (vocabulary/term overlap after synonym normalization)
        const tfidfSim = this.cosineSimilarity(vectors[i], vectors[j]);

        // Heuristic semantic similarity (intent, entities, actions, outcomes)
        const heuristicSim = this.calculateSemanticSimilarity(testCases[i], testCases[j]);

        // Combined: equal weight — TF-IDF captures term overlap, heuristic captures structure
        const combinedSim = (tfidfSim * 0.5) + (heuristicSim * 0.5);

        // F05: however similar the text, a proven distinction vetoes the merge.
        const distinct = SemanticDuplicateDetector.distinctionReason(testCases[i], testCases[j]);
        if (distinct) {
          if (combinedSim >= this.threshold) {
            (this.preservedDistinctions ||= []).push({
              a: testCases[i].title, b: testCases[j].title,
              similarity: Math.round(combinedSim * 100) / 100, reason: distinct
            });
          }
          continue;
        }

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

  // ========== HARD DISTINCTION CHECKS (F05) ==========

  /**
   * Operations that are NOT each other, however similarly they are worded.
   * "Export invoices" and "Archive invoices" share every token but the verb and
   * scored 0.75 — above the 0.68 gate — so one was silently deleted.
   */
  static get OPERATION_CUES() {
    return {
      export: /\bexport(?:s|ed|ing)?|download(?:s|ed|ing)?\b/i,
      archive: /\barchiv(?:e|es|ed|ing)\b/i,
      delete: /\bdelete(?:s|d)?|remove(?:s|d)?|destroy|purge\b/i,
      create: /\bcreate(?:s|d)?|add(?:s|ed)?|new\b/i,
      update: /\bupdate(?:s|d)?|edit(?:s|ed)?|modif(?:y|ies|ied)|rename\b/i,
      upload: /\bupload(?:s|ed|ing)?\b/i,
      share: /\bshare(?:s|d)?|invite(?:s|d)?\b/i,
      duplicate: /\bduplicat(?:e|es|ed)|clone|copy\b/i,
      restore: /\brestore(?:s|d)?|undo|recover\b/i,
      enable: /\benable(?:s|d)?|activat(?:e|es|ed)|turn on\b/i,
      disable: /\bdisable(?:s|d)?|deactivat(?:e|es|ed)|turn off\b/i,
      search: /\bsearch(?:es|ed)?|filter(?:s|ed)?|query\b/i,
      sort: /\bsort(?:s|ed)?|order by|reorder\b/i
    };
  }

  /** Role/actor names whose distinction changes the expected outcome. */
  static get ACTOR_CUES() {
    return /\b(admin(?:istrator)?s?|owner|viewer|editor|guest|anonymous|member|manager|superuser|non[- ]owner|unauthenticated|authenticated)\b/gi;
  }

  /** All numeric literals, with unit when one is attached (100kb ≠ 999kb). */
  static numericSignature(text) {
    const out = new Set();
    const re = /(\d+(?:[.,]\d+)?)\s*(kb|mb|gb|bytes?|ms|s|sec(?:onds?)?|min(?:utes?)?|hours?|days?|%|characters?|chars?|items?|rows?|users?|files?)?/gi;
    let m;
    while ((m = re.exec(String(text || ''))) !== null) {
      out.add(`${m[1].replace(',', '')}${(m[2] || '').toLowerCase()}`);
    }
    return out;
  }

  static opsIn(text) {
    const found = new Set();
    for (const [op, re] of Object.entries(SemanticDuplicateDetector.OPERATION_CUES)) {
      if (re.test(text)) found.add(op);
    }
    return found;
  }

  static setsIn(text, re) {
    return new Set((String(text || '').match(re) || []).map(v => v.toLowerCase().replace(/\s+/g, '-')));
  }

  /**
   * F05: is this pair PROVABLY distinct? Text similarity may only RETRIEVE
   * comparison candidates — it may never authorize a deletion on its own.
   * Returns a human-readable reason when the two cases test different things,
   * or null when nothing distinguishes them (i.e. a merge may be considered).
   *
   * Only asymmetric evidence counts: a dimension that is missing on either side
   * is UNKNOWN, never a match. Every rule here is one-directional — it can only
   * PREVENT a merge, so a false positive costs one redundant case, whereas the
   * false negative it replaces silently destroyed a distinct obligation.
   *
   * ponytail: lexical cues over titles/steps/results, not a parsed scenario
   * model. Upgrade path is the Scenario record in fix2.md §7.1 — this function
   * is the seam where that swaps in.
   */
  distinctionReason(a, b) {
    return SemanticDuplicateDetector.distinctionReason(a, b);
  }

  static distinctionReason(a, b) {
    if (!a || !b) return null;
    const textOf = (t) => [t.title, t.description, t.expected_result, t.test_data, t.testData,
      ...(Array.isArray(t.steps) ? t.steps : [])].filter(Boolean).join(' ');
    const ta = textOf(a), tb = textOf(b);
    // The assertion, separately: polarity belongs to the claimed outcome.
    const oa = [a.title, a.expected_result || a.expectedResult].filter(Boolean).join(' ');
    const ob = [b.title, b.expected_result || b.expectedResult].filter(Boolean).join(' ');

    // 1. Polarity — allow vs deny is never the same test.
    const NEG = /\b(cannot|can't|must not|should not|shouldn't|is not|are not|does not|doesn't|never|unable|denied|deny|denies|forbidden|prohibited|rejected|blocked|prevented|unauthoriz(?:ed)?|invalid|fails?|failure|error|403|401)\b/i;
    const pa = NEG.test(oa), pb = NEG.test(ob);
    if (oa && ob && pa !== pb) {
      return `opposite expected outcomes (${pa ? 'denied' : 'allowed'} vs ${pb ? 'denied' : 'allowed'})`;
    }

    // 2. Operation — export ≠ archive, create ≠ update, enable ≠ disable.
    const opsA = SemanticDuplicateDetector.opsIn(ta), opsB = SemanticDuplicateDetector.opsIn(tb);
    if (opsA.size && opsB.size) {
      const shared = [...opsA].filter(o => opsB.has(o));
      if (shared.length === 0) {
        return `different operations (${[...opsA].join('/')} vs ${[...opsB].join('/')})`;
      }
    }

    // 3. Actor / role — owner ≠ non-owner, viewer ≠ admin.
    const acA = SemanticDuplicateDetector.setsIn(ta, SemanticDuplicateDetector.ACTOR_CUES);
    const acB = SemanticDuplicateDetector.setsIn(tb, SemanticDuplicateDetector.ACTOR_CUES);
    if (acA.size && acB.size && ![...acA].some(r => acB.has(r))) {
      return `different actors (${[...acA].join('/')} vs ${[...acB].join('/')})`;
    }

    // 4. Boundary / input partition — 100KB, 100KB−1 and 999KB are three
    //    obligations even when their titles are byte-identical.
    const nA = SemanticDuplicateDetector.numericSignature(ta);
    const nB = SemanticDuplicateDetector.numericSignature(tb);
    if (nA.size && nB.size) {
      const same = [...nA].every(v => nB.has(v)) && [...nB].every(v => nA.has(v));
      if (!same) return `different input values / boundary positions (${[...nA].join(',')} vs ${[...nB].join(',')})`;
    }

    return null;
  }

  // ========== SCENARIO CLASSIFICATION (F05 §7.3) ==========


  /**
   * F05 §7.3: classify a PAIR rather than answering a yes/no "duplicate?".
   *
   * A single similarity number forces every pair into merge-or-keep, so the
   * genuinely uncertain ones were resolved by whichever side of the threshold
   * they fell — silently, and in the deleting direction. The classes are:
   *
   *   exact_duplicate   identical content fingerprint; safe to collapse
   *   equivalent        same scenario, different words; safe to collapse
   *   parameter_variant same obligation, different sample data; parameterisable
   *   overlapping       shares steps but asserts something additional; KEEP both
   *   contradictory     opposite expected outcomes; KEEP both, and flag
   *   distinct          provably different obligation; KEEP both
   *   uncertain         cannot tell; KEEP both and mark for review
   *
   * Only exact_duplicate and equivalent may be auto-collapsed. Everything else
   * is retained, which is the asymmetry that matters: a redundant case costs a
   * few minutes, a deleted obligation costs the coverage it was the only proof of.
   */
  static classifyPair(a, b, opts = {}) {
    const threshold = opts.threshold ?? 0.75;
    if (!a || !b) return { relation: 'uncertain', reason: 'missing candidate', merge: false };

    // 1. Exact content fingerprint — ids and cosmetic wording are not identity.
    const fa = SemanticDuplicateDetector.contentFingerprint(a);
    const fb = SemanticDuplicateDetector.contentFingerprint(b);
    if (fa && fa === fb) {
      return { relation: 'exact_duplicate', reason: 'identical normalized content', merge: true, similarity: 1 };
    }

    // 2. Hard distinctions veto any merge, whatever the text similarity says.
    const distinct = SemanticDuplicateDetector.distinctionReason(a, b);
    if (distinct) {
      // Order matters. Differing INPUTS legitimately produce differing outcomes —
      // "100 KB is accepted" and "101 KB is rejected" is a boundary pair, not a
      // contradiction. A contradiction is opposite outcomes for the SAME input,
      // so the numeric check is consulted first.
      const nA = SemanticDuplicateDetector.numericSignature(SemanticDuplicateDetector.textOf(a));
      const nB = SemanticDuplicateDetector.numericSignature(SemanticDuplicateDetector.textOf(b));
      const differentInputs = nA.size && nB.size &&
        (![...nA].every(v => nB.has(v)) || ![...nB].every(v => nA.has(v)));

      const relation = differentInputs ? 'parameter_variant'
        : (/opposite expected outcomes/.test(distinct) ? 'contradictory' : 'distinct');

      return {
        relation,
        reason: distinct,
        // A parameter_variant is NOT auto-merged: below-limit, at-limit and
        // above-limit are three obligations that happen to look alike.
        merge: false
      };
    }

    // §7.3: ONE similarity number for the incremental gate and the batch detector.
    // The caller passes the score it already computed; recomputing here with the
    // detector's own blend gave two different answers for the same pair, so a
    // case the gate saw as a duplicate could be classed 'distinct' and kept.
    let sim = typeof opts.similarity === 'number' ? opts.similarity : null;
    if (sim === null) {
      const det = opts.detector || new SemanticDuplicateDetector(threshold);
      const groups = det.detectDuplicates([a, b]) || [];
      sim = groups.length && groups[0].similarities && groups[0].similarities[0]
        ? groups[0].similarities[0].combinedSimilarity
        : (0.5 * safeNum(() => det.calculateSemanticSimilarity(a, b)) +
           0.5 * safeNum(() => det.calculateLexicalSimilarity(a, b)));
    }

    if (sim >= threshold) {
      // 3. Same scenario? Only when both sides actually described one. Two
      //    title-only cases scoring high is thin evidence, not equivalence.
      const described = (t) => (Array.isArray(t.steps) && t.steps.length > 0) &&
        !!(t.expected_result || t.expectedResult);

      // Positive evidence of the same subject, not merely a high score. Without
      // this, two fully-described but unrelated cases merged on wording alone.
      const subject = SemanticDuplicateDetector.subjectOverlap(a, b);
      // ponytail: threshold calibrated on the observed separation between true
      // paraphrases and the false merges found on real ticket data — it is a
      // heuristic, not a measured optimum. The failure direction is deliberately
      // safe: below it, both cases are KEPT and flagged, so a mis-set threshold
      // costs a redundant case rather than a deleted obligation. fix2.md §9's
      // labelled corpus is what would calibrate this properly.
      const MIN_SUBJECT_OVERLAP = opts.minSubjectOverlap ?? 0.18;

      if (described(a) && described(b) && subject >= MIN_SUBJECT_OVERLAP) {
        return {
          relation: 'equivalent',
          reason: `same scenario (similarity ${sim.toFixed(2)}, subject overlap ${subject.toFixed(2)})`,
          merge: true, similarity: sim
        };
      }
      if (described(a) && described(b)) {
        // Scores alike, but they are about different things — keep both and say so.
        return {
          relation: 'overlapping',
          reason: `similar wording (${sim.toFixed(2)}) but different subjects (overlap ${subject.toFixed(2)}) — both retained`,
          merge: false, similarity: sim
        };
      }
      return {
        relation: 'uncertain',
        reason: `similar (${sim.toFixed(2)}) but one or both cases are too thin to compare — retained for review`,
        merge: false, similarity: sim
      };
    }

    // 4. Below threshold but sharing an operation + subject: overlapping work,
    //    not a duplicate. Worth surfacing so a reviewer can consolidate by hand.
    const opsA = SemanticDuplicateDetector.opsIn(SemanticDuplicateDetector.textOf(a));
    const opsB = SemanticDuplicateDetector.opsIn(SemanticDuplicateDetector.textOf(b));
    const sharedOps = [...opsA].filter(o => opsB.has(o));
    if (sim >= threshold * 0.8 && sharedOps.length) {
      return { relation: 'overlapping', reason: `shares the ${sharedOps.join('/')} operation`, merge: false, similarity: sim };
    }

    return { relation: 'distinct', reason: 'no meaningful overlap', merge: false, similarity: sim };
  }

  /**
   * Do these two cases talk about the SAME SUBJECT?
   *
   * Every hard distinction check requires BOTH sides to carry the signal — an
   * operation, a number, an actor. When neither does, all of them skip and the
   * similarity score decides alone, which is the thing F05 exists to prevent.
   * On real data that merged "Full chat name visible on hover" into "Chat list
   * paginates after 20 sessions" at 0.69: two unrelated obligations, one deleted.
   *
   * So `equivalent` now needs POSITIVE evidence of sameness rather than absence
   * of proof of difference. Two cases testing the same behaviour share their
   * distinctive nouns and verbs; two unrelated ones do not.
   */
  static SUBJECT_STOPWORDS = new Set([
    'the','a','an','and','or','but','if','then','when','while','for','of','to','in','on','at','by',
    'with','from','as','is','are','be','been','was','were','will','would','should','shall','can',
    'could','may','might','must','that','this','these','those','it','its','their','they','user',
    'users','able','ensure','system','not','all','any','each','via','into','onto','click','clicks',
    'open','opens','see','sees','show','shows','shown','display','displays','displayed','verify',
    'check','page','list','item','items','test','case','given','then','and','step','steps','http',
    'https','com','example','api','www'
  ]);

  /**
   * Crude stem so login/logs and successful/successfully compare equal.
   * Applied until it converges: a single pass turned "successfully" into
   * "successful" and "successful" into "success", so the two never matched.
   */
  static stem(w) {
    let out = String(w);
    for (let i = 0; i < 3; i++) {
      const before = out;
      out = out
        .replace(/(ically|ingly|edly)$/, '')
        .replace(/(ations?|ising|izing|ised|ized)$/, 'ise')
        .replace(/(ness|ment|ion|ful|ly)$/, '')
        .replace(/(ing|ed|es|s)$/, '');
      if (out === before || out.length <= 3) break;
    }
    // Drop a trailing silent 'e' so paginate/paginates and delete/deletes agree
    // ("paginates" loses "es" to give "paginat", which must match "paginate").
    if (out.length > 4) out = out.replace(/e$/, '');
    return out;
  }

  static subjectTokens(t) {
    const text = [t.title, t.expected_result || t.expectedResult].filter(Boolean).join(' ').toLowerCase();
    const words = text.match(/[a-z][a-z0-9-]{2,}/g) || [];
    return new Set(
      words.filter(w => !SemanticDuplicateDetector.SUBJECT_STOPWORDS.has(w))
           .map(w => SemanticDuplicateDetector.stem(w))
           .filter(w => w.length > 2)
    );
  }

  /** Jaccard over distinctive subject words, in [0,1]. */
  static subjectOverlap(a, b) {
    const sa = SemanticDuplicateDetector.subjectTokens(a);
    const sb = SemanticDuplicateDetector.subjectTokens(b);
    if (!sa.size || !sb.size) return 0; // nothing to compare is not sameness
    let shared = 0;
    for (const w of sa) if (sb.has(w)) shared++;
    return shared / (sa.size + sb.size - shared);
  }

  /** Normalized content fingerprint: scenario identity, not id or wording order. */
  static contentFingerprint(t) {
    if (!t) return '';
    const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const steps = (Array.isArray(t.steps) ? t.steps : [])
      .map(s => norm(typeof s === 'string' ? s : (s && (s.action || s.step || s.text)) || ''))
      .filter(Boolean);
    const parts = [
      norm(t.title),
      norm(t.expected_result || t.expectedResult),
      norm(t.test_data || t.testData),
      steps.join('|')
    ];
    return parts.join('::');
  }

  static textOf(t) {
    return [t.title, t.description, t.expected_result || t.expectedResult, t.test_data || t.testData,
      ...(Array.isArray(t.steps) ? t.steps : [])].filter(Boolean).join(' ');
  }

  /**
   * F05 §7.3 step 7: recheck survivors GLOBALLY, without assuming transitivity.
   * A≈B and B≈C does not prove A≈C, so each candidate is compared against every
   * retained case rather than against a group representative.
   *
   * @returns {{kept: Array, merged: Array, review: Array}}
   */
  static consolidate(testCases, opts = {}) {
    const list = Array.isArray(testCases) ? testCases : [];
    const det = opts.detector || new SemanticDuplicateDetector(opts.threshold ?? 0.75);
    const kept = [], merged = [], review = [];

    for (const candidate of list) {
      let mergedInto = null;
      for (const existing of kept) {
        const verdict = SemanticDuplicateDetector.classifyPair(candidate, existing, { ...opts, detector: det });
        if (verdict.merge) { mergedInto = { existing, verdict }; break; }
        if (verdict.relation === 'uncertain' || verdict.relation === 'contradictory' || verdict.relation === 'overlapping') {
          review.push({
            a: candidate.title, b: existing.title,
            relation: verdict.relation, reason: verdict.reason, similarity: verdict.similarity
          });
        }
      }
      if (mergedInto) {
        merged.push({
          title: candidate.title, into: mergedInto.existing.title,
          relation: mergedInto.verdict.relation, reason: mergedInto.verdict.reason
        });
        // Preserve provenance: the survivor now covers both cases' requirements.
        const ids = new Set([...(mergedInto.existing.requirementIds || []), ...(candidate.requirementIds || [])]);
        if (ids.size) mergedInto.existing.requirementIds = [...ids];
      } else {
        kept.push(candidate);
      }
    }
    return { kept, merged, review };
  }

  // ========== HEURISTIC SEMANTIC FEATURES (secondary signal) ==========

  /**
   * Calculate semantic similarity using heuristic feature extraction
   */
  calculateSemanticSimilarity(test1, test2) {
    const features1 = this.extractSemanticFeatures(test1);
    const features2 = this.extractSemanticFeatures(test2);

    // F05: MISSING information is not agreement. Two tests with no steps used to
    // score actions 1.0, and two with all-false outcome flags scored outcomes
    // 1.0 — so the LESS a pair said, the more identical it looked ("Update
    // billing address" vs "Delete saved card" reached 0.85 that way). A dimension
    // neither side describes is dropped from the average and its weight
    // redistributed, so similarity is only ever computed over real evidence.
    const intentSim = this.compareIntents(features1.intent, features2.intent);
    const dims = [
      { w: 0.4, v: intentSim ?? 0, known: intentSim !== null },
      {
        w: 0.3, v: this.compareEntities(features1.entities, features2.entities),
        known: !!(features1.entities.fields.length + features1.entities.buttons.length + features1.entities.apis.length)
            && !!(features2.entities.fields.length + features2.entities.buttons.length + features2.entities.apis.length)
      },
      {
        w: 0.2, v: this.compareActions(features1.actions, features2.actions),
        known: features1.actions.length > 0 && features2.actions.length > 0
      },
      {
        w: 0.1, v: this.compareOutcomes(features1.outcome, features2.outcome),
        known: Object.values(features1.outcome).some(Boolean) && Object.values(features2.outcome).some(Boolean)
      }
    ];
    const known = dims.filter(d => d.known);
    if (!known.length) return 0; // nothing observable — assume nothing
    const totalW = known.reduce((sum, d) => sum + d.w, 0);
    return known.reduce((sum, d) => sum + d.v * d.w, 0) / totalW;
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

  /**
   * F05: only compare what was actually OBSERVED. `type:'unknown'` (no category),
   * `polarity:'neutral'` (undetermined) and `scenario:'standard'` (the default)
   * are absences, not features — crediting them for "matching" scored two
   * title-only, entirely unrelated cases a perfect 1.0 intent similarity.
   * Returns null when no sub-dimension is comparable.
   * @returns {number|null}
   */
  compareIntents(intent1, intent2) {
    const dims = [
      { w: 0.5, known: intent1.type !== 'unknown' && intent2.type !== 'unknown', hit: intent1.type === intent2.type },
      { w: 0.3, known: intent1.polarity !== 'neutral' && intent2.polarity !== 'neutral', hit: intent1.polarity === intent2.polarity },
      // 'standard' on both sides means neither test said anything about scenario.
      { w: 0.2, known: !(intent1.scenario === 'standard' && intent2.scenario === 'standard'), hit: intent1.scenario === intent2.scenario }
    ].filter(d => d.known);
    if (!dims.length) return null;
    const totalW = dims.reduce((sum, d) => sum + d.w, 0);
    return dims.reduce((sum, d) => sum + (d.hit ? d.w : 0), 0) / totalW;
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

  /**
   * Quality score used to pick the survivor among near-duplicates.
   *
   * v13.2: rebalanced to reward STRUCTURE and SPECIFICITY, not raw length.
   * The previous version summed character counts (description.length/10, etc.),
   * which systematically kept the most verbose duplicate and discarded the
   * concise, clearer one. Length now contributes only a small, capped "is it
   * fleshed out at all" signal; the real weight is on concrete, executable
   * structure (distinct steps, observable result, test data) and specificity
   * (presence of identifiers/values rather than vague prose).
   */
  getTestQualityScore(test) {
    let score = 0;

    // Structure: number of distinct, non-trivial steps (capped so a test
    // padded with extra steps can't beat a tight one on volume alone).
    if (Array.isArray(test.steps)) {
      const meaningfulSteps = test.steps
        .map(s => String(s || '').trim())
        .filter(s => s.length > 3);
      score += Math.min(meaningfulSteps.length, 8) * 4; // up to 32
    }

    // Has the essentials of an executable test.
    if (test.expected_result && String(test.expected_result).trim().length > 5) score += 12;
    if (test.test_data && String(test.test_data).trim()) score += 8;
    if (test.preconditions && String(test.preconditions).trim()) score += 4;
    if (test.description && String(test.description).trim().length > 10) score += 4;

    // Specificity: concrete signals (identifiers, numbers, quoted values,
    // selectors, endpoints) beat vague prose. This is what we actually want
    // to preserve when two tests say the same thing.
    score += Math.min(this.specificitySignals(test), 6) * 3; // up to 18

    // Priority of the scenario itself.
    if (test.priority === 'P0') score += 15;
    else if (test.priority === 'P1') score += 10;
    else if (test.priority === 'P2') score += 5;

    return score;
  }

  /** Count concrete-specificity signals across the test's actionable text. */
  specificitySignals(test) {
    const text = [
      test.title, test.expected_result, test.test_data,
      ...(Array.isArray(test.steps) ? test.steps : [])
    ].filter(Boolean).join(' ');
    let n = 0;
    if (/["'][^"']+["']/.test(text)) n++;                 // quoted literal values
    if (/\b\d+\b/.test(text)) n++;                        // numbers / boundaries
    if (/[#.][a-z][\w-]+|\[[^\]]+\]|data-[\w-]+/i.test(text)) n++; // selectors/attrs
    if (/\/[a-z0-9][\w\/-]+/i.test(text)) n++;            // routes / endpoints
    if (/\b(GET|POST|PUT|PATCH|DELETE)\b/.test(text)) n++; // HTTP methods
    if (/\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i.test(text)) n++; // emails / sample data
    return n;
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
