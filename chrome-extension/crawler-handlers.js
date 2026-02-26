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

    // Create and start crawler
    activeCrawler = new WebAppCrawler(config);

    // P0.3: Start heartbeat to checkpoint crawler state every 10s
    startCrawlHeartbeat();

    const knowledgeGraph = await activeCrawler.crawl();

    // P0.3: Stop heartbeat after crawl completes
    stopCrawlHeartbeat();

    console.log('✅ Crawl complete');

    // Save knowledge graph to storage (no embeddings)
    console.log('💾 Saving knowledge graph...');
    await storageManager.saveEmbeddings(config.startUrl, {
      appUrl: config.startUrl,
      embeddings: [], // Empty array (no embeddings)
      knowledgeGraph: knowledgeGraph,
      crawledAt: new Date().toISOString(),
      model: null,
      dimensions: 0,
      totalTokens: 0,
      cost: 0,
      provider: null
    });
    console.log(`✅ Saved knowledge graph with ${knowledgeGraph.totalPages} pages`);

    // Invalidate stale BM25 index and build a fresh one eagerly so the first
    // query after a crawl doesn't pay the build cost.
    try {
      await storageManager.deleteBm25Index(config.startUrl);
      const bm25 = BM25Index.build(knowledgeGraph.pages);
      await storageManager.saveBm25Index(config.startUrl, bm25.serialize());
      console.log(`✅ BM25 index built eagerly (${bm25.N} docs)`);
    } catch (e) {
      console.warn('⚠️ BM25 index build failed (will retry on first query):', e.message);
    }

    const result = {
      pages: knowledgeGraph.totalPages,
      features: knowledgeGraph.stats.totalFeatures,
      apis: knowledgeGraph.stats.totalApis,
      appUrl: config.startUrl,
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
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '✅ Crawl Complete!',
      message: `${result.pages} pages, ${result.features} features, ${result.apis} APIs`,
      priority: 2,
      requireInteraction: false
    });

    return {
      success: true,
      result: result
    };
  } catch (error) {
    console.error('Crawl failed:', error.message);

    // Clear active crawl flag - non-critical cleanup
    await chrome.storage.local.remove('activeCrawl').catch(cleanupErr => {
      console.warn('Failed to clear activeCrawl flag during error handling:', cleanupErr.message);
    });

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

    // Clear active crawl flag from storage - non-critical cleanup
    await chrome.storage.local.remove('activeCrawl').catch(err => {
      console.warn('Failed to clear activeCrawl flag:', err.message);
    });

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
 * Uses smart keyword-based filtering to send only relevant pages
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

    // Calculate knowledge graph size
    const fullPageCount = embeddingData.knowledgeGraph?.pages
      ? Object.keys(embeddingData.knowledgeGraph.pages).length
      : 0;

    console.log(`[LOAD GRAPH] Full knowledge graph: ${fullPageCount} pages`);

    // CRITICAL FIX: For large graphs, filter by ticket keywords before sending
    // Only send the most relevant 30 pages instead of all 1097!
    const MAX_PAGES_TO_SEND = 30; // Top 30 most relevant pages (safer for quota)
    let knowledgeGraphToSend = embeddingData.knowledgeGraph;
    let wasFiltered = false;

    if (fullPageCount > MAX_PAGES_TO_SEND && data.ticketData) {
      console.log(`[LOAD GRAPH] 🎯 Filtering ${fullPageCount} pages by ticket relevance...`);

      // Load (or lazily build) the BM25 index for this app
      let bm25 = null;
      try {
        const saved = await storageManager.loadBm25Index(data.appUrl);
        if (saved) {
          bm25 = BM25Index.deserialize(saved);
          console.log(`[LOAD GRAPH] ✅ Loaded BM25 index (${bm25.N} docs, built ${new Date(bm25.builtAt).toLocaleTimeString()})`);
        }
      } catch (e) {
        console.warn('[LOAD GRAPH] ⚠️ Could not load BM25 index:', e.message);
      }

      if (!bm25 && embeddingData.knowledgeGraph?.pages) {
        console.log('[LOAD GRAPH] 🔨 Building BM25 index lazily...');
        const t0 = Date.now();
        bm25 = BM25Index.build(embeddingData.knowledgeGraph.pages);
        console.log(`[LOAD GRAPH] ✅ BM25 built in ${Date.now() - t0}ms`);
        storageManager.saveBm25Index(data.appUrl, bm25.serialize())
          .catch(e => console.warn('[LOAD GRAPH] Failed to persist BM25 index:', e.message));
      }

      if (bm25) {
        // BM25 semantic relevance scoring
        const queryText = `${data.ticketData.summary || ''} ${data.ticketData.description || ''}`;
        const topResults = bm25.search(queryText, MAX_PAGES_TO_SEND);
        console.log(`[LOAD GRAPH] 🎯 BM25 top match: "${topResults[0]?.url}" (score ${topResults[0]?.score?.toFixed(2)})`);

        const allPages = embeddingData.knowledgeGraph.pages;
        const filteredPages = {};
        for (const { url } of topResults) {
          if (allPages[url]) filteredPages[url] = GraphFilter.stripPageData(allPages[url]);
        }

        // Pad to MAX_PAGES_TO_SEND with un-matched pages if BM25 returned fewer
        if (Object.keys(filteredPages).length < MAX_PAGES_TO_SEND) {
          const remaining = Object.keys(allPages)
            .filter(u => !filteredPages[u])
            .slice(0, MAX_PAGES_TO_SEND - Object.keys(filteredPages).length);
          for (const url of remaining) {
            filteredPages[url] = GraphFilter.stripPageData(allPages[url]);
          }
        }

        knowledgeGraphToSend = {
          ...embeddingData.knowledgeGraph,
          pages: filteredPages,
          filteredForTransfer: true,
          transferPageCount: Object.keys(filteredPages).length,
          filterMethod: 'bm25',
          filterQuery: queryText.slice(0, 120),
        };
      } else {
        // Fallback: legacy keyword scoring
        console.log('[LOAD GRAPH] ⚠️ BM25 unavailable, falling back to keyword scoring');
        knowledgeGraphToSend = GraphFilter.filterByRelevance(
          embeddingData.knowledgeGraph,
          data.ticketData,
          MAX_PAGES_TO_SEND
        );
      }

      wasFiltered = true;
    } else if (fullPageCount > MAX_PAGES_TO_SEND) {
      // Fallback: no ticket data, just take last N pages
      console.log(`[LOAD GRAPH] ⚠️ No ticket data, taking last ${MAX_PAGES_TO_SEND} pages...`);

      const pages = Object.entries(embeddingData.knowledgeGraph.pages || {});
      const subsetPages = Object.fromEntries(pages.slice(-MAX_PAGES_TO_SEND));

      knowledgeGraphToSend = {
        ...embeddingData.knowledgeGraph,
        pages: subsetPages,
        totalPages: fullPageCount,
        filteredForTransfer: true,
        transferPageCount: MAX_PAGES_TO_SEND,
        filterMethod: 'recent-pages'
      };

      wasFiltered = true;
    }

    // Send filtered knowledge graph to content script
    // ContextAnalysisAgent will run in orchestrator (every time tests are generated)
    console.log(`[LOAD GRAPH] 📨 Sending filtered knowledge graph to content script`);
    console.log(`   Pages: ${wasFiltered ? MAX_PAGES_TO_SEND : fullPageCount} / ${fullPageCount}`);

    return {
      success: true,
      useBridge: false,
      result: {
        appUrl: embeddingData.appUrl,
        crawledAt: embeddingData.crawledAt,
        pageCount: fullPageCount,
        transferPageCount: wasFiltered ? MAX_PAGES_TO_SEND : fullPageCount,
        knowledgeGraph: knowledgeGraphToSend, // Send full filtered graph (will be analyzed by orchestrator)
        hasContext: !!knowledgeGraphToSend
      }
    };
  } catch (error) {
    console.error('[LOAD GRAPH] ❌ Error:', error);
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
        console.log('📝 Importing Markdown format (knowledge graph only)');
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

    const pageCount = importData.knowledgeGraph.totalPages || 0;

    return {
      success: true,
      message: `Imported ${pageCount} pages from ${format}`,
      format: format,
      pages: pageCount
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
 */
function parseMarkdownImport(markdown) {
  // This is a simplified parser - MD format is lossy
  // We can only recover basic structure

  console.warn('⚠️ Markdown import is limited - some data may be lost');

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

    console.log(`🗑️ Deleted all crawl data (${totalCount} apps)`);

    return {
      success: true,
      deletedCount: totalCount,
      message: `Successfully deleted ${totalCount} app(s)`
    };
  } catch (error) {
    console.error('❌ Failed to delete crawl data:', error);
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

    return {
      success: true,
      stats: {
        storage: storageStats,
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

    // Merge data from all sources
    console.log('🔀 Merging knowledge graphs from all sources...');
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

    console.log(`✅ Merged data from ${allEmbeddingData.length} sources`);

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

    console.log(`✅ Merged graph saved as: ${mergedAppUrl}`);

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
 * Handle incremental page processing - save pages as we crawl
 * This allows large crawls to process data progressively instead of all at once
 */
async function handleProcessPageIncremental(pageData, crawlId, crawlStartTime) {
  try {
    // Just save page to knowledge graph (no embeddings needed)
    return { success: true };
  } catch (error) {
    console.error('Error in handleProcessPageIncremental:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Finalize incremental crawl - clean up state
 */
async function finalizeIncrementalCrawl(crawlId, knowledgeGraph) {
  // Nothing to finalize (no embeddings generated)
  console.log(`✅ Finalized crawl for ${crawlId} (knowledge graph only)`);
  return {};
}
