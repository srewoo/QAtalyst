// Credential-free, real-Chrome run of the whole panel flow: the unpacked extension,
// a Jira ticket page (served by Playwright for https://demo.atlassian.net, so the
// content scripts inject exactly as on real Jira), a fake local Ollama as the
// model, a real agentic generation, and a Playwright export download.
const fs = require('fs');
const path = require('path');
const { test, expect, chromium } = require('@playwright/test');

const TICKET = {
  key: 'DEMO-42',
  fields: {
    summary: 'Users can sign in with email and password',
    issuetype: { name: 'Story' }, priority: { name: 'High' }, status: { name: 'To Do' }, labels: [], components: [],
    comment: { comments: [] }, attachment: [], issuelinks: [],
    description: { type: 'doc', version: 1, content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Acceptance Criteria:' }] },
      { type: 'bulletList', content: [
        'A user with valid credentials is signed in and lands on the dashboard',
        'An invalid password shows an error message',
        'The account is locked after 5 consecutive failed attempts'
      ].map(t => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: t }] }] })) }] }
  },
  names: {}
};
const PAGE = `<!doctype html><title>DEMO-42</title>
<h1 data-testid="issue.views.issue-base.foundation.summary.heading">${TICKET.fields.summary}</h1>`;

test('panel generates a suite with a local model and exports a Playwright spec', async () => {
  const ext = path.join(__dirname, '..', '..');
  const ctx = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
  });
  try {
    await ctx.route('https://demo.atlassian.net/**', (route) => {
      const url = route.request().url();
      if (url.includes('/rest/api/3/issue/DEMO-42')) return route.fulfill({ json: TICKET });
      if (url.includes('/rest/')) return route.fulfill({ status: 404, json: {} });
      return route.fulfill({ contentType: 'text/html', body: PAGE });
    });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    await sw.evaluate(() => chrome.storage.sync.set({
      llmProvider: 'ollama', llmModel: 'fake', ollamaBaseUrl: 'http://127.0.0.1:4978',
      enableStreaming: false, enableMultiAgent: true, useCrawledDataForTests: false, testCount: 6,
      jiraBaseUrl: 'https://demo.atlassian.net', jiraEmail: 'e2e@example.com', jiraApiToken: 'e2e-token'
    }));

    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('https://demo.atlassian.net/browse/DEMO-42');
    await expect(page.locator('#qatalyst-panel')).toBeVisible({ timeout: 20000 });

    await page.getByTestId('generate-test-cases-btn').click();
    await expect(page.locator('[data-testid^="test-case-"]').first()).toBeVisible({ timeout: 90000 });
    const cards = await page.locator('[data-testid^="test-case-"]').count();
    expect(cards).toBeGreaterThanOrEqual(3); // one per acceptance criterion at least

    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-playwright-btn').click()]);
    expect(download.suggestedFilename()).toBe('DEMO-42.spec.js');
    const source = fs.readFileSync(await download.path(), 'utf8');
    expect(source).toContain('test.describe("DEMO-42');
    expect(source).toContain('await control(page, "Sign In").click();');

    // Verify in app: the panel asks for a start page, then runs and reports.
    await page.getByTestId('verify-in-app-btn').click();
    const startField = page.getByTestId('verify-start-url');
    await expect(startField).toBeVisible();
    await startField.fill('http://127.0.0.1:4977/login');
    page.once('dialog', d => d.accept());
    await page.getByTestId('verify-run-btn').click();
    await expect(page.getByTestId('run-results')).toContainText('Run in app', { timeout: 60000 });
    expect(errors).toEqual([]);
  } finally {
    await ctx.close();
  }
});
