'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { _electron: electron, expect } = require('@playwright/test');
const { createDefaultRoot } = require('../../electron/settings-store');

const project = path.resolve(__dirname, '../..');
const guardPath = path.join(project, 'tests/fixtures/electron-network-guard.cjs');

function executableArchitectures(file, platform = process.platform) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('APP_EXECUTABLE must be an absolute native executable path');
  if (!fs.statSync(file).isFile()) throw new Error('APP_EXECUTABLE must exist and be a regular executable');
  fs.accessSync(file, fs.constants.X_OK);
  const fd = fs.openSync(file, 'r');
  const header = Buffer.alloc(4096);
  let length;
  try { length = fs.readSync(fd, header, 0, header.length, 0); } finally { fs.closeSync(fd); }
  const machine = (value) => ({ 3: 'ia32', 62: 'x64', 183: 'arm64', 40: 'arm', 0x14c: 'ia32', 0x8664: 'x64', 0xaa64: 'arm64', 7: 'ia32', 0x01000007: 'x64', 0x0100000c: 'arm64' })[value];
  if (platform === 'linux' && header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    return [machine(header[5] === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18))].filter(Boolean);
  }
  if (platform === 'win32' && header.toString('ascii', 0, 2) === 'MZ') {
    const offset = header.readUInt32LE(60);
    if (offset + 6 > length || header.toString('ascii', offset, offset + 4) !== 'PE\0\0') throw new Error('APP_EXECUTABLE has an invalid PE header');
    return [machine(header.readUInt16LE(offset + 4))].filter(Boolean);
  }
  if (platform === 'darwin') {
    const magic = header.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) {
      return [machine([0xcefaedfe, 0xcffaedfe].includes(magic) ? header.readUInt32LE(4) : header.readUInt32BE(4))].filter(Boolean);
    }
    if ([0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic)) {
      const little = [0xbebafeca, 0xbfbafeca].includes(magic);
      const uint = (offset) => little ? header.readUInt32LE(offset) : header.readUInt32BE(offset);
      const count = uint(4), stride = [0xcafebabf, 0xbfbafeca].includes(magic) ? 32 : 20;
      if (!count || count > 32 || 8 + count * stride > length) throw new Error('APP_EXECUTABLE has an invalid universal Mach-O header');
      return Array.from({ length: count }, (_, index) => machine(uint(8 + index * stride))).filter(Boolean);
    }
  }
  throw new Error(`APP_EXECUTABLE is not a ${platform} ELF/PE/Mach-O executable`);
}
function packagedExecutable() {
  const executable = process.env.APP_EXECUTABLE;
  const architectures = executableArchitectures(executable);
  if (!architectures.includes(process.arch)) throw new Error(`APP_EXECUTABLE architecture ${architectures.join(',') || 'unknown'} does not match native runner ${process.arch}`);
  return executable;
}
async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
function isolatedRoot(port) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc107-electron-')));
  fs.chmodSync(root, 0o700);
  for (const child of ['home/.ssh', 'userData/sessionData', 'userData/logs', 'config', 'cache', 'appData', 'localAppData', 'exports', 'tmp']) {
    const directory = path.join(root, child);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700);
  }
  const settings = createDefaultRoot({ autoConnect: false, autoCheckUpdates: false, launchAtLogin: false, reconnectOnResume: false, port });
  fs.writeFileSync(path.join(root, 'userData/settings.json'), JSON.stringify(settings), { mode: 0o600 });
  return root;
}
function privateEnvironment(root, packaged, executable) {
  const env = { ...process.env, HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
    APPDATA: path.join(root, 'appData'), LOCALAPPDATA: path.join(root, 'localAppData'),
    TMPDIR: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'),
  };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_DEV', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'APPIMAGE', 'APPDIR', 'USSHTC107_FIXTURE_ROOT']) delete env[key];
  delete env.APP_EXPECTED_UPDATE_MODE;
  // CoreFoundation resolves Keychain preferences independently of POSIX HOME.
  if (process.platform === 'darwin') env.CFFIXED_USER_HOME = env.HOME;
  if (!packaged) env.USSHTC107_FIXTURE_ROOT = root;
  if (!packaged || !executable.endsWith('.AppImage')) delete env.APPIMAGE_EXTRACT_AND_RUN;
  return env;
}
async function rpc(page, method, payload) {
  const result = await page.evaluate(async ({ method, payload }) => window.electronAPI[method](payload), { method, payload });
  expect(result, `${method} must return a successful public envelope`).toMatchObject({ ok: true });
  expect(Object.keys(result).sort()).toEqual(['ok', 'value']);
  return result.value;
}
async function envelope(page, method, payload) {
  return page.evaluate(({ method, payload }) => window.electronAPI[method](payload), { method, payload });
}
async function scope(page) { const state = await rpc(page, 'getStatus'); return { profileId: state.profileId, epoch: state.epoch }; }
async function waitState(page, expected) {
  let state;
  await expect.poll(async () => { state = await rpc(page, 'getStatus'); return state; }).toMatchObject(expected);
  return state;
}
function keychainCommand(env, args) {
  try {
    execFileSync('/usr/bin/security', args, { env, stdio: 'pipe', timeout: 10_000 });
  } catch (error) {
    // Do not include command arguments: create/unlock carry the temporary password.
    throw new Error(`Native acceptance keychain ${args[0]} failed (${error.status ?? error.code})`);
  }
}
function prepareKeychain(keychain, env) {
  fs.mkdirSync(path.dirname(keychain), { recursive: true, mode: 0o700 });
  const password = randomBytes(32).toString('hex');
  for (const args of [
    ['create-keychain', '-p', password, keychain],
    ['set-keychain-settings', '-lut', '21600', keychain],
    ['unlock-keychain', '-p', password, keychain],
    ['default-keychain', '-d', 'user', '-s', keychain],
    ['list-keychains', '-d', 'user', '-s', keychain],
  ]) keychainCommand(env, args);
}
async function launch(testInfo, { packaged = false } = {}) {
  const executable = packaged ? packagedExecutable() : require('electron');
  const port = await unusedPort();
  const root = isolatedRoot(port);
  const env = privateEnvironment(root, packaged, executable);
  const keychain = packaged && process.platform === 'darwin'
    ? path.join(root, 'home/Library/Keychains/usshtc107-acceptance.keychain-db') : null;
  let application, child;
  try {
    if (keychain) prepareKeychain(keychain, env);
    application = await electron.launch({ executablePath: executable, chromiumSandbox: true, timeout: 30_000,
      args: [...(packaged ? [] : [path.join(project, 'tests/fixtures/electron-entry.cjs')]), `--user-data-dir=${path.join(root, 'userData')}`],
      env, cwd: project,
    });
    child = application.process();
    if (typeof testInfo.outputPath === 'function') await application.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
    // This runs directly in the native main process, not in production startup
    // code. Main evaluate has no ordinary global require.
    await application.evaluate(({ app }, { guardPath }) => {
      const load = process.getBuiltinModule('module').createRequire(app.getAppPath());
      load(guardPath).installNetworkGuard(load('electron'));
    }, { guardPath });
    const page = await application.firstWindow();
    await page.waitForFunction(() => window.electronAPI?.isElectron === true);
    if (!packaged) await application.evaluate(async ({ app }) => { await app.__acceptance.ready; });
    await waitState(page, { operation: null, proxyStatus: 'stopped' });
    const context = { application, child, page, root, port, executable, packaged, testInfo, env, keychain, tracing: typeof testInfo.outputPath === 'function' };
    await assertIsolation(context);
    return context;
  } catch (error) {
    if (child?.exitCode === null && child?.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    if (keychain && fs.existsSync(keychain)) keychainCommand(env, ['delete-keychain', keychain]);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    throw error;
  }
}
async function assertIsolation({ application, page, root, packaged, executable }) {
  const actual = await application.evaluate(({ app, BrowserWindow }, { root }) => {
    const load = process.getBuiltinModule('module').createRequire(app.getAppPath());
    const fs = load('node:fs'), path = load('node:path'), os = load('node:os');
    const within = (value) => { const relative = path.relative(root, fs.realpathSync(value)); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
    const window = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().startsWith('file:'));
    return { arch: process.arch, packaged: app.isPackaged, fixtureRoot: fs.realpathSync(root) === root,
      paths: Object.fromEntries(['userData', 'sessionData', 'logs'].map((name) => [name, { value: app.getPath(name), confined: within(app.getPath(name)), mode: fs.statSync(app.getPath(name)).mode & 0o777 }])),
      sshDirectory: path.join(os.homedir(), '.ssh'), sshConfined: within(path.join(os.homedir(), '.ssh')),
      rootMode: fs.statSync(root).mode & 0o777, prefs: window.webContents.getLastWebPreferences(),
      sandboxDisabled: app.commandLine.hasSwitch('no-sandbox'), denied: app.__acceptanceNetwork.denied,
      sessionCount: app.__acceptanceNetwork.sessionCount, fixtureInjection: Boolean(app.__acceptance),
    };
  }, { root });
  expect(actual.arch).toBe(process.arch);
  expect(actual.packaged).toBe(packaged);
  expect(actual.fixtureRoot).toBe(true);
  expect(actual.sandboxDisabled).toBe(false);
  expect(actual.fixtureInjection).toBe(!packaged);
  expect(actual.sshConfined).toBe(true);
  expect(actual.denied).toEqual([]);
  for (const entry of Object.values(actual.paths)) expect(entry.confined).toBe(true);
  if (process.platform !== 'win32') {
    expect(actual.rootMode).toBe(0o700);
    for (const entry of Object.values(actual.paths)) expect(entry.mode).toBe(0o700);
  }
  expect(actual.prefs).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true,
    webSecurity: true, allowRunningInsecureContent: false });
  const info = await rpc(page, 'getRuntimeInfo');
  expect(info).toMatchObject({ isElectron: true, platform: process.platform, devMode: false });
  const currentScope = await scope(page);
  const settings = await rpc(page, 'getSettings', currentScope);
  expect(settings).toMatchObject({ autoConnect: false, autoCheckUpdates: false, launchAtLogin: false });
  const keys = await rpc(page, 'getSshKeyInfo', currentScope);
  expect(keys.client.state).toBe('ready');
  expect(keys.host.state).toBe('ready');
  for (const role of ['client', 'host']) {
    expect(path.relative(root, keys[role].privateKeyPath)).not.toMatch(/^\.\.(?:[\\/]|$)/);
    expect(path.isAbsolute(keys[role].privateKeyPath)).toBe(true);
    expect(fs.realpathSync(keys[role].privateKeyPath)).toBe(keys[role].privateKeyPath);
  }
  const profiles = await rpc(page, 'getProfiles');
  expect(JSON.stringify({ settings, profiles, keys })).not.toMatch(/ssoPassword|savedCookieEncrypted|BEGIN .*PRIVATE KEY/);
  expect(await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process, invoke: typeof window.electronAPI.invoke })))
    .toEqual({ require: 'undefined', process: 'undefined', invoke: 'undefined' });
  if (packaged) expect(executableArchitectures(executable)).toContain(actual.arch);
}
async function invalidSender({ application, page }) {
  const before = await rpc(page, 'getSettings', await scope(page));
  const result = await application.evaluate(async ({ app, BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((item) => item.webContents.getURL().startsWith('file:'));
    const load = process.getBuiltinModule('module').createRequire(app.getAppPath());
    const preload = load('node:path').resolve(load('node:path').dirname(load('node:url').fileURLToPath(main.webContents.getURL())), '../electron/preload.js');
    if (!load('node:fs').statSync(preload).isFile()) throw new Error('Production preload file is missing');
    const window = new BrowserWindow({ show: false, webPreferences: { preload,
      contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
    try {
      // Even the same trusted file URL is rejected if it comes from a different
      // real WebContents, exercising production preload + sender checks.
      await window.loadURL(main.webContents.getURL());
      return await window.webContents.executeJavaScript(`(async () => ({
        status: await window.electronAPI.getStatus(),
        write: await window.electronAPI.saveAppSettings({ launchAtLogin: true }),
        generic: typeof window.electronAPI.invoke
      }))()`);
    } finally { window.destroy(); }
  });
  expect(result).toEqual({ status: { ok: false, error: { code: 'INTERNAL_ERROR' } }, write: { ok: false, error: { code: 'INTERNAL_ERROR' } }, generic: 'undefined' });
  expect(await rpc(page, 'getSettings', await scope(page))).toEqual(before);
}
async function screenshot(context, name) {
  const file = context.testInfo.outputPath(`${name}.png`);
  await context.page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  await context.testInfo.attach(name, { path: file, contentType: 'image/png' });
}
async function finishTrace(context) {
  if (!context.tracing) return;
  context.tracing = false;
  const file = context.testInfo.outputPath('electron-trace.zip');
  await context.application.context().tracing.stop({ path: file });
  await context.testInfo.attach('electron-trace', { path: file, contentType: 'application/zip' });
}
async function assertNoExternal({ application }) {
  expect(await application.evaluate(({ app }) => app.__acceptanceNetwork.denied)).toEqual([]);
}
async function exitNormally(context) {
  const { application, page, child } = context;
  await assertNoExternal(context);
  await finishTrace(context);
  const exit = child.exitCode === null ? once(child, 'exit') : Promise.resolve([child.exitCode, child.signalCode]);
  const closed = application.waitForEvent('close', { timeout: 15_000 });
  // The process may close the IPC channel before its successful exit reply.
  // Exit code and native close, not that reply, are the acceptance evidence.
  const request = page.evaluate(async () => {
    const state = await window.electronAPI.getStatus();
    return window.electronAPI.exitApp({ scope: { profileId: state.value.profileId, epoch: state.value.epoch } });
  }).catch((error) => {
    if (!/closed|destroyed|Target|Session/i.test(error.message)) throw error;
  });
  const result = await Promise.race([exit, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Coordinated app exit deadline exceeded')), 15_000); timer.unref(); exit.finally(() => clearTimeout(timer)); })]);
  await closed;
  await request;
  expect(result).toEqual([0, null]);
}
async function cleanup(context) {
  if (!context) return;
  try {
    if (!context.page.isClosed() && typeof context.testInfo.outputPath === 'function') {
      await screenshot(context, 'last-runtime-state');
      const state = await context.page.evaluate(async () => ({ title: document.querySelector('h1')?.textContent,
        status: await window.electronAPI.getStatus(), profiles: await window.electronAPI.getProfiles() }));
      await context.testInfo.attach('last-public-state', { body: JSON.stringify(state, null, 2), contentType: 'application/json' });
      await finishTrace(context);
    }
  } finally {
    const child = context.child;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    if (context.keychain) keychainCommand(context.env, ['delete-keychain', context.keychain]);
    fs.rmSync(context.root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
}
async function navigate(page, name, title = name) {
  await page.locator('aside').getByRole('button', { name, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeFocused();
}

module.exports = { launch, cleanup, rpc, envelope, scope, waitState, unusedPort, invalidSender, screenshot,
  assertNoExternal, exitNormally, navigate, executableArchitectures };
