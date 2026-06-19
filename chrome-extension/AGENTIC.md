# Agentic Test Generation (v13+)

QAtalyst's test generation engine is a **planner-driven, grounded,
coverage-feedback loop**. As of **v13.2 it is the only engine** — the old fixed
`Phase1→2→3` multi-agent pipeline and the "genetic algorithm" were removed, along
with `agents.js`, `evolution.js`, `duplicate-detector.js`, `test-validator.js` and
`enhancements.js`. It runs whenever the Multi-Agent System is on.

## Why

The retired classic pipeline ran a fixed sequence of agents with a hardcoded
40/25/20/10/5 test distribution and a fake GA, and had no defense against duplicate
or hallucinated ("irrelevant") tests. The agentic engine fixes all of that.

## How it works

```
content.js  ── generateTestCasesAgentic ──▶  background.js: handleGenerateTestCasesAgentic
                                                     │
                                                     ▼
   deriveDistribution(ticket)         ┌────────────  PlannerAgent (agent-loop.js)  ───────────┐
   (dynamic-distribution.js)          │  observe → decide → act, until coverage / budget      │
                                      │                                                       │
            AgentToolRegistry ◀───────┤  tools: bm25_search · inspect_element ·               │
            (agent-tools.js)          │         run_coverage_check · propose_tests ·          │
                                      │         query_jira · fetch_confluence · crawl_route   │
                                      │                                                       │
            every proposed test ──────▶  AcceptanceGate (acceptance-gate.js)                  │
                                      │     1. GROUNDING  (grounded-verifier.js)              │
                                      │     2. RELEVANCE  (ticket+KG vocabulary)              │
                                      │     3. DEDUP      (semantic-duplicate-detector.js)    │
                                      │  → reject / repair / accept                           │
                                      └───────────────────────────────────────────────────────┘
                                                     │
                                            CoverageMapper (coverage-mapper.js)
                                            re-measures coverage each round → feeds next decision
```

### The guarantee: no duplicate / no irrelevant tests

Every test a tool proposes must pass **all three** checks in `AcceptanceGate`
before it counts:

1. **Grounding** — `GroundedVerifier` indexes every real entity in the crawled
   knowledge graph (form fields, button labels, selectors, API endpoints, routes)
   and verifies each concrete reference in the test exists. Near-misses are
   auto-repaired to the real entity; tests referencing things that don't exist are
   rejected. (When there is no crawl data, grounding is "not applicable" and the
   other two checks still apply.)
2. **Relevance** — a weighted vocabulary built from the ticket (high weight) and
   the app's real entities (medium weight) scores each test; off-topic tests are
   rejected.
3. **Dedup** — each candidate is compared (semantic + lexical similarity) against
   every already-accepted test; near-duplicates are rejected. The gate is
   stateful, so the planner can call `propose_tests` repeatedly without ever
   re-introducing a duplicate.

### Coverage feedback loop

`run_coverage_check` maps accepted tests against the knowledge graph and returns
coverage % + the biggest untested forms/APIs/buttons. The planner aims the next
`propose_tests` at those gaps. The loop stops when the coverage target is reached,
the test budget is hit, or no further progress is made.

### Dynamic distribution

`deriveDistribution` classifies the ticket (security / UI / API / data / form /
workflow / payment) and skews the category mix accordingly (e.g. a security ticket
→ more Negative + Security; a UI ticket → more Accessibility) instead of a fixed
split.

### Reliability

The planner **never depends on the LLM behaving**. If the model returns malformed
output or picks an unknown tool, a deterministic controller takes the next sensible
action (refresh coverage, then propose tests for the most under-target category).
This guarantees forward progress and makes the whole loop unit-testable.

## Files

| File | Responsibility |
|------|----------------|
| `agent-loop.js` | `PlannerAgent` — the observe→decide→act loop, stop conditions, deterministic fallback |
| `agent-tools.js` | `AgentToolRegistry` — wraps crawler/BM25/coverage/integrations/LLM as callable tools |
| `acceptance-gate.js` | `AcceptanceGate` — grounding + relevance + dedup choke-point (stateful) |
| `grounded-verifier.js` | `GroundedVerifier` — verifies/repairs tests against real app entities |
| `dynamic-distribution.js` | ticket-shape classifier → category weights & counts |

Tests: `tests/groundedVerifier.test.js`, `tests/acceptanceGate.test.js`,
`tests/dynamicDistribution.test.js`, `tests/agentLoop.test.js`.

## Settings

- `enableMultiAgent` — turns the engine on (the agentic engine is the only engine).
- `coverageTarget` (default `80`) — stop generating once this % of real app features is covered.
- `dedupThreshold` (default `0.68`), `relevanceThreshold` (default `0.25`) — gate tuning.
  When unset, both are derived per-run by `deriveAdaptiveThresholds` (background.js)
  from KG richness + ticket length.
- `testCount` — upper bound on the test budget.

## Behaviour validation (v13.2)

`grounded-verifier.js` also flags hallucinated **behaviours** — a test asserting
`auto-sync`, `email notification`, `real-time/polling`, `webhook`, `scheduled job`,
`retry`, etc. with no supporting API in the crawl. Conservative by default (only
when the crawl has ≥3 APIs, so a thin crawl can't false-reject); warnings are
attached as `_behaviorWarnings` and apply a grounding-score penalty. Set
`strictBehaviors` to hard-reject instead of warn.

## Not yet wired (graceful no-ops)

`query_jira`, `fetch_confluence`, and `crawl_route` tools degrade cleanly when their
integration/tab context isn't available. `crawl_route` (live deeper crawling
mid-loop) and emitting executable Playwright specs are tracked as follow-ups.
`inspect_element` grounds against the knowledge graph, **not** the active Jira tab
(the tab is the ticket page, not the app under test).
