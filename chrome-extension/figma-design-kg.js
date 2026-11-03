/**
 * figma-design-kg.js — a knowledge graph built from a Figma design, for tickets
 * whose app has not been crawled (often: the feature is not built yet).
 *
 * Without a crawl, grounding used to switch off entirely and every test was
 * "unverified". A linked design is weaker evidence than the running app, but it is
 * far better than nothing: it names the screens, buttons and fields the feature is
 * meant to have, so a test that invents a "Remember me" checkbox the design does
 * not contain can still be caught.
 *
 * Output has the crawler's page shape (pages[].features with button / form
 * entries), plus `source: 'design'` so callers label grounding "design", never
 * "verified": a match proves the DESIGN has the element, not that the app does.
 *
 * Pure: takes the Figma REST document JSON, returns plain objects.
 */
(function () {

const CONTROL_RE = /\b(button|btn|cta|link|tab|menu ?item|chip|toggle|switch|icon ?button|action)\b/i;
const FIELD_RE = /\b(input|text ?field|textfield|field|textarea|text ?area|select|dropdown|combo ?box|checkbox|radio|search|date ?picker)\b/i;
const MAX_SCREENS = 40;
const MAX_PER_SCREEN = 80;

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** First non-empty TEXT under a node, depth-first. */
function firstText(node, depth = 0) {
  if (!node || depth > 6) return '';
  if (node.type === 'TEXT' && clean(node.characters)) return clean(node.characters).slice(0, 80);
  for (const c of node.children || []) {
    const t = firstText(c, depth + 1);
    if (t) return t;
  }
  return '';
}

/** A layer name usable as a label: "Primary / Large" or "State=Hover" are variants, not labels. */
function nameLabel(node) {
  const n = clean(node.name);
  return n && !/[\/=]/.test(n) && !CONTROL_RE.test(n) && !FIELD_RE.test(n) ? n : '';
}

function collect(screen) {
  const buttons = [], fields = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (!node || depth > 12 || buttons.length + fields.length >= MAX_PER_SCREEN) return;
    const isBox = ['INSTANCE', 'COMPONENT', 'FRAME', 'GROUP'].includes(node.type);
    const name = clean(node.name);
    if (isBox && FIELD_RE.test(name)) {
      const label = firstText(node) || nameLabel(node);
      if (label && !seen.has('f:' + label.toLowerCase())) {
        seen.add('f:' + label.toLowerCase());
        fields.push({ name: label, label, type: (name.match(FIELD_RE) || [''])[0].toLowerCase() });
      }
      return; // a field's inner texts are its label/placeholder, not separate controls
    }
    if (isBox && CONTROL_RE.test(name)) {
      const label = firstText(node) || nameLabel(node);
      if (label && !seen.has('b:' + label.toLowerCase())) {
        seen.add('b:' + label.toLowerCase());
        buttons.push(label);
      }
      return;
    }
    for (const c of node.children || []) walk(c, depth + 1);
  };
  walk(screen, 0);
  return { buttons, fields };
}

/** Top-level frames are screens. Accepts a file document, a CANVAS, or a single node. */
function screensOf(root) {
  if (!root) return [];
  if (root.type === 'DOCUMENT') return (root.children || []).flatMap(screensOf);
  if (root.type === 'CANVAS') return (root.children || []).filter(n => ['FRAME', 'COMPONENT', 'SECTION'].includes(n.type));
  return [root];
}

/**
 * @param {object} root       Figma document (file `document`) or a node's `document`
 * @param {string} sourceUrl  the Figma link, used to key screens
 * @returns {{source:'design', appUrl:string, pages:object[]}|null}
 */
function designGraphFromFigma(root, sourceUrl) {
  const pages = [];
  for (const screen of screensOf(root).slice(0, MAX_SCREENS)) {
    const { buttons, fields } = collect(screen);
    if (!buttons.length && !fields.length) continue;
    const title = clean(screen.name) || 'Screen';
    const features = buttons.map(text => ({ type: 'button', text }));
    if (fields.length) features.push({ type: 'form', name: title, fields, inputs: fields.map(f => ({ name: f.name })) });
    pages.push({ url: `${sourceUrl}#${encodeURIComponent(title)}`, title, features, apis: [], links: [], source: 'design' });
  }
  return pages.length ? { source: 'design', appUrl: sourceUrl, pages, crawledAt: Date.now() } : null;
}

/** Merge the design graphs of every linked Figma file into one, or null. */
function mergeDesignGraphs(graphs) {
  const pages = (graphs || []).filter(Boolean).flatMap(g => g.pages || []);
  return pages.length ? { source: 'design', appUrl: (graphs.find(Boolean) || {}).appUrl, pages, crawledAt: Date.now() } : null;
}

const api = { designGraphFromFigma, mergeDesignGraphs };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') self.FigmaDesignKG = api;
})();
