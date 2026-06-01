/**
 * Agent Tool Registry
 *
 * Turns QAtalyst's existing capabilities (crawler, BM25, integrations, coverage
 * mapper, Jira search, LLM generation) into a set of discrete tools that the
 * planner agent can call on demand. This is what converts the old fixed
 * "crawl → analyze → generate → review" pipeline into an observe→decide→act loop:
 * the crawler/BM25/integrations are no longer mandatory pre-steps, they're tools
 * the agent reaches for when it decides it needs them.
 *
 * Every tool:
 *   - takes a single JSON `input` object,
 *   - returns a JSON-serializable `observation` (never throws to the caller),
 *   - degrades gracefully when its backing capability is unavailable.
 *
 * Dependencies are injected via the context object so the registry is testable
 * without a live service worker.
 *
 * Version: 1.0.0
 */

class AgentToolRegistry {
  /**
   * @param {object} ctx
   * @param {Function} ctx.callAI          async (system, userContent[], settings) => string
   * @param {object}   ctx.settings
   * @param {object}   ctx.ticketData
   * @param {object}   [ctx.knowledgeGraph]
   * @param {object}   [ctx.bm25]           BM25Index instance (already built)
   * @param {object}   [ctx.coverageMapper] CoverageMapper instance
   * @param {Function} [ctx.jiraSearch]     async (jql) => issues[]
   * @param {Function} [ctx.confluenceFetch]async (url) => text
   * @param {Function} [ctx.crawlRoute]     async (url) => pageFeatures
   * @param {Function} [ctx.inspectLive]    async (selector) => {exists, count}  (live DOM probe)
   * @param {object}   [ctx.verifierIndex]  GroundedVerifier index (real entity sets)
   */
  constructor(ctx = {}) {
    this.ctx = ctx;
    this.callCount = {};
    this.lastError = null; // {tool, error} — surfaced so the host can report why generation failed
  }

  /** Tool catalogue surfaced to the planner. Keep descriptions tight — they go in the prompt. */
  getToolSpecs() {
    return [
      { name: 'bm25_search', description: 'Find the most relevant crawled pages/features for a query. input: {query, topK?}' },
      { name: 'inspect_element', description: 'Check whether a selector / field / button actually exists in the app. input: {selector?, field?, button?}' },
      { name: 'run_coverage_check', description: 'Map accepted tests against real app features and return coverage % + the biggest untested gaps. input: {}' },
      { name: 'propose_tests', description: 'Generate candidate test cases for a category, optionally focused on a specific feature/gap. They will be auto-verified, dedup-checked and relevance-gated before acceptance. input: {category, count, focus?}' },
      { name: 'query_jira', description: 'Search Jira for related/historical issues (e.g. past bugs) to ground regression tests. input: {jql}' },
      { name: 'fetch_confluence', description: 'Fetch a Confluence/doc page for extra requirement context. input: {url}' },
      { name: 'crawl_route', description: 'Crawl one additional route to discover features the initial crawl missed (use when coverage gaps point to an un-crawled area). input: {url}' },
      { name: 'finish', description: 'Stop: enough grounded, non-duplicate coverage has been produced. input: {reason}' }
    ];
  }

  /** Dispatch a tool call. Never throws — returns {error} observation on failure. */
  async execute(name, input = {}) {
    this.callCount[name] = (this.callCount[name] || 0) + 1;
    try {
      switch (name) {
        case 'bm25_search':       return await this.bm25_search(input);
        case 'inspect_element':   return await this.inspect_element(input);
        case 'run_coverage_check':return await this.run_coverage_check(input);
        case 'propose_tests':     return await this.propose_tests(input);
        case 'query_jira':        return await this.query_jira(input);
        case 'fetch_confluence':  return await this.fetch_confluence(input);
        case 'crawl_route':       return await this.crawl_route(input);
        case 'finish':            return { finished: true, reason: input.reason || 'done' };
        default:                  return { error: `Unknown tool: ${name}` };
      }
    } catch (e) {
      const error = e?.message || String(e);
      this.lastError = { tool: name, error };
      return { error, tool: name };
    }
  }

  // ───────────────────────── tools ─────────────────────────

  async bm25_search({ query, topK = 8 }) {
    if (!query) return { error: 'query required' };
    const kg = this.ctx.knowledgeGraph;
    if (this.ctx.bm25 && typeof this.ctx.bm25.search === 'function') {
      const hits = this.ctx.bm25.search(query, topK);
      const pages = this.resolvePages(hits.map(h => h.url));
      return { matches: hits.map((h, i) => ({ url: h.url, score: round2(h.score), summary: summarizePage(pages[i]) })) };
    }
    // Fallback: keyword scan over KG pages
    const pages = pagesOf(kg);
    if (!pages.length) return { matches: [], note: 'no crawl data available' };
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const scored = pages.map(p => {
      const blob = (p.url + ' ' + (p.title || '') + ' ' + JSON.stringify(p.features || '')).toLowerCase();
      return { url: p.url, score: terms.reduce((s, t) => s + (blob.includes(t) ? 1 : 0), 0), page: p };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, topK);
    return { matches: scored.map(s => ({ url: s.url, score: s.score, summary: summarizePage(s.page) })) };
  }

  async inspect_element({ selector, field, button }) {
    const idx = this.ctx.verifierIndex;
    const result = { selector: null, field: null, button: null };

    if (selector) {
      let exists = idx ? (idx.selectors.has(selector) || [...idx.selectors].some(s => s.includes(selector))) : false;
      // Prefer a live DOM probe when available (ground truth).
      if (this.ctx.inspectLive) {
        const live = await safeAsync(() => this.ctx.inspectLive(selector), null);
        if (live) exists = !!live.exists;
        result.selector = { selector, exists, live: !!live, count: live?.count };
      } else {
        result.selector = { selector, exists, live: false };
      }
    }
    if (field && idx) result.field = { field, exists: idx.fields.has(String(field).toLowerCase()) };
    if (button && idx) result.button = { button, exists: idx.buttons.has(String(button).toLowerCase()) };
    return result;
  }

  async run_coverage_check() {
    const cm = this.ctx.coverageMapper;
    const accepted = this.ctx.getAcceptedTests ? this.ctx.getAcceptedTests() : [];
    if (!cm) return { applicable: false, note: 'no knowledge graph — coverage cannot be measured', acceptedCount: accepted.length };
    const coverage = cm.mapCoverage(accepted);
    const gaps = cm.identifyGaps(coverage);
    return {
      applicable: true,
      coveragePercent: coverage.overall.coveragePercentage,
      forms: `${coverage.forms.covered}/${coverage.forms.total}`,
      apis: `${coverage.apis.covered}/${coverage.apis.total}`,
      buttons: `${coverage.buttons.covered}/${coverage.buttons.total}`,
      criticalGaps: gaps.critical.slice(0, 8),
      importantGaps: gaps.important.slice(0, 6),
      summary: gaps.summary
    };
  }

  /**
   * Generate candidate tests for a category, grounded in the real app entities so
   * they reference selectors/fields/buttons that actually exist (maximizing the
   * downstream grounding pass-rate). Returns RAW candidates — the planner runs them
   * through the acceptance gate.
   */
  async propose_tests({ category = 'Positive', count = 5, focus = '' }) {
    count = Math.max(1, Math.min(12, count | 0 || 5));
    const ground = this.groundingContext();
    const ticket = this.ctx.ticketData || {};
    const system = [
      'You are a meticulous QA engineer generating GROUNDED, executable test cases.',
      'RULES:',
      '- Reference ONLY UI elements, fields, buttons, routes and APIs that appear in the "REAL APP ENTITIES" list. Never invent selectors or fields.',
      '- Each test must be specific and independently executable. No vague verbs ("verify it works").',
      '- Steps must be concrete actions; expected_result must be observable.',
      `- Generate exactly ${count} ${category} test cases focused on: ${focus || 'the ticket as a whole'}.`,
      'Return ONLY a JSON array of objects: {title, category, priority(P0-P3), preconditions, steps[], expected_result, test_data}.'
    ].join('\n');

    const user = [
      `TICKET: ${ticket.summary || ticket.title || ''}`,
      ticket.description ? `DESCRIPTION:\n${String(ticket.description).slice(0, 2500)}` : '',
      (ticket.acceptanceCriteria || ticket.acceptance_criteria) ? `ACCEPTANCE CRITERIA:\n${String(ticket.acceptanceCriteria || ticket.acceptance_criteria).slice(0, 1500)}` : '',
      '',
      'REAL APP ENTITIES (use these — do not invent others):',
      ground,
      '',
      `Now produce ${count} ${category} tests focused on: ${focus || 'core behaviour'}.`
    ].filter(Boolean).join('\n');

    const resp = await this.ctx.callAI(system, [{ type: 'text', text: user }], this.ctx.settings);
    const tests = parseTestArray(resp);
    tests.forEach((t, i) => {
      t.category = t.category || category;
      t._proposedFor = { category, focus };
      t.id = t.id || `TC-${category.slice(0, 3).toUpperCase()}-${Date.now() % 100000}-${i}`;
    });
    return { category, focus, generated: tests.length, tests };
  }

  async query_jira({ jql }) {
    if (!jql) return { error: 'jql required' };
    if (!this.ctx.jiraSearch) return { available: false, note: 'Jira search not configured', issues: [] };
    const issues = await safeAsync(() => this.ctx.jiraSearch(jql), []);
    return { count: (issues || []).length, issues: (issues || []).slice(0, 10) };
  }

  async fetch_confluence({ url }) {
    if (!url) return { error: 'url required' };
    if (!this.ctx.confluenceFetch) return { available: false, note: 'Confluence integration not configured' };
    const text = await safeAsync(() => this.ctx.confluenceFetch(url), '');
    return { url, length: (text || '').length, excerpt: (text || '').slice(0, 1500) };
  }

  async crawl_route({ url }) {
    if (!url) return { error: 'url required' };
    if (!this.ctx.crawlRoute) return { available: false, note: 'crawl_route not wired (no tab context)' };
    const features = await safeAsync(() => this.ctx.crawlRoute(url), null);
    if (!features) return { url, crawled: false };
    // Let the host merge into the KG; report what was found.
    return {
      url, crawled: true,
      forms: (features.forms || []).length,
      buttons: (features.buttons || features.features || []).length,
      apis: (features.apis || []).length
    };
  }

  // ───────────────────────── helpers ─────────────────────────

  /** Compact, token-bounded list of real app entities for grounding generation. */
  groundingContext() {
    const idx = this.ctx.verifierIndex;
    if (!idx || idx.empty) return '(no crawl data — generate from the ticket text only, keep references generic)';
    const fields = [...idx.fields].slice(0, 40);
    const buttons = [...idx.buttons].slice(0, 30);
    const routes = [...idx.routes].slice(0, 25);
    const apis = (idx.apis || []).slice(0, 25).map(a => `${a.method} ${a.endpoint || a.url}`);
    return [
      `Fields: ${fields.join(', ') || '(none)'}`,
      `Buttons/actions: ${buttons.join(', ') || '(none)'}`,
      `Routes: ${routes.join(', ') || '(none)'}`,
      `APIs: ${apis.join('; ') || '(none)'}`
    ].join('\n');
  }

  resolvePages(urls) {
    const kg = this.ctx.knowledgeGraph;
    const pages = pagesOf(kg);
    return urls.map(u => pages.find(p => p.url === u) || { url: u });
  }
}

// ───────────────────────── module helpers ─────────────────────────

function pagesOf(kg) {
  if (!kg) return [];
  if (Array.isArray(kg.pages)) return kg.pages;
  if (kg.pages && typeof kg.pages === 'object') {
    return Object.keys(kg.pages).map(url => ({ url, ...kg.pages[url] }));
  }
  return [];
}

function summarizePage(page) {
  if (!page) return '';
  const feats = Array.isArray(page.features) ? page.features : [];
  const forms = feats.filter(f => f.type === 'form').length;
  const buttons = feats.filter(f => f.type === 'button').length;
  return `${page.title || page.url} — ${forms} form(s), ${buttons} button(s)`;
}

function parseTestArray(resp) {
  if (!resp || typeof resp !== 'string') return [];
  // Prefer the host's robust parser if present.
  if (typeof self !== 'undefined' && typeof self.parseRobustJSON === 'function') {
    const v = safeSync(() => self.parseRobustJSON(resp), null);
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v.tests)) return v.tests;
    if (v && Array.isArray(v.testCases)) return v.testCases;
  }
  // Fallback: grab the first JSON array in the text.
  const m = resp.match(/\[[\s\S]*\]/);
  if (m) { const v = safeSync(() => JSON.parse(m[0]), null); if (Array.isArray(v)) return v; }
  const obj = resp.match(/\{[\s\S]*\}/);
  if (obj) { const v = safeSync(() => JSON.parse(obj[0]), null); if (v && Array.isArray(v.tests)) return v.tests; }
  return [];
}

function round2(n) { return Math.round((n || 0) * 100) / 100; }
function safeSync(fn, fb) { try { return fn(); } catch (_) { return fb; } }
async function safeAsync(fn, fb) { try { return await fn(); } catch (_) { return fb; } }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AgentToolRegistry, parseTestArray, pagesOf };
}
if (typeof self !== 'undefined') {
  self.AgentToolRegistry = AgentToolRegistry;
}
