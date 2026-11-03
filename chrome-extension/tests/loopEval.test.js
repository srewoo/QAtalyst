/**
 * The planner must keep working until every acceptance criterion is covered.
 *
 * Regression: coverage was re-measured only every 5 accepted tests, so the
 * controller kept aiming at a criterion it had already covered; the rewritten
 * test was a duplicate, nothing new was accepted, the snapshot never refreshed,
 * and RE-11256 stopped at 2/12 criteria ("no novel scenarios").
 */
const { runLoop } = require('../eval/loop-harness.js');
const fixture = require('../eval/fixtures/re-11256.json');

describe('live planner loop on RE-11256 (compliant model)', () => {
  test.each([1, 5])('batch size %i covers every acceptance criterion and stops as complete', async (batchSize) => {
    const r = await runLoop(fixture, { batchSize });
    expect(r.uncovered).toEqual([]);
    expect(r.acCovered).toBe(r.acTotal);
    expect(r.stopReason).toBe('complete');
  });
});
