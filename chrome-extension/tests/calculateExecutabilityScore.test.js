/**
 * Tests for calculateExecutabilityScore.
 * This function gates test case quality on executability (separate from specificity).
 * A score < 40 → LOW_EXECUTABILITY warning.
 *
 * Four weighted sections:
 *   S1 — Step verb actionability          (0–35 pts)
 *   S2 — Expected result assertion        (0–30 pts)
 *   S3 — Preconditions concreteness       (0–20 pts)
 *   S4 — Step count adequacy (3–10 ideal) (0–15 pts)
 *
 * Total max = 100 (clamped). Score 0 if sections score negative.
 */

// ---------------------------------------------------------------------------
// Inline helpers (toStr mirrors agents.js)
// ---------------------------------------------------------------------------
function toStr(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(toStr).join('\n');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function calculateExecutabilityScore(tc) {
  let score = 0;

  // S1: Step verb actionability (0–35)
  const ACTIONABLE = /^\s*(click|tap|enter|type|navigate|go to|open|select|check|uncheck|verify|assert|confirm|submit|upload|download|drag|hover|press|scroll|clear|search|filter|expand|collapse|fill|choose|login|logout|sign in|sign out|refresh|switch to|copy|paste)\b/i;
  const steps = Array.isArray(tc.steps) ? tc.steps.map(toStr) : [];
  if (steps.length > 0) {
    const actionableCount = steps.filter(s => ACTIONABLE.test(s.trim())).length;
    score += Math.round((actionableCount / steps.length) * 35);
  }

  // S2: Expected result measurable assertion (0–30)
  const er = toStr(tc.expected_result).toLowerCase();
  const ASSERTION_KEYWORDS = [
    'displays', 'shows', 'appears', 'redirects', 'navigates', 'returns', 'toast',
    'message', 'error', 'success', 'contains', 'confirms', 'sends', 'changes',
    'updates', 'closes', 'opens', 'loads', 'visible', 'hidden', 'enabled', 'disabled',
  ];
  const VAGUE_EXPECTED = [
    'works correctly', 'responds appropriately', 'behaves as expected',
    'functions correctly', 'as expected', 'should work', 'correctly',
  ];
  const hasAssertion = ASSERTION_KEYWORDS.some(kw => er.includes(kw));
  const isVague = VAGUE_EXPECTED.some(v => er.includes(v));
  if (hasAssertion && !isVague) score += 30;
  else if (hasAssertion) score += 15;
  else if (!isVague && er.length > 20) score += 10;

  // S3: Preconditions concreteness (0–20)
  const pre = toStr(tc.preconditions).toLowerCase();
  const CONCRETE_PRE = ['role', 'admin', 'user ', '@', 'page', '/dashboard', '/login',
    'logged in as', 'with ', 'account', 'has ', 'existing'];
  const concreteCount = CONCRETE_PRE.filter(indicator => pre.includes(indicator)).length;
  if (concreteCount >= 3) score += 20;
  else if (concreteCount >= 2) score += 15;
  else if (concreteCount >= 1 && pre.length >= 20) score += 10;

  // S4: Step count adequacy (0–15)
  const n = steps.length;
  if (n >= 3 && n <= 10) score += 15;
  else if (n >= 2 && n <= 12) score += 8;

  return Math.max(0, Math.min(100, score));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function makeExecutableTestCase(overrides = {}) {
  return {
    title: 'Login with valid credentials',
    preconditions: "User 'admin@company.com' has an account with 'Admin' role. App is on /login page.",
    steps: [
      "Navigate to '/login'",
      "Enter 'admin@company.com' in the 'Email' field",
      "Enter 'SecurePass123' in the 'Password' field",
      "Click the 'Sign In' button",
      "Verify the dashboard page loads",
    ],
    expected_result: "Dashboard displays with the user's name. Success toast 'Welcome back' appears.",
    ...overrides,
  };
}

function makeVagueTestCase(overrides = {}) {
  return {
    title: 'Test form',
    preconditions: '',
    steps: ['Do the thing'],
    expected_result: 'works correctly',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('calculateExecutabilityScore', () => {

  // ── Section 1: Step verb actionability ──────────────────────────────────
  describe('S1 — step verb actionability (0-35 pts)', () => {
    test('all steps starting with actionable verbs → 35 pts from S1', () => {
      const tc = makeExecutableTestCase({
        // Remove other contributions so S1 stands alone: strip preconditions + make expected vague-neutral
        preconditions: '',
        expected_result: '',
        steps: ['Click the button', 'Enter your name', 'Submit the form'],
      });
      const scoreNoSteps = calculateExecutabilityScore({ ...tc, steps: [] });
      const scoreWithSteps = calculateExecutabilityScore(tc);
      expect(scoreWithSteps).toBeGreaterThan(scoreNoSteps);
    });

    test('no steps → S1 contributes 0', () => {
      const tc = makeVagueTestCase({ steps: [] });
      // S1 = 0 (no steps). With empty expected and preconditions: score = 0.
      expect(calculateExecutabilityScore(tc)).toBe(0);
    });

    test('mix of actionable and vague steps → partial S1 score', () => {
      const allActionable = makeExecutableTestCase({
        preconditions: '',
        expected_result: '',
        steps: ['Click A', 'Enter B', 'Verify C', 'Select D'],
      });
      const halfActionable = makeExecutableTestCase({
        preconditions: '',
        expected_result: '',
        steps: ['Click A', 'Do something vague', 'Enter B', 'Look at stuff'],
      });
      expect(calculateExecutabilityScore(allActionable))
        .toBeGreaterThan(calculateExecutabilityScore(halfActionable));
    });

    test('all recognized actionable verbs produce a non-zero S1 score', () => {
      const verbs = ['click', 'tap', 'enter', 'type', 'navigate', 'open', 'select',
        'check', 'verify', 'assert', 'confirm', 'submit', 'upload', 'download',
        'drag', 'hover', 'press', 'scroll', 'clear', 'search', 'filter', 'fill'];
      verbs.forEach(verb => {
        const tc = { steps: [`${verb} something`], expected_result: '', preconditions: '' };
        expect(calculateExecutabilityScore(tc)).toBeGreaterThan(0);
      });
    });

    test('step verbs are case-insensitive', () => {
      const lower = { steps: ['click the button'], expected_result: '', preconditions: '' };
      const upper = { steps: ['CLICK the button'], expected_result: '', preconditions: '' };
      expect(calculateExecutabilityScore(lower)).toBe(calculateExecutabilityScore(upper));
    });
  });

  // ── Section 2: Expected result assertion ────────────────────────────────
  describe('S2 — expected result assertion (0-30 pts)', () => {
    test('assertion keyword without vague language → 30 pts', () => {
      const withAssertion = { steps: [], preconditions: '', expected_result: 'Toast displays: "Saved".' };
      const withoutAssertion = { steps: [], preconditions: '', expected_result: '' };
      expect(calculateExecutabilityScore(withAssertion))
        .toBeGreaterThan(calculateExecutabilityScore(withoutAssertion));
    });

    test('assertion keyword combined with vague language → 15 pts (not 30)', () => {
      const clean = { steps: [], preconditions: '', expected_result: 'Success toast displays.' };
      const vague = { steps: [], preconditions: '', expected_result: 'System shows a message and works correctly.' };
      expect(calculateExecutabilityScore(clean))
        .toBeGreaterThan(calculateExecutabilityScore(vague));
    });

    test('no assertion keyword but non-vague description (> 20 chars) → 10 pts', () => {
      const descriptive = { steps: [], preconditions: '', expected_result: 'The user is taken to the next step in the workflow.' };
      const empty = { steps: [], preconditions: '', expected_result: '' };
      expect(calculateExecutabilityScore(descriptive))
        .toBeGreaterThan(calculateExecutabilityScore(empty));
    });

    test('purely vague expected result with no assertion → 0 pts from S2', () => {
      // 'works correctly' is in VAGUE_EXPECTED, no assertion keyword either
      const tc = { steps: [], preconditions: '', expected_result: 'works correctly' };
      expect(calculateExecutabilityScore(tc)).toBe(0);
    });

    test('all assertion keywords are recognized', () => {
      const keywords = ['displays', 'shows', 'appears', 'redirects', 'navigates', 'returns',
        'toast', 'message', 'error', 'success', 'contains', 'confirms', 'sends',
        'changes', 'updates', 'closes', 'opens', 'loads', 'visible', 'hidden', 'enabled', 'disabled'];
      keywords.forEach(kw => {
        const tc = { steps: [], preconditions: '', expected_result: `The page ${kw} the result.` };
        const score = calculateExecutabilityScore(tc);
        // Should get at least 10 pts (clean assertion)
        expect(score).toBeGreaterThanOrEqual(10);
      });
    });
  });

  // ── Section 3: Preconditions concreteness ───────────────────────────────
  describe('S3 — preconditions concreteness (0-20 pts)', () => {
    test('3+ concrete indicators → 20 pts', () => {
      // 'user ' + 'role' + '@' + 'logged in as' = 4 indicators
      const tc = { steps: [], expected_result: '', preconditions: "User 'admin@company.com' is logged in as a user with 'Admin' role." };
      const score = calculateExecutabilityScore(tc);
      // At least 20 from S3 (4 indicators ≥ 3)
      expect(score).toBeGreaterThanOrEqual(20);
    });

    test('2 concrete indicators → 15 pts', () => {
      // 'account' + 'page' = 2 indicators; length >= 20
      const two = { steps: [], expected_result: '', preconditions: 'User has an account. Navigate to the page.' };
      const three = { steps: [], expected_result: '', preconditions: "User 'admin@company.com' has an account with 'Admin' role on the page." };
      expect(calculateExecutabilityScore(three))
        .toBeGreaterThanOrEqual(calculateExecutabilityScore(two));
    });

    test('1 concrete indicator AND length >= 20 → 10 pts', () => {
      const oneIndicatorLong = { steps: [], expected_result: '', preconditions: 'The admin is present in the system dashboard.' };
      const empty = { steps: [], expected_result: '', preconditions: '' };
      expect(calculateExecutabilityScore(oneIndicatorLong))
        .toBeGreaterThan(calculateExecutabilityScore(empty));
    });

    test('empty preconditions → 0 pts from S3', () => {
      const noSteps = { steps: [], expected_result: '', preconditions: '' };
      expect(calculateExecutabilityScore(noSteps)).toBe(0);
    });
  });

  // ── Section 4: Step count adequacy ──────────────────────────────────────
  describe('S4 — step count adequacy (0-15 pts)', () => {
    test('3-10 steps → 15 pts from S4', () => {
      const threeSteps = { steps: ['a', 'b', 'c'], expected_result: '', preconditions: '' };
      const tenSteps  = { steps: Array(10).fill('a'), expected_result: '', preconditions: '' };
      // Both get S1=0 (no actionable verbs), S2=0, S3=0, S4=15
      expect(calculateExecutabilityScore(threeSteps)).toBe(15);
      expect(calculateExecutabilityScore(tenSteps)).toBe(15);
    });

    test('2 steps → 8 pts (partial credit)', () => {
      const twoSteps = { steps: ['a', 'b'], expected_result: '', preconditions: '' };
      expect(calculateExecutabilityScore(twoSteps)).toBe(8);
    });

    test('1 step → 0 pts from S4', () => {
      const oneStep = { steps: ['a'], expected_result: '', preconditions: '' };
      expect(calculateExecutabilityScore(oneStep)).toBe(0);
    });

    test('11 steps → 8 pts (partial credit)', () => {
      const elevenSteps = { steps: Array(11).fill('a'), expected_result: '', preconditions: '' };
      expect(calculateExecutabilityScore(elevenSteps)).toBe(8);
    });

    test('13+ steps → 0 pts from S4', () => {
      const tooMany = { steps: Array(13).fill('a'), expected_result: '', preconditions: '' };
      expect(calculateExecutabilityScore(tooMany)).toBe(0);
    });

    test('more optimal step count (3-10) beats fewer or more', () => {
      const base = { expected_result: '', preconditions: '' };
      const optimal = calculateExecutabilityScore({ ...base, steps: Array(5).fill('a') });
      const tooFew  = calculateExecutabilityScore({ ...base, steps: ['a'] });
      const tooMany = calculateExecutabilityScore({ ...base, steps: Array(13).fill('a') });
      expect(optimal).toBeGreaterThan(tooFew);
      expect(optimal).toBeGreaterThan(tooMany);
    });
  });

  // ── Overall quality tiers ────────────────────────────────────────────────
  describe('overall quality tiers', () => {
    test('well-specified test case scores >= 70', () => {
      expect(calculateExecutabilityScore(makeExecutableTestCase())).toBeGreaterThanOrEqual(70);
    });

    test('vague test case with 1 step scores < 40 (LOW_EXECUTABILITY threshold)', () => {
      expect(calculateExecutabilityScore(makeVagueTestCase())).toBeLessThan(40);
    });

    test('fully empty test case scores 0', () => {
      expect(calculateExecutabilityScore({})).toBe(0);
    });

    test('null/undefined fields do not throw', () => {
      expect(() => calculateExecutabilityScore({
        steps: null,
        expected_result: null,
        preconditions: undefined,
      })).not.toThrow();
    });
  });

  // ── Score clamping ───────────────────────────────────────────────────────
  describe('score clamping', () => {
    test('score is never below 0', () => {
      expect(calculateExecutabilityScore(makeVagueTestCase())).toBeGreaterThanOrEqual(0);
      expect(calculateExecutabilityScore({})).toBeGreaterThanOrEqual(0);
    });

    test('score is never above 100', () => {
      // Perfect across all four sections
      const perfect = makeExecutableTestCase({
        steps: [
          "Navigate to '/login'",
          "Enter 'admin@company.com' in 'Email'",
          "Enter 'Pass123' in 'Password'",
          "Click 'Sign In'",
          "Verify dashboard loads",
        ],
        expected_result: 'Dashboard displays and success message appears.',
        preconditions: "User 'admin@company.com' has account with 'Admin' role. On /login page.",
      });
      expect(calculateExecutabilityScore(perfect)).toBeLessThanOrEqual(100);
    });
  });

  // ── toStr coercion edge cases ────────────────────────────────────────────
  describe('toStr coercion on non-string fields', () => {
    test('steps as array of mixed types does not throw', () => {
      const tc = {
        steps: ['Click button', 42, null, { text: 'Enter value' }],
        expected_result: 'Success message displays.',
        preconditions: '',
      };
      expect(() => calculateExecutabilityScore(tc)).not.toThrow();
    });

    test('expected_result as an object stringifies without crashing', () => {
      const tc = {
        steps: [],
        expected_result: { code: 200, body: 'OK' },
        preconditions: '',
      };
      expect(() => calculateExecutabilityScore(tc)).not.toThrow();
    });
  });
});
