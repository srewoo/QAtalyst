# QAtalyst Configuration Guide

**Version:** 11.1.0
**Last Updated:** November 2025

This document provides comprehensive details about all configuration options available in QAtalyst. Most settings are in `config.json` and can be modified directly. A subset is exposed through the UI Settings page.

---

## 📊 Configuration Overview

| Category | Total Options | UI Exposed | Hidden in config.json |
|----------|--------------|------------|----------------------|
| **Crawler** | ~150 | 4 | ~146 |
| **Embeddings** | ~20 | 0 | ~20 |
| **Network** | ~15 | 0 | ~15 |
| **DOM Extraction** | ~30 | 0 | ~30 |
| **AI** | ~15 | 8 | ~7 |
| **Evolution** | ~10 | 2 | ~8 |
| **Integrations** | ~15 | 6 | ~9 |
| **UI** | ~10 | 0 | ~10 |
| **Security** | ~10 | 0 | ~10 |
| **Performance** | ~8 | 0 | ~8 |
| **Logging** | ~6 | 0 | ~6 |
| **Features** | ~8 | 0 | ~8 |
| **TOTAL** | **~297** | **20** | **~277** |

**Legend:**
- ✅ = Available in UI Settings
- ✗ = Hidden (config.json only)
- 🔧 = Requires extension reload
- ⚠️ = Use with caution

---

## 1. CRAWLER CONFIGURATION

### 1.1 Limits (`crawler.limits`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `maxPages` | number | 2000 | ✗ 🔧 | Maximum pages to crawl per session |
| `maxDepth` | number | 10 | ✗ 🔧 | Maximum crawl depth from start URL |
| `maxQueueSize` | number | 2000 | ✗ 🔧 | Maximum URLs in queue |
| `queueWarningThreshold` | number | 1500 | ✗ | Warning threshold (75% of max) |
| `timeout` | number | 600000 | ✗ 🔧 | Overall crawl timeout (10 minutes) |
| `pageTimeout` | number | 40000 | ✗ 🔧 | Per-page load timeout (40 seconds) |

**Usage:**
```json
"limits": {
  "maxPages": 1000,  // Reduce for faster crawls
  "maxDepth": 5      // Limit depth for large sites
}
```

---

### 1.2 Delays (`crawler.delays`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `betweenPages` | number | 200 | ✗ 🔧 | Delay between pages (ms) |
| `pageLoad` | number | 1000 | ✗ 🔧 | Wait after page load (ms) |
| `dynamicContent` | number | 400 | ✗ 🔧 | Wait for dynamic content (ms) |
| `retryDelay` | number | 2000 | ✗ 🔧 | Delay before retry (ms) |

**Note:** Reduced delays for faster crawling. Adaptive wait strategies will adjust based on site type.

---

### 1.3 Adaptive Timeouts (`crawler.timeouts`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `navigation.static` | number | 15000 | ✗ 🔧 | Timeout for static sites (ms) |
| `navigation.dynamic` | number | 30000 | ✗ 🔧 | Timeout for dynamic sites (ms) |
| `navigation.heavy` | number | 60000 | ✗ 🔧 | Timeout for heavy SPAs (ms) |
| `navigation.default` | number | 30000 | ✗ 🔧 | Default timeout (ms) |

**How it works:** Extension auto-detects site type and applies appropriate timeout.

---

### 1.4 Streaming Save (`crawler.streamingSave`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✗ 🔧 | Enable batch saving to IndexedDB |
| `batchSize` | number | 250 | ✗ 🔧 | Save every N pages |

**Why:** Prevents memory exhaustion by saving pages incrementally.

---

### 1.5 Authentication Detection (`crawler.authentication`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `detectPatterns` | array | ["/login", "/signin", ...] | ✗ 🔧 | URL patterns to skip |

**Default patterns:**
- `/login`, `/signin`, `/sign-in`
- `/auth`, `/oauth`, `/sso`
- `/authentication`, `/login.aspx`
- `/account/login`

**Purpose:** Prevents crawler from getting stuck on authentication pages.

---

### 1.6 URL Normalization (`crawler.urlNormalization`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✗ 🔧 | Enable URL normalization |
| `removeParams` | array | ["page", "utm_*", ...] | ✗ 🔧 | Query params to remove |

**Default removed params:**
- Pagination: `page`, `offset`, `limit`
- Tracking: `utm_source`, `utm_medium`, `utm_campaign`, `fbclid`, `gclid`
- Timestamps: `timestamp`, `ts`, `_t`
- Misc: `ref`, `source`

**Example:**
```
Before: /products?page=1&utm_source=google
After:  /products
```

---

### 1.7 SPA Detection (`crawler.spaDetection`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✗ 🔧 | Enable SPA detection |
| `hydrationWait` | number | 3000 | ✗ 🔧 | Wait for hydration (ms) |
| `detectFrameworks` | array | ["React", "Vue", ...] | ✗ 🔧 | Frameworks to detect |

**Detected frameworks:**
- React (including Next.js)
- Vue (including Nuxt.js)
- Angular
- Svelte

**Purpose:** Waits for JavaScript frameworks to hydrate before extracting data.

---

### 1.8 Retry Configuration (`crawler.retry`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✗ 🔧 | Enable automatic retries |
| `maxRetries` | number | 2 | ✗ 🔧 | Max retry attempts |
| `retryDelay` | number | 3000 | ✗ 🔧 | Delay between retries (ms) |
| `retryableErrors` | array | ["timeout", ...] | ✗ 🔧 | Error patterns to retry |

**Retryable errors:**
- `timeout` - Page load timeout
- `net::` - Network errors
- `ERR_` - Chrome error codes
- `Failed to fetch`
- `Page load timeout`

**Non-retryable:** 404, 403, 500 errors (logged immediately)

---

### 1.9 Incremental Crawling (`crawler.incremental`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✗ 🔧 | Skip previously crawled pages |
| `forceRecrawl` | boolean | false | ✗ 🔧 | Force full recrawl |

**How it works:** Saves crawl state and skips unchanged pages on subsequent crawls.

---

### 1.10 Parallel Crawling (`crawler.parallel`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✗ 🔧 | Enable parallel tab crawling |
| `maxConcurrentTabs` | number | 3 | ✗ 🔧 | Starting concurrent tabs |
| `adaptiveScaling` | boolean | true | ✗ 🔧 | Auto-scale based on performance |
| `minTabs` | number | 2 | ✗ 🔧 | Minimum concurrent tabs |
| `maxTabs` | number | 5 | ✗ 🔧 | Maximum concurrent tabs |
| `scaleUpThreshold` | number | 1.5 | ✗ 🔧 | Scale up if avg time < threshold |
| `scaleDownThreshold` | number | 3.0 | ✗ 🔧 | Scale down if avg time > threshold |
| `coordinationDelay` | number | 50 | ✗ 🔧 | Delay between tab coordination (ms) |

**Memory optimized:** Reduced from 10 to 5 max tabs to prevent exhaustion.

---

### 1.11 Sitemap Parsing (`crawler.sitemap`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✗ 🔧 | Enable sitemap.xml parsing |
| `parseFirst` | boolean | true | ✗ 🔧 | Parse before crawling |
| `fallbackToCrawl` | boolean | true | ✗ 🔧 | Crawl if no sitemap found |
| `paths` | array | ["/sitemap.xml", ...] | ✗ 🔧 | Sitemap file paths to try |

**Default paths:**
- `/sitemap.xml`
- `/sitemap_index.xml`
- `/sitemap-index.xml`

---

### 1.12 Selective Crawling (`crawler.selective`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✗ 🔧 | Enable selective crawling |
| `skipNonInteractive` | boolean | false | ✗ 🔧 | Skip pages without features |
| `requiredFeatures` | array | ["form", "button", ...] | ✗ 🔧 | Features to look for |
| `minFeaturesRequired` | number | 1 | ✗ 🔧 | Minimum features to crawl |

**Purpose:** Focus on interactive pages with forms/buttons/APIs.

---

### 1.13 Site Type Detection (`crawler.siteDetection`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✗ 🔧 | Auto-detect site type |
| `sampleSize` | number | 10 | ✗ 🔧 | Pages to analyze |

**Site type configs:**

#### Static Sites
```json
"static": {
  "avgLoadTime": 1500,
  "dynamicContentRatio": 0.2,
  "pageLoadDelay": 500,
  "smartWaitEnabled": false
}
```

#### Dynamic Sites
```json
"dynamic": {
  "avgLoadTime": 3000,
  "dynamicContentRatio": 0.6,
  "pageLoadDelay": 1500,
  "smartWaitEnabled": true
}
```

#### Heavy SPAs
```json
"heavy": {
  "avgLoadTime": 5000,
  "dynamicContentRatio": 0.8,
  "pageLoadDelay": 3000,
  "smartWaitEnabled": true
}
```

---

### 1.14 Priority Crawling (`crawler.priorityCrawling`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✗ 🔧 | Enable priority queue |
| `sortQueue` | boolean | true | ✗ 🔧 | Sort by priority score |

**Scoring system:**
```json
"scoring": {
  "navigation": 100,  // Highest priority
  "form": 90,
  "api": 85,
  "button": 70,
  "table": 60,
  "static": 20        // Lowest priority
}
```

**Purpose:** Crawls important pages (navigation, forms) first for faster meaningful results.

---

### 1.15 Duplicate Detection (`crawler.duplicateDetection`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✅ 🔧 | Master switch for duplicate detection |
| `detectParameterizedUrls` | boolean | true | ✅ 🔧 | Detect parameterized URL patterns |
| `maxSamplesPerPattern` | number | 1 | ✅ 🔧 | Samples to crawl per pattern |
| `similarityThreshold` | number | 0.90 | ✗ 🔧 | Similarity threshold (90%) |
| `compareTitle` | boolean | true | ✗ 🔧 | Compare page titles |
| `compareText` | boolean | true | ✗ 🔧 | Compare text content |
| `compareFeatures` | boolean | true | ✗ 🔧 | Compare features (forms/buttons) |
| `compareStructure` | boolean | true | ✗ 🔧 | Compare DOM structure |
| `skipPagination` | boolean | true | ✗ 🔧 | Skip pagination URLs |
| `paginationPatterns` | array | ["page=", "/page/", ...] | ✗ 🔧 | Pagination URL patterns |

**Pagination patterns:**
- `page=`, `?p=`, `&p=`
- `/page/`, `offset=`, `skip=`

**Performance impact:**
- With detection: 85% faster, 60x speedup for sites with 1000+ parameterized URLs
- Without detection: Every URL crawled (slower, more memory)

---

### 1.16 Caching (`crawler.caching`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✗ 🔧 | Enable feature caching |
| `cacheFeatures` | boolean | true | ✗ 🔧 | Cache extracted features |
| `cacheAPIs` | boolean | true | ✗ 🔧 | Cache API patterns |
| `cacheSimilarPages` | boolean | true | ✗ 🔧 | Cache similar page analysis |
| `maxCacheSize` | number | 200 | ✗ 🔧 | Max cache entries |

**Memory optimized:** Reduced from 1000 to 200 entries.

---

### 1.17 Prefetching (`crawler.prefetching`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✗ 🔧 | Enable URL prefetching |
| `prefetchCount` | number | 5 | ✗ 🔧 | URLs to prefetch ahead |
| `prefetchStrategy` | string | "priority" | ✗ 🔧 | Prefetch strategy |

**Strategies:**
- `priority` - Prefetch high-priority URLs
- `sequential` - Prefetch in queue order

---

### 1.18 Resource Blocking (`crawler.resourceBlocking`) ⚠️

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | **false** | ✗ 🔧 | Enable resource blocking |
| `blockImages` | boolean | true | ✗ 🔧 | Block images |
| `blockFonts` | boolean | true | ✗ 🔧 | Block fonts |
| `blockCSS` | boolean | false | ✗ 🔧 | Block CSS (keeps layout) |
| `blockMedia` | boolean | true | ✗ 🔧 | Block audio/video |
| `allowScripts` | boolean | true | ✗ 🔧 | Allow JavaScript |

**⚠️ Warning:** Disabled by default. When enabled, only blocks resources from the crawled domain. CSS blocking is disabled to preserve layout detection.

**Use case:** Speed up crawls on media-heavy sites.

---

### 1.19 Crawler Features (`crawler.features`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `recursiveCrawl` | boolean | true | ✗ 🔧 | Follow links recursively |
| `followSameOriginOnly` | boolean | true | ✗ 🔧 | Stay on same domain |
| `detectSPARoutes` | boolean | true | ✗ 🔧 | Detect SPA client-side routes |
| `useSitemap` | boolean | true | ✗ 🔧 | Use sitemap.xml if available |
| `captureScreenshots` | boolean | false | ✗ 🔧 | Capture page screenshots |
| `monitorNetwork` | boolean | true | ✗ 🔧 | Monitor network requests |
| `extractForms` | boolean | true | ✗ 🔧 | Extract form data |
| `extractTables` | boolean | true | ✗ 🔧 | Extract table data |
| `extractButtons` | boolean | true | ✗ 🔧 | Extract button data |
| `extractNavigation` | boolean | true | ✗ 🔧 | Extract navigation menus |
| `extractModals` | boolean | true | ✗ 🔧 | Extract modal dialogs |

---

### 1.20 Exclusions (`crawler.exclusions`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `extensions` | array | ["jpg", "pdf", ...] | ✗ 🔧 | File extensions to skip |
| `patterns` | array | ["/api/", ...] | ✗ 🔧 | URL patterns to skip |
| `maxQueryLength` | number | 200 | ✗ 🔧 | Max query string length |

**Default excluded extensions:**
- Images: `jpg`, `jpeg`, `png`, `gif`, `svg`, `ico`
- Documents: `pdf`, `zip`, `exe`, `dmg`
- Media: `mp4`, `mp3`
- Fonts: `woff`, `woff2`, `ttf`, `eot`
- Code: `css`, `js` (when loaded as separate files)

**Default excluded patterns:**
- `/api/` - API endpoints
- `/download/` - Download links
- `/logout`, `/signout` - Auth links
- `mailto:`, `tel:`, `javascript:` - Special protocols

---

### 1.21 SPA Discovery (`crawler.spaDiscovery`) ⚠️

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | **false** | ✗ 🔧 | Enable click-based discovery |
| `maxClicksPerPage` | number | 10 | ✗ 🔧 | Max elements to click |
| `clickDelay` | number | 500 | ✗ 🔧 | Delay between clicks (ms) |
| `discoverTabs` | boolean | true | ✗ 🔧 | Discover tab panels |
| `discoverModals` | boolean | true | ✗ 🔧 | Discover modals |
| `discoverAccordions` | boolean | true | ✗ 🔧 | Discover accordions |
| `discoverDropdowns` | boolean | true | ✗ 🔧 | Discover dropdowns |

**⚠️ Warning:** **DISABLED by default** - Can cause tab crashes. Enable only for SPA-heavy sites.

---

### 1.22 Smart Wait (`crawler.smartWait`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✗ 🔧 | Enable smart wait strategies |
| `networkIdle` | boolean | true | ✗ 🔧 | Wait for network idle |
| `networkIdleTime` | number | 500 | ✗ 🔧 | Network idle timeout (ms) |
| `waitForElements` | boolean | true | ✗ 🔧 | Wait for elements |
| `frameworks` | boolean | true | ✗ 🔧 | Wait for framework hydration |
| `timeout` | number | 30000 | ✗ 🔧 | Max wait time (ms) |
| `minWait` | number | 500 | ✗ 🔧 | Minimum wait time (ms) |

**Purpose:** Intelligent waiting instead of fixed delays. Waits for:
- Network requests to complete
- DOM to become stable
- React/Vue/Angular frameworks to hydrate

---

### 1.23 Storage (`crawler.storage`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `storageType` | string | "indexeddb" | ✗ 🔧 | Storage backend |
| `dbName` | string | "QAtalystEmbeddings" | ✗ 🔧 | IndexedDB database name |
| `dbVersion` | number | 1 | ✗ 🔧 | Database version |
| `maxStorageSize` | number | 52428800 | ✗ 🔧 | Max storage size (50MB) |
| `compressionEnabled` | boolean | true | ✗ 🔧 | Enable compression |

---

### 1.24 Use Crawled Data in Test Generation

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `useCrawledDataForTests` | boolean | true | ✅ | Use crawled app context in test generation |

**When enabled:**
- ✅ LLM receives app context (forms, buttons, APIs)
- ✅ Tests reference actual app features
- ✅ 30-50% more realistic test cases

**When disabled:**
- ❌ App context not extracted
- ❌ Tests generated purely from ticket description

---

## 2. EMBEDDINGS CONFIGURATION ⚠️

**Status:** DISABLED by default

Vector embeddings are currently disabled due to Chrome Manifest V3 CSP restrictions that prevent local ML libraries (Transformers.js, TensorFlow.js) from running.

### 2.1 Provider (`embeddings.provider`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `default` | string | "jina" | ✗ | Default embedding provider |
| `options` | array | ["jina", "openai", "chrome-ai"] | ✗ | Available providers |
| `fallbackOrder` | array | ["jina", "openai", "chrome-ai"] | ✗ | Fallback order |

---

### 2.2 Models (`embeddings.models`)

#### Jina AI (Recommended - FREE)
```json
"jina": {
  "model": "jina-embeddings-v3",
  "dimensions": 1024,
  "batchSize": 2048,
  "costPer1MTokens": 0,
  "freeTier": "10 million tokens for new users",
  "endpoint": "https://api.jina.ai/v1/embeddings"
}
```

#### OpenAI (Paid)
```json
"openai": {
  "model": "text-embedding-3-small",
  "dimensions": 1536,
  "batchSize": 100,
  "costPer1MTokens": 0.02,
  "endpoint": "https://api.openai.com/v1/embeddings"
}
```

#### Chrome AI (Experimental)
```json
"chromeAI": {
  "model": "gemini-nano",
  "dimensions": 768,
  "enabled": false
}
```
**Note:** Chrome Canary/Dev only, experimental

---

### 2.3 Search (`embeddings.search`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `topK` | number | 5 | ✗ | Top K results |
| `minScore` | number | 0.3 | ✗ | Minimum similarity score |
| `maxResults` | number | 10 | ✗ | Maximum results |
| `cacheEnabled` | boolean | true | ✗ | Enable search cache |
| `cacheSize` | number | 100 | ✗ | Cache size |

---

### 2.4 Export (`embeddings.export`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `formats` | array | ["json", "binary"] | ✗ | Export formats |
| `defaultFormat` | string | "json" | ✗ | Default export format |
| `compression` | boolean | true | ✗ | Enable compression |
| `includeMetadata` | boolean | true | ✗ | Include metadata |

---

## 3. NETWORK MONITORING

### 3.1 Network Capture (`network.capture`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `requests` | boolean | true | ✗ | Capture HTTP requests |
| `responses` | boolean | true | ✗ | Capture HTTP responses |
| `headers` | boolean | true | ✗ | Capture headers |
| `payloads` | boolean | true | ✗ | Capture request/response payloads |
| `timing` | boolean | true | ✗ | Capture timing information |

---

### 3.2 Network Filters (`network.filters`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `captureAPIs` | boolean | true | ✗ | Capture API calls |
| `captureGraphQL` | boolean | true | ✗ | Capture GraphQL queries |
| `captureREST` | boolean | true | ✗ | Capture REST API calls |
| `ignoreStatic` | boolean | true | ✗ | Ignore static resources |
| `maxPayloadSize` | number | 10240 | ✗ | Max payload size to capture (10KB) |

---

### 3.3 API Endpoints (`network.endpoints`)

**API patterns to capture:**
```json
"apiPatterns": ["/api/", "/rest/", "/graphql", "/v1/", "/v2/"]
```

**Patterns to exclude:**
```json
"excludePatterns": [
  "google-analytics",
  "doubleclick",
  "facebook.com",
  "twitter.com",
  "hotjar",
  "mixpanel",
  "segment.io"
]
```

---

## 4. DOM EXTRACTION

### 4.1 Text Content (`domExtraction.textContent`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✗ 🔧 | Enable text extraction |
| `maxLength` | number | 4000 | ✗ 🔧 | Max text length (chars) |

**Memory optimized:** Reduced from 5000 to 4000 chars.

---

### 4.2 Forms (`domExtraction.features.forms`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✗ 🔧 | Extract forms |
| `maxForms` | number | 10 | ✗ 🔧 | Max forms per page |
| `captureValidation` | boolean | true | ✗ 🔧 | Capture validation rules |
| `captureFields` | boolean | true | ✗ 🔧 | Capture form fields |

---

### 4.3 Tables (`domExtraction.features.tables`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✗ 🔧 | Extract tables |
| `maxTables` | number | 10 | ✗ 🔧 | Max tables per page |
| `captureHeaders` | boolean | true | ✗ 🔧 | Capture table headers |
| `captureActions` | boolean | true | ✗ 🔧 | Capture action buttons |
| `minRows` | number | 1 | ✗ 🔧 | Minimum rows to extract |

---

### 4.4 Buttons (`domExtraction.features.buttons`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✗ 🔧 | Extract buttons |
| `maxButtons` | number | 50 | ✗ 🔧 | Max buttons per page |
| `captureDisabled` | boolean | true | ✗ 🔧 | Capture disabled buttons |
| `captureActions` | boolean | false | ✗ 🔧 | Capture button actions |

---

### 4.5 Navigation (`domExtraction.features.navigation`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✗ 🔧 | Extract navigation |
| `maxItems` | number | 20 | ✗ 🔧 | Max nav items per page |
| `captureSubmenus` | boolean | true | ✗ 🔧 | Capture dropdown menus |

---

### 4.6 Modals (`domExtraction.features.modals`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✗ 🔧 | Extract modals |
| `maxModals` | number | 5 | ✗ 🔧 | Max modals per page |
| `captureHidden` | boolean | false | ✗ 🔧 | Capture hidden modals |

---

### 4.7 Cards (`domExtraction.features.cards`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✗ 🔧 | Extract card components |
| `maxCards` | number | 20 | ✗ 🔧 | Max cards per page |
| `maxContentLength` | number | 100 | ✗ 🔧 | Max content length per card |

---

### 4.8 Lists (`domExtraction.features.lists`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✗ 🔧 | Extract lists |
| `maxLists` | number | 10 | ✗ 🔧 | Max lists per page |
| `minItems` | number | 3 | ✗ 🔧 | Minimum items to extract |
| `maxItemsPerList` | number | 10 | ✗ 🔧 | Max items per list |

---

### 4.9 Selectors (`domExtraction.selectors`)

| Feature | Selectors |
|---------|-----------|
| Forms | `form` |
| Tables | `table` |
| Buttons | `button`, `a.btn`, `[role='button']` |
| Navigation | `nav`, `[role='navigation']` |
| Modals | `[role='dialog']`, `.modal`, `[aria-modal='true']` |

---

## 5. AI CONFIGURATION

### 5.1 Defaults (`ai.defaults`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `temperature` | number | 0.7 | ✅ | LLM temperature (0-2) |
| `maxTokens` | number | 16000 | ✅ | Max output tokens |
| `testCount` | number | 30 | ✅ | Default test count |
| `minTestCount` | number | 20 | ✗ | Minimum test count |
| `maxTestCount` | number | 100 | ✗ | Maximum test count |

---

### 5.2 Providers (`ai.providers`)

#### OpenAI
```json
"openai": {
  "enabled": true,                                    // ✅ UI
  "endpoint": "https://api.openai.com/v1/chat/completions",
  "defaultModel": "gpt-4o",                          // ✅ UI
  "models": ["gpt-4o", "gpt-4-turbo", ...]          // ✅ UI
}
```

#### Claude (Anthropic)
```json
"claude": {
  "enabled": true,                                    // ✅ UI
  "endpoint": "https://api.anthropic.com/v1/messages",
  "defaultModel": "claude-3-5-sonnet-20241022",      // ✅ UI
  "models": ["claude-3-5-sonnet-20241022", ...]     // ✅ UI
}
```

#### Gemini (Google)
```json
"gemini": {
  "enabled": true,                                    // ✅ UI
  "endpoint": "https://generativelanguage.googleapis.com/v1beta/models",
  "defaultModel": "gemini-2.0-flash-exp",            // ✅ UI
  "models": ["gemini-2.0-flash-exp", ...]           // ✅ UI
}
```

---

### 5.3 Streaming (`ai.streaming`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✅ | Enable response streaming |
| `chunkSize` | number | 1024 | ✗ | Chunk size (bytes) |
| `timeout` | number | 90000 | ✗ | Streaming timeout (90s) |

---

### 5.4 Multi-Agent System (`ai.multiAgent`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✅ | Enable multi-agent system |

**Agent toggles (all in UI):**
- ✅ `enablePositiveAgent` - Positive test cases
- ✅ `enableNegativeAgent` - Negative test cases
- ✅ `enableEdgeAgent` - Edge case tests
- ✅ `enableRegressionAgent` - Regression tests
- ✅ `enableIntegrationAgent` - Integration tests
- ✅ `enableReviewAgent` - Quality review

**Test distribution (hidden):**
```json
"distribution": {
  "positive": 0.40,      // 40%
  "negative": 0.30,      // 30%
  "edge": 0.20,          // 20%
  "regression": 0.05,    // 5%
  "integration": 0.05    // 5%
}
```

---

## 6. EVOLUTIONARY OPTIMIZATION

### 6.1 Evolution Settings (`evolution`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✅ | Enable evolutionary optimization |
| `intensity.default` | string | "balanced" | ✅ | Default intensity level |

---

### 6.2 Intensity Levels (`evolution.intensity.options`)

#### Light (Fast)
```json
"light": {
  "generations": 3,
  "populationSize": 3,
  "mutationRate": 0.3
}
```
**Time:** ~10-15 seconds

#### Balanced (Recommended)
```json
"balanced": {
  "generations": 5,
  "populationSize": 5,
  "mutationRate": 0.4
}
```
**Time:** ~20-30 seconds

#### Intensive (Thorough)
```json
"intensive": {
  "generations": 8,
  "populationSize": 7,
  "mutationRate": 0.5
}
```
**Time:** ~40-50 seconds

#### Exhaustive (Maximum Coverage)
```json
"exhaustive": {
  "generations": 10,
  "populationSize": 10,
  "mutationRate": 0.6
}
```
**Time:** ~80-100 seconds

---

### 6.3 Mutation Strategies (`evolution.mutations`)

All mutation strategies are enabled:
1. `dataVariation` - Explore input combinations
2. `scenarioExpansion` - Add alternative paths
3. `boundaryTesting` - Min/max/null conditions
4. `errorInjection` - Invalid inputs, timeouts
5. `contextShifting` - Different users/environments

---

## 7. INTEGRATIONS

### 7.1 Confluence (`integrations.confluence`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | false | ✅ | Enable Confluence integration |
| `url` | string | "" | ✅ | Confluence base URL |
| `email` | string | "" | ✅ | Confluence email |
| `token` | string | "" | ✅ | Confluence API token |
| `autoFetch` | boolean | true | ✗ | Auto-fetch linked pages |
| `timeout` | number | 10000 | ✗ | Request timeout (10s) |
| `maxPages` | number | 5 | ✗ | Max pages to fetch |

---

### 7.2 Figma (`integrations.figma`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | false | ✅ | Enable Figma integration |
| `token` | string | "" | ✅ | Figma personal access token |
| `imageMode` | string | "single" | ✅ | Image extraction mode |
| `maxImages` | number | 50 | ✗ | Max images per file |
| `minImageSizeKB` | number | 5 | ✗ | Min image size (5KB) |
| `rateLimitDelay` | number | 1000 | ✗ | Rate limit delay (1s) |

**Image modes:**
- `single` - One combined screenshot
- `children` - Individual frame screenshots

---

### 7.3 Google Docs (`integrations.googleDocs`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | false | ✅ | Enable Google Docs integration |
| `apiKey` | string | "" | ✅ | Google Cloud API key |
| `authMode` | string | "public" | ✅ | Authentication mode |
| `clientId` | string | "" | ✅ | OAuth client ID |
| `clientSecret` | string | "" | ✅ | OAuth client secret |
| `projectId` | string | "" | ✅ | Google Cloud project ID |
| `timeout` | number | 10000 | ✗ | Request timeout (10s) |

---

### 7.4 TestRail (`integrations.testrail`) 🚧

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | false | ✗ | Enable TestRail integration |
| `exportFormat` | string | "xml" | ✗ | Export format |

**Status:** Coming soon

---

## 8. USER INTERFACE

### 8.1 Panel (`ui.panel`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `width` | string | "400px" | ✗ | Panel width |
| `position` | string | "right" | ✗ | Panel position |
| `animationDuration` | number | 300 | ✗ | Animation duration (ms) |

---

### 8.2 Display (`ui.display`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `maxTextLength` | number | 10000 | ✗ | Max text display length |
| `debounceDelay` | number | 500 | ✗ | Input debounce delay (ms) |
| `showProgress` | boolean | true | ✗ | Show progress indicators |
| `showTimestamps` | boolean | true | ✗ | Show timestamps |

---

### 8.3 Notifications (`ui.notifications`)

| Setting | Type | Default | UI | Description |
|---------|------|---------|---:|-------------|
| `enabled` | boolean | true | ✗ | Enable notifications |
| `duration` | number | 5000 | ✗ | Notification duration (5s) |
| `position` | string | "top-right" | ✗ | Notification position |

---

## 9. SECURITY

### 9.1 Encryption (`security.encryption`)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `algorithm` | string | "AES-GCM" | Encryption algorithm |
| `keyLength` | number | 256 | Key length (bits) |
| `ivLength` | number | 12 | IV length (bytes) |
| `saltLength` | number | 16 | Salt length (bytes) |
| `iterations` | number | 100000 | PBKDF2 iterations |

---

### 9.2 Sanitization (`security.sanitization`)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | true | Enable HTML sanitization |

**Allowed HTML tags:**
```json
"allowedTags": [
  "p", "br", "strong", "em", "ul", "ol", "li",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "code", "pre", "a", "span", "div"
]
```

**Allowed attributes:**
```json
"allowedAttributes": ["class", "id", "href", "target"]
```

---

### 9.3 Storage Security (`security.storage`)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `encryptAPIKeys` | boolean | true | Encrypt API keys |
| `encryptEmbeddings` | boolean | false | Encrypt embeddings |

---

## 10. PERFORMANCE

### 10.1 Timeouts (`performance.timeouts`)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `request` | number | 90000 | AI request timeout (90s) |
| `retry` | number | 2000 | Retry delay (2s) |
| `maxRetries` | number | 2 | Max retry attempts |

---

### 10.2 Limits (`performance.limits`)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `maxTextExtractLength` | number | 30000 | Max text extraction length |
| `maxConcurrentRequests` | number | 5 | Max concurrent AI requests |

---

### 10.3 Cache (`performance.cache`)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | true | Enable response caching |
| `ttl` | number | 3600000 | Cache TTL (1 hour) |
| `maxSize` | number | 100 | Max cache entries |

---

## 11. LOGGING

### 11.1 Logging Configuration (`logging`)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabled` | boolean | true | Enable logging |
| `level` | string | "info" | Log level |
| `levels` | array | ["debug", "info", "warn", "error"] | Available levels |
| `console` | boolean | true | Log to console |
| `storage` | boolean | false | Log to storage |
| `maxLogs` | number | 1000 | Max logs to store |

**Log levels:**
- `debug` - Detailed debugging info
- `info` - General information
- `warn` - Warning messages
- `error` - Error messages

---

## 12. FEATURE FLAGS

### 12.1 Experimental Features (`features.experimental`)

| Feature | Default | Description |
|---------|---------|-------------|
| `chromeAI` | false | Chrome Built-in AI (Gemini Nano) |
| `interactiveCrawling` | false | Click-based interactive crawling |
| `visualRegression` | false | Visual regression testing |
| `autoRecrawl` | false | Automatic periodic recrawling |

**⚠️ Warning:** Experimental features may be unstable.

---

### 12.2 Beta Features (`features.beta`)

| Feature | Default | Description |
|---------|---------|-------------|
| `enhancedSPADetection` | true | Improved SPA framework detection |
| `sitemapParsing` | true | Sitemap.xml parsing |
| `incrementalCrawl` | true | Skip unchanged pages |

---

## 📝 How to Modify Configuration

### Method 1: UI Settings (Recommended)
1. Right-click extension icon → Options
2. Navigate to appropriate tab
3. Change settings
4. Click "Save All Settings"

**Available in UI:**
- AI provider settings (temperature, models, tokens)
- Agent toggles and percentages
- Evolution settings
- Integration credentials
- Crawler settings (duplicate detection, parameterized URLs)

---

### Method 2: Direct config.json Edit (Advanced)

1. Navigate to extension directory:
   ```
   chrome-extension://<extension-id>/
   ```

2. Edit `config.json`

3. Reload extension:
   ```
   chrome://extensions → Click reload
   ```

**⚠️ Warning:**
- Invalid JSON will break the extension
- Backup config.json before editing
- Most changes require extension reload

---

## 🎯 Common Configuration Scenarios

### Scenario 1: Faster Crawling (Small Sites)
```json
{
  "crawler.limits.maxPages": 500,
  "crawler.parallel.maxTabs": 5,
  "crawler.delays.betweenPages": 100,
  "crawler.duplicateDetection.enabled": true
}
```

### Scenario 2: Thorough Crawling (Large Sites)
```json
{
  "crawler.limits.maxPages": 5000,
  "crawler.parallel.maxTabs": 3,
  "crawler.duplicateDetection.maxSamplesPerPattern": 3,
  "crawler.selective.skipNonInteractive": false
}
```

### Scenario 3: Memory-Constrained Environment
```json
{
  "crawler.limits.maxPages": 500,
  "crawler.parallel.maxTabs": 2,
  "crawler.streamingSave.batchSize": 100,
  "crawler.caching.maxCacheSize": 50,
  "domExtraction.textContent.maxLength": 2000
}
```

### Scenario 4: SPA-Heavy Application
```json
{
  "crawler.spaDetection.enabled": true,
  "crawler.spaDetection.hydrationWait": 5000,
  "crawler.smartWait.enabled": true,
  "crawler.smartWait.frameworks": true,
  "crawler.timeouts.navigation.heavy": 90000
}
```

### Scenario 5: Disable All Duplicate Detection
```json
{
  "crawler.duplicateDetection.enabled": false,
  "crawler.duplicateDetection.detectParameterizedUrls": false
}
```
**Use case:** Small apps where you want every page crawled.

---

## 🔧 Troubleshooting Configuration Issues

### Issue: Extension Crashes During Crawl
**Solution:** Reduce memory usage
```json
{
  "crawler.limits.maxPages": 500,
  "crawler.parallel.maxTabs": 2,
  "crawler.streamingSave.batchSize": 100,
  "crawler.caching.maxCacheSize": 50,
  "crawler.spaDiscovery.enabled": false
}
```

### Issue: Missing Text Extraction
**Solution:** Increase text limits and wait times
```json
{
  "domExtraction.textContent.maxLength": 8000,
  "crawler.smartWait.enabled": true,
  "crawler.spaDetection.hydrationWait": 5000
}
```

### Issue: Too Many Duplicate URLs Crawled
**Solution:** Enable all duplicate detection features
```json
{
  "crawler.duplicateDetection.enabled": true,
  "crawler.duplicateDetection.detectParameterizedUrls": true,
  "crawler.duplicateDetection.maxSamplesPerPattern": 1,
  "crawler.duplicateDetection.similarityThreshold": 0.95
}
```

### Issue: Slow Crawling
**Solution:** Increase parallelization and reduce waits
```json
{
  "crawler.parallel.maxTabs": 5,
  "crawler.delays.betweenPages": 100,
  "crawler.delays.pageLoad": 500,
  "crawler.smartWait.networkIdleTime": 300
}
```

---

## 📚 Additional Resources

- **Help Documentation:** Options → Help & Docs tab
- **Feature Flags Guide:** See `PARAMETERIZED_URL_FEATURE_FLAGS.md`
- **Memory Optimizations:** See `MEMORY_OPTIMIZATIONS.md`
- **Duplicate Detection:** See `DUPLICATE_DETECTION_ANALYSIS.md`

---

## 🔄 Version History

### v11.1.0 (Current)
- Added comprehensive CONFIG.md documentation
- Added `useCrawledDataForTests` feature flag in UI
- Added crawled app status indicator in UI
- Improved text extraction for modern SPAs
- Fixed UI alignment issues
- Memory and performance optimizations

### v11.0.0
- Intelligent web crawler with SPA support
- Duplicate detection and parameterized URL handling
- Knowledge graph generation and merging
- Context-aware test generation
- Memory optimizations (70% reduction)

---

**Last Updated:** November 2025
**Configuration Version:** 11.1.0
