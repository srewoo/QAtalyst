/**
 * Shared text-similarity primitives (v13.3).
 *
 * Single source of truth for concept-level text matching: a synonym lexicon,
 * a light English stemmer, stopwords, and a TF-cosine over *canonicalised*
 * tokens. "Canonicalising" maps surface words to a shared concept — e.g.
 * sign-in / signin / authenticate / log-in → `login`, btn / cta → `button`,
 * creating / created → `create` — so two texts that mean the same thing score
 * as similar even when they share no literal tokens.
 *
 * Used by the AcceptanceGate's relevance check (concept overlap with the ticket
 * + app vocabulary) and available to the duplicate detector so the synonym list
 * lives in exactly one place.
 *
 * Pure logic, no browser dependency → fully unit-testable.
 *
 * Wrapped in an IIFE so it pollutes no global names (the service worker loads
 * every file into one shared scope via importScripts, where a stray top-level
 * `const STOPWORDS`/`stem` would collide with another file and throw at load).
 */
(function () {
// Concept lexicon: each group's first entry is the canonical concept token.
const SYNONYM_GROUPS = [
  ['click', 'tap', 'press', 'hit'],
  ['enter', 'type', 'input', 'fill', 'write'],
  ['verify', 'check', 'validate', 'assert', 'confirm', 'ensure'],
  ['navigate', 'go', 'open', 'browse', 'visit'],
  ['select', 'choose', 'pick'],
  ['submit', 'send', 'post'],
  ['delete', 'remove', 'erase', 'clear'],
  ['create', 'add', 'new', 'insert', 'register', 'signup'],
  ['update', 'edit', 'modify', 'change'],
  ['display', 'show', 'render', 'appear', 'visible'],
  ['hide', 'disappear', 'invisible', 'hidden'],
  ['error', 'fail', 'failure', 'exception', 'invalid'],
  ['success', 'succeed', 'passed', 'successful'],
  ['login', 'signin', 'sign-in', 'log-in', 'authenticate', 'auth', 'logon'],
  ['logout', 'signout', 'sign-out', 'log-out'],
  ['upload', 'attach', 'import'],
  ['download', 'export'],
  ['search', 'find', 'query', 'lookup', 'filter'],
  ['message', 'notification', 'alert', 'toast', 'banner', 'notify'],
  ['user', 'account', 'profile', 'member'],
  ['password', 'passcode', 'pwd', 'credential', 'credentials'],
  ['email', 'mail', 'e-mail'],
  ['page', 'screen', 'view', 'panel'],
  ['button', 'btn', 'cta'],
  ['form', 'dialog', 'modal', 'popup'],
  ['field', 'textbox', 'textarea', 'input'],
  ['valid', 'correct', 'proper', 'accepted'],
  ['invalid', 'incorrect', 'improper', 'rejected', 'wrong'],
  ['redirect', 'forward', 'route'],
  ['load', 'fetch', 'retrieve'],
  ['empty', 'blank', 'null', 'none'],
  ['enable', 'activate', 'turn-on'],
  ['disable', 'deactivate', 'turn-off'],
  ['save', 'store', 'persist'],
  ['cancel', 'abort', 'discard', 'close'],
  ['required', 'mandatory', 'compulsory'],
  ['optional', 'not-required'],
  ['detail', 'information', 'info'],
  ['payment', 'pay', 'checkout', 'billing', 'purchase'],
  ['cart', 'basket', 'bag'],
  ['session', 'token', 'cookie'],
  ['permission', 'access', 'authorize', 'authorization', 'role'],
];

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'under', 'again',
  'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
  'how', 'all', 'both', 'each', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than',
  'too', 'very', 'just', 'because', 'but', 'and', 'or', 'if', 'while',
  'about', 'up', 'out', 'off', 'over', 'down', 'that', 'this', 'these',
  'those', 'it', 'its', 'he', 'she', 'they', 'them', 'his', 'her',
  'their', 'we', 'our', 'you', 'your', 'who', 'which', 'what',
  'step', 'test', 'case', 'given', 'also', 'using', 'used', 'should',
  'displayed', 'shown', 'correct', 'ensure', 'system',
]);

/** Light English stemmer: strips common inflectional suffixes. */
function stem(word) {
  if (word.length < 4) return word;
  const suffixes = [
    { suffix: 'ation', minLen: 6 }, { suffix: 'tion', minLen: 5 },
    { suffix: 'sion', minLen: 5 }, { suffix: 'ment', minLen: 5 },
    { suffix: 'ness', minLen: 5 }, { suffix: 'able', minLen: 5 },
    { suffix: 'ible', minLen: 5 },
    { suffix: 'ying', minLen: 5, replace: 'y' }, { suffix: 'ting', minLen: 5, replace: 't' },
    { suffix: 'ning', minLen: 5, replace: 'n' }, { suffix: 'ring', minLen: 5, replace: 'r' },
    { suffix: 'ling', minLen: 5, replace: 'l' }, { suffix: 'king', minLen: 5, replace: 'k' },
    { suffix: 'ving', minLen: 5, replace: 've' }, { suffix: 'ding', minLen: 5, replace: 'd' },
    { suffix: 'ging', minLen: 5, replace: 'g' }, { suffix: 'bing', minLen: 5, replace: 'b' },
    { suffix: 'ping', minLen: 5, replace: 'p' }, { suffix: 'ing', minLen: 5 },
    { suffix: 'ity', minLen: 5 }, { suffix: 'ied', minLen: 4, replace: 'y' },
    { suffix: 'eed', minLen: 4 }, { suffix: 'ted', minLen: 4, replace: 't' },
    { suffix: 'ned', minLen: 4, replace: 'n' }, { suffix: 'red', minLen: 4, replace: 'r' },
    { suffix: 'sed', minLen: 4, replace: 's' }, { suffix: 'ded', minLen: 4, replace: 'd' },
    { suffix: 'ged', minLen: 4, replace: 'g' }, { suffix: 'ved', minLen: 4, replace: 've' },
    { suffix: 'ed', minLen: 4 }, { suffix: 'ly', minLen: 4 },
    { suffix: 'ies', minLen: 4, replace: 'y' }, { suffix: 'es', minLen: 4 },
    { suffix: 's', minLen: 4 },
  ];
  for (const { suffix, minLen, replace } of suffixes) {
    if (word.length >= minLen && word.endsWith(suffix)) {
      const s = word.slice(0, -suffix.length) + (replace || '');
      if (s.length >= 2) return s;
    }
  }
  return word;
}

// Reverse lookup word/stem → canonical concept, built once.
const SYNONYM_MAP = (() => {
  const map = {};
  for (const group of SYNONYM_GROUPS) {
    const canonical = group[0];
    for (const word of group) {
      map[word] = canonical;
      map[word.replace(/-/g, '')] = canonical;
      const st = stem(word);
      if (st !== word) map[st] = canonical;
      if (word.endsWith('e') && word.length >= 4) map[word.slice(0, -1)] = canonical;
    }
  }
  return map;
})();

/** Map a single surface token to its canonical concept (synonym → stem → self). */
function canonicalize(token) {
  if (SYNONYM_MAP[token]) return SYNONYM_MAP[token];
  const st = stem(token);
  return SYNONYM_MAP[st] || st;
}

/** Tokenize → drop stopwords/short tokens → canonicalize to concepts. */
function canonicalTokens(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t))
    .map(canonicalize)
    .filter(t => t && !STOPWORDS.has(t));
}

/** Term-frequency map for a list of tokens. */
function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

/** Cosine similarity between two TF maps (0..1). */
function cosineTF(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const [t, w] of small) { const o = large.get(t); if (o) dot += w * o; }
  let na = 0, nb = 0;
  for (const w of a.values()) na += w * w;
  for (const w of b.values()) nb += w * w;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Concept-level cosine similarity between two texts (0..1). Two texts that share
 * meaning but not wording (e.g. "user signs in" vs "authenticate the account")
 * score high; unrelated texts score ~0.
 */
function semanticCosine(textA, textB) {
  return cosineTF(termFreq(canonicalTokens(textA)), termFreq(canonicalTokens(textB)));
}

const TextSimilarity = {
  SYNONYM_GROUPS, STOPWORDS, SYNONYM_MAP,
  stem, canonicalize, canonicalTokens, termFreq, cosineTF, semanticCosine,
};

if (typeof module !== 'undefined' && module.exports) module.exports = TextSimilarity;
if (typeof self !== 'undefined') self.TextSimilarity = TextSimilarity;
})();
