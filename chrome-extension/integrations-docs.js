/**
 * integrations-docs.js — Requirement sources: Confluence pages, Figma files and Google Docs.
 * Split out of integrations.js, which keeps CircuitBreaker + IntegrationManager.
 *
 * Load after integrations.js. The classes are published on the global object so
 * background.js / options.js keep using them by bare name.
 */
(function () {
  // Browser: integrations.js published these on the global. Node (tests): require it.
  const { CircuitBreaker, IntegrationManager } =
    (typeof module !== 'undefined' && module.exports) ? require('./integrations.js') : globalThis;

// Confluence Integration
class ConfluenceIntegration {
  constructor(settings) {
    this.baseUrl = settings.confluenceUrl;
    this.email = settings.confluenceEmail;
    this.token = settings.confluenceToken;

    console.log('📄 [Confluence] Integration initialized with:', {
      hasBaseUrl: !!this.baseUrl,
      hasEmail: !!this.email,
      hasToken: !!this.token,
      settingsKeys: Object.keys(settings)
    });
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
    console.log(`📄 [Confluence] fetchPage called for URL: ${url}`);
    console.log(`📄 [Confluence] Configuration status:`, {
      hasBaseUrl: !!this.baseUrl,
      hasEmail: !!this.email,
      hasToken: !!this.token,
      baseUrl: this.baseUrl || 'undefined',
      email: this.email || 'undefined'
      // No token material in logs, not even a prefix.
    });

    if (!this.baseUrl || !this.email || !this.token) {
      console.error('❌ [Confluence] Missing configuration:', {
        baseUrl: this.baseUrl,
        email: this.email,
        token: this.token ? 'present' : 'missing'
      });
      throw new Error('Confluence integration is not configured. Please add Confluence URL, email, and API token in extension settings.');
    }

    try {
      // Extract page ID from URL, or fall back to search-by-title
      let pageId = this.extractPageId(url);

      if (!pageId) {
        // Try to resolve the page via CQL search using title/space from the URL
        console.log(`📄 Confluence - No numeric page ID found, attempting search for: ${url}`);
        pageId = await this.resolvePageIdByUrl(url);
      }

      if (!pageId) {
        throw new Error('Could not resolve Confluence page. URL format not supported or page not found.');
      }

      console.log(`📄 Confluence - Resolved page ID: ${pageId} from URL: ${url}`);

      // Check cache first (cacheManager is optional)
      if (typeof cacheManager !== 'undefined' && cacheManager) {
        const cacheKey = cacheManager.constructor.getCacheKey('confluence', pageId);
        const cached = cacheManager.get(cacheKey);
        if (cached) {
          console.log(`Using cached Confluence page: ${pageId}`);
          return cached;
        }
      }

      // Fetch page content with retry logic
      const fetchPageWithRetry = async () => {
        // Strip trailing /wiki or /wiki/ to avoid double /wiki/wiki/ in Cloud URLs
        const cleanBaseUrl = this.baseUrl.replace(/\/wiki\/?$/, '');
        // Confluence Cloud uses /wiki/rest/api, Server/Data Center uses /rest/api
        const isCloud = cleanBaseUrl.includes('atlassian.net');
        const apiPath = isCloud ? '/wiki/rest/api/content' : '/rest/api/content';
        const apiUrl = `${cleanBaseUrl}${apiPath}/${pageId}?expand=body.storage,version`;
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
      if (typeof retryHelper !== 'undefined' && retryHelper) {
        result = await retryHelper.forService('confluence', 'fetchPage', fetchPageWithRetry, {
          maxRetries: 3,
          baseDelay: 1000
        });
      } else {
        result = await fetchPageWithRetry();
      }

      // Cache the result (cacheManager is optional)
      if (typeof cacheManager !== 'undefined' && cacheManager && result) {
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
  
  /**
   * Resolve a Confluence page ID by searching via CQL when numeric ID is not in the URL.
   * Handles display-format URLs (/display/SPACE/Title) and short links (/x/shortId).
   */
  async resolvePageIdByUrl(url) {
    try {
      const baseUrl = this.baseUrl.replace(/\/wiki\/?$/, '');
      const isCloud = baseUrl.includes('atlassian.net');
      const apiBase = isCloud ? `${baseUrl}/wiki/rest/api` : `${baseUrl}/rest/api`;
      const authHeader = 'Basic ' + btoa(`${this.email}:${this.token}`);

      // Try to extract space key and title from display-format URLs
      const displayMatch = url.match(/\/(?:wiki\/)?display\/([^\/]+)\/(.+?)(?:\?.*)?$/);
      if (displayMatch) {
        const spaceKey = displayMatch[1];
        const title = decodeURIComponent(displayMatch[2].replace(/\+/g, ' '));
        console.log(`📄 Confluence - Searching by space=${spaceKey}, title="${title}"`);

        const cql = encodeURIComponent(`space="${spaceKey}" AND title="${title}"`);
        const searchUrl = `${apiBase}/content/search?cql=${cql}&limit=1`;
        const response = await fetch(searchUrl, {
          headers: { 'Authorization': authHeader, 'Accept': 'application/json' }
        });

        if (response.ok) {
          const data = await response.json();
          if (data.results && data.results.length > 0) {
            return data.results[0].id;
          }
        }
      }

      // For short links (/x/shortId), resolve via Confluence REST API
      const shortLinkMatch = url.match(/\/wiki\/x\/([A-Za-z0-9_-]+)/);
      if (shortLinkMatch) {
        const shortId = shortLinkMatch[1];
        console.log(`📄 Confluence - Short link detected, resolving shortId: ${shortId}`);

        const resolvedId = await this.resolveShortLink(shortId, apiBase, authHeader, url);
        if (resolvedId) {
          return resolvedId;
        }
      }

      // For Jira bridge shortcut URLs (/wiki?xpis=...), decode the base64 payload
      // to extract the Confluence content ID.
      // The xpis value is a URL-encoded base64 JSON: {"bridge":"globalShortcuts","id":"<pageId>","source":"jira"}
      // Skip verification — return the ID directly and let fetchDocument surface real errors.
      const xpisMatch = url.match(/[?&]xpis=([A-Za-z0-9_+/=%-]+)/);
      if (xpisMatch) {
        try {
          const raw = xpisMatch[1];
          // Handle both URL-encoded (%3D) and plain base64
          const b64 = decodeURIComponent(raw);
          const decoded = JSON.parse(atob(b64));
          if (decoded.id) {
            console.log(`📄 Confluence - Jira bridge shortcut decoded: bridge="${decoded.bridge}", id="${decoded.id}", source="${decoded.source}"`);
            return String(decoded.id);
          }
        } catch (e) {
          console.warn(`📄 Confluence - Failed to decode xpis parameter: ${e.message}`);
        }
      }

      return null;
    } catch (error) {
      console.warn('📄 Confluence - Could not resolve page ID by URL:', error.message);
      return null;
    }
  }

  /**
   * Resolve a Confluence short link (/wiki/x/shortId) to a page ID.
   * Tries the REST API shortcutId lookup first, then falls back to following
   * the redirect of the short URL itself.
   */
  async resolveShortLink(shortId, apiBase, authHeader, originalUrl) {
    // Attempt 1: Query the REST API using the shortcutId
    try {
      const shortcutUrl = `${apiBase}/content?shortcutId=${encodeURIComponent(shortId)}`;
      console.log(`📄 Confluence - Trying shortcutId API: ${shortcutUrl}`);
      const response = await fetch(shortcutUrl, {
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' }
      });

      if (response.ok) {
        const data = await response.json();
        const results = data.results || (data.id ? [data] : []);
        if (results.length > 0) {
          console.log(`📄 Confluence - Resolved short link via shortcutId API: ${results[0].id}`);
          return results[0].id;
        }
      }
    } catch (e) {
      console.warn('📄 Confluence - shortcutId API lookup failed:', e.message);
    }

    // Attempt 2: Try CQL search with shortcutId
    try {
      const cql = encodeURIComponent(`shortcutId="${shortId}"`);
      const searchUrl = `${apiBase}/content/search?cql=${cql}&limit=1`;
      console.log(`📄 Confluence - Trying CQL shortcutId search: ${searchUrl}`);
      const response = await fetch(searchUrl, {
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' }
      });

      if (response.ok) {
        const data = await response.json();
        if (data.results && data.results.length > 0) {
          console.log(`📄 Confluence - Resolved short link via CQL search: ${data.results[0].id}`);
          return data.results[0].id;
        }
      }
    } catch (e) {
      console.warn('📄 Confluence - CQL shortcutId search failed:', e.message);
    }

    // Attempt 3: Follow the short URL redirect to extract the page ID from the final URL
    try {
      console.log(`📄 Confluence - Trying redirect resolution for: ${originalUrl}`);
      const response = await fetch(originalUrl, {
        method: 'GET',
        headers: { 'Authorization': authHeader },
        redirect: 'follow'
      });

      const finalUrl = response.url;
      if (finalUrl && finalUrl !== originalUrl) {
        console.log(`📄 Confluence - Short link redirected to: ${finalUrl}`);
        // Try to extract page ID from the redirected URL
        const pageIdMatch = finalUrl.match(/\/pages\/(\d+)|pageId=(\d+)|\/wiki\/spaces\/[^\/]+\/pages\/(\d+)/);
        if (pageIdMatch) {
          const resolvedId = pageIdMatch[1] || pageIdMatch[2] || pageIdMatch[3];
          console.log(`📄 Confluence - Resolved page ID from redirect: ${resolvedId}`);
          return resolvedId;
        }
      }
    } catch (e) {
      console.warn('📄 Confluence - Redirect resolution failed:', e.message);
    }

    console.warn(`📄 Confluence - Could not resolve short link: ${shortId}`);
    return null;
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

    // Return null for URLs without numeric IDs — resolvePageIdByUrl() will handle them
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
    // Default to 'children' mode to extract all child frames
    this.imageMode = settings.figmaImageMode || 'children';

    // UI-related keywords for smart filtering (prioritize these frames)
    this.uiPriorityKeywords = [
      // Screens and pages
      'screen', 'page', 'view', 'layout', 'template',
      // UI components
      'modal', 'dialog', 'popup', 'drawer', 'sidebar', 'panel',
      'header', 'footer', 'navbar', 'nav', 'menu', 'toolbar',
      'form', 'input', 'button', 'card', 'list', 'table', 'grid',
      // States
      'state', 'hover', 'active', 'disabled', 'loading', 'error', 'success', 'empty',
      // Flows
      'flow', 'step', 'wizard', 'onboarding', 'login', 'signup', 'checkout', 'settings',
      // Mobile/responsive
      'mobile', 'tablet', 'desktop', 'responsive',
      // Features
      'dashboard', 'profile', 'notification', 'search', 'filter', 'detail', 'edit', 'create'
    ];

    console.log('🎨 [Figma] Integration initialized with:', {
      hasToken: !!this.token,
      imageMode: this.imageMode,
      settingsKeys: Object.keys(settings)
    });
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
   * Calculate priority score for a node based on UI-relevance
   * Higher score = more likely to be an important UI screen
   * @param {object} node - Figma node with name and type
   * @returns {number} - Priority score (higher is better)
   */
  calculateNodePriority(node) {
    const name = (node.name || '').toLowerCase();
    let score = 0;

    // Base score by type
    if (node.type === 'FRAME') score += 10;
    if (node.type === 'COMPONENT') score += 8;
    if (node.type === 'COMPONENT_SET') score += 9;
    if (node.type === 'INSTANCE') score += 5;

    // Boost score for UI-related keywords in name
    for (const keyword of this.uiPriorityKeywords) {
      if (name.includes(keyword)) {
        score += 15; // Significant boost for UI keywords
      }
    }

    // Boost for numbered/versioned screens (e.g., "Screen 1", "Step 2")
    if (/\d+/.test(name) && (name.includes('screen') || name.includes('step') || name.includes('page'))) {
      score += 10;
    }

    // Penalize generic/utility names
    const genericNames = ['group', 'rectangle', 'ellipse', 'line', 'vector', 'image', 'text', 'auto layout', 'frame'];
    for (const generic of genericNames) {
      if (name === generic || name.startsWith(generic + ' ')) {
        score -= 20;
      }
    }

    // Penalize very short names (likely auto-generated)
    if (name.length < 3) {
      score -= 10;
    }

    // Boost for descriptive names (longer, more specific)
    if (name.length > 10) {
      score += 5;
    }

    return score;
  }

  /**
   * Extract child nodes (frames/components) from a Figma node
   * Uses smart filtering to prioritize UI-relevant frames
   * @param {array} children - Array of child nodes from Figma API
   * @returns {array} - Array of {id, name, type} objects for frames and components, sorted by priority
   */
  extractChildNodes(children) {
    const childNodes = [];
    const validTypes = ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP'];

    const traverse = (nodes, depth = 0) => {
      for (const node of nodes) {
        // Include frames, components, and groups (added GROUP type)
        if (validTypes.includes(node.type)) {
          childNodes.push({
            id: node.id,
            name: node.name,
            type: node.type,
            depth: depth,
            priority: this.calculateNodePriority(node)
          });
        }

        // Recursively check children (go up to 4 levels deep for better coverage)
        if (node.children && depth < 4) {
          traverse(node.children, depth + 1);
        }
      }
    };

    traverse(children);

    // Sort by priority (highest first), then by depth (shallower first)
    childNodes.sort((a, b) => {
      if (b.priority !== a.priority) {
        return b.priority - a.priority;
      }
      return a.depth - b.depth;
    });

    // Log what we found for debugging
    console.log(`🎨 [Figma] Found ${childNodes.length} nodes, top 10 by priority:`);
    childNodes.slice(0, 10).forEach((node, i) => {
      console.log(`   ${i + 1}. "${node.name}" (${node.type}, priority: ${node.priority}, depth: ${node.depth})`);
    });

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
    console.log(`🎨 [Figma] fetchFile called for URL: ${url}`);
    console.log(`🎨 [Figma] Token present: ${!!this.token}`);

    if (!this.token) {
      console.error('❌ [Figma] No token found. Token value:', this.token);
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
      let designRoot = null; // the node tree, for the design knowledge graph

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
            designRoot = nodeInfo.document || null;
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

        designRoot = data.document || null;

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
        nodesForImageExport: nodesForImageExport,
        // Screens, buttons and fields named in the design: grounding when the app
        // has not been crawled (figma-design-kg.js; absent where it is not loaded).
        designGraph: (typeof FigmaDesignKG !== 'undefined' && designRoot)
          ? FigmaDesignKG.designGraphFromFigma(designRoot, url) : null
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
      console.log(`🔧 [Figma] To debug, request ${imageUrlsApi} with your Figma personal access token in the X-Figma-Token header.`);
      
      const response = await fetch(imageUrlsApi, {
        headers: { 'X-Figma-Token': this.token }
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ [Figma] Image URL fetch failed:', response.status, errorText);
        console.log(`🔧 [Figma] To debug, request ${imageUrlsApi} with your Figma personal access token in the X-Figma-Token header.`);
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
    // Match Google Docs URLs including /edit, /view, ?tab=, #heading= variants
    // e.g. https://docs.google.com/document/d/ID/edit?tab=t.0#heading=h.xyz
    const pattern = /https:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+(?:\/(?:edit|view|pub))?(?:\?[^\s"'<>]*)??(?:#[^\s"'<>]*)?/gi;
    const matches = text.match(pattern) || [];
    // Normalise: strip fragment (#) and query params — only the doc ID matters for export
    return [...new Set(matches.map(u => {
      const docId = this.extractDocId(u);
      return docId ? `https://docs.google.com/document/d/${docId}` : u;
    }))];
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

  const api = { ConfluenceIntegration, FigmaIntegration, GoogleDocsIntegration };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(globalThis, api);
})();
