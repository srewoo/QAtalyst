/**
 * F05 §7.3 + F07 §7.1 — scenario classification and requirement predicates.
 */
const SemanticDuplicateDetector = require('../semantic-duplicate-detector.js');
const CoverageMapper = require('../coverage-mapper.js');
const RM = require('../requirement-model.js');

const t = (title, steps, expected, extra = {}) => ({ title, steps, expected_result: expected, ...extra });

describe('F05 — pair classification, not merge-or-keep', () => {
  const classify = (a, b) => SemanticDuplicateDetector.classifyPair(a, b, { threshold: 0.68 });

  test('identical content is an exact duplicate regardless of id', () => {
    const a = t('Login', ['Click Login'], 'Signed in', { id: 'X1' });
    const b = t('Login', ['Click Login'], 'Signed in', { id: 'X2' });
    const v = classify(a, b);
    expect(v.relation).toBe('exact_duplicate');
    expect(v.merge).toBe(true);
  });

  test('a paraphrase of the same scenario is equivalent and may collapse', () => {
    const v = classify(
      t('User logs in successfully', ['Enter email', 'Enter password', 'Click Login'], 'The dashboard is displayed'),
      t('Successful user login', ['Enter email', 'Enter password', 'Click Login'], 'The dashboard is displayed'));
    expect(v.relation).toBe('equivalent');
    expect(v.merge).toBe(true);
  });

  test('opposite outcomes are contradictory and BOTH are kept', () => {
    const v = classify(
      t('Owner can delete', ['Click Delete'], 'The invoice is deleted'),
      t('Viewer cannot delete', ['Click Delete'], 'Deletion is denied'));
    expect(v.relation).toBe('contradictory');
    expect(v.merge).toBe(false);
  });

  test('boundary values are parameter variants and are NOT auto-merged', () => {
    const v = classify(
      t('Upload limit', ['Upload a 100 KB file'], 'Accepted'),
      t('Upload limit', ['Upload a 101 KB file'], 'Rejected'));
    expect(v.relation).toBe('parameter_variant');
    expect(v.merge).toBe(false);
  });

  test('two thin cases are uncertain, not equivalent', () => {
    const v = SemanticDuplicateDetector.classifyPair(
      { title: 'Manage billing' }, { title: 'Manage billing settings' },
      { threshold: 0.68, similarity: 0.9 });
    // High similarity, but neither case described a scenario — that is missing
    // evidence, and auto-deleting on it is how obligations disappeared.
    expect(v.relation).toBe('uncertain');
    expect(v.merge).toBe(false);
  });

  test('the content fingerprint ignores id and wording order', () => {
    const f1 = SemanticDuplicateDetector.contentFingerprint(t('A', ['s1'], 'r', { id: 'Z1' }));
    const f2 = SemanticDuplicateDetector.contentFingerprint(t('A', ['s1'], 'r', { id: 'Z9' }));
    expect(f1).toBe(f2);
  });
});

describe('F05 §7.3 step 7 — global consolidation without assuming transitivity', () => {
  test('A~B and B~C does not collapse A into C', () => {
    const A = t('Upload a 99 KB file', ['Upload a 99 KB file'], 'Accepted');
    const B = t('Upload a 100 KB file', ['Upload a 100 KB file'], 'Accepted');
    const C = t('Upload a 101 KB file', ['Upload a 101 KB file'], 'Rejected');
    const { kept } = SemanticDuplicateDetector.consolidate([A, B, C], { threshold: 0.68 });
    // Each boundary position is its own obligation.
    expect(kept).toHaveLength(3);
  });

  test('a merge carries the requirement links of BOTH cases onto the survivor', () => {
    const A = t('Login', ['Enter email', 'Click Login'], 'Signed in', { requirementIds: ['R1'] });
    const B = t('Login', ['Enter email', 'Click Login'], 'Signed in', { requirementIds: ['R2'] });
    const { kept, merged } = SemanticDuplicateDetector.consolidate([A, B], { threshold: 0.68 });
    expect(merged).toHaveLength(1);
    expect(kept[0].requirementIds.sort()).toEqual(['R1', 'R2']);
  });

  test('uncertain and contradictory pairs are surfaced for review', () => {
    const { review } = SemanticDuplicateDetector.consolidate([
      t('Owner can delete', ['Click Delete'], 'Deleted'),
      t('Viewer cannot delete', ['Click Delete'], 'Denied')
    ], { threshold: 0.68 });
    expect(review.some(r => r.relation === 'contradictory')).toBe(true);
  });
});

describe('F07 §7.1 — requirement predicates', () => {
  const reqs = RM.buildRequirements([
    'An owner can delete an invoice but a viewer cannot',
    'Uploads above 100 KB must be rejected',
    'The export may optionally include VAT',
    'The retry behaviour is TBD'
  ], { ticketKey: 'INV-1' });

  test('a compound AC becomes two atomic obligations with stable ids', () => {
    const ids = reqs.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(reqs[0].modality).toBe('must');
    expect(reqs[1].modality).toBe('must_not');
    expect(reqs[1].actor).toBe('viewer');
  });

  test('an elided clause inherits the operation it is forbidden from', () => {
    // "…but a viewer cannot" has no verb of its own; losing it would make the
    // prohibition unmatchable against any test.
    expect(reqs[1].operation).toBe('delete');
  });

  test('optional and ambiguous obligations are visible but not mandatory', () => {
    expect(reqs.find(r => /VAT/.test(r.text)).status).toBe('optional');
    expect(reqs.find(r => /TBD/i.test(r.text)).status).toBe('ambiguous');
    expect(RM.mandatoryRequirements(reqs).every(r => r.status === 'mandatory')).toBe(true);
  });

  test('every predicate records the source span it came from', () => {
    for (const r of reqs) {
      expect(r.source.span).toBeTruthy();
      expect(typeof r.source.index).toBe('number');
    }
  });

  test('one branch of a compound AC does not cover the whole', () => {
    const cov = CoverageMapper.mapRequirementPredicates(
      [t('Owner deletes an invoice', ['Log in as owner', 'Click Delete'], 'The invoice is deleted')],
      reqs, { requirementModel: RM });
    expect(cov.covered).toBeLessThan(cov.total);
    expect(cov.details.filter(d => d.compoundIncomplete).length).toBeGreaterThan(0);
  });

  test('an inverted assertion is a contradiction, not coverage', () => {
    const cov = CoverageMapper.mapRequirementPredicates(
      [t('Viewer deletes an invoice', ['Log in as viewer', 'Click Delete'], 'The invoice is deleted')],
      reqs, { requirementModel: RM });
    expect(cov.contradictions.length).toBeGreaterThan(0);
  });

  test('a lexical mention without performing the operation is not coverage', () => {
    const cov = CoverageMapper.mapRequirementPredicates(
      [t('Invoice page loads', ['Open the invoices page'], 'The page renders')],
      reqs, { requirementModel: RM });
    expect(cov.covered).toBe(0);
  });

  test('optional obligations do not count against completeness', () => {
    const cov = CoverageMapper.mapRequirementPredicates([], reqs, { requirementModel: RM });
    // 2 mandatory (owner-can, viewer-cannot) + 1 mandatory upload rule = 3.
    expect(cov.total).toBe(3);
    expect(cov.nonMandatory.length).toBe(2);
  });
});
