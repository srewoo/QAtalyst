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
    console.log('🔗 [IntegrationManager] Starting fetchAllLinkedContent');
    console.log('🔗 [IntegrationManager] Settings configured:', {
      hasConfluence: !!(this.settings.confluenceUrl && this.settings.confluenceToken),
      hasFigma: !!this.settings.figmaToken,
      hasGoogleDocs: !!this.settings.googleApiKey
    });

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
    console.log('🔗 [IntegrationManager] Extracted text length:', allText.length);

    // Extract all URLs
    const confluenceUrls = this.confluence.extractUrls(allText);
    const figmaUrls = this.figma.extractUrls(allText);
    const googleDocsUrls = this.googleDocs.extractUrls(allText);

    console.log('🔗 [IntegrationManager] Extracted URLs:', {
      confluence: confluenceUrls.length,
      figma: figmaUrls.length,
      googleDocs: googleDocsUrls.length
    });

    if (confluenceUrls.length > 0) console.log('  📄 Confluence URLs:', confluenceUrls);
    if (figmaUrls.length > 0) console.log('  🎨 Figma URLs:', figmaUrls);
    if (googleDocsUrls.length > 0) console.log('  📝 Google Docs URLs:', googleDocsUrls);

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
    const errors = [];
    
    if (confluenceUrls.length > 0) {
      if (fetchResults[taskIndex].status === 'fulfilled') {
        results.confluence = fetchResults[taskIndex].value;
        console.log('✅ [IntegrationManager] Confluence fetch successful:', results.confluence.length, 'pages');
      } else {
        console.error('❌ [IntegrationManager] Confluence fetch failed:', fetchResults[taskIndex].reason);
        errors.push({ type: 'Confluence', error: fetchResults[taskIndex].reason?.message || 'Unknown error' });
      }
      taskIndex++;
    }
    if (figmaUrls.length > 0) {
      if (fetchResults[taskIndex].status === 'fulfilled') {
        results.figma = fetchResults[taskIndex].value;
        console.log('✅ [IntegrationManager] Figma fetch successful:', results.figma.length, 'files');
      } else {
        console.error('❌ [IntegrationManager] Figma fetch failed:', fetchResults[taskIndex].reason);
        errors.push({ type: 'Figma', error: fetchResults[taskIndex].reason?.message || 'Unknown error' });
      }
      taskIndex++;
    }
    if (googleDocsUrls.length > 0) {
      if (fetchResults[taskIndex].status === 'fulfilled') {
        results.googleDocs = fetchResults[taskIndex].value;
        console.log('✅ [IntegrationManager] Google Docs fetch successful:', results.googleDocs.length, 'documents');
      } else {
        console.error('❌ [IntegrationManager] Google Docs fetch failed:', fetchResults[taskIndex].reason);
        errors.push({ type: 'Google Docs', error: fetchResults[taskIndex].reason?.message || 'Unknown error' });
      }
      taskIndex++;
    }
    
    // Log any errors
    if (errors.length > 0) {
      console.warn('⚠️ [IntegrationManager] Some integrations failed:', errors);
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

    console.log('✅ [IntegrationManager] Final results:', {
      confluence: results.confluence.length,
      figma: results.figma.length,
      googleDocs: results.googleDocs.length,
      enrichedDescriptionLength: results.enrichedDescription.length,
      errors: errors.length
    });
    
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
      // Cloud format: https://company.atlassian.net/wiki/spaces/... (title is optional)
      /https:\/\/[A-Za-z0-9.-]+\.atlassian\.net\/wiki\/spaces\/[~A-Za-z0-9]+\/pages\/\d+(?:\/[A-Za-z0-9+%-]+)?/gi,

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

      console.log(`📄 Confluence - Extracted page ID: ${pageId} from URL: ${url}`);

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
        // Confluence Cloud uses /wiki/rest/api, Server/Data Center uses /rest/api
        const isCloud = this.baseUrl.includes('atlassian.net');
        const apiPath = isCloud ? '/wiki/rest/api/content' : '/rest/api/content';
        const apiUrl = `${this.baseUrl}${apiPath}/${pageId}?expand=body.storage,version`;
        console.log(`🌐 Confluence API request: ${apiUrl}`);

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
    // Service worker context - can't use DOM APIs for sanitization
    // Instead, use regex-based HTML stripping (safe since we're only extracting text)

    // Remove script and style tags with their content
    let text = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')

      // Convert common block elements to line breaks
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<\/h[1-6]>/gi, '\n')
      .replace(/<li>/gi, '- ')

      // Extract URLs from anchor tags before removing them
      .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi, '$2 ($1)')

      // Remove all remaining HTML tags
      .replace(/<[^>]+>/g, '')

      // Decode HTML entities
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")

      // Clean up whitespace
      .replace(/\n{3,}/g, '\n\n')  // Max 2 consecutive newlines
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
    this.imageMode = settings.figmaImageMode || 'single'; // 'single' or 'children'
  }
  
  extractUrls(text) {
    // Match Figma URLs - support file, design, and proto with query parameters
    // Include ? for query strings and capture node-id parameter
    const pattern = /https:\/\/(?:www\.)?figma\.com\/(?:file|design|proto)\/[A-Za-z0-9]+(?:\/[A-Za-z0-9-._~!$&'()*+,;=:@%?#]*)*/gi;
    const matches = text.match(pattern) || [];
    // Clean up any trailing punctuation or HTML entities
    return [...new Set(matches.map(url => url.replace(/[<>"'\s]+$/, '')))];
  }
  
  /**
   * Extract child nodes (frames/components) from a Figma node
   * @param {array} children - Array of child nodes from Figma API
   * @returns {array} - Array of {id, name, type} objects for frames and components
   */
  extractChildNodes(children) {
    const childNodes = [];
    const validTypes = ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE'];
    
    const traverse = (nodes) => {
      for (const node of nodes) {
        // Include frames and components
        if (validTypes.includes(node.type)) {
          childNodes.push({
            id: node.id,
            name: node.name,
            type: node.type
          });
        }
        
        // Recursively check children (but only go 2 levels deep to avoid too many images)
        if (node.children && childNodes.length < CONFIG.MAX_FIGMA_IMAGES) {
          traverse(node.children);
        }
      }
    };
    
    traverse(children);
    
    // Limit to MAX_FIGMA_IMAGES
    return childNodes.slice(0, CONFIG.MAX_FIGMA_IMAGES);
  }
  
  /**
   * Parse Figma URL to extract file key and node ID
   * @param {string} url - Full Figma URL
   * @returns {object} - {fileKey, nodeId}
   */
  parseFigmaURL(url) {
    const fileKeyMatch = url.match(/\/(?:file|design|proto)\/([a-zA-Z0-9]+)/) || url.match(/figma\.com\/(?:file|design|proto)\/([a-zA-Z0-9]+)/);
    const nodeIdMatch = url.match(/node-id=([\d:-]+)/);
    
    return {
      fileKey: fileKeyMatch ? fileKeyMatch[1] : null,
      nodeId: nodeIdMatch ? nodeIdMatch[1].replace(/-/g, ':') : null // Convert "1-41" → "1:41"
    };
  }
  
  async fetchFile(url, retries = 3) {
    if (!this.token) {
      throw new Error('Figma integration is not configured. Please add your Figma Personal Access Token in extension settings.');
    }

    try {
      const { fileKey, nodeId } = this.parseFigmaURL(url);
      
      if (!fileKey) {
        throw new Error('Invalid Figma URL format. Could not extract file key.');
      }

      console.log(`🎨 Figma - Extracted file key: ${fileKey}, node ID: ${nodeId || 'none'} from URL: ${url}`);

      let nodesForImageExport = [];
      let specifications = '';
      let fileName = 'Figma Design';

      // If URL has a specific node-id, use it directly for image export
      if (nodeId) {
        console.log(`🎯 Figma - Using specific node from URL: ${nodeId}`);
        
        // Fetch minimal metadata for this specific node
        const nodeApiUrl = `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${nodeId}`;
        console.log(`🌐 Figma API request (node metadata): ${nodeApiUrl}`);
        
        const nodeResponse = await fetch(nodeApiUrl, {
          headers: { 'X-Figma-Token': this.token }
        });

        if (nodeResponse.ok) {
          const nodeData = await nodeResponse.json();
          const nodeInfo = nodeData.nodes?.[nodeId];
          
          if (nodeInfo) {
            fileName = nodeInfo.document?.name || 'Figma Design';
            specifications = `# ${fileName}\n\n- Node ID: ${nodeId}\n- Type: ${nodeInfo.document?.type || 'Unknown'}`;
            
            // Check image mode setting
            if (this.imageMode === 'children' && nodeInfo.document?.children) {
              // Extract all child frames/components
              const children = this.extractChildNodes(nodeInfo.document.children);
              if (children.length > 0) {
                nodesForImageExport = children.map(child => child.id);
                console.log(`🖼️ Figma - Extracting ${children.length} child images from node: ${fileName}`);
                specifications += `\n- Child Nodes: ${children.length} frames/components`;
              } else {
                // No children found, fallback to single node
                nodesForImageExport = [nodeId];
                console.log(`⚠️ Figma - No children found, using single node image`);
              }
            } else {
              // Use this specific node for image export (single mode)
              nodesForImageExport = [nodeId];
              console.log(`✅ Figma - Found node: ${fileName} (single image mode)`);
            }
          }
        } else {
          console.warn(`⚠️ Figma - Could not fetch node metadata, will still try to export image`);
          nodesForImageExport = [nodeId];
        }
      } else {
        // No specific node-id in URL, fetch file metadata to find top-level frames
        console.log(`📄 Figma - No node-id in URL, fetching file metadata...`);
        
        const apiUrl = `https://api.figma.com/v1/files/${fileKey}`;
        console.log(`🌐 Figma API request: ${apiUrl}`);

        const response = await fetch(apiUrl, {
          headers: { 'X-Figma-Token': this.token }
        });

        // Handle rate limiting (429 Too Many Requests)
        if (response.status === 429) {
          if (retries > 0) {
            const retryAfter = response.headers.get('Retry-After');
            const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : 2000;
            console.warn(`Figma rate limit hit, retrying after ${waitTime}ms...`);
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

        if (data.status && data.status >= 400) {
          throw new Error(data.err || `Figma API returned error status ${data.status}`);
        }

        fileName = data.name;
        specifications = this.extractSpecifications(data);

        // Identify nodes for image export (top-level frames, components)
        if (data.document && data.document.children) {
          for (const page of data.document.children) {
            if (page.type === 'CANVAS' && page.children) {
              for (const child of page.children) {
                if (child.type === 'FRAME' || child.type === 'COMPONENT') {
                  nodesForImageExport.push(child.id);
                  if (nodesForImageExport.length >= CONFIG.MAX_FIGMA_IMAGES) break;
                }
              }
            }
            if (nodesForImageExport.length >= CONFIG.MAX_FIGMA_IMAGES) break;
          }
        }
      }

      return {
        url: url,
        name: fileName,
        specifications: specifications,
        lastModified: null,
        version: null,
        nodesForImageExport: nodesForImageExport
      };
    } catch (error) {
      console.error('Figma fetch error:', error);
      throw error;
    }
  }
  
  extractFileKey(url) {
    // Support file, design, and proto URLs
    const match = url.match(/figma\.com\/(file|design|proto)\/([^\/\?]+)/);
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
      const imageUrlsApi = `https://api.figma.com/v1/images/${fileKey}?ids=${nodeIds.join(',')}&format=png&scale=2`;
      
      console.log(`📸 [Figma] Fetching image URLs for ${nodeIds.length} nodes...`);
      console.log(`🔧 [Figma] CURL command to test manually:`);
      console.log(`curl -H "X-Figma-Token: YOUR_TOKEN" "${imageUrlsApi}"`);
      
      const response = await fetch(imageUrlsApi, {
        headers: { 'X-Figma-Token': this.token }
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ [Figma] Image URL fetch failed:', response.status, errorText);
        console.log(`🔧 [Figma] Test this curl command with your token to debug:`);
        console.log(`curl -H "X-Figma-Token: YOUR_TOKEN" "${imageUrlsApi}"`);
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
            console.log(`⬇️ [Figma] Downloading image for node ${nodeId}...`);
            console.log(`🔧 [Figma] CURL to download: curl "${imageUrl}" --output ${nodeId.replace(':', '_')}.png`);
            
            const imageResponse = await fetch(imageUrl);
            if (imageResponse.ok) {
              const blob = await imageResponse.blob();
              if (blob.size < minSizeInBytes) {
                console.warn(`⚠️ [Figma] Skipping image ${nodeId} (size ${Math.round(blob.size / 1024)}KB) - smaller than ${CONFIG.MIN_FIGMA_IMAGE_SIZE_KB}KB`);
                continue;
              }
              const base64 = await new Promise(resolve => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.readAsDataURL(blob);
              });
              images.push(base64);
              console.log(`✅ [Figma] Downloaded and converted image ${nodeId} (${Math.round(blob.size / 1024)}KB)`);
            } else {
              console.warn(`❌ [Figma] Failed to fetch image from ${imageUrl}: ${imageResponse.status}`);
            }
          } catch (imgError) {
            console.error(`❌ [Figma] Error fetching or converting image ${imageUrl}:`, imgError);
          }
        } else {
          console.warn(`⚠️ [Figma] No image URL returned for node ${nodeId}`);
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
// NOTE: Google Docs API requires OAuth2, not API keys
// For now, we'll use a simpler approach: fetch the public HTML export
class GoogleDocsIntegration {
  constructor(settings) {
    this.apiKey = settings.googleApiKey; // Keep for backward compatibility, but not used
  }
  
  extractUrls(text) {
    // Match Google Docs URLs with optional /edit suffix and query parameters
    const pattern = /https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+(?:\/edit)?(?:\?[A-Za-z0-9=&_-]+)?/gi;
    const matches = text.match(pattern) || [];
    return [...new Set(matches)];
  }
  
  async fetchDocument(url) {
    try {
      const docId = this.extractDocId(url);
      if (!docId) {
        throw new Error('Invalid Google Docs URL format. Could not extract document ID.');
      }

      console.log(`📄 [Google Docs] Fetching document: ${docId}`);
      console.log(`⚠️ [Google Docs] Note: Using public export method (Google Docs API requires OAuth2)`);
      
      // Use the public export URL instead of API
      // This works for publicly shared documents without authentication
      const exportUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
      
      console.log(`🔧 [Google Docs] CURL command to test manually:`);
      console.log(`curl -L "${exportUrl}"`);
      console.log(`\n💡 Note: Document must be shared as "Anyone with the link can view"`);

      const response = await fetch(exportUrl, {
        method: 'GET',
        redirect: 'follow'
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`❌ [Google Docs] Fetch failed:`, response.status, errorText);
        console.log(`🔧 [Google Docs] Test this curl command:`);
        console.log(`curl -L "https://docs.google.com/document/d/${docId}/export?format=txt"`);
        
        if (response.status === 401 || response.status === 403) {
          throw new Error('Google Docs access denied. Please share the document as "Anyone with the link can view".');
        } else if (response.status === 404) {
          throw new Error('Google Doc not found. The document may have been deleted or the link is incorrect.');
        } else {
          throw new Error(`Google Docs export failed with status ${response.status}.`);
        }
      }
      
      console.log(`✅ [Google Docs] Successfully fetched document ${docId}`);

      // Get plain text content from export
      const content = await response.text();
      
      // Truncate if too long
      let finalContent = content;
      if (finalContent.length > CONFIG.MAX_TEXT_EXTRACT_LENGTH) {
        console.warn(`Google Docs content truncated from ${finalContent.length} to ${CONFIG.MAX_TEXT_EXTRACT_LENGTH} characters.`);
        finalContent = finalContent.substring(0, CONFIG.MAX_TEXT_EXTRACT_LENGTH) + '... [Content truncated]';
      }

      return {
        url: url,
        title: `Google Doc ${docId}`,
        content: finalContent,
        revisionId: null
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
