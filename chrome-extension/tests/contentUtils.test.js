/**
 * Tests for content-utils.js — the pure, DOM-free logic extracted from the
 * Jira content script. Imports the REAL module so behaviour can't drift.
 * No DOM/chrome needed; console.log is silenced to keep output clean.
 */
const ORIG_LOG = console.log;
const ORIG_ERR = console.error;
beforeAll(() => { console.log = () => {}; console.error = () => {}; });
afterAll(() => { console.log = ORIG_LOG; console.error = ORIG_ERR; });

const {
  extractTextFromADF,
  extractFileType,
  determinePageType,
  extractTicketKeywords,
  calculateRelevanceScore,
  findMatchingApp,
  extractRelevantContext,
  formatAppContextForPrompt,
  validateSettingsUI,
  getPriorityColor,
  getCategoryColor,
  formatAnalysisForJiraComment,
  formatTestScopeForJiraComment,
  formatTestCasesForJiraComment,
  formatTestCasesForClipboard,
} = require('../content-utils.js');

describe('extractTextFromADF', () => {
  test('returns empty string for null/undefined', () => {
    expect(extractTextFromADF(null)).toBe('');
    expect(extractTextFromADF(undefined)).toBe('');
  });
  test('returns string input unchanged', () => {
    expect(extractTextFromADF('plain text')).toBe('plain text');
  });
  test('extracts text from nested paragraph nodes', () => {
    const adf = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'World' }] },
      ],
    };
    const out = extractTextFromADF(adf);
    expect(out).toContain('Hello');
    expect(out).toContain('World');
  });
  test('appends link href in parentheses when text differs from url', () => {
    const adf = {
      type: 'paragraph',
      content: [{
        type: 'text', text: 'click here',
        marks: [{ type: 'link', attrs: { href: 'https://x.io/page' } }],
      }],
    };
    expect(extractTextFromADF(adf)).toContain('(https://x.io/page)');
  });
  test('does not duplicate url when link text equals href', () => {
    const adf = {
      type: 'paragraph',
      content: [{
        type: 'text', text: 'https://x.io',
        marks: [{ type: 'link', attrs: { href: 'https://x.io' } }],
      }],
    };
    expect(extractTextFromADF(adf)).toBe('https://x.io');
  });
  test('wraps code blocks in fences', () => {
    const adf = { type: 'codeBlock', content: [{ type: 'text', text: 'a=1' }] };
    expect(extractTextFromADF(adf)).toContain('```');
    expect(extractTextFromADF(adf)).toContain('a=1');
  });
  test('extracts URL from a smart-link inlineCard (pasted Confluence link)', () => {
    const url = 'https://mindtickle.atlassian.net/wiki/spaces/C/pages/3924492679/Persisting+Meeting+Status+Timestamps';
    const adf = { type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url } }] },
    ]};
    expect(extractTextFromADF(adf)).toContain(url);
  });
  test('extracts URL from blockCard/embedCard attrs.data.url', () => {
    const url = 'https://company.atlassian.net/wiki/spaces/AB/pages/123/Spec';
    expect(extractTextFromADF({ type: 'blockCard', attrs: { url } })).toContain(url);
    expect(extractTextFromADF({ type: 'embedCard', attrs: { data: { url } } })).toContain(url);
  });
});

describe('extractFileType', () => {
  test('classifies images', () => {
    for (const f of ['a.png', 'b.JPG', 'c.jpeg', 'd.gif', 'e.svg', 'f.webp']) {
      expect(extractFileType(f)).toBe('image');
    }
  });
  test('classifies documents', () => {
    for (const f of ['a.pdf', 'b.doc', 'c.docx', 'd.txt', 'e.md']) {
      expect(extractFileType(f)).toBe('document');
    }
  });
  test('returns raw extension for unknown types', () => {
    expect(extractFileType('archive.zip')).toBe('zip');
  });
});

describe('determinePageType', () => {
  test('detects confluence variants', () => {
    expect(determinePageType('https://x.atlassian.net/wiki/spaces/ABC')).toBe('confluence');
    expect(determinePageType('https://confluence.acme.com/x')).toBe('confluence');
  });
  test('detects figma, google docs/drive, github', () => {
    expect(determinePageType('https://www.figma.com/file/abc')).toBe('figma');
    expect(determinePageType('https://docs.google.com/document/d/1')).toBe('google_docs');
    expect(determinePageType('https://drive.google.com/file/d/1')).toBe('google_drive');
    expect(determinePageType('https://github.com/org/repo')).toBe('github');
  });
  test('falls back to external for unknown', () => {
    expect(determinePageType('https://example.com/anything')).toBe('external');
  });
});

describe('extractTicketKeywords', () => {
  test('drops stopwords and short words, dedupes', () => {
    const kw = extractTicketKeywords({ summary: 'The login button is broken', description: '' });
    expect(kw).toContain('login');
    expect(kw).toContain('button');
    expect(kw).toContain('broken');
    expect(kw).not.toContain('the'); // stop word
    expect(kw).not.toContain('is');  // < 3 chars
  });
  test('extracts bracketed and quoted phrases', () => {
    const kw = extractTicketKeywords({ summary: 'Issue in [checkout flow] and "payment gateway"', description: '' });
    expect(kw).toContain('checkout flow');
    expect(kw).toContain('payment gateway');
  });
  test('handles missing fields without throwing', () => {
    expect(() => extractTicketKeywords({})).not.toThrow();
    expect(Array.isArray(extractTicketKeywords({}))).toBe(true);
  });
});

describe('calculateRelevanceScore', () => {
  test('weights url(10) > title(5) > description(2)', () => {
    expect(calculateRelevanceScore('https://app/login', '', '', ['login'])).toBe(10);
    expect(calculateRelevanceScore('https://app/x', 'Login Page', '', ['login'])).toBe(5);
    expect(calculateRelevanceScore('https://app/x', '', 'the login form', ['login'])).toBe(2);
  });
  test('sums across locations for the same keyword', () => {
    expect(calculateRelevanceScore('https://app/login', 'Login', 'login here', ['login'])).toBe(17);
  });
  test('zero when no keyword matches', () => {
    expect(calculateRelevanceScore('https://app/x', 'Y', 'z', ['nomatch'])).toBe(0);
  });
});

describe('findMatchingApp', () => {
  test('matches by exact domain mentioned in ticket', () => {
    const apps = [{ url: 'https://shop.acme.com', pages: 5, features: 2 }];
    const got = findMatchingApp(apps, { summary: 'bug on shop.acme.com', description: '' });
    expect(got.url).toBe('https://shop.acme.com');
  });
  test('falls back to the single app when no domain match', () => {
    const apps = [{ url: 'https://shop.acme.com', pages: 5, features: 2 }];
    const got = findMatchingApp(apps, { summary: 'unrelated text', description: '' });
    expect(got.url).toBe('https://shop.acme.com');
  });
  test('prefers largest app by pages when several and no match', () => {
    const apps = [
      { url: 'https://a.io', pages: 3, features: 1 },
      { url: 'https://b.io', pages: 9, features: 1 },
    ];
    const got = findMatchingApp(apps, { summary: 'nope', description: '' });
    expect(got.url).toBe('https://b.io');
  });
});

describe('extractRelevantContext', () => {
  const kg = {
    knowledgeGraph: {
      appUrl: 'https://app.io',
      totalPages: 2,
      pages: {
        'https://app.io/login': {
          metadata: { title: 'Login', description: 'login page' },
          features: [{ type: 'form', id: 'login-form', action: '/auth', inputs: [{ name: 'user', type: 'text' }] },
                     { type: 'button', id: 'submit', text: 'Sign in' }],
          apis: [{ method: 'POST', endpoint: '/api/login', payload: {} }],
        },
        'https://app.io/about': {
          metadata: { title: 'About', description: 'about us' },
          features: [],
          apis: [],
        },
      },
    },
  };
  test('returns null when pages are missing', () => {
    expect(extractRelevantContext({ knowledgeGraph: {} }, { summary: '', description: '' })).toBeNull();
  });
  test('collects forms, apis, features and pages with relevance scoring', () => {
    const ctx = extractRelevantContext(kg, { summary: 'login problem', description: '' });
    expect(ctx.appUrl).toBe('https://app.io');
    expect(ctx.forms).toHaveLength(1);
    expect(ctx.forms[0].id).toBe('login-form');
    expect(ctx.apis).toHaveLength(1);
    expect(ctx.pages).toHaveLength(2);
    // the login page (keyword match) must outrank about page
    expect(ctx.pages[0].title).toBe('Login');
    expect(ctx.pages[0]._relevanceScore).toBeGreaterThan(ctx.pages[1]._relevanceScore);
  });
});

describe('formatAppContextForPrompt', () => {
  test('returns empty string for null context', () => {
    expect(formatAppContextForPrompt(null)).toBe('');
  });
  test('includes app url, forms and api endpoints', () => {
    const out = formatAppContextForPrompt({
      appUrl: 'https://app.io', totalPages: 1,
      forms: [{ url: 'https://app.io/x', id: 'f1', action: '/a', method: 'POST', inputs: [{ name: 'email', type: 'email', required: true }], _relevanceScore: 10 }],
      apis: [{ url: 'https://app.io/x', method: 'GET', endpoint: '/api/me', _relevanceScore: 0 }],
      features: [], pages: [],
    });
    expect(out).toContain('https://app.io');
    expect(out).toContain('email');
    expect(out).toContain('/api/me');
    expect(out).toContain('⭐'); // relevance indicator for the relevant form
  });
});

describe('validateSettingsUI', () => {
  test('no errors for a valid OpenAI config', () => {
    expect(validateSettingsUI({ llmProvider: 'openai', llmModel: 'gpt-4.1', apiKey: 'sk-abc' })).toEqual([]);
  });
  test('flags missing api key for non-bedrock', () => {
    const errs = validateSettingsUI({ llmProvider: 'openai', llmModel: 'gpt-4.1', apiKey: '' });
    expect(errs.some(e => e.includes('API Key'))).toBe(true);
  });
  test('flags missing bedrock credentials', () => {
    const errs = validateSettingsUI({ llmProvider: 'bedrock', llmModel: 'm' });
    expect(errs.some(e => e.includes('Access Key ID'))).toBe(true);
    expect(errs.some(e => e.includes('Secret Access Key'))).toBe(true);
    expect(errs.some(e => e.includes('Region'))).toBe(true);
  });
  test('flags missing provider and model', () => {
    const errs = validateSettingsUI({ apiKey: 'sk-x' });
    expect(errs.some(e => e.includes('Provider'))).toBe(true);
    expect(errs.some(e => e.includes('Model'))).toBe(true);
  });
});

describe('priority/category colors', () => {
  test('known priorities map to fixed colors, unknown to default', () => {
    expect(getPriorityColor('P0')).toBe('#d32f2f');
    expect(getPriorityColor('P3')).toBe('#1976d2');
    expect(getPriorityColor('P9')).toBe('#666');
  });
  test('known categories map to fixed colors, unknown to default', () => {
    expect(getCategoryColor('Positive')).toBe('#388e3c');
    expect(getCategoryColor('Integration')).toBe('#1976d2');
    expect(getCategoryColor('Weird')).toBe('#666');
  });
});

describe('Jira comment / clipboard formatters', () => {
  test('analysis comment converts markdown headers and bold to wiki markup', () => {
    const out = formatAnalysisForJiraComment('## Title\n**bold** text\n- item');
    expect(out).toContain('h2. Title');
    expect(out).toContain('*bold*');
    expect(out).toContain('* item'); // - converted to *
    expect(out).toContain('Requirements Analysis');
  });
  test('test scope comment includes scope header', () => {
    const out = formatTestScopeForJiraComment('# Scope');
    expect(out).toContain('Test Scope Document');
    expect(out).toContain('h1. Scope');
  });
  test('test cases comment renders id, title, priority color and numbered steps', () => {
    const out = formatTestCasesForJiraComment([
      { id: 'TC-1', title: 'Login works', priority: 'P0', category: 'Positive', steps: ['open', 'submit'], expected_result: 'ok' },
    ]);
    expect(out).toContain('h3. TC-1: Login works');
    expect(out).toContain('#d32f2f'); // P0 color
    expect(out).toContain('# open');
    expect(out).toContain('# submit');
    expect(out).toContain('1 tests');
  });
  test('clipboard formatter joins cases and reads snake/camel expected result', () => {
    const out = formatTestCasesForClipboard([
      { id: 'TC-1', title: 'A', priority: 'P1', category: 'Edge', expectedResult: 'r1' },
      { id: 'TC-2', title: 'B', priority: 'P2', category: 'Negative', expected_result: 'r2' },
    ]);
    expect(out).toContain('TC-1: A');
    expect(out).toContain('r1');
    expect(out).toContain('r2');
    expect(out).toContain('---');
  });
});
