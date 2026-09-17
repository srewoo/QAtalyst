/**
 * review-memory.js (§15.1 + §15.2) — keep reviewer DECISIONS, and update a suite
 * when the requirements change instead of regenerating it wholesale.
 *
 * Regeneration previously took the previous output plus a free-text comment and
 * produced a fresh suite. Everything the reviewer had decided — that a scenario
 * is irrelevant, that two cases are genuinely distinct, that these steps are
 * correct and must not be touched — was discarded on every run, so the same
 * argument had to be had again each time.
 *
 * Two records:
 *   Decision — what a reviewer concluded about a scenario, scoped to a project
 *              and a requirement revision so it cannot leak across projects or
 *              outlive the requirement it was about.
 *   Manifest — what a run was generated FROM (ticket + requirement revisions,
 *              settings, model, gate version), so the next run can diff the
 *              requirements and touch only what actually changed.
 *
 * Storage is injected; pure logic otherwise.
 */
(function () {

const DECISIONS_KEY = 'qatalyst_review_decisions';
const MANIFEST_KEY = 'qatalyst_generation_manifests';

const VERDICTS = ['accepted', 'edited', 'duplicate_of', 'irrelevant',
                  'incorrect_expectation', 'missing_scenario', 'not_executable', 'distinct_from'];

/** Scenario identity for a decision — never the model's id. */
function scenarioKey(testCase) {
  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const steps = (Array.isArray(testCase.steps) ? testCase.steps : [])
    .map(s => norm(typeof s === 'string' ? s : (s && (s.action || s.step)) || '')).filter(Boolean);
  return [norm(testCase.title), steps.join('|')].join('::');
}

class ReviewMemory {
  /**
   * @param {object} storage { get(key), set(key, value) }
   * @param {string} scope  project/app scope — a decision must not cross projects
   */
  constructor(storage, scope) {
    this.storage = storage;
    this.scope = scope || 'default';
    this.decisions = new Map();
  }

  async load() {
    try {
      const all = (await this.storage.get(DECISIONS_KEY)) || {};
      const book = all[DECISIONS_KEY] || all || {};
      this.decisions = new Map(Object.entries(book[this.scope] || {}));
    } catch (_) { this.decisions = new Map(); }
    return this;
  }

  async save() {
    try {
      const all = (await this.storage.get(DECISIONS_KEY)) || {};
      const book = all[DECISIONS_KEY] || all || {};
      book[this.scope] = Object.fromEntries(this.decisions);
      await this.storage.set({ [DECISIONS_KEY]: book });
    } catch (e) { console.warn('[ReviewMemory] could not persist:', e.message); }
  }

  /**
   * @param {object} testCase
   * @param {string} verdict one of VERDICTS
   * @param {object} [meta] { reason, requirementIds, requirementRevision, relatedKey }
   */
  record(testCase, verdict, meta = {}) {
    if (!VERDICTS.includes(verdict)) throw new Error(`unknown verdict: ${verdict}`);
    this.decisions.set(scenarioKey(testCase), {
      verdict,
      reason: meta.reason || '',
      requirementIds: meta.requirementIds || testCase.requirementIds || [],
      // §15.1: a decision is about a requirement AS IT WAS. When the requirement
      // changes the decision is stale, not wrong — it must be re-reviewed rather
      // than silently applied to different behaviour.
      requirementRevision: meta.requirementRevision || null,
      relatedKey: meta.relatedKey || null,
      title: testCase.title,
      at: Date.now()
    });
  }

  get(testCase) { return this.decisions.get(scenarioKey(testCase)) || null; }

  /**
   * Apply remembered decisions to a freshly generated suite.
   *
   * §15.1: rejecting a scenario prevents its return on the SAME unchanged
   * requirement — but never globally, and never once the requirement has moved.
   *
   * @returns {{kept, suppressed, stale, locked}}
   */
  apply(testCases, opts = {}) {
    const currentRevision = opts.requirementRevision || null;
    const kept = [], suppressed = [], stale = [], locked = [];

    for (const tc of testCases || []) {
      const decision = this.get(tc);
      if (!decision) { kept.push(tc); continue; }

      const revisionMoved = decision.requirementRevision && currentRevision &&
        decision.requirementRevision !== currentRevision;
      if (revisionMoved) {
        // The requirement changed underneath the decision — re-review it.
        stale.push({ title: tc.title, verdict: decision.verdict, reason: decision.reason });
        kept.push({ ...tc, _decisionStale: true });
        continue;
      }

      if (decision.verdict === 'irrelevant' || decision.verdict === 'duplicate_of') {
        suppressed.push({ title: tc.title, verdict: decision.verdict, reason: decision.reason });
        continue;
      }
      if (decision.verdict === 'edited') {
        // §15.1: a manually edited case is LOCKED. Regeneration proposes changes;
        // it does not overwrite work a human already corrected.
        locked.push(tc.title);
        kept.push({ ...tc, _locked: true, _lockedReason: 'edited by a reviewer' });
        continue;
      }
      kept.push(tc);
    }
    return { kept, suppressed, stale, locked };
  }

  /** §15.1: a pair a reviewer declared distinct must never be merged again. */
  isProtectedPair(a, b) {
    const da = this.get(a), db = this.get(b);
    const ka = scenarioKey(a), kb = scenarioKey(b);
    return !!((da && da.verdict === 'distinct_from' && da.relatedKey === kb) ||
              (db && db.verdict === 'distinct_from' && db.relatedKey === ka));
  }
}

// ───────────────────────── §15.2 generation manifest ─────────────────────────

/**
 * What a run was generated from. Stored so the NEXT run can compare requirement
 * revisions and regenerate only the changed obligations and their impact area,
 * instead of replacing a suite whose case ids, destination links and execution
 * history are worth keeping.
 */
function buildManifest({ ticketKey, ticketRevision, requirements, settings, model, gateVersion, testCases }) {
  return {
    ticketKey: ticketKey || null,
    ticketRevision: ticketRevision || null,
    generatedAt: Date.now(),
    model: model || (settings && settings.llmModel) || null,
    gateVersion: gateVersion || 'v1',
    settings: settings ? {
      testCount: settings.testCount, coverageTarget: settings.coverageTarget,
      dedupThreshold: settings.dedupThreshold, relevanceThreshold: settings.relevanceThreshold,
      enabledCategories: settings.enabledCategories
    } : null,
    // The requirement inventory, hashed per obligation, is what makes a diff
    // possible: wording changes that do not change behaviour must not churn the suite.
    requirements: (requirements || []).map(r => ({
      id: r.id, hash: hashRequirement(r), status: r.status, modality: r.modality,
      operation: r.operation, actor: r.actor
    })),
    caseIds: (testCases || []).map(t => t.id).filter(Boolean)
  };
}

/**
 * Behaviour-bearing hash: ignores pure wording, reacts to meaning.
 * The operation is STEMMED — "uploads" and "upload" are the same obligation, and
 * treating them as different would flag a suite for update every time someone
 * rephrased a sentence.
 */
function stemOp(op) {
  return String(op || '').toLowerCase().replace(/(?:ies|ed|ing|es|s)$/, '').replace(/y$/, 'i');
}

function hashRequirement(r) {
  const meaning = [r.modality, r.actor || '', stemOp(r.operation),
    // Numbers matter: a changed limit is a changed obligation.
    (String(r.text || '').match(/\d+(?:[.,]\d+)?\s*[a-z%]*/gi) || []).join(',')
  ].join('|').toLowerCase();
  let h = 0;
  for (let i = 0; i < meaning.length; i++) { h = ((h << 5) - h + meaning.charCodeAt(i)) | 0; }
  return String(h >>> 0);
}

/**
 * §15.2: classify what changed between two runs.
 * @returns {{unchanged, updateRequired, newlyNeeded, possiblyObsolete}}
 */
function diffManifests(previous, current) {
  const prev = new Map(((previous && previous.requirements) || []).map(r => [r.id, r]));
  const curr = new Map(((current && current.requirements) || []).map(r => [r.id, r]));

  const unchanged = [], updateRequired = [], newlyNeeded = [], possiblyObsolete = [];
  for (const [id, r] of curr) {
    const before = prev.get(id);
    if (!before) { newlyNeeded.push(r); continue; }
    // Wording-only changes leave the hash alone, so they do not churn the suite.
    if (before.hash === r.hash) unchanged.push(r);
    else updateRequired.push({ ...r, was: before });
  }
  for (const [id, r] of prev) {
    if (!curr.has(id)) {
      // A proposed retirement must say WHICH requirement disappeared — deleting
      // the case automatically could remove real regression protection.
      possiblyObsolete.push({ ...r, reason: `requirement ${id} is no longer present in the ticket` });
    }
  }
  return { unchanged, updateRequired, newlyNeeded, possiblyObsolete };
}

const api = { ReviewMemory, scenarioKey, VERDICTS, buildManifest, diffManifests, hashRequirement, stemOp,
              DECISIONS_KEY, MANIFEST_KEY };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') Object.assign(self, api);
if (typeof window !== 'undefined') Object.assign(window, api);
})();
