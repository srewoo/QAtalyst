// Evolutionary Optimization System for QAtalyst
// Genetic Algorithm-based test case generation for enhanced coverage

class EvolutionaryOptimizer {
  constructor(settings, onProgress) {
    this.settings = settings;
    this.onProgress = onProgress;
    this.populationSize = 15; // Smaller for client-side performance
    this.generations = this.getGenerations(settings.evolutionIntensity || 'balanced');
    this.mutationRate = 0.3;
    this.crossoverRate = 0.7;
    this.elitismCount = 2;
  }
  
  getGenerations(intensity) {
    const map = {
      'light': 3,
      'balanced': 5,
      'intensive': 8,
      'exhaustive': 10
    };
    return map[intensity] || 5;
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
    const scores = [];
    
    for (const individual of population) {
      const score = await this.calculateFitness(individual, ticketData);
      scores.push(score);
    }
    
    return scores;
  }
  
  async calculateFitness(testCases, ticketData) {
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
    const sample = testCases.slice(0, Math.min(5, testCases.length));
    const qualityScore = await this.evaluateQualityWithAI(sample, ticketData);
    fitness += qualityScore * 40;
    
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
      const systemMessage = `You are a QA quality evaluator. Score test cases from 0-1 based on:
- Clarity of test steps
- Relevance to requirements
- Realistic test data
- Clear expected results

Return ONLY a number between 0 and 1.`;

      const userMessage = `Evaluate these test cases quality:

Ticket: ${ticketData.key} - ${ticketData.summary}

Sample Tests:
${sampleTests.map((tc, idx) => `${idx + 1}. [${tc.category}] ${tc.title}\nSteps: ${tc.steps?.join(', ')}`).join('\n\n')}

Return quality score (0-1):`;

      const response = await this.callAI(systemMessage, userMessage, this.settings);
      const score = parseFloat(response.trim());
      return isNaN(score) ? 0.7 : Math.max(0, Math.min(1, score));
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
      'contextShifting'
    ];
    
    for (let i = 0; i < offspring.length; i++) {
      if (Math.random() < this.mutationRate) {
        const strategy = mutationStrategies[Math.floor(Math.random() * mutationStrategies.length)];
        offspring[i] = await this.applyMutation(offspring[i], strategy, ticketData);
      }
    }
    
    return offspring;
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
        const mutatedTests = JSON.parse(jsonMatch[0]);
        
        // Replace mutated tests in original array
        indicesToMutate.forEach((idx, i) => {
          if (mutatedTests[i]) {
            testCases[idx] = mutatedTests[i];
          }
        });
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
      contextShifting: 'Change test context: different users, environments, states, concurrent operations.'
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
