/**
 * Runtime host access.
 *
 * The manifest grants only the fixed API hosts QAtalyst always talks to (Jira
 * Cloud, the LLM providers, Figma, Google, Xray/Qmetry/Zephyr cloud). Anything
 * user-specific — the app under test, a self-hosted Jira/Confluence, a TestRail
 * instance — is declared as an optional host permission and requested here, per
 * site, at the moment the user asks for it. That keeps the install-time warning
 * at "these known services" instead of "all your data on all websites".
 *
 * chrome.permissions.request() needs a live user gesture: call it before any
 * other `await` in the click handler.
 */
(function () {

/** Two-letter-ccTLD second levels like co.uk / com.au. */
const CC_SLD = /^(?:co|com|net|org|gov|edu|ac|or|ne|go)$/;

/**
 * Registrable domain of a hostname, e.g. app.eu.example.com → example.com.
 * ponytail: naive public-suffix heuristic (handles co.uk-style ccTLDs); swap in
 * a real PSL if a customer's domain is mis-scoped.
 */
function registrableDomain(hostname) {
  const labels = hostname.split('.');
  if (labels.length <= 2) return hostname;
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  const take = tld.length === 2 && CC_SLD.test(sld) ? 3 : 2;
  return labels.slice(-take).join('.');
}

const isIp = (h) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(h) || h.includes(':');

/**
 * Match pattern for a URL, or null if it isn't a web URL.
 * `siblings: true` widens to every subdomain of the site, so the network monitor
 * still sees API calls the app makes to api.example.com while crawling
 * app.example.com.
 */
function originPattern(url, { siblings = false } = {}) {
  let u;
  try { u = new URL(url); } catch (_) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  // The URL's own scheme: Chrome's permissions.contains() says no to "*://host/*"
  // when only "http://host/*" was granted, so a wildcard scheme made granted
  // sites look ungranted.
  const scheme = u.protocol.slice(0, -1);
  if (!siblings || host === 'localhost' || isIp(host)) return `${scheme}://${host}/*`;
  return `${scheme}://*.${registrableDomain(host)}/*`;
}

/**
 * Request access to the given URLs' sites. Resolves { granted, origins }.
 * Already-granted origins resolve true without a prompt.
 */
async function requestHostAccess(urls, opts) {
  const origins = [...new Set((urls || []).map(u => originPattern(u, opts)).filter(Boolean))];
  if (!origins.length) return { granted: true, origins };
  const granted = await chrome.permissions.request({ origins });
  return { granted, origins };
}

/** Does the extension already have access to this URL's site? */
async function hasHostAccess(url, opts) {
  const origin = originPattern(url, opts);
  return origin ? chrome.permissions.contains({ origins: [origin] }) : false;
}

const api = { registrableDomain, originPattern, requestHostAccess, hasHostAccess };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') self.HostPermissions = api;
})();
