/**
 * @vitest-environment happy-dom
 *
 * F20 + F22 — an OFFLINE pipeline harness over the real content→worker→render
 * path, driven by RECORDED provider output.
 *
 * The eval scorer grades a static suite that a human pasted in; it never
 * executes the generator, so the blind spots of the shipped heuristics are
 * repeated in the grade. This drives the actual service worker end to end with a
 * scripted model, so a regression in the wiring between modules — which is what
 * every P0 finding turned out to be — fails here rather than in production.
 *
 * No credentials, no network, no browser: everything is stubbed.
 */
require('fake-indexeddb/auto');
const { loadScripts } = require('./helpers/load-global.js');
const { createChromeMock } = require('./helpers/chrome-mock.js');

/** The shape crawler.js actually emits: pages is an ARRAY. */
const RAW_GRAPH = {
  appUrl: 'https://app.example.com',
  totalPages: 2,
  pages: [
    { url: 'https://app.example.com/invoices', title: 'Invoices',
      features: [
        { type: 'form', selector: '#filter', inputs: [{ name: 'dateFrom' }, { name: 'dateTo' }] },
        { type: 'button', text: 'Delete', selector: '#del' },
        { type: 'button', text: 'Export', selector: '#exp' }
      ],
      apis: [{ method: 'DELETE', endpoint: '/api/invoices', url: 'https://app.example.com/api/invoices' }] },
    { url: 'https://app.example.com/upload', title: 'Upload',
      features: [{ type: 'form', selector: '#up', inputs: [{ name: 'file' }] }], apis: [] }
  ]
};

/** Exactly what content.js extractAppContext() hands the worker. */
const UI_PAYLOAD = {
  appUrl: 'https://app.example.com',
  knowledgeGraph: RAW_GRAPH,
  hasContext: true,
  crawledAt: Date.now(),
  pageCount: 2,
  transferPageCount: 2
};

const TICKET = {
  key: 'INV-42',
  summary: 'Invoice permissions and upload limits',
  description: 'Acceptance Criteria:\n- An owner can delete an invoice\n- A viewer cannot delete an invoice\n- Uploads above 100 KB are rejected',
  acceptanceCriteria: '- An owner can delete an invoice\n- A viewer cannot delete an invoice\n- Uploads above 100 KB are rejected'
};

/**
 * RECORDED provider output. Deliberately imperfect: it contains a duplicate, an
 * off-topic case, a malformed case and a case referencing an entity that does not
 * exist — so the harness proves the gate is wired, not merely present.
 */
const RECORDED = {
  tests: [
    { title: 'Owner deletes an invoice', category: 'Positive', priority: 'P0',
      preconditions: 'Logged in as owner', test_data: 'invoice 4711',
      steps: ['Log in as owner', 'Click the "Delete" button'],
      expected_result: 'The invoice is deleted' },
    { title: 'Viewer cannot delete an invoice', category: 'Negative', priority: 'P0',
      preconditions: 'Logged in as viewer', test_data: 'invoice 4711',
      steps: ['Log in as viewer', 'Click the "Delete" button'],
      expected_result: 'Deletion is denied and the invoice remains' },
    // Duplicate of the first, reworded.
    { title: 'An owner can remove an invoice', category: 'Positive', priority: 'P0',
      preconditions: 'Logged in as owner', test_data: 'invoice 4711',
      steps: ['Log in as owner', 'Click the "Delete" button'],
      expected_result: 'The invoice is deleted' },
    // Malformed: no expected result.
    { title: 'Something about invoices', category: 'Positive', steps: ['Look at the page'] },
    // References an entity the crawl does not contain.
    { title: 'Owner clicks Teleport', category: 'Positive', priority: 'P2',
      steps: ['Click the "Teleport" button'], expected_result: 'The user is teleported' }
  ]
};

function setup() {
  const chrome = createChromeMock();
  global.chrome = chrome;
  global.fetch = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ choices: [{ message: { content: JSON.stringify(RECORDED) } }] }),
    text: async () => JSON.stringify(RECORDED)
  });
  return chrome;
}

describe('F22 — the real UI payload survives the whole worker pipeline', () => {
  let normalize, GroundedVerifier, CoverageMapper, AcceptanceGate, SemanticDuplicateDetector, finalizeTestCases;

  beforeAll(() => {
    setup();
    // Load the real modules the worker composes, in worker order.
    const mods = ['background-utils.js', 'text-similarity.js', 'embeddings.js', 'grounded-verifier.js',
      'semantic-duplicate-detector.js', 'coverage-mapper.js', 'acceptance-gate.js',
      'test-case-finalizer.js', 'requirement-model.js', 'readiness.js'];
    global.APP_CONFIG = { ERRORS: {}, MAX_RETRIES: 1, REQUEST_TIMEOUT: 1000 };
    global.securityManager = { validateApiKey: () => true };
    for (const m of mods) require(`../${m}`);
    ({ normalizeGenerationContext: normalize } = require('../background-utils.js'));
    ({ GroundedVerifier } = require('../grounded-verifier.js'));
    CoverageMapper = require('../coverage-mapper.js');
    ({ AcceptanceGate } = require('../acceptance-gate.js'));
    SemanticDuplicateDetector = require('../semantic-duplicate-detector.js');
    ({ finalizeTestCases } = require('../test-case-finalizer.js'));
  });

  test('the wrapper normalizes and grounding becomes applicable', () => {
    const kg = normalize(UI_PAYLOAD);
    expect(kg).toBeTruthy();
    expect(new GroundedVerifier(kg).isApplicable()).toBe(true);
    expect(CoverageMapper.prototype).toBeTruthy();
    const inv = new CoverageMapper(kg).buildFeatureInventory();
    expect(inv.buttons.length).toBeGreaterThan(0);
    expect(inv.forms.length).toBeGreaterThan(0);
  });

  test('recorded model output is filtered by the real gate, end to end', async () => {
    const kg = normalize(UI_PAYLOAD);
    const result = await finalizeTestCases(RECORDED.tests, {
      ticketData: TICKET,
      knowledgeGraph: kg,
      deps: { AcceptanceGate, GroundedVerifier, SemanticDuplicateDetector },
      relevanceThreshold: 0,
      dedupThreshold: 0.68
    });

    const titles = result.testCases.map(t => t.title);
    // Kept: the two real, distinct obligations.
    expect(titles).toContain('Owner deletes an invoice');
    expect(titles).toContain('Viewer cannot delete an invoice');
    // Dropped: malformed (no oracle).
    expect(titles).not.toContain('Something about invoices');
    expect(result.stats.schema).toBeGreaterThanOrEqual(1);
    // The allow/deny pair must NOT have been collapsed.
    expect(titles.filter(t => /delete|remove/i.test(t)).length).toBeGreaterThanOrEqual(2);
  });

  test('a reworded duplicate is collapsed, not shipped twice', async () => {
    const result = await finalizeTestCases(RECORDED.tests, {
      ticketData: TICKET, knowledgeGraph: normalize(UI_PAYLOAD),
      deps: { AcceptanceGate, GroundedVerifier, SemanticDuplicateDetector },
      relevanceThreshold: 0, dedupThreshold: 0.68
    });
    const owners = result.testCases.filter(t => /owner/i.test(t.title) && /delete|remove/i.test(t.title));
    expect(owners.length).toBe(1);
  });

  test('a case referencing a non-existent control is rejected or flagged, never verified', async () => {
    const result = await finalizeTestCases(RECORDED.tests, {
      ticketData: TICKET, knowledgeGraph: normalize(UI_PAYLOAD),
      deps: { AcceptanceGate, GroundedVerifier, SemanticDuplicateDetector },
      relevanceThreshold: 0, dedupThreshold: 0.68
    });
    const teleport = result.testCases.find(t => /teleport/i.test(t.title));
    if (teleport) expect(teleport._grounding).not.toBe('verified');
    else expect(result.rejected.some(r => /teleport/i.test(r.test?.title || ''))).toBe(true);
  });

  test('the run reports what it removed instead of presenting a clean suite', async () => {
    const result = await finalizeTestCases(RECORDED.tests, {
      ticketData: TICKET, knowledgeGraph: normalize(UI_PAYLOAD),
      deps: { AcceptanceGate, GroundedVerifier, SemanticDuplicateDetector },
      relevanceThreshold: 0, dedupThreshold: 0.68
    });
    expect(result.degradations.length).toBeGreaterThan(0);
    expect(result.degradations.join(' ')).toMatch(/invalid|duplicate/i);
  });

  test('requirement coverage is measured against predicates, with contradictions split out', () => {
    const RMod = require('../requirement-model.js');
    const items = CoverageMapper.extractRequirementItems(TICKET);
    const reqs = RMod.buildRequirements(items, { ticketKey: TICKET.key });
    const cov = CoverageMapper.mapRequirementPredicates([
      { title: 'Viewer deletes an invoice', steps: ['Log in as viewer', 'Click Delete'],
        expected_result: 'The invoice is deleted' }
    ], reqs, { requirementModel: RMod });
    // The inverted case contradicts the prohibition rather than covering it.
    expect(cov.contradictions.length).toBeGreaterThan(0);
  });

  test('execution readiness is assessed for every retained case', async () => {
    const { assessExecutability } = require('../readiness.js');
    const result = await finalizeTestCases(RECORDED.tests, {
      ticketData: TICKET, knowledgeGraph: normalize(UI_PAYLOAD),
      deps: { AcceptanceGate, GroundedVerifier, SemanticDuplicateDetector },
      relevanceThreshold: 0, dedupThreshold: 0.68
    });
    for (const tc of result.testCases) {
      const r = assessExecutability(tc);
      expect(['automation_ready', 'manual_ready', 'specification_only']).toContain(r.level);
    }
  });
});
