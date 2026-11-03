#!/usr/bin/env node
/**
 * Live-loop eval: run the real planner on every fixture that carries a ticket and
 * a crawl, with a compliant scripted model (see loop-harness.js), and report the
 * acceptance-criteria coverage the loop reaches before it stops.
 */
const fs = require('fs');
const path = require('path');
const { runLoop } = require('./loop-harness.js');

(async () => {
  const dir = path.join(__dirname, 'fixtures');
  let failed = 0;
  console.log('QAtalyst live-loop eval (compliant scripted model)');
  console.log('='.repeat(72));
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.json'))) {
    const fx = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!fx.ticket || !fx.knowledgeGraph) continue;
    for (const batchSize of [1, 5]) {
      const r = await runLoop(fx, { batchSize });
      const ok = r.acCovered === r.acTotal && r.stopReason === 'complete';
      if (!ok) failed++;
      console.log(`${f.padEnd(26)} batch ${batchSize}  AC ${r.acCovered}/${r.acTotal}  tests ${r.tests}  ` +
        `steps ${r.steps}  stop ${r.stopReason}  ${ok ? '✅' : '❌'}`);
      for (const u of r.uncovered) console.log(`    uncovered: ${u.slice(0, 90)}`);
    }
  }
  console.log('='.repeat(72));
  process.exitCode = failed ? 1 : 0;
})();
