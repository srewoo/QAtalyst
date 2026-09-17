/**
 * Tests for assertion-critic.js (G2) — the adversarial pass that flags inverted /
 * unverifiable / wrong expected results. callAI is stubbed so no model is used.
 */
const { critiqueAssertions, parseCriticJSON } = require('../assertion-critic.js');

const TESTS = [
  { title: 'Sidebar updates after delete', steps: ['delete a session'], expected_result: 'session is removed' },
  { title: 'Sidebar does NOT update after delete', steps: ['delete a session'], expected_result: 'the session is immediately removed' }, // inverted
  { title: 'Something happens', steps: ['do a thing'], expected_result: 'it works correctly' }, // unverifiable
];

// A stubbed model that flags index 1 (inverted) and 2 (unverifiable).
const stubCritic = async () => JSON.stringify({
  verdicts: [
    { i: 0, verdict: 'ok' },
    { i: 1, verdict: 'suspect', issue: 'title says does NOT update but expected says removed' },
    { i: 2, verdict: 'suspect', issue: 'unverifiable "it works"' },
  ],
});

describe('critiqueAssertions', () => {
  test('flags suspect tests non-destructively by default', async () => {
    const out = await critiqueAssertions(TESTS, { summary: 'chat sidebar' }, stubCritic);
    expect(out.ran).toBe(true);
    expect(out.flagged).toBe(2);
    expect(out.tests).toHaveLength(3); // nothing dropped
    expect(out.tests[0]._assertionWarning).toBeUndefined();
    expect(out.tests[1]._assertionWarning).toMatch(/does not update|removed/i);
    expect(out.tests[2]._assertionWarning).toBeTruthy();
  });

  test('strict mode drops suspect tests', async () => {
    const out = await critiqueAssertions(TESTS, {}, stubCritic, { assertionCriticStrict: true });
    expect(out.flagged).toBe(2);
    expect(out.tests).toHaveLength(1);
    expect(out.tests[0].title).toBe('Sidebar updates after delete');
  });

  test('disabled via setting → no-op', async () => {
    const out = await critiqueAssertions(TESTS, {}, stubCritic, { enableAssertionCritic: false });
    expect(out.ran).toBe(false);
    expect(out.tests).toHaveLength(3);
    expect(out.tests.every(t => !t._assertionWarning)).toBe(true);
  });

  test('critic failure (throwing model) returns tests unchanged', async () => {
    const boom = async () => { throw new Error('429'); };
    const out = await critiqueAssertions(TESTS, {}, boom);
    expect(out.ran).toBe(false);
    expect(out.tests).toHaveLength(3);
  });

  test('unparseable model output returns tests unchanged', async () => {
    const junk = async () => 'sorry, I cannot help with that';
    const out = await critiqueAssertions(TESTS, {}, junk);
    expect(out.ran).toBe(false);
    expect(out.flagged).toBe(0);
  });

  test('empty / missing input is a safe no-op', async () => {
    expect((await critiqueAssertions([], {}, stubCritic)).tests).toEqual([]);
    expect((await critiqueAssertions(null, {}, stubCritic)).tests).toEqual([]);
    expect((await critiqueAssertions(TESTS, {}, null)).ran).toBe(false);
  });

  test('tolerates a fenced/prose-wrapped JSON verdict', async () => {
    const fenced = async () => '```json\n{"verdicts":[{"i":1,"verdict":"suspect","issue":"inverted"}]}\n```';
    const out = await critiqueAssertions(TESTS, {}, fenced);
    expect(out.ran).toBe(true);
    expect(out.flagged).toBe(1);
    expect(out.tests[1]._assertionWarning).toBe('inverted');
  });
});

describe('parseCriticJSON', () => {
  test('parses plain, fenced, and prose-wrapped objects', () => {
    expect(parseCriticJSON('{"verdicts":[]}')).toEqual({ verdicts: [] });
    expect(parseCriticJSON('```json\n{"verdicts":[]}\n```')).toEqual({ verdicts: [] });
    expect(parseCriticJSON('here: {"verdicts":[{"i":0,"verdict":"ok"}]} done').verdicts).toHaveLength(1);
    expect(parseCriticJSON('not json')).toBeNull();
  });
});

describe('F11 — the critic sees the evidence, and its silence is not approval', () => {
  const TICKET = {
    summary: 'Invoice permissions',
    acceptanceCriteria: '- Viewer cannot delete invoices\n- Owner can delete invoices',
    // The decisive rule sits well past the old 1,500-character description clip.
    description: 'x'.repeat(1600) + '\nUploads above 100 KB must be rejected with a size error.'
  };
  const TESTS = [
    { title: 'Viewer deletes an invoice', steps: ['Log in as Viewer', 'Click Delete'],
      expected_result: 'The invoice is deleted', preconditions: 'An invoice exists', test_data: 'viewer@example.com' }
  ];

  const capture = () => {
    const seen = {};
    const callAI = async (system, content) => {
      seen.system = system;
      seen.user = content[0].text;
      return JSON.stringify({ verdicts: [{ i: 0, verdict: 'contradictory', issue: 'AC says a viewer cannot delete' }] });
    };
    return { seen, callAI };
  };

  test('sends the acceptance criteria, not just a clipped description', async () => {
    const { seen, callAI } = capture();
    await critiqueAssertions(TESTS, TICKET, callAI, {});
    // Pre-fix the dedicated AC field was never sent at all.
    expect(seen.user).toContain('Viewer cannot delete invoices');
    expect(seen.user).toContain('ACCEPTANCE CRITERIA');
  });

  test('a rule past character 1500 of the description is still visible', async () => {
    const { seen, callAI } = capture();
    await critiqueAssertions(TESTS, TICKET, callAI, {});
    expect(seen.user).toContain('Uploads above 100 KB must be rejected');
  });

  test('sends preconditions and test data — they decide whether an outcome is right', async () => {
    const { seen, callAI } = capture();
    await critiqueAssertions(TESTS, TICKET, callAI, {});
    expect(seen.user).toContain('An invoice exists');
    expect(seen.user).toContain('viewer@example.com');
  });

  test('reports four-valued verdicts rather than ok/suspect', async () => {
    const callAI = async () => JSON.stringify({ verdicts: [
      { i: 0, verdict: 'supported' }, { i: 1, verdict: 'contradictory', issue: 'inverted' },
      { i: 2, verdict: 'unverifiable', issue: 'vague' }, { i: 3, verdict: 'unknown', issue: 'not specified' }
    ] });
    const four = [0, 1, 2, 3].map(i => ({ title: `T${i}`, steps: ['x'], expected_result: 'y' }));
    const r = await critiqueAssertions(four, TICKET, callAI, {});
    expect(r.byVerdict).toEqual({ supported: 1, contradictory: 1, unverifiable: 1, unknown: 1 });
    expect(r.tests.map(t => t._assertionStatus))
      .toEqual(['supported', 'contradictory', 'unverifiable', 'unknown']);
  });

  test('strict mode drops contradictions but never "unknown"', async () => {
    const callAI = async () => JSON.stringify({ verdicts: [
      { i: 0, verdict: 'contradictory', issue: 'inverted' },
      { i: 1, verdict: 'unknown', issue: 'ticket is silent' }
    ] });
    const two = [{ title: 'A', steps: ['x'], expected_result: 'y' }, { title: 'B', steps: ['x'], expected_result: 'y' }];
    const r = await critiqueAssertions(two, TICKET, callAI, { assertionCriticStrict: true });
    // Deleting "unknown" would silently remove exactly the under-specified
    // behaviour a reviewer most needs to see.
    expect(r.tests.map(t => t.title)).toEqual(['B']);
  });

  test('a test with no verdict is marked unjudged, not approved', async () => {
    const callAI = async () => JSON.stringify({ verdicts: [{ i: 0, verdict: 'supported' }] });
    const two = [{ title: 'A', steps: ['x'], expected_result: 'y' }, { title: 'B', steps: ['x'], expected_result: 'y' }];
    const r = await critiqueAssertions(two, TICKET, callAI, {});
    expect(r.unjudged).toBe(1);
    expect(r.tests[1]._assertionStatus).toBe('unjudged');
    expect(r.tests[1]._assertionWarning).toMatch(/unchecked/);
  });

  test('critic unavailability is reported, so silence cannot imply verification', async () => {
    const failing = async () => { throw new Error('provider 500'); };
    const r = await critiqueAssertions(TESTS, TICKET, failing, {});
    expect(r.ran).toBe(false);
    expect(r.unavailableReason).toMatch(/provider 500/);

    const disabled = await critiqueAssertions(TESTS, TICKET, async () => '{}', { enableAssertionCritic: false });
    expect(disabled.unavailableReason).toMatch(/disabled/);

    const unparseable = await critiqueAssertions(TESTS, TICKET, async () => 'not json', {});
    expect(unparseable.ran).toBe(false);
    expect(unparseable.unavailableReason).toMatch(/no parseable verdicts/);
  });
});
