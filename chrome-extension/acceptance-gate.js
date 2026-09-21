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

// Shared concept-normalisation primitives (synonym + stem canonicalisation).
// Resolved from the global (service worker importScripts) or via require (tests).
const TS = (typeof TextSimilarity !== 'undefined' && TextSimilarity)
  || (typeof self !== 'undefined' && self.TextSimilarity)
  || (typeof require !== 'undefined' ? require('./text-similarity.js') : null);

// Free, offline embedding (feature-hashed concept + char-gram vectors). When
// present, relevance is the cosine between a test's embedding and a reference
// embedding built once from the ticket+app vocabulary — this captures semantic
// (not merely lexical) relevance. Falls back to concept-overlap when absent.
const EMB = (typeof Embeddings !== 'undefined' && Embeddings)
  || (typeof self !== 'undefined' && self.Embeddings)
  || (typeof require !== 'undefined' ? require('./embeddings.js') : null);

class AcceptanceGate {
  /**
   * @param {object} cfg
   * @param {object} cfg.knowledgeGraph
   * @param {object} cfg.ticketData
   * @param {object} [cfg.deps] { GroundedVerifier, SemanticDuplicateDetector } (defaults from self)
   * @param {number} [cfg.dedupThreshold=0.68] similarity at/above which a test is a duplicate
   * @param {number} [cfg.relevanceThreshold=0.25] min relevance score to be considered on-topic
   * @param {number} [cfg.minGroundingScore=0.5]
   */
  constructor(cfg = {}) {
    const deps = cfg.deps || (typeof self !== 'undefined' ? self : {});
    const GV = deps.GroundedVerifier || (typeof GroundedVerifier !== 'undefined' ? GroundedVerifier : null);
    const SDD = deps.SemanticDuplicateDetector || (typeof SemanticDuplicateDetector !== 'undefined' ? SemanticDuplicateDetector : null);

    // Defaults tightened (v13.2): dedup 0.78→0.68 catches near-duplicates that
    // differ only in wording; relevance 0.12→0.25 rejects tests that merely share
    // an incidental token ("user", "page") with the ticket. Both still overridable
    // per-call via settings / adaptive thresholds.
    this.dedupThreshold = cfg.dedupThreshold ?? 0.68;
    this.relevanceThreshold = cfg.relevanceThreshold ?? 0.25;

    // F06: the verifier needs the TICKET as well as the crawl, so a control the
    // ticket asks for but the app does not have yet is recognised as
    // not-built-yet rather than rejected as invented.
    this.verifier = GV ? new GV(cfg.knowledgeGraph, {
      minGroundingScore: cfg.minGroundingScore,
      ticketData: cfg.ticketData
    }) : null;
    this.dedup = SDD ? new SDD(this.dedupThreshold) : null;

    this.referenceVocab = this.buildReferenceVocab(cfg.ticketData, cfg.knowledgeGraph);
    this.relevanceApplicable = this.referenceVocab.size > 0;
    // F10: app entities scored separately — they classify, they do not admit.
    this.appVocab = this.buildAppVocab(cfg.knowledgeGraph);

    // Build the reference EMBEDDING once: an L2-normalized vector over the same
    // concept vocabulary used for the overlap path. Used when Embeddings is
    // available; otherwise we fall back to the concept-overlap score below.
    this.embeddings = EMB && typeof EMB.embed === 'function' ? EMB : null;
    this.referenceVector = (this.embeddings && this.relevanceApplicable)
      ? this.embeddings.embed(this.weightedReferenceText(this.referenceVocab))
      : null;

    // F14: an existing test suite (e.g. fetched from TestRail) to dedupe AGAINST
    // but never emit. Generated tests that duplicate one of these are rejected as
    // "already covered by existing suite", so QAtalyst doesn't re-propose tests
    // the team already maintains. Tagged _existing so the reason can say so.
    this.existingSuite = (Array.isArray(cfg.existingTests) ? cfg.existingTests : [])
      .filter(t => t && (t.title || t.description))
      .map(t => ({ ...t, _existing: true }));

    this.accepted = [];        // tests admitted so far
    this.rejected = [];        // { test, stage, reason }
    // F05: pairs that scored as near-duplicates but were kept apart by a proven
    // distinction. Exposed so a reviewer can audit every merge decision.
    this.preservedDistinctions = [];
    this.deps = cfg.deps || {};
    this.stats = { grounding: 0, relevance: 0, duplicate: 0, duplicateExisting: 0, repaired: 0, accepted: 0 };
  }

  /**
   * Admit a batch of candidate tests. Stateful: dedups against previously accepted tests too.
   * @returns {{accepted: object[], rejected: object[], stats: object}}
   */
  admit(candidates) {
    const newlyAccepted = [];
    const rejectedBefore = this.rejected.length;
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
        let verdict = g.verdict;
        let issues = g.issues;
        if (verdict === 'needs_repair') {
          test = this.verifier.applyRepairs(candidate, g.repairs);
          this.stats.repaired++;
          // F06: a repair is a proposal, not a proof. Re-verify the REPAIRED
          // test: fuzzy label substitution can resolve one reference and break
          // another, and only a clean second pass justifies 'verified'.
          const g2 = this.verifier.verify(test);
          if (g2.verdict === 'reject') {
            this.reject(candidate, 'grounding', g2.issues.join('; ') || 'repair did not resolve references');
            continue;
          }
          verdict = g2.verdict;
          issues = g2.issues;
          test._groundingScore = g2.score;
        } else {
          test._groundingScore = g.score;
        }
        // v13.2: make the no-KG hole visible. When grounding can't run (no crawl
        // data) the test is admitted but explicitly flagged 'unverified' rather
        // than treated as grounded, so the UI/consumer can mark it for manual
        // verification.
        // F06: 'unresolved' means the test still names entities that exist
        // nowhere in the crawl and that no repair could map. It is NOT verified —
        // stamping it so was how hallucinated controls reached exportable output.
        if (verdict === 'not_applicable' || g.unverified) {
          test._grounding = 'unverified';
        } else if (verdict === 'specification') {
          // F06: requirement-backed, not yet implemented. A valid case that can
          // only be executed once the feature ships — distinct both from a
          // verified case and from an invented one.
          test._grounding = 'specification';
          test._pendingImplementation = g.pendingImplementation;
          this.stats.specification = (this.stats.specification || 0) + 1;
        } else if (verdict === 'unresolved' || (issues && issues.length)) {
          test._grounding = 'unresolved';
          test._groundingIssues = issues;
          this.stats.unresolved = (this.stats.unresolved || 0) + 1;
        } else {
          test._grounding = 'verified';
        }
        // Surface hallucinated-behaviour warnings (auto-sync/email/polling with no
        // supporting API) so reviewers see them even when the test is admitted.
        if (g.behaviorWarnings && g.behaviorWarnings.length) {
          test._behaviorWarnings = g.behaviorWarnings;
          this.stats.behaviorWarnings = (this.stats.behaviorWarnings || 0) + 1;
        }
      }

      // ── 2. RELEVANCE ──
      if (this.relevanceApplicable) {
        const rel = this.relevanceScore(test);
        test._relevanceScore = round3(rel);
        // F10: record the BASIS for keeping it, not just the score, so a reviewer
        // can see whether a case covers the ticket or merely exists in the app.
        test._relevanceBasis = this.classifyRelevance(test);
        if (rel < this.relevanceThreshold) {
          const why = test._relevanceBasis === 'app_only'
            ? 'describes a real app feature unrelated to this ticket'
            : 'off-topic';
          this.reject(candidate, 'relevance', `${why} (relevance ${rel.toFixed(3)} < ${this.relevanceThreshold})`);
          continue;
        }
      }

      // ── 3. DEDUP (vs accepted + this batch + existing suite) ──
      const dup = this.findDuplicate(test, this.accepted.concat(newlyAccepted, this.existingSuite));
      if (dup) {
        if (dup.against._existing) {
          this.stats.duplicateExisting++;
          this.reject(candidate, 'duplicate', `already covered by existing suite case "${dup.against.title || dup.against.id}" (sim ${dup.sim.toFixed(2)})`);
        } else {
          this.reject(candidate, 'duplicate', `near-duplicate of "${dup.against.title || dup.against.id}" (sim ${dup.sim.toFixed(2)})`);
        }
        continue;
      }

      this.stats.accepted++;
      newlyAccepted.push(test);
    }
    // Safety net: rejecting EVERY candidate on grounding is far more likely to
    // mean the crawl does not cover this ticket than that the model hallucinated
    // every single test. Returning nothing — with "try crawling the app first"
    // when the user has already crawled — is the worst possible answer. Re-admit
    // them as explicitly unverified so the user gets a reviewable suite and a
    // truthful explanation.
    // Needs a meaningful batch: one or two rejections are ordinary, and treating
    // them as a crawl mismatch would wave through exactly the hallucinated tests
    // grounding exists to catch. Twenty in a row is a different claim.
    const MIN_BATCH_FOR_MISMATCH = 3;
    // Compare THIS batch's rejections, not the cumulative list. `this.rejected`
    // accumulates across every batch the planner submits, so comparing it to one
    // batch's candidate count fired whenever the running total happened to equal
    // the current batch size — and the flag, once set, was never cleared. That is
    // how the panel came to say "none of the tests could be matched" while
    // displaying eight tests that had matched.
    const batchRejects = this.rejected.slice(rejectedBefore).filter(r => r.stage === 'grounding');
    if (newlyAccepted.length === 0 && candidates && candidates.length >= MIN_BATCH_FOR_MISMATCH) {
      const groundingRejects = batchRejects;
      if (groundingRejects.length === candidates.length) {
        console.warn(`[Gate] All ${candidates.length} candidates in this batch failed grounding — treating the crawl as not covering this ticket.`);
        this.crawlMismatch = true;
        for (const r of groundingRejects) {
          const test = { ...r.test, _grounding: 'unverified', _groundingIssues: [r.reason] };
          this.stats.grounding = Math.max(0, (this.stats.grounding || 1) - 1);
          this.stats.accepted++;
          newlyAccepted.push(test);
        }
        // Only this batch's grounding rejections are withdrawn — earlier batches
        // may have been rejected for good reason.
        const withdraw = new Set(groundingRejects);
        this.rejected = this.rejected.filter(r => !withdraw.has(r));
      }
    }

    this.accepted.push(...newlyAccepted);
    return {
      accepted: newlyAccepted, rejected: this.rejected,
      // Report the state of the SUITE, not a sticky flag: if anything in the
      // final suite did ground against the crawl, the crawl plainly covers part
      // of this ticket and claiming otherwise is false.
      crawlMismatch: !!this.crawlMismatch && !this.accepted.some(t => t._grounding === 'verified'),
      preservedDistinctions: this.preservedDistinctions,
      stats: { ...this.stats, preservedDistinctions: this.preservedDistinctions.length }
    };
  }

  reject(test, stage, reason) {
    this.stats[stage] = (this.stats[stage] || 0) + 1;
    this.rejected.push({ test, stage, reason });
  }

  /** All tests admitted so far. */
  getAccepted() { return this.accepted; }

  // ───────────────────────── relevance ─────────────────────────

  /**
   * Relevance = CONCEPT-level overlap between the test and the reference
   * vocabulary. Both the test and the vocabulary are canonicalised to concepts
   * (sign-in/authenticate/log-in → `login`, btn/cta → `button`, creating →
   * `create`), so a test is judged relevant when it talks about the same THINGS
   * as the ticket/app — even with entirely different wording — rather than when
   * it happens to share surface tokens. Score is the mean reference weight over
   * the test's distinct concepts, in ~[0,1].
   */
  relevanceScore(test) {
    const text = [
      test.title, test.description, test.expected_result,
      ...(Array.isArray(test.steps) ? test.steps : [])
    ].filter(Boolean).join(' ');

    // Preferred path: embedding-vector cosine. Captures semantically related
    // tests (e.g. "authenticate the account" vs a login ticket) that share few
    // surface tokens with the ticket but mean the same thing.
    if (this.embeddings && this.referenceVector) {
      return this.embeddings.cosine(this.embeddings.embed(text), this.referenceVector);
    }

    // Fallback: concept-overlap mean weight (when Embeddings is unavailable).
    const concepts = this.conceptTokens(text);
    if (concepts.length === 0) return 0;
    let matchedWeight = 0;
    const seen = new Set();
    for (const c of concepts) {
      if (seen.has(c)) continue;
      seen.add(c);
      const w = this.referenceVocab.get(c);
      if (w) matchedWeight += w;
    }
    // F39: this is NOT a mean (the old comment claimed "mean weight") — it's the
    // total matched reference-vocab weight, sqrt-damped by the number of distinct
    // concepts so long, partially-relevant tests aren't over-rewarded for volume.
    // A squarely on-topic test scores high; off-topic trends to ~0. Value is not
    // bounded to 1, which is fine: it's compared against relevanceThreshold only.
    return matchedWeight / Math.sqrt(seen.size);
  }

  /**
   * F10: WHY is this test in scope? A single relevance number cannot distinguish
   * "this tests the ticket's feature" from "this is a regression test for a
   * neighbouring feature the change touches" from "this is an unrelated app
   * feature the crawl happened to include".
   *
   *   direct      — talks about the ticket's own subject matter
   *   app_only    — names real app entities but nothing from the ticket. This is
   *                 exactly the case that used to pass, because app entity names
   *                 were mixed into the ticket vocabulary.
   *   unsupported — grounded in neither
   *
   * ponytail: lexical scope classification, not an impact analysis. A genuine
   * "impacted regression" verdict needs the change/diff context of fix2.md §14
   * item 3; until then a regression test must still overlap the ticket to pass.
   */
  classifyRelevance(test) {
    const text = [test.title, test.description, test.expected_result,
      ...(Array.isArray(test.steps) ? test.steps : [])].filter(Boolean).join(' ');
    const concepts = new Set(this.conceptTokens(text));
    if (!concepts.size) return 'unsupported';
    let ticketHits = 0, appHits = 0;
    for (const c of concepts) {
      if (this.referenceVocab.has(c)) ticketHits++;
      else if (this.appVocab.has(c)) appHits++;
    }
    if (ticketHits > 0) return 'direct';
    if (appHits > 0) return 'app_only';
    return 'unsupported';
  }

  /** Canonicalise text to concept tokens (delegates to TextSimilarity; falls back to plain tokens). */
  conceptTokens(text) {
    return TS ? TS.canonicalTokens(text) : tokenize(text);
  }

  buildReferenceVocab(ticketData, knowledgeGraph) {
    const vocab = new Map();
    const add = (text, weight) => {
      for (const tok of this.conceptTokens(text)) {
        vocab.set(tok, Math.max(vocab.get(tok) || 0, weight));
      }
    };
    if (ticketData) {
      add([ticketData.summary, ticketData.title].filter(Boolean).join(' '), 1.0);
      add([ticketData.description, ticketData.acceptanceCriteria, ticketData.acceptance_criteria].filter(Boolean).join(' '), 0.7);
    }
    // App entity names from KG (forms/fields/buttons/routes/titles)
    // F10: app entity names are deliberately NOT mixed in here any more.
    // Relevance answers "is this test about THIS TICKET?"; whether the entities
    // it names exist is a separate question the grounding check already answers.
    // Merging them meant a test for a real but entirely unrelated feature scored
    // relevant purely because the app's own button labels were in the vocabulary
    // — the crawl was voting on scope.
    return vocab;
  }

  /**
   * F10: the app's own entity names, kept SEPARATE from ticket relevance. Used
   * only to classify why a test was retained, never to let it through the gate.
   */
  buildAppVocab(knowledgeGraph) {
    const vocab = new Map();
    if (!knowledgeGraph || !this.verifier || !this.verifier.index) return vocab;
    const add = (text, weight) => {
      for (const tok of this.conceptTokens(text)) {
        vocab.set(tok, Math.max(vocab.get(tok) || 0, weight));
      }
    };
    const idx = this.verifier.index;
    idx.fields.forEach(f => add(f, 0.5));
    idx.buttons.forEach(b => add(b, 0.5));
    idx.pageTitles.forEach(t => add(t, 0.4));
    idx.routes.forEach(r => add(r.replace(/[/_-]/g, ' '), 0.3));
    return vocab;
  }

  /**
   * F10: reference text for the embedding path, WEIGHTED. The vector was built
   * from `vocab.keys().join(' ')`, which threw the weights away — so a route
   * fragment (0.3) pulled exactly as hard as the ticket summary (1.0). A
   * feature-hash TF embedding weights by term frequency, so repeat each token in
   * proportion to its configured weight.
   */
  weightedReferenceText(vocab) {
    const parts = [];
    for (const [tok, w] of vocab) {
      const reps = Math.max(1, Math.round(w * 3));
      for (let i = 0; i < reps; i++) parts.push(tok);
    }
    return parts.join(' ');
  }

  // ───────────────────────── dedup ─────────────────────────

  /** Return {against, sim} for the first existing test that is a near-duplicate, else null. */
  findDuplicate(test, existing) {
    for (const other of existing) {
      const sim = this.similarity(test, other);
      if (sim < this.dedupThreshold) continue;
      // F05: similarity may RETRIEVE a comparison candidate; it may not
      // authorize a deletion. A proven distinction (opposite outcome, different
      // operation, different actor, different boundary value) keeps both cases —
      // silently dropping one of those was how the suite achieved a low
      // duplicate rate while losing real obligations.
      // F05 §7.3: classify the pair instead of answering merge-or-keep from a
      // number. Only a proven exact duplicate or equivalent scenario may be
      // collapsed; contradictory, parameter-variant, overlapping and uncertain
      // pairs are all RETAINED — and recorded, so the call is auditable.
      const Detector = this.deps && this.deps.SemanticDuplicateDetector;
      if (Detector && typeof Detector.classifyPair === 'function') {
        const verdict = Detector.classifyPair(test, other, {
          detector: this.dedup, threshold: this.dedupThreshold,
          // Pass the score the gate already computed, so the gate and the batch
          // detector cannot disagree about the same pair.
          similarity: sim
        });
        if (!verdict.merge) {
          this.preservedDistinctions.push({
            test: test.title, against: other.title || other.id,
            sim: round3(sim), relation: verdict.relation, reason: verdict.reason
          });
          continue;
        }
        return { against: other, sim, relation: verdict.relation };
      }

      const distinct = this.dedup && typeof this.dedup.distinctionReason === 'function'
        ? this.dedup.distinctionReason(test, other)
        : null;
      if (distinct) {
        this.preservedDistinctions.push({
          test: test.title, against: other.title || other.id,
          sim: round3(sim), reason: distinct
        });
        continue;
      }
      return { against: other, sim };
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
