'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createUpdateService } = require('../../electron/update-service');
const security = require('../../electron/update-security');
const { ServiceError } = require('../../electron/ipc-contract');

const VERSION = '1.3.0';
const request = { version: VERSION };
const flush = async () => { for (let index = 0; index < 40; index += 1) await Promise.resolve(); };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fakeClock() {
  let time = 0, sequence = 0;
  const timers = new Map();
  return {
    now: () => time, timers,
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { at: time + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async tick(ms) {
      await flush();
      const target = time + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, value]) => value.at <= target);
        if (!next) break;
        timers.delete(next[0]); time = next[1].at; next[1].fn(); await flush();
      }
      time = target; await flush();
    },
  };
}
function fixture(t, options = {}) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc-update-')));
  const platform = options.platform || 'win32';
  const mounted = path.join(directory, options.appImage ? 'mount' : 'installed');
  const resourcesPath = path.join(mounted, 'resources');
  fs.mkdirSync(resourcesPath, { recursive: true });
  const appPath = path.join(resourcesPath, 'app.asar');
  fs.writeFileSync(appPath, 'fixture packaged app');
  const configPath = path.join(resourcesPath, 'app-update.yml');
  fs.writeFileSync(configPath, 'publisherName:\n  - Fixture Publisher\nupdaterCacheDirName: fixture-cache\n');
  if (options.deb) fs.writeFileSync(path.join(resourcesPath, 'package-type'), 'deb');
  const executablePath = options.executablePath || path.join(mounted, 'usshtc107');
  if (!options.executablePath) fs.writeFileSync(executablePath, 'fixture executable');
  const env = { SystemRoot: 'C:\\Windows' };
  let oldImage;
  if (options.appImage) {
    oldImage = path.join(directory, options.customImageName || 'usshtc107-1.2.0-linux-x86_64.AppImage');
    fs.writeFileSync(oldImage, 'running appimage', { mode: options.readOnly ? 0o555 : 0o755 });
    env.APPIMAGE = oldImage;
    env.APPDIR = mounted;
  }
  if (options.env) Object.assign(env, options.env);
  const bytes = Buffer.from('deterministic fixture installer bytes');
  const asset = `usshtc107-${VERSION}-${platform === 'win32' ? 'win' : platform === 'darwin' ? 'mac' : 'linux'}-${platform === 'linux' ? 'x86_64' : options.assetArch || 'x64'}.${platform === 'win32' ? 'exe' : platform === 'darwin' ? 'zip' : 'AppImage'}`;
  const cache = path.join(directory, 'cache');
  fs.mkdirSync(cache);
  const file = path.join(cache, asset);
  fs.writeFileSync(file, bytes);
  const info = { version: VERSION, files: [{ url: asset, size: bytes.length, sha512: createHash('sha512').update(bytes).digest('base64') }],
    releaseDate: '2026-10-23T10:00:00Z', releaseNotes: '<b>Safe</b> update' };
  const native = new EventEmitter();
  const f = { directory, resourcesPath, configPath, executablePath, env, oldImage, bytes, file, info,
    clock: fakeClock(), native, states: [], logs: [], available: [], external: [], constructors: [],
    checks: 0, downloads: 0, nativeChecks: 0, nativeQuits: 0, installs: [], signatures: [], verifications: [],
    preparations: 0, handoffs: 0, events: [], current: true, cancelled: false,
    checkStarted: deferred(), downloadStarted: deferred(), nativeStarted: deferred(), platformStarted: deferred() };
  f.markerResults = []; f.markerHandoffs = [];
  f.nativeHandoff = () => {
    native.emit('before-quit-for-update');
    f.markerHandoffs.push(f.handoffs);
    const result = f.service.consumeQuitMarker();
    f.markerResults.push(result);
    return result;
  };
  class FixtureUpdater extends EventEmitter {
    constructor(provider) {
      super();
      if (options.constructorError) throw options.constructorError;
      f.provider = provider; f.updater = this; f.constructors.push(new.target.name);
      for (const name of ['downloadedUpdateHelper', 'configOnDisk', 'installerPath']) {
        Object.defineProperty(this, name, { get() { throw new Error(`Private access: ${name}`); } });
      }
      for (const name of ['channel', 'forceDevUpdateConfig']) {
        Object.defineProperty(this, name, { set() { throw new Error(`Forbidden mutation: ${name}`); } });
      }
    }
    checkForUpdates() {
      f.checks += 1; f.checkStarted.resolve();
      return f.checkHook ? f.checkHook() : Promise.resolve({ isUpdateAvailable: !options.current, updateInfo: f.info });
    }
    downloadUpdate(token) {
      f.downloads += 1; f.downloadToken = token; f.downloadStarted.resolve();
      if (f.downloadHook) return f.downloadHook(token);
      this.emit('update-downloaded', { ...f.info, downloadedFile: f.file });
      return Promise.resolve(platform === 'darwin' ? [] : [f.file]);
    }
    quitAndInstall(...args) {
      f.installs.push(args); f.events.push('platform'); f.platformStarted.resolve();
      if (f.installHook) return f.installHook();
      queueMicrotask(() => f.nativeHandoff());
    }
  }
  class NsisUpdater extends FixtureUpdater {}
  class MacUpdater extends FixtureUpdater {}
  class AppImageUpdater extends FixtureUpdater {}
  const classes = { AppUpdater: FixtureUpdater, NsisUpdater, MacUpdater, AppImageUpdater };
  Object.defineProperty(classes, 'autoUpdater', { get() { throw new Error('Singleton forbidden'); } });
  native.checkForUpdates = () => { f.nativeChecks += 1; f.nativeStarted.resolve(); f.nativeCheckHook?.(); };
  native.quitAndInstall = () => {
    f.nativeQuits += 1; f.events.push('native-platform');
    if (f.nativeQuitHook) return f.nativeQuitHook();
    f.nativeHandoff();
  };
  const abort = new AbortController();
  f.abort = abort;
  f.context = {
    signal: abort.signal,
    assertCurrent() { if (!f.current || abort.signal.aborted) throw new ServiceError('OPERATION_CANCELLED'); },
    async prepare() { f.preparations += 1; f.events.push('prepare'); return f.prepareHook ? f.prepareHook() : { cancelled: f.cancelled }; },
    onHandoff() { f.handoffs += 1; f.events.push('handoff'); f.handoffHook?.(); },
  };
  const verifier = {
    ...security,
    async verifyUpdateFile(...args) {
      f.verifications.push(args); f.events.push('verify');
      if (f.verifyHook) return f.verifyHook(...args);
      return security.verifyUpdateFile(...args);
    },
    async verifyWindowsSignature(...args) {
      f.signatures.push(args); f.events.push('signature');
      return f.signatureHook ? f.signatureHook(...args) : null;
    },
  };
  const app = { isPackaged: options.packaged !== false, getVersion: () => '1.2.0',
    getAppPath: () => appPath, whenReady: () => options.ready || Promise.resolve() };
  f.service = createUpdateService({ app, nativeUpdater: native,
    autoCheckUpdates: options.autoCheck === true, clock: f.clock,
    shell: { async openExternal(url) { f.external.push(url); if (f.openHook) return f.openHook(); } },
    onState: value => f.states.push(value), onAvailable: value => f.available.push(value),
    log: (...args) => f.logs.push(args),
    beforeAppImageInstall(candidate, oldPath) {
      f.preflight = { candidate, oldPath }; f.events.push('preflight'); return f.preflightHook?.(candidate, oldPath);
    },
    onAppImageRenamed(value) { f.renamed = value; f.events.push('renamed'); return f.renameHook?.(value); },
    adapters: { platform, arch: 'x64', env, resourcesPath, executablePath,
      updaterClasses: classes, security: verifier, fs: options.fs || fs,
      execFileSync: () => options.rosetta ? '1\n' : '0\n' },
  });
  t.after(() => { f.service.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  f.ready = async () => { await f.service.check(); await f.service.download(request); };
  return f;
}
const rejectCode = (promise, code) => assert.rejects(promise, error => error instanceof ServiceError && error.code === code && error.message === code);
const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof ServiceError && error.code === code);

test('fixed explicit updater configuration never downloads or installs when checking', async t => {
  const f = fixture(t);
  assert.deepEqual(f.constructors, ['NsisUpdater']);
  assert.deepEqual(f.provider, { provider: 'github', owner: 'Enthusjast', repo: 'usshtc-107', private: false,
    protocol: 'https', channel: 'latest', tagNamePrefix: 'v', releaseType: 'release' });
  for (const key of ['autoDownload', 'autoInstallOnAppQuit', 'allowPrerelease', 'allowDowngrade']) assert.equal(f.updater[key], false);
  assert.equal(f.updater.disableWebInstaller, true);
  const state = await f.service.check();
  assert.equal(state.phase, 'available'); assert.equal(state.releaseNotes, 'Safe update');
  assert.equal(state.checkedAt, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(Object.keys(state).sort(), ['phase', 'currentVersion', 'availableVersion', 'releaseDate', 'releaseNotes', 'checkedAt', 'progress', 'installMode', 'errorCode'].sort());
  assert.equal(f.available.length, 1); assert.equal(f.downloads, 0); assert.equal(f.preparations, 0);
  await f.service.check(); assert.equal(f.available.length, 1);
  await f.service.openRelease();
  assert.deepEqual(f.external, ['https://github.com/Enthusjast/usshtc-107/releases/latest']);
});

test('automatic checks wait for readiness and exactly 30s/24h; opt-out and re-enable are live', async t => {
  const ready = deferred();
  const f = fixture(t, { autoCheck: true, ready: ready.promise });
  await f.clock.tick(60000); assert.equal(f.checks, 0); assert.equal(f.clock.timers.size, 0);
  f.service.setAutoCheck(false); f.service.setAutoCheck(true);
  assert.equal(f.clock.timers.size, 0);
  ready.resolve(); await flush();
  await f.clock.tick(29999); assert.equal(f.checks, 0);
  await f.clock.tick(1); assert.equal(f.checks, 1);
  await f.clock.tick(86400000 - 1); assert.equal(f.checks, 1);
  await f.clock.tick(1); assert.equal(f.checks, 2);
  f.service.setAutoCheck(false); assert.equal(f.clock.timers.size, 0);
  await f.clock.tick(2 * 86400000); assert.equal(f.checks, 2);
  await f.service.check(); assert.equal(f.checks, 3);
  f.service.setAutoCheck(true); await f.clock.tick(29999); assert.equal(f.checks, 3);
  await f.clock.tick(1); assert.equal(f.checks, 4);
  f.service.dispose(); assert.equal(f.clock.timers.size, 0);
});

test('disabling during a read-only check does not cancel it or arrange another automatic check', async t => {
  const f = fixture(t, { autoCheck: true });
  const result = deferred(); f.checkHook = () => result.promise;
  await f.clock.tick(30000); assert.equal(f.checks, 1);
  f.service.setAutoCheck(false); assert.equal(f.clock.timers.size, 0);
  result.resolve({ isUpdateAvailable: true, updateInfo: f.info }); await flush();
  assert.equal(f.service.getState().phase, 'available');
  await f.clock.tick(86400000); assert.equal(f.checks, 1);
});

test('exact duplicate actions share the same promise and competing requests fail without replacing candidate', async t => {
  const f = fixture(t), check = deferred();
  f.checkHook = () => check.promise;
  const first = f.service.check(); assert.strictEqual(f.service.check(), first);
  throwsCode(() => f.service.download(request), 'OPERATION_IN_PROGRESS');
  check.resolve({ isUpdateAvailable: true, updateInfo: f.info }); await first;
  const downloaded = deferred();
  f.downloadHook = () => downloaded.promise;
  const download = f.service.download(request);
  assert.strictEqual(f.service.download({ version: VERSION }), download);
  throwsCode(() => f.service.download({ version: '2.0.0' }), 'OPERATION_IN_PROGRESS');
  throwsCode(() => f.service.check(), 'OPERATION_IN_PROGRESS');
  throwsCode(() => f.service.install(request, f.context), 'OPERATION_IN_PROGRESS');
  await f.downloadStarted.promise;
  f.updater.emit('update-downloaded', { ...f.info, downloadedFile: f.file }); downloaded.resolve([f.file]);
  await download;
  throwsCode(() => f.service.check(), 'OPERATION_IN_PROGRESS');
  assert.equal((await f.service.download(request)).phase, 'downloaded'); assert.equal(f.downloads, 1);
  const prepare = deferred(); f.prepareHook = () => prepare.promise;
  const install = f.service.install(request, f.context);
  assert.strictEqual(f.service.install(request, f.context), install);
  throwsCode(() => f.service.install({ version: '2.0.0' }, f.context), 'OPERATION_IN_PROGRESS');
  prepare.resolve({ cancelled: true }); assert.deepEqual(await install, { cancelled: true });
  assert.equal(f.preparations, 1); assert.equal(f.installs.length, 0);
});

test('available version and integrity metadata are rejected at consumer boundaries', async t => {
  for (const [mutate, code] of [
    [info => { info.version = '1.2.0'; }, 'UPDATE_VERSION_REJECTED'],
    [info => { info.version = '1.1.0'; }, 'UPDATE_VERSION_REJECTED'],
    [info => { info.version = '1.3.0-beta.1'; }, 'UPDATE_VERSION_REJECTED'],
    [info => { info.version = 'v1.3.0'; }, 'UPDATE_VERSION_REJECTED'],
    [info => { info.files[0].sha512 = ''; }, 'UPDATE_INVALID_METADATA'],
    [info => { delete info.files[0].sha512; info.files[0].sha2 = 'bad'; }, 'UPDATE_INVALID_METADATA'],
    [info => { info.files[0].url = 'https://evil.invalid/update.exe'; }, 'UPDATE_INVALID_METADATA'],
    [info => { info.files[0].size = 0; }, 'UPDATE_INVALID_METADATA'],
    [info => { info.files.push({ ...info.files[0] }); }, 'UPDATE_INVALID_METADATA'],
  ]) {
    const f = fixture(t); mutate(f.info);
    await rejectCode(f.service.check(), code);
    assert.equal(f.downloads, 0); assert.equal(f.service.getState().availableVersion, null);
    assert.equal(f.service.getState().errorCode, code);
  }
  const current = fixture(t, { current: true }); current.info.version = '1.2.0';
  assert.equal((await current.service.check()).phase, 'current');
  const none = fixture(t); none.checkHook = () => null;
  await rejectCode(none.service.check(), 'UPDATE_NO_RELEASE');
});

test('download identity requires current event metadata, version, canonical named file and public path agreement', async t => {
  const changes = [
    (f, event) => { event.version = '1.4.0'; },
    (f, event) => { event.files = [{ ...f.info.files[0], sha512: createHash('sha512').update('other').digest('base64') }]; },
    (f, event) => { event.downloadedFile = path.join(f.directory, 'unknown.exe'); },
  ];
  for (const change of changes) {
    const f = fixture(t); await f.service.check();
    f.downloadHook = () => { const event = { ...f.info, downloadedFile: f.file }; change(f, event); f.updater.emit('update-downloaded', event); return [f.file]; };
    await rejectCode(f.service.download(request), 'UPDATE_INVALID_METADATA');
    throwsCode(() => f.service.install(request, f.context), 'UPDATE_INVALID_METADATA');
    assert.equal(f.installs.length, 0);
  }
  for (const returned of ['missing-event', 'wrong-array', 'empty-array', 'duplicate-event']) {
    const f = fixture(t); await f.service.check();
    f.downloadHook = () => {
      if (returned !== 'missing-event') f.updater.emit('update-downloaded', { ...f.info, downloadedFile: f.file });
      if (returned === 'duplicate-event') f.updater.emit('update-downloaded', { ...f.info, downloadedFile: f.file });
      return returned === 'wrong-array' ? [f.file, f.file] : returned === 'empty-array' ? [] : [f.file];
    };
    await rejectCode(f.service.download(request), 'UPDATE_INVALID_METADATA');
  }
});

test('new and cached Windows downloads use the same signature verifier callback and explicit local verification', async t => {
  const f = fixture(t); await f.service.check();
  assert.equal(await f.updater.verifyUpdateCodeSignature(['Fixture Publisher'], f.file), null);
  assert.equal(f.signatures.length, 1);
  await f.service.download(request);
  assert.equal(f.verifications.length, 1); assert.equal(f.signatures.length, 2);
  assert.deepEqual(f.signatures.at(-1)[0], ['Fixture Publisher']);
  assert.equal(f.signatures.at(-1)[1], f.file);
  assert.equal(Object.isFrozen(f.verifications[0][1]), true);
  assert.equal(f.preparations, 0);
  const installation = f.service.install(request, f.context);
  await installation;
  assert.equal(f.verifications.length, 2); assert.equal(f.signatures.length, 3);
  assert.deepEqual(f.installs, [[false, true]]);
  assert.ok(f.events.indexOf('prepare') < f.events.lastIndexOf('verify'));
  assert.ok(f.events.lastIndexOf('signature') < f.events.indexOf('platform'));
  assert.equal(f.handoffs, 1);
  assert.deepEqual(f.markerResults, [{ valid: true }]); assert.deepEqual(f.markerHandoffs, [0]);
  assert.equal(f.service.consumeQuitMarker(), null);
});

test('download checksum/signature rejection clears readiness; a genuine network failure remains retryable', async t => {
  for (const kind of ['checksum', 'signature']) {
    const f = fixture(t); await f.service.check();
    if (kind === 'checksum') fs.writeFileSync(f.file, Buffer.alloc(f.bytes.length, 7));
    else f.signatureHook = () => 'UPDATE_SIGNATURE_INVALID';
    await rejectCode(f.service.download(request), kind === 'checksum' ? 'UPDATE_CHECKSUM_MISMATCH' : 'UPDATE_SIGNATURE_INVALID');
    throwsCode(() => f.service.install(request, f.context), 'UPDATE_INVALID_METADATA');
    assert.equal(f.preparations, 0);
    fs.writeFileSync(f.file, f.bytes); f.signatureHook = null;
    assert.equal((await f.service.download(request)).phase, 'downloaded');
  }
  const f = fixture(t); await f.service.check();
  f.downloadHook = () => Promise.reject(Object.assign(new Error('Authorization: private\n/home/private/file'), { code: 'ECONNRESET' }));
  await rejectCode(f.service.download(request), 'UPDATE_NETWORK');
  f.downloadHook = null; await f.service.download(request);
  assert.equal(f.service.getState().phase, 'downloaded');
  assert.equal(f.logs.some(args => /private|Authorization|home/.test(args.join(' '))), false);
});

test('failed installer verification retains its internal checkpoint through the service without exposing it in public state', async t => {
  const f = fixture(t);
  await f.service.check();
  fs.writeFileSync(f.file, Buffer.alloc(f.bytes.length, 13));
  await assert.rejects(f.service.download(request), error => {
    assert.equal(error.code, 'UPDATE_CHECKSUM_MISMATCH');
    assert.equal(error.cause.verificationStep, 'digest');
    assert.equal(error.cause.cause.code, 'UPDATE_CHECKSUM_MISMATCH');
    assert.deepEqual(JSON.parse(JSON.stringify(error)), { code: 'UPDATE_CHECKSUM_MISMATCH' });
    return true;
  });
  assert.equal(f.service.getState().errorCode, 'UPDATE_CHECKSUM_MISMATCH');
  assert.doesNotMatch(JSON.stringify(f.states), /verificationStep|cause|digest/);
  assert.equal(f.installs.length, 0);
});

test('installation verifies cache again only after preparation; corrupted ready bytes are never installed', async t => {
  const f = fixture(t); await f.ready();
  fs.writeFileSync(f.file, Buffer.alloc(f.bytes.length, 9));
  await rejectCode(f.service.install(request, f.context), 'UPDATE_CHECKSUM_MISMATCH');
  assert.equal(f.preparations, 1); assert.equal(f.installs.length, 0); assert.equal(f.handoffs, 0);
  throwsCode(() => f.service.install(request, f.context), 'UPDATE_INVALID_METADATA');
  fs.writeFileSync(f.file, f.bytes);
  await f.service.download(request); await f.service.install(request, f.context);
  assert.equal(f.installs.length, 1);
});

test('cached Windows signature and packaged publisher names are rechecked before installation', async t => {
  const f = fixture(t); await f.ready();
  f.signatureHook = () => 'UPDATE_SIGNATURE_INVALID';
  await rejectCode(f.service.install(request, f.context), 'UPDATE_SIGNATURE_INVALID');
  assert.equal(f.installs.length, 0);
  f.signatureHook = null; await f.service.download(request);
  fs.writeFileSync(f.configPath, 'publisherName: []\n');
  await rejectCode(f.service.install(request, f.context), 'UPDATE_SIGNATURE_INVALID');
  assert.equal(f.installs.length, 0);
});

test('preparation cancellation and flush failure retain ready state, UI and retry without platform attempts', async t => {
  const f = fixture(t); await f.ready();
  f.cancelled = true;
  assert.deepEqual(await f.service.install(request, f.context), { cancelled: true });
  assert.equal(f.service.getState().phase, 'downloaded'); assert.equal(f.verifications.length, 1);
  f.cancelled = false; f.prepareHook = () => { throw new Error('sensitive failed flush'); };
  await rejectCode(f.service.install(request, f.context), 'UPDATE_PREPARATION_FAILED');
  assert.equal(f.service.getState().errorCode, 'UPDATE_PREPARATION_FAILED');
  assert.equal(f.installs.length, 0); assert.equal(f.handoffs, 0); assert.equal(f.verifications.length, 1);
  f.prepareHook = null;
  await f.service.install(request, f.context);
  assert.equal(f.installs.length, 1); assert.equal(f.handoffs, 1);
});

test('handoff stays pending after a void platform return; exactly one current native marker performs cleanup', async t => {
  const f = fixture(t); await f.ready(); f.installHook = () => {};
  let settled = false;
  const installation = f.service.install(request, f.context); installation.then(() => { settled = true; });
  await f.platformStarted.promise; await flush();
  assert.equal(settled, false); assert.equal(f.handoffs, 0); assert.equal(f.service.consumeQuitMarker(), null);
  assert.strictEqual(f.service.install(request, f.context), installation);
  f.native.emit('before-quit-for-update');
  await flush(); assert.equal(f.handoffs, 0); assert.equal(settled, false);
  assert.strictEqual(f.service.install(request, f.context), installation);
  assert.deepEqual(f.service.consumeQuitMarker(), { valid: true }); assert.equal(f.handoffs, 1);
  assert.equal(f.service.consumeQuitMarker(), null);
  await installation; assert.equal(settled, true);
  let prevented = false;
  f.native.emit('before-quit-for-update', { preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(f.handoffs, 1);
  assert.deepEqual(f.service.consumeQuitMarker(), { valid: false });
  throwsCode(() => f.service.install(request, f.context), 'UPDATE_RESTART_REQUIRED');
});

test('native synchronous/emitted platform failures preserve UI and require process restart', async t => {
  for (const mode of ['throw', 'emit']) {
    const f = fixture(t); await f.ready();
    f.installHook = () => {
      const error = new Error('installer C:\\private\\file certificate secret');
      if (mode === 'throw') throw error;
      f.updater.emit('error', error);
    };
    await rejectCode(f.service.install(request, f.context), 'UPDATE_INSTALL_FAILED');
    assert.equal(f.service.getState().errorCode, 'UPDATE_RESTART_REQUIRED');
    assert.equal(f.handoffs, 0); assert.equal(f.installs.length, 1);
    throwsCode(() => f.service.install(request, f.context), 'UPDATE_RESTART_REQUIRED');
    throwsCode(() => f.service.download(request), 'UPDATE_RESTART_REQUIRED');
    f.native.emit('before-quit-for-update'); assert.deepEqual(f.service.consumeQuitMarker(), { valid: false });
  }
  const timeout = fixture(t); await timeout.ready(); timeout.installHook = () => {};
  const installation = timeout.service.install(request, timeout.context);
  const rejection = rejectCode(installation, 'UPDATE_INSTALL_FAILED');
  await timeout.platformStarted.promise; await timeout.clock.tick(60000); await rejection;
  assert.equal(timeout.handoffs, 0);
});

test('fatal/epoch abort during preparation or queued handoff prevents stale platform work and invalidates consumed marker', async t => {
  const preparing = fixture(t); await preparing.ready();
  const prepare = deferred(); preparing.prepareHook = () => prepare.promise;
  const installation = preparing.service.install(request, preparing.context);
  const aborted = rejectCode(installation, 'OPERATION_CANCELLED');
  await flush(); preparing.abort.abort(); await aborted;
  prepare.resolve({}); await flush(); assert.equal(preparing.installs.length, 0);
  const f = fixture(t); await f.ready(); f.installHook = () => {};
  const pending = f.service.install(request, f.context);
  const rejection = rejectCode(pending, 'OPERATION_CANCELLED');
  await f.platformStarted.promise; f.abort.abort(); await rejection;
  f.native.emit('before-quit-for-update');
  assert.deepEqual(f.service.consumeQuitMarker(), { valid: false }); assert.equal(f.handoffs, 0);
  const between = fixture(t); await between.ready(); between.installHook = () => {};
  const handed = between.service.install(request, between.context);
  const rejectedBetween = rejectCode(handed, 'OPERATION_CANCELLED');
  await between.platformStarted.promise;
  between.native.emit('before-quit-for-update'); await flush();
  assert.equal(between.handoffs, 0);
  between.abort.abort();
  assert.deepEqual(between.service.consumeQuitMarker(), { valid: false }); await rejectedBetween;
  assert.equal(between.handoffs, 0);
});

test('mac ZIP cache is not native acceptance; removable native stage listeners gate the native-only quit', async t => {
  const f = fixture(t, { platform: 'darwin' }); await f.ready();
  assert.deepEqual(f.constructors, ['MacUpdater']); assert.equal(f.nativeChecks, 0); assert.equal(f.nativeQuits, 0);
  assert.equal(f.service.getState().phase, 'downloaded');
  const installation = f.service.install(request, f.context);
  await f.nativeStarted.promise;
  assert.equal(f.service.getState().phase, 'staging'); assert.equal(f.handoffs, 0);
  assert.equal(f.native.listenerCount('update-downloaded'), 1); assert.equal(f.native.listenerCount('error'), 1);
  assert.strictEqual(f.service.install(request, f.context), installation);
  f.native.emit('update-downloaded'); await installation;
  assert.equal(f.nativeQuits, 1); assert.equal(f.installs.length, 0); assert.equal(f.handoffs, 1);
  assert.equal(f.native.listenerCount('update-downloaded'), 0); assert.equal(f.native.listenerCount('error'), 0);
  assert.deepEqual(f.markerResults, [{ valid: true }]); assert.deepEqual(f.markerHandoffs, [0]);
  f.native.emit('update-downloaded'); assert.equal(f.nativeQuits, 1);
});

test('mac stage timeout, native error and synchronous quit failure are one-attempt restart-required failures', async t => {
  for (const mode of ['timeout', 'error', 'throw-check', 'throw-quit']) {
    const f = fixture(t, { platform: 'darwin' }); await f.ready();
    if (mode === 'throw-check') f.nativeCheckHook = () => { throw new Error('private feed credentials'); };
    if (mode === 'throw-quit') f.nativeQuitHook = () => { throw new Error('native quit failed'); };
    const installation = f.service.install(request, f.context);
    const rejected = rejectCode(installation, 'UPDATE_INSTALL_FAILED');
    await f.nativeStarted.promise;
    if (mode === 'timeout') { await f.clock.tick(59999); assert.equal(f.service.getState().phase, 'staging'); await f.clock.tick(1); }
    if (mode === 'error') f.native.emit('error', new Error('raw certificate JSON/path'));
    if (mode === 'throw-quit') f.native.emit('update-downloaded');
    await rejected;
    assert.equal(f.service.getState().errorCode, 'UPDATE_RESTART_REQUIRED');
    assert.equal(f.handoffs, 0); assert.equal(f.native.listenerCount('update-downloaded'), 0); assert.equal(f.native.listenerCount('error'), 0);
    f.native.emit('update-downloaded'); assert.ok(f.nativeQuits <= 1);
    throwsCode(() => f.service.install(request, f.context), 'UPDATE_RESTART_REQUIRED');
    assert.equal(f.nativeChecks, 1);
  }
});

test('mac abort/dispose removes stage listeners and late native success cannot quit', async t => {
  for (const mode of ['abort', 'dispose']) {
    const f = fixture(t, { platform: 'darwin' }); await f.ready();
    const installation = f.service.install(request, f.context);
    const rejection = rejectCode(installation, 'OPERATION_CANCELLED');
    await f.nativeStarted.promise;
    if (mode === 'abort') f.abort.abort(); else f.service.dispose();
    await rejection;
    assert.equal(f.native.listenerCount('update-downloaded'), 0); assert.equal(f.native.listenerCount('error'), 0);
    f.native.emit('update-downloaded'); assert.equal(f.nativeQuits, 0); assert.equal(f.handoffs, 0);
    assert.equal(f.clock.timers.size, 0);
  }
});

test('mac Rosetta requests and binds only the native arm64 ZIP', async t => {
  const f = fixture(t, { platform: 'darwin', rosetta: true, assetArch: 'arm64' });
  await f.ready(); assert.equal(f.verifications[0][1].arch, 'arm64');
  assert.equal(f.verifications[0][1].assetName.endsWith('-arm64.zip'), true);
});

test('Debian and genuinely read-only AppImages check only; source and standard unpacked do not request updates', async t => {
  for (const options of [{ platform: 'linux', deb: true }, { platform: 'linux', appImage: true, readOnly: true }]) {
    const f = fixture(t, options);
    assert.equal(f.service.getState().installMode, 'manual'); assert.deepEqual(f.constructors, ['CheckOnlyUpdater']);
    await f.service.check(); assert.equal(f.checks, 1);
    throwsCode(() => f.service.download(request), 'UPDATE_MANUAL_ONLY');
    throwsCode(() => f.service.install(request, f.context), 'UPDATE_MANUAL_ONLY');
    await rejectCode(f.updater.doDownloadUpdate(), 'UPDATE_MANUAL_ONLY');
    throwsCode(() => f.updater.quitAndInstall(), 'UPDATE_MANUAL_ONLY');
    assert.equal(f.downloads, 0); assert.equal(f.installs.length, 0);
  }
  for (const options of [{ packaged: false }, { executablePath: '/fixture/win-unpacked/usshtc107.exe' },
    { platform: 'darwin', executablePath: '/fixture/mac-arm64/usshtc107.app/Contents/MacOS/usshtc107' },
    { platform: 'linux', env: { APPIMAGE: '/unrelated/image.AppImage', APPDIR: '/unrelated' } }]) {
    const f = fixture(t, { ...options, autoCheck: true });
    assert.equal(f.service.getState().installMode, 'unsupported'); assert.equal(f.updater, undefined);
    await f.clock.tick(2 * 86400000); assert.equal(f.checks, 0);
    throwsCode(() => f.service.check(), 'UPDATE_MANUAL_ONLY');
    throwsCode(() => f.service.download(request), 'UPDATE_MANUAL_ONLY');
    await f.service.openRelease(); assert.equal(f.external.length, 1);
  }
});

test('only the packaged AppImage mount authorizes in-app install and rename callbacks bind frozen candidate in old directory', async t => {
  const f = fixture(t, { platform: 'linux', appImage: true });
  assert.equal(f.service.getState().installMode, 'in-app'); assert.deepEqual(f.constructors, ['AppImageUpdater']);
  await f.ready();
  const expected = path.join(path.dirname(f.oldImage), path.basename(f.file));
  f.installHook = () => { f.updater.emit('appimage-filename-updated', expected); f.nativeHandoff(); };
  await f.service.install(request, f.context);
  assert.equal(f.preflight.oldPath, f.oldImage); assert.equal(Object.isFrozen(f.preflight.candidate), true);
  assert.deepEqual(f.renamed, { candidate: f.preflight.candidate, oldPath: f.oldImage, newPath: expected });
  assert.equal(f.events.indexOf('preflight') < f.events.indexOf('platform'), true);
  assert.equal(f.events.indexOf('renamed') < f.events.indexOf('handoff'), true);
  assert.deepEqual(f.markerResults, [{ valid: true }]); assert.deepEqual(f.markerHandoffs, [0]);
  assert.equal(f.signatures.length, 0); assert.equal(f.env.APPIMAGE, f.oldImage);
});

test('AppImage writable/preflight failures can retry; unexpected rename or owned-autostart update failure cannot', async t => {
  const f = fixture(t, { platform: 'linux', appImage: true }); await f.ready();
  f.preflightHook = () => { throw new Error('owned desktop unavailable'); };
  await rejectCode(f.service.install(request, f.context), 'AUTOSTART_UPDATE_FAILED');
  assert.equal(f.service.getState().errorCode, 'AUTOSTART_UPDATE_FAILED'); assert.equal(f.installs.length, 0);
  f.preflightHook = null; fs.chmodSync(f.oldImage, 0o555);
  await rejectCode(f.service.install(request, f.context), 'UPDATE_PERMISSION_DENIED');
  fs.chmodSync(f.oldImage, 0o755);
  await f.service.install(request, f.context); assert.equal(f.installs.length, 1);
  for (const mode of ['wrong-path', 'autostart-error']) {
    const other = fixture(t, { platform: 'linux', appImage: true }); await other.ready();
    if (mode === 'autostart-error') other.renameHook = () => { throw new Error('private desktop path'); };
    let continued = false;
    other.installHook = () => {
      try {
        other.updater.emit('appimage-filename-updated', path.join(mode === 'wrong-path' ? other.resourcesPath : path.dirname(other.oldImage), path.basename(other.file)));
        continued = true;
      } catch (error) { other.updater.emit('error', error); }
    };
    await rejectCode(other.service.install(request, other.context), 'AUTOSTART_UPDATE_FAILED');
    assert.equal(continued, false, 'failed synchronous rename handling must stop the installer before relaunch');
    other.native.emit('before-quit-for-update');
    assert.equal(other.handoffs, 0); assert.equal(other.service.getState().errorCode, 'UPDATE_RESTART_REQUIRED');
    assert.deepEqual(other.service.consumeQuitMarker(), { valid: false });
    throwsCode(() => other.service.install(request, other.context), 'UPDATE_RESTART_REQUIRED');
  }
});

test('initialization failures stay visible without preventing startup or leaking native logs', async t => {
  const f = fixture(t, { constructorError: Object.assign(new Error('private broken updater config'), { code: 'EACCES' }), autoCheck: true });
  assert.equal(f.service.getState().phase, 'error'); assert.equal(f.service.getState().installMode, 'in-app');
  assert.equal(f.service.getState().errorCode, 'UPDATE_PERMISSION_DENIED');
  throwsCode(() => f.service.check(), 'UPDATE_PERMISSION_DENIED');
  await f.clock.tick(86400000); assert.equal(f.checks, 0);
  await f.service.openRelease(); assert.equal(f.external.length, 1);
  const good = fixture(t);
  for (const level of ['debug', 'info', 'warn', 'error']) good.updater.logger[level]({ password: 'secret', feed: 'http://native:auth@127.0.0.1/private', path: '/private/file' });
  assert.equal(good.logs.length, 0);
});

test('dispose cancels pending download/check, clears timers and subscriptions, and rejects late completion', async t => {
  for (const kind of ['check', 'download']) {
    const f = fixture(t, { autoCheck: true });
    const pending = deferred();
    if (kind === 'check') f.checkHook = () => pending.promise;
    else { await f.service.check(); f.downloadHook = () => pending.promise; }
    const operation = kind === 'check' ? f.service.check() : f.service.download(request);
    const rejected = rejectCode(operation, 'OPERATION_CANCELLED');
    await (kind === 'check' ? f.checkStarted.promise : f.downloadStarted.promise);
    f.service.dispose(); await rejected;
    if (kind === 'download') assert.equal(f.downloadToken.cancelled, true);
    assert.equal(f.clock.timers.size, 0); assert.equal(f.updater.listenerCount('update-downloaded'), 0);
    assert.equal(f.updater.listenerCount('download-progress'), 0); assert.equal(f.native.listenerCount('before-quit-for-update'), 0);
    const publications = f.states.length;
    pending.resolve(kind === 'check' ? { isUpdateAvailable: true, updateInfo: f.info } : [f.file]); await flush();
    assert.equal(f.states.length, publications); assert.equal(f.service.consumeQuitMarker(), null);
    throwsCode(() => f.service.check(), 'SHUTTING_DOWN');
  }
});

test('progress DTO is finite, candidate-bound and detached; checks never interrupt a downloaded candidate', async t => {
  const f = fixture(t, { autoCheck: true }); await f.service.check();
  const pending = deferred(); f.downloadHook = () => pending.promise;
  const downloading = f.service.download(request); await f.downloadStarted.promise;
  const progress = { percent: 50, transferred: f.bytes.length / 2, total: f.bytes.length, bytesPerSecond: 10,
    downloadedFile: '/private/cache', nativeFeed: 'secret' };
  f.updater.emit('download-progress', progress);
  assert.deepEqual(f.service.getState().progress, { percent: 50, transferred: f.bytes.length / 2, total: f.bytes.length, bytesPerSecond: 10 });
  const detached = f.service.getState(); detached.progress.percent = 1;
  assert.equal(f.service.getState().progress.percent, 50);
  for (const invalid of [{ percent: NaN }, { transferred: Infinity }, { percent: 101 }, { total: f.bytes.length + 1 }, { bytesPerSecond: -1 }]) {
    f.updater.emit('download-progress', { ...progress, ...invalid });
    assert.equal(f.service.getState().progress.percent, 50);
  }
  f.updater.emit('update-downloaded', { ...f.info, downloadedFile: f.file }); pending.resolve([f.file]); await downloading;
  assert.equal(f.service.getState().progress, null);
  await f.clock.tick(30000 + 86400000); assert.equal(f.checks, 1);
  assert.equal(f.preparations, 0); assert.equal(f.installs.length, 0);
});

test('stale context and handoff cleanup failure cannot arm a valid quit marker', async t => {
  const stale = fixture(t); await stale.ready(); stale.current = false;
  await rejectCode(stale.service.install(request, stale.context), 'OPERATION_CANCELLED');
  assert.equal(stale.preparations, 0); assert.equal(stale.installs.length, 0);
  const failed = fixture(t); await failed.ready(); failed.installHook = () => {};
  failed.handoffHook = () => { throw new Error('failed non-install cleanup'); };
  const installation = failed.service.install(request, failed.context);
  const rejected = rejectCode(installation, 'UPDATE_INSTALL_FAILED');
  await failed.platformStarted.promise;
  let prevented = false;
  failed.native.emit('before-quit-for-update', { preventDefault() { prevented = true; } });
  assert.equal(failed.handoffs, 0); assert.equal(prevented, false);
  assert.deepEqual(failed.service.consumeQuitMarker(), { valid: false });
  await rejected;
  assert.equal(failed.service.consumeQuitMarker(), null);
  assert.equal(failed.service.getState().errorCode, 'UPDATE_RESTART_REQUIRED');
  throwsCode(() => failed.service.check(), 'UPDATE_RESTART_REQUIRED');
});

test('AppImage identity does not trust an inherited image or a symlink replacement, including pre-install changes',
  { skip: process.platform === 'win32' ? 'Real file symlinks require Windows developer mode or elevation' : false }, async t => {
  const unrelated = fixture(t, { platform: 'linux', appImage: true, env: { APPDIR: '/inherited/unrelated/mount' } });
  assert.equal(unrelated.service.getState().installMode, 'unsupported');
  const f = fixture(t, { platform: 'linux', appImage: true }); await f.ready();
  fs.unlinkSync(f.oldImage);
  const other = path.join(f.directory, 'other.AppImage'); fs.writeFileSync(other, 'other image');
  fs.symlinkSync(other, f.oldImage);
  await rejectCode(f.service.install(request, f.context), 'UPDATE_PERMISSION_DENIED');
  assert.equal(f.installs.length, 0); assert.equal(f.preflight, undefined);
});

test('updater HTTP authorization failures stay update failures, not platform login errors', async t => {
  const f = fixture(t);
  f.checkHook = () => { const error = Object.assign(new Error('401 Cookie: private'), { statusCode: 401 }); f.updater.emit('error', error); throw error; };
  await rejectCode(f.service.check(), 'UPDATE_NETWORK');
  assert.equal(f.service.getState().errorCode, 'UPDATE_NETWORK');
  assert.equal(f.preparations, 0); assert.equal(f.handoffs, 0);
  assert.deepEqual(f.logs.map(entry => entry[2]), ['UPDATE_NETWORK', 'UPDATE_NETWORK']);
});

test('request payloads accept version only and release navigation errors expose fixed codes', async t => {
  const f = fixture(t); await f.service.check();
  for (const invalid of [null, [], { version: VERSION, downloadedFile: f.file }, { version: 1 }, { version: VERSION, feed: 'https://evil.invalid' }]) {
    throwsCode(() => f.service.download(invalid), 'INVALID_ARGUMENT');
    throwsCode(() => f.service.install(invalid, f.context), 'INVALID_ARGUMENT');
  }
  throwsCode(() => f.service.download({ version: '1.2.0' }), 'UPDATE_VERSION_REJECTED');
  throwsCode(() => f.service.setAutoCheck(1), 'INVALID_ARGUMENT');
  f.openHook = () => { throw new Error('private shell error'); };
  await rejectCode(f.service.openRelease(), 'UPDATE_NETWORK');
});

test('custom unversioned AppImage name is preserved without requiring a filename-updated event', async t => {
  const f = fixture(t, { platform: 'linux', appImage: true, customImageName: 'research.AppImage' });
  await f.ready(); await f.service.install(request, f.context);
  assert.equal(f.preflight.oldPath, f.oldImage); assert.equal(f.renamed, undefined);
  assert.equal(f.handoffs, 1); assert.deepEqual(f.installs, [[false, true]]);
  assert.deepEqual(f.markerResults, [{ valid: true }]); assert.deepEqual(f.markerHandoffs, [0]);
});

test('a missing cached installer clears ready state rather than attempting platform installation', async t => {
  const f = fixture(t); await f.ready(); fs.unlinkSync(f.file);
  await rejectCode(f.service.install(request, f.context), 'UPDATE_CHECKSUM_MISMATCH');
  throwsCode(() => f.service.install(request, f.context), 'UPDATE_INVALID_METADATA');
  assert.equal(f.installs.length, 0); assert.equal(f.handoffs, 0);
});

test('aborting while an explicit cached signature check is pending cannot later install', async t => {
  const f = fixture(t); await f.ready();
  const signature = deferred(), started = deferred();
  f.signatureHook = () => { started.resolve(); return signature.promise; };
  const installation = f.service.install(request, f.context);
  const rejected = rejectCode(installation, 'OPERATION_CANCELLED');
  await started.promise; f.abort.abort(); await rejected;
  signature.resolve(null); await flush();
  assert.equal(f.installs.length, 0); assert.equal(f.handoffs, 0);
});

test('native marker and actual before-quit may arrive in different turns; intervening errors or abort retain UI', async t => {
  for (const platform of ['win32', 'darwin']) for (const outcome of ['accept', 'error', 'abort']) {
    const f = fixture(t, { platform }); await f.ready();
    const mark = () => f.native.emit('before-quit-for-update');
    f.installHook = mark; f.nativeQuitHook = mark;
    let settled = false;
    const installation = f.service.install(request, f.context);
    const result = outcome === 'accept' ? installation : rejectCode(installation, outcome === 'abort' ? 'OPERATION_CANCELLED' : 'UPDATE_INSTALL_FAILED');
    installation.then(() => { settled = true; }, () => { settled = true; });
    if (platform === 'darwin') { await f.nativeStarted.promise; f.native.emit('update-downloaded'); }
    else await f.platformStarted.promise;
    await flush();
    assert.equal(settled, false); assert.equal(f.handoffs, 0);
    assert.strictEqual(f.service.install(request, f.context), installation);
    if (outcome === 'abort') f.abort.abort();
    if (outcome === 'error') (platform === 'darwin' ? f.native : f.updater).emit('error', new Error('late native failure'));
    if (outcome !== 'accept') await result;
    assert.equal(f.handoffs, 0);
    assert.deepEqual(f.service.consumeQuitMarker(), { valid: outcome === 'accept' });
    await result;
    assert.equal(f.handoffs, outcome === 'accept' ? 1 : 0);
    assert.equal(f.service.consumeQuitMarker(), null);
  }
});
