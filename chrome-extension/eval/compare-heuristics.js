#!/usr/bin/env node
/**
 * §15.7 — non-destructive comparison mode for heuristic changes.
 *
 * Lowering a duplicate threshold improves the visible duplicate count while
 * quietly reducing real coverage, and nothing in the old workflow would have
 * shown that. This runs two configurations over the SAME saved candidates and
 * reports the disagreements — above all the cases the new logic would remove
 * that the old one kept, which is the direction that destroys obligations.
 *
 * It never writes to a suite. Promote a change only when the protected
 * distinction fixtures still pass and the disagreements are ones you accept.
 *
 *   node chrome-extension/eval/compare-heuristics.js [fixture.json] [--old 0.68] [--new 0.75]
 */
const fs = require('fs');
const path = require('path');
const SemanticDuplicateDetector = require('../semantic-duplicate-detector.js');
const { AcceptanceGate } = require('../acceptance-gate.js');
const { GroundedVerifier } = require('../grounded-verifier.js');

const ALGORITHM_VERSION = 'v2-scenario-classification';

/** Run one configuration over a fixture's candidates. */
function runConfig(fixture, { dedupThreshold }) {
  const gate = new AcceptanceGate({
    knowledgeGraph: fixture.knowledgeGraph || null,
    ticketData: fixture.ticket || {},
    deps: { GroundedVerifier, SemanticDuplicateDetector },
    dedupThreshold,
    relevanceThreshold: 0
  });
  const r = gate.admit(fixture.generatedSuite || []);
  return {
    kept: r.accepted.map(t => t.title),
    rejected: (r.rejected || []).map(x => ({ title: x.test && x.test.title, stage: x.stage, reason: x.reason })),
    preserved: (r.preservedDistinctions || []).map(p => ({ a: p.test, b: p.against, relation: p.relation }))
  };
}

function compare(fixture, oldCfg, newCfg) {
  const before = runConfig(fixture, oldCfg);
  const after = runConfig(fixture, newCfg);
  const beforeSet = new Set(before.kept);
  const afterSet = new Set(after.kept);

  return {
    key: fixture.key || '(fixture)',
    // The dangerous direction: kept before, removed now.
    newlyRemoved: before.kept.filter(t => !afterSet.has(t)),
    // The safe direction: removed before, kept now.
    newlyKept: after.kept.filter(t => !beforeSet.has(t)),
    beforeCount: before.kept.length,
    afterCount: after.kept.length,
    preservedNow: after.preserved
  };
}

function main() {
  const args = process.argv.slice(2);
  const fixtureArg = args.find(a => !a.startsWith('--'));
  const opt = (name, dflt) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? parseFloat(args[i + 1]) : dflt;
  };
  const oldCfg = { dedupThreshold: opt('old', 0.68) };
  const newCfg = { dedupThreshold: opt('new', 0.75) };

  const dir = path.join(__dirname, 'fixtures');
  const files = fixtureArg ? [fixtureArg]
    : fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f));

  console.log(`\nHeuristic comparison (${ALGORITHM_VERSION})`);
  console.log(`old dedupThreshold=${oldCfg.dedupThreshold}  →  new dedupThreshold=${newCfg.dedupThreshold}`);
  console.log('='.repeat(70));

  let regressions = 0;
  for (const file of files) {
    let fixture;
    try { fixture = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { console.error(`  ✗ ${path.basename(file)}: ${e.message}`); continue; }

    const d = compare(fixture, oldCfg, newCfg);
    console.log(`\n${d.key}: ${d.beforeCount} → ${d.afterCount} retained`);
    if (d.newlyRemoved.length) {
      regressions += d.newlyRemoved.length;
      console.log('  ⚠️  REMOVED by the new logic (review each — this is where obligations disappear):');
      d.newlyRemoved.forEach(t => console.log(`     - ${t}`));
    }
    if (d.newlyKept.length) {
      console.log('  ✅ newly retained:');
      d.newlyKept.forEach(t => console.log(`     + ${t}`));
    }
    if (!d.newlyRemoved.length && !d.newlyKept.length) console.log('  no disagreements');
  }

  console.log('\n' + '='.repeat(70));
  console.log(regressions
    ? `⚠️  ${regressions} case(s) would be removed by the new logic — review before promoting.`
    : '✅ No case is removed by the new logic.');
  console.log('This is a report. Nothing was written to any suite.\n');
  // Non-zero only on request, so this can run informationally in CI.
  process.exit(process.argv.includes('--strict') && regressions ? 1 : 0);
}

if (require.main === module) main();
module.exports = { compare, runConfig, ALGORITHM_VERSION };
