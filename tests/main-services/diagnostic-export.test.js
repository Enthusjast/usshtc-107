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
      code: 'WSS_HANDSHAKE_OK', durationMs: 5, body: 'remote-secret' }, { id: 'arbitrary', code: 'unsafe' }] }) });
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
