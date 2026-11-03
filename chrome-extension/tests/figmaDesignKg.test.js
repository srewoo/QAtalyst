/**
 * Without a crawl, a linked Figma design becomes the grounding source: tests that
 * name controls the design does not have are still caught.
 */
const { designGraphFromFigma, mergeDesignGraphs } = require('../figma-design-kg.js');
const { AcceptanceGate } = require('../acceptance-gate.js');
const { GroundedVerifier } = require('../grounded-verifier.js');
const SemanticDuplicateDetector = require('../semantic-duplicate-detector.js');

const text = (characters) => ({ type: 'TEXT', name: characters, characters });
const DOC = { type: 'DOCUMENT', children: [{ type: 'CANVAS', name: 'Page 1', children: [
  { type: 'FRAME', name: 'Login', children: [
    { type: 'INSTANCE', name: 'Input / Default', children: [text('Email')] },
    { type: 'INSTANCE', name: 'Input / Password', children: [text('Password'), text('Enter your password')] },
    { type: 'INSTANCE', name: 'Button / Primary', children: [text('Sign In')] },
    { type: 'INSTANCE', name: 'Link', children: [text('Forgot password?')] },
    { type: 'TEXT', name: 'Heading', characters: 'Welcome back' }
  ] },
  { type: 'FRAME', name: 'Empty frame', children: [{ type: 'RECTANGLE', name: 'bg' }] }
] }] };

describe('Figma design knowledge graph', () => {
  const kg = designGraphFromFigma(DOC, 'https://www.figma.com/design/abc/Auth');

  test('screens become pages with their buttons and fields; empty frames are skipped', () => {
    expect(kg.source).toBe('design');
    expect(kg.pages).toHaveLength(1);
    const page = kg.pages[0];
    expect(page.title).toBe('Login');
    expect(page.features.filter(f => f.type === 'button').map(f => f.text)).toEqual(['Sign In', 'Forgot password?']);
    expect(page.features.find(f => f.type === 'form').fields.map(f => f.label)).toEqual(['Email', 'Password']);
  });

  test('plain text and variant names are not mistaken for controls', () => {
    const labels = JSON.stringify(kg.pages[0].features);
    expect(labels).not.toMatch(/Welcome back|Button \/ Primary|Enter your password/);
  });

  test('a design with no controls yields no graph, and merging skips nulls', () => {
    expect(designGraphFromFigma({ type: 'FRAME', name: 'Logo', children: [text('Acme')] }, 'u')).toBeNull();
    expect(mergeDesignGraphs([null, kg]).pages).toHaveLength(1);
    expect(mergeDesignGraphs([null])).toBeNull();
  });

  test('the real gate grounds against the design: an invented control is rejected', () => {
    const ticket = { summary: 'Sign in with email and password', acceptanceCriteria: 'Users can sign in with email and password' };
    const gate = new AcceptanceGate({ knowledgeGraph: kg, ticketData: ticket, deps: { GroundedVerifier, SemanticDuplicateDetector } });
    const real = { title: 'Valid credentials sign the user in', category: 'Positive', priority: 'P1',
      steps: ['Type a valid email in the "Email" field', 'Type the password in the "Password" field', 'Click "Sign In"'],
      expected_result: 'The user is signed in' };
    const invented = { title: 'Remember me keeps the user signed in', category: 'Positive', priority: 'P2',
      steps: ['Tick the "Remember me" checkbox', 'Click "Sign In"'], expected_result: 'The session persists after restart' };
    gate.admit([real, invented]);
    const accepted = gate.getAccepted();
    expect(accepted.map(t => t.title)).toEqual(['Valid credentials sign the user in']);
  });
});

describe('strict grounding', () => {
  const kg = { pages: [{ url: 'https://app.example.com/login', title: 'Login',
    features: [{ type: 'form', fields: [{ name: 'email' }, { name: 'password' }] }, { type: 'button', text: 'Sign In' }] }] };
  const ticket = { summary: 'Sign in with email and password', acceptanceCriteria: 'Users can sign in with email and password' };
  const mixed = { title: 'Sign in with email and password and Remember me', category: 'Positive', priority: 'P2',
    steps: ['Type the email in the email field', 'Type the password in the password field',
            'Tick the "Remember me" checkbox', 'Click "Sign In"'],
    expected_result: 'The user is signed in with email and password' };
  const gate = (strictGrounding) => new AcceptanceGate({ knowledgeGraph: kg, ticketData: ticket, strictGrounding,
    deps: { GroundedVerifier, SemanticDuplicateDetector } });

  test('on by default: a test naming an element the app lacks is rejected with the reason', () => {
    const g = gate(undefined);
    g.admit([mixed]);
    expect(g.getAccepted()).toHaveLength(0);
    expect(g.rejected[0].stage).toBe('grounding');
    expect(g.rejected[0].reason).toMatch(/remember me/i);
  });

  test('off: the same test is kept and flagged unresolved for review', () => {
    const g = gate(false);
    g.admit([mixed]);
    expect(g.getAccepted().map(t => t._grounding)).toEqual(['unresolved']);
  });
});
