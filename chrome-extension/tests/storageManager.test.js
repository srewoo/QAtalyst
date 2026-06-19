/**
 * Tests for StorageManager (storage-manager.js) — persistence of crawl
 * embeddings/knowledge-graphs over chrome.storage. Uses the in-memory chrome
 * mock so save/load/list round-trips exercise the real serialization paths.
 */
require('fake-indexeddb/auto'); // StorageManager persists embeddings in IndexedDB
const { createChromeMock } = require('./helpers/chrome-mock.js');

// chrome + CONFIG must exist before requiring/instantiating (the constructor
// reads CONFIG.get(...)); stub CONFIG to return the supplied defaults.
global.chrome = createChromeMock();
global.CONFIG = global.CONFIG || { get: (_k, d) => d };
const StorageManager = require('../storage-manager.js');

function freshManager(storage = {}) {
  global.chrome = createChromeMock(storage);
  return new StorageManager();
}

describe('StorageManager pure helpers', () => {
  test('formatBytes renders human-readable sizes', () => {
    const sm = freshManager();
    expect(sm.formatBytes(0)).toMatch(/0/);
    expect(sm.formatBytes(1024)).toMatch(/1(\.0+)?\s?KB/i);
    expect(sm.formatBytes(1048576)).toMatch(/1(\.0+)?\s?MB/i);
  });

  test('sanitizeFilename strips unsafe characters', () => {
    const sm = freshManager();
    const out = sm.sanitizeFilename('https://app.example.com/a b?c=1');
    expect(out).not.toMatch(/[\/?:]/);
    expect(out.length).toBeGreaterThan(0);
  });

  test('createDataUrl builds a data: URI with the given mime', () => {
    const sm = freshManager();
    const url = sm.createDataUrl('{"a":1}', 'application/json');
    expect(url.startsWith('data:application/json')).toBe(true);
  });
});

describe('StorageManager save/load round-trip', () => {
  test('saveEmbeddings then loadEmbeddings returns the stored graph + embeddings', async () => {
    const sm = freshManager();
    const appUrl = 'https://app.example.com';
    await sm.saveEmbeddings(appUrl, {
      embeddings: [{ id: 1, vector: [0.1, 0.2] }],
      knowledgeGraph: {
        pages: [{ url: appUrl + '/home', title: 'Home' }],
        forms: [{ id: 'login', fields: ['user', 'pass'] }],
        apis: [{ method: 'POST', endpoint: '/api/login' }],
      },
    });
    const loaded = await sm.loadEmbeddings(appUrl);
    expect(loaded).toBeTruthy();
    expect(loaded.appUrl).toBe(appUrl);
    expect(loaded.knowledgeGraph.forms[0].id).toBe('login');
    expect(loaded.embeddings[0].id).toBe(1);
  });

  test('getAllApps lists a saved app', async () => {
    const sm = freshManager();
    await sm.saveEmbeddings('https://shop.example.com', { embeddings: [], knowledgeGraph: { pages: [{ url: 'https://shop.example.com' }] } });
    const apps = await sm.getAllApps();
    expect(Array.isArray(apps)).toBe(true);
    expect(apps.length).toBeGreaterThanOrEqual(1);
  });

  test('loadEmbeddings returns null/undefined for an unknown app', async () => {
    const sm = freshManager();
    const loaded = await sm.loadEmbeddings('https://never-crawled.example.com');
    expect(loaded == null || Object.keys(loaded).length === 0).toBe(true);
  });
});
