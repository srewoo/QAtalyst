/**
 * Sandbox loader for QAtalyst's browser/service-worker scripts.
 *
 * Many files (background.js, security.js, rate-limiter.js, config.js, …) attach
 * their API to globals (self/globalThis/window) instead of module.exports, and
 * the service worker pulls dependencies in via importScripts(). This loader
 * builds a single shared global context with the browser globals those scripts
 * expect (chrome, fetch, crypto, TextEncoder, DOM via jsdom-if-present, …),
 * evaluates the requested files into it (honouring importScripts as
 * load-into-same-context), and returns the context so a test can read whatever
 * the scripts defined (functions, classes, the dispatched message listeners).
 *
 * Usage:
 *   const { ctx } = loadScripts(['config.js', 'security.js'], { chrome });
 *   const sm = new ctx.SecurityManager();
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const EXT_DIR = path.resolve(__dirname, '..', '..');

function loadScripts(files, opts = {}) {
  const chrome = opts.chrome || require('./chrome-mock.js').createChromeMock(opts.storage);
  const fetchImpl = opts.fetch || (() => Promise.reject(new Error('fetch not stubbed')));

  // Base globals every script may touch.
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    queueMicrotask,
    TextEncoder, TextDecoder,
    URL, URLSearchParams,
    crypto: globalThis.crypto,
    AbortController, AbortSignal,
    fetch: (...a) => sandbox.fetch_impl(...a),
    fetch_impl: fetchImpl,
    chrome,
    Date, Math, JSON, Object, Array, String, Number, Boolean, RegExp,
    Map, Set, WeakMap, WeakSet, Promise, Error, Symbol, Proxy, Reflect,
    Uint8Array, Uint16Array, Uint32Array, Int8Array, Float64Array, ArrayBuffer, DataView,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    structuredClone: (v) => JSON.parse(JSON.stringify(v)),
    importScripts: (...names) => names.forEach(loadOne),
    ...(opts.extraGlobals || {}),
  };

  // Optional DOM (when a jsdom window is supplied by the test).
  if (opts.window) {
    sandbox.window = opts.window;
    sandbox.document = opts.window.document;
    sandbox.DOMParser = opts.window.DOMParser;
    sandbox.Node = opts.window.Node;
    sandbox.navigator = opts.window.navigator;
    sandbox.location = opts.window.location;
  }

  // self/globalThis/window all alias the sandbox so global attachments land here.
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  if (!sandbox.window) sandbox.window = sandbox;

  vm.createContext(sandbox);

  const loaded = new Set();
  function loadOne(name) {
    const base = path.basename(name);
    if (loaded.has(base)) return;
    loaded.add(base);
    const full = path.join(EXT_DIR, base);
    const code = fs.readFileSync(full, 'utf8');
    vm.runInContext(code, sandbox, { filename: base });
  }

  files.forEach(loadOne);
  return { ctx: sandbox, chrome };
}

module.exports = { loadScripts, EXT_DIR };
