// Evolutionary Optimization System for QAtalyst
// Genetic Algorithm-based test case generation for enhanced coverage

class EvolutionaryOptimizer {
  constructor(settings, onProgress) {
    this.settings = settings;
    this.onProgress = onProgress;
    this.populationSize = 6; // OPTIMIZED: Reduced from 8 for faster evolution with parallel processing
    this.generations = this.getGenerations(settings.evolutionIntensity || 'light');
    this.mutationRate = 0.3;
    this.crossoverRate = 0.7;
    this.elitismCount = 2;
    this.qualityCache = new Map(); // Cache quality evaluations to reduce AI calls
  }

  getGenerations(intensity) {
    // OPTIMIZED: Further reduced with parallel processing for much faster results
    const map = {
      'light': 1,      // was 2 - now 1 generation with parallel AI calls
      'balanced': 2,   // was 3 - now 2 generations
      'intensive': 3,  // was 5 - now 3 generations
      'exhaustive': 5  // was 7 - now 5 generations
    };
    return map[intensity] || 1; // Default to light (1 generation)
  }
  
  async evolve(baseTestCases, ticketData, callAIFunc) {
    this.callAI = callAIFunc;
    
    // Create initial population from base tests
    let population = this.createInitialPopulation(baseTestCases);
    let bestSolution = baseTestCases;
    let bestFitness = 0;
    
    for (let gen = 0; gen < this.generations; gen++) {
      // Report progress
      if (this.onProgress) {
        this.onProgress({
          generation: gen + 1,
          total: this.generations,
          status: 'evolving',
          bestFitness: Math.round(bestFitness)
        });
      }
      
      // Evaluate fitness for all individuals
      const fitnessScores = await this.evaluateFitness(population, ticketData);
      
      // Track best solution
      const maxFitnessIdx = fitnessScores.indexOf(Math.max(...fitnessScores));
      if (fitnessScores[maxFitnessIdx] > bestFitness) {
        bestFitness = fitnessScores[maxFitnessIdx];
        bestSolution = population[maxFitnessIdx];
      }
      
      // Selection - Tournament selection
      const selected = this.selection(population, fitnessScores);
      
      // Crossover - Create offspring
      const offspring = this.crossover(selected);
      
      // Mutation - Apply mutations
      const mutated = await this.mutate(offspring, ticketData);
      
      // Elitism - Keep best individuals
      population = this.elitism(population, fitnessScores, mutated);
    }
    
    // Report completion
    if (this.onProgress) {
      this.onProgress({
        generation: this.generations,
        total: this.generations,
        status: 'completed',
        bestFitness: Math.round(bestFitness)
      });
    }
    
    return bestSolution;
  }
  
  createInitialPopulation(baseTests) {
    const population = [baseTests]; // Include original as baseline
    
    // Create variations by shuffling and slight modifications
    for (let i = 1; i < this.populationSize; i++) {
      const variation = JSON.parse(JSON.stringify(baseTests)); // Deep clone
      
      // Shuffle test order
      for (let j = variation.length - 1; j > 0; j--) {
        const k = Math.floor(Math.random() * (j + 1));
        [variation[j], variation[k]] = [variation[k], variation[j]];
      }
      
      // Random slight priority/category shifts for variation
      variation.forEach(test => {
        if (Math.random() < 0.2) { // 20% chance
          const priorities = ['P0', 'P1', 'P2', 'P3'];
          test.priority = priorities[Math.floor(Math.random() * priorities.length)];
        }
      });
      
      population.push(variation);
    }
    
    return population;
  }
  
  async evaluateFitness(population, ticketData) {
    // THROTTLED PARALLEL OPTIMIZATION: Evaluate individuals in batches to prevent rate limiting
    const BATCH_SIZE = 5; // Maximum 5 concurrent API calls
    const scores = [];

    for (let i = 0; i < population.length; i += BATCH_SIZE) {
      const batch = population.slice(i, i + BATCH_SIZE);
      const batchPromises = batch.map((individual, batchIndex) => {
        const globalIndex = i + batchIndex;
        // Skip quality evaluation for every 3rd individual to reduce AI calls
        const skipQuality = (globalIndex % 3 !== 0);
        return this.calculateFitness(individual, ticketData, skipQuality);
      });

      const batchScores = await Promise.all(batchPromises);
      scores.push(...batchScores);

      // Small delay between batches to prevent overwhelming the API
      if (i + BATCH_SIZE < population.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    return scores;
  }

  async calculateFitness(testCases, ticketData, skipQuality = false) {
    // Fitness criteria:
    // 1. Coverage diversity (30%)
    // 2. Test quality (40%)
    // 3. Completeness (30%)

    let fitness = 0;

    // Coverage diversity score
    const categories = {};
    const priorities = {};
    testCases.forEach(tc => {
      categories[tc.category] = (categories[tc.category] || 0) + 1;
      priorities[tc.priority] = (priorities[tc.priority] || 0) + 1;
    });

    const categoryCount = Object.keys(categories).length;
    const priorityCount = Object.keys(priorities).length;
    const diversityScore = ((categoryCount / 5) + (priorityCount / 4)) / 2 * 30;
    fitness += diversityScore;

    // Test quality score (AI evaluation on sample)
    if (!skipQuality) {
      const sample = testCases.slice(0, Math.min(5, testCases.length));
      const qualityScore = await this.evaluateQualityWithAI(sample, ticketData);
      fitness += qualityScore * 40;
    } else {
      // Use default quality score to avoid AI call
      fitness += 0.7 * 40; // Assume reasonable quality
    }

    // Completeness score
    const hasPositive = testCases.some(tc => tc.category === 'Positive');
    const hasNegative = testCases.some(tc => tc.category === 'Negative');
    const hasEdge = testCases.some(tc => tc.category === 'Edge');
    const completenessScore = ((hasPositive ? 1 : 0) + (hasNegative ? 1 : 0) + (hasEdge ? 1 : 0)) / 3 * 30;
    fitness += completenessScore;

    return Math.min(100, fitness);
  }
  
  async evaluateQualityWithAI(sampleTests, ticketData) {
    try {
      // Create cache key from test IDs
      const cacheKey = sampleTests.map(tc => tc.id).join(',');

      // Check cache first
      if (this.qualityCache.has(cacheKey)) {
        return this.qualityCache.get(cacheKey);
      }

      const systemMessage = `You are a QA quality evaluator. Score test cases from 0-1 based on:
- Description quality and detail (minimum 50 words, follows "Verify that..." pattern)
- Clarity of test steps (specific, actionable, referencing actual UI elements)
- Relevance to requirements
- Realistic test data with specific values
- Clear expected results with measurable outcomes

SCORING GUIDE:
- 0.9-1.0: Excellent descriptions (50+ words, detailed context), clear steps, perfect data
- 0.7-0.8: Good descriptions (30-50 words), mostly clear steps, good data
- 0.5-0.6: Basic descriptions (20-30 words), adequate steps, basic data
- 0.0-0.4: Poor descriptions (<20 words), vague steps, missing data

Return ONLY a number between 0 and 1.`;

      const userMessage = `Evaluate these test cases quality:

Ticket: ${ticketData.key} - ${ticketData.summary}

Sample Tests:
${sampleTests.map((tc, idx) => `${idx + 1}. [${tc.category}] ${tc.title}\nSteps: ${tc.steps?.join(', ')}`).join('\n\n')}

Return quality score (0-1):`;

      const response = await this.callAI(systemMessage, userMessage, this.settings);
      const score = parseFloat(response.trim());
      const finalScore = isNaN(score) ? 0.7 : Math.max(0, Math.min(1, score));

      // Cache the result
      this.qualityCache.set(cacheKey, finalScore);

      return finalScore;
    } catch (error) {
      console.error('Quality evaluation failed:', error);
      return 0.7; // Default reasonable score
    }
  }
  
  selection(population, fitnessScores) {
    const selected = [];
    const tournamentSize = 3;
    
    while (selected.length < population.length) {
      // Tournament selection
      const tournament = [];
      for (let i = 0; i < tournamentSize; i++) {
        const idx = Math.floor(Math.random() * population.length);
        tournament.push({ individual: population[idx], fitness: fitnessScores[idx], idx });
      }
      
      // Select winner (highest fitness)
      tournament.sort((a, b) => b.fitness - a.fitness);
      selected.push(JSON.parse(JSON.stringify(tournament[0].individual))); // Deep clone
    }
    
    return selected;
  }
  
  crossover(selected) {
    const offspring = [];
    
    for (let i = 0; i < selected.length; i += 2) {
      if (Math.random() < this.crossoverRate && i + 1 < selected.length) {
        const parent1 = selected[i];
        const parent2 = selected[i + 1];
        
        // Single-point crossover
        if (parent1.length > 1 && parent2.length > 1) {
          const point = Math.floor(Math.random() * Math.min(parent1.length, parent2.length));
          
          const child1 = [
            ...parent1.slice(0, point),
            ...parent2.slice(point)
          ];
          
          const child2 = [
            ...parent2.slice(0, point),
            ...parent1.slice(point)
          ];
          
          offspring.push(child1, child2);
        } else {
          offspring.push(parent1, parent2);
        }
      } else {
        offspring.push(selected[i]);
        if (i + 1 < selected.length) {
          offspring.push(selected[i + 1]);
        }
      }
    }
    
    return offspring;
  }
  
  async mutate(offspring, ticketData) {
    const mutationStrategies = [
      'dataVariation',
      'scenarioExpansion',
      'boundaryTesting',
      'errorInjection',
      'contextShifting',
      'descriptionEnhancement'
    ];

    // PARALLEL OPTIMIZATION: Apply mutations in parallel instead of sequentially
    const mutationPromises = offspring.map(async (individual, i) => {
      if (Math.random() < this.mutationRate) {
        const strategy = mutationStrategies[Math.floor(Math.random() * mutationStrategies.length)];
        return await this.applyMutation(individual, strategy, ticketData);
      }
      return individual; // Return unchanged if no mutation
    });

    const mutatedOffspring = await Promise.all(mutationPromises);
    return mutatedOffspring;
  }
  
  async applyMutation(testCases, strategy, ticketData) {
    try {
      // Select a few tests to mutate (not all)
      const mutationCount = Math.min(3, Math.ceil(testCases.length * 0.2));
      const indicesToMutate = [];
      while (indicesToMutate.length < mutationCount) {
        const idx = Math.floor(Math.random() * testCases.length);
        if (!indicesToMutate.includes(idx)) {
          indicesToMutate.push(idx);
        }
      }
      
      const testsToMutate = indicesToMutate.map(idx => testCases[idx]);
      
      const systemMessage = `You are a test mutation specialist applying ${strategy} mutation strategy.

${this.getMutationDescription(strategy)}

Modify the provided test cases and return them in the SAME JSON format.
Return ONLY valid JSON array, no markdown.`;

      const userMessage = `Apply ${strategy} mutation to these tests for:

Ticket: ${ticketData.key} - ${ticketData.summary}

Tests to mutate:
${JSON.stringify(testsToMutate, null, 2)}

Return mutated tests as JSON array:`;

      const response = await this.callAI(systemMessage, userMessage, this.settings);

      // Parse mutated tests
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        let jsonStr = jsonMatch[0];

        // Fix common JSON escape issues from LLM responses
        // 1. Fix unescaped newlines inside strings
        jsonStr = jsonStr.replace(/(?<=":[\s]*"[^"]*)\n(?=[^"]*")/g, '\\n');
        // 2. Fix unescaped tabs inside strings
        jsonStr = jsonStr.replace(/(?<=":[\s]*"[^"]*)\t(?=[^"]*")/g, '\\t');
        // 3. Fix unescaped backslashes that aren't already escape sequences
        jsonStr = jsonStr.replace(/\\(?!["\\/bfnrtu])/g, '\\\\');

        try {
          const mutatedTests = JSON.parse(jsonStr);

          // Replace mutated tests in original array
          indicesToMutate.forEach((idx, i) => {
            if (mutatedTests[i]) {
              testCases[idx] = mutatedTests[i];
            }
          });
        } catch (parseError) {
          // Try more aggressive JSON cleanup if initial parse fails
          console.warn(`Mutation ${strategy} JSON parse failed, attempting cleanup:`, parseError.message);

          // Remove control characters that break JSON
          jsonStr = jsonStr.replace(/[\x00-\x1F\x7F]/g, (char) => {
            if (char === '\n') return '\\n';
            if (char === '\r') return '\\r';
            if (char === '\t') return '\\t';
            return '';
          });

          const mutatedTests = JSON.parse(jsonStr);
          indicesToMutate.forEach((idx, i) => {
            if (mutatedTests[i]) {
              testCases[idx] = mutatedTests[i];
            }
          });
        }
      }
    } catch (error) {
      console.error(`Mutation ${strategy} failed:`, error);
      // Return unchanged on error
    }
    
    return testCases;
  }
  
  getMutationDescription(strategy) {
    const descriptions = {
      dataVariation: 'Modify test data to explore different input combinations. Change values, add edge cases, try different data types.',
      scenarioExpansion: 'Expand test scenarios by adding more steps, alternative paths, or additional validations.',
      boundaryTesting: 'Add boundary value tests: minimum, maximum, zero, null, empty, overflow conditions.',
      errorInjection: 'Introduce error conditions: invalid inputs, missing data, unauthorized access, timeouts.',
      contextShifting: 'Change test context: different users, environments, states, concurrent operations.',
      descriptionEnhancement: 'CRITICAL: Enhance test descriptions to be MORE DETAILED (minimum 50 words). Use pattern: "Verify that [specific feature] works correctly when [detailed context]. Ensure that [specific validations] including [data checks], [UI state], and [system behavior]. This test validates [business requirement] and protects against [potential issues]." Add specific details about what is being tested, why it matters, and what could go wrong.'
    };
    return descriptions[strategy] || 'Improve test coverage through intelligent mutations.';
  }
  
  elitism(population, fitnessScores, offspring) {
    // Keep top N fittest individuals from previous generation
    const indexed = population.map((ind, idx) => ({
      individual: ind,
      fitness: fitnessScores[idx]
    }));
    
    indexed.sort((a, b) => b.fitness - a.fitness);
    
    const elite = indexed.slice(0, this.elitismCount).map(x => x.individual);
    const rest = offspring.slice(0, population.length - this.elitismCount);
    
    return [...elite, ...rest];
  }
}

// Export for use in background.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { EvolutionaryOptimizer };
}
