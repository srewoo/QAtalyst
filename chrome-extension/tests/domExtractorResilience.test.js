/**
 * @vitest-environment happy-dom
 *
 * Two defects, one visible symptom: "DOM extraction error: [object DOMException]"
 * on every page of a crawl.
 *
 *   1. `[*ngIf]` is not a valid CSS selector — an attribute name cannot begin
 *      with `*`. Angular's `*ngIf` is template syntax that never reaches the DOM.
 *      getFieldDependencies() ran it against every form field, so it threw on
 *      every page that had a form.
 *   2. extract() wrapped all TEN extraction phases in one try/catch, so that
 *      throw discarded forms, tables, buttons, navigation, modals, cards, lists,
 *      error patterns, page hints and embeds — the page reported ZERO features,
 *      and the summary log never ran, so nothing looked wrong.
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'dom-extractor.js'), 'utf8');

describe('the selector that threw', () => {
  test('every selector literal in dom-extractor.js is valid CSS', () => {
    // Pull selector strings out of querySelector*/closest/matches calls.
    // A selector may be split across lines with `+`, so capture what follows the
    // closing quote and skip concatenations rather than testing a truncated
    // fragment (which would be a false positive, not a finding).
    const calls = [...SRC.matchAll(
      /(?:querySelectorAll|querySelector|closest|matches)\(\s*(['"`])([^'"`]+)\1(\s*[+)])/g)];
    expect(calls.length).toBeGreaterThan(10); // sanity: we actually found some

    const invalid = [];
    for (const [, , selector, next] of calls) {
      if (selector.includes('${')) continue;      // runtime template literal
      if (next.trim().startsWith('+')) continue;  // concatenated: fragment only
      try { document.querySelector(selector); }
      catch (e) { invalid.push(`${selector}  →  ${e.name}`); }
    }
    expect(invalid).toEqual([]);
  });

  test('the invalid Angular selector is not passed to any DOM query', () => {
    // Scoped to real calls — the string may legitimately appear in a comment
    // explaining why it was removed.
    const selectorArgs = [...SRC.matchAll(
      /(?:querySelectorAll|querySelector|closest|matches)\(\s*(['"`])([^'"`]+)\1/g)].map(m => m[2]);
    expect(selectorArgs.some(sel => sel.includes('*ngIf'))).toBe(false);
  });

  test('it is replaced by attributes Angular actually renders', () => {
    // *ngIf is compiled away; dev builds emit ng-reflect-ng-if.
    expect(SRC).toMatch(/ng-reflect-ng-if|data-ng-if/);
  });
});

describe('one failing phase cannot discard the others', () => {
  let DOMExtractor;
  beforeAll(() => { DOMExtractor = require('../dom-extractor.js'); });

  const setupPage = () => {
    document.body.innerHTML = `
      <form id="login"><input name="email" type="email"><input name="pw" type="password">
        <button type="submit">Sign In</button></form>
      <table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>x</td></tr></tbody></table>
      <button id="export">Export</button>
      <nav><a href="/a">A</a></nav>`;
  };

  test('a throwing phase costs only its own features', () => {
    setupPage();
    const x = new DOMExtractor();
    // Break ONE phase, exactly as the bad selector used to.
    x.extractTables = () => { throw new DOMException('bad selector', 'SyntaxError'); };

    const features = x.extract();
    // Pre-fix: the throw aborted everything and this returned [].
    expect(features.length).toBeGreaterThan(0);
    expect(features.some(f => f.type === 'button')).toBe(true);
  });

  test('the failure is recorded with its phase and a readable reason', () => {
    setupPage();
    const x = new DOMExtractor();
    x.extractButtons = () => { throw new DOMException('nope', 'SyntaxError'); };
    x.extract();

    expect(x.extractionErrors).toHaveLength(1);
    expect(x.extractionErrors[0].phase).toBe('buttons');
    // "[object DOMException]" told you nothing; the name and message do.
    expect(x.extractionErrors[0].error).toMatch(/SyntaxError/);
    expect(x.extractionErrors[0].error).not.toMatch(/\[object/);
  });

  test('partial extraction is visible downstream, not silently thin', () => {
    setupPage();
    const x = new DOMExtractor();
    x.extractLists = () => { throw new Error('boom'); };
    x.extract();
    // A thin page and a page we failed to read must be distinguishable.
    expect(x.pageHints.extractionErrors).toBeTruthy();
    expect(x.pageHints.extractionErrors[0].phase).toBe('lists');
  });

  test('a clean page reports no extraction errors', () => {
    setupPage();
    const x = new DOMExtractor();
    const features = x.extract();
    expect(x.extractionErrors).toEqual([]);
    expect(features.length).toBeGreaterThan(0);
  });

  test('real form extraction survives a page with form fields', () => {
    // The original crash path: any page with a form field hit getFieldDependencies.
    setupPage();
    const x = new DOMExtractor();
    const features = x.extract();
    expect(features.some(f => f.type === 'form')).toBe(true);
    expect(x.extractionErrors).toEqual([]);
  });

  test('getFieldDependencies does not throw on an ordinary field', () => {
    setupPage();
    const x = new DOMExtractor();
    const field = document.querySelector('input[name="email"]');
    expect(() => x.getFieldDependencies(field)).not.toThrow();
  });
});
