/**
 * background-utils.js (v13.3) — pure logic helpers extracted from the
 * background service worker so they're independently unit-testable (and to start
 * shrinking the 4k-line background.js). No I/O; depends only on APP_CONFIG and
 * securityManager globals at call time.
 *
 * IIFE-wrapped so it adds no global bindings beyond the functions it exports
 * (the worker loads everything into one scope via importScripts).
 */
(function () {

// Validate settings before API calls. Throws with a joined message on any error.
function validateSettings(settings) {
  const errors = [];
  if (!settings.llmProvider) errors.push(APP_CONFIG.ERRORS.NO_PROVIDER);
  if (!settings.llmModel) errors.push(APP_CONFIG.ERRORS.NO_MODEL);

  if (settings.llmProvider === 'bedrock') {
    if (!settings.bedrockAccessKeyId || settings.bedrockAccessKeyId.trim() === '') {
      errors.push('AWS Access Key ID is required for Bedrock. Please configure it in extension settings.');
    } else if (!securityManager.validateApiKey(settings.bedrockAccessKeyId, 'bedrock')) {
      errors.push('Invalid AWS Access Key ID format. It should start with AKIA or ASIA and be 20 characters.');
    }
    if (!settings.bedrockSecretKey || settings.bedrockSecretKey.trim() === '') {
      errors.push('AWS Secret Access Key is required for Bedrock. Please configure it in extension settings.');
    }
  } else {
    if (!settings.apiKey || settings.apiKey.trim() === '') {
      errors.push(APP_CONFIG.ERRORS.NO_API_KEY);
    } else if (!securityManager.validateApiKey(settings.apiKey, settings.llmProvider)) {
      errors.push(`Invalid API key format for ${settings.llmProvider}. Please check your API key.`);
    }
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));
}

function round2(n) { return Math.round(n * 100) / 100; }

function clampInt(n, lo, hi) {
  n = parseInt(n, 10);
  if (!Number.isFinite(n)) n = lo;
  return Math.max(lo, Math.min(hi, n));
}

function rejectionBreakdown(rejected) {
  const out = {};
  for (const r of rejected || []) out[r.stage] = (out[r.stage] || 0) + 1;
  return out;
}

/**
 * Derive per-run dedup/relevance thresholds (no global constant for every
 * ticket). Explicit settings win; otherwise scale by KG richness + ticket size.
 */
function deriveAdaptiveThresholds(ticketData, knowledgeGraph, settings) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const kgEntities = knowledgeGraph
    ? ((knowledgeGraph.forms || []).length +
       (knowledgeGraph.apis || []).length +
       (knowledgeGraph.features || []).length)
    : 0;
  const ticketWords = String([
    ticketData?.summary, ticketData?.title, ticketData?.description,
    ticketData?.acceptanceCriteria, ticketData?.acceptance_criteria,
  ].filter(Boolean).join(' ')).split(/\s+/).filter(Boolean).length;

  let relevance = 0.25;
  if (kgEntities === 0) relevance += 0.05;
  else if (kgEntities >= 40) relevance -= 0.03;
  if (ticketWords < 40) relevance -= 0.05;
  else if (ticketWords > 300) relevance += 0.02;
  relevance = clamp(relevance, 0.15, 0.35);

  let dedup = 0.68;
  const budget = parseInt(settings?.testCount, 10);
  if (Number.isFinite(budget) && budget <= 25) dedup -= 0.04;
  dedup = clamp(dedup, 0.6, 0.78);

  return {
    dedupThreshold: Number.isFinite(settings?.dedupThreshold) ? settings.dedupThreshold : round2(dedup),
    relevanceThreshold: Number.isFinite(settings?.relevanceThreshold) ? settings.relevanceThreshold : round2(relevance),
  };
}

const api = { validateSettings, round2, clampInt, rejectionBreakdown, deriveAdaptiveThresholds };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') Object.assign(self, api);
})();
