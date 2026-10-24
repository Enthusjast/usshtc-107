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
  if (Buffer.byteLength(cookie, 'utf8') > MAX_COOKIE_BYTES) throw credentialLimitError('cookie', MAX_COOKIE_BYTES);
  return cookie;
}

function normalizeUsername(username) {
  if (typeof username !== 'string' || username.length > MAX_SSO_USERNAME_CHARS
      || Buffer.byteLength(username, 'utf8') > MAX_SSO_USERNAME_BYTES
      || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(username)) {
    throw new TypeError('username is invalid');
  }
  return username.trim();
}

function validatePassword(password) {
  if (typeof password !== 'string') throw new TypeError('password is invalid');
  if (Buffer.byteLength(password, 'utf8') > MAX_SSO_PASSWORD_BYTES) throw credentialLimitError('password', MAX_SSO_PASSWORD_BYTES);
  return password;
}

// Opaque, locked keyring values must survive migration without decrypting them.
function validateEncryptedSecret(value) {
  if (typeof value !== 'string') throw new TypeError('encrypted credential is invalid');
  if (Buffer.byteLength(value, 'utf8') > Math.ceil(MAX_ENCRYPTED_SECRET_BYTES / 3) * 4
      || Buffer.from(value, 'base64').length > MAX_ENCRYPTED_SECRET_BYTES) {
    throw credentialLimitError('encrypted credential', MAX_ENCRYPTED_SECRET_BYTES);
  }
  return value;
}

function persistenceError(result) {
  const error = new Error('Credential persistence failed');
  error.code = result?.errorCode || 'SETTINGS_SAVE_FAILED';
  return error;
}

class CredentialStore {
  constructor({ safeStorage, profileId, readSecrets, commitSecrets, userDataPath, onWarning = () => {} }) {
    if (typeof readSecrets !== 'function' || typeof commitSecrets !== 'function') {
      throw new TypeError('readSecrets and commitSecrets must be functions');
    }
    this.safeStorage = safeStorage;
    this.profileId = profileId;
    this.readSecrets = readSecrets;
    this.commitSecrets = commitSecrets;
    this.userDataPath = userDataPath;
    this.onWarning = onWarning;
    this.ephemeralCookie = '';
    this.cookieRevoked = false;
  }

  isEncryptionAvailable() {
    try {
      if (!this.safeStorage.isEncryptionAvailable()) return false;
      if (process.platform === 'linux' && typeof this.safeStorage.getSelectedStorageBackend === 'function') {
        const backend = this.safeStorage.getSelectedStorageBackend();
        if (backend === 'basic_text' || backend === 'unknown') return false;
      }
      return true;
    } catch (_) { return false; }
  }

  seal(value) {
    if (!this.isEncryptionAvailable()) {
      const error = new Error('OS credential encryption is unavailable');
      error.code = 'SECURE_STORAGE_UNAVAILABLE';
      throw error;
    }
    if (typeof value !== 'string') throw new TypeError('secret must be a string');
    const encrypted = this.safeStorage.encryptString(value);
    if (!Buffer.isBuffer(encrypted) || encrypted.length > MAX_ENCRYPTED_SECRET_BYTES) {
      throw credentialLimitError('encrypted credential', MAX_ENCRYPTED_SECRET_BYTES);
    }
    return encrypted.toString('base64');
  }

  unseal(value) {
    validateEncryptedSecret(value);
    if (!this.isEncryptionAvailable()) {
      const error = new Error('OS credential encryption is unavailable');
      error.code = 'SECURE_STORAGE_UNAVAILABLE';
      throw error;
    }
    if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
      throw new TypeError('encrypted credential is invalid');
    }
    return this.safeStorage.decryptString(Buffer.from(value, 'base64'));
  }

  _commit(patch) {
    const result = this.commitSecrets(this.cookieRevoked ? { ...patch, savedCookieEncrypted: '' } : patch);
    if (result?.state !== 'committed' || result.durable !== true) throw persistenceError(result);
    return result;
  }

  static migrateLegacySecrets(options, raw) {
    const policy = new CredentialStore({ ...options, profileId: 'default', readSecrets: () => ({}), commitSecrets: () => {} });
    const secrets = {
      ssoUsername: normalizeUsername(raw.ssoUsername ?? ''),
      ssoPassword: '',
      savedCookieEncrypted: validateEncryptedSecret(raw.savedCookieEncrypted ?? ''),
    };
    let ephemeralCookie = '';
    const password = raw.ssoPassword ?? '';
    if (typeof password !== 'string') throw new TypeError('password is invalid');
    if (password.startsWith('xor:')) {
      validateEncryptedSecret(password.slice(4));
      const key = crypto.createHash('md5').update(options.userDataPath).digest();
      const bytes = Buffer.from(password.slice(4), 'base64');
      for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= key[index % key.length];
      const plaintext = validatePassword(bytes.toString('utf8'));
      if (policy.isEncryptionAvailable()) secrets.ssoPassword = policy.seal(plaintext);
      else policy.onWarning('Removed a legacy-obfuscated SSO password because OS encryption is unavailable');
    } else {
      secrets.ssoPassword = validateEncryptedSecret(password);
    }
    if (!secrets.savedCookieEncrypted && Object.hasOwn(raw, 'savedCookie')) {
      ephemeralCookie = validateCookie(raw.savedCookie);
      if (policy.isEncryptionAvailable()) secrets.savedCookieEncrypted = policy.seal(ephemeralCookie);
      else policy.onWarning('Removed a plaintext saved Cookie because OS encryption is unavailable');
    }
    return { secrets, ephemeralCookie };
  }

  restoreEphemeralCookie(cookie) {
    this.ephemeralCookie = validateCookie(cookie);
    this.cookieRevoked = false;
  }

  getCookie() {
    if (this.cookieRevoked) return '';
    if (this.ephemeralCookie) return this.ephemeralCookie;
    const encrypted = this.readSecrets().savedCookieEncrypted;
    if (!encrypted) return '';
    try { return validateCookie(this.unseal(encrypted)); }
    catch (_) { this.onWarning('Saved Cookie could not be decrypted'); return ''; }
  }

  saveCookie(cookie) {
    if (cookie === '') return this.clearCookie();
    validateCookie(cookie);
    const encrypted = this.isEncryptionAvailable() ? this.seal(cookie) : '';
    this._commit({ savedCookieEncrypted: encrypted });
    this.ephemeralCookie = cookie;
    this.cookieRevoked = false;
    return Boolean(encrypted);
  }

  clearCookie() {
    // Real authorization revocation is memory-first even when the root is locked.
    this.cookieRevoked = true;
    this.ephemeralCookie = '';
    this._commit({ savedCookieEncrypted: '' });
    return true;
  }

  getSsoStatus() {
    const secrets = this.readSecrets();
    let username = '';
    try { username = normalizeUsername(secrets.ssoUsername || ''); } catch (_) {}
    return { profileId: this.profileId, username, hasPassword: Boolean(secrets.ssoPassword), storageAvailable: this.isEncryptionAvailable() };
  }

  getSsoPassword() {
    const password = this.readSecrets().ssoPassword;
    if (!password || password.startsWith('xor:')) return '';
    try { return validatePassword(this.unseal(password)); }
    catch (_) { this.onWarning('SSO password could not be decrypted'); return ''; }
  }

  saveSso({ username, password, clearPassword = false }) {
    const patch = { ssoUsername: normalizeUsername(username) };
    if (password !== undefined) validatePassword(password);
    if (clearPassword) patch.ssoPassword = '';
    else if (password) patch.ssoPassword = this.seal(password);
    this._commit(patch);
    return this.getSsoStatus();
  }

  clearSso() {
    this._commit({ ssoUsername: '', ssoPassword: '' });
    return this.getSsoStatus();
  }
}

module.exports = {
  CredentialStore, MAX_COOKIE_BYTES, MAX_ENCRYPTED_SECRET_BYTES, MAX_SSO_PASSWORD_BYTES,
  MAX_SSO_USERNAME_BYTES, normalizeUsername, validateCookie, validateEncryptedSecret,
};
