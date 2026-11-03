/**
 * Optional passphrase protection for stored API keys (key-vault.js + SecurityManager).
 * Real WebCrypto (Node), real SecurityManager, in-memory chrome.storage.
 */
const { loadScripts } = require('./helpers/load-global.js');

async function setup() {
  const { ctx } = loadScripts(['config.js', 'security.js', 'key-vault.js']);
  const sm = ctx.securityManager;
  // Keys as the options page stores them today: sealed with the device key.
  await ctx.chrome.storage.sync.set({
    apiKey: await sm.encryptApiKeyForStorage('sk-live-123'),
    jiraApiToken: await sm.encryptApiKeyForStorage('jira-456')
  });
  return { ctx, sm, vault: ctx.KeyVault, store: ctx.chrome.storage };
}

describe('passphrase protection', () => {
  test('full cycle: set, lock, unlock, remove — keys survive every step', async () => {
    const { sm, vault, store } = await setup();
    expect(await vault.status()).toEqual({ mode: 'device', unlocked: true });

    const set = await vault.setPassphrase('correct horse battery');
    expect(set).toEqual({ resealed: 2, unreadable: 0 });
    const sealed = await store.sync.get(['apiKey', 'jiraApiToken']);
    expect(sealed.apiKey.startsWith('encp:')).toBe(true);
    expect(await sm.decryptApiKeyFromStorage(sealed.apiKey)).toBe('sk-live-123');
    // The passphrase is only in session storage, never on disk.
    expect(JSON.stringify(await store.local.get(null))).not.toContain('correct horse battery');

    await vault.lock();
    expect(await vault.status()).toEqual({ mode: 'passphrase', unlocked: false });
    await expect(sm.decryptApiKeyFromStorage(sealed.apiKey)).rejects.toThrow(/locked/i);

    await expect(vault.unlock('wrong passphrase')).rejects.toThrow(/wrong passphrase/i);
    expect((await vault.status()).unlocked).toBe(false);
    await vault.unlock('correct horse battery');
    expect(await sm.decryptApiKeyFromStorage(sealed.apiKey)).toBe('sk-live-123');

    expect(await vault.removePassphrase()).toEqual({ resealed: 2, unreadable: 0 });
    const back = await store.sync.get(['apiKey', 'jiraApiToken']);
    expect(back.apiKey.startsWith('enc:')).toBe(true);
    expect(await sm.decryptApiKeyFromStorage(back.jiraApiToken)).toBe('jira-456');
    expect(await vault.status()).toEqual({ mode: 'device', unlocked: true });
  });

  test('a new key saved while unlocked is sealed with the passphrase; while locked, saving refuses', async () => {
    const { sm, vault } = await setup();
    await vault.setPassphrase('correct horse battery');
    expect((await sm.encryptApiKeyForStorage('new-key')).startsWith('encp:')).toBe(true);
    await vault.lock();
    // Never silently falls back to the weaker device key.
    await expect(sm.encryptApiKeyForStorage('new-key')).rejects.toThrow(/locked/i);
  });

  test('guards: short passphrase, double set, remove while locked', async () => {
    const { vault } = await setup();
    await expect(vault.setPassphrase('short')).rejects.toThrow(/at least 8/);
    await vault.setPassphrase('correct horse battery');
    await expect(vault.setPassphrase('another long one')).rejects.toThrow(/already set/);
    await vault.lock();
    await expect(vault.removePassphrase()).rejects.toThrow(/unlock first/i);
  });

  test('device mode is unchanged for users who never set a passphrase', async () => {
    const { sm } = await setup();
    const v = await sm.encryptApiKeyForStorage('plain-user-key');
    expect(v.startsWith('enc:')).toBe(true);
    expect(await sm.decryptApiKeyFromStorage(v)).toBe('plain-user-key');
  });
});
