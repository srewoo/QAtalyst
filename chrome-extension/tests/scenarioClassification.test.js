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

describe('§10 row 13 — removing the sole covering case reopens its requirement', () => {
  const RMod = require('../requirement-model.js');
  const reqs = RMod.buildRequirements(
    ['An owner can delete an invoice', 'Uploads above 100 KB must be rejected'], { ticketKey: 'T' });

  const suite = [
    { id: 'A', title: 'Owner deletes an invoice', steps: ['Log in as owner', 'Click Delete'],
      expected_result: 'The invoice is deleted' },
    { id: 'B', title: 'Upload above the limit is rejected', steps: ['Upload a 101 KB file'],
      expected_result: 'The upload is rejected' }
  ];

  test('coverage is recomputed from the RETAINED suite, not the generated one', () => {
    const before = CoverageMapper.mapRequirementPredicates(suite, reqs, { requirementModel: RMod });
    // The assertion critic drops case A in strict mode.
    const after = CoverageMapper.mapRequirementPredicates(
      suite.filter(t => t.id !== 'A'), reqs, { requirementModel: RMod });

    expect(before.covered).toBe(1);
    // Reporting the pre-removal number would claim coverage the suite no longer has.
    expect(after.covered).toBe(0);
    expect(after.percentage).toBeLessThan(before.percentage);
  });

  test('the requirement returns to the uncovered list', () => {
    const after = CoverageMapper.mapRequirementPredicates(
      suite.filter(t => t.id !== 'A'), reqs, { requirementModel: RMod });
    expect(after.uncovered.map(u => u.text)).toContain('An owner can delete an invoice');
  });

  test('completion cannot be claimed while a mandatory obligation is uncovered', () => {
    const after = CoverageMapper.mapRequirementPredicates(
      suite.filter(t => t.id !== 'A'), reqs, { requirementModel: RMod });
    const complete = after.covered === after.total && after.contradictions.length === 0;
    expect(complete).toBe(false);
  });

  test('an emptied suite reports zero coverage, never inherited coverage', () => {
    const none = CoverageMapper.mapRequirementPredicates([], reqs, { requirementModel: RMod });
    expect(none.covered).toBe(0);
    expect(none.uncovered).toHaveLength(none.total);
  });
});

describe('F05 — false merges found on real ticket data (RE-11256)', () => {
  const fixture = require('../eval/fixtures/re-11256.json');
  const find = (re) => fixture.generatedSuite.find(t => re.test(t.title));

  // Every hard distinction check requires BOTH sides to carry the signal — an
  // operation, a number, an actor. When neither does, all of them skipped and the
  // similarity score decided alone, which is the thing F05 exists to prevent.
  // These three pairs were merged at 0.68-0.71 on a real ticket.
  const FALSE_MERGES = [
    ['hover tooltip vs pagination', /hover/i, /paginates/i],
    ['mobile responsiveness vs pagination', /responsive/i, /paginates/i],
    ['one-time migration vs list rendering', /Migration/i, /chronological/i]
  ];

  test.each(FALSE_MERGES)('%s is not treated as equivalent', (_label, aRe, bRe) => {
    const v = SemanticDuplicateDetector.classifyPair(find(aRe), find(bRe), { threshold: 0.68 });
    expect(v.merge).toBe(false);
    expect(v.relation).not.toBe('equivalent');
  });

  test('the whole real suite survives consolidation intact', () => {
    const { kept, merged } = SemanticDuplicateDetector.consolidate(fixture.generatedSuite, { threshold: 0.68 });
    expect(kept).toHaveLength(fixture.generatedSuite.length);
    expect(merged).toHaveLength(0);
  });

  test('similar-but-different pairs are flagged for review, not silently kept apart', () => {
    const { review } = SemanticDuplicateDetector.consolidate(fixture.generatedSuite, { threshold: 0.68 });
    expect(review.length).toBeGreaterThan(0);
    expect(review.some(r => r.relation === 'overlapping')).toBe(true);
  });

  test('subject overlap separates real paraphrases from unrelated cases', () => {
    const paraphraseA = { title: 'User logs in successfully', steps: ['Enter valid email', 'Click Login'],
      expected_result: 'The dashboard is displayed' };
    const paraphraseB = { title: 'Successful user login', steps: ['Enter valid email', 'Click Login'],
      expected_result: 'The dashboard is displayed' };

    const same = SemanticDuplicateDetector.subjectOverlap(paraphraseA, paraphraseB);
    const different = SemanticDuplicateDetector.subjectOverlap(find(/hover/i), find(/paginates/i));
    // The margin is what makes the threshold defensible rather than arbitrary.
    expect(same).toBeGreaterThan(0.3);
    expect(different).toBeLessThan(0.2);
  });

  test('the stemmer converges so morphology does not defeat the comparison', () => {
    // A single pass turned "successfully" into "successful" and "successful"
    // into "success", so the two never matched.
    expect(SemanticDuplicateDetector.stem('successfully')).toBe(SemanticDuplicateDetector.stem('successful'));
    expect(SemanticDuplicateDetector.stem('paginates')).toBe(SemanticDuplicateDetector.stem('paginate'));
  });

  test('a genuine paraphrase still collapses — the guard is not just "never merge"', () => {
    const a = { title: 'User logs in successfully', steps: ['Enter valid email', 'Click Login'],
      expected_result: 'The dashboard is displayed' };
    const b = { title: 'Successful user login', steps: ['Enter valid email', 'Click Login'],
      expected_result: 'The dashboard is displayed' };
    expect(SemanticDuplicateDetector.classifyPair(a, b, { threshold: 0.68 }).merge).toBe(true);
  });
});

describe('§7.1 — "good to have" is not a release obligation', () => {
  const RMod = require('../requirement-model.js');

  test('an explicit optionality marker beats a modal verb in the same sentence', () => {
    // Found on RE-11256: "Good to have: ... the chat should move up the list"
    // was classified mandatory, because `should` matched the mandatory pattern.
    const r = RMod.buildRequirements(
      ['Good to have: On editing, the chat should move up the list immediately'], { ticketKey: 'T' })[0];
    expect(r.status).toBe('optional');
    expect(r.modality).toBe('may');
  });

  test('it does not count toward mandatory completeness', () => {
    const reqs = RMod.buildRequirements([
      'The panel must list chat sessions',
      'Good to have: the chat should move up the list immediately'
    ], { ticketKey: 'T' });
    expect(RMod.mandatoryRequirements(reqs)).toHaveLength(1);
  });

  test('an ordinary "should" is still mandatory', () => {
    expect(RMod.buildRequirements(['The chat should move up the list'], { ticketKey: 'T' })[0].status)
      .toBe('mandatory');
  });

  test('the harvester keeps the marker instead of stripping it', () => {
    const CM = require('../coverage-mapper.js');
    const items = CM.extractRequirementItems({
      description: 'Good to have: On editing, the chat should move up the list immediately.'
    });
    // Dropping the label discarded the only evidence the item was optional.
    expect(items.some(i => /good to have/i.test(i))).toBe(true);
  });
});

describe('grooming notes: build instructions are not acceptance criteria', () => {
  const RMod = require('../requirement-model.js');

  test('a props signature is not a testable obligation', () => {
    // "props -> (list of sessions, active session id, callback...)" is a function
    // signature. Counting it inflated RE-11256's denominator and pushed the
    // planner to write tests for something no test can observe.
    expect(RMod.detectStatus('props -> (list of sessions, active session id, onRename)'))
      .toBe('implementation_note');
  });

  test('a library choice is not a testable obligation', () => {
    expect(RMod.detectStatus('implement pagination for session listing. use relay.'))
      .toBe('implementation_note');
    expect(RMod.detectStatus('use listing component (infinite loader).'))
      .toBe('implementation_note');
  });

  test('anything a user can SEE is still an obligation', () => {
    // The exclusion is deliberately narrow.
    for (const behavioural of [
      'title should be ellipsed (use ellipsis tooltip).',
      'on hover we need to show the 3dot icon which will open the dropdown',
      'In history pane, it will shows an empty state with no recent chats.',
      'Pagination of chat list (~20)',
      'It should be responsive.'
    ]) {
      expect(RMod.detectStatus(behavioural)).toBe('mandatory');
    }
  });

  test('build instructions do not count toward completeness', () => {
    const reqs = RMod.buildRequirements([
      'The panel displays a list of chat sessions',
      'props -> (list of sessions, active session id)',
      'use relay for pagination'
    ], { ticketKey: 'T' });
    expect(RMod.mandatoryRequirements(reqs)).toHaveLength(1);
  });

  test('they remain visible rather than being discarded', () => {
    const reqs = RMod.buildRequirements(['props -> (a, b)'], { ticketKey: 'T' });
    // Set aside, not deleted — a reviewer may still want to see them.
    expect(reqs).toHaveLength(1);
    expect(reqs[0].status).toBe('implementation_note');
  });
});

describe('the crawl-mismatch claim must match the actual suite', () => {
  const { AcceptanceGate } = require('../acceptance-gate.js');
  const { GroundedVerifier } = require('../grounded-verifier.js');

  const kg = { pages: [{ url: 'https://app/x', title: 'X',
    features: [{ type: 'button', text: 'Save', selector: '#s' }], apis: [] }] };
  const ticket = { summary: 'Save things', description: 'The Save button stores the record.' };

  test('a run with some grounded tests is not reported as a total mismatch', () => {
    const gate = new AcceptanceGate({ knowledgeGraph: kg, ticketData: ticket,
      deps: { GroundedVerifier, SemanticDuplicateDetector }, relevanceThreshold: 0 });

    // A batch that all fails grounding…
    gate.admit([
      { title: 'Teleport a', steps: ['Click the "Teleport" button'], expected_result: 'Gone' },
      { title: 'Teleport b', steps: ['Click the "Warp" button'], expected_result: 'Gone' },
      { title: 'Teleport c', steps: ['Click the "Portal" button'], expected_result: 'Gone' }
    ]);
    // …followed by one that grounds cleanly.
    const r = gate.admit([
      { title: 'Save the record', steps: ['Click the "Save" button'], expected_result: 'The record is stored' }
    ]);

    // The panel previously said "none of the tests could be matched" while
    // displaying tests that plainly had matched: the flag was sticky and the
    // comparison used a cumulative reject list against one batch's size.
    expect(gate.getAccepted().some(t => t._grounding === 'verified')).toBe(true);
    expect(r.crawlMismatch).toBe(false);
  });

  test('a genuine total mismatch is still reported', () => {
    const gate = new AcceptanceGate({ knowledgeGraph: kg, ticketData: ticket,
      deps: { GroundedVerifier, SemanticDuplicateDetector }, relevanceThreshold: 0 });
    const r = gate.admit([
      { title: 'Teleport a', steps: ['Click the "Teleport" button'], expected_result: 'Gone' },
      { title: 'Teleport b', steps: ['Click the "Warp" button'], expected_result: 'Gone' },
      { title: 'Teleport c', steps: ['Click the "Portal" button'], expected_result: 'Gone' }
    ]);
    expect(r.crawlMismatch).toBe(true);
  });
});
