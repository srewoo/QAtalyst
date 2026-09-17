/**
 * §14 items 2-5 and 7 — evidence a crawl cannot provide.
 *
 * A crawl observes one session of one build: one role, one viewport, one flag
 * state, and whichever calls that session happened to make. Contracts, the
 * permission matrix, state transitions, what changed in the PR and what fails in
 * production are all invisible to it — and each previously became an invented
 * assertion or a missing test.
 */
const C = require('../contract-import.js');

const SPEC = {
  openapi: '3.0.3',
  info: { title: 'Invoices API', version: '2.1.0' },
  components: { schemas: { Upload: { type: 'object', required: ['file'],
    properties: { file: { type: 'string' }, sizeKb: { type: 'integer', maximum: 100 } } } } },
  paths: {
    '/invoices/{id}': { delete: {
      operationId: 'deleteInvoice', security: [{ bearer: [] }],
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', maxLength: 36 } }],
      responses: { 204: { description: 'Deleted' }, 403: { description: 'Forbidden' } } } },
    '/uploads': { post: {
      operationId: 'upload',
      requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Upload' } } } },
      responses: { 201: { description: 'Created' }, 413: { description: 'Too large' } } } }
  }
};

describe('§14.2 — OpenAPI contract import', () => {
  test('parses operations, resolving $ref', () => {
    const r = C.importOpenApi(SPEC);
    expect(r.ok).toBe(true);
    expect(r.operations).toHaveLength(2);
    const upload = r.operations.find(o => o.operationId === 'upload');
    // The schema arrived via $ref — unresolved, the limit would be invisible.
    expect(upload.requestFields.map(f => f.name)).toContain('sizeKb');
  });

  test('a documented limit becomes an asserted obligation, not a guess', () => {
    const notes = C.contractObligations(C.importOpenApi(SPEC).operations).map(o => o.note);
    expect(notes).toContain('sizeKb maximum 100');
    expect(notes).toContain('file is required');
  });

  test('specified error responses and auth are obligations too', () => {
    const obs = C.contractObligations(C.importOpenApi(SPEC).operations);
    expect(obs.some(o => o.kind === 'error_response' && o.status === '413')).toBe(true);
    expect(obs.some(o => o.kind === 'auth' && /deleteInvoice/.test(o.note))).toBe(true);
  });

  test('a non-OpenAPI document is rejected with a usable message', () => {
    expect(C.importOpenApi('{"hello":1}').error).toMatch(/not an OpenAPI/i);
    expect(C.importOpenApi('not json').error).toMatch(/valid JSON/i);
  });

  test('a circular $ref cannot hang the worker', () => {
    const circular = { openapi: '3.0.0', components: { schemas: { A: { $ref: '#/components/schemas/A' } } },
      paths: { '/x': { get: { operationId: 'x', responses: {} } } } };
    expect(() => C.importOpenApi(circular)).not.toThrow();
  });
});

describe('§14.4 — role / state / flag profile', () => {
  const PROFILE = {
    version: '1.0',
    roles: [{ name: 'owner', can: ['delete', 'export'] }, { name: 'viewer', cannot: ['delete'] }],
    states: [{ name: 'draft', to: ['issued'] }, { name: 'issued', to: [], terminal: true }],
    featureFlags: [{ name: 'newBilling', values: [true, false] }]
  };

  test('the permission matrix becomes explicit allow AND deny obligations', () => {
    const r = C.importProjectProfile(PROFILE);
    const notes = C.permissionObligations(r.profile).map(o => o.note);
    // One browser session cannot enumerate this.
    expect(notes).toContain('owner can delete');
    expect(notes).toContain('viewer cannot delete');
  });

  test('invalid transitions are derived, not just the valid ones', () => {
    const r = C.importProjectProfile(PROFILE);
    const notes = C.stateObligations(r.profile).map(o => o.note);
    expect(notes).toContain('draft → issued is allowed');
    // The negative transition is the test nobody writes from a crawl.
    expect(notes).toContain('issued → draft must be rejected');
  });

  test('an empty profile is reported rather than silently accepted', () => {
    expect(C.importProjectProfile({}).ok).toBe(false);
  });
});

describe('§14.3 — change context', () => {
  test('accepts the GitHub shape', () => {
    const r = C.importChangeContext({ number: 42, files: [
      { filename: 'src/billing/invoice.js', status: 'modified', additions: 40, deletions: 3 },
      { filename: 'src/billing/__tests__/invoice.test.js', status: 'modified' }
    ] });
    expect(r.ok).toBe(true);
    expect(r.files[1].isTest).toBe(true);
  });

  test('accepts the GitLab shape', () => {
    const r = C.importChangeContext({ iid: 7, changes: [
      { new_path: 'app/models/order.rb', old_path: 'app/models/order.rb' },
      { new_path: 'config/settings.yml', new_file: false }
    ] });
    expect(r.ok).toBe(true);
    expect(r.files.map(f => f.path)).toContain('app/models/order.rb');
    expect(r.files.find(f => /settings\.yml/.test(f.path)).isConfig).toBe(true);
  });

  test('impacted areas are ranked by churn and exclude test files', () => {
    const r = C.importChangeContext({ files: [
      { filename: 'src/billing/invoice.js', additions: 100, deletions: 20 },
      { filename: 'src/profile/name.js', additions: 2, deletions: 1 },
      { filename: 'src/billing/__tests__/x.test.js', additions: 500, deletions: 0 }
    ] });
    const areas = C.impactedAreas(r.files);
    expect(areas[0].area).toBe('src/billing');
    expect(areas.some(a => /__tests__/.test(a.area))).toBe(false);
  });

  test('a diff is labelled implementation evidence, not approved behaviour', () => {
    const r = C.importChangeContext({ files: [{ filename: 'a.js' }] });
    expect(r.evidence.trust).toBe('implementation');
  });
});

describe('§14.5 / §14.7 — execution results and runtime errors', () => {
  test('execution results distinguish executed cases from proposed ones', () => {
    const r = C.importExecutionResults({ results: [
      { title: 'Owner deletes an invoice', status: 'passed', duration: 120 },
      { title: 'Viewer cannot delete', status: 'failed', error: 'expected 403' },
      { title: 'Flaky upload', status: 'passed', retries: 2 }
    ] });
    expect(r.summary).toMatchObject({ total: 3, passed: 2, failed: 1 });
    expect(r.results.find(x => /Flaky/.test(x.title)).flaky).toBe(true);
    expect(r.evidence.trust).toBe('observed');
  });

  test('runtime errors are ranked by occurrence and trusted lowest', () => {
    const r = C.importRuntimeErrors({ errors: [
      { message: 'NullPointer in invoice export', count: 3 },
      { message: 'Timeout calling /api/invoices', count: 87 }
    ] });
    expect(r.errors[0].count).toBe(87);
    // Observed failures suggest risk; they never establish intended behaviour.
    expect(r.evidence.trust).toBe('observed_risk');
  });

  test('PII and secrets are redacted before anything can reach a prompt', () => {
    const r = C.importRuntimeErrors({ errors: [{
      message: 'Failed for user alice@example.com with Bearer sk-abcdefghijklmnop from 10.1.2.3',
      count: 1
    }] });
    const m = r.errors[0].message;
    expect(m).not.toContain('alice@example.com');
    expect(m).not.toContain('sk-abcdefghijklmnop');
    expect(m).not.toContain('10.1.2.3');
    expect(m).toContain('[email]');
  });

  test('every importer reports failure rather than returning silence', () => {
    for (const fn of [C.importOpenApi, C.importProjectProfile, C.importChangeContext,
                      C.importExecutionResults, C.importRuntimeErrors]) {
      const r = fn('not json at all {');
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
    }
  });

  test('all importers emit the same evidence shape', () => {
    const results = [
      C.importOpenApi(SPEC),
      C.importProjectProfile({ roles: [{ name: 'admin', can: ['x'] }] }),
      C.importChangeContext({ files: [{ filename: 'a.js' }] }),
      C.importExecutionResults({ results: [{ title: 't', status: 'passed' }] }),
      C.importRuntimeErrors({ errors: [{ message: 'boom' }] })
    ];
    for (const r of results) {
      expect(r.evidence).toMatchObject({
        id: expect.any(String), sourceType: expect.any(String),
        observedAt: expect.any(Number), trust: expect.any(String)
      });
    }
  });
});
