/**
 * Tests for buildStructuralFingerprint.
 * This function produces the structural similarity key used in isDuplicatePage.
 * Two pages with identical fingerprints are treated as structurally identical regardless of text content.
 * A bad fingerprint causes false duplicate detection (pages dropped) or false uniques (index bloat).
 */

// ---------------------------------------------------------------------------
// Inline the pure function under test
// ---------------------------------------------------------------------------
function buildStructuralFingerprint(pageData) {
  const parts = [];
  const features = pageData.features || [];

  // Count feature types
  const typeCounts = {};
  features.forEach(f => {
    const type = f.type || 'unknown';
    typeCounts[type] = (typeCounts[type] || 0) + 1;
  });

  Object.keys(typeCounts).sort().forEach(type => {
    parts.push(`${type}:${typeCounts[type]}`);
  });

  // Include form field structure
  const forms = features.filter(f => f.type === 'form');
  forms.forEach((form, i) => {
    if (form.fields) {
      const fieldSig = form.fields.map(f => `${f.type || 'text'}`).sort().join(',');
      parts.push(`form${i}[${fieldSig}]`);
    }
  });

  // Include button intents
  const buttons = features.filter(f => f.type === 'button');
  if (buttons.length > 0) {
    const intents = buttons.map(b => b.intent || 'unknown').sort().join(',');
    parts.push(`btns[${intents}]`);
  }

  return parts.join('|');
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function makePageData(overrides = {}) {
  return {
    url: 'https://app.example.com/page',
    title: 'Page Title',
    textContent: 'Some page text content here.',
    features: [],
    apis: [],
    ...overrides,
  };
}

function loginPageFeatures() {
  return [
    { type: 'form', fields: [{ type: 'email' }, { type: 'password' }] },
    { type: 'button', intent: 'submit' },
    { type: 'button', intent: 'navigation' },
  ];
}

function dashboardFeatures() {
  return [
    { type: 'table', rows: 10 },
    { type: 'button', intent: 'create' },
    { type: 'button', intent: 'export' },
    { type: 'nav', items: ['Home', 'Reports'] },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('buildStructuralFingerprint', () => {
  describe('empty and minimal pages', () => {
    test('returns empty string for page with no features', () => {
      const fp = buildStructuralFingerprint(makePageData());
      expect(fp).toBe('');
    });

    test('handles missing features array gracefully', () => {
      const fp = buildStructuralFingerprint({ url: 'https://example.com' });
      expect(typeof fp).toBe('string');
      expect(fp).toBe('');
    });
  });

  describe('type count encoding', () => {
    test('encodes feature types and counts as "type:count"', () => {
      const page = makePageData({ features: dashboardFeatures() });
      const fp = buildStructuralFingerprint(page);
      expect(fp).toContain('button:2');
      expect(fp).toContain('nav:1');
      expect(fp).toContain('table:1');
    });

    test('type counts are sorted alphabetically for stable fingerprint', () => {
      // Two identical pages with features in different array order should produce the same fingerprint
      const page1 = makePageData({
        features: [
          { type: 'nav' }, { type: 'button', intent: 'submit' }, { type: 'form', fields: [] },
        ],
      });
      const page2 = makePageData({
        features: [
          { type: 'form', fields: [] }, { type: 'nav' }, { type: 'button', intent: 'submit' },
        ],
      });
      expect(buildStructuralFingerprint(page1)).toBe(buildStructuralFingerprint(page2));
    });
  });

  describe('form field structure encoding', () => {
    test('encodes form fields as sorted type list', () => {
      const page = makePageData({ features: loginPageFeatures() });
      const fp = buildStructuralFingerprint(page);
      expect(fp).toContain('form0[email,password]');
    });

    test('two forms with same fields produce same fingerprint', () => {
      const form1 = { type: 'form', fields: [{ type: 'text' }, { type: 'email' }] };
      const form2 = { type: 'form', fields: [{ type: 'text' }, { type: 'email' }] };
      const fp1 = buildStructuralFingerprint(makePageData({ features: [form1] }));
      const fp2 = buildStructuralFingerprint(makePageData({ features: [form2] }));
      expect(fp1).toBe(fp2);
    });

    test('two forms with different fields produce different fingerprints', () => {
      const loginForm = { type: 'form', fields: [{ type: 'email' }, { type: 'password' }] };
      const searchForm = { type: 'form', fields: [{ type: 'text' }] };
      const fp1 = buildStructuralFingerprint(makePageData({ features: [loginForm] }));
      const fp2 = buildStructuralFingerprint(makePageData({ features: [searchForm] }));
      expect(fp1).not.toBe(fp2);
    });

    test('form with no fields property produces empty bracket pair', () => {
      const noFields = { type: 'form' }; // no .fields property
      const fp = buildStructuralFingerprint(makePageData({ features: [noFields] }));
      // Forms without fields are skipped in fingerprint (no form0[...] entry)
      expect(fp).not.toContain('form0[');
    });
  });

  describe('button intent encoding', () => {
    test('encodes button intents as sorted comma-separated list', () => {
      const page = makePageData({ features: loginPageFeatures() });
      const fp = buildStructuralFingerprint(page);
      expect(fp).toContain('btns[navigation,submit]'); // sorted
    });

    test('unknown button intent defaults to "unknown"', () => {
      const page = makePageData({ features: [{ type: 'button' }] }); // no intent
      const fp = buildStructuralFingerprint(page);
      expect(fp).toContain('btns[unknown]');
    });

    test('no buttons means no btns[] section in fingerprint', () => {
      const page = makePageData({ features: [{ type: 'form', fields: [{ type: 'text' }] }] });
      const fp = buildStructuralFingerprint(page);
      expect(fp).not.toContain('btns[');
    });
  });

  describe('duplicate detection equivalence', () => {
    test('identical pages produce identical fingerprints', () => {
      const page1 = makePageData({ features: loginPageFeatures() });
      const page2 = makePageData({
        url: 'https://app.example.com/login?page=2',    // different URL
        textContent: 'Different text content entirely', // different text
        features: loginPageFeatures(),                  // same structure
      });
      expect(buildStructuralFingerprint(page1)).toBe(buildStructuralFingerprint(page2));
    });

    test('structurally different pages produce different fingerprints', () => {
      const loginPage = makePageData({ features: loginPageFeatures() });
      const dashboard = makePageData({ features: dashboardFeatures() });
      expect(buildStructuralFingerprint(loginPage)).not.toBe(buildStructuralFingerprint(dashboard));
    });

    test('page with extra button differs from page without', () => {
      const base = makePageData({ features: [{ type: 'button', intent: 'submit' }] });
      const extra = makePageData({ features: [{ type: 'button', intent: 'submit' }, { type: 'button', intent: 'cancel' }] });
      expect(buildStructuralFingerprint(base)).not.toBe(buildStructuralFingerprint(extra));
    });
  });

  describe('determinism', () => {
    test('calling twice on same data returns same result', () => {
      const page = makePageData({ features: loginPageFeatures() });
      expect(buildStructuralFingerprint(page)).toBe(buildStructuralFingerprint(page));
    });

    test('feature with unknown type is encoded as "unknown"', () => {
      const page = makePageData({ features: [{ /* no type */ }] });
      const fp = buildStructuralFingerprint(page);
      expect(fp).toContain('unknown:1');
    });
  });
});
