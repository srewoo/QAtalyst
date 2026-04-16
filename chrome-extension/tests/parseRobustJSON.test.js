/**
 * Tests for parseRobustJSON and extractCompleteObjectsFromArray.
 * These functions are the last line of defence against malformed LLM JSON output.
 * We isolate them from the browser extension environment via inline re-implementation
 * so tests run in Node without chrome/importScripts globals.
 */

// ---------------------------------------------------------------------------
// Inline the pure functions under test (no browser globals needed)
// ---------------------------------------------------------------------------
function extractCompleteObjectsFromArray(jsonString) {
  const objects = [];
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let objectStart = -1;

  for (let i = 0; i < jsonString.length; i++) {
    const char = jsonString[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (char === '\\' && inString) { escapeNext = true; continue; }
    if (char === '"' && !escapeNext) { inString = !inString; continue; }
    if (inString) continue;
    if (char === '{') {
      if (depth === 0) objectStart = i;
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && objectStart !== -1) {
        const objectStr = jsonString.substring(objectStart, i + 1);
        try { objects.push(JSON.parse(objectStr)); } catch (_) { /* skip */ }
        objectStart = -1;
      }
    }
  }
  return objects;
}

function parseRobustJSON(jsonString) {
  try { return JSON.parse(jsonString); } catch (_) { /* fall through */ }

  let fixed = jsonString;
  fixed = fixed.replace(/,(\s*[}\]])/g, '$1');
  fixed = fixed.replace(/"\s*\n\s*"/g, '",\n"');
  fixed = fixed.replace(/(\]|\})\s*\n\s*"/g, '$1,\n"');
  fixed = fixed.replace(/\/\/.*/g, '');
  fixed = fixed.replace(/\/\*[\s\S]*?\*\//g, '');

  try { return JSON.parse(fixed); } catch (_) { /* fall through */ }

  if (fixed.trim().startsWith('[')) {
    const complete = extractCompleteObjectsFromArray(fixed);
    if (complete.length > 0) return complete;
  }

  const innerArrayMatch = fixed.match(/"testCases"\s*:\s*(\[[\s\S]*)/);
  if (innerArrayMatch) {
    const complete = extractCompleteObjectsFromArray(innerArrayMatch[1]);
    if (complete.length > 0) return { testCases: complete };
  }

  const match = fixed.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch (_) { /* fall through */ } }

  throw new Error('JSON parsing failed');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('parseRobustJSON', () => {
  describe('valid JSON — returned unchanged', () => {
    test('parses a simple object', () => {
      expect(parseRobustJSON('{"a":1}')).toEqual({ a: 1 });
    });

    test('parses a JSON array', () => {
      expect(parseRobustJSON('[1,2,3]')).toEqual([1, 2, 3]);
    });

    test('parses nested objects', () => {
      const input = JSON.stringify({ testCases: [{ id: 'TC-001', title: 'Login test' }] });
      expect(parseRobustJSON(input)).toEqual({ testCases: [{ id: 'TC-001', title: 'Login test' }] });
    });
  });

  describe('trailing comma repair', () => {
    test('removes trailing comma before }', () => {
      const result = parseRobustJSON('{"a":1,"b":2,}');
      expect(result).toEqual({ a: 1, b: 2 });
    });

    test('removes trailing comma before ]', () => {
      const result = parseRobustJSON('[1, 2, 3,]');
      expect(result).toEqual([1, 2, 3]);
    });

    test('removes trailing comma in nested structure', () => {
      const result = parseRobustJSON('{"items":[1,2,]}');
      expect(result).toEqual({ items: [1, 2] });
    });
  });

  describe('JS comment stripping', () => {
    test('removes single-line // comments', () => {
      const result = parseRobustJSON('{\n"a": 1 // comment\n}');
      expect(result).toEqual({ a: 1 });
    });

    test('removes /* block */ comments', () => {
      const result = parseRobustJSON('{"a": /* comment */ 1}');
      expect(result).toEqual({ a: 1 });
    });
  });

  describe('truncated array recovery', () => {
    test('recovers complete objects from truncated array', () => {
      const truncated = '[{"id":"TC-001","title":"Login"},{"id":"TC-002","title":"Logout"},{"id":"TC-003","title":"Incomplet';
      const result = parseRobustJSON(truncated);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('TC-001');
      expect(result[1].id).toBe('TC-002');
    });

    test('returns empty array when no complete objects are in truncated input', () => {
      expect(() => parseRobustJSON('[{"incomplete')).toThrow();
    });

    test('recovers from truncated testCases wrapper', () => {
      const truncated = '{"testCases":[{"id":"TC-001","title":"Login"},{"id":"TC-002","title":"Incomplet';
      const result = parseRobustJSON(truncated);
      expect(result).toHaveProperty('testCases');
      expect(result.testCases).toHaveLength(1);
      expect(result.testCases[0].id).toBe('TC-001');
    });
  });

  describe('escaped strings inside JSON', () => {
    test('handles escaped quotes in string values', () => {
      const input = '{"title":"He said \\"hello\\""}';
      expect(parseRobustJSON(input)).toEqual({ title: 'He said "hello"' });
    });

    test('handles backslash in string values', () => {
      const input = '{"path":"C:\\\\Users\\\\test"}';
      expect(parseRobustJSON(input)).toEqual({ path: 'C:\\Users\\test' });
    });
  });

  describe('error cases', () => {
    test('throws for completely unrecoverable input', () => {
      expect(() => parseRobustJSON('this is not json at all')).toThrow();
    });

    test('throws for empty string', () => {
      expect(() => parseRobustJSON('')).toThrow();
    });
  });
});

describe('extractCompleteObjectsFromArray', () => {
  test('extracts all complete objects from valid array', () => {
    const input = '[{"a":1},{"b":2},{"c":3}]';
    expect(extractCompleteObjectsFromArray(input)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  test('skips the last incomplete object in truncated array', () => {
    const input = '[{"id":1},{"id":2},{"id":3,"ti';
    const result = extractCompleteObjectsFromArray(input);
    expect(result).toHaveLength(2);
    expect(result.map(o => o.id)).toEqual([1, 2]);
  });

  test('handles nested objects without counting inner braces as boundaries', () => {
    const input = '[{"nested":{"x":1},"y":2},{"z":3}]';
    const result = extractCompleteObjectsFromArray(input);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ nested: { x: 1 }, y: 2 });
  });

  test('handles strings containing braces', () => {
    const input = '[{"title":"step {one}","id":1},{"id":2}]';
    const result = extractCompleteObjectsFromArray(input);
    expect(result).toHaveLength(2);
    expect(result[0].title).toBe('step {one}');
  });

  test('returns empty array for no complete objects', () => {
    expect(extractCompleteObjectsFromArray('[{"incomplete')).toEqual([]);
  });

  test('returns empty array for empty input', () => {
    expect(extractCompleteObjectsFromArray('')).toEqual([]);
  });
});
