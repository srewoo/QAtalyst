/**
 * @vitest-environment happy-dom
 *
 * Tests for popup.js (the extension's quick-settings popup) driven against the
 * REAL popup.html DOM. We inject popup.html's <body> markup into the happy-dom
 * document, then load config.js + security.js (provide CONFIG / SecurityManager /
 * securityManager) and popup.js itself through the sandbox harness, sharing the
 * happy-dom window so the script's document.getElementById(...) calls hit real
 * elements. We then exercise:
 *   (a) DOMContentLoaded populating the form from chrome.storage.sync
 *   (b) the provider <select> change handler rebuilding the model list / toggling
 *       the Bedrock credential block
 *   (c) the Save button collecting field values back into chrome.storage.sync
 *
 * Anything that needs background.js messaging (crawl/import/export/merge) is NOT
 * covered here — see the report at the bottom of the suite for the Playwright list.
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

/**
 * Render popup.html into happy-dom, wire chrome with the given seed storage, load
 * the real scripts, fire DOMContentLoaded, and let microtasks settle.
 */
async function setupPopup(seed = {}, chromeOverride) {
  document.body.innerHTML = bodyMarkup('popup.html');
  const chrome = chromeOverride || createChromeMock(seed);
  global.chrome = chrome;
  const { ctx } = loadScripts(['config.js', 'security.js', 'popup.js'], { window, chrome });
  document.dispatchEvent(new window.Event('DOMContentLoaded'));
  // Let the async DOMContentLoaded handler (awaits chrome.storage + decrypt) run.
  await settle();
  return { ctx, chrome };
}

function el(id) {
  return document.getElementById(id);
}

/** Yield enough macrotasks for chained async crypto (PBKDF2) work to settle. */
async function settle(n = 25) {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * Wait until `predicate()` is truthy (or timeout). Robust against PBKDF2 taking
 * a variable number of macrotasks under load — far more reliable than a fixed
 * `settle(n)`.
 */
async function settleUntil(predicate, { tries = 200, stepMs = 5 } = {}) {
  for (let i = 0; i < tries; i++) {
    let ok = false;
    try { ok = await predicate(); } catch (_) { ok = false; }
    if (ok) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

describe('popup.js — load settings into the form', () => {
  test('populates provider, model, and integration URLs from chrome.storage.sync', async () => {
    await setupPopup({
      llmProvider: 'claude',
      llmModel: 'claude-sonnet-4-6',
      testrailUrl: 'https://acme.testrail.io',
      confluenceUrl: 'https://acme.atlassian.net/wiki',
    });

    expect(el('llmProvider').value).toBe('claude');
    expect(el('llmModel').value).toBe('claude-sonnet-4-6');
    expect(el('testrailUrl').value).toBe('https://acme.testrail.io');
    expect(el('confluenceUrl').value).toBe('https://acme.atlassian.net/wiki');
  });

  test('rebuilds the model dropdown to match the saved provider', async () => {
    await setupPopup({ llmProvider: 'gemini' });
    const optionValues = Array.from(el('llmModel').options).map((o) => o.value);
    // gemini model list from popup.js modelOptions
    expect(optionValues).toContain('gemini-2.5-pro');
    expect(optionValues).toContain('gemini-2.5-flash');
    expect(optionValues).not.toContain('gpt-5.2');
  });

  test('defaults to the openai model list when no provider is saved', async () => {
    await setupPopup({});
    const optionValues = Array.from(el('llmModel').options).map((o) => o.value);
    expect(optionValues).toContain('gpt-5.2');
    expect(optionValues).not.toContain('gemini-2.5-pro');
  });

  test('decrypts a stored (encrypted) apiKey back into the field on load', async () => {
    // Encryption is keyed by a per-install device key in chrome.storage.local, so
    // we must encrypt and decrypt against the SAME chrome mock for the round-trip
    // to succeed. Build the mock, encrypt with a SecurityManager bound to it, then
    // hand that same mock to the popup so the load-path decrypt uses the same key.
    const chrome = createChromeMock({ llmProvider: 'openai' });
    global.chrome = chrome;
    const { ctx } = loadScripts(['config.js', 'security.js'], { window, chrome });
    const sm = new ctx.SecurityManager();
    const encrypted = await sm.encryptApiKeyForStorage('sk-popup-secret-123');
    expect(sm.isEncrypted(encrypted)).toBe(true);
    await chrome.storage.sync.set({ apiKey: encrypted });

    await setupPopup({}, chrome);
    expect(el('apiKey').value).toBe('sk-popup-secret-123');
  });

  test('shows Bedrock credential block and hides apiKey block for bedrock provider', async () => {
    await setupPopup({ llmProvider: 'bedrock' });
    expect(el('bedrockCredentialsGroup').style.display).toBe('block');
    expect(el('apiKeyGroup').style.display).toBe('none');
  });
});

describe('popup.js — provider change handler', () => {
  test('switching provider updates model options and toggles bedrock fields', async () => {
    await setupPopup({ llmProvider: 'openai' });

    const provider = el('llmProvider');
    provider.value = 'bedrock';
    provider.dispatchEvent(new window.Event('change'));

    expect(el('bedrockCredentialsGroup').style.display).toBe('block');
    expect(el('apiKeyGroup').style.display).toBe('none');
    const optionValues = Array.from(el('llmModel').options).map((o) => o.value);
    expect(optionValues.some((v) => v.startsWith('anthropic.') || v.startsWith('us.openai.'))).toBe(true);
  });
});

describe('popup.js — save settings', () => {
  test('Save collects non-bedrock fields into chrome.storage.sync', async () => {
    const { chrome } = await setupPopup({ llmProvider: 'openai' });

    el('llmProvider').value = 'openai';
    el('llmProvider').dispatchEvent(new window.Event('change'));
    el('llmModel').value = 'gpt-5.2-mini';
    el('apiKey').value = 'sk-plain-key-value-abc';
    el('testrailUrl').value = 'https://t.example.io';
    el('confluenceUrl').value = 'https://c.example.net';

    el('saveBtn').dispatchEvent(new window.Event('click'));
    await settle();

    const saved = await chrome.storage.sync.get([
      'llmProvider',
      'llmModel',
      'apiKey',
      'testrailUrl',
      'confluenceUrl',
    ]);
    expect(saved.llmProvider).toBe('openai');
    expect(saved.llmModel).toBe('gpt-5.2-mini');
    // popup.js stores apiKey as-typed (no encryption on the non-bedrock path)
    expect(saved.apiKey).toBe('sk-plain-key-value-abc');
    expect(saved.testrailUrl).toBe('https://t.example.io');
    expect(saved.confluenceUrl).toBe('https://c.example.net');
  });

  test('Save encrypts the bedrock secret key before persisting it', async () => {
    const { ctx, chrome } = await setupPopup({ llmProvider: 'openai' });

    el('llmProvider').value = 'bedrock';
    el('llmProvider').dispatchEvent(new window.Event('change'));
    el('llmModel').value = el('llmModel').options[0].value;
    el('bedrockAccessKeyId').value = 'AKIATESTKEYID0001';
    el('bedrockSecretKey').value = 'super-secret-bedrock-value';
    el('bedrockRegion').value = el('bedrockRegion').options[0].value;

    el('saveBtn').dispatchEvent(new window.Event('click'));
    // Wait for the async encrypt+persist to actually land (PBKDF2 timing varies
    // under load), rather than a fixed number of ticks.
    await settleUntil(async () => {
      const s = await chrome.storage.sync.get(['bedrockSecretKey']);
      return s.bedrockSecretKey && s.bedrockSecretKey !== 'super-secret-bedrock-value';
    });

    const saved = await chrome.storage.sync.get(['bedrockAccessKeyId', 'bedrockSecretKey']);
    expect(saved.bedrockAccessKeyId).toBe('AKIATESTKEYID0001');
    // Secret must be stored encrypted, not in plaintext, and decrypt back.
    expect(saved.bedrockSecretKey).not.toBe('super-secret-bedrock-value');
    const sm = new ctx.SecurityManager();
    expect(sm.isEncrypted(saved.bedrockSecretKey)).toBe(true);
    expect(await sm.decryptApiKeyFromStorage(saved.bedrockSecretKey)).toBe('super-secret-bedrock-value');
  });

  test('Save shows a success status message', async () => {
    await setupPopup({ llmProvider: 'openai' });
    el('saveBtn').dispatchEvent(new window.Event('click'));
    await settle();
    expect(el('status').className).toContain('success');
    expect(el('status').textContent).toMatch(/saved/i);
  });
});
