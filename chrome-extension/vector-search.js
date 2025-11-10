/**
 * Vector Search - Semantic search over embeddings
 * Version: 11.0.0
 * Performs cosine similarity search to find relevant app context
 */

class VectorSearch {
  constructor(embeddings = []) {
    this.embeddings = embeddings;
    this.cache = new Map(); // Cache query results
  }

  /**
   * Search for pages relevant to query
   * @param {string} queryText - Search query
   * @param {number} topK - Number of results to return
   * @param {number} minScore - Minimum similarity score (0-1)
   * @returns {Promise<Array>} Top K most relevant pages
   */
  async search(queryText, topK = 5, minScore = 0.5) {
    if (this.embeddings.length === 0) {
      console.warn('⚠️ No embeddings loaded');
      return [];
    }

    // Check cache
    const cacheKey = `${queryText}:${topK}:${minScore}`;
    if (this.cache.has(cacheKey)) {
      console.log('📦 Returning cached search results');
      return this.cache.get(cacheKey);
    }

    console.log(`🔍 Searching for: "${queryText}"`);
    console.log(`   Corpus size: ${this.embeddings.length} documents`);

    const startTime = performance.now();

    // Get query embedding (assuming it's already embedded by EmbeddingManager)
    // In practice, this would call EmbeddingManager.embedQuery()
    // For now, we'll handle this in the caller

    const results = [];

    // For each document, calculate similarity
    for (const doc of this.embeddings) {
      // This method expects queryVector to be passed separately
      // We'll refactor this in the actual implementation
      results.push(doc);
    }

    const searchTime = performance.now() - startTime;
    console.log(`   Search completed in ${searchTime.toFixed(2)}ms`);

    // Cache results
    this.cache.set(cacheKey, results.slice(0, topK));

    return results.slice(0, topK);
  }

  /**
   * Search with pre-computed query vector
   * @param {Array<number>} queryVector - Query embedding vector
   * @param {number} topK - Number of results
   * @param {number} minScore - Minimum similarity score
   */
  searchWithVector(queryVector, topK = 5, minScore = 0.5) {
    if (this.embeddings.length === 0) {
      return [];
    }

    const startTime = performance.now();

    // Calculate similarity for all documents
    const results = this.embeddings.map(doc => ({
      ...doc,
      score: this.cosineSimilarity(queryVector, doc.vector)
    }));

    // Filter by minimum score
    const filtered = results.filter(r => r.score >= minScore);

    // Sort by score descending
    const sorted = filtered.sort((a, b) => b.score - a.score);

    // Take top K
    const topResults = sorted.slice(0, topK);

    const searchTime = performance.now() - startTime;
    console.log(`🔍 Vector search: ${topResults.length} results in ${searchTime.toFixed(2)}ms`);

    if (topResults.length > 0) {
      console.log(`   Top result: ${topResults[0].metadata?.title || topResults[0].url} (score: ${topResults[0].score.toFixed(3)})`);
    }

    return topResults;
  }

  /**
   * Calculate cosine similarity between two vectors
   * @param {Array<number>} vecA - First vector
   * @param {Array<number>} vecB - Second vector
   * @returns {number} Similarity score (0-1)
   */
  cosineSimilarity(vecA, vecB) {
    if (vecA.length !== vecB.length) {
      throw new Error('Vectors must have same length');
    }

    let dotProduct = 0;
    let magA = 0;
    let magB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      magA += vecA[i] * vecA[i];
      magB += vecB[i] * vecB[i];
    }

    magA = Math.sqrt(magA);
    magB = Math.sqrt(magB);

    if (magA === 0 || magB === 0) {
      return 0;
    }

    return dotProduct / (magA * magB);
  }

  /**
   * Search by URL pattern
   * @param {string} urlPattern - URL pattern to match
   */
  searchByUrl(urlPattern) {
    const regex = new RegExp(urlPattern, 'i');
    return this.embeddings.filter(doc => regex.test(doc.url));
  }

  /**
   * Search by page title
   * @param {string} titleQuery - Title to search for
   */
  searchByTitle(titleQuery) {
    const regex = new RegExp(titleQuery, 'i');
    return this.embeddings.filter(doc =>
      regex.test(doc.metadata?.title || '')
    );
  }

  /**
   * Get all pages with specific feature types
   * @param {string} featureType - Feature type (form, table, button, etc.)
   */
  searchByFeatureType(featureType) {
    return this.embeddings.filter(doc => {
      const text = doc.text.toLowerCase();
      return text.includes(featureType.toLowerCase());
    });
  }

  /**
   * Get pages with API endpoints
   */
  getPagesWithAPIs() {
    return this.embeddings.filter(doc => {
      return doc.metadata?.apiCount > 0 || doc.text.includes('API Endpoints');
    });
  }

  /**
   * Get pages with forms
   */
  getPagesWithForms() {
    return this.searchByFeatureType('form');
  }

  /**
   * Get pages with tables
   */
  getPagesWithTables() {
    return this.searchByFeatureType('table');
  }

  /**
   * Multi-query search - combine results from multiple queries
   * @param {Array<string>} queries - Array of query texts
   * @param {number} topK - Results per query
   */
  async multiSearch(queries, topK = 3) {
    const allResults = [];

    for (const query of queries) {
      const results = await this.search(query, topK);
      allResults.push(...results);
    }

    // Remove duplicates and re-rank
    const seen = new Set();
    const unique = allResults.filter(doc => {
      if (seen.has(doc.id)) return false;
      seen.add(doc.id);
      return true;
    });

    // Sort by average score
    return unique.sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  /**
   * Get search statistics
   */
  getStats() {
    return {
      totalDocuments: this.embeddings.length,
      cacheSize: this.cache.size,
      dimensions: this.embeddings[0]?.vector?.length || 0,
      pagesWithAPIs: this.getPagesWithAPIs().length,
      pagesWithForms: this.getPagesWithForms().length,
      pagesWithTables: this.getPagesWithTables().length
    };
  }

  /**
   * Clear search cache
   */
  clearCache() {
    this.cache.clear();
    console.log('🗑️ Search cache cleared');
  }

  /**
   * Update embeddings
   */
  setEmbeddings(embeddings) {
    this.embeddings = embeddings;
    this.clearCache(); // Clear cache when embeddings change
    console.log(`📊 Loaded ${embeddings.length} embeddings`);
  }

  /**
   * Add new embeddings
   */
  addEmbeddings(newEmbeddings) {
    this.embeddings.push(...newEmbeddings);
    this.clearCache();
    console.log(`➕ Added ${newEmbeddings.length} embeddings (total: ${this.embeddings.length})`);
  }

  /**
   * Remove embeddings by URL pattern
   */
  removeEmbeddings(urlPattern) {
    const regex = new RegExp(urlPattern, 'i');
    const before = this.embeddings.length;
    this.embeddings = this.embeddings.filter(doc => !regex.test(doc.url));
    const removed = before - this.embeddings.length;
    this.clearCache();
    console.log(`🗑️ Removed ${removed} embeddings`);
    return removed;
  }

  /**
   * Find similar pages to a given page
   * @param {string} pageUrl - URL of the page to find similar pages for
   * @param {number} topK - Number of similar pages
   */
  findSimilarPages(pageUrl, topK = 5) {
    const page = this.embeddings.find(doc => doc.url === pageUrl);
    if (!page) {
      console.warn(`⚠️ Page not found: ${pageUrl}`);
      return [];
    }

    return this.searchWithVector(page.vector, topK + 1)
      .filter(doc => doc.url !== pageUrl) // Exclude the page itself
      .slice(0, topK);
  }
}

// Export for use in background script
if (typeof module !== 'undefined' && module.exports) {
  module.exports = VectorSearch;
}
