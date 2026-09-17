/**
 * Epic Mode — per-child-story test-case generation for a Jira Epic.
 *
 * When the open issue is an Epic, QAtalyst fetches its child stories and
 * generates test cases for EACH child in parallel (bounded concurrency), then
 * renders the results grouped per story. Context is managed compactly: a short
 * shared epic header is folded into each child's description rather than sending
 * the whole epic on every call, and child descriptions are clipped to a budget —
 * so each per-story LLM call stays within the model's token limit.
 *
 * The orchestration (`generateEpicTestCases`) takes injected dependencies
 * (`fetchEpicChildren`, `generateForChild`) so it is unit-testable without a
 * browser, chrome APIs, or the DOM. The pure helpers below are exported too.
 */
(function () {
  const EPIC_HEADER_MAX_CHARS = 1200;   // compact shared epic context per child
  const CHILD_DESC_MAX_CHARS = 6000;    // clip a single story's description
  const DEFAULT_CONCURRENCY = 3;        // parallel stories at once (rate-limit safe)

  /** Is the open issue an Epic? Tolerant of issueType / issuetype shapes. */
  function isEpicIssue(ticketData) {
    const t = (ticketData && (ticketData.issueType || ticketData.issuetype)) || '';
    return String(t).toLowerCase() === 'epic';
  }

  /**
   * JQL to find an epic's children. Jira "next-gen"/team-managed projects use
   * `parent`, classic/company-managed use the `Epic Link` field — query both so
   * either project style works.
   */
  function buildEpicChildrenJQL(epicKey) {
    const k = String(epicKey).replace(/["\\]/g, '');
    return `parent = "${k}" OR "Epic Link" = "${k}"`;
  }

  function truncate(text, max) {
    const s = String(text == null ? '' : text);
    return s.length > max ? s.slice(0, max) + '…[truncated]' : s;
  }

  /** Figma / Confluence / Google Docs URLs that should feed external enrichment. */
  function extractDocLinks(text) {
    const urls = String(text == null ? '' : text).match(/https?:\/\/[^\s)\]]+/g) || [];
    return urls.filter((u) => /figma\.com|atlassian\.net\/wiki|\/wiki\/|docs\.google\.com|drive\.google\.com/i.test(u));
  }

  /**
   * Truncate like `truncate`, but never drop a Figma/Confluence/Docs link that
   * sits past the cut point — those links drive external-content enrichment, so
   * losing them would silently strip context. Any such links in the dropped tail
   * are re-appended.
   */
  function truncateKeepingLinks(text, max) {
    const s = String(text == null ? '' : text);
    if (s.length <= max) return s;
    const head = s.slice(0, max);
    const tailLinks = extractDocLinks(s.slice(max)).filter((u) => !head.includes(u));
    const suffix = tailLinks.length ? `\n[linked docs] ${tailLinks.join(' ')}` : '';
    return head + '…[truncated]' + suffix;
  }

  /**
   * Compact shared epic context prepended to each child story. Keeps every
   * per-story call grounded in the epic's intent without re-sending the full
   * epic body N times.
   */
  function buildEpicHeader(epic, maxChars = EPIC_HEADER_MAX_CHARS) {
    const key = epic && epic.key ? `[${epic.key}] ` : '';
    const summary = (epic && epic.summary) || '';
    const desc = truncate((epic && epic.description) || '', maxChars);
    return `Parent Epic ${key}${summary}\n${desc}`.trim();
  }

  /**
   * Build the ticketData for a child story with the epic header folded into the
   * description. Reuses the existing prompt builder (which reads ticketData
   * summary/description) — no background changes needed.
   */
  function prepareChildTicketData(child, epicHeader) {
    const childDesc = truncateKeepingLinks((child && child.description) || '', CHILD_DESC_MAX_CHARS);
    return {
      ...child,
      description: `${epicHeader}\n\n--- Story ---\n${childDesc}`,
      _epicChild: true
    };
  }

  /**
   * Per-child test-case budget: split the configured total across children,
   * with a sensible floor/ceiling so each story still gets meaningful coverage
   * without exploding the run.
   */
  /**
   * F13: the per-child budget had a hard floor of 8, so an epic with 20 stories
   * generated at least 160 tests no matter what the user set the total to — the
   * displayed count was not a bound at all. The floor now yields to the global
   * budget: it raises a small share up to a usable minimum only while the total
   * can afford it. Counts are ceilings, never quotas to fill.
   */
  function perChildTestCount(totalTestCount, childCount, { min = 8, max = 25 } = {}) {
    const total = Number(totalTestCount) || 30;
    const n = Math.max(1, childCount);
    const share = Math.ceil(total / n);
    // Applying `min` must not push the epic past its own total.
    const affordableMin = Math.max(1, Math.floor(total / n));
    return Math.min(max, Math.max(Math.min(min, affordableMin), share));
  }

  /**
   * Bounded-concurrency map: run `worker` over `items`, at most `limit` in
   * flight. Never rejects — each slot resolves to {status,value|reason}, so one
   * failed story can't abort the whole epic run.
   */
  async function runWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const poolSize = Math.max(1, Math.min(limit || DEFAULT_CONCURRENCY, items.length));
    const runners = Array.from({ length: poolSize }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        try {
          results[i] = { status: 'fulfilled', value: await worker(items[i], i) };
        } catch (e) {
          results[i] = { status: 'rejected', reason: e };
        }
      }
    });
    await Promise.all(runners);
    return results;
  }

  /** Roll up per-child outcomes for the summary header. */
  function aggregateEpicResults(perChild) {
    let totalTests = 0, stories = 0, failed = 0;
    for (const r of perChild || []) {
      if (r && r.ok && Array.isArray(r.testCases)) { totalTests += r.testCases.length; stories++; }
      else failed++;
    }
    return { stories, failed, totalTests };
  }

  /**
   * F13: consolidate the WHOLE epic after every child has finished.
   *
   * Children were generated independently, each with its own AcceptanceGate, and
   * the results were simply concatenated. Three stories that each need a login
   * prerequisite therefore produced three near-identical login tests, and nothing
   * ever compared across children.
   *
   * This collapses proven equivalents across the epic while:
   *   - keeping EVERY story link on the surviving case (one shared case can
   *     legitimately cover several stories — the link set is the coverage, and
   *     dropping it would silently uncover a story),
   *   - refusing to merge pairs with a proven distinction (different actor,
   *     opposite outcome, different boundary), so per-child permission and state
   *     differences survive,
   *   - recording per-child counts before and after, so a reviewer can see that a
   *     story's coverage moved rather than disappeared.
   *
   * ponytail: consolidation only. It does not yet PROPOSE the cross-story
   * workflow test fix2.md F13 also asks for — that needs a generation pass over
   * the merged plan, not a filter over finished output.
   *
   * @param {Array<{child, testCases}>} results per-child results
   * @param {object} [deps] { Detector } — injected for tests; falls back to the global
   * @returns {{testCases, merged, perChild}}
   */
  function consolidateEpicSuite(results, deps = {}) {
    const rows = Array.isArray(results) ? results : [];
    const Detector = deps.Detector
      || (typeof SemanticDuplicateDetector !== 'undefined' ? SemanticDuplicateDetector : null)
      || (typeof self !== 'undefined' && self.SemanticDuplicateDetector)
      || (typeof window !== 'undefined' && window.SemanticDuplicateDetector);

    // Flatten, tagging every case with the story it came from.
    const flat = [];
    for (const row of rows) {
      const key = (row && row.child && (row.child.key || row.child.id)) || '';
      for (const tc of (row && row.testCases) || []) {
        flat.push({ ...tc, _stories: [key].filter(Boolean) });
      }
    }
    const before = countByStory(rows);

    if (!Detector || flat.length < 2) {
      return { testCases: flat, merged: [], perChild: { before, after: before } };
    }

    const det = new Detector(deps.threshold ?? 0.75);
    const kept = [];
    const merged = [];

    for (const candidate of flat) {
      let mergedInto = null;
      for (const existing of kept) {
        if (typeof Detector.distinctionReason === 'function' &&
            Detector.distinctionReason(candidate, existing)) continue;
        const groups = det.detectDuplicates([candidate, existing]) || [];
        if (groups.some(g => (g.duplicates || []).length > 0)) { mergedInto = existing; break; }
      }
      if (mergedInto) {
        // Carry the story links over — this is what keeps the merged-away
        // story's coverage attributed rather than lost.
        for (const s of candidate._stories) {
          if (!mergedInto._stories.includes(s)) mergedInto._stories.push(s);
        }
        merged.push({ title: candidate.title, into: mergedInto.title, stories: candidate._stories.slice() });
      } else {
        kept.push(candidate);
      }
    }

    // Per-story counts AFTER merging: a story is still covered by any case that
    // links to it, even when that case now serves several stories.
    const after = {};
    for (const tc of kept) for (const s of tc._stories) after[s] = (after[s] || 0) + 1;

    return { testCases: kept, merged, perChild: { before, after } };
  }

  function countByStory(rows) {
    const out = {};
    for (const row of rows || []) {
      const key = (row && row.child && (row.child.key || row.child.id)) || '';
      if (key) out[key] = ((row && row.testCases) || []).length;
    }
    return out;
  }

  /**
   * F13: propose the workflow that SPANS stories.
   *
   * Consolidation removes redundancy between children but can only ever return a
   * subset of what the children already wrote — and no child can write the test
   * that crosses story boundaries, because no child sees the others. An epic that
   * splits "create order / pay order / ship order" across three stories therefore
   * gets three isolated suites and nothing that walks the whole path, which is
   * exactly where integration defects live.
   *
   * This derives candidate end-to-end workflows from the consolidated suite by
   * chaining stories whose operations form a lifecycle, and returns them as
   * PROPOSALS for the caller to generate against — it does not invent test steps
   * from nothing.
   *
   * ponytail: operation-sequence heuristics over story titles and case
   * operations. A real workflow model needs the state/transition records of
   * fix2.md §7.1; this is the seam where that swaps in.
   */
  function proposeCrossStoryWorkflows(results, consolidated, opts = {}) {
    const rows = Array.isArray(results) ? results : [];
    if (rows.length < 2) return [];

    // Lifecycle order: an operation later in this list normally depends on one
    // earlier in it, which is what makes the chain a workflow rather than a set.
    const ORDER = ['create', 'add', 'submit', 'approve', 'pay', 'update', 'edit',
                   'assign', 'ship', 'complete', 'export', 'archive', 'cancel', 'delete'];
    const opOf = (text) => {
      const t = String(text || '').toLowerCase();
      for (const op of ORDER) if (new RegExp(`\\b${op}\\w*\\b`).test(t)) return op;
      return null;
    };

    const stories = rows.map(r => {
      const key = (r.child && (r.child.key || r.child.id)) || '';
      const summary = (r.child && (r.child.summary || r.child.title)) || '';
      const caseText = (r.testCases || []).map(t => t.title).join(' ');
      return { key, summary, op: opOf(summary) || opOf(caseText) };
    }).filter(s => s.key && s.op);

    // Order the stories by their position in the lifecycle.
    const chain = stories
      .filter((s, i, arr) => arr.findIndex(x => x.op === s.op) === i)
      .sort((a, b) => ORDER.indexOf(a.op) - ORDER.indexOf(b.op));

    if (chain.length < 2) return [];

    const subject = (opts.epicSummary || chain[0].summary || 'the epic')
      .replace(/^(epic|story)[:\s-]*/i, '').trim();

    return [{
      kind: 'cross_story_workflow',
      title: `End-to-end: ${chain.map(c => c.op).join(' → ')} across ${chain.length} stories`,
      stories: chain.map(c => c.key),
      operations: chain.map(c => c.op),
      // What the caller should ask a generator to produce. It is a PROPOSAL, not
      // a finished case — nothing here asserts behaviour the stories do not state.
      rationale: `Stories ${chain.map(c => c.key).join(', ')} implement consecutive stages of ${subject}. ` +
        `No child story can test the handover between them, because each is generated in isolation.`,
      focus: `A single test that performs ${chain.map(c => c.op).join(', then ')} in sequence, ` +
        `carrying the same record through every stage and asserting it survives each handover.`
    }];
  }

  /**
   * Orchestrate epic-mode generation.
   * @param {{key,summary,description}} epic
   * @param {object} deps
   *   - fetchEpicChildren(epicKey) => Promise<Array<childTicketData>>
   *   - generateForChild(childTicketData, index) => Promise<result>  (result.testCases[])
   *   - concurrency?: number
   *   - onProgress?: (done, total, child) => void
   * @returns {Promise<{epicKey, children, results, summary}>}
   */
  async function generateEpicTestCases(epic, deps) {
    const children = await deps.fetchEpicChildren(epic.key);
    if (!children || children.length === 0) {
      return { epicKey: epic.key, children: [], results: [], summary: aggregateEpicResults([]) };
    }

    const header = buildEpicHeader(epic);
    let done = 0;

    const settled = await runWithConcurrency(children, deps.concurrency, async (child, i) => {
      const childData = prepareChildTicketData(child, header);
      const res = await deps.generateForChild(childData, i);
      done++;
      if (deps.onProgress) { try { deps.onProgress(done, children.length, child); } catch (_) {} }
      return res;
    });

    const results = settled.map((s, i) => ({
      child: children[i],
      ok: s.status === 'fulfilled' && !!s.value,
      result: s.status === 'fulfilled' ? s.value : null,
      error: s.status === 'rejected' ? (s.reason && s.reason.message ? s.reason.message : String(s.reason)) : null,
      testCases: (s.status === 'fulfilled' && s.value && Array.isArray(s.value.testCases)) ? s.value.testCases : []
    }));

    // F13: one global consolidation pass across every child, instead of simply
    // concatenating independently-gated suites.
    const consolidated = consolidateEpicSuite(results, deps);

    // F13: the test that spans stories, which no child could have written.
    const workflows = proposeCrossStoryWorkflows(results, consolidated, { epicSummary: epic.summary });

    return {
      epicKey: epic.key,
      children,
      results,
      consolidated,
      workflows,
      summary: {
        ...aggregateEpicResults(results),
        consolidatedTests: consolidated.testCases.length,
        mergedAcrossStories: consolidated.merged.length
      }
    };
  }

  /**
   * Fold a child's comments, linked issues, and web/remote links into its
   * description text so they (a) give the model more context and (b) get scanned
   * for Figma/Confluence/Docs URLs by the external-content enrichment step.
   * Returns a new child object with an augmented `description`.
   */
  function foldChildContext(child) {
    if (!child) return child;
    const parts = [String(child.description || '')];

    const comments = Array.isArray(child.comments) ? child.comments : [];
    if (comments.length) {
      parts.push('--- Comments ---');
      for (const c of comments) {
        const author = (c && c.author) || '';
        const text = (c && (c.text || c.body)) || '';
        if (text) parts.push(`${author ? author + ': ' : ''}${text}`);
      }
    }

    const links = Array.isArray(child.issueLinks) ? child.issueLinks : [];
    if (links.length) {
      parts.push('--- Linked Issues ---');
      for (const l of links) {
        if (l && l.key) parts.push(`${l.type || 'relates to'} ${l.key}${l.summary ? ': ' + l.summary : ''}`);
      }
    }

    const remote = Array.isArray(child.remoteLinks) ? child.remoteLinks : [];
    if (remote.length) {
      parts.push('--- Web Links ---');
      for (const r of remote) {
        if (r && r.url) parts.push(`${r.title ? r.title + ' ' : ''}${r.url}`);
      }
    }

    return { ...child, description: parts.filter(Boolean).join('\n') };
  }

  /**
   * Filter children down to a set of selected keys, preserving original order.
   * Used by the "select child tickets" modal before generation.
   */
  function filterSelectedChildren(children, selectedKeys) {
    const set = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys || []);
    return (children || []).filter((c) => c && set.has(c.key));
  }

  /**
   * Build a single synthetic "rollup" ticketData for an epic, combining the epic
   * header with a compact digest of its (selected) children. Used by Analyse
   * Requirements and Generate Test Scope so they reason across the whole epic in
   * ONE call — no per-child fan-out. Bounded by per-child + overall char caps so
   * a large epic can't blow the context window.
   */
  function buildEpicRollupTicketData(epic, children, opts = {}) {
    const childMax = opts.childMax || 1200;
    const overallMax = opts.overallMax || 24000;
    const kids = children || [];
    const header = buildEpicHeader(epic);

    let digest = '';
    let included = 0;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      const block = `### Story ${i + 1}: ${c.key} — ${c.summary || ''}\n${truncateKeepingLinks(c.description || '', childMax)}`;
      if (digest.length + block.length > overallMax) {
        digest += `\n\n…(${kids.length - included} more stories omitted to fit context)`;
        break;
      }
      digest += (digest ? '\n\n' : '') + block;
      included++;
    }

    return {
      key: epic.key,
      summary: epic.summary || '',
      issueType: epic.issueType || 'Epic',
      description: `${header}\n\n=== Child Stories (${kids.length}) ===\n\n${digest}`,
      comments: [],
      attachments: [],
      linkedPages: [],
      _epicRollup: true,
      _childKeys: kids.map((c) => c.key)
    };
  }

  const api = {
    isEpicIssue, buildEpicChildrenJQL, buildEpicHeader, prepareChildTicketData,
    perChildTestCount, runWithConcurrency, aggregateEpicResults, generateEpicTestCases, consolidateEpicSuite, proposeCrossStoryWorkflows,
    filterSelectedChildren, buildEpicRollupTicketData, foldChildContext, truncate, truncateKeepingLinks, extractDocLinks
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.QAtalystEpicMode = api;
  if (typeof window !== 'undefined') window.QAtalystEpicMode = api;
})();
