/**
 * @vitest-environment happy-dom
 *
 * Tests for the external integration classes in integrations.js
 * (ConfluenceIntegration, FigmaIntegration, GoogleDocsIntegration).
 *
 * integrations.js uses module.exports, so we require the real classes directly.
 * It depends on a handful of browser/service-worker globals — chrome, fetch,
 * btoa/atob, and a CONFIG object — which we supply on `global` BEFORE requiring
 * the module. We never re-implement the integration logic here; every test drives
 * the real class and asserts on its actual output and the fetch calls it makes.
 */
const { createChromeMock } = require('./helpers/chrome-mock.js');

// CONFIG mirrors config.js values the integrations read at runtime.
global.CONFIG = {
  MAX_TEXT_EXTRACT_LENGTH: 30000,
  MAX_FIGMA_IMAGES: 50,
  MIN_FIGMA_IMAGE_SIZE_KB: 5,
  FIGMA_RATE_LIMIT_DELAY: 1000,
};
global.chrome = createChromeMock();

const {
  ConfluenceIntegration,
  FigmaIntegration,
  GoogleDocsIntegration,
} = require('../integrations.js');

// Helper to build a Response-like object the integration code consumes.
function makeResponse({ ok = true, status = 200, json, text, headers = {}, url } = {}) {
  return {
    ok,
    status,
    url,
    headers: { get: (k) => headers[k] ?? headers[k.toLowerCase()] ?? null },
    json: async () => (typeof json === 'function' ? json() : json),
    text: async () => (typeof text === 'function' ? text() : (text ?? '')),
  };
}

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// ConfluenceIntegration
// ---------------------------------------------------------------------------
describe('ConfluenceIntegration.extractUrls', () => {
  const conf = new ConfluenceIntegration({
    confluenceUrl: 'https://acme.atlassian.net/wiki',
    confluenceEmail: 'me@acme.com',
    confluenceToken: 'tok123',
  });

  test('extracts a Cloud wiki page URL from free text', () => {
    const text = 'See spec at https://acme.atlassian.net/wiki/spaces/PROJ/pages/123456/My-Page for details.';
    const urls = conf.extractUrls(text);
    expect(urls).toContain('https://acme.atlassian.net/wiki/spaces/PROJ/pages/123456/My-Page');
  });

  test('deduplicates repeated URLs', () => {
    const u = 'https://acme.atlassian.net/wiki/spaces/PROJ/pages/123456';
    const urls = conf.extractUrls(`${u} and again ${u}`);
    expect(urls.filter((x) => x === u)).toHaveLength(1);
  });

  test('returns empty array when no Confluence URLs present', () => {
    expect(conf.extractUrls('nothing here, just https://example.com/foo')).toEqual([]);
  });
});

describe('ConfluenceIntegration.extractPageId', () => {
  const conf = new ConfluenceIntegration({
    confluenceUrl: 'https://acme.atlassian.net/wiki',
    confluenceEmail: 'me@acme.com',
    confluenceToken: 'tok123',
  });

  test('extracts numeric id from a Cloud pages URL', () => {
    expect(conf.extractPageId('https://acme.atlassian.net/wiki/spaces/PROJ/pages/987654/Title')).toBe('987654');
  });

  test('extracts id from a viewpage.action?pageId= URL', () => {
    expect(conf.extractPageId('https://confluence.acme.com/pages/viewpage.action?pageId=42')).toBe('42');
  });

  test('returns null when URL has no numeric id', () => {
    expect(conf.extractPageId('https://acme.atlassian.net/wiki/display/PROJ/Some-Title')).toBeNull();
  });
});

describe('ConfluenceIntegration.fetchPage', () => {
  function newConf() {
    return new ConfluenceIntegration({
      confluenceUrl: 'https://acme.atlassian.net/wiki',
      confluenceEmail: 'me@acme.com',
      confluenceToken: 'secret-token',
    });
  }

  test('throws when not configured (missing token)', async () => {
    const conf = new ConfluenceIntegration({ confluenceUrl: 'https://acme.atlassian.net/wiki', confluenceEmail: 'me@acme.com' });
    await expect(conf.fetchPage('https://acme.atlassian.net/wiki/spaces/P/pages/1')).rejects.toThrow(/not configured/i);
  });

  test('builds the Cloud REST URL + Basic auth header and parses body.storage into text', async () => {
    const conf = newConf();
    global.fetch.mockResolvedValue(
      makeResponse({
        json: {
          title: 'Login Spec',
          body: { storage: { value: '<h1>Login</h1><p>User enters <b>email</b>.</p>' } },
          version: { number: 7 },
        },
      })
    );

    const result = await conf.fetchPage('https://acme.atlassian.net/wiki/spaces/PROJ/pages/123456/Login');

    // (a) correct request URL + headers/auth
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, opts] = global.fetch.mock.calls[0];
    expect(calledUrl).toBe('https://acme.atlassian.net/wiki/rest/api/content/123456?expand=body.storage,version');
    const expectedAuth = 'Basic ' + Buffer.from('me@acme.com:secret-token').toString('base64');
    expect(opts.headers.Authorization).toBe(expectedAuth);
    expect(opts.headers.Accept).toBe('application/json');

    // (b) parsed into the shape the app expects
    expect(result.url).toBe('https://acme.atlassian.net/wiki/spaces/PROJ/pages/123456/Login');
    expect(result.title).toBe('Login Spec');
    expect(result.version).toBe(7);
    expect(result.content).toContain('Login');
    expect(result.content).toContain('User enters email.');
    expect(result.content).not.toContain('<h1>'); // HTML stripped
  });

  test('uses the Server REST path (/rest/api/content) for non-Cloud base URLs', async () => {
    const conf = new ConfluenceIntegration({
      confluenceUrl: 'https://confluence.acme.com',
      confluenceEmail: 'me@acme.com',
      confluenceToken: 'secret-token',
    });
    global.fetch.mockResolvedValue(
      makeResponse({ json: { title: 'T', body: { storage: { value: '<p>hi</p>' } }, version: { number: 1 } } })
    );

    await conf.fetchPage('https://confluence.acme.com/pages/viewpage.action?pageId=555');
    const [calledUrl] = global.fetch.mock.calls[0];
    expect(calledUrl).toBe('https://confluence.acme.com/rest/api/content/555?expand=body.storage,version');
  });

  test('maps 401 to an authentication error', async () => {
    const conf = newConf();
    global.fetch.mockResolvedValue(makeResponse({ ok: false, status: 401 }));
    await expect(conf.fetchPage('https://acme.atlassian.net/wiki/spaces/P/pages/1')).rejects.toThrow(/authentication failed/i);
  });

  test('maps 404 to a not-found error', async () => {
    const conf = newConf();
    global.fetch.mockResolvedValue(makeResponse({ ok: false, status: 404 }));
    await expect(conf.fetchPage('https://acme.atlassian.net/wiki/spaces/P/pages/1')).rejects.toThrow(/not found/i);
  });

  test('429 surfaces a rate-limit error carrying the 429 status (no infinite loop)', async () => {
    const conf = newConf();
    global.fetch.mockResolvedValue(makeResponse({ ok: false, status: 429, headers: { 'Retry-After': '30' } }));
    await expect(
      conf.fetchPage('https://acme.atlassian.net/wiki/spaces/P/pages/1')
    ).rejects.toMatchObject({ message: expect.stringMatching(/rate limited/i), response: { status: 429 } });
  });
});

// ---------------------------------------------------------------------------
// FigmaIntegration
// ---------------------------------------------------------------------------
describe('FigmaIntegration URL parsing', () => {
  const figma = new FigmaIntegration({ figmaToken: 'figd-abc' });

  test('extractUrls finds file/design/proto URLs', () => {
    const text = 'design https://www.figma.com/design/AbC123/My-File?node-id=1-2 plus https://figma.com/file/XyZ9/Old';
    const urls = figma.extractUrls(text);
    expect(urls).toContain('https://www.figma.com/design/AbC123/My-File?node-id=1-2');
    expect(urls).toContain('https://figma.com/file/XyZ9/Old');
  });

  test('extractFileKey returns the key segment', () => {
    expect(figma.extractFileKey('https://www.figma.com/design/AbC123/My-File?node-id=1-2')).toBe('AbC123');
  });

  test('parseFigmaURL extracts fileKey and converts node-id dashes to colons', () => {
    const { fileKey, nodeId } = figma.parseFigmaURL('https://www.figma.com/design/AbC123/My-File?node-id=12-345');
    expect(fileKey).toBe('AbC123');
    expect(nodeId).toBe('12:345');
  });

  test('parseFigmaURL returns null nodeId when no node-id present', () => {
    const { fileKey, nodeId } = figma.parseFigmaURL('https://www.figma.com/file/XyZ9/Old');
    expect(fileKey).toBe('XyZ9');
    expect(nodeId).toBeNull();
  });
});

describe('FigmaIntegration.calculateNodePriority', () => {
  const figma = new FigmaIntegration({ figmaToken: 'figd-abc' });

  test('UI-keyword frames outrank generic rectangles', () => {
    const loginScreen = figma.calculateNodePriority({ name: 'Login Screen', type: 'FRAME' });
    const rect = figma.calculateNodePriority({ name: 'Rectangle', type: 'FRAME' });
    expect(loginScreen).toBeGreaterThan(rect);
  });
});

describe('FigmaIntegration.fetchFile', () => {
  test('throws when no token configured', async () => {
    const figma = new FigmaIntegration({});
    await expect(figma.fetchFile('https://www.figma.com/file/XyZ9/Old')).rejects.toThrow(/not configured/i);
  });

  test('throws on a URL with no extractable file key', async () => {
    const figma = new FigmaIntegration({ figmaToken: 'figd-abc' });
    await expect(figma.fetchFile('https://www.figma.com/community')).rejects.toThrow(/Invalid Figma URL/i);
  });

  test('no node-id: calls files endpoint with X-Figma-Token and parses specs + image nodes', async () => {
    const figma = new FigmaIntegration({ figmaToken: 'figd-abc' });
    global.fetch.mockResolvedValue(
      makeResponse({
        json: {
          name: 'Checkout Flow',
          document: {
            children: [
              {
                type: 'CANVAS',
                name: 'Page 1',
                children: [
                  { id: '1:10', type: 'FRAME', name: 'Cart', absoluteBoundingBox: { width: 100.4, height: 200.6 }, children: [{ type: 'TEXT' }, { type: 'TEXT' }] },
                  { id: '1:20', type: 'COMPONENT', name: 'Button' },
                  { id: '1:30', type: 'TEXT', name: 'caption' },
                ],
              },
            ],
          },
        },
      })
    );

    const result = await figma.fetchFile('https://www.figma.com/file/XyZ9/Checkout');

    // (a) request: files endpoint + token header
    const [calledUrl, opts] = global.fetch.mock.calls[0];
    expect(calledUrl).toBe('https://api.figma.com/v1/files/XyZ9');
    expect(opts.headers['X-Figma-Token']).toBe('figd-abc');

    // (b) parsed shape
    expect(result.name).toBe('Checkout Flow');
    expect(result.specifications).toContain('# Checkout Flow');
    expect(result.specifications).toContain('Page 1');
    expect(result.specifications).toContain('Cart');
    expect(result.specifications).toContain('100x201'); // rounded size
    // image-export nodes: only FRAME + COMPONENT (not TEXT)
    expect(result.nodesForImageExport).toEqual(['1:10', '1:20']);
  });

  test('with node-id: calls nodes endpoint and derives specs from the node document', async () => {
    const figma = new FigmaIntegration({ figmaToken: 'figd-abc', figmaImageMode: 'single' });
    global.fetch.mockResolvedValue(
      makeResponse({
        json: {
          nodes: {
            '1:41': { document: { name: 'Profile Card', type: 'FRAME' } },
          },
        },
      })
    );

    const result = await figma.fetchFile('https://www.figma.com/design/AbC123/My-File?node-id=1-41');

    const [calledUrl, opts] = global.fetch.mock.calls[0];
    expect(calledUrl).toBe('https://api.figma.com/v1/files/AbC123/nodes?ids=1:41');
    expect(opts.headers['X-Figma-Token']).toBe('figd-abc');

    expect(result.name).toBe('Profile Card');
    expect(result.specifications).toContain('Profile Card');
    expect(result.specifications).toContain('Node ID: 1:41');
    expect(result.nodesForImageExport).toEqual(['1:41']); // single mode
  });

  test('maps 401/403 to an authentication error', async () => {
    const figma = new FigmaIntegration({ figmaToken: 'figd-abc' });
    global.fetch.mockResolvedValue(makeResponse({ ok: false, status: 403 }));
    await expect(figma.fetchFile('https://www.figma.com/file/XyZ9/Old')).rejects.toThrow(/authentication failed/i);
  });

  test('maps 404 to a file-not-found error', async () => {
    const figma = new FigmaIntegration({ figmaToken: 'figd-abc' });
    global.fetch.mockResolvedValue(makeResponse({ ok: false, status: 404 }));
    await expect(figma.fetchFile('https://www.figma.com/file/XyZ9/Old')).rejects.toThrow(/not found/i);
  });

  test('429 with no retries left throws a rate-limit error', async () => {
    const figma = new FigmaIntegration({ figmaToken: 'figd-abc' });
    global.fetch.mockResolvedValue(makeResponse({ ok: false, status: 429, headers: { 'Retry-After': '0' } }));
    // retries=0 -> immediate throw, no setTimeout wait
    await expect(figma.fetchFile('https://www.figma.com/file/XyZ9/Old', 0)).rejects.toThrow(/rate limit exceeded/i);
  });
});

describe('FigmaIntegration.fetchNodeImages', () => {
  test('returns [] when no token/fileKey/nodes', async () => {
    const figma = new FigmaIntegration({});
    expect(await figma.fetchNodeImages('key', ['1:1'])).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('builds the images endpoint URL with token; returns [] gracefully on non-ok', async () => {
    const figma = new FigmaIntegration({ figmaToken: 'figd-abc' });
    global.fetch.mockResolvedValue(makeResponse({ ok: false, status: 500, text: 'boom' }));
    const out = await figma.fetchNodeImages('XyZ9', ['1:10', '1:20']);
    expect(out).toEqual([]);
    const [calledUrl, opts] = global.fetch.mock.calls[0];
    expect(calledUrl).toBe('https://api.figma.com/v1/images/XyZ9?ids=1:10,1:20&format=png&scale=2');
    expect(opts.headers['X-Figma-Token']).toBe('figd-abc');
  });
});

// ---------------------------------------------------------------------------
// GoogleDocsIntegration
// ---------------------------------------------------------------------------
describe('GoogleDocsIntegration URL handling', () => {
  const gdocs = new GoogleDocsIntegration({});

  test('extractDocId pulls the document id', () => {
    expect(gdocs.extractDocId('https://docs.google.com/document/d/abc123_DEF/edit?tab=t.0#heading=h.x')).toBe('abc123_DEF');
  });

  test('extractUrls normalises to a bare /document/d/<id> URL (strips query+fragment)', () => {
    const urls = gdocs.extractUrls('doc at https://docs.google.com/document/d/abc123_DEF/edit?tab=t.0#heading=h.x end');
    expect(urls).toEqual(['https://docs.google.com/document/d/abc123_DEF']);
  });
});

describe('GoogleDocsIntegration.fetchDocument', () => {
  const gdocs = new GoogleDocsIntegration({});

  test('hits the public export endpoint and returns parsed text content', async () => {
    global.fetch.mockResolvedValue(makeResponse({ text: 'Requirement: user can reset password.' }));

    const result = await gdocs.fetchDocument('https://docs.google.com/document/d/DOCID123/edit');

    const [calledUrl, opts] = global.fetch.mock.calls[0];
    expect(calledUrl).toBe('https://docs.google.com/document/d/DOCID123/export?format=txt');
    expect(opts.method).toBe('GET');
    expect(opts.redirect).toBe('follow');

    expect(result.url).toBe('https://docs.google.com/document/d/DOCID123/edit');
    expect(result.title).toBe('Google Doc DOCID123');
    expect(result.content).toBe('Requirement: user can reset password.');
    expect(result.revisionId).toBeNull();
  });

  test('throws on an invalid Google Docs URL (no doc id)', async () => {
    await expect(gdocs.fetchDocument('https://docs.google.com/spreadsheets/d/x')).rejects.toThrow(/Invalid Google Docs URL/i);
  });

  test('maps 403 to an access-denied error', async () => {
    global.fetch.mockResolvedValue(makeResponse({ ok: false, status: 403, text: 'forbidden' }));
    await expect(gdocs.fetchDocument('https://docs.google.com/document/d/DOCID123')).rejects.toThrow(/access denied/i);
  });

  test('maps 404 to a not-found error', async () => {
    global.fetch.mockResolvedValue(makeResponse({ ok: false, status: 404, text: 'nope' }));
    await expect(gdocs.fetchDocument('https://docs.google.com/document/d/DOCID123')).rejects.toThrow(/not found/i);
  });

  test('truncates content longer than MAX_TEXT_EXTRACT_LENGTH', async () => {
    const big = 'x'.repeat(global.CONFIG.MAX_TEXT_EXTRACT_LENGTH + 100);
    global.fetch.mockResolvedValue(makeResponse({ text: big }));
    const result = await gdocs.fetchDocument('https://docs.google.com/document/d/DOCID123');
    expect(result.content.endsWith('... [Content truncated]')).toBe(true);
    expect(result.content.length).toBeLessThan(big.length);
  });
});
