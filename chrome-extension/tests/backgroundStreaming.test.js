/**
 * @vitest-environment happy-dom
 *
 * Streaming smoke tests for the LLM stream clients. Loads the full worker in the
 * sandbox with a mocked SSE `fetch`, then drives callOpenAIStream / callAIStream
 * and asserts chunks flow through onChunk and the full text is returned. These
 * guard the streaming code across the upcoming extraction into llm-client.js.
 */
require('fake-indexeddb/auto');
const { loadScripts } = require('./helpers/load-global.js');
const { createChromeMock } = require('./helpers/chrome-mock.js');

/** Build a fetch Response whose body streams the given OpenAI-style SSE deltas. */
function openAiSse(contents) {
  const enc = new TextEncoder();
  const lines = contents.map(c => `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n`);
  lines.push('data: [DONE]\n');
  let i = 0;
  return {
    ok: true, status: 200,
    body: {
      getReader: () => ({
        read: async () => (i < lines.length
          ? { done: false, value: enc.encode(lines[i++]) }
          : { done: true, value: undefined }),
        cancel: async () => {},
      }),
    },
    json: async () => ({}),
  };
}

function boot(fetchImpl) {
  const chrome = createChromeMock();
  const { ctx } = loadScripts(['background.js'], {
    chrome, window, fetch: fetchImpl,
    extraGlobals: { indexedDB: global.indexedDB, IDBKeyRange: global.IDBKeyRange },
  });
  return ctx;
}

const OPENAI = { llmProvider: 'openai', llmModel: 'gpt-4.1', apiKey: 'sk-' + 'a'.repeat(40) };

describe('callOpenAIStream', () => {
  test('streams deltas through onChunk and returns the joined text', async () => {
    const ctx = boot((url) => {
      expect(String(url)).toMatch(/openai/i);
      return Promise.resolve(openAiSse(['Hello', ', ', 'world']));
    });
    const chunks = [];
    const full = await ctx.callOpenAIStream('sys', [{ type: 'text', text: 'hi' }], OPENAI,
      (c) => chunks.push(c), 'req-1');
    expect(chunks).toEqual(['Hello', ', ', 'world']);
    expect(full).toBe('Hello, world');
  });

  test('throws a clear error on a non-ok response', async () => {
    const ctx = boot(() => Promise.resolve({
      ok: false, status: 401, json: async () => ({ error: { message: 'bad key' } }),
    }));
    await expect(
      ctx.callOpenAIStream('sys', [{ type: 'text', text: 'hi' }], OPENAI, () => {}, 'req-2')
    ).rejects.toThrow(/bad key|401/);
  });
});

describe('callAIStream routing', () => {
  test('routes openai provider to the OpenAI streamer', async () => {
    const ctx = boot(() => Promise.resolve(openAiSse(['A', 'B'])));
    const chunks = [];
    const full = await ctx.callAIStream('sys', [{ type: 'text', text: 'hi' }], OPENAI,
      (c) => chunks.push(c), 'req-3');
    expect(chunks).toEqual(['A', 'B']);
    expect(full).toBe('AB');
  });
});
