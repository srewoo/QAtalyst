/**
 * Tests for content-export.js — the pure CSV + clipboard text builders extracted
 * from content.js. Imports the REAL module (no DOM / IO needed).
 */
const { buildTestCasesCSV, buildTestCasesClipboardText } = require('../content-export.js');

describe('buildTestCasesCSV', () => {
  // F27: CSV now carries Source / Historical Reference / Rationale columns.
  const HEADER = 'ID,Title,Category,Priority,Description,Preconditions,Steps,Test Data,Expected Result,Requirement IDs,Grounding,Review Needed,Source,Historical Reference,Rationale';

  test('emits the fixed header row first', () => {
    const csv = buildTestCasesCSV([]);
    expect(csv).toBe(HEADER);
  });

  test('one quoted row per test case in order', () => {
    const csv = buildTestCasesCSV([
      { id: 'TC-1', title: 'Login', category: 'Positive', priority: 'P0', description: 'd1', expected_result: 'ok' },
      { id: 'TC-2', title: 'Logout', category: 'Negative', priority: 'P1', description: 'd2', expected_result: 'bye' },
    ]);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('"TC-1","Login","Positive","P0","d1","","","","ok","","","","","",""');
    expect(lines[2]).toBe('"TC-2","Logout","Negative","P1","d2","","","","bye","","","","","",""');
  });

  test('escapes embedded double-quotes by doubling them', () => {
    const csv = buildTestCasesCSV([
      { id: 'TC-1', title: 'Click "Save" button', category: 'Positive', priority: 'P0', description: 'has "quotes"', expected_result: 'saved' },
    ]);
    expect(csv.split('\n')[1]).toBe('"TC-1","Click ""Save"" button","Positive","P0","has ""quotes""","","","","saved","","","","","",""');
  });

  test('commas inside fields stay inside the quoted cell (not new columns)', () => {
    const csv = buildTestCasesCSV([
      { id: 'TC-1', title: 'a, b, c', category: 'Positive', priority: 'P0', description: 'x,y', expected_result: 'p,q' },
    ]);
    const row = csv.split('\n')[1];
    expect(row).toBe('"TC-1","a, b, c","Positive","P0","x,y","","","","p,q","","","","","",""');
  });

  test('newlines inside a field are preserved within the quoted cell', () => {
    const csv = buildTestCasesCSV([
      { id: 'TC-1', title: 'line1\nline2', category: 'Edge', priority: 'P2', description: 'multi\nline', expected_result: 'ok' },
    ]);
    // The field newline is literal; quoting keeps it part of the cell value.
    expect(csv).toContain('"line1\nline2"');
    expect(csv).toContain('"multi\nline"');
  });

  test('supports expectedResult camelCase alias and missing fields', () => {
    const csv = buildTestCasesCSV([
      { id: 'TC-1', title: 'T', expectedResult: 'via camelCase' },
    ]);
    expect(csv.split('\n')[1]).toBe('"TC-1","T","","","","","","","via camelCase","","","","","",""');
  });

  test('carries regression provenance (F27)', () => {
    const csv = buildTestCasesCSV([
      { id: 'TC-9', title: 'Reset still works', category: 'Regression', priority: 'P1', expected_result: 'ok', historicalReference: 'PROJ-42', rationale: 'guards password reset regression' },
    ]);
    const row = csv.split('\n')[1];
    expect(row).toContain('"regression"');
    expect(row).toContain('"PROJ-42"');
    expect(row).toContain('"guards password reset regression"');
  });

  test('infers regression source from _proposedFor when source absent (F27)', () => {
    const csv = buildTestCasesCSV([
      { id: 'TC-9', title: 'x', category: 'Regression', _proposedFor: { category: 'Regression' } },
    ]);
    expect(csv.split('\n')[1]).toContain('"regression"');
  });

  test('exports the fields needed to actually execute the test (F15)', () => {
    const csv = buildTestCasesCSV([{
      id: 'TC-1', title: 'Login', category: 'Positive', priority: 'P0',
      preconditions: 'User is logged out',
      steps: ['Open the login page', 'Enter valid credentials', 'Click Login'],
      test_data: 'user@example.com / hunter2',
      expected_result: 'The dashboard is displayed'
    }]);
    const row = csv.split('\n').slice(1).join('\n');
    expect(row).toContain('User is logged out');
    expect(row).toContain('1. Open the login page');
    expect(row).toContain('3. Click Login');
    expect(row).toContain('user@example.com / hunter2');
  });

  test('marks cases that need review before execution (F15)', () => {
    const csv = buildTestCasesCSV([
      { id: 'TC-1', title: 'ok', expected_result: 'x', _grounding: 'verified' },
      { id: 'TC-2', title: 'risky', expected_result: 'x', _grounding: 'unresolved',
        _assertionWarning: 'expected result may be inverted' }
    ]);
    const rows = csv.split('\n');
    expect(rows[1]).toContain('"verified"');
    expect(rows[2]).toContain('"unresolved"');
    expect(rows[2]).toContain('unresolved app references');
    expect(rows[2]).toContain('expected result may be inverted');
  });

  test('neutralises spreadsheet formula injection from model-authored text', () => {
    const csv = buildTestCasesCSV([
      { id: 'TC-1', title: '=HYPERLINK("http://evil","click")', expected_result: '+1+1' }
    ]);
    const row = csv.split('\n')[1];
    expect(row).toContain("\"'=HYPERLINK");
    expect(row).toContain("\"'+1+1\"");
    expect(row).not.toContain('"=HYPERLINK');
  });

  test('handles empty / null input', () => {
    expect(buildTestCasesCSV(null)).toBe(HEADER);
  });

  test('stringifies object fields instead of printing [object Object]', () => {
    const csv = buildTestCasesCSV([
      { id: 'TC-1', title: 'T', description: { note: 'obj desc' }, expected_result: 'ok' },
    ]);
    expect(csv).not.toContain('[object Object]');
    expect(csv).toContain('obj desc');
  });
});

describe('buildTestCasesClipboardText', () => {
  const TWO = [
    { id: 'TC-1', title: 'Login', category: 'Positive', priority: 'P0', description: 'happy', steps: ['open', 'submit'], expected_result: 'dashboard', preconditions: 'logged out', test_data: 'user/pass' },
    { id: 'TC-2', title: 'Logout', category: 'Negative', priority: 'P1', description: 'fail' },
  ];

  test('starts with the QAtalyst header banner', () => {
    const txt = buildTestCasesClipboardText(TWO);
    expect(txt.startsWith('QAtalyst Test Cases\n===================\n\n')).toBe(true);
  });

  test('omits the Active Filters block when no filters active', () => {
    const txt = buildTestCasesClipboardText(TWO, { activeFilter: 'all', searchQuery: '', priorityFilter: 'all' });
    expect(txt).not.toContain('Active Filters:');
  });

  test('includes the Active Filters block listing each active filter', () => {
    const txt = buildTestCasesClipboardText(TWO, { activeFilter: 'Positive', searchQuery: 'login', priorityFilter: 'P0' });
    expect(txt).toContain('Active Filters:');
    expect(txt).toContain('- Category: Positive');
    expect(txt).toContain('- Search: "login"');
    expect(txt).toContain('- Priority: P0');
    expect(txt).toContain('Showing 2 test case(s)');
  });

  test('only lists the filters that are actually set', () => {
    const txt = buildTestCasesClipboardText(TWO, { activeFilter: 'all', searchQuery: 'foo', priorityFilter: 'all' });
    expect(txt).toContain('- Search: "foo"');
    expect(txt).not.toContain('- Category:');
    expect(txt).not.toContain('- Priority:');
  });

  test('renders full detail for a case including steps, preconditions, test data', () => {
    const txt = buildTestCasesClipboardText([TWO[0]]);
    expect(txt).toContain('Test Case #1');
    expect(txt).toContain('ID: TC-1');
    expect(txt).toContain('Title: Login');
    expect(txt).toContain('Category: Positive');
    expect(txt).toContain('Priority: P0');
    expect(txt).toContain('Preconditions: logged out');
    expect(txt).toContain('Steps:\n  1. open\n  2. submit\n');
    expect(txt).toContain('Expected Result: dashboard');
    expect(txt).toContain('Test Data: user/pass');
  });

  test('falls back to N/A and omits optional sections when absent', () => {
    const txt = buildTestCasesClipboardText([TWO[1]]);
    expect(txt).toContain('Description: fail');
    expect(txt).toContain('Expected Result: N/A');
    expect(txt).not.toContain('Preconditions:');
    expect(txt).not.toContain('Steps:');
    expect(txt).not.toContain('Test Data:');
  });

  test('numbers multiple cases sequentially', () => {
    const txt = buildTestCasesClipboardText(TWO);
    expect(txt).toContain('Test Case #1');
    expect(txt).toContain('Test Case #2');
  });

  test('handles empty input (header only, no filter block)', () => {
    const txt = buildTestCasesClipboardText([]);
    expect(txt).toBe('QAtalyst Test Cases\n===================\n\n');
  });

  test('stringifies object test_data/preconditions instead of [object Object]', () => {
    const txt = buildTestCasesClipboardText([{
      id: 'TC-1', title: 'T', category: 'Edge', priority: 'P1',
      preconditions: { loggedIn: true },
      test_data: { user: 'alice', sessions: 3 },
      expected_result: 'ok',
    }]);
    expect(txt).not.toContain('[object Object]');
    expect(txt).toContain('alice');
    expect(txt).toContain('loggedIn');
  });
});

describe('F07/F15 — exported cases cite their requirements', () => {
  test('requirement ids appear in the export', () => {
    const csv = buildTestCasesCSV([
      { id: 'TC-1', title: 'Owner deletes an invoice', expected_result: 'Deleted',
        requirementIds: ['INV-1-R001', 'INV-1-R003'] }
    ]);
    expect(csv.split('\n')[0]).toContain('Requirement IDs');
    expect(csv.split('\n')[1]).toContain('INV-1-R001 INV-1-R003');
  });

  test('a case with no requirement link exports an empty cell, not a fabricated one', () => {
    const csv = buildTestCasesCSV([{ id: 'TC-2', title: 'x', expected_result: 'y' }]);
    expect(csv.split('\n')[1]).toContain('""');
  });
});
