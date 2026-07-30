const crypto = require('crypto');

const MAX_COOKIE_BYTES = 64 * 1024;
const MAX_ENCRYPTED_SECRET_BYTES = 256 * 1024;
const MAX_SSO_USERNAME_CHARS = 128;
const MAX_SSO_USERNAME_BYTES = 512;
const MAX_SSO_PASSWORD_BYTES = 4096;

function credentialLimitError(name, maxBytes) {
  const error = new TypeError(`${name} exceeds the ${maxBytes}-byte limit`);
  error.code = 'CREDENTIAL_LIMIT_EXCEEDED';
  return error;
}

function validateCookie(cookie) {
  if (typeof cookie !== 'string') throw new TypeError('cookie must be a string');
  if (Buffer.byteLength(cookie, 'utf8') > MAX_COOKIE_BYTES) {
    throw credentialLimitError('cookie', MAX_COOKIE_BYTES);
  }
  return cookie;
}

function normalizeUsername(username) {
  if (typeof username !== 'string'
      || username.length > MAX_SSO_USERNAME_CHARS
      || Buffer.byteLength(username, 'utf8') > MAX_SSO_USERNAME_BYTES
      || /[\r\n\0]/.test(username)) {
    throw new TypeError('username is invalid');
  }
  return username.trim();
}

function validatePassword(password) {
  if (typeof password !== 'string') throw new TypeError('password is invalid');
  if (Buffer.byteLength(password, 'utf8') > MAX_SSO_PASSWORD_BYTES) {
    throw credentialLimitError('password', MAX_SSO_PASSWORD_BYTES);
  }
  return password;
}

class CredentialStore {
  constructor({ safeStorage, settings, persist, userDataPath, onWarning = () => {} }) {
    this.safeStorage = safeStorage;
    this.settings = settings;
    this.persist = persist;
    this.userDataPath = userDataPath;
    this.onWarning = onWarning;
    this.ephemeralCookie = '';
  }

  isEncryptionAvailable() {
    try {
      if (!this.safeStorage.isEncryptionAvailable()) return false;
      if (process.platform === 'linux' && typeof this.safeStorage.getSelectedStorageBackend === 'function') {
        const backend = this.safeStorage.getSelectedStorageBackend();
        if (backend === 'basic_text' || backend === 'unknown') return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  _encrypt(value) {
    if (!this.isEncryptionAvailable()) {
      const error = new Error('OS credential encryption is unavailable');
      error.code = 'SECURE_STORAGE_UNAVAILABLE';
      throw error;
    }
    const encrypted = this.safeStorage.encryptString(value);
    if (!Buffer.isBuffer(encrypted) || encrypted.length > MAX_ENCRYPTED_SECRET_BYTES) {
      throw credentialLimitError('encrypted credential', MAX_ENCRYPTED_SECRET_BYTES);
    }
    return encrypted.toString('base64');
  }

  _decrypt(value) {
    if (!value || !this.isEncryptionAvailable()) return '';
    if (typeof value !== 'string'
        || Buffer.byteLength(value, 'ascii') > MAX_ENCRYPTED_SECRET_BYTES * 2) {
      throw credentialLimitError('encrypted credential', MAX_ENCRYPTED_SECRET_BYTES * 2);
    }
    const encrypted = Buffer.from(value, 'base64');
    if (encrypted.length > MAX_ENCRYPTED_SECRET_BYTES) {
      throw credentialLimitError('encrypted credential', MAX_ENCRYPTED_SECRET_BYTES);
    }
    return this.safeStorage.decryptString(encrypted);
  }

  _commit(patch, removed = []) {
    const previous = {};
    for (const key of [...Object.keys(patch), ...removed]) {
      previous[key] = { exists: Object.hasOwn(this.settings, key), value: this.settings[key] };
    }
    Object.assign(this.settings, patch);
    for (const key of removed) delete this.settings[key];
    try {
      this.persist(this.settings);
    } catch (error) {
      for (const [key, snapshot] of Object.entries(previous)) {
        if (snapshot.exists) this.settings[key] = snapshot.value;
        else delete this.settings[key];
      }
      throw error;
    }
  }

  _decodeLegacyXor(value) {
    if (typeof value !== 'string'
        || Buffer.byteLength(value, 'ascii') > MAX_ENCRYPTED_SECRET_BYTES * 2) {
      throw credentialLimitError('legacy credential', MAX_ENCRYPTED_SECRET_BYTES * 2);
    }
    const key = crypto.createHash('md5').update(this.userDataPath).digest();
    const bytes = Buffer.from(value.slice(4), 'base64');
    for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= key[index % key.length];
    return bytes.toString('utf8');
  }

  migrateLegacySecrets() {
    const patch = {};
    const removed = [];

    if (this.settings.savedCookie) {
      try {
        validateCookie(this.settings.savedCookie);
        this.ephemeralCookie = this.settings.savedCookie;
        if (this.isEncryptionAvailable()) {
          patch.savedCookieEncrypted = this._encrypt(this.settings.savedCookie);
        } else {
          this.onWarning('Removed a plaintext saved Cookie because OS encryption is unavailable');
        }
      } catch (error) {
        this.onWarning(`Removed an invalid plaintext saved Cookie: ${error.message}`);
      }
      removed.push('savedCookie');
    }

    if (this.settings.ssoPassword?.startsWith('xor:')) {
      try {
        if (!this.isEncryptionAvailable()) throw new Error('OS encryption is unavailable');
        const legacyPassword = validatePassword(this._decodeLegacyXor(this.settings.ssoPassword));
        patch.ssoPassword = this._encrypt(legacyPassword);
      } catch (error) {
        patch.ssoPassword = '';
        this.onWarning(`Removed a legacy-obfuscated SSO password: ${error.message}`);
      }
    }

    if (this.settings.ssoUsername) {
      try {
        const normalizedUsername = normalizeUsername(this.settings.ssoUsername);
        if (normalizedUsername !== this.settings.ssoUsername) patch.ssoUsername = normalizedUsername;
      } catch (error) {
        patch.ssoUsername = '';
        this.onWarning(`Removed an invalid SSO username: ${error.message}`);
      }
    }

    if (Object.keys(patch).length > 0 || removed.length > 0) this._commit(patch, removed);
  }

  getCookie() {
    if (this.ephemeralCookie) return this.ephemeralCookie;
    try {
      return validateCookie(this._decrypt(this.settings.savedCookieEncrypted));
    } catch (error) {
      this.onWarning(`Saved Cookie could not be decrypted: ${error.message}`);
      return '';
    }
  }

  saveCookie(cookie) {
    if (cookie === '') return this.clearCookie();
    validateCookie(cookie);
    if (!this.isEncryptionAvailable()) {
      this._commit({ savedCookieEncrypted: '' }, ['savedCookie']);
      this.ephemeralCookie = cookie;
      return false;
    }
    const encrypted = this._encrypt(cookie);
    this._commit({ savedCookieEncrypted: encrypted }, ['savedCookie']);
    this.ephemeralCookie = cookie;
    return true;
  }

  clearCookie() {
    this._commit({ savedCookieEncrypted: '' }, ['savedCookie']);
    this.ephemeralCookie = '';
    return true;
  }

  getSsoStatus() {
    let username = '';
    try { username = normalizeUsername(this.settings.ssoUsername || ''); } catch (_) {}
    return {
      username,
      hasPassword: Boolean(this.settings.ssoPassword),
      storageAvailable: this.isEncryptionAvailable(),
    };
  }

  getSsoPassword() {
    if (!this.settings.ssoPassword || this.settings.ssoPassword.startsWith('xor:')) return '';
    try {
      return validatePassword(this._decrypt(this.settings.ssoPassword));
    } catch (error) {
      this.onWarning(`SSO password could not be decrypted: ${error.message}`);
      return '';
    }
  }

  saveSso({ username, password, clearPassword = false }) {
    const normalizedUsername = normalizeUsername(username);
    if (password !== undefined) validatePassword(password);

    const patch = { ssoUsername: normalizedUsername };
    if (clearPassword) patch.ssoPassword = '';
    else if (password) patch.ssoPassword = this._encrypt(password);
    this._commit(patch);
    return this.getSsoStatus();
  }

  clearSso() {
    this._commit({ ssoUsername: '', ssoPassword: '' });
    return this.getSsoStatus();
  }
}

module.exports = {
  CredentialStore,
  MAX_COOKIE_BYTES,
  MAX_ENCRYPTED_SECRET_BYTES,
  MAX_SSO_PASSWORD_BYTES,
  MAX_SSO_USERNAME_BYTES,
  validateCookie,
};
