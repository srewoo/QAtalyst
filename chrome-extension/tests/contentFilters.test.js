/**
 * Tests for content-filters.js — the pure test-case FILTER predicates extracted
 * from content.js. Imports the REAL module (no DOM needed — pure logic).
 */
const { filterTestCases, hasActiveFilters } = require('../content-filters.js');

const SAMPLE = [
  { id: 'TC-1', title: 'Login with valid creds', description: 'happy path', category: 'Positive', priority: 'P0', steps: ['open login', 'submit'], expected_result: 'redirected to dashboard' },
  { id: 'TC-2', title: 'Login with wrong password', description: 'auth failure', category: 'Negative', priority: 'P1', steps: ['open login', 'enter bad password'], expected_result: 'error shown' },
  { id: 'TC-3', title: 'Empty username field', description: 'boundary', category: 'Edge', priority: 'P2', steps: ['leave username empty'], expectedResult: 'validation message' },
  { id: 'TC-4', title: 'Logout regression', description: 'session cleared', category: 'Regression', priority: 'P0', steps: ['click logout'], expected_result: 'back to login' },
];

describe('filterTestCases', () => {
  test('returns all cases when no filters active', () => {
    const out = filterTestCases(SAMPLE, { activeFilter: 'all', searchQuery: '', priorityFilter: 'all' });
    expect(out).toHaveLength(4);
  });

  test('defaults to no filtering when state omitted', () => {
    expect(filterTestCases(SAMPLE)).toHaveLength(4);
    expect(filterTestCases(SAMPLE, undefined)).toHaveLength(4);
  });

  test('does not mutate the input array', () => {
    const copy = [...SAMPLE];
    const out = filterTestCases(SAMPLE, { activeFilter: 'Positive' });
    expect(SAMPLE).toEqual(copy);
    expect(out).not.toBe(SAMPLE);
  });

  test('filters by category returns only that category', () => {
    const out = filterTestCases(SAMPLE, { activeFilter: 'Negative' });
    expect(out.map(tc => tc.id)).toEqual(['TC-2']);
  });

  test('filters by priority returns the right subset', () => {
    const out = filterTestCases(SAMPLE, { priorityFilter: 'P0' });
    expect(out.map(tc => tc.id)).toEqual(['TC-1', 'TC-4']);
  });

  test('category + priority filters combine (AND)', () => {
    const out = filterTestCases(SAMPLE, { activeFilter: 'Regression', priorityFilter: 'P0' });
    expect(out.map(tc => tc.id)).toEqual(['TC-4']);
    const none = filterTestCases(SAMPLE, { activeFilter: 'Positive', priorityFilter: 'P1' });
    expect(none).toHaveLength(0);
  });

  test('search matches title', () => {
    const out = filterTestCases(SAMPLE, { searchQuery: 'logout' });
    expect(out.map(tc => tc.id)).toEqual(['TC-4']);
  });

  test('search matches description', () => {
    const out = filterTestCases(SAMPLE, { searchQuery: 'boundary' });
    expect(out.map(tc => tc.id)).toEqual(['TC-3']);
  });

  test('search matches step text', () => {
    const out = filterTestCases(SAMPLE, { searchQuery: 'bad password' });
    expect(out.map(tc => tc.id)).toEqual(['TC-2']);
  });

  test('search matches expected_result and the expectedResult alias', () => {
    expect(filterTestCases(SAMPLE, { searchQuery: 'dashboard' }).map(tc => tc.id)).toEqual(['TC-1']);
    // TC-3 uses expectedResult (camelCase) not expected_result
    expect(filterTestCases(SAMPLE, { searchQuery: 'validation message' }).map(tc => tc.id)).toEqual(['TC-3']);
  });

  test('search is case-insensitive against an already-lowercased query', () => {
    // content.js lowercases the query before calling; we pass lowercase here.
    // matches title (TC-1/TC-2) and TC-4's expected_result "back to login"
    const out = filterTestCases(SAMPLE, { searchQuery: 'login' });
    expect(out.map(tc => tc.id)).toEqual(['TC-1', 'TC-2', 'TC-4']);
  });

  test('all three filters combine', () => {
    const out = filterTestCases(SAMPLE, { activeFilter: 'Positive', searchQuery: 'login', priorityFilter: 'P0' });
    expect(out.map(tc => tc.id)).toEqual(['TC-1']);
  });

  test('handles empty / null input gracefully', () => {
    expect(filterTestCases([], { activeFilter: 'Positive' })).toEqual([]);
    expect(filterTestCases(null, {})).toEqual([]);
  });

  test('non-matching category yields empty list', () => {
    expect(filterTestCases(SAMPLE, { activeFilter: 'Security' })).toEqual([]);
  });
});

describe('hasActiveFilters', () => {
  test('false when everything is at default', () => {
    expect(hasActiveFilters({ activeFilter: 'all', searchQuery: '', priorityFilter: 'all' })).toBe(false);
    expect(hasActiveFilters({})).toBe(false);
    expect(hasActiveFilters(undefined)).toBe(false);
  });

  test('true when category filter set', () => {
    expect(hasActiveFilters({ activeFilter: 'Positive' })).toBe(true);
  });

  test('true when search query set', () => {
    expect(hasActiveFilters({ searchQuery: 'foo' })).toBe(true);
  });

  test('true when priority filter set', () => {
    expect(hasActiveFilters({ priorityFilter: 'P1' })).toBe(true);
  });

  test('returns a real boolean even for a truthy search string', () => {
    expect(hasActiveFilters({ searchQuery: 'x' })).toBe(true);
  });
});
