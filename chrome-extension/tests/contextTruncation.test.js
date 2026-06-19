/**
 * Tests for paragraph-boundary-aware context truncation —
 * the REAL ContextManager._truncateText(text, targetTokens) from context-manager.js.
 *
 * Contract (token-based, NOT char-based):
 * - If estimateTokens(text) <= targetTokens, the text is returned unchanged.
 * - Multi-block input (>2 paragraph blocks) is split at paragraph boundaries,
 *   blocks are scored by priority (first block always kept), and selected
 *   greedily until the token budget is met; removed regions are replaced with a
 *   "[... content truncated ...]" marker.
 * - Input with <=2 blocks falls back to a start+end character slice with the
 *   same marker.
 *
 * Previously this test inlined a (drifted, char-based) copy. It now imports the
 * shipped class so it can never diverge from production behaviour.
 */
require('../context-manager.js');
const ContextManager = globalThis.ContextManager;
const cm = new ContextManager('gpt-4.1');
const truncate = (text, targetTokens) => cm._truncateText(text, targetTokens);
const tokens = (text) => cm.estimateTokens(text);
const MARKER = '[... content truncated ...]';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeParagraphs(count, wordsEach = 25) {
  return Array.from({ length: count }, (_, i) =>
    `Paragraph ${i + 1}: ` + `word${i} `.repeat(wordsEach).trim()
  ).join('\n\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ContextManager._truncateText (real source)', () => {
  describe('no-op cases (text fits the token budget)', () => {
    test('returns text unchanged when it fits within targetTokens', () => {
      const text = 'Short text that comfortably fits the budget.';
      expect(truncate(text, 1000)).toBe(text);
    });

    test('returns falsy input unchanged (0 tokens)', () => {
      expect(truncate('', 100)).toBe('');
      expect(truncate(null, 100)).toBe(null);
      expect(truncate(undefined, 100)).toBe(undefined);
    });

    test('returns text unchanged when token count equals the budget exactly', () => {
      const text = 'exactly four chars per token here ok';
      expect(truncate(text, tokens(text))).toBe(text);
    });
  });

  describe('token budget invariant', () => {
    test('multi-paragraph output is reduced to roughly the token budget', () => {
      const text = makeParagraphs(25, 30); // far exceeds the budget
      const budget = 120;
      const result = truncate(text, budget);
      expect(result.length).toBeLessThan(text.length);
      // Selection reserves headroom for the marker; allow a small overage for it.
      expect(tokens(result)).toBeLessThanOrEqual(budget + 40);
    });

    test('actually truncates when input exceeds the budget', () => {
      const text = makeParagraphs(20, 30);
      const result = truncate(text, 100);
      expect(result).not.toBe(text);
      expect(result.length).toBeLessThan(text.length);
    });
  });

  describe('paragraph-boundary behaviour', () => {
    test('keeps the first paragraph (highest priority) and inserts a marker', () => {
      const text = makeParagraphs(20, 30);
      const result = truncate(text, 100);
      expect(result).toContain('Paragraph 1:');
      expect(result).toContain(MARKER);
    });

    test('prefers earlier/high-priority content over middle blocks', () => {
      const early = 'EARLY CONTENT: this first paragraph must survive trimming.';
      const middleFiller = Array.from({ length: 15 }, (_, i) =>
        `Filler paragraph ${i} ` + 'lorem ipsum dolor sit '.repeat(8)
      ).join('\n\n');
      const text = `${early}\n\n${middleFiller}`;
      const result = truncate(text, 60);
      expect(result).toContain('EARLY CONTENT');
    });

    test('keeps blocks whole rather than cutting mid-paragraph when they fit', () => {
      const text = makeParagraphs(12, 25);
      const result = truncate(text, 150);
      // The first paragraph is kept in full (not sliced mid-word).
      expect(result).toContain('Paragraph 1: word0');
    });
  });

  describe('few-block fallback (<=2 blocks)', () => {
    test('falls back to start+end slice with a marker for a single long block', () => {
      const text = 'word '.repeat(400).trim(); // one continuous block, no \n\n
      const result = truncate(text, 50);
      expect(result).toContain(MARKER);
      expect(result.length).toBeLessThan(text.length);
      // start+end fallback: begins with original head, ends with original tail
      expect(text.startsWith(result.split(MARKER)[0].trim().slice(0, 20))).toBe(true);
    });
  });
});
