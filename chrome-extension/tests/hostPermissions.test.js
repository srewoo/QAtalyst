const { originPattern, registrableDomain, requestHostAccess } = require('../host-permissions.js');

describe('host-permissions', () => {
  test('exact site by default', () => {
    expect(originPattern('https://acme.testrail.io/index.php?/api')).toBe('https://acme.testrail.io/*');
  });
  test('siblings widens to the registrable domain so cross-subdomain APIs are seen', () => {
    expect(originPattern('https://app.eu.example.com/x', { siblings: true })).toBe('https://*.example.com/*');
    expect(originPattern('https://app.example.co.uk/', { siblings: true })).toBe('https://*.example.co.uk/*');
    expect(originPattern('https://example.io/', { siblings: true })).toBe('https://*.example.io/*');
  });
  test('localhost and IPs never widen', () => {
    expect(originPattern('http://localhost:3000/', { siblings: true })).toBe('http://localhost/*');
    expect(originPattern('http://10.0.0.5:8080/', { siblings: true })).toBe('http://10.0.0.5/*');
  });
  test('non-web URLs are ignored', () => {
    expect(originPattern('chrome://extensions')).toBeNull();
    expect(originPattern('not a url')).toBeNull();
    expect(registrableDomain('a.b.com')).toBe('b.com');
  });
  test('requests deduped origins in one prompt; nothing to ask → no prompt', async () => {
    const request = vi.fn(async () => true);
    globalThis.chrome = { permissions: { request } };
    await requestHostAccess(['https://a.x.com/1', 'https://a.x.com/2', '']);
    expect(request).toHaveBeenCalledWith({ origins: ['https://a.x.com/*'] });
    request.mockClear();
    expect(await requestHostAccess([])).toEqual({ granted: true, origins: [] });
    expect(request).not.toHaveBeenCalled();
    delete globalThis.chrome;
  });
});
