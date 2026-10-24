'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createAppController } = require('../../electron/app-controller');
const { SettingsStore, createDefaultRoot, publicSettings } = require('../../electron/settings-store');
const { SshConfigService } = require('../../electron/ssh-config-service');
const { fingerprintConfig } = require('../../electron/diagnostics-service');

const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
const ioError = () => Object.assign(new Error('private fixture failure'), { code: 'EIO' });

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc-onboarding-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'settings.json');
  let failure = null;
  const store = new SettingsStore({ filePath, platform: process.platform, io: {
    ...fs,
    renameSync: (source, target) => {
      if (failure === 'rename') throw ioError();
      return fs.renameSync(source, target);
    },
    fsyncSync: (fd) => {
      if (['directory', 'unknown'].includes(failure) && fs.fstatSync(fd).isDirectory()) throw ioError();
      return fs.fsyncSync(fd);
    },
    openSync: (target, flags, mode) => {
      if (failure === 'unknown' && target === filePath && flags === 'r') throw ioError();
      return fs.openSync(target, flags, mode);
    },
  } });
  const initial = createDefaultRoot({ autoConnect: false });
  initial.app.notifyAuth = false;
  initial.profiles[0].secrets = { ssoUsername: 'private-account',
    ssoPassword: Buffer.from('private-password').toString('base64'),
    savedCookieEncrypted: Buffer.from('private-cookie').toString('base64') };
  initial.profiles.push({ ...structuredClone(initial.profiles[0]), id: randomUUID(), name: 'Other',
    settings: { ...initial.profiles[0].settings, port: 4000, sshAlias: 'usshtc107-2' } });
  if (options.journal) {
    initial.keys = { initialized: true, clientFingerprint: `SHA256:${'A'.repeat(43)}`, hostFingerprint: null };
    const id = randomUUID();
    initial.keyTransaction = { id, target: 'host', phase: 'installed',
      before: { clientFingerprint: initial.keys.clientFingerprint, hostFingerprint: null },
      after: { clientFingerprint: initial.keys.clientFingerprint, hostFingerprint: `SHA256:${'B'.repeat(43)}` },
      files: [{ role: 'host-private', existed: false, oldSha256: null, newSha256: 'a'.repeat(64),
        stageBasename: `proxy_host_ed25519.usshtc107-txn-${id}.new`,
        rollbackBasename: `proxy_host_ed25519.usshtc107-txn-${id}.old` }] };
  }
  assert.equal(store.save(initial).state, 'committed');
  const calls = [];
  const originalSave = store.save.bind(store);
  store.save = (candidate) => { calls.push('save'); return originalSave(candidate); };
  const sshDirectory = path.join(directory, 'ssh');
  const sshConfig = new SshConfigService({ sshDirectory, privateKeyPath: path.join(sshDirectory, 'client') });
  const configOptions = (scope, saved) => ({ profileId: scope.profileId, alias: saved.sshAlias, host: saved.host, port: saved.port });
  const initialConfig = configOptions({ profileId: initial.activeProfileId }, publicSettings(initial));
  const preview = sshConfig.preview(initialConfig);
  sshConfig.write(initialConfig, { expectedSourceHash: preview.sourceHash, expectedConfigHash: preview.configHash });
  let callbacks, scope, latest;
  let cookie = 'SCOW_USER=fixture';
  let generation = 1;
  const login = {
    getCookie: () => cookie,
    setScope: (value) => { scope = { ...value }; },
    setProfile: (value) => {
      scope = { ...value };
      callbacks.onLoginState({ ...scope, authGeneration: generation, loginStatus: 'success', cookieValid: true, cookieCount: 1 });
    },
    deactivate: () => { cookie = ''; calls.push('deactivate'); },
    resetForProfile: async () => {
      cookie = '';
      callbacks.onLoginState({ ...scope, authGeneration: ++generation, loginStatus: 'failure', cookieValid: false, cookieCount: 0 });
    },
    dispose: () => {},
  };
  const proxy = {
    setScope: (value) => { scope = { ...value }; },
    start: async (config) => callbacks.onProxyState({ ...scope, proxyStatus: 'started', runningConfig: config }),
    stop: async () => {
      calls.push('stop');
      callbacks.onProxyState({ ...scope, proxyStatus: 'stopped', runningConfig: null, connectionCount: 0 });
    },
    cancelPendingStart: () => {}, dispose: async () => {},
  };
  const inspect = (candidate, saved) => {
    calls.push(['inspect', candidate, saved]);
    return options.inspect ? options.inspect(candidate, saved) : sshConfig.inspect(configOptions(candidate, saved));
  };
  const app = createAppController({ settingsStore: store, proxy, login,
    createCredentialStore: () => ({ getSsoStatus: () => ({ username: 'private-account', hasPassword: true }) }),
    bindCallbacks: (value) => { callbacks = value; }, confirmInterrupt: async () => true,
    getDiagnostics: (candidate) => { calls.push(['get-diagnostics', candidate]); return latest ? structuredClone(latest) : null; },
    inspectSshConfig: options.missingInspector ? undefined : inspect,
    onConfigSaved: () => { calls.push('invalidate'); latest = null; }, flush: async () => {},
  });
  const currentScope = () => { const { profileId, epoch } = app.getSnapshot(); return { profileId, epoch }; };
  const running = (patch = {}) => callbacks.onProxyState({ ...currentScope(), proxyStatus: 'started',
    runningConfig: app.getSnapshot().desiredConfig, ...patch });
  running();
  const proof = (patch = {}) => ({ runId: randomUUID(), ...currentScope(),
    configFingerprint: fingerprintConfig(publicSettings(store.getRoot())),
    authGeneration: app.getAuthGeneration(),
    startedAt: '2026-10-24T00:00:00.000Z', finishedAt: '2026-10-24T00:00:01.000Z',
    checks: [
      { id: 'local-listener', status: 'passed', code: 'LOCAL_SSH_OK', mode: 'ssh-auth', durationMs: 1 },
      { id: 'wss', status: 'passed', code: 'WSS_SHELL_READY', durationMs: 1 },
      { id: 'remote-command', status: 'passed', code: 'REMOTE_COMMAND_OK', durationMs: 1 },
    ], ...patch });
  latest = proof();
  const save = (patch = {}) => app.run('save-onboarding', { scope: currentScope(), status: 'completed',
    step: 'verify', runId: latest?.runId, ...patch });
  return { app, store, calls, sshConfig, proof, save, running, callbacks, scope: currentScope,
    root: () => store.getRoot(), latest: () => latest,
    setLatest: (value) => { latest = value; }, setFailure: (value) => { failure = value; },
    setCookie: (value) => { cookie = value; },
    loginState: (patch) => callbacks.onLoginState({ ...currentScope(), authGeneration: generation, ...patch }),
  };
}

test('onboarding skip/resume changes only active metadata and never invalidates diagnostic proof or scope', async (t) => {
  const f = fixture(t, { journal: true });
  const before = structuredClone(f.root());
  const oldScope = f.scope();
  const runId = f.latest().runId;
  for (const [status, step] of [['dismissed', 'connect'], ['new', 'config'], ['dismissed', 'verify']]) {
    const dto = await f.save({ status, step });
    const expected = structuredClone(before);
    expected.profiles[0].onboarding = { status, step };
    assert.deepEqual(f.root(), expected);
    assert.deepEqual(dto, f.app.getProfiles());
    assert.deepEqual(Object.keys(dto.profiles[0]).sort(), ['id', 'name', 'onboarding', 'settings']);
    assert.equal(JSON.stringify(dto).includes('private-'), false);
    assert.deepEqual(f.scope(), oldScope);
    assert.equal(f.latest().runId, runId);
    assert.equal(f.calls.includes('invalidate'), false);
  }
  assert.equal(f.calls.some((call) => Array.isArray(call) && call[0] === 'inspect'), false);
  assert.equal(f.calls.includes('stop'), false);
});

test('valid completion uses saved configuration and fresh owned inspection without leaking run proof into root', async (t) => {
  const f = fixture(t);
  const before = structuredClone(f.root());
  const oldScope = f.scope();
  const result = await f.save();
  before.profiles[0].onboarding = { status: 'completed', step: 'verify' };
  assert.deepEqual(f.root(), before);
  assert.deepEqual(result, f.app.getProfiles());
  assert.deepEqual(f.calls.find((call) => Array.isArray(call) && call[0] === 'inspect'),
    ['inspect', oldScope, publicSettings(before)]);
  assert.deepEqual(f.scope(), oldScope);
  assert.equal(f.calls.filter((call) => call === 'save').length, 1);
  assert.equal(f.calls.includes('invalidate'), false);
});

test('onboarding input rejects unknown fields, malformed enums/run IDs and stale scope before any write', async (t) => {
  const f = fixture(t);
  const before = structuredClone(f.root());
  for (const patch of [
    { status: 'ready' }, { step: 'done' }, { status: null }, { step: undefined },
    { runId: 1 }, { runId: '' }, { runId: 'x'.repeat(129) }, { runId: 'bad\nrun' },
    { checks: f.latest().checks }, { onboarding: { status: 'completed' } }, { credentials: {} },
    { configFingerprint: f.latest().configFingerprint }, { draftRevision: 0 },
    { scope: { ...f.scope(), arbitrary: true } },
  ]) await assert.rejects(f.save(patch), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.save({ scope: { ...f.scope(), epoch: 99 } }), { code: 'PROFILE_CHANGED' });
  await assert.rejects(f.save({ scope: { profileId: f.root().profiles[1].id, epoch: f.scope().epoch } }), { code: 'PROFILE_CHANGED' });
  assert.deepEqual(f.root(), before);
  assert.equal(f.calls.includes('save'), false);
});

for (const scenario of [
  ['forged run ID', (f) => ({ runId: `forged-${f.latest().runId}` })],
  ['missing run ID', () => ({ runId: undefined })],
  ['non-verify step', () => ({ step: 'connect' })],
  ['no latest proof', (f) => { f.setLatest(null); }],
  ['unfinished run', (f) => { f.setLatest(f.proof({ finishedAt: null })); }],
  ['invalid completion timestamp', (f) => { f.setLatest(f.proof({ finishedAt: 'invalid' })); }],
  ['previous epoch proof', (f) => { f.setLatest(f.proof({ epoch: f.scope().epoch - 1 })); }],
  ['other profile proof', (f) => { f.setLatest(f.proof({ profileId: f.root().profiles[1].id })); }],
  ['different saved fingerprint', (f) => { f.setLatest(f.proof({ configFingerprint: '0'.repeat(64) })); }],
  ['stopped listener', (f) => { f.running({ proxyStatus: 'stopped', runningConfig: null }); }],
  ['starting listener', (f) => { f.running({ proxyStatus: 'starting' }); }],
  ['missing running configuration', (f) => { f.running({ runningConfig: null }); }],
  ['invalid auth status', (f) => { f.loginState({ loginStatus: 'pending' }); }],
  ['invalid Cookie state', (f) => { f.loginState({ cookieValid: false }); }],
  ['missing current Cookie', (f) => { f.setCookie(''); }],
  ['bind-only result', (f) => { const value = f.proof(); Object.assign(value.checks[0], { code: 'LOCAL_PORT_AVAILABLE', mode: 'bind-only' }); f.setLatest(value); }],
  ['SSH code without auth mode', (f) => { const value = f.proof(); delete value.checks[0].mode; f.setLatest(value); }],
  ['failed local check', (f) => { const value = f.proof(); value.checks[0].status = 'failed'; f.setLatest(value); }],
  ['failed WSS check', (f) => { const value = f.proof(); value.checks[1].status = 'failed'; f.setLatest(value); }],
  ['missing WSS check', (f) => { const value = f.proof(); value.checks = value.checks.filter((check) => check.id !== 'wss'); f.setLatest(value); }],
  ['handshake-only WSS', (f) => { const value = f.proof(); value.checks[1].code = 'WSS_HANDSHAKE_OK'; f.setLatest(value); }],
  ['missing remote command', (f) => { const value = f.proof(); value.checks.pop(); f.setLatest(value); }],
  ['failed remote command', (f) => { const value = f.proof(); value.checks[2].status = 'failed'; f.setLatest(value); }],
  ['stale authentication proof', (f) => { f.setLatest(f.proof({ authGeneration: 0 })); }],
]) {
  test(`completion rejects ${scenario[0]}`, async (t) => {
    const f = fixture(t);
    const before = structuredClone(f.root());
    const patch = scenario[1](f);
    await assert.rejects(f.save(patch), { code: 'ONBOARDING_NOT_READY' });
    assert.deepEqual(f.root(), before);
    assert.equal(f.calls.includes('save'), false);
  });
}

test('every running connection field, including derived WSS URL, must equal desired configuration', async (t) => {
  const f = fixture(t);
  for (const [key, value] of Object.entries(f.app.getSnapshot().desiredConfig)) {
    const altered = typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : `${value}-changed`;
    f.running({ runningConfig: { ...f.app.getSnapshot().desiredConfig, [key]: altered } });
    await assert.rejects(f.save(), { code: 'ONBOARDING_NOT_READY' }, key);
  }
  f.running({ runningConfig: { ...f.app.getSnapshot().desiredConfig, arbitrary: true } });
  await assert.rejects(f.save(), { code: 'ONBOARDING_NOT_READY' });
  assert.equal(f.calls.includes('save'), false);
});

test('saving even identical connection settings invalidates former proof without an epoch change', async (t) => {
  const f = fixture(t);
  const runId = f.latest().runId;
  const scope = f.scope();
  await f.app.run('save-settings', { scope, patch: { port: f.root().profiles[0].settings.port } });
  assert.deepEqual(f.scope(), scope);
  assert.equal(f.latest(), null);
  const writes = f.calls.filter((call) => call === 'save').length;
  await assert.rejects(f.save({ runId }), { code: 'ONBOARDING_NOT_READY' });
  assert.equal(f.calls.filter((call) => call === 'save').length, writes);
});

test('fresh actual config inspection rejects source modified after successful diagnostics', async (t) => {
  const f = fixture(t);
  const source = fs.readFileSync(f.sshConfig.configPath, 'utf8');
  fs.writeFileSync(f.sshConfig.configPath, source.replace(`  Port ${f.root().profiles[0].settings.port}`, '  Port 4999'));
  await assert.rejects(f.save(), { code: 'ONBOARDING_NOT_READY' });
  assert.equal(f.calls.includes('save'), false);
});

for (const code of ['SSH_CONFIG_MISSING', 'SSH_CONFIG_MISMATCH', 'SSH_ALIAS_CONFLICT', 'SSH_CONFIG_INVALID']) {
  test(`fresh config ${code} cannot complete onboarding`, async (t) => {
    const f = fixture(t, { inspect: () => {
      if (code === 'SSH_ALIAS_CONFLICT' || code === 'SSH_CONFIG_INVALID') throw Object.assign(new Error('private config'), { code });
      return { code };
    } });
    await assert.rejects(f.save(), { code: 'ONBOARDING_NOT_READY' });
    assert.equal(f.calls.includes('save'), false);
  });
}

test('missing fresh config inspection cannot silently complete', async (t) => {
  const f = fixture(t, { missingInspector: true });
  await assert.rejects(f.save(), { code: 'ONBOARDING_NOT_READY' });
  assert.equal(f.calls.includes('save'), false);
});

for (const change of ['new-run', 'invalidated', 'auth-generation', 'cookie', 'proxy', 'saved-config']) {
  test(`inspection await rechecks ${change} before persistence`, async (t) => {
    const gate = deferred();
    const f = fixture(t, { inspect: () => gate.promise });
    const completion = f.save();
    await turn();
    if (change === 'new-run') f.setLatest(f.proof());
    if (change === 'invalidated') f.setLatest(null);
    if (change === 'auth-generation') f.loginState({ authGeneration: 2 });
    if (change === 'cookie') f.setCookie('SCOW_USER=different');
    if (change === 'proxy') f.running({ proxyStatus: 'stopped', runningConfig: null });
    if (change === 'saved-config') {
      const root = structuredClone(f.root());
      root.profiles[0].settings.sshAlias = 'changed-alias';
      assert.equal(f.store.save(root).state, 'committed');
    }
    const writes = f.calls.filter((call) => call === 'save').length;
    gate.resolve({ code: 'SSH_CONFIG_OK' });
    await assert.rejects(completion, { code: 'ONBOARDING_NOT_READY' });
    assert.equal(f.calls.filter((call) => call === 'save').length, writes);
    assert.equal(f.root().profiles[0].onboarding.status, 'new');
  });
}

test('identical completion shares one action; different onboarding payload cannot overtake inspection', async (t) => {
  const gate = deferred();
  const f = fixture(t, { inspect: () => gate.promise });
  const first = f.save();
  const same = f.save();
  assert.equal(same, first);
  await assert.rejects(f.save({ status: 'dismissed' }), { code: 'OPERATION_IN_PROGRESS' });
  gate.resolve({ code: 'SSH_CONFIG_OK' });
  await first;
  assert.equal(f.calls.filter((call) => call === 'save').length, 1);
});

test('authentication revocation aborts completion during inspection and cannot write even after late success', async (t) => {
  const gate = deferred();
  const f = fixture(t, { inspect: () => gate.promise });
  const before = structuredClone(f.root());
  const completion = f.save();
  await turn();
  f.callbacks.onAuthRequired(f.scope());
  assert.deepEqual(await completion, { cancelled: true });
  gate.resolve({ code: 'SSH_CONFIG_OK' });
  await turn();
  assert.deepEqual(f.root(), before);
  assert.equal(f.calls.includes('save'), false);
  assert.equal(f.app.getSnapshot().cookieValid, false);
});

test('fatal exit aborts pending inspection rather than persisting completed metadata', async (t) => {
  const gate = deferred();
  const f = fixture(t, { inspect: () => gate.promise });
  const completion = f.save();
  await turn();
  const exit = f.app.prepareExit('fatal');
  assert.deepEqual(await completion, { cancelled: true });
  await exit;
  gate.resolve({ code: 'SSH_CONFIG_OK' });
  await turn();
  assert.equal(f.root().profiles[0].onboarding.status, 'new');
  assert.equal(f.calls.includes('save'), false);
});

for (const [failure, errorCode, committed] of [
  ['rename', 'SETTINGS_SAVE_FAILED', false],
  ['directory', 'SETTINGS_DURABILITY_UNCERTAIN', true],
  ['unknown', 'SETTINGS_COMMIT_UNKNOWN', false],
]) {
  test(`onboarding respects actual SettingsStore ${failure} commit semantics`, { skip: process.platform === 'win32' && failure !== 'rename' }, async (t) => {
    const f = fixture(t, { journal: true });
    const before = structuredClone(f.root());
    f.setFailure(failure);
    await assert.rejects(f.save({ status: 'dismissed', step: 'connect' }), { code: errorCode });
    const expected = structuredClone(before);
    if (committed) expected.profiles[0].onboarding = { status: 'dismissed', step: 'connect' };
    assert.deepEqual(f.root(), expected);
    assert.equal(f.store.isLocked(), failure !== 'rename');
    if (failure !== 'rename') {
      assert.equal(f.app.getSnapshot().storageErrorCode, errorCode);
      assert.equal(f.app.getSnapshot().proxyStatus, 'stopped');
      await assert.rejects(f.save({ status: 'new' }), { code: 'SETTINGS_LOCKED' });
    }
    const disk = JSON.parse(fs.readFileSync(path.join(f.sshConfig.sshDirectory, '..', 'settings.json'), 'utf8'));
    assert.equal(disk.profiles[0].onboarding.status, failure === 'rename' ? 'new' : 'dismissed');
    assert.deepEqual(disk.keyTransaction, before.keyTransaction);
    assert.deepEqual(disk.profiles[0].secrets, before.profiles[0].secrets);
  });
}

test('skip and resume metadata do not require authentication or a running listener', async (t) => {
  const f = fixture(t);
  f.setCookie('');
  f.loginState({ cookieValid: false, loginStatus: 'idle' });
  f.running({ proxyStatus: 'stopped', runningConfig: null });
  f.setLatest(null);
  for (const status of ['dismissed', 'new']) {
    await f.save({ status, step: 'login' });
    assert.deepEqual(f.root().profiles[0].onboarding, { status, step: 'login' });
  }
});

test('failed completion persistence does not claim completed or invalidate a reusable valid run', async (t) => {
  const f = fixture(t);
  const before = structuredClone(f.root());
  const runId = f.latest().runId;
  f.setFailure('rename');
  await assert.rejects(f.save(), { code: 'SETTINGS_SAVE_FAILED' });
  assert.deepEqual(f.root(), before);
  assert.equal(f.latest().runId, runId);
  assert.equal(f.store.isLocked(), false);
  f.setFailure(null);
  await f.save();
  assert.deepEqual(f.root().profiles[0].onboarding, { status: 'completed', step: 'verify' });
});

test('independent diagnostic failures also prevent onboarding completion', async (t) => {
  const f = fixture(t);
  const proof = f.proof();
  proof.checks.push({ id: 'ssh-config', status: 'failed', code: 'SSH_CONFIG_MISMATCH', durationMs: 1 });
  f.setLatest(proof);
  await assert.rejects(f.save(), { code: 'ONBOARDING_NOT_READY' });
  assert.equal(f.calls.includes('save'), false);
});

test('health preference does not require restart or invalidate connection proof', async (t) => {
  const f = fixture(t);
  const runId = f.latest().runId;
  const before = f.app.getSnapshot().desiredConfig;
  const result = await f.app.run('save-settings', { scope: f.scope(), patch: { healthProbeEnabled: true } });
  assert.equal(result.needsRestart, false);
  assert.deepEqual(f.app.getSnapshot().desiredConfig, before);
  assert.equal(f.latest().runId, runId);
  assert.equal(f.calls.includes('invalidate'), false);
  await f.save();
});

for (const patch of [{ path: '/work with spaces' }, { startupCommand: 'tmux new -A -s usshtc' }]) {
  test(`connection setting invalidates proof and requires restart: ${Object.keys(patch)[0]}`, async (t) => {
    const f = fixture(t);
    const runId = f.latest().runId;
    const result = await f.app.run('save-settings', { scope: f.scope(), patch });
    assert.equal(result.needsRestart, true);
    assert.equal(f.latest(), null);
    await assert.rejects(f.save({ runId }), { code: 'ONBOARDING_NOT_READY' });
  });
}
