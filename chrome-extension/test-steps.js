/**
 * test-steps.js — turn a test case's natural-language steps and expected result
 * into concrete actions and assertions.
 *
 * Shared by the Playwright exporter (playwright-export.js) and the in-app runner
 * (test-runner.js), so both automate exactly the same subset. The grammar is the
 * one the generator is told to write ("Click \"Sign In\"", "Type x in the
 * \"Email\" field", "Select \"Editor\" in the \"Role\" dropdown", full URLs,
 * "POST /api/x"). Anything else becomes a MANUAL step: it is reported, never
 * guessed, so automation coverage is honest.
 *
 * Pure: strings in, plain objects out.
 */
(function () {

const Q = '["“”]';
const NQ = '[^"“”]';
const URL_RE = /https?:\/\/[^\s"'<>)`]+/;
const SELECT_RE = new RegExp(`\\b(?:select|choose|pick)\\s+(?:the\\s+)?${Q}(${NQ}+)${Q}\\s+(?:option\\s+)?(?:in|from)\\s+the\\s+${Q}?(${NQ}+?)${Q}?\\s+(?:dropdown|select|list|menu|combobox|field)\\b`, 'i');
const CHECK_RE = new RegExp(`\\b(tick|check|select|enable|untick|uncheck|clear|disable)\\s+(?:the\\s+)?${Q}(${NQ}+)${Q}\\s+(?:checkbox|toggle|switch|option)\\b`, 'i');
const FILL_RE = new RegExp(`\\b(?:type|enter|fill(?:\\s+in)?|input|paste)\\s+(.+?)\\s+(?:in|into)\\s+the\\s+${Q}?(${NQ}+?)${Q}?\\s+(?:field|input|textbox|text box|textarea|box)\\b`, 'i');
const CLICK_RE = new RegExp(`\\b(?:click|clicks|press|tap|open|select|choose)\\s+(?:on\\s+)?(?:the\\s+)?${Q}(${NQ}+)${Q}`, 'i');
const API_RE = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s,;)"'`]*)(?:[^.]*?\b(?:returns?|responds?(?:\s+with)?|status)\s*(?:code\s*)?([1-5]\d\d))?/;
const QUOTED_RE = new RegExp(`${Q}(${NQ}{2,200})${Q}`, 'g');
const QUOTED_ONE = new RegExp(`^${Q}(${NQ}*)${Q}$`);
// Phrases in an expected result that name a page change rather than text.
const URL_PATH_RE = /\b(?:lands? on|redirect(?:s|ed)? to|navigates? to|is taken to|goes to|opens?)\s+(?:the\s+)?(\/[\w\-/]*)/i;

const clean = (s) => String(s || '').trim();

/** One step → one action. */
function parseStep(step) {
  const text = clean(step);
  let m;
  if ((m = text.match(SELECT_RE))) return { kind: 'select', value: m[1], target: clean(m[2]), text };
  if ((m = text.match(CHECK_RE))) {
    return { kind: /^(untick|uncheck|clear|disable)$/i.test(m[1]) ? 'uncheck' : 'check', target: m[2], text };
  }
  if ((m = text.match(FILL_RE))) {
    const raw = clean(m[1]);
    const lit = raw.match(QUOTED_ONE);
    return { kind: 'fill', target: clean(m[2]), value: lit ? lit[1] : null, describe: lit ? null : raw, text };
  }
  if ((m = text.match(CLICK_RE))) return { kind: 'click', target: m[1], text };
  if ((m = text.match(URL_RE)) && /\b(open|navigate|go to|visit|load|start (?:on|at)|on)\b/i.test(text)) {
    return { kind: 'goto', url: m[0].replace(/[.,]$/, ''), text };
  }
  return { kind: 'manual', text };
}

/** Expected result → assertions; unparsed remainder is kept as a manual check. */
function parseExpected(expected) {
  const text = clean(expected);
  const out = [];
  const api = text.match(API_RE);
  if (api) out.push({ kind: 'api', method: api[1], path: api[2], status: api[3] ? Number(api[3]) : null });
  const nav = text.match(URL_PATH_RE);
  if (nav) out.push({ kind: 'url', path: nav[1] });
  for (const q of text.matchAll(QUOTED_RE)) out.push({ kind: 'text', value: clean(q[1]) });
  return { assertions: out, manualCheck: text };
}

/**
 * The whole test. `startUrl` comes from the first URL in the preconditions when no
 * step navigates. `automation` is 'full' (every step and at least one assertion
 * automated), 'partial' (some), or 'none' (no assertion could be automated).
 */
function parseTestCase(tc) {
  const steps = (Array.isArray(tc.steps) ? tc.steps : String(tc.steps || '').split('\n')).map(clean).filter(Boolean);
  const actions = steps.map(parseStep);
  const pre = clean(tc.preconditions).match(URL_RE);
  const startUrl = actions.some(a => a.kind === 'goto') ? null : (pre ? pre[0].replace(/[.,]$/, '') : null);
  const exp = parseExpected(tc.expected_result || tc.expectedResult);
  const manualSteps = actions.filter(a => a.kind === 'manual').length;
  const needsData = actions.filter(a => a.kind === 'fill' && a.value == null).length;
  const automation = !exp.assertions.length ? 'none'
    : (manualSteps || needsData ? 'partial' : 'full');
  return { startUrl, actions, assertions: exp.assertions, manualCheck: exp.manualCheck, manualSteps, needsData, automation };
}

/** A crawled selector worth emitting: ids and test ids are stable, class chains are not. */
function stableSelector(sel) {
  return typeof sel === 'string' && /^(#[\w-]+|\[data-(?:testid|test-id|test|qa)=["'][^"']+["']\])$/.test(sel.trim());
}

/** label (lowercased) → stable selector, from a crawl's buttons and form fields. */
function selectorIndex(kg) {
  const idx = new Map();
  const pages = kg && kg.pages ? (Array.isArray(kg.pages) ? kg.pages : Object.values(kg.pages)) : [];
  for (const p of pages) {
    for (const f of (p && p.features) || []) {
      if (f.type === 'button' && f.text && stableSelector(f.selector)) idx.set(clean(f.text).toLowerCase(), f.selector);
      for (const fld of f.fields || f.inputs || []) {
        const key = clean(fld.label || fld.name).toLowerCase();
        if (key && stableSelector(fld.selector)) idx.set(key, fld.selector);
      }
    }
  }
  return idx;
}

const api = { parseStep, parseExpected, parseTestCase, selectorIndex, stableSelector };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') self.TestSteps = api;
})();
