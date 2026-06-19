/**
 * Tests for crawler-auth.js — automated form login for crawling auth-gated apps.
 * Pure helpers are tested directly; the orchestration is tested with injected
 * fake deps (no browser needed), including success, timeout, and error paths.
 */
const { CrawlerAuth, validateAuthConfig, matchesSuccess, buildFillSteps } = require('../crawler-auth.js');

const BASE = {
  loginUrl: 'https://app.example.com/login',
  usernameSelector: '#user', passwordSelector: '#pass', submitSelector: '#submit',
  username: 'alice', password: 's3cret',
  successUrlPattern: '/dashboard',
};

describe('validateAuthConfig', () => {
  test('accepts a complete config', () => {
    expect(validateAuthConfig(BASE).valid).toBe(true);
  });
  test('reports each missing required field', () => {
    const r = validateAuthConfig({ loginUrl: 'x' });
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/usernameSelector/);
    expect(r.errors.join(' ')).toMatch(/password/);
  });
  test('submitByEnter substitutes for submitSelector', () => {
    const { submitSelector, ...rest } = BASE;
    expect(validateAuthConfig({ ...rest, submitByEnter: true }).valid).toBe(true);
    expect(validateAuthConfig(rest).valid).toBe(false);
  });
});

describe('matchesSuccess', () => {
  test('substring pattern', () => {
    expect(matchesSuccess('https://app.example.com/dashboard/home', BASE)).toBe(true);
    expect(matchesSuccess('https://app.example.com/login', BASE)).toBe(false);
  });
  test('/regex/ pattern', () => {
    const cfg = { ...BASE, successUrlPattern: '/(dashboard|welcome)/' };
    expect(matchesSuccess('https://app.example.com/dashboard', cfg)).toBe(true);
    expect(matchesSuccess('https://app.example.com/welcome/home', cfg)).toBe(true);
    expect(matchesSuccess('https://app.example.com/login', cfg)).toBe(false);
  });
  test('no pattern → success = left the login page', () => {
    const cfg = { loginUrl: 'https://app.example.com/login' };
    expect(matchesSuccess('https://app.example.com/home', cfg)).toBe(true);
    expect(matchesSuccess('https://app.example.com/login', cfg)).toBe(false);
    expect(matchesSuccess('https://app.example.com/login/', cfg)).toBe(false); // trailing slash/hash ignored
  });
});

describe('buildFillSteps', () => {
  test('fills username + password then clicks submit', () => {
    const steps = buildFillSteps(BASE);
    expect(steps).toEqual([
      { action: 'fill', selector: '#user', value: 'alice' },
      { action: 'fill', selector: '#pass', value: 's3cret' },
      { action: 'click', selector: '#submit' },
    ]);
  });
  test('uses Enter when submitByEnter set', () => {
    const { submitSelector, ...rest } = BASE;
    const steps = buildFillSteps({ ...rest, submitByEnter: true });
    expect(steps[2]).toEqual({ action: 'enter', selector: '#pass' });
  });
});

function fakeDeps(urlSequence) {
  const calls = { navigated: [], filled: null, urlIdx: 0, sleeps: 0 };
  return {
    calls,
    navigate: async (url) => { calls.navigated.push(url); },
    fillAndSubmit: async (steps) => { calls.filled = steps; },
    getCurrentUrl: async () => urlSequence[Math.min(calls.urlIdx++, urlSequence.length - 1)],
    sleep: async () => { calls.sleeps++; },
  };
}

describe('CrawlerAuth.authenticate', () => {
  test('navigates, fills, and confirms success', async () => {
    const deps = fakeDeps([
      'https://app.example.com/login',      // still on login
      'https://app.example.com/dashboard',  // success
    ]);
    const auth = new CrawlerAuth(BASE, deps);
    const r = await auth.authenticate();
    expect(r.success).toBe(true);
    expect(deps.calls.navigated).toEqual([BASE.loginUrl]);
    expect(deps.calls.filled.length).toBe(3);
  });

  test('fails (no throw) on invalid config', async () => {
    const r = await new CrawlerAuth({ loginUrl: 'x' }, fakeDeps([])).authenticate();
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/invalid auth config/);
  });

  test('times out when success is never reached', async () => {
    const deps = fakeDeps(['https://app.example.com/login']); // never leaves login
    const auth = new CrawlerAuth({ ...BASE, maxWaitMs: 5, pollMs: 1 }, deps);
    const r = await auth.authenticate();
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/timeout/);
  });

  test('captures dep errors without throwing', async () => {
    const auth = new CrawlerAuth(BASE, {
      navigate: async () => { throw new Error('nav boom'); },
      fillAndSubmit: async () => {}, getCurrentUrl: async () => null, sleep: async () => {},
    });
    const r = await auth.authenticate();
    expect(r.success).toBe(false);
    expect(r.reason).toMatch(/nav boom/);
  });
});
