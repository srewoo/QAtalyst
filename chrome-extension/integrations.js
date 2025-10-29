// External Integrations System for QAtalyst
// Fetch requirements from Confluence, Figma, and Google Docs

class IntegrationManager {
  constructor(settings) {
    this.settings = settings;
    this.confluence = new ConfluenceIntegration(settings);
    this.figma = new FigmaIntegration(settings);
    this.googleDocs = new GoogleDocsIntegration(settings);
  }
  
  async fetchAllLinkedContent(ticketData) {
    const results = {
      confluence: [],
      figma: [],
      googleDocs: [],
      enrichedDescription: ticketData.description || ''
    };
    
    // Extract URLs from ticket description and comments
    const allText = [
      ticketData.description || '',
      ...(ticketData.comments || []).map(c => c.body || '')
    ].join('\n');
    
    // Detect and fetch Confluence pages
    const confluenceUrls = this.confluence.extractUrls(allText);
    for (const url of confluenceUrls) {
      try {
        const content = await this.confluence.fetchPage(url);
        results.confluence.push(content);
      } catch (error) {
        console.error('Confluence fetch failed:', error);
      }
    }
    
    // Detect and fetch Figma files (with delay to avoid rate limits)
    const figmaUrls = this.figma.extractUrls(allText);
    for (let i = 0; i < figmaUrls.length; i++) {
      try {
        // Add small delay between requests to respect rate limits
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        const content = await this.figma.fetchFile(figmaUrls[i]);
        results.figma.push(content);
      } catch (error) {
        console.error('Figma fetch failed:', error);
      }
    }
    
    // Detect and fetch Google Docs
    const googleDocsUrls = this.googleDocs.extractUrls(allText);
    for (const url of googleDocsUrls) {
      try {
        const content = await this.googleDocs.fetchDocument(url);
        results.googleDocs.push(content);
      } catch (error) {
        console.error('Google Docs fetch failed:', error);
      }
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
    
    return results;
  }
}

// Confluence Integration
class ConfluenceIntegration {
  constructor(settings) {
    this.baseUrl = settings.confluenceUrl;
    this.token = settings.confluenceToken;
  }
  
  extractUrls(text) {
    // Match Confluence URLs
    const patterns = [
      /https?:\/\/[^\/]+\.atlassian\.net\/wiki\/spaces\/[^\s]+/gi,
      /https?:\/\/[^\/]+\.confluence\.[^\/]+\/[^\s]+/gi
    ];
    
    const urls = [];
    for (const pattern of patterns) {
      const matches = text.match(pattern) || [];
      urls.push(...matches);
    }
    
    return [...new Set(urls)]; // Remove duplicates
  }
  
  async fetchPage(url) {
    if (!this.baseUrl || !this.token) {
      throw new Error('Confluence not configured');
    }
    
    try {
      // Extract page ID from URL
      const pageId = this.extractPageId(url);
      if (!pageId) {
        throw new Error('Could not extract page ID from URL');
      }
      
      // Fetch page content
      const apiUrl = `${this.baseUrl}/rest/api/content/${pageId}?expand=body.storage,version`;
      
      const response = await fetch(apiUrl, {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Accept': 'application/json'
        }
      });
      
      if (!response.ok) {
        throw new Error(`Confluence API error: ${response.status}`);
      }
      
      const data = await response.json();
      
      return {
        url: url,
        title: data.title,
        content: this.parseHtml(data.body.storage.value),
        version: data.version.number
      };
    } catch (error) {
      console.error('Confluence fetch error:', error);
      return {
        url: url,
        title: 'Failed to fetch',
        content: `Error: ${error.message}`,
        version: 0
      };
    }
  }
  
  extractPageId(url) {
    // Try to extract page ID from various Confluence URL formats
    const patterns = [
      /\/pages\/(\d+)\//,  // /pages/123456/
      /pageId=(\d+)/,       // ?pageId=123456
      /\/(\d+)$/            // ending with /123456
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) {
        return match[1];
      }
    }
    
    return null;
  }
  
  parseHtml(html) {
    // Simple HTML to text conversion
    // Remove HTML tags and get clean text
    const text = html
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
    // Match Figma URLs
    const pattern = /https?:\/\/(www\.)?figma\.com\/(file|proto)\/[^\s]+/gi;
    const matches = text.match(pattern) || [];
    return [...new Set(matches)];
  }
  
  async fetchFile(url, retries = 3) {
    if (!this.token) {
      throw new Error('Figma not configured');
    }
    
    try {
      const fileKey = this.extractFileKey(url);
      if (!fileKey) {
        throw new Error('Could not extract file key from URL');
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
          throw new Error('Figma API rate limit exceeded. Please try again later.');
        }
      }
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Figma API error: ${response.status}`);
      }
      
      const data = await response.json();
      
      // Check for API error in response
      if (data.status && data.status >= 400) {
        throw new Error(data.err || `Figma API returned error status ${data.status}`);
      }
      
      // Extract specifications
      const specifications = this.extractSpecifications(data);
      
      return {
        url: url,
        name: data.name,
        specifications: specifications,
        lastModified: data.lastModified,
        version: data.version
      };
    } catch (error) {
      console.error('Figma fetch error:', error);
      return {
        url: url,
        name: 'Failed to fetch',
        specifications: `Error: ${error.message}`,
        lastModified: null,
        version: null
      };
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
    
    return specs.join('\n');
  }
}

// Google Docs Integration
class GoogleDocsIntegration {
  constructor(settings) {
    this.apiKey = settings.googleApiKey;
  }
  
  extractUrls(text) {
    // Match Google Docs URLs
    const pattern = /https?:\/\/docs\.google\.com\/document\/d\/[^\s\/]+/gi;
    const matches = text.match(pattern) || [];
    return [...new Set(matches)];
  }
  
  async fetchDocument(url) {
    if (!this.apiKey) {
      throw new Error('Google Docs not configured');
    }
    
    try {
      const docId = this.extractDocId(url);
      if (!docId) {
        throw new Error('Could not extract document ID from URL');
      }
      
      // Fetch document content
      const apiUrl = `https://docs.googleapis.com/v1/documents/${docId}?key=${this.apiKey}`;
      
      const response = await fetch(apiUrl);
      
      if (!response.ok) {
        throw new Error(`Google Docs API error: ${response.status}`);
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
      return {
        url: url,
        title: 'Failed to fetch',
        content: `Error: ${error.message}`,
        revisionId: null
      };
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
        content.push('\n[Table content]');
      }
    });
    
    return content.join('\n\n');
  }
}

// Export for use in background.js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { IntegrationManager, ConfluenceIntegration, FigmaIntegration, GoogleDocsIntegration };
}
