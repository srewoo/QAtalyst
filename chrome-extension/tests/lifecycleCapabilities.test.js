/**
 * §15.1-15.3, §15.6 — reviewer decisions, requirement-change updates, execution
 * readiness and clarification questions.
 */
const { ReviewMemory, buildManifest, diffManifests, hashRequirement } = require('../review-memory.js');
const { assessExecutability, clarificationQuestions, unresolvedLedger } = require('../readiness.js');
const RM = require('../requirement-model.js');

const memStorage = () => {
  const store = {};
  return { store, get: async (k) => ({ [k]: store[k] }), set: async (o) => Object.assign(store, o) };
};
const tc = (title, steps = ['Do a thing'], expected = 'Something observable happens', extra = {}) =>
  ({ title, steps, expected_result: expected, ...extra });

describe('§15.1 — reviewer decisions are kept, not re-litigated', () => {
  test('a rejected scenario does not come back on the same unchanged ticket', async () => {
    const m = await new ReviewMemory(memStorage(), 'PROJ').load();
    const irrelevant = tc('Test the marketing footer');
    m.record(irrelevant, 'irrelevant', { reason: 'not part of this feature', requirementRevision: 'r1' });

    const { kept, suppressed } = m.apply([irrelevant, tc('Owner deletes an invoice')], { requirementRevision: 'r1' });
    expect(kept.map(k => k.title)).toEqual(['Owner deletes an invoice']);
    expect(suppressed[0].reason).toBe('not part of this feature');
  });

  test('a decision goes stale when the requirement moves under it', async () => {
    const m = await new ReviewMemory(memStorage(), 'PROJ').load();
    const case1 = tc('Upload a 100 KB file');
    m.record(case1, 'irrelevant', { requirementRevision: 'r1' });

    const { kept, suppressed, stale } = m.apply([case1], { requirementRevision: 'r2' });
    // The requirement changed — the old decision must be re-reviewed, not applied
    // to behaviour it was never about.
    expect(suppressed).toHaveLength(0);
    expect(kept[0]._decisionStale).toBe(true);
    expect(stale).toHaveLength(1);
  });

  test('another project does not inherit the decision', async () => {
    const storage = memStorage();
    const a = await new ReviewMemory(storage, 'PROJ-A').load();
    a.record(tc('Shared looking case'), 'irrelevant', {});
    await a.save();
    const b = await new ReviewMemory(storage, 'PROJ-B').load();
    expect(b.apply([tc('Shared looking case')], {}).suppressed).toHaveLength(0);
  });

  test('an edited case is locked against regeneration', async () => {
    const m = await new ReviewMemory(memStorage(), 'PROJ').load();
    const edited = tc('Owner deletes an invoice');
    m.record(edited, 'edited', { reason: 'corrected the expected result' });
    const { kept, locked } = m.apply([edited], {});
    expect(locked).toEqual(['Owner deletes an invoice']);
    expect(kept[0]._locked).toBe(true);
  });

  test('a pair marked distinct is protected from future merging', async () => {
    const m = await new ReviewMemory(memStorage(), 'PROJ').load();
    const { scenarioKey } = require('../review-memory.js');
    const a = tc('Owner can delete'), b = tc('Viewer cannot delete');
    m.record(a, 'distinct_from', { relatedKey: scenarioKey(b) });
    expect(m.isProtectedPair(a, b)).toBe(true);
    expect(m.isProtectedPair(a, tc('Unrelated case'))).toBe(false);
  });

  test('decisions survive a reload', async () => {
    const storage = memStorage();
    const m1 = await new ReviewMemory(storage, 'PROJ').load();
    m1.record(tc('X'), 'irrelevant', {});
    await m1.save();
    const m2 = await new ReviewMemory(storage, 'PROJ').load();
    expect(m2.get(tc('X')).verdict).toBe('irrelevant');
  });
});

describe('§15.2 — suite updates when requirements change', () => {
  const reqsV1 = RM.buildRequirements(['Uploads above 100 KB must be rejected', 'An owner can delete an invoice'], { ticketKey: 'T' });
  const reqsV2 = RM.buildRequirements(['Uploads above 250 KB must be rejected', 'An owner can delete an invoice'], { ticketKey: 'T' });
  const reqsWorded = RM.buildRequirements(['Any upload over 100 KB must be rejected', 'An owner can delete an invoice'], { ticketKey: 'T' });

  test('a changed limit marks only that obligation as needing an update', () => {
    const d = diffManifests(
      buildManifest({ requirements: reqsV1 }), buildManifest({ requirements: reqsV2 }));
    expect(d.updateRequired).toHaveLength(1);
    expect(d.unchanged).toHaveLength(1);
  });

  test('rewording without changing behaviour does not churn the suite', () => {
    const d = diffManifests(
      buildManifest({ requirements: reqsV1 }), buildManifest({ requirements: reqsWorded }));
    // "above 100 KB" vs "over 100 KB" is the same obligation.
    expect(d.updateRequired).toHaveLength(0);
    expect(d.unchanged).toHaveLength(2);
  });

  test('a removed requirement is proposed for retirement WITH its reason', () => {
    const d = diffManifests(
      buildManifest({ requirements: reqsV1 }),
      buildManifest({ requirements: RM.buildRequirements(['An owner can delete an invoice'], { ticketKey: 'T' }) }));
    expect(d.possiblyObsolete.length).toBeGreaterThan(0);
    // Deleting a case automatically could remove real regression protection.
    expect(d.possiblyObsolete[0].reason).toMatch(/no longer present/);
  });

  test('a new requirement is newly needed, not an update', () => {
    const d = diffManifests(
      buildManifest({ requirements: RM.buildRequirements(['An owner can delete an invoice'], { ticketKey: 'T' }) }),
      buildManifest({ requirements: reqsV1 }));
    expect(d.newlyNeeded.length).toBeGreaterThan(0);
  });

  test('the manifest records what the run was generated from', () => {
    const m = buildManifest({
      ticketKey: 'T-1', ticketRevision: 'rev9', requirements: reqsV1,
      settings: { testCount: 20, coverageTarget: 80 }, model: 'gpt-4.1',
      testCases: [{ id: 'TC-001' }]
    });
    expect(m).toMatchObject({ ticketKey: 'T-1', ticketRevision: 'rev9', model: 'gpt-4.1' });
    expect(m.caseIds).toEqual(['TC-001']);
    expect(m.settings.testCount).toBe(20);
  });
});

describe('§15.3 — executability', () => {
  test('a fully specified case is automation ready', () => {
    const r = assessExecutability(tc('Owner deletes an invoice',
      ['Log in as owner', 'Click Delete'], 'The invoice disappears from the list',
      { preconditions: 'An invoice exists and the user is an owner', test_data: 'invoice #4711' }));
    expect(r.level).toBe('automation_ready');
  });

  test('a case needing fault injection is manual-ready with the dependency named', () => {
    const r = assessExecutability(tc('Timeout shows an error', ['Call the endpoint'], 'A timeout message appears'));
    expect(r.level).toBe('manual_ready');
    expect(r.blockers.join(' ')).toMatch(/induce the timeout/);
  });

  test('a migration case names its fixture dependency', () => {
    const r = assessExecutability(tc('Legacy users keep access', ['Open the app'], 'The dashboard loads'));
    expect(r.blockers.join(' ')).toMatch(/pre-migration fixture/);
  });

  test('a case with no oracle is specification-only', () => {
    const r = assessExecutability({ title: 'Check the thing', steps: ['Do it'], expected_result: '' });
    expect(r.level).toBe('specification_only');
    expect(r.missing.join(' ')).toMatch(/expected result/);
  });

  test('a role-sensitive case that never establishes the role is flagged', () => {
    const r = assessExecutability(tc('Admin sees the audit log', ['Open the audit log'], 'Entries are listed'));
    expect(r.missing.join(' ')).toMatch(/acting role/);
  });

  test('typing an email address is not a delivery dependency', () => {
    const r = assessExecutability(tc('Login', ['Enter email', 'Click Login'], 'The dashboard is shown',
      { preconditions: 'User is logged out' }));
    expect(r.level).toBe('automation_ready');
  });
});

describe('§15.6 — targeted clarification questions', () => {
  const reqs = RM.buildRequirements([
    'Uploads up to 100 KB are accepted',
    'The retry behaviour is TBD',
    'Users must not be able to resubmit the form'
  ], { ticketKey: 'X' });

  test('an unstated inclusivity produces a specific question', () => {
    const qs = clarificationQuestions(reqs, []);
    expect(qs.some(q => /inclusive or exclusive/.test(q.question))).toBe(true);
  });

  test('an ambiguous requirement is asked about rather than guessed', () => {
    const qs = clarificationQuestions(reqs, []);
    expect(qs.some(q => /not settled/.test(q.question))).toBe(true);
  });

  test('questions name the cases that depend on the answer', () => {
    const cases = [tc('Upload at the limit', ['Upload 100 KB'], 'Accepted', { requirementIds: [reqs[0].id] })];
    const qs = clarificationQuestions(reqs, cases);
    const bound = qs.find(q => /inclusive/.test(q.question));
    expect(bound.blocks).toContain('Upload at the limit');
  });

  test('the same question is never asked twice', () => {
    const qs = clarificationQuestions([...reqs, ...reqs], []);
    const texts = qs.map(q => q.question.toLowerCase());
    expect(new Set(texts).size).toBe(texts.length);
  });

  test('unanswered questions keep their obligations unresolved', () => {
    const qs = clarificationQuestions(reqs, []);
    const open = unresolvedLedger(reqs, qs, {});
    expect(open.length).toBe(qs.length);
    // Answering one closes exactly one.
    const closed = unresolvedLedger(reqs, qs, { [qs[0].id]: 'inclusive' });
    expect(closed.length).toBe(qs.length - 1);
  });

  test('a clear ticket yields no questions', () => {
    const clear = RM.buildRequirements(['An owner can delete an invoice'], { ticketKey: 'C' });
    expect(clarificationQuestions(clear, [])).toHaveLength(0);
  });
});
