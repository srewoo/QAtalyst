// "Verify in app" must reach the same verdicts as the exported Playwright spec:
// T-01 and T-02 pass, T-03 (a wrong expectation) fails. Runs the REAL extension:
// the unpacked build is loaded into Chromium and the runner is called from its
// own service worker, so this also proves the worker loads in a real browser.
const path = require('path');
const { test, expect, chromium } = require('@playwright/test');
const cases = require('./cases.js');

test('Verify in app runner reaches the same verdicts as Playwright', async () => {
  const ext = path.join(__dirname, '..', '..');
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    const loadErrors = await sw.evaluate(() => ['TestRunner', 'TestSteps', 'CoverageJudge', 'FigmaDesignKG', 'HostPermissions',
      'PlaywrightExport'].filter(n => !self[n] && n !== 'PlaywrightExport'));
    expect(loadErrors).toEqual([]);
    const out = await sw.evaluate(async (tests) => self.TestRunner.runTestsInApp(tests), cases);
    expect(out.results.map(r => [r.id, r.status])).toEqual([['T-01', 'passed'], ['T-02', 'passed'], ['T-03', 'failed']]);
    expect(out.results[2].reason).toMatch(/Welcome back/);

    // Tests that name no page (generated without a crawl) start on the page chosen in the panel.
    const noUrl = cases.map(({ preconditions, ...t }) => t);
    const out2 = await sw.evaluate(async (tests) => self.TestRunner.runTestsInApp(tests, { startUrl: 'http://127.0.0.1:4977/login' }), noUrl);
    expect(out2.results.map(r => [r.id, r.status])).toEqual([['T-01', 'passed'], ['T-02', 'passed'], ['T-03', 'failed']]);
  } finally {
    await ctx.close();
  }
});
