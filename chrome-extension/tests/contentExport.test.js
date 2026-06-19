/**
 * Tests for content-export.js — the pure CSV + clipboard text builders extracted
 * from content.js. Imports the REAL module (no DOM / IO needed).
 */
const { buildTestCasesCSV, buildTestCasesClipboardText } = require('../content-export.js');

describe('buildTestCasesCSV', () => {
  test('emits the fixed header row first', () => {
    const csv = buildTestCasesCSV([]);
    expect(csv).toBe('ID,Title,Category,Priority,Description,Expected Result');
  });

  test('one quoted row per test case in order', () => {
    const csv = buildTestCasesCSV([
      { id: 'TC-1', title: 'Login', category: 'Positive', priority: 'P0', description: 'd1', expected_result: 'ok' },
      { id: 'TC-2', title: 'Logout', category: 'Negative', priority: 'P1', description: 'd2', expected_result: 'bye' },
    ]);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('"TC-1","Login","Positive","P0","d1","ok"');
    expect(lines[2]).toBe('"TC-2","Logout","Negative","P1","d2","bye"');
  });

  test('escapes embedded double-quotes by doubling them', () => {
    const csv = buildTestCasesCSV([
      { id: 'TC-1', title: 'Click "Save" button', category: 'Positive', priority: 'P0', description: 'has "quotes"', expected_result: 'saved' },
    ]);
    expect(csv.split('\n')[1]).toBe('"TC-1","Click ""Save"" button","Positive","P0","has ""quotes""","saved"');
  });

  test('commas inside fields stay inside the quoted cell (not new columns)', () => {
    const csv = buildTestCasesCSV([
      { id: 'TC-1', title: 'a, b, c', category: 'Positive', priority: 'P0', description: 'x,y', expected_result: 'p,q' },
    ]);
    const row = csv.split('\n')[1];
    expect(row).toBe('"TC-1","a, b, c","Positive","P0","x,y","p,q"');
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
    expect(csv.split('\n')[1]).toBe('"TC-1","T","","","","via camelCase"');
  });

  test('handles empty / null input', () => {
    expect(buildTestCasesCSV(null)).toBe('ID,Title,Category,Priority,Description,Expected Result');
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
});
