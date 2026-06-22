/**
 * Network Interceptor (MAIN world).
 *
 * webRequest (used by network-monitor.js) exposes request metadata + headers
 * but NOT response bodies. This script is injected into the page's MAIN world by
 * the crawler so it can wrap window.fetch and XMLHttpRequest, capture response
 * payloads (and request bodies) for API-ish calls, and stash them on
 * `window.__qatalystApiCaptures`. The crawler later drains that array and feeds
 * it to NetworkMonitor.ingestResponseBody().
 *
 * Design constraints:
 *  - Idempotent: re-injection on the same document is a no-op.
 *  - Non-destructive: responses are clone()d so the page still reads its body.
 *  - Bounded: capped count + per-body clip so it can't balloon memory.
 *  - Silent: never throws into the page; all capture work is wrapped in try/catch.
 */
(function () {
  if (window.__qatalystNetHooked) return;
  window.__qatalystNetHooked = true;

  var MAX_CAPTURES = 200;
  var MAX_BODY_CHARS = 8000; // coarse clip in-page; NetworkMonitor clips again
  var caps = (window.__qatalystApiCaptures = window.__qatalystApiCaptures || []);

  function isApiish(u) {
    try {
      var p = new URL(u, location.href).pathname.toLowerCase();
      return /\/(api|rest|graphql|ajax)\//.test(p) || /\/v\d+\//.test(p) || p.endsWith('.json');
    } catch (e) { return false; }
  }
  function clip(s) {
    return (typeof s === 'string' && s.length > MAX_BODY_CHARS) ? s.slice(0, MAX_BODY_CHARS) : s;
  }
  function parseMaybe(t) {
    if (typeof t !== 'string') return t;
    try { return JSON.parse(t); } catch (e) { return clip(t); }
  }
  function tryJson(b) {
    if (typeof b === 'string') { try { return JSON.parse(b); } catch (e) { return clip(b); } }
    return undefined;
  }
  function push(rec) { if (caps.length < MAX_CAPTURES) caps.push(rec); }

  // ── fetch ──────────────────────────────────────────────────────────────────
  if (typeof window.fetch === 'function') {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      var method = (init && init.method) || (input && input.method) || 'GET';
      var reqBody = init && init.body;
      var p = origFetch.apply(this, arguments);
      try {
        if (isApiish(url)) {
          p.then(function (resp) {
            try {
              resp.clone().text().then(function (t) {
                push({ url: url, method: method, status: resp.status, body: parseMaybe(t), requestBody: tryJson(reqBody), ts: Date.now() });
              }).catch(function () {});
            } catch (e) {}
            return resp;
          }).catch(function () {});
        }
      } catch (e) {}
      return p;
    };
  }

  // ── XMLHttpRequest ───────────────────────────────────────────────────────────
  if (typeof window.XMLHttpRequest === 'function') {
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__qaInfo = { method: method, url: url }; } catch (e) {}
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function (body) {
      var xhr = this;
      try {
        xhr.addEventListener('load', function () {
          try {
            var info = xhr.__qaInfo || {};
            if (!isApiish(info.url)) return;
            var t;
            if (xhr.responseType === '' || xhr.responseType === 'text') t = xhr.responseText;
            else t = xhr.response;
            push({ url: info.url, method: info.method || 'GET', status: xhr.status, body: parseMaybe(t), requestBody: tryJson(body), ts: Date.now() });
          } catch (e) {}
        });
      } catch (e) {}
      return origSend.apply(this, arguments);
    };
  }
})();
