/**
 * content-export.js — pure, DOM-free export builders extracted from content.js.
 *
 * Contains the string-building parts of CSV export and clipboard export. The
 * DOM/IO parts (Blob creation, link click, navigator.clipboard.writeText,
 * button feedback) stay in content.js and call these builders.
 *
 * IIFE-wrapped (content scripts share one page scope). Functions are exposed on
 * the page global via Object.assign(self|window, api) so content.js — loaded
 * AFTER this file — can call them, and exported via module.exports for tests.
 *
 * No I/O, no chrome.*, no DOM.
 */
(function () {
  'use strict';

  /**
   * Build the full CSV document (header row + one row per test case) for a list
   * of test cases. Fields are wrapped in double-quotes and embedded quotes are
   * escaped by doubling, so commas / quotes / newlines inside fields are safe.
   * Behaviour preserved verbatim from content.js's exportTestCasesToCSV.
   *
   * @param {Array<object>} testCases
   * @returns {string} CSV text
   */
  function buildTestCasesCSV(testCases) {
    const headers = ['ID', 'Title', 'Category', 'Priority', 'Description', 'Expected Result'];

    const rows = (testCases || []).map(tc => {
      const id = tc.id || '';
      const title = (tc.title || '').replace(/"/g, '""'); // Escape quotes
      const category = tc.category || '';
      const priority = tc.priority || '';
      const description = (tc.description || '').replace(/"/g, '""'); // Escape quotes
      const expectedResult = (tc.expected_result || tc.expectedResult || '').replace(/"/g, '""'); // Escape quotes

      // Wrap fields in quotes to handle commas and newlines
      return [
        `"${id}"`,
        `"${title}"`,
        `"${category}"`,
        `"${priority}"`,
        `"${description}"`,
        `"${expectedResult}"`
      ].join(',');
    });

    return [headers.join(','), ...rows].join('\n');
  }

  /**
   * Build the plain-text clipboard representation of a list of test cases,
   * optionally prefixed with an "Active Filters" block. Behaviour preserved
   * verbatim from content.js's copyTestCasesToClipboard string building.
   *
   * @param {Array<object>} testCases
   * @param {{activeFilter?: string, searchQuery?: string, priorityFilter?: string}} [filterState]
   * @returns {string} clipboard text
   */
  function buildTestCasesClipboardText(testCases, filterState) {
    const {
      activeFilter = 'all',
      searchQuery = '',
      priorityFilter = 'all'
    } = filterState || {};

    const cases = testCases || [];

    let clipboardText = 'QAtalyst Test Cases\n';
    clipboardText += '===================\n\n';

    const hasFilters = activeFilter !== 'all' || !!searchQuery || priorityFilter !== 'all';
    if (hasFilters) {
      clipboardText += 'Active Filters:\n';
      if (activeFilter !== 'all') clipboardText += `- Category: ${activeFilter}\n`;
      if (searchQuery) clipboardText += `- Search: "${searchQuery}"\n`;
      if (priorityFilter !== 'all') clipboardText += `- Priority: ${priorityFilter}\n`;
      clipboardText += `\nShowing ${cases.length} test case(s)\n`;
      clipboardText += '-------------------\n\n';
    }

    cases.forEach((tc, idx) => {
      clipboardText += `Test Case #${idx + 1}\n`;
      clipboardText += `-----------\n`;
      clipboardText += `ID: ${tc.id}\n`;
      clipboardText += `Title: ${tc.title}\n`;
      clipboardText += `Category: ${tc.category}\n`;
      clipboardText += `Priority: ${tc.priority}\n`;
      clipboardText += `Description: ${tc.description || 'N/A'}\n`;

      if (tc.preconditions) {
        clipboardText += `Preconditions: ${tc.preconditions}\n`;
      }

      if (tc.steps && tc.steps.length > 0) {
        clipboardText += `Steps:\n`;
        tc.steps.forEach((step, stepIdx) => {
          clipboardText += `  ${stepIdx + 1}. ${step}\n`;
        });
      }

      clipboardText += `Expected Result: ${tc.expected_result || tc.expectedResult || 'N/A'}\n`;

      if (tc.test_data) {
        clipboardText += `Test Data: ${tc.test_data}\n`;
      }

      clipboardText += '\n';
    });

    return clipboardText;
  }

  const api = {
    buildTestCasesCSV,
    buildTestCasesClipboardText,
  };

  if (typeof self !== 'undefined') Object.assign(self, api);
  else if (typeof window !== 'undefined') Object.assign(window, api);
  else if (typeof globalThis !== 'undefined') Object.assign(globalThis, api);

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
