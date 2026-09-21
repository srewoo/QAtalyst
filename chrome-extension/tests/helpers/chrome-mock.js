/**
 * In-memory chrome.* API mock for unit/integration tests.
 *
 * Covers the surface QAtalyst actually uses: storage.sync/local (with a real
 * in-memory keyspace), runtime messaging (onMessage listeners you can dispatch
 * to), tabs.sendMessage, and a few no-op stubs. Construct a fresh one per test
 * to keep state isolated.
 */
function createChromeMock(initialStorage = {}) {
  const sharedStore = { ...initialStorage };
  const store = sharedStore; // kept for helpers below that read the default keyspace
  const messageListeners = [];

  const area = (ownStore) => {
   const store = ownStore || sharedStore;
   return ({
    get: (keys, cb) => {
      let out;
      if (keys == null) out = { ...store };
      else if (typeof keys === 'string') out = { [keys]: store[keys] };
      else if (Array.isArray(keys)) out = Object.fromEntries(keys.map(k => [k, store[k]]));
      else { // object of defaults
        out = {};
        for (const k of Object.keys(keys)) out[k] = (k in store) ? store[k] : keys[k];
      }
      if (cb) { cb(out); return; }
      return Promise.resolve(out);
    },
    set: (obj, cb) => {
      Object.assign(store, obj);
      if (cb) { cb(); return; }
      return Promise.resolve();
    },
    remove: (keys, cb) => {
      (Array.isArray(keys) ? keys : [keys]).forEach(k => delete store[k]);
      if (cb) { cb(); return; }
      return Promise.resolve();
    },
    clear: (cb) => {
      for (const k of Object.keys(store)) delete store[k];
      if (cb) { cb(); return; }
      return Promise.resolve();
    },
   });
  };

  const makeEvent = () => ({
    _listeners: [],
    addListener(fn) { this._listeners.push(fn); },
    removeListener(fn) {
      const i = this._listeners.indexOf(fn);
      if (i >= 0) this._listeners.splice(i, 1);
    },
    hasListener(fn) { return this._listeners.includes(fn); },
  });

  const chrome = {
    _store: store,
    _messageListeners: messageListeners,
    // `session` is a real area here (F17): the worker checkpoints recoverable
    // partial suites into it, and without it those writes silently no-opped in
    // tests. Each area keeps its OWN keyspace so a session checkpoint can't be
    // mistaken for a setting.
    storage: { sync: area(), local: area(), session: area({}), onChanged: { addListener() {} } },
    runtime: {
      lastError: null,
      id: 'test-extension-id',
      getURL: (p) => `chrome-extension://test/${p}`,
      onMessage: {
        addListener: (fn) => messageListeners.push(fn),
        removeListener: (fn) => {
          const i = messageListeners.indexOf(fn);
          if (i >= 0) messageListeners.splice(i, 1);
        },
      },
      onInstalled: { addListener() {} },
      sendMessage: (msg, cb) => { if (cb) cb(undefined); return Promise.resolve(undefined); },
    },
    tabs: {
      query: (_q, cb) => { const r = []; if (cb) { cb(r); return; } return Promise.resolve(r); },
      sendMessage: (_id, _msg, cb) => { if (cb) cb(undefined); return Promise.resolve(undefined); },
      create: (_o, cb) => { const t = { id: 1 }; if (cb) { cb(t); return; } return Promise.resolve(t); },
    },
    action: { onClicked: { addListener() {} } },
    notifications: { create() {}, clear() {} },
    declarativeNetRequest: { updateDynamicRules: () => Promise.resolve() },
    // webRequest events TRACK their listeners (F18). No-op add/remove made a
    // listener-leak test pass vacuously — the very bug it was meant to catch was
    // invisible to it.
    webRequest: {
      onBeforeRequest: makeEvent(),
      onCompleted: makeEvent(),
      onErrorOccurred: makeEvent(),
    },
  };

  /**
   * Dispatch a message to every registered onMessage listener and resolve with
   * the first sendResponse value (supports async listeners that `return true`).
   */
  chrome.__dispatch = (message, sender = { tab: { id: 1 } }) =>
    new Promise((resolve) => {
      let settled = false;
      const sendResponse = (resp) => { if (!settled) { settled = true; resolve(resp); } };
      let keptOpen = false;
      for (const fn of messageListeners) {
        const ret = fn(message, sender, sendResponse);
        if (ret === true) keptOpen = true;
      }
      if (!keptOpen && !settled) resolve(undefined);
    });

  return chrome;
}

module.exports = { createChromeMock };
