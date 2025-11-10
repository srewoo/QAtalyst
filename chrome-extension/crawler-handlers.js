/**
 * Crawler Message Handlers - Handle crawler-related messages
 * Version: 11.0.0
 * Processes crawler requests from content script and popup
 */

/**
 * Send message to all extension windows
 */
function broadcastMessage(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Ignore if no listeners
  });
}

/**
 * Handle start crawl request
 */
async function handleStartCrawl(data) {
  try {
    console.log('🕷️ Starting web app crawl...');

    // Get current tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) {
      throw new Error('No active tab found');
    }

    // Get crawler settings from chrome.storage (UI settings) to override config.json
    const userSettings = await chrome.storage.sync.get([
      'enableDuplicateDetection',
      'detectParameterizedUrls',
      'maxSamplesPerPattern'
    ]);

    // Apply user settings to CONFIG if they exist (use CONFIG.set() method)
    if (userSettings.enableDuplicateDetection !== undefined) {
      CONFIG.set('crawler.duplicateDetection.enabled', userSettings.enableDuplicateDetection);
    }
    if (userSettings.detectParameterizedUrls !== undefined) {
      CONFIG.set('crawler.duplicateDetection.detectParameterizedUrls', userSettings.detectParameterizedUrls);
    }
    if (userSettings.maxSamplesPerPattern !== undefined) {
      CONFIG.set('crawler.duplicateDetection.maxSamplesPerPattern', userSettings.maxSamplesPerPattern);
    }

    console.log('🎛️ Crawler Settings:', {
      enableDuplicateDetection: CONFIG.get('crawler.duplicateDetection.enabled'),
      detectParameterizedUrls: CONFIG.get('crawler.duplicateDetection.detectParameterizedUrls'),
      maxSamplesPerPattern: CONFIG.get('crawler.duplicateDetection.maxSamplesPerPattern')
    });

    // Get crawler settings from config.json
    const config = {
      startUrl: data.startUrl || tab.url,
      maxPages: data.maxPages || CONFIG.get('crawler.limits.maxPages', 1000),
      maxDepth: data.maxDepth || CONFIG.get('crawler.limits.maxDepth', 10),
      delay: data.delay || CONFIG.get('crawler.delays.betweenPages', 1000),
      tabId: tab.id
    };

    // Store incremental crawl settings for progressive embedding generation
    if (data.generateEmbeddings && data.embeddingApiKey) {
      // Get existing settings first to avoid overwriting other active crawls
      const existing = await chrome.storage.local.get(['incrementalCrawlSettings']);
      const incrementalSettings = existing.incrementalCrawlSettings || {};

      incrementalSettings[config.startUrl] = {
        generateEmbeddings: data.generateEmbeddings,
        embeddingApiKey: data.embeddingApiKey,
        embeddingProvider: data.embeddingProvider || 'openai',
        timestamp: Date.now()
      };

      await chrome.storage.local.set({ incrementalCrawlSettings: incrementalSettings });
      console.log(`💾 Stored incremental crawl settings for: ${config.startUrl}`);
      console.log(`   Provider: ${data.embeddingProvider || 'openai'}, Embeddings enabled: true`);
    } else {
      console.log('⏭️ Skipping incremental embedding setup (embeddings not requested)');
      console.log(`   generateEmbeddings: ${data.generateEmbeddings}, hasApiKey: ${!!data.embeddingApiKey}`);
    }

    // Create and start crawler
    activeCrawler = new WebAppCrawler(config);

    // P0.3: Start heartbeat to checkpoint crawler state every 10s
    startCrawlHeartbeat();

    const knowledgeGraph = await activeCrawler.crawl();

    // P0.3: Stop heartbeat after crawl completes
    stopCrawlHeartbeat();

    console.log('✅ Crawl complete');

    let embeddingData = null;
    let embeddingCount = 0;
    let embeddingCost = 0;

    // Check if incremental embeddings were generated during crawl
    const incrementalResult = await finalizeIncrementalCrawl(config.startUrl, knowledgeGraph);

    if (incrementalResult) {
      // Embeddings were generated incrementally
      embeddingCount = incrementalResult.embeddingCount;
      embeddingCost = incrementalResult.totalCost;
      console.log(`✅ Used ${embeddingCount} incrementally generated embeddings (${embeddingCost > 0 ? `$${embeddingCost.toFixed(4)}` : 'FREE'})`);
    } else if (data.generateEmbeddings && data.embeddingApiKey) {
      // Fallback to batch generation if incremental failed
      console.log('⚠️ Incremental embedding failed, falling back to batch generation...');
      const provider = data.embeddingProvider || 'openai';
      console.log(`🔮 Generating embeddings with ${provider === 'jina' ? 'Jina AI' : 'OpenAI'}...`);

      try {
        let embeddingService;

        // Create appropriate embedding service based on provider
        if (provider === 'jina') {
          embeddingService = new JinaEmbeddingService(data.embeddingApiKey);
        } else {
          embeddingService = new OpenAIEmbeddingService(data.embeddingApiKey);
        }

        embeddingData = await embeddingService.generateEmbeddings(knowledgeGraph, (progress) => {
          // Broadcast progress to all windows
          broadcastMessage({
            action: 'embeddingProgress',
            progress
          });
        });

        embeddingCount = embeddingData.embeddings.length;
        embeddingCost = embeddingData.cost;

        // Save embeddings WITH knowledge graph to storage
        await storageManager.saveEmbeddings(config.startUrl, {
          appUrl: config.startUrl,
          embeddings: embeddingData.embeddings,
          knowledgeGraph: knowledgeGraph,
          crawledAt: new Date().toISOString(),
          model: embeddingData.model,
          dimensions: embeddingData.dimensions,
          totalTokens: embeddingData.totalTokens,
          cost: embeddingData.cost,
          provider: embeddingData.provider || provider
        });

        const costMsg = embeddingCost > 0
          ? `($${embeddingCost.toFixed(4)})`
          : '(FREE)';
        console.log(`✅ Generated and saved ${embeddingCount} embeddings ${costMsg}`);
      } catch (error) {
        console.error('❌ Embedding generation failed:', error);
        // Don't fail the whole crawl if embeddings fail
        embeddingCount = 0;
        embeddingCost = 0;
      }
    }

    // CRITICAL FIX: Always save knowledge graph, even without embeddings
    // This ensures crawl data is persisted and can be exported
    if (!data || !data.generateEmbeddings || embeddingCount === 0) {
      console.log('💾 Saving knowledge graph without embeddings...');
      const appUrl = config.startUrl; // Use config.startUrl which is guaranteed to exist
      await storageManager.saveEmbeddings(appUrl, {
        appUrl: appUrl,
        embeddings: [], // Empty array when no embeddings
        knowledgeGraph: knowledgeGraph,
        crawledAt: new Date().toISOString(),
        model: null,
        dimensions: 0,
        totalTokens: 0,
        cost: 0,
        provider: null
      });
      console.log(`✅ Saved knowledge graph with ${knowledgeGraph.totalPages} pages`);
    }

    const result = {
      pages: knowledgeGraph.totalPages,
      features: knowledgeGraph.stats.totalFeatures,
      apis: knowledgeGraph.stats.totalApis,
      embeddings: embeddingCount,
      cost: embeddingCost,
      appUrl: config.startUrl, // Use config.startUrl which is guaranteed to exist
      timestamp: new Date().toISOString(),
      duration: knowledgeGraph.duration
    };

    // Store last crawl result and clear active crawl flag
    await chrome.storage.local.set({
      lastCrawlResult: result
    });
    await chrome.storage.local.remove('activeCrawl');

    // Broadcast completion to progress window
    broadcastMessage({
      action: 'crawlComplete',
      result: result
    });

    // Send modal notification to the tab that initiated the crawl
    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: 'showCrawlCompleteModal',
        result: result
      });
    } catch (error) {
      // Tab may be closed or navigated away, ignore
      console.log('Could not send modal to initiating tab (tab may be closed)');
    }

    // Send desktop notification
    let notificationMessage = `${result.pages} pages, ${result.features} features, ${result.apis} APIs`;
    if (embeddingCount > 0) {
      const costMsg = embeddingCost > 0 ? `($${embeddingCost.toFixed(4)})` : '(FREE)';
      notificationMessage += `, ${embeddingCount} embeddings ${costMsg}`;
    }

    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '✅ Crawl Complete!',
      message: notificationMessage,
      priority: 2,
      requireInteraction: false
    });

    return {
      success: true,
      result: result
    };
  } catch (error) {
    console.error('❌ Crawl failed:', error);

    // Clear active crawl flag
    await chrome.storage.local.remove('activeCrawl').catch(() => {});

    // Broadcast error to progress window
    broadcastMessage({
      action: 'crawlError',
      error: error.message
    });

    return {
      success: false,
      error: error.message
    };
  } finally {
    // P0.3: Ensure heartbeat is stopped (cleanup)
    stopCrawlHeartbeat();

    activeCrawler = null;

    // CRITICAL: Always cleanup resource blocker, even on errors
    // This prevents CSS/images from being blocked after crawl ends
    try {
      if (globalResourceBlocker) {
        await globalResourceBlocker.stop();
        console.log('✅ Resource blocker cleanup complete');
      }
    } catch (cleanupError) {
      console.error('⚠️ Failed to cleanup resource blocker:', cleanupError);
    }
  }
}

/**
 * Handle stop crawl request
 */
async function handleStopCrawl() {
  if (activeCrawler) {
    console.log('⏹️ Stopping crawler...');

    // Stop the crawler
    await activeCrawler.stop();
    activeCrawler = null;

    // Clear active crawl flag from storage
    await chrome.storage.local.remove('activeCrawl').catch(() => {});

    // Broadcast stop message to all extension windows
    broadcastMessage({
      action: 'crawlStopped',
      message: 'Crawl stopped by user'
    });

    console.log('✅ Crawler stopped successfully');

    return { success: true, message: 'Crawl stopped successfully' };
  }

  return { success: false, error: 'No active crawler' };
}

/**
 * Handle pause/resume crawl
 */
async function handlePauseCrawl() {
  if (activeCrawler) {
    if (activeCrawler.isPaused) {
      activeCrawler.resume();
      return { success: true, status: 'resumed' };
    } else {
      activeCrawler.pause();
      return { success: true, status: 'paused' };
    }
  }
  return { success: false, error: 'No active crawler' };
}

/**
 * Handle load embeddings request
 */
async function handleLoadEmbeddings(data) {
  try {
    const embeddingData = await storageManager.loadEmbeddings(data.appUrl);

    if (!embeddingData) {
      return {
        success: false,
        error: 'No embeddings found for this app'
      };
    }

    // Initialize vector search
    vectorSearch = new VectorSearch(embeddingData.embeddings);

    return {
      success: true,
      result: {
        appUrl: embeddingData.appUrl,
        embeddingCount: embeddingData.embeddings.length,
        crawledAt: embeddingData.crawledAt
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Handle search embeddings request
 */
async function handleSearchEmbeddings(data) {
  return {
    success: false,
    error: 'Embeddings are disabled. Local ML libraries do not work in Chrome extensions due to CSP restrictions.'
  };
}

/**
 * Handle get app context for test generation
 */
async function handleGetAppContext(data) {
  // No embeddings available, return empty context
  return {
    success: true,
    context: null
  };
}

/**
 * Handle export embeddings
 */
async function handleExportEmbeddings(data) {
  try {
    const format = data.format || 'both'; // Default: export BOTH formats
    let filename;
    let result = {};

    if (format === 'both') {
      // Export both JSON and Markdown
      const files = await storageManager.exportBothFormats(data.appUrl);
      result = {
        success: true,
        files: files,
        message: `Exported both formats: ${files.json} and ${files.markdown}`
      };
    } else if (format === 'json') {
      filename = await storageManager.exportToJSON(data.appUrl);
      result = { success: true, filename };
    } else if (format === 'markdown' || format === 'md') {
      filename = await storageManager.exportToMarkdown(data.appUrl);
      result = { success: true, filename };
    } else if (format === 'binary') {
      filename = await storageManager.exportToBinary(data.appUrl);
      result = { success: true, filename };
    } else {
      throw new Error('Invalid export format. Use: both, json, markdown, or binary');
    }

    return result;
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Handle import embeddings
 */
async function handleImportEmbeddings(data) {
  try {
    // Detect format and parse accordingly
    let parsedData;
    let format = 'json';

    // Check if data is a string (might be JSON or Markdown)
    if (typeof data === 'string') {
      // Detect format based on content
      if (data.trim().startsWith('#') || data.includes('## ')) {
        // Markdown format
        format = 'markdown';
        parsedData = parseMarkdownImport(data);
        console.log('📝 Importing Markdown format (knowledge graph only, no embeddings)');
      } else {
        // JSON format
        try {
          parsedData = JSON.parse(data);
          console.log('📄 Importing JSON format');
        } catch (e) {
          throw new Error('Invalid JSON format');
        }
      }
    } else {
      // Already parsed object
      parsedData = data;
    }

    // Validate data
    if (!parsedData || !parsedData.appUrl) {
      throw new Error('Invalid import data: missing appUrl');
    }

    // Check if knowledge graph exists
    if (!parsedData.knowledgeGraph) {
      throw new Error('Invalid import data: missing knowledgeGraph');
    }

    // Prepare data for storage
    const importData = {
      appUrl: parsedData.appUrl,
      embeddings: parsedData.embeddings || [], // Empty array if no embeddings
      knowledgeGraph: parsedData.knowledgeGraph,
      metadata: parsedData.metadata || {
        appUrl: parsedData.appUrl,
        model: null,
        dimensions: 0,
        totalTokens: 0,
        cost: 0,
        provider: null,
        crawledAt: parsedData.crawledAt || new Date().toISOString(),
        importedFrom: format
      },
      crawledAt: parsedData.crawledAt || Date.now(),
      version: parsedData.version || '11.0.0'
    };

    // Save to storage
    await storageManager.saveEmbeddings(importData.appUrl, importData);

    const embeddingCount = importData.embeddings.length;
    const pageCount = importData.knowledgeGraph.totalPages || 0;

    return {
      success: true,
      message: format === 'markdown'
        ? `Imported ${pageCount} pages from Markdown (no embeddings)`
        : `Imported ${pageCount} pages with ${embeddingCount} embeddings`,
      format: format,
      pages: pageCount,
      embeddings: embeddingCount
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Parse Markdown import file back to knowledge graph
 * Note: Embeddings cannot be recovered from Markdown
 */
function parseMarkdownImport(markdown) {
  // This is a simplified parser - MD format is lossy
  // We can only recover basic structure, not embeddings

  console.warn('⚠️ Markdown import is limited - embeddings cannot be recovered');

  // Extract app URL
  const appUrlMatch = markdown.match(/\*\*Application:\*\*\s+(.+)/);
  const appUrl = appUrlMatch ? appUrlMatch[1].trim() : 'imported-from-markdown';

  // Extract crawl date
  const dateMatch = markdown.match(/\*\*Crawled:\*\*\s+(.+)/);
  const crawledAt = dateMatch ? new Date(dateMatch[1].trim()).getTime() : Date.now();

  // Extract total pages
  const pagesMatch = markdown.match(/\*\*Total Pages:\*\*\s+(\d+)/);
  const totalPages = pagesMatch ? parseInt(pagesMatch[1]) : 0;

  // Note: Full page data reconstruction from MD is complex
  // For now, just return basic structure
  // TODO: Could add full MD parsing if needed

  return {
    appUrl: appUrl,
    knowledgeGraph: {
      appUrl: appUrl,
      crawledAt: crawledAt,
      totalPages: totalPages,
      pages: [], // Cannot fully recover from MD
      stats: {
        totalFeatures: 0,
        totalApis: 0
      }
    },
    embeddings: [],
    crawledAt: crawledAt
  };
}

/**
 * Handle export all embeddings
 */
async function handleExportAllEmbeddings() {
  try {
    const stats = await storageManager.getStats();

    if (!stats.apps || stats.apps.length === 0) {
      return {
        success: true,
        count: 0
      };
    }

    let exportedCount = 0;

    // Export each app's embeddings
    for (const app of stats.apps) {
      try {
        await storageManager.exportToJSON(app.url);
        exportedCount++;
      } catch (error) {
        console.error(`Failed to export ${app.url}:`, error);
      }
    }

    return {
      success: true,
      count: exportedCount
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Handle delete all embeddings and crawl data
 */
async function handleDeleteAllEmbeddings() {
  try {
    // Get stats to count items before deletion
    const stats = await storageManager.getStats();
    const totalCount = stats.apps ? stats.apps.length : 0;

    if (totalCount === 0) {
      return {
        success: true,
        deletedCount: 0,
        message: 'No data to delete'
      };
    }

    // Clear all embeddings from IndexedDB
    await storageManager.clearAll();

    console.log(`🗑️ Deleted all embeddings and crawl data (${totalCount} apps)`);

    return {
      success: true,
      deletedCount: totalCount,
      message: `Successfully deleted ${totalCount} app(s)`
    };
  } catch (error) {
    console.error('❌ Failed to delete all embeddings:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Handle get all crawled apps
 */
async function handleGetAllApps() {
  try {
    const stats = await storageManager.getStats();
    return {
      success: true,
      apps: stats.apps
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Handle delete embeddings
 */
async function handleDeleteEmbeddings(data) {
  try {
    await storageManager.deleteEmbeddings(data.appUrl);

    // Clear vector search if it was for this app
    if (vectorSearch) {
      vectorSearch.clearCache();
      vectorSearch = null;
    }

    return {
      success: true
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Handle get crawler stats
 */
async function handleGetCrawlerStats() {
  try {
    const storageStats = await storageManager.getStats();
    const searchStats = vectorSearch ? vectorSearch.getStats() : null;

    return {
      success: true,
      stats: {
        storage: storageStats,
        search: searchStats,
        activeCrawler: !!activeCrawler
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Handle merge knowledge graphs
 */
async function handleMergeKnowledgeGraphs(data) {
  try {
    const { appUrls } = data;

    if (!appUrls || appUrls.length < 2) {
      throw new Error('At least 2 knowledge graphs are required for merging');
    }

    console.log(`🔀 Merging ${appUrls.length} knowledge graphs...`);

    // Load all knowledge graphs AND embeddings
    const graphs = [];
    const allEmbeddingData = [];

    for (const appUrl of appUrls) {
      const embeddingData = await storageManager.loadEmbeddings(appUrl);
      if (embeddingData && embeddingData.knowledgeGraph) {
        graphs.push(embeddingData.knowledgeGraph);
        allEmbeddingData.push(embeddingData);
      } else {
        console.warn(`⚠️ No knowledge graph found for ${appUrl}`);
      }
    }

    if (graphs.length < 2) {
      throw new Error(`Only found ${graphs.length} knowledge graphs. Need at least 2 to merge.`);
    }

    // Create merger and merge graphs
    const merger = new KnowledgeGraphMerger();
    const mergedGraph = await merger.mergeGraphs(graphs);

    // Merge embeddings from all sources
    console.log('🔮 Merging embeddings from all sources...');
    const mergedEmbeddings = [];
    let totalTokens = 0;
    let totalCost = 0;
    let embeddingModel = null;
    let embeddingDimensions = 0;
    let embeddingProvider = null;

    // Build URL mapping: old URL -> new URL in merged graph
    const urlMapping = new Map();

    // Map original URLs to merged graph URLs
    for (const [mergedUrl, mergedPage] of Object.entries(mergedGraph.pages || {})) {
      // Check each original graph for matching pages
      for (let i = 0; i < graphs.length; i++) {
        const originalGraph = graphs[i];
        const originalPages = Object.entries(originalGraph.pages || {});

        for (const [originalUrl, originalPage] of originalPages) {
          // Check if this original page matches the merged page
          // (Simple check: if they share the same title or URL pattern)
          const titleMatch = originalPage.metadata?.title === mergedPage.metadata?.title;
          const urlPathMatch = originalUrl.split('://')[1]?.split('/').slice(1).join('/') ===
                               mergedUrl.split('://')[1]?.split('/').slice(1).join('/');

          if (titleMatch || urlPathMatch || originalUrl === mergedUrl) {
            urlMapping.set(originalUrl, mergedUrl);
          }
        }
      }
    }

    // Merge embeddings from each source
    for (let i = 0; i < allEmbeddingData.length; i++) {
      const embData = allEmbeddingData[i];

      if (embData.embeddings && embData.embeddings.length > 0) {
        // Update embedding metadata
        if (!embeddingModel) embeddingModel = embData.model;
        if (!embeddingDimensions) embeddingDimensions = embData.dimensions;
        if (!embeddingProvider) embeddingProvider = embData.provider;

        totalTokens += embData.totalTokens || 0;
        totalCost += embData.cost || 0;

        // Add embeddings with updated page URLs
        for (const embedding of embData.embeddings) {
          const oldPageUrl = embedding.pageUrl;
          const newPageUrl = urlMapping.get(oldPageUrl) || oldPageUrl;

          // Only add if the page exists in merged graph
          if (mergedGraph.pages[newPageUrl]) {
            mergedEmbeddings.push({
              ...embedding,
              pageUrl: newPageUrl, // Update to merged graph URL
              sourceGraph: appUrls[i] // Track which source this came from
            });
          }
        }
      }
    }

    console.log(`✅ Merged ${mergedEmbeddings.length} embeddings from ${allEmbeddingData.length} sources`);

    // Generate merge report
    const report = merger.getMergeReport(graphs, mergedGraph);
    report.embeddings = {
      total: mergedEmbeddings.length,
      fromSources: allEmbeddingData.map((ed, i) => ({
        url: appUrls[i],
        count: ed.embeddings?.length || 0
      })),
      totalTokens,
      totalCost
    };

    // Save merged graph WITH merged embeddings
    const mergedAppUrl = `merged_${Date.now()}`;
    await storageManager.saveEmbeddings(mergedAppUrl, {
      appUrl: mergedAppUrl,
      embeddings: mergedEmbeddings, // ✅ Now includes all embeddings!
      knowledgeGraph: mergedGraph,
      crawledAt: new Date().toISOString(),
      model: embeddingModel,
      dimensions: embeddingDimensions,
      totalTokens: totalTokens,
      cost: totalCost,
      provider: embeddingProvider,
      isMerged: true,
      sources: mergedGraph.sources
    });

    console.log(`✅ Merged graph with ${mergedEmbeddings.length} embeddings saved as: ${mergedAppUrl}`);

    return {
      success: true,
      mergedAppUrl,
      report
    };
  } catch (error) {
    console.error('❌ Merge failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Handle get mergeable apps (apps with knowledge graphs)
 */
async function handleGetMergeableApps() {
  try {
    const stats = await storageManager.getStats();

    // Filter to only apps that have knowledge graphs
    const mergeableApps = (stats.apps || []).map(app => ({
      url: app.url,
      pages: app.embeddingCount,
      crawledAt: app.crawledAt,
      isMerged: app.url.startsWith('merged_')
    }));

    return {
      success: true,
      apps: mergeableApps
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Handle incremental page processing - generate embeddings and save as we crawl
 * This allows large crawls to process data progressively instead of all at once
 */
async function handleProcessPageIncremental(pageData, crawlId, crawlStartTime) {
  try {
    // Get active crawl settings from storage
    const crawlSettings = await chrome.storage.local.get(['incrementalCrawlSettings']);
    const settings = crawlSettings.incrementalCrawlSettings?.[crawlId];

    // Debug logging
    if (!settings) {
      console.log(`⚠️ No incremental settings found for crawlId: ${crawlId}`);
      console.log(`   Available crawl IDs:`, Object.keys(crawlSettings.incrementalCrawlSettings || {}));
    }

    // Only process if embeddings are enabled for this crawl
    if (!settings || !settings.generateEmbeddings || !settings.embeddingApiKey) {
      // Just save page to knowledge graph without embeddings
      return { success: true, embedded: false };
    }

    // Get or create crawl state
    if (!incrementalCrawlState.has(crawlId)) {
      // Initialize state for this crawl
      const provider = settings.embeddingProvider || 'openai';
      let embeddingService;

      if (provider === 'jina') {
        embeddingService = new JinaEmbeddingService(settings.embeddingApiKey);
      } else {
        embeddingService = new OpenAIEmbeddingService(settings.embeddingApiKey);
      }

      incrementalCrawlState.set(crawlId, {
        embeddingService,
        pages: [],
        embeddings: [],
        totalTokens: 0,
        totalCost: 0,
        provider,
        startTime: crawlStartTime
      });

      console.log(`🔮 Initialized incremental embedding for: ${crawlId}`);
      console.log(`   Provider: ${provider}, Model: ${embeddingService.model}`);
    }

    const state = incrementalCrawlState.get(crawlId);

    // Add page to state
    state.pages.push(pageData);

    // Log first page to confirm it's working
    if (state.pages.length === 1) {
      console.log(`✅ Starting incremental embedding generation (first page: ${pageData.url})`);
    }

    // Generate embedding for this page
    try {
      const pageText = state.embeddingService.createPageText(pageData);
      const embedding = await state.embeddingService.generateSingleEmbedding(pageText);

      // Add to embeddings array
      state.embeddings.push({
        url: pageData.url,
        text: pageText,
        embedding: embedding.embedding,
        tokens: embedding.tokens || 0
      });

      // Update totals
      state.totalTokens += embedding.tokens || 0;
      state.totalCost += embedding.cost || 0;

      // Save incrementally to storage every 10 pages (to avoid too many writes)
      if (state.embeddings.length % 10 === 0) {
        await storageManager.saveEmbeddingsIncremental(crawlId, {
          embeddings: state.embeddings,
          metadata: {
            appUrl: crawlId,
            provider: state.provider,
            totalTokens: state.totalTokens,
            cost: state.totalCost,
            pagesProcessed: state.pages.length
          }
        });

        console.log(`💾 Saved ${state.embeddings.length} embeddings incrementally (${state.totalCost > 0 ? `$${state.totalCost.toFixed(4)}` : 'FREE'})`);

        // MEMORY OPTIMIZATION: Clean up old incremental states
        cleanupIncrementalStates();
      }

      // Broadcast embedding progress
      broadcastMessage({
        action: 'embeddingProgress',
        progress: {
          status: 'generating',
          current: state.embeddings.length,
          total: null, // Don't know total until crawl completes
          cost: state.totalCost
        }
      });

      return {
        success: true,
        embedded: true,
        embeddingCount: state.embeddings.length,
        totalCost: state.totalCost
      };
    } catch (error) {
      console.error('Failed to generate embedding for page:', error);
      return { success: false, error: error.message };
    }
  } catch (error) {
    console.error('Error in handleProcessPageIncremental:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Finalize incremental crawl - save final embeddings and clean up state
 */
async function finalizeIncrementalCrawl(crawlId, knowledgeGraph) {
  if (!incrementalCrawlState.has(crawlId)) {
    console.log(`ℹ️ No incremental crawl state found for ${crawlId}`);
    return; // No incremental state to finalize
  }

  const state = incrementalCrawlState.get(crawlId);

  try {
    // Save final embeddings with complete knowledge graph
    await storageManager.saveEmbeddings(crawlId, {
      appUrl: crawlId,
      embeddings: state.embeddings,
      knowledgeGraph: knowledgeGraph,
      crawledAt: new Date().toISOString(),
      model: state.embeddingService.model || 'text-embedding-3-small',
      dimensions: state.embeddings[0]?.embedding?.length || 1536,
      totalTokens: state.totalTokens,
      cost: state.totalCost,
      provider: state.provider
    });

    console.log(`✅ Finalized ${state.embeddings.length} embeddings for ${crawlId}`);

    // Clean up state and settings
    incrementalCrawlState.delete(crawlId);

    // Clean up settings from storage
    const existing = await chrome.storage.local.get(['incrementalCrawlSettings']);
    const incrementalSettings = existing.incrementalCrawlSettings || {};
    delete incrementalSettings[crawlId];
    await chrome.storage.local.set({ incrementalCrawlSettings: incrementalSettings });

    return {
      embeddingCount: state.embeddings.length,
      totalCost: state.totalCost
    };
  } catch (error) {
    console.error('Error finalizing incremental crawl:', error);
    incrementalCrawlState.delete(crawlId);
    throw error;
  }
}
