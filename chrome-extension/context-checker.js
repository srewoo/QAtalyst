/**
 * Context Quality Checker - Validates context availability and quality before test generation
 * Prevents generic test generation by requiring minimum context threshold
 *
 * Version: 1.0.0
 * Purpose: Address generic test fallback issue
 */

class ContextQualityChecker {
  constructor() {
    this.minimumThresholds = {
      pages: 1,           // At least 1 page crawled
      forms: 0,           // Optional but recommended
      apis: 0,            // Optional but recommended
      features: 3,        // At least 3 UI features (buttons, etc.)
      totalElements: 5    // Minimum total elements
    };

    this.qualityLevels = {
      EXCELLENT: 90,
      GOOD: 70,
      FAIR: 50,
      POOR: 30,
      INSUFFICIENT: 0
    };
  }

  /**
   * Check if context is available and sufficient for test generation
   * Returns detailed assessment with recommendations
   */
  checkContext(appContext, ticketData) {
    const assessment = {
      hasContext: false,
      qualityScore: 0,
      qualityLevel: 'INSUFFICIENT',
      canGenerate: false,
      shouldWarn: false,
      recommendations: [],
      details: {
        knowledgeGraph: null,
        externalSources: null,
        ticketQuality: null
      }
    };

    // Check knowledge graph
    const kgAssessment = this.assessKnowledgeGraph(appContext?.knowledgeGraph);
    assessment.details.knowledgeGraph = kgAssessment;

    // Check external sources (Confluence, Figma, Google Docs)
    const externalAssessment = this.assessExternalSources(ticketData);
    assessment.details.externalSources = externalAssessment;

    // Check ticket quality
    const ticketAssessment = this.assessTicketQuality(ticketData);
    assessment.details.ticketQuality = ticketAssessment;

    // Calculate overall quality score (weighted)
    assessment.qualityScore = this.calculateQualityScore(
      kgAssessment,
      externalAssessment,
      ticketAssessment
    );

    // Determine if context is sufficient
    assessment.hasContext = kgAssessment.score > 0 || externalAssessment.score > 0;
    assessment.qualityLevel = this.determineQualityLevel(assessment.qualityScore);
    assessment.canGenerate = assessment.qualityScore >= this.qualityLevels.POOR;
    assessment.shouldWarn = assessment.qualityScore < this.qualityLevels.FAIR;

    // Generate recommendations
    assessment.recommendations = this.generateRecommendations(assessment);

    return assessment;
  }

  /**
   * Assess knowledge graph quality
   */
  assessKnowledgeGraph(knowledgeGraph) {
    const assessment = {
      available: false,
      score: 0,
      metrics: {
        pages: 0,
        forms: 0,
        apis: 0,
        buttons: 0,
        tables: 0,
        totalFeatures: 0
      },
      strengths: [],
      weaknesses: []
    };

    if (!knowledgeGraph) {
      assessment.weaknesses.push('No knowledge graph available - application not crawled');
      return assessment;
    }

    assessment.available = true;

    // Count pages - handle both object and totalPages formats
    if (knowledgeGraph.pages) {
      assessment.metrics.pages = typeof knowledgeGraph.pages === 'object'
        ? Object.keys(knowledgeGraph.pages).length
        : 0;
    }
    // Also check totalPages (used in merged graphs and stats)
    if (knowledgeGraph.totalPages && knowledgeGraph.totalPages > assessment.metrics.pages) {
      assessment.metrics.pages = knowledgeGraph.totalPages;
    }

    // Count forms - from array or stats
    if (knowledgeGraph.forms && Array.isArray(knowledgeGraph.forms)) {
      assessment.metrics.forms = knowledgeGraph.forms.length;
    } else if (knowledgeGraph.stats?.totalForms) {
      assessment.metrics.forms = knowledgeGraph.stats.totalForms;
    }

    // Count APIs - from array or stats
    if (knowledgeGraph.apis && Array.isArray(knowledgeGraph.apis)) {
      assessment.metrics.apis = knowledgeGraph.apis.length;
    } else if (knowledgeGraph.stats?.totalApis) {
      assessment.metrics.apis = knowledgeGraph.stats.totalApis;
    }

    // Count features - from array or stats
    if (knowledgeGraph.features && Array.isArray(knowledgeGraph.features)) {
      const features = knowledgeGraph.features;
      assessment.metrics.buttons = features.filter(f => f.type === 'button').length;
      assessment.metrics.tables = features.filter(f => f.type === 'table').length;
      assessment.metrics.totalFeatures = features.length;
    } else if (knowledgeGraph.stats?.totalFeatures) {
      // Use stats for merged graphs where features array may not be present
      assessment.metrics.totalFeatures = knowledgeGraph.stats.totalFeatures;
      assessment.metrics.buttons = knowledgeGraph.stats.totalButtons || 0;
      assessment.metrics.tables = knowledgeGraph.stats.totalTables || 0;
    }

    // Calculate score (0-100)
    let score = 0;

    // Pages (20 points max) - scale for large crawls
    if (assessment.metrics.pages >= 100) {
      score += 20; // Max points for 100+ pages
    } else if (assessment.metrics.pages >= 50) {
      score += 18;
    } else if (assessment.metrics.pages >= 20) {
      score += 15;
    } else {
      score += Math.min(assessment.metrics.pages * 2, 20);
    }

    // Forms (25 points max)
    score += Math.min(assessment.metrics.forms * 5, 25);

    // APIs (25 points max)
    score += Math.min(assessment.metrics.apis * 2, 25);

    // Features (30 points max) - scale for large crawls
    if (assessment.metrics.totalFeatures >= 1000) {
      score += 30; // Max points for 1000+ features
    } else if (assessment.metrics.totalFeatures >= 500) {
      score += 28;
    } else if (assessment.metrics.totalFeatures >= 100) {
      score += 25;
    } else {
      score += Math.min(assessment.metrics.totalFeatures * 0.3, 30);
    }

    assessment.score = Math.min(score, 100);

    // Identify strengths
    if (assessment.metrics.forms > 3) {
      assessment.strengths.push(`${assessment.metrics.forms} forms detected - excellent for form testing`);
    }
    if (assessment.metrics.apis > 10) {
      assessment.strengths.push(`${assessment.metrics.apis} API endpoints captured - good for integration tests`);
    }
    if (assessment.metrics.pages > 20) {
      assessment.strengths.push(`${assessment.metrics.pages} pages crawled - comprehensive coverage`);
    }
    if (assessment.metrics.totalFeatures > 100) {
      assessment.strengths.push(`${assessment.metrics.totalFeatures} UI features detected - rich context available`);
    }

    // Identify weaknesses
    if (assessment.metrics.forms === 0) {
      assessment.weaknesses.push('No forms detected - limited form testing capability');
    }
    if (assessment.metrics.apis === 0) {
      assessment.weaknesses.push('No API endpoints captured - limited integration testing');
    }
    if (assessment.metrics.pages < 5) {
      assessment.weaknesses.push('Few pages crawled - consider expanding crawl scope');
    }

    return assessment;
  }

  /**
   * Assess external sources (Confluence, Figma, Google Docs)
   */
  assessExternalSources(ticketData) {
    const assessment = {
      available: false,
      score: 0,
      sources: {
        confluence: 0,
        figma: 0,
        googleDocs: 0
      },
      strengths: [],
      weaknesses: []
    };

    // Check linked pages
    if (ticketData.linkedPages && Array.isArray(ticketData.linkedPages)) {
      ticketData.linkedPages.forEach(page => {
        if (page.type === 'confluence') assessment.sources.confluence++;
        else if (page.type === 'figma') assessment.sources.figma++;
        else if (page.type === 'google_docs' || page.type === 'google_drive') {
          assessment.sources.googleDocs++;
        }
      });
    }

    const totalSources = assessment.sources.confluence +
                        assessment.sources.figma +
                        assessment.sources.googleDocs;

    assessment.available = totalSources > 0;

    // Calculate score (0-100)
    // Each source type worth 33 points, max 100
    assessment.score = Math.min(
      (assessment.sources.confluence * 33) +
      (assessment.sources.figma * 33) +
      (assessment.sources.googleDocs * 33),
      100
    );

    // Identify strengths
    if (assessment.sources.confluence > 0) {
      assessment.strengths.push(`${assessment.sources.confluence} Confluence page(s) linked - good for requirements`);
    }
    if (assessment.sources.figma > 0) {
      assessment.strengths.push(`${assessment.sources.figma} Figma design(s) linked - good for UI validation`);
    }
    if (assessment.sources.googleDocs > 0) {
      assessment.strengths.push(`${assessment.sources.googleDocs} Google Doc(s) linked - additional context available`);
    }

    // Identify weaknesses
    if (totalSources === 0) {
      assessment.weaknesses.push('No external sources linked - consider adding Confluence/Figma/Docs links');
    }

    return assessment;
  }

  /**
   * Assess Jira ticket quality
   */
  assessTicketQuality(ticketData) {
    const assessment = {
      available: true,
      score: 0,
      metrics: {
        hasDescription: false,
        descriptionLength: 0,
        hasComments: false,
        commentCount: 0,
        hasAttachments: false,
        attachmentCount: 0,
        hasAcceptanceCriteria: false
      },
      strengths: [],
      weaknesses: []
    };

    // Check description
    if (ticketData.description) {
      assessment.metrics.hasDescription = true;
      assessment.metrics.descriptionLength = ticketData.description.length;
    }

    // Check comments
    if (ticketData.comments && Array.isArray(ticketData.comments)) {
      assessment.metrics.hasComments = ticketData.comments.length > 0;
      assessment.metrics.commentCount = ticketData.comments.length;
    }

    // Check attachments
    if (ticketData.attachments && Array.isArray(ticketData.attachments)) {
      assessment.metrics.hasAttachments = ticketData.attachments.length > 0;
      assessment.metrics.attachmentCount = ticketData.attachments.length;
    }

    // Check for acceptance criteria keywords
    const description = (ticketData.description || '').toLowerCase();
    const hasAC = description.includes('acceptance criteria') ||
                  description.includes('ac:') ||
                  description.includes('given') && description.includes('when') && description.includes('then');
    assessment.metrics.hasAcceptanceCriteria = hasAC;

    // Calculate score (0-100)
    let score = 0;

    // Description (40 points max)
    if (assessment.metrics.hasDescription) {
      score += 10; // Base points for having description
      // Bonus for length (up to 30 points)
      score += Math.min(assessment.metrics.descriptionLength / 20, 30);
    }

    // Acceptance criteria (30 points)
    if (assessment.metrics.hasAcceptanceCriteria) {
      score += 30;
    }

    // Comments (15 points max)
    score += Math.min(assessment.metrics.commentCount * 3, 15);

    // Attachments (15 points max)
    score += Math.min(assessment.metrics.attachmentCount * 5, 15);

    assessment.score = Math.min(score, 100);

    // Identify strengths
    if (assessment.metrics.descriptionLength > 500) {
      assessment.strengths.push('Detailed description provided');
    }
    if (assessment.metrics.hasAcceptanceCriteria) {
      assessment.strengths.push('Acceptance criteria defined');
    }
    if (assessment.metrics.commentCount > 3) {
      assessment.strengths.push(`${assessment.metrics.commentCount} comments with additional context`);
    }

    // Identify weaknesses
    if (!assessment.metrics.hasDescription) {
      assessment.weaknesses.push('No description provided - tests will be very generic');
    } else if (assessment.metrics.descriptionLength < 100) {
      assessment.weaknesses.push('Brief description - consider adding more details');
    }
    if (!assessment.metrics.hasAcceptanceCriteria) {
      assessment.weaknesses.push('No clear acceptance criteria - consider adding');
    }

    return assessment;
  }

  /**
   * Calculate overall quality score (weighted average)
   */
  calculateQualityScore(kgAssessment, externalAssessment, ticketAssessment) {
    // Weights: Knowledge Graph (50%), External Sources (25%), Ticket (25%)
    const weights = {
      knowledgeGraph: 0.50,
      externalSources: 0.25,
      ticket: 0.25
    };

    return Math.round(
      (kgAssessment.score * weights.knowledgeGraph) +
      (externalAssessment.score * weights.externalSources) +
      (ticketAssessment.score * weights.ticket)
    );
  }

  /**
   * Determine quality level from score
   */
  determineQualityLevel(score) {
    if (score >= this.qualityLevels.EXCELLENT) return 'EXCELLENT';
    if (score >= this.qualityLevels.GOOD) return 'GOOD';
    if (score >= this.qualityLevels.FAIR) return 'FAIR';
    if (score >= this.qualityLevels.POOR) return 'POOR';
    return 'INSUFFICIENT';
  }

  /**
   * Generate actionable recommendations based on assessment
   */
  generateRecommendations(assessment) {
    const recommendations = [];

    // Critical recommendations (insufficient context)
    if (assessment.qualityScore < this.qualityLevels.POOR) {
      recommendations.push({
        priority: 'CRITICAL',
        category: 'Context',
        message: 'Insufficient context for reliable test generation',
        actions: [
          'Crawl the application to build knowledge graph',
          'Link Confluence pages with requirements',
          'Add Figma designs to Jira ticket',
          'Expand Jira ticket description with details'
        ]
      });
    }

    // Knowledge graph recommendations
    const kg = assessment.details.knowledgeGraph;
    if (kg && !kg.available) {
      recommendations.push({
        priority: 'HIGH',
        category: 'Knowledge Graph',
        message: 'No application crawl data available',
        actions: [
          'Run web crawler on the application',
          'Generate knowledge graph with forms, APIs, and UI elements',
          'This will enable context-specific test generation'
        ]
      });
    } else if (kg && kg.score < 50) {
      recommendations.push({
        priority: 'MEDIUM',
        category: 'Knowledge Graph',
        message: 'Limited crawl data available',
        actions: [
          'Consider expanding crawl scope (more pages)',
          'Ensure interactive pages (forms, APIs) are crawled',
          'Check if crawler detected all relevant features'
        ]
      });
    }

    // External sources recommendations
    const ext = assessment.details.externalSources;
    if (ext && !ext.available) {
      recommendations.push({
        priority: 'MEDIUM',
        category: 'External Sources',
        message: 'No external documentation linked',
        actions: [
          'Link Confluence requirements pages',
          'Attach Figma design files',
          'Add Google Docs if available'
        ]
      });
    }

    // Ticket quality recommendations
    const ticket = assessment.details.ticketQuality;
    if (ticket && ticket.score < 50) {
      const ticketActions = [];
      if (!ticket.metrics.hasAcceptanceCriteria) {
        ticketActions.push('Add clear acceptance criteria');
      }
      if (ticket.metrics.descriptionLength < 100) {
        ticketActions.push('Expand description with feature details');
      }

      if (ticketActions.length > 0) {
        recommendations.push({
          priority: 'MEDIUM',
          category: 'Jira Ticket',
          message: 'Ticket lacks detail for comprehensive testing',
          actions: ticketActions
        });
      }
    }

    // Positive feedback
    if (assessment.qualityScore >= this.qualityLevels.GOOD) {
      recommendations.push({
        priority: 'INFO',
        category: 'Context Quality',
        message: 'Good context available - tests will be well-grounded',
        actions: ['Proceed with test generation']
      });
    }

    return recommendations;
  }

  /**
   * Format assessment for display
   */
  formatAssessmentForDisplay(assessment) {
    const lines = [];

    lines.push(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`📊 CONTEXT QUALITY ASSESSMENT`);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    // Overall score
    const scoreEmoji = assessment.qualityScore >= 70 ? '✅' :
                      assessment.qualityScore >= 50 ? '⚠️' : '❌';
    lines.push(`${scoreEmoji} Overall Quality: ${assessment.qualityLevel} (${assessment.qualityScore}/100)`);
    lines.push(`${assessment.canGenerate ? '✅' : '❌'} Can Generate: ${assessment.canGenerate ? 'Yes' : 'No (insufficient context)'}\n`);

    // Knowledge graph
    const kg = assessment.details.knowledgeGraph;
    if (kg) {
      lines.push(`📚 Knowledge Graph: ${kg.available ? 'Available' : 'Not Available'} (Score: ${kg.score}/100)`);
      if (kg.available) {
        lines.push(`   • Pages: ${kg.metrics.pages}`);
        lines.push(`   • Forms: ${kg.metrics.forms}`);
        lines.push(`   • APIs: ${kg.metrics.apis}`);
        lines.push(`   • Buttons: ${kg.metrics.buttons}`);
      }
      lines.push('');
    }

    // External sources
    const ext = assessment.details.externalSources;
    if (ext && ext.available) {
      lines.push(`🔗 External Sources: (Score: ${ext.score}/100)`);
      if (ext.sources.confluence > 0) lines.push(`   • Confluence: ${ext.sources.confluence} page(s)`);
      if (ext.sources.figma > 0) lines.push(`   • Figma: ${ext.sources.figma} design(s)`);
      if (ext.sources.googleDocs > 0) lines.push(`   • Google Docs: ${ext.sources.googleDocs} doc(s)`);
      lines.push('');
    }

    // Recommendations
    if (assessment.recommendations.length > 0) {
      lines.push(`💡 RECOMMENDATIONS:\n`);
      assessment.recommendations.forEach((rec, i) => {
        const priorityEmoji = rec.priority === 'CRITICAL' ? '🔴' :
                             rec.priority === 'HIGH' ? '🟠' :
                             rec.priority === 'MEDIUM' ? '🟡' : 'ℹ️';
        lines.push(`${priorityEmoji} ${rec.category}: ${rec.message}`);
        rec.actions.forEach(action => {
          lines.push(`   → ${action}`);
        });
        if (i < assessment.recommendations.length - 1) lines.push('');
      });
    }

    lines.push(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    return lines.join('\n');
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = ContextQualityChecker;
}

// Make available globally in browser/service worker context
if (typeof window !== 'undefined') {
  window.ContextQualityChecker = ContextQualityChecker;
} else if (typeof self !== 'undefined') {
  self.ContextQualityChecker = ContextQualityChecker;
}
