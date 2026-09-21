/**
 * @vitest-environment happy-dom
 *
 * F15 — every quality signal the backend produces must have a VISIBLE, tested
 * representation. Before this, displayTestCasesResults rendered counts and a
 * legacy "evolution" badge, while degradations, acceptance-criteria coverage,
 * rejection reasons, preserved distinctions and per-case grounding warnings were
 * all computed and then silently dropped.
 */
const { renderQualityStatus } = require('../content-format.js');

describe('renderQualityStatus', () => {
  test('renders nothing for a clean run with nothing to report', () => {
    expect(renderQualityStatus({ testCases: [{ title: 'ok', _grounding: 'verified' }] })).toBe('');
  });

  test('surfaces reduced-context degradations', () => {
    const html = renderQualityStatus({
      degradations: ['No crawl data for this app — tests could not be grounded.']
    });
    expect(html).toContain('What limited this run');
    expect(html).toContain('No crawl data for this app');
  });

  test('reports requirement coverage, gaps and contradictions', () => {
    const html = renderQualityStatus({
      acCoverage: {
        applicable: true, covered: 1, total: 3, percentage: 33,
        uncovered: [{ index: 1, text: 'Viewer sees a read-only banner' }],
        contradictions: [{ index: 2, text: 'Viewer cannot delete invoices', by: 'Viewer can delete invoices' }]
      }
    });
    expect(html).toContain('1/3');
    expect(html).toContain('Viewer sees a read-only banner');
    // A contradiction must read as a conflict, not as an ordinary missing test.
    expect(html).toContain('CONTRADICTED');
    expect(html).toContain('Viewer can delete invoices');
  });

  test('explains what the gate removed and why', () => {
    const html = renderQualityStatus({
      rejected: [
        { title: 'Dup login', stage: 'duplicate', reason: 'near-duplicate of "Login works"' },
        { title: 'Unrelated', stage: 'relevance', reason: 'off-topic (relevance 0.100 < 0.3)' }
      ]
    });
    expect(html).toContain('2 candidate(s) removed');
    expect(html).toContain('duplicate: 1');
    expect(html).toContain('relevance: 1');
    expect(html).toContain('near-duplicate of');
  });

  test('lets a reviewer audit why two similar cases were NOT merged', () => {
    const html = renderQualityStatus({
      preservedDistinctions: [
        { test: 'Export invoices', against: 'Archive invoices', sim: 0.75, reason: 'different operations (export vs archive)' }
      ]
    });
    expect(html).toContain('kept apart on purpose');
    expect(html).toContain('different operations');
  });

  test('counts the cases that are not ready to execute', () => {
    const html = renderQualityStatus({
      testCases: [
        { title: 'a', _grounding: 'verified' },
        { title: 'b', _grounding: 'unresolved' },
        { title: 'c', _grounding: 'verified', _assertionWarning: 'expected result may be inverted' },
        { title: 'd', _grounding: 'verified', _behaviorWarnings: ['no supporting API for auto-sync'] }
      ]
    });
    expect(html).toContain('3 of 4 case(s) need review');
  });

  test('escapes model-derived text rather than injecting it as markup', () => {
    const html = renderQualityStatus({
      degradations: ['<img src=x onerror="alert(1)">'],
      rejected: [{ title: '<script>bad()</script>', stage: 'duplicate', reason: 'x' }]
    });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>bad()');
    expect(html).toContain('&lt;img');
  });

  test('tolerates a result object with no quality fields at all', () => {
    expect(renderQualityStatus({})).toBe('');
    expect(() => renderQualityStatus({ rejected: null, testCases: null })).not.toThrow();
  });
});
