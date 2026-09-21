/**
 * F21 — one validated settings definition.
 *
 * Defaults and bounds were spread across config.json, config.js,
 * context-manager.js, options.js and the provider code, and did not agree.
 */
const { SCHEMA, validateSettings, describeSettings, orphanedSettings } = require('../settings-schema.js');

describe('settings validation', () => {
  test('clamps out-of-range values and REPORTS every correction', () => {
    const r = validateSettings({ testCount: 500, coverageTarget: 5, temperature: 9 });
    expect(r.settings.testCount).toBe(100);
    expect(r.settings.coverageTarget).toBe(40);
    expect(r.settings.temperature).toBe(2);
    // Silent clamping is how a user's setting stops meaning what it says.
    expect(r.corrections).toHaveLength(3);
  });

  test('a non-numeric value falls back to the default instead of NaN', () => {
    const r = validateSettings({ testCount: 'lots' });
    expect(r.settings.testCount).toBe(SCHEMA.testCount.default);
    expect(r.corrections.join(' ')).toMatch(/not a number/);
  });

  test('an unknown provider falls back rather than reaching the client', () => {
    const r = validateSettings({ llmProvider: 'grok' });
    expect(r.settings.llmProvider).toBe('openai');
    expect(r.corrections.join(' ')).toMatch(/not one of/);
  });

  test('string booleans from storage are coerced', () => {
    expect(validateSettings({ dedupeAgainstExistingSuite: 'true' }).settings.dedupeAgainstExistingSuite).toBe(true);
    expect(validateSettings({ dedupeAgainstExistingSuite: false }).settings.dedupeAgainstExistingSuite).toBe(false);
  });

  test('unknown keys are surfaced, not silently carried', () => {
    expect(validateSettings({ typoSettng: 1 }).unknown).toEqual(['typoSettng']);
  });

  test('every declared setting names the code path that consumes it', () => {
    // A control that reaches nothing is exactly the defect that made
    // dedupeAgainstExistingSuite unreachable for a whole release.
    expect(orphanedSettings()).toEqual([]);
  });

  test('secrets are marked so they are never logged', () => {
    const secrets = describeSettings().filter(s => s.secret).map(s => s.key);
    expect(secrets).toContain('jiraApiToken');
    expect(secrets).toContain('confluenceToken');
    expect(secrets).toContain('figmaToken');
    expect(secrets).toContain('testrailApiKey');
  });

  test('defaults are applied for absent settings', () => {
    const r = validateSettings({});
    expect(r.settings.coverageTarget).toBe(80);
    expect(r.settings.dedupThreshold).toBe(0.68);
    expect(r.corrections).toHaveLength(0);
  });
});
