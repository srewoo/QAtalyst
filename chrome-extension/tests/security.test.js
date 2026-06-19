/**
 * @vitest-environment happy-dom
 *
 * Tests for SecurityManager (security.js) — API-key encryption, validation,
 * masking, and HTML escaping. Loaded via the sandbox harness because security.js
 * attaches to globalThis instead of module.exports and needs APP_CONFIG + crypto.
 * jsdom env so DOM-based escapeHTML works; we pass the jsdom window into the
 * sandbox so security.js sees a real document.
 */
require('../config.js'); // sets global APP_CONFIG used by SecurityManager methods
const { SecurityManager } = require('../security.js');

function newManager() {
  return new SecurityManager();
}

describe('SecurityManager.validateApiKey', () => {
  const sm = newManager();

  test('accepts a well-formed OpenAI key', () => {
    expect(sm.validateApiKey('sk-' + 'a'.repeat(40), 'openai')).toBe(true);
  });

  test('accepts a well-formed Claude key, rejects a plain sk- key for claude', () => {
    expect(sm.validateApiKey('sk-ant-' + 'a'.repeat(40), 'claude')).toBe(true);
    expect(sm.validateApiKey('sk-' + 'a'.repeat(40), 'claude')).toBe(false);
  });

  test('rejects an empty / missing key', () => {
    expect(sm.validateApiKey('', 'openai')).toBe(false);
    expect(sm.validateApiKey(null, 'openai')).toBe(false);
  });

  test('rejects an obviously malformed key', () => {
    expect(sm.validateApiKey('not-a-key', 'openai')).toBe(false);
  });
});

describe('SecurityManager.maskApiKey', () => {
  const sm = newManager();

  test('masks the middle, keeps a short prefix/suffix', () => {
    const masked = sm.maskApiKey('sk-1234567890abcdef');
    expect(masked).not.toBe('sk-1234567890abcdef');
    expect(masked).toMatch(/\*/);
  });

  test('does not throw on short or empty input', () => {
    expect(() => sm.maskApiKey('')).not.toThrow();
    expect(() => sm.maskApiKey('abc')).not.toThrow();
  });
});

describe('SecurityManager.escapeHTML', () => {
  const sm = newManager();

  test('escapes angle brackets and ampersands', () => {
    const out = sm.escapeHTML('<script>alert("x")&</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;');
    expect(out).toContain('&amp;');
  });
});

describe('SecurityManager API-key encryption round-trip', () => {
  test('decrypts back to the original key with the same password', async () => {
    const sm = newManager();
    const stored = await sm.encryptApiKeyForStorage('sk-secret-key-value-123', 'correct horse');
    expect(typeof stored).toBe('string');
    expect(sm.isEncrypted(stored)).toBe(true);
    const back = await sm.decryptApiKeyFromStorage(stored, 'correct horse');
    expect(back).toBe('sk-secret-key-value-123');
  });

  test('produces different ciphertext each time (random salt/iv)', async () => {
    const sm = newManager();
    const a = await sm.encryptApiKeyForStorage('sk-same', 'pw');
    const b = await sm.encryptApiKeyForStorage('sk-same', 'pw');
    expect(a).not.toBe(b);
  });
});
