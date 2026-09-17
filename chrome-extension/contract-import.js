/**
 * contract-import.js (§14 items 2, 4, 5, 7) — evidence sources that a crawl
 * cannot provide, imported as FILES so none of them needs an account connection.
 *
 * A crawl observes one session of one build: one role, one viewport, one flag
 * state, and whichever API calls that session happened to make. It cannot tell
 * you what an endpoint's contract SAYS, which roles exist, what the app does in
 * states nobody clicked into, or which paths actually fail in production. Every
 * one of those gaps previously became either an invented assertion or a missing
 * test.
 *
 * All four importers emit the SAME evidence shape (fix2.md §7.1), so retrieval,
 * grounding and equivalence stay independent of which connector supplied the
 * data:
 *   { id, sourceType, sourceUrl, sourceRevision, observedAt, scope, content, trust }
 *
 * ponytail: parsing and normalization only. No network, no auth, no polling —
 * §14.1 says offer file import first, and a read-only adapter later.
 */
(function () {

const now = () => Date.now();

function evidence(sourceType, id, content, extra = {}) {
  return {
    id: `${sourceType}:${id}`,
    sourceType,
    sourceUrl: extra.sourceUrl || null,
    sourceRevision: extra.sourceRevision || null,
    observedAt: extra.observedAt || now(),
    scope: extra.scope || null,
    // Implementation evidence is NOT approved intended behaviour (§14 item 3).
    trust: extra.trust || 'reference',
    content
  };
}

// ───────────────────── §14.2 OpenAPI contract import ─────────────────────

/**
 * Parse an OpenAPI 3.x document into operation records.
 *
 * Without this, request/response/auth/boundary cases were inferred from a single
 * passive network capture — so a required field nobody's session happened to omit
 * was invisible, and an error response nobody triggered did not exist.
 *
 * @returns {{ok, operations, error?, version?, title?}}
 */
function importOpenApi(input) {
  let doc;
  try {
    doc = typeof input === 'string' ? JSON.parse(input) : input;
  } catch (e) {
    return { ok: false, operations: [], error: `Not valid JSON: ${e.message}` };
  }
  if (!doc || typeof doc !== 'object') return { ok: false, operations: [], error: 'Empty document' };
  if (!doc.openapi && !doc.swagger) {
    return { ok: false, operations: [], error: 'Missing "openapi"/"swagger" version field — not an OpenAPI document' };
  }

  const resolve = (node, depth = 0) => {
    // $ref resolution, bounded so a circular schema cannot hang the worker.
    if (!node || typeof node !== 'object' || depth > 8) return node;
    if (node.$ref && typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
      const path = node.$ref.slice(2).split('/');
      let target = doc;
      for (const p of path) target = target && target[p.replace(/~1/g, '/').replace(/~0/g, '~')];
      return resolve(target, depth + 1);
    }
    return node;
  };

  const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options'];
  const operations = [];

  for (const [path, item] of Object.entries(doc.paths || {})) {
    const resolvedItem = resolve(item) || {};
    for (const method of METHODS) {
      const op = resolvedItem[method];
      if (!op) continue;

      const params = [...(resolvedItem.parameters || []), ...(op.parameters || [])]
        .map(p => resolve(p)).filter(Boolean)
        .map(p => ({
          name: p.name, in: p.in, required: !!p.required,
          type: (resolve(p.schema) || {}).type || null,
          // These are exactly the boundary obligations §7.2 asks for.
          constraints: pickConstraints(resolve(p.schema) || {})
        }));

      const body = resolve(op.requestBody);
      const bodySchema = body && body.content
        ? resolve((Object.values(body.content)[0] || {}).schema)
        : null;

      const responses = Object.entries(op.responses || {}).map(([status, r]) => {
        const rr = resolve(r) || {};
        return { status, description: rr.description || '' };
      });

      operations.push({
        operationId: op.operationId || `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        path,
        summary: op.summary || '',
        parameters: params,
        requestFields: bodySchema ? flattenSchema(bodySchema, resolve) : [],
        requestRequired: bodySchema && Array.isArray(bodySchema.required) ? bodySchema.required : [],
        responses,
        // §14: auth is part of the contract, and a missing-auth case is only
        // writable when you know the operation is protected.
        security: op.security || doc.security || null,
        deprecated: !!op.deprecated
      });
    }
  }

  return {
    ok: true,
    operations,
    version: doc.openapi || doc.swagger,
    title: (doc.info && doc.info.title) || '',
    evidence: evidence('openapi', (doc.info && doc.info.title) || 'contract', operations, {
      sourceRevision: (doc.info && doc.info.version) || null,
      trust: 'contract'
    })
  };
}

function pickConstraints(schema) {
  const out = {};
  for (const k of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
                   'minLength', 'maxLength', 'pattern', 'enum', 'format', 'minItems', 'maxItems']) {
    if (schema[k] !== undefined) out[k] = schema[k];
  }
  return out;
}

function flattenSchema(schema, resolve, prefix = '', depth = 0) {
  const s = resolve(schema) || {};
  if (depth > 5 || !s.properties) return [];
  const out = [];
  for (const [name, raw] of Object.entries(s.properties)) {
    const prop = resolve(raw) || {};
    const full = prefix ? `${prefix}.${name}` : name;
    out.push({
      name: full, type: prop.type || null,
      required: Array.isArray(s.required) && s.required.includes(name),
      constraints: pickConstraints(prop)
    });
    if (prop.type === 'object') out.push(...flattenSchema(prop, resolve, full, depth + 1));
  }
  return out;
}

/**
 * §14 item 2: the boundary obligations a contract states outright. These are
 * facts, not guesses — the difference between asserting a documented limit and
 * inventing one.
 */
function contractObligations(operations) {
  const out = [];
  for (const op of operations || []) {
    const all = [...(op.parameters || []), ...(op.requestFields || [])];
    for (const f of all) {
      const c = f.constraints || {};
      if (f.required) out.push({ operation: op.operationId, field: f.name, kind: 'required', note: `${f.name} is required` });
      if (c.maxLength !== undefined) out.push({ operation: op.operationId, field: f.name, kind: 'boundary', limit: c.maxLength, note: `${f.name} max length ${c.maxLength}` });
      if (c.maximum !== undefined) out.push({ operation: op.operationId, field: f.name, kind: 'boundary', limit: c.maximum, note: `${f.name} maximum ${c.maximum}` });
      if (c.minimum !== undefined) out.push({ operation: op.operationId, field: f.name, kind: 'boundary', limit: c.minimum, note: `${f.name} minimum ${c.minimum}` });
      if (c.enum) out.push({ operation: op.operationId, field: f.name, kind: 'enum', values: c.enum, note: `${f.name} is one of ${c.enum.join('/')}` });
    }
    for (const r of op.responses || []) {
      if (/^[45]/.test(r.status)) {
        out.push({ operation: op.operationId, kind: 'error_response', status: r.status, note: `${op.operationId} can return ${r.status}${r.description ? ` (${r.description})` : ''}` });
      }
    }
    if (op.security && op.security.length) {
      out.push({ operation: op.operationId, kind: 'auth', note: `${op.operationId} requires authentication` });
    }
  }
  return out;
}

// ───────────────── §14.4 role / state / environment manifest ─────────────────

/**
 * A crawl sees ONE session. The permission matrix, the lifecycle states and the
 * flag combinations are not observable from it at all — which is why permission
 * and state cases were previously either missing or guessed.
 *
 * @returns {{ok, profile, error?}}
 */
function importProjectProfile(input) {
  let doc;
  try { doc = typeof input === 'string' ? JSON.parse(input) : input; }
  catch (e) { return { ok: false, error: `Not valid JSON: ${e.message}` }; }
  if (!doc || typeof doc !== 'object') return { ok: false, error: 'Empty profile' };

  const profile = {
    version: doc.version || null,
    roles: (doc.roles || []).map(r => typeof r === 'string'
      ? { name: r, can: [], cannot: [] }
      : { name: r.name, can: r.can || [], cannot: r.cannot || [], tenant: r.tenant || null }),
    states: (doc.states || []).map(s => typeof s === 'string'
      ? { name: s, from: [], to: [] }
      : { name: s.name, from: s.from || [], to: s.to || [], terminal: !!s.terminal }),
    featureFlags: (doc.featureFlags || doc.flags || []).map(f => typeof f === 'string'
      ? { name: f, values: [true, false] }
      : { name: f.name, values: f.values || [true, false], default: f.default }),
    environments: doc.environments || [],
    testData: doc.testData || {}
  };

  if (!profile.roles.length && !profile.states.length && !profile.featureFlags.length) {
    return { ok: false, error: 'Profile declares no roles, states or feature flags' };
  }
  return { ok: true, profile, evidence: evidence('project_profile', profile.version || 'profile', profile, { trust: 'declared' }) };
}

/**
 * §14 item 4: the allow/deny pairs a role matrix makes explicit. Each is a
 * distinct obligation that must never be merged away (F05).
 */
function permissionObligations(profile) {
  const out = [];
  const roles = (profile && profile.roles) || [];
  const operations = new Set();
  for (const r of roles) { (r.can || []).forEach(o => operations.add(o)); (r.cannot || []).forEach(o => operations.add(o)); }

  for (const op of operations) {
    for (const r of roles) {
      if ((r.can || []).includes(op)) out.push({ actor: r.name, operation: op, modality: 'must', note: `${r.name} can ${op}` });
      else if ((r.cannot || []).includes(op)) out.push({ actor: r.name, operation: op, modality: 'must_not', note: `${r.name} cannot ${op}` });
    }
  }
  return out;
}

/** §14 item 4: valid and INVALID transitions — the invalid ones are the tests. */
function stateObligations(profile) {
  const out = [];
  const states = (profile && profile.states) || [];
  const names = states.map(s => s.name);
  for (const s of states) {
    for (const to of (s.to || [])) out.push({ from: s.name, to, valid: true, note: `${s.name} → ${to} is allowed` });
    for (const other of names) {
      if (other === s.name || (s.to || []).includes(other)) continue;
      out.push({ from: s.name, to: other, valid: false, note: `${s.name} → ${other} must be rejected` });
    }
  }
  return out;
}

// ───────────── §14.3 change context / §14.5 execution / §14.7 traces ─────────────

/**
 * §14 item 3: a PR/MR's changed files, scoping regression to what actually moved.
 * Accepts the shape both the GitHub and GitLab APIs return, or a plain list, so
 * the evidence can be pasted from either without a connector.
 *
 * Implementation evidence is kept explicitly separate from approved behaviour:
 * a diff says what changed, never what SHOULD happen.
 */
function importChangeContext(input) {
  let doc;
  try { doc = typeof input === 'string' ? JSON.parse(input) : input; }
  catch (e) { return { ok: false, files: [], error: `Not valid JSON: ${e.message}` }; }

  const list = Array.isArray(doc) ? doc : (doc.files || doc.changes || doc.diffs || []);
  if (!Array.isArray(list) || !list.length) {
    return { ok: false, files: [], error: 'No changed files found in the payload' };
  }

  const files = list.map(f => ({
    path: f.filename || f.new_path || f.path || f.old_path || '',
    status: f.status || (f.new_file ? 'added' : f.deleted_file ? 'removed' : 'modified'),
    additions: f.additions ?? null,
    deletions: f.deletions ?? null,
    // Test files are evidence of intent; config changes are risk.
    isTest: /(^|\/)(tests?|spec|__tests__)\//i.test(f.filename || f.new_path || f.path || '') ||
            /\.(test|spec)\.[jt]sx?$/i.test(f.filename || f.new_path || f.path || ''),
    isConfig: /\.(ya?ml|toml|ini|env|conf|config\.[jt]s|json)$/i.test(f.filename || f.new_path || f.path || '')
  })).filter(f => f.path);

  return {
    ok: true, files,
    revision: doc.sha || doc.head_sha || (doc.diff_refs && doc.diff_refs.head_sha) || null,
    evidence: evidence('change_context', doc.number || doc.iid || 'change', files, {
      sourceUrl: doc.html_url || doc.web_url || null,
      // A diff describes the implementation, never the approved requirement.
      trust: 'implementation'
    })
  };
}

/** §14 item 3: which areas a change plausibly touches, for regression scoping. */
function impactedAreas(files) {
  const areas = new Map();
  for (const f of files || []) {
    if (f.isTest) continue;
    // The directory is the crudest useful unit of impact.
    const parts = f.path.split('/').filter(Boolean);
    const area = parts.length > 1 ? parts.slice(0, -1).join('/') : '(root)';
    const entry = areas.get(area) || { area, files: 0, configChanged: false, churn: 0 };
    entry.files++;
    entry.churn += (f.additions || 0) + (f.deletions || 0);
    if (f.isConfig) entry.configChanged = true;
    areas.set(area, entry);
  }
  return [...areas.values()].sort((a, b) => b.churn - a.churn);
}

/**
 * §14 item 5: executed tests and their results. This is what distinguishes a
 * PROPOSED case from one that has actually run — and lets a flaky or obsolete
 * case be recognised rather than regenerated forever.
 */
function importExecutionResults(input) {
  let doc;
  try { doc = typeof input === 'string' ? JSON.parse(input) : input; }
  catch (e) { return { ok: false, results: [], error: `Not valid JSON: ${e.message}` }; }

  const list = Array.isArray(doc) ? doc : (doc.results || doc.tests || doc.suites || []);
  if (!Array.isArray(list) || !list.length) return { ok: false, results: [], error: 'No results found' };

  const results = list.map(r => ({
    title: r.title || r.name || r.fullName || '',
    status: String(r.status || r.outcome || r.state || '').toLowerCase(),
    durationMs: r.duration ?? r.durationMs ?? null,
    error: r.error || (r.failureMessages && r.failureMessages[0]) || null,
    // A test that changes verdict between runs is flaky — a fact no static
    // analysis can establish.
    retries: r.retries ?? null,
    flaky: !!r.flaky || (r.retries > 0 && /pass/.test(String(r.status || '')))
  })).filter(r => r.title);

  return {
    ok: true, results,
    summary: {
      total: results.length,
      passed: results.filter(r => /pass/.test(r.status)).length,
      failed: results.filter(r => /fail/.test(r.status)).length,
      flaky: results.filter(r => r.flaky).length
    },
    evidence: evidence('execution', doc.runId || 'run', results, { trust: 'observed' })
  };
}

/**
 * §14 item 7: sanitized runtime failures, to prioritise real failure paths.
 * Observed failures suggest RISK; they never establish intended behaviour, so
 * they are trusted lowest and labelled as such.
 */
function importRuntimeErrors(input) {
  let doc;
  try { doc = typeof input === 'string' ? JSON.parse(input) : input; }
  catch (e) { return { ok: false, errors: [], error: `Not valid JSON: ${e.message}` }; }

  const list = Array.isArray(doc) ? doc : (doc.errors || doc.issues || doc.spans || []);
  if (!Array.isArray(list) || !list.length) return { ok: false, errors: [], error: 'No error records found' };

  const errors = list.map(e => ({
    message: redact(e.message || e.title || e.name || ''),
    operation: e.operation || e.transaction || e.endpoint || e.span || null,
    count: e.count ?? e.occurrences ?? 1,
    lastSeen: e.lastSeen || e.timestamp || null,
    // Payloads routinely carry customer data; never let it reach a prompt.
    sample: e.sample ? redact(String(e.sample).slice(0, 300)) : null
  })).filter(e => e.message);

  return {
    ok: true,
    errors: errors.sort((a, b) => (b.count || 0) - (a.count || 0)),
    evidence: evidence('runtime_errors', 'incidents', errors, { trust: 'observed_risk' })
  };
}

/** Strip obvious PII/secrets before anything reaches a prompt or an export. */
function redact(text) {
  return String(text || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/\b(?:\d[ -]?){13,19}\b/g, '[card]')
    .replace(/\b(?:sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{10,}/g, '[token]')
    .replace(/\bBearer\s+[A-Za-z0-9._-]{10,}/gi, 'Bearer [token]')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '[ip]');
}

const api = {
  importOpenApi, contractObligations,
  importProjectProfile, permissionObligations, stateObligations,
  importChangeContext, impactedAreas,
  importExecutionResults, importRuntimeErrors,
  redact, evidence
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') Object.assign(self, api);
if (typeof window !== 'undefined') Object.assign(window, api);
})();
