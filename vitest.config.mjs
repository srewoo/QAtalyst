// @ts-check
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['chrome-extension/tests/**/*.test.js'],
    coverage: {
      reporter: ['text', 'lcov'],
      // Measure the unit-testable logic modules. Excluded below are files that
      // v8 cannot meaningfully measure in a unit context OR that are covered by
      // other means:
      //  - background.js: the service worker is integration-tested
      //    (backgroundHandlers.test.js) by loading it in a vm sandbox; v8 does
      //    not instrument vm-evaluated code, so it would always read 0% here.
      //  - content.js / options.js / popup.js: browser/DOM UI. options & popup
      //    have sandbox tests (also vm, unmeasured); content.js is Playwright
      //    (e2e/) territory.
      //  - plumbing with no current unit tests is excluded so the % reflects
      //    coverage of what we actually target, not unrelated browser glue.
      include: ['chrome-extension/**/*.js'],
      exclude: [
        'chrome-extension/tests/**',
        'chrome-extension/e2e/**',
        // integration/sandbox- or browser-tested (v8 can't measure vm/DOM here)
        'chrome-extension/background.js',
        'chrome-extension/content.js',
        'chrome-extension/options.js',
        'chrome-extension/popup.js',
        // browser/runtime glue not unit-targeted yet
        'chrome-extension/logger.js',
        'chrome-extension/cache-manager.js',
        'chrome-extension/resource-blocker.js',
        'chrome-extension/smart-wait.js',
        'chrome-extension/crawler-progress.js',
        'chrome-extension/graph-filter.js',
        'chrome-extension/context-checker.js',
        'chrome-extension/crawler-handlers.js',
        'chrome-extension/knowledge-graph-merger.js',
        'chrome-extension/historical-mining.js',
        'chrome-extension/retry-helper.js',
        'chrome-extension/config.js',
      ],
    },
  },
});
