// Content script - Injects QAtalyst panel into Jira pages

(function() {
  'use strict';

  // content.js depends on helpers in the other content scripts listed before it in
  // manifest.json. If Chrome is still using an older manifest (the extension was
  // updated on disk but not reloaded), this file runs without them and every
  // action fails with "X is not defined". Say what to do instead of crashing.
  const REQUIRED = ['extractTicketKey', 'extractTicketData', 'loadAndDecryptSettings', 'escapeHtml',
    'buildTestCasesCSV', 'filterTestCases', 'handleExtractDOM', 'PlaywrightExport', 'TestSteps'];
  const missing = REQUIRED.filter(name => typeof globalThis[name] === 'undefined' && typeof window[name] === 'undefined');
  if (missing.length) {
    console.error(`[QAtalyst] Extension files out of date (missing: ${missing.join(', ')}). Reload QAtalyst at chrome://extensions, then refresh this page.`);
    if (location.pathname.includes('/browse/') && !document.getElementById('qatalyst-reload-notice')) {
      const note = document.createElement('div');
      note.id = 'qatalyst-reload-notice';
      note.setAttribute('role', 'alert');
      note.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:340px;padding:12px 14px;' +
        'background:#fff7ed;border:1px solid #fb923c;border-radius:8px;font:13px/1.4 system-ui,sans-serif;color:#7c2d12;' +
        'box-shadow:0 4px 12px rgba(0,0,0,.15)';
      note.textContent = 'QAtalyst was updated. Open chrome://extensions, click Reload on QAtalyst, then refresh this page.';
      (document.body || document.documentElement).appendChild(note);
    }
    return;
  }

  // Streaming state
  let currentStreamingRequestId = null;
  let streamingContent = '';
  let isStreaming = false;

  // Pending stream completions: streamType -> {resolve, reject}
  // Used to bridge the gap between the immediate ACK and the final streamComplete message.
  const pendingStreamCompletions = new Map();

  /**
   * F17: does this completion belong to the run that is still waiting?
   * A pending entry records the ticket it was started for; a message carrying a
   * DIFFERENT ticket key is a late result from a superseded run and is dropped.
   * Messages with no ticket key are accepted (older worker builds).
   */
  function isCurrentRun(pending, message) {
    if (!message || !message.ticketKey) return true;
    if (!pending || !pending.ticketKey) return true;
    return pending.ticketKey === message.ticketKey;
  }

  // escapeHtml, createSafeErrorMessage, createSafeFormattedContent → content-format.js

  // Listen for streaming chunks, agent progress, enhancement progress, and historical mining progress.
  // F21: the evolution* listeners are gone — that generation path was retired and
  // nothing has sent those messages since, so they were dead handlers for a
  // status the system can no longer produce.
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'streamChunk') {
      handleStreamChunk(request.requestId, request.chunk);
    }

    // Final result delivered via tab message (avoids message-channel-closed error in MV3)
    //
    // F17: completion is matched on streamType ALONE, which is not a run identity.
    // After navigating to another ticket (or starting a replacement run), a late
    // result from the previous run resolved the current panel's pending promise
    // and rendered the old ticket's tests as if they were this one's. Reject any
    // completion whose ticket doesn't match what the pending request asked for.
    if (request.action === 'streamComplete') {
      const pending = pendingStreamCompletions.get(request.streamType);
      if (pending && isCurrentRun(pending, request)) {
        pendingStreamCompletions.delete(request.streamType);
        pending.resolve(request.result);
      } else if (pending) {
        console.warn('[QAtalyst] Ignored a stale streamComplete for', request.ticketKey || '(unknown ticket)');
      }
    }
    if (request.action === 'streamError') {
      const pending = pendingStreamCompletions.get(request.streamType);
      if (pending && isCurrentRun(pending, request)) {
        pendingStreamCompletions.delete(request.streamType);
        pending.reject(new Error(request.error));
      }
    }

    if (request.action === 'keepAlive') {
      // UI liveness heartbeat only. NOTE: the real service-worker keepalive is
      // done worker-side (F15) — a message to this tab does NOT reset the SW
      // idle timer. This just signals the panel that generation is progressing.
      console.log('💓 Keep-alive heartbeat received');
    }
    if (request.action === 'agentProgress') {
      handleAgentProgress(request.progress);
    }
    if (request.action === 'enhancementProgress') {
      handleEnhancementProgress(request.status);
    }
    if (request.action === 'contextQualityAssessment') {
      handleContextQualityAssessment(request.assessment);
    }
    if (request.action === 'historicalMiningProgress') {
      // The worker sends `progress`, not `status`. Reading the wrong field made
      // this always undefined, so the panel rendered "✅ Mining complete" from the
      // very first event — mining looked finished before it had started.
      handleHistoricalMiningProgress(request.progress || request.status);
    }
    if (request.type === 'UPLOAD_PROGRESS') {
      handleUploadProgress(request.progress);
    }
    if (request.action === 'runTestsProgress') {
      const box = document.getElementById('run-results');
      if (box) box.innerHTML = `<div class="quality-note">▶️ ${request.done}/${request.total} — last: ${escapeHtml((request.result && request.result.id) || '')} ${escapeHtml((request.result && request.result.status) || '')}</div>`;
    }
    if (request.action === 'qualityReports') {
      handleQualityReports(request.reports);
    }

    // Crawler messages (extractDOM, discoverLinks, …) are answered by
    // content-crawler.js's own listener.
  });

  // loadAndDecryptSettings, fetchTicketDataFromAPI → content-ticket.js
  /**
   * Fetch an Epic's child stories. Returns { children: [], error: string|null }.
   *
   * Tries multiple strategies because epic→child linkage and the search endpoint
   * vary by Jira project type and API version:
   *   1. Agile API  /rest/agile/1.0/epic/{key}/issue  — most reliable, works for
   *      both team-managed and company-managed projects, no JQL field pitfalls.
   *   2. New search /rest/api/3/search/jql with `parent = KEY` (team-managed).
   *   3. New search with `"Epic Link" = KEY` (classic/company-managed).
   *   4. Legacy /rest/api/3/search (older self-hosted Jira) with the same JQLs.
   * The first strategy that returns issues wins. If all fail, the LAST real
   * error (status + message) is returned so the UI can show WHY, instead of a
   * misleading "no children found".
   */
  async function fetchEpicChildren(epicKey) {
    const settings = await loadAndDecryptSettings(['jiraBaseUrl', 'jiraEmail', 'jiraApiToken']);
    if (!settings.jiraEmail || !settings.jiraApiToken) {
      return { children: [], error: 'Jira API credentials are not configured (Email + API token).' };
    }
    const base = (settings.jiraBaseUrl || window.location.origin).replace(/\/+$/, '');
    const auth = 'Basic ' + btoa(`${settings.jiraEmail}:${settings.jiraApiToken}`);
    const maxResults = 50;

    const mapIssue = (issue) => {
      const f = issue.fields || {};
      // Comments (URLs in comment bodies are preserved by extractTextFromADF).
      const comments = (f.comment?.comments || []).map((c) => ({
        author: c.author?.displayName || '',
        text: extractTextFromADF(c.body) || ''
      })).filter((c) => c.text);
      // Issue-links panel: issue-to-issue links (other tickets) with direction.
      const issueLinks = (f.issuelinks || []).map((l) => {
        const linked = l.outwardIssue || l.inwardIssue;
        if (!linked) return null;
        const rel = l.outwardIssue ? (l.type?.outward || 'relates to') : (l.type?.inward || 'relates to');
        return { key: linked.key, summary: linked.fields?.summary || '', type: rel };
      }).filter(Boolean);
      return {
        key: issue.key,
        summary: f.summary || '',
        description: extractTextFromADF(f.description) || '',
        issueType: f.issuetype?.name || '',
        comments,
        issueLinks
      };
    };

    const getJson = async (url) => {
      const resp = await fetch(url, { method: 'GET', headers: { 'Authorization': auth, 'Accept': 'application/json' } });
      if (!resp.ok) {
        let detail = '';
        try { const j = await resp.json(); detail = (j.errorMessages && j.errorMessages.join('; ')) || JSON.stringify(j.errors || {}); } catch (_) {}
        throw new Error(`HTTP ${resp.status} ${resp.statusText}${detail ? ' — ' + detail : ''}`);
      }
      return resp.json();
    };

    const fields = 'summary,description,issuetype,comment,issuelinks';
    const k = encodeURIComponent(epicKey);
    const strategies = [
      { label: 'agile-api', url: `${base}/rest/agile/1.0/epic/${k}/issue?fields=${fields}&maxResults=${maxResults}` },
      { label: 'search/jql parent', url: `${base}/rest/api/3/search/jql?jql=${encodeURIComponent(`parent = "${epicKey}"`)}&fields=${fields}&maxResults=${maxResults}` },
      { label: 'search/jql Epic Link', url: `${base}/rest/api/3/search/jql?jql=${encodeURIComponent(`"Epic Link" = "${epicKey}"`)}&fields=${fields}&maxResults=${maxResults}` },
      { label: 'legacy search parent', url: `${base}/rest/api/3/search?jql=${encodeURIComponent(`parent = "${epicKey}"`)}&fields=${fields}&maxResults=${maxResults}` },
      { label: 'legacy search Epic Link', url: `${base}/rest/api/3/search?jql=${encodeURIComponent(`"Epic Link" = "${epicKey}"`)}&fields=${fields}&maxResults=${maxResults}` },
    ];

    let lastError = null;
    for (const s of strategies) {
      try {
        const result = await getJson(s.url);
        const issues = (result.issues || []).map(mapIssue);
        if (issues.length > 0) {
          console.log(`📚 Epic ${epicKey}: ${issues.length} child stories via ${s.label}`);
          return { children: issues, error: null };
        }
        console.log(`ℹ️ Epic ${epicKey}: 0 children via ${s.label}, trying next strategy`);
      } catch (err) {
        lastError = `${s.label}: ${err.message}`;
        console.warn(`⚠️ Epic children fetch (${s.label}) failed:`, err.message);
      }
    }
    return { children: [], error: lastError };
  }

  /**
   * Fetch a single issue's web/remote links (the "Web links" in the issue-links
   * panel — often where Confluence/Figma/Docs URLs live). Returns [{title,url}].
   */
  async function fetchChildRemoteLinks(issueKey) {
    try {
      const settings = await loadAndDecryptSettings(['jiraBaseUrl', 'jiraEmail', 'jiraApiToken']);
      if (!settings.jiraEmail || !settings.jiraApiToken) return [];
      const base = (settings.jiraBaseUrl || window.location.origin).replace(/\/+$/, '');
      const resp = await fetch(`${base}/rest/api/3/issue/${encodeURIComponent(issueKey)}/remotelink`, {
        method: 'GET',
        headers: { 'Authorization': 'Basic ' + btoa(`${settings.jiraEmail}:${settings.jiraApiToken}`), 'Accept': 'application/json' }
      });
      if (!resp.ok) return [];
      const links = await resp.json();
      return (links || []).map((l) => ({ title: l.object?.title || '', url: l.object?.url || '' })).filter((l) => l.url);
    } catch (err) {
      console.warn(`⚠️ Remote-link fetch failed for ${issueKey}:`, err.message);
      return [];
    }
  }

  /**
   * Fold each selected child's comments + linked issues (free — already fetched)
   * into its description. Web/remote links from the issue-links panel require an
   * extra request per child, so that step is OPT-IN via the
   * `epicFetchWebLinks` setting (default off) to keep large epics fast.
   */
  /**
   * Load each selected child exactly as a single story is loaded, so a story
   * generated inside its epic gets the same context as on its own: the full issue
   * (acceptance-criteria field, labels, components, priority, parent), its
   * attachments (spec PDFs/DOCX/images) and its web links. The epic search only
   * returns summary/description/comments/links; that light record is now only a
   * fallback when the full fetch fails.
   */
  async function prepareSelectedChildren(selected) {
    let fetchWebLinks = true;
    try {
      const s = await chrome.storage.sync.get(['epicFetchWebLinks']);
      fetchWebLinks = s.epicFetchWebLinks !== false; // on by default, like a story's linked pages
    } catch (_) { /* default on */ }
    const settings = await loadAndDecryptSettings(['llmProvider', 'llmModel', 'jiraBaseUrl', 'jiraEmail', 'jiraApiToken']);

    const settled = await QAtalystEpicMode.runWithConcurrency(selected, 4, async (child) => {
      const full = await fetchTicketDataFromAPI(child.key);
      const data = full ? { ...full } : QAtalystEpicMode.foldChildContext(child);
      if (fetchWebLinks) {
        const links = await fetchChildRemoteLinks(child.key);
        if (links.length) {
          data.remoteLinks = links;
          // In the description so external-content enrichment finds Confluence/Figma/Docs URLs.
          data.description = `${data.description || ''}\n--- Web Links ---\n` +
            links.map(r => `${r.title ? r.title + ' ' : ''}${r.url}`).join('\n');
        }
      }
      if (Array.isArray(data.attachments) && data.attachments.length) {
        try { await enrichTicketAttachments(data, settings); } catch (e) {
          console.warn(`⚠️ Attachments for ${child.key} could not be read:`, e.message);
        }
      }
      return data;
    });
    return settled.map((s, i) => (s && s.status === 'fulfilled' && s.value) ? s.value : QAtalystEpicMode.foldChildContext(selected[i]));
  }

  /**
   * Show a modal listing the epic's child stories so the user can choose which
   * to generate test cases for. All selected by default, with a Select-all bulk
   * toggle. Resolves with the selected child array, or null if cancelled.
   */
  function promptEpicChildSelection(epic, children) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.id = 'qatalyst-epic-select-overlay';
      overlay.style.cssText = `position: fixed; inset: 0; background: rgba(0,0,0,0.5);
        z-index: 10000000; display: flex; align-items: center; justify-content: center;`;

      const modal = document.createElement('div');
      modal.style.cssText = `background: white; border-radius: 12px; padding: 20px; width: 460px;
        max-width: 92vw; max-height: 82vh; display: flex; flex-direction: column;
        box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;`;

      const rows = children.map((c, i) => {
        const key = escapeHtml(c.key || '');
        const summary = escapeHtml(c.summary || '(no summary)');
        const type = escapeHtml(c.issueType || '');
        return `<label style="display:flex; align-items:flex-start; gap:10px; padding:8px 10px;
            border-radius:6px; cursor:pointer; ${i % 2 ? 'background:#f8fafc;' : ''}">
          <input type="checkbox" class="qa-epic-child" data-key="${key}" checked
            style="width:16px; height:16px; min-width:16px; margin:2px 0 0 0; flex-shrink:0;">
          <span style="font-size:13px; color:#1e293b; line-height:1.4;">
            <strong>${key}</strong>${type ? ` <span style="color:#64748b;">· ${type}</span>` : ''}<br>
            <span style="color:#475569;">${summary}</span>
          </span>
        </label>`;
      }).join('');

      modal.innerHTML = `
        <h3 style="margin:0 0 4px 0; font-size:18px; color:#1e293b;">🧭 Epic ${escapeHtml(epic.key)} — Select Stories</h3>
        <p style="margin:0 0 12px 0; font-size:13px; color:#64748b;">
          ${children.length} child stor${children.length === 1 ? 'y' : 'ies'} found. Choose which to generate test cases for.
        </p>
        <label style="display:flex; align-items:center; gap:10px; padding:8px 10px; border-bottom:1px solid #e2e8f0; cursor:pointer;">
          <input type="checkbox" id="qa-epic-select-all" checked
            style="width:16px; height:16px; min-width:16px; margin:0; flex-shrink:0;">
          <span style="font-size:13px; font-weight:600; color:#1e293b;">Select all</span>
        </label>
        <div id="qa-epic-list" style="overflow-y:auto; margin:8px 0; flex:1; min-height:60px;">${rows}</div>
        <div style="display:flex; gap:8px; padding-top:12px; border-top:1px solid #e2e8f0;">
          <button id="qa-epic-generate" style="flex:1; padding:10px 16px; background:#0ea5e9; color:white;
            border:none; border-radius:6px; font-size:14px; font-weight:500; cursor:pointer;">Generate (<span id="qa-epic-count">${children.length}</span>)</button>
          <button id="qa-epic-cancel" style="flex:1; padding:10px 16px; background:white; color:#475569;
            border:1px solid #cbd5e1; border-radius:6px; font-size:14px; font-weight:500; cursor:pointer;">Cancel</button>
        </div>`;

      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      const boxes = () => Array.from(modal.querySelectorAll('.qa-epic-child'));
      const selectAll = modal.querySelector('#qa-epic-select-all');
      const countEl = modal.querySelector('#qa-epic-count');
      const genBtn = modal.querySelector('#qa-epic-generate');

      const refresh = () => {
        const checked = boxes().filter((b) => b.checked);
        countEl.textContent = String(checked.length);
        genBtn.disabled = checked.length === 0;
        genBtn.style.opacity = checked.length === 0 ? '0.6' : '1';
        const all = boxes();
        selectAll.checked = checked.length === all.length;
        selectAll.indeterminate = checked.length > 0 && checked.length < all.length;
      };

      selectAll.addEventListener('change', () => { boxes().forEach((b) => { b.checked = selectAll.checked; }); refresh(); });
      modal.querySelector('#qa-epic-list').addEventListener('change', (e) => {
        if (e.target.classList.contains('qa-epic-child')) refresh();
      });

      const close = (value) => { overlay.remove(); resolve(value); };
      genBtn.addEventListener('click', () => {
        const selectedKeys = new Set(boxes().filter((b) => b.checked).map((b) => b.dataset.key));
        close(QAtalystEpicMode.filterSelectedChildren(children, selectedKeys));
      });
      modal.querySelector('#qa-epic-cancel').addEventListener('click', () => close(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
      refresh();
    });
  }

  /**
   * For Analyse Requirements / Generate Test Scope: if the open issue is an Epic,
   * fetch its children, let the user select which to include, and return a single
   * synthetic "rollup" ticket (epic + selected children digest) to run the normal
   * single-ticket flow on. Returns:
   *   - the original ticketData (unchanged) if it isn't an epic or has no children
   *   - a rollup ticketData if the user confirms a selection
   *   - null if the user cancels (caller should abort)
   */
  async function resolveEpicRollupTicketData(ticketData, resultsContainer) {
    if (typeof QAtalystEpicMode === 'undefined' || !QAtalystEpicMode.isEpicIssue(ticketData)) {
      return ticketData;
    }
    if (resultsContainer) {
      resultsContainer.innerHTML = '<div class="qatalyst-loading">🧭 Epic detected — fetching child stories…</div>';
    }
    const { children, error } = await fetchEpicChildren(ticketData.key);
    if (!children.length) {
      // No children (or fetch failed): fall back to the epic's own body so the
      // action still works, but log why.
      if (error) console.warn(`⚠️ Epic rollup: could not fetch children — ${error}`);
      return ticketData;
    }
    const picked = await promptEpicChildSelection(ticketData, children);
    if (!picked || picked.length === 0) return null; // cancelled
    if (resultsContainer) {
      resultsContainer.innerHTML = '<div class="qatalyst-loading">🧭 Gathering story context (comments, links)…</div>';
    }
    const selected = await prepareSelectedChildren(picked);
    return QAtalystEpicMode.buildEpicRollupTicketData(ticketData, selected);
  }

  /**
   * Generate test cases for a single child story via the agentic engine
   * (non-streaming so calls are parallel-safe — progress events are suppressed
   * during Epic Mode). Resolves with the handler's result object.
   */
  function generateForChild(childData, perChildSettings, appContext) {
    // Bounded like the single-ticket path. Epic children used a bare Promise with
    // no timeout, so one child whose worker call never returned left the whole
    // epic waiting forever — the same hang that was fixed for stories.
    return withGenerationTimeout(new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'generateTestCasesAgentic',
        data: {
          ticketKey: childData.key,
          ticketData: childData,
          settings: perChildSettings,
          baseUrl: window.location.origin,
          appContext,
          // Epic children were the only generation path that never received the
          // reviewed analysis/scope, so a correction made in review applied to a
          // story but not to the same story inside its epic.
          reviewedContext: buildReviewedContext()
        }
      }, response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || 'runtime error'));
        } else if (!response) {
          reject(new Error('No response from extension'));
        } else if (response.error) {
          reject(new Error(typeof response.error === 'string' ? response.error : (response.error.message || 'generation error')));
        } else {
          resolve(response);
        }
      });
    }));
  }

  /**
   * Epic Mode orchestration: fetch the epic's child stories, generate test cases
   * for each in parallel (bounded concurrency), and render grouped per story.
   * The test budget is split across children so the whole run stays bounded.
   */
  async function runEpicMode(epic, settings, appContext, resultsContainer) {
    suppressAgentProgress = true; // concurrent agentic runs would scramble the panel
    const concurrency = 3;
    resultsContainer.innerHTML = '<div class="qatalyst-loading">🧭 Epic Mode: fetching child stories…</div>';

    const { children, error } = await fetchEpicChildren(epic.key);
    if (!children.length) {
      resultsContainer.innerHTML = '';
      const msg = error
        ? `Could not fetch this epic's child stories. Jira API said: ${error}. ` +
          `Verify the Jira Base URL/credentials in Advanced Settings, and that ${epic.key} actually has child issues.`
        : `No child stories are linked to ${epic.key}. Add child issues to the epic, or generate against an individual story instead.`;
      resultsContainer.appendChild(createSafeErrorMessage(msg));
      return;
    }

    // Let the user pick which child stories to generate for (all selected by default).
    const picked = await promptEpicChildSelection(epic, children);
    if (!picked || picked.length === 0) {
      resultsContainer.innerHTML = '';
      resultsContainer.appendChild(createSafeErrorMessage('Epic Mode cancelled — no stories selected.'));
      return;
    }
    // Pull each selected story's comments / linked issues / web links into context.
    resultsContainer.innerHTML = '<div class="qatalyst-loading">🧭 Epic Mode: loading each story (criteria, attachments, links)…</div>';
    const selected = await prepareSelectedChildren(picked);

    // Parity with a single story: each story gets the full test budget. Splitting
    // one budget across stories gave 3 tests each to a 10-story epic, and the loop
    // stopped with criteria uncovered. Cost is about one single-story run per story.
    const perCount = Number(settings.testCount) || 30;
    resultsContainer.innerHTML = '<div class="qatalyst-loading"></div>';
    const setLoading = (txt) => {
      const el = resultsContainer.querySelector('.qatalyst-loading');
      if (el) el.textContent = txt;
    };
    setLoading(`🧭 Epic Mode: generating up to ${perCount} tests for each of ${selected.length} stories (0/${selected.length})…`);

    const out = await QAtalystEpicMode.generateEpicTestCases(epic, {
      fetchEpicChildren: async () => selected, // user-selected subset
      concurrency,
      onProgress: (done, total) => setLoading(`🧭 Epic Mode: generating tests for ${total} stories (${done}/${total})…`),
      // Crawl context matched to EACH story (as for a single story), not the epic's
      // wording; the epic-level context is the fallback.
      generateForChild: async (childData) => {
        let ctx = appContext;
        if (appContext) {
          try { ctx = (await extractAppContext(childData)) || appContext; } catch (_) { ctx = appContext; }
        }
        return generateForChild(childData, { ...settings, testCount: perCount }, ctx);
      }
    });

    displayEpicResults(epic, out, resultsContainer);
  }

  /** Render Epic Mode results grouped per child story. */
  function displayEpicResults(epic, out, resultsContainer) {
    const { summary, results } = out;
    const wrap = document.createElement('div');
    wrap.className = 'result-content test-cases epic-results';
    wrap.dataset.testid = 'epic-results';

    const head = document.createElement('div');
    head.className = 'epic-summary';
    head.style.cssText = 'padding:12px;margin-bottom:12px;background:#f0f9ff;border:1px solid #bae6fd;border-radius:6px;font-size:13px;color:#075985;';
    // F13: report the CONSOLIDATED total, and say how many cases were shared
    // across stories — otherwise a global merge is indistinguishable from tests
    // having gone missing.
    const consolidated = out.consolidated;
    const finalCount = consolidated ? consolidated.testCases.length : summary.totalTests;
    head.textContent = `🧭 Epic ${epic.key}: ${finalCount} test cases across ${summary.stories} stories` +
      (consolidated && consolidated.merged.length
        ? ` • ${consolidated.merged.length} duplicate(s) shared across stories instead of repeated`
        : '') +
      (summary.failed ? ` • ${summary.failed} story(ies) failed` : '');
    wrap.appendChild(head);

    results.forEach((r, i) => {
      const details = document.createElement('details');
      details.style.cssText = 'margin-bottom:10px;border:1px solid #e2e8f0;border-radius:6px;';
      if (i === 0) details.open = true;
      const summaryEl = document.createElement('summary');
      summaryEl.style.cssText = 'padding:10px 12px;cursor:pointer;font-weight:600;color:#1e293b;';
      const count = r.ok ? `${r.testCases.length} tests` : `⚠️ ${r.error || 'failed'}`;
      summaryEl.textContent = `${r.child.key} — ${r.child.summary || ''} (${count})`;
      details.appendChild(summaryEl);

      const body = document.createElement('div');
      body.style.cssText = 'padding:0 12px 12px 12px;';
      if (r.ok && r.testCases.length) {
        // formatTestCases returns trusted, escaped HTML for the test-case cards.
        body.innerHTML = formatTestCases(r.testCases);
      } else {
        body.appendChild(createSafeErrorMessage(r.error || 'No test cases generated for this story.'));
      }
      details.appendChild(body);
      wrap.appendChild(details);
    });

    resultsContainer.innerHTML = '';
    resultsContainer.appendChild(wrap);
  }

  // extractVisibleText → content-ticket.js
  // extractTextFromADF → content-utils.js

  function handleStreamChunk(requestId, chunk) {
    if (requestId !== currentStreamingRequestId) return;

    streamingContent += chunk;
    const resultsContainer = document.getElementById('results-container');
    if (!resultsContainer) return;

    // Reuse existing streaming container instead of rebuilding DOM every chunk
    let streamingDiv = resultsContainer.querySelector('.qatalyst-streaming');
    if (!streamingDiv) {
      // First chunk: create the streaming container
      resultsContainer.innerHTML = '';

      streamingDiv = document.createElement('div');
      streamingDiv.className = 'qatalyst-streaming';

      const headerDiv = document.createElement('div');
      headerDiv.className = 'stream-header';

      const statusSpan = document.createElement('span');
      statusSpan.className = 'stream-status';
      statusSpan.textContent = '✨ Generating...';

      const stopBtn = document.createElement('button');
      stopBtn.className = 'stop-btn';
      stopBtn.id = 'stop-stream-btn';
      stopBtn.textContent = '⏹ Stop';
      stopBtn.addEventListener('click', stopStreaming);

      headerDiv.appendChild(statusSpan);
      headerDiv.appendChild(stopBtn);

      const contentDiv = document.createElement('div');
      contentDiv.className = 'stream-content';

      streamingDiv.appendChild(headerDiv);
      streamingDiv.appendChild(contentDiv);
      resultsContainer.appendChild(streamingDiv);
    }

    // Only update the content div (not the entire DOM tree)
    const contentDiv = streamingDiv.querySelector('.stream-content');
    if (contentDiv) {
      contentDiv.innerHTML = '';
      contentDiv.appendChild(createSafeFormattedContent(streamingContent));
    }

    // Auto-scroll to bottom
    resultsContainer.scrollTop = resultsContainer.scrollHeight;
  }
  
  // formatStreamingContent → content-format.js

  function stopStreaming() {
    if (currentStreamingRequestId) {
      chrome.runtime.sendMessage({
        action: 'stopGeneration',
        requestId: currentStreamingRequestId
      });
      isStreaming = false;
      currentStreamingRequestId = null;
      
      // Update UI with safe DOM manipulation
      const resultsContainer = document.getElementById('results-container');
      if (resultsContainer) {
        resultsContainer.innerHTML = '';

        const warningDiv = document.createElement('div');
        warningDiv.className = 'qatalyst-warning';
        warningDiv.textContent = '⚠️ Generation stopped by user';

        const contentWrapper = document.createElement('div');
        contentWrapper.style.marginTop = '10px';
        contentWrapper.appendChild(createSafeFormattedContent(streamingContent));

        warningDiv.appendChild(contentWrapper);
        resultsContainer.appendChild(warningDiv);
      }
    }
  }
  
  // Once the final results are rendered, ignore any in-flight progress messages so a
  // late "done"/observation event can't overwrite the test-case list (race fix).
  let suppressAgentProgress = false;

  /**
   * One persistent "generating" surface.
   *
   * Generation can run for minutes, and the panel had no owner: the initial
   * loading message, the historical-mining panel and the agent-progress panel
   * each did `resultsContainer.innerHTML = …`, so the last writer won. Once
   * mining finished, its "✅ Mining complete" box simply sat there while the
   * planner worked — the user was left looking at a finished-looking panel with
   * no indication anything was still happening, and no way to tell a slow run
   * from a hung one.
   *
   * This owns the container for the whole run: sub-steps update IN PLACE, and an
   * elapsed clock ticks regardless of whether events are arriving, so the UI
   * proves liveness between sparse planner steps.
   */
  const GenerationStatus = {
    _timer: null,
    _startedAt: 0,
    _lastEventAt: 0,
    _state: null,

    // A run that goes quiet for this long is reported as possibly stalled. It is
    // NOT cancelled automatically — a local model on a big ticket can genuinely
    // be this slow, and killing real work would be worse than waiting.
    STALL_WARN_MS: 120000,

    start(label = 'Generating test cases…') {
      this._startedAt = Date.now();
      this._lastEventAt = Date.now();
      this._state = { label, phase: 'Starting', detail: '', step: null, total: null, count: null, done: [] };
      this._render();
      clearInterval(this._timer);
      // Tick independently of events: a long planner step must not look frozen.
      this._timer = setInterval(() => this._render(), 1000);
    },

    update(patch = {}) {
      if (!this._state) return; // never resurrect a finished run from a late event
      this._lastEventAt = Date.now();
      // A finished phase is remembered, so progress reads as a trail rather than
      // a single line that keeps being overwritten.
      if (patch.phase && patch.phase !== this._state.phase && this._state.phase) {
        this._state.done.push(this._state.phase);
      }
      Object.assign(this._state, patch);
      this._render();
    },

    /** Silence since the last progress event — the signal that something is wrong. */
    _stalledMs() {
      return this._lastEventAt ? Date.now() - this._lastEventAt : 0;
    },

    stop() {
      clearInterval(this._timer);
      this._timer = null;
      this._state = null;
      this._lastEventAt = 0;
    },

    isActive() { return !!this._state; },

    _elapsed() {
      const s = Math.floor((Date.now() - this._startedAt) / 1000);
      return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    },

    _render() {
      const container = document.getElementById('results-container');
      if (!container || !this._state) return;
      const st = this._state;
      const pct = (Number.isFinite(st.step) && Number.isFinite(st.total) && st.total > 0)
        ? Math.min(100, Math.round((st.step / st.total) * 100)) : null;

      // A run with no news for minutes must SAY so. Silently spinning forever is
      // what made a stalled run indistinguishable from a slow one.
      const stalledMs = this._stalledMs();
      const stalled = stalledMs > this.STALL_WARN_MS;
      const stalledMin = Math.floor(stalledMs / 60000);

      container.innerHTML = `
        <div class="qatalyst-generating${stalled ? ' gen-stalled' : ''}" data-testid="generation-status">
          <div class="gen-head">
            <span class="gen-spinner" aria-hidden="true"></span>
            <strong>${escapeHtml(st.label)}</strong>
            <span class="gen-elapsed" data-testid="generation-elapsed">${escapeHtml(this._elapsed())}</span>
          </div>
          <div class="gen-phase">${escapeHtml(st.phase || 'Working…')}${
            st.detail ? ` — <span class="gen-detail">${escapeHtml(String(st.detail).slice(0, 120))}</span>` : ''}</div>
          ${pct !== null ? `<div class="gen-bar"><div class="gen-fill" style="width:${pct}%"></div></div>` : ''}
          ${Number.isFinite(st.count) ? `<div class="gen-count">${st.count} test case(s) accepted so far</div>` : ''}
          ${st.done.length ? `<div class="gen-done">${st.done.slice(-4).map(d => `✓ ${escapeHtml(d)}`).join(' &nbsp; ')}</div>` : ''}
          ${stalled ? `
            <div class="gen-stall-warning" data-testid="generation-stalled">
              ⚠️ No progress for ${stalledMin} minute(s). The run may have stalled — or a local/slow model may still be working.
              Check the service-worker console for errors, or stop and try again.
            </div>` : ''}
          <div class="gen-note">This can take a few minutes on a large ticket. You can keep working — results appear here when ready.</div>
          <button type="button" class="gen-cancel" data-testid="generation-cancel">Stop generation</button>
        </div>`;

      // Cancel must be reachable at ANY point, not only once a run looks stuck.
      const cancelBtn = container.querySelector('[data-testid="generation-cancel"]');
      if (cancelBtn) cancelBtn.addEventListener('click', () => cancelGeneration());
    }
  };

  /**
   * Stop a running generation and hand the panel back to the user.
   *
   * There was no way out of a run at all: no cancel, and no client-side timeout,
   * so if the worker died or never replied the sendMessage callback simply never
   * fired and the panel waited forever.
   */
  /**
   * Bound a worker request in wall-clock time.
   *
   * `chrome.runtime.sendMessage` gives no timeout: if the service worker is
   * terminated mid-run, or throws before responding, the callback never fires and
   * the awaiting promise stays pending for the life of the page. That is how a
   * run could sit "Generating…" for fifteen minutes with nothing to click.
   *
   * The timeout is generous and progress-aware — it is a backstop against a DEAD
   * worker, not a limit on slow generation, so it only fires when the run has
   * also gone silent.
   */
  function withGenerationTimeout(promise, { hardMs = 45 * 60 * 1000 } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      // Its OWN clock. Reading GenerationStatus._startedAt would be 0 whenever the
      // status panel is not running — Epic Mode suppresses it — making elapsed
      // time epoch-sized and firing the timeout on the first tick.
      const startedAt = Date.now();
      const done = (fn) => (v) => { if (!settled) { settled = true; clearInterval(poll); fn(v); } };

      const poll = setInterval(() => {
        if (settled) return;
        const elapsed = Date.now() - startedAt;
        // Only give up when the run is BOTH silent and long — a local model can
        // legitimately take many minutes between planner steps. The stall signal
        // only exists while the status panel is live; without it, fall back to
        // the hard ceiling alone rather than treating "no events" as a stall.
        const stalled = GenerationStatus.isActive() ? GenerationStatus._stalledMs() : 0;
        const silentTooLong = stalled > 10 * 60 * 1000;
        if (elapsed > hardMs || silentTooLong) {
          settled = true;
          clearInterval(poll);
          reject(new Error(
            silentTooLong
              ? 'Generation stopped responding — no progress for over 10 minutes. The extension service worker may have been terminated. Check chrome://extensions → QAtalyst → service worker for errors, then try again.'
              : 'Generation exceeded the maximum run time and was abandoned.'
          ));
        }
      }, 5000);

      promise.then(done(resolve), done(reject));
    });
  }

  async function cancelGeneration() {
    try {
      await chrome.runtime.sendMessage({ action: 'stopMultiAgentGeneration' });
    } catch (e) {
      console.warn('[QAtalyst] cancel request failed:', e.message);
    }
    try {
      if (currentStreamingRequestId) {
        await chrome.runtime.sendMessage({ action: 'stopGeneration', requestId: currentStreamingRequestId });
      }
    } catch (_) {}

    suppressAgentProgress = true;
    GenerationStatus.stop();
    isStreaming = false;
    currentStreamingRequestId = null;

    const container = document.getElementById('results-container');
    if (container) {
      container.innerHTML = '';
      const msg = document.createElement('div');
      msg.className = 'qatalyst-warning-box';
      msg.dataset.testid = 'generation-cancelled';
      msg.style.cssText = 'background:#fff3cd;border:1px solid #ffc107;border-radius:8px;padding:12px;margin:10px 0;color:#856404;';
      msg.textContent = 'Generation stopped. Any partial results were discarded — run it again when ready.';
      container.appendChild(msg);
    }
    const btn = document.getElementById('test-cases-btn');
    if (btn) {
      btn.disabled = false;
      if (btn.dataset.originalLabel) btn.innerHTML = btn.dataset.originalLabel;
    }
    setActivityIndicator(false);
  }

  function handleAgentProgress(progress) {
    if (suppressAgentProgress) return;
    const resultsContainer = document.getElementById('results-container');
    if (!resultsContainer) return;

    const { agent, step, total, status, description, count, error } = progress;

    // Route into the single generation surface so planner steps, mining and the
    // final validation all update ONE panel in place.
    if (GenerationStatus.isActive() && status !== 'error' && !error) {
      GenerationStatus.update({
        phase: agent ? `${agent}` : 'Planning coverage',
        detail: description || '',
        step: Number.isFinite(step) ? step : null,
        total: Number.isFinite(total) ? total : null,
        count: Number.isFinite(count) ? count : null
      });
      return;
    }
    
    // Progress is only meaningful when both step and total are numbers.
    const hasProgress = Number.isFinite(step) && Number.isFinite(total) && total > 0;
    const pct = hasProgress ? Math.min(100, Math.round((step / total) * 100)) : (status === 'completed' ? 100 : 8);
    const stepLabel = hasProgress ? `Step ${step}/${total}` : (status === 'completed' ? 'Complete' : 'Working…');

    // Update agent progress display
    const agentProgressHTML = `
      <div class="agent-progress-container">
        <div class="agent-progress-header">
          <h3>🧬 Multi-Agent Test Generation</h3>
          <div class="agent-progress-stats">${escapeHtml(stepLabel)}</div>
        </div>
        <div class="agent-progress-bar">
          <div class="agent-progress-fill" style="width: ${pct}%"></div>
        </div>
        <div class="agent-current">
          ${status === 'running' ? '⚡' : status === 'completed' ? '✅' : '❌'}
          <strong>${escapeHtml(agent || 'Planner')}</strong>
          ${description ? `<span class="agent-desc">${escapeHtml(description)}</span>` : ''}
          ${Number.isFinite(count) ? `<span class="agent-count">${count} tests so far</span>` : ''}
          ${status === 'error' && error ? `<span class="agent-error">${escapeHtml(error)}</span>` : ''}
        </div>
      </div>
    `;

    resultsContainer.innerHTML = agentProgressHTML;
  }
  
/**
   * Handle context quality assessment from background script
   * Shows real-time quality indicator during test generation
   */
  function handleContextQualityAssessment(assessment) {
    const resultsContainer = document.getElementById('results-container');
    if (!resultsContainer) return;

    // Determine quality color and icon
    let qualityColor, qualityIcon, qualityMessage;
    switch (assessment.qualityLevel) {
      case 'EXCELLENT':
        qualityColor = '#28a745';
        qualityIcon = '🟢';
        qualityMessage = 'Excellent context - high quality tests expected';
        break;
      case 'GOOD':
        qualityColor = '#17a2b8';
        qualityIcon = '🔵';
        qualityMessage = 'Good context - quality tests expected';
        break;
      case 'FAIR':
        qualityColor = '#ffc107';
        qualityIcon = '🟡';
        qualityMessage = 'Fair context - some tests may be generic';
        break;
      case 'POOR':
        qualityColor = '#fd7e14';
        qualityIcon = '🟠';
        qualityMessage = 'Poor context - tests will be largely generic';
        break;
      default:
        qualityColor = '#dc3545';
        qualityIcon = '🔴';
        qualityMessage = 'Insufficient context - consider crawling your app first';
    }

    // Build recommendations list - handle both string and object formats
    let recommendationsHTML = '';
    if (assessment.recommendations?.length > 0) {
      const recItems = assessment.recommendations.slice(0, 3).map(r => {
        // Handle object format: { priority, category, message, actions }
        if (typeof r === 'object' && r.message) {
          return `<li><strong>${r.category || 'Tip'}:</strong> ${r.message}</li>`;
        }
        // Handle string format
        return `<li>${r}</li>`;
      }).join('');

      recommendationsHTML = `<ul style="margin: 8px 0 0 0; padding-left: 20px; font-size: 12px;">
           ${recItems}
         </ul>`;
    }

    const qualityHTML = `
      <div class="context-quality-indicator" style="
        background: ${qualityColor}15;
        border: 1px solid ${qualityColor};
        border-radius: 8px;
        padding: 12px;
        margin-bottom: 12px;
      ">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-size: 20px;">${qualityIcon}</span>
          <div>
            <div style="font-weight: 600; color: ${qualityColor};">
              Context Quality: ${assessment.qualityLevel} (${assessment.qualityScore}/100)
            </div>
            <div style="font-size: 12px; color: #666;">
              ${qualityMessage}
            </div>
          </div>
        </div>
        ${recommendationsHTML}
      </div>
      <div class="qatalyst-loading">🧬 Generating test cases with ${assessment.qualityLevel.toLowerCase()} context...</div>
    `;

    resultsContainer.innerHTML = qualityHTML;
  }

  function handleEnhancementProgress(status) {
    const resultsContainer = document.getElementById('results-container');
    if (!resultsContainer) return;

    const enhancementHTML = `
      <div class="enhancement-progress-container">
        <div class="enhancement-header">
          <h3>🎯 Enhanced Features</h3>
          <div class="enhancement-status ${status}">
            ${status === 'analyzing' ? '⚡ Analyzing gaps & complexity...' : '✅ Analysis complete'}
          </div>
        </div>
        <div class="enhancement-info">
          <div class="enhancement-item">
            <span class="enhancement-icon">🔍</span>
            <span>Gap Analysis</span>
          </div>
          <div class="enhancement-item">
            <span class="enhancement-icon">📊</span>
            <span>Complexity Scaling</span>
          </div>
          <div class="enhancement-item">
            <span class="enhancement-icon">🎯</span>
            <span>Context-Aware Generation</span>
          </div>
        </div>
      </div>
    `;

    resultsContainer.innerHTML = enhancementHTML;
  }

  function handleHistoricalMiningProgress(progress) {
    // Accept both the {phase} object the worker sends and a bare status string.
    const phase = (progress && typeof progress === 'object') ? progress.phase : progress;
    const status = (phase === 'done' || phase === 'complete') ? 'complete' : 'analyzing';
    const resultsContainer = document.getElementById('results-container');
    if (!resultsContainer) return;

    // While a generation run owns the panel, mining is a PHASE of it — not a
    // replacement for it. Overwriting the container here is what left the user
    // staring at "✅ Mining complete" for the rest of the run.
    if (GenerationStatus.isActive()) {
      GenerationStatus.update({
        phase: status === 'analyzing' ? 'Mining historical bugs' : 'Historical mining complete',
        detail: status === 'analyzing' ? 'searching past issues for regression risks' : ''
      });
      return;
    }

    const historicalHTML = `
      <div class="historical-mining-progress-container">
        <div class="historical-mining-header">
          <h3>🧠 Historical Test Case Mining</h3>
          <div class="historical-mining-status ${status}">
            ${status === 'analyzing' ? '⚡ Mining historical bugs...' : '✅ Mining complete'}
          </div>
        </div>
        <div class="historical-mining-info">
          <div class="historical-mining-item">
            <span class="historical-mining-icon">🔍</span>
            <span>Extracting Features</span>
          </div>
          <div class="historical-mining-item">
            <span class="historical-mining-icon">🐛</span>
            <span>Searching Historical Bugs</span>
          </div>
          <div class="historical-mining-item">
            <span class="historical-mining-icon">📊</span>
            <span>Analyzing Patterns</span>
          </div>
          <div class="historical-mining-item">
            <span class="historical-mining-icon">🛡️</span>
            <span>Generating Prevention Tests</span>
          </div>
        </div>
      </div>
    `;

    resultsContainer.innerHTML = historicalHTML;
  }

  // Wait for Jira page to load
  function waitForJiraLoad() {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const issueView = document.querySelector('[data-testid="issue.views.issue-base.foundation.summary.heading"]') ||
                         document.querySelector('#summary-val') ||
                         document.querySelector('.issue-header');
        
        if (issueView) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 500);
    });
  }
  
  // Inject the JiraShastra panel
  async function injectPanel() {
    await waitForJiraLoad();
    
    // Check if already injected
    if (document.getElementById('qatalyst-panel')) {
      return;
    }
    
    // Create panel container
    const panel = document.createElement('div');
    panel.id = 'qatalyst-panel';
    panel.className = 'qatalyst-panel';
    
    // Get ticket data
    const ticketKey = extractTicketKey();
    const ticketData = await extractTicketData();
    
    // Create panel HTML
    panel.innerHTML = `
      <div class="qatalyst-header">
        <div style="display: flex; align-items: center; gap: 8px;">
          <img src="${chrome.runtime.getURL('icons/icon16.png')}" alt="QAtalyst" style="width: 20px; height: 20px;">
          <h3>QAtalyst</h3>
        </div>
        <div class="qatalyst-header-buttons">
          <button class="qatalyst-minimize" id="qatalyst-minimize" title="Minimize">−</button>
          <button class="qatalyst-expand" id="qatalyst-expand" title="Expand/Collapse">⇔</button>
          <button class="qatalyst-close" id="qatalyst-close">×</button>
        </div>
      </div>
      <div class="qatalyst-content">
        <div class="qatalyst-ticket-info">
          <strong>Ticket:</strong> ${escapeHtml(ticketKey)}
        </div>

        <div class="qatalyst-actions">
          <button class="qatalyst-btn primary" id="analyze-btn" data-testid="analyze-requirements-btn">
            <span class="btn-icon">🔍</span>
            <span>Analyse Requirements</span>
          </button>
          
          <button class="qatalyst-btn" id="test-scope-btn" data-testid="generate-test-scope-btn">
            <span class="btn-icon">📋</span>
            <span>Generate Test Scope</span>
          </button>
          
          <button class="qatalyst-btn" id="test-cases-btn" data-testid="generate-test-cases-btn">
            <span class="btn-icon">✓</span>
            <span>Generate Test Cases</span>
          </button>
        </div>
        
        <div class="qatalyst-results" id="results-container" data-testid="results-container">
          <div class="qatalyst-placeholder">
            <p>Select any action above to get started. Each feature works independently.</p>
            <ul style="text-align: left; margin-top: 10px; font-size: 12px;">
              <li>🔍 <strong>Analyse Requirements</strong> - Extract and structure ticket requirements</li>
              <li>📋 <strong>Generate Test Scope</strong> - Create comprehensive test planning document</li>
              <li>✓ <strong>Generate Test Cases</strong> - Generate 20-30 detailed, executable test cases</li>
            </ul>
          </div>
        </div>
        
        <div class="qatalyst-footer">
          <button class="qatalyst-btn secondary" id="settings-btn" data-testid="settings-btn">
            <span class="btn-icon">⚙️</span>
            <span>Settings</span>
          </button>
          <button class="qatalyst-btn secondary" id="help-btn" data-testid="help-btn">
            <span class="btn-icon">❓</span>
            <span>Help</span>
          </button>
        </div>
      </div>
    `;
    
    // Append to Jira page
    document.body.appendChild(panel);
    
    // Setup event listeners
    setupEventListeners(ticketKey, ticketData);
  }
  
  // Ticket extraction (extractTicketKey, extractTicketData, comments, attachments,
  // inline images, linked pages) → content-ticket.js
  /**
   * Get intelligently filtered crawl context based on Jira ticket keywords
   * Queries crawl data JSON and creates 5-10 KB focused summary
   * @param {Object} ticketData - Jira ticket data for keyword extraction
   * @returns {Promise<string|null>} - Filtered context summary
   */
  async function getCrawledContextSummary(ticketData) {
    try {
      // Extract keywords from Jira ticket
      const keywords = extractTicketKeywords(ticketData);

      if (keywords.length === 0) {
        console.log('ℹ️ No keywords extracted from ticket, requesting general crawl context');
        // Still request crawl data - background will provide fallback summary
      } else {
        console.log(`🔍 Extracted ${keywords.length} keywords from ticket:`, keywords.slice(0, 10));
      }

      // Request filtered crawl data from background
      const response = await chrome.runtime.sendMessage({
        action: 'getFilteredCrawlData',
        keywords: keywords,
        maxSizeKB: 10 // Limit summary to 10 KB
      });

      if (!response || !response.success || !response.summary) {
        console.log('ℹ️ No relevant crawl data found. Use Settings > Web App Crawler to crawl your application.');
        return null;
      }

      console.log(`✅ Using filtered crawl context (${response.summary.length} bytes, ${response.matchedPages} relevant pages)`);
      return response.summary;

    } catch (error) {
      console.warn('⚠️ Could not fetch filtered crawl data:', error);
      return null;
    }
  }

  // Setup event listeners
  function setupEventListeners(ticketKey, ticketData) {
    // Close button
    document.getElementById('qatalyst-close')?.addEventListener('click', () => {
      document.getElementById('qatalyst-panel').style.display = 'none';
    });

    // Minimize button
    document.getElementById('qatalyst-minimize')?.addEventListener('click', () => {
      const panel = document.getElementById('qatalyst-panel');
      const minimizeBtn = document.getElementById('qatalyst-minimize');
      const isMinimized = panel.classList.toggle('minimized');

      // Update button icon and title
      if (isMinimized) {
        minimizeBtn.innerHTML = '□';
        minimizeBtn.title = 'Restore';
      } else {
        minimizeBtn.innerHTML = '−';
        minimizeBtn.title = 'Minimize';
      }
    });

    // Expand button
    document.getElementById('qatalyst-expand')?.addEventListener('click', () => {
      const panel = document.getElementById('qatalyst-panel');
      panel.classList.toggle('expanded');
    });

    // Analyze button
    document.getElementById('analyze-btn')?.addEventListener('click', async () => {
      await handleAnalyze(ticketKey, ticketData);
    });

    // Test scope button
    document.getElementById('test-scope-btn')?.addEventListener('click', async () => {
      await handleTestScope(ticketKey, ticketData);
    });

    // Test cases button
    document.getElementById('test-cases-btn')?.addEventListener('click', async () => {
      await handleTestCases(ticketKey, ticketData);
    });
    
    // Settings button
    document.getElementById('settings-btn')?.addEventListener('click', () => {
      // Send message to background to open options page
      chrome.runtime.sendMessage({ action: 'openOptions' });
    });
    
    // Help button
    document.getElementById('help-btn')?.addEventListener('click', () => {
      showHelp();
    });
  }
  
  // validateSettingsUI → content-utils.js

  /**
   * Set activity indicator on panel (shows green dot when minimized)
   */
  function setActivityIndicator(isActive) {
    const panel = document.getElementById('qatalyst-panel');
    if (panel) {
      if (isActive) {
        panel.classList.add('has-activity');
      } else {
        panel.classList.remove('has-activity');
      }
    }
  }

  // Handle analyze requirements
  async function handleAnalyze(ticketKey, ticketData) {
    const resultsContainer = document.getElementById('results-container');
    const btn = document.getElementById('analyze-btn');
    btn.disabled = true;
    setActivityIndicator(true);

    try {
      const settings = await loadAndDecryptSettings([
        'llmProvider', 'llmModel', 'apiKey', 'bedrockAccessKeyId', 'bedrockSecretKey', 'bedrockSessionToken', 'bedrockRegion', 'enableStreaming',
        'jiraBaseUrl', 'jiraEmail', 'jiraApiToken',
        'figmaToken', 'googleApiKey'
      ]);

      // Epic Mode (rollup): if this is an epic, let the user pick child stories
      // and fold them into a single rollup ticket so this action spans the epic.
      const epicResolved = await resolveEpicRollupTicketData(ticketData, resultsContainer);
      if (epicResolved === null) {
        resultsContainer.innerHTML = '';
        resultsContainer.appendChild(createSafeErrorMessage('Epic Mode cancelled — no stories selected.'));
        return;
      }
      ticketData = epicResolved;

      // Enrich ticket with image and document attachment content
      await enrichTicketAttachments(ticketData, settings);

      // Validate settings
      const validationErrors = validateSettingsUI(settings);
      if (validationErrors.length > 0) {
        throw new Error(
          validationErrors.join('\\n') + 
          '\\n\\n🔧 Please configure your settings by clicking the Settings button below.'
        );
      }
      
      // Use streaming or regular based on settings
      if (settings.enableStreaming !== false) {
        // Initialize streaming
        streamingContent = '';
        isStreaming = true;
        currentStreamingRequestId = `analyze-${Date.now()}`;
        resultsContainer.innerHTML = '<div class="qatalyst-loading">🔍 Analyzing requirements with AI (streaming enabled)...</div>';
        
        const crawledContext = await getCrawledContextSummary(ticketData);

        // Update currentAppContext for UI display
        if (crawledContext) {
          currentAppContext = { hasCrawledData: true };
        } else {
          currentAppContext = null;
        }

        const response = await new Promise((resolve, reject) => {
          pendingStreamCompletions.set('analyze', { resolve, reject, ticketKey });
          chrome.runtime.sendMessage({
            action: 'analyzeRequirementsStream',
            data: { ticketKey, ticketData, settings, crawledContext }
          }, ack => {
            if (chrome.runtime.lastError) {
              pendingStreamCompletions.delete('analyze');
              reject(new Error(chrome.runtime.lastError.message));
            } else if (ack?.error) {
              pendingStreamCompletions.delete('analyze');
              reject(new Error(ack.error));
            }
            // Otherwise, wait for 'streamComplete' / 'streamError' tab message
          });
        });

        // Stream is complete
        isStreaming = false;
        currentStreamingRequestId = null;
        displayAnalysisResults(response);
      } else {
        // Regular non-streaming
        resultsContainer.innerHTML = '<div class="qatalyst-loading">🔍 Analyzing requirements with AI...</div>';
        
        const crawledContext = await getCrawledContextSummary(ticketData);

        // Update currentAppContext for UI display
        if (crawledContext) {
          currentAppContext = { hasCrawledData: true };
        } else {
          currentAppContext = null;
        }

        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: 'analyzeRequirements',
            data: {
              ticketKey,
              ticketData,
              settings,
              crawledContext: crawledContext
            }
          }, response => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (!response) {
              reject(new Error('No response received from extension'));
            } else if (response.error) {
              reject(new Error(response.error));
            } else {
              resolve(response);
            }
          });
        });

        displayAnalysisResults(response);
      }
      
    } catch (error) {
      isStreaming = false;
      currentStreamingRequestId = null;
      resultsContainer.innerHTML = '';
      resultsContainer.appendChild(createSafeErrorMessage(error.message));
    } finally {
      btn.disabled = false;
      setActivityIndicator(false);
    }
  }

  // Handle test scope generation
  async function handleTestScope(ticketKey, ticketData) {
    const resultsContainer = document.getElementById('results-container');
    const btn = document.getElementById('test-scope-btn');
    
    if (!ticketData) {
      resultsContainer.innerHTML = `
        <div class="qatalyst-error">
          ❌ Could not extract ticket data. Please try refreshing the page or analyzing requirements first.
        </div>
      `;
      return;
    }
    
    btn.disabled = true;
    setActivityIndicator(true);

    try {
      const settings = await loadAndDecryptSettings([
        'llmProvider', 'llmModel', 'apiKey', 'bedrockAccessKeyId', 'bedrockSecretKey', 'bedrockSessionToken', 'bedrockRegion', 'enableStreaming',
        'jiraBaseUrl', 'jiraEmail', 'jiraApiToken',
        'figmaToken', 'googleApiKey'
      ]);

      // Epic Mode (rollup): if this is an epic, let the user pick child stories
      // and fold them into a single rollup ticket so this action spans the epic.
      const epicResolved = await resolveEpicRollupTicketData(ticketData, resultsContainer);
      if (epicResolved === null) {
        resultsContainer.innerHTML = '';
        resultsContainer.appendChild(createSafeErrorMessage('Epic Mode cancelled — no stories selected.'));
        return;
      }
      ticketData = epicResolved;

      // Enrich ticket with image and document attachment content
      await enrichTicketAttachments(ticketData, settings);

      // Validate settings
      const validationErrors = validateSettingsUI(settings);
      if (validationErrors.length > 0) {
        throw new Error(
          validationErrors.join('\\n') + 
          '\\n\\n🔧 Please configure your settings by clicking the Settings button below.'
        );
      }
      
      // Use streaming or regular based on settings
      if (settings.enableStreaming !== false) {
        // Initialize streaming
        streamingContent = '';
        isStreaming = true;
        currentStreamingRequestId = `scope-${Date.now()}`;
        resultsContainer.innerHTML = '<div class="qatalyst-loading">📋 Generating comprehensive test scope (streaming enabled)...</div>';
        
        const crawledContext = await getCrawledContextSummary(ticketData);

        // Update currentAppContext for UI display
        if (crawledContext) {
          currentAppContext = { hasCrawledData: true };
        } else {
          currentAppContext = null;
        }

        const response = await new Promise((resolve, reject) => {
          pendingStreamCompletions.set('scope', { resolve, reject, ticketKey });
          chrome.runtime.sendMessage({
            action: 'generateTestScopeStream',
            data: { ticketKey, ticketData, settings, crawledContext }
          }, ack => {
            if (chrome.runtime.lastError) {
              pendingStreamCompletions.delete('scope');
              reject(new Error(chrome.runtime.lastError.message));
            } else if (ack?.error) {
              pendingStreamCompletions.delete('scope');
              reject(new Error(ack.error));
            }
          });
        });

        // Stream is complete
        isStreaming = false;
        currentStreamingRequestId = null;
        displayTestScopeResults(response);
      } else {
        // Regular non-streaming
        resultsContainer.innerHTML = '<div class="qatalyst-loading">📋 Generating comprehensive test scope...</div>';

        const crawledContext = await getCrawledContextSummary(ticketData);

        // Update currentAppContext for UI display
        if (crawledContext) {
          currentAppContext = { hasCrawledData: true };
        } else {
          currentAppContext = null;
        }

        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: 'generateTestScope',
            data: {
              ticketKey,
              ticketData,
              settings,
              crawledContext: crawledContext
            }
          }, response => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (!response) {
              reject(new Error('No response received from extension'));
            } else if (response.error) {
              reject(new Error(response.error));
            } else {
              resolve(response);
            }
          });
        });

        displayTestScopeResults(response);
      }
      
    } catch (error) {
      isStreaming = false;
      currentStreamingRequestId = null;
      resultsContainer.innerHTML = '';
      resultsContainer.appendChild(createSafeErrorMessage(error.message));
    } finally {
      btn.disabled = false;
      setActivityIndicator(false);
    }
  }

  // Handle test cases generation
  async function handleTestCases(ticketKey, ticketData) {
    const resultsContainer = document.getElementById('results-container');
    const btn = document.getElementById('test-cases-btn');
    // The disabled button was the only signal a run had started, and a greyed-out
    // button reads as "unavailable", not "working".
    btn.dataset.originalLabel = btn.dataset.originalLabel || btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-icon">⏳</span><span>Generating…</span>';
    setActivityIndicator(true);
    
    try {
      const settings = await loadAndDecryptSettings([
        'llmProvider', 'llmModel', 'apiKey', 'bedrockAccessKeyId', 'bedrockSecretKey', 'bedrockSessionToken', 'bedrockRegion', 'enableStreaming', 'enableMultiAgent',
        // temperature/maxTokens were previously omitted here, so the LLM client
        // always fell back to defaults regardless of the options sliders. Load
        // them so the user's values are actually honored.
        'temperature', 'maxTokens',
        'coverageTarget', 'dedupThreshold', 'relevanceThreshold', 'enabledCategories', 'testCount',
        'useCrawledDataForTests',
        'enableHistoricalMining', 'historicalMaxResults', 'historicalJqlFilters',
        // F14: none of these were loaded for generation, so the worker's
        // existing-suite dedup branch was unreachable no matter what the user set.
        'dedupeAgainstExistingSuite',
        'testrailUrl', 'testrailUsername', 'testrailApiKey', 'testrailProjectId', 'testrailSuiteId',
        'jiraBaseUrl', 'jiraEmail', 'jiraApiToken',
        'figmaToken', 'googleApiKey'
      ]);

      // Enrich with BOTH image and document attachments (F4). Previously only
      // images were fetched here, so spec PDFs/requirement docs attached to the
      // ticket were never extracted or sent to the generator. enrichTicketAttachments
      // handles the vision-model gate for images and always extracts document text.
      if (ticketData.attachments?.length > 0) {
        try {
          await enrichTicketAttachments(ticketData, settings);
        } catch (e) {
          console.warn('⚠️ Attachment enrichment failed, continuing without it:', e.message);
        }
      }

      // Extract app context from crawled knowledge graphs (if enabled)
      currentTicketData = ticketData;

      let appContext = null;
      if (settings.useCrawledDataForTests !== false) { // Enabled by default
        console.log('🔍 [CRAWL DATA] Feature enabled - extracting app context from crawled data...');
        appContext = await extractAppContext(ticketData);
        currentAppContext = appContext; // Store globally for UI display
        if (appContext) {
          console.log(`✅ [CRAWL DATA] Successfully extracted app context:`);
          const kg = appContext.knowledgeGraph || {};
          console.log(`   📱 App URL: ${appContext.appUrl}`);
          console.log(`   📄 Total Pages: ${appContext.pageCount || 0}`);
          console.log(`   📄 Pages transferred: ${appContext.transferPageCount || 0}`);
          console.log(`   📝 Forms: ${kg.forms?.length || 0}`);
          console.log(`   🔌 APIs: ${kg.apis?.length || 0}`);
        } else {
          console.log('⚠️ [CRAWL DATA] No crawled app context found - proceeding without it');
          console.log('   💡 Tip: Crawl your app first using the popup or settings page');

          // Show warning to user about missing crawled data
          const shouldProceed = await showNoCrawlDataWarning();
          if (!shouldProceed) {
            resultsContainer.innerHTML = `
              <div class="qatalyst-warning-box" style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 16px; margin: 10px 0;">
                <h4 style="color: #856404; margin: 0 0 8px 0;">⚠️ Test Generation Cancelled</h4>
                <p style="color: #856404; margin: 0;">Please crawl your application first for better test quality.</p>
                <p style="color: #856404; margin: 8px 0 0 0; font-size: 12px;">
                  💡 Use the popup or settings page to start crawling your web application.
                </p>
              </div>
            `;
            return;
          }
        }
      } else {
        console.log('❌ [CRAWL DATA] Feature disabled in settings - skipping app context extraction');
        console.log('   💡 Enable in Settings → Crawler Settings → "Use Crawled Data in Test Generation"');
        currentAppContext = null;
      }

      // Debug logging for settings
      console.log('🔍 QAtalyst Settings Loaded:', {
        enableMultiAgent: settings.enableMultiAgent,
        coverageTarget: settings.coverageTarget,
        testCount: settings.testCount,
        llmProvider: settings.llmProvider,
        llmModel: settings.llmModel
      });

      // Debug: Direct storage check to verify what's actually stored
      chrome.storage.sync.get(['enableMultiAgent'], (result) => {
        console.log('🔍 Direct storage check for enableMultiAgent:', result);
        console.log('🔍 Type of enableMultiAgent:', typeof result.enableMultiAgent);
        console.log('🔍 Value is truthy?', !!result.enableMultiAgent);
      });

      // Validate settings
      const validationErrors = validateSettingsUI(settings);
      if (validationErrors.length > 0) {
        throw new Error(
          validationErrors.join('\\n') +
          '\\n\\n🔧 Please configure your settings by clicking the Settings button below.'
        );
      }

      // ── Epic Mode: when the open issue is an Epic, generate per-child-story
      // test cases in parallel instead of one set for the epic body. ──────────
      if (typeof QAtalystEpicMode !== 'undefined' && QAtalystEpicMode.isEpicIssue(ticketData)) {
        await runEpicMode(ticketData, settings, appContext, resultsContainer);
        return; // finally{} below re-enables the button
      }

      // Use multi-agent if enabled
      console.log('🔍 Checking multi-agent enabled:', settings.enableMultiAgent);
      if (settings.enableMultiAgent) {
        console.log('✅ Multi-agent is enabled, using multi-agent system');
      } else {
        console.log('❌ Multi-agent is NOT enabled, using single-agent system');
      }

      if (settings.enableMultiAgent) {
        // The planner-driven agentic engine is the only generation engine: a
        // grounded, coverage-feedback loop with a hard no-duplicate /
        // no-irrelevant acceptance gate. (The classic multi-agent pipeline + GA
        // were retired in v13.2.)
        const genAction = 'generateTestCasesAgentic';
        suppressAgentProgress = false; // allow progress updates for this run
        console.log('🚀 Starting agentic planner test case generation...');
        GenerationStatus.start('Generating test cases…');
        GenerationStatus.update({ phase: 'Planning grounded test coverage', detail: 'reading the ticket and crawl evidence' });

        console.log('📤 Sending message to background script...');
        const response = await withGenerationTimeout(new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: genAction,
            data: {
              ticketKey,
              ticketData,
              settings,
              baseUrl: window.location.origin,
              externalSources: currentAnalysisData?.externalSources, // source COUNTS only — see F09
              appContext: appContext, // Add crawled app context
              // F23: the reviewed analysis and test scope are edited in this
              // panel and were then thrown away — generation rebuilt its own
              // interpretation from the raw ticket. A user could correct an
              // ambiguity or exclude a feature in the review step and still get
              // tests based on the original reading, while the UI presented a
              // connected QA workflow.
              reviewedContext: buildReviewedContext()
            }
          }, response => {
            console.log('📥 Received response from background script:', response);
            if (chrome.runtime.lastError) {
              const errorMsg = chrome.runtime.lastError.message || JSON.stringify(chrome.runtime.lastError);
              console.error('❌ Chrome runtime error:', errorMsg);
              reject(new Error(errorMsg));
            } else if (!response) {
              console.error('❌ No response received');
              reject(new Error('No response received from extension'));
            } else if (response.error) {
              const errorMsg = typeof response.error === 'string' ? response.error : (response.error.message || JSON.stringify(response.error));
              console.error('❌ Response contains error:', errorMsg);
              reject(new Error(errorMsg));
            } else {
              console.log('✅ Response successful, displaying results');
              resolve(response);
            }
          });
        }));

        // Render final results and stop accepting progress updates so a late
        // "done" message cannot overwrite the test-case list.
        suppressAgentProgress = true;
        GenerationStatus.stop();
        displayTestCasesResults(response);
      }
      // Use streaming or regular based on settings
      else if (settings.enableStreaming !== false) {
        // Initialize streaming
        streamingContent = '';
        isStreaming = true;
        currentStreamingRequestId = `testcases-${Date.now()}`;
        GenerationStatus.start('Generating test cases…');
        GenerationStatus.update({ phase: 'Streaming from the model', detail: 'output is validated before it is shown' });
        
        const response = await new Promise((resolve, reject) => {
          pendingStreamCompletions.set('testcases', { resolve, reject, ticketKey });
          chrome.runtime.sendMessage({
            action: 'generateTestCasesStream',
            data: { ticketKey, ticketData, settings, appContext }
          }, ack => {
            if (chrome.runtime.lastError) {
              pendingStreamCompletions.delete('testcases');
              reject(new Error(chrome.runtime.lastError.message || JSON.stringify(chrome.runtime.lastError)));
            } else if (ack?.error) {
              pendingStreamCompletions.delete('testcases');
              reject(new Error(typeof ack.error === 'string' ? ack.error : (ack.error.message || JSON.stringify(ack.error))));
            }
          });
        });

        // Stream is complete
        isStreaming = false;
        currentStreamingRequestId = null;
        displayTestCasesResults(response);
      } else {
        // Regular non-streaming (single-agent)
        GenerationStatus.start('Generating test cases…');
        GenerationStatus.update({ phase: 'Asking the model', detail: 'this usually takes 30-90 seconds' });
        
        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: 'generateTestCases',
            data: {
              ticketKey,
              ticketData,
              settings,
              appContext: appContext // Add crawled app context
            }
          }, response => {
            if (chrome.runtime.lastError) {
              const errorMsg = chrome.runtime.lastError.message || JSON.stringify(chrome.runtime.lastError);
              reject(new Error(errorMsg));
            } else if (!response) {
              reject(new Error('No response received from extension'));
            } else if (response.error) {
              const errorMsg = typeof response.error === 'string' ? response.error : (response.error.message || JSON.stringify(response.error));
              reject(new Error(errorMsg));
            } else {
              resolve(response);
            }
          });
        });

        GenerationStatus.stop();
        displayTestCasesResults(response);
      }

    } catch (error) {
      isStreaming = false;
      currentStreamingRequestId = null;
      resultsContainer.innerHTML = '';
      resultsContainer.appendChild(createSafeErrorMessage(error.message));
    } finally {
      // The status must never outlive the run — a spinner still ticking after a
      // failure is worse than no spinner at all.
      GenerationStatus.stop();
      btn.disabled = false;
      if (btn.dataset.originalLabel) btn.innerHTML = btn.dataset.originalLabel;
      setActivityIndicator(false);
    }
  }

  // Store current results for review feature
  let currentAnalysisData = null;
  let currentTestScopeData = null;
  let currentTestCasesData = null;
  let currentAppContext = null; // Store crawled app context for UI display
  // F03: the ticket behind the current suite, so regeneration can be validated
  // against the original requirements rather than only the previous output.
  let currentTicketData = null;

  /**
   * F23: package the user's REVIEWED analysis and scope so generation consumes
   * the decisions they made, not just the raw ticket. Returns null when neither
   * step has been run — generation then behaves exactly as before.
   *
   * Model output is a PROPOSAL: it is passed as reviewed interpretation, and the
   * prompt is explicit that the ticket remains the source of truth, so an
   * unsupported inference in the analysis cannot silently become a requirement.
   */
  function buildReviewedContext() {
    const analysis = currentAnalysisData && (currentAnalysisData.analysis || currentAnalysisData.content);
    const scope = currentTestScopeData && (currentTestScopeData.testScope || currentTestScopeData.scope || currentTestScopeData.content);
    if (!analysis && !scope) return null;
    return {
      analysis: typeof analysis === 'string' ? analysis.slice(0, 6000) : null,
      scope: typeof scope === 'string' ? scope.slice(0, 6000) : null,
      // Whether the user actually edited/regenerated these, or just saw them.
      analysisReviewed: !!(currentAnalysisData && currentAnalysisData.reviewed),
      scopeReviewed: !!(currentTestScopeData && currentTestScopeData.reviewed)
    };
  }
  let currentQualityReports = null; // Store quality reports from background

  // Display functions
  function displayAnalysisResults(data) {
    const container = document.getElementById('results-container');
    currentAnalysisData = data; // Store for review

    // Render context summary box
    const contextSummaryHtml = renderContextSummaryBox(data.externalSources || {}, currentAppContext);

    container.innerHTML = `
      <div class="qatalyst-result">
        <h4>📊 Requirements Analysis</h4>
        ${contextSummaryHtml}
        <div class="result-content" data-testid="analysis-output">
          ${formatAnalysis(data.analysis)}
        </div>
        <button class="qatalyst-btn small" onclick="this.parentElement.querySelector('.result-content').classList.toggle('expanded')">View Full Analysis</button>

        <!-- User Review Section -->
        <div class="qatalyst-review-section">
          <h5>💬 Provide Feedback (Optional)</h5>
          <p style="font-size: 12px; color: #666; margin-bottom: 8px;">
            Add your feedback below and click "Regenerate" to get an improved version based on your input.
          </p>
          <textarea
            id="analysis-review-input"
            class="qatalyst-review-textarea"
            placeholder="Example: Add more details about security requirements, focus on API integration points, etc."
            rows="3"
          ></textarea>
          <button class="qatalyst-btn primary" id="regenerate-analysis-btn" style="margin-top: 8px;">
            <span class="btn-icon">🔄</span>
            <span>Regenerate with Feedback</span>
          </button>
        </div>

        <button class="qatalyst-btn primary" id="add-analysis-to-jira-btn" style="margin-top: 12px;">
          <span class="btn-icon">📝</span>
          <span>Add to Jira</span>
        </button>
      </div>
    `;

    // Add event listeners
    document.getElementById('regenerate-analysis-btn')?.addEventListener('click', async () => {
      const review = document.getElementById('analysis-review-input').value.trim();
      if (!review) {
        showNotification('Please provide some feedback before regenerating.', 'warning');
        return;
      }
      await handleRegenerateAnalysis(review);
    });

    document.getElementById('add-analysis-to-jira-btn')?.addEventListener('click', () => {
      addAnalysisToJira(data.analysis);
    });
  }
  
  function displayTestScopeResults(data) {
    const container = document.getElementById('results-container');
    currentTestScopeData = data; // Store for review

    // Handle both 'scope' and 'testScope' properties for backward compatibility
    const scopeContent = data.scope || data.testScope || 'No scope generated';
    
    // Check if scope is undefined, null, empty, or the string "undefined"
    if (!scopeContent || scopeContent === 'undefined' || scopeContent.trim() === '' || scopeContent === 'No scope generated') {
      container.innerHTML = `
        <div class="qatalyst-error">
          <h4>❌ Test Scope Generation Failed</h4>
          <p>The AI provider did not return a valid test scope. This may be due to:</p>
          <ul style="text-align: left; margin: 15px 0; padding-left: 20px;">
            <li><strong>Extension Cache Issue:</strong> Try reloading the extension
              <br><small style="color: #666;">Go to <code>chrome://extensions</code> and click the reload button</small>
            </li>
            <li><strong>API Configuration:</strong> Verify your API key is valid and has sufficient quota</li>
            <li><strong>Integration Errors:</strong> Check browser console for detailed error messages</li>
            <li><strong>Ticket Data:</strong> Ensure the Jira ticket has sufficient description content</li>
          </ul>
          <button class="qatalyst-btn primary" onclick="location.reload();" style="margin-top: 10px;">
            🔄 Reload Page
          </button>
        </div>
      `;
      return;
    }
    
    container.innerHTML = `
      <div class="qatalyst-result">
        <h4>📋 Test Scope</h4>
        <div class="result-content" data-testid="test-scope-output">
          ${formatTestScope(scopeContent)}
        </div>

        <!-- User Review Section -->
        <div class="qatalyst-review-section">
          <h5>💬 Provide Feedback (Optional)</h5>
          <p style="font-size: 12px; color: #666; margin-bottom: 8px;">
            Add your feedback below and click "Regenerate" to get an improved test scope based on your input.
          </p>
          <textarea
            id="scope-review-input"
            class="qatalyst-review-textarea"
            placeholder="Example: Add more focus on performance testing, include mobile test scenarios, etc."
            rows="3"
          ></textarea>
          <button class="qatalyst-btn primary" id="regenerate-scope-btn" style="margin-top: 8px;">
            <span class="btn-icon">🔄</span>
            <span>Regenerate with Feedback</span>
          </button>
        </div>

        <button class="qatalyst-btn primary" id="add-scope-to-jira-btn" style="margin-top: 12px;">
          <span class="btn-icon">📝</span>
          <span>Add to Jira</span>
        </button>
      </div>
    `;

    // Add event listeners
    document.getElementById('regenerate-scope-btn')?.addEventListener('click', async () => {
      const review = document.getElementById('scope-review-input').value.trim();
      if (!review) {
        showNotification('Please provide some feedback before regenerating.', 'warning');
        return;
      }
      await handleRegenerateTestScope(review);
    });

    document.getElementById('add-scope-to-jira-btn')?.addEventListener('click', () => {
      addTestScopeToJira(scopeContent);
    });
  }
  
  // Store active filter state
  let activeFilter = 'all';
  let searchQuery = '';
  let priorityFilter = 'all';

  function displayTestCasesResults(data) {
    const container = document.getElementById('results-container');
    currentTestCasesData = data; // Store for review

    // Always reset filters when new results are displayed
    activeFilter = 'all';
    searchQuery = '';
    priorityFilter = 'all';

    // Render context summary box
    const contextSummaryHtml = renderContextSummaryBox(data.externalSources || {}, currentAppContext);

    // F15: one category registry across prompts, distribution, UI and export.
    // The chips were a hardcoded five, so Security and Accessibility tests — which
    // the distribution module can and does generate — were produced but had no
    // filter and were invisible in the counts.
    const allCases = data.testCases || [];
    const registry = (typeof DynamicDistribution !== 'undefined' && DynamicDistribution.CATEGORIES)
      || ['Positive', 'Negative', 'Edge', 'Regression', 'Integration', 'Security', 'Accessibility'];
    // Registry order first, then any category the model actually emitted.
    const categories = [...new Set([...registry, ...allCases.map(tc => tc.category).filter(Boolean)])];
    const countFor = (cat) => data.byCategory?.[cat] ?? allCases.filter(tc => tc.category === cat).length;
    const stats = { total: data.total || allCases.length || 0 };

    // Enhancement badges
    let enhancementBadges = '';
    if (data.enhancements) {
      const badges = [];

      if (data.enhancements.gaps && data.enhancements.gaps.length > 0) {
        badges.push(`<div class="enhancement-badge gap">
          🔍 ${data.enhancements.gaps.length} gaps identified
        </div>`);
      }

      if (data.enhancements.scalingApplied) {
        const diff = data.enhancements.scaledCount - data.enhancements.originalCount;
        const sign = diff > 0 ? '+' : '';
        badges.push(`<div class="enhancement-badge scaling">
          📊 Complexity scaled: ${sign}${diff} tests (Score: ${data.enhancements.complexityScore}/100)
        </div>`);
      }

      if (data.enhancements.additionalTests && data.enhancements.additionalTests.length > 0) {
        badges.push(`<div class="enhancement-badge additional">
          ✨ ${data.enhancements.additionalTests.length} gap-filling tests added
        </div>`);
      }

      if (badges.length > 0) {
        enhancementBadges = `<div class="enhancement-badges">${badges.join('')}</div>`;
      }
    }

    // Historical insights badge
    let historicalBadge = '';
    if (data.historicalInsights) {
      const insights = data.historicalInsights;
      const historicalTestCount = data.testCases.filter(tc => tc.source === 'historical').length;

      if (historicalTestCount > 0 || insights.bugPatterns.length > 0) {
        historicalBadge = `
          <div class="historical-insights-section">
            <h5>🧠 Historical Insights (from ${insights.totalBugsAnalyzed} past bugs)</h5>
            <div class="historical-stats">
              ${historicalTestCount > 0 ? `<span class="hist-stat">🛡️ ${historicalTestCount} bug-prevention tests added</span>` : ''}
              ${insights.bugPatterns.length > 0 ? `<span class="hist-stat">📊 ${insights.bugPatterns.length} bug patterns identified</span>` : ''}
              ${insights.riskAreas.length > 0 ? `<span class="hist-stat">⚠️ ${insights.riskAreas.length} risk areas detected</span>` : ''}
            </div>

            ${data.historicalBugs && data.historicalBugs.length > 0 ? `
              <details class="historical-details">
                <summary>View ${data.historicalBugs.length} analyzed bugs</summary>
                <ul class="historical-bugs-list">
                  ${data.historicalBugs.slice(0, 10).map(bug => `
                    <li>
                      <a href="${bug.url}" target="_blank">${bug.key}</a>: ${bug.summary}
                      <span class="bug-date">(${new Date(bug.created).toLocaleDateString()})</span>
                    </li>
                  `).join('')}
                </ul>
              </details>
            ` : ''}
          </div>
        `;
      }
    }

    // F21: the "evolutionary optimization" badges were removed — that generation
    // path was retired and nothing sets `evolutionPending`/`finalEvolution` any
    // more, so the UI could only ever have shown a status the system no longer
    // produces. Real quality status is rendered by renderQualityStatus() below.
    const qualityStatusHtml = renderQualityStatus(data);

    container.innerHTML = `
      <div class="qatalyst-result">
        <h4>✅ Generated Test Cases</h4>
        ${contextSummaryHtml}
        ${qualityStatusHtml}
        ${enhancementBadges}
        ${historicalBadge}
        <div class="test-stats" data-testid="test-stats">
          <button class="stat-filter active" data-filter="all" data-testid="filter-all">Total: ${stats.total}</button>
          ${categories.map(cat => `<button class="stat-filter" data-filter="${escapeHtml(cat)}" data-testid="filter-${escapeHtml(cat)}">${escapeHtml(cat)}: ${countFor(cat)}</button>`).join('')}
        </div>

        <!-- Enhanced Filter Controls -->
        <div class="filter-controls">
          <div class="search-box">
            <input type="text" id="test-search" data-testid="test-search" placeholder="🔍 Search test cases..." class="qatalyst-search-input" value="" />
          </div>
          <div class="priority-filter">
            <label>Priority:</label>
            <select id="priority-filter" data-testid="priority-filter" class="qatalyst-select">
              <option value="all" selected>All</option>
              <option value="P0">P0 - Critical</option>
              <option value="P1">P1 - High</option>
              <option value="P2">P2 - Medium</option>
              <option value="P3">P3 - Low</option>
            </select>
          </div>
          <button class="qatalyst-btn secondary" id="clear-filters-btn" style="display: none;">
            <span>Clear Filters</span>
          </button>
          <div id="filter-status" data-testid="filter-status" class="filter-status"></div>
        </div>

        <div class="result-content test-cases" id="test-cases-container" data-testid="test-cases-container">
          ${formatTestCases(data.testCases)}
        </div>

        <!-- User Review Section -->
        <div class="qatalyst-review-section">
          <h5>💬 Provide Feedback (Optional)</h5>
          <p style="font-size: 12px; color: #666; margin-bottom: 8px;">
            Add your feedback below and click "Regenerate" to get improved test cases based on your input.
          </p>
          <textarea
            id="testcases-review-input"
            class="qatalyst-review-textarea"
            placeholder="Example: Add more security tests, include performance test cases, focus more on edge cases, etc."
            rows="3"
          ></textarea>
          <button class="qatalyst-btn primary" id="regenerate-testcases-btn" style="margin-top: 8px;">
            <span class="btn-icon">🔄</span>
            <span>Regenerate with Feedback</span>
          </button>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px;">
          <button class="qatalyst-btn primary" id="add-to-jira-btn" data-testid="add-to-jira-btn">
            <span class="btn-icon">📝</span>
            <span>Add to Jira</span>
          </button>
          <button class="qatalyst-btn secondary" id="export-csv-btn" data-testid="export-csv-btn">
            <span class="btn-icon">📥</span>
            <span>Export to CSV</span>
          </button>
          <button class="qatalyst-btn secondary" id="export-playwright-btn" data-testid="export-playwright-btn" title="Download a Playwright spec built from these tests">
            <span class="btn-icon">🎭</span>
            <span>Export Playwright</span>
          </button>
          <button class="qatalyst-btn secondary" id="copy-clipboard-btn" data-testid="copy-clipboard-btn" style="background: linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%);">
            <span class="btn-icon">📋</span>
            <span>Copy to Clipboard</span>
          </button>
          <button class="qatalyst-btn primary" id="export-to-test-mgmt-btn" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%);">
            <span class="btn-icon">🚀</span>
            <span>Test Management <span style="background: #3b82f6; color: white; font-size: 9px; font-weight: 600; padding: 2px 6px; border-radius: 3px; margin-left: 6px; vertical-align: middle;">BETA</span></span>
          </button>
        </div>
        <button class="qatalyst-btn secondary" id="verify-in-app-btn" data-testid="verify-in-app-btn" style="width: 100%; margin-top: 8px;" title="Replay these tests in your app, in a background tab">
          <span class="btn-icon">▶️</span>
          <span>Verify in app</span>
        </button>
        <div id="run-results" data-testid="run-results" style="margin-top: 8px;"></div>
        <button class="qatalyst-btn" id="cancel-upload-btn" style="display: none; background: #ef4444; color: white; width: 100%; margin-top: 8px;">
          <span class="btn-icon">🛑</span>
          <span>Cancel Upload</span>
        </button>
      </div>
    `;

    // Add event listeners
    document.getElementById('add-to-jira-btn')?.addEventListener('click', () => {
      const testsToExport = getFilteredTestCases(data.testCases);
      addTestCasesToJira(testsToExport);
    });

    document.getElementById('export-csv-btn')?.addEventListener('click', () => {
      const testsToExport = getFilteredTestCases(data.testCases);
      exportTestCasesToCSV(testsToExport);
    });

    document.getElementById('verify-in-app-btn')?.addEventListener('click', async () => {
      await verifyInApp(getFilteredTestCases(data.testCases));
    });

    document.getElementById('export-playwright-btn')?.addEventListener('click', async () => {
      await exportPlaywright(getFilteredTestCases(data.testCases));
    });

    document.getElementById('export-to-test-mgmt-btn')?.addEventListener('click', async () => {
      const testsToExport = getFilteredTestCases(data.testCases);
      await exportToTestManagement(testsToExport);
    });

    document.getElementById('cancel-upload-btn')?.addEventListener('click', async () => {
      const response = await chrome.runtime.sendMessage({ type: 'CANCEL_UPLOAD' });
      if (response.success) {
        const cancelBtn = document.getElementById('cancel-upload-btn');
        if (cancelBtn) {
          cancelBtn.disabled = true;
          cancelBtn.innerHTML = '<span class="btn-icon">⏳</span><span>Cancelling...</span>';
        }
      }
    });

    document.getElementById('regenerate-testcases-btn')?.addEventListener('click', async () => {
      const review = document.getElementById('testcases-review-input').value.trim();
      if (!review) {
        showNotification('Please provide some feedback before regenerating.', 'warning');
        return;
      }
      await handleRegenerateTestCases(review);
    });

    // Copy to Clipboard functionality
    document.getElementById('copy-clipboard-btn')?.addEventListener('click', () => {
      const testsToExport = getFilteredTestCases(data.testCases);
      copyTestCasesToClipboard(testsToExport);
    });

    // Filter functionality
    // §15.1: make the per-case review controls live.
    bindReviewDecisionButtons();

    const filterButtons = document.querySelectorAll('.stat-filter');

    // Ensure only 'Total' button is active initially and reset filter state
    activeFilter = 'all';
    searchQuery = '';
    priorityFilter = 'all';

    filterButtons.forEach(btn => {
      if (btn.dataset.filter === 'all') {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    filterButtons.forEach(button => {
      button.addEventListener('click', (e) => {
        // Prevent event bubbling
        e.stopPropagation();

        // Remove active class from all buttons
        filterButtons.forEach(btn => btn.classList.remove('active'));

        // Add active class to clicked button (handle both target and currentTarget)
        const clickedButton = e.currentTarget || e.target;
        clickedButton.classList.add('active');

        // Get filter value
        activeFilter = clickedButton.dataset.filter;
        applyFilters(data.testCases);
      });
    });

    // Search functionality
    document.getElementById('test-search')?.addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase();
      applyFilters(data.testCases);
    });

    // Priority filter
    document.getElementById('priority-filter')?.addEventListener('change', (e) => {
      priorityFilter = e.target.value;
      applyFilters(data.testCases);
    });

    // Clear filters
    document.getElementById('clear-filters-btn')?.addEventListener('click', () => {
      activeFilter = 'all';
      searchQuery = '';
      priorityFilter = 'all';

      // Reset UI
      const searchInput = document.getElementById('test-search');
      if (searchInput) searchInput.value = '';

      const prioritySelect = document.getElementById('priority-filter');
      if (prioritySelect) prioritySelect.value = 'all';

      // Reset active button
      filterButtons.forEach(btn => btn.classList.remove('active'));
      const totalBtn = document.querySelector('.stat-filter[data-filter="all"]');
      if (totalBtn) totalBtn.classList.add('active');

      // Hide the clear button itself
      const clearBtn = document.getElementById('clear-filters-btn');
      if (clearBtn) clearBtn.style.display = 'none';

      applyFilters(data.testCases);
    });
  }

  // Get currently filtered test cases
  // Pure filter predicates moved to content-filters.js (filterTestCases); this
  // wrapper supplies the current module-level filter state.
  function getFilteredTestCases(testCases) {
    return filterTestCases(testCases, { activeFilter, searchQuery, priorityFilter });
  }

  // Apply all active filters to test cases
  function applyFilters(testCases) {
    const filteredTests = getFilteredTestCases(testCases);

    // Check if any filters are active
    // hasActiveFilters moved to content-filters.js.
    const hasFilters = hasActiveFilters({ activeFilter, searchQuery, priorityFilter });

    // Show/hide clear filters button
    const clearBtn = document.getElementById('clear-filters-btn');
    if (clearBtn) {
      clearBtn.style.display = hasFilters ? 'inline-flex' : 'none';
    }

    // Update filter status
    const statusElement = document.getElementById('filter-status');
    if (statusElement) {
      if (hasFilters) {
        statusElement.innerHTML = `
          <span class="filter-badge">
            Showing ${filteredTests.length} of ${testCases.length} tests
          </span>
        `;
      } else {
        statusElement.innerHTML = '';
      }
    }

    // Update the displayed test cases
    const container = document.getElementById('test-cases-container');
    if (container) {
      if (filteredTests.length === 0) {
        container.innerHTML = `
          <div class="no-results">
            <p>No test cases match the current filters.</p>
            <button class="qatalyst-btn secondary" onclick="document.getElementById('clear-filters-btn').click()">
              Clear Filters
            </button>
          </div>
        `;
      } else {
        container.innerHTML = formatTestCases(filteredTests);
      }
    }
  }

  // Copy test cases to clipboard
  function copyTestCasesToClipboard(testCases) {
    // Clipboard text building moved to content-export.js
    // (buildTestCasesClipboardText); this wrapper supplies filter state and
    // performs the navigator.clipboard I/O + button feedback.
    const clipboardText = buildTestCasesClipboardText(testCases, {
      activeFilter, searchQuery, priorityFilter
    });

    // Copy to clipboard
    navigator.clipboard.writeText(clipboardText).then(() => {
      // Show success message
      const btn = document.getElementById('copy-clipboard-btn');
      const originalHTML = btn.innerHTML;
      btn.innerHTML = '<span class="btn-icon">✅</span><span>Copied!</span>';
      btn.style.background = 'linear-gradient(135deg, #10b981 0%, #059669 100%)';

      setTimeout(() => {
        btn.innerHTML = originalHTML;
        btn.style.background = 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 100%)';
      }, 2000);
    }).catch(err => {
      console.error('Failed to copy to clipboard:', err);
      showNotification('Failed to copy test cases to clipboard. Please try again.', 'error');
    });
  }
  
  // F15: renderQualityStatus lives in content-format.js (pure + unit-tested);
  // content.js calls it exactly as it would a local function.

  function renderContextSummaryBox(externalSources, appContext = null) {
    const jiraStatus = '✅ Yes'; // Jira is always the primary context
    const confluenceStatus = externalSources.confluence > 0 ? '✅ Yes' : '❌ No';
    const figmaStatus = externalSources.figma > 0 ? '✅ Yes' : '❌ No';
    const googleDocsStatus = externalSources.googleDocs > 0 ? '✅ Yes' : '❌ No';

    // Check if crawled data is available (filtered by keywords)
    const knowledgeGraphStatus = (appContext && (appContext.knowledgeGraph || appContext.hasCrawledData)) ? '✅ Yes' : '❌ No';

    // Build details for knowledge graph tooltip
    let kgDetails = '';
    if (appContext && appContext.knowledgeGraph) {
      const pages = Object.keys(appContext.knowledgeGraph.pages || {}).length;
      const forms = appContext.knowledgeGraph.forms?.length || 0;
      const apis = appContext.knowledgeGraph.apis?.length || 0;
      kgDetails = `${pages} pages, ${forms} forms, ${apis} APIs`;
    }

    return `
      <div class="context-summary-box">
        <div class="context-summary-item">
          <span class="status-icon">jira:</span>
          <span class="status-text">${jiraStatus}</span>
        </div>
        <div class="context-summary-item">
          <span class="status-icon">confluence:</span>
          <span class="status-text">${confluenceStatus}</span>
        </div>
        <div class="context-summary-item">
          <span class="status-icon">figma:</span>
          <span class="status-text">${figmaStatus}</span>
        </div>
        <div class="context-summary-item">
          <span class="status-icon">google doc:</span>
          <span class="status-text">${googleDocsStatus}</span>
        </div>
        <div class="context-summary-item" ${appContext ? `title="${kgDetails}"` : ''}>
          <span class="status-icon">🕷️ crawled app:</span>
          <span class="status-text">${knowledgeGraphStatus}</span>
        </div>
      </div>
    `;
  }
  
  // Format functions

  // renderMarkdown, inlineMarkdown, formatAnalysis, formatTestScope → content-format.js

  /**
   * §15.1: record what the reviewer decided about a case, so the decision
   * survives the next run instead of having to be made again. Scoped to the
   * project and the requirement revision, so it cannot leak across projects or
   * outlive the requirement it was about.
   */
  async function recordDecision(testCase, verdict, reason) {
    try {
      const key = currentTicketData && currentTicketData.key;
      const res = await chrome.runtime.sendMessage({
        action: 'recordReviewDecision',
        data: {
          testCase, verdict,
          project: key ? String(key).split('-')[0] : 'default',
          meta: {
            reason: reason || '',
            requirementIds: testCase.requirementIds || [],
            requirementRevision: (currentTicketData && (currentTicketData.updated || currentTicketData.version)) || null
          }
        }
      });
      return !!(res && res.success);
    } catch (e) {
      console.warn('[QAtalyst] could not record review decision:', e.message);
      return false;
    }
  }

  /** Wire the per-case review controls rendered by formatTestCases. */
  function bindReviewDecisionButtons() {
    document.querySelectorAll('[data-decision]').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', async () => {
        const idx = Number(btn.dataset.caseIndex);
        const tc = ((currentTestCasesData && currentTestCasesData.testCases) || [])[idx];
        if (!tc) return;
        const ok = await recordDecision(tc, btn.dataset.decision);
        btn.textContent = ok ? '✓ noted' : '✗ failed';
        btn.disabled = true;
      });
    });
  }

  function formatTestCases(testCases) {
    return testCases.map((tc, idx) => {
      // Handle both camelCase and snake_case property names
      const expectedResult = tc.expected_result || tc.expectedResult || 'Not specified';
      const description = tc.description || 'Not specified';
      const preconditions = tc.preconditions || '';
      const testData = tc.test_data || tc.testData || '';

      // Steps may be an array of strings or objects; normalise to strings.
      const steps = Array.isArray(tc.steps) ? tc.steps : (tc.steps ? [tc.steps] : []);
      const stepText = (s) => typeof s === 'string' ? s : (s && (s.action || s.step || s.text) ) || (s != null ? JSON.stringify(s) : '');

      // Add historical badge
      const sourceBadge = tc.source === 'historical'
        ? `<span class="source-badge historical">🛡️ Bug Prevention</span>`
        : '';

      // F15: per-case quality flags. The pipeline records these on every case
      // (unresolved references, no crawl to verify against, a questionable
      // assertion, an asserted behaviour with no supporting API) but the panel
      // rendered none of them, so an unverified case was visually identical to a
      // fully grounded one.
      const warnings = [
        tc._grounding === 'unresolved'
          ? 'References app elements that could not be found in the crawl — verify before executing.' : '',
        tc._grounding === 'unverified'
          ? 'Not verified against a crawled app — grounding could not run.' : '',
        tc._grounding === 'design'
          ? 'Grounded against the Figma design, not the running app — re-check once the feature is built.' : '',
        tc._assertionWarning || '',
        ...(Array.isArray(tc._behaviorWarnings) ? tc._behaviorWarnings : [])
      ].filter(Boolean);
      const qualityBadge = warnings.length
        ? `<span class="tc-quality-badge ${tc._grounding === 'unresolved' ? 'unresolved' : 'review'}" title="${escapeHtml(warnings.join(' '))}">👁️ Review</span>`
        : '';
      const warningsHtml = warnings.length
        ? `<div class="tc-warnings">${warnings.map(w => `<div class="tc-warning">⚠️ ${escapeHtml(w)}</div>`).join('')}</div>`
        : '';

      const ref = escapeHtml(tc.historicalReference || '');
      const historicalInfo = tc.historicalReference
        ? `<div class="historical-ref">📚 Based on: <a href="${escapeHtml(window.location.origin)}/browse/${ref}" target="_blank" rel="noopener noreferrer">${ref}</a></div>`
        : '';

      const stepsHtml = steps.length
        ? `<div class="tc-steps"><strong>Steps:</strong>
             <ol class="tc-steps-list">${steps.map(s => `<li>${inlineMarkdown(stepText(s))}</li>`).join('')}</ol>
           </div>`
        : '';

      return `
      <div class="test-case ${tc.source === 'historical' ? 'historical-test' : ''}${warnings.length ? ' needs-review' : ''}" data-testid="test-case-${idx}">
        <div class="tc-header">
          <span class="tc-id">${escapeHtml(tc.id || '')}</span>
          <span class="tc-priority ${escapeHtml(tc.priority || '')}">${escapeHtml(tc.priority || '')}</span>
          <span class="tc-category">${escapeHtml(tc.category || '')}</span>
          ${sourceBadge}
          ${qualityBadge}
        </div>
        ${warningsHtml}
        <div class="tc-title">${inlineMarkdown(tc.title)}</div>
        ${tc.preventionReason ? `<div class="prevention-reason">🛡️ ${inlineMarkdown(tc.preventionReason)}</div>` : ''}
        ${historicalInfo}
        <div class="tc-description">
          <strong>Description:</strong> ${inlineMarkdown(description)}
        </div>
        ${preconditions ? `<div class="tc-preconditions"><strong>Preconditions:</strong> ${inlineMarkdown(preconditions)}</div>` : ''}
        ${stepsHtml}
        ${testData ? `<div class="tc-data"><strong>Test Data:</strong> ${inlineMarkdown(testData)}</div>` : ''}
        <div class="tc-expected">
          <strong>Expected Result:</strong> ${inlineMarkdown(expectedResult)}
        </div>
        <div class="tc-decisions">
          <span class="tc-decisions-label">Not useful?</span>
          <button type="button" class="tc-decision-btn" data-decision="irrelevant" data-case-index="${idx}"
                  title="Do not propose this scenario again for this ticket">Irrelevant</button>
          <button type="button" class="tc-decision-btn" data-decision="incorrect_expectation" data-case-index="${idx}"
                  title="The expected result is wrong">Wrong expectation</button>
          <button type="button" class="tc-decision-btn" data-decision="not_executable" data-case-index="${idx}"
                  title="This cannot be run as written">Not executable</button>
        </div>
      </div>
    `;
    }).join('');
  }
  
  const RUN_ICONS = { passed: '✅', partial: '🟡', failed: '❌', skipped: '⏭️', not_automatable: '✋' };

  /** Replay tests in the user's app (worker: test-runner.js) and show the results. */
  /**
   * Step 1 of "Verify in app": ask which page the tests start on. Tests that name
   * no page of their own (common when generated without a crawl) start there.
   * Prefilled from the last URL used for this Jira project, else the crawled app.
   */
  async function verifyInApp(testCases) {
    const box = document.getElementById('run-results');
    if (!box || !testCases.length) return;
    const project = (extractTicketKey() || '').split('-')[0] || 'default';
    const storeKey = `qatalyst_verify_start::${project}`;
    let appContext = null;
    try { appContext = await extractAppContext(currentTicketData || {}); } catch (_) { /* optional */ }
    let saved = '';
    try { saved = (await chrome.storage.local.get(storeKey))[storeKey] || ''; } catch (_) { /* optional */ }
    const prefill = saved || (appContext && (appContext.appUrl || appContext.knowledgeGraph?.appUrl)) || '';
    box.innerHTML = `
      <div class="quality-block">
        <label for="verify-start-url" style="display:block; font-weight:600; margin-bottom:4px;">Start page</label>
        <p class="quality-note" style="margin:0 0 6px 0;">Tests that don't name a page begin here. Use a test environment if you can.</p>
        <div style="display:flex; gap:6px;">
          <input type="url" id="verify-start-url" data-testid="verify-start-url" placeholder="https://your-app.example.com/page"
                 style="flex:1; padding:6px 8px; border:1px solid #cbd5e1; border-radius:6px;">
          <button class="qatalyst-btn primary" id="verify-run-btn" data-testid="verify-run-btn" style="width:auto;">Run tests</button>
        </div>
        <div id="verify-url-error" class="tc-warning" hidden></div>
      </div>`;
    const input = document.getElementById('verify-start-url');
    input.value = prefill;
    input.focus();
    document.getElementById('verify-run-btn').addEventListener('click', async () => {
      const url = input.value.trim();
      const err = document.getElementById('verify-url-error');
      if (!/^https?:\/\/[^\s]+$/i.test(url)) {
        err.textContent = '⚠️ Enter a full URL starting with https:// (or http:// for a local app).';
        err.hidden = false;
        return;
      }
      try { await chrome.storage.local.set({ [storeKey]: url }); } catch (_) { /* optional */ }
      await runVerification(testCases, url, appContext && appContext.knowledgeGraph);
    });
  }

  /** Step 2: confirm, run in a background tab (worker: test-runner.js), show results. */
  async function runVerification(testCases, startUrl, knowledgeGraph) {
    const box = document.getElementById('run-results');
    // This clicks and types in a live app with the user's session. Say so first.
    const ok = window.confirm(
      `QAtalyst will run ${testCases.length} test(s) in a background tab on ${new URL(startUrl).host}, clicking and typing with your logged-in session.\n\n` +
      'Use a test environment if you can. Steps that delete, pay, send or transfer are skipped. Continue?');
    if (!ok) return;
    box.innerHTML = '<div class="quality-note">▶️ Starting…</div>';
    const res = await chrome.runtime.sendMessage({ action: 'runTestsInApp', data: { tests: testCases, knowledgeGraph: knowledgeGraph || null, startUrl } });
    if (!res || res.error) {
      box.innerHTML = `<div class="tc-warning">⚠️ ${escapeHtml((res && res.error) || 'The run did not start.')}</div>`;
      return;
    }
    const byId = new Map(testCases.map(t => [t.id || t.title, t]));
    const order = ['failed', 'partial', 'passed', 'skipped', 'not_automatable'];
    const rows = [...res.results].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status)).map(r => {
      const t = byId.get(r.id) || {};
      const why = r.reason ? ` — ${escapeHtml(r.reason)}${r.step ? ` (step ${r.step})` : ''}` : '';
      const skipped = (r.log || []).length ? `<div class="quality-note">${(r.log || []).map(escapeHtml).join('<br>')}</div>` : '';
      return `<li>${RUN_ICONS[r.status] || ''} <strong>${escapeHtml(r.id || '')}</strong> ${escapeHtml(t.title || '')}${why}${skipped}</li>`;
    }).join('');
    const summary = Object.entries(res.summary).map(([k, v]) => `${RUN_ICONS[k] || ''} ${v} ${k.replace('_', ' ')}`).join(' · ');
    box.innerHTML = `<div class="quality-block"><h5>Run in app: ${escapeHtml(summary)}</h5>
      <p class="quality-note">🟡 partial = passed, but some steps were manual or needed test data and were not executed.</p>
      <ul style="margin: 4px 0 0 16px; padding: 0;">${rows}</ul></div>`;
  }

  /** Download a Playwright spec for these tests (playwright-export.js). */
  async function exportPlaywright(testCases) {
    const btn = document.getElementById('export-playwright-btn');
    try {
      // The crawl supplies stable selectors (#id, data-testid). Without it the spec
      // still works, using role / label / text locators.
      let knowledgeGraph = null;
      try { knowledgeGraph = (await extractAppContext(currentTicketData || {}))?.knowledgeGraph || null; } catch (_) { /* optional */ }
      const ticketKey = extractTicketKey() || 'test-cases';
      const { filename, source, stats } = PlaywrightExport.exportPlaywrightSpec(testCases, {
        ticketKey, summary: (currentTicketData && currentTicketData.summary) || '', knowledgeGraph
      });
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showNotification(`Playwright spec downloaded: ${stats.full} automated, ${stats.partial} with manual steps or TODO data, ${stats.none} marked fixme.`);
      if (btn) {
        const original = btn.innerHTML;
        btn.innerHTML = '<span class="btn-icon">✅</span><span>Exported!</span>';
        setTimeout(() => { btn.innerHTML = original; }, 2000);
      }
    } catch (error) {
      console.error('Playwright export failed:', error);
      showNotification(`Playwright export failed: ${error.message}`, 'error');
    }
  }

  function exportTestCasesToCSV(testCases) {
    try {
      // CSV document building moved to content-export.js (buildTestCasesCSV);
      // this function performs the Blob creation + download I/O.
      const csvContent = buildTestCasesCSV(testCases);

      // Create blob and download
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      
      // Generate filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
      const ticketKey = extractTicketKey() || 'test-cases';
      const filename = `${ticketKey}_test_cases_${timestamp}.csv`;
      
      link.setAttribute('href', url);
      link.setAttribute('download', filename);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      // Show success message
      const btn = document.getElementById('export-csv-btn');
      if (btn) {
        const originalHTML = btn.innerHTML;
        btn.innerHTML = '<span class="btn-icon">✅</span><span>Exported!</span>';
        btn.disabled = true;
        setTimeout(() => {
          btn.innerHTML = originalHTML;
          btn.disabled = false;
        }, 2000);
      }
      
      console.log(`✅ Exported ${testCases.length} test cases to ${filename}`);
    } catch (error) {
      console.error('Error exporting to CSV:', error);
      showNotification('Failed to export test cases to CSV. Please try again.', 'error');
    }
  }

  function handleUploadProgress(progress) {
    const btn = document.getElementById('export-to-test-mgmt-btn');
    if (!btn) return;

    const { current, total, phase } = progress;

    if (phase === 'initializing') {
      btn.innerHTML = '<span class="btn-icon">🔄</span><span>Initializing...</span>';
    } else if (phase === 'checking-duplicates') {
      btn.innerHTML = '<span class="btn-icon">🔍</span><span>Checking duplicates...</span>';
    } else if (phase === 'bulk-uploading') {
      btn.innerHTML = '<span class="btn-icon">🚀</span><span>Bulk uploading...</span>';
    } else if (phase === 'uploading') {
      const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
      btn.innerHTML = `<span class="btn-icon">📤</span><span>Uploading ${current}/${total} (${percentage}%)</span>`;
    } else if (phase === 'completed') {
      btn.innerHTML = '<span class="btn-icon">✅</span><span>Completed!</span>';
    } else if (phase === 'cancelled') {
      btn.innerHTML = '<span class="btn-icon">🛑</span><span>Cancelled</span>';
    } else if (phase === 'rate-limited') {
      btn.innerHTML = '<span class="btn-icon">⚠️</span><span>Rate Limited</span>';
    }
  }

  async function exportToTestManagement(testCases) {
    const btn = document.getElementById('export-to-test-mgmt-btn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="btn-icon">⏳</span><span>Exporting...</span>';
    }

    // Show cancel button
    const cancelBtn = document.getElementById('cancel-upload-btn');
    if (cancelBtn) {
      cancelBtn.style.display = 'inline-block';
    }

    try {
      // Get Jira ticket key
      const ticketKey = extractTicketKey();

      // Send message to background script to handle the export
      const response = await chrome.runtime.sendMessage({
        type: 'EXPORT_TO_TEST_MANAGEMENT',
        testCases: testCases,
        jiraTicket: ticketKey
      });

      // Hide cancel button
      if (cancelBtn) {
        cancelBtn.style.display = 'none';
        cancelBtn.disabled = false;
        cancelBtn.innerHTML = '<span class="btn-icon">🛑</span><span>Cancel</span>';
      }

      if (response.success) {
        // Show success feedback
        if (btn) {
          btn.innerHTML = '<span class="btn-icon">✅</span><span>Exported!</span>';
          setTimeout(() => {
            btn.innerHTML = '<span class="btn-icon">🚀</span><span>Export to Test Management <span style="background: #3b82f6; color: white; font-size: 9px; font-weight: 600; padding: 2px 6px; border-radius: 3px; margin-left: 6px; vertical-align: middle;">BETA</span></span>';
            btn.disabled = false;
          }, 3000);
        }

        // Show detailed results
        const successCount = response.results.success.length;
        const failedCount = response.results.failed.length;
        const skippedCount = response.results.skipped ? response.results.skipped.length : 0;
        const platform = response.platform;

        let message = `Successfully exported ${successCount} test case(s) to ${platform}`;

        if (skippedCount > 0) {
          message += `\n${skippedCount} duplicate(s) skipped (already exist in ${platform})`;
        }

        if (failedCount > 0) {
          message += `\n\nFailed to export ${failedCount} test case(s):`;
          response.results.failed.forEach(fail => {
            message += `\n- ${fail.title}: ${fail.error}`;
          });
        }

        if (skippedCount > 0) {
          message += '\n\nSkipped duplicates:';
          response.results.skipped.forEach(skip => {
            message += `\n- ${skip.title} (already exists: ${skip.existingId})`;
          });
        }

        if (successCount > 0) {
          message += '\n\nSuccessfully exported:';
          response.results.success.forEach(success => {
            message += `\n- ${success.title} (${success.id})`;
          });
        }

        // Show success notification with summary
        const notificationType = failedCount > 0 ? 'warning' : 'success';
        const summaryMsg = `Exported ${successCount} test cases to test management` +
          (failedCount > 0 ? ` (${failedCount} failed, ${skippedCount} skipped)` : '');
        showNotification(summaryMsg, notificationType);
        console.log('Export results:', response.results);
      } else {
        throw new Error(response.error || 'Export failed');
      }
    } catch (error) {
      console.error('❌ Error exporting to test management:', error);

      // Hide cancel button
      const cancelBtn = document.getElementById('cancel-upload-btn');
      if (cancelBtn) {
        cancelBtn.style.display = 'none';
        cancelBtn.disabled = false;
        cancelBtn.innerHTML = '<span class="btn-icon">🛑</span><span>Cancel</span>';
      }

      // Show error feedback
      if (btn) {
        btn.innerHTML = '<span class="btn-icon">❌</span><span>Export Failed</span>';
        setTimeout(() => {
          btn.innerHTML = '<span class="btn-icon">🚀</span><span>Export to Test Management <span style="background: #3b82f6; color: white; font-size: 9px; font-weight: 600; padding: 2px 6px; border-radius: 3px; margin-left: 6px; vertical-align: middle;">BETA</span></span>';
          btn.disabled = false;
        }, 3000);
      }

      showNotification(`Export failed: ${error.message}. Check your Test Management settings.`, 'error');
    }
  }

  async function addAnalysisToJira(analysis) {
    const btn = document.getElementById('add-analysis-to-jira-btn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="btn-icon">⏳</span><span>Posting to Jira...</span>';
    }

    try {
      const baseUrl = window.location.origin;
      const ticketKey = extractTicketKey();

      // Format analysis for Jira comment
      const formattedComment = formatAnalysisForJiraComment(analysis);

      const response = await fetch(`${baseUrl}/rest/api/2/issue/${ticketKey}/comment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({
          body: formattedComment
        })
      });

      if (response.ok) {
        if (btn) {
          btn.innerHTML = '<span class="btn-icon">✅</span><span>Posted to Jira!</span>';
          setTimeout(() => {
            btn.disabled = false;
            btn.innerHTML = '<span class="btn-icon">📝</span><span>Add to Jira</span>';
          }, 3000);
        }

        showNotification('✅ Requirements analysis successfully posted to Jira comments!', 'success');

        setTimeout(() => {
          window.location.reload();
        }, 2000);
      } else {
        throw new Error(`Failed to post comment: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.error('Failed to post to Jira:', error);

      try {
        await navigator.clipboard.writeText(analysis);
        showNotification('⚠️ Could not post directly to Jira. Requirements analysis copied to clipboard - please paste manually.', 'warning');
      } catch (clipboardError) {
        showNotification('❌ Failed to post to Jira and copy to clipboard. Please try again.', 'error');
      }

      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span class="btn-icon">📝</span><span>Add to Jira</span>';
      }
    }
  }

  async function addTestScopeToJira(testScope) {
    const btn = document.getElementById('add-scope-to-jira-btn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="btn-icon">⏳</span><span>Posting to Jira...</span>';
    }

    try {
      const baseUrl = window.location.origin;
      const ticketKey = extractTicketKey();

      // Format test scope for Jira comment
      const formattedComment = formatTestScopeForJiraComment(testScope);

      const response = await fetch(`${baseUrl}/rest/api/2/issue/${ticketKey}/comment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({
          body: formattedComment
        })
      });

      if (response.ok) {
        if (btn) {
          btn.innerHTML = '<span class="btn-icon">✅</span><span>Posted to Jira!</span>';
          setTimeout(() => {
            btn.disabled = false;
            btn.innerHTML = '<span class="btn-icon">📝</span><span>Add to Jira</span>';
          }, 3000);
        }

        showNotification('✅ Test scope successfully posted to Jira comments!', 'success');

        setTimeout(() => {
          window.location.reload();
        }, 2000);
      } else {
        throw new Error(`Failed to post comment: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.error('Failed to post to Jira:', error);

      try {
        await navigator.clipboard.writeText(testScope);
        showNotification('⚠️ Could not post directly to Jira. Test scope copied to clipboard - please paste manually.', 'warning');
      } catch (clipboardError) {
        showNotification('❌ Failed to post to Jira and copy to clipboard. Please try again.', 'error');
      }

      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span class="btn-icon">📝</span><span>Add to Jira</span>';
      }
    }
  }

  async function addTestCasesToJira(testCases) {
    const btn = document.getElementById('add-to-jira-btn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="btn-icon">⏳</span><span>Posting to Jira...</span>';
    }

    try {
      // Get Jira site URL from current page
      const baseUrl = window.location.origin;
      const ticketKey = extractTicketKey();

      // Format test cases for Jira comment (using Jira markdown)
      const formattedComment = formatTestCasesForJiraComment(testCases);

      // Try to post comment using Jira REST API
      const response = await fetch(`${baseUrl}/rest/api/2/issue/${ticketKey}/comment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        credentials: 'include', // Include cookies for authentication
        body: JSON.stringify({
          body: formattedComment
        })
      });

      if (response.ok) {
        if (btn) {
          btn.innerHTML = '<span class="btn-icon">✅</span><span>Posted to Jira!</span>';
          setTimeout(() => {
            btn.disabled = false;
            btn.innerHTML = '<span class="btn-icon">📝</span><span>Add to Jira</span>';
          }, 3000);
        }

        // Show success notification
        showNotification('✅ Test cases successfully posted to Jira comments!', 'success');

        // Reload comments section to show new comment
        setTimeout(() => {
          window.location.reload();
        }, 2000);
      } else {
        throw new Error(`Failed to post comment: ${response.status} ${response.statusText}`);
      }
    } catch (error) {
      console.error('Failed to post to Jira:', error);

      // Fallback to copy to clipboard
      const formatted = formatTestCasesForClipboard(testCases);
      try {
        await navigator.clipboard.writeText(formatted);
        showNotification('⚠️ Could not post directly to Jira. Test cases copied to clipboard - please paste manually.', 'warning');
      } catch (clipboardError) {
        showNotification('❌ Failed to post to Jira and copy to clipboard. Please try again.', 'error');
      }

      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<span class="btn-icon">📝</span><span>Add to Jira</span>';
      }
    }
  }

  // formatAnalysisForJiraComment, formatTestScopeForJiraComment,
  // formatTestCasesForJiraComment, formatTestCasesForClipboard,
  // getPriorityColor, getCategoryColor → content-utils.js

  /**
   * Show warning modal when no crawled data is available
   * Returns true if user wants to proceed anyway, false if they cancel
   */
  async function showNoCrawlDataWarning() {
    return new Promise((resolve) => {
      // Create modal overlay
      const overlay = document.createElement('div');
      overlay.id = 'qatalyst-crawl-warning-overlay';
      overlay.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 0, 0, 0.5);
        z-index: 10000000;
        display: flex;
        align-items: center;
        justify-content: center;
      `;

      // Create modal content
      const modal = document.createElement('div');
      modal.style.cssText = `
        background: white;
        border-radius: 12px;
        padding: 24px;
        max-width: 500px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      `;

      modal.innerHTML = `
        <div style="text-align: center; margin-bottom: 16px;">
          <span style="font-size: 48px;">⚠️</span>
        </div>
        <h3 style="margin: 0 0 12px 0; color: #856404; text-align: center; font-size: 18px;">
          No Crawled Application Data Found
        </h3>
        <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 12px; margin-bottom: 16px;">
          <p style="margin: 0 0 8px 0; color: #856404; font-size: 14px; font-weight: 600;">
            Test Quality Impact:
          </p>
          <ul style="margin: 0; padding-left: 20px; color: #856404; font-size: 13px;">
            <li>Tests may reference non-existent fields, buttons, or APIs</li>
            <li>No validation against actual application structure</li>
            <li>Higher risk of hallucinated test data</li>
            <li>Coverage mapping will not work</li>
          </ul>
        </div>
        <div style="background: #d4edda; border: 1px solid #28a745; border-radius: 8px; padding: 12px; margin-bottom: 20px;">
          <p style="margin: 0 0 8px 0; color: #155724; font-size: 14px; font-weight: 600;">
            💡 Recommended: Crawl your application first
          </p>
          <ol style="margin: 0; padding-left: 20px; color: #155724; font-size: 13px;">
            <li>Open the QAtalyst popup (click extension icon)</li>
            <li>Enter your application URL</li>
            <li>Click "Start Crawl" and wait for completion</li>
            <li>Then generate test cases with full context</li>
          </ol>
        </div>
        <div style="display: flex; gap: 12px; justify-content: center;">
          <button id="qatalyst-crawl-cancel" style="
            padding: 10px 20px;
            background: #28a745;
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
          ">
            🔍 Crawl First (Recommended)
          </button>
          <button id="qatalyst-crawl-proceed" style="
            padding: 10px 20px;
            background: #6c757d;
            color: white;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
          ">
            ⚡ Generate Anyway
          </button>
        </div>
        <p style="margin: 12px 0 0 0; text-align: center; font-size: 11px; color: #6c757d;">
          Quality rating without crawl: 3-4/10 | With crawl: 8-9/10
        </p>
      `;

      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      // Handle button clicks
      document.getElementById('qatalyst-crawl-cancel').addEventListener('click', () => {
        overlay.remove();
        resolve(false); // Don't proceed
      });

      document.getElementById('qatalyst-crawl-proceed').addEventListener('click', () => {
        overlay.remove();
        resolve(true); // Proceed anyway
      });

      // Allow clicking overlay to cancel
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
          overlay.remove();
          resolve(false);
        }
      });
    });
  }

  function showNotification(message, type = 'success') {
    const container = document.getElementById('results-container');
    if (!container) return;

    const notification = document.createElement('div');
    notification.className = type === 'success' ? 'qatalyst-success' :
                           type === 'warning' ? 'qatalyst-warning' :
                           'qatalyst-error';
    notification.style.position = 'fixed';
    notification.style.top = '20px';
    notification.style.right = '460px';
    notification.style.zIndex = '1000000';
    notification.style.maxWidth = '400px';
    notification.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
    notification.innerHTML = message;

    document.body.appendChild(notification);

    setTimeout(() => {
      notification.remove();
    }, 5000);
  }
  
  // Regeneration handlers for user review feature
  async function handleRegenerateAnalysis(userReview) {
    const resultsContainer = document.getElementById('results-container');
    const btn = document.getElementById('regenerate-analysis-btn');
    if (btn) btn.disabled = true;

    try {
      const settings = await loadAndDecryptSettings(['llmProvider', 'llmModel', 'apiKey', 'bedrockAccessKeyId', 'bedrockSecretKey', 'bedrockSessionToken', 'bedrockRegion']);

      // Check if AI provider is configured
      if (!settings.llmProvider) {
        throw new Error('Please select an AI provider in the extension settings first');
      }

      if (!settings.apiKey) {
        throw new Error('Please add your API key in the extension settings first');
      }

      resultsContainer.innerHTML = '<div class="qatalyst-loading">🔄 Regenerating analysis based on your feedback...</div>';

      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'regenerateWithReview',
          data: {
            type: 'analysis',
            originalContent: currentAnalysisData.analysis,
            userReview: userReview,
            settings
          }
        }, response => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!response) {
            reject(new Error('No response received from extension'));
          } else if (response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response);
          }
        });
      });

      // Update current data and display
      currentAnalysisData.analysis = response.improvedContent;
      displayAnalysisResults(currentAnalysisData);

    } catch (error) {
      resultsContainer.innerHTML = `<div class="qatalyst-error">❌ ${error.message.replace(/\\n/g, '<br>')}</div>`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function handleRegenerateTestScope(userReview) {
    const resultsContainer = document.getElementById('results-container');
    const btn = document.getElementById('regenerate-scope-btn');
    if (btn) btn.disabled = true;

    try {
      const settings = await loadAndDecryptSettings(['llmProvider', 'llmModel', 'apiKey', 'bedrockAccessKeyId', 'bedrockSecretKey', 'bedrockSessionToken', 'bedrockRegion']);

      // Check if AI provider is configured
      if (!settings.llmProvider) {
        throw new Error('Please select an AI provider in the extension settings first');
      }

      if (!settings.apiKey) {
        throw new Error('Please add your API key in the extension settings first');
      }

      resultsContainer.innerHTML = '<div class="qatalyst-loading">🔄 Regenerating test scope based on your feedback...</div>';

      const scopeContent = currentTestScopeData.scope || currentTestScopeData.testScope;

      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'regenerateWithReview',
          data: {
            type: 'testScope',
            originalContent: scopeContent,
            userReview: userReview,
            settings
          }
        }, response => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!response) {
            reject(new Error('No response received from extension'));
          } else if (response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response);
          }
        });
      });

      // Update current data and display
      currentTestScopeData.scope = response.improvedContent;
      displayTestScopeResults(currentTestScopeData);

    } catch (error) {
      resultsContainer.innerHTML = `<div class="qatalyst-error">❌ ${error.message.replace(/\\n/g, '<br>')}</div>`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function handleRegenerateTestCases(userReview) {
    const resultsContainer = document.getElementById('results-container');
    const btn = document.getElementById('regenerate-testcases-btn');
    if (btn) btn.disabled = true;

    try {
      const settings = await loadAndDecryptSettings(['llmProvider', 'llmModel', 'apiKey', 'bedrockAccessKeyId', 'bedrockSecretKey', 'bedrockSessionToken', 'bedrockRegion', 'testCount']);

      // Check if AI provider is configured
      if (!settings.llmProvider) {
        throw new Error('Please select an AI provider in the extension settings first');
      }

      if (!settings.apiKey) {
        throw new Error('Please add your API key in the extension settings first');
      }

      resultsContainer.innerHTML = '<div class="qatalyst-loading">🔄 Regenerating test cases based on your feedback...</div>';

      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: 'regenerateWithReview',
          data: {
            type: 'testCases',
            originalContent: JSON.stringify(currentTestCasesData.testCases),
            userReview: userReview,
            settings,
            // F03: send the original ticket + crawl evidence too. Regeneration
            // was previously given only the previous output and the review
            // comment, so the regenerated suite could not be checked for
            // relevance or grounding against anything.
            ticketData: currentTicketData,
            appContext: currentAppContext
          }
        }, response => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!response) {
            reject(new Error('No response received from extension'));
          } else if (response.error) {
            reject(new Error(response.error));
          } else {
            resolve(response);
          }
        });
      });

      // Update current data and display
      currentTestCasesData.testCases = response.improvedTestCases;
      displayTestCasesResults(currentTestCasesData);

    } catch (error) {
      resultsContainer.innerHTML = `<div class="qatalyst-error">❌ ${error.message.replace(/\\n/g, '<br>')}</div>`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function showHelp() {
    // Open options page with Help tab selected
    chrome.runtime.sendMessage({ action: 'openOptionsPage', tab: 'help' });
  }

  /**
   * Handle quality reports from background script (validation, coverage, duplicates)
   * Stores reports for display in test results and logs summary
   */
  function handleQualityReports(reports) {
    if (!reports) return;

    console.log('📊 [QualityReports] Received quality reports:', {
      validation: reports.validation ? `${reports.validation.validCount || 0}/${reports.validation.totalCount || 0} valid` : 'N/A',
      coverage: reports.coverage ? `${reports.coverage.overallCoverage || 0}%` : 'N/A',
      duplicates: reports.duplicates ? `${reports.duplicates.duplicatesRemoved || 0} removed` : 'N/A'
    });

    // Store reports globally for display when test results render
    currentQualityReports = reports;

    // Update UI if results container already has test cases displayed
    const container = document.getElementById('results-container');
    if (!container) return;

    // Append quality summary if not already shown
    const existingReport = container.querySelector('.quality-reports-summary');
    if (existingReport) return;

    const reportHTML = document.createElement('div');
    reportHTML.className = 'quality-reports-summary';
    reportHTML.style.cssText = 'background: #f0f7ff; border: 1px solid #b8daff; border-radius: 8px; padding: 12px; margin: 12px 0;';

    const items = [];
    if (reports.validation) {
      const pct = reports.validation.totalCount > 0
        ? Math.round((reports.validation.validCount / reports.validation.totalCount) * 100)
        : 100;
      items.push(`✅ Validation: ${pct}% passed (${reports.validation.validCount}/${reports.validation.totalCount})`);
    }
    if (reports.coverage) {
      items.push(`📊 Coverage: ${reports.coverage.overallCoverage || 0}%`);
    }
    if (reports.duplicates) {
      items.push(`🔄 Duplicates: ${reports.duplicates.duplicatesRemoved || 0} removed`);
    }

    reportHTML.innerHTML = `
      <div style="font-weight: 600; margin-bottom: 6px; font-size: 13px;">📋 Quality Report</div>
      <div style="font-size: 12px; color: #495057;">${items.join(' &nbsp;|&nbsp; ')}</div>
    `;

    // F21: the evolution-progress container no longer exists — nothing renders it.
    container.appendChild(reportHTML);
  }

  // Initialize
  if (window.location.pathname.includes('/browse/')) {
    injectPanel();
  }

  // Crawler page handlers (extractDOM, discoverLinks, …) and showCrawlCompleteModal
  // → content-crawler.js
  /**
   * Extract app context from crawled knowledge graphs
   * This enriches test case generation with real implementation details
   */
  async function extractAppContext(ticketData) {
    try {
      console.log('🔍 [CRAWL DATA] Checking for crawled app context...');

      // Get all crawled apps from background script (which has access to extension's IndexedDB)
      console.log('[CRAWL DATA] 📡 Requesting app list from background script...');
      const response = await chrome.runtime.sendMessage({
        action: 'getAllApps'
      });

      console.log('[CRAWL DATA] 📨 Response from getAllApps:', JSON.stringify(response, null, 2));

      if (!response) {
        console.log('⚠️ [CRAWL DATA] No response from background script');
        return null;
      }

      if (!response.success) {
        console.log('⚠️ [CRAWL DATA] getAllApps failed:', response.error || 'Unknown error');
        return null;
      }

      if (!response.apps || response.apps.length === 0) {
        console.log('⚠️ [CRAWL DATA] No crawled apps found in database');
        console.log('   💡 Use the popup or settings page to crawl your application first');
        return null;
      }

      console.log(`📚 [CRAWL DATA] Found ${response.apps.length} crawled app(s):`);
      response.apps.forEach((app, i) => {
        console.log(`   ${i + 1}. ${app.url} - ${app.pages} pages, ${app.features} features`);
      });

      // F18: pick the crawled app that matches THIS ticket, not simply the
      // largest graph. Previously every ticket was grounded against the biggest
      // crawl regardless of relevance — with two apps crawled, tickets for the
      // small app got confidently-wrong entities from the big one. findMatchingApp
      // scores apps by domain/product mentions in the ticket and only falls back
      // to merged/largest when nothing matches. (It also handles the single-app
      // and merged-graph cases internally.)
      let selectedApp;
      if (typeof findMatchingApp === 'function') {
        selectedApp = findMatchingApp(response.apps, ticketData) || response.apps[0];
      } else {
        // Defensive fallback (should not happen — content-utils loads first).
        const merged = response.apps.filter(a => a.url.startsWith('merged_'));
        const pool = merged.length ? merged : response.apps;
        selectedApp = pool.reduce((p, c) => (c.pages > p.pages ? c : p), pool[0]);
      }

      console.log(`✅ [CRAWL DATA] Selected crawled app (ticket-matched): ${selectedApp.url} (${selectedApp.pages} pages, ${selectedApp.features} features)`);
      const matchedApp = selectedApp;

      // Load the knowledge graph from background script
      // Pass ticketData for smart keyword-based filtering
      console.log('[CRAWL DATA] 📡 Requesting knowledge graph with ticket context...');

      // Query EVERY relevant crawl, not just the best one.
      //
      // Only the top-ranked app was loaded, so with a 257-page help-site crawl
      // and a 70-page app crawl, one of them was silently ignored — and a rule
      // documented only in the help centre, or a control present only in the app,
      // was invisible to generation depending on which won.
      //
      // Each graph is filtered to the ticket's relevant pages first (the worker
      // does that), so combining them stays bounded rather than shipping both
      // crawls wholesale.
      const ranked = (typeof rankMatchingApps === 'function')
        ? rankMatchingApps(response.apps, ticketData)
        : [matchedApp];
      const toLoad = ranked.slice(0, 3); // bounded: primary + supporting evidence

      const loaded = [];
      for (const app of toLoad) {
        const res = await chrome.runtime.sendMessage({
          action: 'loadEmbeddings',
          data: { appUrl: app.url, ticketData }
        });
        if (res && res.success && res.result && res.result.knowledgeGraph) {
          const pageCount = Object.keys(res.result.knowledgeGraph.pages || {}).length;
          // A crawl that contributes no ticket-relevant page adds nothing but noise.
          if (pageCount > 0) {
            loaded.push({ app, result: res.result, pageCount });
            console.log(`   + ${app.url}: ${pageCount} relevant page(s)`);
          } else {
            console.log(`   - ${app.url}: no ticket-relevant pages, skipped`);
          }
        }
      }

      let kgResponse;
      if (loaded.length === 0) {
        // Fall back to the primary so the "no relevant pages" path still reports.
        kgResponse = await chrome.runtime.sendMessage({
          action: 'loadEmbeddings',
          data: { appUrl: matchedApp.url, ticketData }
        });
      } else if (loaded.length === 1) {
        kgResponse = { success: true, result: loaded[0].result };
      } else {
        // Combine the filtered graphs so grounding sees the app AND the docs.
        const merged = await chrome.runtime.sendMessage({
          action: 'mergeGraphsInMemory',
          data: { graphs: loaded.map(l => l.result.knowledgeGraph) }
        });
        if (merged && merged.success && merged.knowledgeGraph) {
          const primary = loaded[0].result;
          kgResponse = { success: true, result: {
            ...primary,
            knowledgeGraph: merged.knowledgeGraph,
            appUrl: primary.appUrl,
            combinedFrom: loaded.map(l => l.app.url),
            transferPageCount: Object.keys(merged.knowledgeGraph.pages || {}).length
          } };
          console.log(`🔀 Combined ${loaded.length} crawls for grounding: ${loaded.map(l => l.app.url).join(', ')}`);
        } else {
          kgResponse = { success: true, result: loaded[0].result };
        }
      }

      console.log('[CRAWL DATA] 📨 loadEmbeddings response:', kgResponse ? 'received' : 'null');

      if (!kgResponse) {
        console.error('❌ [CRAWL DATA] No response from loadEmbeddings');
        return null;
      }

      if (!kgResponse.success) {
        console.error('❌ [CRAWL DATA] Failed to load knowledge graph');
        console.error('   Error:', kgResponse.error || 'Unknown error');
        console.error('   Full response:', JSON.stringify(kgResponse, null, 2));
        return null;
      }

      // Receive knowledge graph from background (will be analyzed by ContextAnalysisAgent in orchestrator)
      const knowledgeGraph = kgResponse.result.knowledgeGraph;
      const hasContext = kgResponse.result.hasContext;

      console.log('[CRAWL DATA] 📨 Received knowledge graph from background');

      if (hasContext) {
        console.log(`✅ [CRAWL DATA] Knowledge graph available`);
        console.log(`   App URL: ${kgResponse.result.appUrl}`);
        console.log(`   Pages: ${kgResponse.result.transferPageCount} / ${kgResponse.result.pageCount}`);
        console.log(`   Graph pages: ${Object.keys(knowledgeGraph.pages || {}).length}`);
      } else {
        console.log('ℹ️ [CRAWL DATA] No knowledge graph available');
      }

      // Create app context with raw knowledge graph
      // ContextAnalysisAgent will analyze this in the orchestrator (Agent 1/8)
      const r = kgResponse.result;
      const context = {
        appUrl: r.appUrl,
        knowledgeGraph: knowledgeGraph,
        hasContext: hasContext,
        crawledAt: r.crawledAt,
        pageCount: r.pageCount,
        transferPageCount: r.transferPageCount,
        // F01: these evidence flags were dropped here, so the worker's
        // stale / thin-relevance degradation warnings could never fire — the
        // suite looked fully grounded even against a months-old or unrelated
        // crawl. They live on `result` (not on the graph) — carry both.
        stale: r.stale,
        stalenessDays: r.stalenessDays,
        staleAfterDays: r.staleAfterDays,
        lowRelevance: knowledgeGraph?.lowRelevance,
        noRelevantPages: knowledgeGraph?.noRelevantPages
      };

      console.log('✅ [CRAWL DATA] App context prepared successfully:');
      console.log('   Context available:', hasContext);
      console.log('   Pages:', context.pageCount || 0);
      return context;

    } catch (error) {
      console.error('❌ Error extracting app context:', error);
      return null;
    }
  }

  // findMatchingApp, extractTicketKeywords, calculateRelevanceScore,
  // extractRelevantContext, formatAppContextForPrompt → content-utils.js
  // (the second extractTicketKeywords declaration; it was the effective one)

  // handleDetectSPAFramework → content-crawler.js

  // Handle Jira SPA navigation
  let lastUrl = window.location.href;
  new MutationObserver(() => {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      if (currentUrl.includes('/browse/')) {
        setTimeout(injectPanel, 1000);
      }
    }
  }).observe(document, { subtree: true, childList: true });

})();
