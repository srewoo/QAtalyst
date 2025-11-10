/**
 * Knowledge Graph Merger
 * Intelligently combines multiple knowledge graphs from different sources
 *
 * Use Cases:
 * - Merge help site documentation with actual application crawl
 * - Combine multiple crawls of the same app over time
 * - Merge different environments (staging + production)
 *
 * Features:
 * - Smart page matching by URL patterns and titles
 * - Feature deduplication and enrichment
 * - API endpoint merging
 * - Metadata combination
 * - Conflict resolution with priority rules
 */

class KnowledgeGraphMerger {
  constructor(options = {}) {
    this.options = {
      // Matching thresholds
      titleSimilarityThreshold: 0.7,
      urlPatternMatchThreshold: 0.6,

      // Priority rules (higher = more authoritative)
      sourcePriority: {
        'app': 100,        // Actual app is most authoritative for technical details
        'helpsite': 80,    // Help site is authoritative for documentation
        'staging': 60,     // Staging environment
        'default': 50      // Unknown sources
      },

      // Merge strategies
      preferActualImplementation: true,  // Prefer app data for forms, APIs
      preferDocumentation: true,         // Prefer help site for descriptions

      ...options
    };
  }

  /**
   * Merge multiple knowledge graphs into one
   */
  async mergeGraphs(graphs) {
    console.log(`🔀 Merging ${graphs.length} knowledge graphs...`);

    if (graphs.length === 0) {
      throw new Error('No knowledge graphs provided');
    }

    if (graphs.length === 1) {
      return graphs[0];
    }

    // Start with first graph as base
    let mergedGraph = JSON.parse(JSON.stringify(graphs[0]));
    mergedGraph.sources = [this.getSourceInfo(graphs[0])];

    // Merge each subsequent graph
    for (let i = 1; i < graphs.length; i++) {
      mergedGraph = await this.mergeTwoGraphs(mergedGraph, graphs[i]);
      mergedGraph.sources.push(this.getSourceInfo(graphs[i]));
    }

    // Update metadata
    mergedGraph.mergedAt = new Date().toISOString();
    mergedGraph.mergeCount = graphs.length;
    mergedGraph.isMerged = true;

    console.log(`✅ Merged ${graphs.length} graphs into one`);
    return mergedGraph;
  }

  /**
   * Merge two knowledge graphs
   */
  async mergeTwoGraphs(graph1, graph2) {
    const merged = {
      appUrl: graph1.appUrl, // Keep primary URL
      alternateUrls: [graph1.appUrl, graph2.appUrl],
      pages: {},
      totalPages: 0,
      stats: {
        totalFeatures: 0,
        totalApis: 0,
        totalForms: 0,
        totalButtons: 0,
        totalTables: 0
      },
      sources: graph1.sources || []
    };

    // Build page maps for matching
    const pages1 = Object.entries(graph1.pages || {});
    const pages2 = Object.entries(graph2.pages || {});

    // Track matched pages
    const matched2 = new Set();

    // Process pages from graph1
    for (const [url1, page1] of pages1) {
      // Try to find matching page in graph2
      const match = this.findMatchingPage(url1, page1, pages2);

      if (match) {
        // Merge matched pages
        const [url2, page2] = match;
        matched2.add(url2);

        const mergedPage = this.mergePages(page1, page2, {
          source1: this.getSourceType(graph1.appUrl),
          source2: this.getSourceType(graph2.appUrl)
        });

        merged.pages[url1] = mergedPage;
      } else {
        // No match, keep page1 as-is
        merged.pages[url1] = page1;
      }
    }

    // Add unmatched pages from graph2
    for (const [url2, page2] of pages2) {
      if (!matched2.has(url2)) {
        merged.pages[url2] = page2;
      }
    }

    // Update stats
    merged.totalPages = Object.keys(merged.pages).length;
    merged.stats = this.calculateStats(merged.pages);

    return merged;
  }

  /**
   * Find matching page between two graphs
   */
  findMatchingPage(url1, page1, pages2) {
    let bestMatch = null;
    let bestScore = 0;

    for (const [url2, page2] of pages2) {
      const score = this.calculatePageSimilarity(url1, page1, url2, page2);

      if (score > bestScore && score > this.options.urlPatternMatchThreshold) {
        bestScore = score;
        bestMatch = [url2, page2];
      }
    }

    return bestMatch;
  }

  /**
   * Calculate similarity score between two pages
   */
  calculatePageSimilarity(url1, page1, url2, page2) {
    let score = 0;
    let weights = 0;

    // 1. URL pattern similarity (30% weight)
    const urlSim = this.calculateUrlSimilarity(url1, url2);
    score += urlSim * 0.3;
    weights += 0.3;

    // 2. Title similarity (40% weight)
    if (page1.metadata?.title && page2.metadata?.title) {
      const titleSim = this.calculateStringSimilarity(
        page1.metadata.title.toLowerCase(),
        page2.metadata.title.toLowerCase()
      );
      score += titleSim * 0.4;
      weights += 0.4;
    }

    // 3. Description similarity (20% weight)
    if (page1.metadata?.description && page2.metadata?.description) {
      const descSim = this.calculateStringSimilarity(
        page1.metadata.description.toLowerCase(),
        page2.metadata.description.toLowerCase()
      );
      score += descSim * 0.2;
      weights += 0.2;
    }

    // 4. Feature type overlap (10% weight)
    const featureTypes1 = new Set((page1.features || []).map(f => f.type));
    const featureTypes2 = new Set((page2.features || []).map(f => f.type));
    const intersection = new Set([...featureTypes1].filter(x => featureTypes2.has(x)));
    const union = new Set([...featureTypes1, ...featureTypes2]);
    const featureSim = union.size > 0 ? intersection.size / union.size : 0;
    score += featureSim * 0.1;
    weights += 0.1;

    return weights > 0 ? score / weights : 0;
  }

  /**
   * Calculate URL similarity based on path patterns
   */
  calculateUrlSimilarity(url1, url2) {
    try {
      const path1 = new URL(url1).pathname.toLowerCase();
      const path2 = new URL(url2).pathname.toLowerCase();

      // Exact match
      if (path1 === path2) return 1.0;

      // Extract keywords from paths
      const keywords1 = path1.split('/').filter(s => s && s.length > 2);
      const keywords2 = path2.split('/').filter(s => s && s.length > 2);

      if (keywords1.length === 0 && keywords2.length === 0) return 0.5;
      if (keywords1.length === 0 || keywords2.length === 0) return 0;

      // Calculate keyword overlap
      const set1 = new Set(keywords1);
      const set2 = new Set(keywords2);
      const intersection = new Set([...set1].filter(x => set2.has(x)));
      const union = new Set([...set1, ...set2]);

      return intersection.size / union.size;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Calculate string similarity (Levenshtein-based)
   */
  calculateStringSimilarity(str1, str2) {
    if (str1 === str2) return 1.0;

    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;

    if (longer.length === 0) return 1.0;

    const distance = this.levenshteinDistance(longer, shorter);
    return (longer.length - distance) / longer.length;
  }

  /**
   * Levenshtein distance algorithm
   */
  levenshteinDistance(str1, str2) {
    const matrix = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  }

  /**
   * Merge two pages intelligently
   */
  mergePages(page1, page2, context) {
    const merged = {
      depth: Math.min(page1.depth || 0, page2.depth || 0),
      metadata: this.mergeMetadata(page1.metadata, page2.metadata, context),
      features: this.mergeFeatures(page1.features, page2.features, context),
      apis: this.mergeApis(page1.apis, page2.apis),
      sources: [context.source1, context.source2]
    };

    return merged;
  }

  /**
   * Merge metadata with priority rules
   */
  mergeMetadata(meta1, meta2, context) {
    const merged = {};

    // Prefer help site for descriptive content
    if (context.source1 === 'helpsite' || context.source2 === 'helpsite') {
      const helpMeta = context.source1 === 'helpsite' ? meta1 : meta2;
      const appMeta = context.source1 === 'app' ? meta1 : meta2;

      merged.title = helpMeta?.title || appMeta?.title || '';
      merged.description = helpMeta?.description || appMeta?.description || '';

      // Use app metadata for technical details
      merged.loadTime = appMeta?.loadTime || helpMeta?.loadTime;
      merged.timestamp = appMeta?.timestamp || helpMeta?.timestamp;
    } else {
      // Default merging
      merged.title = meta1?.title || meta2?.title || '';
      merged.description = meta1?.description || meta2?.description || '';
      merged.loadTime = meta1?.loadTime || meta2?.loadTime;
      merged.timestamp = meta2?.timestamp || meta1?.timestamp; // Prefer newer
    }

    return merged;
  }

  /**
   * Merge features with deduplication
   */
  mergeFeatures(features1 = [], features2 = [], context) {
    const merged = [];
    const seen = new Set();

    // Prefer actual app features for forms, buttons, etc.
    const preferredSource = context.source1 === 'app' ? features1 :
                           context.source2 === 'app' ? features2 :
                           features1;
    const secondarySource = preferredSource === features1 ? features2 : features1;

    // Add preferred features first
    for (const feature of preferredSource) {
      const key = this.getFeatureKey(feature);
      if (!seen.has(key)) {
        merged.push(feature);
        seen.add(key);
      }
    }

    // Add unique features from secondary source
    for (const feature of secondarySource) {
      const key = this.getFeatureKey(feature);
      if (!seen.has(key)) {
        merged.push(feature);
        seen.add(key);
      }
    }

    return merged;
  }

  /**
   * Generate unique key for feature deduplication
   */
  getFeatureKey(feature) {
    if (feature.type === 'form') {
      return `form:${feature.id || feature.action}`;
    } else if (feature.type === 'button') {
      return `button:${feature.text}`;
    } else if (feature.type === 'table') {
      return `table:${feature.id || feature.headers?.join(',')}`;
    } else {
      return `${feature.type}:${feature.id || feature.text || Math.random()}`;
    }
  }

  /**
   * Merge API endpoints with deduplication
   */
  mergeApis(apis1 = [], apis2 = []) {
    const merged = [];
    const seen = new Set();

    for (const api of [...apis1, ...apis2]) {
      const key = `${api.method}:${api.endpoint}`;
      if (!seen.has(key)) {
        merged.push(api);
        seen.add(key);
      }
    }

    return merged;
  }

  /**
   * Calculate statistics for merged graph
   */
  calculateStats(pages) {
    const stats = {
      totalFeatures: 0,
      totalApis: 0,
      totalForms: 0,
      totalButtons: 0,
      totalTables: 0
    };

    for (const page of Object.values(pages)) {
      if (page.features) {
        stats.totalFeatures += page.features.length;
        stats.totalForms += page.features.filter(f => f.type === 'form').length;
        stats.totalButtons += page.features.filter(f => f.type === 'button').length;
        stats.totalTables += page.features.filter(f => f.type === 'table').length;
      }
      if (page.apis) {
        stats.totalApis += page.apis.length;
      }
    }

    return stats;
  }

  /**
   * Get source type from URL
   */
  getSourceType(url) {
    if (!url) return 'default';

    const lowerUrl = url.toLowerCase();
    if (lowerUrl.includes('help') || lowerUrl.includes('docs') || lowerUrl.includes('support')) {
      return 'helpsite';
    } else if (lowerUrl.includes('staging') || lowerUrl.includes('stg')) {
      return 'staging';
    } else {
      return 'app';
    }
  }

  /**
   * Get source info from graph
   */
  getSourceInfo(graph) {
    return {
      url: graph.appUrl,
      type: this.getSourceType(graph.appUrl),
      pages: graph.totalPages,
      crawledAt: graph.crawledAt || new Date().toISOString()
    };
  }

  /**
   * Get merge report
   */
  getMergeReport(originalGraphs, mergedGraph) {
    return {
      totalGraphs: originalGraphs.length,
      sources: mergedGraph.sources,
      totalPages: mergedGraph.totalPages,
      pagesFromEachSource: mergedGraph.sources.map(s => ({
        url: s.url,
        type: s.type,
        pages: s.pages
      })),
      stats: mergedGraph.stats,
      mergedAt: mergedGraph.mergedAt
    };
  }
}
