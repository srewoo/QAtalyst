/**
 * Context Manager for QAtalyst
 * Handles context gathering, token management, and graceful truncation
 * Ensures all data sources are properly included and fit within model limits
 */

// Prevent redeclaration
if (typeof ContextManager === 'undefined') {

  /**
   * Token limits for different models (input context)
   */
  const MODEL_LIMITS = {
    // OpenAI
    'gpt-4.1': { maxInput: 1047576, maxOutput: 32768, safeInput: 900000 },
    'gpt-4.1-mini': { maxInput: 1047576, maxOutput: 32768, safeInput: 900000 },
    'o1': { maxInput: 200000, maxOutput: 100000, safeInput: 150000 },
    'gpt-4-turbo': { maxInput: 128000, maxOutput: 4096, safeInput: 100000 },
    'gpt-4': { maxInput: 8192, maxOutput: 4096, safeInput: 6000 },

    // Claude
    'claude-sonnet-4-20250514': { maxInput: 200000, maxOutput: 8192, safeInput: 180000 },
    'claude-sonnet-4-20250111': { maxInput: 200000, maxOutput: 8192, safeInput: 180000 },
    'claude-3-5-sonnet-20241022': { maxInput: 200000, maxOutput: 8192, safeInput: 180000 },
    'claude-3-opus-20240229': { maxInput: 200000, maxOutput: 4096, safeInput: 180000 },

    // Gemini
    'gemini-2.5-pro-exp-03': { maxInput: 1000000, maxOutput: 8192, safeInput: 900000 },
    'gemini-2.5-flash-exp': { maxInput: 1000000, maxOutput: 8192, safeInput: 900000 },
    'gemini-2.0-flash-exp': { maxInput: 1000000, maxOutput: 8192, safeInput: 900000 },
    'gemini-1.5-pro': { maxInput: 2000000, maxOutput: 8192, safeInput: 1800000 }
  };

  /**
   * Priority order for content truncation (lowest priority truncated first)
   */
  const CONTENT_PRIORITY = {
    JIRA_SUMMARY: 100,      // Never truncate
    JIRA_DESCRIPTION: 90,   // High priority
    ACCEPTANCE_CRITERIA: 85,
    FIGMA_IMAGES: 80,       // Important for visual context
    JIRA_ATTACHMENTS: 75,
    CONFLUENCE: 70,
    GOOGLE_DOCS: 65,
    CRAWL_DATA: 60,         // Can be heavily truncated
    JIRA_COMMENTS: 50,      // Can be summarized
    HISTORICAL_BUGS: 40     // Lowest priority
  };

  class ContextManager {
    constructor(model = 'gpt-4.1') {
      this.model = model;
      this.limits = MODEL_LIMITS[model] || MODEL_LIMITS['gpt-4.1'];
      this.contextParts = [];
      this.images = [];
      this.totalTokens = 0;
      this.truncationLog = [];
    }

    /**
     * Estimate tokens from text (improved accuracy)
     * Uses different ratios for different content types
     */
    estimateTokens(text, contentType = 'text') {
      if (!text || typeof text !== 'string') return 0;

      const length = text.length;
      const words = text.split(/\s+/).filter(w => w.length > 0).length;

      // Different estimation based on content type
      switch (contentType) {
        case 'code':
          // Code has more tokens per character (special chars, indentation)
          return Math.ceil(length / 3);
        case 'json':
          // JSON has lots of punctuation
          return Math.ceil(length / 3.5);
        case 'markdown':
          // Markdown is similar to text but with some overhead
          return Math.ceil(length / 3.8);
        default:
          // Standard text: ~4 chars per token
          return Math.ceil(length / 4);
      }
    }

    /**
     * Estimate tokens for an image
     * Based on OpenAI's image token calculation
     */
    estimateImageTokens(imageData) {
      if (!imageData) return 0;

      // Base64 image - estimate based on size
      if (typeof imageData === 'string' && imageData.startsWith('data:image')) {
        const base64Length = imageData.split(',')[1]?.length || 0;
        const estimatedPixels = base64Length * 0.75 / 3; // Rough pixel estimate

        // OpenAI charges ~85 tokens per 512x512 tile
        if (estimatedPixels < 262144) { // 512x512
          return 85;
        } else if (estimatedPixels < 1048576) { // 1024x1024
          return 170;
        } else {
          return 765; // High detail
        }
      }

      // Default for unknown image format
      return 1000;
    }

    /**
     * Add context with priority and token tracking
     */
    addContext(content, priority, label, contentType = 'text') {
      if (!content) return this;

      const tokens = this.estimateTokens(content, contentType);

      this.contextParts.push({
        content,
        priority,
        label,
        tokens,
        contentType,
        truncated: false
      });

      this.totalTokens += tokens;
      return this;
    }

    /**
     * Add image with token tracking
     */
    addImage(imageData, label, priority = CONTENT_PRIORITY.FIGMA_IMAGES) {
      if (!imageData) return this;

      const tokens = this.estimateImageTokens(imageData);

      this.images.push({
        data: imageData,
        label,
        priority,
        tokens
      });

      this.totalTokens += tokens;
      return this;
    }

    /**
     * Get available tokens for content (after reserving for output)
     */
    getAvailableTokens() {
      const reservedForOutput = this.limits.maxOutput;
      const reservedForSystemPrompt = 2000; // Approximate
      return this.limits.safeInput - reservedForOutput - reservedForSystemPrompt;
    }

    /**
     * Check if we're within limits
     */
    isWithinLimits() {
      return this.totalTokens <= this.getAvailableTokens();
    }

    /**
     * Truncate content to fit within limits
     * Removes lowest priority content first
     */
    truncateToFit() {
      const available = this.getAvailableTokens();

      if (this.totalTokens <= available) {
        return { truncated: false, removedItems: [] };
      }

      // Sort by priority (lowest first for removal)
      const allItems = [
        ...this.contextParts.map((p, i) => ({ ...p, type: 'text', index: i })),
        ...this.images.map((p, i) => ({ ...p, type: 'image', index: i }))
      ].sort((a, b) => a.priority - b.priority);

      const removedItems = [];
      let currentTokens = this.totalTokens;

      for (const item of allItems) {
        if (currentTokens <= available) break;

        if (item.type === 'text') {
          // First try to truncate, then remove
          const part = this.contextParts[item.index];

          if (!part.truncated && part.tokens > 500) {
            // Truncate to 30% of original
            const targetTokens = Math.floor(part.tokens * 0.3);
            const truncatedContent = this._truncateText(part.content, targetTokens);
            const newTokens = this.estimateTokens(truncatedContent, part.contentType);

            currentTokens -= (part.tokens - newTokens);
            part.content = truncatedContent;
            part.tokens = newTokens;
            part.truncated = true;

            this.truncationLog.push({
              action: 'truncated',
              label: part.label,
              originalTokens: item.tokens,
              newTokens: newTokens
            });
          } else {
            // Remove entirely
            currentTokens -= part.tokens;
            part.content = null;
            part.tokens = 0;

            removedItems.push(part.label);
            this.truncationLog.push({
              action: 'removed',
              label: part.label,
              tokens: item.tokens
            });
          }
        } else if (item.type === 'image') {
          // Remove image
          currentTokens -= item.tokens;
          this.images[item.index].data = null;
          this.images[item.index].tokens = 0;

          removedItems.push(item.label);
          this.truncationLog.push({
            action: 'removed',
            label: item.label,
            tokens: item.tokens,
            type: 'image'
          });
        }
      }

      this.totalTokens = currentTokens;

      return {
        truncated: true,
        removedItems,
        finalTokens: currentTokens,
        available
      };
    }

    /**
     * Truncate text intelligently (keep beginning and end, remove middle)
     */
    _truncateText(text, targetTokens) {
      const currentTokens = this.estimateTokens(text);
      if (currentTokens <= targetTokens) return text;

      const ratio = targetTokens / currentTokens;
      const targetChars = Math.floor(text.length * ratio);

      // Keep first 60% and last 20%, remove middle
      const keepStart = Math.floor(targetChars * 0.6);
      const keepEnd = Math.floor(targetChars * 0.2);

      const start = text.substring(0, keepStart);
      const end = text.substring(text.length - keepEnd);

      return start + '\n\n[... content truncated to fit context limit ...]\n\n' + end;
    }

    /**
     * Build final context object for LLM
     */
    buildContext() {
      // Auto-truncate if needed
      const truncationResult = this.truncateToFit();

      // Build content parts
      const contentParts = [];

      // Add text content (sorted by priority, highest first)
      const textParts = this.contextParts
        .filter(p => p.content)
        .sort((a, b) => b.priority - a.priority);

      for (const part of textParts) {
        contentParts.push({
          type: 'text',
          text: part.content
        });
      }

      // Add images
      const validImages = this.images.filter(img => img.data);
      for (const img of validImages) {
        contentParts.push({
          type: 'image_url',
          image_url: { url: img.data }
        });
      }

      return {
        contentParts,
        stats: {
          totalTokens: this.totalTokens,
          available: this.getAvailableTokens(),
          model: this.model,
          limits: this.limits,
          truncated: truncationResult.truncated,
          truncationLog: this.truncationLog,
          textParts: textParts.length,
          images: validImages.length
        }
      };
    }

    /**
     * Get token usage summary
     */
    getTokenSummary() {
      const parts = this.contextParts.map(p => ({
        label: p.label,
        tokens: p.tokens,
        truncated: p.truncated
      }));

      const images = this.images.map(i => ({
        label: i.label,
        tokens: i.tokens
      }));

      return {
        total: this.totalTokens,
        available: this.getAvailableTokens(),
        usage: `${((this.totalTokens / this.getAvailableTokens()) * 100).toFixed(1)}%`,
        parts,
        images,
        withinLimits: this.isWithinLimits()
      };
    }
  }

  /**
   * Factory function to create a context manager and populate it
   */
  async function buildContextForRequest(data, settings) {
    const model = settings.llmModel || 'gpt-4.1';
    const ctx = new ContextManager(model);

    const { ticketData, externalContent, appContext, images } = data;

    // 1. Add Jira ticket data (highest priority)
    if (ticketData) {
      ctx.addContext(
        `Ticket: ${ticketData.key}\nSummary: ${ticketData.summary}`,
        CONTENT_PRIORITY.JIRA_SUMMARY,
        'Jira Summary'
      );

      if (ticketData.description) {
        ctx.addContext(
          ticketData.description,
          CONTENT_PRIORITY.JIRA_DESCRIPTION,
          'Jira Description',
          'markdown'
        );
      }

      if (ticketData.acceptanceCriteria) {
        ctx.addContext(
          ticketData.acceptanceCriteria,
          CONTENT_PRIORITY.ACCEPTANCE_CRITERIA,
          'Acceptance Criteria'
        );
      }

      if (ticketData.comments && ticketData.comments.length > 0) {
        const commentsText = ticketData.comments
          .map(c => `[${c.author}]: ${c.text}`)
          .join('\n\n');
        ctx.addContext(
          commentsText,
          CONTENT_PRIORITY.JIRA_COMMENTS,
          'Jira Comments'
        );
      }
    }

    // 2. Add external content
    if (externalContent) {
      if (externalContent.confluence && externalContent.confluence.length > 0) {
        const confluenceText = externalContent.confluence
          .map(c => `## ${c.title}\n${c.content}`)
          .join('\n\n');
        ctx.addContext(
          confluenceText,
          CONTENT_PRIORITY.CONFLUENCE,
          'Confluence Pages',
          'markdown'
        );
      }

      if (externalContent.googleDocs && externalContent.googleDocs.length > 0) {
        const docsText = externalContent.googleDocs
          .map(d => `## ${d.title}\n${d.content}`)
          .join('\n\n');
        ctx.addContext(
          docsText,
          CONTENT_PRIORITY.GOOGLE_DOCS,
          'Google Docs'
        );
      }

      if (externalContent.figma && externalContent.figma.length > 0) {
        const figmaSpecs = externalContent.figma
          .map(f => `## ${f.name}\n${f.specifications}`)
          .join('\n\n');
        ctx.addContext(
          figmaSpecs,
          CONTENT_PRIORITY.FIGMA_IMAGES,
          'Figma Specifications',
          'markdown'
        );
      }
    }

    // 3. Add crawl data
    if (appContext && appContext.knowledgeGraph) {
      const crawlSummary = formatCrawlDataForContext(appContext);
      ctx.addContext(
        crawlSummary,
        CONTENT_PRIORITY.CRAWL_DATA,
        'Application Context',
        'markdown'
      );
    }

    // 4. Add images
    if (images && images.length > 0) {
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const label = img.source === 'figma' ? `Figma Image ${i + 1}` : `Jira Attachment ${i + 1}`;
        const priority = img.source === 'figma'
          ? CONTENT_PRIORITY.FIGMA_IMAGES
          : CONTENT_PRIORITY.JIRA_ATTACHMENTS;

        ctx.addImage(img.data, label, priority);
      }
    }

    return ctx;
  }

  /**
   * Format crawl data into a concise summary
   */
  function formatCrawlDataForContext(appContext) {
    if (!appContext || !appContext.knowledgeGraph) {
      return '';
    }

    const kg = appContext.knowledgeGraph;
    const parts = [];

    parts.push(`## Application Context: ${appContext.appUrl || 'Unknown'}`);
    parts.push(`Total Pages Crawled: ${appContext.pageCount || 0}`);
    parts.push(`Relevant Pages: ${appContext.transferPageCount || 0}`);

    // Add forms summary
    if (kg.forms && kg.forms.length > 0) {
      parts.push('\n### Forms Found:');
      kg.forms.slice(0, 10).forEach(form => {
        const fields = form.fields?.slice(0, 5).map(f => f.name || f.label).join(', ') || 'N/A';
        parts.push(`- ${form.name || 'Unnamed Form'}: ${fields}`);
      });
      if (kg.forms.length > 10) {
        parts.push(`  ... and ${kg.forms.length - 10} more forms`);
      }
    }

    // Add APIs summary
    if (kg.apis && kg.apis.length > 0) {
      parts.push('\n### API Endpoints:');
      kg.apis.slice(0, 15).forEach(api => {
        parts.push(`- ${api.method || 'GET'} ${api.url || api.endpoint}`);
      });
      if (kg.apis.length > 15) {
        parts.push(`  ... and ${kg.apis.length - 15} more endpoints`);
      }
    }

    // Add page summaries
    if (kg.pages) {
      const pageList = Object.values(kg.pages).slice(0, 10);
      if (pageList.length > 0) {
        parts.push('\n### Key Pages:');
        pageList.forEach(page => {
          parts.push(`- ${page.metadata?.title || page.url}: ${page.metadata?.description || 'No description'}`);
        });
      }
    }

    return parts.join('\n');
  }

  // Export for use in other modules
  if (typeof window !== 'undefined') {
    window.ContextManager = ContextManager;
    window.buildContextForRequest = buildContextForRequest;
    window.CONTENT_PRIORITY = CONTENT_PRIORITY;
    window.MODEL_LIMITS = MODEL_LIMITS;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.ContextManager = ContextManager;
    globalThis.buildContextForRequest = buildContextForRequest;
    globalThis.CONTENT_PRIORITY = CONTENT_PRIORITY;
    globalThis.MODEL_LIMITS = MODEL_LIMITS;
  }
}
