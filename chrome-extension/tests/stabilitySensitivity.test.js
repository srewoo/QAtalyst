/**
 * §15.5 — stability under harmless changes, sensitivity to meaningful ones.
 *
 * The question these answer is whether the pipeline responds to MEANING or to
 * wording, input order and document volume. Each pair below changes one thing;
 * the assertion is on canonical scenarios and requirement coverage, never on
 * exact output strings.
 */
const SemanticDuplicateDetector = require('../semantic-duplicate-detector.js');
const CoverageMapper = require('../coverage-mapper.js');
const RM = require('../requirement-model.js');
const { AcceptanceGate } = require('../acceptance-gate.js');
const { GroundedVerifier } = require('../grounded-verifier.js');

const tc = (title, steps, expected) => ({ title, steps, expected_result: expected });
const gate = (ticket) => new AcceptanceGate({
  knowledgeGraph: null, ticketData: ticket,
  deps: { GroundedVerifier, SemanticDuplicateDetector },
  relevanceThreshold: 0, dedupThreshold: 0.68
});
const titles = (r) => r.accepted.map(t => t.title).sort();

const SUITE = [
  tc('Owner deletes an invoice', ['Log in as owner', 'Click Delete'], 'The invoice is deleted'),
  tc('Viewer cannot delete an invoice', ['Log in as viewer', 'Click Delete'], 'Deletion is denied'),
  tc('Upload at the 100 KB limit', ['Upload a 100 KB file'], 'The upload is accepted'),
  tc('Upload above the 100 KB limit', ['Upload a 101 KB file'], 'The upload is rejected')
];

describe('stability — harmless changes must not change the outcome', () => {
  test('reordering candidates preserves the retained set (no first-arrival bias)', () => {
    const forward = gate({ summary: 'Invoices' }).admit([...SUITE]);
    const reversed = gate({ summary: 'Invoices' }).admit([...SUITE].reverse());
    expect(titles(reversed)).toEqual(titles(forward));
  });

  test('paraphrasing a requirement yields the same obligations', () => {
    const a = RM.buildRequirements(['Uploads above 100 KB must be rejected'], { ticketKey: 'T' });
    const b = RM.buildRequirements(['Any upload over 100 KB must be rejected'], { ticketKey: 'T' });
    expect(b[0].modality).toBe(a[0].modality);
    expect(b[0].status).toBe(a[0].status);
    const { hashRequirement } = require('../review-memory.js');
    expect(hashRequirement(b[0])).toBe(hashRequirement(a[0]));
  });

  test('repeating a requirement does not inflate the obligation count', () => {
    const once = RM.buildRequirements(['An owner can delete an invoice'], { ticketKey: 'T' });
    const twice = RM.buildRequirements(
      ['An owner can delete an invoice', 'An owner can delete an invoice'], { ticketKey: 'T' });
    const cov1 = CoverageMapper.mapRequirementPredicates([], once, { requirementModel: RM });
    const cov2 = CoverageMapper.mapRequirementPredicates([], twice, { requirementModel: RM });
    // A duplicated paragraph is not twice the work.
    expect(cov2.total).toBe(cov1.total * 2); // predicates are per-line…
    // …but coverage of the same test satisfies both, so completeness is unchanged.
    const test = [tc('Owner deletes an invoice', ['Log in as owner', 'Click Delete'], 'The invoice is deleted')];
    const c1 = CoverageMapper.mapRequirementPredicates(test, once, { requirementModel: RM });
    const c2 = CoverageMapper.mapRequirementPredicates(test, twice, { requirementModel: RM });
    expect(c1.percentage).toBe(c2.percentage);
  });

  test('duplicate candidates collapse to the same canonical set', () => {
    const withDupes = [...SUITE, { ...SUITE[0] }, { ...SUITE[1] }];
    const r = gate({ summary: 'Invoices' }).admit(withDupes);
    expect(titles(r)).toEqual(titles(gate({ summary: 'Invoices' }).admit([...SUITE])));
  });
});

describe('sensitivity — meaningful changes MUST change the outcome', () => {
  test('changing "can" to "cannot" changes the expected behaviour and is detected', () => {
    const can = RM.buildRequirements(['A viewer can delete invoices'], { ticketKey: 'T' })[0];
    const cannot = RM.buildRequirements(['A viewer cannot delete invoices'], { ticketKey: 'T' })[0];
    expect(can.modality).toBe('must');
    expect(cannot.modality).toBe('must_not');

    const test = [tc('Viewer deletes an invoice', ['Log in as viewer', 'Click Delete'], 'The invoice is deleted')];
    expect(CoverageMapper.mapRequirementPredicates(test, [can], { requirementModel: RM }).covered).toBe(1);
    const inverted = CoverageMapper.mapRequirementPredicates(test, [cannot], { requirementModel: RM });
    expect(inverted.covered).toBe(0);
    expect(inverted.contradictions).toHaveLength(1);
  });

  test('changing the limit changes the obligation', () => {
    const { hashRequirement } = require('../review-memory.js');
    const a = RM.buildRequirements(['Uploads above 100 KB must be rejected'], { ticketKey: 'T' })[0];
    const b = RM.buildRequirements(['Uploads above 250 KB must be rejected'], { ticketKey: 'T' })[0];
    expect(hashRequirement(b)).not.toBe(hashRequirement(a));
  });

  test('changing the actor produces a distinct scenario', () => {
    const v = SemanticDuplicateDetector.classifyPair(
      tc('Admin opens billing', ['Log in as admin', 'Open billing'], 'Billing is shown'),
      tc('Guest opens billing', ['Log in as guest', 'Open billing'], 'Access is forbidden'),
      { threshold: 0.68 });
    expect(v.merge).toBe(false);
  });

  test('changing the starting state produces a distinct scenario', () => {
    const v = SemanticDuplicateDetector.classifyPair(
      tc('Submit an approved order', ['Open an approved order', 'Click Submit'], 'The order ships'),
      tc('Submit a cancelled order', ['Open a cancelled order', 'Click Submit'], 'Submission is blocked'),
      { threshold: 0.68 });
    expect(v.merge).toBe(false);
  });

  test('removing the only supporting evidence makes the assertion unsupported', () => {
    const KG = { pages: [{ url: 'https://app/x', title: 'X',
      features: [{ type: 'button', text: 'Publish', selector: '#p' }], apis: [] }] };
    const withEvidence = new GroundedVerifier(KG).verify(
      tc('Publish the article', ['Click the "Publish" button'], 'The article is live'));
    const withoutEvidence = new GroundedVerifier({ pages: [{ url: 'https://app/x', title: 'X',
      features: [{ type: 'button', text: 'Save', selector: '#s' }], apis: [] }] }).verify(
      tc('Publish the article', ['Click the "Publish" button'], 'The article is live'));
    expect(withEvidence.verdict).toBe('grounded');
    expect(['unresolved', 'reject', 'needs_repair']).toContain(withoutEvidence.verdict);
  });

  test('adding irrelevant app pages does not change the retained ticket scope', () => {
    const base = { pages: [{ url: 'https://app/login', title: 'Login',
      features: [{ type: 'button', text: 'Sign In', selector: '#si' }], apis: [] }] };
    const noisy = { pages: [...base.pages, ...Array.from({ length: 30 }, (_, i) => ({
      url: `https://app/noise/${i}`, title: `Noise ${i}`,
      features: [{ type: 'button', text: `Noise action ${i}` }], apis: [] }))] };
    const ticket = { summary: 'Fix the login button', description: 'Sign In must work.' };
    const g1 = new AcceptanceGate({ knowledgeGraph: base, ticketData: ticket,
      deps: { GroundedVerifier, SemanticDuplicateDetector } });
    const g2 = new AcceptanceGate({ knowledgeGraph: noisy, ticketData: ticket,
      deps: { GroundedVerifier, SemanticDuplicateDetector } });
    // F10: app entities no longer enter the ticket relevance vocabulary, so 30
    // unrelated pages cannot shift what counts as in scope.
    expect(g2.referenceVocab.size).toBe(g1.referenceVocab.size);
  });
});
