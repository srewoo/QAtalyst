/**
 * @vitest-environment happy-dom
 *
 * Tests for content-format.js — the text/markdown formatting + safe-DOM builder
 * helpers extracted from the Jira content script. Imports the REAL module; the
 * escape/builder helpers need a DOM, hence happy-dom.
 */
const {
  escapeHtml,
  createSafeErrorMessage,
  createSafeFormattedContent,
  formatStreamingContent,
  renderMarkdown,
  inlineMarkdown,
  formatAnalysis,
  formatTestScope,
} = require('../content-format.js');

describe('escapeHtml', () => {
  test('neutralises angle brackets / script tags', () => {
    expect(escapeHtml('<script>alert(1)</script>'))
      .toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
  test('leaves plain text untouched', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});

describe('createSafeErrorMessage', () => {
  test('prefixes the cross mark and uses textContent (no HTML injection)', () => {
    const el = createSafeErrorMessage('<b>boom</b>');
    expect(el.className).toBe('qatalyst-error');
    expect(el.textContent).toContain('❌');
    expect(el.textContent).toContain('<b>boom</b>'); // literal, not parsed
    expect(el.querySelector('b')).toBeNull();
  });
  test('splits multi-line messages with <br> elements', () => {
    const el = createSafeErrorMessage('line1\nline2\nline3');
    expect(el.querySelectorAll('br').length).toBe(2);
  });
});

describe('createSafeFormattedContent', () => {
  test('renders **bold** as <strong> without parsing other html', () => {
    const el = createSafeFormattedContent('hello **world**');
    const strong = el.querySelector('strong');
    expect(strong).not.toBeNull();
    expect(strong.textContent).toBe('world');
  });
  test('converts leading "- " to a bullet', () => {
    const el = createSafeFormattedContent('- item one');
    expect(el.textContent).toContain('• item one');
  });
});

describe('formatStreamingContent', () => {
  test('escapes first then applies bold, bullets and line breaks', () => {
    const out = formatStreamingContent('<x>**b**\n- a');
    expect(out).toContain('&lt;x&gt;');
    expect(out).toContain('<strong>b</strong>');
    expect(out).toContain('• a');
    expect(out).toContain('<br>');
  });
  test('handles null safely', () => {
    expect(formatStreamingContent(null)).toBe('');
  });
});

describe('renderMarkdown', () => {
  test('returns empty string for null', () => {
    expect(renderMarkdown(null)).toBe('');
  });
  test('escapes raw html in the source (XSS-safe)', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });
  test('renders headings, lists and fenced code', () => {
    expect(renderMarkdown('# Title')).toContain('<h1 class="qa-md-h">Title</h1>');
    expect(renderMarkdown('- a\n- b')).toContain('<ul class="qa-md-list">');
    expect(renderMarkdown('1. a\n2. b')).toContain('<ol class="qa-md-list">');
    const code = renderMarkdown('```\nx=1\n```');
    expect(code).toContain('<pre class="qa-md-code">');
    expect(code).toContain('x=1');
  });
  test('renders GFM pipe tables', () => {
    const out = renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(out).toContain('<table class="qa-md-table">');
    expect(out).toContain('<th>A</th>');
    expect(out).toContain('<td>1</td>');
  });
  test('only allows http(s)/relative links', () => {
    expect(renderMarkdown('[ok](https://x.io)')).toContain('href="https://x.io"');
    // javascript: scheme must NOT become an anchor href
    expect(renderMarkdown('[bad](javascript:alert(1))')).not.toContain('href="javascript');
  });
});

describe('inlineMarkdown', () => {
  test('returns empty string for null', () => {
    expect(inlineMarkdown(null)).toBe('');
  });
  test('escapes then renders bold/code and converts newlines to <br>', () => {
    const out = inlineMarkdown('<b>**x**</b>\ny');
    expect(out).toContain('&lt;b&gt;');
    expect(out).toContain('<strong>x</strong>');
    expect(out).toContain('<br>');
  });
});

describe('formatAnalysis / formatTestScope', () => {
  test('formatAnalysis pretty-prints object input as fenced json', () => {
    const out = formatAnalysis({ a: 1 });
    expect(out).toContain('qa-md-code');
    // escapeHtml (DOM textContent→innerHTML) escapes <>& but NOT quotes,
    // so the JSON key stays literal inside the fenced <code> block.
    expect(out).toContain('"a": 1');
  });
  test('formatAnalysis renders string input as markdown', () => {
    expect(formatAnalysis('# Hi')).toContain('<h1 class="qa-md-h">Hi</h1>');
  });
  test('formatTestScope warns on empty/undefined scope', () => {
    expect(formatTestScope('')).toContain('No test scope was generated');
    expect(formatTestScope('undefined')).toContain('No test scope was generated');
    expect(formatTestScope('null')).toContain('No test scope was generated');
  });
  test('formatTestScope renders real scope text as markdown', () => {
    expect(formatTestScope('## Scope')).toContain('<h2 class="qa-md-h">Scope</h2>');
  });
});
