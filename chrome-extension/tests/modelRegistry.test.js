/**
 * Dynamic model discovery + Ollama.
 *
 * The model dropdown was a hardcoded list, which is wrong in both directions: it
 * offers models an account may not have access to (failing at generation time,
 * after the user has waited) and hides models the account does have. The provider
 * label named a model too ("OpenAI (GPT-5.2)"), which goes stale the moment a
 * newer model ships.
 */
const { discoverModels, discoverOpenAI, discoverOllama, NON_CHAT } = require('../model-registry.js');

const ok = (json) => ({ ok: true, status: 200, json: async () => json, text: async () => '' });
const fail = (status, body = '') => ({ ok: false, status, json: async () => ({}), text: async () => body });

describe('discovery reflects real access', () => {
  test('OpenAI models come from the account, not a hardcoded list', async () => {
    global.fetch = async (url, opts) => {
      expect(url).toContain('/models');
      expect(opts.headers.Authorization).toBe('Bearer sk-test');
      return ok({ data: [
        { id: 'gpt-4.1', created: 100 },
        { id: 'gpt-5.2', created: 300 },
        { id: 'ft:gpt-4.1:acme:custom', created: 200 },   // a fine-tune a list could never know
        { id: 'text-embedding-3-large', created: 400 },   // not a chat model
        { id: 'whisper-1', created: 500 }
      ] });
    };
    const r = await discoverModels('openai', { apiKey: 'sk-test' });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('discovered');
    const ids = r.models.map(m => m.id);
    expect(ids).toContain('ft:gpt-4.1:acme:custom');
    expect(ids).not.toContain('text-embedding-3-large');
    expect(ids).not.toContain('whisper-1');
    // Newest first.
    expect(ids[0]).toBe('gpt-5.2');
  });

  test('a failure falls back to the built-in list and SAYS it is a fallback', async () => {
    global.fetch = async () => fail(401, 'invalid api key');
    const fallback = [{ id: 'gpt-4.1', label: 'GPT-4.1' }];
    const r = await discoverModels('openai', { apiKey: 'bad' }, fallback);
    expect(r.ok).toBe(false);
    expect(r.source).toBe('fallback');
    expect(r.models).toEqual(fallback);
    // Silently showing a stale list as if it were real access is the bug.
    expect(r.error).toMatch(/401/);
  });

  test('no key is reported rather than producing an empty dropdown', async () => {
    const fallback = [{ id: 'gpt-4.1', label: 'GPT-4.1' }];
    const r = await discoverModels('openai', {}, fallback);
    expect(r.models).toEqual(fallback);
    expect(r.error).toMatch(/API key/i);
  });

  test('Claude discovery sends the version and browser-access headers', async () => {
    let seen = null;
    global.fetch = async (url, opts) => {
      seen = opts.headers;
      return ok({ data: [{ id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6' }] });
    };
    const r = await discoverModels('claude', { apiKey: 'sk-ant-x' });
    expect(seen['anthropic-version']).toBeTruthy();
    expect(seen['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(r.models[0].label).toBe('Claude Sonnet 4.6');
  });

  test('Gemini keeps only models that can generate content', async () => {
    global.fetch = async () => ok({ models: [
      { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', displayName: 'Embeddings', supportedGenerationMethods: ['embedContent'] }
    ] });
    const r = await discoverModels('gemini', { apiKey: 'k' });
    expect(r.models.map(m => m.id)).toEqual(['gemini-2.5-pro']);
  });
});

describe('Ollama — local models', () => {
  test('lists the tags the user has actually pulled', async () => {
    global.fetch = async (url) => {
      expect(url).toBe('http://localhost:11434/api/tags');
      return ok({ models: [
        { name: 'llama3.1:8b', details: { parameter_size: '8B' }, modified_at: '2026-01-01T00:00:00Z' },
        { name: 'qwen2.5-coder:14b', details: { parameter_size: '14B' }, modified_at: '2026-02-01T00:00:00Z' }
      ] });
    };
    const r = await discoverModels('ollama', {});
    expect(r.ok).toBe(true);
    // A hardcoded list could never have known which models are installed.
    expect(r.models.map(m => m.id)).toContain('llama3.1:8b');
    expect(r.models[0].label).toMatch(/14B|8B/);
  });

  test('a custom host is honoured', async () => {
    let seen = '';
    global.fetch = async (url) => { seen = url; return ok({ models: [{ name: 'mistral' }] }); };
    await discoverModels('ollama', { ollamaBaseUrl: 'http://192.168.1.50:11434/' });
    expect(seen).toBe('http://192.168.1.50:11434/api/tags');
  });

  test('an unreachable Ollama explains how to fix it', async () => {
    global.fetch = async () => { throw new Error('Failed to fetch'); };
    const r = await discoverModels('ollama', {});
    expect(r.error).toMatch(/ollama serve/);
    expect(r.error).toMatch(/OLLAMA_ORIGINS/);
  });

  test('a running Ollama with no models says to pull one', async () => {
    global.fetch = async () => ok({ models: [] });
    const r = await discoverModels('ollama', {});
    expect(r.error).toMatch(/ollama pull/);
  });

  test('needs no API key', async () => {
    global.fetch = async () => ok({ models: [{ name: 'llama3.1' }] });
    const r = await discoverModels('ollama', {}); // no apiKey at all
    expect(r.ok).toBe(true);
  });
});

describe('provider labels and validation', () => {
  test('the provider dropdown names providers, never models', () => {
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'options.html'), 'utf8');
    const block = html.slice(html.indexOf('id="llmProvider"'), html.indexOf('</select>', html.indexOf('id="llmProvider"')));
    // "OpenAI (GPT-5.2)" goes stale the moment a newer model ships.
    expect(block).toMatch(/<option value="openai">OpenAI<\/option>/);
    expect(block).not.toMatch(/GPT-\d/);
    expect(block).toContain('value="ollama"');
  });

  test('Ollama does not require an API key to pass settings validation', () => {
    global.APP_CONFIG = { ERRORS: { NO_PROVIDER: 'p', NO_MODEL: 'm', NO_API_KEY: 'k' } };
    global.securityManager = { validateApiKey: () => true };
    const { validateSettings } = require('../background-utils.js');
    expect(() => validateSettings({ llmProvider: 'ollama', llmModel: 'llama3.1' })).not.toThrow();
    // …but a malformed endpoint is still caught.
    expect(() => validateSettings({ llmProvider: 'ollama', llmModel: 'llama3.1', ollamaBaseUrl: 'localhost:11434' }))
      .toThrow(/http/);
  });

  test('other providers still require a key', () => {
    const { validateSettings } = require('../background-utils.js');
    expect(() => validateSettings({ llmProvider: 'openai', llmModel: 'gpt-4.1' })).toThrow();
  });
});

describe('reasoning models get the right parameters', () => {
  const { modelCapabilities, applyModelParams } = require('../model-registry.js');

  test('o-series and GPT-5 are recognised as reasoning models', () => {
    for (const m of ['o1', 'o3', 'o4-mini', 'gpt-5.2', 'gpt-5.2-mini']) {
      expect(modelCapabilities(m, 'openai').reasoning).toBe(true);
    }
  });

  test('chat models are not', () => {
    for (const m of ['gpt-4.1', 'gpt-4-turbo', 'ft:gpt-4.1:acme:x']) {
      expect(modelCapabilities(m, 'openai').reasoning).toBe(false);
    }
    expect(modelCapabilities('claude-sonnet-4-6', 'claude').reasoning).toBe(false);
    expect(modelCapabilities('llama3.1:8b', 'ollama').reasoning).toBe(false);
  });

  test('a reasoning model gets max_completion_tokens, never max_tokens', () => {
    const { body } = applyModelParams({}, { llmModel: 'o3', maxTokens: 20000 }, 'openai');
    // Sending max_tokens to an o-series model is a hard 400.
    expect(body.max_tokens).toBeUndefined();
    expect(body.max_completion_tokens).toBe(20000);
  });

  test('a chat model keeps max_tokens and temperature', () => {
    const { body } = applyModelParams({}, { llmModel: 'gpt-4.1', maxTokens: 8000, temperature: 0.3 }, 'openai');
    expect(body.max_tokens).toBe(8000);
    expect(body.temperature).toBe(0.3);
    expect(body.max_completion_tokens).toBeUndefined();
  });

  test('temperature is OMITTED for reasoning models, and the override is reported', () => {
    const { body, adjustments } = applyModelParams({}, { llmModel: 'o3', temperature: 0.2, maxTokens: 20000 }, 'openai');
    expect(body.temperature).toBeUndefined();
    // Silently ignoring the user's setting is its own bug — say so.
    expect(adjustments.join(' ')).toMatch(/reasoning model/);
  });

  test('an explicit temperature of 0 survives for chat models', () => {
    // `?? 0.7` not `|| 0.7` — 0 is a deliberate choice for structured JSON.
    const { body } = applyModelParams({}, { llmModel: 'gpt-4.1', temperature: 0, maxTokens: 4000 }, 'openai');
    expect(body.temperature).toBe(0);
  });

  test('the output budget is raised so reasoning cannot consume the whole answer', () => {
    const { body, adjustments } = applyModelParams({}, { llmModel: 'o4-mini', maxTokens: 2000 }, 'openai');
    // A 2000-token budget can be spent entirely on reasoning, returning nothing.
    expect(body.max_completion_tokens).toBeGreaterThanOrEqual(16000);
    expect(adjustments.join(' ')).toMatch(/budget raised/);
  });

  test('a generous budget is left alone', () => {
    const { body, adjustments } = applyModelParams({}, { llmModel: 'o3', maxTokens: 32000 }, 'openai');
    expect(body.max_completion_tokens).toBe(32000);
    expect(adjustments.join(' ')).not.toMatch(/budget raised/);
  });

  test('JSON mode is not requested from models that reject it', () => {
    expect(modelCapabilities('o3', 'openai').supportsJsonMode).toBe(false);
    expect(modelCapabilities('gpt-4.1', 'openai').supportsJsonMode).toBe(true);
  });
});
