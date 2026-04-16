// Multi-Agent Test Generation System
// Client-side agent orchestration for QAtalyst

// Import DuplicateDetector if available
// Check if DuplicateDetector is already defined (e.g., in service worker context)
if (typeof DuplicateDetector === 'undefined') {
  try {
    // Try to load the duplicate detector if it exists
    if (typeof require !== 'undefined') {
      DuplicateDetector = require('./duplicate-detector.js');
    } else if (typeof window !== 'undefined' && window.DuplicateDetector) {
      // Will be loaded via script tag in browser
      DuplicateDetector = window.DuplicateDetector;
    }
  } catch (e) {
    // Duplicate detector not available
    console.log('DuplicateDetector not available:', e.message);
  }
}

/**
 * Robust JSON parser that handles common AI-generated JSON errors
 * Including truncated responses from LLMs
 */
function parseRobustJSON(jsonString) {
  // Try direct parse first
  try {
    return JSON.parse(jsonString);
  } catch (e) {
    // Attempt to fix common issues
    let fixed = jsonString;

    // Remove trailing commas before } or ]
    fixed = fixed.replace(/,(\s*[}\]])/g, '$1');

    // Add missing commas between properties (common error)
    fixed = fixed.replace(/"\s*\n\s*"/g, '",\n"');

    // Fix missing commas after closing arrays/objects
    fixed = fixed.replace(/(\]|\})\s*\n\s*"/g, '$1,\n"');

    // Remove comments (if AI added them)
    fixed = fixed.replace(/\/\/.*/g, '');
    fixed = fixed.replace(/\/\*[\s\S]*?\*\//g, '');

    try {
      return JSON.parse(fixed);
    } catch (e2) {
      // Truncated array: [{...}, {...}, {incomplete...
      if (fixed.trim().startsWith('[')) {
        const completeObjects = extractCompleteObjectsFromArray(fixed);
        if (completeObjects.length > 0) {
          console.log(`[parseRobustJSON] Recovered ${completeObjects.length} complete objects from truncated array`);
          return completeObjects;
        }
      }

      // Truncated wrapper object: {"testCases": [{...}, {incomplete...
      // Extract the inner array value and salvage complete items from it
      const innerArrayMatch = fixed.match(/"testCases"\s*:\s*(\[[\s\S]*)/);
      if (innerArrayMatch) {
        const innerArray = innerArrayMatch[1];
        const completeObjects = extractCompleteObjectsFromArray(innerArray);
        if (completeObjects.length > 0) {
          console.log(`[parseRobustJSON] Recovered ${completeObjects.length} test cases from truncated wrapper`);
          return { testCases: completeObjects };
        }
      }

      // Last resort: try to find any complete JSON object
      const match = fixed.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch (e3) {
          throw new Error(`JSON parsing failed: ${e.message} at ${e2.message}`);
        }
      }
      throw e2;
    }
  }
}

/**
 * Extract complete JSON objects from a truncated array response
 * Handles cases like: [{...}, {...}, {incomplete...
 */
function extractCompleteObjectsFromArray(jsonString) {
  const objects = [];
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let objectStart = -1;

  for (let i = 0; i < jsonString.length; i++) {
    const char = jsonString[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\' && inString) {
      escapeNext = true;
      continue;
    }

    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }

    if (inString) continue;

    if (char === '{') {
      if (depth === 0) {
        objectStart = i;
      }
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && objectStart !== -1) {
        // Found a complete object
        const objectStr = jsonString.substring(objectStart, i + 1);
        try {
          const parsed = JSON.parse(objectStr);
          objects.push(parsed);
        } catch (parseErr) {
          // Skip malformed objects
          console.warn('[extractCompleteObjects] Skipping malformed object');
        }
        objectStart = -1;
      }
    }
  }

  return objects;
}

/**
 * Safely coerce any value to a string.
 * Arrays are joined; objects are JSON-serialised; null/undefined become ''.
 */
function toStr(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(toStr).join('\n');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

class AgentOrchestrator {
  constructor(settings, onProgress) {
    this.settings = settings;
    this.onProgress = onProgress;
    this.agents = this.initializeAgents();
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
    console.log('[ORCHESTRATOR] ⛔ Cancellation requested');
  }
  
  initializeAgents() {
    return [
      new ContextAnalysisAgent(),
      new RequirementAnalysisAgent(),
      new PositiveTestAgent(),
      new NegativeTestAgent(),
      new EdgeCaseAgent(),
      new RegressionTestAgent(),
      new IntegrationTestAgent(),
      new AIFeatureTestAgent(),
      new AccessibilityTestAgent(),
      new ReviewAgent()
    ];
  }
  
  async executeAgents(ticketData, analysisContext = null, appContext = null) {
    const results = {
      analysis: analysisContext || null,
      testCases: [],
      agentResults: {},
      statistics: {},
      appContext: appContext || null // Store app context in results
    };

    // Classify ticket complexity upfront — used by all agents for CoT depth + batch scaling
    const ticketComplexity = BaseAgent.calculateTicketComplexity(ticketData);
    results.complexity = ticketComplexity;
    console.log(`[ORCHESTRATOR] 🧮 Ticket complexity: ${ticketComplexity.level.toUpperCase()} (score: ${ticketComplexity.score})`, ticketComplexity.factors);

    // Check if we have knowledge graph to analyze
    if (appContext && appContext.knowledgeGraph) {
      console.log(`[ORCHESTRATOR] 📊 Knowledge graph available with ${Object.keys(appContext.knowledgeGraph.pages || {}).length} pages`);
    } else {
      console.log(`[ORCHESTRATOR] ℹ️ No knowledge graph available (running without crawled data)`);
    }

    // Detect AI features in ticket
    const aiDetection = AIFeatureTestAgent.detectAIFeatures(ticketData);
    if (aiDetection.isAIFeature) {
      console.log(`[ORCHESTRATOR] 🤖 AI features detected (${aiDetection.confidence} confidence):`, aiDetection.keywords);
      // Enable AIFeatureTestAgent by setting flag
      const aiAgent = this.agents.find(a => a instanceof AIFeatureTestAgent);
      if (aiAgent) {
        aiAgent.hasAIFeatures = true;
      }
    } else {
      console.log(`[ORCHESTRATOR] ℹ️ No AI features detected - AIFeatureTestAgent will be skipped`);
    }

    const enabledAgents = this.agents.filter(agent => agent.isEnabled(this.settings));

    // Classify agents into 3 phases
    const analysisAgents = enabledAgents.filter(a =>
      a instanceof ContextAnalysisAgent || a instanceof RequirementAnalysisAgent
    );
    const testAgents = enabledAgents.filter(a =>
      a instanceof PositiveTestAgent || a instanceof NegativeTestAgent ||
      a instanceof EdgeCaseAgent || a instanceof RegressionTestAgent ||
      a instanceof IntegrationTestAgent || a instanceof AIFeatureTestAgent ||
      a instanceof AccessibilityTestAgent
    );
    const reviewAgents = enabledAgents.filter(a => a instanceof ReviewAgent);
    const totalSteps = analysisAgents.length + testAgents.length + reviewAgents.length;
    let stepCounter = 0;

    // ═══ PHASE 1: Analysis agents (sequential — downstream agents depend on their output) ═══
    console.log(`[ORCHESTRATOR] 📋 Phase 1: Running ${analysisAgents.length} analysis agents sequentially`);
    for (const agent of analysisAgents) {
      if (this.cancelled) { console.log('[ORCHESTRATOR] ⛔ Cancelled before analysis'); break; }
      stepCounter++;
      if (this.onProgress) {
        this.onProgress({ agent: agent.name, step: stepCounter, total: totalSteps, status: 'running', description: agent.description });
      }
      try {
        const agentResult = await agent.execute(ticketData, results, this.settings, appContext);
        results.agentResults[agent.name] = agentResult;
        if (agent instanceof ContextAnalysisAgent) {
          results.contextSummary = agentResult.summary;
          console.log(`[ORCHESTRATOR] 📝 Context summary created: ${agentResult.summary?.length || 0} chars`);
        } else if (agent instanceof RequirementAnalysisAgent) {
          results.analysis = agentResult;
        }
        if (this.onProgress) {
          this.onProgress({ agent: agent.name, step: stepCounter, total: totalSteps, status: 'completed', count: 0 });
        }
      } catch (error) {
        console.error(`Agent ${agent.name} failed:`, error);
        if (this.onProgress) {
          this.onProgress({ agent: agent.name, step: stepCounter, total: totalSteps, status: 'error', error: error.message });
        }
      }
    }

    // ═══ PHASE 2: Test generation agents (parallel — with cross-agent dedup) ═══
    if (!this.cancelled && testAgents.length > 0) {
      console.log(`[ORCHESTRATOR] 🚀 Phase 2: Running ${testAgents.length} test agents in parallel`);

      // Shared dedup list: all agents can read from this, and append after each batch.
      // This enables cross-agent deduplication during parallel execution.
      const sharedTestSummaries = [];

      // Snapshot results for all parallel agents (each gets its own copy to avoid race conditions)
      const resultsSnapshot = {
        analysis: results.analysis,
        testCases: [], // Each agent starts with empty testCases
        agentResults: { ...results.agentResults },
        contextSummary: results.contextSummary,
        appContext: results.appContext
      };

      // Report all test agents as running
      const testAgentStartStep = stepCounter + 1;
      testAgents.forEach((agent, i) => {
        if (this.onProgress) {
          this.onProgress({ agent: agent.name, step: testAgentStartStep + i, total: totalSteps, status: 'running', description: agent.description });
        }
      });

      // Launch all test agents concurrently with shared dedup context
      const parallelResults = await Promise.allSettled(
        testAgents.map(async (agent) => {
          // Each agent gets its own results copy but shares the dedup list
          const agentResults = { ...resultsSnapshot, testCases: [], _sharedTestSummaries: sharedTestSummaries };
          const agentResult = await agent.executeBatched(ticketData, agentResults, this.settings, appContext, {
            batches: 4,
            testsPerBatch: 3
          });

          // After agent completes, add its test summaries to shared list for cross-agent dedup
          if (Array.isArray(agentResult)) {
            agentResult.forEach(tc => {
              sharedTestSummaries.push(`[${agent.name}] ${tc.title || ''}: ${(tc.description || '').substring(0, 80)}`);
            });
          }

          return { agent, result: agentResult };
        })
      );

      // Collect results from all parallel agents
      parallelResults.forEach((outcome, i) => {
        stepCounter++;
        const agent = testAgents[i];
        if (outcome.status === 'fulfilled') {
          const { result } = outcome.value;
          results.agentResults[agent.name] = result;
          if (Array.isArray(result)) {
            results.testCases.push(...result);
          }
          if (this.onProgress) {
            this.onProgress({ agent: agent.name, step: testAgentStartStep + i, total: totalSteps, status: 'completed', count: Array.isArray(result) ? result.length : 0 });
          }
        } else {
          console.error(`Agent ${agent.name} failed:`, outcome.reason);
          if (this.onProgress) {
            this.onProgress({ agent: agent.name, step: testAgentStartStep + i, total: totalSteps, status: 'error', error: outcome.reason?.message || 'Unknown error' });
          }
        }
      });
      // Advance stepCounter past all test agents
      stepCounter = testAgentStartStep + testAgents.length - 1;
    }

    // Initial validation pass before the Review→Refine loop
    results.testCases = this.validateAndCleanTestCases(results.testCases, ticketData);

    // ═══ PHASE 3: Iterative Review → Refine loop (up to MAX_CYCLES) ═══
    // Stop conditions (checked before each Review call and after each Refine pass):
    //   a) avgSpecificityScore >= 65 AND no LOW_SPECIFICITY / LOW_EXECUTABILITY warnings
    //   b) Cancelled
    //   c) No improvement in the last cycle
    //   d) Max cycles reached
    const MAX_CYCLES = 3;
    const AVG_QUALITY_TARGET = 65; // avg specificityScore to aim for
    const PER_TEST_THRESHOLD = 65; // per-test threshold for "good enough"

    // Shared refinement agent — wired up once and reused across cycles
    const refinementAgent = new RefinementAgent();
    const boundAgent = this.agents.find(a => a.callAI && a.callAI !== BaseAgent.prototype.callAI);
    if (boundAgent) {
      refinementAgent.callAI = boundAgent.callAI;
      refinementAgent.settings = this.settings;
    }

    // Track suggestions already added to avoid cross-cycle duplicates
    const addedSuggestionTitles = new Set();
    // Track how many tests were "bad" in the previous cycle (for convergence check)
    let prevCycleLowCount = Infinity;

    for (let cycle = 1; cycle <= MAX_CYCLES; cycle++) {
      if (this.cancelled) { console.log('[ORCHESTRATOR] ⛔ Cancelled before review cycle'); break; }

      // ── Stop condition check ──
      const scores = results.testCases.map(tc => tc._specificityScore || 0);
      const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
      const lowQualityCount = results.testCases.filter(tc =>
        tc._qualityWarning === 'LOW_SPECIFICITY' || tc._executabilityWarning === 'LOW_EXECUTABILITY'
      ).length;

      console.log(`[ORCHESTRATOR] 📊 Cycle ${cycle} quality snapshot: avg=${avgScore.toFixed(1)}, low-quality=${lowQualityCount}/${results.testCases.length}`);

      if (avgScore >= AVG_QUALITY_TARGET && lowQualityCount === 0) {
        console.log(`[ORCHESTRATOR] ✅ Quality target reached before cycle ${cycle} — skipping review`);
        break;
      }

      // ── Step 1: Run ReviewAgent ──
      if (reviewAgents.length > 0 && !this.cancelled) {
        const reviewAgent = reviewAgents[0];
        stepCounter++;
        if (this.onProgress) {
          this.onProgress({
            agent: reviewAgent.name,
            step: stepCounter,
            total: totalSteps + MAX_CYCLES * 2,
            status: 'running',
            description: `Review cycle ${cycle}/${MAX_CYCLES}: checking quality and alignment`
          });
        }

        try {
          const reviewResult = await reviewAgent.execute(ticketData, results, this.settings, appContext);
          results.agentResults[`${reviewAgent.name}_cycle${cycle}`] = reviewResult;
          results.review = reviewResult;

          // Cycle 1: apply all actions (remove flagged, add suggested shells, flag rewrites)
          // Cycles 2+: skip removal (avoid culling already-refined tests) but apply rewrites
          if (reviewResult) {
            // Remove tests (cycle 1 only — prevents aggressive re-removal of refined tests)
            if (cycle === 1 && Array.isArray(reviewResult.testsToRemove) && reviewResult.testsToRemove.length > 0) {
              const idsToRemove = new Set(reviewResult.testsToRemove.map(t => t.id));
              const before = results.testCases.length;
              results.testCases = results.testCases.filter(tc => !idsToRemove.has(tc.id));
              console.log(`[ORCHESTRATOR] 🗑️ Cycle ${cycle} review: removed ${before - results.testCases.length} flagged tests`);
            }

            // Add suggested test shells (deduplicated across cycles)
            if (Array.isArray(reviewResult.suggestedTests)) {
              const shells = reviewResult.suggestedTests
                .filter(s => s.title && (s.rationale || s.storyReference) && !addedSuggestionTitles.has(s.title))
                .map((s, i) => {
                  addedSuggestionTitles.add(s.title);
                  return {
                    id: `TC-SUG-C${cycle}-${String(i + 1).padStart(3, '0')}`,
                    title: s.title,
                    category: s.category || 'Positive',
                    priority: s.priority || 'P1',
                    storyReference: s.rationale || s.storyReference || '',
                    description: s.rationale || s.title,
                    preconditions: '',
                    steps: [],
                    expected_result: '',
                    test_data: '',
                    _needsRefinement: true
                  };
                });
              if (shells.length > 0) {
                results.testCases.push(...shells);
                console.log(`[ORCHESTRATOR] ➕ Cycle ${cycle} review: added ${shells.length} new test shells`);
              }
            }

            // Flag tests for targeted rewrite based on review feedback
            if (Array.isArray(reviewResult.testsToRewrite) && reviewResult.testsToRewrite.length > 0) {
              const rewriteMap = new Map(reviewResult.testsToRewrite.map(t => [t.id, t]));
              results.testCases.forEach(tc => {
                const rw = rewriteMap.get(tc.id);
                if (rw) {
                  tc._reviewFeedback = rw.improvementInstructions || rw.issues || '';
                  tc._needsRefinement = true;
                  tc._specificityScore = Math.min(tc._specificityScore || 50, 40);
                }
              });
              console.log(`[ORCHESTRATOR] ✏️ Cycle ${cycle} review: flagged ${reviewResult.testsToRewrite.length} tests for rewrite`);
            }
          }

          if (this.onProgress) {
            this.onProgress({ agent: reviewAgent.name, step: stepCounter, total: totalSteps + MAX_CYCLES * 2, status: 'completed', count: 0 });
          }
        } catch (err) {
          console.error(`[ORCHESTRATOR] Review cycle ${cycle} failed (non-critical):`, err.message);
        }

        // Re-score after applying review actions
        results.testCases = this.validateAndCleanTestCases(results.testCases, ticketData);
      }

      // ── Step 2: Refine poor-quality tests ──
      if (this.cancelled) break;

      const testsToRefine = results.testCases.filter(tc =>
        tc._needsRefinement ||
        tc._qualityWarning === 'LOW_SPECIFICITY' ||
        tc._executabilityWarning === 'LOW_EXECUTABILITY' ||
        (tc._specificityScore || 0) < PER_TEST_THRESHOLD
      );

      if (testsToRefine.length === 0) {
        console.log(`[ORCHESTRATOR] ✅ No tests need refinement in cycle ${cycle} — stopping`);
        break;
      }

      // Convergence guard: if the count hasn't improved since last cycle, stop
      if (testsToRefine.length >= prevCycleLowCount) {
        console.log(`[ORCHESTRATOR] ⚠️ No improvement in low-quality count (${testsToRefine.length}), stopping refinement`);
        break;
      }
      prevCycleLowCount = testsToRefine.length;

      console.log(`[ORCHESTRATOR] 🔄 Cycle ${cycle}/${MAX_CYCLES} refine: ${testsToRefine.length} tests below threshold`);
      stepCounter++;
      if (this.onProgress) {
        this.onProgress({
          agent: 'Refinement',
          step: stepCounter,
          total: totalSteps + MAX_CYCLES * 2,
          status: 'running',
          description: `Refine cycle ${cycle}: improving ${testsToRefine.length} tests`
        });
      }

      try {
        const refined = await refinementAgent.refineTests(testsToRefine, ticketData, results, this.settings, appContext, cycle);

        if (refined && refined.length > 0) {
          const refinedIds = new Set(testsToRefine.map(tc => tc.id));
          results.testCases = results.testCases.filter(tc => !refinedIds.has(tc.id));
          results.testCases.push(...refined);
          console.log(`[ORCHESTRATOR] ✅ Cycle ${cycle}: refined ${refined.length} tests`);
        } else {
          console.log(`[ORCHESTRATOR] ⚠️ Cycle ${cycle}: refinement returned no improvements, stopping`);
          if (this.onProgress) {
            this.onProgress({ agent: 'Refinement', step: stepCounter, total: totalSteps + MAX_CYCLES * 2, status: 'completed', count: 0 });
          }
          break;
        }

        if (this.onProgress) {
          this.onProgress({ agent: 'Refinement', step: stepCounter, total: totalSteps + MAX_CYCLES * 2, status: 'completed', count: refined.length });
        }
      } catch (err) {
        console.error(`[ORCHESTRATOR] Refinement cycle ${cycle} failed (non-critical):`, err.message);
        break;
      }

      // Re-score after refinement
      results.testCases = this.validateAndCleanTestCases(results.testCases, ticketData);
    }

    // Calculate statistics
    results.statistics = this.calculateStatistics(results.testCases);

    return results;
  }

  /**
   * Validate test cases post-generation:
   * - Ensure storyReference is populated and meaningful
   * - Flag vague descriptions and steps
   * - Ensure expected results are specific
   */
  validateAndCleanTestCases(testCases, ticketData) {
    const ticketKey = ticketData?.key || ticketData?.ticketKey || 'Unknown';
    const genericRefs = ['user story', 'the story', 'story requirement', 'requirement', 'n/a', 'na', 'none', 'general'];
    let fixedCount = 0;

    return testCases.map((tc, index) => {
      // JSON schema validation: ensure all required fields exist with correct types
      const requiredDefaults = {
        id: () => `TC-${(tc.category || 'GEN').substring(0, 3).toUpperCase()}-${String(index + 1).padStart(3, '0')}`,
        title: () => (tc.description || '').substring(0, 80) || 'Untitled Test Case',
        category: () => 'Positive',
        priority: () => 'P2',
        description: () => tc.title || '',
        steps: () => [],
        expected_result: () => '',
        test_data: () => ''
      };

      for (const [field, defaultFn] of Object.entries(requiredDefaults)) {
        if (tc[field] === undefined || tc[field] === null) {
          tc[field] = defaultFn();
          tc._autoFilled = tc._autoFilled || [];
          tc._autoFilled.push(field);
        }
      }

      // Fix missing or generic storyReference
      const ref = (tc.storyReference || '').trim().toLowerCase();
      if (!ref || ref.length < 10 || genericRefs.some(g => ref === g)) {
        // Attempt to derive from description or title
        const derivedRef = this.deriveStoryReference(tc, ticketData);
        if (derivedRef) {
          tc.storyReference = derivedRef;
          fixedCount++;
        } else {
          tc.storyReference = `${ticketKey}: ${tc.title || 'Untitled test'}`;
          fixedCount++;
        }
      }

      // Ensure steps is always an array of strings
      if (!Array.isArray(tc.steps)) {
        tc.steps = tc.steps ? [toStr(tc.steps)] : [];
      } else {
        tc.steps = tc.steps.map(toStr);
      }

      // Coerce all string fields — AI can return objects/arrays instead of strings
      tc.title = toStr(tc.title);
      tc.description = toStr(tc.description);
      tc.preconditions = toStr(tc.preconditions);
      tc.test_data = toStr(tc.test_data);
      tc.category = toStr(tc.category);
      tc.priority = toStr(tc.priority);

      // Normalize expected_result / expectedResult
      if (!tc.expected_result && tc.expectedResult) {
        tc.expected_result = toStr(tc.expectedResult);
      } else {
        tc.expected_result = toStr(tc.expected_result);
      }

      // Specificity scoring
      tc._specificityScore = this.calculateSpecificityScore(tc);
      if (tc._specificityScore < 40) {
        tc._qualityWarning = 'LOW_SPECIFICITY';
      }

      // Executability scoring — separate dimension from specificity
      tc._executabilityScore = this.calculateExecutabilityScore(tc);
      if (tc._executabilityScore < 40) {
        tc._executabilityWarning = 'LOW_EXECUTABILITY';
      }

      return tc;
    });
  }

  /**
   * Calculate executability score for a test case (0-100).
   * Measures whether a manual tester can actually run the test as written:
   *   - Step verbs are actionable (click, enter, navigate, …)
   *   - expected_result contains a measurable assertion
   *   - preconditions name a concrete user/system state
   *   - step count is adequate (3-10 steps is ideal)
   */
  calculateExecutabilityScore(tc) {
    let score = 0;

    // ── SECTION 1: Step verb actionability (0–35 points) ──
    const ACTIONABLE = /^\s*(click|tap|enter|type|navigate|go to|open|select|check|uncheck|verify|assert|confirm|submit|upload|download|drag|hover|press|scroll|clear|search|filter|expand|collapse|fill|choose|login|logout|sign in|sign out|refresh|switch to|copy|paste)\b/i;
    const steps = Array.isArray(tc.steps) ? tc.steps.map(toStr) : [];
    if (steps.length > 0) {
      const actionableCount = steps.filter(s => ACTIONABLE.test(s.trim())).length;
      score += Math.round((actionableCount / steps.length) * 35);
    }

    // ── SECTION 2: Expected result has a measurable assertion (0–30 points) ──
    const er = toStr(tc.expected_result).toLowerCase();
    const ASSERTION_KEYWORDS = [
      'displays', 'shows', 'appears', 'redirects', 'navigates', 'returns', 'toast',
      'message', 'error', 'success', 'contains', 'confirms', 'sends', 'changes',
      'updates', 'closes', 'opens', 'loads', 'visible', 'hidden', 'enabled', 'disabled',
    ];
    const VAGUE_EXPECTED = [
      'works correctly', 'responds appropriately', 'behaves as expected',
      'functions correctly', 'as expected', 'should work', 'correctly',
    ];
    const hasAssertion = ASSERTION_KEYWORDS.some(kw => er.includes(kw));
    const isVague = VAGUE_EXPECTED.some(v => er.includes(v));
    if (hasAssertion && !isVague) score += 30;
    else if (hasAssertion) score += 15;
    else if (!isVague && er.length > 20) score += 10;

    // ── SECTION 3: Preconditions name a concrete state (0–20 points) ──
    const pre = toStr(tc.preconditions).toLowerCase();
    const CONCRETE_PRE = ['role', 'admin', 'user ', '@', 'page', '/dashboard', '/login',
      'logged in as', 'with ', 'account', 'has ', 'existing'];
    const concreteCount = CONCRETE_PRE.filter(indicator => pre.includes(indicator)).length;
    if (concreteCount >= 3) score += 20;
    else if (concreteCount >= 2) score += 15;
    else if (concreteCount >= 1 && pre.length >= 20) score += 10;
    // empty/vague preconditions get 0

    // ── SECTION 4: Step count adequacy (0–15 points) ──
    const n = steps.length;
    if (n >= 3 && n <= 10) score += 15;
    else if (n >= 2 && n <= 12) score += 8;
    // < 2 or > 12 gets 0

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Calculate specificity score for a test case (0-100).
   * Higher = more specific and executable.
   */
  calculateSpecificityScore(tc) {
    let score = 50; // Base score

    const allText = [
      toStr(tc.title),
      toStr(tc.description),
      toStr(tc.expected_result),
      ...(Array.isArray(tc.steps) ? tc.steps.map(toStr) : []),
      toStr(tc.test_data)
    ].join(' ');

    const allTextLower = allText.toLowerCase();

    // Penalize vague words (-5 each)
    const vagueWords = [
      'appropriate', 'correctly', 'properly', 'as expected', 'should work',
      'works correctly', 'relevant', 'valid data', 'invalid data',
      'enter valid', 'enter invalid', 'proper error', 'proper message',
      'the system should', 'works as expected', 'functions correctly'
    ];
    vagueWords.forEach(w => {
      if (allTextLower.includes(w)) score -= 5;
    });

    // Reward concrete patterns (+5 each)
    // Quoted strings in steps (exact values)
    const quotedValues = allText.match(/['"][^'"]{2,}['"]/g);
    if (quotedValues && quotedValues.length > 0) score += Math.min(quotedValues.length * 3, 15);

    // Specific numbers/amounts
    if (/\d+/.test(tc.test_data || '')) score += 5;

    // Email patterns in test data
    if (/\S+@\S+\.\S+/.test(allText)) score += 5;

    // URL patterns
    if (/https?:\/\/\S+/.test(allText)) score += 3;

    // Specific field names in quotes
    const fieldRefs = allText.match(/['"][A-Z][a-zA-Z\s]{2,}['"]/g);
    if (fieldRefs && fieldRefs.length >= 2) score += 5;

    // Steps count (more steps = more detailed)
    if (tc.steps && tc.steps.length >= 3) score += 5;
    if (tc.steps && tc.steps.length >= 5) score += 5;

    // Expected result has specific text to look for
    const er = toStr(tc.expected_result).toLowerCase();
    if (er.includes('message') || er.includes('toast') || er.includes('displays') || er.includes('shows')) score += 5;

    // Description length (longer = more detailed)
    if ((tc.description || '').length > 80) score += 5;

    // ── NEW: Requirement coverage check ──
    // Verify that storyReference keywords actually appear in steps/expected_result
    const storyRef = toStr(tc.storyReference).toLowerCase();
    if (storyRef && storyRef.length > 15) {
      const refKeywords = storyRef.split(/\s+/).filter(w => w.length > 4);
      const stepsAndResult = (Array.isArray(tc.steps) ? tc.steps.map(toStr).join(' ') : '') + ' ' + toStr(tc.expected_result);
      const stepsLower = stepsAndResult.toLowerCase();
      const coveredKeywords = refKeywords.filter(kw => stepsLower.includes(kw));
      const coverageRatio = refKeywords.length > 0 ? coveredKeywords.length / refKeywords.length : 0;
      if (coverageRatio >= 0.5) score += 8; // Good requirement coverage
      else if (coverageRatio >= 0.25) score += 4;
      else if (coverageRatio === 0 && refKeywords.length > 2) score -= 5; // No overlap = suspicious
    } else {
      score -= 5; // Missing or too-short storyReference
    }

    // ── NEW: Completeness check ──
    if (!tc.steps || tc.steps.length < 2) score -= 10; // Too few steps
    if (!tc.preconditions || toStr(tc.preconditions).length < 10) score -= 5; // No preconditions
    if (!tc.test_data || toStr(tc.test_data).length < 5) score -= 3; // No test data

    // ── NEW: Step-level specificity ──
    // Each step should reference a named element (quoted strings or specific actions)
    if (tc.steps && tc.steps.length > 0) {
      const specificSteps = tc.steps.filter(step => {
        const s = toStr(step);
        return /['"][^'"]{2,}['"]/.test(s) || /click|enter|select|navigate|verify|check/i.test(s);
      });
      const stepSpecificityRatio = specificSteps.length / tc.steps.length;
      if (stepSpecificityRatio >= 0.8) score += 5;
      else if (stepSpecificityRatio < 0.4) score -= 5;
    }

    return Math.max(0, Math.min(100, score));
  }

  /**
   * Try to derive a meaningful storyReference from the test case context
   */
  deriveStoryReference(testCase, ticketData) {
    const summary = ticketData?.summary || ticketData?.title || '';
    if (!summary) return null;

    // If the test title relates to the story summary, use a condensed form
    const titleWords = (testCase.title || '').toLowerCase().split(/\s+/);
    const summaryWords = summary.toLowerCase().split(/\s+/);
    const overlap = titleWords.filter(w => w.length > 3 && summaryWords.includes(w));

    if (overlap.length >= 2) {
      return `${ticketData?.key || ''}: ${summary}`.substring(0, 200);
    }
    return null;
  }

  calculateStatistics(testCases) {
    return {
      total: testCases.length,
      byCategory: testCases.reduce((acc, tc) => {
        acc[tc.category] = (acc[tc.category] || 0) + 1;
        return acc;
      }, {}),
      byPriority: testCases.reduce((acc, tc) => {
        acc[tc.priority] = (acc[tc.priority] || 0) + 1;
        return acc;
      }, {})
    };
  }
}

// Base Agent class
class BaseAgent {
  constructor(name, description, defaultEnabled = true) {
    this.name = name;
    this.description = description;
    this.defaultEnabled = defaultEnabled;
    // Two-call CoT: subclasses set this to true to enable a reasoning pre-pass
    this.useTwoCallCoT = false;
    // Cached reasoning output from the CoT pre-pass (set before batch loop)
    this._cotReasoning = null;
  }
  
  isEnabled(settings) {
    const key = `enable${this.name}Agent`;
    return settings[key] !== false;
  }
  
  async execute(ticketData, previousResults, settings, appContext = null) {
    // Compute ticket complexity once — available to getSystemMessage/getUserMessage via this._complexity
    this._complexity = BaseAgent.calculateTicketComplexity(ticketData);
    console.log(`[${this.name}] 📊 Ticket complexity: ${this._complexity.level} (score: ${this._complexity.score})`);

    const systemMessage = this.getSystemMessage(previousResults);
    let userMessage = await this.getUserMessage(ticketData, previousResults, appContext);

    // Token-aware truncation: truncate user message content if approaching limits
    userMessage = this.ensureTokenSafety(systemMessage, userMessage, settings);

    // Call AI (will use callAI from background.js context)
    const response = await this.callAI(systemMessage, userMessage, settings);

    return this.parseResponse(response);
  }

  // Batched execution to prevent timeouts on large requests
  // Splits the work into smaller batches and aggregates results
  async executeBatched(ticketData, previousResults, settings, appContext = null, batchConfig = null) {
    // Compute complexity (if not already set by execute())
    if (!this._complexity) {
      this._complexity = BaseAgent.calculateTicketComplexity(ticketData);
    }

    // Scale batch config to ticket complexity — complex tickets get more batches
    const config = batchConfig || (() => {
      const level = this._complexity.level;
      if (level === 'simple') return { batches: 1, testsPerBatch: 5 };
      if (level === 'complex') return { batches: 4, testsPerBatch: 4 };
      return { batches: 3, testsPerBatch: 3 }; // medium
    })();

    console.log(`[${this.name}] 🔄 Batched execution (${this._complexity.level} ticket): ${config.batches} batches × ${config.testsPerBatch} tests each`);

    // Two-call CoT: one reasoning pre-pass before all batches (not repeated per batch)
    if (this.useTwoCallCoT && !this._cotReasoning) {
      try {
        console.log(`[${this.name}] 🧠 CoT pre-pass: reasoning about requirements...`);
        this._cotReasoning = await this.buildReasoningContext(ticketData, previousResults, appContext, settings);
        if (this._cotReasoning) {
          console.log(`[${this.name}] 🧠 CoT pre-pass complete: ${(this._cotReasoning.testableRequirements || []).length} requirements, ${(this._cotReasoning.scenarios || []).length} scenarios identified`);
        }
      } catch (err) {
        console.warn(`[${this.name}] CoT pre-pass failed, continuing without reasoning context:`, err.message);
        this._cotReasoning = null;
      }
    }

    const allResults = [];

    for (let i = 0; i < config.batches; i++) {
      console.log(`[${this.name}] 📦 Batch ${i + 1}/${config.batches}...`);

      try {
        const systemMessage = this.getSystemMessage(previousResults, i + 1, config.batches, config.testsPerBatch);
        let userMessage = await this.getUserMessageBatched(ticketData, previousResults, appContext, i + 1, config.batches, config.testsPerBatch);

        // Token-aware truncation
        userMessage = this.ensureTokenSafety(systemMessage, userMessage, settings);

        // Call AI for this batch
        const response = await this.callAI(systemMessage, userMessage, settings);
        const batchResults = this.parseResponse(response);

        // Accumulate results
        if (Array.isArray(batchResults)) {
          allResults.push(...batchResults);
          console.log(`[${this.name}] ✅ Batch ${i + 1} complete: ${batchResults.length} tests generated`);
        }
      } catch (error) {
        console.error(`[${this.name}] ❌ Batch ${i + 1} failed:`, error.message);
        // Continue with next batch even if one fails
      }
    }

    console.log(`[${this.name}] 🎉 All batches complete: ${allResults.length} total tests`);
    return allResults;
  }

  // Override this in subclasses to customize batch messages
  // Batch 1: full context. Batch 2+: condensed context with only delta (dedup list + focus area).
  async getUserMessageBatched(ticketData, previousResults, appContext, batchNum, totalBatches, testsPerBatch) {
    if (batchNum === 1) {
      // First batch: send full context (will be cached by prompt caching)
      const originalMessage = await this.getUserMessage(ticketData, previousResults, appContext);
      return originalMessage.replace(
        /Generate \d+ (?:UNIQUE )?(?:positive|negative|edge|regression|integration)? ?test cases/gi,
        `Generate ${testsPerBatch} test cases (batch ${batchNum}/${totalBatches})`
      );
    }

    // Batch 2+: condensed message — skip repeating full story/context, focus on delta
    // Include both this agent's own tests AND cross-agent shared summaries for dedup
    const ownTests = previousResults.testCases?.slice(-20).map(tc =>
      `  - "${tc.title}" (${tc.category || 'unknown'}): ${(tc.description || '').substring(0, 100)}`
    ).join('\n') || '';

    const crossAgentTests = (previousResults._sharedTestSummaries || []).slice(-20).map(s =>
      `  - ${s}`
    ).join('\n') || '';

    const existingSummaries = [ownTests, crossAgentTests].filter(Boolean).join('\n') || 'None yet';

    const batchFocusAreas = {
      2: 'alternative user flows and different user types',
      3: 'error recovery, edge cases, and failure scenarios',
      4: 'UI/UX validation and integration points'
    };
    const focus = batchFocusAreas[batchNum] || 'additional uncovered scenarios';

    return `**CONTINUATION — Batch ${batchNum}/${totalBatches}**

**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}

**BATCH FOCUS:** ${focus}

**PREVIOUSLY GENERATED TESTS (DO NOT DUPLICATE):**
${existingSummaries}

Generate ${testsPerBatch} NEW test cases covering ${focus}.
Each test MUST have a "storyReference" field and follow the specificity rules from the system prompt.
Return as JSON array.`;
  }

  getSystemMessage(previousResults) {
    throw new Error('Must implement getSystemMessage in subclass');
  }

  getUserMessage(ticketData, previousResults, appContext = null) {
    throw new Error('Must implement getUserMessage in subclass');
  }
  
  parseResponse(response) {
    // Default: return raw response
    return response;
  }
  
  /**
   * Generate concrete test data hints from field constraints.
   * Returns valid, boundary, and invalid example values for a form field.
   */
  generateTestDataHint(field) {
    if (!field) return null;
    const type = (field.type || 'text').toLowerCase();
    const name = (field.name || field.id || '').toLowerCase();
    const validation = field.validation || [];
    const format = field._formatHints?.format;
    const placeholder = field.placeholder || '';

    // Extract constraints
    let minLen = null, maxLen = null, min = null, max = null, pattern = null;
    validation.forEach(v => {
      if (v.startsWith('minLength:')) minLen = parseInt(v.split(':')[1]);
      if (v.startsWith('maxLength:')) maxLen = parseInt(v.split(':')[1]);
      if (v.startsWith('min:')) min = v.split(':')[1];
      if (v.startsWith('max:')) max = v.split(':')[1];
      if (v.startsWith('pattern:')) pattern = v.split(':').slice(1).join(':');
    });

    // Use <select> option values if available — most specific data possible
    if (type === 'select' && field._options && field._options.length > 0) {
      const opts = field._options;
      const first = opts[0];
      const last = opts[opts.length - 1];
      return {
        valid: `"${first.value}" (${first.label})`,
        boundary: `"${first.value}" (first option), "${last.value}" (last option)`,
        invalid: '"nonexistent_value" (not in dropdown options)',
        options: opts.map(o => o.label).join(', ')
      };
    }

    // Use placeholder as hint for realistic data
    const placeholderHint = placeholder && placeholder.length > 3 ? ` (placeholder: "${placeholder}")` : '';

    // Domain-contextual names based on field name patterns
    const domainName = this._inferDomainValue(name);

    // Generate hints based on type + constraints
    if (type === 'email' || format === 'email' || name.includes('email')) {
      const validEmail = domainName === 'healthcare' ? '"dr.sarah.chen@hospital.org"' :
                         domainName === 'finance' ? '"analyst@tradecorp.com"' :
                         domainName === 'ecommerce' ? '"customer@shopmart.com"' :
                         '"jane.smith@company.com"';
      return {
        valid: validEmail,
        boundary: '"a@b.co" (min valid), "' + 'x'.repeat(Math.min(maxLen || 64, 64)) + '@test.com" (max length)',
        invalid: '"not-an-email", "" (empty), "@missing-local.com"'
      };
    }
    if (type === 'password' || name.includes('password')) {
      return {
        valid: '"SecureP@ss2025!"',
        boundary: minLen ? `"${'a'.repeat(minLen)}" (min ${minLen} chars)` : '"Ab1@5678" (8 chars)',
        invalid: minLen ? `"${'a'.repeat(minLen - 1)}" (${minLen - 1} chars, below min)` : '"short"'
      };
    }
    if (type === 'number' || type === 'range') {
      const minV = min || '0';
      const maxV = max || '9999';
      return {
        valid: `${Math.floor((parseInt(minV) + parseInt(maxV)) / 2)}`,
        boundary: `${minV} (min), ${maxV} (max), ${parseInt(minV) - 1} (below min), ${parseInt(maxV) + 1} (above max)`,
        invalid: '"abc" (non-numeric), "" (empty)'
      };
    }
    if (type === 'tel' || format === 'phone' || name.includes('phone')) {
      return {
        valid: '"+1 (555) 123-4567"',
        boundary: '"5551234567" (no formatting)',
        invalid: '"abc" (letters), "123" (too short)'
      };
    }
    if (type === 'url' || name.includes('url') || name.includes('website')) {
      return {
        valid: '"https://www.example.com"',
        boundary: '"http://a.co" (minimal valid URL)',
        invalid: '"not-a-url", "ftp://wrong-scheme.com"'
      };
    }
    if (type === 'date' || format === 'date') {
      return {
        valid: '"2025-07-15"',
        boundary: '"2025-01-01" (start of year), "2025-12-31" (end of year)',
        invalid: '"2025-13-01" (invalid month), "not-a-date"'
      };
    }
    // Default text field — use placeholder if available
    if (type === 'text' || type === 'textarea') {
      const mv = maxLen || 255;
      const mnv = minLen || 1;
      const validValue = placeholder && placeholder.length > 3 ? `"${placeholder}"` : `"Sample ${name || 'text'} value"`;
      return {
        valid: `${validValue}${placeholderHint}`,
        boundary: `"${'a'.repeat(Math.min(mnv, 5))}" (min ${mnv}), "${'x'.repeat(Math.min(mv, 50))}..." (max ${mv} chars)`,
        invalid: minLen ? `"" (empty), "${'a'.repeat(Math.max(mv + 1, 256))}" (exceeds max)` : '"" (empty if required)'
      };
    }
    return null;
  }

  /**
   * Infer domain category from field name patterns for contextual test data.
   */
  _inferDomainValue(fieldName) {
    const name = (fieldName || '').toLowerCase();
    if (/patient|diagnosis|prescription|medical|health|clinic|doctor|nurse/.test(name)) return 'healthcare';
    if (/price|payment|cart|order|shipping|product|sku|inventory/.test(name)) return 'ecommerce';
    if (/account|balance|transaction|portfolio|trade|investment|loan|credit/.test(name)) return 'finance';
    return 'general';
  }

  /**
   * Ensure combined prompt fits within model token limits.
   * Truncates user message (context data) if needed, preserving system instructions.
   */
  ensureTokenSafety(systemMessage, userMessage, settings) {
    if (typeof estimateTokenCount !== 'function' || typeof checkTokenLimit !== 'function') {
      return userMessage; // Token counter not loaded, skip
    }

    const model = settings?.llmModel || 'gpt-4.1';
    const systemTokens = estimateTokenCount(systemMessage);
    const userTokens = estimateTokenCount(userMessage);
    const outputReserve = 4000; // Reserve tokens for output
    const totalTokens = systemTokens + userTokens + outputReserve;

    const check = checkTokenLimit(totalTokens, model, outputReserve);

    if (!check.safe) {
      // Calculate max tokens available for user message
      const maxUserTokens = Math.max(check.limit - systemTokens - outputReserve - 500, 2000);
      console.warn(`[${this.name}] Token limit exceeded (${totalTokens}/${check.limit}). Truncating user message to ~${maxUserTokens} tokens.`);
      return truncateToTokenLimit(userMessage, maxUserTokens);
    }

    if (check.warning) {
      console.warn(`[${this.name}] ${check.warning}`);
    }

    return userMessage;
  }

  // This will be set by background.js to use its callAI function
  async callAI(systemMessage, userMessage, settings) {
    throw new Error('callAI must be bound from background.js');
  }

  // Format app context for inclusion in prompts
  // NOTE: Prefers intelligent context summary over raw JSON (massive size reduction!)
  formatAppContext(appContext, previousResults = null) {
    // First, check if we have an intelligent context summary (generated by ContextAnalysisAgent)
    // This is MUCH better than raw JSON - it's concise, focused, and already analyzed
    if (previousResults && previousResults.contextSummary) {
      let formatted = '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      formatted += '📱 APPLICATION CONTEXT (Intelligent Feature Summary)\n';
      formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';
      formatted += previousResults.contextSummary;
      formatted += '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      formatted += '💡 Use the ACTUAL field names, API endpoints, and UI components mentioned above.\n';
      formatted += '   Reference specific forms, fields, and APIs when writing test cases.\n';
      formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      return formatted;
    }

    // Fallback: If no summary, use raw appContext (legacy behavior)
    if (!appContext) {
      return '';
    }

    // NEW: Handle knowledge graph directly if present (when ContextAnalysisAgent is disabled)
    if (appContext.knowledgeGraph) {
      const kg = appContext.knowledgeGraph;
      let formatted = '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      formatted += '📱 APPLICATION CONTEXT (From Crawled Knowledge Graph)\n';
      formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

      formatted += `🌐 Application: ${appContext.appUrl || 'Unknown'}\n`;
      formatted += `📄 Total Pages Crawled: ${appContext.pageCount || Object.keys(kg.pages || {}).length}\n\n`;

      // Helper: score relevance of an item to the ticket keywords
      const ticketText = ((previousResults?.analysis || '') + ' ' + (appContext._ticketSummary || '')).toLowerCase();
      const ticketKeywords = ticketText.split(/\s+/).filter(w => w.length > 3);
      const scoreRelevance = (text) => {
        if (!text || !ticketKeywords.length) return 0;
        const lower = text.toLowerCase();
        return ticketKeywords.reduce((score, kw) => score + (lower.includes(kw) ? 1 : 0), 0);
      };

      // Add forms from knowledge graph with FULL field constraints, sorted by relevance
      if (kg.forms && kg.forms.length > 0) {
        // Sort forms by relevance to ticket
        const rankedForms = [...kg.forms].sort((a, b) => {
          const aText = `${a.name || ''} ${a.id || ''} ${a.url || ''} ${(a.inputs || []).map(i => i.name || i.label || '').join(' ')}`;
          const bText = `${b.name || ''} ${b.id || ''} ${b.url || ''} ${(b.inputs || []).map(i => i.name || i.label || '').join(' ')}`;
          return scoreRelevance(bText) - scoreRelevance(aText);
        });

        formatted += '📝 FORMS FOUND (with field constraints for test data generation):\n';
        rankedForms.slice(0, 5).forEach((form, index) => {
          formatted += `\n${index + 1}. Form: "${form.name || form.id || 'unnamed'}" on ${form.url}\n`;
          formatted += `   • Action: ${form.action || 'N/A'} | Method: ${form.method}\n`;
          if (form.inputs && form.inputs.length > 0) {
            formatted += `   • Fields (USE THESE EXACT NAMES & CONSTRAINTS IN TESTS):\n`;
            form.inputs.slice(0, 15).forEach(input => {
              const name = input.name || input.id || 'unnamed';
              const req = input.required ? ' [REQUIRED]' : ' [optional]';
              const label = input.label ? ` label="${input.label}"` : '';
              let constraints = '';
              if (input.validation && input.validation.length > 0) {
                constraints = ` constraints=[${input.validation.join(', ')}]`;
              }
              let format = '';
              if (input._formatHints?.format) {
                format = ` format=${input._formatHints.format}`;
              }
              const ph = input.placeholder ? ` placeholder="${input.placeholder}"` : '';
              formatted += `     - "${name}" (${input.type})${req}${label}${constraints}${format}${ph}\n`;
            });
            // Generate example test data hints
            formatted += `   • 📋 TEST DATA HINTS:\n`;
            form.inputs.slice(0, 10).forEach(input => {
              const hint = this.generateTestDataHint(input);
              if (hint) {
                formatted += `     - "${input.name || input.id}": valid=${hint.valid}, boundary=${hint.boundary}, invalid=${hint.invalid}\n`;
              }
            });
          }
        });
        if (kg.forms.length > 5) {
          formatted += `\n   ... and ${kg.forms.length - 5} more forms\n`;
        }
        formatted += '\n';
      }

      // Add APIs from knowledge graph, sorted by relevance
      if (kg.apis && kg.apis.length > 0) {
        const rankedApis = [...kg.apis].sort((a, b) => {
          return scoreRelevance(`${b.endpoint || ''} ${b.url || ''}`) - scoreRelevance(`${a.endpoint || ''} ${a.url || ''}`);
        });

        formatted += '🔌 API ENDPOINTS DETECTED:\n';
        rankedApis.slice(0, 10).forEach((api, index) => {
          formatted += `\n${index + 1}. ${api.method} ${api.endpoint}\n`;
          formatted += `   • Page: ${api.url}\n`;
          if (api.statusCode) formatted += `   • Status: ${api.statusCode}\n`;
          if (api.payload) {
            const keys = Object.keys(api.payload).slice(0, 6).join(', ');
            formatted += `   • Request fields: ${keys}\n`;
          }
        });
        if (kg.apis.length > 10) {
          formatted += `\n   ... and ${kg.apis.length - 10} more API endpoints\n`;
        }
        formatted += '\n';
      }

      // Add API error summary if available
      if (kg.apiErrors && kg.apiErrors.length > 0) {
        formatted += '⚠️ API ERRORS CAPTURED:\n';
        kg.apiErrors.slice(0, 5).forEach((err, i) => {
          formatted += `   ${i + 1}. ${err.method || 'GET'} ${err.endpoint} → ${err.statusCode} (${err.category || 'error'})\n`;
        });
        formatted += '\n';
      }

      // Add stats summary
      if (kg.stats) {
        formatted += '📊 CRAWL STATISTICS:\n';
        formatted += `   • Total Features: ${kg.stats.totalFeatures || 0}\n`;
        formatted += `   • Total APIs: ${kg.stats.totalApis || 0}\n`;
        formatted += `   • Total Forms: ${kg.stats.totalForms || 0}\n`;
        formatted += '\n';
      }

      formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      formatted += '💡 Use the ACTUAL field names, button labels, and API endpoints from above.\n';
      formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
      return formatted;
    }

    let formatted = '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    formatted += '📱 APPLICATION CONTEXT (From Crawled Knowledge Graph)\n';
    formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    formatted += `🌐 Application: ${appContext.appUrl}\n`;
    formatted += `📄 Total Pages Crawled: ${appContext.totalPages}\n\n`;

    // Add forms
    if (appContext.forms && appContext.forms.length > 0) {
      formatted += '📝 FORMS FOUND:\n';
      appContext.forms.slice(0, 5).forEach((form, index) => {
        formatted += `\n${index + 1}. Form on ${form.url}\n`;
        formatted += `   • ID: ${form.id || 'N/A'}\n`;
        formatted += `   • Action: ${form.action || 'N/A'}\n`;
        formatted += `   • Method: ${form.method}\n`;
        if (form.inputs && form.inputs.length > 0) {
          formatted += `   • Fields:\n`;
          form.inputs.slice(0, 10).forEach(input => {
            const required = input.required ? ' (required)' : '';
            formatted += `     - ${input.name || input.id}: ${input.type}${required}\n`;
          });
        }
      });
      if (appContext.forms.length > 5) {
        formatted += `\n   ... and ${appContext.forms.length - 5} more forms\n`;
      }
      formatted += '\n';
    }

    // Add APIs
    if (appContext.apis && appContext.apis.length > 0) {
      formatted += '🔌 API ENDPOINTS DETECTED:\n';
      appContext.apis.slice(0, 10).forEach((api, index) => {
        formatted += `\n${index + 1}. ${api.method} ${api.endpoint}\n`;
        formatted += `   • Page: ${api.url}\n`;
        if (api.payload) {
          formatted += `   • Payload: ${JSON.stringify(api.payload)}\n`;
        }
      });
      if (appContext.apis.length > 10) {
        formatted += `\n   ... and ${appContext.apis.length - 10} more API endpoints\n`;
      }
      formatted += '\n';
    }

    // Add buttons
    if (appContext.features && appContext.features.length > 0) {
      const buttons = appContext.features.filter(f => f.type === 'button');
      if (buttons.length > 0) {
        formatted += '🔘 BUTTONS FOUND:\n';
        buttons.slice(0, 10).forEach((btn, index) => {
          formatted += `   ${index + 1}. "${btn.text || btn.id}" on ${btn.url}\n`;
        });
        if (buttons.length > 10) {
          formatted += `   ... and ${buttons.length - 10} more buttons\n`;
        }
        formatted += '\n';
      }
    }

    formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    formatted += '💡 Use the above ACTUAL implementation details when generating test cases.\n';
    formatted += 'Include real field names, API endpoints, and button labels in your tests.\n';
    formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

    return formatted;
  }

  /**
   * Two-call CoT: first LLM call that reasons about requirements before generating tests.
   * Returns structured JSON with testable requirements, key scenarios, risky areas, and
   * a coverage priority statement. Subclasses that set useTwoCallCoT=true inherit this
   * default implementation; EdgeCaseAgent keeps its own analyzeEdgeCasesWithLLM instead.
   *
   * Returns null if the call fails — callers must handle gracefully.
   */
  async buildReasoningContext(ticketData, previousResults, appContext, settings) {
    const priorAnalysis = toStr(previousResults?.analysis || previousResults?.contextSummary || '').substring(0, 600);
    const agentFocus = this.name.replace('Test', '').toLowerCase();

    const systemMsg = `You are a senior QA analyst specialising in ${agentFocus} test case design. Given a Jira user story, identify ALL testable scenarios for ${agentFocus} testing. Return ONLY valid JSON — no markdown, no prose.`;

    const userMsg = `**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}
**Description:**
${(ticketData.description || '').substring(0, 2500)}

${priorAnalysis ? `**Prior requirement analysis (summary):**\n${priorAnalysis}` : ''}

Analyze and return this JSON structure:
{
  "testableRequirements": ["<exact quote or paraphrase from story>", ...],
  "scenarios": [
    { "name": "<scenario name>", "focus": "${agentFocus}", "priority": "P0|P1|P2", "rationale": "<why this scenario matters>" }
  ],
  "integrationPoints": ["<service/API/system to validate>", ...],
  "riskyAreas": ["<area with high failure probability>", ...],
  "coveragePriority": "<one paragraph on what to prioritise and why>"
}`;

    try {
      const response = await this.callAI(systemMsg, userMsg, settings);
      const parsed = parseRobustJSON(response);
      // Validate we got a useful object back
      if (parsed && (parsed.testableRequirements || parsed.scenarios)) {
        return parsed;
      }
      return null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Format CoT reasoning context for injection into user messages.
   * Returns empty string when _cotReasoning is not available.
   */
  formatCotReasoning() {
    const r = this._cotReasoning;
    if (!r) return '';

    const reqs = Array.isArray(r.testableRequirements) ? r.testableRequirements.slice(0, 8).map((req, i) => `  ${i + 1}. ${req}`).join('\n') : '';
    const scenarios = Array.isArray(r.scenarios) ? r.scenarios.slice(0, 10).map(s => `  • [${s.priority || 'P1'}] ${s.name}${s.rationale ? ` — ${s.rationale}` : ''}`).join('\n') : '';
    const risks = Array.isArray(r.riskyAreas) ? r.riskyAreas.slice(0, 5).join(', ') : '';

    return `
**PRE-ANALYSIS — REASONING PASS OUTPUT (use this to guide your test generation):**
${reqs ? `Testable requirements identified:\n${reqs}` : ''}
${scenarios ? `\nKey scenarios to cover:\n${scenarios}` : ''}
${risks ? `\nRisky areas: ${risks}` : ''}
${r.coveragePriority ? `\nCoverage priority: ${r.coveragePriority}` : ''}
`;
  }

  /**
   * Classify a Jira ticket by complexity.
   * Scores 6 factors (description length, AC density, integration surface, user roles,
   * story points, linked items) and returns { level, score, factors }.
   * level: 'simple' | 'medium' | 'complex'
   */
  static calculateTicketComplexity(ticketData) {
    let score = 0;
    const factors = {};
    const descText = (ticketData.description || '') + ' ' + (ticketData.summary || '');
    const descLower = descText.toLowerCase();

    // F1: Description word count
    const descWords = descText.split(/\s+/).filter(Boolean).length;
    factors.descWords = descWords;
    if (descWords > 400) score += 3;
    else if (descWords > 150) score += 2;
    else score += 1;

    // F2: Acceptance criteria density (Given/When/Then, AC:, must, shall)
    const acHits = (descText.match(/acceptance criteria|given\s|when\s|then\s|AC:|must\s|shall\s/gi) || []).length;
    factors.acMentions = acHits;
    if (acHits > 10) score += 3;
    else if (acHits > 4) score += 2;
    else if (acHits > 0) score += 1;

    // F3: Integration surface area
    const integTerms = ['api', 'service', 'integration', 'webhook', 'endpoint', 'external',
      'third-party', 'sync', 'event', 'kafka', 'queue', 'database', 'storage', 'auth', 'oauth'];
    const integCount = integTerms.filter(t => descLower.includes(t)).length;
    factors.integrationTerms = integCount;
    if (integCount > 5) score += 3;
    else if (integCount > 2) score += 2;
    else if (integCount > 0) score += 1;

    // F4: User role diversity
    const roleTerms = ['admin', 'host', 'participant', 'moderator', 'owner',
      'viewer', 'editor', 'manager', 'guest', 'operator', 'superadmin'];
    const roleCount = roleTerms.filter(t => descLower.includes(t)).length;
    factors.userRoles = roleCount;
    if (roleCount > 3) score += 2;
    else if (roleCount > 1) score += 1;

    // F5: Story points
    const sp = parseInt(ticketData.storyPoints || ticketData.story_points || 0, 10);
    factors.storyPoints = sp;
    if (sp >= 8) score += 2;
    else if (sp >= 3) score += 1;

    // F6: Linked issues / docs
    const linked = (ticketData.linkedIssues || []).length + (ticketData.linkedPages || []).length;
    factors.linkedItems = linked;
    if (linked > 3) score += 2;
    else if (linked > 0) score += 1;

    const level = score >= 11 ? 'complex' : score >= 6 ? 'medium' : 'simple';
    return { level, score, factors };
  }

  /**
   * Return chain-of-thought reasoning guidance scaled to ticket complexity.
   * Injected into user messages so the model reasons before generating output.
   */
  static getCoTGuidance(complexity) {
    const level = typeof complexity === 'string' ? complexity : (complexity?.level || 'medium');

    if (level === 'simple') {
      return `
**REASONING CHECKLIST (complete before generating tests):**
1. Identify the 2-3 core requirements from the story
2. For each: define the success path and the most likely failure path
3. Confirm every generated test maps directly to one of these requirements`;
    }

    if (level === 'complex') {
      return `
**REASONING PROCESS — MANDATORY FOR COMPLEX TICKETS (complete each step before generating):**
1. **Requirement extraction:** List every explicit AND implicit testable requirement (look for "must", "shall", bullets, Given/When/Then)
2. **User journey mapping:** Identify all user roles/personas and their distinct end-to-end journeys through this feature
3. **Integration dependency tree:** List every external service, API, or system involved and enumerate what can independently fail for each
4. **State machine analysis:** Enumerate all states the primary entity can be in and which state transitions are valid vs. invalid
5. **Boundary identification:** Find all numeric limits, time constraints, permission tiers, and data size ceilings
6. **Concurrency risks:** Identify scenarios where two actors or background processes could collide (double-submit, race conditions, stale locks)
7. **Coverage gap check:** Before submitting, verify every finding from steps 1-6 has at least one concrete test case`;
    }

    // medium
    return `
**REASONING CHECKLIST (complete before generating tests):**
1. **Requirements scan:** List every "should/must/will" statement and acceptance criterion as a testable requirement
2. **Persona analysis:** Identify all user roles and their specific allowed vs. blocked actions
3. **Integration check:** List all APIs, services, or external systems this feature touches and what can fail
4. **For each requirement:** Consider happy path → failure path → boundary condition
5. **Coverage check:** Confirm every requirement from step 1 has at least one test before submitting`;
  }
}

// 0. Context Analysis Agent - NEW! Understands crawled app data
class ContextAnalysisAgent extends BaseAgent {
  constructor() {
    super('ContextAnalysis', 'Analyzes crawled application data and creates intelligent summary', true);
  }

  getSystemMessage() {
    return `You are an expert application analyst specializing in understanding web applications from their structure.

Your task: Analyze the crawled knowledge graph data (forms, APIs, pages) and create an intelligent, concise feature summary for the given Jira ticket.

**Your summary MUST include these 4 key sections:**

1. **MAIN PURPOSE** 🎯
   - What is the primary purpose of this feature?
   - What problem does it solve for users?
   - What is the business value?

2. **HOW IT WORKS** ⚙️
   - What is the user workflow/journey?
   - What forms/fields does the user interact with?
   - What API endpoints are called and in what sequence?
   - How do different components connect together?
   - What data flows between systems?

3. **UI COMPONENTS** 🎨
   - What forms are present and what fields do they contain?
   - What buttons/actions are available?
   - What pages/screens are involved?
   - How does the user navigate through the feature?
   - What validation rules are in place?

4. **API CONTRACTS** 🔌
   - What API endpoints does this feature call? List them with methods (GET/POST/PUT/DELETE)
   - What are the request payloads (key fields, required vs optional)?
   - What are the response shapes (success and error)?
   - What HTTP status codes were observed (200, 400, 401, 404, 500)?
   - What pagination patterns exist (cursor, offset, page-number)?
   - What error responses were captured and what do they mean?

5. **SECURITY & PERFORMANCE CONSIDERATIONS** 🔒⚡
   - What authentication/authorization is required?
   - What sensitive data is handled (PII, passwords, tokens)?
   - What are the performance-critical operations?
   - What are potential bottlenecks (large data sets, file uploads)?
   - What rate limiting or throttling exists?
   - What error states and edge cases are handled?

**CRITICAL**:
- Keep it concise (400-800 words) but comprehensive
- Reference ACTUAL form fields, button names, and API endpoints from the data
- Be specific and technical - use real field names and endpoints
- Identify security risks and performance concerns explicitly
- Write in clear, structured format with the 4 sections above

**Output Format**: Plain text summary with clear sections, NOT test cases.`;
  }

  getUserMessage(ticketData, previousResults, appContext) {
    // Extract knowledge graph from appContext
    const knowledgeGraph = appContext?.knowledgeGraph;

    if (!knowledgeGraph || !knowledgeGraph.pages) {
      return 'No application context available. Skip this analysis.';
    }

    const pageCount = Object.keys(knowledgeGraph.pages).length;
    const formCount = knowledgeGraph.forms?.length || 0;
    const apiCount = knowledgeGraph.apis?.length || 0;

    // Build concise context representation
    let contextStr = `**JIRA TICKET TO ANALYZE**\n`;
    contextStr += `Key: ${ticketData.key}\n`;
    contextStr += `Summary: ${ticketData.summary}\n`;
    contextStr += `Description: ${ticketData.description || 'N/A'}\n\n`;

    contextStr += `**CRAWLED APPLICATION DATA** (${pageCount} pages analyzed):\n\n`;

    // Forms with detailed field information
    if (formCount > 0) {
      contextStr += `📝 **FORMS DETECTED** (${formCount} forms):\n`;
      knowledgeGraph.forms.slice(0, 10).forEach((form, i) => {
        contextStr += `\n${i + 1}. Page: ${form.url}\n`;
        contextStr += `   Form ID: ${form.id || 'N/A'}\n`;
        contextStr += `   Action: ${form.action || 'N/A'}\n`;
        contextStr += `   Method: ${form.method}\n`;
        if (form.inputs && form.inputs.length > 0) {
          contextStr += `   Fields detected:\n`;
          form.inputs.slice(0, 10).forEach(input => {
            const req = input.required ? ' (required)' : '';
            contextStr += `     • ${input.name || input.id}: ${input.type}${req}\n`;
          });
        }
      });
      contextStr += '\n';
    }

    // API endpoints with payload information, schemas, and errors
    if (apiCount > 0) {
      contextStr += `🔌 **API ENDPOINTS DETECTED** (${apiCount} endpoints):\n`;
      knowledgeGraph.apis.slice(0, 15).forEach((api, i) => {
        contextStr += `\n${i + 1}. ${api.method} ${api.endpoint}\n`;
        contextStr += `   Called from: ${api.url}\n`;
        if (api.statusCode) {
          contextStr += `   Status: ${api.statusCode}\n`;
        }
        if (api.payload) {
          const payloadKeys = Object.keys(api.payload).slice(0, 8).join(', ');
          contextStr += `   Request fields: ${payloadKeys}\n`;
        }
        if (api.response) {
          contextStr += `   Response shape: ${JSON.stringify(api.response).substring(0, 150)}\n`;
        }
      });
      contextStr += '\n';
    }

    // API schemas (inferred from captured requests)
    if (knowledgeGraph.apiSchemas && knowledgeGraph.apiSchemas.length > 0) {
      contextStr += `📋 **API SCHEMAS (inferred from captured traffic):**\n`;
      knowledgeGraph.apiSchemas.slice(0, 8).forEach((schema, i) => {
        contextStr += `\n${i + 1}. ${schema.method || 'GET'} ${schema.endpoint}\n`;
        if (schema.requestSchema) {
          contextStr += `   Request: ${JSON.stringify(schema.requestSchema).substring(0, 200)}\n`;
        }
        if (schema.responseSchema) {
          contextStr += `   Response: ${JSON.stringify(schema.responseSchema).substring(0, 200)}\n`;
        }
      });
      contextStr += '\n';
    }

    // API errors captured during crawl
    if (knowledgeGraph.apiErrors && knowledgeGraph.apiErrors.length > 0) {
      contextStr += `⚠️ **API ERRORS CAPTURED** (${knowledgeGraph.apiErrors.length} errors):\n`;
      knowledgeGraph.apiErrors.slice(0, 10).forEach((err, i) => {
        contextStr += `   ${i + 1}. ${err.method || 'GET'} ${err.endpoint} → ${err.statusCode} ${err.category || ''}\n`;
      });
      contextStr += '\n';
    }

    contextStr += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    contextStr += `**YOUR TASK:**\n\n`;
    contextStr += `Analyze the above application data in the context of the Jira ticket.\n`;
    contextStr += `Create a feature summary with these sections:\n\n`;
    contextStr += `**1. MAIN PURPOSE** 🎯\n`;
    contextStr += `Explain what this feature does and why it exists.\n\n`;
    contextStr += `**2. HOW IT WORKS** ⚙️\n`;
    contextStr += `Describe the user workflow, which forms/fields are used, which APIs are called, and in what sequence.\n\n`;
    contextStr += `**3. UI COMPONENTS** 🎨\n`;
    contextStr += `List the actual forms, fields, buttons, and pages involved.\n\n`;
    contextStr += `**4. API CONTRACTS** 🔌\n`;
    contextStr += `Summarize the key API endpoints: methods, request/response shapes, observed status codes, and error patterns.\n\n`;
    contextStr += `**IMPORTANT:**\n`;
    contextStr += `- Reference ACTUAL field names, endpoints, and form IDs from the data above\n`;
    contextStr += `- Be specific and technical\n`;
    contextStr += `- Keep it 200-500 words total\n`;
    contextStr += `- This summary will be used by test generation agents`;

    return contextStr;
  }

  parseResponse(response) {
    // Return the summary as-is (it's already formatted text)
    return {
      summary: response,
      type: 'context-summary'
    };
  }
}

// 1. Requirement Analysis Agent
class RequirementAnalysisAgent extends BaseAgent {
  constructor() {
    super('RequirementAnalysis', 'Analyzes and structures requirements from Jira ticket', true);
  }
  
  getSystemMessage(previousResults) {
    const hasContext = previousResults?.contextSummary;

    return `You are a senior business analyst specializing in requirement analysis.
Analyze Jira tickets and extract structured requirements for test case generation.

${hasContext ? '**CRITICAL**: You have access to the actual application context. Cross-reference requirements with the real implementation to identify gaps or discrepancies.' : ''}

Focus on:
1. Feature overview and objectives
2. Functional requirements (what the system should do)
3. UI/UX specifications ${hasContext ? '(validate against actual UI components)' : ''}
4. Integration points and dependencies ${hasContext ? '(verify against actual APIs)' : ''}
5. Acceptance criteria
6. Edge cases and constraints
7. Business rules and validations
8. ${hasContext ? 'Implementation gaps (requirements not yet implemented)' : 'Potential implementation challenges'}
9. ${hasContext ? 'Additional features found (implemented but not in requirements)' : 'Assumptions and risks'}

${hasContext ? 'VALIDATION TASK: Compare the requirements with the Context Summary. Note any differences between what is requested and what is actually implemented.' : ''}

Provide a well-structured analysis in markdown format with clear sections.`;
  }
  
  getUserMessage(ticketData, previousResults, appContext = null) {
    const contextSection = previousResults?.contextSummary
      ? `\n**APPLICATION CONTEXT (From Crawled Data):**\n${previousResults.contextSummary}\n\n**TASK: Cross-reference the requirements below with the actual implementation above.**\n\n`
      : '';

    // Complexity-aware depth instructions
    const complexityLevel = this._complexity?.level || 'medium';
    const depthInstruction = complexityLevel === 'complex'
      ? `\n**COMPLEXITY: HIGH** — This is a complex, multi-integration ticket. Be especially thorough:\n- Extract ALL implicit requirements (not just stated ones)\n- Map every integration dependency\n- Identify conflicting requirements\n- Surface ambiguities that testers should clarify before test execution`
      : complexityLevel === 'simple'
        ? `\n**COMPLEXITY: LOW** — Focus on the 2-3 core requirements and their direct success/failure criteria.`
        : `\n**COMPLEXITY: MEDIUM** — Ensure complete AC coverage and identify integration touchpoints.`;

    return `Analyze this Jira ticket comprehensively:
${contextSection}
**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary || 'N/A'}
**Type:** ${ticketData.type || 'N/A'}
**Description:**
${ticketData.description || 'No description provided'}

**Comments:** ${ticketData.comments?.length || 0} comments available
**Attachments:** ${ticketData.attachments?.length || 0} files attached
**Linked Pages:** ${ticketData.linkedPages?.length || 0} pages linked
${depthInstruction}

Provide a comprehensive requirement analysis.`;
  }
}

// 2. Positive Test Agent (40% of tests)
class PositiveTestAgent extends BaseAgent {
  constructor() {
    super('PositiveTest', 'Generates user story-aligned functional and UI test scenarios', true);
    this.useTwoCallCoT = true; // First call reasons; second call generates
  }

  getSystemMessage(previousResults) {
    // Check if images are available for visual analysis
    const hasVisualContext = this.hasImages?.figma || this.hasImages?.jira;

    const visualAnalysisSection = hasVisualContext ? `
**🎨 FIGMA/UI DESIGN ANALYSIS (CRITICAL - Images Attached):**
You have Figma designs or screenshots attached. Generate BOTH functional AND visual validation tests.

**PART A: FUNCTIONAL UI TESTS (Test interactions)**
Extract every interactive element and create tests for:
- Buttons: Click actions, hover states, disabled states
- Input fields: Valid input, placeholder text, focus states
- Modals/Dialogs: Open, close, action buttons
- Dropdowns: Open, select options, close
- Checkboxes/Toggles: Check, uncheck, visual state change

**PART B: VISUAL VALIDATION TESTS (Test appearance - IMPORTANT!)**
For each screen/component in the Figma design, create visual tests:

1. **Element Presence Tests:**
   - "Verify 'Start Recording' button is visible on the modal"
   - "Verify 'Meeting Title' label is displayed above the input field"
   - "Verify terms checkbox is present before the submit button"

2. **Text/Label Tests:**
   - "Verify modal title displays 'Record a Live Meeting'"
   - "Verify placeholder text shows 'Enter meeting title'"
   - "Verify button text is 'Start Recording' not 'Submit'"

3. **Color/Style Tests (if colors visible in design):**
   - "Verify 'Start Recording' button has primary color (blue/green)"
   - "Verify error messages display in red color"
   - "Verify disabled button appears grayed out"

4. **Layout/Position Tests:**
   - "Verify 'Cancel' button is positioned to the left of 'Start Recording'"
   - "Verify terms checkbox appears below the form fields"
   - "Verify modal is centered on screen"

5. **State Appearance Tests:**
   - "Verify button shows loading spinner when clicked"
   - "Verify input field border turns red on validation error"
   - "Verify success state shows green checkmark icon"

**STEP 3: Use EXACT element names from design:**
- WRONG: "Click submit button"
- RIGHT: "Click 'Start Recording' button"
- WRONG: "Check the box"
- RIGHT: "Check 'I agree to the terms and conditions' checkbox"

**🎯 AT LEAST 30% OF TESTS SHOULD BE VISUAL VALIDATION TESTS when Figma is attached.**
` : '';

    return `You are a SENIOR QA ENGINEER who generates test cases DIRECTLY FROM USER STORIES.

**🚨 CRITICAL RULE: EVERY TEST MUST HAVE A "storyReference" FIELD 🚨**
Each test MUST include a "storyReference" field that quotes or paraphrases the EXACT requirement from the user story that this test validates. If you cannot identify a specific story requirement for a test, DO NOT generate that test.

**YOUR PRIMARY MISSION:**
Generate test cases that validate EVERY SCENARIO mentioned in the user story.
DO NOT generate generic tests. ONLY generate tests that trace back to specific requirements.

**BEFORE GENERATING ANY TEST, ASK YOURSELF:**
1. "Which EXACT sentence/requirement in the user story does this test validate?"
2. "Can I quote the story requirement in the storyReference field?"
3. If the answer to #2 is NO → DO NOT generate this test

**SCENARIO TYPES TO FIND IN THE STORY:**
- "As a... I want... so that..." statements → Main flows to test
- Bullet points or numbered requirements → Individual test cases
- "should/must/will" statements → Acceptance criteria to verify
- Different user types mentioned (internal/external/host/participant) → Test each
- Failure/recovery scenarios mentioned → Error handling tests
- Integration mentions (bot, API, service) → Integration points
${visualAnalysisSection}

**🎯 SPECIFICITY RULES (CRITICAL - Every test must follow these):**

1. **CONCRETE TEST DATA**: Never say "enter valid data" — specify EXACT values:
   ❌ "Enter valid email" → ✅ "Enter 'john.doe@company.com' in the Email field"
   ❌ "Enter a name" → ✅ "Enter 'Jane Smith' in the 'Full Name' field"

2. **EXACT UI ELEMENTS**: Always use the real field/button name from the app context or story:
   ❌ "Click submit button" → ✅ "Click the 'Save Changes' button"
   ❌ "Fill in the form" → ✅ "Enter '2025-06-15' in the 'Start Date' picker"

3. **MEASURABLE EXPECTED RESULTS**: Never say "should work correctly":
   ❌ "System should respond appropriately" → ✅ "Success toast 'Meeting created' appears within 3 seconds"
   ❌ "Page should load properly" → ✅ "Dashboard page loads showing 'Welcome, Jane' header"

4. **SPECIFIC PRECONDITIONS**: Never just "user is logged in":
   ❌ "User is logged in" → ✅ "User 'jane@company.com' is logged in with 'Admin' role on the Dashboard page"

5. **BANNED VAGUE WORDS** (never use these without a specific qualifier):
   "appropriate", "correct", "proper", "valid", "invalid", "relevant", "expected", "as expected", "should work", "works correctly"

**If APPLICATION CONTEXT is provided with field constraints/test data hints, USE THOSE EXACT VALUES in your test steps and test_data fields.**

**REQUIRED TEST CASE FORMAT (includes storyReference):**
{
  "id": "TC-POS-001",
  "title": "[Action] [specific feature from user story]",
  "category": "Positive",
  "priority": "P0",
  "storyReference": "QUOTE or PARAPHRASE the exact requirement from user story this test validates",
  "description": "Verify that [exact scenario from user story]. The user should be able to [specific action] and the system should [expected behavior].",
  "preconditions": "[Specific state: user role, page location, existing data]",
  "steps": [
    "Navigate to [exact page URL or name]",
    "Enter '[concrete value]' in the '[exact field name]' field",
    "Click the '[exact button text]' button",
    "Verify [specific measurable outcome]"
  ],
  "expected_result": "[Specific, measurable outcome with exact text/values to verify]",
  "test_data": "[Concrete values: email='test@example.com', name='Jane Smith', amount=150.00]"
}

**🚫 REJECTED TEST PATTERNS (DO NOT GENERATE THESE):**
❌ "Verify form validation works" → Too generic, not story-specific
❌ "Test SQL injection in input field" → Security test not in story
❌ "Verify empty field handling" → Generic validation, not in story
❌ "Test with 255 characters" → Arbitrary limit not from story
❌ "Performance under load" → Not mentioned in story
❌ Any test where storyReference would be empty or vague

**✅ CORRECT TEST PATTERNS:**
✅ storyReference: "users can submit the form without uploading an attachment"
✅ storyReference: "admin users can bulk-export records from the dashboard"
✅ storyReference: "session is restored after unexpected logout" (recovery scenario)
✅ storyReference: "user grants permission after initially declining the prompt"

**FEW-SHOT EXAMPLE:**

Given user story: "As a host, I want to schedule a meeting so that I can invite participants via email."
With app context showing a form with fields: title (text, required, maxLength:100), date (date, required), email (email, required).

Example output:
{
  "testCases": [
    {
      "id": "TC-POS-001",
      "title": "Schedule meeting with valid details and send email invite",
      "category": "Positive",
      "priority": "P0",
      "storyReference": "As a host, I want to schedule a meeting so that I can invite participants via email",
      "description": "Verify that a host can create a new meeting by filling in the title, date, and participant email, and that an email invitation is sent upon submission.",
      "preconditions": "User 'host@company.com' is logged in with 'Host' role on the Meetings page. No meetings currently scheduled.",
      "steps": [
        "Click the 'Schedule Meeting' button on the Meetings page",
        "Enter 'Q4 Planning Review' in the 'Meeting Title' field",
        "Select '2025-07-15' in the 'Date' picker",
        "Enter 'jane.smith@company.com' in the 'Participant Email' field",
        "Click the 'Send Invite' button"
      ],
      "expected_result": "Success toast 'Meeting scheduled successfully' appears. Meeting 'Q4 Planning Review' appears in the Meetings list with date '2025-07-15'. Email invitation is sent to jane.smith@company.com.",
      "test_data": "title='Q4 Planning Review', date='2025-07-15', email='jane.smith@company.com'"
    }
  ]
}

Generate test cases in this EXACT JSON format (following the specificity level shown in the example above):
{
  "testCases": [
    {
      "id": "TC-POS-001",
      "title": "Specific title from story",
      "category": "Positive",
      "priority": "P0|P1|P2",
      "storyReference": "EXACT quote or paraphrase from user story",
      "description": "Detailed description referencing story requirement",
      "preconditions": "Specific setup",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "expected_result": "Outcome from story",
      "test_data": "Scenario-specific data"
    }
  ]
}

Return ONLY valid JSON, no markdown formatting.`;
  }
  
  getUserMessage(ticketData, previousResults, appContext = null) {
    // Use positivePercent from settings, default to 40%
    const percentage = (this.settings?.positivePercent || 40) / 100;
    const testCount = Math.floor((this.settings?.testCount || 30) * percentage);
    const existingTests = previousResults.testCases?.map(tc => `- ${tc.title}`).join('\n') || 'None yet';

    // Format app context if available (prefers intelligent summary over raw JSON)
    const appContextSection = this.formatAppContext(appContext || previousResults.appContext, previousResults);

    // Check for visual context
    const hasVisualContext = this.hasImages?.figma || this.hasImages?.jira;
    const visualContextNote = hasVisualContext
      ? `\n**📷 FIGMA DESIGNS ATTACHED - GENERATE VISUAL TESTS:**
You MUST generate BOTH functional AND visual validation tests:

**FUNCTIONAL TESTS:** Test clicking buttons, entering text, selecting options
**VISUAL VALIDATION TESTS (30% minimum):**
- Element presence: "Verify 'Start Recording' button is visible"
- Text/labels: "Verify modal title shows 'Record a Live Meeting'"
- Colors: "Verify primary button is blue/green color"
- Layout: "Verify Cancel is left of Start Recording"
- States: "Verify disabled state shows grayed button"

Use EXACT text from the Figma design in your test cases.`
      : '';

    // Extract scenarios from user story for emphasis
    const userStoryScenarios = this.extractUserStoryScenarios(ticketData);

    return `**═══════════════════════════════════════════════════════════════**
**📋 USER STORY TO TEST (READ THIS CAREFULLY - THIS IS YOUR PRIMARY INPUT)**
**═══════════════════════════════════════════════════════════════**

**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}

**FULL USER STORY / DESCRIPTION:**
${ticketData.description || 'No description provided'}

**═══════════════════════════════════════════════════════════════**
**🎯 EXTRACTED SCENARIOS TO TEST (You MUST cover these):**
**═══════════════════════════════════════════════════════════════**
${userStoryScenarios}
${this.formatCotReasoning()}
${visualContextNote}
${appContextSection}

**═══════════════════════════════════════════════════════════════**
**📊 REQUIREMENT ANALYSIS (from previous agent):**
**═══════════════════════════════════════════════════════════════**
${previousResults.analysis || 'No prior analysis available'}

**Already Generated Tests (DO NOT duplicate):**
${existingTests}

**═══════════════════════════════════════════════════════════════**
**🎯 YOUR TASK: Generate ${testCount} STORY-ALIGNED Test Cases**
**═══════════════════════════════════════════════════════════════**

**MANDATORY COVERAGE:**
1. Generate tests for EACH scenario extracted from the user story above
2. Include tests for ALL user types mentioned (internal users, external users, etc.)
3. Include tests for ALL flows mentioned (happy path, recovery, edge cases)
4. If Figma is attached:
   - Include FUNCTIONAL UI tests (click buttons, enter text)
   - Include VISUAL VALIDATION tests (element presence, text labels, colors, layout)
   - At least 30% should be visual validation tests
5. Include tests for integration points mentioned in the story
6. EVERY test must have a "storyReference" field quoting the requirement it validates

**DO NOT GENERATE:**
- Generic form validation (empty fields, special characters)
- SQL injection or security tests (unless mentioned in story)
- Performance tests (unless mentioned in story)
- Tests that don't trace back to a specific requirement in the user story
- Tests without a clear "storyReference"

${BaseAgent.getCoTGuidance(this._complexity)}

Return as JSON array.`;
  }

  // Extract key scenarios from user story description
  extractUserStoryScenarios(ticketData) {
    const description = ticketData.description || '';
    const summary = ticketData.summary || '';
    const fullText = `${summary}\n${description}`;

    const scenarios = [];

    // Look for "As a... I want... so that..." patterns
    const asAMatches = fullText.match(/as\s+a[n]?\s+[^,\.]+[,\.]?\s*i\s+want\s+[^,\.]+/gi);
    if (asAMatches) {
      asAMatches.forEach(match => scenarios.push(`• User Story: ${match.trim()}`));
    }

    // Look for bullet points or numbered lists (likely requirements)
    const bulletPoints = fullText.match(/^[\-\•\*]\s+.+$/gm);
    if (bulletPoints) {
      bulletPoints.slice(0, 10).forEach(point => scenarios.push(`• Requirement: ${point.trim()}`));
    }

    // Look for "should" statements (acceptance criteria)
    const shouldStatements = fullText.match(/(?:system|user|bot|feature|it)\s+should\s+[^\.]+/gi);
    if (shouldStatements) {
      shouldStatements.slice(0, 5).forEach(stmt => scenarios.push(`• Acceptance Criteria: ${stmt.trim()}`));
    }

    // Look for flow keywords
    const flowKeywords = ['create', 'update', 'delete', 'submit', 'cancel', 'recovery', 'retry', 'denied', 'failed', 'timeout', 'permission'];
    flowKeywords.forEach(keyword => {
      if (fullText.toLowerCase().includes(keyword)) {
        const sentences = fullText.split(/[.!?]+/).filter(s => s.toLowerCase().includes(keyword));
        sentences.slice(0, 2).forEach(s => {
          if (s.trim().length > 20) {
            scenarios.push(`• Scenario (${keyword}): ${s.trim()}`);
          }
        });
      }
    });

    // Look for "For X, ..." patterns
    const forPatterns = fullText.match(/for\s+\w+\s+\w+\s+[^,\.]+[,\.]/gi);
    if (forPatterns) {
      forPatterns.slice(0, 5).forEach(pattern => scenarios.push(`• Flow: ${pattern.trim()}`));
    }

    if (scenarios.length === 0) {
      return '⚠️ No explicit scenarios found. Analyze the description to identify implicit requirements.';
    }

    // Deduplicate and return
    return [...new Set(scenarios)].slice(0, 15).join('\n');
  }

  // Batched version - asks for specific number of tests per batch
  getUserMessageBatched(ticketData, previousResults, appContext, batchNum, totalBatches, testsPerBatch) {
    const existingTests = previousResults.testCases?.map(tc => `- ${tc.title}`).join('\n') || 'None yet';
    const appContextSection = this.formatAppContext(appContext || previousResults.appContext, previousResults);

    // Check for visual context
    const hasVisualContext = this.hasImages?.figma || this.hasImages?.jira;
    const visualContextNote = hasVisualContext
      ? '\n**📷 FIGMA DESIGNS ATTACHED:** Generate UI test cases with EXACT element names from the designs.'
      : '';

    // Extract scenarios from user story
    const userStoryScenarios = this.extractUserStoryScenarios(ticketData);

    // Batch-specific focus areas
    const batchFocus = {
      1: 'PRIMARY USER FLOWS - Core happy path scenarios from the user story',
      2: 'ALTERNATIVE FLOWS - Different user types and paths mentioned in the story',
      3: 'RECOVERY SCENARIOS - Error handling, edge cases, and recovery flows from the story',
      4: 'UI/UX VALIDATION - Interface tests based on Figma designs (if available) or story UI mentions'
    };

    return `**═══════════════════════════════════════════════════════════════**
**📋 USER STORY (Batch ${batchNum}/${totalBatches})**
**═══════════════════════════════════════════════════════════════**

**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}

**FULL DESCRIPTION:**
${ticketData.description || 'No description provided'}

**EXTRACTED SCENARIOS:**
${userStoryScenarios}

${visualContextNote}
${appContextSection}

**Already Generated Tests (DO NOT duplicate):**
${existingTests}

**═══════════════════════════════════════════════════════════════**
**🎯 BATCH ${batchNum} FOCUS: ${batchFocus[batchNum] || 'Additional story scenarios'}**
**═══════════════════════════════════════════════════════════════**

Generate ${testsPerBatch} STORY-ALIGNED test cases for this batch.

**REQUIREMENTS:**
- Each test MUST trace to a specific scenario from the user story
- Use EXACT UI element names from Figma (if attached)
- Cover the batch focus area above
- NO generic form validation or security tests

Return as JSON array.`;
  }

  parseResponse(response) {
    try {
      const jsonMatch = response.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');

      const parsed = parseRobustJSON(jsonMatch[0]);
      return parsed.testCases || [];
    } catch (error) {
      console.error('Failed to parse positive test cases:', error);
      console.error('Response preview:', response.substring(0, 500));
      return [];
    }
  }
  
  extractKeywords(ticketData) {
    const text = `${ticketData.summary || ''} ${ticketData.description || ''}`.toLowerCase();
    const domainKeywords = ['api', 'auth', 'login', 'signup', 'payment', 'dashboard', 'admin', 'user', 'oauth', 'database', 'notification', 'email', 'mobile', 'ui', 'ux', 'button', 'form', 'validation', 'search', 'filter', 'upload', 'download', 'export', 'import', 'integration', 'webhook', 'token', 'session', 'permission', 'role'];
    return domainKeywords.filter(kw => text.includes(kw)).slice(0, 5) || ['feature'];
  }
  
  inferPersonas(ticketData) {
    const text = `${ticketData.summary || ''} ${ticketData.description || ''}`.toLowerCase();
    const personas = [];
    if (text.includes('admin') || text.includes('administrator')) personas.push('Admin User');
    if (text.includes('customer') || text.includes('client')) personas.push('Customer');
    if (text.includes('guest') || text.includes('anonymous')) personas.push('Guest User');
    if (personas.length === 0) personas.push('End User');
    return personas;
  }
}

// 3. Negative Test Agent (30% of tests)
class NegativeTestAgent extends BaseAgent {
  constructor() {
    super('NegativeTest', 'Generates story-aligned error handling and failure recovery scenarios', true);
    this.useTwoCallCoT = true; // First call reasons; second call generates
  }

  getSystemMessage(previousResults) {
    // Check if images are available
    const hasVisualContext = this.hasImages?.figma || this.hasImages?.jira;

    const visualSection = hasVisualContext ? `
**🎨 FIGMA/UI CONTEXT (Images Attached):**
Analyze the UI designs to identify:
- Error states and validation messages shown in designs
- Disabled states and their conditions
- Loading/error UI patterns
- Form validation indicators
Use EXACT element names from designs in your test steps.
` : '';

    return `You are a SENIOR QA ENGINEER generating STORY-ALIGNED negative test cases.

**🚨 CRITICAL RULE: EVERY TEST MUST HAVE A "storyReference" FIELD 🚨**
Each test MUST include a "storyReference" field that quotes the EXACT failure/error scenario from the user story. If the failure scenario is NOT mentioned in the story, DO NOT generate the test.

**YOUR PRIMARY MISSION:**
Generate negative tests ONLY for failure scenarios EXPLICITLY MENTIONED in the user story.
DO NOT generate generic security or validation tests.

**BEFORE GENERATING ANY NEGATIVE TEST, ASK:**
1. "Is this failure scenario MENTIONED in the user story?"
2. "Can I quote where the story mentions this error condition?"
3. If NO → DO NOT generate this test

**FAILURE SCENARIOS TO LOOK FOR IN STORY:**
- "fails/failed/failure" mentions → Test that failure case
- "denied/rejected/kicked" mentions → Test denial handling
- "error/issue/problem" mentions → Test error states
- "cannot/unable/not allowed" mentions → Test restriction handling
- "recovery/retry" mentions → Test recovery flows
- "permission/access" mentions → Test permission denial scenarios
${visualSection}

**🚫 REJECTED TEST PATTERNS (DO NOT GENERATE):**
❌ "SQL injection attempt" → Generic security, not in story
❌ "XSS attack prevention" → Generic security, not in story
❌ "Empty field validation" → Generic validation, not in story
❌ "Invalid email format" → Generic validation, not in story
❌ "Session timeout" → Generic, not in story
❌ Any test without a clear storyReference

**🎯 SPECIFICITY RULES FOR NEGATIVE TESTS:**
1. **CONCRETE TRIGGER**: Specify EXACTLY what input/action causes the failure:
   ❌ "Enter invalid data" → ✅ "Enter 'abc' in the 'Amount' field (expects numeric)"
   ❌ "Submit without required fields" → ✅ "Leave 'Email' field empty and click 'Register'"

2. **EXACT ERROR MESSAGES**: Describe what error the user should see:
   ❌ "Error message appears" → ✅ "Red text 'Email is required' appears below the Email field"

3. **CONCRETE TEST DATA**: Provide the exact invalid values to use:
   ❌ "Use invalid email" → ✅ "Enter 'not-an-email' in Email field"

**If APPLICATION CONTEXT provides field constraints (maxLength, min, max, pattern), use those to create precise boundary-violation test data.**

**REQUIRED TEST CASE FORMAT:**
{
  "id": "TC-NEG-001",
  "title": "[Failure from story] handling",
  "category": "Negative",
  "priority": "P0|P1|P2",
  "storyReference": "QUOTE the exact failure scenario from story",
  "description": "Verify that when [specific failure trigger] occurs, the system [specific error handling]. Tests requirement: [quote story].",
  "preconditions": "[Specific state that enables the failure scenario]",
  "steps": ["Navigate to [page]", "Enter '[specific invalid value]' in '[field name]'", "Click '[button]'", "Observe error behavior"],
  "expected_result": "[Exact error message text and location, or specific recovery behavior]",
  "test_data": "[Concrete invalid values with reason: email='not-an-email' (missing @)]"
}

**FEW-SHOT EXAMPLE:**

Given user story: "When scheduling fails due to a calendar conflict, the system should show an error and suggest the next available slot."

Example output:
{
  "testCases": [
    {
      "id": "TC-NEG-001",
      "title": "Schedule meeting on an already-booked time slot shows conflict error",
      "category": "Negative",
      "priority": "P0",
      "storyReference": "When scheduling fails due to a calendar conflict, the system should show an error and suggest the next available slot",
      "description": "Verify that when a host attempts to schedule a meeting on '2025-07-15 10:00 AM' which is already booked, the system displays a conflict error with the next available time suggestion.",
      "preconditions": "User 'host@company.com' is logged in. Meeting 'Team Standup' already exists on 2025-07-15 at 10:00 AM.",
      "steps": [
        "Click 'Schedule Meeting' on the Meetings page",
        "Enter 'Design Review' in the 'Meeting Title' field",
        "Select '2025-07-15' in the 'Date' picker and '10:00 AM' in the 'Time' picker",
        "Click the 'Send Invite' button"
      ],
      "expected_result": "Error banner 'Time slot conflict: 10:00 AM is already booked for Team Standup' appears. System suggests 'Next available: 11:00 AM' with a 'Use suggested time' button.",
      "test_data": "date='2025-07-15', time='10:00 AM' (conflicts with existing 'Team Standup')"
    }
  ]
}

Generate test cases in this EXACT JSON format:
{
  "testCases": [...]
}

Return ONLY valid JSON, no markdown formatting.`;
  }

  getUserMessage(ticketData, previousResults, appContext = null) {
    const appContextSection = this.formatAppContext(appContext || previousResults.appContext, previousResults);
    const percentage = (this.settings?.negativePercent || 25) / 100;
    const testCount = Math.floor((this.settings?.testCount || 30) * percentage);
    const existingTests = previousResults.testCases?.map(tc => `- ${tc.title}`).join('\n') || 'None yet';

    // Extract failure scenarios from user story
    const failureScenarios = this.extractFailureScenarios(ticketData);

    // Check for visual context
    const hasVisualContext = this.hasImages?.figma || this.hasImages?.jira;
    const visualNote = hasVisualContext
      ? '\n**📷 FIGMA DESIGNS ATTACHED:** Reference error states and validation UI from the designs.'
      : '';

    return `**═══════════════════════════════════════════════════════════════**
**📋 USER STORY - IDENTIFY FAILURE SCENARIOS**
**═══════════════════════════════════════════════════════════════**

**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}

**FULL DESCRIPTION:**
${ticketData.description || 'No description provided'}

**═══════════════════════════════════════════════════════════════**
**🚨 EXTRACTED FAILURE/ERROR SCENARIOS FROM STORY:**
**═══════════════════════════════════════════════════════════════**
${failureScenarios}
${this.formatCotReasoning()}
${visualNote}
${appContextSection}

**Requirement Analysis:**
${previousResults.analysis || 'No prior analysis available'}

**Already Generated Tests (DO NOT duplicate):**
${existingTests}

**═══════════════════════════════════════════════════════════════**
**🎯 YOUR TASK: Generate ${testCount} STORY-ALIGNED Negative Tests**
**═══════════════════════════════════════════════════════════════**

**MANDATORY:**
- Each test MUST address a failure scenario from the user story
- Test what happens when specific features FAIL
- Include recovery mechanisms mentioned in the story
- Use EXACT UI elements from Figma (if attached)

**DO NOT GENERATE:**
- Generic SQL injection, XSS, CSRF tests
- Generic empty field validation
- Generic timeout/performance tests
- Any test that doesn't trace to the user story

${BaseAgent.getCoTGuidance(this._complexity)}

Return as JSON array.`;
  }

  // Extract failure/error scenarios from user story
  extractFailureScenarios(ticketData) {
    const description = ticketData.description || '';
    const summary = ticketData.summary || '';
    const fullText = `${summary}\n${description}`;

    const scenarios = [];

    // Look for failure keywords
    const failureKeywords = ['fail', 'error', 'denied', 'rejected', 'invalid', 'unable', 'cannot', 'issue', 'problem', 'not allowed', 'timeout', 'permission', 'recovery', 'service error'];

    failureKeywords.forEach(keyword => {
      if (fullText.toLowerCase().includes(keyword)) {
        const sentences = fullText.split(/[.!?]+/).filter(s => s.toLowerCase().includes(keyword));
        sentences.slice(0, 2).forEach(s => {
          if (s.trim().length > 20) {
            scenarios.push(`• Failure (${keyword}): ${s.trim()}`);
          }
        });
      }
    });

    // Look for "should not" or "must not" patterns
    const negativePatterns = fullText.match(/(?:should|must|cannot|can't|won't|will not)\s+not?\s+[^\.]+/gi);
    if (negativePatterns) {
      negativePatterns.slice(0, 3).forEach(p => scenarios.push(`• Constraint: ${p.trim()}`));
    }

    // Look for conditional failures ("if...then error", "when...fails")
    const conditionalFailures = fullText.match(/(?:if|when)\s+[^,]+(?:fail|error|denied|reject|invalid)[^\.]+/gi);
    if (conditionalFailures) {
      conditionalFailures.slice(0, 3).forEach(c => scenarios.push(`• Conditional: ${c.trim()}`));
    }

    if (scenarios.length === 0) {
      return '⚠️ No explicit failure scenarios found. Identify implicit error conditions from the features being built.';
    }

    return [...new Set(scenarios)].slice(0, 10).join('\n');
  }

  parseResponse(response) {
    try {
      const jsonMatch = response.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');

      const parsed = parseRobustJSON(jsonMatch[0]);
      return parsed.testCases || [];
    } catch (error) {
      console.error('Failed to parse negative test cases:', error);
      console.error('Response preview:', response.substring(0, 500));
      return [];
    }
  }
}

// 4. Edge Case Agent (20% of tests)
class EdgeCaseAgent extends BaseAgent {
  constructor() {
    super('EdgeCase', 'Generates story-specific edge cases and boundary scenarios', true);
  }

  getSystemMessage(previousResults) {
    const hasVisualContext = this.hasImages?.figma || this.hasImages?.jira;

    const visualSection = hasVisualContext ? `
**🎨 FIGMA/UI CONTEXT (Images Attached):**
Analyze UI designs for edge cases:
- Maximum content in UI elements (long names, descriptions)
- Empty states shown in designs
- Multiple items/selections
- Responsive breakpoints
` : '';

    return `You are a SENIOR QA ENGINEER generating STORY-ALIGNED edge case tests.

**🚨 CRITICAL RULE: EVERY TEST MUST HAVE A "storyReference" FIELD 🚨**
Each test MUST include a "storyReference" field linking to a SPECIFIC feature/entity from the user story. Edge cases must be for story-specific features, not generic boundaries.

**YOUR PRIMARY MISSION:**
Generate edge cases for SPECIFIC FEATURES and ENTITIES mentioned in the user story.
DO NOT generate generic boundary tests (255 chars, file size limits, etc.).

**BEFORE GENERATING ANY EDGE TEST, ASK:**
1. "What feature/entity from the story does this edge case test?"
2. "Can I reference where the story mentions this feature?"
3. If NO → DO NOT generate this test

**STORY-SPECIFIC EDGE CASES TO FIND:**
- Multiple/many of something mentioned → Test with 0, 1, many
- User types mentioned → Test edge cases for each type
- Actions mentioned → Test simultaneous/rapid actions
- States mentioned → Test unusual state combinations
${visualSection}

**🚫 REJECTED TEST PATTERNS:**
❌ "255 character limit" → Arbitrary, not from story
❌ "10MB file upload" → Generic limit, not from story
❌ "1000 concurrent users" → Generic load, not from story
❌ Any edge case for features NOT in the story

**🎯 SPECIFICITY RULES FOR EDGE CASES:**
1. **USE FIELD CONSTRAINTS**: If application context provides field limits (maxLength:50, min:0, max:100), use those EXACT boundaries:
   ❌ "Enter very long text" → ✅ "Enter exactly 51 characters in 'Name' field (maxLength is 50)"
   ❌ "Enter extreme number" → ✅ "Enter '101' in 'Quantity' field (max is 100)"

2. **CONCRETE EDGE VALUES**: Always provide exact boundary values:
   ❌ "Test with many items" → ✅ "Add 50 participants to the meeting (test system limit)"
   ❌ "Test empty state" → ✅ "Navigate to Meetings page with 0 scheduled meetings"

3. **SPECIFIC TIMING**: For timing edges, state exact conditions:
   ❌ "Do actions simultaneously" → ✅ "Click 'Start Recording' while the bot is still joining (within 2s of invite)"

**REQUIRED TEST CASE FORMAT:**
{
  "id": "TC-EDG-001",
  "title": "[Edge condition] for [story feature]",
  "category": "Edge",
  "priority": "P1|P2",
  "storyReference": "QUOTE the feature/entity from story this tests",
  "description": "Verify that [story feature] handles [exact boundary condition]. When [specific trigger], the system should [specific behavior].",
  "preconditions": "[Exact state setup with concrete values]",
  "steps": ["Navigate to [page]", "Set up [exact condition]", "Trigger [exact action]", "Observe [specific behavior]"],
  "expected_result": "[Exact expected behavior at the boundary]",
  "test_data": "[Exact boundary values with reasoning: name='x'.repeat(51) because maxLength=50]"
}

**FEW-SHOT EXAMPLE:**

Given user story: "Host can invite up to 10 participants to a meeting" with app context showing participants field (min:1, max:10).

Example output:
{
  "testCases": [
    {
      "id": "TC-EDG-001",
      "title": "Invite exactly 10 participants (upper boundary)",
      "category": "Edge",
      "priority": "P1",
      "storyReference": "Host can invite up to 10 participants to a meeting",
      "description": "Verify that the system correctly handles the maximum boundary of 10 participants. The host should be able to add exactly 10 email addresses and the 'Add Participant' button should become disabled after the 10th entry.",
      "preconditions": "User 'host@company.com' is logged in on the Schedule Meeting page. No participants added yet.",
      "steps": [
        "Enter 'p1@test.com' through 'p10@test.com' in the 'Participant Email' field, clicking 'Add' after each",
        "Verify the participant count shows '10/10'",
        "Attempt to enter 'p11@test.com' in the 'Participant Email' field",
        "Click 'Send Invite'"
      ],
      "expected_result": "'Add Participant' button is disabled after 10th entry. Tooltip shows 'Maximum 10 participants reached'. Meeting is created successfully with all 10 participants.",
      "test_data": "participants=['p1@test.com'...'p10@test.com'] (exactly at max:10 boundary), p11@test.com (exceeds max)"
    }
  ]
}

Return ONLY valid JSON, no markdown formatting.`;
  }

  async getUserMessage(ticketData, previousResults, appContext = null) {
    const appContextSection = this.formatAppContext(appContext || previousResults.appContext, previousResults);
    const percentage = (this.settings?.edgePercent || 10) / 100;
    const testCount = Math.floor((this.settings?.testCount || 30) * percentage);
    const existingTests = previousResults.testCases?.map(tc => `- ${tc.title}`).join('\n') || 'None yet';

    // Use LLM-powered edge case pre-analysis (or fall back to keyword extraction)
    let edgeOpportunities;
    try {
      edgeOpportunities = await this.analyzeEdgeCasesWithLLM(ticketData, previousResults, appContext);
    } catch (e) {
      console.warn('[EdgeCaseAgent] LLM pre-analysis failed, using fallback:', e.message);
      edgeOpportunities = this.extractEdgeOpportunitiesFallback(ticketData);
    }

    const hasVisualContext = this.hasImages?.figma || this.hasImages?.jira;
    const visualNote = hasVisualContext
      ? '\n**📷 FIGMA DESIGNS ATTACHED:** Identify edge cases from UI (empty states, max content, etc.).'
      : '';

    return `**═══════════════════════════════════════════════════════════════**
**📋 USER STORY - IDENTIFY EDGE CASE OPPORTUNITIES**
**═══════════════════════════════════════════════════════════════**

**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}

**FULL DESCRIPTION:**
${ticketData.description || 'No description provided'}

**═══════════════════════════════════════════════════════════════**
**🔍 DEEP EDGE CASE ANALYSIS (LLM-Powered):**
**═══════════════════════════════════════════════════════════════**
${edgeOpportunities}

${visualNote}
${appContextSection}

**Requirement Analysis:**
${previousResults.analysis || 'No prior analysis available'}

**Already Generated Tests (DO NOT duplicate):**
${existingTests}

**═══════════════════════════════════════════════════════════════**
**🎯 YOUR TASK: Generate ${testCount} STORY-ALIGNED Edge Cases**
**═══════════════════════════════════════════════════════════════**

**IMPORTANT:** Use the deep analysis above as your primary guide. Each edge case must map to a specific finding from the analysis.

**DO NOT GENERATE:**
- Generic character limit tests
- Generic file size tests
- Edge cases not relevant to this specific feature

${BaseAgent.getCoTGuidance(this._complexity)}

Return as JSON array.`;
  }

  /**
   * LLM-powered edge case pre-analysis.
   * Asks the LLM to identify state machines, concurrency risks, permission boundaries,
   * and data flow edge cases BEFORE generating test cases.
   */
  async analyzeEdgeCasesWithLLM(ticketData, previousResults, appContext) {
    const systemMessage = `You are an edge case analysis expert. Given a user story, identify SPECIFIC edge case opportunities across these dimensions. Be concise — return bullet points only, no test cases.

**ANALYSIS DIMENSIONS:**

1. **STATE MACHINE ANALYSIS:**
   - What are the possible states of the primary entity? (e.g., draft → active → paused → completed)
   - What invalid state transitions could be attempted?
   - What happens if an action is triggered in an unexpected state?
   - Can the entity be in two states simultaneously?

2. **CONCURRENCY & RACE CONDITIONS:**
   - What if two users perform the same action at the same time?
   - What if a user double-clicks or rapidly repeats an action?
   - What if background processes (bots, syncs, notifications) conflict with user actions?
   - What if a resource is modified while being read?

3. **PERMISSION & ACCESS BOUNDARIES:**
   - What roles/user types interact with this feature?
   - What happens if permissions change mid-operation?
   - Can a user escalate access through this feature?
   - What if a user accesses a resource they previously had access to but no longer do?

4. **DATA FLOW & BOUNDARY VALUES:**
   - What are the actual field constraints from the application context?
   - What happens at exact boundary values (max, min, 0, -1, max+1)?
   - What if required data is missing, null, or malformed?
   - What if data changes between validation and submission?

5. **INTEGRATION & DEPENDENCY EDGES:**
   - What external systems does this feature depend on?
   - What if an external service is down, slow, or returns unexpected data?
   - What if webhooks/callbacks arrive out of order or are duplicated?

Return ONLY the relevant dimensions with specific findings for THIS story. Skip dimensions that don't apply.
Format: Use "• " bullet points grouped by dimension heading.`;

    const contextInfo = this.formatAppContext(appContext || previousResults?.appContext, previousResults);

    const userMessage = `**USER STORY:**
Ticket: ${ticketData.key}
Summary: ${ticketData.summary}
Description: ${(ticketData.description || '').substring(0, 2000)}

${contextInfo}

**Requirement Analysis:**
${(previousResults.analysis || '').substring(0, 1000)}

Analyze this story and return edge case opportunities grouped by dimension.`;

    const response = await this.callAI(systemMessage, userMessage, this.settings);

    // Return the raw text analysis — it will be injected into the edge case generation prompt
    if (!response || response.length < 50) {
      throw new Error('LLM returned insufficient analysis');
    }

    return response;
  }

  /**
   * Fallback keyword-based edge case extraction (used when LLM pre-analysis fails)
   */
  extractEdgeOpportunitiesFallback(ticketData) {
    const description = ticketData.description || '';
    const summary = ticketData.summary || '';
    const fullText = `${summary}\n${description}`;

    const opportunities = [];

    const quantityWords = ['multiple', 'many', 'all', 'any', 'both', 'either', 'each', 'various', 'different'];
    quantityWords.forEach(word => {
      if (fullText.toLowerCase().includes(word)) {
        opportunities.push(`• Quantity edge: What if there are MANY vs ONE vs ZERO?`);
      }
    });

    const userTypes = fullText.match(/(?:internal|external|host|participant|user|admin|guest)\s+\w+/gi);
    if (userTypes) {
      opportunities.push(`• User type edges: ${[...new Set(userTypes)].slice(0, 3).join(', ')}`);
    }

    const stateWords = ['initiated', 'started', 'stopped', 'joined', 'left', 'kicked', 'denied', 'allowed'];
    stateWords.forEach(word => {
      if (fullText.toLowerCase().includes(word)) {
        opportunities.push(`• State edge (${word}): What if action happens during transition?`);
      }
    });

    if (fullText.toLowerCase().includes('real-time') || fullText.toLowerCase().includes('scheduled')) {
      opportunities.push(`• Timing edge: Real-time vs scheduled timing differences`);
    }

    if (fullText.toLowerCase().includes('recovery') || fullText.toLowerCase().includes('retry')) {
      opportunities.push(`• Recovery edge: Multiple recovery attempts, rapid retries`);
    }

    if (opportunities.length === 0) {
      return '⚠️ Analyze the features in the story to identify quantity, timing, and state edge cases.';
    }

    return [...new Set(opportunities)].slice(0, 8).join('\n');
  }

  parseResponse(response) {
    try {
      // Try to find {"testCases": [...]} format first
      const objectMatch = response.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
      if (objectMatch) {
        const parsed = parseRobustJSON(objectMatch[0]);
        return parsed.testCases || [];
      }

      // Fallback: try to find direct array format [...]
      const arrayMatch = response.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        const parsed = parseRobustJSON(arrayMatch[0]);
        return Array.isArray(parsed) ? parsed : [];
      }

      throw new Error('No JSON found in response');
    } catch (error) {
      console.error('Failed to parse edge case test cases:', error);
      console.error('Response preview:', response.substring(0, 500));
      return [];
    }
  }
}

// 5. Regression Test Agent (5% of tests)
class RegressionTestAgent extends BaseAgent {
  constructor() {
    super('RegressionTest', 'Generates regression tests for existing features impacted by new story', true);
  }

  getSystemMessage(previousResults) {
    return `You are a SENIOR QA ENGINEER generating STORY-AWARE regression tests.

**🚨 CRITICAL RULE: EVERY TEST MUST HAVE A "storyReference" FIELD 🚨**
Each regression test MUST reference the NEW feature from the story AND the EXISTING feature it protects.

**YOUR PRIMARY MISSION:**
Identify EXISTING FEATURES that could be IMPACTED by the new feature in the user story.
Generate regression tests to ensure those existing features still work.

**BEFORE GENERATING ANY REGRESSION TEST, ASK:**
1. "What NEW feature from the story could impact existing functionality?"
2. "What EXISTING feature shares components with this new feature?"
3. If you can't identify both → DO NOT generate this test

**EXAMPLES OF STORY-AWARE REGRESSION:**
- New feature: "Bulk export for reports"
  → storyReference: "bulk export" impacts "individual report download"
  → storyReference: "bulk export" impacts "report history page"

**WHAT TO TEST:**
- Features that SHARE components with the new story feature
- Workflows that the new feature EXTENDS or MODIFIES
- Data/APIs that the new feature TOUCHES

**🚫 REJECTED PATTERNS:**
❌ Generic "login still works" (unless story touches auth)
❌ Regression for unrelated features
❌ Tests without clear story connection

**REQUIRED TEST CASE FORMAT:**
{
  "id": "TC-REG-001",
  "title": "Existing [feature] works after [story feature]",
  "category": "Regression",
  "priority": "P0|P1",
  "storyReference": "New feature '[quote from story]' could impact existing '[related feature]'",
  "description": "Verify that [existing feature] continues to work after [new feature from story]. This protects against regression in [specific area].",
  "preconditions": "[Existing feature setup]",
  "steps": ["Steps for existing workflow"],
  "expected_result": "[Existing behavior preserved]",
  "test_data": "[Data that worked before]"
}

Return ONLY valid JSON, no markdown formatting.`;
  }

  getUserMessage(ticketData, previousResults, appContext = null) {
    const appContextSection = this.formatAppContext(appContext || previousResults.appContext, previousResults);
    const testCount = Math.floor((this.settings?.testCount || 30) * 0.05) || 2;

    // Extract what features might be impacted
    const impactAnalysis = this.analyzeRegressionImpact(ticketData);

    return `**═══════════════════════════════════════════════════════════════**
**📋 NEW FEATURE BEING BUILT (From User Story)**
**═══════════════════════════════════════════════════════════════**

**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}

**FULL DESCRIPTION:**
${ticketData.description || 'No description provided'}

**═══════════════════════════════════════════════════════════════**
**🔄 POTENTIAL REGRESSION IMPACT AREAS:**
**═══════════════════════════════════════════════════════════════**
${impactAnalysis}

${appContextSection}

**Requirement Analysis:**
${previousResults.analysis || 'No prior analysis available'}

**═══════════════════════════════════════════════════════════════**
**🎯 YOUR TASK: Generate ${testCount} REGRESSION Tests**
**═══════════════════════════════════════════════════════════════**

**THINK ABOUT:**
- What EXISTING features could this new feature break?
- What workflows SHARE components with this new feature?
- What data/APIs does this feature TOUCH that existing features use?

Generate regression tests for existing features that could be impacted.

Return as JSON array.`;
  }

  // Analyze what existing features might be impacted
  analyzeRegressionImpact(ticketData) {
    const description = ticketData.description || '';
    const summary = ticketData.summary || '';
    const fullText = `${summary}\n${description}`;

    const impacts = [];

    // Common feature areas and their related existing features
    const featureAreas = {
      'form': ['existing form submissions', 'form validation', 'form history'],
      'report': ['existing reports', 'report exports', 'report scheduling'],
      'user': ['user authentication', 'user profile', 'user permissions', 'user settings'],
      'notification': ['existing notifications', 'email delivery', 'in-app alerts'],
      'auth': ['existing login flow', 'session management', 'permission checks'],
      'search': ['search results', 'search filters', 'saved searches'],
      'dashboard': ['dashboard widgets', 'dashboard data', 'dashboard layout']
    };

    Object.entries(featureAreas).forEach(([area, relatedFeatures]) => {
      if (fullText.toLowerCase().includes(area)) {
        impacts.push(`• ${area.toUpperCase()} area touched - Check: ${relatedFeatures.slice(0, 2).join(', ')}`);
      }
    });

    // Look for integration points
    if (fullText.toLowerCase().includes('api') || fullText.toLowerCase().includes('integration')) {
      impacts.push('• API/Integration changes - Existing API consumers may be affected');
    }

    // Look for UI changes
    if (fullText.toLowerCase().includes('button') || fullText.toLowerCase().includes('modal') || fullText.toLowerCase().includes('ui')) {
      impacts.push('• UI changes - Existing UI elements in same area may be affected');
    }

    if (impacts.length === 0) {
      return '⚠️ Analyze the story to identify which existing features share components with this new feature.';
    }

    return impacts.slice(0, 5).join('\n');
  }

  parseResponse(response) {
    try {
      // Try to find {"testCases": [...]} format first
      const objectMatch = response.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
      if (objectMatch) {
        const parsed = parseRobustJSON(objectMatch[0]);
        return parsed.testCases || [];
      }

      // Fallback: try to find direct array format [...]
      const arrayMatch = response.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        const parsed = parseRobustJSON(arrayMatch[0]);
        return Array.isArray(parsed) ? parsed : [];
      }

      throw new Error('No JSON found in response');
    } catch (error) {
      console.error('Failed to parse regression test cases:', error);
      console.error('Response preview:', response.substring(0, 500));
      return [];
    }
  }
}

// 6. Integration Test Agent (5% of tests)
class IntegrationTestAgent extends BaseAgent {
  constructor() {
    super('IntegrationTest', 'Generates story-specific integration tests for mentioned systems', true);
  }

  getSystemMessage(previousResults) {
    return `You are a SENIOR QA ENGINEER generating STORY-ALIGNED integration tests.

**🚨 CRITICAL RULE: EVERY TEST MUST HAVE A "storyReference" FIELD 🚨**
Each test MUST quote the EXACT integration point mentioned in the user story. If the integration is NOT mentioned in the story, DO NOT generate the test.

**YOUR PRIMARY MISSION:**
Generate integration tests ONLY for systems/services EXPLICITLY mentioned in the user story.
DO NOT generate generic API or database tests.

**BEFORE GENERATING ANY INTEGRATION TEST, ASK:**
1. "Where exactly does the story mention this integration?"
2. "Can I quote the story's reference to this system/service?"
3. If NO → DO NOT generate this test

**INTEGRATION KEYWORDS TO FIND IN STORY:**
- Service names: "payment gateway", "email service", "search index", "notification service"
- Integration verbs: "joins", "syncs", "sends", "receives"
- System mentions: "API", "webhook", "service", "platform"

**🚫 REJECTED PATTERNS:**
❌ "Test POST /api/users" → Generic API, not from story
❌ "Database CRUD operations" → Generic, not from story
❌ Any integration not explicitly mentioned in story

**REQUIRED TEST CASE FORMAT:**
{
  "id": "TC-INT-001",
  "title": "[System A] ↔ [System B] for [story feature]",
  "category": "Integration",
  "priority": "P1|P2",
  "storyReference": "QUOTE where story mentions this integration (e.g., 'payment failed due to gateway timeout')",
  "description": "Verify that [integration from story] works. When [trigger], the system should [behavior].",
  "preconditions": "[Setup]",
  "steps": ["Integration steps"],
  "expected_result": "[Integration outcome]",
  "test_data": "[Data between systems]"
}

**✅ VALID storyReference EXAMPLES:**
✅ "payment failed due to gateway timeout"
✅ "email delivery failed due to invalid recipient"
✅ "search index was unavailable during bulk import"

Return ONLY valid JSON, no markdown formatting.`;
  }

  getUserMessage(ticketData, previousResults, appContext = null) {
    const appContextSection = this.formatAppContext(appContext || previousResults.appContext, previousResults);
    const percentage = (this.settings?.integrationPercent || 5) / 100;
    const testCount = Math.floor((this.settings?.testCount || 30) * percentage) || 2;

    // Extract integration points from story
    const integrationPoints = this.extractIntegrationPoints(ticketData);

    return `**═══════════════════════════════════════════════════════════════**
**📋 USER STORY - IDENTIFY INTEGRATION POINTS**
**═══════════════════════════════════════════════════════════════**

**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}

**FULL DESCRIPTION:**
${ticketData.description || 'No description provided'}

**═══════════════════════════════════════════════════════════════**
**🔗 INTEGRATION POINTS MENTIONED IN STORY:**
**═══════════════════════════════════════════════════════════════**
${integrationPoints}

${appContextSection}

**Requirement Analysis:**
${previousResults.analysis || 'No prior analysis available'}

**═══════════════════════════════════════════════════════════════**
**🎯 YOUR TASK: Generate ${testCount} STORY-ALIGNED Integration Tests**
**═══════════════════════════════════════════════════════════════**

**FOCUS ON:**
- Integration points MENTIONED in the story
- Data flows BETWEEN systems described
- Third-party services REFERENCED

**DO NOT GENERATE:**
- Generic REST API CRUD tests
- Generic database integration tests
- Integrations not mentioned in the story

Return as JSON array.`;
  }

  // Extract integration points from user story
  extractIntegrationPoints(ticketData) {
    const description = ticketData.description || '';
    const summary = ticketData.summary || '';
    const fullText = `${summary}\n${description}`;

    const integrations = [];

    // Common integration keywords and their meanings
    const integrationPatterns = {
      'bot': 'Bot ↔ Meeting platform integration',
      'recall': 'System ↔ Recall API integration',
      'calendar': 'Calendar service integration',
      'consent': 'Consent verification service',
      'notification': 'Notification service integration',
      'email': 'Email service integration',
      'api': 'API endpoint integration',
      'webhook': 'Webhook integration',
      'third-party': 'Third-party service integration',
      'sync': 'Data synchronization',
      'meeting platform': 'Meeting platform (Zoom/Meet/Teams) integration'
    };

    Object.entries(integrationPatterns).forEach(([keyword, integration]) => {
      if (fullText.toLowerCase().includes(keyword)) {
        integrations.push(`• ${integration}`);
      }
    });

    // Look for specific integration mentions
    const integrationMentions = fullText.match(/(?:integrat|connect|sync|communicate|call|send to|receive from)\s+(?:with\s+)?[^\.]+/gi);
    if (integrationMentions) {
      integrationMentions.slice(0, 3).forEach(mention => {
        integrations.push(`• Mentioned: ${mention.trim()}`);
      });
    }

    // Look for service names
    const serviceNames = fullText.match(/(?:call ai|recall|zoom|teams|meet|slack|salesforce|hubspot)\b/gi);
    if (serviceNames) {
      [...new Set(serviceNames)].forEach(service => {
        integrations.push(`• Service: ${service} integration`);
      });
    }

    if (integrations.length === 0) {
      return '⚠️ No explicit integration points found. Check if the story involves any external systems or services.';
    }

    return [...new Set(integrations)].slice(0, 8).join('\n');
  }

  parseResponse(response) {
    try {
      // Try to find {"testCases": [...]} format first
      const objectMatch = response.match(/\{[\s\S]*"testCases"[\s\S]*\}/);
      if (objectMatch) {
        const parsed = parseRobustJSON(objectMatch[0]);
        return parsed.testCases || [];
      }

      // Fallback: try to find direct array format [...]
      const arrayMatch = response.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        const parsed = parseRobustJSON(arrayMatch[0]);
        return Array.isArray(parsed) ? parsed : [];
      }

      throw new Error('No JSON found in response');
    } catch (error) {
      console.error('Failed to parse integration test cases:', error);
      console.error('Response preview:', response.substring(0, 500));
      return [];
    }
  }
}

// Refinement Agent — Takes low-quality tests and makes them specific + executable
class RefinementAgent extends BaseAgent {
  constructor() {
    super('Refinement', 'Refines vague test cases into specific, executable tests', true);
  }

  /**
   * Refine a batch of low-quality tests.
   * Takes existing tests + context and returns improved versions.
   * @param {number} passNumber - Current refinement pass (1, 2, or 3)
   */
  async refineTests(testsToRefine, ticketData, previousResults, settings, appContext, passNumber = 1) {
    // Limit to 10 tests per refinement pass to avoid token overflow
    const batch = testsToRefine.slice(0, 10);

    const systemMessage = this.getRefinementSystemMessage(passNumber);
    let userMessage = this.getRefinementUserMessage(batch, ticketData, previousResults, appContext, passNumber);

    // Token safety
    userMessage = this.ensureTokenSafety(systemMessage, userMessage, settings);

    const response = await this.callAI(systemMessage, userMessage, settings);
    return this.parseResponse(response);
  }

  getRefinementSystemMessage(passNumber = 1) {
    const escalation = passNumber >= 3
      ? `\n**⚠️ FINAL PASS — MAXIMUM SPECIFICITY REQUIRED:**
Every single step MUST contain an exact UI element name, an exact value to enter, or an exact visual assertion.
If you cannot determine the exact value from context, INVENT a realistic one (e.g., email: 'jane.smith@acme.com', amount: '$1,250.00').
No step may use ANY word from the banned list below. Zero tolerance.`
      : passNumber >= 2
        ? `\n**🔄 SECOND PASS — These tests were already refined once but still scored low.**
Focus on: replacing ANY remaining vague phrases, adding EXACT field values from the app context, and writing steps detailed enough for a junior tester.`
        : '';

    return `You are a TEST CASE REFINEMENT SPECIALIST. Your job is to take VAGUE test cases and make them SPECIFIC and EXECUTABLE.
${escalation}

**YOUR TASK:** For each test case provided, improve it by:

1. **Replace vague steps** with concrete actions using EXACT field names, button labels, and values:
   - BEFORE: "Enter valid data in the form"
   - AFTER: "Enter 'john.doe@company.com' in the 'Email' field"

2. **Replace vague expected results** with measurable outcomes:
   - BEFORE: "System should respond appropriately"
   - AFTER: "Success toast 'Profile updated successfully' appears at top of page"

3. **Add concrete test data** with specific values:
   - BEFORE: "Use valid credentials"
   - AFTER: "email='test.user@company.com', password='SecureP@ss123'"

4. **Make preconditions specific**:
   - BEFORE: "User is logged in"
   - AFTER: "User 'admin@company.com' is logged in with Admin role, on the Settings page"

5. **Preserve the original test intent** — don't change WHAT is being tested, only make HOW more specific.

**BANNED VAGUE WORDS** (replace ALL of these — score penalty for each one remaining):
"appropriate", "correctly", "properly", "as expected", "should work", "valid data", "invalid data",
"relevant", "expected behavior", "functions correctly", "works as expected", "proper error",
"proper message", "the system should", "enter valid", "enter invalid"

**OUTPUT FORMAT:** Return a JSON array of the refined test cases in the same format, preserving all original fields (id, category, priority, storyReference) but with improved description, steps, expected_result, preconditions, and test_data.

Return ONLY valid JSON array, no markdown.`;
  }

  getRefinementUserMessage(tests, ticketData, previousResults, appContext, passNumber = 1) {
    const contextSection = this.formatAppContext(appContext || previousResults?.appContext, previousResults);

    const testsJson = tests.map(tc => {
      const entry = {
        id: tc.id,
        title: tc.title,
        category: tc.category,
        priority: tc.priority,
        storyReference: tc.storyReference,
        description: tc.description,
        preconditions: tc.preconditions,
        steps: tc.steps,
        expected_result: tc.expected_result,
        test_data: tc.test_data,
        _specificityScore: tc._specificityScore || 0
      };
      // Include review feedback for targeted rewrites
      if (tc._reviewFeedback) {
        entry._reviewFeedback = tc._reviewFeedback;
      }
      return entry;
    });

    const passContext = passNumber > 1
      ? `\n**⚠️ REFINEMENT PASS ${passNumber}:** These tests were refined in pass ${passNumber - 1} but still scored below the specificity threshold (70/100). The _specificityScore shows their current score. Focus on the lowest-scoring tests first.\n`
      : '';

    return `**STORY CONTEXT:**
Ticket: ${ticketData.key}
Summary: ${ticketData.summary}
Description: ${(ticketData.description || '').substring(0, 1500)}

${contextSection}
${passContext}
**TEST CASES TO REFINE (make each one specific and executable):**
${JSON.stringify(testsJson, null, 2)}

**INSTRUCTIONS:**
- Keep the same id, title, category, priority, storyReference
- Replace ALL vague language with concrete, specific details
- If application context provides field names/constraints, use those EXACT names and values
- Add concrete test data values (emails, names, amounts, dates)
- Make every step actionable by a manual tester who has never seen the story
- Target specificity score > 70 for every test

Return the refined tests as a JSON array.`;
  }

  parseResponse(response) {
    try {
      let parsed = parseRobustJSON(response);
      if (parsed.testCases) parsed = parsed.testCases;
      if (!Array.isArray(parsed)) parsed = [parsed];
      return parsed.filter(tc => tc && tc.id);
    } catch (error) {
      console.error('[RefinementAgent] Failed to parse refined tests:', error.message);
      return [];
    }
  }

  // Not used via standard agent pipeline, so return empty defaults
  getSystemMessage() { return ''; }
  getUserMessage() { return ''; }
}

// 7. Review Agent
class ReviewAgent extends BaseAgent {
  constructor() {
    super('Review', 'Reviews generated tests for story alignment and coverage gaps', true);
    // Initialize duplicate detector if available
    this.duplicateDetector = DuplicateDetector ? new DuplicateDetector(0.85) : null;
  }

  getSystemMessage(previousResults) {
    return `You are a principal QA architect performing STORY ALIGNMENT review.

**YOUR PRIMARY MISSION:**
Verify that generated tests actually cover the USER STORY requirements.
Identify tests that are GENERIC and don't trace to the story.

Your review must be THOROUGH and ACTIONABLE, focusing on:

1. **STORY ALIGNMENT CHECK (40% focus):**
   - Does each test trace back to a specific requirement in the user story?
   - Are there scenarios in the story that have NO tests?
   - Identify GENERIC tests that should be removed (SQL injection, generic validation, etc.)
   - Check if Figma UI elements are correctly referenced

2. **Coverage Analysis (30% focus):**
   - Map tests to requirements - what % is covered?
   - Identify untested features or workflows FROM THE STORY
   - Check for missing user types mentioned in story
   - Verify all acceptance criteria have tests

3. **Quality Assessment (30% focus):**
   - Check if descriptions are DETAILED (50+ words minimum)
   - Identify duplicate or near-duplicate tests
   - Validate priority assignments match story criticality
   - Ensure steps reference actual UI elements from Figma/story

**STORY ALIGNMENT ISSUES TO FLAG:**
- "This test doesn't trace to any requirement in the story"
- "Generic security test - story doesn't mention security concerns"
- "Generic form validation - not specific to story features"
- "Missing test for: [specific scenario from story]"

Return your analysis in this EXACT JSON format:
{
  "storyAlignmentScore": 75,
  "storyAlignmentIssues": [
    "TC-XXX-001: Generic SQL injection test - not relevant to this user story",
    "TC-YYY-002: Generic empty field validation - story doesn't specify field validations"
  ],
  "missingStoryScenarios": [
    "No test for: Error recovery after service timeout (mentioned in story)",
    "No test for: Admin bulk export with filters applied (mentioned in story)"
  ],
  "coverageAssessment": "Detailed coverage analysis with specific examples",
  "coverageScore": 85,
  "criticalGaps": [
    "Specific missing test scenario from the story"
  ],
  "qualityIssues": [
    "Specific quality issue found in tests"
  ],
  "duplicateTests": [
    "Test titles that are duplicates or near-duplicates"
  ],
  "suggestedTests": [
    {
      "title": "Test title that maps to story requirement",
      "rationale": "Required by story: [quote from story]",
      "priority": "P0|P1|P2",
      "category": "Positive|Negative|Edge"
    }
  ],
  "testsToRemove": [
    {
      "id": "TC-XXX-001",
      "reason": "Generic test not relevant to this story"
    }
  ],
  "testsToRewrite": [
    {
      "id": "TC-XXX-002",
      "issues": "Steps are vague, expected result says 'works correctly', no concrete test data",
      "improvementInstructions": "Replace step 2 with exact field name from the app context. Add concrete email and password values. Expected result should specify the exact success message text."
    }
  ]
}

**testsToRewrite:** For tests that have a valid concept but poor specificity — provide the test ID and specific rewrite instructions.
Be specific about story alignment. Flag generic tests that don't belong.
Return ONLY valid JSON.`;
  }
  
  getUserMessage(ticketData, previousResults, appContext = null) {
    // Perform duplicate detection if detector is available
    let duplicateInfo = '';
    let duplicateAnalysis = null;

    if (this.duplicateDetector && previousResults.testCases.length > 0) {
      duplicateAnalysis = this.duplicateDetector.detectDuplicates(previousResults.testCases);

      if (duplicateAnalysis.length > 0) {
        const duplicateDetails = duplicateAnalysis.map(group => {
          const primaryTest = previousResults.testCases[group.primary];
          const duplicateList = group.similarities.map(dup =>
            `  - "${dup.test.title}" (${Math.round(dup.similarity * 100)}% similar)`
          ).join('\n');

          return `- "${primaryTest.title}" has duplicates:\n${duplicateList}`;
        }).join('\n\n');

        duplicateInfo = `\n**Detected Duplicate Tests (${duplicateAnalysis.length} groups):**
${duplicateDetails}\n`;
      }
    }

    const testCasesSummary = previousResults.testCases.map((tc, idx) =>
      `${idx + 1}. [${tc.category}] ${tc.title}`
    ).join('\n');

    return `**═══════════════════════════════════════════════════════════════**
**📋 ORIGINAL USER STORY (Compare tests against this)**
**═══════════════════════════════════════════════════════════════**

**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}

**FULL DESCRIPTION:**
${ticketData.description || 'Not provided'}

**═══════════════════════════════════════════════════════════════**
**📊 GENERATED TEST CASES (${previousResults.testCases.length} total)**
**═══════════════════════════════════════════════════════════════**

${testCasesSummary}

**Categories:**
- Positive: ${previousResults.testCases.filter(tc => tc.category === 'Positive').length}
- Negative: ${previousResults.testCases.filter(tc => tc.category === 'Negative').length}
- Edge: ${previousResults.testCases.filter(tc => tc.category === 'Edge').length}
- Regression: ${previousResults.testCases.filter(tc => tc.category === 'Regression').length}
- Integration: ${previousResults.testCases.filter(tc => tc.category === 'Integration').length}

**Security Tests:** ${previousResults.testCases.filter(tc => tc.security_risk).length}
**Performance Tests:** ${previousResults.testCases.filter(tc => tc.performance_impact === 'yes').length}
${duplicateInfo}

**Requirement Analysis:**
${previousResults.analysis || 'Not available'}

**═══════════════════════════════════════════════════════════════**
**🎯 YOUR REVIEW TASK:**
**═══════════════════════════════════════════════════════════════**

1. **CHECK STORY ALIGNMENT:**
   - Compare each test against the user story
   - Flag tests that are GENERIC (don't trace to story)
   - Identify story scenarios with NO tests

2. **IDENTIFY GAPS:**
   - What story requirements have no tests?
   - What user types/flows are missing?

3. **SUGGEST IMPROVEMENTS:**
   - Suggest tests for missing story scenarios
   - Recommend removing generic tests

Return your analysis as specified JSON format.`;
  }

  // Override parseResponse to handle JSON parsing
  parseResponse(response) {
    if (typeof response === 'string') {
      try {
        // Remove any markdown code blocks if present
        const cleanedJson = response.replace(/```json\s*|\s*```/gi, '').trim();
        return JSON.parse(cleanedJson);
      } catch (error) {
        console.error('Failed to parse ReviewAgent response as JSON:', error);
        console.error('Raw response:', response);
        // Return a default review structure if parsing fails
        return {
          coverageAssessment: "Unable to parse review response",
          coverageScore: 0,
          criticalGaps: [],
          qualityIssues: [],
          descriptionQualityIssues: [],
          duplicateTests: [],
          suggestedTests: [],
          securityConcerns: [],
          performanceConcerns: [],
          riskAreas: []
        };
      }
    }
    return response;
  }

  // Override execute to include duplicate removal
  async execute(ticketData, previousResults, settings, appContext = null) {
    // If duplicate detector is available, clean the tests first
    if (this.duplicateDetector && previousResults.testCases.length > 0) {
      const duplicateAnalysis = this.duplicateDetector.removeDuplicates(previousResults.testCases);

      // Store the duplicate analysis for reference
      this.lastDuplicateAnalysis = duplicateAnalysis;

      // Log duplicate removal
      if (duplicateAnalysis.removed.length > 0) {
        console.log(`ReviewAgent: Removed ${duplicateAnalysis.removed.length} duplicate tests`);
        console.log('Duplicate groups:', duplicateAnalysis.duplicateGroups);
      }

      // Update previousResults with cleaned tests
      previousResults = {
        ...previousResults,
        testCases: duplicateAnalysis.cleaned,
        duplicatesRemoved: duplicateAnalysis.removed,
        duplicateGroups: duplicateAnalysis.duplicateGroups
      };
    }

    // Call parent execute with cleaned tests - parseResponse will handle JSON parsing
    const result = await super.execute(ticketData, previousResults, settings, appContext);

    // Add duplicate information to the result object (result is already parsed by parseResponse)
    if (this.lastDuplicateAnalysis && typeof result === 'object' && result !== null) {
      result.duplicateAnalysis = this.lastDuplicateAnalysis.summary;
      result.duplicatesRemoved = this.lastDuplicateAnalysis.removed.map(t => t.title);
    }

    return result;
  }
}

// 8. AI Feature Test Agent (15% of tests, only for AI/LLM features)
class AIFeatureTestAgent extends BaseAgent {
  constructor() {
    super('AIFeature', 'Generates AI/LLM/ML-specific test scenarios', true);
  }

  /**
   * Detect if ticket involves AI/LLM/ML features using semantic analysis
   * Goes beyond simple keyword matching to understand context and reduce false positives
   */
  static detectAIFeatures(ticketData) {
    const allText = [
      ticketData.summary || '',
      ticketData.description || '',
      ticketData.acceptance_criteria || '',
      ...(ticketData.feature_list || [])
    ].join(' ').toLowerCase();

    // ========== SEMANTIC DETECTION SYSTEM ==========

    // HIGH CONFIDENCE patterns - these strongly indicate AI features
    const highConfidencePatterns = [
      // Explicit AI/LLM references
      /\b(llm|large language model)\b/i,
      /\b(gpt-?[34]|gpt-?4o|claude|gemini|bard|palm|openai|anthropic|chatgpt)\b/i,
      /\b(machine learning|deep learning|neural network)\b/i,
      /\bartificial intelligence\b/i,

      // AI-specific operations
      /\b(prompt|prompting)\s+(engineering|injection|template|design)\b/i,
      /\b(text|content|response)\s+generation\b/i,
      /\bgenerat(e|ing|ion)\s+(text|response|content|summary|insight)\b/i,
      /\b(embeddings?|vector)\s+(search|store|database|index)\b/i,
      /\b(rag|retrieval.augmented)\b/i,
      /\bfine.?tun(e|ing)\b/i,
      /\bmodel\s+(training|inference|serving|deployment)\b/i,

      // AI concerns
      /\bhallucination\b/i,
      /\b(token|context)\s+(limit|window|count)\b/i,
      /\b(temperature|top.?p|top.?k)\s*(=|:|\s+\d)/i,
      /\bai\s+(bias|safety|ethics|moderation)\b/i,

      // AI-specific features
      /\bsemantic\s+(search|similarity|understanding)\b/i,
      /\bnatural\s+language\s+(processing|understanding|generation)\b/i,
      /\b(chatbot|conversational\s+ai|ai\s+assistant)\b/i,
      /\bsentiment\s+(analysis|detection)\b/i,
      /\b(summariz|translat)(e|ing|ion)\s+(using|with|via)\s+(ai|llm|model)\b/i
    ];

    // MEDIUM CONFIDENCE patterns - may indicate AI but need context
    const mediumConfidencePatterns = [
      /\bai\s+(feature|functionality|capability|integration)\b/i,
      /\b(intelligent|smart)\s+(search|recommendation|suggestion)\b/i,
      /\bmodel\s+(response|output|prediction)\b/i,
      /\b(nlp|ml)\b/i,
      /\bprediction\s+(model|engine|service)\b/i,
      /\bclassification\s+(model|algorithm)\b/i,
      /\b(auto|ai).?(generat|complet|suggest)\b/i,
      /\bcontent\s+moderation\b/i,
      /\b(chat|conversation)\s+(context|history|memory)\b/i
    ];

    // LOW CONFIDENCE patterns - common words that MIGHT indicate AI in context
    const lowConfidencePatterns = [
      /\bgeneration\b/i,  // Could be "lead generation", "report generation"
      /\bmodel\b/i,       // Could be "data model", "business model"
      /\btraining\b/i,    // Could be "user training", "employee training"
      /\bprompt\b/i,      // Could be "prompt user to...", UI prompt
      /\bagent\b/i,       // Could be "support agent", "agent application"
      /\bassistant\b/i,   // Could be "assistant role", "office assistant"
      /\bintelligent\b/i  // Could be "intelligent design", generic use
    ];

    // FALSE POSITIVE exclusion patterns - when these are present, lower confidence
    const falsePositivePatterns = [
      /\b(support|customer\s+service)\s+agent\b/i,  // Human agent
      /\b(office|personal|admin)\s+assistant\b/i,    // Human assistant
      /\b(data|database|business|domain)\s+model\b/i, // Non-AI model
      /\b(user|employee|staff)\s+training\b/i,        // Human training
      /\b(lead|report|invoice|pdf)\s+generation\b/i,  // Document generation
      /\bprompt\s+(user|dialog|message|alert)\b/i,    // UI prompts
      /\b(test|dev|staging)\s+model\b/i               // Non-AI context
    ];

    // Calculate semantic score
    let score = 0;
    let matchedPatterns = [];
    let matchedKeywords = [];

    // Check high confidence patterns (+30 points each)
    highConfidencePatterns.forEach(pattern => {
      const match = allText.match(pattern);
      if (match) {
        score += 30;
        matchedPatterns.push({ pattern: pattern.source, match: match[0], confidence: 'HIGH' });
        matchedKeywords.push(match[0]);
      }
    });

    // Check medium confidence patterns (+15 points each)
    mediumConfidencePatterns.forEach(pattern => {
      const match = allText.match(pattern);
      if (match) {
        score += 15;
        matchedPatterns.push({ pattern: pattern.source, match: match[0], confidence: 'MEDIUM' });
        matchedKeywords.push(match[0]);
      }
    });

    // Check low confidence patterns (+5 points each, only if no false positive)
    lowConfidencePatterns.forEach(pattern => {
      const match = allText.match(pattern);
      if (match) {
        // Check for false positives
        const isFalsePositive = falsePositivePatterns.some(fp => fp.test(allText));
        if (!isFalsePositive) {
          score += 5;
          matchedPatterns.push({ pattern: pattern.source, match: match[0], confidence: 'LOW' });
          matchedKeywords.push(match[0]);
        }
      }
    });

    // Apply false positive penalty (-20 points for each)
    falsePositivePatterns.forEach(pattern => {
      if (pattern.test(allText)) {
        score -= 20;
        matchedPatterns.push({ pattern: pattern.source, confidence: 'FALSE_POSITIVE' });
      }
    });

    // Ensure score doesn't go negative
    score = Math.max(0, score);

    // Determine confidence level based on semantic score
    let confidence;
    let isAIFeature;

    if (score >= 50) {
      confidence = 'HIGH';
      isAIFeature = true;
    } else if (score >= 25) {
      confidence = 'MEDIUM';
      isAIFeature = true;
    } else if (score >= 10) {
      confidence = 'LOW';
      isAIFeature = true;  // Still enable but with warning
    } else {
      confidence = 'NONE';
      isAIFeature = false;
    }

    // Deduplicate keywords
    const uniqueKeywords = [...new Set(matchedKeywords)];

    console.log(`🤖 [AI Detection] Semantic analysis complete:`, {
      score,
      confidence,
      isAIFeature,
      patterns: matchedPatterns.length,
      keywords: uniqueKeywords
    });

    return {
      isAIFeature,
      keywords: uniqueKeywords,
      confidence,
      score,
      patterns: matchedPatterns,
      analysis: {
        highConfidenceMatches: matchedPatterns.filter(p => p.confidence === 'HIGH').length,
        mediumConfidenceMatches: matchedPatterns.filter(p => p.confidence === 'MEDIUM').length,
        lowConfidenceMatches: matchedPatterns.filter(p => p.confidence === 'LOW').length,
        falsePositiveMatches: matchedPatterns.filter(p => p.confidence === 'FALSE_POSITIVE').length
      }
    };
  }

  /**
   * Only enable this agent if AI features are detected
   */
  isEnabled(settings) {
    // Agent can be disabled in settings
    if (settings.disableAIFeatureAgent === true) {
      return false;
    }

    // Check if ticket has AI features (this will be set by orchestrator)
    return this.hasAIFeatures === true;
  }

  getSystemMessage(previousResults) {
    return `You are a QA engineer specializing in AI/LLM/ML feature testing.
Create comprehensive test scenarios specifically for AI-powered features, covering reliability, safety, and quality aspects.

EXAMPLE HIGH-QUALITY AI TEST CASE:
{
  "id": "TC-AI-001",
  "title": "LLM generates consistent responses for identical prompts",
  "category": "AIFeature",
  "priority": "P1",
  "description": "Verify that the AI model produces consistent and deterministic responses when given the same prompt multiple times with temperature=0. Ensure that the system maintains response consistency across multiple invocations, and the output format, structure, and key content remain stable. This validates the reliability and predictability of the AI feature for production use cases where consistency is critical.",
  "preconditions": "AI model configured with temperature=0, API endpoint accessible",
  "steps": [
    "Send identical prompt 'Summarize the key benefits of cloud computing' to AI endpoint",
    "Record the response",
    "Wait 5 seconds",
    "Send the same prompt again",
    "Record the second response",
    "Repeat 3 more times (total 5 requests)",
    "Compare all 5 responses for consistency"
  ],
  "expected_result": "All 5 responses should be identical or near-identical (95%+ similarity), maintaining same structure and key points",
  "test_data": "Prompt: 'Summarize the key benefits of cloud computing', Temperature: 0, Model: gpt-4",
  "ai_test_type": "Consistency"
}

**AI Test Categories:**

1. **Prompt Testing** (20%)
   - Prompt injection attacks (jailbreaking, system prompt leakage)
   - Prompt manipulation and adversarial inputs
   - Multi-turn conversation context maintenance
   - Prompt format variations (JSON, XML, plain text)
   - Edge case prompts (very long, very short, special characters)

2. **Hallucination Detection** (25%)
   - Factual accuracy validation (verifiable claims)
   - Citation and source verification
   - Detection of fabricated data/references
   - Grounding to provided context only
   - Confidence scoring and uncertainty handling

3. **Consistency & Reliability** (20%)
   - Response consistency for identical prompts
   - Deterministic behavior with temperature=0
   - Output format stability (JSON schema adherence)
   - API reliability under load
   - Timeout and retry handling

4. **Bias & Safety** (15%)
   - Bias detection (gender, racial, cultural)
   - Toxicity and harmful content filtering
   - PII (Personal Identifiable Information) leakage prevention
   - Content moderation and guardrails
   - Ethical AI behavior

5. **Token & Context Limits** (10%)
   - Context window boundary testing
   - Token limit handling (input and output)
   - Truncation behavior
   - Streaming response handling
   - Cost optimization (token usage)

6. **Model Parameter Validation** (10%)
   - Temperature, top-p, top-k parameter effects
   - Max tokens configuration
   - Stop sequences and delimiters
   - System prompt effectiveness
   - Model version consistency

**CRITICAL REQUIREMENTS:**

1. **Detailed Descriptions (minimum 60 words):**
   - Start with "Verify that the AI/LLM/model..."
   - Explain WHAT is being tested and WHY it matters for AI
   - Mention specific AI concerns (hallucination, bias, consistency, etc.)
   - Include expected AI behavior and failure modes
   - Pattern: "Verify that the AI [feature] correctly [behavior] when [context]. Ensure that [AI-specific validations] including [checks for hallucination/bias/consistency]. The model should [expected AI behavior] and prevent [AI failure mode]. This validates [AI quality aspect]."

2. **AI-Specific Test Data:**
   - Include actual prompts/inputs to test
   - Specify model parameters (temperature, max_tokens, etc.)
   - Define expected output formats
   - Include adversarial/edge case examples

3. **Measurable Success Criteria:**
   - Quantify consistency (e.g., "95%+ similarity")
   - Define acceptable hallucination rates (e.g., "0 fabricated citations")
   - Specify performance thresholds (e.g., "response within 5 seconds")
   - Measure bias metrics where applicable

Generate test cases in this EXACT JSON format:
{
  "testCases": [
    {
      "id": "TC-AI-001",
      "title": "Clear AI test case title",
      "category": "AIFeature",
      "priority": "P0|P1|P2|P3",
      "description": "Detailed 60+ word description starting with 'Verify that the AI/LLM/model...'",
      "preconditions": "AI model setup, API access, test environment",
      "steps": ["Step 1", "Step 2", "Step 3"],
      "expected_result": "Expected AI behavior with measurable criteria",
      "test_data": "Prompts, parameters, model configuration",
      "ai_test_type": "PromptTesting|Hallucination|Consistency|Bias|TokenLimits|Parameters"
    }
  ]
}

**IMPORTANT:** Only generate tests relevant to the ACTUAL AI features mentioned in the ticket. Do not create generic tests.

Return ONLY valid JSON, no markdown formatting.`;
  }

  getUserMessage(ticketData, previousResults, appContext = null) {
    const testCount = Math.floor((this.settings?.testCount || 30) * 0.15); // 15% of total tests
    const existingTests = previousResults.testCases?.map(tc => `- ${tc.title}`).join('\n') || 'None yet';

    // Extract AI-specific context
    const aiDetection = AIFeatureTestAgent.detectAIFeatures(ticketData);
    const aiKeywords = aiDetection.keywords.join(', ');

    // Format app context if available
    const appContextSection = this.formatAppContext(appContext || previousResults.appContext, previousResults);

    // Extract specific AI feature mentions from story
    const aiFeatures = this.extractAIFeatures(ticketData);

    return `**═══════════════════════════════════════════════════════════════**
**📋 AI/LLM FEATURE FROM USER STORY**
**═══════════════════════════════════════════════════════════════**

**Ticket:** ${ticketData.key}
**Summary:** ${ticketData.summary}

**FULL DESCRIPTION:**
${ticketData.description || 'Not provided'}

**═══════════════════════════════════════════════════════════════**
**🤖 AI FEATURES DETECTED IN STORY:**
**═══════════════════════════════════════════════════════════════**
${aiFeatures}

**AI Keywords:** ${aiKeywords}
**Detection Confidence:** ${aiDetection.confidence}

${appContextSection}

**Existing Test Cases:**
${existingTests}

**═══════════════════════════════════════════════════════════════**
**🎯 YOUR TASK: Generate ${testCount} STORY-ALIGNED AI Tests**
**═══════════════════════════════════════════════════════════════**

**TEST THE AI FEATURES MENTIONED IN THE STORY:**
- Prompt handling for the SPECIFIC use case in the story
- Hallucination risks for THIS feature's outputs
- Consistency requirements for THIS AI feature
- Safety concerns relevant to THIS feature

**DO NOT GENERATE:**
- Generic AI tests not related to the story
- Tests for AI capabilities not mentioned
- Generic prompt injection tests (unless security is mentioned)

Return as JSON array with "testCases" key.`;
  }

  // Extract specific AI features from the story
  extractAIFeatures(ticketData) {
    const description = ticketData.description || '';
    const summary = ticketData.summary || '';
    const fullText = `${summary}\n${description}`;

    const features = [];

    // Look for specific AI feature mentions
    const aiPatterns = [
      { pattern: /generat\w*\s+(?:text|content|response|summary)/gi, feature: 'Text/Content Generation' },
      { pattern: /llm|language model/gi, feature: 'LLM Integration' },
      { pattern: /prompt/gi, feature: 'Prompt Handling' },
      { pattern: /ai\s+(?:feature|assistant|agent)/gi, feature: 'AI Assistant/Agent' },
      { pattern: /summar\w+/gi, feature: 'Summarization' },
      { pattern: /recommend\w*/gi, feature: 'AI Recommendations' },
      { pattern: /classif\w*/gi, feature: 'Classification' },
      { pattern: /predict\w*/gi, feature: 'Prediction' }
    ];

    aiPatterns.forEach(({ pattern, feature }) => {
      if (pattern.test(fullText)) {
        features.push(`• ${feature}`);
      }
    });

    // Extract sentences mentioning AI
    const aiSentences = fullText.split(/[.!?]+/).filter(s =>
      /\b(ai|llm|model|generat|prompt)\b/i.test(s)
    );
    aiSentences.slice(0, 3).forEach(s => {
      if (s.trim().length > 20) {
        features.push(`• Mentioned: ${s.trim().substring(0, 100)}...`);
      }
    });

    if (features.length === 0) {
      return '⚠️ AI features detected by keywords but no specific mentions found in description.';
    }

    return [...new Set(features)].slice(0, 6).join('\n');
  }

  parseResponse(response) {
    try {
      // Strip markdown code fences if present
      const stripped = response.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed = parseRobustJSON(stripped);
      const cases = parsed.testCases || (Array.isArray(parsed) ? parsed : []);
      return cases;
    } catch (error) {
      console.error('Failed to parse AI feature test cases:', error);
      console.error('Response preview:', response.substring(0, 500));
      return [];
    }
  }
}

// 9. Accessibility Test Agent
class AccessibilityTestAgent extends BaseAgent {
  constructor() {
    super('AccessibilityTest', 'Generates WCAG-aligned accessibility test cases from extracted ARIA data', false);
    this.hasA11yData = false;
  }

  isEnabled(settings) {
    // Only run if explicitly enabled AND a11y data is available
    return settings.enableAccessibilityTestAgent === true && this.hasA11yData;
  }

  getSystemMessage(previousResults) {
    return `You are a SENIOR ACCESSIBILITY QA ENGINEER generating WCAG 2.1 AA-compliant test cases.

**YOUR PRIMARY MISSION:**
Generate accessibility test cases using the ACTUAL ARIA attributes, roles, and keyboard interactions extracted from the application.

**WCAG TEST CATEGORIES:**

1. **Keyboard Navigation (WCAG 2.1.1, 2.1.2):**
   - Can every interactive element be reached via Tab key?
   - Can every action be triggered via Enter/Space?
   - Is there a visible focus indicator on each element?
   - Can the user escape modal dialogs with Escape key?
   - Are skip-navigation links present?

2. **Screen Reader Labels (WCAG 1.1.1, 4.1.2):**
   - Does every input have an associated label (via <label>, aria-label, or aria-labelledby)?
   - Do images have meaningful alt text?
   - Do buttons have accessible names (text content or aria-label)?
   - Are form error messages associated via aria-describedby?

3. **Focus Management (WCAG 2.4.3, 2.4.7):**
   - Does focus move to modals when opened and return when closed?
   - Is tabindex used correctly (avoid positive values)?
   - Are dynamically added elements announced to screen readers (aria-live)?

4. **ARIA State Correctness (WCAG 4.1.2):**
   - Do expandable sections correctly toggle aria-expanded?
   - Do checkboxes/toggles update aria-checked?
   - Do disabled elements have aria-disabled="true"?
   - Are required fields marked with aria-required="true"?

5. **Color & Contrast (WCAG 1.4.3, 1.4.11):**
   - Are error states conveyed by more than just color (icon, text, border)?
   - Is there sufficient contrast between text and background?

**REQUIRED TEST CASE FORMAT:**
{
  "id": "TC-A11Y-001",
  "title": "[A11y category] - [specific element/interaction]",
  "category": "Accessibility",
  "priority": "P1",
  "storyReference": "[WCAG criterion] + [element from app context]",
  "description": "Verify that [specific element] meets [WCAG criterion] by [specific check].",
  "preconditions": "[Screen reader active / keyboard-only navigation / specific page state]",
  "steps": ["Tab to [exact element name]", "Verify [exact ARIA attribute/state]", "Activate with Enter/Space", "Check screen reader announcement"],
  "expected_result": "[Exact accessible behavior: label announced, focus visible, state updated]",
  "test_data": "Screen reader: NVDA/VoiceOver. Browser: Chrome. Keyboard only."
}

Return ONLY valid JSON, no markdown formatting.`;
  }

  getUserMessage(ticketData, previousResults, appContext = null) {
    const appContextSection = this.formatAppContext(appContext || previousResults?.appContext, previousResults);

    // Extract a11y-specific data from knowledge graph
    let a11yContext = '';
    const kg = appContext?.knowledgeGraph || previousResults?.appContext?.knowledgeGraph;
    if (kg && kg.pages) {
      const pages = Object.values(kg.pages);
      const allFeatures = pages.flatMap(p => p.features || []);

      // Collect forms with a11y data
      const formsWithA11y = allFeatures.filter(f => f.type === 'form');
      if (formsWithA11y.length > 0) {
        a11yContext += '\n**FORMS WITH ACCESSIBILITY DATA:**\n';
        formsWithA11y.slice(0, 5).forEach((form, i) => {
          a11yContext += `${i + 1}. Form: ${form.name || form.id || 'unnamed'}\n`;
          if (form.fields) {
            form.fields.slice(0, 10).forEach(field => {
              const a11y = field._accessibility || {};
              a11yContext += `   - "${field.name}": label=${field.label || 'MISSING'}, aria-label=${a11y.ariaLabel || 'none'}, aria-required=${a11y.ariaRequired || 'not set'}, aria-describedby=${a11y.ariaDescribedby || 'none'}\n`;
            });
          }
        });
      }

      // Collect buttons
      const buttons = allFeatures.filter(f => f.type === 'button');
      if (buttons.length > 0) {
        a11yContext += '\n**BUTTONS:**\n';
        buttons.slice(0, 15).forEach((btn, i) => {
          a11yContext += `   ${i + 1}. "${btn.text || 'unnamed'}" — role=${btn.role || 'button'}, disabled=${btn.disabled || false}\n`;
        });
      }

      // Collect modals/dialogs
      const modals = allFeatures.filter(f => f.type === 'modal');
      if (modals.length > 0) {
        a11yContext += '\n**MODALS/DIALOGS:**\n';
        modals.slice(0, 5).forEach((modal, i) => {
          a11yContext += `   ${i + 1}. "${modal.title || 'unnamed'}" — has close button: ${modal.hasCloseButton || false}\n`;
        });
      }
    }

    const testCount = Math.max(5, Math.floor((this.settings?.testCount || 30) * 0.1));

    return `**USER STORY:**
Ticket: ${ticketData.key}
Summary: ${ticketData.summary}
Description: ${(ticketData.description || '').substring(0, 1000)}

${appContextSection}

**ACCESSIBILITY DATA EXTRACTED FROM APP:**
${a11yContext || 'No specific a11y data extracted. Generate tests based on standard WCAG checks for the UI components described above.'}

**YOUR TASK:** Generate ${testCount} accessibility test cases covering:
- Keyboard navigation for all interactive elements
- Screen reader label completeness
- Focus management for modals and dynamic content
- ARIA state correctness
- Error state accessibility (not color-only)

Return as JSON: { "testCases": [...] }`;
  }

  parseResponse(response) {
    try {
      const parsed = parseRobustJSON(response);
      return parsed.testCases || (Array.isArray(parsed) ? parsed : []);
    } catch (error) {
      console.error('Failed to parse accessibility test cases:', error);
      return [];
    }
  }
}
