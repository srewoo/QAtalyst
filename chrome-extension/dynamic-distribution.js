/**
 * Dynamic Test Distribution
 *
 * Replaces the hardcoded 40/25/20/10/5 positive/negative/edge/regression/integration
 * split with a distribution derived from what the ticket is actually about.
 *
 * A security ticket should skew negative + security; a UI ticket should skew
 * accessibility + edge; a data-migration ticket should skew regression + integration.
 *
 * Two-stage:
 *   1. classifyTicket() — fast, deterministic keyword classifier (no LLM, always runs)
 *   2. deriveDistribution() — turns the classification into category weights that
 *      sum to 1.0, blended toward a sane baseline so no category is starved.
 *
 * An optional LLM refinement hook (refineWithLLM) can override the heuristic when a
 * callAI function is supplied, but the heuristic is the always-available default.
 *
 * Pure logic → unit-testable.
 * Version: 1.0.0
 */

const CATEGORIES = ['Positive', 'Negative', 'Edge', 'Regression', 'Integration', 'Security', 'Accessibility'];

// Baseline used as a floor so every relevant category gets some coverage.
const BASELINE = {
  Positive: 0.30, Negative: 0.22, Edge: 0.16, Regression: 0.10,
  Integration: 0.10, Security: 0.06, Accessibility: 0.06
};

// Signal keywords per ticket "shape". Matched against title+description+AC.
const SIGNALS = {
  security:   ['auth', 'login', 'password', 'token', 'oauth', 'permission', 'role', 'rbac', 'encrypt', 'jwt', 'session', 'csrf', 'xss', 'inject', 'vulnerab', 'sensitive', 'pii', 'gdpr', 'access control'],
  ui:         ['ui', 'screen', 'page', 'button', 'modal', 'layout', 'responsive', 'design', 'figma', 'css', 'style', 'theme', 'component', 'tooltip', 'dropdown', 'navigation', 'accessib', 'a11y', 'aria', 'keyboard', 'contrast', 'screen reader'],
  api:        ['api', 'endpoint', 'rest', 'graphql', 'request', 'response', 'payload', 'webhook', 'integration', 'service', 'microservice', 'rpc', 'http', 'status code'],
  data:       ['migration', 'database', 'schema', 'backfill', 'import', 'export', 'etl', 'sync', 'consistency', 'transaction', 'record', 'persist', 'query'],
  form:       ['form', 'field', 'input', 'validation', 'submit', 'required', 'dropdown', 'checkbox', 'upload', 'wizard', 'multi-step'],
  workflow:   ['workflow', 'flow', 'process', 'pipeline', 'state', 'transition', 'approval', 'lifecycle', 'orchestrat'],
  payment:    ['payment', 'checkout', 'billing', 'invoice', 'price', 'discount', 'refund', 'subscription', 'charge', 'cart', 'order']
};

// How each detected shape nudges category weights (additive boosts before normalization).
const SHAPE_BOOSTS = {
  security:  { Negative: 0.18, Security: 0.22, Edge: 0.06 },
  ui:        { Accessibility: 0.18, Edge: 0.10, Positive: 0.04 },
  api:       { Integration: 0.20, Negative: 0.10, Edge: 0.06 },
  data:      { Regression: 0.18, Integration: 0.12, Edge: 0.06 },
  form:      { Negative: 0.16, Edge: 0.12, Positive: 0.04 },
  workflow:  { Regression: 0.12, Integration: 0.10, Positive: 0.06 },
  payment:   { Negative: 0.16, Security: 0.10, Integration: 0.08, Edge: 0.06 }
};

/**
 * Classify a ticket into weighted shapes.
 * @returns {{shapes: Array<{shape:string, score:number, hits:string[]}>, primary:string}}
 */
function classifyTicket(ticketData) {
  const text = ticketText(ticketData);
  const shapes = [];
  for (const [shape, keywords] of Object.entries(SIGNALS)) {
    const hits = keywords.filter(k => text.includes(k));
    if (hits.length > 0) shapes.push({ shape, score: hits.length, hits });
  }
  shapes.sort((a, b) => b.score - a.score);
  return { shapes, primary: shapes[0]?.shape || 'generic' };
}

/**
 * Derive normalized category weights for a ticket.
 * @param {object} ticketData
 * @param {object} [opts]
 * @param {string[]} [opts.enabledCategories] restrict to these categories
 * @returns {{weights: object, primary: string, shapes: object[]}}
 */
function deriveDistribution(ticketData, opts = {}) {
  const { shapes, primary } = classifyTicket(ticketData);

  // Start from baseline.
  const weights = { ...BASELINE };

  // Apply boosts from every detected shape, scaled by its relative strength.
  const totalScore = shapes.reduce((s, x) => s + x.score, 0) || 1;
  for (const { shape, score } of shapes) {
    const boosts = SHAPE_BOOSTS[shape];
    if (!boosts) continue;
    const strength = score / totalScore; // 0..1
    for (const [cat, boost] of Object.entries(boosts)) {
      weights[cat] = (weights[cat] || 0) + boost * (0.5 + strength);
    }
  }

  // Restrict to enabled categories if provided.
  let cats = CATEGORIES;
  if (Array.isArray(opts.enabledCategories) && opts.enabledCategories.length) {
    cats = CATEGORIES.filter(c => opts.enabledCategories.includes(c));
  }
  // Drop categories that have no baseline+boost presence (shouldn't happen, but safe).
  const filtered = {};
  cats.forEach(c => { filtered[c] = weights[c] || 0; });

  return { weights: normalize(filtered), primary, shapes };
}

/**
 * Convert normalized weights into integer test counts that sum exactly to total.
 * Uses largest-remainder rounding so the counts add up.
 */
function allocateCounts(weights, total) {
  const entries = Object.entries(weights);
  const raw = entries.map(([cat, w]) => ({ cat, exact: w * total }));
  const counts = {};
  let allocated = 0;
  raw.forEach(r => { counts[r.cat] = Math.floor(r.exact); allocated += counts[r.cat]; });
  // distribute the remainder to the largest fractional parts
  let remainder = total - allocated;
  raw.sort((a, b) => (b.exact - Math.floor(b.exact)) - (a.exact - Math.floor(a.exact)));
  for (let i = 0; i < raw.length && remainder > 0; i++) { counts[raw[i].cat]++; remainder--; }
  return counts;
}

/**
 * Optional: ask the LLM to refine the distribution. Falls back to heuristic on any error.
 * @param {object} ticketData
 * @param {Function} callAI - async (systemMessage, userContent[], settings) => string
 * @param {object} settings
 */
async function refineWithLLM(ticketData, callAI, settings) {
  const heuristic = deriveDistribution(ticketData);
  if (typeof callAI !== 'function') return heuristic;
  try {
    const system = 'You are a senior QA strategist. Given a ticket, output ONLY a JSON object mapping test categories to weights that sum to 1.0. Categories: ' + CATEGORIES.join(', ') + '. Weight categories by where the real risk for THIS ticket lies.';
    const user = `Ticket:\n${ticketText(ticketData, false).slice(0, 4000)}\n\nHeuristic suggestion: ${JSON.stringify(heuristic.weights)}\n\nReturn refined JSON only.`;
    const resp = await callAI(system, [{ type: 'text', text: user }], settings);
    const parsed = JSON.parse((resp.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    const cleaned = {};
    CATEGORIES.forEach(c => { if (typeof parsed[c] === 'number' && parsed[c] >= 0) cleaned[c] = parsed[c]; });
    if (Object.keys(cleaned).length >= 3) {
      return { weights: normalize(cleaned), primary: heuristic.primary, shapes: heuristic.shapes, refinedBy: 'llm' };
    }
  } catch (_) { /* fall back */ }
  return heuristic;
}

// ───────────────────────── helpers ─────────────────────────

function ticketText(ticketData, lower = true) {
  if (!ticketData) return '';
  const parts = [
    ticketData.summary, ticketData.title, ticketData.description,
    ticketData.acceptanceCriteria, ticketData.acceptance_criteria,
    Array.isArray(ticketData.labels) ? ticketData.labels.join(' ') : ticketData.labels,
    ticketData.issueType, ticketData.components
  ];
  const text = parts.filter(Boolean).map(p => Array.isArray(p) ? p.join(' ') : String(p)).join('\n');
  return lower ? text.toLowerCase() : text;
}

function normalize(weights) {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights;
  const out = {};
  for (const [k, v] of Object.entries(weights)) out[k] = Math.round((v / sum) * 1000) / 1000;
  // fix rounding drift onto the largest bucket
  const drift = 1 - Object.values(out).reduce((a, b) => a + b, 0);
  if (Math.abs(drift) > 0.0001) {
    const top = Object.keys(out).reduce((a, b) => out[a] >= out[b] ? a : b);
    out[top] = Math.round((out[top] + drift) * 1000) / 1000;
  }
  return out;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { classifyTicket, deriveDistribution, allocateCounts, refineWithLLM, CATEGORIES, BASELINE };
}
if (typeof self !== 'undefined') {
  self.DynamicDistribution = { classifyTicket, deriveDistribution, allocateCounts, refineWithLLM, CATEGORIES };
}
