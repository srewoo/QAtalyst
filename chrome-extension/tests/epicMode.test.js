/**
 * Tests for epic-mode.js — per-child-story test generation for a Jira Epic.
 * Pure helpers + the dependency-injected orchestration (no chrome/DOM needed).
 */
const EpicMode = require('../epic-mode.js');

describe('isEpicIssue', () => {
  test('detects Epic across issueType / issuetype casing', () => {
    expect(EpicMode.isEpicIssue({ issueType: 'Epic' })).toBe(true);
    expect(EpicMode.isEpicIssue({ issuetype: 'epic' })).toBe(true);
    expect(EpicMode.isEpicIssue({ issueType: 'Story' })).toBe(false);
    expect(EpicMode.isEpicIssue({})).toBe(false);
    expect(EpicMode.isEpicIssue(null)).toBe(false);
  });
});

describe('buildEpicChildrenJQL', () => {
  test('queries both parent and Epic Link, and sanitizes the key', () => {
    const jql = EpicMode.buildEpicChildrenJQL('ABC-123');
    expect(jql).toContain('parent = "ABC-123"');
    expect(jql).toContain('"Epic Link" = "ABC-123"');
    // No injection via quotes/backslashes
    expect(EpicMode.buildEpicChildrenJQL('A"B\\C')).not.toMatch(/["\\]{2}/);
  });
});

describe('buildEpicHeader + prepareChildTicketData (context management)', () => {
  test('header includes key + summary and clips long epic descriptions', () => {
    const header = EpicMode.buildEpicHeader({ key: 'EP-1', summary: 'Billing revamp', description: 'x'.repeat(5000) });
    expect(header).toContain('[EP-1]');
    expect(header).toContain('Billing revamp');
    expect(header).toMatch(/truncated/);
  });

  test('child description folds in the epic header and clips its own body', () => {
    const header = EpicMode.buildEpicHeader({ key: 'EP-1', summary: 'Billing', description: 'pay' });
    const child = EpicMode.prepareChildTicketData({ key: 'EP-2', summary: 'Add card', description: 'y'.repeat(9000) }, header);
    expect(child.description).toContain('Parent Epic [EP-1] Billing');
    expect(child.description).toContain('--- Story ---');
    expect(child.description).toMatch(/truncated/);
    expect(child._epicChild).toBe(true);
    expect(child.key).toBe('EP-2'); // child identity preserved
  });
});

describe('perChildTestCount', () => {
  test('splits the total across children within floor/ceiling', () => {
    expect(EpicMode.perChildTestCount(50, 5)).toBe(10);
    expect(EpicMode.perChildTestCount(200, 2)).toBe(25);  // capped at max 25
    expect(EpicMode.perChildTestCount(undefined, 3)).toBe(10); // default total 30
  });

  test('F13: the configured total is a real global bound', () => {
    // Previously the min-8 floor won unconditionally, so a 20-story epic with a
    // total of 50 generated at least 160 tests — the setting bounded nothing.
    const perChild = EpicMode.perChildTestCount(50, 20);
    expect(perChild * 20).toBeLessThanOrEqual(50 + 20); // within one-per-child rounding
    expect(perChild).toBeGreaterThanOrEqual(1);
  });

  test('F13: the floor still applies when the budget can afford it', () => {
    // 5 stories out of 100 → share 20, capped by max; a small share is lifted to
    // the usable minimum only while the total allows it.
    expect(EpicMode.perChildTestCount(40, 5)).toBe(8);
  });
});

describe('runWithConcurrency', () => {
  test('runs all items and never exceeds the concurrency limit', async () => {
    let inFlight = 0, peak = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    const out = await EpicMode.runWithConcurrency(items, 3, async (n) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(out.map((r) => r.value)).toEqual(items.map((n) => n * 2));
  });

  test('isolates failures — one rejection does not abort the rest', async () => {
    const out = await EpicMode.runWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    });
    expect(out[0]).toEqual({ status: 'fulfilled', value: 1 });
    expect(out[1].status).toBe('rejected');
    expect(out[2]).toEqual({ status: 'fulfilled', value: 3 });
  });
});

describe('truncateKeepingLinks (external-doc context survives truncation)', () => {
  test('preserves a Figma/Confluence/Docs link past the cut point', () => {
    const text = 'x'.repeat(50) + ' see https://www.figma.com/file/ABC/Spec and https://mt.atlassian.net/wiki/spaces/X/pages/1';
    const out = EpicMode.truncateKeepingLinks(text, 30);
    expect(out).toContain('truncated');
    expect(out).toContain('https://www.figma.com/file/ABC/Spec');
    expect(out).toContain('https://mt.atlassian.net/wiki/spaces/X/pages/1');
  });
  test('does not duplicate a link already within the kept head', () => {
    const text = 'https://docs.google.com/document/d/123 ' + 'y'.repeat(100);
    const out = EpicMode.truncateKeepingLinks(text, 60);
    expect(out.match(/docs\.google\.com\/document\/d\/123/g)).toHaveLength(1);
  });
  test('extractDocLinks only returns external-doc URLs', () => {
    const links = EpicMode.extractDocLinks('a https://example.com/x b https://www.figma.com/design/Z c');
    expect(links).toEqual(['https://www.figma.com/design/Z']);
  });
});

describe('foldChildContext (comments + issue-links + web links)', () => {
  test('folds comments, linked issues, and web links into the description', () => {
    const out = EpicMode.foldChildContext({
      key: 'EP-2', summary: 'Add card', description: 'Story body',
      comments: [{ author: 'Sam', text: 'see https://www.figma.com/file/Z/Spec' }],
      issueLinks: [{ key: 'EP-9', summary: 'Blocker', type: 'is blocked by' }],
      remoteLinks: [{ title: 'Design', url: 'https://mt.atlassian.net/wiki/spaces/A/pages/5' }],
    });
    expect(out.description).toContain('Story body');
    expect(out.description).toContain('--- Comments ---');
    expect(out.description).toContain('Sam: see https://www.figma.com/file/Z/Spec');
    expect(out.description).toContain('--- Linked Issues ---');
    expect(out.description).toContain('is blocked by EP-9: Blocker');
    expect(out.description).toContain('--- Web Links ---');
    expect(out.description).toContain('https://mt.atlassian.net/wiki/spaces/A/pages/5');
  });

  test('leaves description unchanged when there is no extra context', () => {
    const out = EpicMode.foldChildContext({ key: 'EP-3', description: 'just body' });
    expect(out.description).toBe('just body');
  });
});

describe('filterSelectedChildren (selection modal)', () => {
  const children = [
    { key: 'EP-2', summary: 'a' },
    { key: 'EP-3', summary: 'b' },
    { key: 'EP-4', summary: 'c' },
  ];
  test('keeps only selected keys, preserving original order', () => {
    const out = EpicMode.filterSelectedChildren(children, new Set(['EP-4', 'EP-2']));
    expect(out.map((c) => c.key)).toEqual(['EP-2', 'EP-4']);
  });
  test('accepts an array of keys and tolerates empty/missing input', () => {
    expect(EpicMode.filterSelectedChildren(children, ['EP-3']).map((c) => c.key)).toEqual(['EP-3']);
    expect(EpicMode.filterSelectedChildren(children, [])).toEqual([]);
    expect(EpicMode.filterSelectedChildren(null, ['EP-2'])).toEqual([]);
  });
});

describe('buildEpicRollupTicketData (rollup for analyse/scope)', () => {
  const epic = { key: 'EP-1', summary: 'Checkout revamp', description: 'Improve checkout' };
  const children = [
    { key: 'EP-2', summary: 'Cart', description: 'cart desc' },
    { key: 'EP-3', summary: 'Pay', description: 'pay desc' },
  ];

  test('produces one synthetic ticket folding the epic + all children', () => {
    const rollup = EpicMode.buildEpicRollupTicketData(epic, children);
    expect(rollup.key).toBe('EP-1');
    expect(rollup._epicRollup).toBe(true);
    expect(rollup._childKeys).toEqual(['EP-2', 'EP-3']);
    expect(rollup.description).toContain('Parent Epic [EP-1] Checkout revamp');
    expect(rollup.description).toContain('Child Stories (2)');
    expect(rollup.description).toContain('EP-2 — Cart');
    expect(rollup.description).toContain('EP-3 — Pay');
  });

  test('caps total size and notes omitted stories', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ key: `EP-${i}`, summary: 's', description: 'x'.repeat(1000) }));
    const rollup = EpicMode.buildEpicRollupTicketData(epic, many, { overallMax: 5000 });
    expect(rollup.description.length).toBeLessThan(8000);
    expect(rollup.description).toMatch(/more stories omitted/);
    expect(rollup._childKeys).toHaveLength(100); // identity preserved even if body trimmed
  });
});

describe('generateEpicTestCases (orchestration)', () => {
  const epic = { key: 'EP-1', summary: 'Checkout', description: 'Revamp checkout' };

  test('generates per child in parallel and aggregates results', async () => {
    const children = [
      { key: 'EP-2', summary: 'Cart', description: 'cart' },
      { key: 'EP-3', summary: 'Pay', description: 'pay' },
    ];
    const seenDescs = [];
    const out = await EpicMode.generateEpicTestCases(epic, {
      fetchEpicChildren: async () => children,
      concurrency: 2,
      generateForChild: async (childData) => {
        seenDescs.push(childData.description);
        return { testCases: [{ id: 't1' }, { id: 't2' }] };
      },
    });
    expect(out.epicKey).toBe('EP-1');
    expect(out.results).toHaveLength(2);
    expect(out.summary).toMatchObject({ stories: 2, failed: 0, totalTests: 4 });
    // Each child call received the epic header in its description.
    expect(seenDescs.every((d) => d.includes('Parent Epic [EP-1] Checkout'))).toBe(true);
  });

  test('reports per-child failures without failing the whole run', async () => {
    const children = [{ key: 'EP-2', description: 'a' }, { key: 'EP-3', description: 'b' }];
    const out = await EpicMode.generateEpicTestCases(epic, {
      fetchEpicChildren: async () => children,
      generateForChild: async (childData) => {
        if (childData.key === 'EP-2') throw new Error('rate limited');
        return { testCases: [{ id: 't1' }] };
      },
    });
    expect(out.summary).toMatchObject({ stories: 1, failed: 1, totalTests: 1 });
    const failed = out.results.find((r) => r.child.key === 'EP-2');
    expect(failed.ok).toBe(false);
    expect(failed.error).toMatch(/rate limited/);
  });

  test('handles an epic with no children gracefully', async () => {
    const out = await EpicMode.generateEpicTestCases(epic, {
      fetchEpicChildren: async () => [],
      generateForChild: async () => ({ testCases: [] }),
    });
    expect(out.children).toEqual([]);
    expect(out.summary).toEqual({ stories: 0, failed: 0, totalTests: 0 });
  });
});

describe('F13 — global epic consolidation', () => {
  const SemanticDuplicateDetector = require('../semantic-duplicate-detector.js');
  const DEPS = { Detector: SemanticDuplicateDetector };

  const loginCase = (story) => ({
    id: `${story}-1`, title: 'User logs in before starting', category: 'Functional',
    steps: ['Open the login page', 'Enter valid credentials', 'Click Login'],
    expected_result: 'The dashboard is displayed'
  });

  test('three stories needing the same prerequisite do not yield three tests', () => {
    const out = EpicMode.consolidateEpicSuite([
      { child: { key: 'EP-1' }, testCases: [loginCase('a')] },
      { child: { key: 'EP-2' }, testCases: [loginCase('b')] },
      { child: { key: 'EP-3' }, testCases: [loginCase('c')] }
    ], DEPS);

    // Pre-fix: children were gated independently and simply concatenated.
    expect(out.testCases).toHaveLength(1);
    expect(out.merged).toHaveLength(2);
  });

  test('a shared case keeps every story it covers', () => {
    const out = EpicMode.consolidateEpicSuite([
      { child: { key: 'EP-1' }, testCases: [loginCase('a')] },
      { child: { key: 'EP-2' }, testCases: [loginCase('b')] }
    ], DEPS);
    // Coverage IS the link set — dropping it would silently uncover EP-2.
    expect(out.testCases[0]._stories.sort()).toEqual(['EP-1', 'EP-2']);
    expect(out.perChild.after['EP-1']).toBe(1);
    expect(out.perChild.after['EP-2']).toBe(1);
  });

  test('different permissions across children survive consolidation', () => {
    const out = EpicMode.consolidateEpicSuite([
      { child: { key: 'EP-1' }, testCases: [{
        title: 'Owner deletes the record', steps: ['Log in as Owner', 'Click Delete'],
        expected_result: 'The record is deleted' }] },
      { child: { key: 'EP-2' }, testCases: [{
        title: 'Viewer deletes the record', steps: ['Log in as Viewer', 'Click Delete'],
        expected_result: 'Deletion is denied' }] }
    ], DEPS);
    expect(out.testCases).toHaveLength(2);
    expect(out.merged).toHaveLength(0);
  });

  test('per-child counts are reported before and after merging', () => {
    const out = EpicMode.consolidateEpicSuite([
      { child: { key: 'EP-1' }, testCases: [loginCase('a'), { title: 'Unique to EP-1', steps: ['Click Export'], expected_result: 'Exported' }] },
      { child: { key: 'EP-2' }, testCases: [loginCase('b')] }
    ], DEPS);
    expect(out.perChild.before).toEqual({ 'EP-1': 2, 'EP-2': 1 });
    // EP-2's coverage moved onto the shared case rather than disappearing.
    expect(out.perChild.after['EP-2']).toBe(1);
  });

  test('degrades safely with no detector available', () => {
    const out = EpicMode.consolidateEpicSuite(
      [{ child: { key: 'EP-1' }, testCases: [loginCase('a')] }], { Detector: null });
    expect(out.testCases).toHaveLength(1);
    expect(out.merged).toEqual([]);
  });
});
