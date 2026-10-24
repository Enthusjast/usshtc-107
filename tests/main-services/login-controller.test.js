'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createLoginController } = require('../../electron/login-controller');
const { PLATFORM } = require('../../electron/constants');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
class Window extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.destroyed = false;
    this.webContents = new EventEmitter();
    this.webContents.url = PLATFORM.url;
    this.webContents.getURL = () => this.webContents.url;
    this.webContents.setWindowOpenHandler = (handler) => { this.popup = handler; };
    this.webContents.executeJavaScript = async () => false;
    this.navigation = deferred();
  }
  loadURL(url) { this.loaded = url; return this.navigation.promise; }
  isDestroyed() { return this.destroyed; }
  focus() { this.focused = true; }
  destroy() { this.destroyed = true; this.emit('closed'); }
  close() { this.destroy(); }
}
function fixture(options = {}) {
  const cookies = new EventEmitter();
  const requests = [];
  cookies.get = () => { const query = deferred(); requests.push(query); return query.promise; };
  const partition = new EventEmitter();
  const cleared = [];
  partition.cookies = cookies;
  partition.setPermissionCheckHandler = (fn) => { partition.permissionCheck = fn; };
  partition.setPermissionRequestHandler = (fn) => { partition.permissionRequest = fn; };
  for (const method of ['clearData', 'clearCache', 'clearAuthCache', 'closeAllConnections']) {
    partition[method] = async () => { cleared.push(method); if (options.failClear?.() === method) throw new Error('clear failed'); };
  }
  let timerId = 0;
  const timers = new Map();
  const clock = {
    setInterval: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearInterval: (id) => timers.delete(id),
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  const windows = [], states = [], authenticated = [], revoked = [];
  const credentials = { getCookie: () => options.savedCookie || '', getSsoPassword: () => '',
    getSsoStatus: () => ({ username: 'fixture' }), clearCookie: () => { cleared.push('credential-cookie'); } };
  const controller = createLoginController({ clock,
    getSession: () => partition,
    createWindow: (value) => { const window = new Window(value); windows.push(window); return window; },
    getWindow: () => null, getConfig: () => ({ cluster: 'training', loginNode: 'node' }),
    onState: (value) => states.push(value),
    onAuthenticated: (value) => authenticated.push(value),
    onAuthRequired: (value) => revoked.push(value),
  });
  const scope = { profileId: 'default', epoch: 0 };
  controller.setProfile(scope, credentials);
  return { controller, partition, cookies, credentials, windows, states, authenticated, revoked,
    timers, requests, cleared, scope };
}
function navigate(window, url = `${PLATFORM.origin}/shell/training/node`) {
  window.webContents.url = url;
  window.webContents.emit('did-navigate', {}, url);
}

test('start releases immediately after starting navigation, with isolated secure session/window', async () => {
  const f = fixture();
  await f.controller.start();
  assert.equal(f.windows.length, 1);
  assert.equal(f.windows[0].loaded, PLATFORM.url);
  assert.equal(f.states.at(-1).loginStage, 'opening');
  assert.equal(f.windows[0].options.webPreferences.partition, 'persist:usshtc107-auth');
  assert.equal(f.windows[0].options.webPreferences.sandbox, true);
  assert.equal(f.partition.permissionCheck(), false);
  let permission;
  f.partition.permissionRequest(null, null, (value) => { permission = value; });
  assert.equal(permission, false);
  let prevented = false;
  f.partition.emit('will-download', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(await f.controller.start(), { alreadyOpen: true });
  assert.equal(f.windows[0].focused, true);
  f.controller.dispose();
  assert.equal(f.timers.size, 0);
});

test('login finalization captures source scope/generation and closes without awaiting connection', async () => {
  const f = fixture();
  await f.controller.start();
  const window = f.windows[0];
  navigate(window);
  f.requests[0].resolve([{ name: 'SCOW_USER', value: 'one' }]);
  await turn();
  assert.equal(f.controller.getCookie(), 'SCOW_USER=one');
  assert.equal(f.authenticated.length, 1);
  assert.deepEqual(f.authenticated[0].scope, f.scope);
  assert.equal(f.authenticated[0].authGeneration, f.states.at(-1).authGeneration);
  assert.equal(window.destroyed, true);
  assert.equal(f.states.at(-1).loginStatus, 'success');
  f.controller.dispose();
});

test('same-profile epoch changes cancel old queries without changing browser owner/auth generation', async () => {
  const f = fixture();
  await f.controller.start();
  navigate(f.windows[0]);
  const generation = f.states.at(-1).authGeneration;
  f.controller.setScope({ profileId: 'default', epoch: 1 });
  assert.equal(f.requests.length, 2);
  f.requests[0].resolve([{ name: 'SCOW_USER', value: 'old' }]);
  await turn();
  assert.equal(f.authenticated.length, 0);
  f.requests[1].resolve([{ name: 'SCOW_USER', value: 'new' }]);
  await turn();
  assert.equal(f.authenticated.length, 1);
  assert.equal(f.authenticated[0].scope.epoch, 1);
  assert.equal(f.authenticated[0].authGeneration, generation);
  f.controller.dispose();
});

test('query revisions reject an older query even within one scope and owner', async () => {
  const f = fixture();
  await f.controller.start();
  navigate(f.windows[0]);
  navigate(f.windows[0]);
  f.requests[1].resolve([{ name: 'SCOW_USER', value: 'new' }]);
  f.requests[0].resolve([{ name: 'SCOW_USER', value: 'old' }]);
  await turn();
  assert.equal(f.controller.getCookie(), 'SCOW_USER=new');
  assert.equal(f.authenticated.length, 1);
  f.controller.dispose();
});

test('profile reset detaches owner before clearing and old callbacks cannot be rebound', async () => {
  const f = fixture();
  await f.controller.start();
  f.cleared.length = 0;
  navigate(f.windows[0]);
  const previousGeneration = f.states.at(-1).authGeneration;
  await f.controller.resetForProfile({ revoke: true });
  assert.deepEqual(f.cleared, ['credential-cookie', 'clearData', 'clearCache', 'clearAuthCache', 'closeAllConnections']);
  f.controller.setProfile({ profileId: 'default', epoch: 2 }, f.credentials);
  f.requests[0].resolve([{ name: 'SCOW_USER', value: 'stale' }]);
  f.cookies.emit('changed', {}, { domain: PLATFORM.domain }, 'expired');
  await turn();
  assert.equal(f.authenticated.length, 0);
  assert.equal(f.controller.getCookie(), '');
  assert.ok(f.states.at(-1).authGeneration > previousGeneration);
  assert.equal(f.cookies.listenerCount('changed'), 1);
  f.controller.dispose();
  assert.equal(f.cookies.listenerCount('changed'), 0);
});

test('restoring persisted cookie never claims the browser partition or queries unrelated cookies', async () => {
  const f = fixture({ savedCookie: 'SCOW_USER=saved' });
  f.controller.setScope({ profileId: 'default', epoch: 1 });
  f.cookies.emit('changed', {}, { domain: PLATFORM.domain }, 'explicit');
  assert.equal(f.controller.getCookie(), 'SCOW_USER=saved');
  assert.equal(f.requests.length, 0);
  assert.equal(f.timers.size, 0);
  f.controller.dispose();
});

test('failed partition cleanup keeps owner empty and retries all cleanup before a new login', async () => {
  let fail = false;
  const f = fixture({ failClear: () => fail ? 'clearCache' : null });
  await f.controller.start();
  f.cleared.length = 0;
  fail = true;
  await assert.rejects(f.controller.resetForProfile(), { code: 'LOGIN_RESET_FAILED' });
  assert.equal(f.states.at(-1).loginStatus, 'failure');
  f.cookies.emit('changed', {}, { domain: PLATFORM.domain }, 'explicit');
  assert.equal(f.timers.size, 0);
  fail = false;
  await f.controller.start();
  assert.equal(f.windows.length, 2);
  assert.equal(f.cleared.filter((name) => name === 'clearData').length, 2);
  f.controller.dispose();
});

test('empty owned cookie query revokes authentication while runtime deactivate preserves persisted cookie', async () => {
  const f = fixture();
  await f.controller.start();
  navigate(f.windows[0]);
  f.requests[0].resolve([{ name: 'SCOW_USER', value: 'one' }]);
  await turn();
  f.cookies.emit('changed', {}, { domain: PLATFORM.domain }, 'expired');
  const [timerId, timer] = [...f.timers].find(([, value]) => value.delay === 250);
  f.timers.delete(timerId);
  timer.fn();
  f.requests[1].resolve([]);
  await turn();
  assert.equal(f.controller.getCookie(), '');
  assert.equal(f.revoked.length, 1);
  assert.equal(f.states.at(-1).cookieValid, false);
  assert.ok(f.cleared.includes('credential-cookie'));
  f.controller.dispose();
  const saved = fixture({ savedCookie: 'SCOW_USER=persisted' });
  await saved.controller.resetForProfile();
  assert.equal(saved.cleared.includes('credential-cookie'), false);
  saved.controller.dispose();
});

test('login stage distinguishes platform SSO, shell completion and a return to authentication', async () => {
  const f = fixture();
  await f.controller.start();
  const window = f.windows[0];
  navigate(window, `${PLATFORM.origin}/dashboard`);
  f.requests[0].resolve([{ name: 'SCOW_USER', value: 'one' }]);
  await turn();
  assert.equal(f.states.at(-1).loginStatus, 'sso_done');
  assert.equal(f.states.at(-1).loginStage, 'shell');
  navigate(window, `${PLATFORM.origin}/auth`);
  f.requests[1].resolve([]);
  await turn();
  assert.equal(f.states.at(-1).loginStatus, 'pending');
  assert.equal(f.states.at(-1).loginStage, 'sso');
  window.webContents.url = 'https://id.ustc.edu.cn/cas/login';
  window.webContents.emit('did-finish-load');
  assert.equal(f.states.at(-1).loginStage, 'sso');
  f.controller.dispose();
});

test('window navigation and popup guards reject untrusted origins without opening new windows', async () => {
  const f = fixture();
  await f.controller.start();
  const window = f.windows[0];
  let blocked = 0;
  for (const event of ['will-navigate', 'will-redirect']) {
    window.webContents.emit(event, { preventDefault: () => { blocked += 1; } }, 'https://attacker.example');
  }
  window.webContents.emit('will-attach-webview', { preventDefault: () => { blocked += 1; } });
  assert.equal(blocked, 3);
  assert.equal(window.popup({ url: 'https://attacker.example' }).action, 'deny');
  assert.equal(window.loaded, PLATFORM.url);
  assert.equal(window.popup({ url: 'https://id.ustc.edu.cn/cas/login' }).action, 'deny');
  assert.equal(window.loaded, 'https://id.ustc.edu.cn/cas/login');
  f.controller.dispose();
});

test('navigation failures retain a visible failure stage and close their owned login window', async () => {
  const f = fixture();
  await f.controller.start();
  f.windows[0].navigation.reject(new Error('local fixture navigation failure'));
  await turn();
  assert.equal(f.states.at(-1).loginStatus, 'failure');
  assert.equal(f.windows[0].destroyed, true);
  assert.equal(f.timers.size, 0);
  f.controller.dispose();
});

test('aborted starts and reset tokens cannot create a window or continue partition side effects', async () => {
  const f = fixture();
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(f.controller.start({ signal: aborted.signal }), { code: 'OPERATION_CANCELLED' });
  assert.equal(f.windows.length, 0);
  let checks = 0;
  await assert.rejects(f.controller.resetForProfile({ assertCurrent: () => {
    checks += 1;
    if (checks > 1) throw Object.assign(new Error('cancelled'), { code: 'OPERATION_CANCELLED' });
  } }), { code: 'OPERATION_CANCELLED' });
  assert.deepEqual(f.cleared, ['clearData']);
  await f.controller.start();
  assert.equal(f.windows.length, 1);
  assert.ok(f.cleared.includes('closeAllConnections'));
  f.controller.dispose();
  await assert.rejects(f.controller.start(), { code: 'OPERATION_CANCELLED' });
  assert.equal(f.controller.getCookie(), '');
});
