/**
 * content-ticket.js — reading the open Jira ticket: settings decryption, the
 * REST fetch of the issue, and DOM fallbacks for description, comments,
 * attachments, inline images and linked pages. Moved verbatim out of content.js.
 *
 * Content scripts share one global scope, so this is an IIFE that publishes an
 * explicit api on window. Depends on globals from security.js
 * (securityManager), config.js (APP_CONFIG) and content-utils.js.
 */
(function () {
  'use strict';

  // Helper function to load and decrypt settings
  async function loadAndDecryptSettings(keys) {
    // Every caller that loads the provider also needs where it lives and how the
    // run is checked. The per-handler key lists omitted these, so a configured
    // Ollama URL was ignored (generation hit localhost:11434) and the accuracy
    // opt-outs never reached the worker. Added once, here.
    const withProvider = Array.isArray(keys) && keys.includes('llmProvider')
      ? [...new Set([...keys, 'ollamaBaseUrl', 'openaiBaseUrl', 'strictGrounding', 'enableCoverageJudge',
          'enableAssertionCritic', 'assertionCriticStrict'])]
      : keys;
    const settings = await chrome.storage.sync.get(withProvider);

    // Decrypt sensitive tokens using the wrapper method that handles plain text gracefully
    if (settings.apiKey) {
      settings.apiKey = await securityManager.decryptApiKeyFromStorage(settings.apiKey);
    }
    if (settings.jiraApiToken) {
      settings.jiraApiToken = await securityManager.decryptApiKeyFromStorage(settings.jiraApiToken);
    }
    if (settings.confluenceToken) {
      settings.confluenceToken = await securityManager.decryptApiKeyFromStorage(settings.confluenceToken);
    }
    if (settings.figmaToken) {
      settings.figmaToken = await securityManager.decryptApiKeyFromStorage(settings.figmaToken);
    }
    if (settings.googleApiKey) {
      settings.googleApiKey = await securityManager.decryptApiKeyFromStorage(settings.googleApiKey);
    }
    if (settings.testrailApiKey) {
      settings.testrailApiKey = await securityManager.decryptApiKeyFromStorage(settings.testrailApiKey);
    }
    if (settings.bedrockSecretKey) {
      settings.bedrockSecretKey = await securityManager.decryptApiKeyFromStorage(settings.bedrockSecretKey);
    }
    if (settings.bedrockSessionToken) {
      settings.bedrockSessionToken = await securityManager.decryptApiKeyFromStorage(settings.bedrockSessionToken);
    }

    // Confluence lives on the same Atlassian instance as Jira and shares the same
    // API token, so the separate Confluence settings were removed. Derive the
    // Confluence creds from the Jira creds (when not explicitly set) so Confluence
    // links still resolve for enrichment.
    if (!settings.confluenceUrl && settings.jiraBaseUrl) settings.confluenceUrl = settings.jiraBaseUrl;
    if (!settings.confluenceEmail && settings.jiraEmail) settings.confluenceEmail = settings.jiraEmail;
    if (!settings.confluenceToken && settings.jiraApiToken) settings.confluenceToken = settings.jiraApiToken;

    return settings;
  }

  // Fetch ticket data from Jira REST API
  async function fetchTicketDataFromAPI(ticketKey) {
    try {
      // Load Jira credentials
      const settings = await loadAndDecryptSettings(['jiraBaseUrl', 'jiraEmail', 'jiraApiToken', 'jiraAcFieldId']);

      if (!settings.jiraEmail || !settings.jiraApiToken) {
        console.log('🔑 Jira API credentials not configured, will use DOM scraping');
        return null;
      }

      // Get Jira base URL from settings, fallback to current page
      const jiraBaseUrl = settings.jiraBaseUrl || window.location.origin;

      console.log('🌐 Fetching ticket data from Jira API:', ticketKey);

      // Fetch ticket data. `expand=names` returns the human-readable display
      // name for every field (incl. customfield_*) so we can auto-detect an
      // "Acceptance Criteria" custom field without hard-coded field IDs (F2).
      const response = await fetch(`${jiraBaseUrl}/rest/api/3/issue/${ticketKey}?expand=names`, {
        method: 'GET',
        headers: {
          'Authorization': 'Basic ' + btoa(`${settings.jiraEmail}:${settings.jiraApiToken}`),
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        console.warn(`⚠️ Jira API request failed: ${response.status} ${response.statusText}`);
        return null;
      }

      const issueData = await response.json();
      console.log('✅ Successfully fetched ticket data from Jira API');

      const f = issueData.fields || {};

      // Extract and format data
      const data = {
        key: issueData.key,
        summary: f.summary || '',
        description: extractTextFromADF(f.description) || '',
        // Issue type drives Epic Mode (generate per child story).
        issueType: f.issuetype?.name || '',
        comments: [],
        attachments: [],
        linkedPages: [],
        // F2: ticket metadata that carries scope/grounding signal.
        issueLinks: [],
        parent: null,
        labels: Array.isArray(f.labels) ? f.labels : [],
        components: Array.isArray(f.components) ? f.components.map(c => c?.name).filter(Boolean) : [],
        priority: f.priority?.name || '',
        status: f.status?.name || '',
        fixVersions: Array.isArray(f.fixVersions) ? f.fixVersions.map(v => v?.name).filter(Boolean) : [],
        acceptanceCriteria: ''
      };

      // Issue-links panel (linked bugs / blocks / relates-to) — same shape and
      // direction handling as the Epic path (F2). Previously invisible for a
      // normal story, hiding linked defects/duplicates from generation.
      data.issueLinks = (f.issuelinks || []).map((l) => {
        const linked = l.outwardIssue || l.inwardIssue;
        if (!linked) return null;
        const rel = l.outwardIssue ? (l.type?.outward || 'relates to') : (l.type?.inward || 'relates to');
        return { key: linked.key, summary: linked.fields?.summary || '', type: rel, status: linked.fields?.status?.name || '' };
      }).filter(Boolean);

      // Parent / epic context.
      if (f.parent) {
        data.parent = {
          key: f.parent.key,
          summary: f.parent.fields?.summary || '',
          issueType: f.parent.fields?.issuetype?.name || ''
        };
      }

      // Acceptance criteria: prefer a configured custom-field id, else auto-detect
      // any custom field whose display name mentions "acceptance criteria" (F2/F5).
      let acFieldId = settings.jiraAcFieldId || '';
      try {
        const names = issueData.names || {};
        if (!acFieldId) {
          acFieldId = Object.keys(names).find(id =>
            /^customfield_/.test(id) && /accept(ance)?\s*criteria|^ac$|acceptance/i.test(names[id] || '')
          ) || '';
        }
        if (acFieldId && f[acFieldId] != null) {
          data.acceptanceCriteria = extractTextFromADF(f[acFieldId]) || (typeof f[acFieldId] === 'string' ? f[acFieldId] : '');
        }
      } catch (e) {
        console.warn('⚠️ AC custom-field detection failed:', e.message);
      }

      // Parent story / epic: its description and acceptance criteria. A sub-task's
      // criteria usually live on the parent story, and an epic child's on itself
      // plus the epic's intent. Only the key and title were loaded before.
      if (data.parent && data.parent.key) {
        try {
          const pf = ['summary', 'description', 'issuetype', acFieldId].filter(Boolean).join(',');
          const pr = await fetch(`${jiraBaseUrl}/rest/api/3/issue/${encodeURIComponent(data.parent.key)}?fields=${pf}`, {
            method: 'GET',
            headers: {
              'Authorization': 'Basic ' + btoa(`${settings.jiraEmail}:${settings.jiraApiToken}`),
              'Accept': 'application/json'
            }
          });
          if (pr.ok) {
            const pj = await pr.json();
            const ff = pj.fields || {};
            data.parent.description = (extractTextFromADF(ff.description) || '').slice(0, 6000);
            if (acFieldId && ff[acFieldId] != null) {
              data.parent.acceptanceCriteria = extractTextFromADF(ff[acFieldId]) || (typeof ff[acFieldId] === 'string' ? ff[acFieldId] : '');
            }
          }
        } catch (e) {
          console.warn('⚠️ Parent issue context could not be loaded:', e.message);
        }
      }

      // Extract comments
      if (issueData.fields.comment && issueData.fields.comment.comments) {
        data.comments = issueData.fields.comment.comments.map((comment, index) => ({
          id: index + 1,
          author: comment.author?.displayName || 'Unknown',
          text: extractTextFromADF(comment.body) || '',
          timestamp: comment.created || ''
        }));
      }

      // Extract attachments — flag images and documents for downstream processing
      if (issueData.fields.attachment) {
        data.attachments = issueData.fields.attachment.map((att, index) => {
          const name = att.filename || 'Unknown';
          const ext = name.split('.').pop().toLowerCase();
          const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'];
          const docExts = ['pdf', 'txt', 'md', 'csv', 'doc', 'docx', 'log', 'json', 'xml'];
          return {
            id: index + 1,
            fileName: name,
            name,
            url: att.content || '',
            mimeType: att.mimeType || '',
            size: att.size || 0,
            isImage: imageExts.includes(ext) || (att.mimeType || '').startsWith('image/'),
            isDocument: docExts.includes(ext) || (att.mimeType || '').includes('pdf')
              || (att.mimeType || '').includes('text/')
          };
        });
      }

      return data;
    } catch (error) {
      console.error('❌ Error fetching from Jira API:', error);
      return null;
    }
  }

  // Extract all visible text from DOM using TreeWalker
  function extractVisibleText(rootElement = document.body) {
    const walker = document.createTreeWalker(rootElement, NodeFilter.SHOW_TEXT, {
      acceptNode: function(node) {
        // Skip text nodes inside invisible elements
        if (!node.parentElement) return NodeFilter.FILTER_REJECT;
        const style = window.getComputedStyle(node.parentElement);
        if (style.visibility === 'hidden' || style.display === 'none') {
          return NodeFilter.FILTER_REJECT;
        }
        // Skip empty or whitespace-only nodes
        if (!node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    let text = '';

    while ((node = walker.nextNode())) {
      text += node.textContent.trim() + ' ';
    }

    return text.trim();
  }

  // Extract ticket key from URL
  function extractTicketKey() {
    const match = window.location.pathname.match(/\/browse\/([A-Z]+-\d+)/);
    return match ? match[1] : 'Unknown';
  }

  // Debug helper: Find description element on page
  window.debugDescriptionSelector = function() {
    console.log('🔍 Searching for description element...');
    const selectors = [
      '[data-testid="issue.views.issue-base.foundation.description.description-content"]',
      '#description-val',
      '[data-test-id="issue.views.field.rich-text.description"]',
      '.description-content',
      '.user-content-block',
      '[data-testid*="description"]',
      '[id*="description"]',
      '.ak-renderer-document'
    ];

    selectors.forEach(sel => {
      const el = document.querySelector(sel);
      if (el) {
        console.log(`✅ Found with selector: "${sel}"`);
        console.log('   Text preview:', el.innerText?.substring(0, 100) || el.textContent?.substring(0, 100));
      } else {
        console.log(`❌ Not found: "${sel}"`);
      }
    });

    // Also search for any element with "description" in data attributes
    const allWithDesc = document.querySelectorAll('[data-testid*="description"], [data-test-id*="description"]');
    console.log(`\n📊 Found ${allWithDesc.length} elements with "description" in data attributes:`);
    allWithDesc.forEach((el, i) => {
      console.log(`  ${i + 1}. ${el.tagName} - testid: ${el.getAttribute('data-testid') || el.getAttribute('data-test-id')}`);
    });
  };
  
  // Extract ticket data
  async function extractTicketData() {
    const ticketKey = extractTicketKey();

    // Try Jira API first
    console.log('🔄 Attempting to fetch ticket data from Jira API...');
    const apiData = await fetchTicketDataFromAPI(ticketKey);

    if (apiData) {
      console.log('✅ Using data from Jira API');

      // API path doesn't extract linked pages from the DOM — do it now
      // so Confluence/Figma/Google Docs links on the page are captured
      apiData.linkedPages = extractLinkedPages();
      console.log(`🔗 Extracted ${apiData.linkedPages.length} linked pages from DOM for API data`);

      // Debug logging
      console.log('========== JIRA API DATA DEBUG ==========');
      console.log('📝 Description from API:');
      console.log(apiData.description);
      console.log('\n💬 Comments from API:', apiData.comments.length);
      if (apiData.comments.length > 0) {
        apiData.comments.forEach((comment, index) => {
          console.log(`\n--- Comment ${index + 1} ---`);
          console.log(`Author: ${comment.author}`);
          console.log(`Text:`);
          console.log(comment.text);
        });
      }
      console.log('🔗 Linked Pages:', apiData.linkedPages.length);
      console.log('========================================');

      return apiData;
    }

    // Fallback to TreeWalker extraction (gets all visible text including URLs)
    console.log('⚠️ Falling back to TreeWalker text extraction');

    const data = {
      key: ticketKey,
      summary: '',
      description: '',
      comments: [],
      attachments: [],
      linkedPages: []
    };

    // Extract summary
    const summaryEl = document.querySelector('[data-testid="issue.views.issue-base.foundation.summary.heading"]') ||
                     document.querySelector('#summary-val');
    if (summaryEl) {
      data.summary = summaryEl.textContent.trim();
    }

    // Use TreeWalker to extract all visible text from the issue content area
    const issueContent = document.querySelector('[data-testid="issue.views.issue-base.foundation.details.issue-base"]') ||
                        document.querySelector('#issue-content') ||
                        document.querySelector('.issue-container') ||
                        document.querySelector('main') ||
                        document.body;

    console.log('📍 Extracting visible text from:', issueContent.tagName, issueContent.className);

    const extractedText = extractVisibleText(issueContent);

    data.description = extractedText;

    console.log('========== TREEWALKER EXTRACTION DEBUG ==========');
    console.log('📝 Extracted visible text:');
    console.log(data.description);
    console.log('\nText length:', data.description.length, 'characters');
    console.log('========================================');

    // Try to extract comments separately
    data.comments = extractComments();

    // Extract attachments
    data.attachments = extractAttachments();

    // Extract linked pages
    data.linkedPages = extractLinkedPages();

    // Final summary
    console.log('========== TICKET DATA SUMMARY ==========');
    console.log('Ticket Key:', data.key);
    console.log('Summary:', data.summary);
    console.log('Description Length:', data.description.length, 'characters');
    console.log('Comments Count:', data.comments.length);
    console.log('Attachments Count:', data.attachments.length);
    console.log('Linked Pages Count:', data.linkedPages.length);
    console.log('========================================');

    return data;
  }
  
  // Extract comments from ticket
  function extractComments() {
    const comments = [];
    
    // Try multiple selectors for different Jira versions
    const commentElements = document.querySelectorAll(
      '[data-testid="issue.activity.comment"],' +
      '.activity-comment,' +
      '.issue-data-block-comment'
    );
    
    commentElements.forEach((commentEl, index) => {
      const authorEl = commentEl.querySelector('[data-testid="issue.activity.comment.author"]') ||
                      commentEl.querySelector('.comment-author') ||
                      commentEl.querySelector('.author');
      
      const bodyEl = commentEl.querySelector('[data-testid="issue.activity.comment.body"]') ||
                    commentEl.querySelector('.comment-body') ||
                    commentEl.querySelector('.action-body');
      
      if (bodyEl) {
        // Use innerText to preserve URL format
        const commentText = bodyEl.innerText || bodyEl.textContent.trim();
        comments.push({
          id: index + 1,
          author: authorEl ? authorEl.textContent.trim() : 'Unknown',
          text: commentText,
          timestamp: extractCommentTimestamp(commentEl)
        });
      }
    });
    
    return comments;
  }
  
  // Extract comment timestamp
  function extractCommentTimestamp(commentEl) {
    const timeEl = commentEl.querySelector('time') ||
                   commentEl.querySelector('[data-testid="issue.activity.comment.timestamp"]') ||
                   commentEl.querySelector('.comment-time');
    
    return timeEl ? timeEl.getAttribute('datetime') || timeEl.textContent.trim() : '';
  }
  
  // Extract attachments from ticket
  function extractAttachments() {
    const attachments = [];

    // Try multiple selectors for different Jira versions
    const attachmentElements = document.querySelectorAll(
      '[data-testid="issue.views.field.rich-text.attachments.attachment-item"],' +
      '.attachment-content,' +
      '.attachment-item,' +
      '[data-testid="media-card-view"]'
    );

    attachmentElements.forEach((attachEl, index) => {
      const linkEl = attachEl.querySelector('a') ||
                    attachEl.querySelector('[data-testid="media-card-link"]');

      const nameEl = attachEl.querySelector('.attachment-title') ||
                    attachEl.querySelector('[data-testid="media-card-title"]') ||
                    linkEl;

      if (linkEl) {
        const fileName = nameEl ? nameEl.textContent.trim() : 'Unknown';
        const fileType = extractFileType(fileName);

        attachments.push({
          id: index + 1,
          name: fileName,
          url: linkEl.href || '',
          type: fileType,
          isImage: fileType === 'image'
        });
      }
    });

    return attachments;
  }

  /**
   * Extract inline images embedded directly in Jira description/comments
   * These are images pasted directly into the rich text editor (not as attachments)
   * @returns {array} Array of {name, url, isInline} objects
   */
  function extractInlineImages() {
    const inlineImages = [];
    const processedUrls = new Set();

    // Selectors for inline images in Jira description and comments
    // Jira Cloud uses different structures for inline images
    const inlineImageSelectors = [
      // Jira Cloud - Description panel inline images
      '[data-testid="issue.views.field.rich-text.description"] img',
      '[data-testid="issue-description"] img',
      // Jira Cloud - Media elements in description
      '[data-testid="issue.views.field.rich-text.description"] [data-testid="media-image"]',
      '[data-testid="issue.views.field.rich-text.description"] [data-node-type="media"] img',
      '[data-testid="issue.views.field.rich-text.description"] [data-node-type="mediaSingle"] img',
      // Jira Server/Data Center
      '.user-content-block img',
      '.description-content img',
      '#description-val img',
      '.field-ignore-highlight img',
      // ADF (Atlassian Document Format) rendered content
      '.ak-renderer-document img',
      '[data-renderer-start-pos] img',
      // Comments section inline images
      '[data-testid="issue-activity-feed"] img',
      '.activity-comment img',
      '#activitymodule img',
      // Generic rich text areas
      '.rich-text-container img',
      '.wiki-content img'
    ];

    // Query all inline images
    const allInlineImages = document.querySelectorAll(inlineImageSelectors.join(','));

    console.log(`🔍 [InlineImages] Found ${allInlineImages.length} potential inline images`);

    allInlineImages.forEach((img, index) => {
      const src = img.src || img.getAttribute('data-src') || img.getAttribute('data-original');

      if (!src || processedUrls.has(src)) {
        return;
      }

      // Skip tiny images (likely icons, avatars, etc.)
      const width = img.naturalWidth || img.width || parseInt(img.getAttribute('width')) || 0;
      const height = img.naturalHeight || img.height || parseInt(img.getAttribute('height')) || 0;

      // Skip images smaller than 50x50 (likely icons)
      if ((width > 0 && width < 50) || (height > 0 && height < 50)) {
        console.log(`⏭️ [InlineImages] Skipping small image: ${width}x${height}`);
        return;
      }

      // Skip known non-content images (avatars, icons, emojis)
      const skipPatterns = [
        '/avatar/', '/avatars/',
        '/icons/', '/icon/',
        '/emoji/', '/emojis/',
        '/secure/useravatar',
        '/images/icons/',
        'emoticon',
        'avatar-small',
        'avatar-xsmall'
      ];

      if (skipPatterns.some(pattern => src.toLowerCase().includes(pattern))) {
        console.log(`⏭️ [InlineImages] Skipping non-content image: ${src.substring(0, 100)}`);
        return;
      }

      // Skip data URIs that are too small (base64 icons)
      if (src.startsWith('data:') && src.length < 500) {
        console.log(`⏭️ [InlineImages] Skipping small data URI`);
        return;
      }

      processedUrls.add(src);

      // Try to get a meaningful name
      const alt = img.alt || img.getAttribute('title') || '';
      const fileName = alt || `inline-image-${index + 1}`;

      inlineImages.push({
        id: `inline-${index + 1}`,
        name: fileName,
        url: src,
        type: 'image',
        isImage: true,
        isInline: true
      });

      console.log(`✅ [InlineImages] Found inline image: "${fileName}" (${src.substring(0, 80)}...)`);
    });

    console.log(`📷 [InlineImages] Total inline images extracted: ${inlineImages.length}`);
    return inlineImages;
  }

  /**
   * Collect and process images from attachments and inline images
   * - Jira images (authenticated) are converted to base64
   * - Public URLs can be passed directly to LLM
   * - Data URIs are passed as-is
   */
  async function fetchImageAttachments(attachments) {
    const imageAttachments = attachments.filter(att => att.isImage);
    const imageData = [];

    // Also extract inline images from description
    const inlineImages = extractInlineImages();
    const allImages = [...imageAttachments, ...inlineImages];

    // Deduplicate by URL
    const seenUrls = new Set();
    const uniqueImages = allImages.filter(img => {
      if (!img.url || seenUrls.has(img.url)) return false;
      seenUrls.add(img.url);
      return true;
    });

    console.log(`📷 Found ${imageAttachments.length} attachment images + ${inlineImages.length} inline images = ${uniqueImages.length} unique images`);

    for (const attachment of uniqueImages) {
      try {
        // For data URIs (already base64), keep as-is
        if (attachment.url.startsWith('data:')) {
          const mimeMatch = attachment.url.match(/data:([^;]+);/);
          const mimeType = mimeMatch ? mimeMatch[1] : 'image/png';

          imageData.push({
            name: attachment.name,
            data: attachment.url,
            url: attachment.url,
            mimeType: mimeType,
            isInline: attachment.isInline || false
          });
          console.log(`✅ Added data URI image: ${attachment.name}`);
          continue;
        }

        // Check if this is a Jira/Atlassian URL (requires authentication)
        const isAuthenticatedUrl = attachment.url.includes('atlassian.net') ||
                                    attachment.url.includes('jira.com') ||
                                    attachment.url.includes('atlassian.com');

        if (isAuthenticatedUrl) {
          // Route through background service worker — it has <all_urls> host_permissions
          // and bypasses the CORS restrictions that block content-script fetches.
          console.log(`🔐 Fetching authenticated image via background: ${attachment.name}`);

          try {
            const result = await new Promise((resolve) => {
              chrome.runtime.sendMessage(
                { action: 'fetchImage', url: attachment.url },
                (response) => resolve(response || { success: false, error: 'No response' })
              );
            });

            if (result.success) {
              imageData.push({
                name: attachment.name,
                data: result.data,
                url: attachment.url,
                mimeType: result.mimeType,
                isInline: attachment.isInline || false
              });
              console.log(`✅ Fetched via background: ${attachment.name} (${(result.size / 1024).toFixed(2)} KB)`);
            } else {
              console.warn(`⚠️ Background fetch failed for ${attachment.name}: ${result.error}`);
            }
          } catch (fetchError) {
            console.warn(`⚠️ Cannot fetch authenticated image ${attachment.name}: ${fetchError.message}`);
          }
        } else {
          // Public URLs can be passed directly to LLM
          imageData.push({
            name: attachment.name,
            data: attachment.url,  // Pass URL directly
            url: attachment.url,
            mimeType: 'image/png',
            isInline: attachment.isInline || false
          });
          console.log(`✅ Added public image URL: ${attachment.name}`);
        }
      } catch (error) {
        console.warn(`⚠️ Error processing ${attachment.name}:`, error.message);
      }
    }

    console.log(`📷 Total images ready for LLM: ${imageData.length}`);
    return imageData;
  }

  /**
   * Enrich ticketData with both image and document attachment content.
   * Call this once before sending data to any AI handler.
   */
  async function enrichTicketAttachments(ticketData, settings) {
    if (!ticketData.attachments?.length) return;

    // Images — only for vision-capable models
    const visionModels = (typeof APP_CONFIG !== 'undefined' && APP_CONFIG.VISION_MODELS) ||
      ['gpt-4.1', 'gpt-4.1-mini', 'claude-3-opus', 'claude-3-sonnet', 'gemini-pro-vision',
       'gemini-1.5-pro', 'anthropic.claude', 'us.openai.gpt', 'us.openai.o3'];
    if (visionModels.some(m => settings.llmModel?.includes(m))) {
      ticketData.imageAttachments = await fetchImageAttachments(ticketData.attachments);
    }

    // Documents — always extract text (PDF, TXT, CSV, MD…)
    const jiraSettings = await loadAndDecryptSettings(['jiraEmail', 'jiraApiToken']);
    const docTexts = await fetchDocumentAttachments(
      ticketData.attachments,
      jiraSettings.jiraEmail,
      jiraSettings.jiraApiToken
    );
    if (docTexts.length > 0) {
      ticketData.documentAttachments = docTexts;
      console.log(`📄 Extracted text from ${docTexts.length} document(s) for LLM context`);

      // F24: an image-only PDF is passed to a vision model as an image rather
      // than being dropped — previously its base64 was produced and discarded.
      const scanned = docTexts.filter(d => d.isScannedPdf && d.base64);
      if (scanned.length) {
        ticketData.imageAttachments = (ticketData.imageAttachments || []).concat(
          scanned.map(d => ({ data: `data:${d.mimeType};base64,${d.base64}`, fileName: d.fileName }))
        );
      }
    }
    // F24: attachments we could NOT read are recorded on the ticket so generation
    // and the panel can say a requirement may be missing, instead of treating an
    // unreadable spec as no spec.
    if (docTexts.unreadable && docTexts.unreadable.length) {
      ticketData.unreadableAttachments = docTexts.unreadable;
      console.warn(`⚠️ ${docTexts.unreadable.length} attachment(s) could not be read`);
    }
  }

  /**
   * Fetch document attachments (PDF, TXT, MD, CSV…) and extract their text content.
   * Returns an array of { fileName, text } objects to be injected as LLM context.
   */
  async function fetchDocumentAttachments(attachments, jiraEmail, jiraApiToken) {
    const docAttachments = attachments.filter(att => att.isDocument && !att.isImage && att.url);
    if (docAttachments.length === 0) return [];

    console.log(`📄 Found ${docAttachments.length} document attachment(s) to extract`);
    const results = [];

    // F24: report every attachment, including the ones we could not read. The old
    // loop kept only successful non-empty results and dropped the rest on the
    // floor — so the base64 fallback for an image-only PDF was never delivered,
    // and a spec nobody could read looked identical to no spec at all.
    const skipped = [];

    for (const att of docAttachments.slice(0, 10)) {
      const fileName = att.fileName || att.name || 'document';
      try {
        const result = await new Promise(resolve => {
          chrome.runtime.sendMessage({
            action: 'fetchDocument',
            url: att.url,
            fileName,
            jiraEmail,
            jiraApiToken
          }, response => resolve(response || { success: false, error: 'No response' }));
        });

        if (result.text) {
          console.log(`✅ Extracted ${result.text.length} chars from ${fileName}`);
          results.push({ fileName, text: result.text, type: result.type, status: result.status });
        } else if (result.base64 && result.isScannedPdf) {
          // Image-only PDF: hand the bytes to a vision-capable model rather than
          // discarding the document entirely.
          console.log(`🖼️ ${fileName} has no text layer — passing as an image for vision extraction`);
          results.push({
            fileName, text: '', type: result.type, status: result.status,
            base64: result.base64, mimeType: result.mimeType, isScannedPdf: true
          });
        } else {
          console.warn(`⚠️ Could not extract ${fileName}: ${result.note || result.error}`);
          skipped.push({ fileName, reason: result.note || result.error || 'unknown error', status: result.status });
        }
      } catch (err) {
        console.warn(`⚠️ Error extracting ${fileName}:`, err.message);
        skipped.push({ fileName, reason: err.message, status: 'error' });
      }
    }

    // Anything beyond the cap is an omission the user should know about.
    if (docAttachments.length > 10) {
      skipped.push({
        fileName: `${docAttachments.length - 10} further attachment(s)`,
        reason: 'not processed — attachment limit reached', status: 'skipped'
      });
    }

    results.unreadable = skipped;
    return results;
  }

  // Convert blob to base64
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }
  
  // extractFileType → content-utils.js

  // Extract linked pages (Confluence, external URLs)
  function extractLinkedPages() {
    const linkedPages = [];
    const processedUrls = new Set();

    // Find all links in description, comments, and Jira linked pages sections
    // NOTE: Jira has multiple UI locations for Confluence/external links:
    // - Description content
    // - Comments
    // - Linked Pages panel (Confluence pages section)
    // - Issue links section
    // - Web links section
    const linkElements = document.querySelectorAll(
      // Description
      '[data-testid="issue.views.issue-base.foundation.description.description-content"] a,' +
      '.user-content-block a,' +
      '.description a,' +
      // Comments
      '.comment-body a,' +
      // Jira Linked Pages / Confluence pages panel
      '[data-testid="issue.views.field.confluence-pages"] a,' +
      '[data-testid*="confluence"] a,' +
      '[data-test-id*="confluence"] a,' +
      '[data-testid="linked-pages-group"] a,' +
      // Issue links section
      '[data-testid="issue.views.issue-base.content.issue-links.group-container"] a,' +
      '[data-testid*="issue-links"] a,' +
      '.link-content a,' +
      // Web links section
      '[data-testid="issue.views.field.web-links"] a,' +
      '[data-testid*="web-links"] a,' +
      // Generic link panels - cover more Jira UI variations
      '[data-testid*="remote-link"] a,' +
      '.issuelinks a,' +
      '.links-list a,' +
      // Attachments area sometimes has linked pages
      '[data-testid="issue.views.issue-base.context.context-group"] a'
    );

    console.log(`🔗 Found ${linkElements.length} link elements in the page`);

    linkElements.forEach((linkEl, index) => {
      const url = linkEl.href;
      const text = linkEl.textContent.trim();

      // Filter out internal Jira links and duplicates
      if (url && !processedUrls.has(url) && !url.includes('/browse/')) {
        processedUrls.add(url);

        const pageType = determinePageType(url);

        // Log each detected link for debugging
        console.log(`🔗 Link #${index + 1}: Type=${pageType}, URL=${url}, Text="${text}"`);

        linkedPages.push({
          id: index + 1,
          title: text || url,
          url: url,
          type: pageType
        });
      }
    });

    // ========== SMART LINK DETECTION ==========
    // Jira Smart Links render URLs as rich card previews using @atlaskit/smart-card.
    // These appear in 3 forms: inline (enriched <a>), block (card <div>), embed (<iframe>).
    // Block and embed cards store the URL in data-src or data-url attributes, not in <a href>.
    const smartLinkSelectors = [
      // Atlaskit Smart Card containers (block & embed views)
      '[data-testid*="block-card"] [data-src]',
      '[data-testid*="embed-card"] [data-src]',
      '[data-testid*="block-card"] [data-url]',
      '[data-testid*="embed-card"] [data-url]',
      // Smart card resolved views (the rendered card itself)
      '[data-testid*="smart-block-title-resolved-view"]',
      '[data-testid*="smart-embed-resolved-view"]',
      // Generic smart link attributes
      '[data-smart-link]',
      '[data-card-appearance="block"]',
      '[data-card-appearance="embed"]',
      // Atlaskit smart-card custom element wrappers
      '[data-testid*="inline-card-resolved-view"] a',
      // Block card containers that may have nested <a> or data-src
      '[data-testid*="block-card-resolved-view"]',
      '[data-testid*="block-card-resolved-view"] a',
      // Smart link containers with URL in data attributes
      '[data-src]:not(img):not(script):not(iframe[src*="atlassian"])',
    ];

    const smartLinkElements = document.querySelectorAll(smartLinkSelectors.join(','));
    let smartLinkCount = 0;

    smartLinkElements.forEach(el => {
      // Extract URL from various attributes — priority order
      const url = el.getAttribute('data-src') ||
                  el.getAttribute('data-url') ||
                  el.getAttribute('data-smart-link') ||
                  el.href ||
                  el.querySelector('a[href]')?.href;

      if (!url || processedUrls.has(url) || url.includes('/browse/')) return;

      // Extract title from card content
      const title = el.getAttribute('data-title') ||
                    el.getAttribute('aria-label') ||
                    el.textContent?.trim() ||
                    url;

      const pageType = determinePageType(url);

      // Only add if it's a recognized integration or external URL
      if (pageType !== 'external' || url.startsWith('http')) {
        processedUrls.add(url);
        smartLinkCount++;
        console.log(`🔗 Smart Link #${smartLinkCount}: Type=${pageType}, URL=${url}, Title="${title.substring(0, 60)}"`);
        linkedPages.push({
          id: linkedPages.length + 1,
          title: title.substring(0, 200) || url,
          url: url,
          type: pageType,
          source: 'smart-link'
        });
      }
    });

    if (smartLinkCount > 0) {
      console.log(`🔗 Found ${smartLinkCount} Smart Link(s) in the page`);
    }

    // Fallback: If no Confluence pages found, scan all links on the page for external sources
    // This handles cases where Jira UI structure varies
    if (!linkedPages.some(p => p.type === 'confluence' || p.type === 'figma' || p.type === 'google_docs')) {
      console.log('🔗 No integration links found via selectors, scanning all page links...');
      const allLinks = document.querySelectorAll('a[href]');
      allLinks.forEach((linkEl, index) => {
        const url = linkEl.href;
        if (!url || processedUrls.has(url) || url.includes('/browse/')) return;

        const pageType = determinePageType(url);
        // Only add external integration links (not generic external links)
        if (pageType === 'confluence' || pageType === 'figma' || pageType === 'google_docs' || pageType === 'google_drive') {
          processedUrls.add(url);
          const text = linkEl.textContent.trim();
          console.log(`🔗 Fallback found: Type=${pageType}, URL=${url}`);
          linkedPages.push({
            id: linkedPages.length + 1,
            title: text || url,
            url: url,
            type: pageType
          });
        }
      });
    }

    console.log(`🔗 Total linked pages extracted: ${linkedPages.length}`);
    if (linkedPages.length > 0) {
      console.log('🔗 Linked pages by type:');
      const typeCount = {};
      linkedPages.forEach(page => {
        typeCount[page.type] = (typeCount[page.type] || 0) + 1;
      });
      Object.entries(typeCount).forEach(([type, count]) => {
        console.log(`  - ${type}: ${count}`);
      });
    }

    return linkedPages;
  }
  
  // determinePageType → content-utils.js

  // NOTE: an earlier extractTicketKeywords() declaration lived here, but a SECOND
  // declaration later in this file (also moved) overwrote it via hoisting, so the
  // later version was the one actually used at every call site. Both are now in
  // content-utils.js as the single effective extractTicketKeywords.

  const api = {
    loadAndDecryptSettings,
    fetchTicketDataFromAPI,
    extractVisibleText,
    extractTicketKey,
    extractTicketData,
    extractComments,
    extractCommentTimestamp,
    extractAttachments,
    extractInlineImages,
    fetchImageAttachments,
    enrichTicketAttachments,
    fetchDocumentAttachments,
    blobToBase64,
    extractLinkedPages,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  // content.js (loaded after this file) calls these by bare name.
  if (typeof window !== 'undefined') Object.assign(window, api);
  if (typeof self !== 'undefined') self.QAtalystContentTicket = api;
})();
