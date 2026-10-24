const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiagnosticExportService, MAX_EXPORT_BYTES } = require('../../electron/diagnostic-export-service');

const scope = { profileId: 'default', epoch: 2 };
const time = '2026-01-01T00:00:00.000Z';
function fixture(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc-export-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'export.json');
  const logs = [{ ...scope, time, level: 'info', source: 'app', message: 'hello' }];
  let selected;
  const service = createDiagnosticExportService({
    dialog: { showSaveDialog: async (window, options) => { selected = { window, options }; return { canceled: false, filePath }; } },
    getWindow: () => 'parent', getRuntime: () => ({ appVersion: '1.2.1', electronVersion: '43.8.3',
      nodeVersion: '22.12.0', osVersion: 'Linux', arch: 'x64', hostname: 'secret-host' }),
    getSettings: () => ({ host: 'localhost', port: 3000, savedCookieEncrypted: 'hidden', ssoUsername: 'hidden' }),
    getDiagnostics: () => null, getLogs: () => logs, clock: () => Date.parse(time),
    homePath: '/private/home', userDataPath: '/private/home/app', ...overrides,
  });
  return { service, filePath, logs, selected: () => selected };
}

test('diagnostic JSON is allowlisted, re-redacted and excludes private paths', async (t) => {
  const f = fixture(t, { getDiagnostics: () => ({ runId: 'run-1', ...scope, configFingerprint: 'a'.repeat(64),
    startedAt: time, finishedAt: time, secret: 'top-secret', checks: [{ id: 'wss', status: 'passed',
      code: 'WSS_SHELL_READY', durationMs: 5, body: 'remote-secret' }, { id: 'arbitrary', code: 'unsafe' }] }) });
  f.logs[0].message = 'Cookie: secret-cookie\nAuthorization: Bearer secret-token\npassword=secret-password ticket=secret-ticket /private/home/app/log /private/home/file\nExec: secret-command\n-----BEGIN PRIVATE KEY-----\nsecret-key\n-----END PRIVATE KEY-----';
  f.logs.push({ ...scope, epoch: 1, time, level: 'warn', source: 'app', message: 'previous scope' });
  assert.deepEqual(await f.service.exportDiagnostics(scope), { exported: true });
  const raw = fs.readFileSync(f.filePath, 'utf8');
  const value = JSON.parse(raw);
  assert.deepEqual(Object.keys(value), ['formatVersion', 'generatedAt', 'runtime', 'settings', 'diagnostics', 'logs', 'truncatedLogCount']);
  assert.deepEqual(value.settings, { host: 'localhost', port: 3000 });
  assert.equal(value.logs.length, 2);
  assert.equal(value.diagnostics.checks.length, 1);
  assert.equal(value.diagnostics.checks[0].body, undefined);
  for (const secret of ['secret-cookie', 'secret-token', 'secret-password', 'secret-ticket', 'secret-key',
    'secret-command', 'remote-secret', 'top-secret', 'secret-host', '/private/home']) assert.equal(raw.includes(secret), false, secret);
  assert.match(raw, /\[USERDATA\]/);
  assert.match(raw, /\[HOME\]/);
  assert.equal(f.selected().window, 'parent');
  assert.deepEqual(f.selected().options.filters, [{ name: 'JSON', extensions: ['json'] }]);
});

test('logs export filters only its captured current scope and does not accept renderer bodies', async (t) => {
  const f = fixture(t);
  f.logs.push({ ...scope, epoch: 1, time, level: 'info', source: 'app', message: 'hello old' });
  f.logs.push({ ...scope, time, level: 'error', source: 'proxy', message: 'failure' });
  await f.service.exportLogs({ scope, filters: { query: 'HELLO', source: 'app' } });
  assert.deepEqual(JSON.parse(fs.readFileSync(f.filePath)), [{ time, level: 'info', source: 'app', message: 'hello' }]);
  await assert.rejects(f.service.exportLogs({ scope, filters: { logs: ['secret'] } }), { code: 'INVALID_ARGUMENT' });
});

test('native cancellation creates no file', async (t) => {
  const f = fixture(t, { dialog: { showSaveDialog: async () => ({ canceled: true }) } });
  assert.deepEqual(await f.service.exportDiagnostics(scope), { cancelled: true });
  assert.equal(fs.existsSync(f.filePath), false);
});

test('scope is rechecked after native choice and cannot be mutated by caller', async (t) => {
  let release;
  let current = true;
  const f = fixture(t, { dialog: { showSaveDialog: () => new Promise((resolve) => { release = resolve; }) },
    assertCurrent: (candidate) => { assert.deepEqual(candidate, scope); if (!current) throw Object.assign(new Error('PROFILE_CHANGED'), { code: 'PROFILE_CHANGED' }); } });
  const input = { ...scope };
  const pending = f.service.exportDiagnostics(input);
  input.profileId = 'other';
  current = false;
  release({ canceled: false, filePath: f.filePath });
  await assert.rejects(pending, { code: 'PROFILE_CHANGED' });
  assert.equal(fs.existsSync(f.filePath), false);
});

test('dialog and write failures expose only the fixed retryable code', async (t) => {
  const f = fixture(t, { dialog: { showSaveDialog: async () => { throw new Error('/private/secret'); } } });
  await assert.rejects(f.service.exportDiagnostics(scope), { message: 'EXPORT_FAILED', code: 'EXPORT_FAILED' });
  const g = fixture(t);
  fs.mkdirSync(g.filePath);
  await assert.rejects(g.service.exportDiagnostics(scope), { message: 'EXPORT_FAILED', code: 'EXPORT_FAILED' });
});

test('caps at 500 records and trims oldest whole records to the eight MiB limit', async (t) => {
  const f = fixture(t);
  f.logs.length = 0;
  for (let i = 0; i < 510; i++) f.logs.push({ ...scope, time, level: 'info', source: 'app', message: `${i}:` + '中'.repeat(8190) });
  await f.service.exportDiagnostics(scope);
  assert.ok(fs.statSync(f.filePath).size <= MAX_EXPORT_BYTES);
  const value = JSON.parse(fs.readFileSync(f.filePath));
  assert.ok(value.truncatedLogCount > 0);
  assert.equal(value.truncatedLogCount + value.logs.length, 500);
  assert.ok(value.logs[0].message.startsWith(`${10 + value.truncatedLogCount}:`));
  assert.ok(value.logs.at(-1).message.startsWith('509:'));
  assert.equal(value.logs.every((entry) => typeof entry.message === 'string'), true);
});

test('exports all ten bounded proof checks and public profile options without remote command or output bodies', async (t) => {
  const ids = ['settings', 'keys', 'ssh-config', 'local-listener', 'dns', 'tls', 'token', 'setup', 'wss', 'remote-command'];
  const codes = ['SETTINGS_OK', 'KEYS_OK', 'SSH_CONFIG_OK', 'LOCAL_SSH_OK', 'DNS_OK', 'TLS_OK', 'TOKEN_OK', 'SETUP_OK', 'WSS_SHELL_READY', 'REMOTE_COMMAND_OK'];
  const remotePath = `/private/home/work with spaces/${'a'.repeat(300)}`;
  const f = fixture(t, { getSettings: () => ({ host: 'localhost', port: 3000, path: remotePath,
    startupCommand: 'tmux new -A -s usshtc', healthProbeEnabled: true, validateTokenPeriodically: true,
    cookie: 'private-cookie', privateKey: 'private-key' }),
  getDiagnostics: () => ({ runId: 'run-proof', ...scope, configFingerprint: 'b'.repeat(64), authGeneration: 4,
    startedAt: time, finishedAt: time, command: 'private-command', output: 'private-output',
    checks: ids.map((id, index) => ({ id, status: 'passed', code: codes[index], durationMs: 1,
      command: 'private-command', stdout: 'private-output', stderr: 'private-stderr' })) }) });
  await f.service.exportDiagnostics(scope);
  const raw = fs.readFileSync(f.filePath, 'utf8');
  const value = JSON.parse(raw);
  assert.deepEqual(value.diagnostics.checks.map((check) => check.id), ids);
  assert.deepEqual(value.diagnostics.checks.map((check) => check.code), codes);
  assert.equal(value.diagnostics.authGeneration, 4);
  assert.equal(value.settings.path, remotePath.replace('/private/home', '[HOME]'));
  assert.equal(value.settings.startupCommand, 'tmux new -A -s usshtc');
  assert.equal(value.settings.healthProbeEnabled, true);
  assert.equal(value.settings.validateTokenPeriodically, true);
  for (const secret of ['private-cookie', 'private-key', 'private-command', 'private-output', 'private-stderr', '/private/home']) {
    assert.equal(raw.includes(secret), false, secret);
  }
});

test('exports readiness and command failures distinctly and excludes obsolete handshake codes and arbitrary startup commands', async (t) => {
  const f = fixture(t, { getSettings: () => ({ startupCommand: 'printf private-command' }),
    getDiagnostics: () => ({ runId: 'run-failed', ...scope, configFingerprint: 'c'.repeat(64), authGeneration: -1,
      startedAt: time, finishedAt: time, checks: [
        { id: 'wss', status: 'failed', code: 'REMOTE_READY_TIMEOUT', durationMs: 10000 },
        { id: 'remote-command', status: 'failed', code: 'REMOTE_COMMAND_FAILED', durationMs: 15000 },
        { id: 'tls', status: 'passed', code: 'WSS_HANDSHAKE_OK', durationMs: 1 },
      ] }) });
  await f.service.exportDiagnostics(scope);
  const raw = fs.readFileSync(f.filePath, 'utf8');
  const value = JSON.parse(raw);
  assert.deepEqual(value.diagnostics.checks.map((check) => check.code), ['REMOTE_READY_TIMEOUT', 'REMOTE_COMMAND_FAILED', null]);
  assert.equal(value.diagnostics.authGeneration, null);
  assert.equal(Object.hasOwn(value.settings, 'startupCommand'), false);
  assert.equal(raw.includes('private-command'), false);
});

for (const stage of ['token', 'setup']) {
  test(`exports REST ${stage} failure without credentials or response bodies`, async (t) => {
    const outcomes = [
      { id: 'token', status: stage === 'token' ? 'failed' : 'passed', code: stage === 'token' ? 'AUTH_REQUIRED' : 'TOKEN_OK' },
      { id: 'setup', status: stage === 'token' ? 'skipped' : 'failed', code: stage === 'token' ? 'DEPENDENCY_FAILED' : 'PORTAL_TIMEOUT' },
      { id: 'wss', status: 'skipped', code: 'DEPENDENCY_FAILED' },
      { id: 'remote-command', status: 'skipped', code: 'DEPENDENCY_FAILED' },
    ];
    const f = fixture(t, { getDiagnostics: () => ({ runId: `run-${stage}-failed`, ...scope,
      configFingerprint: 'd'.repeat(64), startedAt: time, finishedAt: time,
      checks: outcomes.map((check) => ({ ...check, durationMs: 10, cookie: 'private-token-cookie',
        token: 'private-token', body: 'private-response-body' })) }) });
    await f.service.exportDiagnostics(scope);
    const raw = fs.readFileSync(f.filePath, 'utf8');
    const value = JSON.parse(raw);
    assert.deepEqual(value.diagnostics.checks.map(({ id, status, code }) => ({ id, status, code })), outcomes);
    for (const secret of ['private-token-cookie', 'private-token', 'private-response-body']) {
      assert.equal(raw.includes(secret), false, secret);
    }
  });
}
