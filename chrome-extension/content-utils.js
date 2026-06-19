/**
 * content-utils.js — pure, DOM-free logic helpers extracted verbatim from
 * content.js to start shrinking that 4.8k-line content script and make the
 * pure logic independently unit-testable.
 *
 * IIFE-wrapped (CRITICAL: content scripts share one page scope — a colliding
 * top-level binding would break injection). The functions are exposed on the
 * page global via Object.assign(self|window, api) so content.js — which the
 * manifest loads AFTER this file — can call them exactly as before. The same
 * `api` is exported via module.exports for unit tests.
 *
 * No I/O, no chrome.* — only string/object transforms plus console logging.
 */
(function () {
  'use strict';

  // Extract plain text with URLs from Jira's ADF (Atlassian Document Format)
  function extractTextFromADF(adfContent) {
    if (!adfContent) return '';
    if (typeof adfContent === 'string') return adfContent;

    let text = '';

    function traverse(node) {
      if (!node) return;

      // Extract text content
      if (node.type === 'text') {
        text += node.text || '';
      }

      // Extract URLs from links
      if (node.type === 'text' && node.marks) {
        const linkMark = node.marks.find(m => m.type === 'link');
        if (linkMark && linkMark.attrs && linkMark.attrs.href) {
          // If text doesn't match URL, append URL in parentheses
          if (node.text !== linkMark.attrs.href) {
            text += ` (${linkMark.attrs.href})`;
          }
        }
      }

      // Handle media/images
      if (node.type === 'media' || node.type === 'mediaInline') {
        if (node.attrs && node.attrs.url) {
          text += node.attrs.url + ' ';
        }
      }

      // Handle code blocks
      if (node.type === 'codeBlock' && node.content) {
        text += '\n```\n';
        node.content.forEach(traverse);
        text += '\n```\n';
        return;
      }

      // Add line breaks for paragraphs and headings
      if (['paragraph', 'heading'].includes(node.type)) {
        if (text && !text.endsWith('\n')) {
          text += '\n';
        }
      }

      // Recursively process child nodes
      if (node.content && Array.isArray(node.content)) {
        node.content.forEach(traverse);
      }

      // Add line break after paragraphs
      if (['paragraph', 'heading'].includes(node.type)) {
        text += '\n';
      }
    }

    traverse(adfContent);
    return text.trim();
  }

  // Extract file type from filename
  function extractFileType(filename) {
    const extension = filename.split('.').pop().toLowerCase();
    const imageTypes = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'];
    const docTypes = ['pdf', 'doc', 'docx', 'txt', 'md'];

    if (imageTypes.includes(extension)) return 'image';
    if (docTypes.includes(extension)) return 'document';
    return extension || 'unknown';
  }

  // Determine the type of linked page
  function determinePageType(url) {
    // Convert to lowercase for case-insensitive matching
    const lowerUrl = url.toLowerCase();

    // Confluence detection - more patterns
    if (lowerUrl.includes('confluence') ||
        lowerUrl.includes('atlassian.net/wiki') ||
        lowerUrl.includes('/wiki/spaces/') ||
        lowerUrl.includes('/wiki/display/') ||
        lowerUrl.includes('/wiki/x/')) {
      return 'confluence';
    }
    // Figma detection - handle various Figma URL patterns
    else if (lowerUrl.includes('figma.com') ||
             lowerUrl.includes('fig.ma')) {  // Figma's short URL service
      return 'figma';
    }
    // Google Docs detection
    else if (lowerUrl.includes('docs.google.com')) {
      return 'google_docs';
    }
    // Google Drive detection
    else if (lowerUrl.includes('drive.google.com')) {
      return 'google_drive';
    }
    // GitHub detection
    else if (lowerUrl.includes('github.com')) {
      return 'github';
    }

    // Log unrecognized URLs for debugging
    console.log('🔗 URL type not recognized:', url);
    return 'external';
  }

  /**
   * Extract keywords from ticket for intelligent filtering
   *
   * NOTE: content.js historically declared two function statements with this
   * name in the same IIFE scope; the LATER one (this version) won via hoisting,
   * so both call sites used it. This is that effective version, preserved
   * verbatim so behaviour is unchanged.
   */
  function extractTicketKeywords(ticketData) {
    const text = `${ticketData.summary || ''} ${ticketData.description || ''}`.toLowerCase();

    // Remove common words
    const stopWords = ['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'been', 'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'what', 'which', 'who', 'when', 'where', 'why', 'how', 'error', 'issue', 'bug', 'problem', 'fix', 'update', 'add', 'remove', 'while', 'after', 'before'];

    // Extract words (3+ chars, not stop words)
    const words = text.match(/\b[a-z]{3,}\b/g) || [];
    const keywords = [...new Set(words.filter(w => !stopWords.includes(w)))];

    // Also extract quoted phrases and brackets
    const phrases = text.match(/\[([^\]]+)\]/g) || [];
    const quotedPhrases = text.match(/"([^"]+)"/g) || [];

    const allKeywords = [
      ...keywords,
      ...phrases.map(p => p.replace(/[\[\]]/g, '').toLowerCase()),
      ...quotedPhrases.map(p => p.replace(/"/g, '').toLowerCase())
    ];

    return [...new Set(allKeywords)];
  }

  /**
   * Calculate relevance score for a page/URL based on keywords
   */
  function calculateRelevanceScore(url, title, description, keywords) {
    let score = 0;
    const searchText = `${url} ${title || ''} ${description || ''}`.toLowerCase();

    keywords.forEach(keyword => {
      if (searchText.includes(keyword)) {
        // URL matches are most important
        if (url.toLowerCase().includes(keyword)) {
          score += 10;
        }
        // Title matches are very important
        if (title && title.toLowerCase().includes(keyword)) {
          score += 5;
        }
        // Description matches are somewhat important
        if (description && description.toLowerCase().includes(keyword)) {
          score += 2;
        }
      }
    });

    return score;
  }

  /**
   * Find matching crawled app based on ticket content
   */
  function findMatchingApp(apps, ticketData) {
    // Strategy 1: Look for URLs in ticket description
    const ticketText = `${ticketData.summary} ${ticketData.description}`.toLowerCase();

    for (const app of apps) {
      try {
        // Skip merged graphs for URL matching (they don't have real URLs)
        if (app.url.startsWith('merged_')) {
          continue;
        }

        const appDomain = new URL(app.url).hostname.toLowerCase();

        // Check if exact domain is mentioned in ticket
        if (ticketText.includes(appDomain)) {
          console.log(`✅ Matched app by exact domain: ${appDomain}`);
          return app;
        }

        // Extract base domain (e.g., "mindtickle.com" from "jellyvission.integration.mindtickle.com")
        const domainParts = appDomain.split('.');
        let baseDomain = appDomain;

        // Handle cases like: subdomain.staging.example.com → example.com
        if (domainParts.length >= 2) {
          // Get last 2 parts (example.com)
          baseDomain = domainParts.slice(-2).join('.');

          // Check if base domain is mentioned (environment-agnostic)
          if (ticketText.includes(baseDomain)) {
            console.log(`✅ Matched app by base domain: ${baseDomain} (from ${appDomain})`);
            return app;
          }
        }

        // Extract product name from base domain (e.g., "mindtickle" from "mindtickle.com")
        const productName = domainParts[domainParts.length - 2];
        if (productName && productName.length > 3 && ticketText.includes(productName)) {
          console.log(`✅ Matched app by product name: ${productName}`);
          return app;
        }

        // Check first subdomain only if it's meaningful (not env names)
        const firstPart = domainParts[0];
        const envKeywords = ['staging', 'prod', 'dev', 'test', 'qa', 'integration', 'uat', 'demo', 'sandbox'];
        if (firstPart.length > 3 && !envKeywords.includes(firstPart) && ticketText.includes(firstPart)) {
          console.log(`✅ Matched app by subdomain: ${firstPart}`);
          return app;
        }
      } catch (e) {
        continue;
      }
    }

    // Strategy 2: ALWAYS use crawled data when feature is enabled
    // Prioritize based on data quality, not URL matching

    // If only one app exists, use it
    if (apps.length === 1) {
      console.log(`📌 Auto-using crawled app: ${apps[0].url} (${apps[0].pages} pages, ${apps[0].features} features)`);
      return apps[0];
    }

    // Strategy 3: Prefer merged graphs (most comprehensive across environments)
    const mergedApps = apps.filter(app => app.url.startsWith('merged_'));
    if (mergedApps.length === 1) {
      console.log(`📌 Auto-using merged graph: ${mergedApps[0].url} (${mergedApps[0].pages} pages, ${mergedApps[0].features} features)`);
      return mergedApps[0];
    }

    // Strategy 4: Use the largest merged app (most comprehensive)
    if (mergedApps.length > 1) {
      const largestMerged = mergedApps.reduce((prev, current) =>
        (current.pages > prev.pages) ? current : prev
      );
      console.log(`📌 Auto-using largest merged graph: ${largestMerged.url} (${largestMerged.pages} pages, ${largestMerged.features} features)`);
      return largestMerged;
    }

    // Strategy 5: Use the largest app by page count (most data = best context)
    const largestApp = apps.reduce((prev, current) =>
      (current.pages > prev.pages) ? current : prev
    );
    console.log(`📌 Auto-using largest crawled app: ${largestApp.url} (${largestApp.pages} pages, ${largestApp.features} features)`);
    return largestApp;
  }

  /**
   * Extract relevant context from knowledge graph (SMART FILTERING)
   */
  function extractRelevantContext(kgData, ticketData) {
    console.log('[EXTRACT] Starting smart context extraction...');
    console.log('[EXTRACT] kgData keys:', Object.keys(kgData));

    // Handle different response formats
    let knowledgeGraph;

    if (kgData.result && kgData.result.knowledgeGraph) {
      knowledgeGraph = kgData.result.knowledgeGraph;
      console.log('[EXTRACT] Using kgData.result.knowledgeGraph');
    } else if (kgData.knowledgeGraph) {
      knowledgeGraph = kgData.knowledgeGraph;
      console.log('[EXTRACT] Using kgData.knowledgeGraph');
    } else if (kgData.result) {
      knowledgeGraph = kgData.result;
      console.log('[EXTRACT] Using kgData.result as knowledgeGraph');
    } else {
      console.error('[EXTRACT] ERROR: Cannot find knowledge graph in response!');
      console.log('[EXTRACT] Available keys:', Object.keys(kgData));
      return null;
    }

    console.log('[EXTRACT] knowledgeGraph keys:', Object.keys(knowledgeGraph));

    if (!knowledgeGraph.pages) {
      console.error('[EXTRACT] ERROR: knowledgeGraph.pages is missing!');
      console.log('[EXTRACT] knowledgeGraph structure:', knowledgeGraph);
      return null;
    }

    const totalPages = Object.keys(knowledgeGraph.pages).length;
    console.log('[EXTRACT] ✅ Found pages object with', totalPages, 'pages');

    // Extract keywords from ticket for smart filtering
    const keywords = extractTicketKeywords(ticketData);
    console.log('[EXTRACT] 🔍 Extracted keywords from ticket:', keywords.slice(0, 10));

    const context = {
      appUrl: knowledgeGraph.appUrl || kgData.appUrl,
      totalPages: knowledgeGraph.totalPages || 0,
      forms: [],
      apis: [],
      pages: [],
      features: []
    };

    // Score and filter pages by relevance
    const pages = Object.entries(knowledgeGraph.pages || {});
    const scoredPages = pages.map(([url, page]) => {
      const score = calculateRelevanceScore(
        url,
        page.metadata?.title,
        page.metadata?.description,
        keywords
      );
      return { url, page, score };
    });

    // Sort by relevance (highest score first)
    scoredPages.sort((a, b) => b.score - a.score);

    // Log relevance distribution
    const relevantPages = scoredPages.filter(p => p.score > 0);
    console.log(`[EXTRACT] 📊 Relevance Analysis:`);
    console.log(`   Total pages: ${totalPages}`);
    console.log(`   Relevant pages (score > 0): ${relevantPages.length}`);
    console.log(`   Irrelevant pages: ${totalPages - relevantPages.length}`);

    if (relevantPages.length > 0) {
      console.log(`[EXTRACT] 🎯 Top 5 most relevant pages:`);
      relevantPages.slice(0, 5).forEach((p, i) => {
        console.log(`   ${i + 1}. ${p.url} (score: ${p.score})`);
      });
    }

    // Prioritize: Process relevant pages first, then fill with others if needed
    const pagesToProcess = [
      ...relevantPages,
      ...scoredPages.filter(p => p.score === 0)
    ];

    for (const { url, page, score } of pagesToProcess) {
      // Collect forms (with relevance score)
      if (page.features) {
        const forms = page.features.filter(f => f.type === 'form');
        forms.forEach(form => {
          context.forms.push({
            url: url,
            id: form.id,
            action: form.action,
            method: form.method || 'POST',
            inputs: form.inputs || [],
            _relevanceScore: score // Track relevance
          });
        });

        // Collect other features
        const otherFeatures = page.features.filter(f => f.type !== 'form');
        otherFeatures.forEach(feature => {
          context.features.push({
            url: url,
            type: feature.type,
            ...feature,
            _relevanceScore: score // Track relevance
          });
        });
      }

      // Collect APIs (with relevance score)
      if (page.apis && page.apis.length > 0) {
        page.apis.forEach(api => {
          context.apis.push({
            url: url,
            method: api.method,
            endpoint: api.endpoint,
            payload: api.payload,
            _relevanceScore: score // Track relevance
          });
        });
      }

      // Collect page metadata
      if (page.metadata) {
        context.pages.push({
          url: url,
          title: page.metadata.title,
          description: page.metadata.description,
          _relevanceScore: score // Track relevance
        });
      }
    }

    // Sort all collected data by relevance score (highest first)
    context.forms.sort((a, b) => b._relevanceScore - a._relevanceScore);
    context.apis.sort((a, b) => b._relevanceScore - a._relevanceScore);
    context.features.sort((a, b) => b._relevanceScore - a._relevanceScore);
    context.pages.sort((a, b) => b._relevanceScore - a._relevanceScore);

    console.log('[EXTRACT] ✅ Context extraction complete:');
    console.log(`   Forms: ${context.forms.length} (top score: ${context.forms[0]?._relevanceScore || 0})`);
    console.log(`   APIs: ${context.apis.length} (top score: ${context.apis[0]?._relevanceScore || 0})`);
    console.log(`   Features: ${context.features.length} (top score: ${context.features[0]?._relevanceScore || 0})`);
    console.log(`   Pages: ${context.pages.length} (top score: ${context.pages[0]?._relevanceScore || 0})`);

    return context;
  }

  /**
   * Format app context for LLM prompt (with relevance indicators)
   */
  function formatAppContextForPrompt(appContext) {
    if (!appContext) {
      return '';
    }

    let formatted = '\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    formatted += '📱 APPLICATION CONTEXT (From Crawled Knowledge Graph)\n';
    formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    formatted += `🌐 Application: ${appContext.appUrl}\n`;
    formatted += `📄 Total Pages Crawled: ${appContext.totalPages}\n`;

    // Add relevance summary
    const relevantForms = appContext.forms?.filter(f => f._relevanceScore > 0).length || 0;
    const relevantAPIs = appContext.apis?.filter(a => a._relevanceScore > 0).length || 0;
    if (relevantForms + relevantAPIs > 0) {
      formatted += `\n🎯 SMART FILTERING: Showing most relevant data first based on ticket keywords\n`;
      formatted += `   Relevant Forms: ${relevantForms}/${appContext.forms?.length || 0}\n`;
      formatted += `   Relevant APIs: ${relevantAPIs}/${appContext.apis?.length || 0}\n`;
    }
    formatted += '\n';

    // Add forms (with relevance indicators)
    if (appContext.forms && appContext.forms.length > 0) {
      formatted += '📝 FORMS FOUND (sorted by relevance):\n';
      appContext.forms.slice(0, 5).forEach((form, index) => {
        const relevanceIndicator = form._relevanceScore > 0 ? '⭐ ' : '';
        formatted += `\n${index + 1}. ${relevanceIndicator}Form on ${form.url}\n`;
        formatted += `   • ID: ${form.id || 'N/A'}\n`;
        formatted += `   • Action: ${form.action || 'N/A'}\n`;
        formatted += `   • Method: ${form.method}\n`;
        if (form.inputs && form.inputs.length > 0) {
          formatted += `   • Fields:\n`;
          form.inputs.slice(0, 10).forEach(input => {
            const required = input.required ? ' (required)' : '';
            formatted += `     - ${input.name || input.id}: ${input.type}${required}\n`;
          });
        }
      });
      if (appContext.forms.length > 5) {
        formatted += `\n   ... and ${appContext.forms.length - 5} more forms\n`;
      }
      formatted += '\n';
    }

    // Add APIs (with relevance indicators)
    if (appContext.apis && appContext.apis.length > 0) {
      formatted += '🔌 API ENDPOINTS DETECTED (sorted by relevance):\n';
      appContext.apis.slice(0, 10).forEach((api, index) => {
        const relevanceIndicator = api._relevanceScore > 0 ? '⭐ ' : '';
        formatted += `\n${index + 1}. ${relevanceIndicator}${api.method} ${api.endpoint}\n`;
        formatted += `   • Page: ${api.url}\n`;
        if (api.payload) {
          formatted += `   • Payload: ${JSON.stringify(api.payload)}\n`;
        }
      });
      if (appContext.apis.length > 10) {
        formatted += `\n   ... and ${appContext.apis.length - 10} more API endpoints\n`;
      }
      formatted += '\n';
    }

    // Add buttons and other features
    if (appContext.features && appContext.features.length > 0) {
      const buttons = appContext.features.filter(f => f.type === 'button');
      if (buttons.length > 0) {
        formatted += '🔘 BUTTONS FOUND:\n';
        buttons.slice(0, 10).forEach((btn, index) => {
          formatted += `   ${index + 1}. "${btn.text || btn.id}" on ${btn.url}\n`;
        });
        if (buttons.length > 10) {
          formatted += `   ... and ${buttons.length - 10} more buttons\n`;
        }
        formatted += '\n';
      }
    }

    // Add page titles
    if (appContext.pages && appContext.pages.length > 0) {
      formatted += '📄 KEY PAGES:\n';
      appContext.pages.slice(0, 5).forEach((page, index) => {
        formatted += `   ${index + 1}. ${page.title || 'Untitled'}\n`;
        formatted += `      URL: ${page.url}\n`;
        if (page.description) {
          formatted += `      ${page.description.substring(0, 100)}...\n`;
        }
      });
      if (appContext.pages.length > 5) {
        formatted += `   ... and ${appContext.pages.length - 5} more pages\n`;
      }
    }

    formatted += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
    formatted += '💡 Use the above ACTUAL implementation details when generating test cases.\n';
    formatted += 'Include real field names, API endpoints, and button labels in your tests.\n';
    formatted += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

    return formatted;
  }

  // Validate settings before operations
  function validateSettingsUI(settings) {
    const errors = [];

    // Check API credentials based on provider
    if (settings.llmProvider === 'bedrock') {
      // For AWS Bedrock, check for Access Key ID and Secret Key
      if (!settings.bedrockAccessKeyId || settings.bedrockAccessKeyId.trim() === '') {
        errors.push('⚠️ AWS Access Key ID is missing');
      }
      if (!settings.bedrockSecretKey || settings.bedrockSecretKey.trim() === '') {
        errors.push('⚠️ AWS Secret Access Key is missing');
      }
      if (!settings.bedrockRegion || settings.bedrockRegion.trim() === '') {
        errors.push('⚠️ AWS Region is missing');
      }
    } else {
      // For other providers (OpenAI, Claude, Gemini), check for API key
      if (!settings.apiKey || settings.apiKey.trim() === '') {
        errors.push('⚠️ API Key is missing');
      }
    }

    if (!settings.llmProvider) {
      errors.push('⚠️ LLM Provider not selected');
    }

    if (!settings.llmModel) {
      errors.push('⚠️ LLM Model not selected');
    }

    return errors;
  }

  function getPriorityColor(priority) {
    const colors = {
      'P0': '#d32f2f',
      'P1': '#f57c00',
      'P2': '#fbc02d',
      'P3': '#1976d2'
    };
    return colors[priority] || '#666';
  }

  function getCategoryColor(category) {
    const colors = {
      'Positive': '#388e3c',
      'Negative': '#d32f2f',
      'Edge': '#f57c00',
      'Regression': '#7b1fa2',
      'Integration': '#1976d2'
    };
    return colors[category] || '#666';
  }

  function formatAnalysisForJiraComment(analysis) {
    const header = `h2. 📊 QAtalyst Requirements Analysis
_Generated on ${new Date().toLocaleString()}_

----

`;

    // Convert markdown-style formatting to Jira wiki markup
    let jiraFormatted = analysis
      .replace(/^### (.*$)/gm, 'h3. $1') // h3 headers
      .replace(/^## (.*$)/gm, 'h2. $1')  // h2 headers
      .replace(/^# (.*$)/gm, 'h1. $1')   // h1 headers
      .replace(/\*\*(.*?)\*\*/g, '*$1*') // bold
      .replace(/^\* /gm, '* ')           // bullet lists
      .replace(/^- /gm, '* ');           // convert - to *

    return header + jiraFormatted;
  }

  function formatTestScopeForJiraComment(testScope) {
    const header = `h2. 📋 QAtalyst Test Scope Document
_Generated on ${new Date().toLocaleString()}_

----

`;

    // Convert markdown-style formatting to Jira wiki markup
    let jiraFormatted = testScope
      .replace(/^### (.*$)/gm, 'h3. $1') // h3 headers
      .replace(/^## (.*$)/gm, 'h2. $1')  // h2 headers
      .replace(/^# (.*$)/gm, 'h1. $1')   // h1 headers
      .replace(/\*\*(.*?)\*\*/g, '*$1*') // bold
      .replace(/^\* /gm, '* ')           // bullet lists
      .replace(/^- /gm, '* ');           // convert - to *

    return header + jiraFormatted;
  }

  function formatTestCasesForJiraComment(testCases) {
    const header = `h2. 🤖 QAtalyst Generated Test Cases (${testCases.length} tests)
_Generated on ${new Date().toLocaleString()}_

----

`;

    const testCaseBlocks = testCases.map((tc, idx) => {
      const expectedResult = tc.expected_result || tc.expectedResult || 'Not specified';
      const steps = tc.steps || [];
      const preconditions = tc.preconditions || tc.precondition || 'None';
      const testData = tc.testData || tc.test_data || 'Not specified';

      const stepsFormatted = steps.length > 0
        ? steps.map((step, i) => `# ${step}`).join('\n')
        : 'Not specified';

      return `h3. ${tc.id}: ${tc.title}
*Priority:* {color:${getPriorityColor(tc.priority)}}${tc.priority}{color} | *Category:* {color:${getCategoryColor(tc.category)}}${tc.category}{color}

*Preconditions:*
${preconditions}

*Test Steps:*
${stepsFormatted}

*Expected Result:*
${expectedResult}

*Test Data:*
${testData}

----
`;
    }).join('\n');

    return header + testCaseBlocks;
  }

  function formatTestCasesForClipboard(testCases) {
    return testCases.map(tc => {
      const expectedResult = tc.expected_result || tc.expectedResult || 'Not specified';
      return `**${tc.id}: ${tc.title}**
Priority: ${tc.priority} | Type: ${tc.category}
Expected Result: ${expectedResult}`;
    }).join('\n---\n');
  }

  const api = {
    extractTextFromADF,
    extractFileType,
    determinePageType,
    extractTicketKeywords,
    calculateRelevanceScore,
    findMatchingApp,
    extractRelevantContext,
    formatAppContextForPrompt,
    validateSettingsUI,
    getPriorityColor,
    getCategoryColor,
    formatAnalysisForJiraComment,
    formatTestScopeForJiraComment,
    formatTestCasesForJiraComment,
    formatTestCasesForClipboard,
  };

  // Expose on the page/global scope so content.js (loaded AFTER this file) can
  // call these exactly as it did when they were defined inline.
  if (typeof self !== 'undefined') Object.assign(self, api);
  else if (typeof window !== 'undefined') Object.assign(window, api);
  else if (typeof globalThis !== 'undefined') Object.assign(globalThis, api);

  // CommonJS export for unit tests.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
