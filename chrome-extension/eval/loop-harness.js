/**
 * loop-harness.js — drive the REAL planner loop (PlannerAgent + tools + gate +
 * coverage) on a fixture ticket and crawl, with a scripted model.
 *
 * run-eval.js scores a frozen suite recorded from some past run; it cannot tell
 * whether today's loop would keep going until every criterion is covered. This
 * can. The scripted model is "compliant": for an acceptance-criterion focus it
 * writes one grounded test that restates the criterion and names real entities
 * from the crawl; for any other focus it writes a test about the next entity.
 * Whatever the loop then fails to cover is the controller's or the gate's fault,
 * not the model's.
 */
const path = require('path');
const EXT = path.join(__dirname, '..');
const { PlannerAgent } = require(path.join(EXT, 'agent-loop.js'));
const { AgentToolRegistry } = require(path.join(EXT, 'agent-tools.js'));
const { AcceptanceGate } = require(path.join(EXT, 'acceptance-gate.js'));
const { GroundedVerifier } = require(path.join(EXT, 'grounded-verifier.js'));
const SemanticDuplicateDetector = require(path.join(EXT, 'semantic-duplicate-detector.js'));
const CoverageMapper = require(path.join(EXT, 'coverage-mapper.js'));
const { deriveDistribution, allocateCounts } = require(path.join(EXT, 'dynamic-distribution.js'));

function entitiesOf(kg) {
  const pages = Array.isArray(kg.pages) ? kg.pages : Object.values(kg.pages || {});
  const buttons = [], apis = [];
  for (const p of pages) {
    for (const f of p.features || []) if (f.type === 'button' && f.text) buttons.push(f.text);
    for (const a of p.apis || []) apis.push(`${a.method || 'GET'} ${a.endpoint}`);
  }
  return { buttons, apis, url: pages[0] && pages[0].url };
}

function compliantModel(kg) {
  const ent = entitiesOf(kg);
  let n = 0;
  return async (system) => {
    if (!system.includes('generating GROUNDED')) return 'not json'; // planner decisions → deterministic controller
    const m = system.match(/focused on: (.*)\.\n/);
    const focus = (m && m[1]) || '';
    const cat = (system.match(/exactly \d+ (\w+) test cases/) || [])[1] || 'Positive';
    const criterion = (focus.match(/^Acceptance criterion: (.*)$/) || [])[1];
    n++;
    const button = ent.buttons[n % Math.max(1, ent.buttons.length)] || 'Submit';
    const api = ent.apis[n % Math.max(1, ent.apis.length)] || '';
    const subject = criterion || `${button} behaves as specified (${focus || 'core behaviour'})`;
    return JSON.stringify({ tests: [{
      title: subject.slice(0, 140), category: cat, priority: 'P1',
      preconditions: `A signed-in user on ${ent.url}`,
      steps: [`Open ${ent.url}`, `Click "${button}"`, api ? `Observe the ${api} request` : 'Observe the page'],
      expected_result: subject
    }] });
  };
}

async function runLoop(fixture, budget = {}) {
  const kg = fixture.knowledgeGraph;
  const ticket = fixture.ticket;
  const callAI = compliantModel(kg);
  const settings = { llmProvider: 'test' };
  const gate = new AcceptanceGate({ knowledgeGraph: kg, ticketData: ticket, deps: { GroundedVerifier, SemanticDuplicateDetector } });
  const tools = new AgentToolRegistry({ callAI, settings, ticketData: ticket, knowledgeGraph: kg, CoverageMapper,
    coverageMapper: new CoverageMapper(kg), verifierIndex: new GroundedVerifier(kg).index,
    getAcceptedTests: () => gate.getAccepted() });
  const planner = new PlannerAgent({ callAI, settings, tools, gate, ticketData: ticket,
    distribution: deriveDistribution(ticket), allocateCounts,
    budget: { maxSteps: 40, maxTests: 30, coverageTarget: 80, maxNoProgress: 8, batchSize: 1, ...budget } });
  const result = await planner.run();
  const items = CoverageMapper.extractRequirementItems(ticket);
  const ac = CoverageMapper.mapAcceptanceCriteria(result.testCases, items);
  return { stopReason: result.stopReason, tests: result.testCases.length, steps: result.stats.steps,
    acCovered: ac.covered, acTotal: ac.total, uncovered: ac.uncovered.map(u => u.text) };
}

module.exports = { runLoop, compliantModel };
