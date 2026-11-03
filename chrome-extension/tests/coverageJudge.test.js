/**
 * Coverage beyond word overlap:
 *  - CoverageMapper: stems match across word forms; a criterion's distinctive words
 *    must appear, so shared ticket vocabulary alone does not credit it;
 *  - CoverageJudge: a meaning-based verdict per criterion, conservative on failure;
 *  - PlannerAgent: a "complete" stop is vetoed while the judge finds open criteria.
 */
const CoverageMapper = require('../coverage-mapper.js');
const { judgeCoverage, applyJudgement } = require('../coverage-judge.js');
const { PlannerAgent } = require('../agent-loop.js');
const { AgentToolRegistry } = require('../agent-tools.js');
const { AcceptanceGate } = require('../acceptance-gate.js');
const { GroundedVerifier } = require('../grounded-verifier.js');
const SemanticDuplicateDetector = require('../semantic-duplicate-detector.js');
const { deriveDistribution, allocateCounts } = require('../dynamic-distribution.js');

const tc = (id, title, expected, steps = ['Open the members page']) => ({ id, title, expected_result: expected, steps });

describe('CoverageMapper word matching', () => {
  test('word forms match: invites / invited / invite', () => {
    const r = CoverageMapper.mapAcceptanceCriteria(
      [tc('T-1', 'Admin invites members from a CSV', 'Every member is invited')],
      ['Admins can invite members from a CSV file']);
    expect(r.covered).toBe(1);
  });

  test('sharing only common ticket words does not cover a criterion', () => {
    const items = ['Admins can invite members from a CSV file',
      'The invite dialog lets the admin choose a role for invited members'];
    const r = CoverageMapper.mapAcceptanceCriteria(
      [tc('T-1', 'Admin invites members from a CSV', 'Every member in the CSV is invited')], items);
    expect(r.details[0].covered).toBe(true);
    expect(r.details[1].covered).toBe(false); // nothing about choosing a role
  });

  test('stems that differ only in suffix still match (pagination / paginates)', () => {
    const r = CoverageMapper.mapAcceptanceCriteria(
      [tc('T-1', 'Chat list paginates after 20 sessions', 'More sessions load after the first 20')],
      ['Pagination of chat list (~20).', 'The chat list shows each session name']);
    expect(r.details[0].covered).toBe(true);
  });
});

describe('CoverageJudge', () => {
  const tests = [tc('T-1', 'Admin invites from CSV', 'All rows invited'), tc('T-2', 'Viewer cannot invite', 'Invite is blocked')];
  const criteria = ['Admins can invite from a CSV', 'Viewers cannot invite', 'Admin chooses a role'];

  test('parses verdicts and ignores uncited "covered" claims', async () => {
    const ai = async () => JSON.stringify({ criteria: [
      { c: 0, verdict: 'covered', tests: ['T-1'] },
      { c: 1, verdict: 'covered', tests: ['T-99'] },   // cites a test that does not exist
      { c: 2, verdict: 'uncovered', tests: [] },
      { c: 7, verdict: 'covered', tests: ['T-1'] }     // out of range: ignored
    ] });
    const j = await judgeCoverage(tests, criteria, { summary: 'Invite' }, ai);
    expect(j.ran).toBe(true);
    expect(j.verdicts.get(0).verdict).toBe('covered');
    expect(j.verdicts.get(1).verdict).toBe('uncovered');
    expect(j.verdicts.has(7)).toBe(false);
  });

  test('a failed or unparseable call is reported, never treated as approval', async () => {
    expect((await judgeCoverage(tests, criteria, {}, async () => { throw new Error('429'); })).ran).toBe(false);
    expect((await judgeCoverage(tests, criteria, {}, async () => 'no json')).unavailableReason).toMatch(/no parseable/);
    expect((await judgeCoverage(tests, criteria, {}, null)).ran).toBe(false);
  });

  test('applyJudgement overrides word matches both ways and lists what it overruled', () => {
    const ac = CoverageMapper.mapAcceptanceCriteria(tests, criteria);
    const verdicts = new Map([[0, { verdict: 'uncovered', tests: [] }], [2, { verdict: 'covered', tests: ['T-1'] }]]);
    const out = applyJudgement(ac, { ran: true, verdicts });
    expect(out.details[0].covered).toBe(false);
    expect(out.details[2].covered).toBe(true);
    expect(out.details[2].matchType).toBe('judged');
    expect(out.details[1].covered).toBe(ac.details[1].covered); // no verdict: word result kept
    expect(out.overruled.map(o => o.index).sort()).toEqual([0, 2]);
    expect(applyJudgement(ac, { ran: false })).toBe(ac);
  });
});

describe('PlannerAgent with a coverage judge', () => {
  const KG = { pages: [{ url: 'https://app.example.com/login', title: 'Login',
    features: [{ type: 'form', selector: '#login-form', inputs: [{ name: 'username' }, { name: 'password' }] },
               { type: 'button', text: 'Sign In', selector: '#signin' }],
    apis: [{ method: 'POST', endpoint: '/api/auth/login' }] }] };
  const TICKET = { summary: 'User login', acceptanceCriteria: 'Users can sign in with username and password' };
  let gid = 0;
  const ai = async (system) => {
    if (!system.includes('generating GROUNDED')) return 'not json'; // force the deterministic controller
    gid++;
    return JSON.stringify([{ title: `Sign in with username and password ${gid}`, category: 'Positive', priority: 'P1',
      steps: [`Enter user${gid} in the username field`, 'Enter a password in the password field', 'Click "Sign In"'],
      expected_result: `User ${gid} is signed in with username and password` }]);
  };
  const build = (coverageJudge) => {
    const settings = { llmProvider: 'test' };
    const gate = new AcceptanceGate({ knowledgeGraph: KG, ticketData: TICKET, deps: { GroundedVerifier, SemanticDuplicateDetector } });
    const tools = new AgentToolRegistry({ callAI: ai, settings, ticketData: TICKET, knowledgeGraph: KG, CoverageMapper,
      coverageMapper: new CoverageMapper({ ...KG, forms: [], apis: KG.pages[0].apis, features: [] }),
      verifierIndex: new GroundedVerifier(KG).index, getAcceptedTests: () => gate.getAccepted() });
    return new PlannerAgent({ callAI: ai, settings, tools, gate, ticketData: TICKET,
      distribution: deriveDistribution(TICKET), allocateCounts, coverageJudge,
      budget: { maxSteps: 20, maxTests: 8, coverageTarget: 10, maxNoProgress: 6, batchSize: 1 } });
  };

  test('a judge that finds an open criterion vetoes the stop, then the run completes', async () => {
    let calls = 0;
    const judge = async (tests, criteria) => {
      calls++;
      const verdict = calls === 1 ? 'uncovered' : 'covered';
      return { ran: true, verdicts: new Map(criteria.map((_, i) => [i, { verdict, tests: [tests[0] && tests[0].id].filter(Boolean) }])) };
    };
    const planner = build(judge);
    const before = { accepted: 0 };
    const result = await planner.run();
    expect(calls).toBe(2);
    expect(result.testCases.length).toBeGreaterThan(before.accepted + 1); // the veto produced another proposal
    expect(planner.lastJudgement.ran).toBe(true);
  });

  test('a judge that never agrees is bounded and cannot loop forever', async () => {
    let calls = 0;
    const judge = async (_tests, criteria) => {
      calls++;
      return { ran: true, verdicts: new Map(criteria.map((_, i) => [i, { verdict: 'uncovered', tests: [] }])) };
    };
    await build(judge).run();
    expect(calls).toBeLessThanOrEqual(2);
  });
});
