/**
 * content-filters.js — pure, DOM-free test-case FILTER logic extracted from
 * content.js to make the filtering predicates independently unit-testable.
 *
 * IIFE-wrapped (content scripts share one page scope). The functions are
 * exposed on the page global via Object.assign(self|window, api) so content.js
 * — which the manifest loads AFTER this file — can call them. The same `api`
 * is exported via module.exports for unit tests.
 *
 * These functions are PURE: filter state (activeFilter / searchQuery /
 * priorityFilter) is passed in explicitly rather than read from module-level
 * mutable globals, so callers in content.js delegate to them by supplying the
 * current state. No I/O, no chrome.*, no DOM.
 */
(function () {
  'use strict';

  /**
   * Filter a list of test cases by category, free-text search, and priority.
   * Behaviour preserved verbatim from content.js's getFilteredTestCases.
   *
   * @param {Array<object>} testCases
   * @param {{activeFilter?: string, searchQuery?: string, priorityFilter?: string}} state
   * @returns {Array<object>} new filtered array (input is not mutated)
   */
  function filterTestCases(testCases, state) {
    const {
      activeFilter = 'all',
      searchQuery = '',
      priorityFilter = 'all'
    } = state || {};

    let filteredTests = [...(testCases || [])];

    // Apply category filter
    if (activeFilter !== 'all') {
      filteredTests = filteredTests.filter(tc => tc.category === activeFilter);
    }

    // Apply search filter
    if (searchQuery) {
      filteredTests = filteredTests.filter(tc => {
        const searchableText = `${tc.title} ${tc.description} ${tc.steps?.join(' ')} ${tc.expected_result || tc.expectedResult || ''}`.toLowerCase();
        return searchableText.includes(searchQuery);
      });
    }

    // Apply priority filter
    if (priorityFilter !== 'all') {
      filteredTests = filteredTests.filter(tc => tc.priority === priorityFilter);
    }

    return filteredTests;
  }

  /**
   * Whether any filter is active given the current filter state.
   * Mirrors the `hasFilters` expression used throughout content.js.
   *
   * @param {{activeFilter?: string, searchQuery?: string, priorityFilter?: string}} state
   * @returns {boolean}
   */
  function hasActiveFilters(state) {
    const {
      activeFilter = 'all',
      searchQuery = '',
      priorityFilter = 'all'
    } = state || {};
    return activeFilter !== 'all' || !!searchQuery || priorityFilter !== 'all';
  }

  const api = {
    filterTestCases,
    hasActiveFilters,
  };

  if (typeof self !== 'undefined') Object.assign(self, api);
  else if (typeof window !== 'undefined') Object.assign(window, api);
  else if (typeof globalThis !== 'undefined') Object.assign(globalThis, api);

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
