/**
 * test-runner.js — "Verify in app": replay generated tests in a real browser tab.
 *
 * Grounding proves a test names real UI; this proves its steps work and its
 * expected result happens. Steps are parsed by test-steps.js (the same grammar the
 * Playwright export uses), executed in a background tab with the user's session,
 * and each test ends as passed / failed (with the failing step) / partial (passed,
 * but some steps could not be automated) / not_automatable / skipped.
 *
 * Safety: this clicks and types in a live app. It runs only on sites the user
 * already granted, and tests whose steps delete, pay, send or transfer are skipped
 * unless `allowDestructive` is set.
 *
 * Service-worker module (chrome.tabs / chrome.scripting / chrome.webRequest).
 */
(function () {

const TS = () => self.TestSteps;
const DESTRUCTIVE_RE = /\b(delete|remove|destroy|purge|wipe|pay|purchase|buy|checkout|place order|refund|transfer|send|publish|deactivate|cancel (?:subscription|account)|reset)\b/i;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Wait for the tab to finish loading, then a short settle for SPA rendering. */
async function settle(tabId, timeoutMs = 10000) {
  await sleep(300);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error('the test tab was closed');
    if (tab.status === 'complete') break;
    await sleep(200);
  }
  await sleep(400);
}

/** Runs IN THE PAGE (serialised by chrome.scripting): perform one action. */
function pageAction(action) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const find = () => {
    if (action.selector) { const el = document.querySelector(action.selector); if (el) return el; }
    const want = norm(action.target);
    if (action.kind === 'click') {
      const cands = [...document.querySelectorAll('button, a, [role=button], [role=tab], [role=menuitem], [role=link], input[type=submit], input[type=button], summary')].filter(visible);
      const label = (e) => norm(e.innerText || e.value || e.getAttribute('aria-label') || e.title);
      return cands.find(e => label(e) === want) || cands.find(e => label(e).includes(want)) || null;
    }
    for (const l of document.querySelectorAll('label')) {
      if (norm(l.textContent).includes(want)) {
        const el = l.htmlFor ? document.getElementById(l.htmlFor) : l.querySelector('input, select, textarea');
        if (el) return el;
      }
    }
    return [...document.querySelectorAll('input, select, textarea, [contenteditable=true]')].find(el =>
      [el.getAttribute('aria-label'), el.placeholder, el.name, el.id].some(v => v && norm(v).includes(want))) || null;
  };
  const el = find();
  if (!el) return { ok: false, error: `could not find "${action.target}" on the page` };
  if (el.disabled) return { ok: false, error: `"${action.target}" is disabled` };
  const setValue = (v) => { // React/Vue-compatible: use the native setter, then fire events
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set && !(el instanceof HTMLSelectElement)) setter.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  switch (action.kind) {
    case 'click': el.click(); return { ok: true };
    case 'fill':
      if (el.isContentEditable) { el.textContent = action.value; el.dispatchEvent(new Event('input', { bubbles: true })); }
      else setValue(action.value);
      return { ok: true };
    case 'select': {
      const opt = [...(el.options || [])].find(o => norm(o.text) === norm(action.value));
      if (!opt) return { ok: false, error: `option "${action.value}" is not in "${action.target}"` };
      setValue(opt.value); return { ok: true };
    }
    case 'check': case 'uncheck':
      if (el.checked !== (action.kind === 'check')) el.click();
      return { ok: true };
    default: return { ok: false, error: `unsupported action ${action.kind}` };
  }
}

/** Runs IN THE PAGE: is this text visible? */
function pageHasText(text) {
  const want = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return (document.body && document.body.innerText || '').replace(/\s+/g, ' ').toLowerCase().includes(want);
}

async function inPage(tabId, func, arg) {
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args: [arg] });
  return res && res.result;
}

const pathRegex = (path) => new RegExp('^' + String(path).split('/').map(seg => (/^(:\w+|\{[^}]+\})$/.test(seg)
  ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('/') + '$');

/** Run one test in `tabId`. `requests` is the live webRequest log for that tab. */
async function runOne(tc, { tabId, selectors, requests, allowDestructive, startUrl: defaultStart }) {
  const plan = TS().parseTestCase(tc);
  // A test that names no page starts on the page the user chose in the panel.
  if (!plan.startUrl && !plan.actions.some(a => a.kind === 'goto')) plan.startUrl = defaultStart || null;
  const id = tc.id || tc.title;
  if (plan.automation === 'none') return { id, status: 'not_automatable', reason: `no automatable assertion: ${plan.manualCheck}` };
  if (!allowDestructive && plan.actions.some(a => DESTRUCTIVE_RE.test(a.text))) {
    return { id, status: 'skipped', reason: 'a step deletes, pays, sends or transfers something; enable destructive steps to run it' };
  }
  requests.length = 0;
  const log = [];
  try {
    if (plan.startUrl) { await chrome.tabs.update(tabId, { url: plan.startUrl }); await settle(tabId); }
    for (const [i, a] of plan.actions.entries()) {
      if (a.kind === 'manual') { log.push(`step ${i + 1} skipped (manual): ${a.text}`); continue; }
      if (a.kind === 'goto') { await chrome.tabs.update(tabId, { url: a.url }); await settle(tabId); continue; }
      if (a.kind === 'fill' && a.value == null) { log.push(`step ${i + 1} skipped (needs test data): ${a.text}`); continue; }
      const res = await inPage(tabId, pageAction, { ...a, selector: selectors.get(String(a.target).toLowerCase()) || null });
      if (!res || !res.ok) return { id, status: 'failed', step: i + 1, reason: (res && res.error) || 'the step could not run', log };
      if (a.kind === 'click') await settle(tabId, 8000);
    }
    for (const as of plan.assertions) {
      if (as.kind === 'text') {
        let seen = false;
        for (let t = 0; t < 10 && !seen; t++) { seen = await inPage(tabId, pageHasText, as.value); if (!seen) await sleep(500); }
        if (!seen) return { id, status: 'failed', reason: `"${as.value}" never appeared`, log };
      } else if (as.kind === 'url') {
        const tab = await chrome.tabs.get(tabId);
        if (!new URL(tab.url).pathname.startsWith(as.path)) return { id, status: 'failed', reason: `expected to be on ${as.path}, was on ${new URL(tab.url).pathname}`, log };
      } else if (as.kind === 'api') {
        const rx = pathRegex(as.path);
        const hit = requests.find(r => r.method === as.method && rx.test(new URL(r.url).pathname));
        if (!hit) return { id, status: 'failed', reason: `${as.method} ${as.path} was never called`, log };
        if (as.status && hit.statusCode !== as.status) return { id, status: 'failed', reason: `${as.method} ${as.path} returned ${hit.statusCode}, expected ${as.status}`, log };
      }
    }
    return { id, status: log.length ? 'partial' : 'passed', log };
  } catch (e) {
    return { id, status: 'failed', reason: e.message, log };
  }
}

/**
 * Run tests sequentially in one background tab. `onProgress(i, total, result)`.
 * @returns {Promise<{results, summary}>}
 */
async function runTestsInApp(tests, { knowledgeGraph = null, allowDestructive = false, startUrl = null, onProgress = () => {}, isCancelled = () => false } = {}) {
  const firstUrl = (tests || []).map(t => TS().parseTestCase(t).startUrl || (TS().parseTestCase(t).actions.find(a => a.kind === 'goto') || {}).url).find(Boolean) || startUrl;
  if (!firstUrl) throw new Error('No start page: enter the URL of the page these tests begin on.');
  if (self.HostPermissions && !(await self.HostPermissions.hasHostAccess(firstUrl, { siblings: true }))) {
    throw new Error(`QAtalyst has no access to ${new URL(firstUrl).hostname}. Crawl it from the toolbar popup (and allow site access) first.`);
  }
  const selectors = TS().selectorIndex(knowledgeGraph);
  const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  const requests = [];
  const listener = (d) => { if (d.tabId === tab.id) requests.push({ method: d.method, url: d.url, statusCode: d.statusCode }); };
  chrome.webRequest.onCompleted.addListener(listener, { urls: ['<all_urls>'], tabId: tab.id });
  const results = [];
  try {
    for (const [i, tc] of tests.entries()) {
      if (isCancelled()) break;
      const r = await runOne(tc, { tabId: tab.id, selectors, requests, allowDestructive, startUrl });
      results.push(r);
      onProgress(i + 1, tests.length, r);
    }
  } finally {
    chrome.webRequest.onCompleted.removeListener(listener);
    chrome.tabs.remove(tab.id).catch(() => {});
  }
  const summary = {};
  for (const r of results) summary[r.status] = (summary[r.status] || 0) + 1;
  return { results, summary };
}

const api = { runTestsInApp, runOne, pageAction, pageHasText, DESTRUCTIVE_RE };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') self.TestRunner = api;
})();
