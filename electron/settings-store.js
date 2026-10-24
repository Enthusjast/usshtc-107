const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { APP_DEFAULTS, PROFILE_DEFAULTS, APP_SETTING_KEYS, PROFILE_SETTING_KEYS, validateSettingsPatch } = require('../shared/settings-schema.mjs');
const { normalizeUsername, validateEncryptedSecret } = require('./credential-store');

const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;
const MAX_PROFILES = 8;
const PUBLIC_SETTING_KEYS = Object.freeze([...PROFILE_SETTING_KEYS, ...APP_SETTING_KEYS]);
const ROOT_KEYS = ['schemaVersion', 'activeProfileId', 'app', 'profiles', 'keys', 'keyTransaction'];
const SECRET_KEYS = ['ssoUsername', 'ssoPassword', 'savedCookieEncrypted'];
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function codedError(code) { const error = new Error(code); error.code = code; return error; }
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exactKeys(value, keys) {
  if (!isPlainObject(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw codedError('SETTINGS_INVALID');
  }
}
function validateProfileName(value) {
  if (typeof value !== 'string' || CONTROL_CHARACTERS.test(value)) throw codedError('PROFILE_NAME_INVALID');
  const name = value.trim();
  let characters = 0;
  for (const character of name) { characters += 1; if (characters > 64) throw codedError('PROFILE_NAME_INVALID'); }
  if (!name || Buffer.byteLength(name, 'utf8') > 256) throw codedError('PROFILE_NAME_INVALID');
  return name;
}
function validateFingerprint(value) {
  if (value !== null && (typeof value !== 'string' || !FINGERPRINT.test(value))) throw codedError('SETTINGS_INVALID');
}
function validateFingerprints(value) {
  exactKeys(value, ['clientFingerprint', 'hostFingerprint']);
  validateFingerprint(value.clientFingerprint);
  validateFingerprint(value.hostFingerprint);
}
function validateKeyTransaction(transaction) {
  if (transaction === null) return;
  exactKeys(transaction, ['id', 'target', 'phase', 'before', 'after', 'files']);
  if (!UUID.test(transaction.id) || !['client', 'host', 'both'].includes(transaction.target)
      || !['prepared', 'installed', 'committed'].includes(transaction.phase)) throw codedError('SETTINGS_INVALID');
  validateFingerprints(transaction.before);
  validateFingerprints(transaction.after);
  if (transaction.after.clientFingerprint === null || transaction.after.hostFingerprint === null
      || (transaction.target === 'client' && transaction.before.hostFingerprint !== null
        && transaction.before.hostFingerprint !== transaction.after.hostFingerprint)
      || (transaction.target === 'host' && transaction.before.clientFingerprint !== null
        && transaction.before.clientFingerprint !== transaction.after.clientFingerprint)) throw codedError('SETTINGS_INVALID');
  if (!Array.isArray(transaction.files) || transaction.files.length < 1 || transaction.files.length > 3) throw codedError('SETTINGS_INVALID');
  const basenames = { 'client-private': 'usshtc107_ed25519', 'client-public': 'usshtc107_ed25519.pub', 'host-private': 'proxy_host_ed25519' };
  const roles = new Set();
  for (const file of transaction.files) {
    exactKeys(file, ['role', 'existed', 'oldSha256', 'newSha256', 'stageBasename', 'rollbackBasename']);
    const basename = basenames[file.role];
    if (!basename || roles.has(file.role) || typeof file.existed !== 'boolean'
        || (file.existed ? typeof file.oldSha256 !== 'string' || !SHA256.test(file.oldSha256) : file.oldSha256 !== null)
        || typeof file.newSha256 !== 'string' || !SHA256.test(file.newSha256)
        || file.stageBasename !== `${basename}.usshtc107-txn-${transaction.id}.new`
        || file.rollbackBasename !== `${basename}.usshtc107-txn-${transaction.id}.old`
        || (transaction.target === 'host' && file.role !== 'host-private')
        || (transaction.target === 'client' && file.role === 'host-private')) throw codedError('SETTINGS_INVALID');
    roles.add(file.role);
  }
  const expectedRoles = transaction.target === 'host' ? ['host-private']
    : transaction.target === 'client' ? ['client-private', 'client-public']
      : ['client-private', 'client-public', 'host-private'];
  if (roles.size !== expectedRoles.length || expectedRoles.some((role) => !roles.has(role))) throw codedError('SETTINGS_INVALID');
}
function validatedSettings(value, defaults, keys) {
  exactKeys(value, keys);
  const result = validateSettingsPatch(value, defaults);
  if (!result.ok || keys.some((key) => result.value[key] !== value[key])) throw codedError('SETTINGS_INVALID');
}
function serializedJson(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function contentHash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function validateRoot(root) {
  if (isPlainObject(root) && Number.isInteger(root.schemaVersion) && root.schemaVersion > 2) throw codedError('SETTINGS_VERSION_UNSUPPORTED');
  exactKeys(root, ROOT_KEYS);
  if (root.schemaVersion !== 2) throw codedError(Number.isInteger(root.schemaVersion) && root.schemaVersion > 2 ? 'SETTINGS_VERSION_UNSUPPORTED' : 'SETTINGS_INVALID');
  validatedSettings(root.app, APP_DEFAULTS, APP_SETTING_KEYS);
  if (!Array.isArray(root.profiles) || root.profiles.length < 1 || root.profiles.length > MAX_PROFILES) throw codedError('SETTINGS_INVALID');
  const ids = new Set();
  const aliases = new Set();
  for (const profile of root.profiles) {
    exactKeys(profile, ['id', 'name', 'settings', 'secrets', 'onboarding']);
    if (typeof profile.id !== 'string' || (profile.id !== 'default' && !UUID.test(profile.id)) || ids.has(profile.id)
        || validateProfileName(profile.name) !== profile.name) throw codedError('SETTINGS_INVALID');
    validatedSettings(profile.settings, PROFILE_DEFAULTS, PROFILE_SETTING_KEYS);
    const alias = profile.settings.sshAlias.toLowerCase();
    if (aliases.has(alias)) throw codedError('PROFILE_ALIAS_CONFLICT');
    exactKeys(profile.secrets, SECRET_KEYS);
    if (normalizeUsername(profile.secrets.ssoUsername) !== profile.secrets.ssoUsername) throw codedError('SETTINGS_INVALID');
    validateEncryptedSecret(profile.secrets.ssoPassword);
    if (profile.secrets.ssoPassword.startsWith('xor:')) throw codedError('SETTINGS_INVALID');
    validateEncryptedSecret(profile.secrets.savedCookieEncrypted);
    exactKeys(profile.onboarding, ['status', 'step']);
    if (!['new', 'dismissed', 'completed'].includes(profile.onboarding.status)
        || !['login', 'config', 'connect', 'verify'].includes(profile.onboarding.step)) throw codedError('SETTINGS_INVALID');
    ids.add(profile.id);
    aliases.add(alias);
  }
  if (!ids.has(root.activeProfileId)) throw codedError('SETTINGS_INVALID');
  exactKeys(root.keys, ['initialized', 'clientFingerprint', 'hostFingerprint']);
  if (typeof root.keys.initialized !== 'boolean') throw codedError('SETTINGS_INVALID');
  validateFingerprint(root.keys.clientFingerprint);
  validateFingerprint(root.keys.hostFingerprint);
  validateKeyTransaction(root.keyTransaction);
  if (!root.keys.initialized && (root.keys.clientFingerprint !== null || root.keys.hostFingerprint !== null)) throw codedError('SETTINGS_INVALID');
  if (root.keyTransaction) {
    const expected = root.keyTransaction.phase === 'committed' ? root.keyTransaction.after : root.keyTransaction.before;
    if (!root.keys.initialized || root.keys.clientFingerprint !== expected.clientFingerprint
        || root.keys.hostFingerprint !== expected.hostFingerprint) throw codedError('SETTINGS_INVALID');
  }
  if (Buffer.byteLength(serializedJson(root), 'utf8') > MAX_SETTINGS_FILE_BYTES) throw codedError('SETTINGS_FILE_TOO_LARGE');
  return root;
}
function createDefaultRoot(defaults = {}) {
  const app = { ...APP_DEFAULTS };
  const settings = { ...PROFILE_DEFAULTS };
  for (const key of APP_SETTING_KEYS) if (Object.hasOwn(defaults, key)) app[key] = defaults[key];
  for (const key of PROFILE_SETTING_KEYS) if (Object.hasOwn(defaults, key)) settings[key] = defaults[key];
  return {
    schemaVersion: 2, activeProfileId: 'default', app,
    profiles: [{ id: 'default', name: 'Default', settings, secrets: { ssoUsername: '', ssoPassword: '', savedCookieEncrypted: '' }, onboarding: { status: 'new', step: 'login' } }],
    keys: { initialized: false, clientFingerprint: null, hostFingerprint: null }, keyTransaction: null,
  };
}
function publicSettings(root, id = root.activeProfileId) {
  const profile = root.profiles.find((entry) => entry.id === id);
  if (!profile) throw codedError('PROFILE_CHANGED');
  return Object.fromEntries(PUBLIC_SETTING_KEYS.map((key) => [key, Object.hasOwn(root.app, key) ? root.app[key] : profile.settings[key]]));
}
function readUtf8FileLimited(filePath, maxBytes = MAX_SETTINGS_FILE_BYTES, io = fs) {
  const descriptor = io.openSync(filePath, 'r');
  const chunks = [];
  const buffer = Buffer.alloc(64 * 1024);
  let total = 0;
  try {
    while (true) {
      const count = io.readSync(descriptor, buffer, 0, Math.min(buffer.length, maxBytes - total + 1), null);
      if (count === 0) break;
      total += count;
      if (total > maxBytes) throw codedError('SETTINGS_FILE_TOO_LARGE');
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
  } finally { io.closeSync(descriptor); }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks, total));
}
function syncDirectory(directory, { io = fs, platform = process.platform } = {}) {
  if (platform === 'win32') return;
  const descriptor = io.openSync(directory, 'r');
  try { io.fsyncSync(descriptor); } finally { io.closeSync(descriptor); }
}
class AtomicWriteError extends Error {
  constructor(cause, replacement, candidateHash) {
    super('Atomic JSON write failed', { cause });
    this.name = 'AtomicWriteError';
    this.code = cause.code || 'SETTINGS_SAVE_FAILED';
    this.replacement = replacement;
    this.candidateHash = candidateHash;
  }
}
function atomicWriteJson(filePath, value, { maxBytes = MAX_SETTINGS_FILE_BYTES, io = fs, platform = process.platform } = {}) {
  const serialized = serializedJson(value);
  const candidateHash = contentHash(serialized);
  let replacement = 'not_replaced';
  let descriptor;
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw codedError('SETTINGS_FILE_TOO_LARGE');
    io.mkdirSync(directory, { recursive: true, mode: 0o700 });
    descriptor = io.openSync(temporaryPath, 'wx', 0o600);
    io.fchmodSync(descriptor, 0o600);
    io.writeFileSync(descriptor, serialized, 'utf8');
    io.fsyncSync(descriptor);
    io.closeSync(descriptor);
    descriptor = undefined;
    replacement = 'unknown';
    io.renameSync(temporaryPath, filePath);
    replacement = 'replaced';
    syncDirectory(directory, { io, platform });
    return { replacement: 'replaced', durable: true, contentHash: candidateHash };
  } catch (error) {
    if (descriptor !== undefined) { try { io.closeSync(descriptor); } catch (_) {} }
    try { io.unlinkSync(temporaryPath); } catch (_) {}
    throw new AtomicWriteError(error, replacement, candidateHash);
  }
}

class SettingsStore {
  constructor({ filePath, defaults = {}, onWarning = () => {}, migrateLegacySecrets, inspectExistingIdentity, io = fs, platform = process.platform }) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.onWarning = onWarning;
    this.migrateLegacySecrets = migrateLegacySecrets;
    this.inspectExistingIdentity = inspectExistingIdentity;
    this.io = io;
    this.platform = platform;
    this.root = createDefaultRoot(defaults);
    this.knownHash = null;
    this.storageErrorCode = null;
    this.corruptHash = null;
    this.migratedCookie = '';
  }
  getRoot() { return this.root; }
  isLocked() { return this.storageErrorCode !== null; }
  getStorageErrorCode() { return this.storageErrorCode; }
  takeMigratedCookie() { const cookie = this.isLocked() ? '' : this.migratedCookie; this.migratedCookie = ''; return cookie; }
  _lock(code) { this.storageErrorCode = code; return codedError(code); }
  _read() { return readUtf8FileLimited(this.filePath, MAX_SETTINGS_FILE_BYTES, this.io); }
  _existingKeys(raw) {
    const keys = this.inspectExistingIdentity?.(raw);
    if (keys) return { ...keys, initialized: keys.initialized || Boolean(raw?.sshPublicKey || raw?.sshPublicKeyRaw) };
    // Cached public identities prove this is not a new installation, even if files are missing.
    return { initialized: Boolean(raw?.sshPublicKey || raw?.sshPublicKeyRaw), clientFingerprint: null, hostFingerprint: null };
  }
  _migrate(raw) {
    if (!isPlainObject(raw)) throw codedError('SETTINGS_INVALID');
    const root = createDefaultRoot(this.defaults);
    const patch = Object.fromEntries(PUBLIC_SETTING_KEYS.filter((key) => Object.hasOwn(raw, key)).map((key) => [key, raw[key]]));
    const result = validateSettingsPatch(patch, { ...root.app, ...root.profiles[0].settings });
    if (!result.ok) throw codedError('SETTINGS_MIGRATION_FAILED');
    for (const key of APP_SETTING_KEYS) root.app[key] = result.value[key];
    for (const key of PROFILE_SETTING_KEYS) root.profiles[0].settings[key] = result.value[key];
    let migration;
    if (this.migrateLegacySecrets) migration = this.migrateLegacySecrets(raw);
    else {
      if (raw.savedCookie || raw.ssoPassword?.startsWith('xor:')) throw codedError('SETTINGS_MIGRATION_FAILED');
      migration = { secrets: { ssoUsername: raw.ssoUsername ?? '', ssoPassword: raw.ssoPassword ?? '', savedCookieEncrypted: raw.savedCookieEncrypted ?? '' } };
    }
    root.profiles[0].secrets = migration.secrets;
    root.profiles[0].onboarding.status = 'dismissed';
    root.keys = this._existingKeys(raw);
    validateRoot(root);
    return { root, ephemeralCookie: migration.ephemeralCookie || '' };
  }
  _backupCorrupt(text) {
    const backupPath = `${this.filePath}.corrupt-${crypto.randomUUID()}`;
    let descriptor;
    try {
      descriptor = this.io.openSync(backupPath, 'wx', 0o600);
      this.io.fchmodSync(descriptor, 0o600);
      this.io.writeFileSync(descriptor, text, 'utf8');
      this.io.fsyncSync(descriptor);
      this.onWarning('Invalid JSON settings were backed up privately; explicit recovery is required');
    } catch (_) { this.onWarning('Invalid JSON settings could not be backed up; explicit recovery is required'); }
    finally { if (descriptor !== undefined) { try { this.io.closeSync(descriptor); } catch (_) {} } }
  }
  load() {
    let text;
    try { text = this._read(); }
    catch (error) {
      if (error.code === 'ENOENT') {
        // Missing is fresh only on the initial load, not a way around an uncertain commit.
        if (this.isLocked()) throw this._lock(this.storageErrorCode);
        try {
          const root = createDefaultRoot(this.defaults);
          root.keys = this._existingKeys();
          validateRoot(root);
          this.root = root;
          this.knownHash = null;
          return this.root;
        } catch (initializationError) { throw this._lock(initializationError.code || 'SETTINGS_INVALID'); }
      }
      throw this._lock(error.code === 'SETTINGS_FILE_TOO_LARGE' ? error.code : 'SETTINGS_LOAD_FAILED');
    }
    let raw;
    try { raw = JSON.parse(text); }
    catch (_) {
      const hash = contentHash(text);
      if (this.corruptHash !== hash) this._backupCorrupt(text);
      this.corruptHash = hash;
      throw this._lock('SETTINGS_RECOVERY_REQUIRED');
    }
    try {
      if (!isPlainObject(raw)) throw codedError('SETTINGS_INVALID');
      if (!Object.hasOwn(raw, 'schemaVersion')) {
        const migration = this._migrate(raw);
        this.knownHash = contentHash(text);
        this.storageErrorCode = null;
        const result = this.save(migration.root);
        if (result.state !== 'committed' || !result.durable) throw codedError(result.errorCode || 'SETTINGS_MIGRATION_FAILED');
        this.migratedCookie = migration.ephemeralCookie;
      } else {
        // Schema 2 profiles saved before these opt-ins retain their existing settings.
        // Backfill only new optional fields; all other missing/unknown keys remain invalid.
        if (raw.schemaVersion === 2 && Array.isArray(raw.profiles)) {
          for (const profile of raw.profiles) {
            if (!isPlainObject(profile?.settings)) continue;
            for (const key of ['path', 'startupCommand', 'healthProbeEnabled']) {
              if (!Object.hasOwn(profile.settings, key)) profile.settings[key] = PROFILE_DEFAULTS[key];
            }
          }
        }
        validateRoot(raw);
        if (this.isLocked()) syncDirectory(path.dirname(this.filePath), { io: this.io, platform: this.platform });
        this.root = raw;
        this.knownHash = contentHash(text);
        this.storageErrorCode = null;
      }
      this.corruptHash = null;
      return this.root;
    } catch (error) { throw this._lock(this.storageErrorCode || error.code || 'SETTINGS_INVALID'); }
  }
  save(candidate) {
    if (this.isLocked()) return { state: 'not_committed', durable: false, errorCode: 'SETTINGS_LOCKED' };
    let adopted;
    try { validateRoot(candidate); adopted = JSON.parse(JSON.stringify(candidate)); }
    catch (error) { return { state: 'not_committed', durable: false, errorCode: error.code || 'SETTINGS_INVALID' }; }
    try {
      const result = atomicWriteJson(this.filePath, adopted, { io: this.io, platform: this.platform });
      this.root = adopted;
      this.knownHash = result.contentHash;
      return { state: 'committed', durable: true, errorCode: null };
    } catch (error) {
      let actualHash;
      try { actualHash = contentHash(this._read()); }
      catch (readError) { if (readError.code === 'ENOENT') actualHash = null; }
      if (actualHash !== undefined && actualHash === error.candidateHash) {
        this.root = adopted;
        this.knownHash = actualHash;
        this._lock('SETTINGS_DURABILITY_UNCERTAIN');
        return { state: 'committed', durable: false, errorCode: this.storageErrorCode };
      }
      if (actualHash !== undefined && actualHash === this.knownHash) {
        return { state: 'not_committed', durable: false, errorCode: error.code === 'SETTINGS_FILE_TOO_LARGE' ? error.code : 'SETTINGS_SAVE_FAILED' };
      }
      this._lock('SETTINGS_COMMIT_UNKNOWN');
      return { state: 'unknown', durable: false, errorCode: this.storageErrorCode };
    }
  }
  retryLoad({ allowCorruptRecovery = false } = {}) {
    if (allowCorruptRecovery && this.storageErrorCode === 'SETTINGS_RECOVERY_REQUIRED' && this.corruptHash) {
      let text;
      try { text = this._read(); } catch (_) { throw this._lock('SETTINGS_LOAD_FAILED'); }
      if (contentHash(text) === this.corruptHash) {
        this.knownHash = this.corruptHash;
        this.storageErrorCode = null;
        const root = createDefaultRoot(this.defaults);
        root.keys = this._existingKeys();
        const result = this.save(root);
        if (result.state !== 'committed' || !result.durable) throw this._lock(result.errorCode || 'SETTINGS_RECOVERY_REQUIRED');
        this.corruptHash = null;
      } else this.load();
    } else this.load();
    try { syncDirectory(path.dirname(this.filePath), { io: this.io, platform: this.platform }); }
    catch (_) { throw this._lock('SETTINGS_DURABILITY_UNCERTAIN'); }
    this.storageErrorCode = null;
    return this.root;
  }
}
module.exports = {
  MAX_SETTINGS_FILE_BYTES, MAX_PROFILES, SettingsStore, AtomicWriteError, atomicWriteJson,
  createDefaultRoot, validateRoot, validateProfileName, publicSettings, readUtf8FileLimited, syncDirectory,
};
