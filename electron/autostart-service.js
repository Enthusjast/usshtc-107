'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');

const APP_ID = 'com.ustc.usshtc107';
const DESKTOP_FILE = 'usshtc107.desktop';
const MAX_DESKTOP_BYTES = 64 * 1024;
const ARGS = ['--autostart'];
const ERROR_CODES = new Set(['AUTOSTART_CONFLICT', 'AUTOSTART_UNAVAILABLE', 'AUTOSTART_FAILED', 'AUTOSTART_UPDATE_FAILED', 'INVALID_ARGUMENT']);

function serviceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
function safeError(error) {
  if (ERROR_CODES.has(error?.code)) return error;
  return serviceError(['EACCES', 'EPERM', 'EROFS', 'ENOENT', 'ENOSYS', 'ENOTSUP'].includes(error?.code)
    ? 'AUTOSTART_UNAVAILABLE' : 'AUTOSTART_FAILED');
}
function status(supported, enabled = false, approvalRequired = false, errorCode = null) {
  return { supported, enabled, approvalRequired, errorCode };
}
function validExecutable(value, paths) {
  if (typeof value !== 'string' || !paths.isAbsolute(value)
      || /[=\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
    throw serviceError('AUTOSTART_UNAVAILABLE');
  }
  return value;
}

// Exec quoting is parsed after Desktop Entry string unescaping. Each Exec
// escape therefore needs its backslash escaped once more in the file itself.
function desktopExec(executable) {
  const argument = executable.replace(/%/g, '%%').replace(/[\\"$`]/g, '\\$&');
  return `"${argument.replace(/\\/g, '\\\\')}" --autostart`;
}
function desktopContents(executable) {
  return '[Desktop Entry]\nType=Application\nName=usshtc107\n'
    + `Exec=${desktopExec(executable)}\nTerminal=false\nX-usshtc107-Managed=true\n`;
}
function desktopEntry(text) {
  const result = new Map();
  let group = null;
  let found = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const heading = /^\[([^\]]+)\]$/.exec(line);
    if (heading) {
      group = heading[1];
      if (group === 'Desktop Entry') {
        if (found) throw serviceError('AUTOSTART_CONFLICT');
        found = true;
      }
      continue;
    }
    if (group !== 'Desktop Entry') continue;
    const entry = /^([A-Za-z0-9-]+(?:\[[^\]]+\])?)=(.*)$/.exec(line);
    if (!entry || result.has(entry[1])) throw serviceError('AUTOSTART_CONFLICT');
    result.set(entry[1], entry[2]);
  }
  if (result.get('X-usshtc107-Managed') !== 'true') throw serviceError('AUTOSTART_CONFLICT');
  return result;
}
function sameFile(first, second) {
  return first.dev === second.dev && first.ino === second.ino
    && first.size === second.size && first.mtimeMs === second.mtimeMs && first.ctimeMs === second.ctimeMs;
}

function createAutostartService({
  app, appId = APP_ID, platform = process.platform, fs: io = fs,
  env = process.env, homePath = os.homedir(), executablePath = process.execPath,
} = {}) {
  const supported = app?.isPackaged === true && ['win32', 'darwin', 'linux'].includes(platform);
  const configHome = typeof env.XDG_CONFIG_HOME === 'string' && path.posix.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME : path.join(homePath, '.config');
  const directory = path.join(configHome, 'autostart');
  const desktopPath = path.join(directory, DESKTOP_FILE);

  function linuxExecutable() {
    const selected = env.APPIMAGE || executablePath;
    validExecutable(selected, path.posix);
    const resolved = validExecutable(io.realpathSync(selected), path.posix);
    if (!io.statSync(resolved).isFile()) throw serviceError('AUTOSTART_UNAVAILABLE');
    io.accessSync(resolved, fs.constants.X_OK);
    return resolved;
  }
  function readDesktop() {
    let parent;
    try { parent = io.lstatSync(directory); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw serviceError('AUTOSTART_CONFLICT');
    let before;
    try { before = io.lstatSync(desktopPath); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_DESKTOP_BYTES) {
      throw serviceError('AUTOSTART_CONFLICT');
    }
    let fd;
    try {
      fd = io.openSync(desktopPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const opened = io.fstatSync(fd);
      if (!opened.isFile() || !sameFile(before, opened)) throw serviceError('AUTOSTART_CONFLICT');
      // Read at most the limit plus one, even if another process grows the file.
      const bytes = Buffer.alloc(MAX_DESKTOP_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = io.readSync(fd, bytes, length, bytes.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > MAX_DESKTOP_BYTES || !sameFile(opened, io.fstatSync(fd))) {
        throw serviceError('AUTOSTART_CONFLICT');
      }
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); }
      catch (_) { throw serviceError('AUTOSTART_CONFLICT'); }
      return { stat: opened, text, entries: desktopEntry(text) };
    } finally { if (fd !== undefined) io.closeSync(fd); }
  }
  function checkUnchanged(previous) {
    const current = readDesktop();
    if ((previous === null) !== (current === null)
        || (previous && (!sameFile(previous.stat, current.stat) || previous.text !== current.text))) {
      throw serviceError('AUTOSTART_CONFLICT');
    }
  }
  function syncDirectory() {
    const fd = io.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
  }
  function writeDesktop(previous, content) {
    io.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = io.lstatSync(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw serviceError('AUTOSTART_CONFLICT');
    const temporary = path.join(directory, `.${DESKTOP_FILE}.${randomUUID()}.tmp`);
    let fd;
    try {
      fd = io.openSync(temporary, 'wx', 0o600);
      io.fchmodSync(fd, 0o600);
      io.writeFileSync(fd, content, 'utf8');
      io.fsyncSync(fd);
      io.closeSync(fd);
      fd = undefined;
      checkUnchanged(previous);
      if (previous) io.renameSync(temporary, desktopPath);
      else {
        // An atomic no-replace install must not overwrite a file created after
        // the ownership check by another application.
        try { io.linkSync(temporary, desktopPath); }
        catch (error) { if (error.code === 'EEXIST') throw serviceError('AUTOSTART_CONFLICT'); throw error; }
        io.unlinkSync(temporary);
      }
      syncDirectory();
    } finally {
      if (fd !== undefined) io.closeSync(fd);
      try { io.unlinkSync(temporary); } catch (_) {}
    }
  }
  function readStatus() {
    if (!supported) return status(false, false, false, 'AUTOSTART_UNAVAILABLE');
    if (platform === 'linux') {
      const desktop = readDesktop();
      if (!desktop) return status(true);
      const entry = desktop.entries;
      return status(true, entry.get('Type') === 'Application'
        && entry.get('Exec') === desktopExec(linuxExecutable())
        && entry.get('Hidden') !== 'true' && entry.get('X-GNOME-Autostart-enabled') !== 'false');
    }
    if (typeof app.getLoginItemSettings !== 'function' || typeof app.setLoginItemSettings !== 'function') {
      throw serviceError('AUTOSTART_UNAVAILABLE');
    }
    if (platform === 'darwin') {
      const result = app.getLoginItemSettings({ type: 'mainAppService' });
      if (!['enabled', 'requires-approval', 'not-registered', 'not-found'].includes(result?.status)) {
        throw serviceError('AUTOSTART_UNAVAILABLE');
      }
      return status(true, result.status === 'enabled', result.status === 'requires-approval');
    }
    const executable = validExecutable(executablePath, path.win32);
    const result = app.getLoginItemSettings({ path: executable, args: [...ARGS] });
    if (!Array.isArray(result?.launchItems)) throw serviceError('AUTOSTART_UNAVAILABLE');
    const normalize = value => path.win32.normalize(value).toLowerCase();
    const own = result.launchItems.filter(item => item.name === appId && item.scope === 'user'
      && typeof item.path === 'string' && normalize(item.path) === normalize(executable)
      && Array.isArray(item.args) && item.args.length === ARGS.length && item.args.every((arg, index) => arg === ARGS[index]));
    return status(true, own.some(item => item.enabled === true));
  }
  async function getStatus() {
    try { return readStatus(); }
    catch (error) { return status(supported, false, false, safeError(error).code); }
  }
  async function setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw serviceError('INVALID_ARGUMENT');
    if (!supported) throw serviceError('AUTOSTART_UNAVAILABLE');
    try {
      if (platform === 'linux') {
        const previous = readDesktop();
        if (enabled) writeDesktop(previous, desktopContents(linuxExecutable()));
        else if (previous) {
          checkUnchanged(previous);
          io.unlinkSync(desktopPath);
          syncDirectory();
        }
      } else {
        if (typeof app.setLoginItemSettings !== 'function') throw serviceError('AUTOSTART_UNAVAILABLE');
        app.setLoginItemSettings(platform === 'win32'
          ? { name: appId, path: validExecutable(executablePath, path.win32), args: [...ARGS], openAtLogin: enabled, enabled }
          : { type: 'mainAppService', openAtLogin: enabled });
      }
      const actual = readStatus();
      if (actual.errorCode || (actual.enabled !== enabled && !(enabled && actual.approvalRequired))) {
        throw serviceError(actual.errorCode || 'AUTOSTART_FAILED');
      }
      return actual;
    } catch (error) { throw safeError(error); }
  }
  function imageUpdatePaths(oldPath, newPath) {
    validExecutable(oldPath, path.posix);
    validExecutable(newPath, path.posix);
    if (path.normalize(oldPath) !== oldPath || path.normalize(newPath) !== newPath
        || path.dirname(oldPath) !== path.dirname(newPath)) throw serviceError('AUTOSTART_UPDATE_FAILED');
    return { oldPath, newPath };
  }
  const imageEntryEnabled = (desktop, oldPath) => desktop?.entries.get('Type') === 'Application'
    && desktop.entries.get('Exec') === desktopExec(oldPath)
    && desktop.entries.get('Hidden') !== 'true' && desktop.entries.get('X-GNOME-Autostart-enabled') !== 'false';
  function prepareAppImageUpdate(oldPath, newPath) {
    try {
      const paths = imageUpdatePaths(oldPath, newPath);
      if (!supported || platform !== 'linux' || oldPath === newPath) return { ...paths, enabled: false };
      let desktop;
      try { desktop = readDesktop(); }
      catch (error) {
        // An unrelated entry is not ours to rewrite or enable during an update.
        if (error.code === 'AUTOSTART_CONFLICT') return { ...paths, enabled: false };
        throw error;
      }
      const enabled = imageEntryEnabled(desktop, oldPath);
      if (enabled) io.accessSync(directory, fs.constants.W_OK | fs.constants.X_OK);
      return { ...paths, enabled };
    } catch (_) { throw serviceError('AUTOSTART_UPDATE_FAILED'); }
  }
  function applyAppImageUpdate(plan) {
    if (plan?.enabled !== true) return { updated: false };
    try {
      const { oldPath, newPath } = imageUpdatePaths(plan.oldPath, plan.newPath);
      const desktop = readDesktop();
      if (!imageEntryEnabled(desktop, oldPath)) return { updated: false };
      let group = null;
      const content = desktop.text.replace(/^([^\r\n]*)(\r?\n|$)/gm, (original, line, newline) => {
        const heading = /^\[([^\]]+)\]$/.exec(line);
        if (heading) group = heading[1];
        return group === 'Desktop Entry' && line.startsWith('Exec=') ? `Exec=${desktopExec(newPath)}${newline}` : original;
      });
      writeDesktop(desktop, content);
      return { updated: true };
    } catch (_) { throw serviceError('AUTOSTART_UPDATE_FAILED'); }
  }
  return { getStatus, setEnabled, prepareAppImageUpdate, applyAppImageUpdate };
}

module.exports = { createAutostartService };
