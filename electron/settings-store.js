const fs = require('fs');
const net = require('net');
const path = require('path');

const MAX_SETTINGS_FILE_BYTES = 1024 * 1024;

const PUBLIC_SETTING_KEYS = Object.freeze([
  'port',
  'host',
  'cluster',
  'loginNode',
  'cols',
  'rows',
  'useRoot',
  'autoConnect',
  'startMinimized',
  'theme',
  'sshAlias',
  'locale',
]);

const INTERNAL_STRING_KEYS = Object.freeze([
  'savedCookie',
  'savedCookieEncrypted',
  'ssoUsername',
  'ssoPassword',
  'sshPublicKey',
  'sshPublicKeyRaw',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseInteger(value, name, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new TypeError(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseBoolean(value, name) {
  if (value === true || value === false) return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new TypeError(`${name} must be a boolean`);
}

function parseToken(value, name, maxLength = 128) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || !/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    throw new TypeError(`${name} contains unsupported characters`);
  }
  return trimmed;
}

function parseHost(value, name) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 253 || /[\r\n\0\s]/.test(trimmed)) {
    throw new TypeError(`${name} is not a valid host`);
  }
  if (net.isIP(trimmed)) return trimmed;
  if (trimmed === 'localhost') return trimmed;
  const labels = trimmed.split('.');
  const valid = labels.every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  ));
  if (!valid) throw new TypeError(`${name} is not a valid host`);
  return trimmed;
}

function normalizePublicSettings(input, current) {
  if (!isPlainObject(input)) throw new TypeError('settings must be an object');
  const unknown = Object.keys(input).filter((key) => !PUBLIC_SETTING_KEYS.includes(key));
  if (unknown.length > 0) throw new TypeError(`Unknown setting: ${unknown[0]}`);

  const next = { ...current };
  if ('port' in input) next.port = parseInteger(input.port, 'port', 1, 65535);
  if ('host' in input) next.host = parseHost(input.host, 'host');
  if ('cluster' in input) next.cluster = parseToken(input.cluster, 'cluster');
  if ('loginNode' in input) next.loginNode = parseHost(input.loginNode, 'loginNode');
  if ('cols' in input) next.cols = parseInteger(input.cols, 'cols', 40, 500);
  if ('rows' in input) next.rows = parseInteger(input.rows, 'rows', 10, 200);
  if ('useRoot' in input) next.useRoot = parseBoolean(input.useRoot, 'useRoot');
  if ('autoConnect' in input) next.autoConnect = parseBoolean(input.autoConnect, 'autoConnect');
  if ('startMinimized' in input) next.startMinimized = parseBoolean(input.startMinimized, 'startMinimized');
  if ('sshAlias' in input) next.sshAlias = parseToken(input.sshAlias, 'sshAlias', 64);
  if ('theme' in input) {
    if (input.theme !== 'dark' && input.theme !== 'light') throw new TypeError('theme must be dark or light');
    next.theme = input.theme;
  }
  if ('locale' in input) {
    if (input.locale !== 'en' && input.locale !== 'zh') throw new TypeError('locale must be en or zh');
    next.locale = input.locale;
  }
  return next;
}

function publicSettings(settings) {
  return Object.fromEntries(PUBLIC_SETTING_KEYS.map((key) => [key, settings[key]]));
}

function normalizeLoadedSettings(raw, defaults, onWarning = () => {}) {
  const normalized = { ...defaults };
  if (!isPlainObject(raw)) return normalized;

  for (const key of PUBLIC_SETTING_KEYS) {
    if (!(key in raw)) continue;
    try {
      Object.assign(normalized, normalizePublicSettings({ [key]: raw[key] }, normalized));
    } catch (error) {
      onWarning(`Ignoring invalid setting '${key}': ${error.message}`);
    }
  }
  for (const key of INTERNAL_STRING_KEYS) {
    if (typeof raw[key] === 'string') normalized[key] = raw[key];
  }
  return normalized;
}

function settingsSizeError(filePath) {
  const error = new Error(`Settings file exceeds the ${MAX_SETTINGS_FILE_BYTES}-byte limit: ${filePath}`);
  error.code = 'SETTINGS_FILE_TOO_LARGE';
  return error;
}

function readUtf8FileLimited(filePath, maxBytes = MAX_SETTINGS_FILE_BYTES) {
  const descriptor = fs.openSync(filePath, 'r');
  const chunks = [];
  const buffer = Buffer.alloc(64 * 1024);
  let total = 0;
  try {
    while (true) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, maxBytes - total + 1),
        null,
      );
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw settingsSizeError(filePath);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function atomicWriteJson(filePath, value) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SETTINGS_FILE_BYTES) {
    throw settingsSizeError(filePath);
  }
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, serialized, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_) {}
    }
    try { fs.unlinkSync(temporaryPath); } catch (_) {}
    throw error;
  }
}

class SettingsStore {
  constructor({ filePath, defaults, onWarning = () => {} }) {
    this.filePath = filePath;
    this.defaults = { ...defaults };
    this.onWarning = onWarning;
  }

  load() {
    try {
      const raw = JSON.parse(readUtf8FileLimited(this.filePath));
      return normalizeLoadedSettings(raw, this.defaults, this.onWarning);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if (error.code === 'SETTINGS_FILE_TOO_LARGE') {
          this.onWarning(error.message);
          return { ...this.defaults };
        }
        const backupPath = `${this.filePath}.corrupt-${Date.now()}`;
        try {
          fs.copyFileSync(this.filePath, backupPath, fs.constants.COPYFILE_EXCL);
          fs.chmodSync(backupPath, 0o600);
          this.onWarning(`Settings load failed; the invalid file was backed up to ${backupPath}`);
        } catch (_) {
          this.onWarning(`Settings load failed: ${error.message}`);
        }
      }
      return { ...this.defaults };
    }
  }

  save(settings) {
    atomicWriteJson(this.filePath, settings);
  }
}

module.exports = {
  MAX_SETTINGS_FILE_BYTES,
  PUBLIC_SETTING_KEYS,
  SettingsStore,
  atomicWriteJson,
  normalizeLoadedSettings,
  normalizePublicSettings,
  parseHost,
  parseInteger,
  parseToken,
  publicSettings,
  readUtf8FileLimited,
};
