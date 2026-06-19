/**
 * Crawler authentication (v13.3).
 *
 * Two ways to crawl auth-gated apps:
 *   1. Session reuse — if the user is already logged in, set
 *      `crawler.authentication.useCurrentSession: true` and the crawler inherits
 *      the tab's cookies (handled in crawler.navigate). No code here needed.
 *   2. Automated form login — this module: navigate to a login page, fill the
 *      username/password fields, submit, and wait for a success signal before
 *      the crawl proceeds. Session cookies then carry through the crawl.
 *
 * Out of scope (documented, not faked): MFA/2FA, SSO/OAuth redirects, CAPTCHA.
 * Those require human interaction; for them, use session reuse instead.
 *
 * The orchestration takes injected deps so it is unit-testable without a browser:
 *   deps = { navigate(url), fillAndSubmit(steps), getCurrentUrl(), sleep(ms) }
 */
(function () {

/** Validate an auth config. Returns { valid, errors[] }. Pure. */
function validateAuthConfig(cfg) {
  const errors = [];
  if (!cfg || typeof cfg !== 'object') return { valid: false, errors: ['no auth config'] };
  if (!cfg.loginUrl) errors.push('loginUrl is required');
  if (!cfg.usernameSelector) errors.push('usernameSelector is required');
  if (!cfg.passwordSelector) errors.push('passwordSelector is required');
  if (!cfg.username) errors.push('username is required');
  if (!cfg.password) errors.push('password is required');
  if (!cfg.submitSelector && !cfg.submitByEnter) {
    errors.push('submitSelector is required (or set submitByEnter:true)');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Did login succeed? Pure. Success when:
 *  - currentUrl matches successUrlPattern (substring or /regex/), OR
 *  - no pattern given and we've navigated AWAY from the login page.
 */
function matchesSuccess(currentUrl, cfg) {
  if (!currentUrl) return false;
  const pat = cfg.successUrlPattern;
  if (pat) {
    if (pat instanceof RegExp) return pat.test(currentUrl);
    const m = /^\/(.*)\/([gimsuy]*)$/.exec(String(pat));
    if (m) { try { return new RegExp(m[1], m[2]).test(currentUrl); } catch (_) { /* fall through */ } }
    return currentUrl.includes(String(pat));
  }
  // No explicit success pattern: treat "left the login URL" as success.
  return stripHash(currentUrl) !== stripHash(cfg.loginUrl);
}

function stripHash(u) { return String(u || '').split('#')[0].replace(/\/$/, ''); }

/** Build the ordered fill/submit step list executed in the page. Pure. */
function buildFillSteps(cfg) {
  const steps = [
    { action: 'fill', selector: cfg.usernameSelector, value: cfg.username },
    { action: 'fill', selector: cfg.passwordSelector, value: cfg.password },
  ];
  if (cfg.submitSelector) steps.push({ action: 'click', selector: cfg.submitSelector });
  else if (cfg.submitByEnter) steps.push({ action: 'enter', selector: cfg.passwordSelector });
  return steps;
}

class CrawlerAuth {
  /**
   * @param {object} cfg auth config (see validateAuthConfig)
   * @param {object} deps { navigate, fillAndSubmit, getCurrentUrl, sleep }
   */
  constructor(cfg, deps = {}) {
    this.cfg = cfg || {};
    this.deps = deps;
    this.maxWaitMs = cfg && cfg.maxWaitMs ? cfg.maxWaitMs : 15000;
    this.pollMs = cfg && cfg.pollMs ? cfg.pollMs : 500;
  }

  /**
   * Run the login flow. Returns { success, reason }. Never throws — a failed
   * login should degrade the crawl, not crash it (the caller decides whether to
   * proceed unauthenticated).
   */
  async authenticate() {
    const v = validateAuthConfig(this.cfg);
    if (!v.valid) return { success: false, reason: `invalid auth config: ${v.errors.join('; ')}` };

    try {
      await this.deps.navigate(this.cfg.loginUrl);
      await this.deps.fillAndSubmit(buildFillSteps(this.cfg));

      const deadline = Date.now() + this.maxWaitMs;
      // Note: Date.now() is fine in the service worker; tests inject a fake clock via deps.sleep.
      while (Date.now() < deadline) {
        const url = await this.deps.getCurrentUrl();
        if (matchesSuccess(url, this.cfg)) return { success: true, reason: 'login confirmed', url };
        await this.deps.sleep(this.pollMs);
      }
      return { success: false, reason: 'login not confirmed before timeout' };
    } catch (e) {
      return { success: false, reason: `login flow error: ${e && e.message ? e.message : e}` };
    }
  }
}

const api = { CrawlerAuth, validateAuthConfig, matchesSuccess, buildFillSteps };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof self !== 'undefined') Object.assign(self, { CrawlerAuth, validateAuthConfig, matchesSuccess, buildFillSteps });
})();
