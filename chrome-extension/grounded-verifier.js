/**
 * Grounded Verifier - validates generated test cases against the real application.
 *
 * Replaces the fake "genetic algorithm" fitness signal with a concrete grounding
 * check: for every concrete entity a test references (selector, form field, button
 * label, API endpoint, route), does that entity actually exist in the crawled
 * knowledge graph? Ungrounded references are the #1 source of "irrelevant" /
 * hallucinated test cases.
 *
 * Verdicts:
 *   - grounded     : all (or enough) concrete references exist → accept
 *   - needs_repair : some references are wrong but a close real match exists → repair
 *   - reject       : references concrete entities that don't exist and can't be mapped
 *
 * When no knowledge graph is available the verifier degrades gracefully: grounding
 * is "not applicable" and tests pass through (relevance is then enforced separately
 * by the BM25 relevance gate in the planner loop).
 *
 * Pure logic, no browser/network dependency → fully unit-testable under Vitest.
 *
 * Version: 1.0.0
 */

class GroundedVerifier {
  /**
   * @param {object} knowledgeGraph - crawl output. Tolerant of both shapes:
   *   (a) raw crawl: { pages: [ { url, title, features:[], apis:[] } ], ... }
   *   (b) aggregated: { pages: {url: {...}}, forms:[], apis:[], features:[] }
   * @param {object} [options]
   * @param {number} [options.minGroundingScore=0.5] accept threshold for grounded references
   * @param {number} [options.fuzzyThreshold=0.82] similarity needed to propose a repair
   * @param {boolean} [options.behaviorCheck=true] flag described backend behaviours
   *   (auto-sync, email, polling…) that have no supporting API in the crawl.
   * @param {boolean} [options.strictBehaviors=false] hard-reject on unsupported
   *   behaviours instead of just warning + applying a score penalty.
   * @param {number} [options.minApisForBehaviorCheck=3] only reason about missing
   *   backend mechanisms when we observed at least this many APIs (so an
   *   incomplete crawl doesn't false-reject real behaviour).
   */
  constructor(knowledgeGraph, options = {}) {
    this.knowledgeGraph = knowledgeGraph || null;
    this.minGroundingScore = options.minGroundingScore ?? 0.5;
    this.fuzzyThreshold = options.fuzzyThreshold ?? 0.82;
    this.behaviorCheck = options.behaviorCheck !== false;
    this.strictBehaviors = options.strictBehaviors === true;
    this.minApisForBehaviorCheck = options.minApisForBehaviorCheck ?? 3;
    this.index = this.buildIndex();
  }

  /**
   * Backend behaviours a test can ASSERT but that the crawler can only confirm
   * via an API. `re` detects the claim in the test text; `support` is what a
   * real implementation would look like across the app's API surface.
   */
  static get BEHAVIOR_PATTERNS() {
    return [
      { name: 'auto-sync / background sync', re: /\bauto[\s-]?sync|background sync|sync(?:s|ed)?\s+(?:automatically|every|in the background)\b/i, support: /sync|refresh|poll|fetch|update/i },
      { name: 'real-time / polling update', re: /\breal[\s-]?time|live updat|auto[\s-]?refresh|poll(?:s|ing)?\b|updates?\s+(?:every|in real[\s-]?time)\b/i, support: /poll|stream|live|socket|sse|subscribe|refresh|update|events?/i },
      { name: 'websocket / server push', re: /\bweb\s?socket|server[\s-]?sent|\bsse\b|push (?:notification|update)\b/i, support: /ws|socket|sse|stream|push|subscribe|notify|events?/i },
      { name: 'email notification', re: /\b(?:sends?|sent|receives?|received)\s+(?:an?\s+)?email|email (?:notification|confirmation|is sent)|confirmation email\b/i, support: /email|mail|notif|smtp|send|message/i },
      { name: 'sms / OTP delivery', re: /\bsms|text message|\botp\b|one[\s-]?time (?:password|code)\b/i, support: /sms|otp|verify|code|message|notif|twilio/i },
      { name: 'scheduled / periodic job', re: /\bscheduled|cron|nightly|periodic(?:ally)?|every\s+\d+\s+(?:seconds?|minutes?|hours?)\b/i, support: /schedul|cron|job|sync|batch|poll|task/i },
      { name: 'retry / backoff', re: /\bretr(?:y|ies|ied)|exponential backoff|auto[\s-]?retr\b/i, support: /retr|backoff|queue|resend|attempt/i },
      { name: 'webhook / callback', re: /\bweb\s?hook|callback url\b/i, support: /webhook|hook|callback|event|notify/i },
      { name: 'rate limiting', re: /\brate[\s-]?limit|throttl(?:e|ing)|too many requests\b/i, support: /limit|throttle|quota|rate|429/i }
    ];
  }

  /**
   * Detect behavioural claims with no supporting mechanism in the crawled app.
   * Returns { warnings:string[], penalty:number } where penalty ∈ (0,1] scales
   * the grounding score. No-op (empty, penalty 1) unless the crawl is API-rich
   * enough to make absence meaningful.
   */
  checkBehaviors(testCase) {
    const out = { warnings: [], penalty: 1 };
    if (!this.behaviorCheck) return out;
    if (this.index.apis.length < this.minApisForBehaviorCheck) return out; // crawl too thin to judge

    const steps = Array.isArray(testCase?.steps) ? testCase.steps : [];
    const text = [testCase?.title, testCase?.description, testCase?.expected_result, ...steps]
      .filter(Boolean).join('\n');
    if (!text) return out;

    // Everything the app actually offers, as one searchable haystack.
    const haystack = [
      ...this.index.apis.map(a => `${a.method} ${a.endpoint} ${a.url}`),
      ...this.index.buttons, ...this.index.fields, ...this.index.routes
    ].join(' ').toLowerCase();

    for (const b of GroundedVerifier.BEHAVIOR_PATTERNS) {
      if (b.re.test(text) && !b.support.test(haystack)) {
        out.warnings.push(`Test asserts "${b.name}" but no supporting API/mechanism was observed in the app`);
      }
    }
    if (out.warnings.length) out.penalty = Math.max(0.55, Math.pow(0.85, out.warnings.length));
    return out;
  }

  /** Build a normalized index of real application entities from either KG shape. */
  buildIndex() {
    const index = {
      fields: new Set(),     // form field names / ids (lowercased)
      buttons: new Set(),    // button/link labels (lowercased)
      selectors: new Set(),  // raw CSS selectors captured during extraction
      apis: [],              // { method, endpoint, url }
      routes: new Set(),     // url paths
      pageTitles: new Set(),
      empty: true
    };

    const kg = this.knowledgeGraph;
    if (!kg) return index;

    const addField = (f) => { const v = norm(f); if (v) index.fields.add(v); };
    const addButton = (b) => { const v = norm(b); if (v) index.buttons.add(v); };
    const addSelector = (s) => { if (s && typeof s === 'string') index.selectors.add(s.trim()); };
    const addApi = (a) => {
      if (!a) return;
      const endpoint = a.endpoint || pathOf(a.url) || '';
      if (!endpoint && !a.url) return;
      index.apis.push({
        method: (a.method || 'GET').toUpperCase(),
        endpoint: endpoint,
        url: a.url || ''
      });
    };
    const addRoute = (u) => { const p = pathOf(u); if (p) index.routes.add(p); };

    // --- Pull features off a single page-like object (handles both shapes) ---
    const ingestPage = (page, url) => {
      if (!page || typeof page !== 'object') return;
      if (url || page.url) { addRoute(url || page.url); }
      if (page.title) index.pageTitles.add(norm(page.title));

      // features: form / button / input / nav etc.
      const feats = Array.isArray(page.features) ? page.features : [];
      for (const feat of feats) {
        if (!feat || typeof feat !== 'object') continue;
        if (feat.selector) addSelector(feat.selector);
        if (feat.type === 'form') {
          (feat.inputs || feat.fields || []).forEach(inp => addField(inp?.name || inp?.id || inp?.label || inp));
        } else if (feat.type === 'button' || feat.type === 'link') {
          addButton(feat.text || feat.label);
        }
        // a feature can also carry nested inputs even when not typed 'form'
        if (Array.isArray(feat.inputs)) feat.inputs.forEach(inp => addField(inp?.name || inp?.id || inp));
      }

      // apis attached to the page
      (Array.isArray(page.apis) ? page.apis : []).forEach(addApi);
    };

    // Shape (a): pages is an array
    if (Array.isArray(kg.pages)) {
      kg.pages.forEach(p => ingestPage(p, p?.url));
    } else if (kg.pages && typeof kg.pages === 'object') {
      // Shape (b): pages is an object keyed by url
      Object.keys(kg.pages).forEach(url => ingestPage(kg.pages[url], url));
    }

    // Shape (b) aggregated top-level collections
    if (Array.isArray(kg.forms)) {
      kg.forms.forEach(form => {
        addSelector(form.selector);
        (form.inputs || form.fields || []).forEach(inp => addField(inp?.name || inp?.id || inp));
      });
    }
    if (Array.isArray(kg.apis)) kg.apis.forEach(addApi);
    if (Array.isArray(kg.features)) {
      kg.features.forEach(feat => {
        if (feat?.selector) addSelector(feat.selector);
        if (feat?.type === 'button' && feat.text) addButton(feat.text);
      });
    }

    index.empty = !(index.fields.size || index.buttons.size || index.apis.length ||
                    index.routes.size || index.selectors.size);
    return index;
  }

  /** Is grounding even possible? (false when no crawl data). */
  isApplicable() {
    return !this.index.empty;
  }

  /**
   * Verify a single test case against the real app.
   * @returns {{verdict:'grounded'|'needs_repair'|'reject'|'not_applicable',
   *            score:number, references:object, issues:string[], repairs:object}}
   */
  verify(testCase) {
    if (this.index.empty) {
      // v13.2: no crawl data → grounding is impossible. Do NOT report score 1
      // (which reads as "fully grounded"); report a null score and surface the
      // fact that this test was never verified against a real app, so the test
      // gets flagged 'unverified' downstream instead of silently trusted.
      return { verdict: 'not_applicable', score: null, references: {}, issues: [], repairs: {}, unverified: true };
    }

    const refs = this.extractReferences(testCase);
    const issues = [];
    const repairs = {};
    let referenced = 0;
    let grounded = 0;

    // --- selectors (the strongest grounding signal) ---
    for (const sel of refs.selectors) {
      referenced++;
      if (this.index.selectors.has(sel) || this.selectorMatchesKnown(sel)) {
        grounded++;
      } else {
        const fix = this.nearest(sel, [...this.index.selectors]);
        if (fix) { repairs[`selector:${sel}`] = fix; grounded++; }
        else issues.push(`Selector "${sel}" not found in crawled DOM`);
      }
    }

    // --- form fields ---
    for (const field of refs.fields) {
      referenced++;
      if (this.index.fields.has(field)) {
        grounded++;
      } else {
        const fix = this.nearest(field, [...this.index.fields]);
        if (fix) { repairs[`field:${field}`] = fix; grounded++; }
        else issues.push(`Field "${field}" does not exist on any crawled form`);
      }
    }

    // --- buttons / actions ---
    for (const btn of refs.buttons) {
      referenced++;
      if (this.index.buttons.has(btn) || this.tokenSubsetOfAny(btn, this.index.buttons)) {
        grounded++;
      } else {
        const fix = this.nearest(btn, [...this.index.buttons]);
        if (fix) { repairs[`button:${btn}`] = fix; grounded++; }
        else issues.push(`Button/action "${btn}" not present in the app`);
      }
    }

    // --- API endpoints ---
    for (const api of refs.apis) {
      referenced++;
      if (this.apiExists(api)) grounded++;
      else issues.push(`API "${api}" not observed in crawled network traffic`);
    }

    // --- routes ---
    for (const route of refs.routes) {
      referenced++;
      if (this.routeExists(route)) grounded++;
      else {
        const fix = this.nearest(route, [...this.index.routes]);
        if (fix) { repairs[`route:${route}`] = fix; grounded++; }
        else issues.push(`Route "${route}" was not reachable during crawl`);
      }
    }

    let score = referenced === 0 ? 0.6 : grounded / referenced;

    // --- behaviour validation (v13.2): catch hallucinated backend behaviours ---
    const behavior = this.checkBehaviors(testCase);
    const behaviorReject = this.strictBehaviors && behavior.warnings.length > 0;
    if (behavior.warnings.length) {
      score *= behavior.penalty; // unsupported behaviour drags the score down
      if (this.strictBehaviors) issues.push(...behavior.warnings);
    }

    // No concrete references at all → cannot confirm grounding, but don't hard-reject;
    // these flow to the relevance gate instead. Slight penalty (0.6).
    let verdict;
    if (behaviorReject) {
      verdict = 'reject'; // strict mode: a hallucinated behaviour fails the test outright
    } else if (referenced === 0) {
      verdict = 'grounded'; // abstract test, judged by relevance gate downstream
    } else if (Object.keys(repairs).length > 0 && score >= this.minGroundingScore) {
      verdict = 'needs_repair';
    } else if (score >= this.minGroundingScore && issues.length === 0) {
      verdict = 'grounded';
    } else if (score >= this.minGroundingScore) {
      verdict = 'needs_repair';
    } else {
      verdict = 'reject';
    }

    return { verdict, score: round2(score), references: refs, issues, repairs, behaviorWarnings: behavior.warnings };
  }

  /** Apply proposed repairs to a test case in place-safe manner (returns a new object). */
  applyRepairs(testCase, repairs) {
    if (!repairs || Object.keys(repairs).length === 0) return testCase;
    const tc = JSON.parse(JSON.stringify(testCase));
    const replaceInText = (text) => {
      if (typeof text !== 'string') return text;
      let out = text;
      for (const key of Object.keys(repairs)) {
        const original = key.split(':').slice(1).join(':');
        if (original) out = out.split(original).join(repairs[key]);
      }
      return out;
    };
    tc.title = replaceInText(tc.title);
    tc.description = replaceInText(tc.description);
    tc.expected_result = replaceInText(tc.expected_result);
    tc.test_data = replaceInText(tc.test_data);
    tc.preconditions = replaceInText(tc.preconditions);
    if (Array.isArray(tc.steps)) tc.steps = tc.steps.map(replaceInText);
    tc._repaired = true;
    tc._repairs = repairs;
    return tc;
  }

  /** Batch verify; returns { accepted, repaired, rejected, report }. */
  verifyBatch(testCases) {
    const accepted = [];
    const rejected = [];
    let repairedCount = 0;
    for (const tc of testCases || []) {
      const result = this.verify(tc);
      if (result.verdict === 'reject') {
        rejected.push({ test: tc, reason: result.issues.join('; '), score: result.score });
        continue;
      }
      let finalTc = tc;
      if (result.verdict === 'needs_repair') {
        finalTc = this.applyRepairs(tc, result.repairs);
        repairedCount++;
      }
      finalTc._groundingScore = result.score;
      finalTc._groundingVerdict = result.verdict;
      accepted.push(finalTc);
    }
    return {
      accepted,
      rejected,
      report: {
        total: (testCases || []).length,
        accepted: accepted.length,
        repaired: repairedCount,
        rejected: rejected.length,
        applicable: this.isApplicable()
      }
    };
  }

  // ────────────────────────── reference extraction ──────────────────────────

  /** Extract concrete app entities a test references. */
  extractReferences(testCase) {
    const steps = Array.isArray(testCase?.steps) ? testCase.steps : [];
    const blob = [
      testCase?.title, testCase?.description, testCase?.preconditions,
      testCase?.expected_result, testCase?.test_data, ...steps
    ].filter(Boolean).join('\n');

    return {
      selectors: uniq(this.findSelectors(blob)),
      fields: uniq(this.findFields(blob).map(norm)),
      buttons: uniq(this.findButtons(blob).map(norm)),
      apis: uniq(this.findApis(blob)),
      routes: uniq(this.findRoutes(blob))
    };
  }

  findSelectors(text) {
    const out = [];
    // #id, .class, [attr=...], or selectors wrapped in backticks/quotes
    const re = /(?:^|\s|["'`(])((?:#|\.)[a-zA-Z][\w-]+|\[[a-zA-Z-]+(?:[~|^$*]?=["']?[^\]"']+["']?)?\])/g;
    let m;
    while ((m = re.exec(text)) !== null) out.push(m[1].trim());
    return out;
  }

  findFields(text) {
    const out = [];
    // Quoted field name immediately before the keyword: the "Card Number" field
    const quoted = /["'`]([a-zA-Z][\w ]{0,30})["'`]\s*(?:field|input|textbox|dropdown|checkbox)/gi;
    // Single unquoted token immediately before the keyword: the email field
    const single = /\b([a-zA-Z][\w-]{1,30})\s+(?:field|input|textbox|dropdown|checkbox)\b/gi;
    let m;
    while ((m = quoted.exec(text)) !== null) out.push(m[1]);
    while ((m = single.exec(text)) !== null) out.push(m[1]);
    return out;
  }

  findButtons(text) {
    const out = [];
    // click/press/tap/select "<label>" [button]
    const re = /(?:click|press|tap|select|choose|hit)\s+(?:on\s+)?(?:the\s+)?["'`]([^"'`]{1,40})["'`]/gi;
    let m; while ((m = re.exec(text)) !== null) out.push(m[1]);
    // also: <label> button
    const re2 = /["'`]([^"'`]{1,40})["'`]\s+button/gi;
    while ((m = re2.exec(text)) !== null) out.push(m[1]);
    return out;
  }

  findApis(text) {
    const out = [];
    const re = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[\w\-/{}:.]+)/g;
    let m; while ((m = re.exec(text)) !== null) out.push(`${m[1]} ${m[2]}`);
    // bare /api/... endpoints
    const re2 = /\b(\/api\/[\w\-/{}:.]+)/g;
    while ((m = re2.exec(text)) !== null) out.push(`GET ${m[1]}`);
    return out;
  }

  findRoutes(text) {
    const out = [];
    const re = /https?:\/\/[^\s"'`)]+/g;
    let m; while ((m = re.exec(text)) !== null) { const p = pathOf(m[0]); if (p) out.push(p); }
    return out;
  }

  // ────────────────────────── matching helpers ──────────────────────────

  selectorMatchesKnown(sel) {
    // an id/class selector matches if any known selector contains it
    for (const known of this.index.selectors) {
      if (known.includes(sel) || sel.includes(known)) return true;
    }
    return false;
  }

  apiExists(apiRef) {
    const [method, endpoint] = apiRef.split(' ');
    const ep = (endpoint || '').toLowerCase();
    return this.index.apis.some(a => {
      const known = (a.endpoint || pathOf(a.url) || '').toLowerCase();
      if (!known) return false;
      const methodOk = !method || method === 'GET' || a.method === method;
      return methodOk && (known === ep || known.includes(ep) || ep.includes(known));
    });
  }

  routeExists(route) {
    const r = route.toLowerCase();
    for (const known of this.index.routes) {
      const k = known.toLowerCase();
      if (k === r || k.includes(r) || r.includes(k)) return true;
    }
    return false;
  }

  tokenSubsetOfAny(label, set) {
    const tokens = label.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return false;
    for (const known of set) {
      if (tokens.every(t => known.includes(t))) return true;
    }
    return false;
  }

  /** Return the nearest candidate above fuzzyThreshold, else null. */
  nearest(value, candidates) {
    let best = null, bestScore = 0;
    for (const cand of candidates) {
      const s = similarity(value, cand);
      if (s > bestScore) { bestScore = s; best = cand; }
    }
    return bestScore >= this.fuzzyThreshold ? best : null;
  }
}

// ────────────────────────── pure utilities ──────────────────────────

function norm(s) {
  if (s == null) return '';
  return String(s).trim().toLowerCase().replace(/\s+/g, ' ');
}

function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function pathOf(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    if (/^https?:\/\//.test(url)) return new URL(url).pathname.replace(/\/$/, '') || '/';
  } catch (_) { /* not a full url */ }
  // already a path
  const m = url.match(/^(\/[\w\-/{}:.]*)/);
  return m ? m[1].replace(/\/$/, '') || '/' : '';
}

/** Normalized similarity in [0,1] using Levenshtein distance. */
function similarity(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// Export for Vitest (CommonJS) and service worker (self)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GroundedVerifier, similarity, levenshtein, pathOf };
}
if (typeof self !== 'undefined') {
  self.GroundedVerifier = GroundedVerifier;
}
