/**
 * bg-context.js — Generation context: crawl data filtered to the ticket, loaded from storage, and the ticket enriched with Confluence / Figma / Google Docs content.
 *
 * Moved verbatim out of background.js. Plain script: the worker importScripts it,
 * so these functions stay globals and every call site is unchanged.
 */


// Unified AI call function (non-streaming - kept for backward compatibility)
// callAI is provided by llm-client.js (importScripts above).

// validateSettings is provided by background-utils.js (importScripts above).

/**
 * Get filtered crawl data based on Jira ticket keywords
 * Intelligently queries crawl data JSON and creates a focused 5-10 KB summary
 * @param {Array} keywords - Keywords extracted from Jira ticket
 * @param {number} maxSizeKB - Maximum summary size in KB
 * @returns {Promise<Object>} - { summary: string, matchedPages: number }
 */
async function getFilteredCrawlData(keywords, maxSizeKB = 10) {
  try {
    // Ensure storage manager is ready
    await storageReady;

    if (!storageManager) {
      console.log('ℹ️ Storage manager not initialized');
      return { summary: null, matchedPages: 0 };
    }

    // Get all stored apps with their knowledge graphs
    const allApps = await storageManager.getAllEmbeddings();

    if (!allApps || allApps.length === 0) {
      console.log('ℹ️ No crawled apps in storage');
      return { summary: null, matchedPages: 0 };
    }

    console.log(`📦 Found ${allApps.length} crawled app(s) in storage`);

    // Extract all pages from all knowledge graphs
    const crawledPages = [];
    for (const app of allApps) {
      console.log(`🔍 Checking app: ${app.appUrl}`);
      console.log(`   - Has knowledgeGraph: ${!!app.knowledgeGraph}`);

      if (app.knowledgeGraph) {
        console.log(`   - knowledgeGraph.pages type: ${typeof app.knowledgeGraph.pages}`);
        console.log(`   - Is array: ${Array.isArray(app.knowledgeGraph.pages)}`);

        if (app.knowledgeGraph.pages) {
          // Ensure pages is actually an array
          if (Array.isArray(app.knowledgeGraph.pages)) {
            console.log(`   - Adding ${app.knowledgeGraph.pages.length} pages`);
            crawledPages.push(...app.knowledgeGraph.pages);
          } else {
            console.warn('⚠️ app.knowledgeGraph.pages is not an array:', typeof app.knowledgeGraph.pages);
            // Try to convert it to an array if it's an object
            if (typeof app.knowledgeGraph.pages === 'object' && app.knowledgeGraph.pages !== null) {
              const pagesArray = Object.values(app.knowledgeGraph.pages);
              console.log(`   - Converted object to array: ${pagesArray.length} pages`);
              crawledPages.push(...pagesArray);
            }
          }
        }
      }
    }

    if (crawledPages.length === 0) {
      console.log('ℹ️ No pages found in crawl data. Please crawl your app first using Settings → Web App Crawler');
      return { summary: null, matchedPages: 0 };
    }

    console.log(`🔍 Filtering ${crawledPages.length} pages from ${allApps.length} app(s) with BM25 (${keywords.length} keywords)`);

    // Build a per-app BM25 index map (load from IndexedDB or build lazily)
    const appBm25Map = new Map(); // appUrl → BM25Index
    for (const app of allApps) {
      if (!app.knowledgeGraph?.pages) continue;
      try {
        const saved = await storageManager.loadBm25Index(app.appUrl);
        if (saved) {
          appBm25Map.set(app.appUrl, BM25Index.deserialize(saved));
          console.log(`[BM25] Loaded index for ${app.appUrl}`);
        } else {
          const bm25 = BM25Index.build(app.knowledgeGraph.pages);
          appBm25Map.set(app.appUrl, bm25);
          storageManager.saveBm25Index(app.appUrl, bm25.serialize())
            .catch(e => console.warn('[BM25] Failed to persist index:', e.message));
        }
      } catch (e) {
        console.warn(`[BM25] Index unavailable for ${app.appUrl}, will use keyword fallback:`, e.message);
      }
    }

    const queryText = keywords.join(' ');

    // Score pages: BM25 where index is available, keyword fallback otherwise
    const scoredPages = crawledPages.map(page => {
      const pageUrl = page.url || page.metadata?.url || '';
      // Find which app owns this page
      const ownerApp = allApps.find(a => pageUrl.startsWith(a.appUrl));
      const bm25 = ownerApp ? appBm25Map.get(ownerApp.appUrl) : null;

      if (bm25) {
        // BM25: score this single doc against the query
        const queryTerms = BM25Index.tokenize(queryText);
        return { page, score: bm25.scoreDoc(pageUrl, queryTerms) };
      }

      // Keyword fallback for pages without an index
      let score = 0;
      const description = page.description || page.metadata?.description || '';
      keywords.forEach(kw => {
        const k = kw.toLowerCase();
        if (pageUrl.toLowerCase().includes(k)) score += 10;
        if ((page.title || '').toLowerCase().includes(k)) score += 5;
        if (description.toLowerCase().includes(k)) score += 3;
        (page.forms || []).forEach(f => (f.fields || []).forEach(fi => {
          if ((fi.name || '').toLowerCase().includes(k)) score += 2;
        }));
      });
      return { page, score };
    });

    // Sort by BM25 score (descending)
    scoredPages.sort((a, b) => b.score - a.score);

    // Filter pages with score > 0 (at least one keyword match)
    const relevantPages = scoredPages.filter(p => p.score > 0);

    if (relevantPages.length === 0) {
      console.log('ℹ️ No keyword-matched pages found, providing general crawl summary');
      // Fallback: Return a basic summary of available crawl data
      const topPages = scoredPages.slice(0, 10);
      if (topPages.length > 0) {
        let fallbackSummary = `\n\n## 🌐 Application Context (General Overview)\n\n`;
        fallbackSummary += `**Note:** No pages specifically matched ticket keywords, showing general app structure\n`;
        fallbackSummary += `**Total Crawled Pages:** ${crawledPages.length}\n\n`;

        topPages.forEach(({ page }) => {
          fallbackSummary += `- **${page.title || page.url}**`;
          if (page.forms && page.forms.length > 0) {
            fallbackSummary += ` (${page.forms.length} forms)`;
          }
          fallbackSummary += `\n`;
        });

        return { summary: fallbackSummary, matchedPages: topPages.length, fallback: true };
      }
      return { summary: null, matchedPages: 0 };
    }

    console.log(`✅ Found ${relevantPages.length} relevant pages (top score: ${relevantPages[0]?.score || 0})`);

    // Build focused summary within size limit
    const maxBytes = maxSizeKB * 1024;
    const encoder = new TextEncoder(); // Reuse encoder instance
    let summary = `\n\n## 🌐 Application Context (Filtered from Crawl Data)\n\n`;
    summary += `**Relevance:** Found ${relevantPages.length} pages matching ticket keywords\n`;
    summary += `**Keywords Used:** ${keywords.slice(0, 10).join(', ')}${keywords.length > 10 ? ` +${keywords.length - 10} more` : ''}\n\n`;

    let includedPages = 0;
    let currentSize = encoder.encode(summary).length;

    // Add pages in order of relevance until size limit reached
    for (const { page, score } of relevantPages) {
      const pageSection = buildPageSection(page, score);
      const sectionSize = encoder.encode(pageSection).length;

      if (currentSize + sectionSize > maxBytes && includedPages > 0) {
        // Size limit reached, add summary note
        const remaining = relevantPages.length - includedPages;
        if (remaining > 0) {
          summary += `\n_... and ${remaining} more relevant pages (omitted for size limit)_\n`;
        }
        break;
      }

      summary += pageSection;
      currentSize += sectionSize;
      includedPages++;
    }

    console.log(`📊 Generated summary: ${currentSize} bytes (${(currentSize / 1024).toFixed(1)} KB), ${includedPages} pages`);

    return {
      summary: summary,
      matchedPages: includedPages
    };

  } catch (error) {
    console.error('❌ Error filtering crawl data:', error);
    return { summary: null, matchedPages: 0 };
  }
}

/**
 * Build a formatted section for a single page
 * @param {Object} page - Page data
 * @param {number} score - Relevance score
 * @returns {string} - Formatted page section
 */
function buildPageSection(page, score) {
  let section = `### 📄 ${page.title || 'Untitled Page'} (Relevance: ${score})\n`;
  section += `- **URL:** ${page.url}\n`;

  const description = page.description || page.metadata?.description;
  if (description) {
    section += `- **Description:** ${description.substring(0, 200)}${description.length > 200 ? '...' : ''}\n`;
  }

  // Forms
  if (page.forms && page.forms.length > 0) {
    section += `- **Forms:** ${page.forms.length} form(s)\n`;
    page.forms.slice(0, 2).forEach((form, idx) => {
      section += `  - Form ${idx + 1}: `;
      if (form.fields && form.fields.length > 0) {
        const fieldNames = form.fields.slice(0, 5).map(f => f.name || f.type).filter(Boolean);
        section += `${form.fields.length} fields (${fieldNames.join(', ')})`;
        if (form.fields.length > 5) section += ` +${form.fields.length - 5} more`;
      }
      section += `\n`;
    });
  }

  // Interactions
  if (page.interactions && page.interactions.length > 0) {
    section += `- **Interactive Elements:** ${page.interactions.length} (`;
    const interactionTypes = {};
    page.interactions.forEach(i => {
      interactionTypes[i.type] = (interactionTypes[i.type] || 0) + 1;
    });
    section += Object.entries(interactionTypes).map(([type, count]) => `${count} ${type}`).join(', ');
    section += `)\n`;
  }

  // APIs/Endpoints if available
  if (page.apis && page.apis.length > 0) {
    section += `- **API Endpoints:** ${page.apis.slice(0, 3).join(', ')}${page.apis.length > 3 ? ` +${page.apis.length - 3} more` : ''}\n`;
  }

  section += `\n`;
  return section;
}

// Get crawl data from existing storage (populated by Settings page crawler)
async function getCrawlDataFromStorage() {
  try {
    // Ensure storage manager is ready
    await storageReady;

    if (!storageManager) {
      console.log('ℹ️ Storage manager not initialized');
      return null;
    }

    // Get all crawled pages from storage
    const crawledPages = await storageManager.getAllPages();

    if (!crawledPages || crawledPages.length === 0) {
      console.log('ℹ️ No crawl data in storage. Run crawler from Settings page first.');
      return null;
    }

    // Get knowledge graph for additional context
    const knowledgeGraph = await storageManager.getKnowledgeGraph();

    // Build context data from stored crawl
    const contextData = {
      pages: [],
      pagesCount: crawledPages.length,
      featuresCount: 0,
      apisCount: 0
    };

    // Extract and format page data
    for (const page of crawledPages) {
      contextData.pages.push({
        url: page.url,
        title: page.title,
        description: page.metadata?.description || '',
        forms: page.forms || [],
        interactions: page.interactions || [],
        keywords: page.metadata?.keywords || []
      });

      // Count features and APIs
      if (page.forms) contextData.featuresCount += page.forms.length;
      if (page.interactions) contextData.featuresCount += page.interactions.length;
    }

    // Count APIs from knowledge graph
    if (knowledgeGraph && knowledgeGraph.apis) {
      contextData.apisCount = knowledgeGraph.apis.length || 0;
    }

    console.log(`📊 Retrieved crawl data: ${contextData.pagesCount} pages, ${contextData.featuresCount} features, ${contextData.apisCount} APIs`);
    return contextData;

  } catch (error) {
    console.error('❌ Error retrieving crawl data from storage:', error);
    return null;
  }
}

// Shared helper: Fetch and merge external content (Confluence, Figma, Google Docs)
async function enrichTicketWithExternalContent(ticketData, settings) {
  // F25: this returned early unless SOME credential was configured — but the
  // Google Docs adapter fetches PUBLIC documents through the export endpoint with
  // no key at all. A ticket whose only linked spec was a public Google Doc was
  // therefore never enriched, gated on credentials it did not need.
  const hasAnyCredential = !!(settings.confluenceUrl || settings.figmaToken || settings.googleApiKey);
  const mayFetchPublicDocs = typeof GoogleDocsIntegration !== 'undefined';
  if (!hasAnyCredential && !mayFetchPublicDocs) {
    return { enrichedTicketData: ticketData, externalContent: null, externalSources: null };
  }

  const integrationManager = new IntegrationManager(settings);
  const externalContent = await integrationManager.fetchAllLinkedContent(ticketData);

  // F25: count what was actually USABLE, not merely attempted. Failed Confluence
  // entries stay in the returned list (with content:null and an error) so the
  // failure can be reported — but counting them as "3 Confluence sources" told
  // the user they had context they did not have.
  const usable = (arr) => (arr || []).filter(x => x && !x.error && (x.content || x.text || x.images));
  const failed = (arr) => (arr || []).filter(x => x && x.error);

  const externalSources = {
    confluence: usable(externalContent.confluence).length,
    figma: usable(externalContent.figma).length,
    googleDocs: usable(externalContent.googleDocs).length,
    // Per-source failures, preserved through the worker response so the panel can
    // distinguish "no linked docs" from "we could not read your linked docs".
    failures: [
      ...failed(externalContent.confluence).map(x => ({ type: 'confluence', url: x.url, error: x.error })),
      ...failed(externalContent.figma).map(x => ({ type: 'figma', url: x.url, error: x.error })),
      ...failed(externalContent.googleDocs).map(x => ({ type: 'googleDocs', url: x.url, error: x.error }))
    ]
  };

  // Build linkedPages from fetched content
  const fetchedLinkedPages = [];
  const typeMap = [
    { key: 'confluence', titleField: 'title', defaultTitle: 'Confluence Page', type: 'confluence' },
    { key: 'figma', titleField: 'name', defaultTitle: 'Figma File', type: 'figma' },
    { key: 'googleDocs', titleField: 'title', defaultTitle: 'Google Doc', type: 'google_docs' }
  ];

  for (const { key, titleField, defaultTitle, type } of typeMap) {
    externalContent[key].forEach((item, i) => {
      fetchedLinkedPages.push({
        id: `${type === 'google_docs' ? 'googledocs' : key}-${i}`,
        title: item[titleField] || defaultTitle,
        url: item.url || '',
        type: type,
        fetched: true
      });
    });
  }

  // Merge with existing linked pages (deduplicate by URL)
  const existingUrls = new Set((ticketData.linkedPages || []).map(p => p.url));
  const mergedLinkedPages = [
    ...(ticketData.linkedPages || []),
    ...fetchedLinkedPages.filter(p => !existingUrls.has(p.url))
  ];

  const enrichedTicketData = {
    ...ticketData,
    description: externalContent.enrichedDescription || ticketData.description,
    linkedPages: mergedLinkedPages,
    externalSources
  };

  return { enrichedTicketData, externalContent, externalSources };
}
