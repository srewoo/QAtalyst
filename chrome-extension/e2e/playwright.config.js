// Playwright config for QAtalyst E2E (NOT part of `npm test`).
// Requires @playwright/test (npm i -D @playwright/test) and a real target —
// see e2e/README.md. Kept separate from the Vitest unit suite.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: __dirname,
  testMatch: '**/*.spec.js',
  timeout: 120000,
  retries: 0,
  use: {
    headless: false, // extensions require a headed / persistent context
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  reporter: [['list']],
});
