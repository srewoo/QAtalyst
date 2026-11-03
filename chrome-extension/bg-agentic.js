/**
 * bg-agentic.js — Agentic test generation (planner loop + acceptance gate + coverage), its helpers, and regenerate-with-review.
 *
 * Moved verbatim out of background.js. Plain script: the worker importScripts it,
 * so these functions stay globals and every call site is unchanged.
 */


// Multi-agent test generation handler
/**
 * Agentic test-case generation.
 *
 * A planner LLM drives an observe→decide→act loop over a tool registry (BM25
 * search, element inspection, coverage check, grounded test proposal, …). Every
 * proposed test passes the AcceptanceGate (grounding + relevance + dedup) before
 * it counts, and coverage is re-measured each round and fed back into the next
 * decision. The result is a grounded, non-duplicate, relevant suite whose size
 * is driven by coverage of the real app rather than a fixed count.
 *
 * Falls back transparently: with no crawl data, grounding is "not applicable" and
 * the gate enforces relevance + dedup against the ticket alone.
 */
// deriveAdaptiveThresholds + round2 are provided by background-utils.js.

async function handleGenerateTestCasesAgentic(data, tabId) {
  validateSettings(data.settings);
  const { ticketData, settings } = data;
  // F01: `data.appContext` is the content script's WRAPPER
  // ({appUrl, knowledgeGraph, hasContext, …}). Assigning it straight to
  // knowledgeGraph gave the verifier/coverage/BM25 an object with no top-level
  // pages/forms/apis — an empty entity index — while still being truthy, so the
  // "no crawl data" degradation never fired either. Normalize at the boundary.
  let knowledgeGraph = normalizeGenerationContext(data.appContext);

  // F21: collect degradations so the result can tell the user when the suite was
  // produced with reduced context (no crawl, failed enrichment, thin/stale
  // relevance…) instead of silently presenting it as complete.
  const degradations = [];
  if (!knowledgeGraph) {
    degradations.push('No crawl data for this app — tests could not be grounded against real UI and are flagged unverified. Crawl the app for higher-quality tests.');
  } else if (knowledgeGraph.stale) {
    degradations.push(`Crawl data is ${knowledgeGraph.stalenessDays}d old (> ${knowledgeGraph.staleAfterDays}d) — it may no longer match the live app. Consider re-crawling.`);
  } else if (knowledgeGraph.explorationGaps && knowledgeGraph.explorationGaps.some(g => g.kind === 'budget_cutoff')) {
    // F19: pages the crawl never reached are gaps in the evidence, not proof the
    // app lacks those screens.
    const gap = knowledgeGraph.explorationGaps.find(g => g.kind === 'budget_cutoff');
    degradations.push(`The crawl stopped before visiting ${gap.remaining} discovered page(s) — features on them could not be grounded.`);
  } else if (knowledgeGraph.noRelevantPages) {
    degradations.push('No crawled pages matched this ticket — grounding is effectively ticket-only. Verify the right app was crawled.');
  } else if (knowledgeGraph.lowRelevance) {
    degradations.push('Few crawled pages matched this ticket — grounding context is thin.');
  }

  // F24: an attachment that could not be read is missing evidence, and the user
  // must be told — a spec nobody could parse is not the same as no spec.
  for (const u of ((ticketData && ticketData.unreadableAttachments) || []).slice(0, 5)) {
    degradations.push(`Attachment "${u.fileName}" could not be read (${u.reason}) — any requirement it contains is missing from these tests.`);
  }

  // Enrich with external content (Confluence/Figma/Docs) when not pre-supplied.
  //
  // F09: this used to skip enrichment whenever `data.externalSources` was
  // truthy — but the content script sends the ANALYSIS step's source COUNTS
  // ({confluence: 3, figma: 1}), not the fetched content. So running Analysis
  // first made generation skip fetching every linked document and build the
  // suite from the bare ticket, while the UI still showed "Confluence ✅".
  // Only pre-supplied CONTENT may skip the fetch.
  let enrichedTicketData = ticketData;
  const preSuppliedContent = data.enrichedTicketData || data.externalContent;
  let fetchedExternal = data.externalContent || null;
  if (preSuppliedContent) {
    enrichedTicketData = data.enrichedTicketData || ticketData;
  }
  if (!preSuppliedContent) {
    try {
      const enrichResult = await enrichTicketWithExternalContent(ticketData, settings);
      enrichedTicketData = enrichResult.enrichedTicketData || ticketData;
      fetchedExternal = enrichResult.externalContent || null;
      // F25: a per-source failure must be visible, not averaged away into a
      // success. "3 Confluence pages" when two 403'd is a false claim of context.
      const failures = (enrichResult.externalSources && enrichResult.externalSources.failures) || [];
      for (const f of failures.slice(0, 6)) {
        degradations.push(`A linked ${f.type} source could not be read (${f.error || 'fetch failed'}) — any requirement it contains is missing from these tests.`);
      }
    } catch (e) {
      console.warn('[Agentic] external enrichment skipped:', e.message);
      degradations.push(`External content (Confluence/Figma/Docs) could not be fetched: ${e.message}. Tests were generated from the ticket alone.`);
    }
  }

  // No crawl, but a linked Figma design: ground against the design's screens,
  // buttons and fields instead of switching grounding off. Labelled "design",
  // never "verified" - the design is not the running app.
  if (!knowledgeGraph && self.FigmaDesignKG && fetchedExternal && Array.isArray(fetchedExternal.figma)) {
    const designKG = self.FigmaDesignKG.mergeDesignGraphs(fetchedExternal.figma.map(f => f && f.designGraph));
    if (designKG) {
      knowledgeGraph = designKG;
      const note = `No crawl of the app: tests were grounded against the linked Figma design (${designKG.pages.length} screen(s)). ` +
        'A match shows the design has the element, not that the built app does - crawl the app once it ships.';
      const i = degradations.findIndex(d => d.startsWith('No crawl data'));
      if (i >= 0) degradations[i] = note; else degradations.push(note);
    }
  }

  const progress = (event) => safeSendMessageToTab(tabId, { action: 'agentProgress', progress: agenticProgressView(event) });

  // Set expectations BEFORE the wait, not after it. A run that will take ten
  // minutes is fine; a run that takes ten minutes without saying so is not.
  try {
    const t = (typeof providerTuning === 'function') ? providerTuning(settings.llmProvider, settings) : null;
    if (t && typeof estimateRuntime === 'function') {
      safeSendMessageToTab(tabId, {
        action: 'agentProgress',
        progress: {
          agent: 'Planner', status: 'running', step: 0, total: t.maxSteps,
          description: `${t.maxSteps} planning steps — expected to take ${estimateRuntime(settings.llmProvider, t).label}`
        }
      });
    }
  } catch (_) {}

  // ── F14: optionally dedupe against the existing TestRail suite ──
  // When enabled + TestRail configured, pull existing case titles so the gate
  // rejects generated tests that merely duplicate what the team already has.
  let existingTests = [];
  if (settings.dedupeAgainstExistingSuite && settings.testrailUrl && settings.testrailApiKey && typeof TestRailIntegration !== 'undefined') {
    try {
      const tr = new TestRailIntegration(settings);
      if (typeof tr.getCases === 'function') {
        const res = await tr.getCases(settings.testrailSuiteId);
        // getCases now reports {cases, ok, error}; tolerate the old array shape.
        const cases = Array.isArray(res) ? res : (res && res.cases) || [];
        const ok = Array.isArray(res) ? true : !!(res && res.ok);
        existingTests = cases;
        console.log(`[Agentic] dedupe vs existing suite: loaded ${existingTests.length} TestRail case(s)`);
        // F14: a failed import must never read as "the team has no tests".
        // Uniqueness was only checked within this run — say so.
        if (!ok) {
          degradations.push(`The existing TestRail suite could not be fully loaded (${(res && res.error) || 'unknown error'}) — only ${existingTests.length} case(s) were compared against, so a generated test may duplicate one already in the suite.`);
        }
      }
    } catch (e) {
      console.warn('[Agentic] existing-suite fetch skipped:', e.message);
      degradations.push(`The existing TestRail suite could not be loaded (${e.message}) — uniqueness was checked only within this run.`);
    }
  } else if (settings.dedupeAgainstExistingSuite) {
    degradations.push('Deduplication against the existing suite is enabled but TestRail is not configured — uniqueness was checked only within this run.');
  }

  // ── Build the grounding + relevance + dedup gate ──
  // (crawl-mismatch reporting happens after the run — see `gate.crawlMismatch`)
  const verifier = new GroundedVerifier(knowledgeGraph, { ticketData: enrichedTicketData });
  const coverageMapper = knowledgeGraph ? new CoverageMapper(knowledgeGraph) : null;
  const adaptive = deriveAdaptiveThresholds(enrichedTicketData, knowledgeGraph, settings);
  console.log(`[Agentic] adaptive thresholds → dedup ${adaptive.dedupThreshold}, relevance ${adaptive.relevanceThreshold}`);
  const gate = new AcceptanceGate({
    knowledgeGraph,
    ticketData: enrichedTicketData,
    deps: { GroundedVerifier, SemanticDuplicateDetector },
    dedupThreshold: adaptive.dedupThreshold,
    relevanceThreshold: adaptive.relevanceThreshold,
    strictGrounding: settings.strictGrounding !== false,
    existingTests
  });

  // ── BM25 index over the knowledge graph (best-effort) ──
  let bm25 = null;
  try {
    if (knowledgeGraph && knowledgeGraph.appUrl) {
      const saved = await storageManager.loadBm25Index(knowledgeGraph.appUrl);
      if (saved) bm25 = BM25Index.deserialize(saved);
    }
    if (!bm25 && knowledgeGraph && knowledgeGraph.pages) bm25 = BM25Index.build(knowledgeGraph.pages);
  } catch (e) { console.warn('[Agentic] BM25 unavailable:', e.message); }

  // ── Dynamic distribution from ticket shape ──
  const enabledCategories = Array.isArray(settings.enabledCategories) ? settings.enabledCategories : undefined;
  const distribution = deriveDistribution(enrichedTicketData, { enabledCategories });
  console.log(`[Agentic] ticket shape: ${distribution.primary}; distribution:`, distribution.weights);

  // ── F11: Historical mining ──
  // When enabled and Jira is reachable, proactively pull related past bugs so
  // regression proposals are grounded in real history. This makes the previously
  // inert `enableHistoricalMining` toggle functional and feeds the previously-dead
  // "Mining historical bugs…" progress UI (content.js:historicalMiningProgress).
  let historicalIssues = [];
  const wRegression = (distribution.weights && (distribution.weights.Regression || distribution.weights.regression)) || 0;
  if (settings.enableHistoricalMining !== false && wRegression > 0) {
    const jiraSearch = makeAgenticJiraSearch(settings);
    if (jiraSearch) {
      try {
        safeSendMessageToTab(tabId, { action: 'historicalMiningProgress', progress: { phase: 'search', message: 'Mining historical bugs…' } });
        const jql = buildHistoricalJql(enrichedTicketData, settings);
        if (jql) historicalIssues = await jiraSearch(jql) || [];
        safeSendMessageToTab(tabId, { action: 'historicalMiningProgress', progress: { phase: 'done', found: historicalIssues.length } });
        console.log(`[Agentic] historical mining: ${historicalIssues.length} related issue(s) via JQL`);
      } catch (e) { console.warn('[Agentic] historical mining skipped:', e.message); }
    } else {
      console.log('[Agentic] historical mining enabled but Jira not configured (need base URL + email + API token)');
      degradations.push('Historical mining is enabled but Jira is not configured (base URL + email + API token) — regression tests were not grounded in past bugs.');
    }
  }

  // ── Tool registry wiring existing capabilities ──
  // NOTE: inspect_element grounds against the crawled knowledge graph, NOT the
  // active Jira tab (the tab is the ticket page, not the app under test).

  // F17: every run needs its own identity. Epic Mode drives several concurrent
  // children through the SAME tab, and the checkpoint key was `agentic_ckpt_<tabId>`
  // — so children overwrote each other's snapshot, and whichever finished first
  // deleted it in its `finally`. Interrupting one child could not recover it, and
  // a stale result could be applied to the wrong ticket.
  const runId = `${ticketData && ticketData.key ? ticketData.key : 'run'}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const abort = { cancelled: false, runId, controller: new AbortController() };
  activeAgenticAborts.add(abort);

  // F17: the tools call the provider with these settings, so the run's abort
  // signal must ride along — otherwise cancel only stops the NEXT planner step.
  // §14: evidence the user imported earlier is reused automatically — they
  // should not have to re-upload an API contract for every ticket.
  let storedImports = null;
  try {
    storedImports = (await chrome.storage.local.get('qatalyst_imported_evidence')).qatalyst_imported_evidence || null;
  } catch (_) {}

  // Match the planner to what this provider can realistically sustain.
  const tuning = (typeof providerTuning === 'function')
    ? providerTuning(settings.llmProvider, settings)
    : { maxSteps: Math.min(40, Math.ceil((settings.testCount || 30) * 0.9) + 6),
        maxNoProgress: 4, batchSize: 5, maxOutputTokens: settings.maxTokens, local: false, note: null };
  if (tuning.note) {
    console.log(`[Agentic] ${tuning.note}`);
    degradations.push(tuning.note);
  }

  const abortableSettings = {
    ...settings,
    // A local model does not need — and is slowed by — a 16k output allowance.
    maxTokens: tuning.maxOutputTokens || settings.maxTokens,
    _abortSignal: abort.controller.signal
  };

  const tools = new AgentToolRegistry({
    callAI,
    settings: abortableSettings,
    // F23: the user's reviewed analysis/scope, so their corrections and
    // exclusions actually shape the suite.
    reviewedContext: data.reviewedContext || null,
    // §14: imported evidence a crawl cannot provide — API contracts, the role and
    // state matrix, what changed in the PR, and which paths fail in production.
    importedEvidence: buildImportedEvidence(data.imports || storedImports),
    ticketData: enrichedTicketData,
    knowledgeGraph,
    bm25,
    coverageMapper,
    verifierIndex: verifier.index,
    getAcceptedTests: () => gate.getAccepted(),
    jiraSearch: makeAgenticJiraSearch(settings),
    confluenceFetch: makeAgenticConfluenceFetch(settings),
    // F5: give the registry the CoverageMapper class so run_coverage_check can
    // compute acceptance-criteria coverage even when there's no knowledge graph.
    CoverageMapper,
    // F11/F12: seed regression generation with the mined historical bugs.
    historicalIssues
  });

  // ── Budget: derive from the test-count slider ──
  const maxTests = clampInt(settings.testCount || settings.maxTestCases || 30, 8, 100);

  // Meaning-based coverage check, asked before the planner may stop as "complete".
  const coverageJudge = (settings.enableCoverageJudge !== false && self.CoverageJudge)
    ? (tests, criteria) => self.CoverageJudge.judgeCoverage(tests, criteria, enrichedTicketData, callAI, abortableSettings)
    : null;
  const planner = new PlannerAgent({
    callAI, settings: abortableSettings, tools, gate, coverageJudge,
    ticketData: enrichedTicketData,
    distribution,
    allocateCounts: (self.DynamicDistribution && self.DynamicDistribution.allocateCounts) || undefined,
    onProgress: progress,
    isCancelled: () => abort.cancelled,
    budget: {
      maxTests,
      // Provider-aware: the planner makes one SEQUENTIAL call per step, so a
      // step budget tuned for a hosted model (33 calls) becomes 30-60 minutes
      // against a local 7B model. Local providers get a short loop with larger
      // batches — the same suite in a handful of calls instead of dozens.
      maxSteps: tuning.maxSteps,
      coverageTarget: clampInt(settings.coverageTarget || 80, 40, 100),
      maxNoProgress: tuning.maxNoProgress,
      batchSize: tuning.batchSize
    }
  });

  // F15: keep the service worker alive from WITHIN the worker and checkpoint.
  // The old keepalive posted a message to the content TAB, which does nothing to
  // the SW idle timer — a stall between LLM chunks could kill the worker and lose
  // the whole in-memory suite. Calling an async extension API resets the 30s idle
  // timer, and we snapshot accepted tests to session storage each tick so a
  // termination leaves a recoverable partial suite instead of nothing.
  const ckptKey = `agentic_ckpt_${runId}`;
  const keepAlive = setInterval(() => {
    try { chrome.runtime.getPlatformInfo(() => {}); } catch (_) {}
    try {
      chrome.storage.session.set({ [ckptKey]: {
        runId, tabId,
        tests: gate.getAccepted(),
        ts: Date.now(),
        ticketKey: ticketData && ticketData.key,
        // F17: the ticket revision this suite was built from, so a resumed run
        // can tell whether the ticket has changed underneath it.
        ticketRevision: (ticketData && (ticketData.updated || ticketData.version)) || null,
        stage: 'planning'
      } });
    } catch (_) {}
    // Also nudge the content script so its UI heartbeat/lastSeen stays fresh.
    safeSendMessageToTab(tabId, { action: 'keepAlive', timestamp: Date.now() });
  }, 5000);
  let completedCleanly = false;
  try {
    const result = await planner.run();

    // Surface a real reason when nothing was produced, instead of a silent "0 tests".
    if (!result.testCases || result.testCases.length === 0) {
      const aiErr = result.stats?.aiError?.error;
      const rb = rejectionBreakdown(result.rejected);
      const rejectedCount = (result.rejected || []).length;
      let reason;
      if (aiErr) {
        reason = `Test generation failed: the AI provider returned an error (${aiErr}). Check that your selected model ("${settings.llmModel}") is valid for your ${settings.llmProvider} API key.`;
      } else if (rejectedCount > 0 && rb.grounding === rejectedCount) {
        // Telling someone to "crawl the app first" when they already have a
        // 70-page crawl is worse than useless. All-grounding rejection means the
        // crawl does not cover THIS ticket — commonly because the feature is not
        // built yet, or the crawl is of a different area.
        reason = `Generated ${rejectedCount} candidate test(s), but none could be matched against the crawled app. ` +
          `This usually means the crawl does not cover this feature — either it is not built yet, or a different part of the app was crawled. ` +
          `Re-crawl the screens this ticket is about, or turn off "Use Crawled Data in Test Generation" in Settings to generate specification-level tests from the ticket alone.`;
      } else if (rejectedCount > 0) {
        reason = `Generated ${rejectedCount} candidate test(s), but all were filtered out by the quality gate (${JSON.stringify(rb)}). Try lowering the relevance/dedup thresholds, or adding more detail to the ticket.`;
      } else {
        reason = 'No test cases were generated. The AI returned no parseable test cases — check the service-worker console (chrome://extensions → QAtalyst → service worker) for details.';
      }
      console.error('[Agentic] 0 tests produced:', reason, result.stats);
      return { error: reason };
    }

    // G2: adversarial assertion critic — flag tests whose expected_result is
    // inverted / unverifiable / contradicts the ticket. The gate proves entities
    // exist but not that assertions are correct; this closes that blind spot.
    // Non-destructive by default (flags `_assertionWarning`); strict mode drops.
    if (settings.enableAssertionCritic !== false && typeof critiqueAssertions === 'function') {
      try {
        const critique = await critiqueAssertions(result.testCases, enrichedTicketData, callAI, settings);
        if (critique.ran) {
          result.testCases = critique.tests;
          const v = critique.byVerdict || {};
          if (v.contradictory) {
            const verb = settings.assertionCriticStrict ? 'removed' : 'flagged for review';
            degradations.push(`${v.contradictory} test(s) assert an outcome that contradicts the ticket or their own steps — ${verb}.`);
          }
          if (v.unverifiable) degradations.push(`${v.unverifiable} test(s) have an expected result that is not observable — nothing concrete to assert.`);
          if (v.unknown) degradations.push(`${v.unknown} test(s) assert behaviour the ticket does not settle — confirm the expected result before executing.`);
          // F11: an incomplete verdict batch is missing information, not approval.
          if (critique.unjudged) degradations.push(`${critique.unjudged} test(s) received no verdict from the assertion critic — their expected results are unchecked.`);
        } else {
          // F11: critic unavailability must be VISIBLE. Returning the tests
          // unchanged after a failed critique returns UNCHECKED tests, and
          // silence there reads to the user as verification.
          degradations.push(`Expected results were not reviewed by the assertion critic (${critique.unavailableReason || 'unavailable'}) — inverted or unsupported outcomes may be present.`);
        }
      } catch (e) {
        console.warn('[Agentic] assertion critic skipped:', e.message);
        degradations.push(`Expected results were not reviewed by the assertion critic (${e.message}) — inverted or unsupported outcomes may be present.`);
      }
    }

    if (knowledgeGraph && knowledgeGraph.source === 'design') {
      for (const tc of result.testCases) if (tc._grounding === 'verified') tc._grounding = 'design';
    }

    // Deterministic backstop for the critic: status codes, exact messages and limits
    // the ticket never states (and the crawl never observed) are flagged per test.
    if (typeof flagInventedSpecifics === 'function') {
      const { flagged } = flagInventedSpecifics(result.testCases, enrichedTicketData, knowledgeGraph);
      if (flagged) {
        degradations.push(`${flagged} test(s) assert a status code, exact message or limit the ticket does not state — confirm or soften them before executing.`);
      }
    }

    // F08: coverage must describe the suite that is actually RETURNED. The
    // planner measured it before the critic ran, so in strict mode the reported
    // coverage still counted cases that had since been removed — and the
    // "produced nothing" check above was never repeated.
    result.coverage = recomputeFinalCoverage(result.testCases, {
      coverageMapper, ticketData: enrichedTicketData, previous: result.coverage
    });
    // Judge the FINAL suite (the critic may have changed it), so reported coverage
    // is meaning-based, not just word overlap.
    if (coverageJudge && result.coverage && result.coverage.acCoverage && result.coverage.acCoverage.applicable) {
      const ac = result.coverage.acCoverage;
      const judgement = await coverageJudge(result.testCases, (ac.details || []).map(d => d.text));
      if (judgement.ran) {
        result.coverage.acCoverage = self.CoverageJudge.applyJudgement(ac, judgement);
        const over = result.coverage.acCoverage.overruled || [];
        const lost = over.filter(o => o.wordBased === 'covered').length;
        if (lost) degradations.push(`${lost} acceptance criterion(s) shared words with a test but are not actually tested by it — counted as uncovered.`);
        const open = result.coverage.acCoverage.total - result.coverage.acCoverage.covered;
        if (open) degradations.push(`${open} of ${result.coverage.acCoverage.total} acceptance criteria are not genuinely covered by this suite (checked by meaning, not just wording).`);
      } else {
        degradations.push(`Acceptance-criteria coverage was checked by wording only (${judgement.unavailableReason}) — a criterion may be over- or under-credited.`);
      }
    }
    if (!result.testCases.length) {
      return { error: 'All generated test cases were removed by the assertion critic (their expected results could not be supported by the ticket). No suite was produced.' };
    }

    // A crawl that covers none of this ticket must be reported, or the user is
    // left wondering why every case says "unverified".
    if (gate.crawlMismatch) {
      degradations.push('None of the generated tests could be matched against the crawled app — the crawl does not appear to cover this feature (it may not be built yet, or a different area was crawled). These tests are specification-level and were NOT verified against the real UI.');
    }

    // Say which measure the Coverage Target was judged against — and say so
    // plainly when it could not be judged at all, rather than leaving a visible
    // setting silently inert.
    if (result.coverageBasis === 'requirements') {
      degradations.push(`Coverage Target (${result.coverageTarget}%) was measured against requirement coverage — there was no usable crawl to measure app features against.`);
    } else if (!result.coverageBasis) {
      degradations.push(`Coverage Target (${result.coverageTarget}%) could not be applied: neither app-feature nor requirement coverage was measurable for this ticket.`);
    }

    // §15.3: label each case honestly — specification_only / manual_ready /
    // automation_ready — instead of presenting everything as ready to run.
    if (typeof assessExecutability === 'function') {
      for (const tc of result.testCases) {
        const r = assessExecutability(tc);
        tc._executability = r.level;
        if (r.blockers.length) tc._executionBlockers = r.blockers;
        if (r.missing.length) tc._executionGaps = r.missing;
      }
      const notReady = result.testCases.filter(t => t._executability === 'specification_only').length;
      const needsSetup = result.testCases.filter(t => t._executability === 'manual_ready').length;
      if (notReady) degradations.push(`${notReady} case(s) cannot be executed as written — they are missing a role, starting state or test data.`);
      if (needsSetup) degradations.push(`${needsSetup} case(s) need a fixture or fault-injection hook before they can run.`);
    }

    // §15.2: record what this run was generated FROM, and compare it with the
    // previous run's manifest. Without this the module existed but nothing ever
    // stored or diffed one — a capability with no caller is the same defect as a
    // setting with no control.
    try {
      if (typeof buildManifest === 'function' && result.coverage?.requirements) {
        const manifestKey = `qatalyst_manifest_${ticketData && ticketData.key}`;
        const previous = (await chrome.storage.local.get(manifestKey))[manifestKey] || null;

        const manifest = buildManifest({
          ticketKey: ticketData && ticketData.key,
          ticketRevision: (ticketData && (ticketData.updated || ticketData.version)) || null,
          requirements: result.coverage.requirements,
          settings, model: settings.llmModel,
          testCases: result.testCases
        });

        if (previous && typeof diffManifests === 'function') {
          const diff = diffManifests(previous, manifest);
          result.requirementChanges = diff;
          if (diff.updateRequired.length) {
            degradations.push(`${diff.updateRequired.length} requirement(s) changed since the last run — the affected tests may need updating rather than replacing.`);
          }
          if (diff.newlyNeeded.length) {
            degradations.push(`${diff.newlyNeeded.length} requirement(s) are new since the last run.`);
          }
          if (diff.possiblyObsolete.length) {
            degradations.push(`${diff.possiblyObsolete.length} requirement(s) from the last run are gone — their tests may be obsolete, but review before deleting: they may still be protecting real behaviour.`);
          }
        }
        await chrome.storage.local.set({ [manifestKey]: manifest });
      }
    } catch (e) { console.warn('[Agentic] generation manifest skipped:', e.message); }

    // §15.1: apply what a reviewer already decided about these scenarios, so a
    // rejection does not have to be repeated on every run of the same ticket.
    try {
      if (typeof ReviewMemory === 'function' && ticketData && ticketData.key) {
        const project = String(ticketData.key).split('-')[0];
        const memory = await new ReviewMemory(chrome.storage.local, project).load();
        const applied = memory.apply(result.testCases, {
          requirementRevision: (ticketData.updated || ticketData.version) || null
        });
        result.testCases = applied.kept;
        if (applied.suppressed.length) {
          degradations.push(`${applied.suppressed.length} case(s) you previously marked irrelevant or duplicate were not proposed again.`);
        }
        if (applied.stale.length) {
          degradations.push(`${applied.stale.length} earlier review decision(s) are stale — the requirement changed underneath them and they need re-reviewing.`);
        }
        if (applied.locked.length) {
          degradations.push(`${applied.locked.length} case(s) you edited are locked and were preserved as you wrote them.`);
        }
      }
    } catch (e) { console.warn('[Agentic] review memory skipped:', e.message); }

    // §15.6: ask about the facts that DECIDE an expected result, rather than
    // inventing a specific the ticket never stated.
    if (typeof clarificationQuestions === 'function' && result.coverage?.requirements) {
      const questions = clarificationQuestions(result.coverage.requirements, result.testCases);
      if (questions.length) {
        result.clarifications = questions.slice(0, 8);
        result.unresolved = unresolvedLedger(result.coverage.requirements, questions);
        degradations.push(`${questions.length} question(s) must be answered before the expected results for some cases can be confirmed.`);
      }
    }

    // F21: if the AC coverage loop left criteria uncovered, say so explicitly.
    const acCov = result.coverage?.acCoverage;
    if (acCov && acCov.applicable && acCov.covered < acCov.total) {
      degradations.push(`${acCov.total - acCov.covered} of ${acCov.total} acceptance criteria are not clearly covered by a generated test — review the uncovered items.`);
    }

    // F12: an incomplete run must say so. A suite that stopped because it ran out
    // of budget or stalled is not the same artifact as one that covered every
    // known obligation, and both used to be returned identically.
    if (result.stopReason && result.stopReason !== 'complete') {
      const why = {
        budget_exhausted: `Generation stopped at the ${settings.testCount || 'configured'}-test budget — there may be uncovered obligations left.`,
        no_novel_scenarios: 'Generation stopped early: recent rounds produced no new distinct scenarios.',
        cancelled: 'Generation was cancelled — this suite is partial.',
        steps_exhausted: 'Generation used its full planning budget before covering every obligation.'
      }[result.stopReason];
      if (why) degradations.push(why);
    }

    const payload = {
      success: true,
      mode: 'agentic',
      testCases: result.testCases,
      stopReason: result.stopReason,
      coverage: result.coverage,
      acCoverage: acCov || null,
      // F07: predicate-level coverage + the requirement inventory the ids refer to.
      requirementCoverage: result.coverage?.requirementCoverage || null,
      requirements: result.coverage?.requirements || null,
      // §15.6: open questions and the obligations that depend on them.
      clarifications: result.clarifications || null,
      unresolved: result.unresolved || null,
      // §15.2: what changed since the last run of this ticket.
      requirementChanges: result.requirementChanges || null,
      degradations, // F21: reduced-context warnings for the UI to surface
      distribution: result.distribution,
      statistics: {
        total: result.testCases.length,
        ...result.stats,
        rejectedCount: (result.rejected || []).length,
        rejectionBreakdown: rejectionBreakdown(result.rejected)
      },
      rejected: (result.rejected || []).slice(0, 50).map(r => ({ title: r.test?.title, stage: r.stage, reason: r.reason })),
      // F15: surface why similar cases were kept apart, alongside why others were removed.
      preservedDistinctions: result.preservedDistinctions || []
    };
    completedCleanly = true;
    return payload;
  } finally {
    clearInterval(keepAlive);
    activeAgenticAborts.delete(abort);
    // F17: only a run that DELIVERED its suite clears its checkpoint. The old
    // `finally` deleted it on every exit — including the cancel and crash paths
    // the checkpoint existed for — so nothing was ever recoverable, and a
    // concurrent epic child could delete a sibling's snapshot on its way out.
    if (completedCleanly) {
      try { chrome.storage.session.remove(ckptKey); } catch (_) {}
    } else {
      try {
        chrome.storage.session.set({ [ckptKey]: {
          runId, tabId,
          tests: gate.getAccepted(),
          ts: Date.now(),
          ticketKey: ticketData && ticketData.key,
          stage: abort.cancelled ? 'cancelled' : 'interrupted',
          recoverable: gate.getAccepted().length > 0
        } });
      } catch (_) {}
    }
  }
}

/**
 * F17: read back any recoverable partial suites for a ticket. Checkpoints were
 * written on a timer and deleted on every exit, and nothing ever read them — the
 * whole mechanism was decorative. Scoped by ticket so one interrupted epic child
 * can be recovered without touching its siblings.
 */
async function listRecoverableRuns(ticketKey) {
  try {
    const all = await chrome.storage.session.get(null);
    return Object.entries(all || {})
      .filter(([k, v]) => k.startsWith('agentic_ckpt_') && v && v.recoverable &&
                          (!ticketKey || v.ticketKey === ticketKey))
      .map(([key, v]) => ({
        key, runId: v.runId, ticketKey: v.ticketKey, stage: v.stage,
        ts: v.ts, testCount: (v.tests || []).length, tests: v.tests || []
      }))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  } catch (e) {
    console.warn('[Agentic] checkpoint scan failed:', e.message);
    return [];
  }
}

/**
 * F08: recompute requirement + feature coverage from the FINAL retained suite,
 * after every removal, repair or edit. Coverage that describes a different set of
 * tests than the one being returned is worse than no coverage number at all —
 * it is a claim the output cannot support.
 *
 * Requirement coverage is measured from the ticket and therefore works with no
 * crawl graph; feature coverage is simply absent in that case, not "0%".
 */
function recomputeFinalCoverage(testCases, { coverageMapper, ticketData, previous } = {}) {
  const out = { ...(previous || {}) };
  const cases = Array.isArray(testCases) ? testCases : [];

  try {
    const acItems = typeof CoverageMapper.extractRequirementItems === 'function'
      ? CoverageMapper.extractRequirementItems(ticketData || {})
      : [];
    if (acItems.length) {
      out.acCoverage = CoverageMapper.mapAcceptanceCriteria(cases, acItems);

      // F07: predicate coverage alongside the lexical measure. This is the one
      // that requires the test to PERFORM the operation, as the right actor, and
      // assert the right modality — and that refuses to let one branch of a
      // compound AC stand in for the rest.
      if (typeof buildRequirements === 'function' &&
          typeof CoverageMapper.mapRequirementPredicates === 'function') {
        const reqs = buildRequirements(acItems, { ticketKey: ticketData && ticketData.key });
        out.requirements = reqs;
        out.requirementCoverage = CoverageMapper.mapRequirementPredicates(cases, reqs, {
          requirementModel: { mandatoryRequirements, groupCompound }
        });
        // F15: stamp each case with the requirement ids it covers, so an export
        // can cite provenance instead of shipping an unattributed test.
        for (const d of out.requirementCoverage.details || []) {
          if (!d.covered || !d.coveredBy) continue;
          const tc = cases.find(c => (c.id || c.title) === d.coveredBy);
          if (tc) (tc.requirementIds = tc.requirementIds || []).push(d.id);
        }
      }
    }
  } catch (e) { console.warn('[Agentic] AC coverage recompute skipped:', e.message); }

  try {
    if (coverageMapper) {
      const cov = coverageMapper.mapCoverage(cases);
      out.overall = cov.overall;
      out.forms = cov.forms; out.apis = cov.apis; out.buttons = cov.buttons; out.pages = cov.pages;
    }
  } catch (e) { console.warn('[Agentic] feature coverage recompute skipped:', e.message); }

  out.measuredFrom = cases.length;
  return out;
}

/**
 * §14: normalize whatever evidence files the user supplied into the obligations
 * a generator can act on.
 *
 * A crawl observes one session of one build. It cannot state an endpoint's
 * contract, enumerate the roles, describe states nobody clicked into, or say
 * which paths fail in production — so each of those previously became either an
 * invented assertion or a missing test. All of these are FILE imports: no
 * account connection is required for any of them (§14.1).
 */
function buildImportedEvidence(imports) {
  if (!imports || typeof imports !== 'object') return null;
  const out = { obligations: [], sources: [], failures: [] };

  const add = (label, result, obligationsFn) => {
    if (!result) return;
    if (!result.ok) {
      // An unreadable import is reported, never treated as "nothing to add".
      out.failures.push({ source: label, error: result.error });
      return;
    }
    out.sources.push({ source: label, evidence: result.evidence || null });
    if (obligationsFn) out.obligations.push(...obligationsFn(result));
  };

  try {
    if (imports.openapi) {
      add('OpenAPI contract', importOpenApi(imports.openapi),
        r => contractObligations(r.operations).map(o => ({ ...o, source: 'contract' })));
    }
    if (imports.projectProfile) {
      add('Role/state profile', importProjectProfile(imports.projectProfile), r => [
        ...permissionObligations(r.profile).map(o => ({ ...o, kind: 'permission', source: 'profile' })),
        ...stateObligations(r.profile).map(o => ({ ...o, kind: 'state_transition', source: 'profile' }))
      ]);
    }
    if (imports.changeContext) {
      const r = importChangeContext(imports.changeContext);
      add('Change context', r, () => impactedAreas(r.files).slice(0, 10)
        .map(a => ({ kind: 'impacted_area', area: a.area, churn: a.churn, source: 'diff',
                     note: `${a.area} changed (${a.files} file(s))${a.configChanged ? ', including configuration' : ''}` })));
    }
    if (imports.executionResults) {
      const r = importExecutionResults(imports.executionResults);
      add('Execution results', r, () => (r.results || []).filter(x => /fail/.test(x.status) || x.flaky)
        .slice(0, 20).map(x => ({ kind: x.flaky ? 'flaky_test' : 'failing_test', note: x.title, source: 'execution' })));
    }
    if (imports.runtimeErrors) {
      const r = importRuntimeErrors(imports.runtimeErrors);
      add('Runtime errors', r, () => (r.errors || []).slice(0, 15)
        // Observed failures suggest RISK; they never establish intended behaviour.
        .map(e => ({ kind: 'observed_failure', note: `${e.message}${e.operation ? ` (${e.operation})` : ''}`,
                     occurrences: e.count, source: 'runtime', trust: 'risk_only' })));
    }
  } catch (e) {
    out.failures.push({ source: 'imports', error: e.message });
  }

  return (out.obligations.length || out.sources.length || out.failures.length) ? out : null;
}

/** Map a planner event to the progress shape the content UI expects (agent/step/total/status/count). */
function agenticProgressView(event) {
  if (!event) return { agent: 'Planner', step: 0, total: 1, status: 'running' };
  const total = Number.isFinite(event.maxSteps) ? event.maxSteps : undefined;
  const step = Number.isFinite(event.step) ? event.step : undefined;
  const count = Number.isFinite(event.acceptedSoFar) ? event.acceptedSoFar
    : (Number.isFinite(event.accepted) ? event.accepted : undefined);
  const base = { agent: 'Planner', step, total, count };

  switch (event.phase) {
    case 'start':
      return { ...base, step: 0, status: 'running', description: 'Planning grounded test coverage…' };
    case 'step':
      return { ...base, status: 'running', description: `${event.tool}${event.thought ? ' — ' + event.thought : ''}` };
    case 'observation':
      return { ...base, status: 'running', description: `${event.tool}: ${event.summary || ''}` };
    case 'rescue':
      return { ...base, status: 'running', description: 'Generating targeted tests…' };
    case 'stop':
    case 'finish':
    case 'done':
      return { ...base, step: total || step, status: 'completed', count: count, description: event.reason || 'Generation complete' };
    case 'cancelled':
      return { ...base, status: 'error', error: 'Generation cancelled' };
    default:
      return { ...base, status: 'running', description: event.phase };
  }
}

// rejectionBreakdown is provided by background-utils.js.

// buildHistoricalJql (F11) is provided by background-utils.js.

/** Jira search adapter for the query_jira tool. Returns undefined if not available. */
function makeAgenticJiraSearch(settings) {
  if (typeof HistoricalMiningEngine === 'undefined') return undefined;
  // F10: the engine needs (settings, callAI, baseUrl). It was previously
  // constructed with only `settings`, so this.baseUrl was undefined and every
  // request went to "undefined/rest/api/..." — the tool could never fetch. Also
  // guard: without a base URL + API-token auth a background-worker Jira call
  // cannot succeed, so report "not configured" instead of failing per call.
  const baseUrl = String((settings && settings.jiraBaseUrl) || '').replace(/\/+$/, '');
  if (!baseUrl || !settings.jiraEmail || !settings.jiraApiToken) return undefined;
  return async (jql) => {
    try {
      const engine = new HistoricalMiningEngine(settings, callAI, baseUrl);
      if (typeof engine.searchJiraIssues === 'function') {
        const res = await engine.searchJiraIssues(jql);
        return Array.isArray(res) ? res : (res?.issues || []);
      }
    } catch (e) { console.warn('[Agentic] jira search failed:', e.message); }
    return [];
  };
}

/** Confluence fetch adapter for the fetch_confluence tool. Returns undefined if not configured. */
function makeAgenticConfluenceFetch(settings) {
  if (!settings || !settings.confluenceUrl || !settings.confluenceToken) return undefined;
  if (typeof IntegrationManager === 'undefined') return undefined;
  return async (url) => {
    try {
      const mgr = new IntegrationManager(settings);
      const content = await mgr.confluence.fetchPage(url);
      return typeof content === 'string' ? content : (content?.content || content?.text || '');
    } catch (e) { console.warn('[Agentic] confluence fetch failed:', e.message); return ''; }
  };
}

// clampInt is provided by background-utils.js.

// Handle regeneration with user review
async function handleRegenerateWithReview(data) {
  validateSettings(data.settings);

  // F03: regeneration must receive the ORIGINAL ticket and evidence, not only
  // the previous output text plus a review comment. Without them the regenerated
  // suite cannot be checked for relevance or grounding against anything.
  const { type, originalContent, userReview, settings, ticketData, appContext } = data;

  // Construct prompts based on type
  let systemMessage = '';
  let userMessage = '';

  if (type === 'analysis') {
    systemMessage = `You are a senior business analyst. You previously generated a requirement analysis, and the user has provided feedback to improve it.
Your task is to incorporate the user's feedback and generate an improved, more comprehensive version.`;

    userMessage = `Here is the original requirement analysis you generated:

---
${originalContent}
---

The user provided this feedback:
"${userReview}"

Please regenerate the requirement analysis incorporating the user's feedback. Maintain the same structured markdown format but enhance it based on the feedback provided.`;

  } else if (type === 'testScope') {
    systemMessage = `You are a test planning expert. You previously generated a test scope document, and the user has provided feedback to improve it.
Your task is to incorporate the user's feedback and generate an improved, more comprehensive version.`;

    userMessage = `Here is the original test scope you generated:

---
${originalContent}
---

The user provided this feedback:
"${userReview}"

Please regenerate the test scope incorporating the user's feedback. Maintain the same structured markdown format but enhance it based on the feedback provided.`;

  } else if (type === 'testCases') {
    systemMessage = `You are an expert QA engineer. You previously generated test cases, and the user has provided feedback to improve them.
Your task is to incorporate the user's feedback and generate improved test cases.

Generate test cases in this EXACT JSON format:
{
  "testCases": [
    {
      "id": "TC-XXX-001",
      "title": "Clear test case title",
      "category": "Positive|Negative|Edge|Integration",
      "priority": "P0|P1|P2|P3",
      "description": "What this test validates",
      "preconditions": "Setup required",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "expected_result": "Expected outcome",
      "test_data": "Required test data"
    }
  ]
}`;

    const ticketBlock = ticketData
      ? `\nThe test cases must stay grounded in this ticket:\n---\n${formatTicketContextForPrompt(ticketData)}\n---\n`
      : '';

    userMessage = `Here are the original test cases you generated:

---
${originalContent}
---
${ticketBlock}
The user provided this feedback:
"${userReview}"

Please regenerate the test cases incorporating the user's feedback. Return the result as a JSON object with a "testCases" array. You can add new test cases, modify existing ones, or remove inadequate ones based on the feedback. Do not introduce duplicates of cases that are already present, and do not assert behaviour the ticket does not support.`;
  } else {
    throw new Error(`Unknown regeneration type: ${type}`);
  }

  // Call AI with properly separated system/user messages
  const userContent = [
    { type: 'text', text: userMessage }
  ];
  const improvedResponse = await callAI(systemMessage, userContent, settings);

  // Handle test cases specially (need JSON parsing)
  if (type === 'testCases') {
    try {
      const jsonMatch = improvedResponse.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No valid JSON found in improved response');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const improvedTestCases = parsed.testCases;

      if (!Array.isArray(improvedTestCases)) {
        throw new Error('testCases is not an array');
      }

      // F03: an edit is not a licence to bypass the gate. Editing a previously
      // clean suite could otherwise reintroduce duplicates and unsupported cases.
      const final = await finalizeGenerated(improvedTestCases, { ticketData, appContext, settings });
      return {
        improvedTestCases: final.testCases,
        rejected: final.rejected,
        preservedDistinctions: final.preservedDistinctions,
        qualityStats: final.stats,
        degradations: final.degradations
      };
    } catch (error) {
      throw new Error(`Failed to parse improved test cases: ${error.message}`);
    }
  } else {
    // For analysis and test scope, return the improved content directly
    return { improvedContent: improvedResponse };
  }
}
