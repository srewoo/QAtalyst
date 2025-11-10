/**
 * Jina AI Embedding Service
 * Provides semantic embeddings using Jina AI's embedding API
 *
 * FREE Tier: 10 million tokens for new users
 * Model: jina-embeddings-v3 (1024 dimensions, configurable)
 * API: https://api.jina.ai/v1/embeddings
 *
 * Perfect for large-scale crawling (thousands of pages)
 */

class JinaEmbeddingService {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.model = 'jina-embeddings-v3';
    this.dimensions = 1024; // Default, can be reduced via Matryoshka learning
    this.endpoint = 'https://api.jina.ai/v1/embeddings';
    this.batchSize = 512; // Jina API limit: 512 items per request (was incorrectly set to 2048)
    this.maxTokensPerRequest = 8192; // Max tokens per single request
  }

  /**
   * Generate embeddings for the entire knowledge graph
   */
  async generateEmbeddings(knowledgeGraph, progressCallback = null) {
    console.log('🔮 Generating embeddings with Jina AI...');

    // Prepare documents from knowledge graph
    const documents = this.prepareDocuments(knowledgeGraph);
    console.log(`📄 Prepared ${documents.length} documents`);

    // Create batches (Jina supports up to 2048 items per request!)
    const batches = this.createBatches(documents);
    console.log(`📦 Created ${batches.length} batches`);

    const embeddings = [];
    let totalTokens = 0;

    // Process each batch
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];

      // Report progress
      if (progressCallback) {
        progressCallback({
          status: 'generating',
          current: i + 1,
          total: batches.length,
          percentage: Math.round(((i + 1) / batches.length) * 100)
        });
      }

      try {
        // Generate embeddings for this batch
        const result = await this.generateBatchEmbeddings(batch);

        // Store results
        result.embeddings.forEach((embedding, idx) => {
          embeddings.push({
            id: batch[idx].id,
            url: batch[idx].url,
            title: batch[idx].title,
            text: batch[idx].text,
            embedding: embedding,
            metadata: batch[idx].metadata
          });
        });

        totalTokens += result.usage.total_tokens;

        // Small delay between batches to avoid rate limits
        if (i < batches.length - 1) {
          await this.sleep(200);
        }
      } catch (error) {
        console.error(`❌ Failed to generate embeddings for batch ${i + 1}:`, error);
        throw error;
      }
    }

    console.log(`✅ Generated ${embeddings.length} embeddings (${totalTokens} tokens)`);

    return {
      embeddings,
      totalTokens,
      cost: 0, // FREE tier!
      model: this.model,
      dimensions: this.dimensions,
      provider: 'jina'
    };
  }

  /**
   * Generate embeddings for a single batch
   */
  async generateBatchEmbeddings(batch) {
    const texts = batch.map(doc => doc.text);

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
        normalized: true, // L2 normalization for better cosine similarity
        embedding_type: 'float' // Return as float array
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Jina API error (${response.status}): ${errorText}`);
    }

    const data = await response.json();

    // Jina API response format
    return {
      embeddings: data.data.map(item => item.embedding),
      usage: {
        total_tokens: data.usage?.total_tokens || 0
      }
    };
  }

  /**
   * Prepare documents from knowledge graph
   */
  prepareDocuments(knowledgeGraph) {
    const documents = [];

    // Convert each page to a document
    Object.entries(knowledgeGraph.pages || {}).forEach(([url, page]) => {
      // Create comprehensive text representation
      const textParts = [];

      // Add page title
      if (page.metadata?.title || page.title) {
        textParts.push(`Title: ${page.metadata?.title || page.title}`);
      }

      // Add page description
      if (page.metadata?.description || page.description) {
        textParts.push(`Description: ${page.metadata?.description || page.description}`);
      }

      // Add URL path for context
      try {
        const urlObj = new URL(url);
        textParts.push(`Path: ${urlObj.pathname}`);
      } catch (e) {
        // Ignore invalid URLs
      }

      // ✨ NEW: Add main text content (help articles, documentation)
      if (page.textContent && page.textContent.length > 50) {
        textParts.push(`\nContent:\n${page.textContent}`);
      }

      // Add features summary
      if (page.features && page.features.length > 0) {
        const featureTypes = [...new Set(page.features.map(f => f.type))];
        textParts.push(`\nFeatures: ${featureTypes.join(', ')}`);

        // Add detailed feature information
        page.features.forEach(feature => {
          if (feature.type === 'form' && feature.inputs) {
            const inputNames = feature.inputs.map(i => i.name).filter(n => n && !n.startsWith('unnamed-'));
            if (inputNames.length > 0) {
              textParts.push(`Form fields: ${inputNames.join(', ')}`);
            }
          } else if (feature.type === 'button' && feature.text) {
            textParts.push(`Button: ${feature.text}`);
          } else if (feature.type === 'navigation' && feature.items) {
            const navItems = feature.items.map(i => i.text).filter(t => t);
            if (navItems.length > 0) {
              textParts.push(`Navigation: ${navItems.join(', ')}`);
            }
          }
        });
      }

      // Add API endpoints
      if (page.apis && page.apis.length > 0) {
        const apiPaths = page.apis.map(api => `${api.method} ${api.endpoint}`);
        textParts.push(`APIs: ${apiPaths.join(', ')}`);
      }

      // Combine all parts
      const text = textParts.join('\n');

      // Only add if we have meaningful content
      if (text.length > 20) {
        documents.push({
          id: `page-${documents.length}`,
          url,
          title: page.metadata?.title || page.title || url,
          text,
          metadata: {
            depth: page.depth || 0,
            featureCount: page.features?.length || 0,
            apiCount: page.apis?.length || 0,
            hasTextContent: !!page.textContent
          }
        });
      }
    });

    return documents;
  }

  /**
   * Create batches from documents
   */
  createBatches(documents) {
    const batches = [];

    // Jina supports up to 2048 items per request
    for (let i = 0; i < documents.length; i += this.batchSize) {
      batches.push(documents.slice(i, i + this.batchSize));
    }

    return batches;
  }

  /**
   * Calculate cost (FREE for Jina AI!)
   */
  calculateCost(tokens) {
    // Jina AI offers 10M tokens free for new users
    return 0;
  }

  /**
   * Sleep utility
   */
  /**
   * Create text representation from a single page
   * Used for incremental embedding generation
   */
  createPageText(page) {
    const textParts = [];

    // Add page title
    if (page.title) {
      textParts.push(`Title: ${page.title}`);
    }

    // Add page description
    if (page.description) {
      textParts.push(`Description: ${page.description}`);
    }

    // Add URL path for context
    try {
      const urlObj = new URL(page.url);
      textParts.push(`Path: ${urlObj.pathname}`);
    } catch (e) {
      // Ignore invalid URLs
    }

    // Add main text content (help articles, documentation)
    if (page.textContent && page.textContent.length > 50) {
      textParts.push(`\nContent:\n${page.textContent}`);
    }

    // Add features summary
    if (page.features && page.features.length > 0) {
      const featureTypes = [...new Set(page.features.map(f => f.type))];
      textParts.push(`\nFeatures: ${featureTypes.join(', ')}`);
    }

    // Add APIs if present
    if (page.apis && page.apis.length > 0) {
      const apiEndpoints = page.apis.map(api => `${api.method} ${api.url}`);
      textParts.push(`\nAPIs: ${apiEndpoints.join(', ')}`);
    }

    return textParts.join('\n');
  }

  /**
   * Generate embedding for a single text string
   * Used for incremental embedding generation
   */
  async generateSingleEmbedding(text) {
    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        input: [text],
        dimensions: this.dimensions
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Jina API error: ${error}`);
    }

    const data = await response.json();

    return {
      embedding: data.data[0].embedding,
      tokens: data.usage?.total_tokens || 0,
      cost: 0 // FREE tier
    };
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Validate API key format
   */
  static validateApiKey(apiKey) {
    // Jina API keys typically start with "jina_"
    if (!apiKey || apiKey.trim() === '') {
      return { valid: false, error: 'API key is required' };
    }

    const trimmedKey = apiKey.trim();

    if (trimmedKey.length < 20) {
      return { valid: false, error: 'API key seems too short' };
    }

    return { valid: true, key: trimmedKey };
  }
}
