/**
 * Tests for AcceptanceGate — the choke-point guaranteeing no duplicate /
 * irrelevant test enters the final suite. Composes grounding + relevance + dedup.
 */
const { AcceptanceGate } = require('../acceptance-gate.js');
const { GroundedVerifier } = require('../grounded-verifier.js');
const SemanticDuplicateDetector = require('../semantic-duplicate-detector.js');

const KG = {
  pages: [{
    url: 'https://app.example.com/login',
    title: 'Login',
    features: [
      { type: 'form', selector: '#login-form', inputs: [{ name: 'username' }, { name: 'password' }] },
      { type: 'button', text: 'Sign In', selector: '#signin' }
    ],
    apis: [{ method: 'POST', endpoint: '/api/auth/login', url: 'https://app.example.com/api/auth/login' }]
  }]
};

const TICKET = {
  summary: 'Implement user login with username and password',
  description: 'Users sign in with username + password. Invalid credentials show an error. Lock account after 5 failed attempts.'
};

function gate(overrides = {}) {
  return new AcceptanceGate({
    knowledgeGraph: KG,
    ticketData: TICKET,
    deps: { GroundedVerifier, SemanticDuplicateDetector },
    ...overrides
  });
}

describe('AcceptanceGate dedup', () => {
  test('rejects a near-duplicate of an already-accepted test', () => {
    const g = gate();
    const first = {
      id: 'TC-1', title: 'Valid login succeeds',
      steps: ['Enter a valid value in the username field', 'Enter a valid value in the password field', 'Click "Sign In"'],
      expected_result: 'User is logged in'
    };
    const dupe = {
      id: 'TC-2', title: 'Successful login with correct credentials',
      steps: ['Type a valid value in the username field', 'Type a valid value in the password field', 'Click "Sign In"'],
      expected_result: 'The user is logged in successfully'
    };
    const r1 = g.admit([first]);
    expect(r1.accepted.length).toBe(1);
    const r2 = g.admit([dupe]);
    expect(r2.accepted.length).toBe(0);
    expect(g.stats.duplicate).toBeGreaterThanOrEqual(1);
  });

  test('accepts a genuinely different test', () => {
    const g = gate();
    g.admit([{ id: 'TC-1', title: 'Valid login', steps: ['Click "Sign In"'], expected_result: 'logged in' }]);
    const r = g.admit([{
      id: 'TC-3', title: 'Account locks after 5 failed attempts',
      steps: ['Enter a value in the username field', 'Enter a wrong value in the password field', 'Repeat 5 times'],
      expected_result: 'Account is locked'
    }]);
    expect(r.accepted.length).toBe(1);
  });

  test('F14: rejects a test already covered by the existing suite', () => {
    const existingTests = [{
      id: 'C500', title: 'Successful login with correct credentials',
      description: 'User signs in with valid username and password',
      steps: ['Enter a valid value in the username field', 'Enter a valid value in the password field', 'Click "Sign In"'],
      expected_result: 'The user is logged in'
    }];
    const g = gate({ existingTests });
    const r = g.admit([{
      id: 'TC-1', title: 'Valid login succeeds',
      steps: ['Type a valid value in the username field', 'Type a valid value in the password field', 'Click "Sign In"'],
      expected_result: 'User is logged in'
    }]);
    expect(r.accepted.length).toBe(0);
    expect(g.stats.duplicateExisting).toBeGreaterThanOrEqual(1);
    expect(g.rejected.some(x => /existing suite/.test(x.reason))).toBe(true);
  });

  test('F14: existing-suite tests are never emitted as generated', () => {
    const existingTests = [{ id: 'C1', title: 'Some old case', steps: ['Click "Sign In"'], expected_result: 'ok' }];
    const g = gate({ existingTests });
    const r = g.admit([{
      id: 'TC-9', title: 'Account locks after 5 failed attempts',
      steps: ['Enter a value in the username field', 'Enter a wrong value in the password field'],
      expected_result: 'Account is locked'
    }]);
    // the new distinct test is accepted; the existing case is not in the accepted set
    expect(r.accepted.length).toBe(1);
    expect(g.getAccepted().some(t => t.id === 'C1')).toBe(false);
  });
});

describe('AcceptanceGate grounding', () => {
  test('rejects a test that references a non-existent field', () => {
    const g = gate();
    const r = g.admit([{
      id: 'TC-X', title: 'Login with biometric',
      steps: ['Enter data in the fingerprintScan field', 'Click "Scan Thumb"'],
      expected_result: 'Authenticated'
    }]);
    expect(r.accepted.length).toBe(0);
    expect(g.rejected.some(x => x.stage === 'grounding')).toBe(true);
  });
});

describe('AcceptanceGate relevance', () => {
  test('rejects an off-topic test', () => {
    const g = gate();
    const r = g.admit([{
      id: 'TC-OT', title: 'Export quarterly revenue chart to PDF',
      steps: ['Open the analytics dashboard', 'Generate the revenue report'],
      expected_result: 'PDF downloaded'
    }]);
    expect(r.accepted.length).toBe(0);
    expect(g.rejected.some(x => x.stage === 'relevance' || x.stage === 'grounding')).toBe(true);
  });

  test('keeps an on-topic login test', () => {
    const g = gate();
    const r = g.admit([{
      id: 'TC-REL', title: 'Invalid password shows error',
      steps: ['Enter a valid value in the username field', 'Enter a wrong value in the password field', 'Click "Sign In"'],
      expected_result: 'An error message is shown'
    }]);
    expect(r.accepted.length).toBe(1);
  });
});

describe('AcceptanceGate without crawl data', () => {
  test('grounding becomes not-applicable; relevance still uses the ticket', () => {
    const g = new AcceptanceGate({ knowledgeGraph: null, ticketData: TICKET, deps: { GroundedVerifier, SemanticDuplicateDetector } });
    const r = g.admit([{ id: 'TC-N', title: 'Login with username and password', steps: ['sign in'], expected_result: 'logged in' }]);
    expect(r.accepted.length).toBe(1);
  });
});
