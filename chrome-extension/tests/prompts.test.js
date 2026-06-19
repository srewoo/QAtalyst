/**
 * Tests for prompts.js — static system prompts extracted from background.js.
 * Imports the real module so the prompts can't silently drift.
 */
const PROMPTS = require('../prompts.js');

describe('prompts.js builders', () => {
  test('exposes the three system-prompt builders', () => {
    expect(typeof PROMPTS.analyzeSystem).toBe('function');
    expect(typeof PROMPTS.testScopeSystem).toBe('function');
    expect(typeof PROMPTS.testCasesSystem).toBe('function');
  });

  test('analyzeSystem is the requirements-analyst prompt with the quality sections', () => {
    const p = PROMPTS.analyzeSystem();
    expect(p.length).toBeGreaterThan(500);
    expect(p).toMatch(/business analyst/i);
    expect(p).toMatch(/REQUIREMENT GAPS|AMBIGUIT|TESTABILITY/i);
  });

  test('testScopeSystem is the test-scope architect prompt', () => {
    const p = PROMPTS.testScopeSystem();
    expect(p.length).toBeGreaterThan(50);
    expect(p).toMatch(/test (architect|scope)/i);
  });

  test('testCasesSystem is the test-case generation prompt', () => {
    const p = PROMPTS.testCasesSystem();
    expect(p.length).toBeGreaterThan(50);
    expect(p).toMatch(/test cases?/i);
  });

  test('builders are pure — same output each call', () => {
    expect(PROMPTS.analyzeSystem()).toBe(PROMPTS.analyzeSystem());
  });
});
