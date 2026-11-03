// Security utilities for QAtalyst
// Handles API key encryption, XSS sanitization, and secure storage

// Prevent redeclaration errors if script is injected multiple times
if (typeof SecurityManager === 'undefined') {
  class SecurityManager {
    // Passphrase-sealed values. OWASP (2023) recommends 600k PBKDF2-SHA256
    // iterations for user-chosen secrets.
    static PASS_PREFIX = 'encp:';
    static PASSPHRASE_ITERATIONS = 600000;
    static LOCKED_MESSAGE = 'QAtalyst is locked: your API keys are protected by a passphrase. Open Advanced Settings and unlock to continue.';

    constructor() {
      this.encoder = new TextEncoder();
      this.decoder = new TextDecoder();
    }

  /**
   * Generate a random salt for encryption
   */
  generateSalt() {
    return crypto.getRandomValues(new Uint8Array(APP_CONFIG.SECURITY.SALT_LENGTH));
  }

  /**
   * Derive encryption key from password using PBKDF2
   */
  async deriveKey(password, salt, iterations = APP_CONFIG.SECURITY.PBKDF2_ITERATIONS) {
    const passwordKey = await crypto.subtle.importKey(
      'raw',
      this.encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveBits', 'deriveKey']
    );

    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations,
        hash: 'SHA-256'
      },
      passwordKey,
      {
        name: APP_CONFIG.SECURITY.ENCRYPTION_ALGORITHM,
        length: APP_CONFIG.SECURITY.KEY_LENGTH
      },
      false,
      ['encrypt', 'decrypt']
    );
  }

  /**
   * Encrypt API key with AES-GCM
   * @param {string} apiKey - The API key to encrypt
   * @param {string} password - User password (optional, uses device ID if not provided)
   * @returns {Promise<{encrypted: string, salt: string, iv: string}>}
   */
  async encryptApiKey(apiKey, password = null, iterations = undefined) {
    try {
      // Use device-specific identifier if no password provided
      const encryptionPassword = password || await this.getDeviceIdentifier();

      // Generate salt and IV
      const salt = this.generateSalt();
      const iv = crypto.getRandomValues(new Uint8Array(APP_CONFIG.SECURITY.IV_LENGTH));

      // Derive encryption key
      const key = await this.deriveKey(encryptionPassword, salt, iterations);

      // Encrypt the API key
      const encryptedBuffer = await crypto.subtle.encrypt(
        {
          name: APP_CONFIG.SECURITY.ENCRYPTION_ALGORITHM,
          iv: iv
        },
        key,
        this.encoder.encode(apiKey)
      );

      // Convert to base64 for storage
      return {
        encrypted: this.arrayBufferToBase64(encryptedBuffer),
        salt: this.arrayBufferToBase64(salt),
        iv: this.arrayBufferToBase64(iv)
      };
    } catch (error) {
      console.error('Encryption failed:', error);
      throw new Error('Failed to encrypt API key');
    }
  }

  /**
   * Decrypt API key
   * @param {string} encryptedData - Base64 encoded encrypted data
   * @param {string} saltBase64 - Base64 encoded salt
   * @param {string} ivBase64 - Base64 encoded IV
   * @param {string} password - User password (optional)
   * @returns {Promise<string>} Decrypted API key
   */
  async decryptApiKey(encryptedData, saltBase64, ivBase64, password = null, iterations = undefined) {
    try {
      // Use device-specific identifier if no password provided
      const encryptionPassword = password || await this.getDeviceIdentifier();

      // Convert from base64
      const encrypted = this.base64ToArrayBuffer(encryptedData);
      const salt = this.base64ToArrayBuffer(saltBase64);
      const iv = this.base64ToArrayBuffer(ivBase64);

      // Derive decryption key
      const key = await this.deriveKey(encryptionPassword, salt, iterations);

      // Decrypt
      const decryptedBuffer = await crypto.subtle.decrypt(
        {
          name: APP_CONFIG.SECURITY.ENCRYPTION_ALGORITHM,
          iv: iv
        },
        key,
        encrypted
      );

      return this.decoder.decode(decryptedBuffer);
    } catch (error) {
      console.error('Decryption failed:', error);
      throw new Error('Failed to decrypt API key');
    }
  }

  /**
   * Get a per-installation unique encryption key
   * Generates a random key on first use and stores it in chrome.storage.local
   */
  async getDeviceIdentifier() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['_qatalyst_enc_key'], async (result) => {
        if (result._qatalyst_enc_key) {
          resolve(result._qatalyst_enc_key);
        } else {
          // Generate a random 32-byte key unique to this installation
          const randomBytes = crypto.getRandomValues(new Uint8Array(32));
          const key = 'qk-' + Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
          chrome.storage.local.set({ _qatalyst_enc_key: key }, () => {
            resolve(key);
          });
        }
      });
    });
  }

  /**
   * Convert ArrayBuffer to Base64
   */
  arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Convert Base64 to ArrayBuffer
   */
  base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  /**
   * Encrypt and encode API key for storage
   * Returns a single string that can be stored directly
   * @param {string} apiKey - Plain text API key
   * @param {string} password - Optional password
   * @returns {Promise<string>} Encrypted key as JSON string with "enc:" prefix
   */
  async encryptApiKeyForStorage(apiKey, password = null) {
    if (!apiKey || typeof apiKey !== 'string') {
      return apiKey; // Return as-is if invalid
    }
    if (apiKey.startsWith('enc:') || apiKey.startsWith(SecurityManager.PASS_PREFIX)) return apiKey; // already sealed

    // Passphrase protection: seal with the user's passphrase, never fall back to the
    // weaker device key silently.
    if (!password && await this.getProtectionMode() === 'passphrase') {
      const pass = await this.getSessionPassphrase();
      if (!pass) throw new Error(SecurityManager.LOCKED_MESSAGE);
      const sealed = await this.encryptApiKey(apiKey, pass, SecurityManager.PASSPHRASE_ITERATIONS);
      return SecurityManager.PASS_PREFIX + JSON.stringify(sealed);
    }

    try {
      const encrypted = await this.encryptApiKey(apiKey, password);
      // Store as JSON with a prefix to identify encrypted values
      return 'enc:' + JSON.stringify(encrypted);
    } catch (error) {
      console.error('Failed to encrypt API key for storage:', error);
      throw new Error('Encryption failed. API key cannot be stored securely. Please check your browser settings and try again.');
    }
  }

  /**
   * Decrypt API key from storage
   * Handles both encrypted and plain text values for migration
   * @param {string} storedValue - Value from storage
   * @param {string} password - Optional password
   * @returns {Promise<string>} Decrypted API key
   */
  async decryptApiKeyFromStorage(storedValue, password = null) {
    if (!storedValue || typeof storedValue !== 'string') {
      return storedValue; // Return as-is if invalid
    }

    if (storedValue.startsWith(SecurityManager.PASS_PREFIX)) {
      return this.decryptPassphraseValue(storedValue);
    }

    // Check if value is encrypted (has our prefix)
    if (!storedValue.startsWith('enc:')) {
      // Plain text value - return as-is for backward compatibility
      return storedValue;
    }

    try {
      // Remove prefix and parse JSON
      const jsonStr = storedValue.substring(4);
      const { encrypted, salt, iv } = JSON.parse(jsonStr);

      // Decrypt using the original method
      return await this.decryptApiKey(encrypted, salt, iv, password);
    } catch (error) {
      // F30: previously returned storedValue.substring(4) — i.e. the raw
      // ciphertext/JSON minus the "enc:" prefix — which would then be sent to the
      // provider as if it were the API key (guaranteed auth failure with a
      // confusing error, and it leaks ciphertext into request logs). Return null
      // so the caller can prompt the user to re-enter the key instead.
      console.error('Failed to decrypt API key from storage (corrupted or wrong device key):', error.message);
      return null;
    }
  }

  /**
   * Check if a stored value is encrypted
   * @param {string} storedValue - Value from storage
   * @returns {boolean} True if encrypted
   */
  isEncrypted(storedValue) {
    return !!storedValue && typeof storedValue === 'string' &&
      (storedValue.startsWith('enc:') || storedValue.startsWith(SecurityManager.PASS_PREFIX));
  }

  // ───────────── optional passphrase protection (see key-vault.js) ─────────────

  /** 'passphrase' when the user set one, else 'device'. */
  async getProtectionMode() {
    try {
      const r = await chrome.storage.local.get('_qatalyst_key_protection');
      return r._qatalyst_key_protection === 'passphrase' ? 'passphrase' : 'device';
    } catch (_) { return 'device'; }
  }

  /**
   * The passphrase lives only in chrome.storage.session: in memory, cleared when the
   * browser closes, and not readable by content scripts. null when locked or when
   * called from a context without access.
   */
  async getSessionPassphrase() {
    try {
      if (!chrome.storage || !chrome.storage.session) return null;
      const r = await chrome.storage.session.get('_qatalyst_passphrase');
      return r._qatalyst_passphrase || null;
    } catch (_) { return null; }
  }

  async decryptPassphraseValue(storedValue) {
    const pass = await this.getSessionPassphrase();
    if (!pass) {
      // A content script cannot read session storage: ask the service worker.
      const inWorker = typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope;
      if (!inWorker && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        const res = await chrome.runtime.sendMessage({ action: 'decryptSecret', value: storedValue });
        if (res && typeof res.value === 'string') return res.value;
      }
      throw new Error(SecurityManager.LOCKED_MESSAGE);
    }
    const { encrypted, salt, iv } = JSON.parse(storedValue.substring(SecurityManager.PASS_PREFIX.length));
    return this.decryptApiKey(encrypted, salt, iv, pass, SecurityManager.PASSPHRASE_ITERATIONS);
  }

  /**
   * Sanitize HTML to prevent XSS attacks
   * Removes dangerous tags and attributes
   * @param {string} html - HTML string to sanitize
   * @returns {string} Sanitized HTML
   */
  sanitizeHTML(html) {
    if (!html) return '';

    // Create a temporary DOM element
    const temp = document.createElement('div');
    temp.innerHTML = html;

    // Recursively sanitize all elements
    this.sanitizeNode(temp);

    return temp.innerHTML;
  }

  /**
   * Recursively sanitize a DOM node
   */
  sanitizeNode(node) {
    // Remove script tags entirely
    const scripts = node.querySelectorAll('script, iframe, object, embed');
    scripts.forEach(script => script.remove());

    // Check all elements
    const elements = node.querySelectorAll('*');
    elements.forEach(element => {
      // Remove elements not in allowed list
      if (!APP_CONFIG.SECURITY.ALLOWED_HTML_TAGS.includes(element.tagName.toLowerCase())) {
        element.remove();
        return;
      }

      // Remove dangerous attributes
      const attributes = Array.from(element.attributes);
      attributes.forEach(attr => {
        const attrName = attr.name.toLowerCase();

        // Remove event handlers
        if (attrName.startsWith('on')) {
          element.removeAttribute(attr.name);
          return;
        }

        // F39: constrain URL attributes to safe schemes rather than only
        // blocking javascript:. data: URLs (which could carry text/html) and
        // other exotic schemes are now dropped too; only http(s), mailto, tel
        // and same-page/relative anchors are allowed on href/src.
        if (attrName === 'href' || attrName === 'src') {
          const v = (attr.value || '').trim();
          const scheme = (v.match(/^([a-z][a-z0-9+.-]*):/i) || [])[1];
          const safeScheme = !scheme || /^(https?|mailto|tel)$/i.test(scheme);
          if (!safeScheme || v.toLowerCase().includes('javascript:')) {
            element.removeAttribute(attr.name);
            return;
          }
        } else if (attr.value && attr.value.toLowerCase().includes('javascript:')) {
          element.removeAttribute(attr.name);
          return;
        }

        // Only keep allowed attributes
        if (!APP_CONFIG.SECURITY.ALLOWED_ATTRIBUTES.includes(attrName)) {
          element.removeAttribute(attr.name);
        }
      });
    });
  }

  /**
   * Escape HTML special characters
   * Use for displaying user input as text
   */
  escapeHTML(text) {
    if (!text) return '';

    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Validate API key format
   */
  validateApiKey(apiKey, provider) {
    if (!apiKey || typeof apiKey !== 'string') {
      return false;
    }

    // Basic validation based on provider
    switch (provider) {
      case 'openai':
        // OpenAI keys start with 'sk-'
        return apiKey.startsWith('sk-') && apiKey.length > 20;

      case 'claude':
        // Claude keys start with 'sk-ant-'
        return apiKey.startsWith('sk-ant-') && apiKey.length > 30;

      case 'gemini':
        // Gemini keys are typically 39 characters
        return apiKey.length >= 30;

      case 'bedrock':
        // For bedrock, apiKey field holds the access key ID (AKIA..., 20 chars)
        // Also accept temporary credentials (ASIA...)
        return (apiKey.startsWith('AKIA') || apiKey.startsWith('ASIA')) && apiKey.length === 20;

      default:
        // Generic validation
        return apiKey.length >= 20;
    }
  }

  /**
   * Mask API key for display (show only last 4 characters)
   */
  maskApiKey(apiKey) {
    if (!apiKey || apiKey.length < 8) {
      return '****';
    }
    const lastFour = apiKey.slice(-4);
    return `${'*'.repeat(apiKey.length - 4)}${lastFour}`;
    }
  }

  // Make globally available (works in both window and service worker contexts)
  if (typeof window !== 'undefined') {
    window.SecurityManager = SecurityManager;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.SecurityManager = SecurityManager;
  }
}

// Create singleton instance (only if not already created)
if (typeof securityManager === 'undefined') {
  var securityManager = new SecurityManager();

  if (typeof window !== 'undefined') {
    window.securityManager = securityManager;
  }
  if (typeof globalThis !== 'undefined') {
    globalThis.securityManager = securityManager;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SecurityManager: (typeof globalThis !== 'undefined' ? globalThis.SecurityManager : undefined),
    securityManager: (typeof globalThis !== 'undefined' ? globalThis.securityManager : undefined),
  };
}
