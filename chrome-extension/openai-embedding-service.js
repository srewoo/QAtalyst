/**
 * OpenAI Embedding Service
 * Generates text embeddings using OpenAI text-embedding-3-small model
 * Version: 11.0.0
 */

class OpenAIEmbeddingService {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.model = 'text-embedding-3-small';
    this.dimensions = 1536; // text-embedding-3-small dimensions
    this.costPer1MTokens = 0.02; // $0.02 per 1M tokens
    this.batchSize = 100; // OpenAI allows up to 2048 inputs per request
    this.maxTokensPerRequest = 8000; // Stay well under the limit
  }

  /**
   * Generate embeddings for crawled pages
   * @param {Object} knowledgeGraph - Crawled knowledge graph
   * @param {Function} progressCallback - Progress update callback
   * @returns {Promise<Object>} Embeddings data
   */
  async generateEmbeddings(knowledgeGraph, progressCallback = null) {
    console.log('🔮 Starting embedding generation...');

    const documents = this.prepareDocuments(knowledgeGraph);
    console.log(`📄 Prepared ${documents.length} documents for embedding`);

    if (documents.length === 0) {
      return {
        embeddings: [],
        totalTokens: 0,
        cost: 0
      };
    }

    const embeddings = [];
    let totalTokens = 0;
    const batches = this.createBatches(documents);

    console.log(`📦 Processing ${batches.length} batches...`);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];

      if (progressCallback) {
        progressCallback({
          status: 'generating',
          current: i + 1,
          total: batches.length,
          percentage: Math.round(((i + 1) / batches.length) * 100)
        });
      }

      try {
        const result = await this.generateBatchEmbeddings(batch);

        // Combine with metadata
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

        // Small delay to avoid rate limits
        if (i < batches.length - 1) {
          await this.sleep(200);
        }
      } catch (error) {
        console.error(`❌ Batch ${i + 1} failed:`, error);
        // Continue with next batch instead of failing completely
      }
    }

    const cost = this.calculateCost(totalTokens);

    console.log(`✅ Generated ${embeddings.length} embeddings`);
    console.log(`📊 Total tokens: ${totalTokens}, Cost: $${cost.toFixed(4)}`);

    return {
      embeddings,
      totalTokens,
      cost,
      model: this.model,
      dimensions: this.dimensions
    };
  }

  /**
   * Prepare documents from knowledge graph for embedding
   */
  prepareDocuments(knowledgeGraph) {
    const documents = [];

    knowledgeGraph.pages.forEach((page, index) => {
      // Create comprehensive text representation of the page
      const parts = [];

      // Title
      if (page.title) {
        parts.push(`Title: ${page.title}`);
      }

      // URL path (for context)
      try {
        const url = new URL(page.url);
        parts.push(`Path: ${url.pathname}`);
      } catch (e) {
        // Ignore invalid URLs
      }

      // Description
      if (page.description) {
        parts.push(`Description: ${page.description}`);
      }

      // ✨ NEW: Add main text content (help articles, documentation)
      if (page.textContent && page.textContent.length > 50) {
        parts.push(`\nContent:\n${page.textContent}`);
      }

      // Features summary
      if (page.features && page.features.length > 0) {
        const featureTypes = page.features.reduce((acc, f) => {
          acc[f.type] = (acc[f.type] || 0) + 1;
          return acc;
        }, {});

        const featureSummary = Object.entries(featureTypes)
          .map(([type, count]) => `${count} ${type}${count > 1 ? 's' : ''}`)
          .join(', ');

        parts.push(`Features: ${featureSummary}`);

        // Extract form field names and button text
        const formFields = [];
        const buttonTexts = [];

        page.features.forEach(feature => {
          if (feature.type === 'form' && feature.inputs) {
            feature.inputs.forEach(input => {
              if (input.name && !input.name.startsWith('unnamed')) {
                formFields.push(input.name);
              }
            });
          }
          if (feature.type === 'button' && feature.text) {
            buttonTexts.push(feature.text);
          }
        });

        if (formFields.length > 0) {
          parts.push(`Form fields: ${formFields.slice(0, 20).join(', ')}`);
        }
        if (buttonTexts.length > 0) {
          parts.push(`Actions: ${buttonTexts.slice(0, 10).join(', ')}`);
        }
      }

      // API endpoints
      if (page.apis && page.apis.length > 0) {
        const apiMethods = page.apis.map(api => `${api.method} ${api.url}`);
        parts.push(`APIs: ${apiMethods.slice(0, 5).join(', ')}`);
      }

      const text = parts.join('\n');

      // Only include pages with meaningful content
      if (text.length > 20) {
        documents.push({
          id: `page-${index}`,
          url: page.url,
          title: page.title || 'Untitled',
          text: text,
          metadata: {
            depth: page.depth,
            featureCount: page.features?.length || 0,
            apiCount: page.apis?.length || 0,
            linkCount: page.links?.length || 0
          }
        });
      }
    });

    return documents;
  }

  /**
   * Create batches of documents
   */
  createBatches(documents) {
    const batches = [];
    let currentBatch = [];
    let currentTokens = 0;

    for (const doc of documents) {
      // Rough estimate: 1 token ≈ 4 characters
      const estimatedTokens = Math.ceil(doc.text.length / 4);

      // Start new batch if current would exceed limits
      if (
        currentBatch.length >= this.batchSize ||
        (currentTokens + estimatedTokens > this.maxTokensPerRequest && currentBatch.length > 0)
      ) {
        batches.push(currentBatch);
        currentBatch = [];
        currentTokens = 0;
      }

      currentBatch.push(doc);
      currentTokens += estimatedTokens;
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    return batches;
  }

  /**
   * Generate embeddings for a batch of documents
   */
  async generateBatchEmbeddings(batch) {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        input: batch.map(doc => doc.text),
        encoding_format: 'float'
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error?.message || `OpenAI API error: ${response.status}`);
    }

    const data = await response.json();

    return {
      embeddings: data.data.map(item => item.embedding),
      usage: data.usage
    };
  }

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
        input: text,
        dimensions: this.dimensions
      })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${error}`);
    }

    const data = await response.json();

    const tokens = data.usage?.total_tokens || 0;
    const cost = this.calculateCost(tokens);

    return {
      embedding: data.data[0].embedding,
      tokens: tokens,
      cost: cost
    };
  }

  /**
   * Calculate cost based on tokens
   */
  calculateCost(tokens) {
    return (tokens / 1000000) * this.costPer1MTokens;
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Send progress update
   */
  sendProgress(progress) {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({
        action: 'embeddingProgress',
        progress
      }).catch(() => {
        // Ignore errors if no listeners
      });
    }
  }
}
