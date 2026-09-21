/**
 * F03/F04 — the shared finalization boundary. Every generation route
 * (single-call, streaming, agentic, review regeneration) runs these same
 * candidates through these same checks, so quality no longer depends on which
 * mode the user has enabled.
 */
const { finalizeTestCases, normalizeTestCase, schemaErrors } = require('../test-case-finalizer.js');
const { AcceptanceGate } = require('../acceptance-gate.js');
const { GroundedVerifier } = require('../grounded-verifier.js');
const SemanticDuplicateDetector = require('../semantic-duplicate-detector.js');

const DEPS = { AcceptanceGate, GroundedVerifier, SemanticDuplicateDetector };
const TICKET = { summary: 'User login', description: 'Users sign in with email and password.' };
const run = (cases, extra = {}) => finalizeTestCases(cases, {
  ticketData: TICKET, knowledgeGraph: null, deps: DEPS, relevanceThreshold: 0, ...extra
});

describe('F04 — canonical schema', () => {
  test('rejects the shapes that used to slip through', async () => {
    const r = await run([
      null,
      'a string',
      [1, 2],
      { title: 'Login' },                                  // no steps, no oracle
      { title: 'Login', steps: ['Click login'] },          // no expected result
      { steps: ['x'], expected_result: 'y' }               // no title
    ]);
    expect(r.testCases).toHaveLength(0);
    expect(r.rejected).toHaveLength(6);
    for (const rej of r.rejected) {
      expect(rej.stage).toBe('schema');
      expect(rej.reason).toBeTruthy();  // field-level reason, not a crash
    }
  });

  test('reconciles the expectedResult / expected_result alias split', () => {
    // The single-call prompt asks for expectedResult; grounding, coverage and
    // similarity all read expected_result. Both are written.
    const tc = normalizeTestCase({ title: 'T', steps: ['s'], expectedResult: 'ok', testData: 'd' }, 0);
    expect(tc.expected_result).toBe('ok');
    expect(tc.expectedResult).toBe('ok');
    expect(tc.test_data).toBe('d');
    expect(tc.testData).toBe('d');
    expect(schemaErrors(tc)).toEqual([]);
  });

  test('flattens object-shaped steps instead of stringifying them', () => {
    const tc = normalizeTestCase({
      title: 'T', expected_result: 'ok',
      steps: [{ action: 'Click Save', expected: 'Saved' }, 'Plain step']
    }, 0);
    expect(tc.steps[0]).toBe('Click Save → Saved');
    expect(tc.steps.join(' ')).not.toContain('[object Object]');
  });

  test('assigns stable IDs independent of model-supplied ones', async () => {
    const r = await run([
      { id: 'SAME', title: 'Login with valid credentials', steps: ['Enter email', 'Enter password'], expected_result: 'Dashboard is shown' },
      { id: 'SAME', title: 'Login fails with a locked account', steps: ['Enter locked email'], expected_result: 'Account locked error is shown' }
    ]);
    // Duplicate model IDs must not collapse two different scenarios.
    expect(r.testCases).toHaveLength(2);
    expect(r.testCases[0].id).not.toBe(r.testCases[1].id);
  });

  test('never fabricates a missing oracle', async () => {
    const r = await run([{ title: 'Login', steps: ['Click login'] }]);
    expect(r.testCases).toHaveLength(0);
    expect(r.rejected[0].reason).toMatch(/expected_result/);
  });
});

describe('F03 — one decision for every route', () => {
  const FIXTURES = [
    { title: 'Login with valid credentials', steps: ['Enter email', 'Enter password', 'Click Login'], expected_result: 'The dashboard is displayed' },
    { title: 'Log in using valid credentials', steps: ['Enter email', 'Enter password', 'Click Login'], expected_result: 'The dashboard is displayed' }, // duplicate
    { title: 'Login', steps: [] },                                                                     // malformed
    { title: 'Login is denied for a locked account', steps: ['Enter locked email', 'Click Login'], expected_result: 'An account-locked error is shown' }
  ];

  test('duplicates collapse, malformed cases are dropped, distinct cases survive', async () => {
    const r = await run(FIXTURES);
    const titles = r.testCases.map(t => t.title);
    expect(titles).toContain('Login with valid credentials');
    expect(titles).toContain('Login is denied for a locked account');
    expect(r.testCases).toHaveLength(2);
    expect(r.stats.schema).toBe(1);
    expect(r.stats.duplicate).toBe(1);
  });

  test('an edit that reintroduces a duplicate into a clean suite is caught', async () => {
    const clean = (await run(FIXTURES)).testCases;
    // Simulate review regeneration returning the suite plus a paraphrase.
    const edited = clean.concat([{
      title: 'Valid credentials log the user in',
      steps: ['Enter email', 'Enter password', 'Click Login'],
      expected_result: 'The dashboard is displayed'
    }]);
    const r = await run(edited);
    expect(r.testCases).toHaveLength(clean.length);
    expect(r.stats.duplicate).toBeGreaterThan(0);
  });

  test('the result reports what was removed rather than presenting a clean suite', async () => {
    const r = await run(FIXTURES);
    expect(r.degradations.join(' ')).toMatch(/duplicate/i);
    expect(r.degradations.join(' ')).toMatch(/structurally invalid/i);
  });

  test('a missing gate is reported, never silently skipped', async () => {
    const r = await finalizeTestCases(
      [{ title: 'T', steps: ['s'], expected_result: 'ok' }],
      { ticketData: TICKET, deps: {} }
    );
    expect(r.degradations.join(' ')).toMatch(/Quality gate unavailable/);
  });
});

describe('F03 — the assertion critic runs on every route', () => {
  const GOOD = [{ title: 'Login works', steps: ['Click Login'], expected_result: 'Signed in' }];

  test('a contradictory assertion is flagged on a non-agentic route', async () => {
    const r = await finalizeTestCases(GOOD, {
      ticketData: TICKET, deps: DEPS, relevanceThreshold: 0,
      critique: async (cases) => ({
        ran: true, flagged: 1, unjudged: 0,
        byVerdict: { supported: 0, contradictory: 1, unverifiable: 0, unknown: 0 },
        tests: cases.map(c => ({ ...c, _assertionStatus: 'contradictory' }))
      })
    });
    expect(r.degradations.join(' ')).toMatch(/contradicts/);
    expect(r.testCases[0]._assertionStatus).toBe('contradictory');
  });

  test('no critic hook means the suite says assertions are unchecked', async () => {
    const r = await finalizeTestCases(GOOD, { ticketData: TICKET, deps: DEPS, relevanceThreshold: 0 });
    // Silence must never read as verification.
    expect(r.degradations.join(' ')).toMatch(/not reviewed by an assertion critic/);
  });

  test('a failing critic is reported, not swallowed', async () => {
    const r = await finalizeTestCases(GOOD, {
      ticketData: TICKET, deps: DEPS, relevanceThreshold: 0,
      critique: async () => { throw new Error('provider 500'); }
    });
    expect(r.degradations.join(' ')).toMatch(/provider 500/);
    expect(r.testCases).toHaveLength(1); // tests survive; only the claim is withdrawn
  });
});
