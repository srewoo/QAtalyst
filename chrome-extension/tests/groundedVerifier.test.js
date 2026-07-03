/**
 * Tests for GroundedVerifier — the quality gate that rejects/repairs test cases
 * referencing app entities that don't exist in the crawled knowledge graph.
 * This is the core "no irrelevant / hallucinated test" signal.
 */
const { GroundedVerifier, similarity, pathOf } = require('../grounded-verifier.js');

// Knowledge graph in the raw-crawl shape (pages = array).
const KG = {
  pages: [
    {
      url: 'https://shop.example.com/checkout',
      title: 'Checkout',
      features: [
        {
          type: 'form',
          selector: '#checkout-form',
          inputs: [{ name: 'email' }, { name: 'cardNumber' }, { name: 'cvv' }]
        },
        { type: 'button', text: 'Place Order', selector: '#place-order-btn' }
      ],
      apis: [{ method: 'POST', endpoint: '/api/orders', url: 'https://shop.example.com/api/orders' }]
    },
    {
      url: 'https://shop.example.com/login',
      title: 'Login',
      features: [
        { type: 'form', selector: '#login-form', inputs: [{ name: 'username' }, { name: 'password' }] },
        { type: 'button', text: 'Sign In', selector: '#signin' }
      ],
      apis: []
    }
  ]
};

describe('GroundedVerifier index building', () => {
  test('should index fields, buttons, selectors, apis and routes from raw-crawl shape', () => {
    const v = new GroundedVerifier(KG);
    expect(v.isApplicable()).toBe(true);
    expect(v.index.fields.has('email')).toBe(true);
    expect(v.index.fields.has('cardnumber')).toBe(true);
    expect(v.index.buttons.has('place order')).toBe(true);
    expect(v.index.selectors.has('#checkout-form')).toBe(true);
    expect(v.index.routes.has('/checkout')).toBe(true);
    expect(v.index.apis.some(a => a.endpoint === '/api/orders' && a.method === 'POST')).toBe(true);
  });

  test('should index aggregated shape (pages object + top-level forms/apis)', () => {
    const aggKG = {
      pages: { 'https://x.com/a': { title: 'A' } },
      forms: [{ selector: '#f1', inputs: [{ name: 'q' }] }],
      apis: [{ method: 'GET', url: 'https://x.com/api/search' }]
    };
    const v = new GroundedVerifier(aggKG);
    expect(v.index.fields.has('q')).toBe(true);
    expect(v.index.apis.some(a => a.endpoint === '/api/search')).toBe(true);
    expect(v.index.routes.has('/a')).toBe(true);
  });

  test('should be not-applicable when no knowledge graph', () => {
    const v = new GroundedVerifier(null);
    expect(v.isApplicable()).toBe(false);
    expect(v.verify({ title: 'anything', steps: ['click #ghost'] }).verdict).toBe('not_applicable');
  });
});

describe('GroundedVerifier.verify', () => {
  test('should mark a test grounded when all references exist', () => {
    const v = new GroundedVerifier(KG);
    const tc = {
      title: 'Successful checkout',
      steps: [
        'Enter a valid value in the email field',
        'Enter a valid value in the cardNumber field',
        'Click "Place Order"'
      ],
      expected_result: 'POST /api/orders returns 200'
    };
    const r = v.verify(tc);
    expect(r.verdict).toBe('grounded');
    expect(r.score).toBeGreaterThanOrEqual(0.5);
    expect(r.issues).toHaveLength(0);
  });

  test('should REJECT a test referencing a non-existent field and button', () => {
    const v = new GroundedVerifier(KG);
    const tc = {
      title: 'Apply discount code',
      steps: [
        'Enter a code in the promoCodeXYZ field',
        'Click "Redeem Mega Coupon"'
      ],
      expected_result: 'Discount applied'
    };
    const r = v.verify(tc);
    expect(r.verdict).toBe('reject');
    expect(r.issues.length).toBeGreaterThan(0);
  });

  test('should propose a REPAIR when a field is a near-miss of a real one', () => {
    const v = new GroundedVerifier(KG, { fuzzyThreshold: 0.7 });
    const tc = {
      title: 'Login',
      // "usernam" is a typo of the real "username"
      steps: ['Enter text in the usernam field', 'Enter text in the password field', 'Click "Sign In"']
    };
    const r = v.verify(tc);
    expect(['needs_repair', 'grounded']).toContain(r.verdict);
    // a repair for the typo'd field should be suggested
    const repaired = v.applyRepairs(tc, r.repairs);
    expect(JSON.stringify(repaired).toLowerCase()).toContain('username');
  });

  test('F6: with a KG present, a vague test that names no concrete entity is rejected', () => {
    const v = new GroundedVerifier(KG);
    const r = v.verify({ title: 'Verify the system behaves correctly', steps: ['Do the thing'] });
    expect(r.verdict).toBe('reject');
    expect(r.score).toBeLessThan(0.5);
    expect(r.issues.join(' ')).toMatch(/too vague/i);
  });

  test('F6: lenient mode (requireGroundingRefs:false) still passes vague tests through', () => {
    const v = new GroundedVerifier(KG, { requireGroundingRefs: false });
    const r = v.verify({ title: 'Verify the system behaves correctly', steps: ['Do the thing'] });
    expect(r.verdict).toBe('grounded');
  });

  test('F6: with NO crawl data, a vague test is not_applicable (not rejected)', () => {
    const v = new GroundedVerifier(null);
    const r = v.verify({ title: 'Verify the system behaves correctly', steps: ['Do the thing'] });
    expect(r.verdict).toBe('not_applicable');
    expect(r.unverified).toBe(true);
  });
});

describe('GroundedVerifier F7 — boundary/param-aware matching', () => {
  const KG = {
    pages: [{
      url: 'https://app.io/settings',
      features: [],
      apis: [
        { method: 'GET', endpoint: '/api/users/{id}' },
        { method: 'POST', endpoint: '/api/orders' }
      ]
    }]
  };
  test('root route "/" does not ground an arbitrary route', () => {
    const v = new GroundedVerifier({ pages: [{ url: 'https://app.io/', features: [], apis: [] }] });
    expect(v.routeExists('/some/deep/path')).toBe(false);
    expect(v.routeExists('/')).toBe(true);
  });
  test('param endpoint matches a concrete id but not a different resource', () => {
    const v = new GroundedVerifier(KG);
    expect(v.apiExists('GET /api/users/42')).toBe(true);   // {id} wildcard
    expect(v.apiExists('GET /api/orders')).toBe(true);      // exact
    expect(v.apiExists('GET /api/payments')).toBe(false);   // not present
    expect(v.apiExists('GET /api')).toBe(true);             // ancestor of known endpoints
  });
  test('short endpoint fragment does not ground via substring', () => {
    const v = new GroundedVerifier(KG);
    // old bidirectional includes would have grounded this against /api/orders
    expect(v.apiExists('GET /ord')).toBe(false);
  });
});

describe('GroundedVerifier.verifyBatch', () => {
  test('should split a batch into accepted and rejected', () => {
    const v = new GroundedVerifier(KG);
    const batch = [
      { title: 'good', steps: ['Click "Sign In"'] },
      { title: 'bad', steps: ['Click "Teleport To Mars"', 'Enter value in the warpDrive field'] }
    ];
    const out = v.verifyBatch(batch);
    expect(out.report.total).toBe(2);
    expect(out.accepted.length).toBe(1);
    expect(out.rejected.length).toBe(1);
    expect(out.accepted[0]._groundingVerdict).toBeDefined();
  });
});

describe('GroundedVerifier behaviour validation (v13.2)', () => {
  // API-rich KG so absence of a mechanism is meaningful.
  const RICH_KG = {
    pages: [{
      url: 'https://app.example.com/settings',
      title: 'Settings',
      features: [
        { type: 'form', selector: '#profile-form', inputs: [{ name: 'displayName' }, { name: 'email' }] },
        { type: 'button', text: 'Save', selector: '#save' }
      ],
      apis: [
        { method: 'GET', endpoint: '/api/profile', url: 'https://app.example.com/api/profile' },
        { method: 'PUT', endpoint: '/api/profile', url: 'https://app.example.com/api/profile' },
        { method: 'POST', endpoint: '/api/settings/save', url: 'https://app.example.com/api/settings/save' }
      ]
    }]
  };

  test('should warn and penalise when a test asserts auto-sync with no supporting API', () => {
    const v = new GroundedVerifier(RICH_KG);
    const tc = {
      title: 'Settings auto-sync',
      steps: ['Update the displayName field', 'Click "Save"'],
      expected_result: 'Changes auto-sync to every other device in real-time'
    };
    const r = v.verify(tc);
    expect(r.behaviorWarnings.length).toBeGreaterThan(0);
    expect(r.behaviorWarnings.join(' ')).toMatch(/sync|real-time|polling/i);
  });

  test('should hard-reject unsupported behaviour in strict mode', () => {
    const v = new GroundedVerifier(RICH_KG, { strictBehaviors: true, minGroundingScore: 0.5 });
    const tc = {
      title: 'Confirmation email',
      steps: ['Update the email field', 'Click "Save"'],
      expected_result: 'A confirmation email is sent and the account auto-syncs nightly via a scheduled job'
    };
    const r = v.verify(tc);
    expect(r.verdict).toBe('reject');
    expect(r.issues.some(i => /email|scheduled|sync/i.test(i))).toBe(true);
  });

  test('should NOT warn when the behaviour has a supporting API', () => {
    const v = new GroundedVerifier(RICH_KG);
    const tc = {
      title: 'Save profile',
      steps: ['Update the displayName field', 'Click "Save"'],
      expected_result: 'POST /api/settings/save persists the changes'
    };
    const r = v.verify(tc);
    expect(r.behaviorWarnings).toHaveLength(0);
  });

  test('F25: now RUNS on a thin (≥1 API) crawl and flags unsupported auto-sync', () => {
    const v = new GroundedVerifier(KG); // KG has 1 API; threshold lowered to 1 (F25)
    const tc = {
      title: 'Login auto-sync',
      steps: ['Enter a value in the username field', 'Click "Sign In"'],
      expected_result: 'Session auto-syncs in real-time across devices'
    };
    const r = v.verify(tc);
    expect(r.behaviorWarnings.length).toBeGreaterThan(0);
  });

  test('F25: still a no-op when the crawl observed ZERO APIs', () => {
    const kgNoApis = { pages: [{ url: 'https://app/x', features: [{ type: 'button', text: 'Go' }], apis: [] }] };
    const v = new GroundedVerifier(kgNoApis);
    const tc = {
      title: 'Auto sync', steps: ['Click "Go"'],
      expected_result: 'Data auto-syncs in real-time'
    };
    const r = v.verify(tc);
    expect(r.behaviorWarnings).toHaveLength(0);
  });

  test('should respect behaviorCheck:false', () => {
    const v = new GroundedVerifier(RICH_KG, { behaviorCheck: false });
    const tc = {
      title: 'Auto sync',
      steps: ['Update the email field'],
      expected_result: 'Data syncs automatically every 30 seconds'
    };
    expect(v.verify(tc).behaviorWarnings).toHaveLength(0);
  });
});

describe('pure helpers', () => {
  test('similarity is 1 for identical, lower for different', () => {
    expect(similarity('username', 'username')).toBe(1);
    expect(similarity('username', 'usernam')).toBeGreaterThan(0.8);
    expect(similarity('username', 'totallydifferent')).toBeLessThan(0.4);
  });

  test('pathOf extracts pathname from urls and bare paths', () => {
    expect(pathOf('https://x.com/a/b/')).toBe('/a/b');
    expect(pathOf('/api/orders')).toBe('/api/orders');
    expect(pathOf('not a url')).toBe('');
  });
});
