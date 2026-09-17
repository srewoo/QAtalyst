/**
 * model-registry.js — discover the models a key can ACTUALLY use.
 *
 * The model dropdown was a hardcoded list, which is wrong in both directions: it
 * offered models an account may have no access to (the call fails at generation
 * time, after the user has waited), and it hid models the account does have
 * (anything released after the list was last edited, or a fine-tune, or a private
 * deployment). The provider label carried a model name too — "OpenAI (GPT-5.2)" —
 * which goes stale the moment a newer model ships.
 *
 * Each provider exposes a models endpoint; this queries it with the user's own
 * credentials and returns what that key can reach. The static list survives only
 * as an offline fallback, clearly labelled as such, so the page still works
 * before a key is entered or when discovery fails.
 *
 * Also supports OLLAMA for local models: no key, no cloud, and the tag list is
 * whatever the user has actually pulled — a case where a hardcoded list could
 * never have been right.
 */
(function () {

const DISCOVERY_TIMEOUT_MS = 10000;

/** Chat-capable model filter. A models endpoint lists embeddings and TTS too. */
const NON_CHAT = /(^|[-_])(embed|embedding|tts|whisper|dall-e|moderation|audio|realtime|image|rerank|clip|search|similarity|edit|davinci|babbage|ada|curie)([-_]|$)/i;

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || DISCOVERY_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Newest-looking first, then alphabetical — so the useful models are at the top. */
function rank(models) {
  return models.sort((a, b) => {
    if (a.created && b.created && a.created !== b.created) return b.created - a.created;
    return String(a.id).localeCompare(String(b.id));
  });
}

// ───────────────────────────── providers ─────────────────────────────

async function discoverOpenAI(settings) {
  if (!settings.apiKey) throw new Error('An API key is required to list models');
  const base = (settings.openaiBaseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const data = await fetchJson(`${base}/models`, {
    headers: { Authorization: `Bearer ${settings.apiKey}` }
  });
  const list = (data.data || [])
    .filter(m => m && m.id && !NON_CHAT.test(m.id))
    // Chat-completions models across current and older generations.
    .filter(m => /^(gpt|o\d|chatgpt|ft:)/i.test(m.id))
    .map(m => ({ id: m.id, label: m.id, created: m.created }));
  return rank(list);
}

async function discoverClaude(settings) {
  if (!settings.apiKey) throw new Error('An API key is required to list models');
  const data = await fetchJson('https://api.anthropic.com/v1/models?limit=100', {
    headers: {
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      // The models endpoint is callable from an extension origin only with this.
      'anthropic-dangerous-direct-browser-access': 'true'
    }
  });
  return rank((data.data || [])
    .filter(m => m && m.id)
    .map(m => ({ id: m.id, label: m.display_name || m.id, created: m.created_at ? Date.parse(m.created_at) / 1000 : null })));
}

async function discoverGemini(settings) {
  if (!settings.apiKey) throw new Error('An API key is required to list models');
  const data = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(settings.apiKey)}&pageSize=200`);
  return rank((data.models || [])
    // Only models that can actually answer a prompt.
    .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => ({
      id: String(m.name || '').replace(/^models\//, ''),
      label: m.displayName || String(m.name || '').replace(/^models\//, '')
    }))
    .filter(m => m.id && !NON_CHAT.test(m.id)));
}

/**
 * Ollama — local models. There is no key and no cloud: the list is whatever the
 * user has pulled, which a hardcoded list could never have known.
 */
async function discoverOllama(settings) {
  const base = (settings.ollamaBaseUrl || 'http://localhost:11434').replace(/\/+$/, '');
  let data;
  try {
    data = await fetchJson(`${base}/api/tags`, { timeout: 5000 });
  } catch (e) {
    throw new Error(
      `Could not reach Ollama at ${base}. Is it running? Start it with "ollama serve". ` +
      `If it is running, it must allow this extension: set OLLAMA_ORIGINS=chrome-extension://* and restart it. (${e.message})`);
  }
  const list = (data.models || []).map(m => ({
    id: m.name,
    label: m.details && m.details.parameter_size ? `${m.name} (${m.details.parameter_size})` : m.name,
    created: m.modified_at ? Date.parse(m.modified_at) / 1000 : null
  }));
  if (!list.length) {
    throw new Error(`Ollama is running at ${base} but has no models. Pull one first, e.g. "ollama pull llama3.1".`);
  }
  return rank(list);
}

async function discoverBedrock(settings) {
  // Bedrock's ListFoundationModels is a SigV4-signed control-plane call. The
  // worker can sign it, but the options page cannot, so discovery is not offered
  // here rather than pretending it failed.
  throw new Error('Bedrock model discovery is not available from this page — enter the model id shown in the AWS console.');
}

const DISCOVERERS = {
  openai: discoverOpenAI,
  claude: discoverClaude,
  gemini: discoverGemini,
  ollama: discoverOllama,
  bedrock: discoverBedrock
};

/**
 * @returns {Promise<{ok, models, source, error?}>}
 *   source: 'discovered' (the key's real access) | 'fallback' (offline list)
 */
async function discoverModels(provider, settings, fallback = []) {
  const fn = DISCOVERERS[provider];
  if (!fn) return { ok: false, models: fallback, source: 'fallback', error: `Unknown provider: ${provider}` };
  try {
    const models = await fn(settings || {});
    if (!models.length) {
      return { ok: false, models: fallback, source: 'fallback', error: 'The provider returned no usable models' };
    }
    return { ok: true, models, source: 'discovered' };
  } catch (e) {
    // Never leave the dropdown empty — but say the list is not the real one.
    return { ok: false, models: fallback, source: 'fallback', error: e.message };
  }
}

const api = { discoverModels, discoverOpenAI, discoverClaude, discoverGemini, discoverOllama, NON_CHAT };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') Object.assign(self, api);
if (typeof window !== 'undefined') Object.assign(window, api);
})();
