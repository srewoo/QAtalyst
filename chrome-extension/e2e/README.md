# QAtalyst E2E (Playwright)

These are **true end-to-end** tests: they load the built extension into a real
Chromium and drive the QAtalyst panel on a live Jira ticket. Unlike the Vitest
suite (which mocks chrome/fetch/DOM), E2E needs real external state, so it is
**not part of `npm test`** and cannot run in a headless CI sandbox without setup.

## Prerequisites (why these can't run in the unit sandbox)

1. A reachable **Jira instance** + a ticket URL you can open.
2. A valid **LLM API key** (OpenAI/Claude/Gemini) — these spend real tokens.
3. The **unpacked extension** loaded into a persistent Chromium context
   (extensions require `--load-extension`, which only works headed / with a
   persistent context).

## Setup

```bash
npm i -D @playwright/test
npx playwright install chromium
cp e2e/.env.example e2e/.env   # fill in JIRA_TICKET_URL, LLM_API_KEY, etc.
npm run test:e2e
```

## Specs

- **jira-panel.smoke.spec.js** — minimal happy path: panel injects, Analyse
  Requirements produces output, Generate Test Cases yields a non-empty list.
- **jira-panel.flows.spec.js** — fuller stateful-flow coverage:
  - panel injection + the three primary action buttons present
  - panel lifecycle (close button hides/removes the panel)
  - Analyse Requirements -> non-empty analysis output
  - Generate Test Scope -> non-empty scope output
  - Generate Test Cases -> non-empty, **de-duplicated** list (unique ids)
  - **category** filter narrows the visible subset (every card is that category;
    reset restores the full list)
  - **priority** filter narrows the visible subset (every card is that priority)
  - **search** filter narrows the visible subset
  - export / Add-to-Jira controls present + enabled
- **helpers.js** — shared launch + env-gate + `openPanel` wiring.

Until a target is configured the specs are `test.skip(...)` so they document
intent without failing, and they cannot run in this sandbox (no live Jira / LLM /
headed browser).

## data-testids added to content.js for E2E

These stable hooks were added (attributes only — behaviour preserved):
`analysis-output`, `test-scope-output`, `test-cases-container`, `test-stats`,
`filter-all` / `filter-Positive` / `filter-Negative` / `filter-Edge` /
`filter-Regression` / `filter-Integration`, `test-search`, `priority-filter`,
`filter-status`, `add-to-jira-btn`, `export-csv-btn`, `copy-clipboard-btn`.
(The action buttons `analyze-requirements-btn`, `generate-test-scope-btn`,
`generate-test-cases-btn`, `settings-btn`, `help-btn` and per-card
`test-case-<idx>` already existed.)
