// `npm run test:export`: credential-free, real-browser checks.
//  - generated.spec.js: a spec from playwright-export.js run against a tiny local app
//    (T-01, T-02 pass; T-03 is expected to fail).
//  - runner.spec.js: "Verify in app" inside the real extension reaches the same verdicts.
//  - panel.spec.js: the whole panel flow on a Jira page with a fake local model.
//  - parity.spec.js: a story inside its epic gets the same generation context as on its own.
const fs = require('fs');
const path = require('path');
const { defineConfig } = require('@playwright/test');
const { exportPlaywrightSpec } = require('../../playwright-export.js');

// Generated here, at config load, because test discovery runs before globalSetup.
const kg = { pages: [{ url: 'http://127.0.0.1:4977/login', features: [{ type: 'button', text: 'Sign In', selector: '#signin' }] }] };
const out = exportPlaywrightSpec(require('./cases.js'), { ticketKey: 'DEMO-42', summary: 'Sign in', knowledgeGraph: kg });
// T-03 asserts something the app never shows; Playwright passes it only if it FAILS.
const source = out.source.replace(/(test\("T-03[^\n]*\n)/, '$1    test.fail(); // deliberately wrong expectation\n');
if (source === out.source) throw new Error('export-check: T-03 not found in the generated spec');
fs.writeFileSync(path.join(__dirname, 'generated.spec.js'), source);

module.exports = defineConfig({
  testDir: __dirname, testMatch: ['generated.spec.js', 'runner.spec.js', 'panel.spec.js', 'parity.spec.js'], timeout: 120000, reporter: 'list',
  globalSetup: require.resolve('./setup.js'), use: { headless: true }
});
