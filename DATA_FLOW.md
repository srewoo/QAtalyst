# QAtalyst Data Flow Documentation

## What Data is Sent to LLM?

### 1. Data Extracted from Jira Page

The extension scrapes the following from the current Jira ticket:

```javascript
{
  key: "PROJ-123",                    // Ticket key
  summary: "Add user authentication", // Ticket title
  description: "Full description...", // Description field
  comments: [                         // All comments
    {
      id: 1,
      author: "John Doe",
      text: "Comment text...",
      timestamp: "2025-10-29"
    }
  ],
  attachments: [                      // All attachments
    {
      id: 1,
      name: "design.png",
      url: "https://...",
      type: "image"
    }
  ],
  linkedPages: [                      // All external links found
    {
      id: 1,
      title: "Requirements Doc",
      url: "https://confluence.../page",
      type: "confluence"
    }
  ]
}
```

### 2. External Content Fetching (If Configured)

**YES - The extension DOES make actual API calls!**

If you have configured API keys/tokens in settings, the extension will:

#### Confluence Integration
- **Detects:** Links matching `*.atlassian.net/wiki/*` or `*.confluence.*`
- **API Call:** `GET {confluenceUrl}/rest/api/content/{pageId}?expand=body.storage`
- **Authentication:** Bearer token from settings
- **Extracted:** Page title, HTML content (converted to text)

#### Figma Integration  
- **Detects:** Links matching `figma.com/file/*` or `figma.com/proto/*`
- **API Call:** `GET https://api.figma.com/v1/files/{fileKey}`
- **Authentication:** X-Figma-Token header
- **Extracted:** File name, page names, frame names, component descriptions
- **Rate Limiting:** Auto-retries with backoff on 429 errors

#### Google Docs Integration
- **Detects:** Links matching `docs.google.com/document/d/*`
- **API Call:** `GET https://docs.googleapis.com/v1/documents/{docId}?key={apiKey}`
- **Authentication:** API key in URL
- **Extracted:** Document title, full text content

### 3. What LLM Receives

#### For Analyze Requirements:
```
**Ticket:** PROJ-123
**Summary:** Add user authentication
**Description:** [Original description]

[IF EXTERNAL SOURCES FETCHED:]
## Confluence Requirements:
[Full Confluence page content]

## Figma Design Specifications:
# Design Name
- Page: Login Screen
- Frame: Login Form (320x500)
- Components: Email Input, Password Input, Submit Button

## Google Docs Content:
[Full Google Doc text]

**Comments:** 5 comments
**Attachments:** 2 files
**Linked Pages:** 3 pages
**External Sources:** 1 Confluence, 1 Figma, 1 Google Docs
```

#### For Generate Test Scope:
- Same data PLUS the requirement analysis result

#### For Generate Test Cases (Multi-Agent):
- Same data PLUS requirement analysis AND test scope

---

## API Call Flow

```
User clicks "Analyse Requirements"
    ↓
Content Script extracts Jira data
    ↓
Sends to Background Script
    ↓
Background checks: Do we have API keys?
    ├─ YES → IntegrationManager.fetchAllLinkedContent()
    │         ├─ Detect Confluence URLs → Make API call
    │         ├─ Detect Figma URLs → Make API call (with retry)
    │         └─ Detect Google Docs URLs → Make API call
    │         ↓
    │         Append fetched content to description
    │
    └─ NO → Skip integration fetching
    ↓
Send enriched data to LLM (OpenAI/Claude/Gemini)
    ↓
Display analysis results
```

---

## Example Real API Calls

### Confluence:
```http
GET https://your-company.atlassian.net/rest/api/content/123456?expand=body.storage
Authorization: Bearer YOUR_CONFLUENCE_TOKEN
Accept: application/json
```

### Figma:
```http
GET https://api.figma.com/v1/files/abc123xyz
X-Figma-Token: YOUR_FIGMA_TOKEN
```

### Google Docs:
```http
GET https://docs.googleapis.com/v1/documents/1a2b3c4d?key=YOUR_GOOGLE_API_KEY
```

---

## Privacy & Security

### What is NOT sent:
- ❌ Your API keys (used only for authentication, not sent to LLM)
- ❌ Jira credentials
- ❌ Other tickets/projects
- ❌ Browser history
- ❌ Personal data outside the ticket

### What IS sent to AI provider:
- ✅ Ticket summary & description
- ✅ Comments text
- ✅ Attachment filenames (not files themselves)
- ✅ Linked page URLs
- ✅ Fetched Confluence/Figma/Google Docs content (if configured)

---

## Configuration Required

| Integration | Settings Needed | Auto-fetching Enabled? |
|-------------|----------------|----------------------|
| **Confluence** | URL + API Token | If both configured |
| **Figma** | Personal Access Token | If configured |
| **Google Docs** | API Key | If configured |
| **None** | - | Never (just sends Jira data) |

---

## Summary

**YES, the extension makes REAL API calls** to Confluence, Figma, and Google Docs:
1. When links are detected in ticket description/comments
2. When corresponding API keys/tokens are configured
3. Content is fetched and appended to description before sending to LLM
4. LLM receives the enriched description for better context

This gives the AI much more context to generate accurate test cases!
