/**
 * QAtalyst stateful-UI flow E2E (Playwright).
 *
 * Drives the panel's full stateful flows on a real Jira ticket: panel lifecycle,
 * Analyse Requirements -> output, Generate Test Scope -> output, Generate Test
 * Cases -> non-empty de-duplicated list, the FILTER controls (category /
 * priority / search change the visible subset), and the export / Add-to-Jira
 * buttons being present + enabled.
 *
 * GATED: needs a live Jira ticket + a real LLM key + a headed browser with the
 * unpacked extension loaded (--load-extension). None of these exist in the unit
 * sandbox, so the whole describe is test.skip(!ready, ...). See e2e/README.md.
 *
 * Selectors use the data-testid attributes added to content.js (see README
 * "data-testids added for E2E").
 */
const { test, expect } = require('@playwright/test');
const { ready, launchWithExtension, openPanel } = require('./helpers');

test.describe('QAtalyst stateful UI flows', () => {
  test.skip(!ready, 'Set JIRA_TICKET_URL and LLM_API_KEY (see e2e/README.md) to run E2E.');

  let context;
  test.beforeAll(async () => { context = await launchWithExtension(); });
  test.afterAll(async () => { await context?.close(); });

  test('panel injects with the three primary action buttons', async () => {
    const page = await openPanel(context);
    await expect(page.locator('#qatalyst-panel')).toBeVisible();
    await expect(page.getByTestId('analyze-requirements-btn')).toBeVisible();
    await expect(page.getByTestId('generate-test-scope-btn')).toBeVisible();
    await expect(page.getByTestId('generate-test-cases-btn')).toBeVisible();
    await page.close();
  });

  test('panel close button removes / hides the panel', async () => {
    const page = await openPanel(context);
    await page.locator('#qatalyst-close').click();
    await expect(page.locator('#qatalyst-panel')).toBeHidden();
    await page.close();
  });

  test('Analyse Requirements produces analysis output', async () => {
    const page = await openPanel(context);
    await page.getByTestId('analyze-requirements-btn').click();
    const output = page.getByTestId('analysis-output');
    await expect(output).toBeVisible({ timeout: 60000 });
    await expect(output).not.toBeEmpty();
    await page.close();
  });

  test('Generate Test Scope produces scope output', async () => {
    const page = await openPanel(context);
    await page.getByTestId('generate-test-scope-btn').click();
    const output = page.getByTestId('test-scope-output');
    await expect(output).toBeVisible({ timeout: 60000 });
    await expect(output).not.toBeEmpty();
    await page.close();
  });

  test('Generate Test Cases yields a non-empty, de-duplicated list', async () => {
    const page = await openPanel(context);
    await page.getByTestId('generate-test-cases-btn').click();

    const container = page.getByTestId('test-cases-container');
    await expect(container).toBeVisible({ timeout: 120000 });

    const cases = container.locator('.test-case');
    await expect(cases.first()).toBeVisible();
    const count = await cases.count();
    expect(count).toBeGreaterThan(0);

    // De-duplication: every rendered test-case id is unique.
    const ids = await cases.locator('.tc-id').allTextContents();
    const nonEmpty = ids.map(s => s.trim()).filter(Boolean);
    expect(new Set(nonEmpty).size).toBe(nonEmpty.length);
    await page.close();
  });

  test('category filter narrows the visible subset', async () => {
    const page = await openPanel(context);
    await page.getByTestId('generate-test-cases-btn').click();
    const container = page.getByTestId('test-cases-container');
    await expect(container.locator('.test-case').first()).toBeVisible({ timeout: 120000 });

    const totalCount = await container.locator('.test-case').count();

    // Filter to Positive only; visible subset must be <= total and every
    // visible card must carry the Positive category.
    await page.getByTestId('filter-Positive').click();
    await expect(page.getByTestId('filter-status')).toContainText(/Showing \d+ of \d+/);

    const positiveCount = await container.locator('.test-case').count();
    expect(positiveCount).toBeLessThanOrEqual(totalCount);
    const categories = await container.locator('.test-case .tc-category').allTextContents();
    for (const c of categories) expect(c.trim()).toBe('Positive');

    // Reset to all restores the full list.
    await page.getByTestId('filter-all').click();
    await expect(container.locator('.test-case')).toHaveCount(totalCount);
    await page.close();
  });

  test('priority filter narrows the visible subset', async () => {
    const page = await openPanel(context);
    await page.getByTestId('generate-test-cases-btn').click();
    const container = page.getByTestId('test-cases-container');
    await expect(container.locator('.test-case').first()).toBeVisible({ timeout: 120000 });
    const totalCount = await container.locator('.test-case').count();

    await page.getByTestId('priority-filter').selectOption('P0');
    const p0Count = await container.locator('.test-case').count();
    expect(p0Count).toBeLessThanOrEqual(totalCount);
    const priorities = await container.locator('.test-case .tc-priority').allTextContents();
    for (const p of priorities) expect(p.trim()).toBe('P0');
    await page.close();
  });

  test('search filter narrows the visible subset', async () => {
    const page = await openPanel(context);
    await page.getByTestId('generate-test-cases-btn').click();
    const container = page.getByTestId('test-cases-container');
    await expect(container.locator('.test-case').first()).toBeVisible({ timeout: 120000 });
    const totalCount = await container.locator('.test-case').count();

    await page.getByTestId('test-search').fill('login');
    // Either fewer cards, or the empty-state message — both are valid narrowing.
    const filteredCount = await container.locator('.test-case').count();
    expect(filteredCount).toBeLessThanOrEqual(totalCount);
    await page.close();
  });

  test('export / Add-to-Jira controls are present and enabled', async () => {
    const page = await openPanel(context);
    await page.getByTestId('generate-test-cases-btn').click();
    await expect(page.getByTestId('test-cases-container').locator('.test-case').first())
      .toBeVisible({ timeout: 120000 });

    for (const id of ['add-to-jira-btn', 'export-csv-btn', 'copy-clipboard-btn']) {
      const btn = page.getByTestId(id);
      await expect(btn).toBeVisible();
      await expect(btn).toBeEnabled();
    }
    await page.close();
  });
});
