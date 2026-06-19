/**
 * Shared E2E helpers — launching the unpacked extension into a persistent
 * Chromium context and the env gate. Centralised so every spec uses the same
 * wiring and the same `ready` predicate.
 */
const path = require('path');
const { chromium } = require('@playwright/test');

const EXT_PATH = path.resolve(__dirname, '..');
const TICKET = process.env.JIRA_TICKET_URL;
const API_KEY = process.env.LLM_API_KEY;

// E2E can only run when there's a live Jira ticket + an LLM key. In the unit
// sandbox neither exists, so specs gate on this and skip cleanly.
const ready = Boolean(TICKET && API_KEY);

async function launchWithExtension() {
  return chromium.launchPersistentContext('', {
    headless: false, // extensions require a headed / persistent context
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
    ],
  });
}

/**
 * Open the ticket and wait for the QAtalyst panel to inject.
 * @returns {Promise<import('@playwright/test').Page>}
 */
async function openPanel(context) {
  const page = await context.newPage();
  await page.goto(TICKET, { waitUntil: 'domcontentloaded' });
  await page.locator('#qatalyst-panel').waitFor({ state: 'visible', timeout: 20000 });
  return page;
}

module.exports = { EXT_PATH, TICKET, API_KEY, ready, launchWithExtension, openPanel };
