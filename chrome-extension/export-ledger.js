/**
 * export-ledger.js (F14) — make export idempotent and reconcilable.
 *
 * Uploading is a write to someone else's system over an unreliable link. Two
 * failure modes were unhandled:
 *
 *   1. Re-export. Running an export twice created every case twice, because the
 *      only duplicate check was an exact title match against a single page of
 *      existing cases.
 *   2. Uncertain writes. A request that timed out AFTER the server created the
 *      case looked identical to one that never arrived. Retrying created a
 *      second copy; not retrying lost the case. Nothing recorded which.
 *
 * The ledger records, per destination, what we believe we wrote and with what
 * outcome — including `uncertain`. On the next export it reconciles: a case with
 * a confirmed record is skipped, and an uncertain one is verified against the
 * destination before being retried rather than blindly re-sent.
 *
 * Storage is injected so this is testable without chrome.storage.
 */
(function () {

const LEDGER_KEY = 'qatalyst_export_ledger';
const MAX_ENTRIES = 5000;

/** Stable identity for a case within a destination — never the model's id. */
function caseKey(testCase) {
  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const steps = (Array.isArray(testCase.steps) ? testCase.steps : [])
    .map(s => norm(typeof s === 'string' ? s : (s && (s.action || s.step)) || '')).filter(Boolean);
  return [norm(testCase.title), norm(testCase.expected_result || testCase.expectedResult), steps.join('|')].join('::');
}

class ExportLedger {
  /**
   * @param {object} storage { get(key), set(key, value) } — chrome.storage.local
   *   in production, a plain object in tests.
   * @param {string} destination e.g. 'testrail:project-7:suite-2'
   */
  constructor(storage, destination) {
    this.storage = storage;
    this.destination = destination || 'unknown';
    this.entries = new Map();
  }

  async load() {
    try {
      const all = (await this.storage.get(LEDGER_KEY)) || {};
      const raw = (all[LEDGER_KEY] || all)[this.destination] || {};
      this.entries = new Map(Object.entries(raw));
    } catch (_) {
      this.entries = new Map();
    }
    return this;
  }

  async save() {
    try {
      const all = (await this.storage.get(LEDGER_KEY)) || {};
      const book = (all[LEDGER_KEY] || all || {});
      // Bound growth: keep the most recent entries.
      let obj = Object.fromEntries(this.entries);
      const keys = Object.keys(obj);
      if (keys.length > MAX_ENTRIES) {
        const trimmed = keys
          .sort((a, b) => (obj[b].at || 0) - (obj[a].at || 0))
          .slice(0, MAX_ENTRIES);
        obj = Object.fromEntries(trimmed.map(k => [k, obj[k]]));
      }
      book[this.destination] = obj;
      await this.storage.set({ [LEDGER_KEY]: book });
    } catch (e) {
      // A ledger we cannot persist is a ledger that cannot prevent a duplicate
      // next time — say so rather than failing the export.
      console.warn('[ExportLedger] could not persist:', e.message);
    }
  }

  get(testCase) { return this.entries.get(caseKey(testCase)) || null; }

  /** Record an intent BEFORE the write, so a crash mid-write leaves a trace. */
  markPending(testCase) {
    this.entries.set(caseKey(testCase), { status: 'pending', at: Date.now(), title: testCase.title });
  }

  markConfirmed(testCase, remoteId) {
    this.entries.set(caseKey(testCase), { status: 'confirmed', remoteId, at: Date.now(), title: testCase.title });
  }

  /** The write may or may not have landed — the case a retry must not duplicate. */
  markUncertain(testCase, reason) {
    this.entries.set(caseKey(testCase), { status: 'uncertain', reason, at: Date.now(), title: testCase.title });
  }

  markFailed(testCase, reason) {
    this.entries.set(caseKey(testCase), { status: 'failed', reason, at: Date.now(), title: testCase.title });
  }

  /**
   * Split a batch by what the ledger already knows.
   * @param {Array} testCases
   * @returns {{toSend, alreadyExported, needsVerification}}
   */
  plan(testCases) {
    const toSend = [], alreadyExported = [], needsVerification = [];
    for (const tc of testCases || []) {
      const entry = this.get(tc);
      if (!entry) { toSend.push(tc); continue; }
      if (entry.status === 'confirmed') { alreadyExported.push({ testCase: tc, remoteId: entry.remoteId }); continue; }
      // 'uncertain' and 'pending' both mean: we may already have created this.
      if (entry.status === 'uncertain' || entry.status === 'pending') {
        needsVerification.push({ testCase: tc, entry });
        continue;
      }
      toSend.push(tc); // a previous outright failure is safe to retry
    }
    return { toSend, alreadyExported, needsVerification };
  }

  /**
   * Resolve uncertain entries against what the destination actually holds.
   * @param {Array} needsVerification from plan()
   * @param {Array} remoteCases existing cases read back from the destination
   * @returns {{confirmed, toSend}}
   */
  reconcile(needsVerification, remoteCases) {
    const remoteByKey = new Map((remoteCases || []).map(c => [caseKey(c), c]));
    const confirmed = [], toSend = [];
    for (const { testCase } of needsVerification || []) {
      const hit = remoteByKey.get(caseKey(testCase));
      if (hit) {
        this.markConfirmed(testCase, hit.id);
        confirmed.push({ testCase, remoteId: hit.id });
      } else {
        // Genuinely absent — the earlier write did not land, so send it.
        toSend.push(testCase);
      }
    }
    return { confirmed, toSend };
  }
}

/**
 * F14: a neutral import for existing suites.
 *
 * Deduplicating against the team's suite required TestRail. Teams on Xray,
 * Zephyr or a spreadsheet had no way to supply what they already cover, so every
 * generated case looked new to them. This accepts a documented, platform-neutral
 * JSON or CSV shape and normalizes it to the same record the duplicate checks
 * read — the same shape TestRailIntegration.normalizeExistingCase produces.
 *
 * Accepted JSON: an array of cases, or { cases: [...] }, each with
 *   { id?, title, preconditions?, steps?: string[]|string, expected_result?, refs? }
 * Accepted CSV: a header row naming at least a title column; ID / Steps /
 * Expected Result / Preconditions are recognised case-insensitively.
 */
function importNeutralSuite(input, format) {
  const text = String(input || '').trim();
  if (!text) return { cases: [], ok: false, error: 'empty input' };

  const kind = format || (text.startsWith('[') || text.startsWith('{') ? 'json' : 'csv');
  try {
    return kind === 'json' ? { cases: fromJson(text), ok: true } : { cases: fromCsv(text), ok: true };
  } catch (e) {
    // F14: an unreadable import is reported, never returned as "no existing cases".
    return { cases: [], ok: false, error: `Could not parse the ${kind.toUpperCase()} suite: ${e.message}` };
  }
}

function normalizeImported(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pick = (...names) => {
    for (const n of names) {
      const hit = Object.keys(raw).find(k => k.toLowerCase().replace(/[^a-z]/g, '') === n);
      if (hit && raw[hit] != null && String(raw[hit]).trim()) return String(raw[hit]).trim();
    }
    return '';
  };
  const title = pick('title', 'name', 'summary', 'testcase', 'case');
  if (!title) return null;
  const stepsRaw = raw.steps ?? raw.Steps ?? pick('steps', 'teststeps', 'procedure');
  const steps = Array.isArray(stepsRaw)
    ? stepsRaw.map(s => String(typeof s === 'string' ? s : (s && (s.content || s.action || s.step)) || '').trim()).filter(Boolean)
    : String(stepsRaw || '').split(/\r?\n|(?:^|\s)\d+[.)]\s/).map(x => x.trim()).filter(Boolean);
  return {
    id: pick('id', 'key', 'caseid', 'testcaseid'),
    title,
    preconditions: pick('preconditions', 'precondition', 'setup'),
    description: pick('description', 'objective'),
    steps,
    expected_result: pick('expectedresult', 'expected', 'expectedresults', 'result'),
    refs: pick('refs', 'requirement', 'requirements', 'story'),
    _source: 'import',
    _existing: true
  };
}

function fromJson(text) {
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.cases) ? parsed.cases : null);
  if (!list) throw new Error('expected an array of cases, or { "cases": [...] }');
  return list.map(normalizeImported).filter(Boolean);
}

/** Minimal RFC4180 CSV reader: quoted fields, doubled quotes, embedded newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(cell => String(cell).trim()));
}

function fromCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('needs a header row and at least one case');
  const headers = rows[0].map(h => String(h || '').trim());
  if (!headers.some(h => /title|name|summary|case/i.test(h))) {
    throw new Error('no title column found in the header row');
  }
  return rows.slice(1)
    .map(r => normalizeImported(Object.fromEntries(headers.map((h, i) => [h, r[i]]))))
    .filter(Boolean);
}

const api = { ExportLedger, caseKey, LEDGER_KEY, importNeutralSuite, parseCsv, normalizeImported };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') Object.assign(self, api);
})();
