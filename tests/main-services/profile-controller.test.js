'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { createAppController } = require('../../electron/app-controller');
const { createLoginController } = require('../../electron/login-controller');
const { CredentialStore } = require('../../electron/credential-store');
const { createDefaultRoot, publicSettings, validateRoot } = require('../../electron/settings-store');
const { ServiceError } = require('../../electron/ipc-contract');
const { PLATFORM } = require('../../electron/constants');

const turn = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const encrypted = (text) => Buffer.from(text).toString('base64');
const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (text) => Buffer.from(text), decryptString: (bytes) => bytes.toString() };

function fixture(options = {}) {
  let root = createDefaultRoot({ autoConnect: false });
  root.profiles[0].secrets = { ssoUsername: 'alice', ssoPassword: encrypted('password-A'), savedCookieEncrypted: encrypted('SCOW_USER=A') };
  const targetId = randomUUID();
  root.profiles.push({ ...structuredClone(root.profiles[0]), id: targetId, name: 'Research',
    settings: { ...root.profiles[0].settings, port: 4000, sshAlias: 'usshtc107-2', autoConnect: true },
    secrets: { ssoUsername: 'bob', ssoPassword: encrypted('password-B'), savedCookieEncrypted: encrypted('SCOW_USER=B') } });
  if (options.oneProfile) root.profiles.pop();
  let storageError = options.locked || null;
  let writeResult = null;
  let clearFailure = null;
  let stopFailure = false;
  let bindFailure = false;
  let activeScope;
  let callbacks;
  let queryNumber = 0;
  const queries = [], calls = [], windows = [], timers = new Map(), stores = new Map();
  const store = {
    getRoot: () => root, isLocked: () => storageError !== null, getStorageErrorCode: () => storageError,
    save: (candidate) => {
      calls.push(['save', candidate.activeProfileId]);
      validateRoot(candidate);
      const result = writeResult || { state: 'committed', durable: true, errorCode: null };
      if (result.state === 'committed') root = structuredClone(candidate);
      if (result.state === 'unknown' || (result.state === 'committed' && !result.durable)) storageError = result.errorCode;
      return result;
    },
    retryLoad: ({ allowCorruptRecovery }) => {
      calls.push(['retry-load', allowCorruptRecovery]);
      if (options.retryFailure) throw new ServiceError(storageError);
      storageError = null;
      if (options.reloadedRoot) root = structuredClone(options.reloadedRoot);
      return root;
    },
  };
  const credentials = (profileId) => {
    if (!stores.has(profileId)) stores.set(profileId, new CredentialStore({ safeStorage, profileId, userDataPath: '/fixture',
      readSecrets: () => root.profiles.find((item) => item.id === profileId).secrets,
      commitSecrets: (patch) => {
        calls.push(['secrets', profileId, Object.keys(patch)]);
        if (store.isLocked()) throw new ServiceError('SETTINGS_LOCKED');
        return store.save({ ...root, profiles: root.profiles.map((item) => item.id === profileId
          ? { ...item, secrets: { ...item.secrets, ...patch } } : item) });
      } }));
    return stores.get(profileId);
  };
  const partition = new EventEmitter();
  partition.cookies = new EventEmitter();
  partition.cookies.get = () => { const query = deferred(); queries.push(query); return query.promise; };
  partition.setPermissionCheckHandler = () => {};
  partition.setPermissionRequestHandler = () => {};
  for (const name of ['clearData', 'clearCache', 'clearAuthCache', 'closeAllConnections']) {
    partition[name] = async () => { calls.push([name]); if (clearFailure === name) throw new Error('fixture clear failure'); };
  }
  const clock = { setTimeout: (fn) => { const id = ++queryNumber; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id), setInterval: (fn) => { const id = ++queryNumber; timers.set(id, fn); return id; },
    clearInterval: (id) => timers.delete(id) };
  const login = createLoginController({ clock, getSession: () => partition,
    getConfig: () => publicSettings(root), getWindow: () => null,
    createWindow: () => {
      const window = new EventEmitter();
      window.destroyed = false;
      window.webContents = new EventEmitter();
      window.webContents.url = PLATFORM.url;
      window.webContents.getURL = () => window.webContents.url;
      window.webContents.setWindowOpenHandler = () => {};
      window.webContents.executeJavaScript = async () => {};
      window.loadURL = async () => {};
      window.isDestroyed = () => window.destroyed;
      window.destroy = () => { window.destroyed = true; window.emit('closed'); };
      window.close = window.destroy;
      window.focus = () => {};
      windows.push(window);
      return window;
    },
    onState: (patch) => callbacks?.onLoginState(patch),
    onAuthenticated: (auth) => callbacks?.onAuthenticated(auth),
    onAuthRequired: (source) => callbacks?.onAuthRequired(source) });
  const proxy = {
    setScope: (scope) => { activeScope = { ...scope }; },
    start: async (config, cookie) => {
      calls.push(['start', activeScope.profileId, config.port, cookie]);
      if (bindFailure) throw new ServiceError('PROXY_START_FAILED');
      callbacks.onProxyState({ ...activeScope, proxyStatus: 'started', runningConfig: config });
      return {};
    },
    stop: async () => {
      calls.push(['stop']);
      if (options.stopGate) await options.stopGate.promise;
      if (stopFailure) throw new ServiceError('PROXY_STOP_FAILED');
      callbacks.onProxyState({ ...activeScope, proxyStatus: 'stopped', runningConfig: null, connectionCount: 0 });
    },
    cancelPendingStart: () => calls.push(['cancel-start']), disconnectSession: () => true, dispose: async () => {},
  };
  const app = createAppController({ settingsStore: store, createCredentialStore: credentials, login, proxy,
    bindCallbacks: (value) => { callbacks = value; },
    confirmInterrupt: options.confirm || (async (value) => { calls.push(['confirm', value.action]); return true; }),
    clearHistory: (id) => { calls.push(['history-clear', id]); if (options.historyFailure) throw new ServiceError('HISTORY_STORAGE_FAILED'); },
    flush: () => {} });
  const scope = () => { const { profileId, epoch } = app.getSnapshot(); return { profileId, epoch }; };
  const activate = () => app.run('activate-profile', { scope: scope(), id: targetId });
  return { app, scope, activate, targetId, calls, windows, partition, queries, credentials, callbacks,
    root: () => root, store, login, timers,
    setWriteResult: (value) => { writeResult = value; },
    setClearFailure: (value) => { clearFailure = value; },
    setStopFailure: (value) => { stopFailure = value; },
    setBindFailure: (value) => { bindFailure = value; } };
}

test('profile creation uses UUIDs, smallest free alias, fresh secrets and bounded validated names', async () => {
  const f = fixture();
  const create = (name, settings) => f.app.run('create-profile', { scope: f.scope(), name, ...(settings === undefined ? {} : { settings }) });
  await create('Third');
  let item = f.root().profiles.at(-1);
  assert.match(item.id, /^[0-9a-f-]{36}$/);
  assert.equal(item.settings.sshAlias, 'usshtc107-3');
  assert.deepEqual(item.secrets, { ssoUsername: '', ssoPassword: '', savedCookieEncrypted: '' });
  assert.deepEqual(item.onboarding, { status: 'new', step: 'login' });
  await f.app.run('delete-profile', { scope: f.scope(), id: f.targetId });
  await create('  Reused  ');
  item = f.root().profiles.at(-1);
  assert.equal(item.name, 'Reused');
  assert.equal(item.settings.sshAlias, 'usshtc107-2');
  await assert.rejects(create('Conflict', { sshAlias: 'USSHTC107' }), { code: 'PROFILE_ALIAS_CONFLICT' });
  for (const name of ['', 'bad\nname', 'x'.repeat(65)]) await assert.rejects(create(name), { code: 'PROFILE_NAME_INVALID' });
  await assert.rejects(create('Secrets', { secrets: { savedCookieEncrypted: 'copy' } }), { code: 'VALIDATION_FAILED' });
  await assert.rejects(create('Invalid', null), { code: 'VALIDATION_FAILED' });
  while (f.root().profiles.length < 8) await create(`Profile ${f.root().profiles.length}`);
  await assert.rejects(create('Ninth'), { code: 'PROFILE_LIMIT' });
  const dto = f.app.getProfiles();
  assert.equal(JSON.stringify(dto).includes('alice'), false);
  assert.equal(JSON.stringify(dto).includes('ssoPassword'), false);
  assert.equal(JSON.stringify(dto).includes('secrets'), false);
  f.login.dispose();
});

test('profile activation stops and fully clears before committing then starts only with target credentials', async () => {
  const f = fixture();
  const old = f.scope();
  const aCookie = f.root().profiles[0].secrets.savedCookieEncrypted;
  const result = await f.activate();
  assert.equal(result.consumedDraftRevision, 0);
  assert.equal(f.scope().profileId, f.targetId);
  assert.ok(f.scope().epoch > old.epoch);
  assert.deepEqual(f.calls.filter(([kind]) => ['stop', 'clearData', 'clearCache', 'clearAuthCache', 'closeAllConnections', 'save', 'start'].includes(kind)), [
    ['stop'], ['clearData'], ['clearCache'], ['clearAuthCache'], ['closeAllConnections'], ['save', f.targetId], ['start', f.targetId, 4000, 'SCOW_USER=B'],
  ]);
  assert.equal(f.root().profiles[0].secrets.savedCookieEncrypted, aCookie);
  assert.deepEqual(f.app.getCredentials(f.scope()), { profileId: f.targetId, username: 'bob', hasPassword: true, storageAvailable: true });
  f.callbacks.onAuthenticated({ scope: old, authGeneration: 1, cookie: 'SCOW_USER=A' });
  f.callbacks.onProxyState({ ...old, proxyStatus: 'started', runningConfig: { port: 9999 } });
  await turn();
  assert.equal(f.app.getSnapshot().runningConfig.port, 4000);
  for (const action of ['start', 'stop', 'login', 'save-settings', 'activate-profile']) {
    await assert.rejects(f.app.run(action, { scope: old, ...(action === 'save-settings' ? { patch: {} } : {}),
      ...(action === 'activate-profile' ? { id: 'default' } : {}) }), { code: 'PROFILE_CHANGED' });
  }
  assert.throws(() => f.app.getCredentials(old), { code: 'PROFILE_CHANGED' });
  f.login.dispose();
});

test('partition and stop failures never commit the target or start another listener', async () => {
  for (const failure of ['stop', 'clearData', 'clearCache', 'clearAuthCache', 'closeAllConnections']) {
    const f = fixture();
    if (failure === 'stop') f.setStopFailure(true); else f.setClearFailure(failure);
    await assert.rejects(f.activate(), { code: failure === 'stop' ? 'PROXY_STOP_FAILED' : 'LOGIN_RESET_FAILED' });
    assert.equal(f.scope().profileId, 'default');
    assert.equal(f.root().activeProfileId, 'default');
    assert.equal(f.app.getSnapshot().cookieValid, false);
    assert.equal(f.calls.some(([kind]) => kind === 'save' || kind === 'start'), false);
    f.partition.cookies.emit('changed', {}, { domain: PLATFORM.domain }, 'expired');
    assert.equal(f.queries.length, 0);
    f.login.dispose();
  }
});

test('atomic commit outcomes preserve actual selection and durability locks prevent all new authority', async () => {
  for (const result of [
    { state: 'not_committed', durable: false, errorCode: 'SETTINGS_SAVE_FAILED' },
    { state: 'committed', durable: false, errorCode: 'SETTINGS_DURABILITY_UNCERTAIN' },
    { state: 'unknown', durable: false, errorCode: 'SETTINGS_COMMIT_UNKNOWN' },
  ]) {
    const f = fixture();
    f.setWriteResult(result);
    await assert.rejects(f.activate(), { code: result.errorCode });
    assert.equal(f.scope().profileId, result.state === 'committed' ? f.targetId : 'default');
    assert.equal(f.app.getSnapshot().cookieValid, false);
    assert.equal(f.calls.some(([kind]) => kind === 'start'), false);
    if (result.state !== 'not_committed') {
      assert.equal(f.app.getSnapshot().storageErrorCode, result.errorCode);
      for (const action of ['start', 'login', 'create-profile', 'save-settings']) {
        await assert.rejects(f.app.run(action, { scope: f.scope(), ...(action === 'create-profile' ? { name: 'Blocked' } : {}),
          ...(action === 'save-settings' ? { patch: {} } : {}) }), { code: 'SETTINGS_LOCKED' });
      }
      assert.equal(f.app.getCredentials(f.scope()).username, '');
      f.setWriteResult(null);
      await f.app.run('retry-load', { scope: f.scope() });
      assert.equal(f.app.getSnapshot().storageErrorCode, null);
      assert.equal(f.app.getCredentials(f.scope()).username, result.state === 'committed' ? 'bob' : 'alice');
    }
    f.login.dispose();
  }
});

test('saving profile/app patches stays disjoint and username changes clear cookie before committing while preserving blank passwords', async () => {
  const f = fixture();
  for (const patch of [{ theme: 'light' }, { launchAtLogin: true }, { savedCookieEncrypted: 'x' }]) {
    await assert.rejects(f.app.run('save-settings', { scope: f.scope(), patch }), { code: 'VALIDATION_FAILED' });
  }
  await assert.rejects(f.app.run('save-app-settings', { scope: f.scope(), patch: { launchAtLogin: true } }), { code: 'VALIDATION_FAILED' });
  await f.app.run('save-app-settings', { scope: f.scope(), patch: { theme: 'light', reconnectOnResume: false } });
  await f.app.run('save-settings', { scope: f.scope(), patch: { port: 3333 } });
  assert.equal(f.root().app.theme, 'light');
  assert.equal(f.root().app.reconnectOnResume, false);
  assert.equal(f.root().profiles[1].settings.port, 4000);
  const oldPassword = f.root().profiles[0].secrets.ssoPassword;
  f.calls.length = 0;
  await f.app.run('save-credentials', { scope: f.scope(), username: 'carol', password: '' });
  const names = f.calls.map(([name]) => name);
  assert.ok(names.indexOf('stop') < names.indexOf('clearData'));
  assert.ok(names.indexOf('closeAllConnections') < names.lastIndexOf('save'));
  assert.equal(f.root().profiles[0].secrets.savedCookieEncrypted, '');
  assert.equal(f.root().profiles[0].secrets.ssoPassword, oldPassword);
  assert.equal(f.root().profiles[0].secrets.ssoUsername, 'carol');
  assert.equal(f.root().profiles[1].secrets.ssoUsername, 'bob');
  assert.equal(f.app.getSnapshot().cookieValid, false);
  f.login.dispose();
});

test('account changes cannot commit a username when persistent cookie removal fails', async () => {
  const f = fixture();
  f.setWriteResult({ state: 'not_committed', durable: false, errorCode: 'SETTINGS_SAVE_FAILED' });
  await assert.rejects(f.app.run('save-credentials', { scope: f.scope(), username: 'carol', password: '' }), { code: 'AUTH_PERSIST_FAILED' });
  assert.equal(f.root().profiles[0].secrets.ssoUsername, 'alice');
  assert.equal(f.credentials('default').getCookie(), '');
  assert.ok(f.calls.some(([name]) => name === 'closeAllConnections'));
  f.setWriteResult(null);
  await f.activate();
  await f.app.run('activate-profile', { scope: f.scope(), id: 'default' });
  assert.equal(f.login.getCookie(), '');
  assert.equal(f.app.getSnapshot().cookieValid, false);
  assert.equal(f.calls.filter(([name]) => name === 'start').every((entry) => entry[1] === f.targetId), true);
  f.login.dispose();
});

test('active deletion switches before removing the old profile and the final profile cannot be deleted', async () => {
  const f = fixture();
  await f.app.run('delete-profile', { scope: f.scope(), id: 'default' });
  assert.equal(f.scope().profileId, f.targetId);
  assert.equal(f.root().profiles.length, 1);
  assert.deepEqual(f.calls.filter(([name]) => name === 'save'), [['save', f.targetId], ['save', f.targetId]]);
  assert.equal(f.calls.at(-1)[0], 'start');
  await assert.rejects(f.app.run('delete-profile', { scope: f.scope(), id: f.targetId }), { code: 'PROFILE_LAST' });
  f.login.dispose();
});

test('cancelled or changed-draft profile confirmations leave credentials, selection and listeners untouched', async () => {
  const confirmation = deferred();
  const f = fixture({ confirm: () => confirmation.promise });
  await f.app.run('set-dirty', { scope: f.scope(), dirty: true, draftRevision: 2 });
  const switching = f.activate();
  await turn();
  await f.app.run('set-dirty', { scope: f.scope(), dirty: true, draftRevision: 3 });
  confirmation.resolve(true);
  await assert.rejects(switching, { code: 'DRAFT_CHANGED' });
  assert.equal(f.root().activeProfileId, 'default');
  assert.equal(f.calls.some(([name]) => name === 'stop' || name === 'save'), false);
  assert.equal(f.login.getCookie(), 'SCOW_USER=A');
  f.login.dispose();
  const cancelled = fixture({ confirm: async () => false });
  await cancelled.app.run('set-dirty', { scope: cancelled.scope(), dirty: true, draftRevision: 1 });
  assert.deepEqual(await cancelled.activate(), { cancelled: true });
  assert.equal(cancelled.login.getCookie(), 'SCOW_USER=A');
  cancelled.login.dispose();
});

test('fatal exit aborts a profile switch before any target commit after a pending stop', async () => {
  const gate = deferred();
  const f = fixture({ stopGate: gate });
  const switching = f.activate();
  await turn();
  const quitting = f.app.prepareExit('fatal');
  gate.resolve();
  assert.deepEqual(await switching, { cancelled: true });
  await quitting;
  assert.equal(f.root().activeProfileId, 'default');
  assert.equal(f.calls.some(([name]) => name === 'save' || name === 'start'), false);
});

test('same target reuses only the exact origin-scoped request while conflicting targets are rejected', async () => {
  const gate = deferred();
  const f = fixture({ stopGate: gate });
  const origin = f.scope();
  const switching = f.app.run('activate-profile', { scope: origin, id: f.targetId });
  await turn();
  assert.equal(f.app.run('activate-profile', { id: f.targetId, scope: { ...origin } }), switching);
  await assert.rejects(f.app.run('activate-profile', { scope: f.scope(), id: 'default' }), { code: 'OPERATION_IN_PROGRESS' });
  gate.resolve();
  await switching;
  f.login.dispose();
});

test('restored B cookie never gives browser ownership and stale A queries/debounce cannot overwrite B', async () => {
  const f = fixture();
  await f.app.run('login', { scope: f.scope() });
  const oldWindow = f.windows[0];
  oldWindow.webContents.url = `${PLATFORM.origin}/shell/training/node`;
  oldWindow.webContents.emit('did-navigate', {}, oldWindow.webContents.url);
  f.partition.cookies.emit('changed', {}, { domain: PLATFORM.domain }, 'explicit');
  const lateTimers = [...f.timers.values()];
  await f.activate();
  const queryCountAfterSwitch = f.queries.length;
  for (const query of f.queries) query.resolve([{ name: 'SCOW_USER', value: 'A-late' }]);
  for (const callback of lateTimers) callback();
  f.partition.cookies.emit('changed', {}, { domain: PLATFORM.domain }, 'expired');
  await turn();
  assert.equal(oldWindow.destroyed, true);
  assert.equal(f.login.getCookie(), 'SCOW_USER=B');
  assert.equal(f.partition.cookies.listenerCount('changed'), 1);
  assert.equal(f.root().profiles[1].secrets.savedCookieEncrypted, encrypted('SCOW_USER=B'));
  assert.equal(f.queries.length, queryCountAfterSwitch);
  f.login.dispose();
});

test('corrupt recovery asks native confirmation before overwrite and locked DTO remains secret-free', async () => {
  const f = fixture({ locked: 'SETTINGS_RECOVERY_REQUIRED', confirm: async () => false });
  assert.equal(f.app.getSnapshot().storageErrorCode, 'SETTINGS_RECOVERY_REQUIRED');
  assert.equal(f.app.getSnapshot().cookieValid, false);
  assert.deepEqual(f.app.getCredentials(f.scope()), { profileId: 'default', username: '', hasPassword: false, storageAvailable: false });
  assert.deepEqual(await f.app.run('retry-load', { scope: f.scope() }), { cancelled: true });
  assert.equal(f.calls.some(([name]) => name === 'retry-load' || name === 'save'), false);
  f.login.dispose();
  const accepted = fixture({ locked: 'SETTINGS_RECOVERY_REQUIRED' });
  await accepted.app.run('retry-load', { scope: accepted.scope() });
  assert.deepEqual(accepted.calls.find(([name]) => name === 'retry-load'), ['retry-load', true]);
  assert.equal(accepted.app.getSnapshot().storageErrorCode, null);
  accepted.login.dispose();
});

test('target bind failure retains committed target for explicit Retry without falling back to A', async () => {
  const f = fixture();
  f.setBindFailure(true);
  await assert.rejects(f.activate(), { code: 'PROXY_START_FAILED' });
  assert.equal(f.root().activeProfileId, f.targetId);
  assert.equal(f.scope().profileId, f.targetId);
  assert.equal(f.app.getSnapshot().errorCode, 'PROXY_START_FAILED');
  assert.equal(f.calls.filter(([name]) => name === 'start').every((entry) => entry[3] === 'SCOW_USER=B'), true);
  f.login.dispose();
});

test('history clearing waits for stop and consumes only the confirmed draft revision', async () => {
  const gate = deferred();
  const f = fixture({ stopGate: gate });
  await f.app.run('set-dirty', { scope: f.scope(), dirty: true, draftRevision: 4 });
  const clearing = f.app.run('clear-history', { scope: f.scope() });
  await turn();
  assert.equal(f.calls.some(([kind]) => kind === 'stop'), true);
  assert.equal(f.calls.some(([kind]) => kind === 'history-clear'), false);
  gate.resolve();
  const result = await clearing;
  assert.equal(result.consumedDraftRevision, 4);
  assert.equal(f.app.getSnapshot().desiredRunning, false);
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'history-clear'), [['history-clear', 'default']]);
  f.login.dispose();
});

test('cancelled history clearing and failed stop never erase history', async () => {
  const cancelled = fixture({ confirm: async () => false });
  assert.deepEqual(await cancelled.app.run('clear-history', { scope: cancelled.scope() }), { cancelled: true });
  assert.equal(cancelled.calls.some(([kind]) => kind === 'stop' || kind === 'history-clear'), false);
  cancelled.login.dispose();
  const failed = fixture();
  failed.setStopFailure(true);
  await assert.rejects(failed.app.run('clear-history', { scope: failed.scope() }), { code: 'PROXY_STOP_FAILED' });
  assert.equal(failed.calls.some(([kind]) => kind === 'history-clear'), false);
  failed.login.dispose();
});

test('history failure after profile deletion does not fabricate a settings rollback or stop the other profile', async () => {
  const f = fixture({ historyFailure: true });
  f.callbacks.onProxyState({ ...f.scope(), proxyStatus: 'started', runningConfig: f.root().profiles[0].settings });
  await assert.rejects(f.app.run('delete-profile', { scope: f.scope(), id: f.targetId }), { code: 'HISTORY_STORAGE_FAILED' });
  assert.equal(f.root().profiles.some((item) => item.id === f.targetId), false);
  assert.equal(f.app.getSnapshot().profileId, 'default');
  assert.equal(f.app.getSnapshot().proxyStatus, 'started');
  assert.equal(f.calls.some(([kind]) => kind === 'stop'), false);
  f.login.dispose();
});
