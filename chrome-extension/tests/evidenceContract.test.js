/**
 * Production-shaped evidence-contract tests (fix2.md §10 regression matrix).
 *
 * These assert the CONTRACT between the content script, the worker and the
 * quality modules — not the internals of a heuristic. Each one fails against the
 * pre-F01/F02/F06 code:
 *   F01 — the UI sends a wrapper; generation read it as a graph → empty index.
 *   F02 — pages are an array; transfer looked them up by URL → zero pages.
 *   F06 — an unresolvable reference was stamped 'verified'.
 */
global.APP_CONFIG = { ERRORS: { NO_PROVIDER: 'p', NO_MODEL: 'm', NO_API_KEY: 'k' } };
global.securityManager = { validateApiKey: () => true };

const { pagesByUrl, normalizeGenerationContext, countKgEntities } = require('../background-utils.js');
const { GroundedVerifier } = require('../grounded-verifier.js');
const { AcceptanceGate } = require('../acceptance-gate.js');
const SemanticDuplicateDetector = require('../semantic-duplicate-detector.js');
const GraphFilter = require('../graph-filter.js');
const CoverageMapper = require('../coverage-mapper.js');

/** The shape crawler.js buildKnowledgeGraph() actually emits: pages is an ARRAY. */
const RAW_GRAPH = {
  appUrl: 'https://app.example.com',
  totalPages: 1,
  pages: [{
    url: 'https://app.example.com/login',
    title: 'Login',
    textContent: 'Sign in to your account',
    features: [
      { type: 'form', selector: '#login-form', inputs: [{ name: 'email' }, { name: 'password' }] },
      { type: 'button', text: 'Login', selector: '#login-btn' }
    ],
    apis: [{ method: 'POST', endpoint: '/api/auth/login', url: 'https://app.example.com/api/auth/login' }]
  }]
};

/** Exactly what content.js extractAppContext() hands to the worker. */
const UI_WRAPPER = {
  appUrl: 'https://app.example.com',
  knowledgeGraph: RAW_GRAPH,
  hasContext: true,
  crawledAt: Date.now(),
  pageCount: 1,
  transferPageCount: 1,
  stale: true,
  stalenessDays: 40,
  staleAfterDays: 14
};

describe('F01 — the worker normalizes the ACTUAL UI payload', () => {
  test('the wrapper yields a groundable graph, not an empty one', () => {
    const kg = normalizeGenerationContext(UI_WRAPPER);
    expect(kg).toBeTruthy();
    // Pre-fix: the wrapper was used as-is, so entity count was 0.
    expect(countKgEntities(kg)).toBeGreaterThan(0);
    expect(new GroundedVerifier(kg).isApplicable()).toBe(true);
  });

  test('coverage inventory built from the wrapper is non-empty', () => {
    const kg = normalizeGenerationContext(UI_WRAPPER);
    const inv = new CoverageMapper(kg).buildFeatureInventory();
    expect(inv.pages.length).toBeGreaterThan(0);
    expect(inv.buttons.length + inv.forms.length).toBeGreaterThan(0);
  });

  test('staleness / relevance flags survive to the canonical context', () => {
    const kg = normalizeGenerationContext(UI_WRAPPER);
    expect(kg.stale).toBe(true);
    expect(kg.stalenessDays).toBe(40);
    expect(kg.staleAfterDays).toBe(14);
  });

  test('an empty wrapper normalizes to null so "no crawl" still degrades', () => {
    expect(normalizeGenerationContext({ appUrl: 'x', knowledgeGraph: { pages: [] }, hasContext: true })).toBeNull();
    expect(normalizeGenerationContext(null)).toBeNull();
  });

  test('a raw graph passed directly is still accepted (both shapes)', () => {
    const kg = normalizeGenerationContext(RAW_GRAPH);
    expect(new GroundedVerifier(kg).isApplicable()).toBe(true);
  });
});

describe('F02 — array and map graphs retrieve equivalently', () => {
  const makePages = (n) => Array.from({ length: n }, (_, i) => ({
    url: `https://app.example.com/invoice/${i}`,
    title: `Invoice ${i}`,
    features: [{ type: 'button', text: `Export invoice ${i}`, selector: `#exp-${i}` }],
    apis: []
  }));

  test.each([29, 30, 31])('%i pages: URL lookup survives normalization', (n) => {
    const arr = makePages(n);
    const byUrl = pagesByUrl(arr);
    expect(Object.keys(byUrl)).toHaveLength(n);
    // The exact operation crawler-handlers performs on every BM25 hit.
    // Pre-fix this was `array[url]` → undefined for all n, i.e. zero transfer.
    for (const p of arr) expect(byUrl[p.url]).toBeDefined();
  });

  test('array and map graphs produce the same entity index', () => {
    const arr = makePages(31);
    const a = new GroundedVerifier(normalizeGenerationContext({ pages: arr })).index;
    const b = new GroundedVerifier(normalizeGenerationContext({ pages: pagesByUrl(arr) })).index;
    expect([...a.buttons].sort()).toEqual([...b.buttons].sort());
    expect([...a.routes].sort()).toEqual([...b.routes].sort());
  });

  test('a button-only feature survives transfer stripping', () => {
    const stripped = GraphFilter.stripPageData(RAW_GRAPH.pages[0]);
    // Pre-fix: only type==='form' features were kept and url/title were read off
    // a non-existent `page.metadata`, so the page arrived anonymous and button-less.
    expect(stripped.url).toBe('https://app.example.com/login');
    expect(stripped.title).toBe('Login');
    const kinds = stripped.features.map(f => f.type);
    expect(kinds).toContain('button');
    expect(kinds).toContain('form');
  });

  test('stripped pages are still groundable', () => {
    const kg = normalizeGenerationContext({ pages: RAW_GRAPH.pages.map(p => GraphFilter.stripPageData(p)) });
    const v = new GroundedVerifier(kg);
    expect(v.isApplicable()).toBe(true);
    expect(v.index.buttons.has('login')).toBe(true);
  });
});

describe('F06 — an unresolved reference is never "verified"', () => {
  const kg = normalizeGenerationContext(RAW_GRAPH);
  const mixedTest = {
    title: 'Login and launch',
    steps: ['Click the "Login" button', 'Click the "Launch Rocket" button'],
    expected_result: 'User is signed in'
  };

  test('verify() does not claim a repair it does not have', () => {
    const g = new GroundedVerifier(kg).verify(mixedTest);
    expect(g.verdict).not.toBe('grounded');
    if (g.issues.length) {
      expect(g.fullyResolved).toBe(false);
      // Pre-fix this was 'needs_repair' with repairs === {}.
      expect(g.verdict === 'unresolved' || g.verdict === 'reject').toBe(true);
    }
  });

  test('the gate flags it unresolved rather than verified', () => {
    const gate = new AcceptanceGate({
      knowledgeGraph: kg,
      ticketData: { summary: 'Login', description: 'User can log in and launch a rocket' },
      deps: { GroundedVerifier, SemanticDuplicateDetector },
      relevanceThreshold: 0
    });
    const { accepted } = gate.admit([mixedTest]);
    for (const t of accepted) expect(t._grounding).not.toBe('verified');
  });

  test('a fully grounded test is still verified', () => {
    const gate = new AcceptanceGate({
      knowledgeGraph: kg,
      ticketData: { summary: 'Login', description: 'User signs in with email and password' },
      deps: { GroundedVerifier, SemanticDuplicateDetector },
      relevanceThreshold: 0
    });
    const { accepted } = gate.admit([{
      title: 'Successful login',
      steps: ['Enter email', 'Enter password', 'Click the "Login" button'],
      expected_result: 'User reaches the dashboard'
    }]);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]._grounding).toBe('verified');
  });
});

describe('F07 — an inverted assertion does not cover an AC', () => {
  const AC = ['Viewer cannot delete invoices'];

  test('the contradicting test scores no coverage', () => {
    const r = CoverageMapper.mapAcceptanceCriteria([{
      title: 'Viewer can delete invoices',
      steps: ['Log in as Viewer', 'Delete an invoice'],
      expected_result: 'The invoice is deleted'
    }], AC);
    // Pre-fix: token recall 0.75 → reported 100% covered by its own inversion.
    expect(r.covered).toBe(0);
    expect(r.percentage).toBe(0);
    expect(r.details[0].matchType).toBe('contradicted');
    expect(r.contradictions).toHaveLength(1);
  });

  test('a test asserting the denial does cover it', () => {
    const r = CoverageMapper.mapAcceptanceCriteria([{
      title: 'Viewer cannot delete invoices',
      steps: ['Log in as Viewer', 'Attempt to delete an invoice'],
      expected_result: 'Deletion is denied and the invoice remains'
    }], AC);
    expect(r.covered).toBe(1);
    expect(r.contradictions).toHaveLength(0);
  });

  test('positive ACs are unaffected', () => {
    const r = CoverageMapper.mapAcceptanceCriteria([{
      title: 'Admin can delete invoices',
      steps: ['Log in as Admin', 'Delete an invoice'],
      expected_result: 'The invoice is deleted'
    }], ['Admin can delete invoices']);
    expect(r.covered).toBe(1);
  });
});

describe('F05 — proven distinctions are never merged away', () => {
  const kg = normalizeGenerationContext(RAW_GRAPH);
  const gateFor = (ticket) => new AcceptanceGate({
    knowledgeGraph: null, // grounding not under test here
    ticketData: ticket,
    deps: { GroundedVerifier, SemanticDuplicateDetector },
    relevanceThreshold: 0,
    dedupThreshold: 0.68
  });

  // The three pairs fix2.md §F05 reproduced as false merges at the 0.68 gate.
  const PAIRS = [
    ['export vs archive (0.75)', { summary: 'Invoices' }, [
      { title: 'Export invoices', steps: ['Click the "Export" button'], expected_result: 'Invoices are exported to CSV' },
      { title: 'Archive invoices', steps: ['Click the "Archive" button'], expected_result: 'Invoices are archived' }
    ]],
    ['sparse unrelated cases (0.85)', { summary: 'Billing' }, [
      { title: 'Update billing address', steps: [], expected_result: '' },
      { title: 'Delete saved payment card', steps: [], expected_result: '' }
    ]],
    ['boundary partitions (0.90)', { summary: 'Upload' }, [
      { title: 'Upload respects the size limit', steps: ['Upload a 100 KB file'], expected_result: 'Upload succeeds' },
      { title: 'Upload respects the size limit', steps: ['Upload a 999 KB file'], expected_result: 'Upload is rejected' }
    ]]
  ];

  test.each(PAIRS)('%s — both cases survive', (_label, ticket, cases) => {
    const r = gateFor(ticket).admit(cases);
    expect(r.accepted).toHaveLength(2);
  });

  test('a near-duplicate kept apart by a distinction is recorded for review', () => {
    const r = gateFor({ summary: 'Invoices' }).admit(PAIRS[0][2]);
    // Export vs archive still SCORES as a near-duplicate; it is the distinction
    // check, not a lower score, that keeps both — and the decision is auditable.
    expect(r.preservedDistinctions).toHaveLength(1);
    expect(r.preservedDistinctions[0].reason).toMatch(/different operations/);
  });

  test('allow vs deny on the same operation is preserved', () => {
    const r = gateFor({ summary: 'Permissions' }).admit([
      { title: 'Owner can delete the invoice', steps: ['Click Delete'], expected_result: 'The invoice is deleted' },
      { title: 'Viewer cannot delete the invoice', steps: ['Click Delete'], expected_result: 'Deletion is denied' }
    ]);
    expect(r.accepted).toHaveLength(2);
  });

  test('a true paraphrase of the same behaviour IS still collapsed', () => {
    const r = gateFor({ summary: 'Login' }).admit([
      { title: 'User logs in successfully', category: 'Functional',
        steps: ['Enter valid email', 'Enter valid password', 'Click the "Login" button'],
        expected_result: 'Login succeeds and the dashboard is displayed' },
      { title: 'Successful user login', category: 'Functional',
        steps: ['Enter valid email', 'Enter valid password', 'Click the "Login" button'],
        expected_result: 'Login succeeds and the dashboard is displayed' }
    ]);
    expect(r.accepted).toHaveLength(1);
  });

  test('missing information no longer inflates similarity', () => {
    const d = new SemanticDuplicateDetector();
    const sparseA = { title: 'Update billing address' };
    const sparseB = { title: 'Delete saved payment card' };
    // Pre-fix: empty steps scored actions 1.0 and all-false outcomes scored 1.0.
    expect(d.calculateSemanticSimilarity(sparseA, sparseB)).toBeLessThan(0.68);
  });
});

describe('F08 — ticket-only coverage feedback survives', () => {
  const { AgentToolRegistry } = require('../agent-tools.js');

  test('a no-graph run still reports uncovered acceptance criteria', async () => {
    const accepted = [{ title: 'Admin can delete invoices', steps: ['Delete'], expected_result: 'Deleted' }];
    const tools = new AgentToolRegistry({
      knowledgeGraph: null,
      coverageMapper: null,
      CoverageMapper,
      ticketData: {
        summary: 'Invoice permissions',
        acceptanceCriteria: '- Admin can delete invoices\n- Viewer cannot delete invoices'
      },
      getAcceptedTests: () => accepted
    });
    const obs = await tools.execute('run_coverage_check', {});
    // Feature coverage is unmeasurable without a crawl...
    expect(obs.applicable).toBe(false);
    // ...but requirement coverage is measured from the ticket and must survive.
    expect(obs.acCoverage.applicable).toBe(true);
    expect(obs.acCoverage.covered).toBeLessThan(obs.acCoverage.total);
    expect(obs.criticalGaps.length).toBeGreaterThan(0);
  });
});

describe('F08 — the planner keeps ticket-only coverage observations', () => {
  const { usableCoverage } = require('../agent-loop.js');

  test('an observation with AC coverage is retained even when features are not measurable', () => {
    // Pre-fix both call sites dropped ANY observation with applicable:false,
    // so lastCoverage stayed null and the uncovered AC was never fed back.
    expect(usableCoverage({ applicable: false, acCoverage: { applicable: true, covered: 1, total: 2 } })).toBe(true);
    expect(usableCoverage({ applicable: true })).toBe(true);
    expect(usableCoverage({ applicable: false, acCoverage: { applicable: false } })).toBe(false);
    expect(usableCoverage(null)).toBe(false);
  });
});

describe('F16 — feature coverage preserves page and operation identity', () => {
  // Two pages, each with its OWN "Save" button, and one path with two methods.
  const KG = normalizeGenerationContext({
    appUrl: 'https://app.example.com',
    pages: [
      { url: 'https://app.example.com/billing', title: 'Billing',
        features: [{ type: 'button', text: 'Save', selector: '#billing-save' }],
        apis: [
          { method: 'GET', endpoint: '/api/invoices', url: 'https://app.example.com/api/invoices' },
          { method: 'DELETE', endpoint: '/api/invoices', url: 'https://app.example.com/api/invoices' }
        ] },
      { url: 'https://app.example.com/profile', title: 'Profile',
        features: [{ type: 'button', text: 'Save', selector: '#profile-save' }], apis: [] }
    ]
  });

  const covered = (cov, kind) => cov[kind].details.filter(d => d.covered);

  test('clicking Save on billing does not mark profile Save covered', () => {
    const cov = new CoverageMapper(KG).mapCoverage([{
      title: 'Save billing details',
      steps: ['Navigate to https://app.example.com/billing', 'Click the Save button'],
      expected_result: 'The billing details are saved'
    }]);
    const saves = covered(cov, 'buttons');
    // Pre-fix: marking did .find(b => b.text === 'Save') — the first Save in the
    // inventory, whichever page it belonged to.
    expect(saves.length).toBeLessThanOrEqual(1);
    if (saves.length) expect(saves[0].url).toContain('/billing');
  });

  test('a GET does not cover DELETE on the same path', () => {
    const cov = new CoverageMapper(KG).mapCoverage([{
      title: 'List invoices',
      steps: ['Send a GET request to /api/invoices'],
      expected_result: 'The response returns the invoice list'
    }]);
    const apis = covered(cov, 'apis');
    expect(apis.some(a => a.method === 'DELETE')).toBe(false);
  });

  test('mentioning one control while acting on another does not count as exercising it', () => {
    const cov = new CoverageMapper(KG).mapCoverage([{
      title: 'Export flow',
      steps: ['Click the Export button'],
      // "Save" appears only as a noun in the outcome — nothing was clicked.
      expected_result: 'The export completes without needing to Save'
    }]);
    // Pre-fix: BTN_ACTION matched "Click" from the step and "Save" from the
    // expected result in one joined blob, crediting Save as exercised.
    expect(covered(cov, 'buttons').some(b => b.text === 'Save')).toBe(false);
  });

  test('entityKey distinguishes same-label entities on different pages', () => {
    const a = CoverageMapper.entityKey('button', { text: 'Save', url: 'https://app/billing' });
    const b = CoverageMapper.entityKey('button', { text: 'Save', url: 'https://app/profile' });
    expect(a).not.toBe(b);
    expect(CoverageMapper.entityKey('api', { method: 'GET', endpoint: '/x' }))
      .not.toBe(CoverageMapper.entityKey('api', { method: 'DELETE', endpoint: '/x' }));
  });
});

describe('F10 — ticket relevance is not decided by the crawl', () => {
  // The app has a login feature AND an unrelated invoice-export feature.
  const KG = normalizeGenerationContext({
    pages: [
      { url: 'https://app.example.com/login', title: 'Login',
        features: [{ type: 'form', selector: '#lf', inputs: [{ name: 'email' }, { name: 'password' }] },
                   { type: 'button', text: 'Sign In', selector: '#si' }], apis: [] },
      { url: 'https://app.example.com/invoices', title: 'Invoices',
        features: [{ type: 'button', text: 'Export invoices', selector: '#exp' }], apis: [] }
    ]
  });
  const TICKET = { summary: 'Add password reset to the login screen',
    description: 'Users who forgot their password can request a reset email from the login screen.' };

  const gate = () => new AcceptanceGate({
    knowledgeGraph: KG, ticketData: TICKET,
    deps: { GroundedVerifier, SemanticDuplicateDetector }
  });

  test('a real but unrelated app feature is classified app_only, not ticket-relevant', () => {
    const g = gate();
    const basis = g.classifyRelevance({
      title: 'Export invoices to CSV',
      steps: ['Click the "Export invoices" button'],
      expected_result: 'A CSV file is downloaded'
    });
    // Pre-fix the app's own button labels were IN the ticket relevance
    // vocabulary, so the crawl effectively voted this test into scope.
    expect(basis).toBe('app_only');
  });

  test('a test about the ticket is classified direct', () => {
    expect(gate().classifyRelevance({
      title: 'Request a password reset from the login screen',
      steps: ['Open the login screen', 'Click Forgot password'],
      expected_result: 'A reset email is sent'
    })).toBe('direct');
  });

  test('app entity names alone no longer enter the ticket vocabulary', () => {
    const g = gate();
    expect(g.referenceVocab.has('invoices')).toBe(false);
    expect(g.appVocab.size).toBeGreaterThan(0);
  });

  test('the reference vector honours the configured ticket weights', () => {
    const g = gate();
    const text = g.weightedReferenceText(g.referenceVocab);
    const count = (t) => (text.match(new RegExp(`\\b${t}\\b`, 'g')) || []).length;
    // Summary terms carry weight 1.0, description terms 0.7 — the old vector was
    // built from the bare key list, so every term counted the same.
    const summaryTerm = [...g.referenceVocab.entries()].find(([, w]) => w === 1.0);
    const descTerm = [...g.referenceVocab.entries()].find(([, w]) => w < 1.0);
    if (summaryTerm && descTerm) {
      expect(count(summaryTerm[0])).toBeGreaterThan(count(descTerm[0]));
    }
  });
});

describe('F06 / §10 row 8 — a new feature is not an invented one', () => {
  // The crawl is of the CURRENT build; the ticket describes the NEXT one.
  const KG = normalizeGenerationContext({
    pages: [{ url: 'https://app/editor', title: 'Editor',
      features: [{ type: 'button', text: 'Save', selector: '#save' }], apis: [] }]
  });
  const TICKET = {
    summary: 'Add a Publish button to the article editor',
    description: 'Editors can click the "Publish" button to make an article live.',
    acceptanceCriteria: '- Clicking "Publish" makes the article live'
  };

  test('a control the ticket requires but the crawl lacks is specification-level, not rejected', () => {
    const g = new GroundedVerifier(KG, { ticketData: TICKET }).verify({
      title: 'Publish an article',
      steps: ['Open the editor', 'Click the "Publish" button'],
      expected_result: 'The article is live'
    });
    // Pre-fix this was rejected as a hallucination — on the most common kind of
    // ticket there is, and precisely when the crawl was richest.
    expect(g.verdict).toBe('specification');
    expect(g.pendingImplementation.join(' ')).toMatch(/not implemented yet/);
  });

  test('a control nothing asks for is still rejected', () => {
    const g = new GroundedVerifier(KG, { ticketData: TICKET }).verify({
      title: 'Teleport the article',
      steps: ['Click the "Teleport" button'],
      expected_result: 'The article is teleported'
    });
    expect(g.verdict).toBe('reject');
  });

  test('the gate admits it with an explicit implementation status', () => {
    const gate = new AcceptanceGate({
      knowledgeGraph: KG, ticketData: TICKET,
      deps: { GroundedVerifier, SemanticDuplicateDetector }, relevanceThreshold: 0
    });
    const { accepted } = gate.admit([{
      title: 'Publish an article',
      steps: ['Open the editor', 'Click the "Publish" button'],
      expected_result: 'The article is live'
    }]);
    expect(accepted).toHaveLength(1);
    // Neither "verified against the app" nor discarded.
    expect(accepted[0]._grounding).toBe('specification');
    expect(accepted[0]._pendingImplementation).toBeTruthy();
  });

  test('an already-built control is still verified, not downgraded', () => {
    const gate = new AcceptanceGate({
      knowledgeGraph: KG, ticketData: TICKET,
      deps: { GroundedVerifier, SemanticDuplicateDetector }, relevanceThreshold: 0
    });
    const { accepted } = gate.admit([{
      title: 'Save a draft',
      steps: ['Click the "Save" button'],
      expected_result: 'The draft is saved'
    }]);
    expect(accepted[0]._grounding).toBe('verified');
  });

  test('a ticket-required API endpoint is treated the same way', () => {
    const g = new GroundedVerifier(KG, {
      ticketData: { summary: 'Add publishing', description: 'POST /api/articles/publish makes it live.' }
    }).verify({
      title: 'Publish via API',
      steps: ['Send POST /api/articles/publish'],
      expected_result: 'The article is live'
    });
    expect(['specification', 'grounded']).toContain(g.verdict);
  });
});
