/**
 * Graph Filter - Smart filtering utilities for knowledge graphs
 * Version: 11.2.0
 *
 * Shared between background script and content script for consistent filtering
 */

class GraphFilter {
  /**
   * Extract meaningful keywords from Jira ticket
   * Removes stop words and extracts key terms
   * @param {Object} ticketData - Jira ticket data
   * @returns {Array<string>} Array of keywords
   */
  static extractTicketKeywords(ticketData) {
    const text = `${ticketData.summary || ''} ${ticketData.description || ''}`.toLowerCase();

    // Common stop words to ignore
    const stopWords = [
      'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
      'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
      'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those',
      'error', 'issue', 'bug', 'problem', 'fix', 'update', 'change', 'add',
      'test', 'user', 'when', 'after', 'before', 'while', 'though', 'even'
    ];

    // Extract words (3+ characters, not stop words)
    const words = text.match(/\b[a-z]{3,}\b/g) || [];
    const keywords = [...new Set(words.filter(w => !stopWords.includes(w)))];

    // Extract [bracketed terms] - usually important feature names
    const bracketedTerms = text.match(/\[([^\]]+)\]/g) || [];
    const bracketedKeywords = bracketedTerms.map(t => t.replace(/[\[\]]/g, '').toLowerCase().trim());

    // Extract "quoted phrases" - usually important terms
    const quotedTerms = text.match(/"([^"]+)"/g) || [];
    const quotedKeywords = quotedTerms.map(t => t.replace(/"/g, '').toLowerCase().trim());

    // Combine and deduplicate
    const allKeywords = [...new Set([...keywords, ...bracketedKeywords, ...quotedKeywords])];

    return allKeywords;
  }

  /**
   * Calculate relevance score for a page based on keywords
   * @param {string} url - Page URL
   * @param {string} title - Page title
   * @param {string} description - Page description
   * @param {Array<string>} keywords - Keywords to match
   * @returns {number} Relevance score (higher = more relevant)
   */
  static calculateRelevanceScore(url, title, description, keywords) {
    let score = 0;
    const searchText = `${url} ${title || ''} ${description || ''}`.toLowerCase();

    keywords.forEach(keyword => {
      const keywordLower = keyword.toLowerCase();

      if (searchText.includes(keywordLower)) {
        // URL matches are most important (user explicitly working on this feature)
        if (url.toLowerCase().includes(keywordLower)) {
          score += 10;
        }

        // Title matches are very important (main page topic)
        if (title && title.toLowerCase().includes(keywordLower)) {
          score += 5;
        }

        // Description matches are somewhat important (page content)
        if (description && description.toLowerCase().includes(keywordLower)) {
          score += 2;
        }
      }
    });

    return score;
  }

  /**
   * Strip unnecessary data from a page to reduce size
   * Keeps only what's needed for test generation: forms, APIs, metadata
   * @param {Object} page - Page object
   * @returns {Object} Stripped page object
   */
  static stripPageData(page) {
    return {
      metadata: {
        title: page.metadata?.title,
        description: page.metadata?.description,
        url: page.metadata?.url
      },
      features: page.features?.filter(f => f.type === 'form'), // Only forms
      apis: page.apis?.slice(0, 20) || [] // Max 20 APIs per page
      // Removed: buttons, links, tables, navigation, etc. (not needed for test gen)
    };
  }

  /**
   * Filter knowledge graph pages by relevance to ticket
   * @param {Object} knowledgeGraph - Full knowledge graph
   * @param {Object} ticketData - Jira ticket data
   * @param {number} maxPages - Maximum pages to return (default: 50)
   * @returns {Object} Filtered knowledge graph
   */
  static filterByRelevance(knowledgeGraph, ticketData, maxPages = 50) {
    if (!knowledgeGraph || !knowledgeGraph.pages) {
      return knowledgeGraph;
    }

    const startTime = Date.now();
    const totalPages = Object.keys(knowledgeGraph.pages).length;

    console.log(`[GRAPH FILTER] 🔍 Filtering ${totalPages} pages by ticket relevance...`);

    // Extract keywords from ticket
    const keywords = this.extractTicketKeywords(ticketData);
    console.log(`[GRAPH FILTER] 📝 Extracted ${keywords.length} keywords:`, keywords.slice(0, 10));

    // Score all pages
    const pages = Object.entries(knowledgeGraph.pages);
    const scoredPages = pages.map(([url, page]) => ({
      url,
      page,
      score: this.calculateRelevanceScore(
        url,
        page.metadata?.title,
        page.metadata?.description,
        keywords
      )
    }));

    // Sort by relevance (highest first)
    scoredPages.sort((a, b) => b.score - a.score);

    // Get relevance statistics
    const relevantPages = scoredPages.filter(p => p.score > 0);
    console.log(`[GRAPH FILTER] 📊 Relevance distribution:`);
    console.log(`   Total pages: ${totalPages}`);
    console.log(`   Relevant pages (score > 0): ${relevantPages.length}`);
    console.log(`   Irrelevant pages: ${totalPages - relevantPages.length}`);

    if (relevantPages.length > 0) {
      console.log(`[GRAPH FILTER] 🎯 Top 5 most relevant pages:`);
      relevantPages.slice(0, 5).forEach((p, i) => {
        console.log(`   ${i + 1}. ${p.url} (score: ${p.score})`);
      });
    }

    // Take top N most relevant pages and strip unnecessary data
    const topPages = scoredPages.slice(0, maxPages);
    const filteredPages = Object.fromEntries(
      topPages.map(p => [p.url, this.stripPageData(p.page)])
    );

    // Create filtered graph - ONLY include essential properties to reduce size
    const filteredGraph = {
      appUrl: knowledgeGraph.appUrl,
      pages: filteredPages, // Only the filtered pages
      totalPages: totalPages, // Original count
      filteredForTransfer: true,
      transferPageCount: topPages.length,
      filterMethod: 'keyword-relevance',
      filterKeywords: keywords.slice(0, 10), // First 10 keywords for debugging
      // Essential stats only (don't copy large stats object)
      stats: {
        totalFeatures: knowledgeGraph.stats?.totalFeatures || 0,
        totalApis: knowledgeGraph.stats?.totalApis || 0,
        totalForms: knowledgeGraph.stats?.totalForms || 0
      }
    };

    const duration = Date.now() - startTime;
    const filteredSize = JSON.stringify(filteredGraph).length / (1024 * 1024);
    const originalSize = JSON.stringify({ pages: knowledgeGraph.pages }).length / (1024 * 1024);
    const reduction = ((1 - filteredSize / originalSize) * 100).toFixed(1);

    console.log(`[GRAPH FILTER] ✅ Filtered in ${duration}ms:`);
    console.log(`   Original: ${originalSize.toFixed(2)} MB (${totalPages} pages)`);
    console.log(`   Filtered: ${filteredSize.toFixed(2)} MB (${topPages.length} pages)`);
    console.log(`   Reduction: ${reduction}%`);

    return filteredGraph;
  }
}

// Make available globally
if (typeof window !== 'undefined') {
  window.GraphFilter = GraphFilter;
}
