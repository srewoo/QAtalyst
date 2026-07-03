/**
 * Tests for coverage-mapper.js — focused on F8: the feature inventory must be
 * populated for BOTH knowledge-graph shapes (raw page array vs aggregated).
 * Before F8 the raw-array shape produced an empty inventory and coverage read 0%.
 */
const CoverageMapper = require('../coverage-mapper.js');

// Shape (a): raw crawl — pages is an array, features/apis live per-page.
const KG_ARRAY = {
  pages: [
    {
      url: 'https://app.io/login',
      title: 'Login',
      features: [
        { type: 'form', id: 'login-form', inputs: [{ name: 'email' }, { name: 'password' }] },
        { type: 'button', text: 'Sign In' },
      ],
      apis: [{ method: 'POST', endpoint: '/api/login' }],
    },
    {
      url: 'https://app.io/orders',
      title: 'Orders',
      features: [{ type: 'button', text: 'New Order' }],
      apis: [{ method: 'GET', endpoint: '/api/orders' }],
    },
  ],
};

// Shape (b): aggregated — top-level collections + object-keyed pages.
const KG_AGG = {
  forms: [{ id: 'login-form', url: 'https://app.io/login', inputs: [{ name: 'email' }] }],
  apis: [{ method: 'POST', endpoint: '/api/login' }],
  features: [{ type: 'button', text: 'Sign In', url: 'https://app.io/login' }],
  pages: { 'https://app.io/login': { title: 'Login' } },
};

describe('CoverageMapper.buildFeatureInventory (F8)', () => {
  test('raw page-array shape yields a populated inventory', () => {
    const inv = new CoverageMapper(KG_ARRAY).buildFeatureInventory();
    expect(inv.forms.length).toBe(1);
    expect(inv.apis.length).toBe(2);
    expect(inv.buttons.length).toBe(2);
    expect(inv.pages.length).toBe(2);
  });

  test('aggregated shape still yields a populated inventory', () => {
    const inv = new CoverageMapper(KG_AGG).buildFeatureInventory();
    expect(inv.forms.length).toBe(1);
    expect(inv.apis.length).toBe(1);
    expect(inv.buttons.length).toBe(1);
    expect(inv.pages.length).toBe(1);
  });

  test('mapCoverage reports non-zero totals for the raw-array shape', () => {
    const cov = new CoverageMapper(KG_ARRAY).mapCoverage([]);
    expect(cov.overall.totalFeatures).toBeGreaterThan(0);
    expect(cov.forms.total + cov.apis.total + cov.buttons.total).toBeGreaterThan(0);
  });

  test('does not double-count when aggregated graph also carries per-page features', () => {
    const kg = {
      forms: [{ id: 'login-form', url: 'https://app.io/login', inputs: [] }],
      apis: [{ method: 'POST', endpoint: '/api/login' }],
      pages: { 'https://app.io/login': { title: 'Login', features: [{ type: 'form', id: 'login-form' }], apis: [{ method: 'POST', endpoint: '/api/login' }] } },
    };
    const inv = new CoverageMapper(kg).buildFeatureInventory();
    expect(inv.forms.length).toBe(1); // deduped by id|url
    expect(inv.apis.length).toBe(1);  // deduped by method+endpoint
  });
});

describe('CoverageMapper acceptance-criteria coverage (F5)', () => {
  test('parseAcceptanceCriteria splits bullets, numbers and task items into clean items', () => {
    const text = [
      'Acceptance Criteria:',
      '- User can reset password via email link',
      '1. Invalid token shows an error message',
      '- [x] Session expires after 30 minutes',
      '   ',
      '| Field | Rule |',
      '| --- | --- |',
    ].join('\n');
    const items = CoverageMapper.parseAcceptanceCriteria(text);
    expect(items).toContain('User can reset password via email link');
    expect(items).toContain('Invalid token shows an error message');
    expect(items.some(i => /Session expires/.test(i))).toBe(true);
    // header + separator + blank dropped
    expect(items).not.toContain('Acceptance Criteria:');
    expect(items.every(i => !/^[-|\s]+$/.test(i))).toBe(true);
  });

  test('mapAcceptanceCriteria marks an AC covered when a test exercises its terms', () => {
    const acItems = ['User can reset password via the emailed link', 'Expired reset token shows an error'];
    const tests = [
      { id: 'T1', title: 'Reset password with emailed link', steps: ['Request reset', 'Open emailed link', 'Set new password'], expected_result: 'Password is reset' },
    ];
    const res = CoverageMapper.mapAcceptanceCriteria(tests, acItems);
    expect(res.total).toBe(2);
    expect(res.covered).toBe(1);
    expect(res.uncovered).toHaveLength(1);
    expect(res.uncovered[0].text).toMatch(/expired reset token/i);
    expect(res.percentage).toBe(50);
  });

  test('mapAcceptanceCriteria is not applicable with no AC items', () => {
    const res = CoverageMapper.mapAcceptanceCriteria([{ title: 'x' }], []);
    expect(res.applicable).toBe(false);
    expect(res.total).toBe(0);
  });

  test('G4: semantic matching covers a differently-worded test when embeddings are strong', () => {
    // AC and test share almost NO vocabulary, so token recall fails; a capable
    // embedder reports high similarity → the semantic path marks it covered.
    const acItems = ['Existing conversation is auto-labelled from its opening query'];
    const tests = [{ title: 'Migration names chat from first question', steps: ['open app'], expected_result: 'chat named from trimmed first question' }];

    // Without embeddings: token recall fails → uncovered.
    const tokenOnly = CoverageMapper.mapAcceptanceCriteria(tests, acItems);
    expect(tokenOnly.covered).toBe(0);

    // Stub embedder that returns a high cosine for this pair → covered via semantics.
    const stubEmb = { embed: (t) => t, cosine: () => 0.8 };
    const withEmb = CoverageMapper.mapAcceptanceCriteria(tests, acItems, { embeddings: stubEmb });
    expect(withEmb.covered).toBe(1);
    expect(withEmb.details[0].matchType).toBe('semantic');
  });

  test('G4: a weak embedder below threshold does NOT create false coverage', () => {
    const acItems = ['Panel is visible by default'];
    const tests = [{ title: 'Unrelated deletion flow', steps: ['delete'], expected_result: 'removed' }];
    const weakEmb = { embed: (t) => t, cosine: () => 0.4 }; // below the 0.62 default
    const res = CoverageMapper.mapAcceptanceCriteria(tests, acItems, { embeddings: weakEmb });
    expect(res.covered).toBe(0);
  });
});

describe('CoverageMapper.extractRequirementItems (G1 — prose-scenario harvesting)', () => {
  // Shaped like RE-11256: AC + Case blocks + grooming notes live in the description.
  const DESC = [
    '**Story:**',
    'As a Seller Copilot User, I want to view a list of my chat sessions.',
    '',
    '**Description:**',
    'When a user opens the interface, a sidebar shows chat sessions.',
    '',
    'Scope: Web & Mobile mini mode',
    '',
    '**Case 1:** User already has an active chat prior to this feature',
    '* Chat name should be created behind the scene using the first question - trimmed question',
    '* When they access chat history only one recent chat and that highlighted as active.',
    '',
    '**Case 2:** First time user or old chat session is deleted',
    '* By default user lands in New chat.',
    '* In history pane, it shows an empty state with no recent chats.',
    '',
    'Good to have: On posting a follow up question, the chat should move up the list immediately.',
    '',
    '**Acceptance Criteria:**',
    '* The left-hand navigation panel is visible by default when the Copilot interface is opened.',
    '* The current active chat session is visually highlighted in the list.',
    '',
    '**Grooming notes:**',
    '* Upon rename, the chat should move to the top of the list.',
    '* Pagination of chat list (~20).',
    '',
    '**Mobile UI**',
    '* On click of hamburger icon, mobile will send an open.sidebar event.',
  ].join('\n');

  test('harvests AC bullets, Case scenarios, grooming notes and inline "Good to have"', () => {
    const items = CoverageMapper.extractRequirementItems({ description: DESC });
    const joined = items.join(' || ').toLowerCase();
    // Case scenarios (the migration case that was untested twice)
    expect(joined).toContain('user already has an active chat');
    expect(joined).toContain('chat name should be created behind the scene');
    // AC bullets
    expect(joined).toContain('navigation panel is visible by default');
    expect(joined).toContain('active chat session is visually highlighted');
    // grooming notes
    expect(joined).toContain('move to the top of the list');
    expect(joined).toContain('pagination of chat list');
    // inline good-to-have + mobile event
    expect(joined).toContain('move up the list immediately');
    expect(joined).toContain('open.sidebar event');
  });

  test('does NOT capture the Story statement or Description prose', () => {
    const items = CoverageMapper.extractRequirementItems({ description: DESC });
    const joined = items.join(' || ').toLowerCase();
    expect(joined).not.toContain('as a seller copilot user');
    expect(joined).not.toContain('when a user opens the interface');
  });

  test('merges a dedicated AC custom field with description-harvested items', () => {
    const items = CoverageMapper.extractRequirementItems({
      acceptanceCriteria: '- Session list is responsive on mobile.',
      description: DESC,
    });
    const joined = items.join(' || ').toLowerCase();
    expect(joined).toContain('responsive on mobile');
    expect(joined).toContain('pagination of chat list');
  });

  test('deduplicates and caps the item list', () => {
    const items = CoverageMapper.extractRequirementItems({ description: DESC });
    expect(items.length).toBeGreaterThan(5);
    expect(items.length).toBeLessThanOrEqual(40);
    expect(new Set(items.map(i => i.toLowerCase())).size).toBe(items.length);
  });

  test('empty ticket yields no items', () => {
    expect(CoverageMapper.extractRequirementItems({})).toEqual([]);
    expect(CoverageMapper.extractRequirementItems(null)).toEqual([]);
  });
});

describe('countKgEntities (F8)', () => {
  const { countKgEntities } = require('../background-utils.js');
  test('counts entities in the raw page-array shape (previously 0)', () => {
    expect(countKgEntities(KG_ARRAY)).toBeGreaterThan(0);
  });
  test('counts entities in the aggregated shape', () => {
    expect(countKgEntities(KG_AGG)).toBeGreaterThan(0);
  });
  test('returns 0 for null', () => {
    expect(countKgEntities(null)).toBe(0);
  });
});
