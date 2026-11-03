# QAtalyst

**Grounded, coverage-checked test cases for Jira tickets.** A Chrome extension (Manifest V3, v14.0). For coding agents, the same method ships as a portable skill.

Paste-a-ticket-into-a-chatbot test generation has three failure modes: it invents UI that doesn't exist, it repeats itself, and it quietly skips acceptance criteria. QAtalyst is built around stopping all three. It crawls the app under test, and every generated test must reference real fields, buttons, routes and APIs, be about *this* ticket, and be new — or it is repaired or rejected. Generation doesn't stop while an acceptance criterion is still uncovered.

No backend: the extension calls your LLM provider directly with your own key.

---

## How it works

```
Jira ticket ──► context ──► planner loop ──► acceptance gate ──► coverage check ──┐
 (panel)         │            (one LLM        grounding · relevance   app features   │
                 │             picks tools)   · de-duplication        + ACs          │
                 │                 ▲                                                  │
   crawl of the app under test     └──────────── gaps steer the next round ──────────┘
   (knowledge graph of forms,
    fields, buttons, routes, APIs)
```

1. **Context.** The Jira panel reads the ticket: description, acceptance criteria, comments, linked issues and attachments (PDF and DOCX text is extracted). It follows links to Confluence, Figma and Google Docs, and can mine past Jira bugs for regression tests.
2. **Knowledge graph.** The crawler walks the app under test and records its pages, forms, fields, buttons, routes and the API calls it makes. Several crawls can be combined, and the most relevant ones are picked per ticket.
3. **Planner loop** (`agent-loop.js`). One LLM repeatedly chooses a tool — `bm25_search`, `inspect_element`, `run_coverage_check`, `propose_tests`, `query_jira`, `fetch_confluence`, `finish`. If the model returns malformed output, a deterministic controller takes the next sensible step, so a run always progresses.
4. **Acceptance gate** (`acceptance-gate.js`). Each proposed test must pass:
   - **Grounding** — every field, control, API or page a test names must exist in the crawl (or, with no crawl, in the linked Figma design). Near-misses are repaired to the real label; a test naming anything the app, design and ticket don't have is rejected and the model rewrites it (*Strict grounding*, on by default). Vague tests with no concrete reference are rejected. Asserted behaviours with no supporting API (e.g. "sends an email") are flagged.
   - **Relevance** — scored against the ticket's and the app's vocabulary.
   - **De-duplication** — semantic + lexical comparison with every accepted test.
5. **Coverage.** Accepted tests are mapped to app features *and* acceptance criteria every round; gaps aim the next proposal. Before the loop may stop as complete, a coverage judge checks each criterion by meaning, not wording, and reopens any that a test only shares words with. The loop ends at the coverage target, the test budget, or when further tests would be redundant.
6. **Checks on the result.** An LLM critic reviews every expected result against the ticket, and a deterministic check flags status codes, exact messages and limits the ticket never states. Coverage is recomputed on the suite actually returned.

The category mix (positive, negative, edge, regression, integration, security, accessibility) is derived from the ticket's shape rather than a fixed split. Full design: [`chrome-extension/AGENTIC.md`](chrome-extension/AGENTIC.md).

> Without a crawl, grounding is skipped and tests are specification-level only. Crawl the screens the ticket touches for the real benefit.

## Features

| Area | What you get |
|------|--------------|
| Generation | Requirement analysis → test scope → test cases, streamed live with a stop button; 20–100 tests per ticket |
| Epics | Select stories under an epic. Each story is loaded and generated exactly as it would be on its own (full issue, acceptance-criteria field, attachments, web links, crawl context matched to the story, full test budget), then the suite is consolidated across stories and cross-story workflows are proposed. Cost is about one single-story run per story |
| Every ticket type | Obligations come from the acceptance criteria when present; otherwise **bugs** must show the expected result after the reproduction steps and that the actual result no longer happens, **tasks / spikes** use their requirement sentences, and **sub-tasks** inherit the parent story's criteria they touch. Parent stories and epics are passed as background context |
| Review | Accept/reject tests with a reason; decisions are remembered and steer regeneration |
| Quality | Per-test grounding status (`verified` / `design` / `specification` / `unverified`), strict grounding, meaning-based acceptance-criteria coverage, contradiction, behaviour and invented-specifics warnings, context-quality assessment |
| Verification | **Export Playwright** — a runnable spec using the crawl's stable selectors; **Verify in app** — replays the tests in a background tab with your session and reports passed / failed (with the failing step) / partial / not automatable |
| No crawl yet | Tests are grounded against the linked Figma design's screens, buttons and fields, and labelled `design` |
| Providers | OpenAI, Anthropic Claude, Google Gemini, AWS Bedrock, Ollama (local); model list fetched live from the provider |
| Sources | Confluence, Figma, Google Docs, Jira attachments, past Jira bugs |
| Export | Jira comment, CSV, clipboard, TestRail, Zephyr Scale, Zephyr Squad, Xray, Qmetry; optional de-dup against an existing TestRail suite |

## Quick start

1. **Install.** `chrome://extensions` → enable *Developer mode* → *Load unpacked* → select `chrome-extension/`.
2. **Configure.** Toolbar icon → *Advanced Settings* → **API Settings**: pick a provider and model, paste your key, *Save*. Add Jira email + API token under **Test Case Settings → Historical Mining** if you want regression mining and attachment reading.
3. **Crawl the app under test.** Open the app in a tab (log in first if needed), click the QAtalyst icon → *Start Full Application Crawl*. Chrome asks once for access to that site — see [Permissions](#permissions). A progress window tracks the crawl.
4. **Generate.** Open a Jira ticket. In the QAtalyst panel: *Analyse Requirements* → *Generate Test Scope* → *Generate Test Cases*. Progress shows each planner step and the running count of accepted tests.
5. **Review and export.** Filter, accept/reject, then export to Jira, CSV or your test-management tool.

## Settings

| Tab | Contents |
|-----|----------|
| API Settings | Provider, model, key, temperature, max tokens, streaming, agentic engine on/off |
| Test Case Settings | Test budget, coverage target, category weights, historical mining, existing-suite de-dup |
| Crawler Settings | Depth, page limits, blacklists, authenticated crawling, parameterised-URL detection |
| Integrations | TestRail, Zephyr, Xray, Qmetry, Figma, Google; custom field mapping; connection tests |
| Help & Docs | In-product guide |

Gate tuning (`dedupThreshold`, `relevanceThreshold`) is derived per run from crawl richness and ticket length unless set explicitly. All settings and their consumers are declared in [`chrome-extension/settings-schema.js`](chrome-extension/settings-schema.js); see also [`chrome-extension/CONFIG.md`](chrome-extension/CONFIG.md).

## Permissions

At install, QAtalyst gets access only to the fixed services it talks to: Jira Cloud (`*.atlassian.net`, `*.jira.com`), the LLM providers, Figma, Google, AWS (Bedrock), Xray, Qmetry and Zephyr Scale cloud, and `localhost` (Ollama).

Everything user-specific is an **optional** permission requested per site, at the moment you use it:

- **The app under test** — when you start a crawl. Access is requested for the whole site (`*.example.com`) so API calls to sibling subdomains are captured.
- **Self-hosted or per-tenant services** (a self-hosted Jira, TestRail, Xray/Zephyr Squad on your Jira, Qmetry, a remote Ollama) — when you click *Save* or *Test connection* in Advanced Settings.

Granted sites can be reviewed and removed at `chrome://extensions` → QAtalyst → *Details* → *Site access*. Implementation: [`chrome-extension/host-permissions.js`](chrome-extension/host-permissions.js).

API keys are stored in `chrome.storage` with AES-GCM. By default the key is derived from an extension-local identifier, which protects against casual inspection but not against someone with your browser profile. For real protection, set a **passphrase** (Advanced Settings → API Settings): keys are then sealed with a key derived from it (PBKDF2, 600k iterations), and the passphrase is kept only in memory until the browser closes, so you unlock once per browser session.

**Verify in app** clicks and types in the app with your logged-in session, so it asks first, runs only on sites you have granted, and skips any test whose steps delete, pay, send or transfer. Use a test environment where you can.

## Coding agents (Claude Code, Codex, Cursor, Antigravity)

The method is also available as the agent skill [`ticket-to-test-cases`](https://github.com/srewoo/agent-skills/tree/main/plugins/qa-toolkit/skills/ticket-to-test-cases) in `srewoo/agent-skills`. The agent writes the tests, and a Python script (standard library only) checks each one against a crawl of the app, the ticket, and the tests already accepted, and tracks acceptance-criteria coverage. It works with any tracker and any browser automation.

```
/plugin marketplace add srewoo/agent-skills
/plugin install qa-toolkit@agent-skills
```

That skill has its own, simpler matching engine and is maintained there. It is not a copy of this extension's code.

## Project layout

```
chrome-extension/
  manifest.json            MV3 manifest
  background.js            service worker: message routing, generation orchestration
  agent-loop.js            planner loop + deterministic fallback
  agent-tools.js           tool registry the planner calls
  acceptance-gate.js       grounding · relevance · de-dup choke-point
  grounded-verifier.js     matches test references to crawled entities, repairs near-misses
  coverage-mapper.js       feature + acceptance-criteria coverage
  requirement-model.js     turns ACs into countable obligations
  semantic-duplicate-detector.js
  dynamic-distribution.js  ticket shape → category mix
  llm-client.js, model-registry.js   provider calls and live model lists
  crawler*.js, dom-extractor.js, network-monitor.js, spa-route-discoverer.js
  content.js               Jira panel UI
  content-ticket.js        reading the ticket (REST + DOM fallbacks, attachments)
  content-crawler.js       in-page side of the crawler (injected into the app under test)
  content-{utils,format,filters,export}.js, epic-mode.js
  integrations.js          CircuitBreaker + IntegrationManager
  integrations-docs.js     Confluence, Figma, Google Docs
  integrations-testrail.js TestRail
  integrations-testmgmt.js Zephyr Scale/Squad, Xray, Qmetry
  host-permissions.js      runtime site-access requests
  assertion-specifics.js   flags invented status codes / messages / limits
  coverage-judge.js        meaning-based acceptance-criteria coverage
  figma-design-kg.js       knowledge graph from a Figma design (no-crawl grounding)
  test-steps.js            step parser shared by the exporter and the runner
  playwright-export.js     generated suite → Playwright spec
  test-runner.js           "Verify in app"
  key-vault.js             optional passphrase protection for API keys
  crawler-{page,urls,graph,tuning}.js   WebAppCrawler methods, split from crawler.js
  bg-{connections,context,generation,agentic,export}.js   worker handlers, split from background.js
  popup.*, options.*       toolbar popup (crawler) and Advanced Settings
  tests/                   Vitest unit + sandbox tests
  e2e/                     Playwright flows against the loaded extension
  eval/                    offline quality evals and fixtures
build.sh                   packages chrome-extension/ for the Web Store
```

## Development

```bash
npm install
npm test                 # Vitest: unit + sandboxed service-worker/options/popup tests
npm run test:e2e         # Playwright against the unpacked extension
npm run eval:all         # offline generation-quality evals
npm run eval:loop        # drives the live planner loop on fixtures (coverage reached before it stops)
npm run test:export      # real Chromium, no credentials: exported spec vs a local app, Verify-in-app
                         # inside the real extension, and the whole panel flow with a fake local model
npm run build            # → qatalyst-v<version>-webstore.zip (verifies every loaded file ships)
```

Content scripts and the service worker are plain scripts that share one global scope per context, not ES modules. Files that are split out follow one pattern: an IIFE that publishes an explicit API on the global and also sets `module.exports` for tests. Load order lives in `manifest.json` (content scripts) and the `importScripts` calls at the top of `background.js`. `tests/scriptLoading.test.js` loads both lists in browser order.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Panel doesn't appear | Make sure you're on a ticket page (`/browse/KEY-123`), then refresh |
| "Does not have access to …" when crawling | Start the crawl from the toolbar popup and allow site access |
| Integration test connection fails | Click *Test connection* again and allow site access when Chrome asks; check the URL |
| Tests marked unverified / no grounding | No relevant crawl for this ticket — crawl the screens it touches |
| "QAtalyst is locked" | Your keys are passphrase-protected: open Advanced Settings and unlock |
| Verify in app: "no access to …" | Crawl that site from the toolbar popup (and allow site access) first |
| "Acceptance criteria 0/0" | The ticket states no requirement QAtalyst can recognise (no AC, no expected result, no "must/should" sentence). Add acceptance criteria, or for a bug its Expected / Actual result |
| Many tests rejected on grounding | The crawl may be missing the screens this ticket touches: re-crawl them, or turn off *Strict grounding* in Test Case Settings |
| Generation seems stuck | The panel warns when a run makes no progress for a few minutes; *Stop* and retry. If the service worker died, reload the extension at `chrome://extensions` |
| Rate limits | Requests back off and retry automatically; lower the test budget or switch provider |

## License

Proprietary — internal use only.
