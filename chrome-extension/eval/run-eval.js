#!/usr/bin/env node
/**
 * Golden-set eval runner (G3)
 *
 * Loads every fixture in eval/fixtures/*.json, scores its generated suite with
 * the shipped logic (see scorer.js), prints a table, and exits non-zero if any
 * fixture fails its thresholds — so a prompt/gate change that regresses quality
 * fails CI instead of shipping on vibes.
 *
 *   node chrome-extension/eval/run-eval.js            # score all fixtures
 *   node chrome-extension/eval/run-eval.js path.json  # score one fixture file
 *
 * LLM-free: it scores a generated suite that is already IN the fixture. To grade
 * a fresh model run, drop its output into a fixture's "generatedSuite".
 */
const fs = require('fs');
const path = require('path');
const { evaluate } = require('./scorer.js');

function loadFixtures(argPath) {
  if (argPath) return [argPath];
  const dir = path.join(__dirname, 'fixtures');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f));
}

function pct(v) { return v == null ? ' n/a' : `${(v * 100).toFixed(0)}%`.padStart(4); }

function main() {
  const files = loadFixtures(process.argv[2]);
  if (!files.length) { console.error('No fixtures found in eval/fixtures/.'); process.exit(2); }

  let anyFail = false;
  console.log('\nQAtalyst generator eval\n' + '='.repeat(60));
  console.log(['fixture'.padEnd(14), 'req'.padStart(5), 'grnd'.padStart(5), 'dup'.padStart(5), 'prec'.padStart(5), 'rec'.padStart(5), 'score'.padStart(6), '  verdict'].join(' '));
  console.log('-'.repeat(60));

  for (const file of files) {
    let fixture;
    try { fixture = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { console.error(`  ✗ ${path.basename(file)}: unreadable (${e.message})`); anyFail = true; continue; }

    const r = evaluate(fixture);
    if (!r.pass) anyFail = true;
    console.log([
      (r.key || path.basename(file)).slice(0, 14).padEnd(14),
      pct(r.requirementCoverage),
      pct(r.groundingValidity),
      pct(r.duplicateRate),
      pct(r.precision),
      pct(r.recall),
      String(r.score).padStart(6),
      r.pass ? '  ✅ PASS' : '  ❌ FAIL'
    ].join(' '));
    if (!r.pass) r.failures.forEach(f => console.log(`                 └─ ${f}`));
    if (r.requirementDetail && r.requirementDetail.uncovered && r.requirementDetail.uncovered.length) {
      const u = r.requirementDetail.uncovered.slice(0, 5).map(x => x.text.slice(0, 60));
      console.log(`                 uncovered reqs: ${u.join(' | ')}`);
    }
  }

  console.log('='.repeat(60) + '\n');
  process.exit(anyFail ? 1 : 0);
}

main();
