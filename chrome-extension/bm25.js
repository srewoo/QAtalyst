/**
 * BM25 Index — probabilistic relevance scoring for the knowledge graph
 *
 * Replaces the manual URL/title/description point system in graph-filter.js.
 * Built lazily on first query per app, then persisted to IndexedDB so subsequent
 * queries skip the build step entirely.
 *
 * BM25 formula:
 *   score(q,d) = Σ  IDF(qi) × tf_norm(qi, d)
 *   IDF(qi)    = log((N − df + 0.5) / (df + 0.5) + 1)
 *   tf_norm    = tf × (k1 + 1) / (tf + k1 × (1 − b + b × |d| / avgdl))
 *
 * Parameters: k1 = 1.5 (saturation), b = 0.75 (length normalisation)
 */
class BM25Index {
  static K1 = 1.5;
  static B  = 0.75;

  static STOP_WORDS = new Set([
    'the','a','an','and','or','but','in','on','at','to','for','of','with',
    'by','from','as','is','was','are','were','be','been','have','has','had',
    'do','does','did','will','would','could','should','may','might','must',
    'can','this','that','these','those','it','its','we','our','you','your',
    'they','their','he','she','his','her','not','all','any','both','each',
    'few','more','most','other','some','such','than','too','very','just',
    'http','https','www','com','org','net','html','css','api','get','post',
    'put','delete','patch','true','false','null','undefined','new','return',
    'error','issue','bug','problem','fix','update','change','add','test','when',
    'after','before','while','though','even','also','only','then','than',
  ]);

  constructor() {
    this.N       = 0;   // total document count
    this.avgdl   = 1;   // average document length in tokens
    this.df      = {};  // term → number of documents containing it
    this.docs    = {};  // url → { len: number, tf: { term: count } }
    this.builtAt = null;
  }

  // ── Tokenisation ────────────────────────────────────────────────────────

  static tokenize(text) {
    if (!text || typeof text !== 'string') return [];
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 2 && !BM25Index.STOP_WORDS.has(t));
  }

  /**
   * Convert a crawled page object into a weighted token list.
   * Each field is repeated according to its relevance weight so that
   * BM25 term frequency naturally reflects field importance.
   *
   * Weights:
   *   URL path        ×3  — most predictive (user browsed here intentionally)
   *   Title           ×2  — primary topic of the page
   *   Description     ×2  — author-supplied summary
   *   Form fields     ×2  — interactive surface area matches feature names
   *   API endpoints   ×2  — backend contract names
   *   Text content    ×1  — broad context, long, already weighted by length
   */
  static pageToTokens(page) {
    const tokens = [];
    const url         = page.url || page.metadata?.url || '';
    const title       = page.title || page.metadata?.title || '';
    const description = page.description || page.metadata?.description || '';
    const text        = page.textContent || '';

    // URL path (×3)
    const path = url.replace(/https?:\/\/[^/]+/, '').replace(/[/\-_=?&#.]/g, ' ');
    for (let i = 0; i < 3; i++) tokens.push(...BM25Index.tokenize(path));

    // Title (×2)
    for (let i = 0; i < 2; i++) tokens.push(...BM25Index.tokenize(title));

    // Description (×2)
    for (let i = 0; i < 2; i++) tokens.push(...BM25Index.tokenize(description));

    // Text content (×1)
    tokens.push(...BM25Index.tokenize(text));

    // Form fields: action, field names, labels, placeholders (×2)
    const forms = page.forms || page.features?.filter(f => f.type === 'form') || [];
    for (const form of forms) {
      const fieldText = (form.fields || [])
        .map(f => `${f.name || ''} ${f.label || ''} ${f.placeholder || ''}`)
        .join(' ');
      const formText = `${form.action || ''} ${fieldText}`;
      for (let i = 0; i < 2; i++) tokens.push(...BM25Index.tokenize(formText));
    }

    // API endpoints (×2)
    const apis = page.apis || [];
    for (const api of apis) {
      const apiText = `${api.method || ''} ${api.url || api.endpoint || ''}`;
      for (let i = 0; i < 2; i++) tokens.push(...BM25Index.tokenize(apiText));
    }

    return tokens;
  }

  // ── Build ────────────────────────────────────────────────────────────────

  /**
   * Build a BM25 index from all pages in a knowledge graph.
   * @param {Array|Object} pages — array of page objects OR { url: page } map
   * @returns {BM25Index}
   */
  static build(pages) {
    const index = new BM25Index();
    const entries = Array.isArray(pages)
      ? pages.map(p => [p.url || p.metadata?.url, p])
      : Object.entries(pages);

    let totalLen = 0;
    for (const [url, page] of entries) {
      if (!url || !page) continue;
      const tokens = BM25Index.pageToTokens(page);
      if (tokens.length === 0) continue;

      const tf = {};
      for (const token of tokens) tf[token] = (tf[token] || 0) + 1;

      index.docs[url] = { len: tokens.length, tf };
      totalLen += tokens.length;

      for (const term of Object.keys(tf)) {
        index.df[term] = (index.df[term] || 0) + 1;
      }
    }

    index.N       = Object.keys(index.docs).length;
    index.avgdl   = index.N > 0 ? totalLen / index.N : 1;
    index.builtAt = Date.now();

    console.log(`[BM25] Built index: ${index.N} docs, ${Object.keys(index.df).length} unique terms, avgdl=${Math.round(index.avgdl)}`);
    return index;
  }

  // ── Scoring ──────────────────────────────────────────────────────────────

  idf(term) {
    const df = this.df[term] || 0;
    return Math.log((this.N - df + 0.5) / (df + 0.5) + 1);
  }

  scoreDoc(url, queryTerms) {
    const doc = this.docs[url];
    if (!doc) return 0;
    const { len, tf } = doc;
    const k1 = BM25Index.K1;
    const b  = BM25Index.B;
    let score = 0;
    for (const term of queryTerms) {
      const termTf = tf[term] || 0;
      if (termTf === 0) continue;
      const idf     = this.idf(term);
      const tfNorm  = (termTf * (k1 + 1)) / (termTf + k1 * (1 - b + b * (len / this.avgdl)));
      score += idf * tfNorm;
    }
    return score;
  }

  /**
   * Return the topK most relevant pages for a free-text query.
   * Only evaluates pages that share at least one query term with the query
   * (candidate pre-filtering), so performance scales with query specificity,
   * not with total corpus size.
   *
   * @param {string} queryText
   * @param {number} topK
   * @returns {Array<{url: string, score: number}>}
   */
  search(queryText, topK = 30) {
    const queryTerms = BM25Index.tokenize(queryText);
    if (queryTerms.length === 0) return [];

    // Pre-filter: only score docs that contain ≥1 query term
    const candidateUrls = new Set();
    for (const term of queryTerms) {
      if (!this.df[term]) continue;
      for (const url of Object.keys(this.docs)) {
        if (this.docs[url].tf[term]) candidateUrls.add(url);
      }
    }

    const results = [];
    for (const url of candidateUrls) {
      const s = this.scoreDoc(url, queryTerms);
      if (s > 0) results.push({ url, score: s });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  // ── Serialise / Deserialise ──────────────────────────────────────────────

  serialize() {
    return {
      N:       this.N,
      avgdl:   this.avgdl,
      df:      this.df,
      docs:    this.docs,
      builtAt: this.builtAt,
    };
  }

  static deserialize(data) {
    const index = new BM25Index();
    Object.assign(index, data);
    return index;
  }
}

if (typeof globalThis !== 'undefined') globalThis.BM25Index = BM25Index;
if (typeof window    !== 'undefined') window.BM25Index    = BM25Index;
