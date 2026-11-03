/**
 * assertion-specifics.js — flag expected results that assert specifics nobody stated.
 *
 * The LLM writes expected results from the ticket. When the ticket says "an error
 * is shown", the model likes to write `"Invalid credentials (E401)" is shown and
 * the API returns 401`. That test then fails against a correct app, or worse,
 * passes review because it sounds precise. The assertion critic (LLM) is told not
 * to invent these, but a prompt is not a guarantee, so this is the deterministic
 * backstop.
 *
 * A status code, an exact quoted text or a numeric limit in `expected_result` is
 * accepted only if the ticket (description, ACs, comments, attachments, linked
 * pages) states it, or the crawl observed it (a real API status, a real UI
 * label). Otherwise the test gets a `_behaviorWarnings` entry, which the panel,
 * the "needs review" banner and the CSV export already show.
 *
 * Pure: no chrome.*, no network.
 */
(function () {

const STATUS_RE = /\b(?:status(?:\s+code)?|code|returns?|responds?(?:\s+with)?|http|with)\s*[:(]?\s*([1-5]\d\d)\b/gi;
const QUOTED_RE = /["“]([^"”]{3,120})["”]/g;
// A number is an asserted LIMIT only after a bound word ("within 2 seconds", "at most
// 100 characters", "after 5 attempts"). "All 3 rows are invited" is test data, not a limit.
const LIMIT_RE = /\b(?:within|under|less than|more than|over|at most|at least|up to|no more than|max(?:imum)?(?: of)?|min(?:imum)?(?: of)?|exceeds?|after|before|limit(?:ed)? to)\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds?|seconds?|secs?|minutes?|mins?|hours?|days?|characters?|chars?|items?|rows?|records?|attempts?|retries|times|files?|mb|kb|gb|%|percent)\b/gi;
const MAX_CORPUS = 400000;

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Every string in the ticket object, lowercased (attachments and comments included). */
function ticketCorpus(ticket) {
  const parts = [];
  let size = 0;
  const walk = (v, depth) => {
    if (size > MAX_CORPUS || depth > 6 || v == null) return;
    if (typeof v === 'string') { parts.push(v); size += v.length; return; }
    if (typeof v === 'number') { parts.push(String(v)); return; }
    if (Array.isArray(v)) { v.forEach(x => walk(x, depth + 1)); return; }
    if (typeof v === 'object') Object.values(v).forEach(x => walk(x, depth + 1));
  };
  walk(ticket, 0);
  return parts.join('\n').toLowerCase();
}

/** Status codes the crawl actually saw, and every UI label it recorded. */
function crawlEvidence(kg) {
  const statuses = new Set();
  const labels = new Set();
  const pages = kg && kg.pages ? (Array.isArray(kg.pages) ? kg.pages : Object.values(kg.pages)) : [];
  for (const p of pages) {
    for (const a of (p && p.apis) || []) {
      if (a && a.statusCode != null) statuses.add(String(a.statusCode));
    }
    for (const f of (p && p.features) || []) {
      for (const s of [f.text, f.label, f.name, f.submitText, f.ariaLabel, f.placeholder]) if (s) labels.add(norm(s));
      for (const fld of f.fields || []) {
        for (const s of [fld.label, fld.name, fld.placeholder]) if (s) labels.add(norm(s));
      }
    }
    for (const s of [p && p.title]) if (s) labels.add(norm(s));
  }
  return { statuses, labels };
}

const hasNumber = (corpus, n) => new RegExp(`(^|[^0-9.])${n.replace('.', '\\.')}([^0-9]|$)`).test(corpus);

/** Specifics in one expected result that neither the ticket nor the crawl supports. */
function unsupportedSpecifics(expected, corpus, evidence) {
  const out = [];
  const text = String(expected || '');
  for (const m of text.matchAll(STATUS_RE)) {
    const code = m[1];
    if (!hasNumber(corpus, code) && !evidence.statuses.has(code)) out.push(`status ${code}`);
  }
  for (const m of text.matchAll(QUOTED_RE)) {
    const q = m[1].trim();
    if (!corpus.includes(q.toLowerCase()) && !evidence.labels.has(norm(q))) out.push(`the exact text "${q}"`);
  }
  for (const m of text.matchAll(LIMIT_RE)) {
    if (!hasNumber(corpus, m[1])) out.push(`the value "${m[0]}"`);
  }
  return [...new Set(out)];
}

/**
 * Add a `_behaviorWarnings` entry to every test whose expected result asserts an
 * unsupported specific. Returns the tests (same objects) and how many were flagged.
 */
function flagInventedSpecifics(tests, ticket, kg) {
  const corpus = ticketCorpus(ticket);
  const evidence = crawlEvidence(kg);
  let flagged = 0;
  for (const tc of tests || []) {
    const specifics = unsupportedSpecifics(tc.expected_result || tc.expectedResult, corpus, evidence);
    if (!specifics.length) continue;
    flagged++;
    tc._inventedSpecifics = specifics;
    tc._behaviorWarnings = [...(tc._behaviorWarnings || []),
      `Expected result asserts ${specifics.join(', ')}, which the ticket does not state — confirm it or assert only what the ticket says.`];
  }
  return { tests, flagged };
}

const api = { flagInventedSpecifics, unsupportedSpecifics, ticketCorpus, crawlEvidence };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') Object.assign(self, api);
})();
