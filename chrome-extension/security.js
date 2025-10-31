// Security utilities for QAtalyst
// Handles API key encryption, XSS sanitization, and secure storage

class SecurityManager {
  constructor() {
    this.encoder = new TextEncoder();
    this.decoder = new TextDecoder();
  }

  /**
   * Generate a random salt for encryption
   */
  generateSalt() {
    return crypto.getRandomValues(new Uint8Array(CONFIG.SECURITY.SALT_LENGTH));
  }

  /**
   * Derive encryption key from password using PBKDF2
   */
  async deriveKey(password, salt) {
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
        iterations: CONFIG.SECURITY.PBKDF2_ITERATIONS,
        hash: 'SHA-256'
      },
      passwordKey,
      {
        name: CONFIG.SECURITY.ENCRYPTION_ALGORITHM,
        length: CONFIG.SECURITY.KEY_LENGTH
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
  async encryptApiKey(apiKey, password = null) {
    try {
      // Use device-specific identifier if no password provided
      const encryptionPassword = password || await this.getDeviceIdentifier();

      // Generate salt and IV
      const salt = this.generateSalt();
      const iv = crypto.getRandomValues(new Uint8Array(CONFIG.SECURITY.IV_LENGTH));

      // Derive encryption key
      const key = await this.deriveKey(encryptionPassword, salt);

      // Encrypt the API key
      const encryptedBuffer = await crypto.subtle.encrypt(
        {
          name: CONFIG.SECURITY.ENCRYPTION_ALGORITHM,
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
  async decryptApiKey(encryptedData, saltBase64, ivBase64, password = null) {
    try {
      // Use device-specific identifier if no password provided
      const encryptionPassword = password || await this.getDeviceIdentifier();

      // Convert from base64
      const encrypted = this.base64ToArrayBuffer(encryptedData);
      const salt = this.base64ToArrayBuffer(saltBase64);
      const iv = this.base64ToArrayBuffer(ivBase64);

      // Derive decryption key
      const key = await this.deriveKey(encryptionPassword, salt);

      // Decrypt
      const decryptedBuffer = await crypto.subtle.decrypt(
        {
          name: CONFIG.SECURITY.ENCRYPTION_ALGORITHM,
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
   * Get a device-specific identifier for encryption
   * Uses extension ID as a consistent identifier
   */
  async getDeviceIdentifier() {
    // Use Chrome extension ID as device identifier
    const extensionId = chrome.runtime.id;
    return `qatalyst-${extensionId}`;
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

    try {
      const encrypted = await this.encryptApiKey(apiKey, password);
      // Store as JSON with a prefix to identify encrypted values
      return 'enc:' + JSON.stringify(encrypted);
    } catch (error) {
      console.error('Failed to encrypt API key for storage:', error);
      return apiKey; // Fallback to plain text if encryption fails
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
      console.error('Failed to decrypt API key from storage:', error);
      // If decryption fails, return the original value without the prefix
      // This handles corrupted encrypted data
      return storedValue.substring(4);
    }
  }

  /**
   * Check if a stored value is encrypted
   * @param {string} storedValue - Value from storage
   * @returns {boolean} True if encrypted
   */
  isEncrypted(storedValue) {
    return storedValue && typeof storedValue === 'string' && storedValue.startsWith('enc:');
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
      if (!CONFIG.SECURITY.ALLOWED_HTML_TAGS.includes(element.tagName.toLowerCase())) {
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

        // Remove javascript: URLs
        if (attr.value && attr.value.toLowerCase().includes('javascript:')) {
          element.removeAttribute(attr.name);
          return;
        }

        // Only keep allowed attributes
        if (!CONFIG.SECURITY.ALLOWED_ATTRIBUTES.includes(attrName)) {
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

// Create singleton instance
const securityManager = new SecurityManager();
