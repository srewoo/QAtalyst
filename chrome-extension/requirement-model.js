/**
 * requirement-model.js (F07 §7.1) — atomic requirement predicates.
 *
 * Coverage used to be measured against raw requirement STRINGS, so an AC was
 * "covered" when enough of its tokens appeared somewhere in a test. That cannot
 * distinguish a test that establishes the condition and asserts the outcome from
 * one that merely mentions the same nouns — and it cannot see that a compound AC
 * ("an owner can delete, a viewer cannot") carries two obligations, of which a
 * suite may satisfy one.
 *
 * This turns each requirement into a record with a stable id, its source span,
 * an actor, a modality (must / must-not / may), an operation, a subject and an
 * expected predicate. Those ids are what a test links to, what an export cites,
 * and what a duplicate adjudicator reasons about.
 *
 * ponytail: lexical parsing, not NLU. It splits on conjunctions and reads cue
 * words; it will mis-parse deeply nested prose. It is deliberately conservative —
 * an unparseable requirement becomes ONE predicate with status 'ambiguous'
 * rather than being silently dropped or split into nonsense. Upgrade path is an
 * LLM extraction pass writing the same record shape.
 */
(function () {

const ACTOR_RE = /\b(admin(?:istrator)?|owner|viewer|editor|guest|anonymous|member|manager|superuser|customer|agent|reviewer|user|system|api)s?\b/i;

const NEGATIVE_RE = /\b(cannot|can't|cant|must not|should not|shouldn't|shall not|will not|won't|does not|doesn't|do not|don't|is not|isn't|are not|aren't|never|no longer|unable to|prevented from|denied|forbidden|prohibited|disallowed|blocked from|restricted from)\b/i;

/**
 * An explicit optionality MARKER qualifies the whole statement, so it must beat a
 * modal verb inside it. "Good to have: the chat should move up" is optional — the
 * `should` describes the behaviour, not its priority. Checking only
 * `OPTIONAL && !MANDATORY` let one `should` promote a nice-to-have into a
 * release obligation, which is precisely what fix2.md §7.1 forbids.
 */
const OPTIONAL_MARKER_RE = /\b(good to have|nice to have|optional|optionally|stretch goal|if time permits|future(?: release| enhancement)|out of scope for (?:this|now)|non[- ]blocking)\b/i;
const OPTIONAL_RE = /\b(may|can optionally|optionally|nice to have|good to have|could|preferably|ideally)\b/i;
const MANDATORY_RE = /\b(must|shall|should|will|is required to|needs? to|has to)\b/i;

const OPERATION_RE = /\b(creat\w*|add\w*|delet\w*|remov\w*|updat\w*|edit\w*|modif\w*|renam\w*|export\w*|import\w*|download\w*|upload\w*|archiv\w*|restor\w*|shar\w*|invit\w*|search\w*|filter\w*|sort\w*|view\w*|see|access\w*|submit\w*|approv\w*|reject\w*|cancel\w*|assign\w*|enabl\w*|disabl\w*|log ?in|log ?out|sign ?in|sign ?up|register|reset|navigat\w*|click\w*|select\w*|receiv\w*|send\w*|displa\w*|show\w*|hid\w*|validat\w*|verif\w*)\b/i;

/** Conjunctions that genuinely separate two obligations, not mere list items. */
const SPLIT_RE = /(?:;|\s+\band\b\s+(?=\w+\s+(?:can|cannot|must|should|shall|may|is|are|will)\b)|\s+\bbut\b\s+|,\s*(?=(?:and\s+)?\w+\s+(?:can|cannot|must|should|shall|may)\b))/i;

let counter = 0;
/** Stable-per-run id. Deterministic given the same ticket + order. */
function makeId(ticketKey, index) {
  return `${ticketKey || 'REQ'}-R${String(index + 1).padStart(3, '0')}`;
}

function detectModality(text) {
  if (NEGATIVE_RE.test(text)) return 'must_not';
  if (OPTIONAL_MARKER_RE.test(text)) return 'may';
  if (OPTIONAL_RE.test(text) && !MANDATORY_RE.test(text)) return 'may';
  return 'must';
}

function detectStatus(text) {
  if (/\b(tbd|tbc|to be (?:decided|confirmed)|\?\?|unclear|open question|needs? clarification)\b/i.test(text)) {
    return 'ambiguous';
  }
  if (/\b(out of scope|not in scope|won'?t (?:be )?(?:do|implement)|deferred|future release)\b/i.test(text)) {
    return 'out_of_scope';
  }
  if (/\b(superseded|replaced by|no longer applies|obsolete)\b/i.test(text)) return 'superseded';
  // Marker first: it qualifies the sentence regardless of the verb inside it.
  if (OPTIONAL_MARKER_RE.test(text)) return 'optional';
  if (OPTIONAL_RE.test(text) && !MANDATORY_RE.test(text)) return 'optional';
  return 'mandatory';
}

function firstMatch(re, text) {
  const m = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g').exec(text);
  return m ? m[0].toLowerCase() : null;
}

/**
 * The operation, excluding words that are really the ACTOR. `view\w*` happily
 * matches "viewer", so "a viewer cannot delete" reported its operation as
 * "viewer" — the actor masquerading as the verb it is forbidden from doing.
 */
function detectOperation(text, actor) {
  const re = new RegExp(OPERATION_RE.source, 'gi');
  let m;
  while ((m = re.exec(text)) !== null) {
    const word = m[0].toLowerCase();
    if (actor && word === actor) continue;              // "viewer" is the actor
    if (actor && word.startsWith(actor)) continue;      // "viewers"
    if (ACTOR_RE.test(word) && word.length <= 8) continue;
    return word;
  }
  return null;
}

/**
 * Split a compound requirement into atomic obligations.
 * "An owner can delete an invoice but a viewer cannot" → 2 predicates.
 */
function splitCompound(text) {
  const t = String(text || '').trim();
  if (t.length < 12) return [t];
  const parts = t.split(new RegExp(SPLIT_RE.source, 'gi'))
    .map(p => String(p || '').trim())
    .filter(p => p.replace(/[^a-z0-9]/gi, '').length >= 5);
  // Only treat it as compound when the split produced genuinely separate claims.
  return parts.length > 1 ? parts : [t];
}

/**
 * Build requirement predicates from harvested requirement strings.
 *
 * @param {string[]} items raw requirement lines (from CoverageMapper.extractRequirementItems)
 * @param {object} [opts] { ticketKey, source }
 * @returns {Array<object>} predicate records
 */
function buildRequirements(items, opts = {}) {
  const out = [];
  const list = Array.isArray(items) ? items : [];
  list.forEach((raw, sourceIndex) => {
    const text = String(raw || '').trim();
    if (!text) return;
    const atoms = splitCompound(text);
    let inheritedOperation = null;
    atoms.forEach((atom, atomIndex) => {
      const id = makeId(opts.ticketKey, out.length);
      const actor = firstMatch(ACTOR_RE, atom);
      // An elided clause ("…but a viewer cannot") carries no verb of its own; it
      // inherits the operation from the clause it was split from. Losing it would
      // make the prohibition unmatchable against any test.
      let operation = detectOperation(atom, actor);
      if (!operation && atomIndex > 0) operation = inheritedOperation;
      else if (operation) inheritedOperation = operation;

      out.push({
        id,
        text: atom,
        // Where this came from, so an export can cite it and a later revision can
        // tell whether THIS obligation changed.
        source: {
          type: opts.source || 'acceptance_criteria',
          index: sourceIndex,
          atom: atomIndex,
          // The full line the atom was split out of — the reviewable span.
          span: text
        },
        actor,
        modality: detectModality(atom),
        operation,
        status: detectStatus(atom),
        // A compound parent is recorded so "all obligations of this AC" can be
        // required together rather than one standing in for the rest.
        compound: atoms.length > 1,
        compoundOf: atoms.length > 1 ? `${opts.ticketKey || 'REQ'}-S${sourceIndex + 1}` : null
      });
    });
  });
  return out;
}

/**
 * Which predicates must be covered for the suite to claim completeness?
 * Optional, ambiguous, superseded and out-of-scope obligations are visible but
 * are NOT counted against completeness — reporting them as gaps trains people to
 * ignore the gap list.
 */
function mandatoryRequirements(reqs) {
  return (reqs || []).filter(r => r.status === 'mandatory');
}

/** Group compound atoms back to their source line, for "all branches covered". */
function groupCompound(reqs) {
  const groups = new Map();
  for (const r of reqs || []) {
    const key = r.compoundOf || r.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return groups;
}

const api = { buildRequirements, mandatoryRequirements, groupCompound, splitCompound, OPTIONAL_MARKER_RE,
              detectModality, detectStatus, detectOperation };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') Object.assign(self, api);
if (typeof window !== 'undefined') Object.assign(window, api);
})();
