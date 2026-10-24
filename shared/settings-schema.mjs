// Public settings contract shared by Node and the renderer. No platform dependencies.
export const APP_DEFAULTS = Object.freeze({
  startMinimized: false,
  theme: 'dark',
  locale: 'en',
  launchAtLogin: false,
  reconnectOnResume: true,
  autoCheckUpdates: true,
  notifyConnections: true,
  notifyAuth: true,
  notifyRecovery: true,
  notifyUpdates: true,
});

export const PROFILE_DEFAULTS = Object.freeze({
  port: 3000,
  host: '127.0.0.1',
  cluster: 'training',
  loginNode: '11.11.10.202',
  cols: 80,
  rows: 24,
  useRoot: false,
  autoConnect: true,
  sshAlias: 'usshtc107',
});

export const APP_SETTING_KEYS = Object.freeze(Object.keys(APP_DEFAULTS));
export const PROFILE_SETTING_KEYS = Object.freeze(Object.keys(PROFILE_DEFAULTS));

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function invalid(code) {
  // Neither values nor caller-provided field names belong in diagnostic messages.
  const error = new TypeError(code);
  error.code = code;
  throw error;
}

function cleanString(value, code) {
  if (typeof value !== 'string') invalid(value == null ? 'required' : code);
  // Validate the raw input: trim must not hide a trailing newline or tab.
  if (CONTROL_CHARACTERS.test(value)) invalid(code);
  const trimmed = value.trim();
  if (!trimmed) invalid('required');
  return trimmed;
}

export function parseInteger(value, name, min, max) {
  if (value == null) invalid('required');
  let parsed = value;
  if (typeof value === 'string') {
    const trimmed = cleanString(value, 'integer_range');
    if (!/^[+-]?\d+$/.test(trimmed)) invalid('integer_range');
    parsed = Number(trimmed);
  }
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    invalid('integer_range');
  }
  return parsed;
}

export function parseToken(value, name, maxLength = 128) {
  const trimmed = cleanString(value, 'invalid_token');
  if (trimmed.length > maxLength || !/^[A-Za-z0-9._-]+$/.test(trimmed)) invalid('invalid_token');
  return trimmed;
}

function isIpv4(value) {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => (
    /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255
  ));
}

function isIpv6(value) {
  let address = value;
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':');
    if (lastColon < 0 || !isIpv4(address.slice(lastColon + 1))) return false;
    // An IPv4 suffix occupies two of the eight IPv6 groups.
    address = `${address.slice(0, lastColon + 1)}0:0`;
  }
  if (!/^[0-9a-f:]+$/i.test(address)) return false;
  const compression = address.indexOf('::');
  if (compression !== -1) {
    if (address.indexOf('::', compression + 2) !== -1) return false;
    const left = address.slice(0, compression);
    const right = address.slice(compression + 2);
    const groups = [...(left ? left.split(':') : []), ...(right ? right.split(':') : [])];
    return groups.length < 8 && groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group));
  }
  const groups = address.split(':');
  return groups.length === 8 && groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group));
}

export function parseHost(value, name) {
  const trimmed = cleanString(value, 'invalid_host');
  if (trimmed.length > 253 || /\s/.test(trimmed)) invalid('invalid_host');
  if (trimmed.includes(':')) {
    if (!isIpv6(trimmed)) invalid('invalid_host');
    return trimmed;
  }
  // Do not accept malformed dotted numeric addresses as DNS names.
  if (/^[\d.]+$/.test(trimmed) && trimmed.includes('.')) {
    if (!isIpv4(trimmed)) invalid('invalid_host');
    return trimmed;
  }
  if (!trimmed.split('.').every((label) => (
    label.length > 0 && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  ))) invalid('invalid_host');
  return trimmed;
}

function parseBoolean(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  invalid('invalid_boolean');
}

function parseEnum(value, choices) {
  if (!choices.includes(value)) invalid('invalid_enum');
  return value;
}

const validators = Object.freeze({
  port: (value) => parseInteger(value, 'port', 1, 65535),
  host: (value) => parseHost(value, 'host'),
  cluster: (value) => parseToken(value, 'cluster'),
  loginNode: (value) => parseHost(value, 'loginNode'),
  cols: (value) => parseInteger(value, 'cols', 40, 500),
  rows: (value) => parseInteger(value, 'rows', 10, 200),
  useRoot: parseBoolean,
  autoConnect: parseBoolean,
  sshAlias: (value) => parseToken(value, 'sshAlias', 64),
  startMinimized: parseBoolean,
  theme: (value) => parseEnum(value, ['dark', 'light']),
  locale: (value) => parseEnum(value, ['en', 'zh']),
  launchAtLogin: parseBoolean,
  reconnectOnResume: parseBoolean,
  autoCheckUpdates: parseBoolean,
  notifyConnections: parseBoolean,
  notifyAuth: parseBoolean,
  notifyRecovery: parseBoolean,
  notifyUpdates: parseBoolean,
});

export function validateSettingsPatch(input, current = { ...APP_DEFAULTS, ...PROFILE_DEFAULTS }) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    return { ok: false, fieldErrors: { settings: input == null ? 'required' : 'unknown_key' } };
  }
  const value = { ...current };
  const fieldErrors = {};
  for (const key of Object.keys(input)) {
    if (!hasOwn(validators, key)) {
      Object.defineProperty(fieldErrors, key, { value: 'unknown_key', enumerable: true });
      continue;
    }
    try {
      value[key] = validators[key](input[key]);
    } catch (error) {
      fieldErrors[key] = error.code;
    }
  }
  return Object.keys(fieldErrors).length ? { ok: false, fieldErrors } : { ok: true, value };
}
