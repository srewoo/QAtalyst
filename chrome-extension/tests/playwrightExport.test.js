/**
 * Step parsing (shared by the exporter and the in-app runner) and Playwright export.
 * The behavioural proof is `npm run test:export`, which runs a generated spec
 * against a local app; these pin the parsing rules.
 */
const { parseStep, parseExpected, parseTestCase, selectorIndex } = require('../test-steps.js');
const { exportPlaywrightSpec } = require('../playwright-export.js');

describe('parseStep', () => {
  test.each([
    ['Click "Sign In"', { kind: 'click', target: 'Sign In' }],
    ['Type "a@b.co" in the "Email" field', { kind: 'fill', target: 'Email', value: 'a@b.co' }],
    ['Type a valid address in the email field', { kind: 'fill', target: 'email', value: null }],
    ['Select "Editor" in the "Role" dropdown', { kind: 'select', target: 'Role', value: 'Editor' }],
    ['Tick the "Terms" checkbox', { kind: 'check', target: 'Terms' }],
    ['Untick the "Terms" checkbox', { kind: 'uncheck', target: 'Terms' }],
    ['Open https://app.example.com/members', { kind: 'goto', url: 'https://app.example.com/members' }],
    ['Wait for the page to settle', { kind: 'manual' }]
  ])('%s', (step, expected) => {
    expect(parseStep(step)).toMatchObject(expected);
  });
});

describe('parseExpected and automation level', () => {
  test('API status, URL change and quoted text become assertions', () => {
    const e = parseExpected('"Saved" is shown, the user lands on /settings and PATCH /api/me returns 200');
    expect(e.assertions).toEqual(expect.arrayContaining([
      { kind: 'api', method: 'PATCH', path: '/api/me', status: 200 },
      { kind: 'url', path: '/settings' },
      { kind: 'text', value: 'Saved' }]));
  });

  test('full, partial and none are distinguished honestly', () => {
    const base = { preconditions: 'On https://a.b/login' };
    expect(parseTestCase({ ...base, steps: ['Click "Go"'], expected_result: '"Done" is shown' }).automation).toBe('full');
    expect(parseTestCase({ ...base, steps: ['Type a name in the "Name" field'], expected_result: '"Done" is shown' }).automation).toBe('partial');
    expect(parseTestCase({ ...base, steps: ['Click "Go"'], expected_result: 'It works well' }).automation).toBe('none');
  });

  test('only stable crawl selectors are used', () => {
    const idx = selectorIndex({ pages: [{ features: [
      { type: 'button', text: 'Save', selector: '#save' },
      { type: 'button', text: 'Cancel', selector: 'div.footer > button.btn' },
      { type: 'form', fields: [{ name: 'email', label: 'Email', selector: '[data-testid="email"]' }] }] }] });
    expect([...idx.entries()]).toEqual([['save', '#save'], ['email', '[data-testid="email"]']]);
  });
});

describe('exportPlaywrightSpec', () => {
  const tests = [
    { id: 'T-01', title: 'Save works', category: 'Positive', priority: 'P1', preconditions: 'On https://a.b/settings',
      steps: ['Type "Ada" in the "Name" field', 'Click "Save"'], expected_result: '"Saved" is shown' },
    { id: 'T-02', title: 'Feels fast', category: 'Edge', steps: ['Use the app'], expected_result: 'It feels fast' }
  ];
  const { source, stats, filename } = exportPlaywrightSpec(tests, { ticketKey: 'ABC-1', knowledgeGraph:
    { pages: [{ features: [{ type: 'button', text: 'Save', selector: '#save' }] }] } });

  test('emits runnable code with stable selectors and honest fixme', () => {
    expect(filename).toBe('ABC-1.spec.js');
    expect(stats).toEqual({ full: 1, partial: 0, none: 1 });
    expect(source).toContain('await page.goto("https://a.b/settings");');
    expect(source).toContain('await field(page, "Name").fill("Ada");');
    expect(source).toContain('await page.locator("#save").click();');
    expect(source).toContain('await expect(page.getByText("Saved").first()).toBeVisible();');
    expect(source).toMatch(/test\.fixme\(true, "No automatable assertion: It feels fast"\)/);
  });

  test('the generated source is valid JavaScript', () => {
    expect(() => new Function('require', 'process', source)).not.toThrow();
  });
});
