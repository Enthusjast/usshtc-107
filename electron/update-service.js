'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const semver = require('semver');
const { CancellationToken } = require('builder-util-runtime');
const { ServiceError } = require('./ipc-contract');
const { redactLogMessage } = require('./log-redaction');
const security = require('./update-security');

const PROVIDER = Object.freeze({
  provider: 'github', owner: 'Enthusjast', repo: 'usshtc-107', private: false,
  protocol: 'https', channel: 'latest', tagNamePrefix: 'v', releaseType: 'release',
});
const RELEASE_URL = 'https://github.com/Enthusjast/usshtc-107/releases/latest';
const FIRST_CHECK_MS = 30 * 1000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const NATIVE_STAGE_MS = 60 * 1000;
const LOCKED_PHASES = new Set(['downloading', 'downloaded', 'staging', 'installing']);
const ERROR_CODES = new Set([
  'UPDATE_NETWORK', 'UPDATE_NO_RELEASE', 'UPDATE_INVALID_METADATA', 'UPDATE_VERSION_REJECTED',
  'UPDATE_CHECKSUM_MISMATCH', 'UPDATE_SIGNATURE_INVALID', 'UPDATE_PERMISSION_DENIED',
  'UPDATE_PREPARATION_FAILED', 'UPDATE_INSTALL_FAILED', 'UPDATE_RESTART_REQUIRED',
  'UPDATE_MANUAL_ONLY', 'AUTOSTART_UPDATE_FAILED', 'OPERATION_IN_PROGRESS',
  'INVALID_ARGUMENT', 'OPERATION_CANCELLED', 'SHUTTING_DOWN', 'DRAFT_CHANGED', 'PROFILE_CHANGED',
]);

function errorCode(error, fallback) {
  if (ERROR_CODES.has(error?.code)) return error.code;
  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return 'UPDATE_PERMISSION_DENIED';
  if (['ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS'].includes(error?.code)) return 'UPDATE_NO_RELEASE';
  if (['ERR_UPDATER_INVALID_VERSION'].includes(error?.code)) return 'UPDATE_VERSION_REJECTED';
  if (['ERR_UPDATER_INVALID_RELEASE_FEED', 'ERR_UPDATER_INVALID_UPDATE_INFO', 'ERR_UPDATER_NO_FILES_PROVIDED', 'ERR_UPDATER_ZIP_FILE_NOT_FOUND'].includes(error?.code)) return 'UPDATE_INVALID_METADATA';
  if (error?.code === 'ERR_UPDATER_INVALID_SIGNATURE') return 'UPDATE_SIGNATURE_INVALID';
  if (error?.code === 'ERR_CHECKSUM_MISMATCH') return 'UPDATE_CHECKSUM_MISMATCH';
  return fallback;
}
function failure(code) { return new ServiceError(code); }
function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure('OPERATION_CANCELLED'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function sameCandidate(first, second) {
  return ['version', 'platform', 'arch', 'assetName', 'size', 'sha512'].every(key => first[key] === second[key]);
}
function effectiveArch(platform, arch, run) {
  if (platform !== 'darwin' || arch !== 'x64') return arch;
  try {
    if (run('/usr/sbin/sysctl', ['-n', 'sysctl.proc_translated'], {
      encoding: 'utf8', timeout: 1000, maxBuffer: 1024, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() === '1') return 'arm64';
  } catch (_) { /* This key is absent on Intel Macs. */ }
  return arch;
}
function appImageIdentity({ app, io, env, executablePath, resourcesPath }) {
  const oldPath = env.APPIMAGE;
  const appDir = env.APPDIR;
  try {
    if (![oldPath, appDir, executablePath, resourcesPath].every(value => typeof value === 'string'
      && path.isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value))) return null;
    // An inherited APPIMAGE alone must never authorize replacing an unrelated file.
    if (io.realpathSync(oldPath) !== oldPath || io.realpathSync(appDir) !== appDir) return null;
    const image = io.lstatSync(oldPath), directory = io.lstatSync(path.dirname(oldPath));
    if (!image.isFile() || image.isSymbolicLink() || !directory.isDirectory() || directory.isSymbolicLink()) return null;
    if (!io.statSync(appDir).isDirectory()) return null;
    const executable = io.realpathSync(executablePath);
    const resources = io.realpathSync(resourcesPath);
    if (path.dirname(executable) !== appDir || resources !== path.join(appDir, 'resources')
      || io.realpathSync(app.getAppPath()) !== path.join(resources, 'app.asar')) return null;
    let writable = true;
    try {
      if (!(image.mode & 0o222) || !(directory.mode & 0o222)) writable = false;
      io.accessSync(oldPath, fs.constants.W_OK);
      io.accessSync(path.dirname(oldPath), fs.constants.W_OK);
    } catch (error) {
      if (!['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) throw error;
      writable = false;
    }
    return { oldPath, appDir, writable };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EINVAL'].includes(error?.code)) return null;
    throw error;
  }
}
function runtimeSupport(app, platform, io, resourcesPath, executablePath, env) {
  if (app?.isPackaged !== true || !['win32', 'darwin', 'linux'].includes(platform)) return { mode: 'unsupported' };
  try {
    const appPath = app.getAppPath();
    const config = path.join(resourcesPath, 'app-update.yml');
    if (!path.isAbsolute(appPath) || path.basename(appPath) !== 'app.asar'
      || !io.statSync(appPath).isFile() || !io.lstatSync(config).isFile() || io.lstatSync(config).isSymbolicLink()) return { mode: 'unsupported' };
    if (/(?:^|[\\/])(?:win|linux)(?:-[a-z0-9_]+)?-unpacked(?:[\\/]|$)/i.test(executablePath)
      || (platform === 'darwin' && /(?:^|\/)mac(?:-(?:arm64|x64|universal))?\/[^/]+\.app\//.test(executablePath))) return { mode: 'unsupported' };
    if (platform !== 'linux') return { mode: 'in-app' };
    let packageType = '';
    try { packageType = io.readFileSync(path.join(resourcesPath, 'package-type'), 'utf8').trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (packageType === 'deb') return { mode: 'manual' };
    const image = appImageIdentity({ app, io, env, executablePath, resourcesPath });
    return image ? { mode: image.writable ? 'in-app' : 'manual', image } : { mode: 'unsupported' };
  } catch (error) {
    return error?.code === 'ENOENT' ? { mode: 'unsupported' }
      : { mode: platform === 'linux' ? 'manual' : 'in-app', errorCode: errorCode(error, 'UPDATE_INVALID_METADATA') };
  }
}

function createUpdateService(deps = {}) {
  const { app, nativeUpdater, shell } = deps;
  const adapters = deps.adapters || {};
  const verifier = adapters.security || security;
  // Electron's virtual fs reports the app.asar root as a directory. Package
  // eligibility and downloaded assets must use physical filesystem identities.
  const io = adapters.fs || (process.versions.electron ? require('original-fs') : fs);
  const platform = adapters.platform || process.platform;
  const arch = effectiveArch(platform, adapters.arch || process.arch, adapters.execFileSync || execFileSync);
  const env = adapters.env || process.env;
  const resourcesPath = adapters.resourcesPath || process.resourcesPath || '';
  const executablePath = adapters.executablePath || process.execPath;
  const clock = deps.clock || {};
  const setTimer = clock.setTimeout ? clock.setTimeout.bind(clock) : setTimeout;
  const clearTimer = clock.clearTimeout ? clock.clearTimeout.bind(clock) : clearTimeout;
  const now = clock.now ? clock.now.bind(clock) : Date.now;
  const support = runtimeSupport(app, platform, io, resourcesPath, executablePath, env);
  const currentVersion = app.getVersion();
  let state = {
    phase: support.errorCode ? 'error' : 'idle', currentVersion, availableVersion: null, releaseDate: null,
    releaseNotes: '', checkedAt: null, progress: null, installMode: support.mode, errorCode: support.errorCode || null,
  };
  let disposed = false, ready = false, autoCheck = deps.autoCheckUpdates !== false, timer = null;
  let candidate = null, readyPath = null, operation = null, intent = null, quitMarker = null;
  let restartRequired = false, notifiedVersion = null;
  const subscriptions = [];
  let updater = null;
  let initializationError = support.errorCode || null;

  function dto() { return { ...state, progress: state.progress ? { ...state.progress } : null }; }
  function publish(patch) {
    if (disposed) return;
    state = { ...state, ...patch };
    try { deps.onState?.(dto()); } catch (_) {}
  }
  function log(level, code) {
    // Native updater messages contain paths, feed credentials and certificate JSON.
    // Never forward those strings, even after generic secret redaction.
    if (!ERROR_CODES.has(code)) return;
    try { deps.log?.(level, 'updater', redactLogMessage(code)); } catch (_) {}
  }
  function listen(emitter, event, callback) {
    emitter.on(event, callback);
    subscriptions.push(() => emitter.removeListener(event, callback));
  }
  function assertAlive() { if (disposed) throw failure('SHUTTING_DOWN'); }
  function assertOperation(op) {
    assertAlive();
    if (operation !== op || op.abort.signal.aborted) throw failure('OPERATION_CANCELLED');
    if (op.eventError) throw op.eventError;
  }
  function validateRequest(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).length !== 1 || typeof payload.version !== 'string') throw failure('INVALID_ARGUMENT');
    return payload.version;
  }
  function checkVersion(version) {
    if (!candidate || version !== candidate.version) throw failure('UPDATE_VERSION_REJECTED');
  }
  function inApp() {
    assertAlive();
    if (support.mode !== 'in-app') throw failure('UPDATE_MANUAL_ONLY');
    if (initializationError) throw failure(initializationError);
    if (restartRequired) throw failure('UPDATE_RESTART_REQUIRED');
  }
  function run(kind, version, body) {
    assertAlive();
    if (operation) {
      if (operation.kind === kind && operation.version === version) return operation.promise;
      throw failure('OPERATION_IN_PROGRESS');
    }
    const op = { kind, version, abort: new AbortController(), eventError: null };
    operation = op;
    op.promise = Promise.resolve().then(() => { assertOperation(op); return body(op); }).finally(() => {
      if (operation === op) operation = null;
      op.cancellation?.dispose();
    });
    return op.promise;
  }
  function schedule(delay) {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (disposed || !ready || !autoCheck || support.mode === 'unsupported' || initializationError) return;
    timer = setTimer(() => {
      timer = null;
      if (!disposed && autoCheck && !operation && !readyPath && !LOCKED_PHASES.has(state.phase)) {
        try { check().catch(() => {}); } catch (_) {}
      }
      schedule(CHECK_INTERVAL_MS);
    }, delay);
    timer?.unref?.();
  }
  function setAutoCheck(enabled) {
    if (typeof enabled !== 'boolean') throw failure('INVALID_ARGUMENT');
    assertAlive();
    if (autoCheck === enabled) return;
    autoCheck = enabled;
    schedule(FIRST_CHECK_MS);
  }
  function validateInfo(info) {
    return verifier.validateUpdateInfo(info, { currentVersion, platform, arch });
  }
  function canonicalFile(file, expected) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || /[\u0000-\u001f\u007f]/.test(file)
      || path.normalize(file) !== file || path.basename(file) !== expected.assetName) throw failure('UPDATE_INVALID_METADATA');
    try {
      const resolved = io.realpathSync(file);
      const stat = io.lstatSync(file);
      if (resolved !== file || !stat.isFile() || stat.isSymbolicLink()) throw failure('UPDATE_CHECKSUM_MISMATCH');
      return resolved;
    } catch (error) { throw failure(errorCode(error, 'UPDATE_CHECKSUM_MISMATCH')); }
  }
  function publisherNames() {
    return verifier.readPublisherNames(path.join(resourcesPath, 'app-update.yml'), { fs: io });
  }
  async function verify(file, frozen, signal) {
    await verifier.verifyUpdateFile(file, frozen, { signal, fs: io });
    if (signal.aborted || disposed) throw failure('OPERATION_CANCELLED');
    if (platform === 'win32') {
      const code = await verifier.verifyWindowsSignature(publisherNames(), file, { execFile: adapters.execFile, env });
      if (code) throw failure('UPDATE_SIGNATURE_INVALID');
    }
    if (signal.aborted || disposed) throw failure('OPERATION_CANCELLED');
  }

  if (support.mode !== 'unsupported' && !initializationError) try {
    const classes = adapters.updaterClasses || require('electron-updater');
    if (support.mode === 'manual') {
      class CheckOnlyUpdater extends classes.AppUpdater {
        doDownloadUpdate() { return Promise.reject(failure('UPDATE_MANUAL_ONLY')); }
        quitAndInstall() { throw failure('UPDATE_MANUAL_ONLY'); }
      }
      updater = new CheckOnlyUpdater({ ...PROVIDER });
    } else {
      const Updater = platform === 'win32' ? classes.NsisUpdater : platform === 'darwin' ? classes.MacUpdater : classes.AppImageUpdater;
      updater = new Updater({ ...PROVIDER });
    }
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.disableWebInstaller = true;
    updater.logger = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, () => {}]));
    if (platform === 'win32' && support.mode === 'in-app') {
      updater.verifyUpdateCodeSignature = (names, file) => verifier.verifyWindowsSignature(names, file, { execFile: adapters.execFile, env });
    }
    listen(updater, 'error', error => {
      if (disposed) return;
      const code = errorCode(error, intent?.attempted ? 'UPDATE_INSTALL_FAILED' : 'UPDATE_NETWORK');
      log('error', code);
      if (intent?.attempted) intent.fail(failure(code));
      else if (operation) operation.eventError = failure(code);
    });
    listen(updater, 'download-progress', value => {
      if (operation?.kind !== 'download' || disposed) return;
      if (!value || !['percent', 'transferred', 'total', 'bytesPerSecond'].every(key => Number.isFinite(value[key]) && value[key] >= 0)
        || value.percent > 100 || value.transferred > value.total || value.total !== candidate?.size) return;
      publish({ progress: { percent: value.percent, transferred: value.transferred, total: value.total, bytesPerSecond: value.bytesPerSecond } });
    });
    listen(updater, 'update-downloaded', event => {
      const op = operation;
      if (disposed || op?.kind !== 'download') return;
      try {
        if (op.event) throw failure('UPDATE_INVALID_METADATA');
        const downloaded = validateInfo(event).candidate;
        if (!sameCandidate(candidate, downloaded)) throw failure('UPDATE_INVALID_METADATA');
        op.event = { file: canonicalFile(event.downloadedFile, candidate) };
      } catch (error) { op.eventError = failure(errorCode(error, 'UPDATE_INVALID_METADATA')); }
    });
    listen(updater, 'appimage-filename-updated', newPath => {
      const active = intent;
      if (disposed || platform !== 'linux' || !active?.attempted || !active.armed) return;
      try {
        active.assertCurrent();
        const oldPath = support.image.oldPath;
        const expected = path.join(path.dirname(oldPath), active.candidate.assetName);
        if (typeof newPath !== 'string' || path.normalize(newPath) !== newPath || newPath !== expected
          || !/\d+\.\d+\.\d+/.test(path.basename(oldPath))) throw failure('AUTOSTART_UPDATE_FAILED');
        const result = deps.onAppImageRenamed?.({ candidate: active.candidate, oldPath, newPath });
        if (result && typeof result.then === 'function') throw failure('AUTOSTART_UPDATE_FAILED');
        active.assertCurrent();
      } catch (_) {
        const error = failure('AUTOSTART_UPDATE_FAILED');
        active.fail(error);
        // AppImageUpdater emits synchronously inside doInstall; throwing prevents
        // its remaining relaunch/quit steps after the image has already moved.
        throw error;
      }
    });
  } catch (error) {
    initializationError = errorCode(error, 'UPDATE_INVALID_METADATA');
    updater = null;
    publish({ phase: 'error', errorCode: initializationError });
    log('error', initializationError);
  }

  if (nativeUpdater) listen(nativeUpdater, 'before-quit-for-update', event => {
    const active = intent;
    if (!active?.attempted || !active.armed) return;
    const valid = !active.markerIssued && !active.failed;
    active.markerIssued = true;
    // Native notification and app before-quit can occur in separate turns.
    // Keep the exclusive install action pending until main consumes this marker.
    quitMarker = { intent: active, valid };
    if (!valid) event?.preventDefault?.();
  });

  function consumeQuitMarker() {
    const marker = quitMarker;
    quitMarker = null;
    if (!marker) return null;
    let valid = marker.valid && !disposed && !marker.intent.failed;
    if (valid) {
      try {
        marker.intent.assertCurrent();
        const result = marker.intent.context.onHandoff();
        if (result && typeof result.then === 'function') throw failure('UPDATE_INSTALL_FAILED');
        marker.intent.assertCurrent();
      } catch (_) { valid = false; }
    }
    if (valid) {
      publish({ phase: 'installing', errorCode: null });
      marker.intent.accept(dto());
    } else marker.intent.fail(failure('UPDATE_INSTALL_FAILED'));
    return { valid };
  }
  function check() {
    assertAlive();
    if (support.mode === 'unsupported') throw failure('UPDATE_MANUAL_ONLY');
    if (initializationError) throw failure(initializationError);
    if (operation) return run('check', null, () => {});
    if (restartRequired) throw failure('UPDATE_RESTART_REQUIRED');
    if (readyPath || LOCKED_PHASES.has(state.phase)) throw failure('OPERATION_IN_PROGRESS');
    return run('check', null, async op => {
      publish({ phase: 'checking', progress: null, errorCode: null });
      try {
        const result = await abortable(updater.checkForUpdates(), op.abort.signal);
        assertOperation(op);
        if (!result || !result.updateInfo || typeof result.isUpdateAvailable !== 'boolean') throw failure('UPDATE_NO_RELEASE');
        const info = result.updateInfo;
        if (!result.isUpdateAvailable) {
          if (typeof info.version !== 'string' || semver.valid(info.version) !== info.version
            || semver.prerelease(info.version) || info.version !== currentVersion) throw failure('UPDATE_VERSION_REJECTED');
          candidate = null;
          publish({ phase: 'current', availableVersion: null, releaseDate: null, releaseNotes: '', checkedAt: new Date(now()).toISOString(), errorCode: null });
        } else {
          const validated = validateInfo(info);
          candidate = validated.candidate;
          publish({ phase: 'available', availableVersion: candidate.version, releaseDate: validated.releaseDate,
            releaseNotes: validated.releaseNotes, checkedAt: new Date(now()).toISOString(), errorCode: null });
          if (notifiedVersion !== candidate.version) {
            notifiedVersion = candidate.version;
            try { deps.onAvailable?.(dto()); } catch (_) {}
          }
        }
        return dto();
      } catch (error) {
        const code = errorCode(error, 'UPDATE_NETWORK');
        publish({ phase: 'error', checkedAt: new Date(now()).toISOString(), errorCode: code });
        log('warn', code);
        throw failure(code);
      }
    });
  }
  function download(payload) {
    const version = validateRequest(payload);
    assertAlive();
    if (support.mode !== 'in-app') throw failure('UPDATE_MANUAL_ONLY');
    if (operation) return run('download', version, () => {});
    inApp();
    checkVersion(version);
    if (readyPath) return Promise.resolve(dto());
    return run('download', version, async op => {
      const frozen = candidate;
      publish({ phase: 'downloading', progress: null, errorCode: null });
      op.cancellation = new CancellationToken();
      try {
        const files = await abortable(updater.downloadUpdate(op.cancellation), op.abort.signal);
        assertOperation(op);
        if (!op.event || !Array.isArray(files) || (files.length === 0 && platform !== 'darwin')) throw failure('UPDATE_INVALID_METADATA');
        if (files.length && (files.length !== 1 || canonicalFile(files[0], frozen) !== op.event.file)) throw failure('UPDATE_INVALID_METADATA');
        await abortable(verify(op.event.file, frozen, op.abort.signal), op.abort.signal);
        assertOperation(op);
        readyPath = op.event.file;
        publish({ phase: 'downloaded', progress: null, errorCode: null });
        return dto();
      } catch (error) {
        readyPath = null;
        const code = errorCode(error, 'UPDATE_NETWORK');
        publish({ phase: 'error', progress: null, errorCode: code });
        log('warn', code);
        throw failure(code);
      }
    });
  }
  function install(payload, context = {}) {
    const version = validateRequest(payload);
    assertAlive();
    if (support.mode !== 'in-app') throw failure('UPDATE_MANUAL_ONLY');
    if (operation) return run('install', version, () => {});
    inApp();
    checkVersion(version);
    if (!readyPath) throw failure('UPDATE_INVALID_METADATA');
    return run('install', version, async op => {
      let removeAbort = () => {};
      const assertCurrent = () => {
        assertOperation(op);
        if (context.signal?.aborted) throw failure('OPERATION_CANCELLED');
        context.assertCurrent?.();
      };
      try {
        assertCurrent();
        if (typeof context.prepare !== 'function' || typeof context.assertCurrent !== 'function'
          || typeof context.onHandoff !== 'function') throw failure('UPDATE_PREPARATION_FAILED');
        const abort = () => op.abort.abort();
        context.signal?.addEventListener('abort', abort, { once: true });
        removeAbort = () => context.signal?.removeEventListener('abort', abort);
        let prepared;
        try { prepared = await abortable(context.prepare(), op.abort.signal); }
        catch (error) { throw failure(errorCode(error, 'UPDATE_PREPARATION_FAILED')); }
        assertCurrent();
        if (prepared?.cancelled === true) {
          publish({ phase: 'downloaded', errorCode: null });
          return { cancelled: true };
        }
        // Native confirmation and stop/flush happen before touching cached bytes.
        try {
          canonicalFile(readyPath, candidate);
          await abortable(verify(readyPath, candidate, op.abort.signal), op.abort.signal);
        } catch (error) {
          if (!op.abort.signal.aborted) readyPath = null;
          throw error;
        }
        assertCurrent();
        if (platform === 'linux') {
          const image = appImageIdentity({ app, io, env, executablePath, resourcesPath });
          if (!image?.writable || image.oldPath !== support.image?.oldPath) throw failure('UPDATE_PERMISSION_DENIED');
          try {
            const result = deps.beforeAppImageInstall?.(candidate, image.oldPath);
            if (result && typeof result.then === 'function') throw failure('AUTOSTART_UPDATE_FAILED');
          } catch (_) { throw failure('AUTOSTART_UPDATE_FAILED'); }
          assertCurrent();
        }
        const active = { candidate, context, attempted: true, armed: platform !== 'darwin',
          failed: false, markerIssued: false, cleanup: () => {} };
        active.assertCurrent = () => {
          assertAlive();
          if (intent !== active || op.abort.signal.aborted || context.signal?.aborted) throw failure('OPERATION_CANCELLED');
          context.assertCurrent();
        };
        intent = active;
        restartRequired = true;
        const handoff = new Promise((resolve, reject) => {
          active.accept = resolve;
          active.fail = error => {
            if (active.failed) return;
            active.failed = true;
            // Keep the armed, invalid intent until disposal so a queued native
            // before-quit cannot be mistaken for an ordinary user quit.
            active.cleanup();
            publish({ phase: 'error', errorCode: 'UPDATE_RESTART_REQUIRED' });
            reject(failure(errorCode(error, 'UPDATE_INSTALL_FAILED')));
          };
        });
        const abortInstall = () => active.fail(failure('OPERATION_CANCELLED'));
        op.abort.signal.addEventListener('abort', abortInstall, { once: true });
        const handoffTimer = setTimer(() => active.fail(failure('UPDATE_INSTALL_FAILED')), NATIVE_STAGE_MS);
        handoffTimer?.unref?.();
        active.cleanup = () => {
          op.abort.signal.removeEventListener('abort', abortInstall);
          clearTimer(handoffTimer);
        };
        if (platform === 'darwin') {
          publish({ phase: 'staging', errorCode: null });
          const cleanup = active.cleanup;
          const success = () => {
            try {
              assertCurrent();
              if (active.failed || intent !== active) throw failure('OPERATION_CANCELLED');
              active.armed = true;
              nativeUpdater.quitAndInstall();
            } catch (error) { active.fail(error); }
          };
          const nativeError = () => active.fail(failure('UPDATE_INSTALL_FAILED'));
          active.cleanup = () => {
            cleanup();
            nativeUpdater?.removeListener('update-downloaded', success);
            nativeUpdater?.removeListener('error', nativeError);
          };
          if (!nativeUpdater?.once || typeof nativeUpdater.checkForUpdates !== 'function'
            || typeof nativeUpdater.quitAndInstall !== 'function') active.fail(failure('UPDATE_INSTALL_FAILED'));
          else {
            nativeUpdater.once('update-downloaded', success);
            nativeUpdater.once('error', nativeError);
            try { nativeUpdater.checkForUpdates(); } catch (error) { active.fail(error); }
          }
        } else {
          // Main's actual before-quit consumes the marker before any UI cleanup.
          try { assertCurrent(); updater.quitAndInstall(false, true); }
          catch (error) { active.fail(error); }
        }
        try { return await handoff; } finally { active.cleanup(); }
      } catch (error) {
        const fallback = intent?.attempted ? 'UPDATE_INSTALL_FAILED' : 'UPDATE_PREPARATION_FAILED';
        const code = errorCode(error, fallback);
        publish({ phase: 'error', progress: null, errorCode: restartRequired ? 'UPDATE_RESTART_REQUIRED' : code });
        log('error', code);
        throw failure(code);
      } finally { removeAbort(); }
    });
  }
  async function openRelease() {
    assertAlive();
    try { await shell.openExternal(RELEASE_URL); return null; }
    catch (_) { throw failure('UPDATE_NETWORK'); }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
    operation?.abort.abort();
    operation?.cancellation?.cancel();
    intent?.fail(failure('SHUTTING_DOWN'));
    intent?.cleanup();
    intent = null;
    quitMarker = null;
    for (const unsubscribe of subscriptions) unsubscribe();
    // MacUpdater's loopback server close method is private. Do not reach into
    // it or destroy its feed while a native installation is being staged.
  }

  Promise.resolve().then(() => app.whenReady()).then(() => {
    if (!disposed) { ready = true; schedule(FIRST_CHECK_MS); }
  }).catch(() => {});
  return { getState: dto, check, download, install, openRelease, setAutoCheck, consumeQuitMarker, dispose };
}

module.exports = { createUpdateService };
