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
  function perChildTestCount(totalTestCount, childCount, { min = 8, max = 25 } = {}) {
    const total = Number(totalTestCount) || 30;
    const n = Math.max(1, childCount);
    return Math.min(max, Math.max(min, Math.ceil(total / n)));
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

    return { epicKey: epic.key, children, results, summary: aggregateEpicResults(results) };
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
    perChildTestCount, runWithConcurrency, aggregateEpicResults, generateEpicTestCases,
    filterSelectedChildren, buildEpicRollupTicketData, foldChildContext, truncate, truncateKeepingLinks, extractDocLinks
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.QAtalystEpicMode = api;
  if (typeof window !== 'undefined') window.QAtalystEpicMode = api;
})();
