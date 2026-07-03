/**
 * Coverage Mapper - Maps test cases to knowledge graph features
 * Shows which forms/APIs/features are tested vs untested
 *
 * Version: 1.0.0
 * Purpose: Provide visibility into test coverage and identify gaps
 */

class CoverageMapper {
  constructor(knowledgeGraph) {
    this.knowledgeGraph = knowledgeGraph;
    this.coverageMap = null;
  }

  /**
   * Map test cases to knowledge graph features
   * Returns comprehensive coverage report
   */
  mapCoverage(testCases) {
    const coverage = {
      overall: {
        totalFeatures: 0,
        coveredFeatures: 0,
        uncoveredFeatures: 0,
        coveragePercentage: 0
      },
      forms: {
        total: 0,
        covered: 0,
        uncovered: 0,
        percentage: 0,
        details: []
      },
      apis: {
        total: 0,
        covered: 0,
        uncovered: 0,
        percentage: 0,
        details: []
      },
      buttons: {
        total: 0,
        covered: 0,
        uncovered: 0,
        percentage: 0,
        details: []
      },
      pages: {
        total: 0,
        covered: 0,
        uncovered: 0,
        percentage: 0,
        details: []
      },
      testMapping: [] // Which tests cover which features
    };

    if (!this.knowledgeGraph) {
      return coverage;
    }

    // Build feature inventory from knowledge graph
    const inventory = this.buildFeatureInventory();

    // Map each test case to features. (F39: the covered-marking that used to
    // run here was a no-op — coverage.*.details is populated *below* — so it was
    // removed. Marking happens once, correctly, after details are initialized.)
    testCases.forEach((testCase) => {
      const mappedFeatures = this.mapTestToFeatures(testCase, inventory);
      coverage.testMapping.push({
        testId: testCase.id,
        testTitle: testCase.title,
        coveredFeatures: mappedFeatures
      });
    });

    // Initialize feature details from inventory
    coverage.forms.details = inventory.forms.map(f => ({
      id: f.id,
      url: f.url,
      fields: f.fields,
      covered: false
    }));

    coverage.apis.details = inventory.apis.map(a => ({
      method: a.method,
      endpoint: a.endpoint,
      url: a.url,
      covered: false
    }));

    coverage.buttons.details = inventory.buttons.map(b => ({
      text: b.text,
      url: b.url,
      covered: false
    }));

    coverage.pages.details = inventory.pages.map(p => ({
      url: p.url,
      title: p.title,
      covered: false
    }));

    // Re-mark covered features (since we just reinitialized).
    // v13.2: only HIGH/MEDIUM confidence counts as "covered" — LOW means the
    // entity was merely name-dropped, not exercised, and must NOT inflate the %.
    coverage.testMapping.forEach(mapping => {
      mapping.coveredFeatures.forEach(feature => {
        if (feature.confidence === 'LOW') return;
        if (feature.type === 'form') {
          const formDetail = coverage.forms.details.find(f => f.id === feature.id);
          if (formDetail) formDetail.covered = true;
        } else if (feature.type === 'api') {
          const apiDetail = coverage.apis.details.find(a => a.endpoint === feature.id);
          if (apiDetail) apiDetail.covered = true;
        } else if (feature.type === 'button') {
          const buttonDetail = coverage.buttons.details.find(b => b.text === feature.id);
          if (buttonDetail) buttonDetail.covered = true;
        } else if (feature.type === 'page') {
          const pageDetail = coverage.pages.details.find(p => p.url === feature.id);
          if (pageDetail) pageDetail.covered = true;
        }
      });
    });

    // Calculate coverage statistics
    coverage.forms.total = coverage.forms.details.length;
    coverage.forms.covered = coverage.forms.details.filter(f => f.covered).length;
    coverage.forms.uncovered = coverage.forms.total - coverage.forms.covered;
    coverage.forms.percentage = coverage.forms.total > 0
      ? Math.round((coverage.forms.covered / coverage.forms.total) * 100)
      : 0;

    coverage.apis.total = coverage.apis.details.length;
    coverage.apis.covered = coverage.apis.details.filter(a => a.covered).length;
    coverage.apis.uncovered = coverage.apis.total - coverage.apis.covered;
    coverage.apis.percentage = coverage.apis.total > 0
      ? Math.round((coverage.apis.covered / coverage.apis.total) * 100)
      : 0;

    coverage.buttons.total = coverage.buttons.details.length;
    coverage.buttons.covered = coverage.buttons.details.filter(b => b.covered).length;
    coverage.buttons.uncovered = coverage.buttons.total - coverage.buttons.covered;
    coverage.buttons.percentage = coverage.buttons.total > 0
      ? Math.round((coverage.buttons.covered / coverage.buttons.total) * 100)
      : 0;

    coverage.pages.total = coverage.pages.details.length;
    coverage.pages.covered = coverage.pages.details.filter(p => p.covered).length;
    coverage.pages.uncovered = coverage.pages.total - coverage.pages.covered;
    coverage.pages.percentage = coverage.pages.total > 0
      ? Math.round((coverage.pages.covered / coverage.pages.total) * 100)
      : 0;

    // Overall coverage
    coverage.overall.totalFeatures =
      coverage.forms.total +
      coverage.apis.total +
      coverage.buttons.total;

    coverage.overall.coveredFeatures =
      coverage.forms.covered +
      coverage.apis.covered +
      coverage.buttons.covered;

    coverage.overall.uncoveredFeatures =
      coverage.overall.totalFeatures - coverage.overall.coveredFeatures;

    coverage.overall.coveragePercentage = coverage.overall.totalFeatures > 0
      ? Math.round((coverage.overall.coveredFeatures / coverage.overall.totalFeatures) * 100)
      : 0;

    this.coverageMap = coverage;
    return coverage;
  }

  /**
   * F5: split raw acceptance-criteria text into discrete, checkable items.
   * Relies on F3's structured ADF extraction (lists/tasks/tables render as
   * markdown), stripping list/task/number/table markers and dropping separators,
   * headers and trivially-short lines.
   */
  static parseAcceptanceCriteria(text) {
    if (!text || typeof text !== 'string') return [];
    const items = [];
    for (let raw of text.split(/\r?\n/)) {
      let line = raw.trim();
      if (!line) continue;
      line = line
        .replace(/^[-*•]\s+/, '')          // bullet
        .replace(/^\d+[.)]\s+/, '')         // ordered
        .replace(/^\[[ xX]?\]\s*/, '')      // task checkbox
        .replace(/^\|\s*/, '').replace(/\s*\|$/, '') // table edges
        .trim();
      if (!line) continue;
      if (/^[-|\s:]+$/.test(line)) continue;               // table separator / rule
      if (/^(acceptance criteria|ac|scenarios?)\s*:?\s*$/i.test(line)) continue; // header
      if (line.replace(/[^a-z0-9]/gi, '').length < 5) continue; // too short to be meaningful
      items.push(line);
    }
    return items;
  }

  /**
   * G1: harvest ALL requirement items from a ticket, not just a dedicated AC
   * field. Many stories (e.g. RE-11256) put the acceptance criteria, behavioural
   * "Case N:" scenarios and grooming notes inside the description prose — none of
   * which reached coverage before, so scenarios like a one-time migration went
   * silently untested. Returns a de-duplicated array of requirement strings that
   * feeds mapAcceptanceCriteria exactly like AC items.
   */
  static extractRequirementItems(ticketData) {
    const t = ticketData || {};
    const out = [];
    const seen = new Set();
    const add = (line) => {
      const item = String(line || '').trim();
      if (!item) return;
      if (item.replace(/[^a-z0-9]/gi, '').length < 5) return; // too short to be meaningful
      const key = item.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(key)) return;
      seen.add(key);
      out.push(item);
    };

    // 1. Dedicated AC custom field (if F2 detected one).
    const acField = t.acceptanceCriteria || t.acceptance_criteria || '';
    if (acField) this.parseAcceptanceCriteria(acField).forEach(add);

    // 2. Requirement-bearing sections embedded in the description.
    if (t.description) this._harvestDescriptionRequirements(String(t.description)).forEach(add);

    return out.slice(0, 40); // hard cap so a huge description can't explode the item list
  }

  /**
   * Section-aware requirement harvester for a (markdown-ish, post-ADF)
   * description. Captures bullets under "Acceptance Criteria" / "Grooming notes"
   * / "Mobile UI" headings, treats each "Case N:" block (title + bullets) as a
   * scenario, and picks up inline "Good to have:" requirements. Non-requirement
   * headings (Story, Description, Scope, …) end capture.
   */
  static _harvestDescriptionRequirements(desc) {
    const items = [];
    const stripEmphasis = (s) => s.replace(/\*\*/g, '').replace(/^#+\s*/, '').replace(/^\*\s+/, '').trim();
    const isBullet = (s) => /^\s*[-*•]\s+/.test(s) || /^\s*\d+[.)]\s+/.test(s);
    const bulletText = (s) => s.replace(/^\s*[-*•]\s+/, '').replace(/^\s*\d+[.)]\s+/, '').trim();

    const reqSection = /^(acceptance criteria|grooming notes|current story grooming notes|mobile ui)\s*:?$/i;
    const caseHeading = /^case\s*\d+\s*:?\s*(.*)$/i;
    const inlineReq = /^(good to have|expected|note)\s*:\s*(.+)$/i;
    const stopSection = /^(story|description|scope|background|context|design|figma|out of scope|dependencies|references?|attachments?)\s*:?.*$/i;

    let capturing = false;
    for (const raw of String(desc).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const bare = stripEmphasis(line);

      const caseM = bare.match(caseHeading);
      if (caseM && !isBullet(raw)) {
        capturing = true;
        if (caseM[1] && caseM[1].trim()) items.push(`Case: ${caseM[1].trim()}`);
        continue;
      }

      const inlineM = bare.match(inlineReq);
      if (inlineM && !isBullet(raw)) { capturing = false; items.push(inlineM[2].trim()); continue; }

      if (reqSection.test(bare) && !isBullet(raw)) { capturing = true; continue; }
      if (stopSection.test(bare) && !isBullet(raw)) { capturing = false; continue; }

      // Any other heading-looking line (short, ends with ':' or fully bold) ends capture.
      const looksHeading = !isBullet(raw) && ((/:$/.test(bare) && bare.length < 60) || /^\*\*.+\*\*$/.test(line));
      if (looksHeading) { capturing = false; continue; }

      if (capturing && isBullet(raw)) items.push(bulletText(raw));
    }
    return items;
  }

  /**
   * F5 + G4: map accepted tests to acceptance-criteria items so we can assert
   * every AC is exercised (the core "full coverage for a ticket" promise).
   *
   * An AC counts as covered when EITHER signal clears its threshold:
   *   - token recall: fraction of the AC's significant tokens present in a test
   *     (precise for shared vocabulary), OR
   *   - semantic similarity (G4): cosine of offline embeddings, which catches a
   *     criterion covered by a differently-worded test (e.g. "migration names
   *     chat from first question" vs a test titled "existing chat auto-named").
   * Embeddings are optional/injected so this stays testable and degrades to pure
   * token recall when `Embeddings` is unavailable.
   */
  static mapAcceptanceCriteria(testCases, acItems, opts = {}) {
    const threshold = opts.threshold ?? 0.4;
    // NOTE (G4): the default embedder (embeddings.js) is offline feature-hashed
    // TF, which captures morphology more than meaning — genuinely related pairs
    // only reach ~0.4 cosine, so 0.62 is deliberately conservative: the semantic
    // path stays inert (no false coverage) until a stronger embedding model is
    // injected via opts.embeddings, at which point it starts catching
    // differently-worded coverage. Token recall remains the primary signal.
    const embThreshold = opts.embThreshold ?? 0.62;
    const items = (acItems || []).filter(Boolean);
    if (!items.length) return { applicable: false, total: 0, covered: 0, uncovered: [], percentage: 100, details: [] };

    const tests = testCases || [];
    const testText = (tc) => [tc.title, tc.description, tc.expected_result, tc.test_data,
      ...(Array.isArray(tc.steps) ? tc.steps : [])].filter(Boolean).join(' ');
    const testTokenSets = tests.map(tc => new Set(acTokens(testText(tc))));

    // Semantic layer (G4): precompute one embedding per test when available.
    const EMB = opts.embeddings || (typeof self !== 'undefined' && self.Embeddings) || null;
    const canEmbed = EMB && typeof EMB.embed === 'function' && typeof EMB.cosine === 'function';
    const testVecs = canEmbed ? tests.map(tc => EMB.embed(testText(tc))) : null;

    const details = items.map((text, index) => {
      const itemTokens = acTokens(text);
      if (!itemTokens.length) return { index, text, covered: true, score: 1, coveredBy: null, matchType: 'trivial' };

      let bestTok = 0, bestTokTc = null;
      testTokenSets.forEach((set, i) => {
        const hit = itemTokens.filter(t => set.has(t)).length / itemTokens.length;
        if (hit > bestTok) { bestTok = hit; bestTokTc = tests[i]; }
      });

      let bestEmb = 0, bestEmbTc = null;
      if (canEmbed) {
        const itemVec = EMB.embed(text);
        testVecs.forEach((vec, i) => {
          const sim = EMB.cosine(itemVec, vec);
          if (sim > bestEmb) { bestEmb = sim; bestEmbTc = tests[i]; }
        });
      }

      const coveredByToken = bestTok >= threshold;
      const coveredByEmb = bestEmb >= embThreshold;
      const covered = coveredByToken || coveredByEmb;
      // Attribute to whichever signal is stronger relative to its own threshold.
      const tokMargin = bestTok - threshold, embMargin = bestEmb - embThreshold;
      const useEmb = coveredByEmb && (!coveredByToken || embMargin > tokMargin);
      const bestTc = useEmb ? bestEmbTc : bestTokTc;
      return {
        index, text,
        covered,
        score: Math.round(Math.max(bestTok, bestEmb) * 100) / 100,
        matchType: covered ? (useEmb ? 'semantic' : 'token') : 'none',
        coveredBy: covered ? (bestTc && (bestTc.id || bestTc.title)) || null : null
      };
    });

    const covered = details.filter(d => d.covered).length;
    return {
      applicable: true,
      total: items.length,
      covered,
      uncovered: details.filter(d => !d.covered).map(d => ({ index: d.index, text: d.text })),
      percentage: Math.round((covered / items.length) * 100),
      details
    };
  }

  /**
   * Build inventory of all features from knowledge graph
   */
  buildFeatureInventory() {
    const inventory = { forms: [], apis: [], buttons: [], pages: [] };
    const kg = this.knowledgeGraph;
    if (!kg) return inventory;

    // F8: previously this read ONLY the aggregated top-level .forms/.apis/.features
    // and object-keyed .pages. On the raw-array KG shape (pages:[{features,apis}])
    // — which GroundedVerifier fully supports — the inventory came back empty, so
    // coverage silently reported 0%/N/A and the gap-feedback loop went blind. Now
    // both shapes are flattened, with de-duplication so shape-(b) graphs that carry
    // both top-level and per-page collections aren't double-counted.
    const seenForm = new Set(), seenApi = new Set(), seenBtn = new Set(), seenPage = new Set();

    const pushForm = (form, url) => {
      if (!form || typeof form !== 'object') return;
      const id = form.id || form.action || 'unknown';
      const u = form.url || url || '';
      const key = `${id}|${u}`;
      if (seenForm.has(key)) return; seenForm.add(key);
      inventory.forms.push({
        id, url: u,
        fields: (form.inputs || form.fields || []).map(inp => (inp && (inp.name || inp.id)) || inp).filter(Boolean)
      });
    };
    const pushApi = (api) => {
      if (!api || typeof api !== 'object') return;
      const endpoint = api.endpoint || '';
      const u = api.url || '';
      if (!endpoint && !u) return;
      const method = (api.method || 'GET');
      const key = `${method} ${endpoint || u}`;
      if (seenApi.has(key)) return; seenApi.add(key);
      inventory.apis.push({ method, endpoint, url: u });
    };
    const pushButton = (feature, url) => {
      if (!feature || feature.type !== 'button' || !feature.text) return;
      const u = feature.url || url || '';
      const key = `${feature.text}|${u}`;
      if (seenBtn.has(key)) return; seenBtn.add(key);
      inventory.buttons.push({ text: feature.text, url: u });
    };
    const pushPage = (url, title) => {
      if (!url || seenPage.has(url)) return; seenPage.add(url);
      inventory.pages.push({ url, title: title || '' });
    };

    // Aggregated top-level collections (shape b).
    if (Array.isArray(kg.forms)) kg.forms.forEach(f => pushForm(f));
    if (Array.isArray(kg.apis)) kg.apis.forEach(pushApi);
    if (Array.isArray(kg.features)) kg.features.forEach(f => pushButton(f));

    // Per-page features (shape a: array; shape b: object keyed by url).
    const ingestPage = (page, url) => {
      if (!page || typeof page !== 'object') return;
      const u = url || page.url || '';
      pushPage(u, (page.metadata && page.metadata.title) || page.title || '');
      const feats = Array.isArray(page.features) ? page.features : [];
      feats.forEach(feat => {
        if (!feat || typeof feat !== 'object') return;
        if (feat.type === 'form') pushForm(feat, u);
        else pushButton(feat, u);
      });
      (Array.isArray(page.apis) ? page.apis : []).forEach(pushApi);
    };
    if (Array.isArray(kg.pages)) kg.pages.forEach(p => ingestPage(p, p && p.url));
    else if (kg.pages && typeof kg.pages === 'object') {
      Object.keys(kg.pages).forEach(url => ingestPage(kg.pages[url], url));
    }

    return inventory;
  }

  /**
   * Map a single test case to features it covers
   */
  mapTestToFeatures(testCase, inventory) {
    const coveredFeatures = [];

    // v13.2 — STRUCTURAL coverage: an entity counts as "covered" only if the
    // test ACTUALLY EXERCISES it, not merely mentions it in prose. We therefore
    // score against the actionable part of the test (steps + expected_result),
    // and require an action verb near the entity. Title/description/preconditions
    // are excluded — a test titled "verify login form" that never touches the
    // form in its steps no longer inflates coverage.
    const actionText = [
      testCase.expected_result || '',
      ...(Array.isArray(testCase.steps) ? testCase.steps : [])
    ].join(' ').toLowerCase();

    // Cheap reference set used only as a weak fallback signal.
    const mentionText = [
      testCase.title || '', testCase.description || ''
    ].join(' ').toLowerCase();

    const hasAction = (re) => re.test(actionText);
    const FORM_ACTION = /\b(submit|fill|enter|type|input|complete|save|create|update|sign\s?up|register|log\s?in)\b/;
    const BTN_ACTION = /\b(click|tap|press|select|choose|toggle|hit)\b/;
    const API_ACTION = /\b(get|post|put|patch|delete|call|request|response|status\s?code|returns?|api|endpoint)\b/;
    const NAV_ACTION = /\b(navigate|go to|open|visit|load|redirect|land on)\b/;

    // Check forms — require a form action AND a reference to the form/its fields in steps.
    inventory.forms.forEach(form => {
      const formId = (form.id || '').toLowerCase();
      const fieldsInSteps = (form.fields || []).filter(f => f && actionText.includes(String(f).toLowerCase()));
      const formIdInSteps = formId && actionText.includes(formId);

      if ((formIdInSteps || fieldsInSteps.length > 0) && hasAction(FORM_ACTION)) {
        const strong = formIdInSteps || fieldsInSteps.length >= Math.max(1, (form.fields || []).length / 2);
        coveredFeatures.push({ type: 'form', id: form.id, confidence: strong ? 'HIGH' : 'MEDIUM' });
      } else if ((formId && mentionText.includes(formId)) || fieldsInSteps.length > 0) {
        // Mentioned/partially touched but not clearly exercised.
        coveredFeatures.push({ type: 'form', id: form.id, confidence: 'LOW' });
      }
    });

    // Check APIs — require the endpoint/method to appear in the actionable text.
    inventory.apis.forEach(api => {
      const endpoint = (api.endpoint || '').toLowerCase();
      const method = (api.method || '').toLowerCase();
      const endpointInSteps = endpoint && actionText.includes(endpoint);
      const methodInSteps = method && actionText.includes(method);

      if (endpointInSteps && (methodInSteps || hasAction(API_ACTION))) {
        coveredFeatures.push({ type: 'api', id: api.endpoint, confidence: 'HIGH' });
      } else if (endpointInSteps) {
        coveredFeatures.push({ type: 'api', id: api.endpoint, confidence: 'MEDIUM' });
      } else if (methodInSteps) {
        // method + at least half the endpoint path segments present in steps
        const parts = endpoint.split('/').filter(Boolean);
        const matched = parts.filter(p => actionText.includes(p));
        if (parts.length && matched.length >= parts.length / 2) {
          coveredFeatures.push({ type: 'api', id: api.endpoint, confidence: 'MEDIUM' });
        }
      }
    });

    // Check buttons — require a click-style action on the button in steps.
    inventory.buttons.forEach(button => {
      const buttonText = (button.text || '').toLowerCase();
      if (!buttonText) return;
      if (actionText.includes(buttonText) && hasAction(BTN_ACTION)) {
        coveredFeatures.push({ type: 'button', id: button.text, confidence: 'HIGH' });
      } else if (actionText.includes(buttonText) || mentionText.includes(buttonText)) {
        coveredFeatures.push({ type: 'button', id: button.text, confidence: 'LOW' });
      }
    });

    // Check pages — require a navigation action or the URL/title in actionable text.
    inventory.pages.forEach(page => {
      const pageUrl = (page.url || '').toLowerCase();
      const pageTitle = (page.title || '').toLowerCase();

      if (pageUrl && actionText.includes(pageUrl) && hasAction(NAV_ACTION)) {
        coveredFeatures.push({ type: 'page', id: page.url, confidence: 'HIGH' });
      } else if (pageUrl && actionText.includes(pageUrl)) {
        coveredFeatures.push({ type: 'page', id: page.url, confidence: 'MEDIUM' });
      } else if (pageTitle && (actionText.includes(pageTitle) || mentionText.includes(pageTitle))) {
        coveredFeatures.push({ type: 'page', id: page.url, confidence: 'LOW' });
      }
    });

    return coveredFeatures;
  }

  /**
   * Identify coverage gaps and critical untested features
   */
  identifyGaps(coverage) {
    const gaps = {
      critical: [],
      important: [],
      optional: [],
      summary: ''
    };

    // Uncovered forms (CRITICAL if they have many fields or are on important pages)
    coverage.forms.details.filter(f => !f.covered).forEach(form => {
      const priority = form.fields.length > 5 ? 'critical' : 'important';
      gaps[priority].push({
        type: 'Form',
        identifier: form.id,
        url: form.url,
        reason: `Form with ${form.fields.length} fields not tested`,
        recommendation: `Add tests for form submission, validation, and error handling`
      });
    });

    // Uncovered APIs (CRITICAL for POST/PUT/DELETE, IMPORTANT for GET)
    coverage.apis.details.filter(a => !a.covered).forEach(api => {
      const priority = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(api.method)
        ? 'critical'
        : 'important';
      gaps[priority].push({
        type: 'API',
        identifier: `${api.method} ${api.endpoint}`,
        url: api.url,
        reason: `${api.method} endpoint not tested`,
        recommendation: `Add integration test for ${api.method} ${api.endpoint}`
      });
    });

    // Uncovered buttons (IMPORTANT for actions, OPTIONAL for navigation)
    coverage.buttons.details.filter(b => !b.covered).forEach(button => {
      const isAction = /submit|save|create|delete|update|confirm|apply/i.test(button.text);
      const priority = isAction ? 'important' : 'optional';
      gaps[priority].push({
        type: 'Button',
        identifier: button.text,
        url: button.url,
        reason: `Button "${button.text}" not tested`,
        recommendation: `Add test clicking "${button.text}" button`
      });
    });

    // Generate summary
    const totalGaps = gaps.critical.length + gaps.important.length + gaps.optional.length;
    gaps.summary = `Found ${totalGaps} coverage gaps: ${gaps.critical.length} critical, ${gaps.important.length} important, ${gaps.optional.length} optional`;

    return gaps;
  }

  /**
   * Generate coverage report for display
   */
  generateReport(coverage) {
    const gaps = this.identifyGaps(coverage);

    const report = {
      summary: {
        overallCoverage: coverage.overall.coveragePercentage,
        totalFeatures: coverage.overall.totalFeatures,
        coveredFeatures: coverage.overall.coveredFeatures,
        uncoveredFeatures: coverage.overall.uncoveredFeatures,
        status: this.getCoverageStatus(coverage.overall.coveragePercentage)
      },
      breakdown: {
        forms: `${coverage.forms.covered}/${coverage.forms.total} (${coverage.forms.percentage}%)`,
        apis: `${coverage.apis.covered}/${coverage.apis.total} (${coverage.apis.percentage}%)`,
        buttons: `${coverage.buttons.covered}/${coverage.buttons.total} (${coverage.buttons.percentage}%)`
      },
      gaps: gaps,
      recommendations: this.generateRecommendations(coverage, gaps)
    };

    return report;
  }

  getCoverageStatus(percentage) {
    if (percentage >= 80) return 'EXCELLENT';
    if (percentage >= 60) return 'GOOD';
    if (percentage >= 40) return 'FAIR';
    if (percentage >= 20) return 'POOR';
    return 'INSUFFICIENT';
  }

  generateRecommendations(coverage, gaps) {
    const recommendations = [];

    if (coverage.overall.coveragePercentage < 60) {
      recommendations.push({
        priority: 'HIGH',
        message: 'Overall coverage is below 60% - significant gaps exist',
        action: 'Focus on testing critical forms and APIs first'
      });
    }

    if (gaps.critical.length > 0) {
      recommendations.push({
        priority: 'CRITICAL',
        message: `${gaps.critical.length} critical features untested`,
        action: 'Generate tests for uncovered forms and write operations (POST/PUT/DELETE)'
      });
    }

    if (coverage.forms.percentage < 50) {
      recommendations.push({
        priority: 'HIGH',
        message: `Only ${coverage.forms.percentage}% of forms are tested`,
        action: 'Add form validation tests, submission tests, and error handling tests'
      });
    }

    if (coverage.apis.percentage < 50) {
      recommendations.push({
        priority: 'HIGH',
        message: `Only ${coverage.apis.percentage}% of APIs are tested`,
        action: 'Add integration tests for API endpoints'
      });
    }

    if (coverage.overall.coveragePercentage >= 80) {
      recommendations.push({
        priority: 'INFO',
        message: 'Excellent coverage achieved!',
        action: 'Focus on edge cases and security tests'
      });
    }

    return recommendations;
  }

  /**
   * Format coverage report for display
   */
  formatReportForDisplay(report) {
    const lines = [];

    lines.push(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`📊 TEST COVERAGE ANALYSIS`);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    // Overall summary
    const statusEmoji = report.summary.status === 'EXCELLENT' ? '✅' :
                       report.summary.status === 'GOOD' ? '👍' :
                       report.summary.status === 'FAIR' ? '⚠️' : '❌';
    lines.push(`${statusEmoji} Overall Coverage: ${report.summary.overallCoverage}% (${report.summary.status})`);
    lines.push(`   • Features: ${report.summary.coveredFeatures}/${report.summary.totalFeatures}`);
    lines.push(`   • Gaps: ${report.summary.uncoveredFeatures}\n`);

    // Breakdown
    lines.push(`📋 Coverage Breakdown:`);
    lines.push(`   • Forms: ${report.breakdown.forms}`);
    lines.push(`   • APIs: ${report.breakdown.apis}`);
    lines.push(`   • Buttons: ${report.breakdown.buttons}\n`);

    // Gaps
    if (report.gaps.critical.length > 0 || report.gaps.important.length > 0) {
      lines.push(`🔍 Coverage Gaps:\n`);

      if (report.gaps.critical.length > 0) {
        lines.push(`   🔴 CRITICAL (${report.gaps.critical.length}):`);
        report.gaps.critical.slice(0, 5).forEach(gap => {
          lines.push(`      • ${gap.type}: ${gap.identifier}`);
          lines.push(`        → ${gap.recommendation}`);
        });
        if (report.gaps.critical.length > 5) {
          lines.push(`      ... and ${report.gaps.critical.length - 5} more`);
        }
        lines.push('');
      }

      if (report.gaps.important.length > 0) {
        lines.push(`   🟡 IMPORTANT (${report.gaps.important.length}):`);
        report.gaps.important.slice(0, 5).forEach(gap => {
          lines.push(`      • ${gap.type}: ${gap.identifier}`);
        });
        if (report.gaps.important.length > 5) {
          lines.push(`      ... and ${report.gaps.important.length - 5} more`);
        }
        lines.push('');
      }
    }

    // Recommendations
    if (report.recommendations.length > 0) {
      lines.push(`💡 RECOMMENDATIONS:\n`);
      report.recommendations.forEach(rec => {
        const emoji = rec.priority === 'CRITICAL' ? '🔴' :
                     rec.priority === 'HIGH' ? '🟠' :
                     rec.priority === 'MEDIUM' ? '🟡' : 'ℹ️';
        lines.push(`${emoji} ${rec.message}`);
        lines.push(`   → ${rec.action}\n`);
      });
    }

    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    return lines.join('\n');
  }
}

// Significant-token extractor for AC↔test matching (F5): lowercase words ≥3
// chars, minus generic function/QA-boilerplate words (user/system/ensure/able…)
// that appear in nearly every AC and test and so carry no discriminating signal.
const AC_STOPWORDS = new Set(['the','a','an','and','or','but','if','then','when','while','for','of','to','in','on','at','by','with','from','as','is','are','be','been','was','were','will','would','should','shall','can','could','may','might','must','that','this','these','those','it','its','their','they','user','users','able','ensure','system','not','no','yes','all','any','each','via','into','onto']);
function acTokens(text) {
  const words = String(text || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  return [...new Set(words.filter(w => !AC_STOPWORDS.has(w)))];
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CoverageMapper;
}

// Make available globally
if (typeof window !== 'undefined') {
  window.CoverageMapper = CoverageMapper;
} else if (typeof self !== 'undefined') {
  self.CoverageMapper = CoverageMapper;
}
