/**
 * Tests for dynamic test distribution — the ticket-shape-aware replacement for the
 * fixed 40/25/20/10/5 split.
 */
const { classifyTicket, deriveDistribution, allocateCounts } = require('../dynamic-distribution.js');

describe('classifyTicket', () => {
  test('detects a security ticket', () => {
    const { primary } = classifyTicket({
      summary: 'Add OAuth login with role-based permissions and JWT session tokens'
    });
    expect(primary).toBe('security');
  });

  test('detects a UI ticket', () => {
    const { primary } = classifyTicket({
      summary: 'Redesign the settings screen layout',
      description: 'Update the responsive component, tooltip and keyboard navigation per Figma'
    });
    expect(primary).toBe('ui');
  });

  test('returns generic for an unrecognizable ticket', () => {
    const { primary } = classifyTicket({ summary: 'Misc cleanup' });
    expect(primary).toBe('generic');
  });
});

describe('deriveDistribution', () => {
  test('weights always sum to ~1.0', () => {
    const { weights } = deriveDistribution({ summary: 'Add payment checkout with discount codes' });
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 2);
  });

  test('security ticket skews toward Security + Negative vs baseline', () => {
    const { weights } = deriveDistribution({
      summary: 'Harden authentication: prevent CSRF, XSS and token injection on login'
    });
    expect(weights.Security).toBeGreaterThan(0.06); // above baseline
    expect(weights.Negative).toBeGreaterThan(0.22);  // above baseline
  });

  test('UI ticket skews toward Accessibility', () => {
    const { weights } = deriveDistribution({
      summary: 'New dashboard screen',
      description: 'aria labels, contrast, keyboard navigation, responsive layout'
    });
    expect(weights.Accessibility).toBeGreaterThan(0.06);
  });

  test('respects enabledCategories restriction', () => {
    const { weights } = deriveDistribution(
      { summary: 'API endpoint for orders' },
      { enabledCategories: ['Positive', 'Negative', 'Integration'] }
    );
    expect(Object.keys(weights).sort()).toEqual(['Integration', 'Negative', 'Positive']);
    expect(Object.values(weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1.0, 2);
  });
});

describe('allocateCounts', () => {
  test('integer counts sum exactly to the requested total', () => {
    const { weights } = deriveDistribution({ summary: 'Add login form validation' });
    const counts = allocateCounts(weights, 30);
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(30);
    Object.values(counts).forEach(c => expect(Number.isInteger(c)).toBe(true));
  });

  test('handles small totals without losing tests', () => {
    const { weights } = deriveDistribution({ summary: 'misc' });
    expect(Object.values(allocateCounts(weights, 7)).reduce((a, b) => a + b, 0)).toBe(7);
  });
});
