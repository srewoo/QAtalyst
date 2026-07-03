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
