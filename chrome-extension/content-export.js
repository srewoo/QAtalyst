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
  'use strict';

  /**
   * Render any test-case field to a readable string. The LLM sometimes returns
   * test_data (or preconditions) as an object/array; naive interpolation printed
   * "[object Object]" in every export. Objects are JSON-stringified, arrays are
   * joined, primitives pass through.
   */
  function toDisplayString(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(toDisplayString).join('; ');
    if (typeof v === 'object') {
      try { return JSON.stringify(v); } catch (_) { return String(v); }
    }
    return String(v);
  }

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
    // F27: carry regression provenance into the export. Source + Historical
    // Reference + Rationale columns let a reviewer see which past bug a
    // regression test guards against; blank for non-regression tests.
    const headers = ['ID', 'Title', 'Category', 'Priority', 'Description', 'Expected Result', 'Source', 'Historical Reference', 'Rationale'];
    const q = (v) => `"${toDisplayString(v).replace(/"/g, '""')}"`;

    const rows = (testCases || []).map(tc => {
      const isRegression = /regress/i.test(tc.category || '') || (tc._proposedFor && /regress/i.test(tc._proposedFor.category || ''));
      const source = tc.source || (isRegression ? 'regression' : '');
      return [
        q(tc.id || ''),
        q(tc.title || ''),
        q(tc.category || ''),
        q(tc.priority || ''),
        q(tc.description || ''),
        q(tc.expected_result || tc.expectedResult || ''),
        q(source),
        q(tc.historicalReference || ''),
        q(tc.rationale || '')
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
      clipboardText += `Description: ${toDisplayString(tc.description) || 'N/A'}\n`;

      if (tc.preconditions) {
        clipboardText += `Preconditions: ${toDisplayString(tc.preconditions)}\n`;
      }

      if (tc.steps && tc.steps.length > 0) {
        clipboardText += `Steps:\n`;
        tc.steps.forEach((step, stepIdx) => {
          clipboardText += `  ${stepIdx + 1}. ${toDisplayString(step)}\n`;
        });
      }

      clipboardText += `Expected Result: ${toDisplayString(tc.expected_result || tc.expectedResult) || 'N/A'}\n`;

      if (tc.test_data) {
        clipboardText += `Test Data: ${toDisplayString(tc.test_data)}\n`;
      }

      // F27: regression provenance, when present.
      if (tc.historicalReference) {
        clipboardText += `Historical Reference: ${tc.historicalReference}\n`;
      }
      if (tc.rationale) {
        clipboardText += `Rationale: ${tc.rationale}\n`;
      }

      clipboardText += '\n';
    });

    return clipboardText;
  }

  const __qaContentExport = {
    buildTestCasesCSV,
    buildTestCasesClipboardText,
  };


  if (typeof module !== 'undefined' && module.exports) module.exports = __qaContentExport;
