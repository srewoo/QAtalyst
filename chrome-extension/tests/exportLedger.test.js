/**
 * F14 — idempotent export and neutral-format import.
 *
 * Re-running an export created every case twice; a request that timed out AFTER
 * the server created the case was indistinguishable from one that never arrived.
 * And deduplicating against the team's suite required TestRail specifically.
 */
const { ExportLedger, caseKey, importNeutralSuite, parseCsv } = require('../export-ledger.js');

const memStorage = () => {
  const store = {};
  return {
    store,
    get: async (k) => ({ [k]: store[k] }),
    set: async (obj) => Object.assign(store, obj)
  };
};

const CASE = { title: 'Owner deletes an invoice', steps: ['Click Delete'], expected_result: 'The invoice is deleted' };

describe('idempotent export', () => {
  test('a confirmed case is not sent a second time', async () => {
    const storage = memStorage();
    const l1 = await new ExportLedger(storage, 'testrail:1:2').load();
    l1.markConfirmed(CASE, 'C77');
    await l1.save();

    const l2 = await new ExportLedger(storage, 'testrail:1:2').load();
    const plan = l2.plan([CASE]);
    // Pre-fix: re-export created a duplicate every time.
    expect(plan.toSend).toHaveLength(0);
    expect(plan.alreadyExported[0].remoteId).toBe('C77');
  });

  test('an uncertain write is verified, not blindly retried', async () => {
    const storage = memStorage();
    const ledger = await new ExportLedger(storage, 'd').load();
    ledger.markUncertain(CASE, 'request timed out');

    const plan = ledger.plan([CASE]);
    expect(plan.toSend).toHaveLength(0);
    expect(plan.needsVerification).toHaveLength(1);

    // The server DID create it — reconciling must confirm, not duplicate.
    const { confirmed, toSend } = ledger.reconcile(plan.needsVerification, [{ ...CASE, id: 'C88' }]);
    expect(confirmed).toHaveLength(1);
    expect(toSend).toHaveLength(0);
    expect(ledger.get(CASE).status).toBe('confirmed');
  });

  test('an uncertain write that never landed IS retried', async () => {
    const ledger = await new ExportLedger(memStorage(), 'd').load();
    ledger.markUncertain(CASE, 'timeout');
    const plan = ledger.plan([CASE]);
    const { confirmed, toSend } = ledger.reconcile(plan.needsVerification, []); // destination is empty
    expect(confirmed).toHaveLength(0);
    expect(toSend).toHaveLength(1);
  });

  test('an outright failure is safe to retry', async () => {
    const ledger = await new ExportLedger(memStorage(), 'd').load();
    ledger.markFailed(CASE, 'HTTP 500');
    expect(ledger.plan([CASE]).toSend).toHaveLength(1);
  });

  test('ledger identity is the scenario, not the model-assigned id', () => {
    expect(caseKey({ ...CASE, id: 'A' })).toBe(caseKey({ ...CASE, id: 'B' }));
    expect(caseKey(CASE)).not.toBe(caseKey({ ...CASE, expected_result: 'Deletion is denied' }));
  });

  test('ledgers are scoped per destination', async () => {
    const storage = memStorage();
    const a = await new ExportLedger(storage, 'testrail:1:2').load();
    a.markConfirmed(CASE, 'C1');
    await a.save();
    const b = await new ExportLedger(storage, 'xray:PROJ').load();
    // Exporting to a different destination must still send the case.
    expect(b.plan([CASE]).toSend).toHaveLength(1);
  });
});

describe('neutral-format import', () => {
  test('imports a JSON suite from any platform', () => {
    const r = importNeutralSuite(JSON.stringify({ cases: [
      { id: 'X-1', title: 'Login works', steps: ['Click Login'], expected_result: 'Signed in' }
    ] }));
    expect(r.ok).toBe(true);
    expect(r.cases[0]).toMatchObject({ id: 'X-1', title: 'Login works', expected_result: 'Signed in' });
    expect(r.cases[0]._existing).toBe(true);
  });

  test('imports a CSV suite with recognised columns', () => {
    const r = importNeutralSuite(
      'ID,Title,Preconditions,Steps,Expected Result\n' +
      'C1,"Owner deletes invoice","Logged in as owner","1. Click Delete","The invoice is deleted"');
    expect(r.ok).toBe(true);
    expect(r.cases[0].title).toBe('Owner deletes invoice');
    expect(r.cases[0].steps).toEqual(['Click Delete']);
    expect(r.cases[0].preconditions).toBe('Logged in as owner');
  });

  test('handles quoted commas and embedded newlines', () => {
    const rows = parseCsv('A,B\n"x, y","line1\nline2"');
    expect(rows[1]).toEqual(['x, y', 'line1\nline2']);
  });

  test('an unreadable import reports failure, never "no existing cases"', () => {
    const r = importNeutralSuite('this is not a suite {');
    expect(r.ok).toBe(false);
    expect(r.cases).toEqual([]);
    expect(r.error).toBeTruthy();
  });

  test('a CSV with no title column is rejected with a usable message', () => {
    const r = importNeutralSuite('Foo,Bar\n1,2');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/title column/i);
  });

  test('imported cases feed the same duplicate checks as TestRail cases', () => {
    const SemanticDuplicateDetector = require('../semantic-duplicate-detector.js');
    const imported = importNeutralSuite(JSON.stringify([
      { title: 'Successful user login', steps: ['Enter email', 'Enter password', 'Click Login'], expected_result: 'The dashboard is displayed' }
    ])).cases;
    const verdict = SemanticDuplicateDetector.classifyPair(
      { title: 'User logs in successfully', steps: ['Enter email', 'Enter password', 'Click Login'], expected_result: 'The dashboard is displayed' },
      imported[0], { threshold: 0.68 });
    expect(verdict.merge).toBe(true);
  });
});
