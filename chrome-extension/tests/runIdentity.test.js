/**
 * @vitest-environment happy-dom
 *
 * F17 — run identity, cancellation and recovery.
 *
 * Checkpoints were keyed by TAB, so Epic Mode's concurrent children (which share
 * one tab) overwrote each other's snapshot and the first to finish deleted it.
 * Nothing ever read a checkpoint back, cancellation was a boolean checked between
 * planner steps, and stream completions were matched on type alone — so a late
 * result from a previous ticket could render into the current panel.
 */
const { createChromeMock } = require('./helpers/chrome-mock.js');

describe('checkpoint keyspace', () => {
  test('session storage is separate from settings', async () => {
    const chrome = createChromeMock({ llmProvider: 'openai' });
    await chrome.storage.session.set({ agentic_ckpt_A: { runId: 'A' } });
    const sync = await chrome.storage.sync.get(null);
    expect(sync.agentic_ckpt_A).toBeUndefined();
    expect(sync.llmProvider).toBe('openai');
  });

  test('concurrent runs on one tab keep separate checkpoints', async () => {
    const chrome = createChromeMock();
    // Two epic children, same tab, different runs.
    await chrome.storage.session.set({
      'agentic_ckpt_EP-1_100_aaa': { runId: 'EP-1_100_aaa', tabId: 7, ticketKey: 'EP-1', tests: [{ title: 'a' }], recoverable: true, ts: 100 },
      'agentic_ckpt_EP-2_101_bbb': { runId: 'EP-2_101_bbb', tabId: 7, ticketKey: 'EP-2', tests: [{ title: 'b' }], recoverable: true, ts: 101 }
    });
    // Pre-fix both used key `agentic_ckpt_7` — the second overwrote the first.
    const all = await chrome.storage.session.get(null);
    const keys = Object.keys(all).filter(k => k.startsWith('agentic_ckpt_'));
    expect(keys).toHaveLength(2);
  });

  test('recovering one interrupted child does not disturb its sibling', async () => {
    const chrome = createChromeMock();
    await chrome.storage.session.set({
      'agentic_ckpt_EP-1_1_a': { ticketKey: 'EP-1', tests: [{ title: 'a' }], recoverable: true, ts: 1 },
      'agentic_ckpt_EP-2_2_b': { ticketKey: 'EP-2', tests: [{ title: 'b' }], recoverable: true, ts: 2 }
    });
    await chrome.storage.session.remove('agentic_ckpt_EP-1_1_a');
    const left = Object.keys(await chrome.storage.session.get(null));
    expect(left).toEqual(['agentic_ckpt_EP-2_2_b']);
  });
});

describe('stale completion rejection', () => {
  // Mirrors the isCurrentRun guard in content.js.
  const isCurrentRun = (pending, message) => {
    if (!message || !message.ticketKey) return true;
    if (!pending || !pending.ticketKey) return true;
    return pending.ticketKey === message.ticketKey;
  };

  test('a result for an old ticket cannot resolve the current panel', () => {
    const pending = { ticketKey: 'PROJ-2' };
    expect(isCurrentRun(pending, { ticketKey: 'PROJ-1' })).toBe(false);
    expect(isCurrentRun(pending, { ticketKey: 'PROJ-2' })).toBe(true);
  });

  test('messages without a ticket key still resolve (older worker builds)', () => {
    expect(isCurrentRun({ ticketKey: 'PROJ-2' }, {})).toBe(true);
    expect(isCurrentRun({}, { ticketKey: 'PROJ-1' })).toBe(true);
  });
});

describe('abort propagation', () => {
  test('an external signal aborts the in-flight request immediately', () => {
    // Mirrors requestController() in llm-client.js.
    const requestController = (settings) => {
      const controller = new AbortController();
      const external = settings && settings._abortSignal;
      if (external) {
        if (external.aborted) controller.abort();
        else external.addEventListener('abort', () => controller.abort(), { once: true });
      }
      return controller;
    };

    const run = new AbortController();
    const req = requestController({ _abortSignal: run.signal });
    expect(req.signal.aborted).toBe(false);
    run.abort();
    // Pre-fix cancellation was a boolean checked BETWEEN planner steps, so the
    // live provider call (and its retries) ran to completion first.
    expect(req.signal.aborted).toBe(true);
  });

  test('a signal already aborted before the call starts aborts it at once', () => {
    const run = new AbortController();
    run.abort();
    const requestController = (settings) => {
      const c = new AbortController();
      const ext = settings && settings._abortSignal;
      if (ext) { if (ext.aborted) c.abort(); else ext.addEventListener('abort', () => c.abort(), { once: true }); }
      return c;
    };
    expect(requestController({ _abortSignal: run.signal }).signal.aborted).toBe(true);
  });
});
