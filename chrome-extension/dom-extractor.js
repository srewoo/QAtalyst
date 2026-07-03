/**
 * DOM Extractor - Extract features from web pages
 * Version: 12.0.0 - Enhanced with intent detection, accessibility, and interaction patterns
 * Identifies forms, tables, buttons, navigation, and other UI elements
 */

// Prevent redeclaration errors if script is injected multiple times
if (typeof DOMExtractor === 'undefined') {

  /**
   * Safe config getter - handles cases where CONFIG is not available
   */
  function getConfig(path, defaultValue) {
    try {
      if (typeof CONFIG !== 'undefined' && typeof CONFIG.get === 'function') {
        return CONFIG.get(path, defaultValue);
      }
    } catch (e) {
      // CONFIG not available, use default
    }
    return defaultValue;
  }

  class DOMExtractor {
    constructor() {
      this.features = [];
      this.errorPatterns = [];
      this.pageHints = {};
      this.pierceShadowDom = getConfig('domExtraction.pierceShadowDom', true);
      this.extractIframes = getConfig('domExtraction.extractIframes', true);
      // Record cross-origin (unreadable) iframes so the knowledge graph still
      // knows an embed exists, even though its internals can't be read.
      this.recordExternalEmbeds = getConfig('domExtraction.recordExternalEmbeds', true);
      this.externalEmbeds = [];
    }

    /**
     * Query elements across the main document, shadow DOMs, and same-origin iframes.
     * Falls back to standard querySelectorAll if shadow/iframe piercing is disabled.
     * @param {string} selector - CSS selector
     * @param {number} maxResults - Maximum elements to return (default 100)
     * @returns {Array<Element>}
     */
    querySelectorDeep(selector, maxResults = 100) {
      const results = [];

      // Main document
      try {
        results.push(...document.querySelectorAll(selector));
      } catch (e) { /* invalid selector */ }

      if (results.length >= maxResults) return results.slice(0, maxResults);

      // Pierce shadow DOM roots
      if (this.pierceShadowDom) {
        try {
          const allElements = document.querySelectorAll('*');
          for (let i = 0; i < allElements.length && results.length < maxResults; i++) {
            const shadowRoot = allElements[i].shadowRoot;
            if (shadowRoot) {
              try {
                const shadowResults = shadowRoot.querySelectorAll(selector);
                results.push(...shadowResults);
              } catch (e) { /* skip */ }
            }
          }
        } catch (e) { /* skip shadow DOM scan */ }
      }

      // Same-origin iframes
      if (this.extractIframes) {
        try {
          const iframes = document.querySelectorAll('iframe');
          for (let i = 0; i < iframes.length && results.length < maxResults; i++) {
            try {
              const iframeDoc = iframes[i].contentDocument;
              if (iframeDoc) {
                const iframeResults = iframeDoc.querySelectorAll(selector);
                results.push(...iframeResults);
              }
            } catch (e) {
              // Cross-origin iframe — cannot access, skip silently
            }
          }
        } catch (e) { /* skip iframe scan */ }
      }

      return results.slice(0, maxResults);
    }

  /**
   * Extract all features from current page
   * @returns {Array} Array of feature objects
   */
  extract() {
    this.features = [];
    this.errorPatterns = [];
    this.pageHints = {};

    try {
      // Extract different feature types
      this.features.push(...this.extractForms());
      this.features.push(...this.extractTables());
      this.features.push(...this.extractButtons());
      this.features.push(...this.extractNavigation());
      this.features.push(...this.extractModals());
      this.features.push(...this.extractCards());
      this.features.push(...this.extractLists());

      // NEW: Extract error message patterns
      this.errorPatterns = this.extractErrorPatterns();

      // NEW: Detect page-level hints (lazy load, dynamic content)
      this.pageHints = this.detectPageHints();

      // NEW: Record cross-origin iframes (embedded widgets we can't read into)
      this.extractExternalEmbeds();
      if (this.externalEmbeds.length > 0) {
        this.pageHints.externalEmbeds = this.externalEmbeds;
      }

      console.log(`📊 DOM Extraction: Found ${this.features.length} features, ${this.errorPatterns.length} error patterns, ${this.externalEmbeds.length} external embeds`);
    } catch (error) {
      console.error('❌ DOM extraction error:', error);
    }

    return this.features;
  }

  /**
   * Get extracted error patterns
   */
  getErrorPatterns() {
    return this.errorPatterns;
  }

  /**
   * Get page-level hints
   */
  getPageHints() {
    return this.pageHints;
  }

  /**
   * Get recorded external (cross-origin) embeds.
   */
  getExternalEmbeds() {
    return this.externalEmbeds;
  }

  /**
   * Resolve the origin of an iframe src against the current document.
   * @returns {string|null}
   */
  getEmbedOrigin(src) {
    if (!src) return null;
    try {
      const base = (typeof document !== 'undefined' && document.baseURI) || undefined;
      return new URL(src, base).origin;
    } catch (e) {
      return null;
    }
  }

  /**
   * Record iframes on the page, distinguishing readable same-origin frames from
   * cross-origin embeds whose internals the browser forbids us from reading.
   *
   * Same-origin iframe contents are already pierced by querySelectorDeep; this
   * surfaces the EXISTENCE of cross-origin embeds (their src + that they are
   * unreadable) so the knowledge graph knows an embedded widget is present.
   *
   * @returns {Array<{type:string, src:string, origin:(string|null), crossOrigin:boolean, readable:boolean, title:(string|undefined)}>}
   */
  extractExternalEmbeds() {
    this.externalEmbeds = [];
    if (!this.recordExternalEmbeds) return this.externalEmbeds;
    if (typeof document === 'undefined') return this.externalEmbeds;

    let pageOrigin = null;
    try {
      pageOrigin = (typeof location !== 'undefined' && location.origin)
        ? location.origin
        : new URL(document.baseURI).origin;
    } catch (e) { /* pageOrigin stays null */ }

    let iframes = [];
    try {
      iframes = document.querySelectorAll('iframe');
    } catch (e) {
      return this.externalEmbeds;
    }

    for (let i = 0; i < iframes.length; i++) {
      const iframe = iframes[i];
      const src = iframe.getAttribute('src') || iframe.src || '';
      const origin = this.getEmbedOrigin(src);

      // Determine readability: cross-origin frames throw or return null on
      // contentDocument access. Treat any access failure as cross-origin.
      let readable = false;
      try {
        readable = !!iframe.contentDocument;
      } catch (e) {
        readable = false;
      }

      // An iframe is cross-origin if its src resolves to a different origin than
      // the page, OR the browser denied access to its document.
      const crossOrigin = (origin !== null && pageOrigin !== null && origin !== pageOrigin) || !readable;

      // Only record the cross-origin / unreadable embeds — same-origin frames are
      // already crawled in-place via querySelectorDeep.
      if (crossOrigin) {
        const embed = {
          type: 'externalEmbed',
          src: src,
          origin: origin,
          crossOrigin: true,
          readable: false
        };
        const title = iframe.getAttribute('title');
        if (title) embed.title = title;
        this.externalEmbeds.push(embed);
      }
    }

    return this.externalEmbeds;
  }

  /**
   * Extract form features with enhanced field dependencies and accessibility
   */
  extractForms() {
    const maxForms = getConfig('domExtraction.features.forms.maxForms', 10);
    const forms = this.querySelectorDeep('form', maxForms);
    const formsArray = Array.from(forms).slice(0, maxForms);
    return formsArray.map((form, index) => {
      const fields = Array.from(form.querySelectorAll('input, select, textarea'))
        .map(field => {
          const fieldData = {
            name: field.name || field.id || field.placeholder || `field_${index}`,
            type: field.type || field.tagName.toLowerCase(),
            required: field.required || field.hasAttribute('required'),
            placeholder: field.placeholder || '',
            label: this.getFieldLabel(field),
            validation: this.getFieldValidation(field)
          };

          // NEW: Extract field dependencies (conditional visibility)
          const dependencies = this.getFieldDependencies(field);
          if (dependencies) {
            fieldData._dependencies = dependencies;
          }

          // NEW: Extract accessibility attributes
          const a11y = this.getFieldAccessibility(field);
          if (Object.keys(a11y).length > 0) {
            fieldData._a11y = a11y;
          }

          // NEW: Detect field format hints from placeholder/pattern
          const formatHints = this.getFieldFormatHints(field);
          if (formatHints) {
            fieldData._formatHints = formatHints;
          }

          // Extract <select> option values for domain-specific test data
          if (field.tagName.toLowerCase() === 'select') {
            const options = Array.from(field.options || [])
              .filter(opt => opt.value && opt.value !== '' && !opt.disabled)
              .slice(0, 15)
              .map(opt => ({ value: opt.value, label: opt.textContent?.trim() || opt.value }));
            if (options.length > 0) {
              fieldData._options = options;
            }
          }

          return fieldData;
        })
        .filter(field => field.type !== 'hidden');

      const submitButton = form.querySelector('button[type="submit"], input[type="submit"]');

      // NEW: Detect form intent and characteristics
      const formMetadata = {
        intent: this.detectFormIntent(form),
        hasAsyncValidation: this.hasAsyncValidation(form),
        isMultiStep: this.isMultiStepForm(form),
        hasFileUpload: !!form.querySelector('input[type="file"]'),
        hasPasswordField: !!form.querySelector('input[type="password"]'),
        autocompleteEnabled: form.autocomplete !== 'off'
      };

      // NEW: Form-level accessibility
      const formA11y = {
        ariaLabel: form.getAttribute('aria-label'),
        ariaDescribedBy: form.getAttribute('aria-describedby'),
        role: form.getAttribute('role') || 'form',
        noValidate: form.hasAttribute('novalidate')
      };

      return {
        type: 'form',
        name: form.name || form.id || this.getFormName(form) || `Form ${index + 1}`,
        action: form.action || 'Unknown',
        method: form.method || 'POST',
        fields,
        submitText: submitButton?.textContent?.trim() || submitButton?.value || 'Submit',
        fieldCount: fields.length,
        selector: this.getSelector(form),
        _metadata: formMetadata,
        _a11y: formA11y
      };
    }).filter(form => form.fields.length > 0);
  }

  /**
   * Detect field dependencies (show/hide conditions)
   */
  getFieldDependencies(field) {
    const dependencies = {};
    const parent = field.closest('[data-show-when], [data-depends-on], [ng-if], [v-if], [*ngIf]') || field;

    // Check common conditional display attributes
    const showWhen = parent.dataset.showWhen || parent.getAttribute('data-show-when');
    const dependsOn = parent.dataset.dependsOn || parent.getAttribute('data-depends-on');
    const ngIf = parent.getAttribute('ng-if') || parent.getAttribute('*ngIf');
    const vIf = parent.getAttribute('v-if');
    const vShow = parent.getAttribute('v-show');

    if (showWhen) dependencies.showWhen = showWhen;
    if (dependsOn) dependencies.dependsOn = dependsOn;
    if (ngIf) dependencies.angularCondition = ngIf;
    if (vIf) dependencies.vueCondition = vIf;
    if (vShow) dependencies.vueShow = vShow;

    // Check if field is in a conditional container
    const conditionalParent = field.closest('.conditional, .dependent-field, [class*="conditional"], [class*="dependent"]');
    if (conditionalParent) {
      dependencies.hasConditionalParent = true;
    }

    return Object.keys(dependencies).length > 0 ? dependencies : null;
  }

  /**
   * Extract field accessibility attributes
   */
  getFieldAccessibility(field) {
    const a11y = {};

    const ariaLabel = field.getAttribute('aria-label');
    const ariaDescribedBy = field.getAttribute('aria-describedby');
    const ariaRequired = field.getAttribute('aria-required');
    const ariaInvalid = field.getAttribute('aria-invalid');
    const role = field.getAttribute('role');
    const tabIndex = field.getAttribute('tabindex');

    if (ariaLabel) a11y.ariaLabel = ariaLabel;
    if (ariaDescribedBy) a11y.ariaDescribedBy = ariaDescribedBy;
    if (ariaRequired) a11y.ariaRequired = ariaRequired === 'true';
    if (ariaInvalid) a11y.ariaInvalid = ariaInvalid;
    if (role) a11y.role = role;
    if (tabIndex) a11y.tabIndex = parseInt(tabIndex, 10);

    // Check for associated error/help text elements
    if (ariaDescribedBy) {
      const helpEl = document.getElementById(ariaDescribedBy);
      if (helpEl) {
        a11y.helpText = helpEl.textContent.trim().substring(0, 100);
      }
    }

    return a11y;
  }

  /**
   * Get field format hints from placeholder and attributes
   */
  getFieldFormatHints(field) {
    const hints = {};

    // Extract format from placeholder
    const placeholder = field.placeholder || '';
    if (placeholder.includes('@')) hints.format = 'email';
    else if (placeholder.match(/\d{2,}[-/]\d{2,}/)) hints.format = 'date';
    else if (placeholder.match(/\(\d{3}\)|\d{3}-\d{3}/)) hints.format = 'phone';
    else if (placeholder.match(/\$|USD|EUR/)) hints.format = 'currency';

    // Check for input masks
    const mask = field.dataset.mask || field.getAttribute('data-inputmask');
    if (mask) hints.mask = mask;

    // Check for date/time pickers
    if (field.type === 'date' || field.type === 'datetime-local' || field.type === 'time') {
      hints.format = field.type;
    }

    return Object.keys(hints).length > 0 ? hints : null;
  }

  /**
   * Detect form intent based on fields and structure
   */
  detectFormIntent(form) {
    const formText = (form.name + ' ' + form.id + ' ' + form.className).toLowerCase();
    const hasPassword = !!form.querySelector('input[type="password"]');
    const hasEmail = !!form.querySelector('input[type="email"]');
    const hasSearch = !!form.querySelector('input[type="search"]');
    const hasFile = !!form.querySelector('input[type="file"]');

    if (formText.includes('login') || formText.includes('signin')) return 'login';
    if (formText.includes('signup') || formText.includes('register')) return 'registration';
    if (formText.includes('search')) return 'search';
    if (formText.includes('contact')) return 'contact';
    if (formText.includes('checkout') || formText.includes('payment')) return 'checkout';
    if (formText.includes('filter')) return 'filter';
    if (hasPassword && hasEmail && form.querySelectorAll('input').length <= 3) return 'login';
    if (hasPassword && form.querySelectorAll('input').length > 3) return 'registration';
    if (hasSearch) return 'search';
    if (hasFile) return 'upload';

    return 'general';
  }

  /**
   * Check if form has async validation
   */
  hasAsyncValidation(form) {
    // Check for common async validation patterns
    const fields = form.querySelectorAll('input, textarea');
    for (const field of fields) {
      if (field.dataset.validate || field.dataset.asyncValidate ||
          field.getAttribute('data-validate-async') ||
          field.classList.contains('async-validate')) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if form is multi-step
   */
  isMultiStepForm(form) {
    const hasSteps = form.querySelector('.step, .wizard-step, [class*="step-"], [data-step]');
    const hasProgress = form.querySelector('.progress, .progress-bar, [class*="progress"]');
    const hasNextPrev = form.querySelector('[class*="next"], [class*="prev"], [class*="previous"]');
    return !!(hasSteps || (hasProgress && hasNextPrev));
  }

  /**
   * Extract table features with enhanced interaction detection
   */
  extractTables() {
    const maxTables = getConfig('domExtraction.features.tables.maxTables', 10);
    const tables = this.querySelectorDeep('table', 20);
    const tablesArray = Array.from(tables).slice(0, maxTables);
    return tablesArray.map((table, index) => {
      const headers = Array.from(table.querySelectorAll('th'))
        .map(th => th.textContent.trim())
        .filter(h => h.length > 0);

      const rowCount = table.querySelectorAll('tbody tr, tr').length;

      // Extract action buttons in table
      const actions = Array.from(table.querySelectorAll('button, a[role="button"]'))
        .map(btn => btn.textContent.trim())
        .filter((text, i, arr) => text && arr.indexOf(text) === i)
        .slice(0, 5);

      // NEW: Detect table interaction capabilities
      const interactions = this.detectTableInteractions(table);

      // NEW: Table accessibility
      const a11y = {
        ariaLabel: table.getAttribute('aria-label'),
        ariaDescribedBy: table.getAttribute('aria-describedby'),
        role: table.getAttribute('role') || 'table',
        caption: table.querySelector('caption')?.textContent.trim()
      };

      return {
        type: 'table',
        name: table.id || table.getAttribute('aria-label') || this.getTableName(table) || `Table ${index + 1}`,
        columns: headers,
        columnCount: headers.length || table.querySelector('tr')?.children.length || 0,
        rowCount,
        actions,
        isPaginated: this.hasPagination(table),
        selector: this.getSelector(table),
        _interactions: interactions,
        _a11y: a11y
      };
    }).filter(table => table.rowCount > 0);
  }

  /**
   * Detect table interaction capabilities
   */
  detectTableInteractions(table) {
    const interactions = {};

    // Check for sortable columns
    const sortableHeaders = table.querySelectorAll('th[aria-sort], th.sortable, th[data-sortable], th .sort-icon');
    if (sortableHeaders.length > 0) {
      interactions.sortable = true;
      interactions.sortableColumns = Array.from(sortableHeaders).map(th => th.textContent.trim()).slice(0, 10);
    }

    // Check for filterable columns
    const filterInputs = table.querySelectorAll('input[type="search"], input.filter, [class*="filter"]');
    if (filterInputs.length > 0) {
      interactions.filterable = true;
    }

    // Check for row selection (checkboxes)
    const rowCheckboxes = table.querySelectorAll('tbody input[type="checkbox"], tbody input[type="radio"]');
    if (rowCheckboxes.length > 0) {
      interactions.rowSelection = true;
      interactions.selectionType = rowCheckboxes[0].type === 'checkbox' ? 'multiple' : 'single';
    }

    // Check for expandable rows
    const expandables = table.querySelectorAll('[aria-expanded], .expandable-row, [data-toggle="collapse"]');
    if (expandables.length > 0) {
      interactions.expandableRows = true;
    }

    // Check for inline editing
    const editables = table.querySelectorAll('[contenteditable="true"], .editable, [data-editable]');
    if (editables.length > 0) {
      interactions.inlineEditing = true;
    }

    // Check for drag and drop
    const draggables = table.querySelectorAll('[draggable="true"], .drag-handle, [class*="drag"]');
    if (draggables.length > 0) {
      interactions.dragAndDrop = true;
    }

    // Check for bulk actions
    const bulkActions = table.closest('.table-container, .data-table')?.querySelector('.bulk-actions, [class*="bulk"]');
    if (bulkActions) {
      interactions.bulkActions = true;
    }

    return Object.keys(interactions).length > 0 ? interactions : null;
  }

  /**
   * Extract button features with intent detection and handler parsing
   */
  extractButtons() {
    const buttons = this.querySelectorDeep('button:not([type="submit"]), a.btn, a.button, [role="button"]', 60);
    const seen = new Set();

    return Array.from(buttons)
      .map(btn => {
        const text = btn.textContent.trim();
        const ariaLabel = btn.getAttribute('aria-label');
        const title = btn.getAttribute('title');
        const displayText = text || ariaLabel || title || 'Unnamed Button';

        // NEW: Parse onclick handler
        const handler = this.parseButtonHandler(btn);

        // NEW: Detect button intent
        const intent = this.detectButtonIntent(btn, displayText);

        // NEW: Check for confirmation requirement
        const requiresConfirmation = this.buttonRequiresConfirmation(btn);

        // NEW: Accessibility attributes
        const a11y = {
          ariaLabel: ariaLabel,
          ariaDescribedBy: btn.getAttribute('aria-describedby'),
          ariaExpanded: btn.getAttribute('aria-expanded'),
          ariaHaspopup: btn.getAttribute('aria-haspopup'),
          ariaControls: btn.getAttribute('aria-controls'),
          role: btn.getAttribute('role') || 'button'
        };

        return {
          type: 'button',
          text: displayText,
          action: btn.onclick?.toString().substring(0, 100) || btn.href || 'Unknown',
          className: btn.className,
          disabled: btn.disabled || btn.hasAttribute('disabled'),
          selector: this.getSelector(btn),
          _handler: handler,
          _intent: intent,
          _requiresConfirmation: requiresConfirmation,
          _a11y: Object.keys(a11y).some(k => a11y[k]) ? a11y : undefined
        };
      })
      .filter(btn => {
        if (!btn.text || btn.text.length === 0 || seen.has(btn.text)) {
          return false;
        }
        seen.add(btn.text);
        return true;
      })
      .slice(0, getConfig('domExtraction.features.buttons.maxButtons', 50));
  }

  /**
   * Parse button click handler
   */
  parseButtonHandler(btn) {
    const handler = {};

    // Get onclick attribute
    const onclickAttr = btn.getAttribute('onclick');
    if (onclickAttr) {
      handler.onclick = onclickAttr.substring(0, 200);
      handler.type = 'inline';

      // Try to extract function name
      const funcMatch = onclickAttr.match(/(\w+)\s*\(/);
      if (funcMatch) {
        handler.functionName = funcMatch[1];
      }
    }

    // Check for data-action attributes (common in frameworks)
    const dataAction = btn.dataset.action || btn.getAttribute('data-action');
    if (dataAction) {
      handler.dataAction = dataAction;
      handler.type = 'data-attribute';
    }

    // Check for Angular/Vue/React patterns
    const ngClick = btn.getAttribute('ng-click') || btn.getAttribute('(click)');
    const vOnClick = btn.getAttribute('v-on:click') || btn.getAttribute('@click');

    if (ngClick) {
      handler.angularHandler = ngClick;
      handler.type = 'angular';
    }
    if (vOnClick) {
      handler.vueHandler = vOnClick;
      handler.type = 'vue';
    }

    // Check for form association
    const form = btn.form || btn.closest('form');
    if (form) {
      handler.associatedForm = form.name || form.id || 'unnamed-form';
    }

    // Check for modal/dialog triggers
    const modalTarget = btn.dataset.target || btn.dataset.bsTarget || btn.getAttribute('data-toggle');
    if (modalTarget) {
      handler.opensModal = modalTarget;
      handler.type = 'modal-trigger';
    }

    return Object.keys(handler).length > 0 ? handler : null;
  }

  /**
   * Detect button intent based on text and attributes
   */
  detectButtonIntent(btn, text) {
    const lowerText = text.toLowerCase();
    const className = (btn.className || '').toLowerCase();
    const allText = lowerText + ' ' + className;

    // Destructive actions
    if (allText.match(/delete|remove|destroy|cancel|clear|reset/)) {
      return { type: 'destructive', action: lowerText.includes('delete') ? 'delete' : 'remove' };
    }

    // Submit/Save actions
    if (allText.match(/submit|save|create|add|post|send|apply/)) {
      return { type: 'submit', action: lowerText.includes('save') ? 'save' : 'submit' };
    }

    // Edit/Update actions
    if (allText.match(/edit|update|modify|change/)) {
      return { type: 'edit', action: 'edit' };
    }

    // Navigation actions
    if (allText.match(/next|previous|prev|back|forward|continue/)) {
      return { type: 'navigation', action: lowerText.includes('next') ? 'next' : 'back' };
    }

    // Toggle actions
    if (allText.match(/toggle|switch|enable|disable|show|hide/)) {
      return { type: 'toggle', action: 'toggle' };
    }

    // Download/Export actions
    if (allText.match(/download|export|print/)) {
      return { type: 'export', action: lowerText.includes('download') ? 'download' : 'export' };
    }

    // Upload actions
    if (allText.match(/upload|import|attach/)) {
      return { type: 'import', action: 'upload' };
    }

    // Search/Filter actions
    if (allText.match(/search|filter|find/)) {
      return { type: 'search', action: 'search' };
    }

    // Expand/Collapse
    if (btn.getAttribute('aria-expanded') !== null) {
      return { type: 'expand', action: 'toggle-expand' };
    }

    // Modal/Dialog openers
    if (btn.dataset.toggle === 'modal' || btn.dataset.bsToggle === 'modal') {
      return { type: 'modal', action: 'open-modal' };
    }

    return null;
  }

  /**
   * Check if button requires confirmation
   */
  buttonRequiresConfirmation(btn) {
    const text = (btn.textContent || '').toLowerCase();
    const className = (btn.className || '').toLowerCase();
    const allText = text + ' ' + className;

    // Destructive actions typically require confirmation
    if (allText.match(/delete|remove|destroy|cancel|reset|clear/)) {
      return true;
    }

    // Check for confirmation-related attributes
    if (btn.dataset.confirm || btn.getAttribute('data-confirm') ||
        btn.dataset.confirmMessage || btn.getAttribute('data-confirm-message')) {
      return true;
    }

    // Check for danger/warning styling
    if (className.match(/danger|warning|destructive|delete/)) {
      return true;
    }

    return false;
  }

  /**
   * Extract navigation features
   */
  extractNavigation() {
    const navs = this.querySelectorDeep('nav, [role="navigation"], header, .navbar, .nav', 15);
    const navsArray = Array.from(navs).slice(0, 5); // MEMORY OPTIMIZATION: Limit to 5 nav elements
    return navsArray.map((nav, index) => {
      const links = Array.from(nav.querySelectorAll('a'))
        .map(a => ({
          text: a.textContent.trim(),
          href: a.href
        }))
        .filter(link => link.text.length > 0)
        .slice(0, getConfig('domExtraction.features.navigation.maxItems', 20)); // Limit nav items

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
    const maxModals = getConfig('domExtraction.features.modals.maxModals', 5);
    const modals = this.querySelectorDeep('[role="dialog"], .modal, [aria-modal="true"]', 10);
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
    const cards = this.querySelectorDeep('.card, [role="article"], .panel', 25);
    return Array.from(cards)
      .map((card, index) => {
        const title = card.querySelector('h1, h2, h3, h4, .card-title, .panel-title');
        const maxContentLength = getConfig('domExtraction.features.cards.maxContentLength', 100);
        const text = card.textContent.trim().substring(0, maxContentLength);

        return {
          type: 'card',
          name: title?.textContent.trim() || `Card ${index + 1}`,
          content: text,
          selector: this.getSelector(card)
        };
      })
      .slice(0, getConfig('domExtraction.features.cards.maxCards', 20)); // Limit cards
  }

  /**
   * Extract list features
   */
  extractLists() {
    const lists = this.querySelectorDeep('ul, ol', 20);
    const minItems = getConfig('domExtraction.features.lists.minItems', 3);
    const maxItemsPerList = getConfig('domExtraction.features.lists.maxItemsPerList', 10);
    const maxLists = getConfig('domExtraction.features.lists.maxLists', 10);

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
  extractTextContent(maxLength = 5000) { // F32: was 2000 — long content pages were mostly dropped
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
    const textElements = contentContainer.querySelectorAll(
      'h1, h2, h3, h4, h5, h6, p, li, blockquote, pre, td, figcaption, ' +
      'div[class*="content"], div[class*="text"], div[class*="description"], div[class*="body"], section, article'
    );

    console.log(`  📊 Found ${textElements.length} text elements to process`);

    // ── Image alt/title text ──────────────────────────────────────────────
    // Pixels are never fetched during crawl, but descriptive text attached to
    // images (alt, title, aria-label, figcaption) is valuable for help/docs sites
    // where screenshots carry important UI context.
    const imageDescriptions = [];
    const images = contentContainer.querySelectorAll('img[alt], img[title], img[aria-label]');
    images.forEach(img => {
      const desc = (img.getAttribute('alt') || img.getAttribute('title') || img.getAttribute('aria-label') || '').trim();
      // Skip decorative/empty alts and very generic ones
      if (desc.length > 3 && !/^(image|photo|pic|icon|logo|banner|screenshot)$/i.test(desc)) {
        imageDescriptions.push(`[Image: ${desc}]`);
      }
    });
    if (imageDescriptions.length > 0 && totalLength < maxLength) {
      const imgText = imageDescriptions.join(' ') + '\n';
      textParts.push(imgText);
      totalLength += imgText.length;
      console.log(`  🖼️ Captured ${imageDescriptions.length} image descriptions`);
    }

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
      } else if (element.matches('figcaption')) {
        text = '[Caption: ' + text + ']\n';
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

    // Fallback 1: If structured extraction got little text, try text-density scoring
    if (fullText.length < 200) {
      console.warn(`⚠️ Structured extraction only got ${fullText.length} chars, trying density-based extraction`);

      // Score direct children of body by text density: textLength / totalHTML length
      // High-density nodes are likely content; low-density are nav/chrome
      const bodyChildren = Array.from(document.body.children).filter(el => {
        const tag = el.tagName?.toLowerCase();
        return tag !== 'script' && tag !== 'style' && tag !== 'link' && tag !== 'noscript';
      });

      const scored = bodyChildren.map(el => {
        const textLen = (el.innerText || '').trim().length;
        const htmlLen = el.innerHTML?.length || 1;
        const density = textLen / htmlLen;
        return { el, textLen, density };
      }).filter(s => s.textLen > 50); // Skip near-empty nodes

      // Sort by text density (descending), then by text length
      scored.sort((a, b) => b.density - a.density || b.textLen - a.textLen);

      // Take top 3 highest-density nodes
      const densityText = scored.slice(0, 3).map(s => {
        let text = (s.el.innerText || '').trim();
        if (text.length > maxLength / 3) text = text.substring(0, Math.floor(maxLength / 3));
        return text;
      }).join('\n\n');

      if (densityText.length >= 200) {
        const cleanDensity = densityText.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();
        console.log(`✅ Density-based extraction got ${cleanDensity.length} chars from ${scored.length} candidate nodes`);
        return cleanDensity.substring(0, maxLength);
      }

      // Fallback 2: Simple body innerText
      console.warn(`⚠️ Density extraction also short, using innerText fallback`);
      let fallbackText = document.body.innerText || document.body.textContent || '';

      if (fallbackText.length < 200) {
        fallbackText = document.body.textContent || '';
      }

      fallbackText = fallbackText.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();

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

  /**
   * Extract error message patterns from the page
   */
  extractErrorPatterns() {
    const patterns = [];
    const seen = new Set();

    // Common error message selectors
    const errorSelectors = [
      '.error', '.error-message', '.error-text', '.has-error',
      '.alert-danger', '.alert-error', '.validation-error',
      '[role="alert"]', '.invalid-feedback', '.field-error',
      '.form-error', '.input-error', '.text-danger', '.text-error',
      '[aria-invalid="true"] + .error', '.help-block.error',
      '.parsley-errors-list', '.errorMessage', '.form-text.text-danger'
    ];

    const errorElements = document.querySelectorAll(errorSelectors.join(', '));

    Array.from(errorElements).slice(0, 20).forEach(el => {
      const message = el.textContent.trim();
      if (message && message.length > 2 && message.length < 200 && !seen.has(message)) {
        seen.add(message);

        // Try to find associated field
        const field = this.findAssociatedField(el);

        patterns.push({
          message: message,
          type: this.categorizeError(message),
          field: field,
          selector: this.getSelector(el),
          visible: this.isVisible(el)
        });
      }
    });

    return patterns;
  }

  /**
   * Find field associated with an error message
   */
  findAssociatedField(errorEl) {
    // Check for aria-describedby reference
    const describedById = errorEl.id;
    if (describedById) {
      const field = document.querySelector(`[aria-describedby="${describedById}"]`);
      if (field) return field.name || field.id;
    }

    // Check for label relationship
    const label = errorEl.closest('label');
    if (label && label.htmlFor) {
      return label.htmlFor;
    }

    // Check sibling input
    const siblingInput = errorEl.previousElementSibling?.matches('input, select, textarea')
      ? errorEl.previousElementSibling
      : errorEl.parentElement?.querySelector('input, select, textarea');

    if (siblingInput) {
      return siblingInput.name || siblingInput.id;
    }

    // Check parent form-group
    const formGroup = errorEl.closest('.form-group, .field-wrapper, .input-group');
    if (formGroup) {
      const input = formGroup.querySelector('input, select, textarea');
      if (input) return input.name || input.id;
    }

    return null;
  }

  /**
   * Categorize error message type
   */
  categorizeError(message) {
    const lowerMessage = message.toLowerCase();

    if (lowerMessage.match(/required|empty|blank|missing/)) return 'required';
    if (lowerMessage.match(/email|@/)) return 'email-format';
    if (lowerMessage.match(/password|weak|strong/)) return 'password';
    if (lowerMessage.match(/min|max|length|character/)) return 'length';
    if (lowerMessage.match(/number|numeric|digit/)) return 'numeric';
    if (lowerMessage.match(/date|time/)) return 'date';
    if (lowerMessage.match(/match|confirm|same/)) return 'match';
    if (lowerMessage.match(/unique|exist|already|taken/)) return 'uniqueness';
    if (lowerMessage.match(/invalid|incorrect|format/)) return 'format';
    if (lowerMessage.match(/server|network|connection/)) return 'server';
    if (lowerMessage.match(/permission|access|denied|unauthorized/)) return 'permission';

    return 'validation';
  }

  /**
   * Detect page-level hints for testing
   */
  detectPageHints() {
    const hints = {};

    // Lazy load detection
    const lazyImages = document.querySelectorAll('img[loading="lazy"], img[data-src], img.lazyload, [data-lazy]');
    if (lazyImages.length > 0) {
      hints.hasLazyLoad = true;
      hints.lazyLoadCount = lazyImages.length;
    }

    // Infinite scroll detection
    const infiniteScrollIndicators = document.querySelectorAll(
      '[data-infinite-scroll], .infinite-scroll, [class*="infinite"], [data-next-page]'
    );
    if (infiniteScrollIndicators.length > 0 || this.hasScrollListener()) {
      hints.hasInfiniteScroll = true;
    }

    // Dynamic content detection
    const dynamicContainers = document.querySelectorAll(
      '[data-loading], [data-loaded], .loading, .skeleton, [class*="loading"], [class*="skeleton"]'
    );
    if (dynamicContainers.length > 0) {
      hints.hasDynamicContent = true;
    }

    // Modal/Dialog detection
    const modals = document.querySelectorAll('[role="dialog"], .modal, [aria-modal="true"]');
    if (modals.length > 0) {
      hints.hasModals = true;
      hints.modalCount = modals.length;
    }

    // Expandable content detection
    const expandables = document.querySelectorAll('[aria-expanded], .accordion, .collapsible, [data-toggle="collapse"]');
    if (expandables.length > 0) {
      hints.hasExpandableContent = true;
      hints.expandableCount = expandables.length;
    }

    // Tab content detection
    const tabs = document.querySelectorAll('[role="tablist"], .tabs, .tab-content');
    if (tabs.length > 0) {
      hints.hasTabs = true;
    }

    // Tooltip/Popover detection
    const tooltips = document.querySelectorAll('[data-toggle="tooltip"], [data-tooltip], .tooltip, [title]:not(a):not(img)');
    if (tooltips.length > 5) {
      hints.hasTooltips = true;
    }

    // Real-time update indicators
    const realTimeElements = document.querySelectorAll(
      '[data-live], [data-refresh], .live-update, [class*="realtime"], [class*="live"]'
    );
    if (realTimeElements.length > 0) {
      hints.hasRealTimeUpdates = true;
    }

    // Check for SPA framework indicators
    hints.spaFramework = this.detectSPAFramework();

    // Keyboard shortcuts detection
    if (document.querySelector('[data-hotkey], [accesskey]')) {
      hints.hasKeyboardShortcuts = true;
    }

    return hints;
  }

  /**
   * Check if page has scroll event listeners (for infinite scroll)
   */
  hasScrollListener() {
    // Check for common infinite scroll libraries
    return !!(
      window.IntersectionObserver ||
      document.querySelector('[data-observer], [data-waypoint]') ||
      typeof window.InfiniteScroll !== 'undefined'
    );
  }

  /**
   * Detect SPA framework
   */
  detectSPAFramework() {
    // ── React ────────────────────────────────────────────────────────────────
    // Legacy markers (React <=17) + the DevTools hook (only present when the
    // DevTools extension is installed — unreliable on its own).
    if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__ || document.querySelector('[data-reactroot], [data-reactid]')) {
      return 'react';
    }
    if (window.__VUE__ || document.querySelector('[data-v-]')) {
      return 'vue';
    }
    if (window.ng || document.querySelector('[ng-version], [_ngcontent]')) {
      return 'angular';
    }
    if (window.Ember || document.querySelector('.ember-view')) {
      return 'ember';
    }
    if (window.__NEXT_DATA__) {
      return 'nextjs';
    }
    if (window.__NUXT__) {
      return 'nuxt';
    }
    // ── Svelte / SvelteKit ─────────────────────────────────────────────────────
    if (window.__svelte || document.querySelector('[class*="svelte-"]') || document.querySelector('#svelte')) {
      return 'svelte';
    }
    // ── Modern React (18+ createRoot) ──────────────────────────────────────────
    // createRoot apps drop data-reactroot/data-reactid entirely, so the legacy
    // check above misses them. React attaches fiber state to the mount node via
    // properties like `_reactRootContainer` (17) or `__reactContainer$<hash>` /
    // `__reactFiber$<hash>` (18). Scan the common mount nodes for those keys.
    if (this.hasReactFiber()) {
      return 'react';
    }
    // ── Generic SPA heuristic (custom/unknown frameworks, web components) ───────
    // A near-empty <body> whose content lives under a single mount node, paired
    // with a script-heavy <head>, is almost certainly a client-rendered SPA even
    // when we can't name the framework. Returning a non-null value here makes the
    // crawler apply its hydration wait instead of extracting an empty shell.
    if (this.looksLikeGenericSpa()) {
      return 'spa-generic';
    }
    return null;
  }

  /** True when a common mount node carries a React fiber/root property. */
  hasReactFiber() {
    try {
      const roots = [
        document.getElementById('root'),
        document.getElementById('app'),
        document.getElementById('__next'),
        document.body && document.body.firstElementChild,
      ];
      for (const el of roots) {
        if (!el) continue;
        if (el._reactRootContainer) return true;
        for (const key in el) {
          if (key.startsWith('__reactContainer$') || key.startsWith('__reactFiber$')) return true;
        }
      }
    } catch (_) { /* defensive: cross-origin / detached nodes */ }
    return false;
  }

  /**
   * Heuristic for unnamed client-rendered SPAs: a single empty mount node plus a
   * script-heavy document and very little static body text.
   */
  looksLikeGenericSpa() {
    try {
      const mount = document.querySelector('#root, #app, #__next, [data-reactroot], main[role="main"]:empty');
      const scriptCount = document.querySelectorAll('script[src]').length;
      const bodyText = (document.body && document.body.innerText ? document.body.innerText : '').trim();
      if (mount && scriptCount >= 1 && bodyText.length < 200) return true;
    } catch (_) { /* ignore */ }
    return false;
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
