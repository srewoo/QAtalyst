/**
 * Tests for token-counter.js — pure token estimation / limit helpers.
 * Module exposes module.exports, so we require it directly (no harness needed).
 */
const tc = require('../token-counter.js');

describe('estimateTokenCount', () => {
  test('returns 0 for empty / non-string input', () => {
    expect(tc.estimateTokenCount('')).toBe(0);
    expect(tc.estimateTokenCount(null)).toBe(0);
    expect(tc.estimateTokenCount(undefined)).toBe(0);
    expect(tc.estimateTokenCount(123)).toBe(0);
  });

  test('uses the ~4 chars/token heuristic (ceil)', () => {
    expect(tc.estimateTokenCount('abcd')).toBe(1);
    expect(tc.estimateTokenCount('abcde')).toBe(2); // ceil(5/4)
    expect(tc.estimateTokenCount('a'.repeat(400))).toBe(100);
  });

  test('scales monotonically with text length', () => {
    const short = tc.estimateTokenCount('a'.repeat(40));
    const long = tc.estimateTokenCount('a'.repeat(4000));
    expect(long).toBeGreaterThan(short);
    expect(long).toBe(short * 100);
  });
});

describe('getModelLimits', () => {
  test('returns the safe default for missing / unknown models', () => {
    expect(tc.getModelLimits()).toEqual({ max: 128000, safe: 120000 });
    expect(tc.getModelLimits('totally-made-up-model')).toEqual({ max: 128000, safe: 120000 });
  });

  test('resolves an exact-match model from TOKEN_LIMITS', () => {
    expect(tc.getModelLimits('gpt-4')).toEqual(tc.TOKEN_LIMITS['gpt-4']);
    expect(tc.getModelLimits('gpt-4').max).toBe(8192);
  });

  test('resolves a known model family by prefix', () => {
    // not an exact key, but matches the 'claude-' family prefix
    expect(tc.getModelLimits('claude-foo-bar')).toEqual({ max: 200000, safe: 190000 });
    // gpt-5 prefix family
    expect(tc.getModelLimits('gpt-5-something')).toEqual({ max: 400000, safe: 380000 });
    // gemini family
    expect(tc.getModelLimits('gemini-anything')).toEqual({ max: 1000000, safe: 950000 });
  });
});

describe('estimateMessagesTokens', () => {
  test('returns 0 for non-array input', () => {
    expect(tc.estimateMessagesTokens(null)).toBe(0);
    expect(tc.estimateMessagesTokens('nope')).toBe(0);
  });

  test('adds per-message overhead plus content tokens', () => {
    // one message, content 'abcd' => 4 overhead + 1 content
    expect(tc.estimateMessagesTokens([{ role: 'user', content: 'abcd' }])).toBe(5);
  });

  test('counts image parts at a fixed image cost', () => {
    const total = tc.estimateMessagesTokens([
      { role: 'user', content: [{ type: 'image' }] },
    ]);
    expect(total).toBe(4 + 1500);
  });
});

describe('checkTokenLimit', () => {
  test('flags requests that exceed the hard limit as unsafe', () => {
    const r = tc.checkTokenLimit(8000, 'gpt-4', 1000); // gpt-4 max 8192
    expect(r.safe).toBe(false);
    expect(r.limit).toBe(8192);
    expect(r.warning).toMatch(/exceeded/i);
  });

  test('warns but stays safe when approaching the safe threshold', () => {
    // gpt-4: max 8192, safe 7500. input 7000 + output 200 = 7200 < safe -> no warning
    const ok = tc.checkTokenLimit(7000, 'gpt-4', 200);
    expect(ok.safe).toBe(true);
    expect(ok.warning).toBeNull();
    // input 7400 + 200 = 7600 > safe(7500) but < max(8192)
    const high = tc.checkTokenLimit(7400, 'gpt-4', 200);
    expect(high.safe).toBe(true);
    expect(high.warning).toMatch(/high|approaching/i);
  });
});

describe('truncateToTokenLimit', () => {
  test('returns text unchanged when already under the limit', () => {
    const text = 'short text';
    expect(tc.truncateToTokenLimit(text, 1000)).toBe(text);
  });

  test('truncates over-limit text to within the token budget', () => {
    const text = 'a'.repeat(8000); // ~2000 tokens
    const out = tc.truncateToTokenLimit(text, 100);
    expect(out).toContain('content truncated');
    // the kept prefix should fit the budget (targetChars = floor(100*4*0.95)=380)
    const prefixLen = out.indexOf('\n\n[...');
    expect(prefixLen).toBeLessThanOrEqual(100 * 4);
    expect(prefixLen).toBeGreaterThan(0);
  });
});

describe('getTokenStatistics', () => {
  test('estimates from a raw string and returns the expected shape', () => {
    const stats = tc.getTokenStatistics('a'.repeat(400), 'gpt-4');
    expect(stats.inputTokens).toBe(100);
    expect(stats.model).toBe('gpt-4');
    expect(stats.limit).toBe(8192);
    expect(stats.safeLimit).toBe(7500);
    expect(stats.remaining).toBe(8192 - 100);
    expect(typeof stats.percentage).toBe('string');
  });

  test('estimates from a messages array', () => {
    const stats = tc.getTokenStatistics([{ role: 'user', content: 'abcd' }], 'gpt-4');
    expect(stats.inputTokens).toBe(5); // 4 overhead + 1 content
  });
});
