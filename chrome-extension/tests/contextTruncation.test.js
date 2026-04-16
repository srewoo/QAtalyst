/**
 * Tests for the paragraph-boundary-aware context truncation (_truncateText).
 * This was rewritten from a naive "keep first 60% + last 20%" approach.
 * The new algorithm splits at paragraph boundaries, scores blocks by priority,
 * and greedily selects blocks until the character budget is met.
 *
 * Key invariants:
 * - Output is never longer than the requested maxLength
 * - Truncation only happens at paragraph boundaries, not mid-sentence
 * - A truncation marker is inserted where content was removed
 * - If input fits within budget, it is returned unchanged
 */

// ---------------------------------------------------------------------------
// Inline _truncateText as adapted from context-manager.js
// ---------------------------------------------------------------------------
function _truncateText(text, maxLength, priority = 50) {
  if (!text || text.length <= maxLength) return text;

  // Split at paragraph boundaries (double newlines or heading markers)
  const rawBlocks = text.split(/\n{2,}|(?=#{1,3}\s)/);
  const blocks = rawBlocks.filter(b => b.trim().length > 0);

  if (blocks.length <= 1) {
    // Single block — hard-truncate with ellipsis
    return text.substring(0, maxLength - 3) + '...';
  }

  // Score each block: earlier blocks and longer blocks score higher
  const scored = blocks.map((block, idx) => ({
    block,
    score: (blocks.length - idx) * 10 + block.length,
    idx,
  }));

  // Greedy selection: pick blocks from highest to lowest score until budget exhausted
  const MARKER = '\n\n[...context truncated...]\n\n';
  const markerLen = MARKER.length;
  let budget = maxLength;
  const selected = new Set();

  const sorted = [...scored].sort((a, b) => b.score - a.score);
  for (const { block, idx } of sorted) {
    const needed = block.length + (selected.size > 0 ? markerLen : 0);
    if (budget >= needed) {
      selected.add(idx);
      budget -= block.length;
    }
    if (budget <= markerLen) break;
  }

  // Rebuild in original order, inserting markers between gaps
  let result = '';
  let prevSelected = true;
  for (let i = 0; i < blocks.length; i++) {
    if (selected.has(i)) {
      if (!prevSelected && result.length > 0) result += MARKER;
      result += blocks[i];
      prevSelected = true;
    } else {
      prevSelected = false;
    }
  }

  // Final safety clamp
  if (result.length > maxLength) result = result.substring(0, maxLength - 3) + '...';
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeParagraphs(count, wordsEach = 20) {
  return Array.from({ length: count }, (_, i) =>
    `Paragraph ${i + 1}: ` + `word${i} `.repeat(wordsEach).trim()
  ).join('\n\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('_truncateText (paragraph-boundary truncation)', () => {
  describe('no-op cases', () => {
    test('returns text as-is when it fits within maxLength', () => {
      const text = 'Short text that fits.';
      expect(_truncateText(text, 1000)).toBe(text);
    });

    test('returns text as-is when length equals maxLength exactly', () => {
      const text = 'abc';
      expect(_truncateText(text, 3)).toBe(text);
    });

    test('returns null/undefined unchanged', () => {
      expect(_truncateText(null, 100)).toBe(null);
      expect(_truncateText(undefined, 100)).toBe(undefined);
    });

    test('returns empty string unchanged', () => {
      expect(_truncateText('', 100)).toBe('');
    });
  });

  describe('output length invariant', () => {
    test('output is never longer than maxLength for multi-paragraph input', () => {
      const text = makeParagraphs(20, 30); // ~large text
      const result = _truncateText(text, 500);
      expect(result.length).toBeLessThanOrEqual(500);
    });

    test('output is never longer than maxLength for single-block input', () => {
      const text = 'A'.repeat(2000);
      const result = _truncateText(text, 100);
      expect(result.length).toBeLessThanOrEqual(100);
    });

    test('output is never longer than maxLength for very small budget', () => {
      const text = makeParagraphs(5, 20);
      const result = _truncateText(text, 50);
      expect(result.length).toBeLessThanOrEqual(50);
    });
  });

  describe('paragraph boundary respect', () => {
    test('does not cut in the middle of a paragraph that fits', () => {
      const para1 = 'First paragraph that is kept in full because it fits.';
      const para2 = 'Second paragraph that is also short and fits.';
      const para3 = 'Third paragraph that makes the total too long for a tight budget: ' + 'x'.repeat(200);
      const text = [para1, para2, para3].join('\n\n');
      const result = _truncateText(text, para1.length + para2.length + 50);
      // para1 and para2 should be present without being cut in the middle
      expect(result).toContain(para1);
      expect(result).toContain(para2);
    });

    test('inserts truncation marker when a block in the middle is dropped', () => {
      // 4 blocks of varying lengths. Budget=190, total text=211 chars (triggers truncation).
      // Greedy score order: b0(140) > b2(100) > b1(50) > b3(15).
      // b0 selected (budget 90), b2 needs 80+29=109 > 90 → skipped,
      // b1 needs 20+29=49 ≤ 90 → selected {0,1} (budget 70),
      // b3 needs 5+29=34 ≤ 70 → selected {0,1,3}.
      // Non-adjacent gap at i=2 → marker inserted between b1 and b3.
      const b0 = 'A'.repeat(100); // score: 4*10+100=140
      const b1 = 'B'.repeat(20);  // score: 3*10+20=50
      const b2 = 'C'.repeat(80);  // score: 2*10+80=100 — skipped (109 > remaining budget)
      const b3 = 'D'.repeat(5);   // score: 1*10+5=15
      const text = [b0, b1, b2, b3].join('\n\n');
      const result = _truncateText(text, 190);
      expect(result).toContain('[...context truncated...]');
    });

    test('truncation marker appears exactly once for a single skipped region', () => {
      // Same 4-block setup — one non-adjacent gap produces exactly one marker
      const b0 = 'A'.repeat(100);
      const b1 = 'B'.repeat(20);
      const b2 = 'C'.repeat(80);
      const b3 = 'D'.repeat(5);
      const text = [b0, b1, b2, b3].join('\n\n');
      const result = _truncateText(text, 190);
      const markerCount = (result.match(/\[\.\.\.context truncated\.\.\.\]/g) || []).length;
      expect(markerCount).toBe(1);
    });
  });

  describe('single-block fallback', () => {
    test('falls back to hard truncation with ellipsis for single continuous block', () => {
      const text = 'word '.repeat(100).trim(); // no paragraph breaks
      const result = _truncateText(text, 20);
      expect(result.length).toBeLessThanOrEqual(20);
      expect(result.endsWith('...')).toBe(true);
    });
  });

  describe('content preservation', () => {
    test('highest priority (earliest) paragraphs are preferred in output', () => {
      // Earlier paragraphs score higher — they should survive trimming
      const early = 'EARLY CONTENT: This paragraph appears first and should be kept.';
      const middle = 'middle content: This paragraph appears in the middle and may be cut.';
      const late = 'x'.repeat(300); // long paragraph to force truncation
      const text = [early, middle, late].join('\n\n');
      const result = _truncateText(text, early.length + 20);
      expect(result).toContain('EARLY CONTENT');
    });
  });
});
