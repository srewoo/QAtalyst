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
