/**
 * Tests for config-loader.js — ConfigLoader class. It uses chrome.runtime.getURL
 * + fetch at load time. We supply the chrome mock as a global and stub fetch.
 */
const { createChromeMock } = require('./helpers/chrome-mock.js');

global.chrome = createChromeMock();
const { ConfigLoader } = require('../config-loader.js');

describe('ConfigLoader.load — fallback to defaults', () => {
  test('falls back to getDefaultConfig when fetch fails', async () => {
    global.fetch = () => Promise.reject(new Error('network down'));
    const cl = new ConfigLoader();
    const cfg = await cl.load();
    expect(cl.isLoaded).toBe(true);
    expect(cfg.version).toBe('11.0.0');
    expect(cfg.crawler.limits.maxPages).toBe(1000);
  });

  test('falls back to defaults on a non-ok HTTP response', async () => {
    global.fetch = () => Promise.resolve({ ok: false, status: 404 });
    const cl = new ConfigLoader();
    const cfg = await cl.load();
    expect(cfg.version).toBe('11.0.0');
  });
});

describe('ConfigLoader.load — successful fetch', () => {
  test('loads the fetched JSON config', async () => {
    const fetched = { version: '99.9.9', crawler: { limits: { maxPages: 7 } } };
    global.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve(fetched) });
    const cl = new ConfigLoader();
    const cfg = await cl.load();
    expect(cfg.version).toBe('99.9.9');
    expect(cl.get('crawler.limits.maxPages')).toBe(7);
  });

  test('load is idempotent (cached after first load)', async () => {
    let calls = 0;
    global.fetch = () => { calls++; return Promise.resolve({ ok: true, json: () => Promise.resolve({ version: '1' }) }); };
    const cl = new ConfigLoader();
    await cl.load();
    await cl.load();
    expect(calls).toBe(1);
  });
});

describe('ConfigLoader.get', () => {
  test('returns nested config values via dot notation', async () => {
    global.fetch = () => Promise.reject(new Error('use defaults'));
    const cl = new ConfigLoader();
    await cl.load();
    expect(cl.get('crawler.limits.maxDepth')).toBe(10);
    expect(cl.get('embeddings.search.topK')).toBe(5);
    expect(cl.get('storage.dbName')).toBe('QAtalystEmbeddings');
  });

  test('returns the provided default for a missing path', async () => {
    global.fetch = () => Promise.reject(new Error('use defaults'));
    const cl = new ConfigLoader();
    await cl.load();
    expect(cl.get('does.not.exist', 'fallback')).toBe('fallback');
    expect(cl.get('crawler.limits.nope', 42)).toBe(42);
    expect(cl.get('missing')).toBeNull();
  });

  test('returns the default when not yet loaded', () => {
    const cl = new ConfigLoader();
    expect(cl.get('crawler.limits.maxPages', 'unloaded')).toBe('unloaded');
  });
});
