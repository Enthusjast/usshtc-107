const os = require('node:os');
const { atomicWriteJson } = require('./settings-store');
const { redactLogMessage } = require('./log-redaction');
const { validateLogFilters, filterLogs, isLogTimestamp } = require('../shared/log-filters.mjs');

const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
const SETTINGS = ['host', 'port', 'cluster', 'loginNode', 'cols', 'rows', 'useRoot', 'path', 'startupCommand', 'healthProbeEnabled', 'wssUrl', 'sshAlias'];
const CHECK_IDS = new Set(['settings', 'keys', 'ssh-config', 'local-listener', 'dns', 'tls', 'wss', 'remote-command']);
const STATUSES = new Set(['pending', 'running', 'passed', 'failed', 'skipped']);
const CODES = new Set(('SETTINGS_OK SETTINGS_INVALID SETTINGS_LOCKED KEYS_OK SSH_KEY_MISSING SSH_KEY_INVALID SSH_KEY_PERMISSIONS SSH_KEY_FINGERPRINT_MISMATCH SSH_CONFIG_OK SSH_CONFIG_MISSING SSH_CONFIG_MISMATCH SSH_ALIAS_CONFLICT SSH_CONFIG_INVALID LOCAL_SSH_OK LOCAL_PORT_AVAILABLE PORT_IN_USE LOCAL_SSH_FAILED DNS_OK DNS_FAILED TLS_OK TLS_FAILED WSS_SHELL_READY REMOTE_READY_TIMEOUT REMOTE_COMMAND_OK REMOTE_COMMAND_FAILED AUTH_REQUIRED WSS_FAILED NETWORK_UNAVAILABLE TIMEOUT CANCELLED DEPENDENCY_FAILED DIAGNOSTIC_DEADLINE').split(' '));
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);
function fail(code) { const error = new Error(code); error.code = code; return error; }
function text(value, max = 256) { return typeof value === 'string' ? value.slice(0, max) : ''; }
function safeDiagnostics(value) {
  if (!value) return null;
  return {
    runId: /^[a-zA-Z0-9_-]{1,128}$/.test(value.runId) ? value.runId : '',
    profileId: text(value.profileId, 128), epoch: Number.isSafeInteger(value.epoch) ? value.epoch : 0,
    configFingerprint: /^[a-f0-9]{64}$/i.test(value.configFingerprint) ? value.configFingerprint : '',
    authGeneration: Number.isSafeInteger(value.authGeneration) && value.authGeneration >= 0 ? value.authGeneration : null,
    startedAt: isLogTimestamp(value.startedAt) ? value.startedAt : null,
    finishedAt: isLogTimestamp(value.finishedAt) ? value.finishedAt : null,
    checks: (Array.isArray(value.checks) ? value.checks : []).slice(0, CHECK_IDS.size).filter((check) => CHECK_IDS.has(check.id)).map((check) => ({
      id: check.id, status: STATUSES.has(check.status) ? check.status : 'skipped',
      code: CODES.has(check.code) ? check.code : null,
      durationMs: Number.isFinite(check.durationMs) && check.durationMs >= 0 ? Math.min(check.durationMs, 30000) : 0,
      ...(['ssh-auth', 'bind-only'].includes(check.mode) ? { mode: check.mode } : {}),
    })),
  };
}

function createDiagnosticExportService({ dialog, getWindow, getRuntime = () => ({}), getSettings,
  getDiagnostics, getLogs, homePath = os.homedir(), userDataPath = '', clock = Date.now,
  assertCurrent = () => {} }) {
  function clean(value) {
    let message = redactLogMessage(value)
      .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, '[REDACTED PRIVATE KEY]');
    for (const [directory, replacement] of [[userDataPath, '[USERDATA]'], [homePath, '[HOME]']]) {
      if (directory) message = message.split(directory).join(replacement);
    }
    return message;
  }
  function capture(scope, allScopes = false) {
    assertCurrent(scope);
    const buffer = getLogs().slice(-500);
    const logs = buffer.filter((entry) => allScopes || (entry.profileId === scope.profileId && entry.epoch === scope.epoch))
      .filter((entry) => isLogTimestamp(entry.time) && LEVELS.has(entry.level))
      .map((entry) => ({ time: entry.time, level: entry.level,
        source: clean(text(entry.source, 128)), message: clean(entry.message) }));
    return logs;
  }
  async function save(scope, value, name) {
    let result;
    try {
      result = await dialog.showSaveDialog(getWindow(), {
        title: name === 'logs' ? 'Export logs' : 'Export diagnostics',
        defaultPath: `usshtc107-${name}.json`, filters: [{ name: 'JSON', extensions: ['json'] }],
      });
    } catch { throw fail('EXPORT_FAILED'); }
    if (result.canceled || !result.filePath) return { cancelled: true };
    assertCurrent(scope);
    try { atomicWriteJson(result.filePath, value, { maxBytes: MAX_EXPORT_BYTES }); }
    catch { throw fail('EXPORT_FAILED'); }
    return { exported: true };
  }
  return {
    async exportLogs({ scope, filters }) {
      scope = { profileId: scope?.profileId, epoch: scope?.epoch };
      const logs = capture(scope);
      const normalized = validateLogFilters(filters, [...new Set(logs.map((entry) => entry.source))]);
      return save(scope, filterLogs(logs, normalized), 'logs');
    },
    async exportDiagnostics(scope) {
      scope = { profileId: scope?.profileId, epoch: scope?.epoch };
      const logs = capture(scope, true);
      const input = getRuntime();
      const runtime = {};
      for (const key of ['appVersion', 'electronVersion', 'nodeVersion', 'osVersion', 'arch']) runtime[key] = clean(text(input[key]));
      const settings = {};
      const saved = getSettings(scope);
      for (const key of SETTINGS) {
        const value = saved[key];
        if (key === 'startupCommand' && value !== '' && value !== 'tmux new -A -s usshtc') continue;
        if (typeof value === 'string') settings[key] = clean(text(value, key === 'path' ? 1024 : 256));
        else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) settings[key] = value;
      }
      const value = { formatVersion: 1, generatedAt: new Date(clock()).toISOString(), runtime,
        settings, diagnostics: safeDiagnostics(getDiagnostics(scope)), logs: [], truncatedLogCount: 0 };
      // Size each complete record once, including the writer's two-space formatting.
      const baseBytes = Buffer.byteLength(JSON.stringify(value, null, 2));
      const sizes = logs.map((entry) => Buffer.byteLength(JSON.stringify(entry, null, 2).split('\n').map((line) => `    ${line}`).join('\n')));
      let bytes = baseBytes + sizes.reduce((sum, size) => sum + size, 0) + logs.length * 2 + 16;
      let first = 0;
      while (bytes > MAX_EXPORT_BYTES && first < logs.length) bytes -= sizes[first++] + 2;
      value.logs = logs.slice(first);
      value.truncatedLogCount = first;
      return save(scope, value, 'diagnostics');
    },
  };
}
module.exports = { createDiagnosticExportService, MAX_EXPORT_BYTES };
