'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { validateCookie } = require('../electron/credential-store');

const OPTIONS = Object.freeze({
  '--cookie': 'cookie', '--port': 'port', '--host': 'host', '--cluster': 'cluster',
  '--login-node': 'loginNode', '--config': 'config', '--data-dir': 'dataDir',
  '--ssh-directory': 'sshDirectory', '--max-bytes': 'maxBytes', '--timeout-ms': 'timeoutMs',
  '--path': 'path', '--startup-command': 'startupCommand', '--health-probe': 'healthProbeEnabled',
  '--validate-token-periodically': 'validateTokenPeriodically',
  '--overwrite': 'overwrite',
});
const PROFILE_KEYS = ['port', 'host', 'cluster', 'loginNode', 'path', 'startupCommand', 'healthProbeEnabled', 'validateTokenPeriodically'];
const CONFIG_KEYS = new Set([...PROFILE_KEYS, 'dataDir', 'sshDirectory', 'maxBytes', 'timeoutMs']);
const MAX_TRANSFER_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
function fail(code = 'CLI_USAGE') { throw Object.assign(new Error(code), { code }); }
function cleanPath(value) {
  if (typeof value !== 'string' || !value.length || /[\u0000-\u001f\u007f]/.test(value)) fail('CLI_CONFIG');
  return path.resolve(value);
}
function boundedInteger(value, min, max) {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('CLI_CONFIG');
  return value;
}
function parseArgs(argv) {
  const values = {};
  const operands = [];
  let command = 'serve';
  let explicitCommand = false;
  let positional = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!positional && arg === '--') { positional = true; continue; }
    if (!positional && (arg === '--help' || arg === '-h')) return { help: true };
    if (!positional && arg === '--version') return { version: true };
    if (!positional && arg.startsWith('-')) {
      const equals = arg.indexOf('=');
      const option = equals < 0 ? arg : arg.slice(0, equals);
      const key = OPTIONS[option];
      if (!key || Object.hasOwn(values, key)) fail();
      if (key === 'overwrite') {
        if (equals >= 0) fail();
        values.overwrite = true;
        continue;
      }
      const value = equals < 0 ? argv[++index] : arg.slice(equals + 1);
      if (typeof value !== 'string' || !value.length || (equals < 0 && value.startsWith('--'))) fail();
      values[key] = value;
    } else if (!explicitCommand && !positional && ['serve', 'get', 'put'].includes(arg)) {
      command = arg;
      explicitCommand = true;
    } else {
      operands.push(arg);
    }
  }
  if (operands.length !== (command === 'serve' ? 0 : 2)) fail();
  return { command, operands, values };
}
async function loadConfig(parsed, env = process.env) {
  const schema = await import('../shared/settings-schema.mjs');
  let file = {};
  if (parsed.values.config) {
    try {
      const handle = await fs.open(cleanPath(parsed.values.config), 'r');
      try {
        if ((await handle.stat()).size > 64 * 1024) fail('CLI_CONFIG');
        file = JSON.parse(await handle.readFile('utf8'));
      } finally { await handle.close(); }
    } catch { fail('CLI_CONFIG'); }
    if (!file || typeof file !== 'object' || Array.isArray(file)
        || Object.keys(file).some(key => !CONFIG_KEYS.has(key))) fail('CLI_CONFIG');
  }
  const { cookie: argumentCookie, config: ignoredConfig, ...overrides } = parsed.values;
  const input = { ...file, ...overrides };
  const profile = {};
  for (const key of PROFILE_KEYS) {
    if (Object.hasOwn(input, key)) profile[key] = input[key];
  }
  const validated = schema.validateSettingsPatch(profile, schema.PROFILE_DEFAULTS);
  if (!validated.ok) fail('CLI_CONFIG');
  let cookie = argumentCookie ?? env.SCOW_TOKEN ?? '';
  if (typeof cookie !== 'string') fail('CLI_CONFIG');
  if (cookie && (argumentCookie === undefined ? !cookie.startsWith('SCOW_USER=') : !cookie.includes('='))) {
    cookie = `SCOW_USER=${cookie}`;
  }
  try {
    validateCookie(cookie);
    if (/[\u0000-\u001f\u007f]/.test(cookie)) fail('CLI_CONFIG');
  } catch { fail('CLI_CONFIG'); }
  if (!cookie) fail('CLI_COOKIE_REQUIRED');
  const dataHome = env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return {
    ...validated.value,
    cookie,
    overwrite: input.overwrite === true,
    dataDir: cleanPath(input.dataDir ?? path.join(dataHome, 'usshtc107-cli')),
    sshDirectory: cleanPath(input.sshDirectory ?? path.join(os.homedir(), '.ssh')),
    maxBytes: boundedInteger(input.maxBytes ?? MAX_TRANSFER_BYTES, 1, MAX_TRANSFER_BYTES),
    timeoutMs: boundedInteger(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, 60 * 60 * 1000),
  };
}
module.exports = { parseArgs, loadConfig, MAX_TRANSFER_BYTES, DEFAULT_TIMEOUT_MS };
