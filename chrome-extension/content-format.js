/**
 * content-format.js — text/markdown formatting + safe-DOM builder helpers
 * extracted verbatim from content.js. These depend on `document` (for the
 * escape/builder helpers) but are otherwise self-contained and cohesive.
 *
 * IIFE-wrapped (content scripts share one page scope). Functions are exposed on
 * the page global so content.js — loaded AFTER this file by the manifest — keeps
 * calling them unchanged. Also exported via module.exports for unit tests; the
 * builder/escape helpers require a DOM (use `@vitest-environment happy-dom`).
 */
(function () {
  'use strict';

  /**
   * Escape HTML special characters to prevent XSS
   * @param {string} text - Text to escape
   * @returns {string} - Escaped text
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Create safe error message element
   * @param {string} message - Error message to display
   * @returns {HTMLElement} - Safe error element
   */
  function createSafeErrorMessage(message) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'qatalyst-error';

    const icon = document.createTextNode('❌ ');
    errorDiv.appendChild(icon);

    // Split by newlines and create separate lines
    const lines = message.split('\n');
    lines.forEach((line, index) => {
      if (index > 0) {
        errorDiv.appendChild(document.createElement('br'));
      }
      errorDiv.appendChild(document.createTextNode(line));
    });

    return errorDiv;
  }

  /**
   * Safely format and sanitize content for display
   * Prevents XSS by using textContent and controlled DOM creation
   * @param {string} content - Content to format
   * @returns {HTMLElement} - Safe DOM element
   */
  function createSafeFormattedContent(content) {
    const container = document.createElement('div');

    // Split content by lines
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      const lineDiv = document.createElement('div');

      // Process bold text **text**
      const boldRegex = /\*\*(.*?)\*\*/g;
      let lastIndex = 0;
      let match;

      while ((match = boldRegex.exec(line)) !== null) {
        // Add text before match
        if (match.index > lastIndex) {
          const textNode = document.createTextNode(line.substring(lastIndex, match.index));
          lineDiv.appendChild(textNode);
        }

        // Add bold text
        const strongElem = document.createElement('strong');
        strongElem.textContent = match[1];
        lineDiv.appendChild(strongElem);

        lastIndex = match.index + match[0].length;
      }

      // Add remaining text
      if (lastIndex < line.length) {
        const textNode = document.createTextNode(line.substring(lastIndex));
        lineDiv.appendChild(textNode);
      }

      // Handle bullet points
      if (line.trim().startsWith('- ')) {
        lineDiv.style.paddingLeft = '20px';
        lineDiv.textContent = '• ' + line.substring(2);
      }

      // If line is empty, add space
      if (line.trim() === '') {
        lineDiv.innerHTML = '&nbsp;';
      }

      container.appendChild(lineDiv);
    }

    return container;
  }

  function formatStreamingContent(content) {
    // Escape first (XSS-safe), then apply lightweight markdown for the live stream.
    return escapeHtml(content == null ? '' : String(content))
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/^- /gm, '• ')
      .replace(/\n/g, '<br>');
  }

  /**
   * Render a markdown string to safe HTML.
   * Security: the entire input is HTML-escaped FIRST (via escapeHtml), then only our
   * own tags are added — so any HTML/script in the model output is neutralised. Links
   * are restricted to http(s)/relative hrefs. Supports GFM pipe tables, headings,
   * ordered/unordered lists, fenced code, bold/italic/inline-code, links and rules.
   */
  function renderMarkdown(md) {
    if (md == null) return '';
    const src = String(md).replace(/\r\n?/g, '\n');
    const lines = src.split('\n');
    const out = [];
    let i = 0;

    const esc = (t) => escapeHtml(t == null ? '' : String(t));
    const inline = (text) => text
      .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line || '');
    const splitRow = (line) => {
      let s = line.trim();
      if (s.startsWith('|')) s = s.slice(1);
      if (s.endsWith('|')) s = s.slice(0, -1);
      return s.split('|').map(c => c.trim());
    };
    const isSpecial = (line, idx) =>
      /^(#{1,6})\s+/.test(line) ||
      /^\s*([-*_])\1{2,}\s*$/.test(line) ||
      /^\s*[-*+]\s+/.test(line) ||
      /^\s*\d+\.\s+/.test(line) ||
      /^```/.test(line.trim()) ||
      (line.includes('|') && isTableSep(lines[idx + 1]));

    while (i < lines.length) {
      const line = lines[i];

      // fenced code block
      if (/^```/.test(line.trim())) {
        const buf = []; i++;
        while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++; }
        i++;
        out.push(`<pre class="qa-md-code"><code>${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }

      // GFM pipe table (header row followed by a |---|---| separator)
      if (line.includes('|') && isTableSep(lines[i + 1])) {
        const header = splitRow(line); i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') { rows.push(splitRow(lines[i])); i++; }
        let t = '<table class="qa-md-table"><thead><tr>';
        header.forEach(h => { t += `<th>${inline(esc(h))}</th>`; });
        t += '</tr></thead><tbody>';
        rows.forEach(r => {
          t += '<tr>';
          header.forEach((_, ci) => { t += `<td>${inline(esc(r[ci] || ''))}</td>`; });
          t += '</tr>';
        });
        out.push(t + '</tbody></table>');
        continue;
      }

      // headings
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { const lvl = h[1].length; out.push(`<h${lvl} class="qa-md-h">${inline(esc(h[2].trim()))}</h${lvl}>`); i++; continue; }

      // horizontal rule
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr class="qa-md-hr">'); i++; continue; }

      // unordered list
      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, '')); i++; }
        out.push('<ul class="qa-md-list">' + items.map(it => `<li>${inline(esc(it))}</li>`).join('') + '</ul>');
        continue;
      }

      // ordered list
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, '')); i++; }
        out.push('<ol class="qa-md-list">' + items.map(it => `<li>${inline(esc(it))}</li>`).join('') + '</ol>');
        continue;
      }

      // blank line
      if (line.trim() === '') { i++; continue; }

      // paragraph (gather until a blank or special line)
      const para = [];
      while (i < lines.length && lines[i].trim() !== '' && !isSpecial(lines[i], i)) { para.push(lines[i]); i++; }
      if (para.length) out.push(`<p>${inline(esc(para.join(' ')))}</p>`);
    }

    return `<div class="qa-md">${out.join('\n')}</div>`;
  }

  /**
   * Inline-only markdown for short fields (titles, descriptions, steps, results).
   * Escapes first (XSS-safe), then renders bold/italic/inline-code/links and turns
   * newlines into <br>. No block-level parsing — keeps card layouts intact.
   */
  function inlineMarkdown(text) {
    if (text == null) return '';
    return escapeHtml(String(text))
      .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\n/g, '<br>');
  }

  function formatAnalysis(analysis) {
    if (analysis && typeof analysis === 'object') {
      // Structured analysis object — pretty-print as fenced JSON so it still renders.
      try { return renderMarkdown('```json\n' + JSON.stringify(analysis, null, 2) + '\n```'); }
      catch (_) { return `<pre>${escapeHtml(String(analysis))}</pre>`; }
    }
    return renderMarkdown(analysis);
  }

  function formatTestScope(scope) {
    if (!scope || scope === 'undefined' || scope === 'null') {
      return '<p class="qatalyst-warning">⚠️ No test scope was generated. Please try again.</p>';
    }
    return renderMarkdown(scope);
  }

  const api = {
    escapeHtml,
    createSafeErrorMessage,
    createSafeFormattedContent,
    formatStreamingContent,
    renderMarkdown,
    inlineMarkdown,
    formatAnalysis,
    formatTestScope,
  };

  // Expose on the page/global scope so content.js (loaded AFTER this file) can
  // call these exactly as it did when they were defined inline.
  if (typeof self !== 'undefined') Object.assign(self, api);
  else if (typeof window !== 'undefined') Object.assign(window, api);
  else if (typeof globalThis !== 'undefined') Object.assign(globalThis, api);

  // CommonJS export for unit tests.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
