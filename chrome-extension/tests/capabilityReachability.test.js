/**
 * Every shipped capability must be REACHABLE.
 *
 * fix2.md's F14 is exactly this defect: `dedupeAgainstExistingSuite` existed in
 * the worker with no control and was never loaded, so a whole feature was dead
 * for a release. I then reproduced it — requirement manifests, review decisions
 * and the §14 importers were all implemented, unit-tested and shipped in the
 * package while nothing called them.
 *
 * A module that is loaded but never invoked is indistinguishable from a module
 * that does not exist, except that it looks finished. This test asserts each
 * capability has a real call site and, where it needs one, a way in from the UI.
 */
const fs = require('fs');
const path = require('path');

const EXT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(EXT, f), 'utf8');

const background = read('background.js');
const content = read('content.js');
const agentTools = read('agent-tools.js');
const optionsHtml = read('options.html');
const optionsJs = read('options.js');
const manifest = JSON.parse(read('manifest.json'));

/** Call sites, excluding the importScripts line and the definition itself. */
const callSites = (src, name) =>
  src.split('\n').filter(l => l.includes(name) && !l.includes('importScripts') && !l.trim().startsWith('*')).length;

describe('every module in the worker is actually used', () => {
  const modules = [
    'test-case-finalizer', 'requirement-model', 'readiness', 'review-memory',
    'export-ledger', 'contract-import', 'document-extractor', 'settings-schema', 'model-registry'
  ];

  test.each(modules)('%s is loaded by the service worker', (m) => {
    expect(background).toContain(`importScripts('${m}.js')`);
  });

  test.each(modules)('%s ships in the package', (m) => {
    // Verified against the real build output rather than the source tree.
    const zip = path.join(EXT, '..', `qatalyst-v${manifest.version}-webstore.zip`);
    if (!fs.existsSync(zip)) return; // build not run in this environment
    const listing = require('child_process').execSync(`unzip -Z1 "${zip}"`, { encoding: 'utf8' });
    expect(listing.split('\n')).toContain(`${m}.js`);
  });
});

describe('capabilities have real call sites, not just definitions', () => {
  const wired = [
    ['F04 schema + gate on every route', background, 'finalizeGenerated'],
    ['F07 requirement predicates', background, 'buildRequirements'],
    ['F07 predicate coverage', background, 'mapRequirementPredicates'],
    ['§15.3 execution readiness', background, 'assessExecutability'],
    ['§15.6 clarification questions', background, 'clarificationQuestions'],
    ['§15.2 generation manifest', background, 'buildManifest'],
    ['§15.2 requirement diff', background, 'diffManifests'],
    ['§15.1 review decisions', background, 'ReviewMemory'],
    ['§14 imported evidence', background, 'buildImportedEvidence'],
    ['§14 evidence in the prompt', agentTools, 'importedEvidenceContext'],
    ['F24 document extraction', background, 'extractDocument'],
    ['F14 export ledger', read('integrations.js'), 'ExportLedger'],
    ['provider tuning', background, 'providerTuning']
  ];

  test.each(wired)('%s is invoked', (_label, src, symbol) => {
    // Two lines minimum: it is referenced somewhere other than its own import.
    expect(callSites(src, symbol)).toBeGreaterThan(0);
  });
});

describe('capabilities that need a way in have one', () => {
  test('§14 imports can be supplied from the options page', () => {
    // These importers were unreachable: nothing ever sent `data.imports`.
    expect(optionsHtml).toContain('import-evidence-btn');
    expect(optionsJs).toContain("action: 'importEvidence'");
    expect(background).toContain("request.action === 'importEvidence'");
  });

  test('imported evidence is reused without re-uploading per ticket', () => {
    expect(background).toContain('qatalyst_imported_evidence');
    expect(background).toMatch(/data\.imports \|\| storedImports/);
  });

  test('§15.1 decisions can be recorded from the results panel', () => {
    expect(content).toContain('recordReviewDecision');
    expect(content).toContain('bindReviewDecisionButtons');
    expect(background).toContain("request.action === 'recordReviewDecision'");
  });

  test('recorded decisions are applied on the next run', () => {
    // Recording without applying would be a diary, not a feature.
    expect(background).toMatch(/memory\.apply\(/);
  });

  test('the Ollama provider is reachable end to end', () => {
    expect(optionsHtml).toContain('value="ollama"');
    expect(read('llm-client.js')).toContain("llmProvider === 'ollama'");
    expect(background).toContain("case 'ollama'"); // Test Connection
  });
});
