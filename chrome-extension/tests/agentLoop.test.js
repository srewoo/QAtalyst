/**
 * Integration test for the agentic core: PlannerAgent + AgentToolRegistry +
 * AcceptanceGate + CoverageMapper, driven by a scripted callAI.
 *
 * Verifies:
 *  - the loop terminates within budget,
 *  - it only accepts grounded, non-duplicate tests,
 *  - the deterministic fallback fills the distribution even when the LLM is useless,
 *  - the coverage feedback loop runs.
 */
const { PlannerAgent } = require('../agent-loop.js');
const { AgentToolRegistry } = require('../agent-tools.js');
const { AcceptanceGate } = require('../acceptance-gate.js');
const { GroundedVerifier } = require('../grounded-verifier.js');
const SemanticDuplicateDetector = require('../semantic-duplicate-detector.js');
const CoverageMapper = require('../coverage-mapper.js');
const { deriveDistribution, allocateCounts } = require('../dynamic-distribution.js');

const KG = {
  pages: [{
    url: 'https://app.example.com/login',
    title: 'Login',
    features: [
      { type: 'form', selector: '#login-form', inputs: [{ name: 'username' }, { name: 'password' }] },
      { type: 'button', text: 'Sign In', selector: '#signin' }
    ],
    apis: [{ method: 'POST', endpoint: '/api/auth/login', url: 'https://app.example.com/api/auth/login' }]
  }]
};

const TICKET = {
  summary: 'Implement secure user login with username and password',
  description: 'Sign in with username + password. Invalid credentials show an error. Lock the account after 5 failed attempts. Enforce CSRF protection on the login form.'
};

// CoverageMapper expects the aggregated KG shape (top-level forms/apis). Provide both.
const KG_FOR_COVERAGE = {
  ...KG,
  forms: [{ id: '#login-form', url: '/login', inputs: [{ name: 'username' }, { name: 'password' }] }],
  apis: [{ method: 'POST', endpoint: '/api/auth/login', url: 'https://app.example.com/api/auth/login' }],
  features: [{ type: 'button', text: 'Sign In' }]
};

/**
 * Scripted callAI:
 *  - generation prompts → grounded test cases (referencing real fields/buttons)
 *  - planner-decision prompts → GARBAGE, to force the deterministic controller
 *    (this is the strongest robustness test).
 */
function makeFakeAI(opts = {}) {
  let gid = 0;
  return async (system) => {
    if (system.includes('generating GROUNDED')) {
      const m = system.match(/exactly (\d+) (\w+) test cases/);
      const count = m ? parseInt(m[1], 10) : 3;
      const category = m ? m[2] : 'Positive';
      const tests = [];
      for (let i = 0; i < count; i++) {
        gid++;
        // Optionally inject a duplicate to prove the gate filters it.
        const dupe = opts.injectDuplicate && gid === 2;
        tests.push({
          title: dupe ? 'Valid login succeeds' : `${category} login scenario ${gid}`,
          category,
          priority: 'P1',
          preconditions: 'User is on the login page',
          steps: [
            'Enter a valid value in the username field',
            'Enter a valid value in the password field',
            'Click "Sign In"'
          ],
          expected_result: dupe ? 'User is logged in' : `Outcome ${gid} is observed on /login`
        });
      }
      // first ever test is the canonical "Valid login succeeds" so the dupe collides
      if (gid <= count) tests[0] = { title: 'Valid login succeeds', category, priority: 'P1',
        steps: ['Enter a valid value in the username field', 'Enter a valid value in the password field', 'Click "Sign In"'],
        expected_result: 'User is logged in' };
      return JSON.stringify(tests);
    }
    return 'no json here, just rambling'; // force deterministic fallback for decisions
  };
}

function buildPlanner(callAI, budget = {}) {
  const settings = { llmProvider: 'test' };
  const distribution = deriveDistribution(TICKET);
  const gate = new AcceptanceGate({
    knowledgeGraph: KG, ticketData: TICKET,
    deps: { GroundedVerifier, SemanticDuplicateDetector }
  });
  const verifier = new GroundedVerifier(KG);
  const coverageMapper = new CoverageMapper(KG_FOR_COVERAGE);
  const tools = new AgentToolRegistry({
    callAI, settings, ticketData: TICKET, knowledgeGraph: KG,
    coverageMapper, verifierIndex: verifier.index,
    getAcceptedTests: () => gate.getAccepted()
  });
  return new PlannerAgent({
    callAI, settings, tools, gate, ticketData: TICKET, distribution,
    allocateCounts,
    budget: { maxSteps: 30, maxTests: 12, coverageTarget: 80, maxNoProgress: 6, ...budget }
  });
}

describe('PlannerAgent agentic loop', () => {
  test('terminates and produces grounded, non-duplicate tests via deterministic fallback', async () => {
    const planner = buildPlanner(makeFakeAI({ injectDuplicate: true }));
    const result = await planner.run();

    expect(result.testCases.length).toBeGreaterThan(0);
    expect(result.testCases.length).toBeLessThanOrEqual(12);

    // every accepted test was grounded (or grounding not applicable)
    result.testCases.forEach(tc => {
      expect(tc._groundingScore).toBeDefined();
    });

    // no two accepted tests are exact-title duplicates
    const titles = result.testCases.map(t => (t.title || '').toLowerCase());
    expect(new Set(titles).size).toBe(titles.length);

    // the gate recorded at least one duplicate rejection (we injected one)
    expect(result.stats.duplicate).toBeGreaterThanOrEqual(1);
  });

  test('runs the coverage feedback loop (coverage measured)', async () => {
    const planner = buildPlanner(makeFakeAI());
    const result = await planner.run();
    expect(result.coverage).toBeTruthy();
    expect(result.coverage.applicable).not.toBe(false);
    expect(typeof result.coverage.coveragePercent).toBe('number');
  });

  test('honours a small maxTests budget', async () => {
    const planner = buildPlanner(makeFakeAI(), { maxTests: 5 });
    const result = await planner.run();
    expect(result.testCases.length).toBeLessThanOrEqual(5);
  });

  test('rescue: still generates when the model only ever explores (never proposes)', async () => {
    // Decision AI always asks to run_coverage_check; generation AI works fine.
    const ai = async (system) => {
      if (system.includes('generating GROUNDED')) {
        return JSON.stringify([
          { title: 'Valid login', category: 'Positive', steps: ['Click "Sign In"'], expected_result: 'logged in' },
          { title: 'Bad password error', category: 'Negative', steps: ['Enter a wrong value in the password field', 'Click "Sign In"'], expected_result: 'error shown' }
        ]);
      }
      return '{"thought":"keep looking","tool":"run_coverage_check","input":{}}';
    };
    const planner = buildPlanner(ai, { maxSteps: 8 });
    const result = await planner.run();
    // The stall guard stops the explore-only loop, then rescue() generates.
    expect(result.testCases.length).toBeGreaterThan(0);
  });

  test('surfaces an AI error when generation calls throw (no silent zero)', async () => {
    const ai = async (system) => {
      if (system.includes('generating GROUNDED')) throw new Error('model gpt-5.2 not found for this API key');
      return 'garbage'; // force deterministic → propose_tests → throws
    };
    const planner = buildPlanner(ai, { maxNoProgress: 3, maxSteps: 6 });
    const result = await planner.run();
    expect(result.testCases.length).toBe(0);
    expect(result.stats.aiError).toBeTruthy();
    expect(result.stats.aiError.error).toMatch(/not found/);
  });

  test('follows an LLM that emits valid decisions', async () => {
    // A cooperative LLM: propose Positive once, then finish.
    let called = 0;
    const ai = async (system) => {
      if (system.includes('generating GROUNDED')) {
        return JSON.stringify([
          { title: 'Valid login', category: 'Positive', steps: ['Click "Sign In"'], expected_result: 'logged in' },
          { title: 'Login error on bad password', category: 'Negative', steps: ['Enter a value in the password field', 'Click "Sign In"'], expected_result: 'error shown' }
        ]);
      }
      called++;
      if (called === 1) return '{"thought":"start by generating","tool":"propose_tests","input":{"category":"Positive","count":2}}';
      return '{"thought":"enough","tool":"finish","input":{"reason":"done"}}';
    };
    const planner = buildPlanner(ai);
    const result = await planner.run();
    expect(result.testCases.length).toBeGreaterThan(0);
    expect(result.transcript.some(t => t.source === 'llm')).toBe(true);
  });
});

describe('F12 — planning is driven by obligations, not category quotas', () => {
  const { evidenceYield } = require('../agent-loop.js');

  test('a batch cannot overshoot the remaining test budget', async () => {
    // Propose 12 at a time against a budget of 5.
    const bigBatchAI = async (system) => {
      if (system.includes('generating GROUNDED')) {
        return JSON.stringify(Array.from({ length: 12 }, (_, i) => ({
          title: `Login scenario ${i} with distinct outcome ${i}`,
          category: 'Positive', priority: 'P1',
          steps: ['Enter a valid value in the username field', `Click "Sign In" attempt ${i}`],
          expected_result: `Outcome ${i} is observed on /login`
        })));
      }
      return 'rambling';
    };
    const planner = buildPlanner(bigBatchAI, { maxTests: 5, maxSteps: 6 });
    const result = await planner.run();
    // Pre-fix the whole batch was admitted, blowing straight past the cap.
    expect(result.testCases.length).toBeLessThanOrEqual(5);
  });

  test('evidence gathering counts as progress, not as a stall', () => {
    // Four useful retrieval calls used to trip the no-progress guard and end the
    // run — exactly while the planner was grounding itself.
    expect(evidenceYield('bm25_search', { results: [{ url: 'x' }] })).toBeGreaterThan(0);
    expect(evidenceYield('inspect_element', { found: true })).toBeGreaterThan(0);
    expect(evidenceYield('query_jira', { issues: [{ key: 'A-1' }] })).toBeGreaterThan(0);
    expect(evidenceYield('run_coverage_check', { criticalGaps: [{ type: 'ac' }] })).toBeGreaterThan(0);
    // A call that returned nothing useful still counts against the streak.
    expect(evidenceYield('bm25_search', { results: [] })).toBe(0);
    expect(evidenceYield('run_coverage_check', { criticalGaps: [] })).toBe(0);
    expect(evidenceYield('propose_tests', { tests: [] })).toBe(0);
  });

  test('a simple ticket can finish small — the count is a ceiling, not a quota', async () => {
    const planner = buildPlanner(makeFakeAI(), { maxTests: 30 });
    // Pre-fix minTests defaulted to half of maxTests (15), so the coverage-target
    // stop could not fire until filler had been generated to reach the floor.
    expect(planner.budget.minTests).toBe(1);
  });

  test('every run reports an explicit stop reason', async () => {
    const result = await buildPlanner(makeFakeAI(), { maxTests: 4, maxSteps: 10 }).run();
    expect(result.stopReason).toBeTruthy();
    expect(['complete', 'budget_exhausted', 'no_novel_scenarios', 'cancelled', 'steps_exhausted'])
      .toContain(result.stopReason);
  });

  test('rescue does not resurrect disabled categories', async () => {
    const asked = [];
    const ai = async (system) => {
      if (system.includes('generating GROUNDED')) {
        const m = system.match(/exactly (\d+) (\w+) test cases/);
        if (m) asked.push(m[2]);
        return '[]'; // never produce anything → forces rescue
      }
      return 'rambling';
    };
    const planner = buildPlanner(ai, { maxTests: 6, maxSteps: 3 });
    // Only Security is enabled for this run.
    planner.targets = { Security: 6 };
    await planner.run();
    // Pre-fix rescue fell back to a hardcoded ['Positive','Negative','Edge'].
    expect(asked.every(c => c === 'Security')).toBe(true);
  });
});

describe('Coverage Target is honoured, and says how', () => {
  const planner = (lastCoverage, coverageTarget = 90) => {
    const { PlannerAgent } = require('../agent-loop.js');
    const p = Object.create(PlannerAgent.prototype);
    return Object.assign(p, {
      gate: { getAccepted: () => Array(10).fill({}), stats: {} },
      budget: { maxTests: 30, minTests: 1, maxNoProgress: 4, coverageTarget },
      noProgressStreak: 0, lastCoverage, emit() {}
    });
  };

  test('feature coverage stops the run once the target is met', () => {
    expect(planner({ coveragePercent: 95 }).shouldStop(true)).toBe(true);
    expect(planner({ coveragePercent: 70 }).shouldStop(true)).toBe(false);
  });

  test('the configured value is what is compared against, not a constant', () => {
    expect(planner({ coveragePercent: 85 }, 80).shouldStop(true)).toBe(true);
    expect(planner({ coveragePercent: 85 }, 95).shouldStop(true)).toBe(false);
  });

  test('without a usable crawl it falls back to requirement coverage', () => {
    // Previously coveragePercent was undefined here, so the target was skipped
    // entirely and the planner ran to its full step budget even with every
    // acceptance criterion already covered.
    const p = planner({ applicable: false,
      acCoverage: { applicable: true, covered: 27, total: 27, percentage: 100 } });
    expect(p.shouldStop(true)).toBe(true);
    expect(p.coverageBasis).toBe('requirements');
  });

  test('the fallback still respects the target', () => {
    const p = planner({ applicable: false,
      acCoverage: { applicable: true, covered: 17, total: 27, percentage: 63 } });
    expect(p.shouldStop(true)).toBe(false);
  });

  test('feature coverage takes precedence when both are available', () => {
    const p = planner({ coveragePercent: 95,
      acCoverage: { applicable: true, covered: 27, total: 27, percentage: 100 } });
    p.shouldStop(true);
    expect(p.coverageBasis).toBe('features');
  });

  test('uncovered acceptance criteria still block an early stop', () => {
    // The ticket-level promise outranks the app-feature percentage.
    const p = planner({ coveragePercent: 99,
      acCoverage: { applicable: true, covered: 10, total: 27, percentage: 37 } });
    expect(p.shouldStop(true)).toBe(false);
  });

  test('an unmeasurable target is reported rather than silently ignored', () => {
    const p = planner({ applicable: false });
    p.shouldStop(true);
    expect(p.coverageBasis).toBeNull();
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'background.js'), 'utf8');
    expect(src).toMatch(/could not be applied/);
  });
});
