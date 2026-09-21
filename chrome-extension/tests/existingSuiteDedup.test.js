/**
 * @vitest-environment happy-dom
 *
 * F14 — deduplication against the team's EXISTING suite.
 *
 * Before this, the feature was unreachable (the setting had no control and was
 * never loaded), the import read only the first page, every failure looked like
 * an empty project, and matching was exact-title only.
 */
const { createChromeMock } = require('./helpers/chrome-mock.js');
global.CONFIG = { MAX_TEXT_EXTRACT_LENGTH: 30000 };
global.chrome = createChromeMock();

const { TestRailIntegration } = require('../integrations.js');
const SemanticDuplicateDetector = require('../semantic-duplicate-detector.js');
global.SemanticDuplicateDetector = SemanticDuplicateDetector;

const SETTINGS = {
  testrailUrl: 'https://tr.example.com',
  testrailUsername: 'qa@example.com',
  testrailApiKey: 'key',
  testrailProjectId: '1'
};

const resp = (json, ok = true, status = 200) => ({
  ok, status, headers: { get: () => null }, json: async () => json, text: async () => ''
});
const makeCase = (id, title) => ({ id, title, custom_preconds: '', custom_steps: '' });

describe('F14 — importing the existing suite', () => {
  test('follows pagination instead of stopping at the first page', async () => {
    const page1 = Array.from({ length: 250 }, (_, i) => makeCase(i + 1, `Case ${i + 1}`));
    const page2 = [makeCase(251, 'Duplicate on page two')];
    global.fetch = vi.fn()
      .mockResolvedValueOnce(resp({ cases: page1, _links: { next: '/next' } }))
      .mockResolvedValueOnce(resp({ cases: page2, _links: { next: null } }));

    const tr = new TestRailIntegration(SETTINGS);
    const res = await tr.getCases();

    expect(res.ok).toBe(true);
    expect(res.pages).toBe(2);
    expect(res.cases).toHaveLength(251);
    // Pre-fix this case was invisible, so it would be proposed and uploaded again.
    expect(res.cases.some(c => c.title === 'Duplicate on page two')).toBe(true);
  });

  test('a failed import is reported as failure, never as "no existing cases"', async () => {
    global.fetch = vi.fn().mockResolvedValue(resp(null, false, 401));
    const res = await new TestRailIntegration(SETTINGS).getCases();
    // Pre-fix: returned [] — indistinguishable from a project with no tests,
    // so every generated case looked unique.
    expect(res.ok).toBe(false);
    expect(res.cases).toEqual([]);
    expect(res.error).toMatch(/401/);
  });

  test('keeps the fields needed to compare behaviour, not just titles', () => {
    const c = TestRailIntegration.normalizeExistingCase({
      id: 42, title: 'Login works', custom_preconds: 'User is registered',
      custom_steps_separated: [
        { content: 'Enter valid credentials', expected: 'Fields accept input' },
        { content: 'Click Login', expected: 'Dashboard is shown' }
      ],
      refs: 'PROJ-1'
    });
    expect(c.id).toBe('C42');
    expect(c.steps).toEqual(['Enter valid credentials', 'Click Login']);
    expect(c.expected_result).toContain('Dashboard is shown');
    expect(c.preconditions).toBe('User is registered');
    expect(c.refs).toBe('PROJ-1');
  });

  test('handles an unpaginated bare-array response from older instances', async () => {
    global.fetch = vi.fn().mockResolvedValue(resp([makeCase(1, 'Only case')]));
    const res = await new TestRailIntegration(SETTINGS).getCases();
    expect(res.ok).toBe(true);
    expect(res.cases).toHaveLength(1);
  });
});

describe('F14 — upload deduplication', () => {
  const tr = () => {
    const t = new TestRailIntegration(SETTINGS);
    t.rateLimitedFetch = global.fetch;
    return t;
  };

  test('catches a paraphrased duplicate with a different title', async () => {
    global.fetch = vi.fn().mockResolvedValue(resp({
      cases: [{
        id: 7, title: 'Successful user login',
        custom_steps_separated: [{ content: 'Enter valid email', expected: '' },
                                 { content: 'Enter valid password', expected: '' },
                                 { content: 'Click Login', expected: 'The dashboard is displayed' }]
      }]
    }));
    const r = await tr().deduplicateTestCases(1, [{
      title: 'User logs in successfully',
      steps: ['Enter valid email', 'Enter valid password', 'Click Login'],
      expected_result: 'The dashboard is displayed'
    }]);
    expect(r.toAdd).toHaveLength(0);
    expect(r.skipped[0].reason).toMatch(/Equivalent/);
  });

  test('preserves a same-titled case whose behaviour differs', async () => {
    global.fetch = vi.fn().mockResolvedValue(resp({
      cases: [{ id: 8, title: 'Delete invoice', custom_steps: 'Log in as Owner\nClick Delete',
                custom_expected: 'The invoice is deleted' }]
    }));
    const r = await tr().deduplicateTestCases(1, [{
      title: 'Delete invoice as viewer',
      steps: ['Log in as Viewer', 'Click Delete'],
      expected_result: 'Deletion is denied'
    }]);
    // Opposite outcome + different actor — must survive.
    expect(r.toAdd).toHaveLength(1);
  });

  test('two duplicates within one batch do not both get created', async () => {
    global.fetch = vi.fn().mockResolvedValue(resp({ cases: [{ id: 1, title: 'Unrelated existing case' }] }));
    const r = await tr().deduplicateTestCases(1, [
      { title: 'Login works', steps: ['Click Login'], expected_result: 'Signed in' },
      { title: 'Login works', steps: ['Click Login'], expected_result: 'Signed in' }
    ]);
    // Pre-fix the map was never extended with in-batch candidates.
    expect(r.toAdd).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
  });

  test('an unreadable existing suite is flagged, not treated as empty', async () => {
    global.fetch = vi.fn().mockResolvedValue(resp(null, false, 500));
    const r = await tr().deduplicateTestCases(1, [{ title: 'Anything', steps: ['x'], expected_result: 'y' }]);
    expect(r.importOk).toBe(false);
    expect(r.toAdd).toHaveLength(1); // still uploads, but the caller knows
  });
});
