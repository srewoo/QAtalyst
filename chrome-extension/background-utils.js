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

/**
 * Count real app entities across BOTH knowledge-graph shapes (F8). The old
 * inline count read only the aggregated top-level .forms/.apis/.features, so a
 * rich raw-array crawl (pages:[{features,apis}]) registered as kgEntities=0 and
 * was misjudged as "no crawl", nudging the relevance threshold the wrong way.
 */
function countKgEntities(kg) {
  if (!kg) return 0;
  let n = (kg.forms || []).length + (kg.apis || []).length + (kg.features || []).length;
  const countPage = (p) => {
    if (!p || typeof p !== 'object') return;
    if (Array.isArray(p.features)) n += p.features.length;
    if (Array.isArray(p.apis)) n += p.apis.length;
    if (Array.isArray(p.forms)) n += p.forms.length;
  };
  if (Array.isArray(kg.pages)) kg.pages.forEach(countPage);
  else if (kg.pages && typeof kg.pages === 'object') Object.keys(kg.pages).forEach(u => countPage(kg.pages[u]));
  return n;
}

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
  const kgEntities = countKgEntities(knowledgeGraph);
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

/**
 * Assemble the ticket context block injected into non-agentic generation
 * prompts. Surfaces the fields that were previously fetched-but-discarded:
 * comment discussion (F1), linked issues + parent/labels/components metadata
 * (F2), acceptance criteria, and extracted document text (F4). Each section is
 * independently clipped so one large field can't crowd out the others.
 */
function formatTicketContextForPrompt(t) {
  t = t || {};
  const parts = [];
  if (t.summary) parts.push(`**Summary:** ${t.summary}`);
  if (t.issueType) parts.push(`**Type:** ${t.issueType}`);
  if (t.priority) parts.push(`**Priority:** ${t.priority}`);
  if (Array.isArray(t.labels) && t.labels.length) parts.push(`**Labels:** ${t.labels.join(', ')}`);
  if (Array.isArray(t.components) && t.components.length) parts.push(`**Components:** ${t.components.join(', ')}`);
  if (t.parent && (t.parent.summary || t.parent.key)) {
    parts.push(`**Parent/Epic:** ${t.parent.key || ''}${t.parent.summary ? ' — ' + t.parent.summary : ''}`.trim());
  }
  parts.push(`**Description:** ${t.description || 'N/A'}`);

  const ac = t.acceptanceCriteria || t.acceptance_criteria;
  if (ac) parts.push(`**Acceptance Criteria:**\n${String(ac).slice(0, 2000)}`);

  const links = Array.isArray(t.issueLinks) ? t.issueLinks : [];
  if (links.length) {
    parts.push('**Linked Issues:**\n' + links.slice(0, 12)
      .map(l => `- ${l.type || 'relates to'} ${l.key || ''}: ${l.summary || ''}${l.status ? ` [${l.status}]` : ''}`)
      .join('\n'));
  }

  const comments = Array.isArray(t.comments) ? t.comments : [];
  if (comments.length) {
    const BUDGET = 1800; let used = 0; const lines = [];
    for (const c of comments.slice(-15)) {
      const body = String(c.text || '').replace(/\s+/g, ' ').trim();
      if (!body) continue;
      const line = `- ${c.author || 'user'}: ${body}`.slice(0, 400);
      if (used + line.length > BUDGET) break;
      used += line.length; lines.push(line);
    }
    if (lines.length) parts.push('**Comments (discussion / clarifications):**\n' + lines.join('\n'));
  }

  const docs = Array.isArray(t.documentAttachments) ? t.documentAttachments
    : (Array.isArray(t.documents) ? t.documents : []);
  if (docs.length) {
    const BUDGET = 2500; let used = 0; const chunks = [];
    for (const d of docs) {
      const txt = String(d.text || d.content || d.extractedText || '').replace(/\s+/g, ' ').trim();
      if (!txt) continue;
      const clip = txt.slice(0, Math.max(0, BUDGET - used));
      if (!clip) break;
      used += clip.length;
      chunks.push(`[${d.fileName || d.name || 'doc'}] ${clip}`);
      if (used >= BUDGET) break;
    }
    if (chunks.length) parts.push('**Attached Documents (extracted text):**\n' + chunks.join('\n'));
  }

  return parts.filter(Boolean).join('\n');
}

/**
 * Build a JQL that finds past bugs related to this ticket (F11): same project,
 * issuetype Bug, matching the ticket's most significant summary terms, excluding
 * the ticket itself, newest first. Returns '' when there's nothing to search on.
 */
function buildHistoricalJql(ticketData) {
  const key = ticketData && ticketData.key ? String(ticketData.key) : '';
  const project = key.includes('-') ? key.split('-')[0] : '';
  const words = String((ticketData && (ticketData.summary || ticketData.title)) || '').match(/[A-Za-z]{4,}/g) || [];
  const stop = new Set(['this','that','with','from','when','then','have','test','tests','should','into','page','user','users','able','support','feature','issue','error']);
  const terms = [...new Set(words.map(w => w.toLowerCase()).filter(w => !stop.has(w)))].slice(0, 4);
  if (!terms.length) return '';
  const textClause = terms.map(t => `text ~ "${t.replace(/["\\]/g, '')}"`).join(' OR ');
  const parts = [];
  if (project) parts.push(`project = "${project}"`);
  parts.push('issuetype = Bug');
  parts.push(`(${textClause})`);
  if (key) parts.push(`key != "${key}"`);
  return parts.join(' AND ') + ' ORDER BY created DESC';
}

const api = { validateSettings, round2, clampInt, rejectionBreakdown, deriveAdaptiveThresholds, formatTicketContextForPrompt, countKgEntities, buildHistoricalJql };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') Object.assign(self, api);
})();
