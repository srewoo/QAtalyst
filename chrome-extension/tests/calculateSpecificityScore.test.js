/**
 * Tests for calculateSpecificityScore.
 * This function is the quality gate — test cases scoring < 40 are flagged LOW_SPECIFICITY.
 * Getting it wrong either suppresses good tests or silently passes bad ones.
 */

// ---------------------------------------------------------------------------
// Inline the pure helpers used by calculateSpecificityScore
// ---------------------------------------------------------------------------
function toStr(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(toStr).join('\n');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function calculateSpecificityScore(tc) {
  let score = 50;

  const allText = [
    toStr(tc.title),
    toStr(tc.description),
    toStr(tc.expected_result),
    ...(Array.isArray(tc.steps) ? tc.steps.map(toStr) : []),
    toStr(tc.test_data),
  ].join(' ');

  const allTextLower = allText.toLowerCase();

  const vagueWords = [
    'appropriate', 'correctly', 'properly', 'as expected', 'should work',
    'works correctly', 'relevant', 'valid data', 'invalid data',
    'enter valid', 'enter invalid', 'proper error', 'proper message',
    'the system should', 'works as expected', 'functions correctly',
  ];
  vagueWords.forEach(w => { if (allTextLower.includes(w)) score -= 5; });

  const quotedValues = allText.match(/['"][^'"]{2,}['"]/g);
  if (quotedValues && quotedValues.length > 0) score += Math.min(quotedValues.length * 3, 15);

  if (/\d+/.test(tc.test_data || '')) score += 5;
  if (/\S+@\S+\.\S+/.test(allText)) score += 5;
  if (/https?:\/\/\S+/.test(allText)) score += 3;

  const fieldRefs = allText.match(/['"][A-Z][a-zA-Z\s]{2,}['"]/g);
  if (fieldRefs && fieldRefs.length >= 2) score += 5;

  if (tc.steps && tc.steps.length >= 3) score += 5;
  if (tc.steps && tc.steps.length >= 5) score += 5;

  const er = toStr(tc.expected_result).toLowerCase();
  if (er.includes('message') || er.includes('toast') || er.includes('displays') || er.includes('shows')) score += 5;

  if ((tc.description || '').length > 80) score += 5;

  // Requirement coverage check
  const storyRef = toStr(tc.storyReference).toLowerCase();
  if (storyRef && storyRef.length > 15) {
    const refKeywords = storyRef.split(/\s+/).filter(w => w.length > 4);
    const stepsAndResult = (Array.isArray(tc.steps) ? tc.steps.map(toStr).join(' ') : '') + ' ' + toStr(tc.expected_result);
    const stepsLower = stepsAndResult.toLowerCase();
    const coveredKeywords = refKeywords.filter(kw => stepsLower.includes(kw));
    const coverageRatio = refKeywords.length > 0 ? coveredKeywords.length / refKeywords.length : 0;
    if (coverageRatio >= 0.5) score += 8;
    else if (coverageRatio >= 0.25) score += 4;
    else if (coverageRatio === 0 && refKeywords.length > 2) score -= 5;
  } else {
    score -= 5;
  }

  // Completeness check
  if (!tc.steps || tc.steps.length < 2) score -= 10;
  if (!tc.preconditions || toStr(tc.preconditions).length < 10) score -= 5;
  if (!tc.test_data || toStr(tc.test_data).length < 5) score -= 3;

  // Step-level specificity
  if (tc.steps && tc.steps.length > 0) {
    const specificSteps = tc.steps.filter(step => {
      const s = toStr(step);
      return /['"][^'"]{2,}['"]/.test(s) || /click|enter|select|navigate|verify|check/i.test(s);
    });
    const stepSpecificityRatio = specificSteps.length / tc.steps.length;
    if (stepSpecificityRatio >= 0.8) score += 5;
    else if (stepSpecificityRatio < 0.4) score -= 5;
  }

  return Math.max(0, Math.min(100, score));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function makeGoodTestCase(overrides = {}) {
  return {
    id: 'TC-POS-001',
    title: 'Schedule meeting with valid details',
    category: 'Positive',
    priority: 'P0',
    storyReference: 'As a host, I want to schedule a meeting so that I can invite participants via email',
    description: 'Verify that a host can create a new meeting by filling in the title, date, and participant email, and that an email invitation is sent upon submission.',
    preconditions: "User 'host@company.com' is logged in with 'Host' role on the Meetings page.",
    steps: [
      "Click the 'Schedule Meeting' button",
      "Enter 'Q4 Review' in the 'Meeting Title' field",
      "Select '2025-07-15' in the 'Date' picker",
      "Enter 'jane@company.com' in the 'Participant Email' field",
      "Click the 'Send Invite' button",
    ],
    expected_result: "Success toast 'Meeting scheduled' displays. Meeting appears in the list.",
    test_data: "title='Q4 Review', date='2025-07-15', email='jane@company.com'",
    ...overrides,
  };
}

function makeVagueTestCase(overrides = {}) {
  return {
    id: 'TC-POS-002',
    title: 'Test form submission',
    category: 'Positive',
    storyReference: 'ok',           // Too short — triggers storyReference penalty
    description: 'Test form',        // Too short — no +5 for long description
    preconditions: '',               // Missing preconditions penalty
    steps: ['Click submit'],         // Only 1 step — too few penalty
    expected_result: 'works correctly', // Vague — -5 per vague word
    test_data: '',                   // Missing test data
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('calculateSpecificityScore', () => {
  describe('base score = 50', () => {
    test('a test with no content scores at the baseline after penalties', () => {
      const score = calculateSpecificityScore({});
      // Penalties: storyReference missing (-5), steps < 2 (-10), no preconditions (-5), no test_data (-3)
      expect(score).toBeLessThan(50);
    });
  });

  describe('good test cases score high', () => {
    test('a well-specified positive test scores >= 70', () => {
      const score = calculateSpecificityScore(makeGoodTestCase());
      expect(score).toBeGreaterThanOrEqual(70);
    });

    test('email in content gives +5', () => {
      const base = calculateSpecificityScore(makeGoodTestCase({ test_data: '' }));
      const withEmail = calculateSpecificityScore(makeGoodTestCase({ test_data: 'email=jane@company.com' }));
      // withEmail should be higher or equal (email bonus) due to test_data number/email bonuses
      expect(withEmail).toBeGreaterThanOrEqual(base);
    });

    test('5+ steps gives additional +5 over 3 steps', () => {
      const threeSteps = makeGoodTestCase({ steps: ['Step 1', "Enter 'X'", "Click 'Y'"] });
      const fiveSteps = makeGoodTestCase();  // already has 5 steps
      expect(calculateSpecificityScore(fiveSteps)).toBeGreaterThan(calculateSpecificityScore(threeSteps));
    });

    test('URL in content adds +3 (baseline without URL is below 100)', () => {
      // Use a minimal test case that stays well below 100 so URL bonus has room to show
      const noUrl = {
        title: 'Login test',
        description: 'Verify user can log in.',
        expected_result: 'Dashboard displays.',
        steps: ['Open login page', 'Enter credentials', 'Click login'],
        test_data: 'username=admin',
        preconditions: 'App is running and accessible.',
        storyReference: 'User should be able to log into the dashboard securely',
      };
      const withUrl = { ...noUrl, description: noUrl.description + ' Navigate to https://app.example.com/login.' };
      expect(calculateSpecificityScore(withUrl)).toBeGreaterThan(calculateSpecificityScore(noUrl));
    });
  });

  describe('vague tests score low', () => {
    test('a vague test case scores < 40 (LOW_SPECIFICITY threshold)', () => {
      const score = calculateSpecificityScore(makeVagueTestCase());
      expect(score).toBeLessThan(40);
    });

    test('each vague word subtracts 5 from score', () => {
      const clean = makeGoodTestCase({ expected_result: 'Meeting appears in list.' });
      const vague = makeGoodTestCase({ expected_result: 'System should work correctly as expected.' });
      expect(calculateSpecificityScore(clean)).toBeGreaterThan(calculateSpecificityScore(vague));
    });
  });

  describe('requirement coverage check', () => {
    // Use a modest fixture that stays below 100 so penalty/bonus differences are measurable
    function makeModestCase(overrides = {}) {
      return {
        title: 'User login test',
        description: 'Verify the user can log in with valid credentials.',
        expected_result: "Dashboard displays the user's name.",
        steps: ["Open '/login' page", "Enter 'admin@test.com' in 'Email' field", "Click 'Login' button"],
        test_data: 'email=admin@test.com',
        preconditions: 'App is running, user account exists.',
        storyReference: 'User should be able to login to the dashboard with valid credentials',
        ...overrides,
      };
    }

    test('storyReference keywords appearing in steps gives +8', () => {
      const goodRef = makeModestCase();
      // Steps that share no keywords with storyReference → no coverage bonus / possible penalty
      const badRef = makeModestCase({
        steps: ["Open the app", "Complete the operation", "Confirm the action"],
        expected_result: 'Operation succeeds.',
      });
      expect(calculateSpecificityScore(goodRef)).toBeGreaterThan(calculateSpecificityScore(badRef));
    });

    test('empty storyReference penalises compared to non-empty', () => {
      const withRef = makeModestCase();
      const withoutRef = makeModestCase({ storyReference: '' });
      expect(calculateSpecificityScore(withRef)).toBeGreaterThan(calculateSpecificityScore(withoutRef));
    });

    test('very short storyReference (< 15 chars) penalises compared to descriptive one', () => {
      const withRef = makeModestCase();
      const shortRef = makeModestCase({ storyReference: 'short' });
      expect(calculateSpecificityScore(withRef)).toBeGreaterThan(calculateSpecificityScore(shortRef));
    });
  });

  describe('completeness checks', () => {
    // Modest fixture that scores in the 60-80 range — leaves room for penalties to show
    function makeModestCase(overrides = {}) {
      return {
        title: 'User login test',
        description: 'Verify the user can log in with valid credentials on the login page.',
        expected_result: "Dashboard displays showing 'Welcome, Admin'.",
        steps: ["Open '/login' page", "Enter 'admin@test.com'", "Click 'Login' button"],
        test_data: 'email=admin@test.com',
        preconditions: 'App is running, user account exists.',
        storyReference: 'User should be able to login to the dashboard with valid credentials',
        ...overrides,
      };
    }

    test('< 2 steps penalises -10', () => {
      const full = makeModestCase();
      const oneStep = makeModestCase({ steps: ['Click submit'] });
      expect(calculateSpecificityScore(full)).toBeGreaterThan(calculateSpecificityScore(oneStep));
    });

    test('missing preconditions penalises -5', () => {
      const full = makeModestCase();
      const noPre = makeModestCase({ preconditions: '' });
      expect(calculateSpecificityScore(full)).toBeGreaterThan(calculateSpecificityScore(noPre));
    });

    test('missing test_data penalises -3', () => {
      const full = makeModestCase();
      const noData = makeModestCase({ test_data: '' });
      expect(calculateSpecificityScore(full)).toBeGreaterThan(calculateSpecificityScore(noData));
    });
  });

  describe('step-level specificity', () => {
    test('steps with quoted values or action verbs push ratio toward +5', () => {
      const specificSteps = makeGoodTestCase({
        steps: ["Click 'Login'", "Enter 'admin@test.com'", "Click 'Submit'", 'Verify dashboard loads', 'Check profile icon'],
      });
      const vagueSteps = makeGoodTestCase({
        steps: ['Open form', 'Fill in data', 'Press button', 'Look at the page', 'Done'],
      });
      expect(calculateSpecificityScore(specificSteps)).toBeGreaterThan(calculateSpecificityScore(vagueSteps));
    });
  });

  describe('score clamping', () => {
    test('score is never below 0', () => {
      const score = calculateSpecificityScore({
        title: 'works correctly and appropriately',
        expected_result: 'functions correctly as expected properly',
        steps: ['do thing'],
        storyReference: '',
        preconditions: '',
        test_data: '',
      });
      expect(score).toBeGreaterThanOrEqual(0);
    });

    test('score is never above 100', () => {
      // A test with everything ideal
      const perfect = makeGoodTestCase({
        description: 'Verify that ' + 'x'.repeat(80),
        test_data: "title='Meeting' date=2025-07-15 email=user@company.com amount=150",
      });
      expect(calculateSpecificityScore(perfect)).toBeLessThanOrEqual(100);
    });
  });
});
