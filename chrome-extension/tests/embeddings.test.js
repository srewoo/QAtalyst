/**
 * Tests for embeddings.js — free, offline, deterministic feature-hashed
 * embeddings. Proves: identical→~1, unrelated→low, semantic>lexical-unrelated,
 * deterministic, and empty input handled.
 */
const Embeddings = require('../embeddings.js');

describe('Embeddings.embed', () => {
  test('returns a fixed-dimension L2-normalized vector', () => {
    const v = Embeddings.embed('user signs in with password');
    expect(v.length).toBe(Embeddings.DIM);
    let norm = 0;
    for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  test('returns an all-zero vector for empty input', () => {
    const v = Embeddings.embed('');
    expect(v.length).toBe(Embeddings.DIM);
    expect(v.every(x => x === 0)).toBe(true);
  });

  test('handles null/undefined/whitespace without throwing', () => {
    expect(Embeddings.embed(null).every(x => x === 0)).toBe(true);
    expect(Embeddings.embed(undefined).every(x => x === 0)).toBe(true);
    expect(Embeddings.embed('   ').every(x => x === 0)).toBe(true);
  });

  test('is deterministic — same input yields an identical vector', () => {
    const a = Embeddings.embed('authenticate the user account');
    const b = Embeddings.embed('authenticate the user account');
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

describe('Embeddings.cosine / similarity', () => {
  test('identical text scores ~1', () => {
    expect(Embeddings.similarity('export invoice to pdf', 'export invoice to pdf')).toBeCloseTo(1, 5);
  });

  test('empty input → cosine 0', () => {
    expect(Embeddings.similarity('', 'anything here')).toBe(0);
    expect(Embeddings.cosine(Embeddings.embed(''), Embeddings.embed(''))).toBe(0);
  });

  test('unrelated topics score low', () => {
    const sim = Embeddings.similarity('user signs in with password', 'export invoice to pdf');
    expect(sim).toBeLessThan(0.15);
  });

  test('SEMANTIC: related-but-lexically-different beats unrelated', () => {
    const related = Embeddings.similarity('user signs in with password', 'authenticate the account');
    const unrelated = Embeddings.similarity('user signs in with password', 'export invoice to pdf');
    // Different surface words, same meaning → meaningfully higher than unrelated.
    expect(related).toBeGreaterThan(0.25);
    expect(related).toBeGreaterThan(unrelated * 3);
  });

  test('morphology/typo robustness via char-grams', () => {
    // "passwrd" is a typo of "password"; char-grams keep them near.
    const sim = Embeddings.similarity('enter the password field', 'enter the passwrd field');
    expect(sim).toBeGreaterThan(0.6);
  });

  test('cosine is symmetric', () => {
    const a = Embeddings.embed('login with valid credentials');
    const b = Embeddings.embed('sign in successfully');
    expect(Embeddings.cosine(a, b)).toBeCloseTo(Embeddings.cosine(b, a), 10);
  });
});
