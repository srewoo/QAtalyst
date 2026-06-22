/**
 * @vitest-environment happy-dom
 *
 * Tests for popup.js / popup.html (the extension's quick popup) driven against
 * the REAL popup.html DOM. We inject popup.html's <body> markup into happy-dom,
 * load config.js + security.js + popup.js through the sandbox harness sharing the
 * happy-dom window, fire DOMContentLoaded, and assert the popup's structure.
 *
 * The popup was slimmed to ONLY a how-to-use guide + the Web App Crawler. AI
 * provider configuration, API keys, and external integrations (Confluence /
 * TestRail) moved to Advanced Settings (options.html) exclusively. These tests
 * pin that contract: the crawler stays, the removed sections are gone, and the
 * popup still loads without errors.
 *
 * Crawl/import/export/merge messaging needs background.js — covered by Playwright.
 */
const fs = require('fs');
const path = require('path');
const { loadScripts } = require('./helpers/load-global.js');
const { createChromeMock } = require('./helpers/chrome-mock.js');

const EXT_DIR = path.resolve(__dirname, '..');

/** Pull the <body>…first <script> markup out of an extension HTML page. */
function bodyMarkup(htmlFile) {
  const html = fs.readFileSync(path.join(EXT_DIR, htmlFile), 'utf8');
  const start = html.indexOf('<body>') + '<body>'.length;
  const scriptIdx = html.indexOf('<script', start);
  const end = scriptIdx !== -1 ? scriptIdx : html.indexOf('</body>', start);
  return html.slice(start, end);
}

/** Yield a few macrotasks so popup.js's async init settles. */
async function settle(n = 10) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * Render popup.html into happy-dom, wire chrome, load the real scripts, fire
 * DOMContentLoaded, and let init settle. The crawler init calls at the bottom of
 * popup.js (loadCrawledApps / loadLastCrawlSummary / checkActiveCrawl) run here;
 * any async errors are swallowed and do not affect element wiring.
 */
async function setupPopup(seed = {}, chromeOverride) {
  document.body.innerHTML = bodyMarkup('popup.html');
  const chrome = chromeOverride || createChromeMock(seed);
  global.chrome = chrome;
  const { ctx } = loadScripts(['config.js', 'security.js', 'popup.js'], { window, chrome });
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await settle();
  return { ctx, chrome };
}

function el(id) {
  return document.getElementById(id);
}

describe('popup.html — how to use section', () => {
  test('renders a how-to-use guide that explains Jira auto-opens', async () => {
    await setupPopup({});
    const text = document.body.textContent || '';
    expect(text).toMatch(/how to use/i);
    expect(text).toMatch(/jira/i);
    expect(text).toMatch(/automatically/i);
  });

  test('points users to Advanced Settings for AI provider / API key', async () => {
    await setupPopup({});
    expect(el('openOptionsBtn')).toBeTruthy();
    expect((document.body.textContent || '')).toMatch(/advanced settings/i);
  });
});

describe('popup.html — removed sections (regression guard)', () => {
  test('no longer renders AI provider configuration fields', async () => {
    await setupPopup({ llmProvider: 'openai' });
    for (const id of ['llmProvider', 'llmModel', 'apiKey', 'apiKeyGroup',
      'bedrockCredentialsGroup', 'bedrockAccessKeyId', 'bedrockSecretKey', 'bedrockRegion']) {
      expect(el(id)).toBeNull();
    }
  });

  test('no longer renders external integration fields or a Save button', async () => {
    await setupPopup({});
    expect(el('confluenceUrl')).toBeNull();
    expect(el('testrailUrl')).toBeNull();
    expect(el('saveBtn')).toBeNull();
  });
});

describe('popup.html — crawler section retained', () => {
  test('renders the Web App Crawler controls', async () => {
    await setupPopup({});
    for (const id of ['crawlAppBtn', 'useCurrentSession', 'importEmbeddingsBtn',
      'exportAllEmbeddingsBtn', 'deleteAllDataBtn', 'mergeGraphsBtn']) {
      expect(el(id)).toBeTruthy();
    }
    expect((document.body.textContent || '')).toMatch(/web app crawler/i);
  });
});

describe('popup.html — no-API-key notice', () => {
  test('shows the notice when no API key is configured', async () => {
    await setupPopup({}); // empty storage
    expect(el('noApiKeyNotice').style.display).toBe('block');
  });

  test('hides the notice when a standard API key is stored', async () => {
    await setupPopup({ apiKey: 'sk-some-stored-key' });
    expect(el('noApiKeyNotice').style.display).toBe('none');
  });

  test('hides the notice when a Bedrock secret key is stored', async () => {
    await setupPopup({ bedrockSecretKey: 'encrypted-secret-blob' });
    expect(el('noApiKeyNotice').style.display).toBe('none');
  });

  test('clicking the notice opens Advanced Settings', async () => {
    const chrome = createChromeMock({});
    chrome.runtime.openOptionsPage = vi.fn();
    await setupPopup({}, chrome);
    el('noApiKeyNotice').dispatchEvent(new window.Event('click'));
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
  });
});

describe('popup.html — crawl-in-progress state', () => {
  test('Start button shows "Crawling in progress" when a crawl is active', async () => {
    const chrome = createChromeMock({
      activeCrawl: { startUrl: 'https://app.example.com', startTime: new Date().toISOString() },
    });
    chrome.runtime.sendMessage = vi.fn(async (msg) => {
      if (msg && msg.action === 'checkCrawlerStatus') return { isRunning: true };
      return undefined;
    });
    await setupPopup({}, chrome);

    const btn = el('crawlAppBtn');
    expect(btn.textContent).toMatch(/crawling in progress/i);
    expect(btn.disabled).toBe(true);
    expect(el('activeCrawlStatus').style.display).toBe('block');
  });

  test('Start button stays actionable when no crawl is running', async () => {
    await setupPopup({}); // no activeCrawl in storage
    const btn = el('crawlAppBtn');
    expect(btn.textContent).toMatch(/start full application crawl/i);
    expect(btn.disabled).toBe(false);
  });

  test('a stale active-crawl flag is cleared and the button resets', async () => {
    const chrome = createChromeMock({
      activeCrawl: { startUrl: 'https://app.example.com', startTime: new Date().toISOString() },
    });
    // Background reports nothing running → checkActiveCrawl should clear + reset.
    chrome.runtime.sendMessage = vi.fn(async () => ({ isRunning: false }));
    await setupPopup({}, chrome);

    const btn = el('crawlAppBtn');
    expect(btn.textContent).toMatch(/start full application crawl/i);
    expect(btn.disabled).toBe(false);
    expect(el('activeCrawlStatus').style.display).toBe('none');
  });
});

describe('popup.js — advanced settings button', () => {
  test('Open Advanced Settings opens the extension options page', async () => {
    const chrome = createChromeMock({});
    chrome.runtime.openOptionsPage = vi.fn();
    await setupPopup({}, chrome);

    el('openOptionsBtn').dispatchEvent(new window.Event('click'));
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
  });
});
