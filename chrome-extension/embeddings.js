/**
 * Free, offline, deterministic embeddings (v1.0.0).
 *
 * Manifest V3 service workers run under a strict CSP (`script-src 'self'
 * 'wasm-unsafe-eval'`) and must work with NO network, NO model download, NO npm
 * runtime deps. A neural sentence-encoder is therefore off the table. Instead we
 * build a real embedding the deterministic way: a fixed-dimension dense vector
 * produced by FEATURE-HASHING the text's features into DIM buckets, TF-weighted,
 * then L2-normalized. Cosine of two such vectors is the similarity.
 *
 * Features per text are:
 *   (a) CONCEPT tokens from text-similarity.js (`canonicalTokens`), which already
 *       cluster synonyms (signin→login, btn→button, authenticate→login). This is
 *       what gives us *semantic* (not merely lexical) matching: two texts that
 *       mean the same thing share concept buckets even with no shared surface word.
 *   (b) character 3-grams of each concept token, for morphology / typo robustness
 *       (so "passwrd" still lands near "password").
 *
 * Each feature is hashed (FNV-1a) to a bucket in [0, DIM) and accumulated with
 * its TF weight; concept tokens are weighted more heavily than char-grams so
 * meaning dominates morphology. The result is L2-normalized so cosine == dot.
 *
 * Wrapped in an IIFE — the service worker importScripts everything into ONE
 * shared scope, so a stray top-level `const DIM`/`function embed` would collide
 * with another file and crash the worker at load. We expose only via
 * `self.Embeddings` + `module.exports`.
 */
(function () {
  // Shared concept-normalisation primitives. Resolved exactly like acceptance-gate.js.
  const TS = (typeof TextSimilarity !== 'undefined' && TextSimilarity)
    || (typeof self !== 'undefined' && self.TextSimilarity)
    || (typeof require !== 'undefined' ? require('./text-similarity.js') : null);

  const DIM = 256;
  const CONCEPT_WEIGHT = 1.0;   // concept tokens carry meaning → dominate
  const NGRAM_WEIGHT = 0.35;    // char 3-grams add morphology/typo robustness
  const NGRAM_N = 3;

  /** FNV-1a 32-bit hash of a string → unsigned int. Deterministic, fast, no deps. */
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      // h *= 16777619, kept in 32-bit via Math.imul
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  /** Bucket index in [0, DIM) for a feature string, namespaced by kind. */
  function bucket(kind, feature) {
    return fnv1a(kind + ':' + feature) % DIM;
  }

  /** Character n-grams of a token (padded so short tokens still yield grams). */
  function charNgrams(token, n) {
    const padded = '^' + token + '$';
    const grams = [];
    if (padded.length <= n) {
      grams.push(padded);
      return grams;
    }
    for (let i = 0; i + n <= padded.length; i++) {
      grams.push(padded.slice(i, i + n));
    }
    return grams;
  }

  /** Concept tokens via TextSimilarity, with a defensive fallback. */
  function tokensOf(text) {
    if (!text) return [];
    if (TS && typeof TS.canonicalTokens === 'function') return TS.canonicalTokens(text);
    return String(text)
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2);
  }

  /**
   * Embed text → an L2-normalized Float32Array of length DIM. Empty/blank input
   * yields an all-zero vector (cosine with anything is then 0 by convention).
   */
  function embed(text) {
    const vec = new Float32Array(DIM);
    const tokens = tokensOf(text);
    if (tokens.length === 0) return vec;

    for (const tok of tokens) {
      // (a) concept token feature
      vec[bucket('c', tok)] += CONCEPT_WEIGHT;
      // (b) char 3-grams of the token
      const grams = charNgrams(tok, NGRAM_N);
      const gw = NGRAM_WEIGHT / Math.sqrt(grams.length || 1);
      for (const g of grams) vec[bucket('g', g)] += gw;
    }

    // L2-normalize so cosine reduces to a dot product and length doesn't bias.
    let norm = 0;
    for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < DIM; i++) vec[i] /= norm;
    }
    return vec;
  }

  /** Cosine similarity between two equal-length vectors (0..1 for non-negative vecs). */
  function cosine(vecA, vecB) {
    if (!vecA || !vecB) return 0;
    const n = Math.min(vecA.length, vecB.length);
    if (n === 0) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < n; i++) {
      const a = vecA[i], b = vecB[i];
      dot += a * b;
      na += a * a;
      nb += b * b;
    }
    if (na === 0 || nb === 0) return 0;
    const c = dot / (Math.sqrt(na) * Math.sqrt(nb));
    // Clamp tiny FP overshoot.
    return c < 0 ? 0 : (c > 1 ? 1 : c);
  }

  /** Convenience: cosine of the embeddings of two texts. */
  function similarity(textA, textB) {
    return cosine(embed(textA), embed(textB));
  }

  const Embeddings = { DIM, embed, cosine, similarity };

  if (typeof module !== 'undefined' && module.exports) module.exports = Embeddings;
  if (typeof self !== 'undefined') self.Embeddings = Embeddings;
})();
