/**
 * @vitest-environment happy-dom
 *
 * Integration tests for the background service worker (background.js).
 *
 * The whole worker is assembled in a sandbox (loadScripts honours importScripts,
 * so every real dependency module is loaded), with chrome, fetch, IndexedDB and
 * a DOM mocked. We then dispatch real messages through the registered
 * chrome.runtime.onMessage listener and assert the handler responses — exercising
 * validateSettings → callAI → response end-to-end, and the full agentic pipeline.
 */
require('fake-indexeddb/auto');
const { loadScripts } = require('./helpers/load-global.js');
const { createChromeMock } = require('./helpers/chrome-mock.js');

const OK = (body) => Promise.resolve({
  ok: true, status: 200,
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  headers: { get: () => null },
});

/**
 * Route fetch by URL. `aiContent` is what the mocked LLM "returns" as its
 * message text — set per test to drive handler behaviour.
 */
function makeFetch(getAiContent) {
  return (url, opts = {}) => {
    const u = String(url);
    if (u.includes('config.json')) return OK({});
    if (u.includes('api.openai.com/v1/chat/completions'))
      return OK({ choices: [{ message: { content: getAiContent() } }] });
    if (u.includes('api.anthropic.com'))
      return OK({ content: [{ text: getAiContent() }] });
    if (u.includes('generativelanguage.googleapis.com') && u.includes('generateContent'))
      return OK({ candidates: [{ content: { parts: [{ text: getAiContent() }] } }] });
    if (u.includes('/v1/models') || u.includes('/models?key='))
      return OK({ data: [{ id: 'gpt-4.1' }] });
    return OK({});
  };
}

function boot(aiContentRef) {
  const chrome = createChromeMock();
  const { ctx } = loadScripts(['background.js'], {
    chrome,
    window,
    fetch: makeFetch(() => aiContentRef.value),
    extraGlobals: { indexedDB: global.indexedDB, IDBKeyRange: global.IDBKeyRange },
  });
  return { chrome, ctx };
}

const OPENAI_SETTINGS = { llmProvider: 'openai', llmModel: 'gpt-4.1', apiKey: 'sk-' + 'a'.repeat(40) };

describe('background service worker — load + message routing', () => {
  test('worker loads and registers a single onMessage listener', () => {
    const { chrome } = boot({ value: '' });
    expect(chrome._messageListeners.length).toBeGreaterThanOrEqual(1);
  });
});

describe('handleAnalyzeRequirements', () => {
  test('returns the AI analysis for a valid request', async () => {
    const aiRef = { value: '## Requirements Overview\nThis feature lets users log in.' };
    const { chrome } = boot(aiRef);
    const resp = await chrome.__dispatch({
      action: 'analyzeRequirements',
      data: {
        ticketData: { key: 'PROJ-1', summary: 'Login', description: 'OAuth login' },
        settings: OPENAI_SETTINGS,
      },
    });
    const text = JSON.stringify(resp);
    expect(resp).toBeTruthy();
    expect(resp.error).toBeFalsy();
    expect(text).toContain('Requirements Overview');
  });

  test('rejects when the API key is missing/invalid', async () => {
    const { chrome } = boot({ value: 'x' });
    const resp = await chrome.__dispatch({
      action: 'analyzeRequirements',
      data: {
        ticketData: { key: 'PROJ-1', summary: 'Login' },
        settings: { llmProvider: 'openai', llmModel: 'gpt-4.1', apiKey: '' },
      },
    });
    expect(resp.error).toBeTruthy();
  });
});

describe('handleGenerateTestScope', () => {
  test('returns the AI-generated scope for a valid request', async () => {
    const aiRef = { value: '## Test Scope\n- Login happy path\n- Invalid credentials' };
    const { chrome } = boot(aiRef);
    const resp = await chrome.__dispatch({
      action: 'generateTestScope',
      data: {
        ticketData: { key: 'PROJ-1', summary: 'Login' },
        analysis: 'Login feature analysis',
        settings: OPENAI_SETTINGS,
      },
    });
    expect(resp).toBeTruthy();
    expect(resp.error).toBeFalsy();
    expect(JSON.stringify(resp)).toContain('Test Scope');
  });
});

describe('handleTestAIConnection', () => {
  test('reports success when the provider models endpoint responds OK', async () => {
    const { chrome } = boot({ value: '' });
    const resp = await chrome.__dispatch({
      action: 'testAIConnection',
      data: { provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-' + 'a'.repeat(40) },
    });
    expect(resp).toBeTruthy();
    expect(resp.error).toBeFalsy();
  });
});

describe('handleGenerateTestCasesAgentic — full pipeline end-to-end', () => {
  test('returns grounded, gated test cases from the mocked planner', async () => {
    // The planner asks the LLM for tests; return a JSON array referencing real
    // entities from the knowledge graph so they pass the grounding gate.
    const tests = [
      {
        title: 'Submit the login form with valid credentials',
        category: 'Positive', priority: 'P1',
        steps: ['Enter a value in the email field', 'Enter a value in the password field', 'Click "Sign In"'],
        expected_result: 'POST /api/login returns 200 and the user is logged in',
      },
      {
        title: 'Submit the login form with an invalid password',
        category: 'Negative', priority: 'P2',
        steps: ['Enter a value in the email field', 'Enter a wrong password', 'Click "Sign In"'],
        expected_result: 'An error message is shown',
      },
    ];
    const aiRef = { value: JSON.stringify(tests) };
    const { chrome } = boot(aiRef);

    const knowledgeGraph = {
      appUrl: 'https://app.example.com',
      pages: [{
        url: 'https://app.example.com/login', title: 'Login',
        features: [
          { type: 'form', selector: '#login', inputs: [{ name: 'email' }, { name: 'password' }] },
          { type: 'button', text: 'Sign In', selector: '#signin' },
        ],
        apis: [{ method: 'POST', endpoint: '/api/login', url: 'https://app.example.com/api/login' }],
      }],
    };

    const resp = await chrome.__dispatch({
      action: 'generateTestCasesAgentic',
      data: {
        ticketData: { key: 'PROJ-1', summary: 'User login', description: 'Login with email and password' },
        settings: { ...OPENAI_SETTINGS, enableMultiAgent: true, testCount: 8, coverageTarget: 60 },
        appContext: knowledgeGraph,
      },
    });

    expect(resp).toBeTruthy();
    expect(resp.error).toBeFalsy();
    const cases = resp.testCases || resp.tests || (resp.data && resp.data.testCases) || [];
    expect(Array.isArray(cases)).toBe(true);
    expect(cases.length).toBeGreaterThan(0);
    // Every returned test should carry a title (i.e. real gated objects).
    expect(cases.every(t => t.title && t.title.length > 0)).toBe(true);
  });
});
