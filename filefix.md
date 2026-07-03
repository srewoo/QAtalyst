# QAtalyst — Change Log (filefix.md)

> Complete record of all changes implemented on branch `feature/qafix-implementation`
> (July 2026), fixing the backlog in [qaFix.md](qaFix.md) plus three bugs found during
> live testing against RE-11256.
>
> **State:** all changes are staged in the working tree; commit with `/smart-commit`
> (direct `git commit` is blocked by a plugin hook).
> **Tests:** 724 passing across 44 files (+48 added during this work).

---

## Summary by file

| File | Changes |
|------|---------|
| `chrome-extension/content.js` | F2 ticket fetch (issuelinks/parent/labels/AC), F4 doc enrichment, F15 keepalive comment, F18 ticket-matched app selection |
| `chrome-extension/content-utils.js` | F3 ADF rewrite (tables/lists/tasks/panels/mentions), F31 stop words, live-bug-3 object stringify in Jira formatter |
| `chrome-extension/agent-tools.js` | F1/F2/F4 ticketContext, F5 AC coverage, F9 JSON mode + temp, F12/F13 regression context, F20 injection fencing, F22 crawl_route removal, F23 retry, F39 covered-titles cap, live-bugs 1–3 normalization |
| `chrome-extension/agent-loop.js` | F5 AC stop condition + AC-directed proposals, F22 prompt cleanup |
| `chrome-extension/acceptance-gate.js` | F14 existing-suite dedup seam, F39 relevance comment fix |
| `chrome-extension/grounded-verifier.js` | F6 vague-test rejection, F7 boundary/param-aware matching, F25 thin-crawl behaviour check |
| `chrome-extension/coverage-mapper.js` | F8 both-KG-shapes inventory, F5 AC parse/map statics, F39 dead-loop removal |
| `chrome-extension/background.js` | F5/F11/F12/F14/F15/F16/F20/F21/F26/F28 (see below) |
| `chrome-extension/background-utils.js` | F1 formatTicketContextForPrompt, F8 countKgEntities, F11 buildHistoricalJql |
| `chrome-extension/llm-client.js` | F9 temperature ?? fix + Claude JSON instr, F24 all-provider token preflight, F34 rate-limiter wiring |
| `chrome-extension/json-parser.js` | F16 markdown-fence stripping |
| `chrome-extension/crawler-handlers.js` | F17 no relevance padding, F19 staleness computation |
| `chrome-extension/historical-mining.js` | (unchanged — fixed at the call site, F10) |
| `chrome-extension/integrations.js` | F14 TestRailIntegration.getCases() |
| `chrome-extension/content-export.js` | F27 provenance columns, live-bug-1 toDisplayString |
| `chrome-extension/prompts.js` | F26 Regression category + distribution |
| `chrome-extension/security.js` | F30 decrypt-failure returns null, F39 safe URL schemes |
| `chrome-extension/rate-limiter.js` | F34 self-export + header update |
| `chrome-extension/knowledge-graph-merger.js` | F33 field-preserving merges |
| `chrome-extension/graph-filter.js`, `bm25.js` | F31 stop-word fixes |
| `chrome-extension/dom-extractor.js`, `network-monitor.js` | F32 truncation caps |
| `chrome-extension/manifest.json` | F29 web_accessible_resources narrowed |
| `README.md` | F36 rewritten to match v13 reality |
| `package.json` | F36 keywords, F37 version-derived zip name |
| `qaFix.md` | Implementation-status header added |
| `chrome-extension/tests/*` | +48 tests incl. new `coverageMapper.test.js`, `agentTools.test.js` |

---

## Sprint 1 — P0 grounding inputs (F1–F4)

### F1 — Comment text now reaches the LLM
- **Was:** every prompt emitted only `**Comments:** N comments`; all discussion/clarifications discarded.
- **Now:** `agent-tools.js → ticketContext()` and `background-utils.js → formatTicketContextForPrompt()` inject the last ~15 comment bodies (author + text), budgeted to ~1800 chars so a huge thread can't starve other sections. Used by both the agentic and non-agentic prompts.

### F2 — Issue links, parent/epic, labels, components, priority, AC custom field
- **Was:** `content.js fetchTicketDataFromAPI` read only summary/description/type/comments/attachments; `issuelinks` only on the epic path.
- **Now:** the fetch uses `?expand=names` and maps `issueLinks` (with direction + status), `parent`, `labels`, `components`, `priority`, `status`, `fixVersions`. Acceptance criteria in a custom field are auto-detected by display name (`/accept(ance)? criteria/i`) or via the new `jiraAcFieldId` setting, extracted through the ADF parser.

### F3 — ADF extraction preserves structure
- **Was:** `extractTextFromADF` flattened tables into run-on blobs, dropped list markers, task-checkbox state, panels, mentions, status lozenges.
- **Now:** full rewrite in `content-utils.js` rendering to markdown — tables → pipe rows with header separator, bullet/ordered lists → `-`/`1.` markers, `taskItem` → `- [x]` / `- [ ]`, panels → `> [!WARNING]`-style blocks, mentions → `@name`, status → `[TEXT]`, dates → ISO, `hardBreak` → newline. All prior behaviours (links, smart-cards, code fences, media URLs) preserved. +6 tests.

### F4 — Document attachments used in generation
- **Was:** PDF/doc text was extracted only on the analyze path; the generation path never even fetched documents.
- **Now:** `content.js handleTestCases` calls `enrichTicketAttachments()` (images for vision models + document text always); both prompt builders inject `documentAttachments` text (budgeted ~2500 chars).

---

## Sprint 2 — P0 gates, coverage & accuracy (F5–F9)

### F5 — Acceptance-criteria → test coverage mapping (the core intent gap)
- **Was:** AC was only relevance vocabulary + truncated prompt text; nothing verified each criterion was exercised.
- **Now:**
  - `CoverageMapper.parseAcceptanceCriteria(text)` splits AC into discrete items (strips bullets/numbers/checkboxes/table edges, drops headers/separators).
  - `CoverageMapper.mapAcceptanceCriteria(tests, items)` maps each accepted test to AC items via significant-token recall (threshold 0.4); returns covered/uncovered/percentage/coveredBy.
  - `agent-tools.js run_coverage_check` reports `acCoverage` (works even with **no** knowledge graph) and emits uncovered AC as top-priority `criticalGaps`.
  - `agent-loop.js`: the planner **won't stop** at the feature-coverage target while an AC is uncovered and budget remains; the deterministic controller proposes tests focused on the top uncovered criterion.
  - `background.js` returns `acCoverage` in the agentic result.

### F6 — Vague tests can no longer bypass grounding
- **Was:** a test referencing zero concrete entities got verdict `grounded`, score 0.6.
- **Now:** with a knowledge graph present, zero-reference tests are **rejected** ("too vague to ground", score ≤0.2) so the planner regenerates something specific. `requireGroundingRefs: false` restores lenient mode; the no-KG path is unchanged (`not_applicable`/unverified).

### F7 — Boundary/param-aware entity matching
- **Was:** `routeExists`/`apiExists`/`selectorMatchesKnown` used bidirectional `includes` — `/` grounded anything; `/api/users/1` grounded against any `/api/*`.
- **Now:** paths are normalized (lowercase, query/hash/trailing-slash stripped); matching is exact, same-arity with `{id}`/`:id`/numeric wildcards (`segMatch`), or segment-boundary ancestor (`isSegmentPrefix`); root `/` matches only itself. Selectors match on compound-selector token boundaries.

### F8 — Coverage no longer blind to one KG shape
- **Was:** `buildFeatureInventory` read only the aggregated shape; on raw page-array crawls the inventory was empty → coverage 0%, feedback loop dead. `deriveAdaptiveThresholds` had the same bug (rich crawl misread as "no crawl").
- **Now:** the inventory ingests both shapes with per-entity de-duplication; `countKgEntities` (background-utils) counts both shapes. New `coverageMapper.test.js` asserts both shapes produce identical inventories.

### F9 — JSON mode actually on; sane temperature
- **Was:** `_jsonMode` had zero writers (OpenAI/Gemini JSON mode dead); `temperature || 0.7` silently bumped an explicit 0; generation ran at 0.7.
- **Now:** `propose_tests` calls with `{_jsonMode: true, temperature: 0.2}` and requests an **object** root `{"tests":[…]}` (json_object mode requires an object); `parseTestArray` unwraps it. Claude gets a raw-JSON-only system instruction (no response_format API). `?? 0.7` fixes the zero-temperature bug across providers.

---

## Sprint 3 — P1 regression (F10–F14, F26, F27)

### F10 — HistoricalMiningEngine baseUrl bug
- **Was:** constructed with only `settings` → every request went to `undefined/rest/api/...`.
- **Now:** `makeAgenticJiraSearch` passes `(settings, callAI, baseUrl)` and returns `undefined` (tool reports "not configured") when base URL/email/token are missing.

### F11 — Historical mining actually wired in
- **Was:** the whole mine pipeline was dead code; the `enableHistoricalMining` toggle gated nothing; the "Mining historical bugs…" progress UI had no sender.
- **Now:** when the toggle is on and regression is in the distribution, the agentic handler builds a JQL (`buildHistoricalJql`: same project + `issuetype = Bug` + top summary terms, excluding the ticket, newest first), fetches related past bugs upfront, emits `historicalMiningProgress`, and seeds them into the tool registry.

### F12 — Real regression prompt with injected history
- **Was:** "Regression" was just an interpolated label on the generic prompt; `query_jira` results never reached generation.
- **Now:** `propose_tests(Regression)` adds a regression brief (protect existing/adjacent behaviour, backward compatibility), injects `HISTORICAL BUGS` (from the upfront seed or a prior `query_jira`, cached as `_historicalIssues`), and requires `historicalReference` + `rationale` fields per test.

### F13 — Change-impact v1
- New `impactedAreas()`: components + labels + linked-issue summaries + crawled routes matching ticket keywords → `LIKELY IMPACTED AREAS` in the regression prompt.

### F14 — Dedupe against the existing suite
- `AcceptanceGate` accepts `existingTests`: generated tests that near-duplicate an existing case are rejected as "already covered by existing suite case …" (counted in `stats.duplicateExisting`); existing cases are never emitted. New `TestRailIntegration.getCases()` fetches project cases (paginated + legacy responses); fetched behind the `dedupeAgainstExistingSuite` setting.

### F26 — Regression in the non-agentic path
- `prompts.js testCasesSystem` and the live inline stream prompt now include the Regression category with a 35/30/20/10/5 distribution.

### F27 — Export provenance
- CSV gains `Source`, `Historical Reference`, `Rationale` columns (source inferred from category/`_proposedFor`); clipboard prints Historical Reference/Rationale when present.

---

## Sprint 4 — P1 robustness & trust (F15–F21)

### F15 — Real MV3 keepalive + checkpointing
- **Was:** "keepAlive" messaged the content tab (does nothing to the SW idle timer); an idle-kill mid-run lost the whole in-memory suite.
- **Now:** the interval calls `chrome.runtime.getPlatformInfo()` **inside the worker** (resets the idle timer, no new permission) and checkpoints `gate.getAccepted()` to `chrome.storage.session` every 5s (`agentic_ckpt_<tabId>`), cleared in `finally`.

### F16 — Truncated streams salvaged
- **Was:** greedy regex + `JSON.parse` threw on any truncation, discarding every streamed test.
- **Now:** the finale parses via `parseRobustJSON` (which also now strips ```json fences), then direct `extractCompleteObjectsFromArray` salvage; partial suites return with `truncated: true` instead of an error. Errors only when nothing is recoverable.

### F17 — No more relevance padding
- **Was:** <30 BM25 matches were padded to 30 with arbitrary pages (26 pages of noise for a 4-page-relevant ticket).
- **Now:** only score>0 pages are sent; `relevantPageCount`/`lowRelevance`/`noRelevantPages` flags feed the degradation report.

### F18 — Ticket-matched knowledge graph selection
- **Was:** always the largest graph — wrong-app grounding with multiple crawls.
- **Now:** `extractAppContext` uses `findMatchingApp` (domain/base-domain/product-name mentions in the ticket; sensible merged/largest fallbacks).

### F19 — Knowledge-graph staleness
- `handleLoadEmbeddings` computes `stalenessDays`/`stale` against a configurable TTL (`kgStalenessDays`, default 14) and returns them with the graph.

### F20 — Prompt-injection hardening
- Ticket/app content is fenced in `<ticket_data>`/`<app_data>` blocks in both generation paths, with an explicit system rule: fenced content is untrusted DATA, never instructions.

### F21 — Degradations surfaced
- The agentic result includes `degradations[]`: no crawl data, stale crawl, thin/no relevant pages, failed external enrichment, mining enabled-but-unconfigured, and uncovered acceptance criteria — so a reduced-context run is never presented as complete.

---

## P2/P3 — Trust, security, cleanup (F22–F39)

- **F22:** `crawl_route` removed from the tool catalogue and planner strategy prompt (it was never wired and always returned `{available:false}`; the planner wasted steps on it). Dispatch kept as a graceful no-op.
- **F23:** `propose_tests` retries once with a corrective "not valid JSON" instruction on empty parse before surrendering the step.
- **F24:** token preflight in `callAI` for **all** providers (was OpenAI-only): estimates system+user tokens, hard-errors on overflow with actionable guidance.
- **F25:** behaviour-hallucination check threshold `minApisForBehaviorCheck` 3→1 (runs on thin crawls; still no-ops at zero APIs).
- **F28:** `sender.tab?.id` guards on all four tab-bound message handlers (popup/options messages get a clean error instead of an uncaught TypeError).
- **F29:** `config.json` removed from `web_accessible_resources`; icon matches scoped to Atlassian/Jira (dropped `<all_urls>` there). The `<all_urls>` **host permission is deliberately kept** — the crawler needs it for arbitrary apps under test.
- **F30:** decrypt failure now returns `null` (caller should prompt for re-entry) instead of returning the mangled ciphertext as if it were the API key.
- **F31:** QA-domain terms (`error/issue/bug/problem/fix/test/user`) removed from the stop-word lists in `graph-filter.js`, `bm25.js`, and `content-utils.js` — a bug ticket about a "user error" no longer loses its most discriminating retrieval terms.
- **F32:** per-page text cap 2000→5000 chars; network response-body cap 4000→8000 (single clip, matching the in-page limit).
- **F33:** `knowledge-graph-merger` spreads both pages/graphs before applying merged fields — textContent, forms, buttons, errorPatterns, routes, etc. survive merges.
- **F34:** the shared per-provider rate limiter is wired into `callAI` (`getRateLimiter(provider).execute(...)`) so agentic bursts respect provider RPM. `retry-helper.js` and `cache-manager.js` remain unused-in-place (documented; deletion touches the manifest for marginal benefit).
- **F35:** satisfied via F26 (legacy prompt aligned with Regression).
- **F36:** README rewritten — the false "8-Agent Multi-Agent System" / "genetic algorithm" / `agents.js`/`evolution.js` claims replaced with the real v13 agentic-planner architecture and an honest v13 note; `package.json` keywords updated (`multi-agent`/`genetic-algorithm` → `agentic`/`test-generation`/`bedrock`).
- **F37:** zip script derives the artifact name from `$npm_package_version` (was hard-coded v13.3).
- **F38 (partial):** ~48 tests added (AC coverage, KG shapes, grounding bypass/matching, existing-suite dedup, JQL builder, exports, fence-stripping/truncation salvage, propose_tests normalization). The vitest coverage-config exclusion of `background.js`/`content.js` is left as-is (affects only the reported %).
- **F39 (mostly done):** dead covered-marking loop removed from `mapCoverage`; covered-titles context 25→60 (shorter clip); `data:`/exotic URL schemes stripped from `href`/`src` in the sanitizer (http/https/mailto/tel allowlist); mislabeled relevance-formula comment corrected. **Left as documented polish:** timeout-constant reconcile, `activeCrawler` mutex, BM25 double-build cache, dual-escape consolidation.

---

## Live-testing fixes (found generating tests for RE-11256)

### LT1 — `[object Object]` in exports
- **Symptom:** every test printed `Test Data: [object Object]`.
- **Cause:** the LLM returned `test_data` as an object; export builders string-interpolated it.
- **Fix:** `toDisplayString()` in `content-export.js` (JSON-stringify objects, join arrays) applied to CSV + clipboard fields; same helper in `content-utils.js` Jira-comment formatter; `propose_tests` also coerces non-string `test_data` to JSON at the source and the prompt now demands a plain string.

### LT2 — Freeform category labels broke tracking
- **Symptom:** categories like "UI - Chat Session List", "Error Handling" instead of canonical labels.
- **Cause:** `t.category = t.category || category` let the LLM's label win; the planner's deficit counting and the UI filters only understand canonical labels.
- **Fix:** the requested canonical category is now **force-set**; the LLM's own label is preserved as `subcategory`; the prompt states the exact required category string.

### LT3 — `Description: N/A` on every test
- **Cause:** the agentic schema never requested a `description` field.
- **Fix:** schema now includes `description` ("1-2 sentence 'Verify that…' summary"); post-processing synthesizes one from the title if still missing (without doubling the "Verify that" prefix).

**Observed result on re-run (RE-11256):** clean test data with concrete values, canonical categories, real descriptions, no duplicate tests, and genuinely boundary-focused Edge cases (exactly-20 pagination, 120-char names, page-2 loader failure). Assessed 8/10, up from 7/10.

---

## Next-phase gaps — IMPLEMENTED (G1–G4)

Implemented after the two RE-11256 test runs. 745 tests passing (+21 since the LT fixes). All staged.

### G1 — Prose-scenario harvesting ✅
- **Was:** requirement coverage only saw the dedicated AC field, so prose "Case 1:/Case 2:" scenarios and grooming notes never became coverage items (the RE-11256 migration scenario went untested twice).
- **Now:** `CoverageMapper.extractRequirementItems(ticketData)` + `_harvestDescriptionRequirements()` harvest AC bullets, "Case N:" scenarios, grooming notes, "Mobile UI" bullets and inline "Good to have:" from the description (ignoring Story/Description prose); `agent-tools.acItems()` uses it, feeding the whole coverage/stop-condition/degradation machinery. +5 tests.

### G2 — Adversarial assertion critic ✅
- **Was:** the gate verifies referenced entities exist, but nothing checks the expected_result is correct — an inverted assertion (run 1's TC7) passed.
- **Now:** new `assertion-critic.js` (`critiqueAssertions`) runs one cheap, batched, skeptical pass over the accepted suite after `planner.run()`, flagging inverted/unverifiable/wrong expected results. Conservative (defaults "ok"), non-destructive by default (`_assertionWarning`; strict-drop opt-in), never breaks generation (any failure returns the suite unchanged), flagged count surfaced in `degradations[]`. Wired in `background.js` (importScripts after json-parser). +8 tests.

### G3 — Golden-set eval harness ✅
- **Was:** no measured score for the generator; prompt/gate changes were unmeasured.
- **Now:** `eval/scorer.js` scores a generated suite against a fixture using the SHIPPED logic (CoverageMapper/GroundedVerifier/SemanticDuplicateDetector) — requirement coverage, grounding validity, duplicate rate, precision/recall vs an expert suite, weighted 0–100. `eval/run-eval.js` (`npm run eval`) prints a table and exits non-zero on threshold failure (CI gate). `eval/fixtures/re-11256.json` scores **88 / PASS** and its uncovered-requirements output pinpoints the migration/mobile-event gaps. LLM-free (scores a suite that's in the fixture). +6 tests.

### G4 — Semantic AC matching ✅ (mechanism); rest deferred
- **Now:** `mapAcceptanceCriteria` gains an OR-path — an AC counts as covered by token recall **or** embedding cosine (injectable `opts.embeddings`), catching differently-worded coverage. Proven by test with a capable stub embedder.
- **Honest limitation:** the bundled offline feature-hashed embeddings are too weak (genuinely-related pairs reach only ~0.4 cosine, below an unrelated pair at 0.42), so no safe threshold helps without false coverage. The default `embThreshold` 0.62 keeps it **inert until a real embedding model is injected** — at which point it activates with no further code change. Documented in-code.

## Still deferred (require external infra / large refactor — not code-only)

- **Code-level change impact from linked MRs** — needs Jira dev-panel MR/commit data (external API, not unit-testable in CI); today's impact analysis is keyword-level (F13).
- **Execution-feedback learning** — pull TestRail execution outcomes back to promote/penalize test patterns as few-shot exemplars; needs persistent cross-run state + live TestRail data.
- **Parallel category generation** — the acceptance gate is intentionally stateful/serial at admission; concurrent proposal calls are a latency win but a non-trivial refactor with correctness risk. Deferred deliberately.
- **A stronger (API-based) embedding model** to make G4's semantic matching actually fire.
