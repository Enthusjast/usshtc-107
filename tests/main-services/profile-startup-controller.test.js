'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createDefaultRoot } = require('../../electron/settings-store');
const { startApplication } = require('../../electron/main');

const fingerprint = `SHA256:${'a'.repeat(43)}`;
const hostFingerprint = `SHA256:${'b'.repeat(43)}`;
const safeStorage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() };

async function fixture(t, document, { missingKeys = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc107-profile-startup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const settingsPath = path.join(directory, 'settings.json');
  const original = typeof document === 'string' ? document : JSON.stringify(document);
  fs.writeFileSync(settingsPath, original, { mode: 0o600 });
  const handlers = new Map(), timers = new Map(), calls = [];
  const app = new EventEmitter();
  app.commandLine = { hasSwitch: () => true, getSwitchValue: () => directory };
  app.setPath = () => {};
  app.setAppLogsPath = () => {};
  app.requestSingleInstanceLock = () => true;
  app.whenReady = async () => {};
  app.isPackaged = true;
  app.getVersion = () => '1.2.1';
  app.getAppPath = () => path.join(directory, 'app.asar');
  app.exit = (code) => calls.push(['exit', code]);
  app.quit = () => calls.push(['quit']);
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: '' };
      this.webContents.send = () => {};
      this.webContents.setWindowOpenHandler = () => {};
    }
    async loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
    isDestroyed() { return this.destroyed; }
    show() {}
    hide() {}
    focus() {}
    isMinimized() { return false; }
    destroy() { this.destroyed = true; }
  }
  class Tray extends EventEmitter {
    setToolTip() {}
    setImage() {}
    setContextMenu() {}
    destroy() {}
  }
  const partition = new EventEmitter();
  partition.cookies = new EventEmitter();
  partition.cookies.get = async () => [];
  partition.setPermissionCheckHandler = () => {};
  partition.setPermissionRequestHandler = () => {};
  for (const method of ['clearData', 'clearCache', 'clearAuthCache', 'closeAllConnections']) partition[method] = async () => calls.push([method]);
  const electron = { app, BrowserWindow: Window, Tray,
    session: { fromPartition: () => { calls.push(['partition']); return partition; } },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) },
    clipboard: { writeText: () => {} }, shell: { openExternal: async () => {} },
    dialog: { showMessageBox: async () => ({ response: 1 }) }, safeStorage,
    Menu: { buildFromTemplate: (value) => value }, nativeImage: { createFromBuffer: (value) => value },
    Notification: { isSupported: () => false } };
  let timerId = 0;
  const clock = { setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id), setInterval: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    clearInterval: (id) => timers.delete(id) };
  const inspectKeys = () => ({ scope: 'application', recoveryRequired: missingKeys,
    client: { state: missingKeys ? 'missing' : 'ready', fingerprint: missingKeys ? null : fingerprint,
      publicKey: `ssh-ed25519 ${Buffer.alloc(51).toString('base64')} fixture`,
      privateKeyPath: path.join(directory, 'ssh', 'usshtc107_ed25519'),
      ...(missingKeys ? { errorCode: 'SSH_KEY_MISSING' } : {}) },
    host: { state: missingKeys ? 'missing' : 'ready', fingerprint: missingKeys ? null : hostFingerprint,
      privateKeyPath: path.join(directory, 'proxy_host_ed25519'),
      ...(missingKeys ? { errorCode: 'SSH_KEY_MISSING' } : {}) } });
  const assertKeys = () => {
    if (missingKeys) throw Object.assign(new Error('SSH_KEY_MISSING'), { code: 'SSH_KEY_MISSING' });
    return inspectKeys();
  };
  const application = startApplication({ electron, clock, process: new EventEmitter(), sshDirectory: path.join(directory, 'ssh'),
    portalPreflight: { validate: async () => ({ status: 'valid' }), setup: async () => ({ ok: true }), run: async () => ({ ok: true }) },
    log: { info() {}, warn() {}, error() {} },
    sshKeyService: { inspect: inspectKeys, initialize: assertKeys, recover: () => {}, assertReady: assertKeys,
      getKeyMaterial: () => { assertKeys(); throw new Error('unexpected key material request'); } },
    createProxyServer: () => { calls.push(['server']); throw new Error('unexpected listener'); } });
  await application.ready;
  t.after(() => application.dispose());
  const event = () => ({ sender: application.getWindow().webContents, senderFrame: application.getWindow().webContents.mainFrame });
  const invoke = (channel, ...args) => handlers.get(channel)(event(), ...args);
  const scope = async () => { const { profileId, epoch } = (await invoke('status:get')).value; return { profileId, epoch }; };
  return { application, handlers, invoke, scope, directory, settingsPath, original, calls, timers };
}

test('future or invalid roots still create a safe window and block writes/login/listeners without overwriting source', async (t) => {
  for (const document of [{ schemaVersion: 3, secret: 'keep-original' }, { schemaVersion: 2, profiles: [] }]) {
    const f = await fixture(t, document);
    const status = (await f.invoke('status:get')).value;
    assert.equal(status.proxyStatus, 'stopped');
    assert.equal(status.cookieValid, false);
    assert.equal(typeof status.storageErrorCode, 'string');
    assert.equal(f.application.getWindow().options.webPreferences.sandbox, true);
    const scope = await f.scope();
    assert.deepEqual((await f.invoke('sso:get-credentials', scope)).value,
      { profileId: 'default', username: '', hasPassword: false, storageAvailable: false });
    assert.equal(JSON.stringify((await f.invoke('profiles:get')).value).includes('secret'), false);
    for (const [channel, payload] of [['proxy:start', scope], ['login:start', scope],
      ['settings:save', { scope, patch: { port: 3333 } }], ['settings:save-app', { theme: 'light' }]]) {
      assert.deepEqual(await f.invoke(channel, payload), { ok: false, error: { code: 'SETTINGS_LOCKED' } });
    }
    assert.equal(f.calls.some(([name]) => ['server', 'generate-client', 'generate-host', 'partition'].includes(name)), false);
    assert.equal(fs.readFileSync(f.settingsPath, 'utf8'), f.original);
  }
});

test('retry-load unlocks only corrected valid source and rejects stale scopes afterward', async (t) => {
  const f = await fixture(t, { schemaVersion: 4 });
  const oldScope = await f.scope();
  const root = createDefaultRoot({ autoConnect: false });
  root.keys = { initialized: true, clientFingerprint: fingerprint, hostFingerprint };
  root.profiles[0].secrets.ssoUsername = 'corrected-account';
  fs.writeFileSync(f.settingsPath, JSON.stringify(root), { mode: 0o600 });
  const retried = await f.invoke('settings:retry-load', oldScope);
  assert.equal(retried.ok, true);
  const scope = await f.scope();
  assert.ok(scope.epoch > oldScope.epoch);
  assert.equal((await f.invoke('status:get')).value.storageErrorCode, null);
  assert.equal((await f.invoke('sso:get-credentials', scope)).value.username, 'corrected-account');
  assert.deepEqual(await f.invoke('settings:get', oldScope), { ok: false, error: { code: 'PROFILE_CHANGED' } });
  assert.equal(f.calls.some(([name]) => name === 'server'), false);
});

test('existing legacy identities are recorded by inspection without regenerating missing keys', async (t) => {
  const f = await fixture(t, { autoConnect: false, savedCookie: 'SCOW_USER=legacy', sshPublicKey: 'cached-existing-key' }, { missingKeys: true });
  const document = JSON.parse(fs.readFileSync(f.settingsPath, 'utf8'));
  assert.equal(document.schemaVersion, 2);
  assert.equal(document.activeProfileId, 'default');
  assert.equal(document.keys.initialized, true);
  assert.equal(document.keys.clientFingerprint, null);
  assert.equal(Object.hasOwn(document, 'savedCookie'), false);
  assert.equal(Object.hasOwn(document, 'sshPublicKey'), false);
  assert.equal(document.profiles[0].onboarding.status, 'dismissed');
  assert.equal((await f.invoke('status:get')).value.errorCode, 'SSH_KEY_MISSING');
  assert.equal(f.calls.some(([name]) => name === 'generate-client' || name === 'generate-host'), false);
  assert.deepEqual(await f.invoke('proxy:start', await f.scope()), { ok: false, error: { code: 'SSH_KEY_MISSING' } });
});

test('profile IPC is fixed, scoped and public; arbitrary roots and stale changes cannot cross the boundary', async (t) => {
  const root = createDefaultRoot({ autoConnect: false });
  root.keys = { initialized: true, clientFingerprint: fingerprint, hostFingerprint };
  const f = await fixture(t, root);
  const scope = await f.scope();
  const created = await f.invoke('profiles:create', { scope, name: 'Second', settings: { port: 4000 } });
  assert.equal(created.ok, true);
  const profile = created.value.profiles[1];
  assert.equal(profile.settings.sshAlias, 'usshtc107-2');
  assert.equal(Object.hasOwn(profile, 'secrets'), false);
  const renamed = await f.invoke('profiles:rename', { scope, id: profile.id, name: 'Renamed' });
  assert.equal(renamed.value.profiles[1].name, 'Renamed');
  assert.deepEqual(await f.invoke('settings:save', { scope, patch: { locale: 'zh' } }),
    { ok: false, error: { code: 'VALIDATION_FAILED', fieldErrors: { locale: 'unknown_key' } } });
  assert.deepEqual(await f.invoke('settings:save-app', { launchAtLogin: true }),
    { ok: false, error: { code: 'VALIDATION_FAILED', fieldErrors: { launchAtLogin: 'unknown_key' } } });
  assert.deepEqual(await f.invoke('profiles:create', { scope, name: 'Secret copy', secrets: root.profiles[0].secrets }),
    { ok: false, error: { code: 'INVALID_ARGUMENT' } });
  const untrusted = await f.handlers.get('profiles:get')({ sender: {}, senderFrame: {} });
  assert.deepEqual(untrusted, { ok: false, error: { code: 'INTERNAL_ERROR' } });
});
