/**
 * Storage Manager - IndexedDB operations for knowledge graphs
 * Version: 11.2.1
 * Manages persistent storage, export/import of crawled app data (pages, forms, APIs)
 * Note: Method names reference "embeddings" for backward compatibility but primarily store knowledge graphs
 */

class StorageManager {
  constructor() {
    this.dbName = CONFIG.get('storage.dbName', 'QAtalystEmbeddings');
    this.dbVersion = CONFIG.get('storage.dbVersion', 2); // Bumped to 2 for page batches
    this.storeName = 'embeddings';
    this.pageBatchStore = 'pageBatches'; // NEW: For streaming save
    this.db = null;
  }

  /**
   * Initialize IndexedDB
   */
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => {
        reject(new Error('Failed to open IndexedDB'));
      };

      request.onsuccess = () => {
        this.db = request.result;
        console.log('✅ IndexedDB initialized');
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const oldVersion = event.oldVersion;

        // Create object store if it doesn't exist
        if (!db.objectStoreNames.contains(this.storeName)) {
          const objectStore = db.createObjectStore(this.storeName, { keyPath: 'appUrl' });
          objectStore.createIndex('crawledAt', 'crawledAt', { unique: false });
          console.log('📦 Created knowledge graph storage');
        }

        // Version 2: Add page batches store for streaming save (P0.1)
        if (oldVersion < 2 && !db.objectStoreNames.contains(this.pageBatchStore)) {
          const batchStore = db.createObjectStore(this.pageBatchStore, { keyPath: 'id' });
          batchStore.createIndex('crawlId', 'crawlId', { unique: false });
          batchStore.createIndex('batchNumber', 'batchNumber', { unique: false });
          console.log('📦 Created page batches object store (streaming save)');
        }
      };
    });
  }

  /**
   * Save embeddings to IndexedDB
   * @param {string} appUrl - App URL (for backward compatibility)
   * @param {Object} embeddingData - Embeddings with metadata
   */
  async saveEmbeddings(appUrl, embeddingData) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);

      // Handle both old format (appUrl in data) and new format (metadata object)
      const dataAppUrl = embeddingData.appUrl || appUrl;

      const data = {
        appUrl: dataAppUrl,
        embeddings: embeddingData.embeddings || [],
        metadata: {
          appUrl: dataAppUrl,
          model: embeddingData.model,
          dimensions: embeddingData.dimensions,
          totalTokens: embeddingData.totalTokens,
          cost: embeddingData.cost,
          provider: embeddingData.provider,
          crawledAt: embeddingData.crawledAt
        },
        knowledgeGraph: embeddingData.knowledgeGraph,
        crawledAt: Date.now(),
        version: '11.0.0'
      };

      const request = store.put(data);

      request.onsuccess = () => {
        console.log(`💾 Saved knowledge graph for ${data.appUrl}`);
        resolve();
      };

      request.onerror = () => {
        reject(new Error('Failed to save embeddings'));
      };
    });
  }

  /**
   * Save embeddings incrementally (append to existing embeddings)
   * Used during progressive crawling to save data as it's generated
   * @param {string} appUrl - App URL
   * @param {Object} incrementalData - Partial embedding data to append
   */
  async saveEmbeddingsIncremental(appUrl, incrementalData) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);

      // First, get existing data
      const getRequest = store.get(appUrl);

      getRequest.onsuccess = () => {
        const existingData = getRequest.result || {
          appUrl: appUrl,
          embeddings: [],
          metadata: {},
          knowledgeGraph: null,
          crawledAt: Date.now(),
          version: '11.0.0'
        };

        // Append new embeddings to existing ones
        existingData.embeddings = existingData.embeddings.concat(incrementalData.embeddings || []);

        // Update metadata
        existingData.metadata = {
          ...existingData.metadata,
          ...incrementalData.metadata,
          lastUpdated: Date.now()
        };

        existingData.crawledAt = Date.now();

        // Save updated data
        const putRequest = store.put(existingData);

        putRequest.onsuccess = () => {
          resolve(true);
        };

        putRequest.onerror = () => {
          reject(new Error('Failed to save incremental embeddings'));
        };
      };

      getRequest.onerror = () => {
        reject(new Error('Failed to load existing embeddings'));
      };
    });
  }

  /**
   * Load embeddings from IndexedDB
   * @param {string} appUrl - App URL to load embeddings for
   */
  async loadEmbeddings(appUrl) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.get(appUrl);

      request.onsuccess = () => {
        if (request.result) {
          console.log(`📂 Loaded knowledge graph for ${appUrl}`);
          resolve(request.result);
        } else {
          console.log(`ℹ️ No knowledge graph found for ${appUrl}`);
          resolve(null);
        }
      };

      request.onerror = () => {
        reject(new Error('Failed to load embeddings'));
      };
    });
  }

  /**
   * Get all stored apps
   */
  async getAllApps() {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.getAllKeys();

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        reject(new Error('Failed to get apps'));
      };
    });
  }

  /**
   * Get all embeddings with metadata
   */
  async getAllEmbeddings() {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readonly');
      const store = transaction.objectStore(this.storeName);
      const request = store.getAll();

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        reject(new Error('Failed to get all embeddings'));
      };
    });
  }

  /**
   * P0.1: Save page batch for streaming (prevents memory exhaustion)
   * Saves pages in chunks of 1,000 to IndexedDB and clears from memory
   * @param {string} crawlId - Unique crawl identifier (appUrl + timestamp)
   * @param {number} batchNumber - Batch sequence number (0, 1, 2, ...)
   * @param {Array} pages - Array of page objects to save
   */
  async savePageBatch(crawlId, batchNumber, pages) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.pageBatchStore], 'readwrite');
      const store = transaction.objectStore(this.pageBatchStore);

      const batch = {
        id: `${crawlId}_batch_${batchNumber}`,
        crawlId: crawlId,
        batchNumber: batchNumber,
        pages: pages,
        savedAt: Date.now(),
        pageCount: pages.length
      };

      const request = store.put(batch);

      request.onsuccess = () => {
        console.log(`💾 Saved page batch ${batchNumber} (${pages.length} pages) for crawl ${crawlId}`);
        resolve();
      };

      request.onerror = () => {
        reject(new Error(`Failed to save page batch ${batchNumber}`));
      };
    });
  }

  /**
   * P0.1: Load all page batches for a crawl
   * Retrieves all batches and combines them into a single pages array
   * @param {string} crawlId - Unique crawl identifier
   * @returns {Array} Combined array of all pages from all batches
   */
  async loadPageBatches(crawlId) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.pageBatchStore], 'readonly');
      const store = transaction.objectStore(this.pageBatchStore);
      const index = store.index('crawlId');
      const request = index.getAll(crawlId);

      request.onsuccess = () => {
        const batches = request.result;

        if (batches.length === 0) {
          console.log(`ℹ️ No page batches found for crawl ${crawlId}`);
          resolve([]);
          return;
        }

        // Sort batches by batch number and combine pages
        batches.sort((a, b) => a.batchNumber - b.batchNumber);
        const allPages = batches.flatMap(batch => batch.pages);

        console.log(`📂 Loaded ${batches.length} batches (${allPages.length} total pages) for crawl ${crawlId}`);
        resolve(allPages);
      };

      request.onerror = () => {
        reject(new Error('Failed to load page batches'));
      };
    });
  }

  /**
   * P0.1: Clear all page batches for a crawl (cleanup after completion)
   * @param {string} crawlId - Unique crawl identifier
   */
  async clearPageBatches(crawlId) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.pageBatchStore], 'readwrite');
      const store = transaction.objectStore(this.pageBatchStore);
      const index = store.index('crawlId');
      const request = index.getAllKeys(crawlId);

      request.onsuccess = () => {
        const keys = request.result;

        if (keys.length === 0) {
          resolve();
          return;
        }

        // Delete all batches for this crawl
        let deleteCount = 0;
        keys.forEach(key => {
          const deleteRequest = store.delete(key);
          deleteRequest.onsuccess = () => {
            deleteCount++;
            if (deleteCount === keys.length) {
              console.log(`🗑️ Cleared ${keys.length} page batches for crawl ${crawlId}`);
              resolve();
            }
          };
        });
      };

      request.onerror = () => {
        reject(new Error('Failed to clear page batches'));
      };
    });
  }

  /**
   * P1.6: Check storage quota and usage
   * Returns quota information to prevent QuotaExceededError
   */
  async checkStorageQuota() {
    if (!navigator.storage || !navigator.storage.estimate) {
      return {
        available: true,
        percentUsed: 0,
        usage: 0,
        quota: 0,
        warning: false
      };
    }

    const estimate = await navigator.storage.estimate();
    const percentUsed = (estimate.usage / estimate.quota) * 100;

    return {
      available: percentUsed < 95, // Consider unavailable if > 95% used
      percentUsed: percentUsed.toFixed(1),
      usage: estimate.usage,
      quota: estimate.quota,
      usageGB: (estimate.usage / (1024 ** 3)).toFixed(2),
      quotaGB: (estimate.quota / (1024 ** 3)).toFixed(2),
      warning: percentUsed > 80 // Warn at 80%
    };
  }

  /**
   * Delete embeddings for an app
   * @param {string} appUrl - App URL to delete
   */
  async deleteEmbeddings(appUrl) {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.delete(appUrl);

      request.onsuccess = () => {
        console.log(`🗑️ Deleted knowledge graph for ${appUrl}`);
        resolve();
      };

      request.onerror = () => {
        reject(new Error('Failed to delete embeddings'));
      };
    });
  }

  /**
   * Export embeddings to JSON file
   * @param {string} appUrl - App URL to export
   */
  async exportToJSON(appUrl) {
    const data = await this.loadEmbeddings(appUrl);

    if (!data) {
      throw new Error(`No data found for ${appUrl}`);
    }

    // Check if we have knowledge graph (main data) even without embeddings
    if (!data.knowledgeGraph) {
      throw new Error(`No knowledge graph found for ${appUrl}`);
    }

    console.log(`📤 Exporting crawl data: ${data.knowledgeGraph.totalPages || 0} pages`);

    // CRITICAL FIX: Use data URL for service worker compatibility
    // URL.createObjectURL() is not available in service workers
    let jsonStr;
    try {
      // Try pretty-printed JSON first
      jsonStr = JSON.stringify(data, null, 2);
    } catch (stringError) {
      // Fallback: Create minified JSON (no pretty printing) to reduce size
      console.warn('⚠️ Large dataset, using minified JSON...');
      jsonStr = JSON.stringify(data);
    }

    // Create filename from app URL
    const filename = `qatalyst-crawl-${this.sanitizeFilename(appUrl)}-${Date.now()}.json`;

    // Convert to data URL (works in service workers)
    // For large files, we use base64 encoding to avoid URL length limits
    const dataUrl = this.createDataUrl(jsonStr, 'application/json');

    try {
      const downloadId = await chrome.downloads.download({
        url: dataUrl,
        filename: filename,
        saveAs: true
      });

      console.log(`📤 Exported crawl data to ${filename} (downloadId: ${downloadId})`);
      return filename;
    } catch (error) {
      console.error('Download failed:', error);
      throw new Error(`Export failed: ${error.message}`);
    }
  }

  /**
   * Export crawl data in BOTH formats (JSON + Markdown)
   * Creates two files: complete JSON data + human-readable MD report
   * @param {string} appUrl - App URL to export
   */
  async exportBothFormats(appUrl) {
    console.log('📦 Exporting in BOTH formats (JSON + Markdown)...');

    try {
      // Export JSON (complete data with embeddings)
      const jsonFilename = await this.exportToJSON(appUrl);
      console.log(`✅ JSON exported: ${jsonFilename}`);

      // Small delay to avoid download conflicts
      await new Promise(resolve => setTimeout(resolve, 500));

      // Export Markdown (human-readable report)
      const mdFilename = await this.exportToMarkdown(appUrl);
      console.log(`✅ Markdown exported: ${mdFilename}`);

      return {
        json: jsonFilename,
        markdown: mdFilename
      };
    } catch (error) {
      console.error('Failed to export both formats:', error);
      throw error;
    }
  }

  /**
   * Export crawl data to Markdown format (human-readable report)
   * @param {string} appUrl - App URL to export
   */
  async exportToMarkdown(appUrl) {
    const data = await this.loadEmbeddings(appUrl);

    if (!data) {
      throw new Error(`No data found for ${appUrl}`);
    }

    if (!data.knowledgeGraph) {
      throw new Error(`No knowledge graph found for ${appUrl}`);
    }

    const kg = data.knowledgeGraph;
    console.log(`📝 Exporting crawl data as Markdown: ${kg.totalPages || 0} pages`);

    // Build Markdown content
    let markdown = `# QAtalyst Crawl Report\n\n`;
    markdown += `**Application:** ${kg.appUrl}\n\n`;
    markdown += `**Crawled:** ${new Date(kg.crawledAt).toLocaleString()}\n\n`;
    markdown += `**Duration:** ${(kg.duration / 1000).toFixed(1)}s\n\n`;
    markdown += `---\n\n`;

    // Summary stats
    markdown += `## 📊 Summary\n\n`;
    markdown += `- **Total Pages:** ${kg.totalPages}\n`;
    markdown += `- **Features Found:** ${kg.stats?.totalFeatures || 0}\n`;
    markdown += `- **APIs Found:** ${kg.stats?.totalApis || 0}\n`;
    markdown += `- **Max Depth:** ${kg.stats?.maxDepthReached || 0}\n`;

    if (kg.performance) {
      markdown += `- **Pages/Minute:** ${kg.performance.pagesPerMinute}\n`;
      markdown += `- **Site Type:** ${kg.performance.siteType || 'not detected'}\n`;
    }

    markdown += `\n---\n\n`;

    // Pages details
    markdown += `## 📄 Pages Crawled\n\n`;

    for (const page of kg.pages) {
      markdown += `### ${page.title || 'Untitled Page'}\n\n`;
      markdown += `**URL:** ${page.url}\n\n`;

      if (page.description) {
        markdown += `**Description:** ${page.description}\n\n`;
      }

      // Features
      if (page.features && page.features.length > 0) {
        markdown += `**Features (${page.features.length}):**\n\n`;
        const featureTypes = {};
        for (const feature of page.features) {
          featureTypes[feature.type] = (featureTypes[feature.type] || 0) + 1;
        }
        for (const [type, count] of Object.entries(featureTypes)) {
          markdown += `- ${type}: ${count}\n`;
        }
        markdown += `\n`;
      }

      // APIs
      if (page.apis && page.apis.length > 0) {
        markdown += `**API Endpoints (${page.apis.length}):**\n\n`;
        for (const api of page.apis) {
          markdown += `- \`${api.method} ${api.url}\`\n`;
        }
        markdown += `\n`;
      }

      // Text content preview
      if (page.textContent) {
        const preview = page.textContent.substring(0, 200);
        markdown += `**Content Preview:**\n\n`;
        markdown += `> ${preview}${page.textContent.length > 200 ? '...' : ''}\n\n`;
      }

      markdown += `---\n\n`;
    }

    // Feature summary
    if (kg.stats?.featureTypes) {
      markdown += `## 🎨 Feature Types Summary\n\n`;
      for (const [type, count] of Object.entries(kg.stats.featureTypes)) {
        markdown += `- **${type}:** ${count}\n`;
      }
      markdown += `\n`;
    }

    // Create Markdown file
    const filename = `qatalyst-report-${this.sanitizeFilename(appUrl)}-${Date.now()}.md`;

    // Convert to data URL (works in service workers)
    const dataUrl = this.createDataUrl(markdown, 'text/markdown');

    try {
      const downloadId = await chrome.downloads.download({
        url: dataUrl,
        filename: filename,
        saveAs: true
      });

      console.log(`📝 Exported Markdown report to ${filename} (downloadId: ${downloadId})`);
      return filename;
    } catch (error) {
      console.error('Download failed:', error);
      throw new Error(`Export failed: ${error.message}`);
    }
  }

  /**
   * Export embeddings to binary format (more compact)
   * @param {string} appUrl - App URL to export
   */
  async exportToBinary(appUrl) {
    const data = await this.loadEmbeddings(appUrl);

    if (!data) {
      throw new Error(`No embeddings found for ${appUrl}`);
    }

    // Convert to binary format
    const buffer = this.serializeToBinary(data);

    // Convert binary buffer to base64 data URL
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    const dataUrl = `data:application/octet-stream;base64,${base64}`;

    const filename = `qatalyst-embeddings-${this.sanitizeFilename(appUrl)}-${Date.now()}.vec`;

    try {
      const downloadId = await chrome.downloads.download({
        url: dataUrl,
        filename: filename,
        saveAs: true
      });

      console.log(`📤 Exported knowledge graph to binary: ${filename} (downloadId: ${downloadId})`);
      return filename;
    } catch (error) {
      console.error('Binary export failed:', error);
      throw new Error(`Export failed: ${error.message}`);
    }
  }

  /**
   * Import embeddings from JSON file
   * @param {File} file - JSON file to import
   */
  async importFromJSON(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = async (e) => {
        try {
          const data = JSON.parse(e.target.result);

          // Validate data structure
          if (!data.appUrl || !data.embeddings || !data.metadata) {
            throw new Error('Invalid embedding file format');
          }

          // Save to IndexedDB
          await this.saveEmbeddings(data);

          console.log(`📥 Imported knowledge graph from ${file.name}`);
          resolve(data);
        } catch (error) {
          reject(new Error(`Import failed: ${error.message}`));
        }
      };

      reader.onerror = () => {
        reject(new Error('Failed to read file'));
      };

      reader.readAsText(file);
    });
  }

  /**
   * Import from binary format
   * @param {File} file - Binary .vec file
   */
  async importFromBinary(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();

      reader.onload = async (e) => {
        try {
          const buffer = e.target.result;
          const data = this.deserializeFromBinary(buffer);

          await this.saveEmbeddings(data);

          console.log(`📥 Imported knowledge graph from binary file`);
          resolve(data);
        } catch (error) {
          reject(new Error(`Binary import failed: ${error.message}`));
        }
      };

      reader.onerror = () => {
        reject(new Error('Failed to read binary file'));
      };

      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * Serialize embeddings to binary format
   */
  serializeToBinary(data) {
    // Simple binary format:
    // - Metadata as JSON string (length prefix)
    // - Embeddings as Float32Array

    const metadataStr = JSON.stringify({
      appUrl: data.appUrl,
      metadata: data.metadata,
      crawledAt: data.crawledAt,
      version: data.version,
      embeddingCount: data.embeddings.length
    });

    const metadataBytes = new TextEncoder().encode(metadataStr);
    const metadataLength = metadataBytes.length;

    // Calculate total size
    const vectorDimensions = data.embeddings[0].vector.length;
    const vectorsSize = data.embeddings.length * vectorDimensions * 4; // Float32 = 4 bytes
    const totalSize = 4 + metadataLength + vectorsSize;

    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);

    let offset = 0;

    // Write metadata length
    view.setUint32(offset, metadataLength, true);
    offset += 4;

    // Write metadata
    new Uint8Array(buffer, offset, metadataLength).set(metadataBytes);
    offset += metadataLength;

    // Write vectors
    const vectorArray = new Float32Array(buffer, offset);
    let vectorIndex = 0;
    for (const embedding of data.embeddings) {
      for (const value of embedding.vector) {
        vectorArray[vectorIndex++] = value;
      }
    }

    return buffer;
  }

  /**
   * Deserialize from binary format
   */
  deserializeFromBinary(buffer) {
    const view = new DataView(buffer);
    let offset = 0;

    // Read metadata length
    const metadataLength = view.getUint32(offset, true);
    offset += 4;

    // Read metadata
    const metadataBytes = new Uint8Array(buffer, offset, metadataLength);
    const metadataStr = new TextDecoder().decode(metadataBytes);
    const metadata = JSON.parse(metadataStr);
    offset += metadataLength;

    // Read vectors
    const vectorArray = new Float32Array(buffer, offset);
    const vectorDimensions = metadata.metadata.dimensions;
    const embeddingCount = metadata.embeddingCount;

    const embeddings = [];
    for (let i = 0; i < embeddingCount; i++) {
      const startIdx = i * vectorDimensions;
      const vector = Array.from(vectorArray.slice(startIdx, startIdx + vectorDimensions));

      embeddings.push({
        id: `page_${i}`,
        vector,
        // Metadata will be reconstructed separately if needed
      });
    }

    return {
      appUrl: metadata.appUrl,
      embeddings,
      metadata: metadata.metadata,
      crawledAt: metadata.crawledAt,
      version: metadata.version
    };
  }

  /**
   * Get storage statistics
   */
  async getStats() {
    const apps = await this.getAllApps();
    const allData = await this.getAllEmbeddings();

    let totalEmbeddings = 0;
    let totalPages = 0;
    let totalSize = 0;

    for (const data of allData) {
      // Handle both cases: with embeddings and without
      totalEmbeddings += (data.embeddings || []).length;

      // Count pages from knowledge graph if available
      if (data.knowledgeGraph) {
        totalPages += data.knowledgeGraph.totalPages || 0;
      }

      // Rough size estimate
      totalSize += JSON.stringify(data).length;
    }

    return {
      appCount: apps.length,
      totalEmbeddings,
      totalPages,
      estimatedSize: this.formatBytes(totalSize),
      apps: allData.map(d => ({
        url: d.appUrl,
        embeddingCount: (d.embeddings || []).length,
        pages: d.knowledgeGraph?.totalPages || 0,
        features: d.knowledgeGraph?.stats?.totalFeatures || 0,
        apis: d.knowledgeGraph?.stats?.totalApis || 0,
        crawledAt: new Date(d.crawledAt).toLocaleString(),
        isMerged: d.knowledgeGraph?.isMerged || false
      }))
    };
  }

  /**
   * Clear all embeddings
   */
  async clearAll() {
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([this.storeName], 'readwrite');
      const store = transaction.objectStore(this.storeName);
      const request = store.clear();

      request.onsuccess = () => {
        console.log('🗑️ Cleared all knowledge graphs');
        resolve();
      };

      request.onerror = () => {
        reject(new Error('Failed to clear embeddings'));
      };
    });
  }

  /**
   * Create data URL from string content
   * Service worker compatible (doesn't use Blob or URL.createObjectURL)
   * @param {string} content - Content to convert
   * @param {string} mimeType - MIME type (e.g., 'application/json', 'text/markdown')
   * @returns {string} Data URL
   */
  createDataUrl(content, mimeType) {
    // Convert content to base64 for reliable encoding
    // This works in service workers unlike Blob/URL.createObjectURL
    const base64 = btoa(unescape(encodeURIComponent(content)));
    return `data:${mimeType};base64,${base64}`;
  }

  /**
   * Sanitize filename
   */
  sanitizeFilename(str) {
    return str.replace(/[^a-z0-9]/gi, '-').toLowerCase().substring(0, 50);
  }

  /**
   * Format bytes to human readable
   */
  formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
  }
}

// Export for use in background script
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StorageManager;
}
