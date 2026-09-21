/**
 * Tests for agent-tools.js propose_tests post-processing — the normalization
 * layer between raw LLM output and the acceptance gate. Uses a stubbed callAI
 * so no network/LLM is involved.
 */
const { AgentToolRegistry, parseTestArray } = require('../agent-tools.js');

function registryWithResponse(llmJson) {
  return new AgentToolRegistry({
    callAI: async () => llmJson,
    settings: {},
    ticketData: { summary: 'Chat sidebar', description: 'Sidebar lists chat sessions' },
  });
}

describe('propose_tests normalization', () => {
  test('forces the requested canonical category over a freeform LLM label', async () => {
    const reg = registryWithResponse(JSON.stringify({
      tests: [
        { title: 'Sidebar shows sessions', category: 'UI - Chat Session List', steps: ['open sidebar'], expected_result: 'list visible' },
        { title: 'Error state shown', category: 'Error Handling', steps: ['fail API'], expected_result: 'error shown' },
      ],
    }));
    const out = await reg.propose_tests({ category: 'Positive', count: 2 });
    expect(out.tests).toHaveLength(2);
    for (const t of out.tests) expect(t.category).toBe('Positive');
    // the LLM's own label is preserved for display
    expect(out.tests[0].subcategory).toBe('UI - Chat Session List');
    expect(out.tests[1].subcategory).toBe('Error Handling');
  });

  test('keeps category untouched (no subcategory) when LLM already used the canonical label', async () => {
    const reg = registryWithResponse(JSON.stringify({
      tests: [{ title: 'T', category: 'Negative', steps: ['x'], expected_result: 'y' }],
    }));
    const out = await reg.propose_tests({ category: 'Negative', count: 1 });
    expect(out.tests[0].category).toBe('Negative');
    expect(out.tests[0].subcategory).toBeUndefined();
  });

  test('fills a missing description from the title', async () => {
    const reg = registryWithResponse(JSON.stringify({
      tests: [{ title: 'Active session is highlighted', steps: ['open'], expected_result: 'highlighted' }],
    }));
    const out = await reg.propose_tests({ category: 'Positive', count: 1 });
    expect(out.tests[0].description).toBe('Verify that Active session is highlighted');
  });

  test('does not double the "Verify that" prefix when the title already has one', async () => {
    const reg = registryWithResponse(JSON.stringify({
      tests: [{ title: 'Verify that sidebar collapses', steps: ['x'], expected_result: 'y' }],
    }));
    const out = await reg.propose_tests({ category: 'Positive', count: 1 });
    expect(out.tests[0].description).toBe('Verify that sidebar collapses');
  });

  test('stringifies an object test_data so exports never print [object Object]', async () => {
    const reg = registryWithResponse(JSON.stringify({
      tests: [{ title: 'T', steps: ['x'], expected_result: 'y', test_data: { user: 'alice', sessions: 3 } }],
    }));
    const out = await reg.propose_tests({ category: 'Edge', count: 1 });
    expect(typeof out.tests[0].test_data).toBe('string');
    expect(out.tests[0].test_data).toContain('alice');
    expect(String(out.tests[0].test_data)).not.toBe('[object Object]');
  });
});

describe('parseTestArray', () => {
  test('unwraps the {tests:[...]} object shape', () => {
    const v = parseTestArray('{"tests":[{"title":"a"}]}');
    expect(v).toHaveLength(1);
    expect(v[0].title).toBe('a');
  });
});

describe('F09 — retrieved evidence reaches the generator', () => {
  // A graph whose ticket-relevant page sits well past the first fixed slice.
  const manyPages = Array.from({ length: 40 }, (_, i) => ({
    url: `https://app.example.com/filler/${i}`,
    title: `Filler ${i}`,
    features: [
      { type: 'form', selector: `#f${i}`, inputs: [{ name: `fillerField${i}` }] },
      { type: 'button', text: `Filler action ${i}` }
    ],
    apis: [{ method: 'GET', endpoint: `/api/filler/${i}` }]
  }));
  const targetPage = {
    url: 'https://app.example.com/invoices/export',
    title: 'Export invoices',
    features: [
      { type: 'form', selector: '#export-form', inputs: [{ name: 'exportFormat' }] },
      { type: 'button', text: 'Download CSV' }
    ],
    apis: [{ method: 'POST', endpoint: '/api/invoices/export' }]
  };
  const KG = { pages: [...manyPages, targetPage] };

  const makeRegistry = (extra = {}) => new AgentToolRegistry({
    knowledgeGraph: KG,
    ticketData: { summary: 'Export invoices to CSV' },
    verifierIndex: new (require('../grounded-verifier.js').GroundedVerifier)(KG).index,
    ...extra
  });

  test('a retrieved page outranks the arbitrary first-N slice', async () => {
    const reg = makeRegistry();
    await reg.execute('bm25_search', { query: 'export invoices csv' });
    const ctx = reg.groundingContext();
    // Pre-fix: the generator got the first 40 fields / 30 buttons in index order,
    // so the page retrieval had just found for it might not appear at all.
    expect(ctx).toContain('exportformat');
    expect(ctx).toContain('download csv');
    expect(ctx).toContain('MOST RELEVANT PAGES');
    expect(ctx).toContain('/invoices/export');
  });

  test('retrieval results are retained, not just summarised into one observation', async () => {
    const reg = makeRegistry();
    await reg.execute('bm25_search', { query: 'export invoices csv' });
    expect(reg.evidence.pages.size).toBeGreaterThan(0);
    const entry = [...reg.evidence.pages.values()][0];
    expect(entry.url).toBeTruthy();
    expect(entry.retrievedAt).toBeGreaterThan(0);
  });

  test('a document fetched by the planner reaches proposal generation', async () => {
    let seenPrompt = '';
    const reg = makeRegistry({
      confluenceFetch: async () => 'SPEC: Exports above 100 MB must be queued and emailed, not downloaded inline.',
      settings: {},
      callAI: async (system, content) => { seenPrompt = content[0].text; return JSON.stringify({ tests: [] }); }
    });
    await reg.execute('fetch_confluence', { url: 'https://wiki/spec' });
    await reg.execute('propose_tests', { category: 'Positive', count: 2 });
    // Pre-fix fetch_confluence returned an excerpt to the PLANNER only — the
    // generator never saw a word of it.
    expect(seenPrompt).toContain('RETRIEVED DOCUMENT EVIDENCE');
    expect(seenPrompt).toContain('must be queued and emailed');
  });

  test('a failed document fetch is distinguished from an empty document', async () => {
    const reg = makeRegistry({ confluenceFetch: async () => { throw new Error('403'); } });
    const obs = await reg.execute('fetch_confluence', { url: 'https://wiki/secret' });
    expect(obs.fetched).toBe(false);
    expect(reg.evidence.docs).toHaveLength(0);
  });
});

describe('F23 — the reviewed analysis and scope reach generation', () => {
  const KG = { pages: [{ url: 'https://app/x', title: 'X',
    features: [{ type: 'button', text: 'Submit', selector: '#s' }], apis: [] }] };

  const build = (reviewedContext) => {
    let prompt = '';
    const reg = new AgentToolRegistry({
      knowledgeGraph: KG,
      ticketData: { summary: 'Bulk upload', description: 'Users can bulk upload records.' },
      verifierIndex: new (require('../grounded-verifier.js').GroundedVerifier)(KG).index,
      reviewedContext,
      settings: {},
      callAI: async (_s, content) => { prompt = content[0].text; return JSON.stringify({ tests: [] }); }
    });
    return { reg, read: () => prompt };
  };

  test("a user's exclusion in the reviewed scope reaches the generator", async () => {
    const { reg, read } = build({
      scope: 'OUT OF SCOPE: CSV imports — handled by a separate ticket.',
      scopeReviewed: true
    });
    await reg.execute('propose_tests', { category: 'Positive', count: 2 });
    // Pre-fix currentTestScopeData was stored in the panel and never sent, so a
    // user could exclude a feature and still get tests for it.
    expect(read()).toContain('OUT OF SCOPE: CSV imports');
    expect(read()).toContain('edited by the user');
  });

  test('a clarification in the reviewed analysis reaches the generator', async () => {
    const { reg, read } = build({ analysis: 'CLARIFIED: the 100-row limit is inclusive.' });
    await reg.execute('propose_tests', { category: 'Edge', count: 2 });
    expect(read()).toContain('the 100-row limit is inclusive');
  });

  test('the ticket remains the source of truth over model-authored analysis', async () => {
    const { reg, read } = build({ analysis: 'Some inferred behaviour.' });
    await reg.execute('propose_tests', { category: 'Positive', count: 1 });
    // A proposal must not be promoted to a requirement just by passing through
    // the review panel.
    expect(read()).toMatch(/the TICKET wins/);
  });

  test('generation is unchanged when neither review step was run', async () => {
    const { reg, read } = build(null);
    await reg.execute('propose_tests', { category: 'Positive', count: 1 });
    expect(read()).not.toContain('REVIEWED INTERPRETATION');
  });
});
