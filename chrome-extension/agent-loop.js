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
      minTests: b.minTests ?? Math.ceil((b.maxTests ?? 35) * 0.5)
    };

    this.targets = this.allocateCounts(this.distribution.weights, this.budget.maxTests);
    this.transcript = [];
    this.lastCoverage = null;
    this.lastObservation = null;
    this.noProgressStreak = 0;
    this.parseFailures = 0;
  }

  /** Run the loop to completion. Returns the final, gated test suite + diagnostics. */
  async run() {
    this.emit({ phase: 'start', targets: this.targets, distribution: this.distribution });

    for (let step = 1; step <= this.budget.maxSteps; step++) {
      if (this.isCancelled()) { this.emit({ phase: 'cancelled', step }); break; }
      if (this.shouldStop()) break;

      const decision = await this.decide(step);
      this.transcript.push({ step, ...decision });
      this.emit({ phase: 'step', step, tool: decision.tool, thought: clip(decision.thought, 160), input: decision.input });

      if (decision.tool === 'finish') {
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
      rejected: this.gate.rejected,
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

    // Find the category furthest below its target.
    const counts = this.categoryCounts();
    let pick = null, deficit = -Infinity;
    for (const [cat, target] of Object.entries(this.targets)) {
      const have = counts[cat] || 0;
      const d = target - have;
      if (d > deficit) { deficit = d; pick = cat; }
    }
    if (pick && deficit > 0) {
      const focus = this.gapFocus();
      return { tool: 'propose_tests', input: { category: pick, count: Math.min(5, deficit), focus }, thought: `fill ${pick} (${deficit} short)` };
    }
    return { tool: 'finish', input: { reason: 'all category targets met' }, thought: 'targets met' };
  }

  // ───────────────────────── act ─────────────────────────

  async act(decision) {
    const before = this.gate.getAccepted().length;
    const observation = await this.tools.execute(decision.tool, decision.input || {});
    let result = observation;

    // Proposed tests must pass the acceptance gate before they count.
    if (decision.tool === 'propose_tests' && Array.isArray(observation.tests)) {
      const admitted = this.gate.admit(observation.tests);
      result = {
        category: observation.category,
        proposed: observation.tests.length,
        accepted: admitted.accepted.length,
        rejected: observation.tests.length - admitted.accepted.length,
        rejectReasons: tallyReasons(admitted.rejected.slice(-observation.tests.length)),
        gateStats: admitted.stats
      };
    } else if (decision.tool === 'run_coverage_check' && observation && observation.applicable !== false) {
      this.lastCoverage = observation;
    }

    // Stall guard is tool-agnostic: ANY step that didn't add an accepted test counts
    // as no-progress; a step that adds tests resets it. This stops a model that just
    // keeps exploring (search/inspect/coverage) without ever proposing.
    const gained = this.gate.getAccepted().length - before;
    this.noProgressStreak = gained > 0 ? 0 : this.noProgressStreak + 1;
    return result;
  }

  /**
   * Last-resort generation if the planner produced nothing (e.g. the model only
   * explored, or early proposals were all rejected). Directly generates for the top
   * categories so we never silently return an empty suite when the LLM is healthy.
   */
  async rescue() {
    this.emit({ phase: 'rescue' });
    const cats = Object.keys(this.targets).length ? Object.keys(this.targets) : ['Positive', 'Negative', 'Edge'];
    for (const cat of cats.slice(0, 4)) {
      if (this.isCancelled() || this.gate.getAccepted().length >= this.budget.maxTests) break;
      const obs = await safeAsync(() => this.tools.execute('propose_tests', { category: cat, count: 5, focus: '' }), null);
      if (obs && Array.isArray(obs.tests)) this.gate.admit(obs.tests);
    }
  }

  // ───────────────────────── stop logic ─────────────────────────

  shouldStop(silent = false) {
    const accepted = this.gate.getAccepted().length;
    if (accepted >= this.budget.maxTests) { if (!silent) this.emit({ phase: 'stop', reason: 'maxTests' }); return true; }
    if (this.noProgressStreak >= this.budget.maxNoProgress) { if (!silent) this.emit({ phase: 'stop', reason: 'no-progress' }); return true; }
    const cov = this.lastCoverage?.coveragePercent;
    if (typeof cov === 'number' && cov >= this.budget.coverageTarget && accepted >= this.budget.minTests) {
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
      'when a coverage gap is on an un-crawled area, crawl_route into it; query_jira for regression history.',
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
    if (obs && obs.applicable !== false) this.lastCoverage = obs;
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
  module.exports = { PlannerAgent, parseDecision, defaultAllocate };
}
if (typeof self !== 'undefined') {
  self.PlannerAgent = PlannerAgent;
}
