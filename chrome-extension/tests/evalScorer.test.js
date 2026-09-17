/**
 * Tests for the golden-set eval scorer (G3). Runs the real scorer against the
 * shipped RE-11256 fixture so the harness itself is CI-covered and can't rot.
 */
const path = require('path');
const fs = require('fs');
const { scoreSuite, evaluate } = require('../eval/scorer.js');

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'eval', 'fixtures', 're-11256.json'), 'utf8')
);

describe('eval scorer (G3)', () => {
  test('computes all metrics for the golden fixture', () => {
    const m = scoreSuite(fixture);
    expect(m.total).toBe(fixture.generatedSuite.length);
    expect(m.requirementCoverage).toBeGreaterThan(0.5);
    expect(m.groundingValidity).toBe(1);        // fixture suite references only real entities
    expect(m.duplicateRate).toBe(0);            // fixture has no duplicates
    expect(m.precision).toBeGreaterThan(0.5);
    expect(m.recall).toBeGreaterThan(0.5);
    expect(m.score).toBeGreaterThanOrEqual(70);
  });

  test('golden fixture passes its thresholds', () => {
    const r = evaluate(fixture);
    expect(r.pass).toBe(true);
    expect(r.failures).toEqual([]);
  });

  test('grounding validity drops when tests reference non-existent entities', () => {
    const bad = {
      ...fixture,
      generatedSuite: [
        { title: 'Uses a fake API', steps: ['call GET /api/does-not-exist'], expected_result: 'works' },
        { title: 'Clicks a fake button', steps: ['Click "Teleport"'], expected_result: 'teleported' },
      ],
    };
    const m = scoreSuite(bad);
    expect(m.groundingValidity).toBeLessThan(0.6);
  });

  test('duplicate rate rises for a near-duplicate suite', () => {
    const dupes = {
      ...fixture,
      knowledgeGraph: null, // isolate the duplicate signal
      generatedSuite: [
        { title: 'Sidebar shows chat session list', steps: ['open sidebar'], expected_result: 'the chat session list is shown' },
        { title: 'Chat session list is displayed in the sidebar', steps: ['open the sidebar'], expected_result: 'sidebar shows the chat session list' },
      ],
    };
    const m = scoreSuite(dupes);
    expect(m.duplicateRate).toBeGreaterThan(0);
  });

  test('flags uncovered requirements (migration scenario is hard to token-match)', () => {
    const m = scoreSuite(fixture);
    expect(m.requirementDetail.total).toBeGreaterThan(5);
    // some requirement items remain uncovered — surfaced, not hidden
    expect(Array.isArray(m.requirementDetail.uncovered)).toBe(true);
  });

  test('evaluate reports failures when thresholds are not met', () => {
    const r = evaluate(fixture, { requirementCoverage: 0.99, groundingValidity: 0.99, duplicateRate: 0, score: 99 });
    expect(r.pass).toBe(false);
    expect(r.failures.length).toBeGreaterThan(0);
  });
});

describe('F20 — the scorer cannot award a grade it did not earn', () => {
  const { evaluate, scoreSuite } = require('../eval/scorer.js');

  test('an empty suite is not a perfect score', () => {
    // Pre-fix: score 100, pass true — only the uniqueness term applied, and an
    // empty suite trivially has no duplicates.
    const r = evaluate({ ticket: {}, generatedSuite: [] });
    expect(r.pass).toBe(false);
    expect(r.score).toBeNull();
    expect(r.failures.join(' ')).toMatch(/not scoreable/);
  });

  test('a suite with nothing to score against is not scoreable', () => {
    const r = evaluate({ ticket: {}, generatedSuite: [{ title: 'anything', expected_result: 'ok' }] });
    expect(r.pass).toBe(false);
    expect(r.scoreable).toBe(false);
  });

  test('unresolved references do not count as valid grounding', () => {
    const kg = { pages: [{ url: 'https://a/login', title: 'Login',
      features: [{ type: 'button', text: 'Login', selector: '#l' }], apis: [] }] };
    const m = scoreSuite({
      ticket: { summary: 'Login', description: 'Acceptance Criteria:\n- User can log in' },
      knowledgeGraph: kg,
      generatedSuite: [
        { title: 'User can log in', steps: ['Click the "Login" button'], expected_result: 'Signed in' },
        { title: 'User can log in', steps: ['Click the "Launch Rocket" button'], expected_result: 'Signed in' }
      ]
    });
    // Pre-fix both counted as grounded because neither was outright rejected.
    expect(m.groundingValidity).toBeLessThan(1);
    expect(m.groundingDetail.unresolved + m.groundingDetail.rejected).toBeGreaterThan(0);
  });

  test('merging a protected distinct pair fails the fixture', () => {
    const r = evaluate({
      ticket: { summary: 'Invoices', description: 'Acceptance Criteria:\n- Invoices can be exported' },
      generatedSuite: [{ title: 'Export invoices', steps: ['Click Export'], expected_result: 'Exported' }],
      protectedDistinctions: [{
        reason: 'test harness: identical cases SHOULD merge',
        cases: [
          { title: 'Export invoices', steps: ['Click Export'], expected_result: 'Exported' },
          { title: 'Export invoices', steps: ['Click Export'], expected_result: 'Exported' }
        ]
      }]
    });
    expect(r.falseMerges.length).toBe(1);
    expect(r.pass).toBe(false);
    expect(r.failures.join(' ')).toMatch(/false merge/);
  });

  test('the shipped adversarial corpus preserves every protected distinction', () => {
    const fixture = require('../eval/fixtures/adversarial-distinctions.json');
    const r = evaluate(fixture);
    expect(r.falseMerges).toEqual([]);
    expect(r.pass).toBe(true);
  });
});
