'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAppController } = require('../../electron/app-controller');
const { DEFAULTS } = require('../../electron/constants');
const { createDefaultRoot, publicSettings } = require('../../electron/settings-store');
const { ServiceError } = require('../../electron/ipc-contract');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
function fixture(overrides = {}) {
  let callbacks;
  let scope;
  let cookie = 'SCOW_USER=fixture';
  let generation = 1;
  const calls = [];
  let root = createDefaultRoot({ ...DEFAULTS, autoConnect: false, ...overrides.settings });
  const settingsStore = { getRoot: () => root, isLocked: () => false, getStorageErrorCode: () => null,
    save: (candidate) => {
      const result = overrides.persistSettings ? overrides.persistSettings(publicSettings(candidate))
        : calls.push(['save', publicSettings(candidate).port]);
      const commit = () => { root = candidate; return { state: 'committed', durable: true }; };
      return result?.then ? result.then(commit) : commit();
    } };
  const credentials = {
    getCookie: () => cookie,
    getSsoStatus: () => ({ username: 'alice', hasPassword: true, storageAvailable: true }),
    saveCookie: (value) => { calls.push(['cookie', value]); return true; },
    saveSso: (value) => {
      calls.push(['sso', value]);
      return { username: value.username, hasPassword: Boolean(value.password), storageAvailable: true };
    },
    clearSso: () => ({ username: '', hasPassword: false }),
  };
  const proxy = {
    setScope: (value) => { scope = { ...value }; },
    start: async (config) => {
      calls.push(['start', config.port]);
      callbacks.onProxyState({ ...scope, proxyStatus: 'started', runningConfig: config, connectionCount: 0 });
      return {};
    },
    stop: async () => {
      calls.push(['stop']);
      callbacks.onProxyState({ ...scope, proxyStatus: 'stopped', runningConfig: null, connectionCount: 0 });
    },
    cancelPendingStart: () => calls.push(['cancel']),
    disconnectSession: (id) => { calls.push(['disconnect', id]); return true; },
    dispose: async () => {},
    ...overrides.proxy,
  };
  const login = {
    setProfile: (value) => {
      scope = { ...value };
      callbacks.onLoginState({ ...scope, authGeneration: generation, loginStatus: 'success', cookieValid: true, cookieCount: 1 });
    },
    setScope: (value) => { scope = { ...value }; },
    getCookie: () => cookie,
    deactivate: () => {
      cookie = '';
      generation += 1;
      callbacks.onLoginState({ ...scope, authGeneration: generation,
        loginStatus: 'idle', cookieValid: false, cookieCount: 0 });
    },
    resetForProfile: async (options = {}) => {
      cookie = '';
      generation += 1;
      callbacks.onLoginState({ ...scope, authGeneration: generation, loginStatus: options.loginStatus || 'idle', cookieValid: false, cookieCount: 0 });
    },
    start: async () => { calls.push(['login']); return {}; },
    dispose: () => calls.push(['login-dispose']),
  };
  const app = createAppController({ settingsStore, proxy, login, createCredentialStore: () => credentials,
    bindCallbacks: (value) => { callbacks = value; },
    confirmInterrupt: overrides.confirm || (async () => true),
    flush: overrides.flush || (() => { calls.push(['flush']); }),
    onExitPrepared: () => calls.push(['exit']),
    ...overrides.services,
  });
  const currentScope = () => {
    const { profileId, epoch } = app.getSnapshot();
    return { profileId, epoch };
  };
  const authenticate = () => {
    cookie = 'SCOW_USER=new';
    callbacks.onLoginState({ ...currentScope(), authGeneration: generation,
      loginStatus: 'success', cookieValid: true, cookieCount: 1 });
    callbacks.onAuthenticated({ scope: currentScope(), authGeneration: generation, cookie });
  };
  return { app, calls, currentScope, callbacks, authenticate, proxy, get settings() { return publicSettings(root); } };
}

test('saved configuration remains distinct from the frozen running instance', async () => {
  const f = fixture();
  await f.app.run('start', { scope: f.currentScope() });
  assert.equal(f.app.getSnapshot().runningConfig.port, 3000);
  await f.app.run('save-settings', { scope: f.currentScope(), patch: { port: 4000 } });
  assert.equal(f.app.getSnapshot().desiredConfig.port, 4000);
  assert.equal(f.app.getSnapshot().runningConfig.port, 3000);
  assert.equal(f.app.getSnapshot().needsRestart, true);
  await f.app.run('save-settings', { scope: f.currentScope(), patch: { port: 3000 } });
  assert.equal(f.app.getSnapshot().needsRestart, false);
  await f.app.run('save-settings', { scope: f.currentScope(), patch: { port: 4000 } });
  const before = f.currentScope();
  await f.app.run('restart', { scope: before });
  assert.equal(f.app.getSnapshot().runningConfig.port, 4000);
  assert.ok(f.currentScope().epoch > before.epoch);
  assert.equal(f.app.getSnapshot().operation, null);
});

test('only identical normalized action/scope/target payloads reuse a promise', async () => {
  const confirmation = deferred();
  const f = fixture({ confirm: () => confirmation.promise });
  const scope = f.currentScope();
  const first = f.app.run('disconnect', { scope, sessionId: 1 });
  assert.equal(f.app.run('disconnect', { sessionId: 1, scope: { ...scope } }), first);
  await assert.rejects(f.app.run('disconnect', { scope, sessionId: 2 }), { code: 'OPERATION_IN_PROGRESS' });
  confirmation.resolve(true);
  await first;
  assert.deepEqual(f.calls.filter((call) => call[0] === 'disconnect'), [['disconnect', 1]]);
});

test('cancelled confirmation preserves connections and current dirty revision', async () => {
  const f = fixture({ confirm: async () => false });
  await f.app.run('start', { scope: f.currentScope() });
  await f.app.run('set-dirty', { scope: f.currentScope(), dirty: true, draftRevision: 3 });
  const result = await f.app.run('stop', { scope: f.currentScope(), draftRevision: 3 });
  assert.deepEqual(result, { cancelled: true });
  assert.equal(f.app.getSnapshot().proxyStatus, 'started');
  assert.equal(f.app.getSnapshot().desiredRunning, true);
  assert.equal(f.calls.filter((call) => call[0] === 'stop').length, 0);
});

test('edits while the native confirmation is open reject before interruption', async () => {
  const confirmation = deferred();
  const f = fixture({ confirm: () => confirmation.promise });
  await f.app.run('set-dirty', { scope: f.currentScope(), dirty: true, draftRevision: 1 });
  const operation = f.app.run('stop', { scope: f.currentScope(), draftRevision: 1 });
  await turn();
  await f.app.run('set-dirty', { scope: f.currentScope(), dirty: true, draftRevision: 2 });
  confirmation.resolve(true);
  await assert.rejects(operation, { code: 'DRAFT_CHANGED' });
  assert.equal(f.calls.filter((call) => call[0] === 'stop').length, 0);
});

test('login completes after window creation and a later user stop prevents authentication autostart', async () => {
  const f = fixture();
  await f.app.run('login', { scope: f.currentScope() });
  assert.equal(f.app.getSnapshot().operation, null);
  assert.equal(f.app.getSnapshot().desiredRunning, true);
  await f.app.run('stop', { scope: f.currentScope() });
  f.authenticate();
  await turn();
  assert.equal(f.app.getSnapshot().desiredRunning, false);
  assert.equal(f.calls.filter((call) => call[0] === 'start').length, 0);
  assert.deepEqual(f.calls.filter((call) => call[0] === 'cookie'), [['cookie', 'SCOW_USER=new']]);
});

test('authentication waits for the current action slot and then starts without self-deadlock', async () => {
  const saved = deferred();
  const f = fixture({ persistSettings: () => saved.promise });
  const save = f.app.run('save-settings', { scope: f.currentScope(), patch: { port: 4000 } });
  f.authenticate();
  await turn();
  assert.equal(f.calls.filter((call) => call[0] === 'cookie').length, 0);
  saved.resolve();
  await save;
  await turn();
  assert.equal(f.calls.filter((call) => call[0] === 'cookie').length, 1);
});

test('stop cancels an in-flight start and stale callbacks cannot overwrite current state', async () => {
  const started = deferred();
  const f = fixture({ proxy: { start: () => started.promise } });
  const start = f.app.run('start', { scope: f.currentScope() });
  await turn();
  const oldScope = f.currentScope();
  const stop = f.app.run('stop', { scope: oldScope });
  started.resolve({ cancelled: true });
  assert.deepEqual(await start, { cancelled: true });
  await stop;
  f.callbacks.onProxyState({ ...oldScope, proxyStatus: 'started', runningConfig: { port: 9999 } });
  assert.equal(f.app.getSnapshot().proxyStatus, 'stopped');
  assert.equal(f.app.getSnapshot().runningConfig, null);
  assert.equal(f.app.getSnapshot().desiredRunning, false);
});

test('security revocation aborts a confirmed restart and cannot restore old listening state', async () => {
  const stopped = deferred();
  const f = fixture();
  await f.app.run('start', { scope: f.currentScope() });
  f.proxy.stop = () => stopped.promise;
  const restart = f.app.run('restart', { scope: f.currentScope() });
  await turn();
  f.callbacks.onAuthRequired({ ...f.currentScope(), statusCode: 401 });
  stopped.resolve();
  assert.deepEqual(await restart, { cancelled: true });
  await turn();
  assert.equal(f.calls.filter((call) => call[0] === 'start').length, 1);
  assert.equal(f.app.getSnapshot().cookieValid, false);
});

test('prepareExit is reusable cleanup, never an application exit request', async () => {
  const f = fixture();
  const first = f.app.prepareExit('app_exit');
  assert.equal(f.app.prepareExit('app_exit'), first);
  await first;
  assert.equal(f.calls.filter((call) => call[0] === 'exit').length, 0);
  assert.equal(f.calls.filter((call) => call[0] === 'flush').length, 1);
  await assert.rejects(f.app.run('start', { scope: f.currentScope() }), { code: 'SHUTTING_DOWN' });
});

test('scope errors and failed persistence leave saved and running config unchanged', async () => {
  const f = fixture({ persistSettings: () => { throw Object.assign(new Error(), { code: 'SETTINGS_WRITE_FAILED' }); } });
  await assert.rejects(f.app.run('start', { scope: { profileId: 'other', epoch: 0 } }), { code: 'PROFILE_CHANGED' });
  await assert.rejects(f.app.run('save-settings', { scope: f.currentScope(), patch: { port: 4000 } }), { code: 'SETTINGS_WRITE_FAILED' });
  assert.equal(f.app.getSnapshot().desiredConfig.port, 3000);
  assert.equal(f.app.getSnapshot().runningConfig, null);
});

test('idempotent duplicates keep their immutable origin even after their own epoch advance', async () => {
  const started = deferred();
  const f = fixture({ proxy: { start: () => started.promise } });
  const scope = f.currentScope();
  const start = f.app.run('start', { scope });
  await turn();
  assert.ok(f.currentScope().epoch > scope.epoch);
  assert.equal(f.app.run('start', { scope }), start);
  started.resolve({});
  await start;
});

test('authentication revocation bypasses a native confirmation that has not resolved', async () => {
  const confirmation = deferred();
  const f = fixture({ confirm: () => confirmation.promise });
  await f.app.run('start', { scope: f.currentScope() });
  f.callbacks.onProxyState({ ...f.currentScope(), connectionCount: 1 });
  const login = f.app.run('login', { scope: f.currentScope() });
  await turn();
  f.callbacks.onAuthRequired({ ...f.currentScope(), statusCode: 403 });
  assert.deepEqual(await login, { cancelled: true });
  await turn();
  assert.ok(f.calls.some((call) => call[0] === 'stop'));
  assert.equal(f.app.getSnapshot().cookieValid, false);
  confirmation.resolve(true);
  await turn();
  assert.equal(f.calls.some((call) => call[0] === 'login'), false);
});

test('credential/account changes consume only the confirmed draft and never expose the password', async () => {
  const f = fixture();
  const sameAccount = await f.app.run('save-credentials', {
    scope: f.currentScope(), username: ' alice ', password: '',
  });
  assert.equal(sameAccount.profileId, 'default');
  assert.equal(f.calls.some((call) => call[0] === 'stop'), false);
  await f.app.run('set-dirty', { scope: f.currentScope(), dirty: true, draftRevision: 4 });
  const changed = await f.app.run('save-credentials', { scope: f.currentScope(), username: 'bob', password: '' });
  assert.equal(changed.consumedDraftRevision, 4);
  assert.equal(f.app.getSnapshot().desiredRunning, false);
  await f.app.run('clear-credentials', { scope: f.currentScope() });
  assert.equal(f.app.getSnapshot().cookieValid, false);
});

test('theme and locale changes persist before the single coordinated exit preparation', async () => {
  const f = fixture();
  await f.app.run('theme', { scope: f.currentScope(), value: 'light' });
  await f.app.run('locale', { scope: f.currentScope(), value: 'zh' });
  assert.equal(f.settings.theme, 'light');
  assert.equal(f.settings.locale, 'zh');
  const exit = await f.app.run('exit', { scope: f.currentScope() });
  assert.equal(exit.consumedDraftRevision, 0);
  await f.app.prepareExit('app_exit');
  assert.equal(f.calls.filter((call) => call[0] === 'flush').length, 1);
  assert.equal(f.calls.filter((call) => call[0] === 'exit').length, 1);
});

test('unknown actions/payload fields and invalid dirty/credential/config values are rejected before side effects', async () => {
  const f = fixture();
  for (const [action, payload, code] of [
    ['arbitrary', { scope: f.currentScope() }, 'INVALID_ARGUMENT'],
    ['start', { scope: f.currentScope(), arbitrary: true }, 'INVALID_ARGUMENT'],
    ['disconnect', { scope: f.currentScope(), sessionId: 0 }, 'INVALID_ARGUMENT'],
    ['save-credentials', { scope: f.currentScope(), username: 'a\nb' }, 'INVALID_ARGUMENT'],
    ['save-credentials', { scope: f.currentScope(), username: 'bob', password: 'x'.repeat(4097) }, 'CREDENTIAL_TOO_LARGE'],
    ['save-settings', { scope: f.currentScope(), patch: { host: 'bad\nhost' } }, 'VALIDATION_FAILED'],
    ['theme', { scope: f.currentScope(), value: 'other' }, 'VALIDATION_FAILED'],
    ['set-dirty', { scope: f.currentScope(), dirty: 'yes', draftRevision: 0 }, 'INVALID_ARGUMENT'],
  ]) await assert.rejects(f.app.run(action, payload), { code });
  assert.equal(f.calls.length, 0);
});


test('cancelling a dirty stop confirmation does not cancel the start it would interrupt', async () => {
  const started = deferred();
  const confirmation = deferred();
  const f = fixture({ confirm: () => confirmation.promise, proxy: { start: () => started.promise } });
  const start = f.app.run('start', { scope: f.currentScope() });
  await turn();
  await f.app.run('set-dirty', { scope: f.currentScope(), dirty: true, draftRevision: 7 });
  const stop = f.app.run('stop', { scope: f.currentScope() });
  assert.equal(f.app.run('stop', { scope: f.currentScope() }), stop);
  await turn();
  assert.equal(f.calls.some((call) => call[0] === 'cancel'), false);
  confirmation.resolve(false);
  assert.deepEqual(await stop, { cancelled: true });
  assert.equal(f.app.getSnapshot().desiredRunning, true);
  started.resolve({});
  assert.deepEqual(await start, {});
  assert.equal(f.calls.some((call) => call[0] === 'stop'), false);
});

test('confirmed dirty stop adopts only its own token after aborting the pending start', async () => {
  const started = deferred();
  const confirmation = deferred();
  const f = fixture({ confirm: () => confirmation.promise, proxy: { start: () => started.promise } });
  const start = f.app.run('start', { scope: f.currentScope() });
  await turn();
  await f.app.run('set-dirty', { scope: f.currentScope(), dirty: true, draftRevision: 8 });
  const stop = f.app.run('stop', { scope: f.currentScope() });
  await turn();
  confirmation.resolve(true);
  assert.deepEqual(await start, { cancelled: true });
  const stopped = await stop;
  assert.equal(stopped.consumedDraftRevision, 8);
  assert.equal(f.app.getSnapshot().desiredRunning, false);
  started.resolve({});
});

test('authentication persistence errors remain visible alongside the revoked-authentication code', async () => {
  const f = fixture();
  f.callbacks.onLoginState({ ...f.currentScope(), authGeneration: 1, errorCode: 'AUTH_PERSIST_FAILED' });
  f.callbacks.onAuthRequired({ ...f.currentScope(), statusCode: 401 });
  await turn();
  assert.equal(f.app.getSnapshot().errorCode, 'AUTH_REQUIRED');
  assert.equal(f.app.getSnapshot().storageErrorCode, 'AUTH_PERSIST_FAILED');
  assert.equal(f.app.getSnapshot().loginStatus, 'failure');
  assert.equal(f.app.getSnapshot().cookieValid, false);
});

test('opening an existing login attempt only focuses it, without clearing auth/dirty state again', async () => {
  const f = fixture({ confirm: () => { throw new Error('must not interrupt an existing login attempt'); } });
  f.callbacks.onLoginState({ ...f.currentScope(), authGeneration: 1, loginStatus: 'pending', cookieValid: false });
  await f.app.run('set-dirty', { scope: f.currentScope(), dirty: true, draftRevision: 2 });
  assert.deepEqual(await f.app.run('login', { scope: f.currentScope() }), {});
  assert.equal(f.calls.filter((call) => call[0] === 'login').length, 1);
  assert.equal(f.calls.some((call) => call[0] === 'stop'), false);
  assert.equal(f.currentScope().epoch, 0);
});

test('config generation requires exact reviewed hashes and rejects renderer connection overrides', async () => {
  const f = fixture();
  const hash = 'a'.repeat(64);
  for (const sourceHash of [undefined, '', 'a'.repeat(63), [hash], { value: hash }]) {
    await assert.rejects(f.app.run('generate-config', { scope: f.currentScope(), sourceHash, configHash: hash }), { code: 'SSH_CONFIG_CHANGED' });
  }
  await assert.rejects(f.app.run('generate-config', { scope: f.currentScope(), sourceHash: hash, configHash: hash, host: 'other-host' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.settings.port, 3000);
  assert.equal(f.calls.some((call) => call[0] === 'start' || call[0] === 'stop'), false);
});

test('autostart applies OS state before committing preference and rolls back failed writes without stopping SSH', async () => {
  let enabled = false;
  const status = () => ({ supported: true, enabled, approvalRequired: false, errorCode: null });
  const f = fixture({ persistSettings: () => {
    assert.equal(enabled, true);
    throw new ServiceError('SETTINGS_WRITE_FAILED');
  }, services: { getAutostartStatus: status, setAutostartEnabled: async (value) => { enabled = value; return status(); } } });
  await f.app.run('start', { scope: f.currentScope() });
  await assert.rejects(f.app.run('set-autostart', { scope: f.currentScope(), enabled: true }), { code: 'SETTINGS_WRITE_FAILED' });
  assert.equal(enabled, false);
  assert.equal(f.settings.launchAtLogin, false);
  assert.equal(f.app.getSnapshot().proxyStatus, 'started');
  assert.equal(f.calls.some(([kind]) => kind === 'stop'), false);
});

test('autostart preserves native approval state and only an explicit OS action can save its preference', async () => {
  const approval = { supported: true, enabled: false, approvalRequired: true, errorCode: null };
  const f = fixture({ services: { getAutostartStatus: () => ({ ...approval, approvalRequired: false }), setAutostartEnabled: async () => approval } });
  await assert.rejects(f.app.run('save-app-settings', { scope: f.currentScope(), patch: { launchAtLogin: true } }), { code: 'VALIDATION_FAILED' });
  const result = await f.app.run('set-autostart', { scope: f.currentScope(), enabled: true });
  assert.equal(result.enabled, false);
  assert.equal(result.approvalRequired, true);
  assert.equal(f.settings.launchAtLogin, true);
});

test('a rejected partial OS change rolls back, and unsupported registrations never attempt mutation', async () => {
  let enabled = false;
  const f = fixture({ services: { getAutostartStatus: () => ({ supported: true, enabled, approvalRequired: false, errorCode: null }),
    setAutostartEnabled: async (value) => { enabled = value; if (value) throw new ServiceError('AUTOSTART_FAILED'); return {}; } } });
  await assert.rejects(f.app.run('set-autostart', { scope: f.currentScope(), enabled: true }), { code: 'AUTOSTART_FAILED' });
  assert.equal(enabled, false);
  assert.equal(f.settings.launchAtLogin, false);
  const unsupported = fixture({ services: { getAutostartStatus: () => ({ supported: false, enabled: false, approvalRequired: false, errorCode: 'AUTOSTART_UNAVAILABLE' }),
    setAutostartEnabled: () => { throw new Error('Unsupported OS must not mutate registration'); } } });
  await assert.rejects(unsupported.app.run('set-autostart', { scope: unsupported.currentScope(), enabled: true }), { code: 'AUTOSTART_UNAVAILABLE' });
});

test('authentication revocation after native OS change prevents preference commit and restores OS state', async () => {
  const gate = deferred(); let enabled = false;
  const f = fixture({ services: { getAutostartStatus: () => ({ supported: true, enabled, approvalRequired: false, errorCode: null }),
    setAutostartEnabled: async (value) => { if (value) await gate.promise; enabled = value; return { supported: true, enabled, approvalRequired: false, errorCode: null }; } } });
  const pending = f.app.run('set-autostart', { scope: f.currentScope(), enabled: true });
  await turn();
  f.callbacks.onAuthRequired({ ...f.currentScope(), statusCode: 401 });
  gate.resolve();
  assert.deepEqual(await pending, { cancelled: true });
  await turn();
  assert.equal(enabled, false);
  assert.equal(f.settings.launchAtLogin, false);
  assert.equal(f.app.getSnapshot().cookieValid, false);
  assert.equal(f.calls.some(([kind]) => kind === 'save'), false);
});

test('background recovery waits outside the action slot and an aborted round cannot start afterward', async () => {
  const gate = deferred();
  const f = fixture({ settings: { autoConnect: true }, persistSettings: () => gate.promise });
  const saving = f.app.run('save-app-settings', { scope: f.currentScope(), patch: { reconnectOnResume: false } });
  const abort = new AbortController();
  const queued = f.callbacks.requestRecoveryStart(f.currentScope(), { signal: abort.signal });
  abort.abort(); gate.resolve();
  await saving;
  assert.deepEqual(await queued, { cancelled: true });
  assert.equal(f.settings.reconnectOnResume, false);
  assert.equal(f.app.getSnapshot().desiredRunning, true);
  assert.equal(f.app.getSnapshot().proxyStatus, 'stopped');
  assert.equal(f.calls.some(([kind]) => kind === 'start'), false);
});

test('validated stop cancels recovery before an action conflict while stale stop cannot cancel another scope', async () => {
  const gate = deferred(); const cancelled = [];
  const f = fixture({ persistSettings: () => gate.promise, services: { cancelRecovery: (reason) => cancelled.push(reason) } });
  const scope = f.currentScope();
  const saving = f.app.run('save-app-settings', { scope, patch: { notifyAuth: false } });
  await assert.rejects(f.app.run('stop', { scope: { ...scope, epoch: scope.epoch - 1 } }), { code: 'PROFILE_CHANGED' });
  assert.deepEqual(cancelled, []);
  await assert.rejects(f.app.run('stop', { scope }), { code: 'OPERATION_IN_PROGRESS' });
  assert.deepEqual(cancelled, ['user_stop']);
  gate.resolve(); await saving;
});

test('cancelled update confirmation preserves running connections, scope and the next draft confirmation', async () => {
  const confirmations = [];
  const f = fixture({ confirm: async value => { confirmations.push(value); return false; }, services: {
    installUpdate: async (_request, context) => context.prepare(),
  } });
  await f.app.run('start', { scope: f.currentScope() });
  f.callbacks.onProxyState({ ...f.currentScope(), connectionCount: 2 });
  await f.app.run('set-dirty', { scope: f.currentScope(), dirty: true, draftRevision: 11 });
  const origin = f.currentScope();
  assert.deepEqual(await f.app.run('install-update', { scope: origin, version: '1.3.0' }), { cancelled: true });
  assert.deepEqual(f.currentScope(), origin);
  assert.equal(f.app.getSnapshot().proxyStatus, 'started');
  assert.equal(f.app.getSnapshot().connectionCount, 2);
  assert.equal(f.calls.some(value => value[0] === 'stop' || value[0] === 'login-dispose'), false);
  await f.app.run('stop', { scope: f.currentScope() });
  assert.equal(confirmations.at(-1).dirty, true);
  assert.equal(confirmations.at(-1).draftRevision, 11);
});

test('update installation holds its action through stop and flush, consumes the draft only at accepted handoff and never requests exit', async () => {
  const flushed = deferred(), prepared = deferred(), handoff = deferred();
  const stages = [];
  const f = fixture({ flush: () => { stages.push('flush'); return flushed.promise; }, services: {
    onUpdatePreparing: () => stages.push('preparing'), onUpdateHandoff: () => stages.push('handoff'),
    installUpdate: async (_request, context) => {
      await context.prepare(); prepared.resolve(); await handoff.promise;
      context.assertCurrent(); context.onHandoff(); return { phase: 'installing' };
    },
  } });
  await f.app.run('start', { scope: f.currentScope() });
  await f.app.run('set-dirty', { scope: f.currentScope(), dirty: true, draftRevision: 9 });
  const origin = f.currentScope();
  const installation = f.app.run('install-update', { scope: origin, version: '1.3.0' });
  assert.equal(f.app.run('install-update', { scope: origin, version: '1.3.0' }), installation);
  await turn();
  assert.deepEqual(stages, ['preparing', 'flush']);
  assert.equal(f.app.getSnapshot().operation, 'preparing_update');
  assert.equal(f.app.getSnapshot().proxyStatus, 'stopped');
  await assert.rejects(f.app.run('theme', { scope: f.currentScope(), value: 'light' }), { code: 'OPERATION_IN_PROGRESS' });
  assert.equal(f.calls.some(value => value[0] === 'login-dispose' || value[0] === 'exit'), false);
  flushed.resolve(); await prepared.promise;
  assert.equal(stages.includes('handoff'), false);
  handoff.resolve();
  assert.deepEqual(await installation, { phase: 'installing', consumedDraftRevision: 9 });
  assert.deepEqual(stages, ['preparing', 'flush', 'handoff']);
  assert.equal(f.calls.filter(value => value[0] === 'login-dispose').length, 1);
  assert.equal(f.calls.some(value => value[0] === 'exit'), false);
  await assert.rejects(f.app.run('start', { scope: f.currentScope() }), { code: 'SHUTTING_DOWN' });
});

for (const broken of ['stop', 'flush']) test(`update ${broken} failure keeps UI authority and dirty revision for a genuine retry`, async () => {
  let fail = true, handoffs = 0;
  const confirmations = [];
  const f = fixture({ confirm: async value => { confirmations.push(value); return true; },
    flush: () => { if (fail && broken === 'flush') throw new Error('private flush failure'); }, services: {
      onUpdateHandoff: () => { handoffs += 1; },
      installUpdate: async (_request, context) => { await context.prepare(); context.onHandoff(); return {}; },
    } });
  const originalStop = f.proxy.stop;
  f.proxy.stop = async (...args) => { if (fail && broken === 'stop') throw new Error('private stop failure'); return originalStop(...args); };
  await f.app.run('start', { scope: f.currentScope() });
  await f.app.run('set-dirty', { scope: f.currentScope(), dirty: true, draftRevision: 5 });
  await assert.rejects(f.app.run('install-update', { scope: f.currentScope(), version: '1.3.0' }), { code: 'UPDATE_PREPARATION_FAILED' });
  assert.equal(handoffs, 0);
  assert.equal(f.calls.some(value => value[0] === 'login-dispose' || value[0] === 'exit'), false);
  fail = false;
  assert.deepEqual(await f.app.run('install-update', { scope: f.currentScope(), version: '1.3.0' }), { consumedDraftRevision: 5 });
  assert.equal(confirmations.at(-1).dirty, true);
  assert.equal(confirmations.at(-1).draftRevision, 5);
  assert.equal(handoffs, 1);
});

test('platform install failure cannot consume a confirmed draft or shut down the still-visible application', async () => {
  const confirmations = [];
  const f = fixture({ confirm: async value => { confirmations.push(value); return true; }, services: {
    installUpdate: async (_request, context) => { await context.prepare(); throw new ServiceError('UPDATE_INSTALL_FAILED'); },
  } });
  await f.app.run('set-dirty', { scope: f.currentScope(), dirty: true, draftRevision: 4 });
  await assert.rejects(f.app.run('install-update', { scope: f.currentScope(), version: '1.3.0' }), { code: 'UPDATE_INSTALL_FAILED' });
  assert.equal(f.calls.some(value => value[0] === 'login-dispose' || value[0] === 'exit'), false);
  await f.app.run('stop', { scope: f.currentScope() });
  assert.equal(confirmations.at(-1).dirty, true);
  assert.equal(confirmations.at(-1).draftRevision, 4);
});

test('fatal shutdown aborts a staged update and late handoff cannot clear drafts or regain ownership', async () => {
  const prepared = deferred(), late = deferred();
  let context, lateFailure, handoffs = 0;
  const f = fixture({ services: {
    onUpdateHandoff: () => { handoffs += 1; },
    installUpdate: async (_request, value) => {
      context = value; await context.prepare(); prepared.resolve(); await late.promise;
      try { context.onHandoff(); } catch (error) { lateFailure = error; throw error; }
    },
  } });
  const installation = f.app.run('install-update', { scope: f.currentScope(), version: '1.3.0' });
  await prepared.promise;
  await f.app.prepareExit('fatal');
  assert.deepEqual(await installation, { cancelled: true });
  assert.equal(context.signal.aborted, true);
  late.resolve(); await turn();
  assert.equal(lateFailure.code, 'OPERATION_CANCELLED');
  assert.equal(handoffs, 0);
  assert.equal(f.calls.filter(value => value[0] === 'login-dispose').length, 1);
});

test('editing while update confirmation is open rejects before stopping or native handoff', async () => {
  const answer = deferred();
  let preparing = 0;
  const f = fixture({ confirm: () => answer.promise, services: {
    onUpdatePreparing: () => { preparing += 1; },
    installUpdate: async (_request, context) => context.prepare(),
  } });
  await f.app.run('start', { scope: f.currentScope() });
  await f.app.run('set-dirty', { scope: f.currentScope(), dirty: true, draftRevision: 6 });
  const installation = f.app.run('install-update', { scope: f.currentScope(), version: '1.3.0' });
  await turn();
  await f.app.run('set-dirty', { scope: f.currentScope(), dirty: true, draftRevision: 7 });
  answer.resolve(true);
  await assert.rejects(installation, { code: 'DRAFT_CHANGED' });
  assert.equal(preparing, 0);
  assert.equal(f.calls.some(value => value[0] === 'stop'), false);
  assert.equal(f.app.getSnapshot().proxyStatus, 'started');
});

test('update action rejects malformed versions and renderer installation paths before acquiring authority', async () => {
  let installs = 0;
  const f = fixture({ services: { installUpdate: () => { installs += 1; } } });
  for (const version of ['v1.3.0', '1.3.0-beta.1', '01.3.0', '', 123]) {
    await assert.rejects(f.app.run('install-update', { scope: f.currentScope(), version }), { code: 'UPDATE_VERSION_REJECTED' });
  }
  await assert.rejects(f.app.run('install-update', { scope: f.currentScope(), version: '1.3.0', path: '/untrusted/installer' }), { code: 'INVALID_ARGUMENT' });
  assert.equal(installs, 0);
});
