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

  test('abstract tests with no concrete references pass to relevance gate (grounded)', () => {
    const v = new GroundedVerifier(KG);
    const r = v.verify({ title: 'Verify the system behaves correctly', steps: ['Do the thing'] });
    expect(r.verdict).toBe('grounded');
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
