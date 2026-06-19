/**
 * @vitest-environment happy-dom
 *
 * Tests for DOMExtractor (dom-extractor.js) — the highest-value crawler target.
 * DOMExtractor uses module.exports of the class and reads CONFIG via a guarded
 * getConfig() (falls back to defaults when CONFIG is absent), so we require it
 * directly and let happy-dom supply document/window. Each test builds a DOM via
 * document.body.innerHTML then exercises the real extractor against it.
 */
const DOMExtractor = require('../dom-extractor.js');

function reset(html) {
  document.body.innerHTML = html;
}

afterEach(() => {
  document.body.innerHTML = '';
});

// NOTE on extractForms(): the full per-field extraction path calls
// field.closest('[data-show-when], ..., [*ngIf]'). The non-standard `[*ngIf]`
// attribute selector is tolerated by real Chrome but rejected by the happy-dom
// (and jsdom-is-broken-here) query parser, which throws inside the field .map.
// So we exercise the form-related *helper* methods directly — they carry the
// real intent/label/validation logic and do not touch that selector.
describe('DOMExtractor form helpers', () => {
  test('detectFormIntent classifies a login form by class/id text', () => {
    reset(`<form id="loginForm" class="login-box"><input type="email"><input type="password"></form>`);
    const ex = new DOMExtractor();
    expect(ex.detectFormIntent(document.querySelector('form'))).toBe('login');
  });

  test('detectFormIntent classifies registration by password + many inputs', () => {
    reset(`<form id="x"><input type="email"><input type="password"><input type="password"><input type="text"></form>`);
    const ex = new DOMExtractor();
    expect(ex.detectFormIntent(document.querySelector('form'))).toBe('registration');
  });

  test('detectFormIntent falls back to general', () => {
    reset(`<form id="x"><input type="text"></form>`);
    const ex = new DOMExtractor();
    expect(ex.detectFormIntent(document.querySelector('form'))).toBe('general');
  });

  test('getFieldLabel resolves label[for], parent label, and aria-label', () => {
    reset(`
      <label for="e">Email</label><input id="e" name="email">
      <label>Bio <textarea id="b" name="bio"></textarea></label>
      <input id="c" aria-label="Code" name="code">
    `);
    const ex = new DOMExtractor();
    expect(ex.getFieldLabel(document.getElementById('e'))).toBe('Email');
    expect(ex.getFieldLabel(document.getElementById('b'))).toContain('Bio');
    expect(ex.getFieldLabel(document.getElementById('c'))).toBe('Code');
  });

  test('getFieldValidation reports required / pattern / length constraints', () => {
    reset(`<input id="f" required pattern="[a-z]+" minlength="3" maxlength="8">`);
    const ex = new DOMExtractor();
    const v = ex.getFieldValidation(document.getElementById('f'));
    expect(v).toContain('required');
    expect(v).toContain('pattern:[a-z]+');
    expect(v).toContain('minLength:3');
    expect(v).toContain('maxLength:8');
  });

  test('getFieldFormatHints infers email format from placeholder and date from type', () => {
    reset(`<input id="e" placeholder="name@example.com"><input id="d" type="date">`);
    const ex = new DOMExtractor();
    expect(ex.getFieldFormatHints(document.getElementById('e'))).toEqual({ format: 'email' });
    expect(ex.getFieldFormatHints(document.getElementById('d'))).toEqual({ format: 'date' });
  });

  test('getFormName derives a name from a heading inside the form', () => {
    reset(`<form><h2>Contact Us</h2><input name="x"></form>`);
    const ex = new DOMExtractor();
    expect(ex.getFormName(document.querySelector('form'))).toBe('Contact Us');
  });
});

describe('DOMExtractor.extractButtons', () => {
  test('extracts buttons, dedupes by text, and detects intent', () => {
    reset(`
      <button type="button">Delete Account</button>
      <button type="button" class="btn-danger">Delete Account</button>
      <button type="button">Save</button>
      <a class="btn" href="/next">Next</a>
      <button type="submit">Submit Form</button>
    `);
    const ex = new DOMExtractor();
    const buttons = ex.extractButtons();
    const texts = buttons.map(b => b.text);

    // Submit-type button is excluded by selector; duplicate "Delete Account" deduped
    expect(texts).toEqual(['Delete Account', 'Save', 'Next']);
    const del = buttons.find(b => b.text === 'Delete Account');
    expect(del._intent.type).toBe('destructive');
    expect(del._requiresConfirmation).toBe(true);
    const save = buttons.find(b => b.text === 'Save');
    expect(save._intent.type).toBe('submit');
  });

  test('falls back to aria-label / title for unnamed buttons', () => {
    reset(`<button type="button" aria-label="Close dialog"></button>`);
    const ex = new DOMExtractor();
    const buttons = ex.extractButtons();
    expect(buttons[0].text).toBe('Close dialog');
  });
});

describe('DOMExtractor.extractTables', () => {
  test('extracts headers, row count and sortable interaction', () => {
    reset(`
      <table id="users">
        <caption>User list</caption>
        <thead><tr><th class="sortable">Name</th><th>Email</th></tr></thead>
        <tbody>
          <tr><td>Ann</td><td>a@x.com</td></tr>
          <tr><td>Bob</td><td>b@x.com</td></tr>
        </tbody>
      </table>
    `);
    const ex = new DOMExtractor();
    const tables = ex.extractTables();
    expect(tables).toHaveLength(1);
    const t = tables[0];
    expect(t.name).toBe('users');
    expect(t.columns).toEqual(['Name', 'Email']);
    expect(t.columnCount).toBe(2);
    // header row + 2 body rows are matched by 'tbody tr, tr'
    expect(t.rowCount).toBeGreaterThanOrEqual(2);
    expect(t._interactions.sortable).toBe(true);
    expect(t._a11y.caption).toBe('User list');
  });
});

describe('DOMExtractor.extractNavigation', () => {
  test('extracts nav links with text and href', () => {
    reset(`
      <nav aria-label="Main">
        <a href="/home">Home</a>
        <a href="/about">About</a>
        <a href="#"></a>
      </nav>
    `);
    const ex = new DOMExtractor();
    const navs = ex.extractNavigation();
    expect(navs).toHaveLength(1);
    expect(navs[0].name).toBe('Main');
    // empty-text link filtered out
    expect(navs[0].itemCount).toBe(2);
    expect(navs[0].items.map(i => i.text)).toEqual(['Home', 'About']);
  });
});

describe('DOMExtractor.extractLists', () => {
  test('only includes lists meeting the minimum item count', () => {
    reset(`
      <ul id="big"><li>a</li><li>b</li><li>c</li></ul>
      <ul id="small"><li>only</li></ul>
    `);
    const ex = new DOMExtractor();
    const lists = ex.extractLists();
    expect(lists).toHaveLength(1);
    expect(lists[0].name).toBe('big');
    expect(lists[0].itemCount).toBe(3);
    expect(lists[0].ordered).toBe(false);
  });
});

describe('DOMExtractor.extractErrorPatterns + categorizeError', () => {
  test('extracts error messages and categorizes them', () => {
    reset(`
      <div class="error">Email is required</div>
      <div class="alert-danger">Invalid email format</div>
      <div role="alert">Server connection failed</div>
    `);
    const ex = new DOMExtractor();
    const patterns = ex.extractErrorPatterns();
    const byMsg = Object.fromEntries(patterns.map(p => [p.message, p.type]));
    expect(byMsg['Email is required']).toBe('required');
    expect(byMsg['Invalid email format']).toBe('email-format');
    expect(byMsg['Server connection failed']).toBe('server');
  });

  test('categorizeError maps message keywords to types', () => {
    const ex = new DOMExtractor();
    expect(ex.categorizeError('Password is too weak')).toBe('password');
    expect(ex.categorizeError('Value must be unique')).toBe('uniqueness');
    expect(ex.categorizeError('Access denied')).toBe('permission');
    expect(ex.categorizeError('Something odd')).toBe('validation');
  });
});

describe('DOMExtractor.detectPageHints', () => {
  test('detects modals, lazy load and expandable content', () => {
    reset(`
      <div role="dialog" aria-label="Confirm">x</div>
      <img loading="lazy" src="a.jpg" />
      <div class="accordion">section</div>
    `);
    const ex = new DOMExtractor();
    const hints = ex.detectPageHints();
    expect(hints.hasModals).toBe(true);
    expect(hints.modalCount).toBe(1);
    expect(hints.hasLazyLoad).toBe(true);
    expect(hints.hasExpandableContent).toBe(true);
  });
});

describe('DOMExtractor.getSelector', () => {
  test('prefers id, then tag.class, then tag', () => {
    reset(`<div id="hero"></div><span class="a b c"></span><section></section>`);
    const ex = new DOMExtractor();
    expect(ex.getSelector(document.getElementById('hero'))).toBe('#hero');
    expect(ex.getSelector(document.querySelector('span'))).toBe('span.a.b');
    expect(ex.getSelector(document.querySelector('section'))).toBe('section');
  });
});

describe('DOMExtractor.extract (integration)', () => {
  // No <form> here: extractForms()'s per-field path hits the non-standard
  // [*ngIf] selector which throws under happy-dom and would abort extract().
  test('aggregates multiple non-form feature types into one array', () => {
    reset(`
      <nav aria-label="N"><a href="/a">A</a></nav>
      <button type="button">Click</button>
      <table id="t"><tr><th>H</th></tr><tr><td>v</td></tr></table>
      <ul id="l"><li>1</li><li>2</li><li>3</li></ul>
    `);
    const ex = new DOMExtractor();
    const features = ex.extract();
    const types = new Set(features.map(f => f.type));
    expect(types.has('navigation')).toBe(true);
    expect(types.has('button')).toBe(true);
    expect(types.has('table')).toBe(true);
    expect(types.has('list')).toBe(true);
    expect(Array.isArray(ex.getPageHints())).toBe(false); // pageHints is an object
    expect(typeof ex.getPageHints()).toBe('object');
  });
});
