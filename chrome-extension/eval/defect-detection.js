#!/usr/bin/env node
/**
 * §15.4 — measure DEFECT DETECTION, not similarity or apparent coverage.
 *
 * Every other metric in this repo asks whether a suite looks right. This asks
 * the only question that matters: given a specific defect, would any case in the
 * suite fail? A test earns credit only when it both exercises the defective
 * behaviour AND asserts an outcome that would differ on the broken build —
 * "verify it works correctly" earns nothing, which is the point.
 *
 * ponytail: static analysis of the ASSERTION against a labelled symptom, not
 * execution. Real detection requires running both builds through a companion
 * runner (fix2.md §15.4); this is the harness those results would slot into, and
 * it is deliberately labelled as an estimate everywhere it reports.
 */
const fs = require('fs');
const path = require('path');

/** Does this case both reach the defect and assert something that would differ? */
function detects(testCase, defect) {
  const steps = Array.isArray(testCase.steps) ? testCase.steps : [];
  const reach = [testCase.title, testCase.description, testCase.preconditions, ...steps]
    .filter(Boolean).join(' ').toLowerCase();
  const assertion = String(testCase.expected_result || testCase.expectedResult || '').toLowerCase();

  // A vague assertion cannot distinguish the correct build from the broken one.
  if (!assertion || /^(it )?works( correctly| as expected)?\.?$/.test(assertion.trim())) return false;
  if (/\b(works? (?:correctly|fine|as expected)|is (?:correct|fine|ok)|behaves? (?:correctly|properly))\b/.test(assertion)
      && assertion.length < 60) return false;

  const refs = defect.detectedBy.mustReference || [];
  const reachesIt = refs.every(r => new RegExp(r, 'i').test(reach));
  if (!reachesIt) return false;

  return new RegExp(defect.detectedBy.mustAssert, 'i').test(assertion);
}

function scoreDetection(fixture, suiteKey = 'generatedSuite') {
  const suite = fixture[suiteKey] || [];
  const defects = fixture.defects || [];
  const rows = defects.map(d => {
    const catchers = suite.filter(tc => detects(tc, d));
    return { id: d.id, description: d.description, detected: catchers.length > 0,
             by: catchers.map(c => c.id || c.title) };
  });
  const detected = rows.filter(r => r.detected).length;
  return {
    key: fixture.key, suite: suiteKey, total: defects.length, detected,
    rate: defects.length ? Math.round((detected / defects.length) * 100) : 0,
    missed: rows.filter(r => !r.detected), rows,
    suiteSize: suite.length
  };
}

function main() {
  const dir = path.join(__dirname, 'fixtures');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => path.join(dir, f));

  console.log('\n§15.4 Defect-detection benchmark (static estimate — not execution)');
  console.log('='.repeat(72));
  let anyFail = false;

  for (const file of files) {
    const fixture = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!fixture.defects) continue;

    const real = scoreDetection(fixture, 'generatedSuite');
    console.log(`\n${real.key}: ${real.detected}/${real.total} defects detected by ${real.suiteSize} case(s) — ${real.rate}%`);
    for (const m of real.missed) console.log(`   ✗ undetected: ${m.id} — ${m.description}`);
    for (const r of real.rows.filter(x => x.detected)) console.log(`   ✓ ${r.id} ← ${r.by.join(', ')}`);
    if (real.rate < 100) anyFail = true;

    // A vague suite must earn NO credit — that is the control.
    if (fixture.vagueSuite) {
      const vague = scoreDetection(fixture, 'vagueSuite');
      console.log(`\n   control — vague suite (${vague.suiteSize} cases): ${vague.detected}/${vague.total} detected`);
      if (vague.detected > 0) {
        console.log('   ⚠️  a vague suite earned detection credit — the scorer is too permissive.');
        anyFail = true;
      } else {
        console.log('   ✅ "works correctly" earns no detection credit, as it must.');
      }
    }
  }

  console.log('\n' + '='.repeat(72));
  console.log('Detection, false alarms and execution cost are reported separately by design:');
  console.log('a smaller suite is better ONLY if it preserves the required detection.\n');
  process.exit(anyFail && process.argv.includes('--strict') ? 1 : 0);
}

if (require.main === module) main();
module.exports = { detects, scoreDetection };
