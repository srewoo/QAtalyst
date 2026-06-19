/**
 * Tests for parseRobustJSON and extractCompleteObjectsFromArray — the last line
 * of defence against malformed LLM JSON output. These import the REAL shipped
 * module (json-parser.js) so the tests can never drift from production behaviour.
 */
const { parseRobustJSON, extractCompleteObjectsFromArray } = require('../json-parser.js');

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
