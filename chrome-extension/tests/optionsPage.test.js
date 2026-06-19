/**
 * @vitest-environment happy-dom
 *
 * Tests for options.js (the extension's full settings page) driven against the
 * REAL options.html DOM. We inject options.html's <body> markup into happy-dom,
 * then load config.js + security.js (provide CONFIG / SecurityManager /
 * securityManager) and options.js itself via the sandbox harness, sharing the
 * happy-dom window so options.js's many top-level document.getElementById(...)
 * .addEventListener(...) calls (which run at script-eval time, NOT inside
 * DOMContentLoaded) resolve against real elements.
 *
 * We exercise:
 *   (a) DOMContentLoaded populating representative fields from chrome.storage.sync
 *       (provider, model, temperature, maxTokens, testCount, coverageTarget,
 *        multi-agent + streaming checkboxes, integration text fields)
 *   (b) the provider <select> change handler rebuilding the model list, updating
 *       the "get key" link, and toggling the Bedrock credential block
 *   (c) the tab switcher
 *   (d) the Save button collecting field values back into chrome.storage.sync with
 *       the right keys/types, including encryption of the LLM API key
 *   (e) the InputValidator (pure helper) blocking an invalid save
 *
 * NOT covered (needs background.js / integrations.js / real network — see report):
 * Test-Connection, Test-Jira-Auth, per-platform Test buttons, Fetch-Custom-Fields,
 * OAuth2 flow, Reset (calls window.location.reload).
 */
const fs = require('fs');
const path = require('path');
const { loadScripts } = require('./helpers/load-global.js');
const { createChromeMock } = require('./helpers/chrome-mock.js');

const EXT_DIR = path.resolve(__dirname, '..');

function bodyMarkup(htmlFile) {
  const html = fs.readFileSync(path.join(EXT_DIR, htmlFile), 'utf8');
  const start = html.indexOf('<body>') + '<body>'.length;
  const scriptIdx = html.indexOf('<script', start);
  const end = scriptIdx !== -1 ? scriptIdx : html.indexOf('</body>', start);
  return html.slice(start, end);
}

/** Yield enough macrotasks for chained async crypto (PBKDF2) work to settle. */
async function settle(n = 25) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

async function setupOptions(seed = {}, chromeOverride) {
  document.body.innerHTML = bodyMarkup('options.html');
  const chrome = chromeOverride || createChromeMock(seed);
  global.chrome = chrome;
  // chrome.identity is referenced by some handlers; stub minimally so script eval
  // (which only *registers* those handlers) and any later calls don't explode.
  chrome.identity = chrome.identity || { getRedirectURL: () => 'https://x/', launchWebAuthFlow() {} };
  const { ctx } = loadScripts(['config.js', 'security.js', 'options.js'], { window, chrome });
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
  await settle();
  return { ctx, chrome };
}

function el(id) {
  return document.getElementById(id);
}

describe('options.js — load settings into the form', () => {
  test('populates representative API + generation settings from storage', async () => {
    await setupOptions({
      llmProvider: 'claude',
      llmModel: 'claude-sonnet-4-6',
      temperature: 0.3,
      maxTokens: 8000,
      testCount: 55,
      coverageTarget: 90,
      enableMultiAgent: true,
      enableStreaming: false,
    });

    expect(el('llmProvider').value).toBe('claude');
    expect(el('llmModel').value).toBe('claude-sonnet-4-6');
    expect(el('temperature').value).toBe('0.3');
    expect(el('maxTokens').value).toBe('8000');
    expect(el('testCount').value).toBe('55');
    expect(el('testCountValue').textContent).toBe('55');
    expect(el('coverageTarget').value).toBe('90');
    expect(el('enableMultiAgent').checked).toBe(true);
    expect(el('enableStreaming').checked).toBe(false);
  });

  test('applies sensible defaults when storage is empty', async () => {
    await setupOptions({});
    expect(el('temperature').value).toBe('0.7');
    expect(el('maxTokens').value).toBe('32768');
    expect(el('testCount').value).toBe('30');
    expect(el('testCountValue').textContent).toBe('30');
    expect(el('enableStreaming').checked).toBe(true); // default ON (!== false)
    expect(el('enableMultiAgent').checked).toBe(false); // default OFF
    // No provider saved -> model list defaults to openai
    const optionValues = Array.from(el('llmModel').options).map((o) => o.value);
    expect(optionValues).toContain('gpt-5.2');
  });

  test('populates integration text fields (jira / testrail / confluence)', async () => {
    await setupOptions({
      jiraBaseUrl: 'https://acme.atlassian.net',
      jiraEmail: 'qa@acme.com',
      testrailUrl: 'https://acme.testrail.io',
      testrailProjectId: '42',
      confluenceUrl: 'https://acme.atlassian.net/wiki',
    });
    expect(el('jiraBaseUrl').value).toBe('https://acme.atlassian.net');
    expect(el('jiraEmail').value).toBe('qa@acme.com');
    expect(el('testrailUrl').value).toBe('https://acme.testrail.io');
    expect(el('testrailProjectId').value).toBe('42');
    expect(el('confluenceUrl').value).toBe('https://acme.atlassian.net/wiki');
  });

  test('shows Bedrock credentials and hides api-key block for bedrock provider', async () => {
    await setupOptions({ llmProvider: 'bedrock' });
    expect(el('bedrockCredentialsGroup').style.display).toBe('block');
    expect(el('apiKeyGroup').style.display).toBe('none');
  });

  test('decrypts a stored (encrypted) apiKey back into the field on load', async () => {
    const chrome = createChromeMock({ llmProvider: 'openai' });
    global.chrome = chrome;
    const { ctx } = loadScripts(['config.js', 'security.js'], { window, chrome });
    const sm = new ctx.SecurityManager();
    const encrypted = await sm.encryptApiKeyForStorage('sk-options-secret-456');
    await chrome.storage.sync.set({ apiKey: encrypted });

    await setupOptions({}, chrome);
    expect(el('apiKey').value).toBe('sk-options-secret-456');
  });
});

describe('options.js — provider change handler', () => {
  test('switching provider rebuilds model list, updates key link, toggles bedrock', async () => {
    await setupOptions({ llmProvider: 'openai' });

    const provider = el('llmProvider');
    provider.value = 'gemini';
    provider.dispatchEvent(new window.Event('change'));

    const optionValues = Array.from(el('llmModel').options).map((o) => o.value);
    expect(optionValues).toContain('gemini-2.5-pro');
    expect(optionValues).not.toContain('gpt-5.2');
    expect(el('getKeyLink').href).toContain('aistudio.google.com');
    // gemini is not bedrock -> apiKey block visible, bedrock block hidden
    expect(el('apiKeyGroup').style.display).toBe('block');
    expect(el('bedrockCredentialsGroup').style.display).toBe('none');

    provider.value = 'bedrock';
    provider.dispatchEvent(new window.Event('change'));
    expect(el('bedrockCredentialsGroup').style.display).toBe('block');
    expect(el('apiKeyGroup').style.display).toBe('none');
  });
});

describe('options.js — tab switching', () => {
  test('clicking a tab activates its content panel', async () => {
    await setupOptions({});
    const tabs = document.querySelectorAll('.tab');
    expect(tabs.length).toBeGreaterThan(1);

    // Pick a non-active tab and click it.
    const target = Array.from(tabs).find((t) => !t.classList.contains('active'));
    expect(target).toBeTruthy();
    const tabName = target.dataset.tab;
    target.dispatchEvent(new window.Event('click'));

    expect(target.classList.contains('active')).toBe(true);
    expect(el(`${tabName}-tab`).classList.contains('active')).toBe(true);
  });
});

describe('options.js — save settings', () => {
  test('Save collects representative fields into storage with correct keys/types', async () => {
    const { chrome } = await setupOptions({ llmProvider: 'openai' });

    el('llmProvider').value = 'openai';
    el('llmProvider').dispatchEvent(new window.Event('change'));
    el('llmModel').value = 'gpt-5.2-mini';
    el('apiKey').value = 'sk-abcdefghij1234567890';
    el('temperature').value = '0.2';
    el('maxTokens').value = '12000';
    el('testCount').value = '65';
    el('coverageTarget').value = '85';
    el('enableMultiAgent').checked = true;
    el('enableStreaming').checked = false;

    el('saveBtn').dispatchEvent(new window.Event('click'));
    await settle();

    const saved = await chrome.storage.sync.get([
      'llmProvider',
      'llmModel',
      'temperature',
      'maxTokens',
      'testCount',
      'coverageTarget',
      'enableMultiAgent',
      'enableStreaming',
    ]);
    expect(saved.llmProvider).toBe('openai');
    expect(saved.llmModel).toBe('gpt-5.2-mini');
    expect(saved.temperature).toBe(0.2); // parseFloat -> number
    expect(saved.maxTokens).toBe(12000); // parseInt -> number
    expect(saved.testCount).toBe(65);
    expect(saved.coverageTarget).toBe(85);
    expect(saved.enableMultiAgent).toBe(true);
    expect(saved.enableStreaming).toBe(false);

    // Status message reflects success.
    expect(el('status').className).toContain('success');
    expect(el('status').textContent).toMatch(/saved/i);
  });

  test('Save encrypts the LLM API key before persisting it', async () => {
    const { ctx, chrome } = await setupOptions({ llmProvider: 'openai' });

    el('llmProvider').value = 'openai';
    el('llmProvider').dispatchEvent(new window.Event('change'));
    el('apiKey').value = 'sk-plaintext-should-be-encrypted-token';

    el('saveBtn').dispatchEvent(new window.Event('click'));
    await settle();

    const saved = await chrome.storage.sync.get(['apiKey']);
    expect(saved.apiKey).not.toBe('sk-plaintext-should-be-encrypted-token');
    const sm = new ctx.SecurityManager();
    expect(sm.isEncrypted(saved.apiKey)).toBe(true);
    expect(await sm.decryptApiKeyFromStorage(saved.apiKey)).toBe('sk-plaintext-should-be-encrypted-token');
  });

  test('Save blocks on validation error (bad email) and shows error status', async () => {
    const { chrome } = await setupOptions({ llmProvider: 'openai' });

    el('jiraEmail').value = 'not-an-email';

    el('saveBtn').dispatchEvent(new window.Event('click'));
    await settle();

    expect(el('status').className).toContain('error');
    expect(el('status').innerHTML).toMatch(/Jira Email/i);
    // Nothing should have been persisted because validation failed before set().
    const saved = await chrome.storage.sync.get(['jiraEmail']);
    expect(saved.jiraEmail).toBeUndefined();
  });
});

describe('options.js — Save-path validation (real InputValidator, exercised via the UI)', () => {
  // InputValidator is a top-level `const` in options.js, so it is not exposed on
  // the sandbox global and cannot be called directly without re-implementing it.
  // We exercise the SAME validation logic through the Save button instead.

  test('rejects an http:// (non-HTTPS) TestRail URL', async () => {
    const { chrome } = await setupOptions({ llmProvider: 'openai' });
    el('testrailUrl').value = 'http://insecure.testrail.io';

    el('saveBtn').dispatchEvent(new window.Event('click'));
    await settle();

    expect(el('status').className).toContain('error');
    expect(el('status').innerHTML).toMatch(/TestRail URL/i);
    expect((await chrome.storage.sync.get(['testrailUrl'])).testrailUrl).toBeUndefined();
  });

  test('rejects a non-numeric TestRail Project ID', async () => {
    const { chrome } = await setupOptions({ llmProvider: 'openai' });
    el('testrailProjectId').value = 'ABC';

    el('saveBtn').dispatchEvent(new window.Event('click'));
    await settle();

    expect(el('status').className).toContain('error');
    expect(el('status').innerHTML).toMatch(/Project ID/i);
    expect((await chrome.storage.sync.get(['testrailProjectId'])).testrailProjectId).toBeUndefined();
  });

  test('accepts a valid https URL + numeric project id and saves them', async () => {
    const { chrome } = await setupOptions({ llmProvider: 'openai' });
    el('testrailUrl').value = 'https://secure.testrail.io';
    el('testrailProjectId').value = '7';

    el('saveBtn').dispatchEvent(new window.Event('click'));
    await settle();

    const saved = await chrome.storage.sync.get(['testrailUrl', 'testrailProjectId']);
    expect(el('status').className).toContain('success');
    expect(saved.testrailUrl).toBe('https://secure.testrail.io');
    expect(saved.testrailProjectId).toBe('7');
  });
});
