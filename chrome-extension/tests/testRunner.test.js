/**
 * test-runner.js ("Verify in app"). The browser round-trip is proven by
 * e2e/export-check/runner.spec.js; these pin the in-page actions and the safety
 * rules that decide what may run at all.
 */
const { Window } = require('happy-dom');
global.self = global.self || global;
self.TestSteps = require('../test-steps.js');
const { pageAction, pageHasText, runOne, DESTRUCTIVE_RE } = require('../test-runner.js');

function withPage(html, fn) {
  const window = new Window({ url: 'https://app.example.com/login' });
  window.document.body.innerHTML = html;
  const saved = {};
  for (const k of ['document', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'Event']) {
    saved[k] = global[k]; global[k] = window[k];
  }
  try { return fn(window); } finally { for (const k of Object.keys(saved)) global[k] = saved[k]; }
}

describe('pageAction (runs inside the page)', () => {
  const FORM = `<label for="e">Email</label><input id="e" name="email">
    <label for="r">Role</label><select id="r"><option value="v">Viewer</option><option value="ed">Editor</option></select>
    <label><input type="checkbox" id="t"> Terms</label><button id="go">Sign In</button><button disabled>Delete</button>`;

  test('fills a field found by its label and fires input/change', () => withPage(FORM, (w) => {
    const seen = [];
    w.document.getElementById('e').addEventListener('input', () => seen.push('input'));
    expect(pageAction({ kind: 'fill', target: 'Email', value: 'a@b.co' })).toEqual({ ok: true });
    expect(w.document.getElementById('e').value).toBe('a@b.co');
    expect(seen).toEqual(['input']);
  }));

  test('selects a dropdown option by its visible text, and rejects one it does not have', () => withPage(FORM, (w) => {
    expect(pageAction({ kind: 'select', target: 'Role', value: 'Editor' })).toEqual({ ok: true });
    expect(w.document.getElementById('r').value).toBe('ed');
    expect(pageAction({ kind: 'select', target: 'Role', value: 'Owner' }).error).toMatch(/option "Owner"/);
  }));

  test('checks a checkbox only when it is not already in the wanted state', () => withPage(FORM, (w) => {
    pageAction({ kind: 'check', target: 'Terms' });
    pageAction({ kind: 'check', target: 'Terms' });
    expect(w.document.getElementById('t').checked).toBe(true);
  }));

  test('reports a missing or disabled control instead of guessing', () => withPage(FORM, () => {
    expect(pageAction({ kind: 'click', target: 'Remember me' }).error).toMatch(/could not find "Remember me"/);
    expect(pageAction({ kind: 'click', target: 'Delete' }).error).toMatch(/disabled/);
  }));

  test('pageHasText matches visible text regardless of spacing and case', () => withPage('<p>Invalid   password</p>', () => {
    expect(pageHasText('invalid password')).toBe(true);
    expect(pageHasText('Welcome back')).toBe(false);
  }));
});

describe('runOne safety rules (no browser needed: they decide before any step runs)', () => {
  const base = { id: 'T-1', preconditions: 'On https://app.example.com/x', expected_result: '"Done" is shown' };

  test('a test with no automatable assertion is not run', async () => {
    const r = await runOne({ ...base, expected_result: 'It feels fast', steps: ['Click "Go"'] }, { requests: [] });
    expect(r.status).toBe('not_automatable');
  });

  test('destructive steps are skipped unless explicitly allowed', async () => {
    const r = await runOne({ ...base, steps: ['Click "Delete account"'] }, { requests: [], allowDestructive: false });
    expect(r.status).toBe('skipped');
    expect(DESTRUCTIVE_RE.test('Click "Save"')).toBe(false);
  });
});
