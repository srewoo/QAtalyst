/**
 * Golden-set eval scorer (G3)
 *
 * A pure, LLM-free scorer for a generated test suite against a fixture ticket.
 * It reuses the SHIPPED logic modules (CoverageMapper, GroundedVerifier,
 * SemanticDuplicateDetector) so the score reflects exactly what the extension
 * enforces at runtime — not a re-implementation that can drift.
 *
 * Input fixture shape:
 *   {
 *     key, ticket: { summary, description, acceptanceCriteria? },
 *     knowledgeGraph?,            // crawl KG for grounding checks (optional)
 *     generatedSuite: [ {title, steps[], expected_result, category, ...} ],
 *     expertSuite?: [ {title, expected_result} ]   // optional gold reference
 *   }
 *
 * Metrics (all 0..1 unless noted):
 *   - requirementCoverage : fraction of harvested requirement items exercised
 *   - groundingValidity   : fraction of tests NOT rejected by the grounding gate
 *                           (null when no KG — grounding is not applicable)
 *   - duplicateRate       : fraction of tests that are near-duplicates
 *   - precision           : fraction of generated tests that match an expert test
 *   - recall              : fraction of expert tests matched by a generated test
 *   - score               : weighted 0..100 aggregate
 *
 * No I/O, no network, no browser globals → runnable in Node and under Vitest.
 */

const CoverageMapper = require('../coverage-mapper.js');
const { GroundedVerifier } = require('../grounded-verifier.js');
const SemanticDuplicateDetector = require('../semantic-duplicate-detector.js');
const Embeddings = require('../embeddings.js'); // G4: enable semantic AC matching in the scorer

const STOP = new Set(['the','a','an','and','or','but','if','then','when','while','for','of','to','in','on','at','by','with','from','as','is','are','be','that','this','it','its','user','users','should','ensure','verify','system','not','all','via']);
function tokens(text) {
  const words = String(text || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  return new Set(words.filter(w => !STOP.has(w)));
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
// Full text (incl. steps) — used where behaviour detail matters.
function testText(t) {
  return [t.title, t.expected_result || t.expectedResult, ...(Array.isArray(t.steps) ? t.steps : [])].filter(Boolean).join(' ');
}
// Intent text (title + expected only) — used for expert-suite matching, since
// expert references are typically title-level; including steps would dilute the
// overlap with URL/selector noise and understate precision/recall.
function matchText(t) {
  return [t.title, t.expected_result || t.expectedResult].filter(Boolean).join(' ');
}

function scoreSuite(fixture, opts = {}) {
  const matchThreshold = opts.matchThreshold ?? 0.3;
  const ticket = fixture.ticket || {};
  const suite = Array.isArray(fixture.generatedSuite) ? fixture.generatedSuite : [];
  const expert = Array.isArray(fixture.expertSuite) ? fixture.expertSuite : null;
  const total = suite.length;

  // ── requirement coverage (reuses the shipped harvester + mapper) ──
  const reqItems = CoverageMapper.extractRequirementItems(ticket);
  const acCov = CoverageMapper.mapAcceptanceCriteria(suite, reqItems, { embeddings: Embeddings });
  const requirementCoverage = acCov.applicable ? acCov.covered / acCov.total : null;

  // ── grounding validity (reuses the shipped verifier on the fixture KG) ──
  let groundingValidity = null;
  let groundingDetail = null;
  if (fixture.knowledgeGraph) {
    const v = new GroundedVerifier(fixture.knowledgeGraph);
    if (v.isApplicable()) {
      // F20: "not rejected" is not "grounded". A test with unresolved references
      // (verdict 'unresolved') or one repaired but still carrying issues used to
      // count as valid grounding, so a suite full of half-hallucinated entities
      // scored 100% grounding. Only fully resolved references count.
      let grounded = 0, unresolved = 0, rejected = 0;
      for (const t of suite) {
        const r = v.verify(t);
        if (r.verdict === 'reject') rejected++;
        else if (r.verdict === 'unresolved' || (r.issues && r.issues.length)) unresolved++;
        else grounded++;
      }
      groundingValidity = total ? grounded / total : null;
      groundingDetail = { grounded, unresolved, rejected };
    }
  }

  // ── duplicate rate (reuses the shipped detector) ──
  let duplicateRate = 0;
  let duplicateCount = 0;
  if (total >= 2) {
    const det = new SemanticDuplicateDetector(opts.dedupThreshold ?? 0.68);
    const groups = det.detectDuplicates(suite) || [];
    duplicateCount = groups.reduce((n, g) => n + ((g.duplicates && g.duplicates.length) || 0), 0);
    duplicateRate = duplicateCount / total;
  }

  // ── F20: false merges on labeled protected pairs ──
  // Duplicate REMOVAL rate says nothing about whether the right cases were
  // removed. A fixture may declare pairs of titles that must never be collapsed
  // (opposite outcomes, different operations/actors, distinct boundary values);
  // merging one of those is a quality FAILURE that a low duplicate rate hides.
  let falseMerges = null;
  const protectedPairs = Array.isArray(fixture.protectedDistinctions) ? fixture.protectedDistinctions : null;
  if (protectedPairs && protectedPairs.length) {
    const det = new SemanticDuplicateDetector(opts.dedupThreshold ?? 0.68);
    falseMerges = [];
    for (const pair of protectedPairs) {
      const [a, b] = pair.cases || [];
      if (!a || !b) continue;
      const groups = det.detectDuplicates([a, b]) || [];
      const merged = groups.some(g => (g.duplicates || []).length > 0);
      if (merged) falseMerges.push({ reason: pair.reason || 'protected pair', a: a.title, b: b.title });
    }
  }

  // ── precision / recall vs an expert suite (token-overlap proxy) ──
  let precision = null, recall = null;
  if (expert && expert.length) {
    const genTok = suite.map(matchText).map(tokens);
    const expTok = expert.map(matchText).map(tokens);
    const matchedGen = genTok.filter(g => expTok.some(e => jaccard(g, e) >= matchThreshold)).length;
    const matchedExp = expTok.filter(e => genTok.some(g => jaccard(g, e) >= matchThreshold)).length;
    precision = total ? matchedGen / total : 0;
    recall = expert.length ? matchedExp / expert.length : 0;
  }

  // ── weighted aggregate ──
  // Weights redistribute over whichever metrics are applicable for this fixture.
  const parts = [];
  if (requirementCoverage != null) parts.push([requirementCoverage, 0.40]);
  if (groundingValidity != null) parts.push([groundingValidity, 0.30]);
  parts.push([1 - Math.min(1, duplicateRate), 0.15]);
  if (precision != null) parts.push([(precision + recall) / 2, 0.15]);
  const wSum = parts.reduce((s, [, w]) => s + w, 0) || 1;

  // F20: a fixture with no requirements, no crawl and no expert suite has NOTHING
  // to judge the output against — only the uniqueness term survives, and an empty
  // suite trivially has no duplicates, so `evaluate({ticket:{},generatedSuite:[]})`
  // returned score 100 / pass true. Missing evidence is not a perfect result.
  const scoreable = total > 0 && (requirementCoverage != null || groundingValidity != null || precision != null);
  const score = scoreable
    ? Math.round((parts.reduce((s, [v, w]) => s + v * w, 0) / wSum) * 100)
    : null;
  const unscoreableReason = scoreable ? null
    : (total === 0 ? 'empty suite — nothing to score'
       : 'no requirements, crawl graph or expert suite to score against');

  return {
    key: fixture.key || '(fixture)',
    total,
    requirementCoverage,
    requirementDetail: { total: acCov.total, covered: acCov.covered, uncovered: acCov.uncovered },
    groundingValidity,
    groundingDetail,
    duplicateRate,
    duplicateCount,
    precision,
    recall,
    falseMerges,
    scoreable,
    unscoreableReason,
    score
  };
}

/** Default pass thresholds; callers (CLI) may override. */
const DEFAULT_THRESHOLDS = {
  requirementCoverage: 0.7,
  groundingValidity: 0.8,
  duplicateRate: 0.15, // max
  score: 70
  // NOTE (F20): precision/recall are deliberately NOT thresholded yet. They are
  // token-overlap proxies against a single hand-written expert suite; fix2.md §9
  // requires a representative labeled baseline (30-50 tickets) before any
  // threshold on them would mean anything. They are reported, not gated.
};

function evaluate(fixture, thresholds = DEFAULT_THRESHOLDS, opts = {}) {
  const m = scoreSuite(fixture, opts);
  const failures = [];

  // F20: never report a pass for something that was never actually judged.
  if (!m.scoreable) {
    return { ...m, pass: false, failures: [`not scoreable: ${m.unscoreableReason}`] };
  }
  // A merged protected pair is a hard failure regardless of the aggregate score.
  if (m.falseMerges && m.falseMerges.length) {
    failures.push(`${m.falseMerges.length} false merge(s) of protected distinct pairs: ` +
      m.falseMerges.map(f => f.reason).join('; '));
  }
  if (m.requirementCoverage != null && m.requirementCoverage < thresholds.requirementCoverage)
    failures.push(`requirementCoverage ${(m.requirementCoverage * 100).toFixed(0)}% < ${(thresholds.requirementCoverage * 100).toFixed(0)}%`);
  if (m.groundingValidity != null && m.groundingValidity < thresholds.groundingValidity)
    failures.push(`groundingValidity ${(m.groundingValidity * 100).toFixed(0)}% < ${(thresholds.groundingValidity * 100).toFixed(0)}%`);
  if (m.duplicateRate > thresholds.duplicateRate)
    failures.push(`duplicateRate ${(m.duplicateRate * 100).toFixed(0)}% > ${(thresholds.duplicateRate * 100).toFixed(0)}%`);
  if (m.score < thresholds.score)
    failures.push(`score ${m.score} < ${thresholds.score}`);
  return { ...m, pass: failures.length === 0, failures };
}

module.exports = { scoreSuite, evaluate, DEFAULT_THRESHOLDS };
