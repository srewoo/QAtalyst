/**
 * readiness.js (§15.3 + §15.6) — is a case actually runnable, and what do we
 * still need to know?
 *
 * §15.3 An observable expected result is not enough. A case is only executable
 *       when the state it needs can be ESTABLISHED: a usable role, a starting
 *       state, a data partition, an action, an observation method. "Verify the
 *       API times out" is unrunnable without a way to induce the timeout; a
 *       migration case needs a pre-migration fixture. Cases were previously all
 *       presented as ready.
 *
 * §15.6 When a missing fact decides an expected result, the useful output is a
 *       specific question tied to that obligation — not a guessed assertion.
 *       Unanswered questions become an unresolved-obligation ledger rather than
 *       silently-invented specifics.
 *
 * Pure logic.
 */
(function () {

/** Things a test cannot do to itself without help. */
const INDUCED_CONDITIONS = [
  { re: /\btime(?:s|d)? out|timeout\b/i, need: 'a way to induce the timeout (fault injection, a stubbed slow endpoint)' },
  { re: /\b(?:server|service) (?:error|down|unavailable)|50\d\b/i, need: 'a way to force the server error' },
  { re: /\boffline|no network|network (?:error|failure)\b/i, need: 'a way to simulate loss of connectivity' },
  { re: /\bconcurrent|race condition|simultaneous\b/i, need: 'a way to drive two actions concurrently' },
  { re: /\bmigrat(?:ed|ion)|legacy (?:user|record|data)|pre-existing\b/i, need: 'a pre-migration fixture' },
  { re: /\bexpired?\b.*\b(?:token|session|card|trial)\b/i, need: 'a way to age or pre-expire the record' },
  { re: /\brate.?limit|throttl\w+|429\b/i, need: 'a way to exceed the rate limit deliberately' },
  // Only an assertion about DELIVERY needs the channel. Matching bare "email"
  // flagged every login test that types an email address as un-runnable.
  { re: /\b(?:receives?|received|sent|sends?|delivered?|arrives?)\s+(?:an?\s+)?(?:email|sms|otp|text message|notification)\b|\b(?:email|sms|otp)\s+(?:is\s+)?(?:sent|received|delivered)\b/i,
    need: 'access to the delivery channel to observe the message' }
];

const ROLE_RE = /\b(admin(?:istrator)?|owner|viewer|editor|guest|anonymous|member|manager|superuser|unauthenticated)\b/i;
const STATE_RE = /\b(given|precondition|already|existing|logged in|signed in|has (?:an?|been)|is (?:in|on|at)|with (?:an?|the))\b/i;

/**
 * @param {object} testCase
 * @param {object} [context] { hasRoleMatrix, hasFixtures }
 * @returns {{level, blockers, missing}} level: automation_ready | manual_ready | specification_only
 */
function assessExecutability(testCase, context = {}) {
  const tc = testCase || {};
  const steps = Array.isArray(tc.steps) ? tc.steps : [];
  const pre = String(tc.preconditions || '');
  const data = String(tc.test_data || tc.testData || '');
  const expected = String(tc.expected_result || tc.expectedResult || '');
  const whole = [tc.title, tc.description, pre, data, expected, ...steps].filter(Boolean).join(' ');

  const missing = [];
  const blockers = [];

  if (!steps.length) missing.push('no steps — nothing to perform');
  if (!expected.trim()) missing.push('no expected result — nothing to assert');

  // A role-sensitive case must say which role runs it.
  if (ROLE_RE.test(whole) && !ROLE_RE.test(pre) && !steps.some(s => ROLE_RE.test(String(s)))) {
    missing.push('the acting role is referenced but never established in preconditions or steps');
  }
  // A case that depends on existing state must say how that state is reached.
  if (STATE_RE.test(expected) && !pre.trim()) {
    missing.push('asserts an outcome that depends on starting state, but declares no preconditions');
  }
  // Data-driven cases need a partition, not a vague noun.
  if (/\b(invalid|valid|boundary|maximum|minimum|limit|empty|duplicate)\b/i.test(whole) && !data.trim()) {
    missing.push('references a data condition but supplies no test data');
  }

  for (const c of INDUCED_CONDITIONS) {
    if (c.re.test(whole)) blockers.push(`requires ${c.need}`);
  }

  // §15.3: three honest levels instead of one implied "ready".
  let level;
  if (missing.length) level = 'specification_only';
  else if (blockers.length) level = 'manual_ready';
  else level = 'automation_ready';

  return { level, blockers, missing };
}

/**
 * §15.6: a specific, answerable question for an obligation whose expected result
 * the evidence does not settle — with the cases that depend on the answer, so a
 * reviewer can see the cost of leaving it open.
 *
 * @param {Array} requirements predicate records
 * @param {Array} testCases
 * @returns {Array<{id, question, blocks, requirementId, priority}>}
 */
function clarificationQuestions(requirements, testCases) {
  const out = [];
  const cases = testCases || [];

  for (const req of requirements || []) {
    const text = String(req.text || '');
    const dependents = cases
      .filter(t => Array.isArray(t.requirementIds) && t.requirementIds.includes(req.id))
      .map(t => t.title);

    // A numeric limit with no stated inclusivity decides three boundary cases.
    const limit = text.match(/\b(?:more|less|greater|fewer|up to|at least|at most|above|below|over|under|max(?:imum)?|min(?:imum)?)\s+than?\s*([\d.,]+\s*\w*)|\b([\d.,]+\s*(?:kb|mb|gb|characters?|chars?|items?|rows?|users?|days?|minutes?|seconds?))\b/i);
    if (limit && !/\binclusive|exclusive|or (?:more|less|fewer|equal)|\band (?:above|below)\b/i.test(text)) {
      out.push({
        id: `Q-${req.id}-BOUND`,
        requirementId: req.id,
        question: `Is the limit in "${clip(text, 80)}" inclusive or exclusive?`,
        why: 'It decides whether the at-limit value passes or fails, and therefore what the boundary cases assert.',
        blocks: dependents,
        priority: 'high'
      });
    }

    // A prohibition with no stated actor leaves the permission matrix open.
    if (req.modality === 'must_not' && !req.actor) {
      out.push({
        id: `Q-${req.id}-ACTOR`,
        requirementId: req.id,
        question: `Who exactly is prevented by "${clip(text, 80)}" — which roles?`,
        why: 'Without the role, an allowed case and a denied case cannot be distinguished.',
        blocks: dependents,
        priority: 'high'
      });
    }

    if (req.status === 'ambiguous') {
      out.push({
        id: `Q-${req.id}-AMBIG`,
        requirementId: req.id,
        question: `"${clip(text, 80)}" is not settled — what is the expected behaviour?`,
        why: 'Marked TBD/unclear in the ticket; any assertion here would be invented.',
        blocks: dependents,
        priority: 'medium'
      });
    }

    // Retry/idempotency is a classic unstated obligation.
    if (/\bretr(?:y|ies)|resubmit|double.?(?:click|submit)\b/i.test(text) && !/\bidempotent|only once|single\b/i.test(text)) {
      out.push({
        id: `Q-${req.id}-IDEM`,
        requirementId: req.id,
        question: `Should a retry of "${clip(text, 60)}" create a second record, or is it idempotent?`,
        why: 'It decides whether the retry case asserts one record or two.',
        blocks: dependents,
        priority: 'medium'
      });
    }
  }

  // Highest-uncertainty first, and never ask the same thing twice.
  const seen = new Set();
  return out
    .filter(q => { const k = q.question.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (b.blocks.length - a.blocks.length) || (a.priority === 'high' ? -1 : 1));
}

/**
 * §15.6: obligations left unresolved because a question is unanswered. The suite
 * must not claim complete mandatory coverage while these are outstanding.
 */
function unresolvedLedger(requirements, questions, answers = {}) {
  const answered = new Set(Object.keys(answers || {}));
  return (questions || [])
    .filter(q => !answered.has(q.id))
    .map(q => ({
      requirementId: q.requirementId,
      question: q.question,
      blocks: q.blocks,
      requirement: (requirements || []).find(r => r.id === q.requirementId)?.text || ''
    }));
}

function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

const api = { assessExecutability, clarificationQuestions, unresolvedLedger, INDUCED_CONDITIONS };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') Object.assign(self, api);
if (typeof window !== 'undefined') Object.assign(window, api);
})();
