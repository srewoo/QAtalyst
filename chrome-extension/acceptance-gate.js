/**
 * Acceptance Gate — the single choke-point every generated test must pass before
 * it enters the final suite. Composes three independent checks so the planner can
 * never accept a duplicate or an irrelevant/hallucinated test:
 *
 *   1. GROUNDING  (grounded-verifier.js)  — does it reference real app entities?
 *   2. RELEVANCE  (this file)             — does it talk about THIS ticket / app?
 *   3. DEDUP      (semantic-duplicate-detector.js) — is it novel vs already-accepted?
 *
 * The gate is stateful: it holds the accepted set so admission is incremental —
 * each new candidate is checked against everything accepted so far. This is what
 * lets the planner loop call propose_tests repeatedly without ever re-introducing
 * a near-duplicate.
 *
 * Dependencies are injected (or pulled from `self`) so the gate is unit-testable
 * with lightweight stand-ins.
 *
 * Version: 1.0.0
 */

const STOPWORDS = new Set(('a an the and or but if then else for to of in on at by with from into over under ' +
  'is are was were be been being do does did will would should could can may might must shall ' +
  'this that these those it its they them user users system page click clicks enter verify check ' +
  'test tests case cases valid invalid should when given and ensure displayed shown correct').split(/\s+/));

class AcceptanceGate {
  /**
   * @param {object} cfg
   * @param {object} cfg.knowledgeGraph
   * @param {object} cfg.ticketData
   * @param {object} [cfg.deps] { GroundedVerifier, SemanticDuplicateDetector } (defaults from self)
   * @param {number} [cfg.dedupThreshold=0.78] similarity at/above which a test is a duplicate
   * @param {number} [cfg.relevanceThreshold=0.12] min relevance score to be considered on-topic
   * @param {number} [cfg.minGroundingScore=0.5]
   */
  constructor(cfg = {}) {
    const deps = cfg.deps || (typeof self !== 'undefined' ? self : {});
    const GV = deps.GroundedVerifier || (typeof GroundedVerifier !== 'undefined' ? GroundedVerifier : null);
    const SDD = deps.SemanticDuplicateDetector || (typeof SemanticDuplicateDetector !== 'undefined' ? SemanticDuplicateDetector : null);

    this.dedupThreshold = cfg.dedupThreshold ?? 0.78;
    this.relevanceThreshold = cfg.relevanceThreshold ?? 0.12;

    this.verifier = GV ? new GV(cfg.knowledgeGraph, { minGroundingScore: cfg.minGroundingScore }) : null;
    this.dedup = SDD ? new SDD(this.dedupThreshold) : null;

    this.referenceVocab = this.buildReferenceVocab(cfg.ticketData, cfg.knowledgeGraph);
    this.relevanceApplicable = this.referenceVocab.size > 0;

    this.accepted = [];        // tests admitted so far
    this.rejected = [];        // { test, stage, reason }
    this.stats = { grounding: 0, relevance: 0, duplicate: 0, repaired: 0, accepted: 0 };
  }

  /**
   * Admit a batch of candidate tests. Stateful: dedups against previously accepted tests too.
   * @returns {{accepted: object[], rejected: object[], stats: object}}
   */
  admit(candidates) {
    const newlyAccepted = [];
    for (const candidate of (candidates || [])) {
      if (!candidate || (!candidate.title && !candidate.description)) continue;

      // ── 1. GROUNDING ──
      let test = candidate;
      if (this.verifier) {
        const g = this.verifier.verify(candidate);
        if (g.verdict === 'reject') {
          this.reject(candidate, 'grounding', g.issues.join('; ') || 'references non-existent app entities');
          continue;
        }
        if (g.verdict === 'needs_repair') {
          test = this.verifier.applyRepairs(candidate, g.repairs);
          this.stats.repaired++;
        }
        test._groundingScore = g.score;
      }

      // ── 2. RELEVANCE ──
      if (this.relevanceApplicable) {
        const rel = this.relevanceScore(test);
        test._relevanceScore = round3(rel);
        if (rel < this.relevanceThreshold) {
          this.reject(candidate, 'relevance', `off-topic (relevance ${rel.toFixed(3)} < ${this.relevanceThreshold})`);
          continue;
        }
      }

      // ── 3. DEDUP (vs accepted + this batch) ──
      const dup = this.findDuplicate(test, this.accepted.concat(newlyAccepted));
      if (dup) {
        this.reject(candidate, 'duplicate', `near-duplicate of "${dup.against.title || dup.against.id}" (sim ${dup.sim.toFixed(2)})`);
        continue;
      }

      this.stats.accepted++;
      newlyAccepted.push(test);
    }
    this.accepted.push(...newlyAccepted);
    return { accepted: newlyAccepted, rejected: this.rejected, stats: { ...this.stats } };
  }

  reject(test, stage, reason) {
    this.stats[stage] = (this.stats[stage] || 0) + 1;
    this.rejected.push({ test, stage, reason });
  }

  /** All tests admitted so far. */
  getAccepted() { return this.accepted; }

  // ───────────────────────── relevance ─────────────────────────

  /**
   * Relevance = weighted overlap between the test's content tokens and the
   * reference vocabulary (ticket terms weighted higher than app terms),
   * normalized by the test's own content-token count so short and long tests
   * are scored comparably.
   */
  relevanceScore(test) {
    const tokens = tokenize([
      test.title, test.description, test.expected_result,
      ...(Array.isArray(test.steps) ? test.steps : [])
    ].filter(Boolean).join(' '));
    if (tokens.length === 0) return 0;
    let matchedWeight = 0;
    const seen = new Set();
    for (const tok of tokens) {
      if (seen.has(tok)) continue;
      seen.add(tok);
      const w = this.referenceVocab.get(tok);
      if (w) matchedWeight += w;
    }
    // normalize by sqrt of distinct token count (dampens long-test inflation)
    return matchedWeight / Math.sqrt(seen.size);
  }

  buildReferenceVocab(ticketData, knowledgeGraph) {
    const vocab = new Map();
    const add = (text, weight) => {
      for (const tok of tokenize(text)) {
        vocab.set(tok, Math.max(vocab.get(tok) || 0, weight));
      }
    };
    if (ticketData) {
      add([ticketData.summary, ticketData.title].filter(Boolean).join(' '), 1.0);
      add([ticketData.description, ticketData.acceptanceCriteria, ticketData.acceptance_criteria].filter(Boolean).join(' '), 0.7);
    }
    // App entity names from KG (forms/fields/buttons/routes/titles)
    if (knowledgeGraph && this.verifier && this.verifier.index) {
      const idx = this.verifier.index;
      idx.fields.forEach(f => add(f, 0.5));
      idx.buttons.forEach(b => add(b, 0.5));
      idx.pageTitles.forEach(t => add(t, 0.4));
      idx.routes.forEach(r => add(r.replace(/[/_-]/g, ' '), 0.3));
    }
    return vocab;
  }

  // ───────────────────────── dedup ─────────────────────────

  /** Return {against, sim} for the first existing test that is a near-duplicate, else null. */
  findDuplicate(test, existing) {
    for (const other of existing) {
      const sim = this.similarity(test, other);
      if (sim >= this.dedupThreshold) return { against: other, sim };
    }
    return null;
  }

  similarity(a, b) {
    if (this.dedup) {
      // Combine the detector's semantic + lexical signals (same blend it uses internally).
      const sem = safe(() => this.dedup.calculateSemanticSimilarity(a, b), 0);
      const lex = safe(() => this.dedup.calculateLexicalSimilarity(a, b), 0);
      return Math.max(sem, 0.5 * sem + 0.5 * lex);
    }
    // Fallback: Jaccard over content tokens.
    return jaccard(tokenize(textOf(a)), tokenize(textOf(b)));
  }
}

// ───────────────────────── helpers ─────────────────────────

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

function textOf(t) {
  return [t.title, t.description, t.expected_result, ...(Array.isArray(t.steps) ? t.steps : [])]
    .filter(Boolean).join(' ');
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function round3(n) { return Math.round(n * 1000) / 1000; }

function safe(fn, fallback) { try { const v = fn(); return Number.isFinite(v) ? v : fallback; } catch (_) { return fallback; } }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AcceptanceGate, tokenize, jaccard };
}
if (typeof self !== 'undefined') {
  self.AcceptanceGate = AcceptanceGate;
}
