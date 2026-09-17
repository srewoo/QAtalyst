/**
 * test-case-finalizer.js (F03 + F04) — the ONE validation boundary every
 * generation route passes through.
 *
 * Before this, relevance, uniqueness and structural sanity depended on which
 * mode the user happened to have enabled: only the agentic path ran the
 * AcceptanceGate, while the single-call path, the streaming path and review
 * regeneration parsed model output and returned it verbatim. Regenerating a
 * previously gated suite could therefore reintroduce duplicates, half-written
 * cases and assertions about entities that do not exist.
 *
 * Pipeline: normalize aliases → validate schema → gate (grounding + relevance +
 * scenario-aware dedup) → report.
 *
 * Deliberately synchronous and dependency-injected so it is unit-testable and
 * safe to call from the service worker on every route.
 *
 * F03 completion: the assertion critic now runs here too, via the optional
 * `critique` hook, so an inverted or unsupported expected result is caught on
 * EVERY route rather than only the agentic one. It is optional and async: when no
 * hook is supplied the suite is returned with an explicit degradation saying
 * assertions were not reviewed, never silently as if they had been.
 */
(function () {

const CATEGORIES = ['Positive', 'Negative', 'Edge', 'Functional', 'Regression', 'Security', 'Performance', 'Accessibility', 'Integration', 'Usability'];
const PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'Critical', 'High', 'Medium', 'Low'];

const MAX = { title: 300, step: 600, text: 2000, steps: 40 };

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const clip = (v, n) => (str(v).length > n ? str(v).slice(0, n) : str(v));

/**
 * F04: one canonical shape. The single-call prompt asks for
 * `expectedResult`/`testData` while grounding, coverage and similarity all read
 * `expected_result`/`test_data` — so on that route every oracle was invisible to
 * every quality check. Both spellings are written back out so neither the
 * checks nor the existing UI/export code has to change.
 *
 * Object-shaped steps ({action, expected}) are flattened rather than stringified
 * into "[object Object]".
 */
function normalizeTestCase(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const steps = (Array.isArray(raw.steps) ? raw.steps : [])
    .map(s => {
      if (typeof s === 'string') return clip(s, MAX.step);
      if (s && typeof s === 'object') {
        return clip([s.action || s.step || s.description, s.expected || s.expectedResult]
          .filter(Boolean).join(' → '), MAX.step);
      }
      return '';
    })
    .filter(Boolean)
    .slice(0, MAX.steps);

  const expected = clip(raw.expected_result ?? raw.expectedResult ?? raw.expected, MAX.text);
  const testData = clip(raw.test_data ?? raw.testData, MAX.text);
  const category = str(raw.category);
  const priority = str(raw.priority);

  return {
    ...raw,
    // F04: ALWAYS our own ID. Models reuse and collide on ids, and the batch
    // detector used to treat matching ids as proof of duplication — so two
    // entirely different scenarios sharing an invented "TC-001" were merged.
    // The model's id is kept for traceability but is never identity.
    id: `TC-${String(index + 1).padStart(3, '0')}`,
    _modelId: str(raw.id) || undefined,
    title: clip(raw.title, MAX.title),
    description: clip(raw.description, MAX.text),
    preconditions: clip(raw.preconditions, MAX.text),
    steps,
    expected_result: expected,
    expectedResult: expected,
    test_data: testData,
    testData: testData,
    category: CATEGORIES.find(c => c.toLowerCase() === category.toLowerCase()) || category || 'Functional',
    priority: PRIORITIES.find(p => p.toLowerCase() === priority.toLowerCase()) || priority || 'P2'
  };
}

/**
 * Structural validity. The gate only required "a title OR a description", so a
 * bare `{title:'Login'}` was admitted as a finished test case.
 * @returns {string[]} field-level reasons; empty means valid.
 */
function schemaErrors(tc) {
  const errors = [];
  if (!tc.title) errors.push('title: required');
  if (!tc.steps.length) errors.push('steps: at least one actionable step required');
  // An expected result is the oracle. Without one the case cannot pass or fail,
  // so it is not a test — and we do NOT invent one.
  if (!tc.expected_result) errors.push('expected_result: required (no observable outcome to assert)');
  return errors;
}

/**
 * @param {Array} rawCases model output, already JSON-parsed
 * @param {object} opts
 * @param {object} opts.ticketData             ticket (for relevance)
 * @param {object|null} opts.knowledgeGraph    canonical graph (already normalized)
 * @param {Array}  [opts.existingTests]        existing suite to dedupe against
 * @param {object} opts.deps                   { AcceptanceGate, GroundedVerifier, SemanticDuplicateDetector }
 * @param {number} [opts.dedupThreshold] @param {number} [opts.relevanceThreshold]
 * @returns {{testCases:Array, rejected:Array, preservedDistinctions:Array, stats:object, degradations:string[]}}
 */
async function finalizeTestCases(rawCases, opts = {}) {
  const degradations = [];
  const rejected = [];
  const list = Array.isArray(rawCases) ? rawCases : [];

  // ── 1 + 2. normalize & validate ──
  const valid = [];
  list.forEach((raw, i) => {
    const tc = normalizeTestCase(raw, i);
    if (!tc) {
      rejected.push({ test: raw, stage: 'schema', reason: 'not a test-case object' });
      return;
    }
    const errors = schemaErrors(tc);
    if (errors.length) {
      rejected.push({ test: tc, stage: 'schema', reason: errors.join('; ') });
      return;
    }
    valid.push(tc);
  });
  if (rejected.length) {
    degradations.push(`${rejected.length} generated case(s) were structurally invalid and dropped (missing title, steps or expected result).`);
  }

  // ── 3. grounding + relevance + dedup ──
  const { AcceptanceGate, GroundedVerifier, SemanticDuplicateDetector } = opts.deps || {};
  if (!AcceptanceGate) {
    // Never silently skip the gate: say so instead of implying a clean suite.
    degradations.push('Quality gate unavailable — cases were schema-validated only, not checked for grounding, relevance or duplication.');
    return { testCases: valid, rejected, preservedDistinctions: [], stats: { accepted: valid.length, schema: rejected.length }, degradations };
  }

  const gate = new AcceptanceGate({
    knowledgeGraph: opts.knowledgeGraph || null,
    ticketData: opts.ticketData || {},
    deps: { GroundedVerifier, SemanticDuplicateDetector },
    dedupThreshold: opts.dedupThreshold,
    relevanceThreshold: opts.relevanceThreshold,
    existingTests: opts.existingTests || []
  });
  const result = gate.admit(valid);

  const stats = { ...result.stats, schema: rejected.length };
  const allRejected = rejected.concat(result.rejected || []);
  if (stats.duplicate) degradations.push(`${stats.duplicate} duplicate case(s) removed.`);
  if (stats.relevance) degradations.push(`${stats.relevance} case(s) rejected as out of scope for this ticket.`);
  if (stats.grounding) degradations.push(`${stats.grounding} case(s) rejected for referencing app entities that do not exist.`);
  const unresolved = result.accepted.filter(t => t._grounding === 'unresolved').length;
  if (unresolved) degradations.push(`${unresolved} case(s) reference entities that could not be resolved against the crawl — review before executing.`);

  let finalCases = result.accepted;

  // ── 4. assertion critique (F03 + F11) ──
  if (typeof opts.critique === 'function' && finalCases.length) {
    try {
      const critique = await opts.critique(finalCases);
      if (critique && critique.ran) {
        finalCases = critique.tests;
        const v = critique.byVerdict || {};
        if (v.contradictory) degradations.push(`${v.contradictory} case(s) assert an outcome that contradicts the ticket or their own steps.`);
        if (v.unverifiable) degradations.push(`${v.unverifiable} case(s) have an expected result that is not observable.`);
        if (v.unknown) degradations.push(`${v.unknown} case(s) assert behaviour the ticket does not settle — confirm before executing.`);
        if (critique.unjudged) degradations.push(`${critique.unjudged} case(s) received no verdict from the assertion critic.`);
        stats.assertionFlagged = critique.flagged || 0;
      } else {
        degradations.push(`Expected results were not reviewed by the assertion critic (${(critique && critique.unavailableReason) || 'unavailable'}) — inverted or unsupported outcomes may be present.`);
      }
    } catch (e) {
      degradations.push(`The assertion critic failed (${e.message}) — expected results are unchecked.`);
    }
  } else if (finalCases.length) {
    // Never let silence read as verification.
    degradations.push('Expected results were not reviewed by an assertion critic on this route — check them before executing.');
  }

  return {
    testCases: finalCases,
    rejected: allRejected,
    preservedDistinctions: result.preservedDistinctions || [],
    stats,
    degradations
  };
}

const api = { finalizeTestCases, normalizeTestCase, schemaErrors };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') Object.assign(self, api);
})();
