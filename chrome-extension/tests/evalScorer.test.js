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
