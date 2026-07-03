/**
 * Tests for background-utils.js — pure logic extracted from the service worker.
 * Imports the real module; stubs the APP_CONFIG + securityManager globals that
 * validateSettings reads at call time.
 */
global.APP_CONFIG = {
  ERRORS: { NO_PROVIDER: 'Provider required', NO_MODEL: 'Model required', NO_API_KEY: 'API key required' },
};
global.securityManager = {
  validateApiKey: (key, provider) => {
    if (provider === 'bedrock') return /^A[KS]IA/.test(key) && key.length === 20;
    if (provider === 'claude') return key.startsWith('sk-ant-') && key.length > 30;
    return key.startsWith('sk-') && key.length > 20;
  },
};
const { validateSettings, round2, clampInt, rejectionBreakdown, deriveAdaptiveThresholds, formatTicketContextForPrompt, buildHistoricalJql } = require('../background-utils.js');

describe('buildHistoricalJql (F11)', () => {
  test('scopes to project + Bug + significant terms, excludes the ticket', () => {
    const jql = buildHistoricalJql({ key: 'PAY-123', summary: 'Refund processing fails for expired coupons' });
    expect(jql).toContain('project = "PAY"');
    expect(jql).toContain('issuetype = Bug');
    expect(jql).toContain('key != "PAY-123"');
    expect(jql).toMatch(/text ~ "refund"/i);
    expect(jql).toContain('ORDER BY created DESC');
  });
  test('returns empty string when there are no significant terms', () => {
    expect(buildHistoricalJql({ key: 'X-1', summary: 'the a to of' })).toBe('');
  });
  test('works without a project key', () => {
    const jql = buildHistoricalJql({ summary: 'checkout payment gateway timeout' });
    expect(jql).not.toContain('project =');
    expect(jql).toContain('issuetype = Bug');
  });
});

describe('formatTicketContextForPrompt (F1/F2/F4)', () => {
  test('includes description, AC, labels, components, priority', () => {
    const out = formatTicketContextForPrompt({
      summary: 'Login page', description: 'desc here', priority: 'High',
      labels: ['auth', 'p1'], components: ['Web'],
      acceptanceCriteria: 'AC-1 must work',
    });
    expect(out).toContain('**Description:** desc here');
    expect(out).toContain('AC-1 must work');
    expect(out).toContain('auth, p1');
    expect(out).toContain('Web');
    expect(out).toContain('High');
  });
  test('injects comment discussion text, not just a count (F1)', () => {
    const out = formatTicketContextForPrompt({
      description: 'd',
      comments: [{ author: 'Alice', text: 'the real edge case is empty email' }],
    });
    expect(out).toContain('Alice');
    expect(out).toContain('empty email');
  });
  test('lists linked issues with direction and key (F2)', () => {
    const out = formatTicketContextForPrompt({
      description: 'd',
      issueLinks: [{ type: 'blocks', key: 'PROJ-9', summary: 'old bug', status: 'Open' }],
    });
    expect(out).toContain('blocks PROJ-9');
    expect(out).toContain('old bug');
    expect(out).toContain('[Open]');
  });
  test('injects extracted document text (F4)', () => {
    const out = formatTicketContextForPrompt({
      description: 'd',
      documentAttachments: [{ fileName: 'spec.pdf', text: 'section 3 covers refunds' }],
    });
    expect(out).toContain('spec.pdf');
    expect(out).toContain('refunds');
  });
  test('clips a huge comment thread to a bounded size', () => {
    const comments = Array.from({ length: 200 }, (_, i) => ({ author: 'u', text: 'x'.repeat(500) + i }));
    const out = formatTicketContextForPrompt({ description: 'd', comments });
    // comment section budget is ~1800 chars; total stays well under 4k
    expect(out.length).toBeLessThan(4000);
  });
  test('omits sections that are absent', () => {
    const out = formatTicketContextForPrompt({ summary: 's', description: 'd' });
    expect(out).not.toContain('Linked Issues');
    expect(out).not.toContain('Comments');
    expect(out).not.toContain('Attached Documents');
  });
});

describe('validateSettings', () => {
  const ok = { llmProvider: 'openai', llmModel: 'gpt-4.1', apiKey: 'sk-' + 'a'.repeat(40) };
  test('passes a valid OpenAI config', () => {
    expect(() => validateSettings(ok)).not.toThrow();
  });
  test('throws on missing provider/model', () => {
    expect(() => validateSettings({ apiKey: ok.apiKey })).toThrow(/Provider required/);
    expect(() => validateSettings({ llmProvider: 'openai', apiKey: ok.apiKey })).toThrow(/Model required/);
  });
  test('throws on missing or malformed API key', () => {
    expect(() => validateSettings({ ...ok, apiKey: '' })).toThrow(/API key required/);
    expect(() => validateSettings({ ...ok, apiKey: 'nope' })).toThrow(/Invalid API key/);
  });
  test('bedrock requires access key id + secret', () => {
    expect(() => validateSettings({ llmProvider: 'bedrock', llmModel: 'claude', bedrockSecretKey: 's' }))
      .toThrow(/Access Key ID is required/);
    expect(() => validateSettings({ llmProvider: 'bedrock', llmModel: 'claude', bedrockAccessKeyId: 'AKIA' + '0'.repeat(16) }))
      .toThrow(/Secret Access Key is required/);
    expect(() => validateSettings({
      llmProvider: 'bedrock', llmModel: 'claude',
      bedrockAccessKeyId: 'AKIA' + '0'.repeat(16), bedrockSecretKey: 'secret',
    })).not.toThrow();
  });
});

describe('round2 / clampInt', () => {
  test('round2 keeps two decimals', () => {
    expect(round2(0.6789)).toBe(0.68);
    expect(round2(1)).toBe(1);
  });
  test('clampInt parses and bounds', () => {
    expect(clampInt('50', 40, 100)).toBe(50);
    expect(clampInt(5, 40, 100)).toBe(40);
    expect(clampInt(500, 40, 100)).toBe(100);
    expect(clampInt('abc', 40, 100)).toBe(40);
  });
});

describe('rejectionBreakdown', () => {
  test('counts rejections by stage', () => {
    const out = rejectionBreakdown([
      { stage: 'grounding' }, { stage: 'dedup' }, { stage: 'grounding' },
    ]);
    expect(out).toEqual({ grounding: 2, dedup: 1 });
  });
  test('handles empty/undefined', () => {
    expect(rejectionBreakdown()).toEqual({});
    expect(rejectionBreakdown([])).toEqual({});
  });
});

describe('deriveAdaptiveThresholds', () => {
  test('explicit settings win', () => {
    const r = deriveAdaptiveThresholds({}, null, { dedupThreshold: 0.5, relevanceThreshold: 0.4 });
    expect(r.dedupThreshold).toBe(0.5);
    expect(r.relevanceThreshold).toBe(0.4);
  });
  test('no KG raises relevance vs a rich KG', () => {
    const ticket = { description: 'word '.repeat(100) };
    const noKg = deriveAdaptiveThresholds(ticket, null, {});
    const richKg = deriveAdaptiveThresholds(ticket, { forms: Array(20), apis: Array(20), features: Array(20) }, {});
    expect(noKg.relevanceThreshold).toBeGreaterThan(richKg.relevanceThreshold);
  });
  test('small test budget tightens dedup; thresholds stay in bounds', () => {
    const r = deriveAdaptiveThresholds({ description: 'x '.repeat(60) }, null, { testCount: 20 });
    expect(r.dedupThreshold).toBeGreaterThanOrEqual(0.6);
    expect(r.dedupThreshold).toBeLessThanOrEqual(0.78);
    expect(r.relevanceThreshold).toBeGreaterThanOrEqual(0.15);
    expect(r.relevanceThreshold).toBeLessThanOrEqual(0.35);
  });
});
