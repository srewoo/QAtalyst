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
    // F16: every detail row carries its canonical key so marking matches the
    // exact entity on the exact page, not merely something with the same label.
    coverage.forms.details = inventory.forms.map(f => ({
      key: CoverageMapper.entityKey('form', f),
      id: f.id, url: f.url, fields: f.fields, covered: false
    }));

    coverage.apis.details = inventory.apis.map(a => ({
      key: CoverageMapper.entityKey('api', a),
      method: a.method, endpoint: a.endpoint, url: a.url, covered: false
    }));

    coverage.buttons.details = inventory.buttons.map(b => ({
      key: CoverageMapper.entityKey('button', b),
      text: b.text, url: b.url, covered: false
    }));

    coverage.pages.details = inventory.pages.map(p => ({
      key: CoverageMapper.entityKey('page', p),
      url: p.url, title: p.title, covered: false
    }));

    // Re-mark covered features (since we just reinitialized).
    // v13.2: only HIGH/MEDIUM confidence counts as "covered" — LOW means the
    // entity was merely name-dropped, not exercised, and must NOT inflate the %.
    // F16: match on the canonical key. Matching on a bare label marked the first
    // same-named entity in the inventory covered — the wrong page's Save button,
    // or DELETE when the test only performed a GET.
    const byKey = {
      form: new Map(coverage.forms.details.map(d => [d.key, d])),
      api: new Map(coverage.apis.details.map(d => [d.key, d])),
      button: new Map(coverage.buttons.details.map(d => [d.key, d])),
      page: new Map(coverage.pages.details.map(d => [d.key, d]))
    };
    coverage.testMapping.forEach(mapping => {
      mapping.coveredFeatures.forEach(feature => {
        if (feature.confidence === 'LOW') return;
        const detail = byKey[feature.type] && byKey[feature.type].get(feature.key);
        if (detail) detail.covered = true;
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
      if (inlineM && !isBullet(raw)) {
        capturing = false;
        // Keep the label. Dropping "Good to have:" discarded the only marker that
        // says this is OPTIONAL, so a nice-to-have arrived downstream looking
        // like a release obligation (fix2.md §7.1).
        const label = inlineM[1].trim();
        const body = inlineM[2].trim();
        items.push(/good to have/i.test(label) ? `${label}: ${body}` : body);
        continue;
      }

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
  /**
   * F07: coverage against requirement PREDICATES, not raw strings.
   *
   * mapAcceptanceCriteria() answers "does some test look like this sentence?".
   * This answers "does a test perform this operation, as this actor, and assert
   * this modality?" — and it reports which requirement id each test covers, so a
   * ready case can cite its provenance and a reviewer can see the mapping.
   *
   * A compound AC only counts as covered when EVERY one of its atoms is covered;
   * one branch standing in for the whole was how an allow/deny pair reported
   * full coverage from the allow case alone.
   *
   * @param {Array} testCases
   * @param {Array} requirements predicate records from requirement-model.js
   * @returns {object} { applicable, total, covered, percentage, details, contradictions, uncovered }
   */
  static mapRequirementPredicates(testCases, requirements, opts = {}) {
    const RM = opts.requirementModel
      || (typeof self !== 'undefined' && self.mandatoryRequirements ? self : null)
      || (typeof require === 'function' ? require('./requirement-model.js') : null);
    const reqs = (requirements || []).filter(Boolean);
    if (!reqs.length) {
      return { applicable: false, total: 0, covered: 0, percentage: 100, details: [], uncovered: [], contradictions: [] };
    }
    const tests = testCases || [];

    // Only mandatory obligations count toward completeness; the rest stay visible.
    const mandatory = RM ? RM.mandatoryRequirements(reqs) : reqs.filter(r => r.status === 'mandatory');
    const mandatoryIds = new Set(mandatory.map(r => r.id));

    const details = reqs.map(req => {
      let best = null;
      for (const tc of tests) {
        const m = CoverageMapper.matchTestToRequirement(tc, req);
        if (!m.covers && !m.contradicts) continue;
        if (!best || m.score > best.score) best = { ...m, test: tc };
      }
      const covered = !!(best && best.covers);
      return {
        id: req.id,
        text: req.text,
        status: req.status,
        modality: req.modality,
        mandatory: mandatoryIds.has(req.id),
        covered,
        contradicts: !!(best && best.contradicts && !covered),
        coveredBy: covered ? (best.test.id || best.test.title) : null,
        contradictedBy: (best && best.contradicts && !covered) ? (best.test.id || best.test.title) : null,
        score: best ? Math.round(best.score * 100) / 100 : 0
      };
    });

    // A compound requirement needs ALL of its atoms.
    const groups = RM ? RM.groupCompound(reqs) : new Map();
    for (const [, members] of groups) {
      if (members.length < 2) continue;
      const allCovered = members.every(m => details.find(d => d.id === m.id)?.covered);
      if (!allCovered) {
        for (const m of members) {
          const d = details.find(x => x.id === m.id);
          if (d) d.compoundIncomplete = true;
        }
      }
    }

    const mandatoryDetails = details.filter(d => d.mandatory);
    const covered = mandatoryDetails.filter(d => d.covered).length;
    return {
      applicable: true,
      total: mandatoryDetails.length,
      covered,
      percentage: mandatoryDetails.length ? Math.round((covered / mandatoryDetails.length) * 100) : 100,
      uncovered: mandatoryDetails.filter(d => !d.covered && !d.contradicts).map(d => ({ id: d.id, text: d.text })),
      contradictions: details.filter(d => d.contradicts).map(d => ({ id: d.id, text: d.text, by: d.contradictedBy })),
      // Visible but not counted against completeness.
      nonMandatory: details.filter(d => !d.mandatory).map(d => ({ id: d.id, text: d.text, status: d.status })),
      details
    };
  }

  /**
   * F07: does this test establish and assert this requirement?
   * Requires operation agreement AND modality agreement — a lexical mention is
   * not coverage, and an inverted assertion is a contradiction, not a gap.
   */
  static matchTestToRequirement(testCase, req) {
    const steps = Array.isArray(testCase.steps) ? testCase.steps : [];
    const assertion = [testCase.title, testCase.expected_result || testCase.expectedResult]
      .filter(Boolean).join(' ').toLowerCase();
    const whole = [testCase.title, testCase.description, testCase.preconditions,
      testCase.expected_result || testCase.expectedResult, ...steps]
      .filter(Boolean).join(' ').toLowerCase();
    if (!whole) return { covers: false, contradicts: false, score: 0 };

    // The operation must actually be performed.
    const opStem = (req.operation || '').replace(/(ing|ed|es|s)$/, '');
    const opPresent = !req.operation || (opStem.length > 2 && whole.includes(opStem));
    if (!opPresent) return { covers: false, contradicts: false, score: 0 };

    // The actor, when the requirement names one, must be the test's actor.
    const actorPresent = !req.actor || whole.includes(req.actor);
    if (!actorPresent) return { covers: false, contradicts: false, score: 0 };

    // Modality must agree with what the test ASSERTS (title + expected result).
    const testNegative = /\b(cannot|can't|must not|should not|is not|are not|does not|doesn't|never|unable|denied|deny|denies|forbidden|prohibited|rejected|blocked|prevented|unauthoriz(?:ed)?|403|401|fails?|error)\b/i.test(assertion);
    const reqNegative = req.modality === 'must_not';

    // Token overlap gives the score; the gates above decide covers/contradicts.
    const reqTokens = String(req.text || '').toLowerCase().match(/[a-z0-9]{3,}/g) || [];
    const hits = reqTokens.filter(t => whole.includes(t)).length;
    const score = reqTokens.length ? hits / reqTokens.length : 0;
    if (score < 0.3) return { covers: false, contradicts: false, score };

    if (testNegative !== reqNegative) return { covers: false, contradicts: true, score };
    return { covers: true, contradicts: false, score };
  }

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
      let covered = coveredByToken || coveredByEmb;

      // F07: a test may only cover an AC whose polarity it actually asserts.
      // The assertion lives in the title + expected result, not in the setup
      // steps (a step "attempt to delete" is not a claim about the outcome).
      let contradicts = false;
      const matchTc = (coveredByEmb && !coveredByToken) ? bestEmbTc : bestTokTc;
      if (covered && matchTc) {
        const acPol = acPolarity(text);
        const tcPol = acPolarity([matchTc.title, matchTc.expected_result].filter(Boolean).join(' '));
        if (acPol !== tcPol) { covered = false; contradicts = true; }
      }
      // Attribute to whichever signal is stronger relative to its own threshold.
      const tokMargin = bestTok - threshold, embMargin = bestEmb - embThreshold;
      const useEmb = coveredByEmb && (!coveredByToken || embMargin > tokMargin);
      const bestTc = useEmb ? bestEmbTc : bestTokTc;
      return {
        index, text,
        covered,
        score: Math.round(Math.max(bestTok, bestEmb) * 100) / 100,
        // F07: 'contradicted' is NOT coverage — it is a conflict a reviewer must
        // resolve, and it is strictly more urgent than a plain gap.
        matchType: covered ? (useEmb ? 'semantic' : 'token') : (contradicts ? 'contradicted' : 'none'),
        contradicts,
        contradictedBy: contradicts ? (matchTc && (matchTc.id || matchTc.title)) || null : null,
        coveredBy: covered ? (bestTc && (bestTc.id || bestTc.title)) || null : null
      };
    });

    const covered = details.filter(d => d.covered).length;
    return {
      applicable: true,
      total: items.length,
      covered,
      uncovered: details.filter(d => !d.covered).map(d => ({ index: d.index, text: d.text })),
      // F07: surface contradictions separately so they can't hide inside the
      // uncovered count as an ordinary "we just need one more test" gap.
      contradictions: details.filter(d => d.contradicts)
        .map(d => ({ index: d.index, text: d.text, by: d.contradictedBy })),
      percentage: Math.round((covered / items.length) * 100),
      details
    };
  }

  /**
   * F16: ONE canonical identity for an app entity, used by the inventory, the
   * test→feature mapping and the covered-marking alike.
   *
   * These had drifted apart: the inventory keyed buttons by `text|url` and APIs
   * by `method endpoint`, but the mapping emitted only `button.text` /
   * `api.endpoint`, and marking then did `.find(b => b.text === id)`. So clicking
   * Save on /billing marked the FIRST "Save" in the inventory covered — often the
   * one on /profile — and a GET on /invoices marked DELETE /invoices covered.
   *
   * ponytail: identity is app + page URL + entity. It does not yet distinguish
   * two states of the SAME url (modal open vs closed) — that needs the crawler to
   * emit a state id (fix2.md §12.1). Keys are built here so that upgrade is one
   * function.
   */
  static entityKey(type, e) {
    const norm = (v) => String(v || '').trim().toLowerCase();
    switch (type) {
      case 'form':   return `form|${norm(e.id)}|${norm(e.url)}`;
      // Method is part of an API's identity: GET and DELETE on one path are two
      // different operations with two different expected outcomes.
      case 'api':    return `api|${norm(e.method) || 'get'}|${norm(e.endpoint || e.url)}`;
      case 'button': return `button|${norm(e.text)}|${norm(e.url)}`;
      case 'page':   return `page|${norm(e.url)}`;
      default:       return `${type}|${norm(e.id || e.text || e.url)}`;
    }
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
  /** Does the text name an explicit HTTP method? (F16 — see API mapping.) */
  static methodsMentioned(text) {
    return /\b(get|post|put|patch|delete|head|options)\b/.test(String(text || ''));
  }

  mapTestToFeatures(testCase, inventory) {
    const coveredFeatures = [];

    // v13.2 — STRUCTURAL coverage: an entity counts as "covered" only if the
    // test ACTUALLY EXERCISES it, not merely mentions it in prose. We therefore
    // score against the actionable part of the test (steps + expected_result),
    // and require an action verb near the entity. Title/description/preconditions
    // are excluded — a test titled "verify login form" that never touches the
    // form in its steps no longer inflates coverage.
    // F16: keep the steps SEPARATE, not joined. A verb anywhere in the combined
    // text used to satisfy the action check for every entity mentioned anywhere
    // else, so a test whose steps click "Export" and whose expected result merely
    // names "Save" credited an exercise of Save. An entity is only exercised when
    // the action verb and the entity appear in the SAME step (or the same
    // expected-result clause).
    const actionUnits = [
      ...(Array.isArray(testCase.steps) ? testCase.steps : []),
      testCase.expected_result || ''
    ].map(u => String(u || '').toLowerCase()).filter(Boolean);
    const actionText = actionUnits.join(' ');

    // Cheap reference set used only as a weak fallback signal.
    const mentionText = [
      testCase.title || '', testCase.description || ''
    ].join(' ').toLowerCase();

    /** Does any single step both mention `needle` AND carry an action verb? */
    const actsOn = (re, needle) => {
      if (!needle) return false;
      return actionUnits.some(u => u.includes(needle) && re.test(u));
    };
    const hasAction = (re) => re.test(actionText);

    // F16: which page(s) does this test actually put us on? A test that navigates
    // to /billing and clicks Save exercised BILLING's Save — not the identically
    // labelled button on /profile. Without this, one click credited every
    // same-named control in the app.
    const scopeUrls = new Set(
      inventory.pages
        .filter(p => {
          const u = (p.url || '').toLowerCase();
          const t = (p.title || '').toLowerCase();
          return (u && actionText.includes(u)) || (t && t.length > 2 && actionText.includes(t));
        })
        .map(p => (p.url || '').toLowerCase())
    );

    /**
     * Can an entity on `url` be credited to this test?
     *  - no page scope established → only if its label is UNAMBIGUOUS app-wide.
     *    Two "Save" buttons and no stated page means we genuinely do not know
     *    which one ran; guessing is how coverage inflated.
     *  - page scope established → only entities on one of those pages.
     */
    const inScope = (url, sameLabelCount) => {
      const u = (url || '').toLowerCase();
      if (!scopeUrls.size) return sameLabelCount <= 1;
      if (!u) return true; // app-level entity, not tied to a page
      return scopeUrls.has(u);
    };
    const labelCounts = new Map();
    for (const b of inventory.buttons) {
      const t = (b.text || '').toLowerCase();
      labelCounts.set(t, (labelCounts.get(t) || 0) + 1);
    }
    const formIdCounts = new Map();
    for (const f of inventory.forms) {
      const i = (f.id || '').toLowerCase();
      formIdCounts.set(i, (formIdCounts.get(i) || 0) + 1);
    }
    const FORM_ACTION = /\b(submit|fill|enter|type|input|complete|save|create|update|sign\s?up|register|log\s?in)\b/;
    const BTN_ACTION = /\b(click|tap|press|select|choose|toggle|hit)\b/;
    const API_ACTION = /\b(get|post|put|patch|delete|call|request|response|status\s?code|returns?|api|endpoint)\b/;
    const NAV_ACTION = /\b(navigate|go to|open|visit|load|redirect|land on)\b/;

    // Check forms — require a form action AND a reference to the form/its fields in steps.
    inventory.forms.forEach(form => {
      const formId = (form.id || '').toLowerCase();
      const fieldsInSteps = (form.fields || []).filter(f => f && actionText.includes(String(f).toLowerCase()));
      const formIdInSteps = formId && actionText.includes(formId);

      const key = CoverageMapper.entityKey('form', form);
      const actedOn = actsOn(FORM_ACTION, formId) ||
        (form.fields || []).some(f => actsOn(FORM_ACTION, String(f || '').toLowerCase()));

      const formScoped = inScope(form.url, formIdCounts.get(formId) || 1);
      if ((formIdInSteps || fieldsInSteps.length > 0) && actedOn && formScoped) {
        const strong = formIdInSteps || fieldsInSteps.length >= Math.max(1, (form.fields || []).length / 2);
        coveredFeatures.push({ type: 'form', key, id: form.id, url: form.url, confidence: strong ? 'HIGH' : 'MEDIUM' });
      } else if ((formId && mentionText.includes(formId)) || fieldsInSteps.length > 0) {
        // Mentioned/partially touched but not clearly exercised.
        coveredFeatures.push({ type: 'form', key, id: form.id, url: form.url, confidence: 'LOW' });
      }
    });

    // Check APIs — require the endpoint/method to appear in the actionable text.
    inventory.apis.forEach(api => {
      const endpoint = (api.endpoint || '').toLowerCase();
      const method = (api.method || '').toLowerCase();
      const endpointInSteps = endpoint && actionText.includes(endpoint);
      const methodInSteps = method && actionText.includes(method);

      const key = CoverageMapper.entityKey('api', api);
      // F16: an operation on a path is only covered when THIS method is the one
      // exercised. Previously any mention of the endpoint marked every method on
      // it covered, so a read test credited coverage of the delete operation.
      const methodOnEndpoint = actsOn(new RegExp(`\\b${method}\\b`), endpoint);

      if (endpointInSteps && methodOnEndpoint) {
        coveredFeatures.push({ type: 'api', key, id: api.endpoint, method: api.method, confidence: 'HIGH' });
      } else if (endpointInSteps && !CoverageMapper.methodsMentioned(actionText)) {
        // Endpoint exercised and no method named at all → assume the observed
        // method; still only MEDIUM, and never when a DIFFERENT method is named.
        coveredFeatures.push({ type: 'api', key, id: api.endpoint, method: api.method, confidence: hasAction(API_ACTION) ? 'MEDIUM' : 'LOW' });
      } else if (endpointInSteps) {
        coveredFeatures.push({ type: 'api', key, id: api.endpoint, method: api.method, confidence: 'LOW' });
      } else if (methodInSteps) {
        // method + at least half the endpoint path segments present in steps
        const parts = endpoint.split('/').filter(Boolean);
        const matched = parts.filter(p => actionText.includes(p));
        if (parts.length && matched.length >= parts.length / 2) {
          coveredFeatures.push({ type: 'api', key, id: api.endpoint, method: api.method, confidence: 'MEDIUM' });
        }
      }
    });

    // Check buttons — require a click-style action on the button in steps.
    inventory.buttons.forEach(button => {
      const buttonText = (button.text || '').toLowerCase();
      if (!buttonText) return;
      const key = CoverageMapper.entityKey('button', button);
      const scoped = inScope(button.url, labelCounts.get(buttonText) || 1);
      if (actsOn(BTN_ACTION, buttonText) && scoped) {
        coveredFeatures.push({ type: 'button', key, id: button.text, url: button.url, confidence: 'HIGH' });
      } else if (actionText.includes(buttonText) || mentionText.includes(buttonText)) {
        coveredFeatures.push({ type: 'button', key, id: button.text, url: button.url, confidence: 'LOW' });
      }
    });

    // Check pages — require a navigation action or the URL/title in actionable text.
    inventory.pages.forEach(page => {
      const pageUrl = (page.url || '').toLowerCase();
      const pageTitle = (page.title || '').toLowerCase();

      const key = CoverageMapper.entityKey('page', page);
      if (pageUrl && actsOn(NAV_ACTION, pageUrl)) {
        coveredFeatures.push({ type: 'page', key, id: page.url, confidence: 'HIGH' });
      } else if (pageUrl && actionText.includes(pageUrl)) {
        coveredFeatures.push({ type: 'page', key, id: page.url, confidence: 'MEDIUM' });
      } else if (pageTitle && (actionText.includes(pageTitle) || mentionText.includes(pageTitle))) {
        coveredFeatures.push({ type: 'page', key, id: page.url, confidence: 'LOW' });
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
/**
 * F07: polarity of a requirement/assertion — does it say a thing HAPPENS or that
 * it is PREVENTED? Token recall is polarity-blind ('not'/'no' are stopwords and
 * "can" vs "cannot" share every other token), so an AC "Viewer cannot delete
 * invoices" scored 0.75 against a test asserting "Viewer CAN delete invoices"
 * and was reported 100% covered by its own contradiction.
 *
 * ponytail: lexical negation cues only — it cannot parse scope ("no field is
 * required") or double negatives. It is deliberately one-directional: a polarity
 * clash only WITHHOLDS coverage (the AC shows as an uncovered gap + a surfaced
 * contradiction), never grants it. Upgrade path is the requirement-predicate
 * model in fix2.md §7.1.
 */
const NEGATIVE_CUES = /\b(?:cannot|can't|cant|may not|must not|should not|shouldn't|shall not|will not|won't|does not|doesn't|do not|don't|is not|isn't|are not|aren't|not be|never|no longer|unable|denied|deny|denies|forbidden|prohibit(?:ed|s)?|disallow(?:ed|s)?|reject(?:ed|s)?|block(?:ed|s)?|prevent(?:ed|s)?|restrict(?:ed|s)?|unauthoriz(?:ed)?|unauthoris(?:ed)?|without permission|403|hidden|disabled|greyed out|grayed out|read[- ]only)\b/i;

function acPolarity(text) {
  return NEGATIVE_CUES.test(String(text || '')) ? 'negative' : 'positive';
}

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
