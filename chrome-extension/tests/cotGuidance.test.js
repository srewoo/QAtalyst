/**
 * Tests for BaseAgent.getCoTGuidance.
 * CoT guidance is injected into every test agent's user message.
 * These tests verify that the right reasoning depth is selected for each complexity level.
 */

// ---------------------------------------------------------------------------
// Inline the pure function under test
// ---------------------------------------------------------------------------
function getCoTGuidance(complexity) {
  const level = typeof complexity === 'string' ? complexity : (complexity?.level || 'medium');

  if (level === 'simple') {
    return `
**REASONING CHECKLIST (complete before generating tests):**
1. Identify the 2-3 core requirements from the story
2. For each: define the success path and the most likely failure path
3. Confirm every generated test maps directly to one of these requirements`;
  }

  if (level === 'complex') {
    return `
**REASONING PROCESS — MANDATORY FOR COMPLEX TICKETS (complete each step before generating):**
1. **Requirement extraction:** List every explicit AND implicit testable requirement (look for "must", "shall", bullets, Given/When/Then)
2. **User journey mapping:** Identify all user roles/personas and their distinct end-to-end journeys through this feature
3. **Integration dependency tree:** List every external service, API, or system involved and enumerate what can independently fail for each
4. **State machine analysis:** Enumerate all states the primary entity can be in and which state transitions are valid vs. invalid
5. **Boundary identification:** Find all numeric limits, time constraints, permission tiers, and data size ceilings
6. **Concurrency risks:** Identify scenarios where two actors or background processes could collide (double-submit, race conditions, stale locks)
7. **Coverage gap check:** Before submitting, verify every finding from steps 1-6 has at least one concrete test case`;
  }

  return `
**REASONING CHECKLIST (complete before generating tests):**
1. **Requirements scan:** List every "should/must/will" statement and acceptance criterion as a testable requirement
2. **Persona analysis:** Identify all user roles and their specific allowed vs. blocked actions
3. **Integration check:** List all APIs, services, or external systems this feature touches and what can fail
4. **For each requirement:** Consider happy path → failure path → boundary condition
5. **Coverage check:** Confirm every requirement from step 1 has at least one test before submitting`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('getCoTGuidance', () => {
  describe('input variants', () => {
    test('accepts string level directly', () => {
      const result = getCoTGuidance('simple');
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    test('accepts complexity object { level }', () => {
      const result = getCoTGuidance({ level: 'medium', score: 7 });
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    test('defaults to medium when complexity is null', () => {
      const nullResult = getCoTGuidance(null);
      const mediumResult = getCoTGuidance('medium');
      expect(nullResult).toBe(mediumResult);
    });

    test('defaults to medium when complexity is undefined', () => {
      const undefResult = getCoTGuidance(undefined);
      const mediumResult = getCoTGuidance('medium');
      expect(undefResult).toBe(mediumResult);
    });
  });

  describe('guidance depth scales with complexity', () => {
    test('complex guidance is longer than medium guidance', () => {
      expect(getCoTGuidance('complex').length).toBeGreaterThan(getCoTGuidance('medium').length);
    });

    test('medium guidance is longer than simple guidance', () => {
      expect(getCoTGuidance('medium').length).toBeGreaterThan(getCoTGuidance('simple').length);
    });

    test('complex guidance has 7 numbered steps', () => {
      const guidance = getCoTGuidance('complex');
      // Count "N. " patterns at line start
      const steps = guidance.match(/^\s*\d+\.\s/gm) || [];
      expect(steps.length).toBe(7);
    });

    test('medium guidance has 5 numbered steps', () => {
      const guidance = getCoTGuidance('medium');
      const steps = guidance.match(/^\s*\d+\.\s/gm) || [];
      expect(steps.length).toBe(5);
    });

    test('simple guidance has 3 numbered steps', () => {
      const guidance = getCoTGuidance('simple');
      const steps = guidance.match(/^\s*\d+\.\s/gm) || [];
      expect(steps.length).toBe(3);
    });
  });

  describe('guidance content appropriateness', () => {
    test('complex guidance mentions concurrency risks', () => {
      expect(getCoTGuidance('complex').toLowerCase()).toContain('concurren');
    });

    test('complex guidance mentions state machine', () => {
      expect(getCoTGuidance('complex').toLowerCase()).toContain('state');
    });

    test('complex guidance mentions integration dependency', () => {
      expect(getCoTGuidance('complex').toLowerCase()).toContain('integration');
    });

    test('medium guidance mentions persona/role analysis', () => {
      expect(getCoTGuidance('medium').toLowerCase()).toContain('persona');
    });

    test('simple guidance focuses on core requirements only', () => {
      const guidance = getCoTGuidance('simple');
      expect(guidance.toLowerCase()).toContain('core requirements');
      // Should NOT mention concurrency or state machine for simple tickets
      expect(guidance.toLowerCase()).not.toContain('concurren');
      expect(guidance.toLowerCase()).not.toContain('state machine');
    });

    test('all guidance levels include instruction to check coverage before submitting', () => {
      ['simple', 'medium', 'complex'].forEach(level => {
        const guidance = getCoTGuidance(level);
        // Each should remind the model to verify coverage
        expect(guidance.toLowerCase()).toMatch(/confirm|verify|check|coverage/);
      });
    });
  });

  describe('string output format', () => {
    test('starts with a newline for clean injection into prompts', () => {
      ['simple', 'medium', 'complex'].forEach(level => {
        expect(getCoTGuidance(level).startsWith('\n')).toBe(true);
      });
    });

    test('different levels produce different strings', () => {
      const s = getCoTGuidance('simple');
      const m = getCoTGuidance('medium');
      const c = getCoTGuidance('complex');
      expect(s).not.toBe(m);
      expect(m).not.toBe(c);
      expect(s).not.toBe(c);
    });
  });
});
