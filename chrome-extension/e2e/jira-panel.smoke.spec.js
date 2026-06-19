/**
 * QAtalyst panel smoke E2E (Playwright).
 *
 * The minimal happy-path: panel injects -> Analyse Requirements produces
 * output -> Generate Test Cases yields a non-empty list. Fuller stateful-flow
 * coverage (filters, exports, lifecycle) lives in jira-panel.flows.spec.js.
 *
 * Skipped until a target is configured (see e2e/README.md and e2e/.env.example)
 * because it needs a live Jira + a real LLM key + a headed browser with
 * --load-extension — none of which exist in the unit-test sandbox.
 */
const { test, expect } = require('@playwright/test');
const { ready, launchWithExtension, openPanel } = require('./helpers');

test.describe('QAtalyst panel on a Jira ticket', () => {
  test.skip(!ready, 'Set JIRA_TICKET_URL and LLM_API_KEY (see e2e/README.md) to run E2E.');

  let context;
  test.beforeAll(async () => { context = await launchWithExtension(); });
  test.afterAll(async () => { await context?.close(); });

  test('injects the panel and generates test cases', async () => {
    const page = await openPanel(context);

    // 1. Panel injects on the ticket page.
    await expect(page.locator('#qatalyst-panel')).toBeVisible();

    // 2. Analyse requirements produces output.
    await page.getByTestId('analyze-requirements-btn').click();
    await expect(page.getByTestId('analysis-output')).not.toBeEmpty({ timeout: 60000 });

    // 3. Generate test cases yields a non-empty list.
    await page.getByTestId('generate-test-cases-btn').click();
    const cases = page.getByTestId('test-cases-container').locator('.test-case');
    await expect(cases.first()).toBeVisible({ timeout: 120000 });
    expect(await cases.count()).toBeGreaterThan(0);
  });
});
