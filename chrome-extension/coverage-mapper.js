/**
 * Coverage Mapper - Maps test cases to knowledge graph features
 * Shows which forms/APIs/features are tested vs untested
 *
 * Version: 1.0.0
 * Purpose: Provide visibility into test coverage and identify gaps
 */

class CoverageMapper {
  constructor(knowledgeGraph) {
    this.knowledgeGraph = knowledgeGraph;
    this.coverageMap = null;
  }

  /**
   * Map test cases to knowledge graph features
   * Returns comprehensive coverage report
   */
  mapCoverage(testCases) {
    const coverage = {
      overall: {
        totalFeatures: 0,
        coveredFeatures: 0,
        uncoveredFeatures: 0,
        coveragePercentage: 0
      },
      forms: {
        total: 0,
        covered: 0,
        uncovered: 0,
        percentage: 0,
        details: []
      },
      apis: {
        total: 0,
        covered: 0,
        uncovered: 0,
        percentage: 0,
        details: []
      },
      buttons: {
        total: 0,
        covered: 0,
        uncovered: 0,
        percentage: 0,
        details: []
      },
      pages: {
        total: 0,
        covered: 0,
        uncovered: 0,
        percentage: 0,
        details: []
      },
      testMapping: [] // Which tests cover which features
    };

    if (!this.knowledgeGraph) {
      return coverage;
    }

    // Build feature inventory from knowledge graph
    const inventory = this.buildFeatureInventory();

    // Map each test case to features
    testCases.forEach((testCase, index) => {
      const mappedFeatures = this.mapTestToFeatures(testCase, inventory);

      coverage.testMapping.push({
        testId: testCase.id,
        testTitle: testCase.title,
        coveredFeatures: mappedFeatures
      });

      // Mark features as covered
      mappedFeatures.forEach(feature => {
        if (feature.type === 'form') {
          const formDetail = coverage.forms.details.find(f => f.id === feature.id);
          if (formDetail) formDetail.covered = true;
        } else if (feature.type === 'api') {
          const apiDetail = coverage.apis.details.find(a => a.endpoint === feature.id);
          if (apiDetail) apiDetail.covered = true;
        } else if (feature.type === 'button') {
          const buttonDetail = coverage.buttons.details.find(b => b.text === feature.id);
          if (buttonDetail) buttonDetail.covered = true;
        } else if (feature.type === 'page') {
          const pageDetail = coverage.pages.details.find(p => p.url === feature.id);
          if (pageDetail) pageDetail.covered = true;
        }
      });
    });

    // Initialize feature details from inventory
    coverage.forms.details = inventory.forms.map(f => ({
      id: f.id,
      url: f.url,
      fields: f.fields,
      covered: false
    }));

    coverage.apis.details = inventory.apis.map(a => ({
      method: a.method,
      endpoint: a.endpoint,
      url: a.url,
      covered: false
    }));

    coverage.buttons.details = inventory.buttons.map(b => ({
      text: b.text,
      url: b.url,
      covered: false
    }));

    coverage.pages.details = inventory.pages.map(p => ({
      url: p.url,
      title: p.title,
      covered: false
    }));

    // Re-mark covered features (since we just reinitialized)
    coverage.testMapping.forEach(mapping => {
      mapping.coveredFeatures.forEach(feature => {
        if (feature.type === 'form') {
          const formDetail = coverage.forms.details.find(f => f.id === feature.id);
          if (formDetail) formDetail.covered = true;
        } else if (feature.type === 'api') {
          const apiDetail = coverage.apis.details.find(a => a.endpoint === feature.id);
          if (apiDetail) apiDetail.covered = true;
        } else if (feature.type === 'button') {
          const buttonDetail = coverage.buttons.details.find(b => b.text === feature.id);
          if (buttonDetail) buttonDetail.covered = true;
        } else if (feature.type === 'page') {
          const pageDetail = coverage.pages.details.find(p => p.url === feature.id);
          if (pageDetail) pageDetail.covered = true;
        }
      });
    });

    // Calculate coverage statistics
    coverage.forms.total = coverage.forms.details.length;
    coverage.forms.covered = coverage.forms.details.filter(f => f.covered).length;
    coverage.forms.uncovered = coverage.forms.total - coverage.forms.covered;
    coverage.forms.percentage = coverage.forms.total > 0
      ? Math.round((coverage.forms.covered / coverage.forms.total) * 100)
      : 0;

    coverage.apis.total = coverage.apis.details.length;
    coverage.apis.covered = coverage.apis.details.filter(a => a.covered).length;
    coverage.apis.uncovered = coverage.apis.total - coverage.apis.covered;
    coverage.apis.percentage = coverage.apis.total > 0
      ? Math.round((coverage.apis.covered / coverage.apis.total) * 100)
      : 0;

    coverage.buttons.total = coverage.buttons.details.length;
    coverage.buttons.covered = coverage.buttons.details.filter(b => b.covered).length;
    coverage.buttons.uncovered = coverage.buttons.total - coverage.buttons.covered;
    coverage.buttons.percentage = coverage.buttons.total > 0
      ? Math.round((coverage.buttons.covered / coverage.buttons.total) * 100)
      : 0;

    coverage.pages.total = coverage.pages.details.length;
    coverage.pages.covered = coverage.pages.details.filter(p => p.covered).length;
    coverage.pages.uncovered = coverage.pages.total - coverage.pages.covered;
    coverage.pages.percentage = coverage.pages.total > 0
      ? Math.round((coverage.pages.covered / coverage.pages.total) * 100)
      : 0;

    // Overall coverage
    coverage.overall.totalFeatures =
      coverage.forms.total +
      coverage.apis.total +
      coverage.buttons.total;

    coverage.overall.coveredFeatures =
      coverage.forms.covered +
      coverage.apis.covered +
      coverage.buttons.covered;

    coverage.overall.uncoveredFeatures =
      coverage.overall.totalFeatures - coverage.overall.coveredFeatures;

    coverage.overall.coveragePercentage = coverage.overall.totalFeatures > 0
      ? Math.round((coverage.overall.coveredFeatures / coverage.overall.totalFeatures) * 100)
      : 0;

    this.coverageMap = coverage;
    return coverage;
  }

  /**
   * Build inventory of all features from knowledge graph
   */
  buildFeatureInventory() {
    const inventory = {
      forms: [],
      apis: [],
      buttons: [],
      pages: []
    };

    if (!this.knowledgeGraph) {
      return inventory;
    }

    // Extract forms
    if (this.knowledgeGraph.forms && Array.isArray(this.knowledgeGraph.forms)) {
      this.knowledgeGraph.forms.forEach(form => {
        inventory.forms.push({
          id: form.id || form.action || 'unknown',
          url: form.url || '',
          fields: (form.inputs || []).map(inp => inp.name || inp.id).filter(Boolean)
        });
      });
    }

    // Extract APIs
    if (this.knowledgeGraph.apis && Array.isArray(this.knowledgeGraph.apis)) {
      this.knowledgeGraph.apis.forEach(api => {
        inventory.apis.push({
          method: api.method || 'GET',
          endpoint: api.endpoint || '',
          url: api.url || ''
        });
      });
    }

    // Extract buttons
    if (this.knowledgeGraph.features && Array.isArray(this.knowledgeGraph.features)) {
      this.knowledgeGraph.features.forEach(feature => {
        if (feature.type === 'button' && feature.text) {
          inventory.buttons.push({
            text: feature.text,
            url: feature.url || ''
          });
        }
      });
    }

    // Extract pages
    if (this.knowledgeGraph.pages && typeof this.knowledgeGraph.pages === 'object') {
      Object.keys(this.knowledgeGraph.pages).forEach(url => {
        const page = this.knowledgeGraph.pages[url];
        inventory.pages.push({
          url: url,
          title: page.title || ''
        });
      });
    }

    return inventory;
  }

  /**
   * Map a single test case to features it covers
   */
  mapTestToFeatures(testCase, inventory) {
    const coveredFeatures = [];

    // Combine all test text
    const allText = [
      testCase.title || '',
      testCase.description || '',
      testCase.preconditions || '',
      testCase.expected_result || '',
      ...(testCase.steps || [])
    ].join(' ').toLowerCase();

    // Check forms
    inventory.forms.forEach(form => {
      const formId = (form.id || '').toLowerCase();
      if (formId && allText.includes(formId)) {
        coveredFeatures.push({
          type: 'form',
          id: form.id,
          confidence: 'HIGH'
        });
      } else {
        // Check if any form fields are mentioned
        const mentionedFields = form.fields.filter(field =>
          allText.includes(field.toLowerCase())
        );
        if (mentionedFields.length > 0) {
          coveredFeatures.push({
            type: 'form',
            id: form.id,
            confidence: mentionedFields.length >= form.fields.length / 2 ? 'HIGH' : 'MEDIUM'
          });
        }
      }
    });

    // Check APIs
    inventory.apis.forEach(api => {
      const endpoint = (api.endpoint || '').toLowerCase();
      if (endpoint && allText.includes(endpoint)) {
        coveredFeatures.push({
          type: 'api',
          id: api.endpoint,
          confidence: 'HIGH'
        });
      } else if (api.method && allText.includes(api.method.toLowerCase())) {
        // Check if method + partial endpoint match
        const endpointParts = endpoint.split('/').filter(Boolean);
        const matchedParts = endpointParts.filter(part => allText.includes(part));
        if (matchedParts.length >= endpointParts.length / 2) {
          coveredFeatures.push({
            type: 'api',
            id: api.endpoint,
            confidence: 'MEDIUM'
          });
        }
      }
    });

    // Check buttons
    inventory.buttons.forEach(button => {
      const buttonText = (button.text || '').toLowerCase();
      if (buttonText && allText.includes(buttonText)) {
        coveredFeatures.push({
          type: 'button',
          id: button.text,
          confidence: 'HIGH'
        });
      }
    });

    // Check pages
    inventory.pages.forEach(page => {
      const pageUrl = (page.url || '').toLowerCase();
      const pageTitle = (page.title || '').toLowerCase();

      if (pageUrl && allText.includes(pageUrl)) {
        coveredFeatures.push({
          type: 'page',
          id: page.url,
          confidence: 'HIGH'
        });
      } else if (pageTitle && allText.includes(pageTitle)) {
        coveredFeatures.push({
          type: 'page',
          id: page.url,
          confidence: 'MEDIUM'
        });
      }
    });

    return coveredFeatures;
  }

  /**
   * Identify coverage gaps and critical untested features
   */
  identifyGaps(coverage) {
    const gaps = {
      critical: [],
      important: [],
      optional: [],
      summary: ''
    };

    // Uncovered forms (CRITICAL if they have many fields or are on important pages)
    coverage.forms.details.filter(f => !f.covered).forEach(form => {
      const priority = form.fields.length > 5 ? 'critical' : 'important';
      gaps[priority].push({
        type: 'Form',
        identifier: form.id,
        url: form.url,
        reason: `Form with ${form.fields.length} fields not tested`,
        recommendation: `Add tests for form submission, validation, and error handling`
      });
    });

    // Uncovered APIs (CRITICAL for POST/PUT/DELETE, IMPORTANT for GET)
    coverage.apis.details.filter(a => !a.covered).forEach(api => {
      const priority = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(api.method)
        ? 'critical'
        : 'important';
      gaps[priority].push({
        type: 'API',
        identifier: `${api.method} ${api.endpoint}`,
        url: api.url,
        reason: `${api.method} endpoint not tested`,
        recommendation: `Add integration test for ${api.method} ${api.endpoint}`
      });
    });

    // Uncovered buttons (IMPORTANT for actions, OPTIONAL for navigation)
    coverage.buttons.details.filter(b => !b.covered).forEach(button => {
      const isAction = /submit|save|create|delete|update|confirm|apply/i.test(button.text);
      const priority = isAction ? 'important' : 'optional';
      gaps[priority].push({
        type: 'Button',
        identifier: button.text,
        url: button.url,
        reason: `Button "${button.text}" not tested`,
        recommendation: `Add test clicking "${button.text}" button`
      });
    });

    // Generate summary
    const totalGaps = gaps.critical.length + gaps.important.length + gaps.optional.length;
    gaps.summary = `Found ${totalGaps} coverage gaps: ${gaps.critical.length} critical, ${gaps.important.length} important, ${gaps.optional.length} optional`;

    return gaps;
  }

  /**
   * Generate coverage report for display
   */
  generateReport(coverage) {
    const gaps = this.identifyGaps(coverage);

    const report = {
      summary: {
        overallCoverage: coverage.overall.coveragePercentage,
        totalFeatures: coverage.overall.totalFeatures,
        coveredFeatures: coverage.overall.coveredFeatures,
        uncoveredFeatures: coverage.overall.uncoveredFeatures,
        status: this.getCoverageStatus(coverage.overall.coveragePercentage)
      },
      breakdown: {
        forms: `${coverage.forms.covered}/${coverage.forms.total} (${coverage.forms.percentage}%)`,
        apis: `${coverage.apis.covered}/${coverage.apis.total} (${coverage.apis.percentage}%)`,
        buttons: `${coverage.buttons.covered}/${coverage.buttons.total} (${coverage.buttons.percentage}%)`
      },
      gaps: gaps,
      recommendations: this.generateRecommendations(coverage, gaps)
    };

    return report;
  }

  getCoverageStatus(percentage) {
    if (percentage >= 80) return 'EXCELLENT';
    if (percentage >= 60) return 'GOOD';
    if (percentage >= 40) return 'FAIR';
    if (percentage >= 20) return 'POOR';
    return 'INSUFFICIENT';
  }

  generateRecommendations(coverage, gaps) {
    const recommendations = [];

    if (coverage.overall.coveragePercentage < 60) {
      recommendations.push({
        priority: 'HIGH',
        message: 'Overall coverage is below 60% - significant gaps exist',
        action: 'Focus on testing critical forms and APIs first'
      });
    }

    if (gaps.critical.length > 0) {
      recommendations.push({
        priority: 'CRITICAL',
        message: `${gaps.critical.length} critical features untested`,
        action: 'Generate tests for uncovered forms and write operations (POST/PUT/DELETE)'
      });
    }

    if (coverage.forms.percentage < 50) {
      recommendations.push({
        priority: 'HIGH',
        message: `Only ${coverage.forms.percentage}% of forms are tested`,
        action: 'Add form validation tests, submission tests, and error handling tests'
      });
    }

    if (coverage.apis.percentage < 50) {
      recommendations.push({
        priority: 'HIGH',
        message: `Only ${coverage.apis.percentage}% of APIs are tested`,
        action: 'Add integration tests for API endpoints'
      });
    }

    if (coverage.overall.coveragePercentage >= 80) {
      recommendations.push({
        priority: 'INFO',
        message: 'Excellent coverage achieved!',
        action: 'Focus on edge cases and security tests'
      });
    }

    return recommendations;
  }

  /**
   * Format coverage report for display
   */
  formatReportForDisplay(report) {
    const lines = [];

    lines.push(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`📊 TEST COVERAGE ANALYSIS`);
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    // Overall summary
    const statusEmoji = report.summary.status === 'EXCELLENT' ? '✅' :
                       report.summary.status === 'GOOD' ? '👍' :
                       report.summary.status === 'FAIR' ? '⚠️' : '❌';
    lines.push(`${statusEmoji} Overall Coverage: ${report.summary.overallCoverage}% (${report.summary.status})`);
    lines.push(`   • Features: ${report.summary.coveredFeatures}/${report.summary.totalFeatures}`);
    lines.push(`   • Gaps: ${report.summary.uncoveredFeatures}\n`);

    // Breakdown
    lines.push(`📋 Coverage Breakdown:`);
    lines.push(`   • Forms: ${report.breakdown.forms}`);
    lines.push(`   • APIs: ${report.breakdown.apis}`);
    lines.push(`   • Buttons: ${report.breakdown.buttons}\n`);

    // Gaps
    if (report.gaps.critical.length > 0 || report.gaps.important.length > 0) {
      lines.push(`🔍 Coverage Gaps:\n`);

      if (report.gaps.critical.length > 0) {
        lines.push(`   🔴 CRITICAL (${report.gaps.critical.length}):`);
        report.gaps.critical.slice(0, 5).forEach(gap => {
          lines.push(`      • ${gap.type}: ${gap.identifier}`);
          lines.push(`        → ${gap.recommendation}`);
        });
        if (report.gaps.critical.length > 5) {
          lines.push(`      ... and ${report.gaps.critical.length - 5} more`);
        }
        lines.push('');
      }

      if (report.gaps.important.length > 0) {
        lines.push(`   🟡 IMPORTANT (${report.gaps.important.length}):`);
        report.gaps.important.slice(0, 5).forEach(gap => {
          lines.push(`      • ${gap.type}: ${gap.identifier}`);
        });
        if (report.gaps.important.length > 5) {
          lines.push(`      ... and ${report.gaps.important.length - 5} more`);
        }
        lines.push('');
      }
    }

    // Recommendations
    if (report.recommendations.length > 0) {
      lines.push(`💡 RECOMMENDATIONS:\n`);
      report.recommendations.forEach(rec => {
        const emoji = rec.priority === 'CRITICAL' ? '🔴' :
                     rec.priority === 'HIGH' ? '🟠' :
                     rec.priority === 'MEDIUM' ? '🟡' : 'ℹ️';
        lines.push(`${emoji} ${rec.message}`);
        lines.push(`   → ${rec.action}\n`);
      });
    }

    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    return lines.join('\n');
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = CoverageMapper;
}

// Make available globally
if (typeof window !== 'undefined') {
  window.CoverageMapper = CoverageMapper;
} else if (typeof self !== 'undefined') {
  self.CoverageMapper = CoverageMapper;
}
