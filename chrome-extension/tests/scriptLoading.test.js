/**
 * The split files only work if they load the way Chrome loads them: plain
 * scripts sharing one global, in a fixed order. Load them exactly that way.
 */
const fs = require('fs');
const path = require('path');
const { loadScripts, EXT_DIR } = require('./helpers/load-global.js');

describe('service worker integration files', () => {
  test('load in importScripts order and publish every class', () => {
    const bg = fs.readFileSync(path.join(EXT_DIR, 'background.js'), 'utf8');
    const files = [...bg.matchAll(/importScripts\('(integrations[^']*)'\)/g)].map(m => m[1]);
    expect(files).toEqual(['integrations.js', 'integrations-docs.js', 'integrations-testrail.js', 'integrations-testmgmt.js']);

    const { ctx } = loadScripts(['config.js', 'export-ledger.js', ...files]);
    for (const c of ['CircuitBreaker', 'IntegrationManager', 'ConfluenceIntegration', 'FigmaIntegration',
      'GoogleDocsIntegration', 'TestRailIntegration', 'ZephyrScaleIntegration', 'ZephyrSquadIntegration',
      'XrayIntegration', 'QmetryIntegration']) {
      expect(typeof ctx[c], c).toBe('function');
    }
    const mgr = new ctx.IntegrationManager({});
    expect(mgr.confluence).toBeInstanceOf(ctx.ConfluenceIntegration);
  });
});

describe('content scripts', () => {
  const { Window } = require('happy-dom');
  const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));

  test('the manifest list loads into one scope without collisions', () => {
    const window = new Window({ url: 'https://acme.atlassian.net/jira/your-work' });
    const { ctx } = loadScripts(manifest.content_scripts[0].js, { window, extraGlobals: { MutationObserver: window.MutationObserver, performance } });
    for (const fn of ['extractTicketKey', 'loadAndDecryptSettings', 'handleExtractDOM', 'showCrawlCompleteModal']) {
      expect(typeof window[fn], fn).toBe('function');
    }
    expect(ctx.__qatalystCrawlerListener).toBe(true);
  });

  test('the full manifest list passes the dependency guard (panel code runs)', () => {
    const window = new Window({ url: 'https://acme.atlassian.net/browse/ABC-1' });
    loadScripts(manifest.content_scripts[0].js, { window, extraGlobals: { MutationObserver: window.MutationObserver } });
    expect(window.document.getElementById('qatalyst-reload-notice')).toBeNull();
  });

  test('content.js on its own (stale manifest) shows a reload notice instead of crashing', () => {
    const window = new Window({ url: 'https://acme.atlassian.net/browse/ABC-1' });
    expect(() => loadScripts(['content.js'], { window, extraGlobals: { MutationObserver: window.MutationObserver } })).not.toThrow();
    const note = window.document.getElementById('qatalyst-reload-notice');
    expect(note && note.textContent).toMatch(/click Reload on QAtalyst/);
  });

  test('the crawler injects only the crawler side, and it answers on its own', async () => {
    const crawler = fs.readFileSync(path.join(EXT_DIR, 'crawler-page.js'), 'utf8'); // verifyContentScript
    const injected = JSON.parse(crawler.match(/files: (\['config\.js'[^\]]*\])/)[1].replace(/'/g, '"'));
    expect(injected).toContain('content-crawler.js');
    expect(injected).not.toContain('content.js');

    const window = new Window({ url: 'https://app.example.com/settings' });
    const { createChromeMock } = require('./helpers/chrome-mock.js');
    const chrome = createChromeMock();
    let listeners = 0;
    const add = chrome.runtime.onMessage.addListener;
    chrome.runtime.onMessage.addListener = (fn) => { listeners++; add(fn); };
    const { ctx } = loadScripts(injected, { window, chrome });
    const res = await chrome.__dispatch({ action: 'detectSPAFramework' });
    expect(res).toEqual({ framework: null });

    // Re-injection into the same document must not add a second listener.
    expect(listeners).toBe(1);
    const code = fs.readFileSync(path.join(EXT_DIR, 'content-crawler.js'), 'utf8');
    require('vm').runInContext(code, ctx);
    expect(listeners).toBe(1);
  });
});
