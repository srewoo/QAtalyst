// A story generated inside its epic must get exactly the context it gets on its
// own. Runs the same story both ways in the real extension and compares the
// <ticket_data> block of the first generation prompt the model receives.
const path = require('path');
const { test, expect, chromium } = require('@playwright/test');

const AC_FIELD = 'customfield_10050';
const adf = (lines) => ({ type: 'doc', version: 1, content: lines.map(t => ({ type: 'paragraph', content: [{ type: 'text', text: t }] })) });
const EPIC = { key: 'EP-1', fields: { summary: 'Checkout revamp', issuetype: { name: 'Epic' }, labels: [], components: [],
  description: adf(['Make paying faster and safer.']), comment: { comments: [] }, attachment: [], issuelinks: [] }, names: {} };
const STORY = { key: 'EP-2', names: { [AC_FIELD]: 'Acceptance Criteria' }, fields: {
  summary: 'Users can save a card for later', issuetype: { name: 'Story' }, priority: { name: 'High' }, status: { name: 'To Do' },
  labels: ['payments'], components: [{ name: 'Checkout' }], comment: { comments: [{ author: { displayName: 'PM' }, body: adf(['Max 3 saved cards.']) }] },
  attachment: [], issuelinks: [], parent: { key: 'EP-1', fields: { summary: 'Checkout revamp', issuetype: { name: 'Epic' } } },
  description: adf(['Returning shoppers should not retype their card.']),
  [AC_FIELD]: adf(['A saved card appears in the card list', 'A user can delete a saved card']) } };
const page = (summary) => `<!doctype html><h1 data-testid="issue.views.issue-base.foundation.summary.heading">${summary}</h1>`;

async function route(ctx) {
  await ctx.route('https://demo.atlassian.net/**', (r) => {
    const u = r.request().url();
    if (u.includes('/rest/agile/1.0/epic/EP-1/issue')) {
      return r.fulfill({ json: { issues: [{ key: 'EP-2', fields: { summary: STORY.fields.summary, description: STORY.fields.description,
        issuetype: STORY.fields.issuetype, comment: STORY.fields.comment, issuelinks: [] } }] } });
    }
    if (u.includes('/remotelink')) return r.fulfill({ json: [] });
    if (u.includes('/rest/api/3/issue/EP-2')) return r.fulfill({ json: STORY });
    if (u.includes('/rest/api/3/issue/EP-1')) return r.fulfill({ json: EPIC });
    if (u.includes('/rest/')) return r.fulfill({ status: 404, json: {} });
    return r.fulfill({ contentType: 'text/html', body: page(u.includes('EP-1') ? EPIC.fields.summary : STORY.fields.summary) });
  });
}

const ticketBlock = (prompts, summary) => {
  const p = prompts.find(x => x.system.includes('generating GROUNDED') && x.user.includes(`TICKET: ${summary}`));
  const m = p && p.user.match(/<ticket_data>([\s\S]*?)<\/ticket_data>/);
  return m ? m[1].trim() : null;
};

test('a story inside its epic gets the same generation context as on its own', async () => {
  const ext = path.join(__dirname, '..', '..');
  const ctx = await chromium.launchPersistentContext('', { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  try {
    await route(ctx);
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker');
    await sw.evaluate((acField) => chrome.storage.sync.set({
      llmProvider: 'ollama', llmModel: 'fake', ollamaBaseUrl: 'http://127.0.0.1:4978', enableStreaming: false,
      enableMultiAgent: true, useCrawledDataForTests: false, testCount: 4, jiraAcFieldId: acField,
      jiraBaseUrl: 'https://demo.atlassian.net', jiraEmail: 'e2e@example.com', jiraApiToken: 'e2e-token'
    }), AC_FIELD);
    const prompts = async () => (await (await fetch('http://127.0.0.1:4978/__prompts')).json());

    // 1. The story on its own.
    await fetch('http://127.0.0.1:4978/__reset');
    const tab = await ctx.newPage();
    await tab.goto('https://demo.atlassian.net/browse/EP-2');
    await tab.getByTestId('generate-test-cases-btn').click();
    await expect(tab.locator('[data-testid^="test-case-"]').first()).toBeVisible({ timeout: 90000 });
    const alone = ticketBlock(await prompts(), STORY.fields.summary);

    // 2. The same story inside its epic.
    await fetch('http://127.0.0.1:4978/__reset');
    await tab.goto('https://demo.atlassian.net/browse/EP-1');
    await tab.getByTestId('generate-test-cases-btn').click();
    await tab.locator('#qa-epic-generate').click();
    await expect(tab.locator('.epic-results')).toBeVisible({ timeout: 90000 });
    const inEpic = ticketBlock(await prompts(), STORY.fields.summary);

    expect(alone).toBeTruthy();
    expect(alone).toContain('A saved card appears in the card list'); // the dedicated AC field
    expect(alone).toContain('PARENT CONTEXT');                         // the epic's intent
    expect(alone).toContain('Max 3 saved cards.');                     // comments
    expect(inEpic).toBe(alone);
  } finally {
    await ctx.close();
  }
});
