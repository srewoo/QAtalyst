/**
 * DOM Extractor - Extract features from web pages
 * Version: 11.0.0
 * Identifies forms, tables, buttons, navigation, and other UI elements
 */

// Prevent redeclaration errors if script is injected multiple times
if (typeof DOMExtractor === 'undefined') {
  class DOMExtractor {
    constructor() {
      this.features = [];
    }

  /**
   * Extract all features from current page
   * @returns {Array} Array of feature objects
   */
  extract() {
    this.features = [];

    try {
      // Extract different feature types
      this.features.push(...this.extractForms());
      this.features.push(...this.extractTables());
      this.features.push(...this.extractButtons());
      this.features.push(...this.extractNavigation());
      this.features.push(...this.extractModals());
      this.features.push(...this.extractCards());
      this.features.push(...this.extractLists());

      console.log(`📊 DOM Extraction: Found ${this.features.length} features`);
    } catch (error) {
      console.error('❌ DOM extraction error:', error);
    }

    return this.features;
  }

  /**
   * Extract form features
   */
  extractForms() {
    const maxForms = CONFIG.get('domExtraction.features.forms.maxForms', 10);
    const forms = document.querySelectorAll('form');
    const formsArray = Array.from(forms).slice(0, maxForms); // MEMORY OPTIMIZATION: Limit forms processed
    return formsArray.map((form, index) => {
      const fields = Array.from(form.querySelectorAll('input, select, textarea'))
        .map(field => ({
          name: field.name || field.id || field.placeholder || `field_${index}`,
          type: field.type || field.tagName.toLowerCase(),
          required: field.required || field.hasAttribute('required'),
          placeholder: field.placeholder || '',
          label: this.getFieldLabel(field),
          validation: this.getFieldValidation(field)
        }))
        .filter(field => field.type !== 'hidden'); // Exclude hidden fields

      const submitButton = form.querySelector('button[type="submit"], input[type="submit"]');

      return {
        type: 'form',
        name: form.name || form.id || this.getFormName(form) || `Form ${index + 1}`,
        action: form.action || 'Unknown',
        method: form.method || 'POST',
        fields,
        submitText: submitButton?.textContent?.trim() || submitButton?.value || 'Submit',
        fieldCount: fields.length,
        selector: this.getSelector(form)
      };
    }).filter(form => form.fields.length > 0); // Only include forms with visible fields
  }

  /**
   * Extract table features
   */
  extractTables() {
    const maxTables = CONFIG.get('domExtraction.features.tables.maxTables', 10);
    const tables = document.querySelectorAll('table');
    const tablesArray = Array.from(tables).slice(0, maxTables); // MEMORY OPTIMIZATION: Limit tables processed
    return tablesArray.map((table, index) => {
      const headers = Array.from(table.querySelectorAll('th'))
        .map(th => th.textContent.trim())
        .filter(h => h.length > 0);

      const rowCount = table.querySelectorAll('tbody tr, tr').length;

      // Extract action buttons in table
      const actions = Array.from(table.querySelectorAll('button, a[role="button"]'))
        .map(btn => btn.textContent.trim())
        .filter((text, i, arr) => text && arr.indexOf(text) === i) // Unique actions
        .slice(0, 5); // Limit to 5 unique actions

      return {
        type: 'table',
        name: table.id || table.getAttribute('aria-label') || this.getTableName(table) || `Table ${index + 1}`,
        columns: headers,
        columnCount: headers.length || table.querySelector('tr')?.children.length || 0,
        rowCount,
        actions,
        isPaginated: this.hasPagination(table),
        selector: this.getSelector(table)
      };
    }).filter(table => table.rowCount > 0);
  }

  /**
   * Extract button features
   */
  extractButtons() {
    const buttons = document.querySelectorAll('button:not([type="submit"]), a.btn, a.button, [role="button"]');
    const seen = new Set();

    return Array.from(buttons)
      .map(btn => {
        const text = btn.textContent.trim();
        const ariaLabel = btn.getAttribute('aria-label');
        const title = btn.getAttribute('title');
        const displayText = text || ariaLabel || title || 'Unnamed Button';

        return {
          type: 'button',
          text: displayText,
          action: btn.onclick?.toString().substring(0, 50) || btn.href || 'Unknown',
          className: btn.className,
          disabled: btn.disabled || btn.hasAttribute('disabled'),
          selector: this.getSelector(btn)
        };
      })
      .filter(btn => {
        // Remove duplicates and empty buttons
        if (!btn.text || btn.text.length === 0 || seen.has(btn.text)) {
          return false;
        }
        seen.add(btn.text);
        return true;
      })
      .slice(0, CONFIG.get('domExtraction.features.buttons.maxButtons', 50)); // Limit buttons
  }

  /**
   * Extract navigation features
   */
  extractNavigation() {
    const navs = document.querySelectorAll('nav, [role="navigation"], header, .navbar, .nav');
    const navsArray = Array.from(navs).slice(0, 5); // MEMORY OPTIMIZATION: Limit to 5 nav elements
    return navsArray.map((nav, index) => {
      const links = Array.from(nav.querySelectorAll('a'))
        .map(a => ({
          text: a.textContent.trim(),
          href: a.href
        }))
        .filter(link => link.text.length > 0)
        .slice(0, CONFIG.get('domExtraction.features.navigation.maxItems', 20)); // Limit nav items

      return {
        type: 'navigation',
        name: nav.getAttribute('aria-label') || nav.id || `Navigation ${index + 1}`,
        items: links,
        itemCount: links.length,
        selector: this.getSelector(nav)
      };
    }).filter(nav => nav.items.length > 0);
  }

  /**
   * Extract modal/dialog features
   */
  extractModals() {
    const maxModals = CONFIG.get('domExtraction.features.modals.maxModals', 5);
    const modals = document.querySelectorAll('[role="dialog"], .modal, [aria-modal="true"]');
    const modalsArray = Array.from(modals).slice(0, maxModals); // MEMORY OPTIMIZATION: Limit modals
    return modalsArray.map((modal, index) => {
      const title = modal.querySelector('[role="heading"], .modal-title, h1, h2, h3');

      return {
        type: 'modal',
        name: modal.getAttribute('aria-label') || title?.textContent.trim() || modal.id || `Modal ${index + 1}`,
        visible: this.isVisible(modal),
        hasCloseButton: !!modal.querySelector('[aria-label*="close" i], .close, .modal-close'),
        selector: this.getSelector(modal)
      };
    });
  }

  /**
   * Extract card/panel features
   */
  extractCards() {
    const cards = document.querySelectorAll('.card, [role="article"], .panel');
    return Array.from(cards)
      .map((card, index) => {
        const title = card.querySelector('h1, h2, h3, h4, .card-title, .panel-title');
        const maxContentLength = CONFIG.get('domExtraction.features.cards.maxContentLength', 100);
        const text = card.textContent.trim().substring(0, maxContentLength);

        return {
          type: 'card',
          name: title?.textContent.trim() || `Card ${index + 1}`,
          content: text,
          selector: this.getSelector(card)
        };
      })
      .slice(0, CONFIG.get('domExtraction.features.cards.maxCards', 20)); // Limit cards
  }

  /**
   * Extract list features
   */
  extractLists() {
    const lists = document.querySelectorAll('ul, ol');
    const minItems = CONFIG.get('domExtraction.features.lists.minItems', 3);
    const maxItemsPerList = CONFIG.get('domExtraction.features.lists.maxItemsPerList', 10);
    const maxLists = CONFIG.get('domExtraction.features.lists.maxLists', 10);

    return Array.from(lists)
      .filter(list => {
        // Only include significant lists (configurable minimum)
        return list.children.length >= minItems;
      })
      .map((list, index) => {
        const items = Array.from(list.children)
          .map(li => li.textContent.trim())
          .filter(text => text.length > 0)
          .slice(0, maxItemsPerList); // Limit items per list

        return {
          type: 'list',
          name: list.id || list.getAttribute('aria-label') || `List ${index + 1}`,
          ordered: list.tagName === 'OL',
          itemCount: list.children.length,
          items,
          selector: this.getSelector(list)
        };
      })
      .slice(0, maxLists); // Limit total lists
  }

  /**
   * Get label for form field
   */
  getFieldLabel(field) {
    // Try to find associated label
    if (field.id) {
      const label = document.querySelector(`label[for="${field.id}"]`);
      if (label) return label.textContent.trim();
    }

    // Check parent label
    const parentLabel = field.closest('label');
    if (parentLabel) return parentLabel.textContent.trim();

    // Check aria-label
    if (field.getAttribute('aria-label')) {
      return field.getAttribute('aria-label');
    }

    return '';
  }

  /**
   * Get field validation rules
   */
  getFieldValidation(field) {
    const validation = [];

    if (field.required) validation.push('required');
    if (field.pattern) validation.push(`pattern:${field.pattern}`);
    if (field.minLength) validation.push(`minLength:${field.minLength}`);
    if (field.maxLength) validation.push(`maxLength:${field.maxLength}`);
    if (field.min) validation.push(`min:${field.min}`);
    if (field.max) validation.push(`max:${field.max}`);

    return validation;
  }

  /**
   * Get form name from context
   */
  getFormName(form) {
    // Check for heading near form
    const heading = form.querySelector('h1, h2, h3, h4');
    if (heading) return heading.textContent.trim();

    // Check parent heading
    const parent = form.closest('div, section');
    if (parent) {
      const parentHeading = parent.querySelector('h1, h2, h3, h4');
      if (parentHeading) return parentHeading.textContent.trim();
    }

    return null;
  }

  /**
   * Get table name from context
   */
  getTableName(table) {
    // Check caption
    const caption = table.querySelector('caption');
    if (caption) return caption.textContent.trim();

    // Check preceding heading
    let prev = table.previousElementSibling;
    while (prev) {
      if (prev.matches('h1, h2, h3, h4')) {
        return prev.textContent.trim();
      }
      prev = prev.previousElementSibling;
    }

    return null;
  }

  /**
   * Check if table has pagination
   */
  hasPagination(table) {
    const parent = table.closest('div, section');
    if (!parent) return false;

    const paginationKeywords = ['pagination', 'pager', 'page-nav'];
    return paginationKeywords.some(keyword =>
      parent.querySelector(`[class*="${keyword}"], [id*="${keyword}"]`)
    );
  }

  /**
   * Extract main text content from page (for help articles, documentation, etc.)
   * MEMORY OPTIMIZED: Default reduced to 2000 chars
   */
  extractTextContent(maxLength = 2000) {
    const textParts = [];
    let totalLength = 0;

    // Include page title and meta description at the top for context
    const pageTitle = document.title?.trim() || '';
    const metaDesc = document.querySelector('meta[name="description"]')?.content?.trim() || '';
    if (pageTitle) {
      textParts.push(`# ${pageTitle}\n\n`);
      totalLength += pageTitle.length + 4;
    }
    if (metaDesc && totalLength < maxLength) {
      textParts.push(`> ${metaDesc}\n\n`);
      totalLength += metaDesc.length + 4;
    }

    // Priority selectors for main content
    const contentSelectors = [
      'article',           // Semantic article tag
      'main',              // Main content area
      '[role="main"]',     // ARIA main role
      '.article',          // Common article class
      '.content',          // Common content class
      '.post-content',     // Blog posts
      '.entry-content',    // WordPress
      '#content',          // Common ID
      '#main-content',     // Common ID
      '.page-content',     // Common in modern sites
      '.site-content',     // WordPress themes
      '.main-content',     // Common pattern
      '.container',        // Bootstrap/common frameworks
      '.main-wrapper',     // Common wrapper pattern
      'section',           // HTML5 section elements
      '[class*="content"]' // Any class containing "content"
    ];

    // Try to find main content container
    let contentContainer = null;
    let contentSelectorUsed = null;
    for (const selector of contentSelectors) {
      contentContainer = document.querySelector(selector);
      if (contentContainer) {
        contentSelectorUsed = selector;
        break;
      }
    }

    // Fallback to body if no main content found
    if (!contentContainer) {
      contentContainer = document.body;
      contentSelectorUsed = 'body (fallback)';
    }

    console.log(`  📦 Content container: ${contentSelectorUsed}`);

    // Extract text from semantic elements + common content divs (single query for performance)
    // Added div, span, section, article, aside for better coverage of modern web apps
    const textElements = contentContainer.querySelectorAll(
      'h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, td, div[class*="content"], div[class*="text"], div[class*="description"], div[class*="body"], section, article'
    );

    console.log(`  📊 Found ${textElements.length} text elements to process`);

    // MEMORY OPTIMIZATION: Limit to first 500 elements to prevent processing huge DOMs
    const limitedElements = Array.from(textElements).slice(0, 500);

    let skippedHidden = 0;
    let skippedNav = 0;
    let skippedShort = 0;
    let skippedDuplicate = 0;
    const processedText = new Set(); // Track processed text to avoid duplicates from nested elements

    // Extract and clean text
    for (const element of limitedElements) {
      // Skip if inside hidden elements
      if (!this.isVisible(element)) {
        skippedHidden++;
        continue;
      }

      // Get text content first for filtering
      let text = element.textContent.trim();

      // Skip empty or very short text
      if (text.length < 3) {
        skippedShort++;
        continue;
      }

      // Skip if it's just a number (likely from navigation)
      if (/^\d+$/.test(text)) {
        skippedShort++;
        continue;
      }

      // Skip duplicate text from nested elements
      // Use first 100 chars as fingerprint to detect duplicates
      const textFingerprint = text.substring(0, 100);
      if (processedText.has(textFingerprint)) {
        skippedDuplicate++;
        continue;
      }

      // IMPROVED: More intelligent navigation filtering
      // Only skip elements that are direct nav children AND have short text
      const isInNav = element.closest('nav, [role="navigation"], header, .navbar, footer, .footer');
      if (isInNav && text.length < 50) {
        // Skip short nav items (links, buttons)
        skippedNav++;
        continue;
      }
      // But allow longer text in nav areas (might be actual content in SPAs)

      // Add separator for headings
      if (element.matches('h1, h2, h3, h4, h5, h6')) {
        text = '\n\n' + text + '\n';
      } else if (element.matches('p, blockquote')) {
        text = text + '\n';
      } else if (element.matches('li')) {
        text = '• ' + text + '\n';
      }

      // Check if adding this would exceed limit
      if (totalLength + text.length > maxLength) {
        // Add partial text up to limit
        const remaining = maxLength - totalLength;
        if (remaining > 50) {  // Only add if we have reasonable space left
          textParts.push(text.substring(0, remaining) + '...');
        }
        break;
      }

      textParts.push(text);
      totalLength += text.length;

      // Mark this text as processed
      processedText.add(textFingerprint);
    }

    // Join and clean up
    let fullText = textParts.join('');

    // Remove excessive whitespace
    fullText = fullText.replace(/\n{3,}/g, '\n\n');  // Max 2 newlines
    fullText = fullText.replace(/[ \t]+/g, ' ');     // Normalize spaces
    fullText = fullText.trim();

    console.log(`  📝 Extraction stats: ${textParts.length} parts, skipped: ${skippedHidden} hidden, ${skippedNav} nav, ${skippedShort} short, ${skippedDuplicate} duplicate`);
    console.log(`  📏 Structured extraction result: ${fullText.length} chars`);

    // Fallback: If structured extraction got very little text, try simple body extraction
    if (fullText.length < 200) {
      console.warn(`⚠️ Structured extraction only got ${fullText.length} chars, using fallback (threshold: 200)`);

      // Try to exclude navigation elements from fallback
      let fallbackText = '';

      // Try innerText directly (respects display: none, visibility: hidden)
      // Don't remove nav elements as it might be too aggressive
      fallbackText = document.body.innerText || document.body.textContent || '';

      // If fallback text is still too short, try without filtering
      if (fallbackText.length < 200) {
        console.warn(`  ⚠️ innerText also short (${fallbackText.length} chars), trying textContent`);
        fallbackText = document.body.textContent || '';
      }

      // Basic cleanup: remove excessive whitespace
      fallbackText = fallbackText.replace(/\n{3,}/g, '\n\n');
      fallbackText = fallbackText.replace(/[ \t]+/g, ' ');
      fallbackText = fallbackText.trim();

      // Limit to maxLength
      if (fallbackText.length > maxLength) {
        fallbackText = fallbackText.substring(0, maxLength) + '...';
      }

      console.log(`✅ Fallback extraction got ${fallbackText.length} chars`);
      return fallbackText;
    }

    return fullText;
  }

  /**
   * Check if element is visible
   */
  isVisible(element) {
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  /**
   * Get unique selector for element
   */
  getSelector(element) {
    if (element.id) return `#${element.id}`;
    if (element.className) {
      const classes = element.className.split(' ').filter(c => c.length > 0).slice(0, 2);
      if (classes.length > 0) {
        return `${element.tagName.toLowerCase()}.${classes.join('.')}`;
      }
    }
    return element.tagName.toLowerCase();
  }
  }

  // Make DOMExtractor globally available (works in both window and service worker contexts)
  if (typeof window !== 'undefined') {
    window.DOMExtractor = DOMExtractor;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.DOMExtractor = DOMExtractor;
  }
}

// Export for use in content script
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DOMExtractor;
}
