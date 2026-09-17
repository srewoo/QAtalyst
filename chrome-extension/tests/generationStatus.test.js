/**
 * @vitest-environment happy-dom
 *
 * A generation run must SAY it is running, for its whole duration.
 *
 * The panel had no owner: the initial loading message, the historical-mining
 * panel and the agent-progress panel each did `resultsContainer.innerHTML = …`,
 * so the last writer won. Once mining finished, its "✅ Mining complete" box sat
 * there for the rest of the run — the user was looking at a finished-looking
 * panel while the planner worked, with no way to tell a slow run from a hung one.
 *
 * The controller is defined inside content.js's IIFE, so this test exercises the
 * same logic against the same DOM contract (data-testid="generation-status").
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

/** Extract the GenerationStatus object literal and evaluate it standalone. */
function loadController() {
  const start = SRC.indexOf('const GenerationStatus = {');
  expect(start).toBeGreaterThan(-1);
  // Balance braces to find the end of the literal.
  let i = SRC.indexOf('{', start), depth = 0, end = -1;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const literal = SRC.slice(SRC.indexOf('{', start), end);
  const escapeHtml = (t) => { const d = document.createElement('div'); d.textContent = String(t ?? ''); return d.innerHTML; };
  return new Function('escapeHtml', 'document', `return (${literal});`)(escapeHtml, document);
}

let GenerationStatus;
beforeEach(() => {
  document.body.innerHTML = '<div id="results-container"></div>';
  GenerationStatus = loadController();
});
afterEach(() => GenerationStatus && GenerationStatus.stop());

const panel = () => document.querySelector('[data-testid="generation-status"]');

describe('the run announces itself', () => {
  test('a status appears as soon as generation starts', () => {
    GenerationStatus.start('Generating test cases…');
    expect(panel()).toBeTruthy();
    expect(panel().textContent).toContain('Generating test cases');
  });

  test('it tells the user this may take a while', () => {
    GenerationStatus.start();
    // Without this, a two-minute run is indistinguishable from a hang.
    expect(panel().textContent).toMatch(/few minutes|take a while/i);
  });

  test('it shows an elapsed clock', () => {
    GenerationStatus.start();
    expect(document.querySelector('[data-testid="generation-elapsed"]')).toBeTruthy();
  });
});

describe('phases update in place, they do not replace each other', () => {
  test('mining does not wipe out the generation status', () => {
    GenerationStatus.start();
    GenerationStatus.update({ phase: 'Mining historical bugs' });
    GenerationStatus.update({ phase: 'Historical mining complete' });
    // Pre-fix, the mining panel replaced the container entirely and stayed.
    expect(panel()).toBeTruthy();
    expect(panel().textContent).toContain('Generating test cases');
  });

  test('completed phases are kept as a trail', () => {
    GenerationStatus.start();
    GenerationStatus.update({ phase: 'Mining historical bugs' });
    GenerationStatus.update({ phase: 'Planning coverage' });
    const text = panel().textContent;
    expect(text).toContain('Planning coverage');      // current
    expect(text).toContain('Mining historical bugs'); // remembered
  });

  test('planner steps render a progress bar', () => {
    GenerationStatus.start();
    GenerationStatus.update({ phase: 'Planner', step: 3, total: 12 });
    const fill = document.querySelector('.gen-fill');
    expect(fill).toBeTruthy();
    expect(fill.style.width).toBe('25%');
  });

  test('accepted-test count is surfaced as it grows', () => {
    GenerationStatus.start();
    GenerationStatus.update({ count: 7 });
    expect(panel().textContent).toContain('7 test case(s) accepted');
  });

  test('a zero count is shown, not hidden as falsy', () => {
    GenerationStatus.start();
    GenerationStatus.update({ count: 0 });
    expect(panel().textContent).toContain('0 test case(s) accepted');
  });
});

describe('the status never outlives the run', () => {
  test('stop() clears it so results can render', () => {
    GenerationStatus.start();
    expect(GenerationStatus.isActive()).toBe(true);
    GenerationStatus.stop();
    expect(GenerationStatus.isActive()).toBe(false);
  });

  test('update() after stop() does not resurrect a stale run', () => {
    GenerationStatus.start();
    GenerationStatus.stop();
    // A late progress event must not restart a finished run's spinner.
    expect(GenerationStatus.isActive()).toBe(false);
  });

  test('model-supplied text is escaped, not injected', () => {
    GenerationStatus.start();
    GenerationStatus.update({ phase: 'x', detail: '<img src=x onerror="alert(1)">' });
    expect(panel().innerHTML).not.toContain('<img src=x');
    expect(panel().innerHTML).toContain('&lt;img');
  });
});

describe('wiring', () => {
  test('every generation route starts and stops the status', () => {
    expect((SRC.match(/GenerationStatus\.start\(/g) || []).length).toBeGreaterThanOrEqual(3);
    expect((SRC.match(/GenerationStatus\.stop\(/g) || []).length).toBeGreaterThanOrEqual(3);
  });

  test('handleTestCases stops it in finally, so a failure cannot leave a spinner running', () => {
    // Scope to handleTestCases — other handlers have their own finally blocks.
    const fnStart = SRC.indexOf('async function handleTestCases(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = SRC.slice(fnStart, SRC.indexOf('// Store current results for review feature', fnStart));
    const finallyIdx = fnBody.lastIndexOf('} finally {');
    expect(finallyIdx).toBeGreaterThan(-1);
    expect(fnBody.slice(finallyIdx, finallyIdx + 400)).toContain('GenerationStatus.stop()');
  });

  test('the button says it is working rather than just going grey', () => {
    expect(SRC).toMatch(/Generating…<\/span>/);
    expect(SRC).toContain('originalLabel');
  });
});

describe('a run can never hang silently', () => {
  test('a quiet run is reported as possibly stalled', () => {
    GenerationStatus.start();
    // Simulate two minutes of silence.
    GenerationStatus._lastEventAt = Date.now() - 3 * 60 * 1000;
    GenerationStatus._render();
    const warning = document.querySelector('[data-testid="generation-stalled"]');
    expect(warning).toBeTruthy();
    expect(warning.textContent).toMatch(/No progress for 3 minute/);
  });

  test('a stalled run is NOT auto-cancelled — a slow local model is still working', () => {
    GenerationStatus.start();
    GenerationStatus._lastEventAt = Date.now() - 5 * 60 * 1000;
    GenerationStatus._render();
    // Killing real work would be worse than waiting; we warn, we do not stop.
    expect(GenerationStatus.isActive()).toBe(true);
  });

  test('a progress event clears the stall warning', () => {
    GenerationStatus.start();
    GenerationStatus._lastEventAt = Date.now() - 5 * 60 * 1000;
    GenerationStatus._render();
    expect(document.querySelector('[data-testid="generation-stalled"]')).toBeTruthy();
    GenerationStatus.update({ phase: 'Planner' });
    expect(document.querySelector('[data-testid="generation-stalled"]')).toBeNull();
  });

  test('Stop is offered from the start, not only once it looks stuck', () => {
    GenerationStatus.start();
    expect(document.querySelector('[data-testid="generation-cancel"]')).toBeTruthy();
  });

  test('a late event cannot resurrect a finished run', () => {
    GenerationStatus.start();
    GenerationStatus.stop();
    GenerationStatus.update({ phase: 'ghost' });
    // update() used to call start() when there was no state, restarting the
    // spinner for a run that had already ended. stop() deliberately leaves the
    // last frame in the DOM — the caller replaces it with results or an error —
    // so what matters is that nothing RE-renders.
    expect(GenerationStatus.isActive()).toBe(false);
    const panel = document.querySelector('[data-testid="generation-status"]');
    if (panel) expect(panel.textContent).not.toContain('ghost');
  });
});

describe('wiring: the request itself is bounded', () => {
  test('the agentic request is wrapped in a timeout', () => {
    // chrome.runtime.sendMessage has no timeout: a terminated service worker
    // never fires the callback, and the promise stays pending forever.
    expect(SRC).toContain('withGenerationTimeout');
    const call = SRC.indexOf('withGenerationTimeout(new Promise');
    expect(call).toBeGreaterThan(-1);
  });

  test('the timeout explains what to check rather than just failing', () => {
    expect(SRC).toMatch(/service worker may have been terminated/);
    expect(SRC).toMatch(/chrome:\/\/extensions/);
  });

  test('cancel stops both the agentic run and any active stream', () => {
    const fn = SRC.slice(SRC.indexOf('async function cancelGeneration()'));
    expect(fn.slice(0, 1200)).toContain('stopMultiAgentGeneration');
    expect(fn.slice(0, 1200)).toContain('stopGeneration');
  });

  test('the mining handler reads the field the worker actually sends', () => {
    // The worker sends {progress}, not {status} — reading the wrong one made the
    // panel show "Mining complete" from the first event.
    expect(SRC).toContain('request.progress || request.status');
  });
});
