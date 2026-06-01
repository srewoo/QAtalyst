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
