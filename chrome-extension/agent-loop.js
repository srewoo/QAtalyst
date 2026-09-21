/**
 * Planner Agent Loop  (observe → decide → act)
 *
 * The heart of the agentic redesign. Instead of a fixed Phase1→2→3 pipeline, one
 * orchestrating LLM is given a tool catalogue and a goal, and decides each step
 * what to do: search the app, inspect an element, propose tests for an
 * under-covered category, crawl deeper into a gap, or finish.
 *
 * Every test a tool proposes is funnelled through the AcceptanceGate (grounding +
 * relevance + dedup) before it counts — so the loop physically cannot accumulate
 * duplicate or irrelevant tests. Coverage is re-measured as tests accumulate and
 * fed back into the next decision: this is the closed coverage feedback loop.
 *
 * Reliability: the loop NEVER depends on the LLM behaving. If the model returns
 * malformed output or stalls, a deterministic controller takes the next sensible
 * action (propose tests for the most under-target category, or crawl the biggest
 * gap). This guarantees forward progress and makes the loop unit-testable with a
 * scripted or even a broken callAI.
 *
 * Version: 1.0.0
 */

class PlannerAgent {
  /**
   * @param {object} cfg
   * @param {Function} cfg.callAI         async (system, userContent[], settings) => string
   * @param {object}   cfg.settings
   * @param {object}   cfg.tools          AgentToolRegistry
   * @param {object}   cfg.gate           AcceptanceGate (stateful accepted set)
   * @param {object}   cfg.ticketData
   * @param {object}   cfg.distribution   { weights, primary } from deriveDistribution()
   * @param {object}   [cfg.budget]       { maxSteps, maxTests, coverageTarget, maxNoProgress }
   * @param {Function} [cfg.onProgress]   (event) => void
   * @param {Function} [cfg.allocateCounts] (weights, total) => {cat:count}
   * @param {Function} [cfg.isCancelled]  () => bool
   */
  constructor(cfg = {}) {
    this.callAI = cfg.callAI;
    this.settings = cfg.settings || {};
    this.tools = cfg.tools;
    this.gate = cfg.gate;
    this.ticketData = cfg.ticketData || {};
    this.distribution = cfg.distribution || { weights: {}, primary: 'generic' };
    this.onProgress = cfg.onProgress || (() => {});
    this.isCancelled = cfg.isCancelled || (() => false);
    this.allocateCounts = cfg.allocateCounts ||
      (typeof self !== 'undefined' && self.DynamicDistribution && self.DynamicDistribution.allocateCounts) ||
      defaultAllocate;

    const b = cfg.budget || {};
    this.budget = {
      maxSteps: b.maxSteps ?? 22,
      maxTests: b.maxTests ?? 35,
      coverageTarget: b.coverageTarget ?? 80,
      maxNoProgress: b.maxNoProgress ?? 4,
      // F12: this defaulted to HALF the count budget and gated the coverage-target
      // stop, so a ticket with three real obligations could not finish with three
      // strong tests — it had to keep generating until it hit the floor, which is
      // exactly how filler gets made. A count is a ceiling; the floor is 1.
      minTests: b.minTests ?? 1,
      // How many tests to request per proposal call. Larger batches mean fewer
      // sequential round-trips, which is what dominates on a slow/local model.
      batchSize: b.batchSize ?? 5
    };

    this.targets = this.allocateCounts(this.distribution.weights, this.budget.maxTests);
    this.transcript = [];
    this.lastCoverage = null;
    this.lastObservation = null;
    this.noProgressStreak = 0;
    this.parseFailures = 0;
    // F12: 'complete' | 'budget_exhausted' | 'no_novel_scenarios' | 'cancelled' |
    // 'missing_evidence' | 'steps_exhausted' — never left implicit.
    this.stopReason = null;
  }

  /** Run the loop to completion. Returns the final, gated test suite + diagnostics. */
  async run() {
    this.emit({ phase: 'start', targets: this.targets, distribution: this.distribution });

    for (let step = 1; step <= this.budget.maxSteps; step++) {
      if (this.isCancelled()) { this.stopReason = 'cancelled'; this.emit({ phase: 'cancelled', step }); break; }
      if (this.shouldStop()) break;

      const decision = await this.decide(step);
      this.transcript.push({ step, ...decision });
      this.emit({ phase: 'step', step, tool: decision.tool, thought: clip(decision.thought, 160), input: decision.input });

      if (decision.tool === 'finish') {
        // F12: completion is the CONTROLLER's call, not the model's. A
        // model-selected finish used to break immediately, so a run could declare
        // itself done with a mandatory acceptance criterion still uncovered.
        const outstanding = await this.outstandingObligations();
        if (outstanding.length && this.gate.getAccepted().length < this.budget.maxTests) {
          this.stopReason = null;
          this.emit({ phase: 'step', step, tool: 'finish-rejected',
            thought: `${outstanding.length} obligation(s) still uncovered` });
          // Aim the next round at the first uncovered obligation instead.
          const observation = await this.act({
            tool: 'propose_tests',
            input: {
              category: this.categoryForObligation(),
              count: Math.min(this.budget.batchSize, this.remainingBudget()),
              focus: `Acceptance criterion: ${outstanding[0]}`
            }
          });
          this.lastObservation = { tool: 'propose_tests', observation };
          continue;
        }
        this.stopReason = 'complete';
        this.emit({ phase: 'finish', step, reason: decision.input?.reason });
        break;
      }

      const observation = await this.act(decision);
      this.lastObservation = { tool: decision.tool, observation };

      this.emit({
        phase: 'observation', step, tool: decision.tool,
        accepted: this.gate.getAccepted().length,
        summary: summarizeObservation(decision.tool, observation)
      });
    }

    // Safety net: if the planner produced nothing, try a direct generation pass
    // before giving up (covers "model only explored" and "early rejections").
    if (this.gate.getAccepted().length === 0 && !this.isCancelled()) {
      await this.rescue();
    }

    const accepted = this.gate.getAccepted();
    const finalCoverage = await this.measureCoverage();
    this.emit({ phase: 'done', accepted: accepted.length, coverage: finalCoverage?.coveragePercent });

    return {
      testCases: accepted,
      coverage: finalCoverage,
      distribution: this.distribution,
      targets: this.targets,
      stats: {
        ...this.gate.stats,
        toolCalls: this.tools.callCount,
        steps: this.transcript.length,
        aiError: this.tools.lastError || null
      },
      // F12: an explicit stop reason — complete / budget_exhausted /
      // no_novel_scenarios / cancelled / steps_exhausted.
      stopReason: this.stopReason || 'steps_exhausted',
      // Which measure the Coverage Target was actually judged against, so a
      // setting that could not be evaluated is visible rather than silently inert.
      coverageBasis: this.coverageBasis || null,
      coverageTarget: this.budget.coverageTarget,
      rejected: this.gate.rejected,
      // F05/F15: near-duplicate pairs the gate deliberately KEPT apart, so a
      // reviewer can audit every merge decision rather than trusting the count.
      preservedDistinctions: this.gate.preservedDistinctions || [],
      transcript: this.transcript
    };
  }

  // ───────────────────────── decide ─────────────────────────

  /** Ask the LLM what to do next; fall back to a deterministic controller on failure. */
  async decide(step) {
    let llmDecision = null;
    if (typeof this.callAI === 'function') {
      const raw = await safeAsync(() => this.callAI(this.systemPrompt(), [{ type: 'text', text: this.statePrompt(step) }], this.settings), null);
      llmDecision = parseDecision(raw);
      if (!llmDecision) this.parseFailures++;
    }
    // Validate the LLM's chosen tool exists; otherwise fall back.
    const validTools = new Set(this.tools.getToolSpecs().map(t => t.name));
    if (llmDecision && validTools.has(llmDecision.tool)) {
      return { ...llmDecision, source: 'llm' };
    }
    return { ...this.deterministicDecision(), source: 'fallback' };
  }

  /** Deterministic next action — guarantees progress without a cooperative LLM. */
  deterministicDecision() {
    // If we've stalled or hit enough coverage, finish.
    if (this.shouldStop(true)) return { tool: 'finish', input: { reason: 'budget or coverage reached' }, thought: 'deterministic stop' };

    // Close the coverage feedback loop even without a cooperative LLM: re-measure
    // coverage once we have some tests, and again every few accepted tests, so the
    // next propose_tests can be aimed at the biggest real gap.
    const accepted = this.gate.getAccepted().length;
    const sinceCheck = accepted - (this._coverageCheckedAt ?? -Infinity);
    if (accepted > 0 && (this.lastCoverage == null || sinceCheck >= 5)) {
      this._coverageCheckedAt = accepted;
      return { tool: 'run_coverage_check', input: {}, thought: 'refresh coverage to target the biggest gap' };
    }

    // F12: OBLIGATIONS FIRST. Category deficits used to drive the loop, so the
    // planner wrote tests to fill a quota before it wrote the test a still-
    // uncovered acceptance criterion demanded — and a simple ticket could never
    // finish small, because half the count budget was a floor.
    const ac = this.lastCoverage?.acCoverage;
    const room = this.remainingBudget();
    if (ac && ac.applicable && room > 0) {
      const gap = (Array.isArray(ac.uncovered) && ac.uncovered[0] && ac.uncovered[0].text) || '';
      if (gap) {
        return {
          tool: 'propose_tests',
          input: { category: this.categoryForObligation(), count: Math.min(this.budget.batchSize, ac.total - ac.covered, room),
                   focus: `Acceptance criterion: ${gap}` },
          thought: `cover AC (${ac.covered}/${ac.total})`
        };
      }
    }

    // Only once every known obligation is covered does the category distribution
    // get a say — and then only as a diagnostic nudge toward untested app areas,
    // never as work that must be manufactured to hit a number.
    const counts = this.categoryCounts();
    let pick = null, deficit = -Infinity;
    for (const [cat, target] of Object.entries(this.targets)) {
      const have = counts[cat] || 0;
      const d = target - have;
      if (d > deficit) { deficit = d; pick = cat; }
    }
    const featureGap = this.gapFocus();
    if (pick && deficit > 0 && room > 0 && featureGap) {
      return { tool: 'propose_tests', input: { category: pick, count: Math.min(this.budget.batchSize, deficit, room), focus: featureGap },
               thought: `untested area: ${pick} (${deficit} short)` };
    }

    this.stopReason = 'complete';
    return { tool: 'finish', input: { reason: 'all known obligations covered' }, thought: 'obligations met' };
  }

  // ───────────────────────── act ─────────────────────────

  async act(decision) {
    const before = this.gate.getAccepted().length;
    const observation = await this.tools.execute(decision.tool, decision.input || {});
    let result = observation;

    // Proposed tests must pass the acceptance gate before they count.
    if (decision.tool === 'propose_tests' && Array.isArray(observation.tests)) {
      // F12: counts are CEILINGS. Batches were admitted whole, so a 12-case
      // proposal with two budget slots left retained all 12 and blew the cap.
      const room = this.remainingBudget();
      const batch = room > 0 ? observation.tests.slice(0, room) : [];
      const admitted = this.gate.admit(batch);
      result = {
        category: observation.category,
        proposed: observation.tests.length,
        accepted: admitted.accepted.length,
        rejected: observation.tests.length - admitted.accepted.length,
        rejectReasons: tallyReasons(admitted.rejected.slice(-observation.tests.length)),
        gateStats: admitted.stats
      };
    } else if (decision.tool === 'run_coverage_check' && usableCoverage(observation)) {
      this.lastCoverage = observation;
    }

    // F12: progress is "the run learned or produced something", not "a test was
    // accepted this step". The old tool-agnostic counter treated a successful
    // bm25_search or element inspection as a stall, so four useful evidence-
    // gathering calls in a row ended the run — exactly when the planner was doing
    // the grounding work that makes proposals good. Only steps that yield NEITHER
    // an accepted test NOR new evidence count against the streak.
    const gained = this.gate.getAccepted().length - before;
    const gatheredEvidence = decision.tool !== 'propose_tests' &&
      result && !result.error && evidenceYield(decision.tool, result) > 0;
    this.noProgressStreak = (gained > 0 || gatheredEvidence) ? 0 : this.noProgressStreak + 1;
    return result;
  }

  /**
   * Last-resort generation if the planner produced nothing (e.g. the model only
   * explored, or early proposals were all rejected). Directly generates for the top
   * categories so we never silently return an empty suite when the LLM is healthy.
   */
  async rescue() {
    this.emit({ phase: 'rescue' });
    // F12: rescue must not resurrect a category the user disabled. `this.targets`
    // already reflects enabledCategories; the old hardcoded fallback ignored it.
    const cats = Object.keys(this.targets);
    if (!cats.length) {
      this.emit({ phase: 'stop', reason: 'no-enabled-categories' });
      return;
    }
    for (const cat of cats.slice(0, 4)) {
      if (this.isCancelled() || this.remainingBudget() <= 0) break;
      const obs = await safeAsync(() => this.tools.execute('propose_tests', { category: cat, count: this.budget.batchSize, focus: '' }), null);
      // Rescue is still bound by the ceiling.
      if (obs && Array.isArray(obs.tests)) this.gate.admit(obs.tests.slice(0, this.remainingBudget()));
    }
  }

  /**
   * F12: what MANDATORY work is still outstanding? Obligations — uncovered
   * acceptance criteria — not category quotas. A category deficit is a diagnostic;
   * an uncovered acceptance criterion is a promise the ticket made.
   * @returns {Promise<string[]>} uncovered requirement texts
   */
  async outstandingObligations() {
    // Measure fresh: the suite has changed since the last observation.
    const cov = await this.measureCoverage();
    const ac = (cov && cov.acCoverage) || this.lastCoverage?.acCoverage;
    if (!ac || !ac.applicable) return [];
    const uncovered = Array.isArray(ac.uncovered) ? ac.uncovered.map(u => u.text) : [];
    // F07: a CONTRADICTED criterion is outstanding too — worse than uncovered.
    const contradicted = Array.isArray(ac.contradictions) ? ac.contradictions.map(c => c.text) : [];
    return [...contradicted, ...uncovered].filter(Boolean);
  }

  /** Remaining room under the hard test ceiling. */
  remainingBudget() {
    return Math.max(0, this.budget.maxTests - this.gate.getAccepted().length);
  }

  /** A category to file an obligation-driven proposal under (targets are diagnostics). */
  categoryForObligation() {
    const counts = this.categoryCounts();
    const cats = Object.keys(this.targets);
    if (!cats.length) return 'Functional';
    // Prefer whichever enabled category is currently thinnest — spreads
    // obligation-driven work without letting a quota decide WHAT to write.
    return cats.reduce((a, b) => ((counts[a] || 0) <= (counts[b] || 0) ? a : b));
  }

  // ───────────────────────── stop logic ─────────────────────────

  shouldStop(silent = false) {
    const accepted = this.gate.getAccepted().length;
    // F12: record WHY the run ended, so the caller can distinguish "complete"
    // from "ran out of budget" from "stalled" instead of presenting every
    // outcome as a finished suite.
    if (accepted >= this.budget.maxTests) {
      this.stopReason = 'budget_exhausted';
      if (!silent) this.emit({ phase: 'stop', reason: 'maxTests' }); return true;
    }
    if (this.noProgressStreak >= this.budget.maxNoProgress) {
      this.stopReason = 'no_novel_scenarios';
      if (!silent) this.emit({ phase: 'stop', reason: 'no-progress' }); return true;
    }
    // The Coverage Target applies to FEATURE coverage when a usable crawl exists.
    // When it does not, coveragePercent is undefined and the target used to be
    // skipped entirely — so on a ticket whose feature is not yet built, the
    // planner ran to its full step budget even with every acceptance criterion
    // covered. Requirement coverage is the meaningful fallback: it is the
    // ticket-level promise, and it is what the user means by "covered" when
    // there is no app to measure against.
    const ac = this.lastCoverage?.acCoverage;
    const featureCov = this.lastCoverage?.coveragePercent;
    const requirementCov = (ac && ac.applicable && typeof ac.percentage === 'number')
      ? ac.percentage : null;

    const cov = (typeof featureCov === 'number') ? featureCov : requirementCov;
    this.coverageBasis = (typeof featureCov === 'number') ? 'features'
      : (requirementCov !== null ? 'requirements' : null);

    if (typeof cov === 'number' && cov >= this.budget.coverageTarget && accepted >= this.budget.minTests) {
      // F5: feature-coverage target reached — but don't declare done while the
      // ticket's acceptance criteria are still uncovered and budget remains. AC
      // coverage is the ticket-level promise and outranks the app-feature %.
      if (ac && ac.applicable && ac.covered < ac.total && accepted < this.budget.maxTests) {
        return false;
      }
      this.stopReason = 'complete';
      if (!silent) this.emit({ phase: 'stop', reason: 'coverage-target' });
      return true;
    }
    return false;
  }

  // ───────────────────────── prompts ─────────────────────────

  systemPrompt() {
    const toolList = this.tools.getToolSpecs().map(t => `- ${t.name}: ${t.description}`).join('\n');
    return [
      'You are the lead QA PLANNER orchestrating grounded test generation for a Jira ticket.',
      'Each turn you choose exactly ONE tool to call. Your objective:',
      'produce a set of test cases that (a) reference REAL app features, (b) are relevant to THIS ticket,',
      '(c) contain no duplicates, and (d) match the target category distribution — until the coverage',
      'target or the test budget is reached.',
      '',
      'Tools available:',
      toolList,
      '',
      'Strategy: use run_coverage_check to see untested features; use bm25_search/inspect_element to',
      'ground yourself before proposing; call propose_tests for the categories furthest below target;',
      'query_jira for regression history when proposing Regression tests.',
      'Proposed tests are auto-verified, dedup-checked and relevance-gated — focus on COVERAGE, not volume.',
      'Call finish when more tests would be redundant.',
      '',
      'Respond with ONLY a JSON object, no prose: {"thought": "...", "tool": "<name>", "input": { ... }}'
    ].join('\n');
  }

  statePrompt(step) {
    const counts = this.categoryCounts();
    const dist = Object.entries(this.targets)
      .map(([c, t]) => `${c}: ${counts[c] || 0}/${t}`).join(', ');
    const cov = this.lastCoverage
      ? `coverage ${this.lastCoverage.coveragePercent}% | ${this.lastCoverage.summary || ''}`
      : 'coverage: not yet measured';
    const lastObs = this.lastObservation
      ? `Last action: ${this.lastObservation.tool} → ${clip(JSON.stringify(this.lastObservation.observation), 500)}`
      : 'No actions yet.';
    return [
      `Step ${step}/${this.budget.maxSteps}. Accepted tests: ${this.gate.getAccepted().length}/${this.budget.maxTests}.`,
      `Ticket: ${clip(this.ticketData.summary || this.ticketData.title || '', 200)}`,
      `Primary ticket shape: ${this.distribution.primary}.`,
      `Category progress (have/target): ${dist}`,
      cov,
      lastObs,
      'Decide the single most useful next tool call.'
    ].join('\n');
  }

  // ───────────────────────── support ─────────────────────────

  categoryCounts() {
    const counts = {};
    for (const tc of this.gate.getAccepted()) {
      const c = tc.category || 'Positive';
      counts[c] = (counts[c] || 0) + 1;
    }
    return counts;
  }

  /** A focus string drawn from the biggest current coverage gap, if known. */
  gapFocus() {
    const gaps = this.lastCoverage?.criticalGaps || this.lastCoverage?.importantGaps || [];
    if (gaps.length) return `${gaps[0].type}: ${gaps[0].identifier} (${gaps[0].recommendation || 'untested'})`;
    return '';
  }

  async measureCoverage() {
    const obs = await safeAsync(() => this.tools.execute('run_coverage_check', {}), null);
    if (usableCoverage(obs)) this.lastCoverage = obs;
    return obs;
  }

  emit(event) {
    try {
      // Enrich every event with budget + live counts so the host UI can render a
      // meaningful progress bar (step/total) and running test count.
      this.onProgress({
        maxSteps: this.budget.maxSteps,
        maxTests: this.budget.maxTests,
        acceptedSoFar: this.gate.getAccepted().length,
        ...event
      });
    } catch (_) {}
  }
}

// ───────────────────────── parsing / utils ─────────────────────────

/**
 * F08: requirement coverage and app-feature coverage are INDEPENDENT. The
 * observation's `applicable:false` means only "no crawl graph, so feature
 * coverage is unmeasurable" — yet both call sites discarded the whole
 * observation, throwing away the acceptance-criteria coverage that was measured
 * from the ticket alone. On a ticket-only run the planner therefore never learned
 * which requirements were still uncovered, and `lastCoverage` stayed null.
 */
/**
 * F12: did a non-proposal step actually LEARN something? Used by the stall guard
 * so genuine evidence gathering counts as progress. A tool call that returns
 * nothing useful still counts against the streak — this rewards results, not
 * activity.
 */
function evidenceYield(tool, obs) {
  if (!obs || typeof obs !== 'object') return 0;
  switch (tool) {
    case 'bm25_search':      return Array.isArray(obs.results) ? obs.results.length : 0;
    case 'inspect_element':  return obs.found ? 1 : 0;
    case 'query_jira':       return Array.isArray(obs.issues) ? obs.issues.length : 0;
    case 'fetch_confluence': return obs.excerpt || obs.content ? 1 : 0;
    case 'run_coverage_check':
      // A coverage check earns progress only when it reveals a gap to aim at.
      return (Array.isArray(obs.criticalGaps) && obs.criticalGaps.length) ? 1 : 0;
    default: return 0;
  }
}

function usableCoverage(obs) {
  if (!obs) return false;
  if (obs.applicable !== false) return true;
  return !!(obs.acCoverage && obs.acCoverage.applicable);
}

function parseDecision(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let obj = null;
  if (typeof self !== 'undefined' && typeof self.parseRobustJSON === 'function') {
    obj = trySync(() => self.parseRobustJSON(raw));
  }
  if (!obj) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) obj = trySync(() => JSON.parse(m[0]));
  }
  if (!obj || typeof obj.tool !== 'string') return null;
  return { thought: obj.thought || '', tool: obj.tool.trim(), input: obj.input || obj.args || {} };
}

function tallyReasons(rejected) {
  const t = {};
  for (const r of rejected || []) t[r.stage] = (t[r.stage] || 0) + 1;
  return t;
}

function summarizeObservation(tool, obs) {
  if (!obs) return '';
  if (tool === 'propose_tests') return `+${obs.accepted} accepted, ${obs.rejected} rejected (${JSON.stringify(obs.rejectReasons || {})})`;
  if (tool === 'run_coverage_check') return obs.applicable === false ? 'no KG' : `${obs.coveragePercent}% covered`;
  if (obs.error) return `error: ${obs.error}`;
  return clip(JSON.stringify(obs), 160);
}

function defaultAllocate(weights, total) {
  const entries = Object.entries(weights || {});
  if (!entries.length) return { Positive: total };
  const counts = {}; let used = 0;
  entries.forEach(([c, w]) => { counts[c] = Math.floor(w * total); used += counts[c]; });
  let rem = total - used;
  const sorted = entries.sort((a, b) => (b[1] * total % 1) - (a[1] * total % 1));
  for (let i = 0; i < sorted.length && rem > 0; i++) { counts[sorted[i][0]]++; rem--; }
  return counts;
}

function clip(s, n) { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n) + '…' : s; }
function trySync(fn) { try { return fn(); } catch (_) { return null; } }
async function safeAsync(fn, fb = null) { try { return await fn(); } catch (_) { return fb; } }

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PlannerAgent, parseDecision, defaultAllocate, usableCoverage, evidenceYield };
}
if (typeof self !== 'undefined') {
  self.PlannerAgent = PlannerAgent;
}
