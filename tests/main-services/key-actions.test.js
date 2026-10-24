'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAppController } = require('../../electron/app-controller');
const { createDefaultRoot } = require('../../electron/settings-store');

const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}
const before = { clientFingerprint: `SHA256:${'a'.repeat(43)}`, hostFingerprint: `SHA256:${'b'.repeat(43)}` };
const after = { clientFingerprint: `SHA256:${'c'.repeat(43)}`, hostFingerprint: `SHA256:${'d'.repeat(43)}` };
const publicInfo = { scope: 'application', recoveryRequired: false,
  client: { state: 'ready', publicKey: 'ssh-ed25519 fixture', fingerprint: after.clientFingerprint, privateKeyPath: '/fixture/client' },
  host: { state: 'ready', fingerprint: after.hostFingerprint, privateKeyPath: '/fixture/host' } };

function fixture(options = {}) {
  let root = createDefaultRoot({ autoConnect: false });
  let callbacks, scope, candidate;
  const calls = [], confirmations = [];
  const keys = {
    prepareRotate(target) { calls.push(['prepare-rotate', target]); return {}; },
    prepareRebuild(target) { calls.push(['prepare-rebuild', target]); return {}; },
    prepareImport: async () => ({}),
    summary: () => ({ target: options.target || 'client', before: { ...before }, after: { ...after } }),
    assertReady() {},
    exportBackup: async () => { calls.push(['export']); return { exported: true }; },
    execute: async (_plan, context) => {
      calls.push(['backup']);
      if (options.cancelBackup) return { cancelled: true };
      context.assertCurrent();
      await context.beforeInstall();
      context.assertCurrent();
      await context.startCandidate({ transactionId: 'fixture-id', keyMaterial: { fixture: true } });
      if (options.beforeCommit) await options.beforeCommit();
      context.assertCurrent();
      calls.push(['commit']);
      await context.activateCandidate('fixture-id');
      context.assertCurrent();
      return publicInfo;
    },
  };
  const controller = createAppController({
    portalPreflight: { run: async () => ({ ok: true }) },
    settingsStore: { getRoot: () => root, isLocked: () => false,
      getStorageErrorCode: () => options.storageErrorCode || null,
      retryLoad() { calls.push(['reload']); },
      save: (value) => { root = value; return { state: 'committed', durable: true }; } },
    keys,
    createCredentialStore: () => ({ getSsoStatus: () => ({ username: '', hasPassword: false }), saveCookie() {} }),
    proxy: {
      setScope(value) { scope = { ...value }; },
      async start(config) { calls.push(['start']); callbacks.onProxyState({ ...scope, proxyStatus: 'started', runningConfig: config, connectionCount: 2 }); return {}; },
      async stop() { calls.push(['stop']); callbacks.onProxyState({ ...scope, proxyStatus: 'stopped', runningConfig: null, connectionCount: 0 }); },
      async startCandidate(value) { candidate = value; calls.push(['candidate', value.scope]); return {}; },
      async activateCandidate() { calls.push(['activate']); callbacks.onProxyState({ ...scope, proxyStatus: 'started', runningConfig: candidate.config, connectionCount: 0 }); },
      cancelPendingStart() { calls.push(['cancel']); }, dispose: async () => {},
    },
    login: {
      setScope(value) { scope = { ...value }; },
      setProfile(value) { scope = { ...value }; callbacks.onLoginState({ ...scope, authGeneration: 1, cookieValid: true, cookieCount: 1, loginStatus: 'success' }); },
      getCookie: () => 'SCOW_USER=fixture',
      resetForProfile: async () => {}, deactivate() {}, dispose() {},
    },
    bindCallbacks(value) { callbacks = value; },
    cancelRecovery(reason) { calls.push(['recovery-cancel', reason]); },
    initializeKeys() { calls.push(['recover-keys']); return null; },
    confirmInterrupt: async (value) => { confirmations.push(value); return options.confirm ? options.confirm(value) : true; },
  });
  const currentScope = () => {
    const { profileId, epoch } = controller.getSnapshot();
    return { profileId, epoch };
  };
  return { controller, calls, confirmations, currentScope, callbacks, keys };
}

test('key replacement is exclusive, defaults to client, forwards host warning metadata and preserves running config', async () => {
  const confirmation = deferred();
  const f = fixture({ confirm: (value) => value.action === 'keys' ? confirmation.promise : true });
  await f.controller.run('start', { scope: f.currentScope() });
  await f.controller.run('save-settings', { scope: f.currentScope(), patch: { port: 4000 } });
  await f.controller.run('set-dirty', { scope: f.currentScope(), dirty: true, draftRevision: 4 });
  const scope = f.currentScope();
  const first = f.controller.run('rotate-keys', { scope, draftRevision: 4 });
  assert.equal(f.controller.run('rotate-keys', { scope: { ...scope }, target: 'client', draftRevision: 4 }), first);
  await assert.rejects(f.controller.run('rotate-keys', { scope, target: 'host' }), { code: 'OPERATION_IN_PROGRESS' });
  await turn();
  assert.equal(f.controller.getSnapshot().operation, 'changing_keys');
  assert.deepEqual(f.confirmations[0], { action: 'keys', connectionCount: 2, dirty: true, draftRevision: 4,
    keyChange: { target: 'client', before, after } });
  confirmation.resolve(true);
  const result = await first;
  assert.deepEqual(result.scope, f.currentScope());
  assert.ok(result.scope.epoch > scope.epoch);
  assert.equal(result.consumedDraftRevision, 4);
  assert.equal(f.controller.getSnapshot().runningConfig.port, 3000);
  assert.equal(f.controller.getSnapshot().desiredConfig.port, 4000);
  assert.equal(f.controller.getSnapshot().desiredRunning, true);
  assert.equal(f.calls.findIndex(([name]) => name === 'backup') < f.calls.findIndex(([name]) => name === 'stop'), true);
  assert.equal(f.calls.findIndex(([name]) => name === 'commit') < f.calls.findIndex(([name]) => name === 'activate'), true);
});

for (const cancellation of ['confirmation', 'backup']) {
  test(`${cancellation} cancellation leaves connections, dirty revision and epoch unchanged`, async () => {
    const f = fixture({ confirm: () => cancellation !== 'confirmation', cancelBackup: cancellation === 'backup' });
    await f.controller.run('start', { scope: f.currentScope() });
    await f.controller.run('set-dirty', { scope: f.currentScope(), dirty: true, draftRevision: 8 });
    const scope = f.currentScope();
    const result = await f.controller.run('rotate-keys', { scope, target: 'host', draftRevision: 8 });
    assert.deepEqual(result, { cancelled: true });
    assert.deepEqual(f.currentScope(), scope);
    assert.equal(f.controller.getSnapshot().proxyStatus, 'started');
    assert.equal(f.controller.getSnapshot().connectionCount, 2);
    assert.equal(f.controller.getSnapshot().desiredRunning, true);
    assert.equal(f.calls.some(([name]) => name === 'stop'), false);
    assert.equal(f.confirmations[0].dirty, true);
  });
}

test('readonly export does not consume dirty draft or advance epoch', async () => {
  const f = fixture({ confirm: () => false });
  const scope = f.currentScope();
  await f.controller.run('set-dirty', { scope, dirty: true, draftRevision: 3 });
  assert.deepEqual(await f.controller.run('export-key-backup', { scope }), { exported: true });
  assert.deepEqual(f.currentScope(), scope);
  await f.controller.run('stop', { scope, draftRevision: 3 });
  assert.equal(f.confirmations[0].dirty, true);
});

test('offline rebuild still verifies gated binding and never admits a listener', async () => {
  const f = fixture();
  const result = await f.controller.run('rebuild-keys', { scope: f.currentScope(), target: 'both' });
  assert.equal(result.recoveryRequired, false);
  assert.equal(f.calls.some(([name]) => name === 'candidate'), true);
  assert.equal(f.calls.some(([name]) => name === 'activate'), false);
  assert.equal(f.controller.getSnapshot().proxyStatus, 'stopped');
  assert.equal(f.controller.getSnapshot().desiredRunning, false);
});

test('draft changes while unified key confirmation is open reject before any backup or stop', async () => {
  const confirmation = deferred();
  const f = fixture({ confirm: () => confirmation.promise });
  const scope = f.currentScope();
  const operation = f.controller.run('rotate-keys', { scope });
  await turn();
  await f.controller.run('set-dirty', { scope, dirty: true, draftRevision: 1 });
  confirmation.resolve(true);
  await assert.rejects(operation, { code: 'DRAFT_CHANGED' });
  assert.equal(f.calls.some(([name]) => ['backup', 'stop'].includes(name)), false);
});

for (const interrupt of ['auth', 'fatal']) {
  test(`${interrupt} interruption after candidate binding cannot commit or restore original business listener`, async () => {
    const barrier = deferred();
    const f = fixture({ beforeCommit: () => barrier.promise });
    await f.controller.run('start', { scope: f.currentScope() });
    const operation = f.controller.run('rotate-keys', { scope: f.currentScope() });
    await turn();
    if (interrupt === 'auth') f.callbacks.onAuthRequired(f.currentScope());
    else f.controller.prepareExit('fatal');
    barrier.resolve();
    assert.deepEqual(await operation, { cancelled: true });
    await turn();
    assert.equal(f.calls.some(([name]) => name === 'commit'), false);
    assert.equal(f.calls.filter(([name]) => name === 'start').length, 1);
    assert.equal(f.controller.getSnapshot().proxyStatus, 'stopped');
  });
}

test('key service fixed failures remain visible rather than becoming INTERNAL_ERROR', async () => {
  const f = fixture();
  f.keys.prepareRotate = () => { throw Object.assign(new Error('private diagnostic must not cross IPC'), { code: 'SSH_KEY_INVALID' }); };
  await assert.rejects(f.controller.run('rotate-keys', { scope: f.currentScope() }), { code: 'SSH_KEY_INVALID' });
  assert.equal(f.controller.getSnapshot().errorCode, 'SSH_KEY_INVALID');
  await assert.rejects(f.controller.run('rebuild-keys', { scope: f.currentScope(), target: 'anything' }), { code: 'INVALID_ARGUMENT' });
});

test('ordinary retry-load with connections or dirty settings confirms before epoch or listener changes', async () => {
  const f = fixture({ confirm: () => false });
  await f.controller.run('start', { scope: f.currentScope() });
  const scope = f.currentScope();
  await f.controller.run('set-dirty', { scope, dirty: true, draftRevision: 9 });
  assert.deepEqual(await f.controller.run('retry-load', { scope, draftRevision: 9 }), { cancelled: true });
  assert.deepEqual(f.currentScope(), scope);
  assert.equal(f.controller.getSnapshot().proxyStatus, 'started');
  assert.equal(f.calls.some(([name]) => ['stop', 'reload', 'recover-keys'].includes(name)), false);
  assert.deepEqual(f.confirmations[0], { action: 'retry-load', connectionCount: 2, dirty: true, draftRevision: 9 });
});

test('clean stopped retry-load recovers keys without an extra dialog and returns the consumed revision', async () => {
  const f = fixture();
  const scope = f.currentScope();
  const result = await f.controller.run('retry-load', { scope });
  assert.equal(f.confirmations.length, 0);
  assert.equal(result.consumedDraftRevision, 0);
  assert.ok(f.currentScope().epoch > scope.epoch);
  assert.ok(f.calls.findIndex(([name]) => name === 'reload') < f.calls.findIndex(([name]) => name === 'recover-keys'));
});

test('corrupt recovery retains forced confirmation even when stopped and clean', async () => {
  const f = fixture({ storageErrorCode: 'SETTINGS_RECOVERY_REQUIRED', confirm: () => false });
  const scope = f.currentScope();
  assert.deepEqual(await f.controller.run('retry-load', { scope }), { cancelled: true });
  assert.equal(f.confirmations[0].action, 'recover-settings');
  assert.deepEqual(f.currentScope(), scope);
  assert.equal(f.calls.some(([name]) => ['stop', 'reload', 'recover-keys'].includes(name)), false);
});

test('draft edits during retry-load confirmation reject before recovery or interruption', async () => {
  const confirmation = deferred();
  const f = fixture({ confirm: () => confirmation.promise });
  const scope = f.currentScope();
  await f.controller.run('set-dirty', { scope, dirty: true, draftRevision: 1 });
  const operation = f.controller.run('retry-load', { scope });
  await turn();
  await f.controller.run('set-dirty', { scope, dirty: true, draftRevision: 2 });
  confirmation.resolve(true);
  await assert.rejects(operation, { code: 'DRAFT_CHANGED' });
  assert.deepEqual(f.currentScope(), scope);
  assert.equal(f.calls.some(([name]) => ['stop', 'reload', 'recover-keys'].includes(name)), false);
});
