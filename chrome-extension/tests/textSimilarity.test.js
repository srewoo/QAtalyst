/**
 * Tests for text-similarity.js — the concept-normalisation + semantic-cosine
 * primitives that back the AcceptanceGate's relevance check. Imports the real
 * module so behaviour can't drift.
 */
const TS = require('../text-similarity.js');

describe('canonicalize — surface word → concept', () => {
  test('maps login synonyms to a single concept', () => {
    for (const w of ['signin', 'sign-in', 'authenticate', 'log-in', 'logon']) {
      expect(TS.canonicalize(w)).toBe('login');
    }
  });
  test('maps UI synonyms', () => {
    expect(TS.canonicalize('btn')).toBe('button');
    expect(TS.canonicalize('cta')).toBe('button');
    expect(TS.canonicalize('textbox')).toBe('field');
  });
  test('stems inflected forms toward the same concept', () => {
    expect(TS.canonicalize('creating')).toBe('create');
    expect(TS.canonicalize('registered')).toBe('create');
    expect(TS.canonicalize('authenticating')).toBe('login');
  });
  test('passes through unknown words (stemmed)', () => {
    expect(TS.canonicalize('widget')).toBe('widget');
  });
});

describe('canonicalTokens', () => {
  test('drops stopwords and short tokens, keeps concepts', () => {
    const toks = TS.canonicalTokens('The user should be able to signin to the account');
    expect(toks).toContain('login');   // signin → login concept
    expect(toks).toContain('user');    // account → user concept
    expect(toks).not.toContain('the');
    expect(toks).not.toContain('be');
  });
});

describe('semanticCosine — meaning over wording', () => {
  test('high for same meaning, different words', () => {
    const s = TS.semanticCosine(
      'user can sign in with their password',
      'authenticate the account using a passcode'
    );
    expect(s).toBeGreaterThan(0.2);
  });

  test('~0 for unrelated topics', () => {
    const s = TS.semanticCosine(
      'user can sign in with their password',
      'export the monthly invoice to a PDF file'
    );
    expect(s).toBeLessThan(0.05);
  });

  test('1.0 for identical text, symmetric', () => {
    expect(TS.semanticCosine('save the form', 'save the form')).toBeCloseTo(1, 5);
    expect(TS.semanticCosine('a b', 'b a')).toBeCloseTo(TS.semanticCosine('b a', 'a b'), 5);
  });

  test('0 when either side is empty', () => {
    expect(TS.semanticCosine('', 'anything here')).toBe(0);
    expect(TS.semanticCosine('anything', '')).toBe(0);
  });

  test('beats lexical: synonym-only overlap still scores', () => {
    // No shared surface tokens, but same concepts (login, button).
    const s = TS.semanticCosine('tap the sign-in cta', 'click the login button');
    expect(s).toBeGreaterThan(0.5);
  });
});
