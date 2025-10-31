// External Integrations System for QAtalyst
// Fetch requirements from Confluence, Figma, and Google Docs

// Note: Retry helper and cache manager are currently disabled for Chrome extension compatibility
// They can be enabled later with proper module loading
const retryHelper = null;
const cacheManager = null;

class IntegrationManager {
  constructor(settings) {
    this.settings = settings;
    this.confluence = new ConfluenceIntegration(settings);
    this.figma = new FigmaIntegration(settings);
    this.googleDocs = new GoogleDocsIntegration(settings);
  }

  /**
   * Fetch multiple Confluence pages in parallel with concurrency control
   */
  async fetchConfluencePages(urls) {
    const results = [];
    const concurrencyLimit = 3; // Max 3 concurrent requests

    // Process URLs in batches
    for (let i = 0; i < urls.length; i += concurrencyLimit) {
      const batch = urls.slice(i, i + concurrencyLimit);
      const batchPromises = batch.map(async (url) => {
        try {
          const content = await this.confluence.fetchPage(url);
          if (content && !content.content.startsWith('Error:')) {
            console.log(`IntegrationManager: Fetched Confluence content for ${url}`);
            return content;
          } else {
            console.warn(`IntegrationManager: Skipped Confluence page (fetch failed or empty): ${url}`);
            return null;
          }
        } catch (error) {
          console.error('IntegrationManager: Confluence fetch failed for', url, ':', error.message);
          return {
            url: url,
            title: 'Confluence page (unavailable)',
            content: `Could not fetch Confluence content. Reason: ${error.message}`,
            version: 0
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults.filter(r => r !== null));
    }

    return results;
  }

  /**
   * Fetch multiple Figma files with rate limiting
   */
  async fetchFigmaFiles(urls) {
    const results = [];

    for (let i = 0; i < urls.length; i++) {
      try {
        // Add delay between requests to respect rate limits
        if (i > 0) {
          await new Promise(resolve =>
            setTimeout(resolve, typeof CONFIG !== 'undefined' ? CONFIG.FIGMA_RATE_LIMIT_DELAY : 1000)
          );
        }

        const fileKey = this.figma.extractFileKey(urls[i]);
        const content = await this.figma.fetchFile(urls[i]);

        if (content && !content.specifications.startsWith('Error:')) {
          // Fetch images for identified nodes
          let images = [];
          if (fileKey && content.nodesForImageExport && content.nodesForImageExport.length > 0) {
            images = await this.figma.fetchNodeImages(fileKey, content.nodesForImageExport);
            console.log(`IntegrationManager: Fetched ${images.length} images for Figma file ${urls[i]}`);
          }

          results.push({ ...content, images });
          console.log(`IntegrationManager: Fetched Figma content for ${urls[i]}`);
        } else {
          console.warn(`IntegrationManager: Skipped Figma file (fetch failed or empty): ${urls[i]}`);
        }
      } catch (error) {
        console.error('IntegrationManager: Figma fetch failed for', urls[i], ':', error.message);
        results.push({
          url: urls[i],
          name: 'Figma design (unavailable)',
          specifications: `Could not fetch Figma content. Reason: ${error.message}`,
          lastModified: null,
          version: null,
          images: []
        });
      }
    }

    return results;
  }

  /**
   * Fetch multiple Google Docs in parallel with concurrency control
   */
  async fetchGoogleDocs(urls) {
    const results = [];
    const concurrencyLimit = 3; // Max 3 concurrent requests

    // Process URLs in batches
    for (let i = 0; i < urls.length; i += concurrencyLimit) {
      const batch = urls.slice(i, i + concurrencyLimit);
      const batchPromises = batch.map(async (url) => {
        try {
          const content = await this.googleDocs.fetchDocument(url);
          if (content && !content.content.startsWith('Error:')) {
            console.log(`IntegrationManager: Fetched Google Docs content for ${url}`);
            return content;
          } else {
            console.warn(`IntegrationManager: Skipped Google Doc (fetch failed or empty): ${url}`);
            return null;
          }
        } catch (error) {
          console.error('IntegrationManager: Google Docs fetch failed for', url, ':', error.message);
          return {
            url: url,
            title: 'Google Doc (unavailable)',
            content: `Could not fetch Google Docs content. Reason: ${error.message}`,
            revisionId: null
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults.filter(r => r !== null));
    }

    return results;
  }

  async fetchAllLinkedContent(ticketData) {
    console.log('IntegrationManager: Starting fetchAllLinkedContent');
    console.log('IntegrationManager: Settings', this.settings);

    const results = {
      confluence: [],
      figma: [],
      googleDocs: [],
      enrichedDescription: ticketData.description || ''
    };

    // Extract URLs from ticket description and comments
    const allText = [
      ticketData.description || '',
      ...(ticketData.comments || []).map(c => c.text || '') // Use c.text for comment content
    ].join('\n');
    console.log('IntegrationManager: All text for URL extraction:', allText);

    // Extract all URLs
    const confluenceUrls = this.confluence.extractUrls(allText);
    const figmaUrls = this.figma.extractUrls(allText);
    const googleDocsUrls = this.googleDocs.extractUrls(allText);

    console.log('IntegrationManager: Extracted URLs:', {
      confluence: confluenceUrls,
      figma: figmaUrls,
      googleDocs: googleDocsUrls
    });

    // Fetch from all integrations in parallel
    const fetchTasks = [];

    if (confluenceUrls.length > 0) {
      fetchTasks.push(this.fetchConfluencePages(confluenceUrls));
    }
    if (figmaUrls.length > 0) {
      fetchTasks.push(this.fetchFigmaFiles(figmaUrls));
    }
    if (googleDocsUrls.length > 0) {
      fetchTasks.push(this.fetchGoogleDocs(googleDocsUrls));
    }

    // Wait for all integrations to complete (use allSettled to not fail on errors)
    const fetchResults = await Promise.allSettled(fetchTasks);

    // Process results
    let taskIndex = 0;
    if (confluenceUrls.length > 0) {
      if (fetchResults[taskIndex].status === 'fulfilled') {
        results.confluence = fetchResults[taskIndex].value;
      }
      taskIndex++;
    }
    if (figmaUrls.length > 0) {
      if (fetchResults[taskIndex].status === 'fulfilled') {
        results.figma = fetchResults[taskIndex].value;
      }
      taskIndex++;
    }
    if (googleDocsUrls.length > 0) {
      if (fetchResults[taskIndex].status === 'fulfilled') {
        results.googleDocs = fetchResults[taskIndex].value;
      }
      taskIndex++;
    }
    
    // Enrich description with external content
    if (results.confluence.length > 0) {
      results.enrichedDescription += '\n\n## Confluence Requirements:\n' +
        results.confluence.map(c => c.content).join('\n\n');
    }
    
    if (results.figma.length > 0) {
      results.enrichedDescription += '\n\n## Figma Design Specifications:\n' +
        results.figma.map(f => f.specifications).join('\n\n');
    }
    
    if (results.googleDocs.length > 0) {
      results.enrichedDescription += '\n\n## Google Docs Content:\n' +
        results.googleDocs.map(d => d.content).join('\n\n');
    }

    console.log('IntegrationManager: Final external sources results:', results);
    
    return results;
  }
}

// Confluence Integration
class ConfluenceIntegration {
  constructor(settings) {
    this.baseUrl = settings.confluenceUrl;
    this.email = settings.confluenceEmail;
    this.token = settings.confluenceToken;
  }
  
  extractUrls(text) {
    // Multiple patterns to support Cloud, Server, and Data Center
    const patterns = [
      // Cloud format: https://company.atlassian.net/wiki/spaces/...
      /https:\/\/[A-Za-z0-9.-]+\.atlassian\.net\/wiki\/spaces\/[~A-Za-z0-9]+\/pages\/\d+\/[A-Za-z0-9+%-]+/gi,

      // Server/Data Center format: https://confluence.company.com/display/...
      /https:\/\/[A-Za-z0-9.-]+\/confluence\/display\/[A-Za-z0-9]+\/[^\/\s<>"']+/gi,

      // Server/Data Center format: https://confluence.company.com/pages/viewpage.action?pageId=...
      /https:\/\/[A-Za-z0-9.-]+\/confluence\/pages\/viewpage\.action\?pageId=\d+/gi,

      // Direct server format: https://wiki.company.com/display/...
      /https:\/\/wiki\.[A-Za-z0-9.-]+\/display\/[A-Za-z0-9]+\/[^\/\s<>"']+/gi,

      // Short links: https://company.atlassian.net/wiki/x/...
      /https:\/\/[A-Za-z0-9.-]+\.atlassian\.net\/wiki\/x\/[A-Za-z0-9_-]+/gi
    ];

    let allMatches = [];
    patterns.forEach(pattern => {
      const matches = text.match(pattern) || [];
      allMatches = allMatches.concat(matches);
    });

    // Clean up any trailing punctuation or HTML entities
    const cleanedUrls = allMatches.map(url => url.replace(/[<>"'\s]+$/, ''));
    return [...new Set(cleanedUrls)]; // Remove duplicates
  }
  
  async fetchPage(url) {
    if (!this.baseUrl || !this.email || !this.token) {
      throw new Error('Confluence integration is not configured. Please add Confluence URL, email, and API token in extension settings.');
    }

    try {
      // Extract page ID from URL
      const pageId = this.extractPageId(url);
      if (!pageId) {
        throw new Error('Invalid Confluence URL format. Could not extract page ID.');
      }

      // Check cache first
      if (cacheManager) {
        const cacheKey = cacheManager.constructor.getCacheKey('confluence', pageId);
        const cached = cacheManager.get(cacheKey);
        if (cached) {
          console.log(`Using cached Confluence page: ${pageId}`);
          return cached;
        }
      }

      // Fetch page content with retry logic
      const fetchPageWithRetry = async () => {
        const apiUrl = `${this.baseUrl}/rest/api/content/${pageId}?expand=body.storage,version`;

        const response = await fetch(apiUrl, {
          headers: {
            'Authorization': 'Basic ' + btoa(`${this.email}:${this.token}`),
            'Accept': 'application/json'
          }
        });

        if (!response.ok) {
          if (response.status === 401) {
            throw new Error('Confluence authentication failed. Please check your API token.');
          } else if (response.status === 403) {
            throw new Error('Access denied. You do not have permission to view this Confluence page.');
          } else if (response.status === 404) {
            throw new Error('Confluence page not found. It may have been deleted or moved.');
          } else if (response.status === 429) {
            // Rate limited - this is retryable
            const retryAfter = response.headers.get('Retry-After') || '60';
            const error = new Error(`Rate limited. Retry after ${retryAfter} seconds.`);
            error.response = { status: 429 };
            throw error;
          } else {
            throw new Error(`Confluence API returned error ${response.status}.`);
          }
        }

        const data = await response.json();

        return {
          url: url,
          title: data.title,
          content: this.parseHtml(data.body.storage.value),
          version: data.version.number
        };
      };

      // Use retry helper if available, otherwise just execute once
      let result;
      if (retryHelper) {
        result = await retryHelper.forService('confluence', 'fetchPage', fetchPageWithRetry, {
          maxRetries: 3,
          baseDelay: 1000
        });
      } else {
        result = await fetchPageWithRetry();
      }

      // Cache the result
      if (cacheManager && result) {
        const cacheKey = cacheManager.constructor.getCacheKey('confluence', pageId);
        cacheManager.set(cacheKey, result);
        console.log(`Cached Confluence page: ${pageId}`);
      }

      return result;
    } catch (error) {
      console.error('Confluence fetch error:', error);
      throw error; // Re-throw to be handled by IntegrationManager
    }
  }
  
  extractPageId(url) {
    // Try to extract page ID from various Confluence URL formats
    const patterns = [
      /\/pages\/(\d+)\//,                        // /pages/123456/
      /pageId=(\d+)/,                            // ?pageId=123456
      /\/(\d+)$/,                                // ending with /123456
      /\/wiki\/spaces\/[^\/]+\/pages\/(\d+)/,   // Cloud URL: /wiki/spaces/PROJ/pages/123456
      /\/display\/[^\/]+\/(\d+)/,                // Display format: /display/SPACE/123456
      /\/pages\/viewpage\.action\?pageId=(\d+)/, // View page action: ?pageId=123456
      /\/confluence\/pages\/(\d+)/,              // Server: /confluence/pages/123456
      /\/wiki\/display\/[^\/]+\/(\d+)/          // Wiki server: /wiki/display/SPACE/123456
    ];

    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }

    // Check for short link format /x/shortId
    const shortLinkMatch = url.match(/\/x\/([A-Za-z0-9_-]+)/);
    if (shortLinkMatch && shortLinkMatch[1]) {
      // For short links, we would need to resolve them via API
      // For now, log a warning
      console.warn('Short link detected, resolution not yet implemented:', url);
      return null;
    }

    return null;
  }
  
  parseHtml(html) {
    // Sanitize HTML first to remove any malicious content
    const sanitizedHtml = securityManager.sanitizeHTML(html);

    // Simple HTML to text conversion
    // Remove HTML tags and get clean text
    let text = sanitizedHtml
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<li>/gi, '- ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .trim();
    
    if (text.length > CONFIG.MAX_TEXT_EXTRACT_LENGTH) {
      console.warn(`Confluence content truncated from ${text.length} to ${CONFIG.MAX_TEXT_EXTRACT_LENGTH} characters.`);
      text = text.substring(0, CONFIG.MAX_TEXT_EXTRACT_LENGTH) + '... [Content truncated]';
    }

    return text;
  }
}

// Figma Integration
// Rate Limits: https://developers.figma.com/docs/rest-api/rate-limits/
// - Personal Access Token: 1,000 requests per minute (shared across all files)
// - OAuth: 2,000 requests per minute per app
// Handles 429 responses with Retry-After header
class FigmaIntegration {
  constructor(settings) {
    this.token = settings.figmaToken;
  }
  
  extractUrls(text) {
    // Match Figma URLs - support file and design with query parameters
    const pattern = /https:\/\/(?:www\.)?figma\.com\/(?:file|design)\/[A-Za-z0-9]+(?:\/[A-Za-z0-9-._~!$&'()*+,;=:@%]*)*/gi;
    const matches = text.match(pattern) || [];
    // Clean up any trailing punctuation or HTML entities
    return [...new Set(matches.map(url => url.replace(/[<>"'\s]+$/, '')))];
  }
  
  async fetchFile(url, retries = 3) {
    if (!this.token) {
      throw new Error('Figma integration is not configured. Please add your Figma Personal Access Token in extension settings.');
    }

    try {
      const fileKey = this.extractFileKey(url);
      if (!fileKey) {
        throw new Error('Invalid Figma URL format. Could not extract file key.');
      }

      // Fetch file metadata
      const apiUrl = `https://api.figma.com/v1/files/${fileKey}`;

      const response = await fetch(apiUrl, {
        headers: {
          'X-Figma-Token': this.token
        }
      });

      // Handle rate limiting (429 Too Many Requests)
      if (response.status === 429) {
        if (retries > 0) {
          // Check for Retry-After header (in seconds)
          const retryAfter = response.headers.get('Retry-After');
          const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 2000; // Default 2s

          console.warn(`Figma rate limit hit, retrying after ${waitTime}ms...`);

          // Wait and retry with exponential backoff
          await new Promise(resolve => setTimeout(resolve, waitTime));
          return await this.fetchFile(url, retries - 1);
        } else {
          throw new Error('Figma API rate limit exceeded (1000 requests/minute). Please wait a moment and try again.');
        }
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error('Figma authentication failed. Please check your Personal Access Token.');
        } else if (response.status === 404) {
          throw new Error('Figma file not found. Please check the URL and your access permissions.');
        } else {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.message || `Figma API returned error ${response.status}.`);
        }
      }

      const data = await response.json();

      // Check for API error in response
      if (data.status && data.status >= 400) {
        throw new Error(data.err || `Figma API returned error status ${data.status}`);
      }

      // Extract specifications
      const specifications = this.extractSpecifications(data);

      // Identify nodes for image export (e.g., top-level frames, components)
      const nodesForImageExport = [];
      if (data.document && data.document.children) {
        for (const page of data.document.children) {
          if (page.type === 'CANVAS' && page.children) {
            for (const child of page.children) {
              // Prioritize top-level frames and components
              if (child.type === 'FRAME' || child.type === 'COMPONENT') {
                nodesForImageExport.push(child.id);
                if (nodesForImageExport.length >= CONFIG.MAX_FIGMA_IMAGES) break; // Limit to MAX_FIGMA_IMAGES
              }
            }
          }
          if (nodesForImageExport.length >= CONFIG.MAX_FIGMA_IMAGES) break;
        }
      }

      return {
        url: url,
        name: data.name,
        specifications: specifications,
        lastModified: data.lastModified,
        version: data.version,
        nodesForImageExport: nodesForImageExport // Store identified nodes
      };
    } catch (error) {
      console.error('Figma fetch error:', error);
      throw error; // Re-throw to be handled by IntegrationManager
    }
  }
  
  extractFileKey(url) {
    const match = url.match(/figma\.com\/(file|proto)\/([^\/]+)/);
    return match ? match[2] : null;
  }
  
  extractSpecifications(figmaData) {
    let specs = [];
    
    // Extract basic information
    specs.push(`# ${figmaData.name}`);
    
    // Extract pages and frames
    if (figmaData.document && figmaData.document.children) {
      figmaData.document.children.forEach(page => {
        specs.push(`\n## Page: ${page.name}`);
        
        if (page.children) {
          page.children.forEach(frame => {
            specs.push(`\n### Frame: ${frame.name}`);
            specs.push(`- Type: ${frame.type}`);
            
            if (frame.absoluteBoundingBox) {
              specs.push(`- Size: ${Math.round(frame.absoluteBoundingBox.width)}x${Math.round(frame.absoluteBoundingBox.height)}`);
            }
            
            // Extract components
            if (frame.children && frame.children.length > 0) {
              specs.push(`- Components: ${frame.children.length}`);
              
              // List component types
              const componentTypes = {};
              frame.children.forEach(child => {
                componentTypes[child.type] = (componentTypes[child.type] || 0) + 1;
              });
              
              Object.entries(componentTypes).forEach(([type, count]) => {
                specs.push(`  - ${type}: ${count}`);
              });
            }
          });
        }
      });
    }
    
    let finalSpecs = specs.join('\n');
    if (finalSpecs.length > CONFIG.MAX_TEXT_EXTRACT_LENGTH) {
      console.warn(`Figma specifications truncated from ${finalSpecs.length} to ${CONFIG.MAX_TEXT_EXTRACT_LENGTH} characters.`);
      finalSpecs = finalSpecs.substring(0, CONFIG.MAX_TEXT_EXTRACT_LENGTH) + '... [Content truncated]';
    }
    
    return finalSpecs;
  }

  async fetchNodeImages(fileKey, nodeIds) {
    if (!this.token || !fileKey || nodeIds.length === 0) {
      return [];
    }

    try {
      const imageUrlsApi = `https://api.figma.com/v1/images/${fileKey}?ids=${nodeIds.join(',')}&format=png&scale=1`;
      const response = await fetch(imageUrlsApi, {
        headers: { 'X-Figma-Token': this.token }
      });

      if (!response.ok) {
        console.error('Figma image URL fetch failed:', response.status, await response.text());
        return [];
      }

      const data = await response.json();
      const images = [];
      const minSizeInBytes = CONFIG.MIN_FIGMA_IMAGE_SIZE_KB * 1024;

      for (const nodeId of nodeIds) {
        if (images.length >= CONFIG.MAX_FIGMA_IMAGES) {
          console.warn(`Figma image extraction limit (${CONFIG.MAX_FIGMA_IMAGES}) reached. Skipping further images.`);
          break;
        }

        const imageUrl = data.images[nodeId];
        if (imageUrl) {
          try {
            const imageResponse = await fetch(imageUrl);
            if (imageResponse.ok) {
              const blob = await imageResponse.blob();
              if (blob.size < minSizeInBytes) {
                console.warn(`Skipping Figma image ${nodeId} (size ${Math.round(blob.size / 1024)}KB) as it's smaller than ${CONFIG.MIN_FIGMA_IMAGE_SIZE_KB}KB.`);
                continue;
              }
              const base64 = await new Promise(resolve => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.readAsDataURL(blob);
              });
              images.push(base64);
            } else {
              console.warn(`Failed to fetch image from ${imageUrl}: ${imageResponse.status}`);
            }
          } catch (imgError) {
            console.error(`Error fetching or converting image ${imageUrl}:`, imgError);
          }
        }
      }
      return images;
    } catch (error) {
      console.error('Error in fetchNodeImages:', error);
      return [];
    }
  }
}

// Google Docs Integration
class GoogleDocsIntegration {
  constructor(settings) {
    this.apiKey = settings.googleApiKey;
  }
  
  extractUrls(text) {
    // Match Google Docs URLs with optional /edit suffix and query parameters
    const pattern = /https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+(?:\/edit)?(?:\?[A-Za-z0-9=&_-]+)?/gi;
    const matches = text.match(pattern) || [];
    return [...new Set(matches)];
  }
  
  async fetchDocument(url) {
    if (!this.apiKey) {
      throw new Error('Google Docs integration is not configured. Please add your Google API Key in extension settings.');
    }

    try {
      const docId = this.extractDocId(url);
      if (!docId) {
        throw new Error('Invalid Google Docs URL format. Could not extract document ID.');
      }

      // Fetch document content - API key should be in URL as query parameter
      const apiUrl = `https://docs.googleapis.com/v1/documents/${docId}?key=${this.apiKey}`;

      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error('Google Docs authentication failed. Please check your API key or document sharing permissions.');
        } else if (response.status === 404) {
          throw new Error('Google Doc not found. The document may have been deleted or you may not have access.');
        } else {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error?.message || `Google Docs API returned error ${response.status}.`);
        }
      }

      const data = await response.json();

      // Extract text content
      const content = this.extractContent(data);

      return {
        url: url,
        title: data.title,
        content: content,
        revisionId: data.revisionId
      };
    } catch (error) {
      console.error('Google Docs fetch error:', error);
      throw error; // Re-throw to be handled by IntegrationManager
    }
  }
  
  extractDocId(url) {
    const match = url.match(/\/document\/d\/([^\/]+)/);
    return match ? match[1] : null;
  }
  
  extractContent(docData) {
    let content = [];
    
    if (!docData.body || !docData.body.content) {
      return 'No content available';
    }
    
    // Extract text from document structure
    docData.body.content.forEach(element => {
      if (element.paragraph) {
        const paragraphText = [];
        
        if (element.paragraph.elements) {
          element.paragraph.elements.forEach(elem => {
            if (elem.textRun && elem.textRun.content) {
              paragraphText.push(elem.textRun.content);
            }
          });
        }
        
        const text = paragraphText.join('').trim();
        if (text) {
          content.push(text);
        }
      } else if (element.table) {
        const table = element.table;
        const rows = [];

        // Extract table data
        if (table.tableRows) {
          for (const row of table.tableRows) {
            const cells = [];
            if (row.tableCells) {
              for (const cell of row.tableCells) {
                const cellText = [];
                if (cell.content) {
                  for (const block of cell.content) {
                    if (block.paragraph && block.paragraph.elements) {
                      for (const elem of block.paragraph.elements) {
                        if (elem.textRun && elem.textRun.content) {
                          cellText.push(elem.textRun.content);
                        }
                      }
                    }
                  }
                }
                cells.push(cellText.join('').trim());
              }
            }
            if (cells.length > 0) {
              rows.push(cells);
            }
          }
        }

        // Format as markdown table
        if (rows.length > 0) {
          content.push('\n');

          // Header row
          content.push('| ' + rows[0].join(' | ') + ' |');
          content.push('|' + rows[0].map(() => '---').join('|') + '|');

          // Data rows
          for (let i = 1; i < rows.length; i++) {
            content.push('| ' + rows[i].join(' | ') + ' |');
          }

          content.push('\n');
        }
      }
    });
    
    let finalContent = content.join('\n\n');
    if (finalContent.length > CONFIG.MAX_TEXT_EXTRACT_LENGTH) {
      console.warn(`Google Docs content truncated from ${finalContent.length} to ${CONFIG.MAX_TEXT_EXTRACT_LENGTH} characters.`);
      finalContent = finalContent.substring(0, CONFIG.MAX_TEXT_EXTRACT_LENGTH) + '... [Content truncated]';
    }

    return finalContent;
  }
}

// TestRail Integration
class TestRailIntegration {
  constructor(settings) {
    this.baseUrl = settings.testrailUrl;
    this.username = settings.testrailUsername;
    this.apiKey = settings.testrailApiKey;
    this.projectId = settings.testrailProjectId;
    this.sectionName = settings.testrailSection || 'QAtalyst_Automation';
  }

  /**
   * Get authentication headers for TestRail API
   */
  getAuthHeaders() {
    return {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + btoa(`${this.username}:${this.apiKey}`)
    };
  }

  /**
   * Test connection to TestRail
   */
  async testConnection() {
    if (!this.baseUrl || !this.username || !this.apiKey) {
      throw new Error('TestRail URL, username, and API key are required');
    }

    try {
      const response = await fetch(`${this.baseUrl}/index.php?/api/v2/get_statuses`, {
        headers: this.getAuthHeaders()
      });

      if (!response.ok) {
        throw new Error(`Connection test failed with status: ${response.status}`);
      }

      return { success: true };
    } catch (error) {
      throw new Error(`TestRail connection failed: ${error.message}`);
    }
  }

  /**
   * Get or create a test suite for the project
   */
  async getOrCreateSuite(suiteName = 'QAtalyst Generated Tests') {
    try {
      // Get existing suites
      const response = await fetch(
        `${this.baseUrl}/index.php?/api/v2/get_suites/${this.projectId}`,
        { headers: this.getAuthHeaders() }
      );

      if (!response.ok) {
        throw new Error(`Failed to get suites: ${response.status}`);
      }

      const suites = await response.json();

      // Find existing suite
      const existingSuite = suites.find(s => s.name === suiteName);
      if (existingSuite) {
        return existingSuite.id;
      }

      // Create new suite
      const createResponse = await fetch(
        `${this.baseUrl}/index.php?/api/v2/add_suite/${this.projectId}`,
        {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify({
            name: suiteName,
            description: 'Test cases generated by QAtalyst AI'
          })
        }
      );

      if (!createResponse.ok) {
        throw new Error(`Failed to create suite: ${createResponse.status}`);
      }

      const newSuite = await createResponse.json();
      return newSuite.id;
    } catch (error) {
      throw new Error(`Suite management failed: ${error.message}`);
    }
  }

  /**
   * Get or create a section within a suite
   */
  async getOrCreateSection(suiteId, sectionName) {
    try {
      // Get existing sections
      const response = await fetch(
        `${this.baseUrl}/index.php?/api/v2/get_sections/${this.projectId}&suite_id=${suiteId}`,
        { headers: this.getAuthHeaders() }
      );

      if (!response.ok) {
        throw new Error(`Failed to get sections: ${response.status}`);
      }

      const sections = await response.json();

      // Find existing section
      const existingSection = sections.find(s => s.name === sectionName);
      if (existingSection) {
        return existingSection.id;
      }

      // Create new section
      const createResponse = await fetch(
        `${this.baseUrl}/index.php?/api/v2/add_section/${this.projectId}`,
        {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify({
            suite_id: suiteId,
            name: sectionName,
            description: 'Test cases generated by QAtalyst AI'
          })
        }
      );

      if (!createResponse.ok) {
        throw new Error(`Failed to create section: ${createResponse.status}`);
      }

      const newSection = await createResponse.json();
      return newSection.id;
    } catch (error) {
      throw new Error(`Section management failed: ${error.message}`);
    }
  }

  /**
   * Upload a single test case to TestRail
   */
  async uploadTestCase(sectionId, testCase) {
    try {
      // Format steps for TestRail
      const steps = testCase.steps.map((step, index) => ({
        content: typeof step === 'string' ? step : step.action || step,
        expected: testCase.expected_result || ''
      }));

      // Create test case
      const response = await fetch(
        `${this.baseUrl}/index.php?/api/v2/add_case/${sectionId}`,
        {
          method: 'POST',
          headers: this.getAuthHeaders(),
          body: JSON.stringify({
            title: testCase.title || testCase.id,
            template_id: 1, // Test Case (Steps)
            type_id: this.getTestTypeId(testCase.category),
            priority_id: this.getPriorityId(testCase.priority),
            custom_steps_separated: steps,
            custom_preconds: testCase.preconditions || '',
            refs: testCase.jiraTicket || ''
          })
        }
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(`Failed to create test case: ${response.status} - ${errorData.error || 'Unknown error'}`);
      }

      return await response.json();
    } catch (error) {
      console.error(`Failed to upload test case "${testCase.title}":`, error);
      throw error;
    }
  }

  /**
   * Upload multiple test cases to TestRail
   */
  async uploadTestCases(testCases, jiraTicket = null, suiteName = null) {
    if (!this.baseUrl || !this.username || !this.apiKey || !this.projectId) {
      throw new Error('TestRail is not properly configured. Please check your settings.');
    }

    try {
      // Get or create suite
      const suiteId = await this.getOrCreateSuite(suiteName || `Jira Ticket: ${jiraTicket || 'Unknown'}`);

      // Get or create section
      const sectionId = await this.getOrCreateSection(suiteId, this.sectionName);

      // Upload test cases
      const results = {
        success: [],
        failed: [],
        total: testCases.length
      };

      for (const testCase of testCases) {
        try {
          const uploaded = await this.uploadTestCase(sectionId, { ...testCase, jiraTicket });
          results.success.push({
            id: uploaded.id,
            title: testCase.title,
            url: `${this.baseUrl}/index.php?/cases/view/${uploaded.id}`
          });
        } catch (error) {
          results.failed.push({
            title: testCase.title,
            error: error.message
          });
        }
      }

      return results;
    } catch (error) {
      throw new Error(`TestRail upload failed: ${error.message}`);
    }
  }

  /**
   * Map test case category to TestRail test type ID
   */
  getTestTypeId(category) {
    const typeMap = {
      'Positive': 1,      // Functional
      'Negative': 1,      // Functional
      'Edge': 7,          // Other
      'Integration': 2,   // Integration
      'Performance': 4,   // Performance
      'Security': 5,      // Security
      'Regression': 6     // Regression
    };
    return typeMap[category] || 1; // Default to Functional
  }

  /**
   * Map test case priority to TestRail priority ID
   */
  getPriorityId(priority) {
    const priorityMap = {
      'P0': 4, // Critical
      'P1': 3, // High
      'P2': 2, // Medium
      'P3': 1  // Low
    };
    return priorityMap[priority] || 2; // Default to Medium
  }
}

// Export for use in background.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { IntegrationManager, ConfluenceIntegration, FigmaIntegration, GoogleDocsIntegration, TestRailIntegration };
}
