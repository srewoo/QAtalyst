/**
 * All ticket types — story, bug/defect, epic, task — must get the full pipeline,
 * and the TYPE must actually shape what is generated.
 *
 * issueType was only blended into a keyword blob, so "Bug" competed with every
 * other word in the description and had no structural effect: a defect got the
 * same generic split as a task, with regression at 10%. And Epic Mode, which is a
 * separate code path, was missing fixes the single-ticket path had received.
 */
const { deriveDistribution, typePrior, TYPE_PRIORS } = require('../dynamic-distribution.js');
const fs = require('fs');
const path = require('path');
const CONTENT = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

const dist = (issueType, summary = 'Something happens', description = 'Details here.') =>
  deriveDistribution({ issueType, summary, description });

describe('the ticket type shapes generation', () => {
  test('a bug is regression-weighted, a story is not', () => {
    // A defect is the one case where regression IS the point: proving the fix
    // holds and that it broke nothing.
    expect(dist('Bug').weights.Regression).toBeGreaterThan(dist('Story').weights.Regression * 2);
  });

  test('a defect is treated like a bug', () => {
    expect(typePrior({ issueType: 'Defect' }).key).toBe('defect');
    expect(dist('Defect').weights.Regression).toBeGreaterThan(dist('Story').weights.Regression);
  });

  test('a bug leans away from the happy path', () => {
    // The happy path is presumably already covered; the failure condition is not.
    expect(dist('Bug').weights.Positive).toBeLessThan(dist('Story').weights.Positive);
  });

  test('an epic leans toward integration — the seams between its children', () => {
    expect(dist('Epic').weights.Integration).toBeGreaterThan(dist('Story').weights.Integration);
  });

  test('custom Jira type names still match', () => {
    // Real instances have "Production Bug", "Sub-bug", "Customer Defect".
    expect(typePrior({ issueType: 'Production Bug' }).key).toBe('bug');
    expect(typePrior({ issueType: 'Customer Defect' }).key).toBe('defect');
    expect(typePrior({ issueType: 'Sub-task' }).key).toBe('sub-task');
  });

  test('an unknown type falls back cleanly rather than throwing', () => {
    expect(typePrior({ issueType: 'Spike' })).toBeNull();
    expect(() => dist('Spike')).not.toThrow();
    expect(dist('Spike').issueType).toBeNull();
  });

  test('a missing type is handled', () => {
    expect(typePrior({})).toBeNull();
    expect(() => deriveDistribution({ summary: 'x' })).not.toThrow();
  });

  test('weights still normalise to 1 for every type', () => {
    for (const type of ['Story', 'Bug', 'Defect', 'Epic', 'Task', 'Spike', '']) {
      const sum = Object.values(dist(type).weights).reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1, 5);
    }
  });

  test('no category is driven to zero by a type prior', () => {
    for (const type of Object.keys(TYPE_PRIORS)) {
      for (const [cat, w] of Object.entries(dist(type).weights)) {
        expect(w, `${type}/${cat}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('Epic Mode gets the same protections as a single ticket', () => {
  const childFn = CONTENT.slice(CONTENT.indexOf('function generateForChild('),
                                CONTENT.indexOf('function generateForChild(') + 1400);

  test('epic children are bounded by a timeout', () => {
    // A child whose worker call never returned left the whole epic waiting.
    expect(childFn).toContain('withGenerationTimeout');
  });

  test('epic children receive the reviewed analysis and scope', () => {
    // They were the only generation path that never did, so a correction made in
    // review applied to a story but not to that story inside its epic.
    expect(childFn).toContain('buildReviewedContext()');
  });

  test('epic children go through the same gated agentic handler', () => {
    expect(childFn).toContain("action: 'generateTestCasesAgentic'");
  });

  test('the timeout keeps its own clock', () => {
    // Reading GenerationStatus._startedAt would be 0 while Epic Mode suppresses
    // the status panel, making elapsed time epoch-sized and firing instantly.
    const fn = CONTENT.slice(CONTENT.indexOf('function withGenerationTimeout('),
                             CONTENT.indexOf('function withGenerationTimeout(') + 1600);
    expect(fn).toContain('const startedAt = Date.now()');
    expect(fn).not.toMatch(/Date\.now\(\) - GenerationStatus\._startedAt/);
  });

  test('the stall check is skipped when the status panel is not running', () => {
    const fn = CONTENT.slice(CONTENT.indexOf('function withGenerationTimeout('),
                             CONTENT.indexOf('function withGenerationTimeout(') + 1600);
    expect(fn).toContain('GenerationStatus.isActive()');
  });
});
