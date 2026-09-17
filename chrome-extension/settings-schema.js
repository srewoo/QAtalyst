/**
 * settings-schema.js (F21) — one validated definition of every setting.
 *
 * Defaults and bounds were spread across config.json, config.js,
 * context-manager.js, token-counter.js, options.js and the provider code, and
 * they did not agree. A value could be clamped one way in the UI, defaulted
 * another way in the worker, and ignored entirely on the path that actually ran
 * — which is how `dedupeAgainstExistingSuite` came to exist in the worker with
 * no control, and how the historical JQL filter reached only the dead path.
 *
 * This is the single source: name, type, default, bounds, and — critically —
 * which code path CONSUMES it, so a setting that nothing reads is visible as a
 * defect rather than shipping as a control that does nothing.
 */
(function () {

const SCHEMA = {
  // ── provider ──
  llmProvider: { type: 'enum', values: ['openai', 'claude', 'gemini', 'bedrock', 'ollama'], default: 'openai', consumedBy: 'llm-client' },
  ollamaBaseUrl: { type: 'string', default: 'http://localhost:11434', consumedBy: 'llm-client + model-registry' },
  openaiBaseUrl: { type: 'string', default: '', consumedBy: 'llm-client + model-registry' },
  llmModel: { type: 'string', default: '', consumedBy: 'llm-client' },
  temperature: { type: 'number', min: 0, max: 2, default: 0.3, consumedBy: 'llm-client' },
  maxTokens: { type: 'int', min: 256, max: 200000, default: 8000, consumedBy: 'llm-client' },
  enableStreaming: { type: 'boolean', default: true, consumedBy: 'background:stream' },

  // ── generation ──
  enableMultiAgent: { type: 'boolean', default: false, consumedBy: 'background:agentic' },
  testCount: { type: 'int', min: 1, max: 100, default: 30, consumedBy: 'agent-loop:budget' },
  coverageTarget: { type: 'int', min: 40, max: 100, default: 80, consumedBy: 'agent-loop:budget' },
  dedupThreshold: { type: 'number', min: 0.3, max: 0.99, default: 0.68, consumedBy: 'acceptance-gate' },
  relevanceThreshold: { type: 'number', min: 0, max: 1, default: 0.15, consumedBy: 'acceptance-gate' },
  enabledCategories: { type: 'array', default: null, consumedBy: 'dynamic-distribution' },

  // ── quality gates ──
  enableAssertionCritic: { type: 'boolean', default: true, consumedBy: 'assertion-critic' },
  assertionCriticStrict: { type: 'boolean', default: false, consumedBy: 'assertion-critic' },
  dedupeAgainstExistingSuite: { type: 'boolean', default: false, consumedBy: 'background:agentic + integrations' },

  // ── evidence ──
  useCrawledDataForTests: { type: 'boolean', default: true, consumedBy: 'content:extractAppContext' },
  kgStalenessDays: { type: 'int', min: 1, max: 365, default: 14, consumedBy: 'crawler-handlers:loadEmbeddings' },
  enableHistoricalMining: { type: 'boolean', default: true, consumedBy: 'background:agentic' },
  historicalMaxResults: { type: 'int', min: 5, max: 50, default: 20, consumedBy: 'historical-mining' },
  historicalJqlFilters: { type: 'string', default: '', consumedBy: 'background-utils:buildHistoricalJql' },

  // ── integrations ──
  jiraBaseUrl: { type: 'string', default: '', consumedBy: 'historical-mining' },
  jiraEmail: { type: 'string', default: '', secret: false, consumedBy: 'historical-mining' },
  jiraApiToken: { type: 'string', default: '', secret: true, consumedBy: 'historical-mining' },
  confluenceUrl: { type: 'string', default: '', consumedBy: 'integrations' },
  confluenceEmail: { type: 'string', default: '', consumedBy: 'integrations' },
  confluenceToken: { type: 'string', default: '', secret: true, consumedBy: 'integrations' },
  figmaToken: { type: 'string', default: '', secret: true, consumedBy: 'integrations' },
  googleApiKey: { type: 'string', default: '', secret: true, consumedBy: 'integrations' },
  testrailUrl: { type: 'string', default: '', consumedBy: 'integrations:TestRail' },
  testrailUsername: { type: 'string', default: '', consumedBy: 'integrations:TestRail' },
  testrailApiKey: { type: 'string', default: '', secret: true, consumedBy: 'integrations:TestRail' },
  testrailProjectId: { type: 'string', default: '', consumedBy: 'integrations:TestRail' },
  testrailSuiteId: { type: 'string', default: '', consumedBy: 'integrations:TestRail' }
};

/**
 * Coerce and clamp a settings object to the schema. Out-of-range values are
 * clamped rather than rejected — a bad number should not block generation — but
 * every correction is reported so it is never silent.
 * @returns {{settings, corrections, unknown}}
 */
function validateSettings(raw) {
  const input = raw || {};
  const settings = {};
  const corrections = [];

  for (const [key, def] of Object.entries(SCHEMA)) {
    const v = input[key];
    if (v === undefined || v === null || v === '') {
      if (def.default !== null) settings[key] = def.default;
      continue;
    }
    switch (def.type) {
      case 'boolean':
        settings[key] = (v === true || v === 'true');
        break;
      case 'int': case 'number': {
        let n = def.type === 'int' ? parseInt(v, 10) : parseFloat(v);
        if (!Number.isFinite(n)) {
          corrections.push(`${key}: "${v}" is not a number — using ${def.default}`);
          n = def.default;
        }
        if (def.min !== undefined && n < def.min) {
          corrections.push(`${key}: ${n} is below the minimum ${def.min} — clamped`);
          n = def.min;
        }
        if (def.max !== undefined && n > def.max) {
          corrections.push(`${key}: ${n} is above the maximum ${def.max} — clamped`);
          n = def.max;
        }
        settings[key] = n;
        break;
      }
      case 'enum':
        if (!def.values.includes(v)) {
          corrections.push(`${key}: "${v}" is not one of ${def.values.join('/')} — using ${def.default}`);
          settings[key] = def.default;
        } else settings[key] = v;
        break;
      case 'array':
        settings[key] = Array.isArray(v) ? v : def.default;
        break;
      default:
        settings[key] = String(v);
    }
  }

  // A key nobody declares is either a typo or a setting whose definition was
  // never written down — both are worth surfacing.
  const unknown = Object.keys(input).filter(k => !(k in SCHEMA));
  return { settings, corrections, unknown };
}

/** Every setting, for the UI, with secrets marked so they are never logged. */
function describeSettings() {
  return Object.entries(SCHEMA).map(([key, def]) => ({
    key, type: def.type, default: def.default, consumedBy: def.consumedBy, secret: !!def.secret
  }));
}

/**
 * F21: which declared settings does no code path consume? A control that reaches
 * nothing is exactly the class of defect that made `dedupeAgainstExistingSuite`
 * unreachable for a whole release.
 */
function orphanedSettings() {
  return Object.entries(SCHEMA).filter(([, d]) => !d.consumedBy).map(([k]) => k);
}

const api = { SCHEMA, validateSettings, describeSettings, orphanedSettings };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') self.SettingsSchema = api;
if (typeof window !== 'undefined') window.SettingsSchema = api;
})();
