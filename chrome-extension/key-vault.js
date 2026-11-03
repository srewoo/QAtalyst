/**
 * key-vault.js — optional passphrase protection for stored API keys.
 *
 * By default keys are sealed with a random per-install key kept in
 * chrome.storage.local: that stops casual reading of settings, but anyone with the
 * browser profile can recover them. With a passphrase, keys are sealed with a key
 * derived from it (PBKDF2, 600k iterations). The passphrase itself is never
 * written to disk: it lives in chrome.storage.session (memory only, cleared when
 * the browser closes, not readable by content scripts), so the user unlocks once
 * per browser session.
 *
 * Used by the options page (set / unlock / lock / remove) and the service worker.
 */
(function () {

// Every setting written through encryptApiKeyForStorage (options.js).
const SECRET_KEYS = ['apiKey', 'jiraApiToken', 'confluenceToken', 'figmaToken', 'googleApiKey', 'googleClientSecret',
  'googleAccessToken', 'googleRefreshToken', 'testrailApiKey', 'bedrockSecretKey', 'bedrockSessionToken'];
const CHECK_PLAINTEXT = 'qatalyst-passphrase-check-v1';
const MIN_LENGTH = 8;

const sm = () => (typeof securityManager !== 'undefined' ? securityManager : new SecurityManager());

async function status() {
  const mode = await sm().getProtectionMode();
  const unlocked = mode === 'passphrase' ? !!(await sm().getSessionPassphrase()) : true;
  return { mode, unlocked };
}

/** Re-seal every stored secret: read with the current scheme, write with the new one. */
async function resealAll(writeScheme) {
  const stored = await chrome.storage.sync.get(SECRET_KEYS);
  const plain = {};
  for (const k of SECRET_KEYS) {
    if (stored[k]) plain[k] = await sm().decryptApiKeyFromStorage(stored[k]);
  }
  await writeScheme();
  const out = {};
  let unreadable = 0;
  for (const [k, v] of Object.entries(plain)) {
    if (typeof v !== 'string' || !v) { unreadable++; continue; } // left as it was
    out[k] = await sm().encryptApiKeyForStorage(v);
  }
  await chrome.storage.sync.set(out);
  return { resealed: Object.keys(out).length, unreadable };
}

async function setPassphrase(pass) {
  if (typeof pass !== 'string' || pass.length < MIN_LENGTH) throw new Error(`Use at least ${MIN_LENGTH} characters.`);
  if ((await status()).mode === 'passphrase') throw new Error('A passphrase is already set. Remove it first to change it.');
  return resealAll(async () => {
    await chrome.storage.session.set({ _qatalyst_passphrase: pass });
    await chrome.storage.local.set({ _qatalyst_key_protection: 'passphrase' });
    await chrome.storage.local.set({ _qatalyst_pass_check: await sm().encryptApiKeyForStorage(CHECK_PLAINTEXT) });
  });
}

/** Verify the passphrase against the stored check value, then keep it for this session. */
async function unlock(pass) {
  const { _qatalyst_pass_check: check } = await chrome.storage.local.get('_qatalyst_pass_check');
  if (!check) throw new Error('No passphrase is set.');
  await chrome.storage.session.set({ _qatalyst_passphrase: pass });
  let ok = false;
  try { ok = (await sm().decryptApiKeyFromStorage(check)) === CHECK_PLAINTEXT; } catch (_) { ok = false; }
  if (!ok) {
    await chrome.storage.session.remove('_qatalyst_passphrase');
    throw new Error('Wrong passphrase.');
  }
  return { unlocked: true };
}

async function lock() {
  await chrome.storage.session.remove('_qatalyst_passphrase');
  return { unlocked: false };
}

/** Back to device-key sealing. Needs the vault unlocked, so the keys can be read. */
async function removePassphrase() {
  if ((await status()).mode !== 'passphrase') return { resealed: 0, unreadable: 0 };
  if (!(await status()).unlocked) throw new Error('Unlock first, so the keys can be re-sealed.');
  return resealAll(async () => {
    await chrome.storage.local.set({ _qatalyst_key_protection: 'device' });
    await chrome.storage.local.remove('_qatalyst_pass_check');
    await chrome.storage.session.remove('_qatalyst_passphrase');
  });
}

const api = { status, setPassphrase, unlock, lock, removePassphrase, SECRET_KEYS, MIN_LENGTH };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') self.KeyVault = api;
})();
