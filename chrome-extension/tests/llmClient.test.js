/**
 * Tests for llm-client.js — the non-streaming provider clients extracted from
 * background.js. Imports the real module; stubs the globals it needs at call
 * time (APP_CONFIG, token-counter functions, fetch). Verifies callAI routes to
 * the right provider and parses each provider's response shape.
 */
// Globals the module/providers read at load + call time.
global.APP_CONFIG = {
  MAX_RETRIES: 2, REQUEST_TIMEOUT: 60000, RETRY_DELAY: 1, DEFAULT_MAX_TOKENS: 4000,
};
global.checkTokenLimit = () => ({ safe: true, warning: null });
global.estimateMessagesTokens = () => 100;
global.estimateTokenCount = () => 100;
global.sleep = () => Promise.resolve();
global.parseDataUri = (u) => ({ mediaType: 'image/png', base64Data: 'x' });
global.isBedrockOpenAIModel = () => false;

const OK = (body) => Promise.resolve({
  ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body),
  headers: { get: () => null },
});

const { callAI, callOpenAI, callClaude, callGemini } = require('../llm-client.js');

afterEach(() => { delete global.fetch; });

describe('llm-client provider routing + parsing', () => {
  test('callAI → OpenAI parses choices[0].message.content', async () => {
    global.fetch = (url) => {
      expect(String(url)).toContain('api.openai.com');
      return OK({ choices: [{ message: { content: 'openai-answer' } }] });
    };
    const out = await callAI('sys', [{ type: 'text', text: 'hi' }],
      { llmProvider: 'openai', llmModel: 'gpt-4.1', apiKey: 'sk-x' });
    expect(out).toBe('openai-answer');
  });

  test('callAI → Claude parses content[0].text', async () => {
    global.fetch = (url) => {
      expect(String(url)).toContain('api.anthropic.com');
      return OK({ content: [{ text: 'claude-answer' }] });
    };
    const out = await callAI('sys', [{ type: 'text', text: 'hi' }],
      { llmProvider: 'claude', llmModel: 'claude-sonnet-4-6', apiKey: 'sk-ant-x' });
    expect(out).toBe('claude-answer');
  });

  test('callAI → Gemini parses candidates[0].content.parts[0].text', async () => {
    global.fetch = (url) => {
      expect(String(url)).toContain('generativelanguage.googleapis.com');
      return OK({ candidates: [{ content: { parts: [{ text: 'gemini-answer' }] } }] });
    };
    const out = await callAI('sys', [{ type: 'text', text: 'hi' }],
      { llmProvider: 'gemini', llmModel: 'gemini-2.0-flash', apiKey: 'AIza-x' });
    expect(out).toBe('gemini-answer');
  });

  test('callAI throws on an unsupported provider', async () => {
    await expect(callAI('s', [{ type: 'text', text: 'x' }],
      { llmProvider: 'nope', llmModel: 'm', apiKey: 'k' })).rejects.toThrow(/Unsupported|provider/i);
  });

  test('callOpenAI sends Authorization bearer + the model', async () => {
    let seen;
    global.fetch = (url, opts) => { seen = { url, opts }; return OK({ choices: [{ message: { content: 'ok' } }] }); };
    await callOpenAI('sys', [{ type: 'text', text: 'hi' }], { llmModel: 'gpt-4.1', apiKey: 'sk-secret' });
    expect(seen.opts.headers.Authorization).toBe('Bearer sk-secret');
    expect(JSON.parse(seen.opts.body).model).toBe('gpt-4.1');
  });
});
