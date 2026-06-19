/**
 * @vitest-environment happy-dom
 *
 * Additional DOMExtractor coverage targeting uncovered form/table/button/page-hint
 * helpers. We exercise the REAL shipped DOMExtractor against a happy-dom document.
 *
 * NOTE: extractForms()'s full per-field path calls field.closest('… [*ngIf]') which
 * happy-dom's selector parser rejects; getFieldDependencies() also uses [*ngIf].
 * We therefore build fixtures WITHOUT triggering that selector and test the form
 * helper methods directly, matching the convention in domExtractor.test.js.
 */
global.CONFIG = global.CONFIG || { get: (_k, d) => d };
const DOMExtractor = require('../dom-extractor.js');

function reset(html) {
  document.body.innerHTML = html;
}
afterEach(() => {
  document.body.innerHTML = '';
  document.title = '';
});

describe('DOMExtractor.getFieldAccessibility', () => {
  test('captures aria attributes and resolves describedby help text', () => {
    reset(`
      <span id="hint">Must be at least 8 chars</span>
      <input id="pw" aria-label="Password" aria-describedby="hint"
             aria-required="true" aria-invalid="false" role="textbox" tabindex="2">
    `);
    const ex = new DOMExtractor();
    const a11y = ex.getFieldAccessibility(document.getElementById('pw'));
    expect(a11y.ariaLabel).toBe('Password');
    expect(a11y.ariaRequired).toBe(true);
    expect(a11y.ariaInvalid).toBe('false');
    expect(a11y.role).toBe('textbox');
    expect(a11y.tabIndex).toBe(2);
    expect(a11y.helpText).toBe('Must be at least 8 chars');
  });

  test('returns an empty object for a bare field', () => {
    reset(`<input id="x">`);
    const ex = new DOMExtractor();
    expect(ex.getFieldAccessibility(document.getElementById('x'))).toEqual({});
  });
});

describe('DOMExtractor.getFieldFormatHints', () => {
  test('infers phone format from a placeholder pattern', () => {
    // Avoid a digit-run that the date rule (\d{2,}[-/]\d{2,}) would match first.
    reset(`<input id="p" placeholder="(123) ___ ____">`);
    const ex = new DOMExtractor();
    expect(ex.getFieldFormatHints(document.getElementById('p'))).toEqual({ format: 'phone' });
  });

  test('infers currency format and captures an input mask', () => {
    reset(`<input id="amt" placeholder="$0.00" data-mask="999.99">`);
    const ex = new DOMExtractor();
    const hints = ex.getFieldFormatHints(document.getElementById('amt'));
    expect(hints.format).toBe('currency');
    expect(hints.mask).toBe('999.99');
  });

  test('returns null when no hints can be inferred', () => {
    reset(`<input id="plain" type="text" placeholder="enter value">`);
    const ex = new DOMExtractor();
    expect(ex.getFieldFormatHints(document.getElementById('plain'))).toBeNull();
  });
});

describe('DOMExtractor.detectFormIntent (additional branches)', () => {
  test.each([
    [`<form class="search-bar"><input type="text"></form>`, 'search'],
    [`<form id="contactForm"><input type="text"></form>`, 'contact'],
    [`<form class="checkout"><input type="text"></form>`, 'checkout'],
    [`<form id="payment-form"><input type="text"></form>`, 'checkout'],
    [`<form class="filter-panel"><input type="text"></form>`, 'filter'],
    [`<form id="x"><input type="search"></form>`, 'search'],
    [`<form id="x"><input type="file"></form>`, 'upload'],
  ])('classifies %s as %s', (html, expected) => {
    reset(html);
    const ex = new DOMExtractor();
    expect(ex.detectFormIntent(document.querySelector('form'))).toBe(expected);
  });
});

describe('DOMExtractor.hasAsyncValidation', () => {
  test('true when a field carries an async-validate marker', () => {
    reset(`<form><input data-validate-async="true"><input type="text"></form>`);
    const ex = new DOMExtractor();
    expect(ex.hasAsyncValidation(document.querySelector('form'))).toBe(true);
  });
  test('true via the async-validate class', () => {
    reset(`<form><input class="async-validate"></form>`);
    const ex = new DOMExtractor();
    expect(ex.hasAsyncValidation(document.querySelector('form'))).toBe(true);
  });
  test('false for an ordinary form', () => {
    reset(`<form><input type="text"></form>`);
    const ex = new DOMExtractor();
    expect(ex.hasAsyncValidation(document.querySelector('form'))).toBe(false);
  });
});

describe('DOMExtractor.isMultiStepForm', () => {
  test('true when explicit step markup is present', () => {
    reset(`<form><div data-step="1">a</div><div class="wizard-step">b</div></form>`);
    const ex = new DOMExtractor();
    expect(ex.isMultiStepForm(document.querySelector('form'))).toBe(true);
  });
  test('true when both a progress bar and next/prev controls exist', () => {
    reset(`<form><div class="progress-bar"></div><button class="next-btn">Next</button></form>`);
    const ex = new DOMExtractor();
    expect(ex.isMultiStepForm(document.querySelector('form'))).toBe(true);
  });
  test('false for a single-step form', () => {
    reset(`<form><input type="text"></form>`);
    const ex = new DOMExtractor();
    expect(ex.isMultiStepForm(document.querySelector('form'))).toBe(false);
  });
});

describe('DOMExtractor.detectTableInteractions', () => {
  test('detects row selection, expandable rows and inline editing', () => {
    reset(`
      <table>
        <thead><tr><th class="sortable">Name</th></tr></thead>
        <tbody>
          <tr><td><input type="checkbox"></td><td contenteditable="true">Ann</td></tr>
          <tr aria-expanded="false"><td>Bob</td></tr>
        </tbody>
      </table>
    `);
    const ex = new DOMExtractor();
    const i = ex.detectTableInteractions(document.querySelector('table'));
    expect(i.sortable).toBe(true);
    expect(i.sortableColumns).toEqual(['Name']);
    expect(i.rowSelection).toBe(true);
    expect(i.selectionType).toBe('multiple');
    expect(i.expandableRows).toBe(true);
    expect(i.inlineEditing).toBe(true);
  });

  test('single-selection radio buttons report selectionType single', () => {
    reset(`<table><tbody><tr><td><input type="radio"></td></tr></tbody></table>`);
    const ex = new DOMExtractor();
    const i = ex.detectTableInteractions(document.querySelector('table'));
    expect(i.rowSelection).toBe(true);
    expect(i.selectionType).toBe('single');
  });

  test('returns null for a plain table with no interactions', () => {
    reset(`<table><tbody><tr><td>x</td></tr></tbody></table>`);
    const ex = new DOMExtractor();
    expect(ex.detectTableInteractions(document.querySelector('table'))).toBeNull();
  });
});

describe('DOMExtractor.getTableName / hasPagination', () => {
  test('getTableName prefers caption then a preceding heading', () => {
    reset(`<table><caption>Sales</caption><tr><td>x</td></tr></table>`);
    const ex = new DOMExtractor();
    expect(ex.getTableName(document.querySelector('table'))).toBe('Sales');
  });
  test('getTableName falls back to a preceding sibling heading', () => {
    reset(`<h3>Quarterly Report</h3><table><tr><td>x</td></tr></table>`);
    const ex = new DOMExtractor();
    expect(ex.getTableName(document.querySelector('table'))).toBe('Quarterly Report');
  });
  test('getTableName returns null when no name source exists', () => {
    reset(`<div><table><tr><td>x</td></tr></table></div>`);
    const ex = new DOMExtractor();
    expect(ex.getTableName(document.querySelector('table'))).toBeNull();
  });
  test('hasPagination detects a pagination control in the wrapper', () => {
    reset(`<div><table><tr><td>x</td></tr></table><nav class="pagination"></nav></div>`);
    const ex = new DOMExtractor();
    expect(ex.hasPagination(document.querySelector('table'))).toBe(true);
  });
  test('hasPagination is false without a pager', () => {
    reset(`<div><table><tr><td>x</td></tr></table></div>`);
    const ex = new DOMExtractor();
    expect(ex.hasPagination(document.querySelector('table'))).toBe(false);
  });
});

describe('DOMExtractor.parseButtonHandler', () => {
  test('parses an inline onclick handler and extracts the function name', () => {
    reset(`<button onclick="doSubmit(42)">Go</button>`);
    const ex = new DOMExtractor();
    const h = ex.parseButtonHandler(document.querySelector('button'));
    expect(h.type).toBe('inline');
    expect(h.onclick).toBe('doSubmit(42)');
    expect(h.functionName).toBe('doSubmit');
  });
  test('captures framework click bindings and modal triggers', () => {
    reset(`<button data-action="save" data-toggle="modal" data-target="#dlg">Open</button>`);
    const ex = new DOMExtractor();
    const h = ex.parseButtonHandler(document.querySelector('button'));
    expect(h.dataAction).toBe('save');
    expect(h.opensModal).toBe('#dlg');
    expect(h.type).toBe('modal-trigger');
  });
  test('records the associated form when the button is inside one', () => {
    reset(`<form id="signup"><button>Join</button></form>`);
    const ex = new DOMExtractor();
    const h = ex.parseButtonHandler(document.querySelector('button'));
    expect(h.associatedForm).toBe('signup');
  });
  test('returns null for a handler-less button', () => {
    reset(`<button>Plain</button>`);
    const ex = new DOMExtractor();
    expect(ex.parseButtonHandler(document.querySelector('button'))).toBeNull();
  });
});

describe('DOMExtractor.detectButtonIntent', () => {
  const cases = [
    ['Edit Profile', 'edit'],
    ['Continue', 'navigation'],
    ['Toggle Sidebar', 'toggle'],
    ['Download Report', 'export'],
    ['Upload File', 'import'],
    ['Find Users', 'search'],
  ];
  test.each(cases)('classifies "%s" intent as %s', (text, type) => {
    reset(`<button>${text}</button>`);
    const ex = new DOMExtractor();
    expect(ex.detectButtonIntent(document.querySelector('button'), text).type).toBe(type);
  });
  test('uses aria-expanded as an expand intent fallback', () => {
    reset(`<button aria-expanded="false">More</button>`);
    const ex = new DOMExtractor();
    expect(ex.detectButtonIntent(document.querySelector('button'), 'More').type).toBe('expand');
  });
  test('returns null when nothing matches', () => {
    reset(`<button>Hello world</button>`);
    const ex = new DOMExtractor();
    expect(ex.detectButtonIntent(document.querySelector('button'), 'Hello world')).toBeNull();
  });
});

describe('DOMExtractor.buttonRequiresConfirmation', () => {
  test('true for destructive text', () => {
    reset(`<button>Remove item</button>`);
    const ex = new DOMExtractor();
    expect(ex.buttonRequiresConfirmation(document.querySelector('button'))).toBe(true);
  });
  test('true via a data-confirm attribute', () => {
    reset(`<button data-confirm="Are you sure?">Proceed</button>`);
    const ex = new DOMExtractor();
    expect(ex.buttonRequiresConfirmation(document.querySelector('button'))).toBe(true);
  });
  test('true via danger styling', () => {
    reset(`<button class="btn btn-danger">Proceed</button>`);
    const ex = new DOMExtractor();
    expect(ex.buttonRequiresConfirmation(document.querySelector('button'))).toBe(true);
  });
  test('false for a neutral button', () => {
    reset(`<button class="btn">View</button>`);
    const ex = new DOMExtractor();
    expect(ex.buttonRequiresConfirmation(document.querySelector('button'))).toBe(false);
  });
});

describe('DOMExtractor.extractModals', () => {
  test('extracts a modal with title and close button', () => {
    reset(`
      <div role="dialog" id="confirm">
        <h2 class="modal-title">Confirm deletion</h2>
        <button class="close" aria-label="Close">x</button>
      </div>
    `);
    const ex = new DOMExtractor();
    const modals = ex.extractModals();
    expect(modals).toHaveLength(1);
    expect(modals[0].name).toBe('Confirm deletion');
    expect(modals[0].hasCloseButton).toBe(true);
  });
});

describe('DOMExtractor.extractCards', () => {
  test('extracts cards with titles and truncated content', () => {
    reset(`
      <div class="card"><h3>Plan A</h3><p>Cheap plan</p></div>
      <div class="panel"><h4 class="panel-title">Plan B</h4></div>
    `);
    const ex = new DOMExtractor();
    const cards = ex.extractCards();
    const names = cards.map(c => c.name);
    expect(names).toContain('Plan A');
    expect(names).toContain('Plan B');
  });
});

describe('DOMExtractor.findAssociatedField', () => {
  test('resolves via aria-describedby reference', () => {
    reset(`<input name="email" aria-describedby="err1"><span id="err1" class="error">bad</span>`);
    const ex = new DOMExtractor();
    expect(ex.findAssociatedField(document.getElementById('err1'))).toBe('email');
  });
  test('resolves via a sibling input', () => {
    reset(`<div><input name="zip"><span class="error" id="e">required</span></div>`);
    const ex = new DOMExtractor();
    expect(ex.findAssociatedField(document.getElementById('e'))).toBe('zip');
  });
  test('resolves via an enclosing form-group', () => {
    reset(`<div class="form-group"><label>City</label><input name="city"><div class="error" id="e2">bad</div></div>`);
    const ex = new DOMExtractor();
    expect(ex.findAssociatedField(document.getElementById('e2'))).toBe('city');
  });
  test('returns null when no field can be associated', () => {
    reset(`<div class="error" id="lonely">oops</div>`);
    const ex = new DOMExtractor();
    expect(ex.findAssociatedField(document.getElementById('lonely'))).toBeNull();
  });
});

describe('DOMExtractor.detectPageHints (additional signals)', () => {
  test('flags infinite scroll, dynamic content, tabs and keyboard shortcuts', () => {
    reset(`
      <div data-infinite-scroll></div>
      <div class="skeleton"></div>
      <div role="tablist"></div>
      <button accesskey="s">Save</button>
    `);
    const ex = new DOMExtractor();
    const hints = ex.detectPageHints();
    expect(hints.hasInfiniteScroll).toBe(true);
    expect(hints.hasDynamicContent).toBe(true);
    expect(hints.hasTabs).toBe(true);
    expect(hints.hasKeyboardShortcuts).toBe(true);
  });

  test('flags real-time updates and lazy-load counts', () => {
    reset(`
      <div data-live></div>
      <img loading="lazy" src="a.jpg"><img data-src="b.jpg">
    `);
    const ex = new DOMExtractor();
    const hints = ex.detectPageHints();
    expect(hints.hasRealTimeUpdates).toBe(true);
    expect(hints.hasLazyLoad).toBe(true);
    expect(hints.lazyLoadCount).toBe(2);
  });
});

describe('DOMExtractor.detectSPAFramework', () => {
  test('detects React via a data-reactroot marker', () => {
    reset(`<div data-reactroot></div>`);
    const ex = new DOMExtractor();
    expect(ex.detectSPAFramework()).toBe('react');
  });
  test('detects Angular via [ng-version]', () => {
    reset(`<div ng-version="17.0.0"></div>`);
    const ex = new DOMExtractor();
    expect(ex.detectSPAFramework()).toBe('angular');
  });
});

describe('DOMExtractor.extractTextContent', () => {
  test('extracts headings and paragraphs from the main content region', () => {
    reset(`<main><h1>Getting Started</h1><p>Welcome to the docs.</p></main>`);
    const ex = new DOMExtractor();
    const text = ex.extractTextContent(2000);
    expect(text).toContain('Getting Started');
    expect(text).toContain('Welcome to the docs.');
  });

  test('respects the maxLength budget', () => {
    reset(`<main><p>${'word '.repeat(2000)}</p></main>`);
    const ex = new DOMExtractor();
    const text = ex.extractTextContent(200);
    expect(text.length).toBeLessThan(600);
  });
});
