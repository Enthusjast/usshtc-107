'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAutostartService } = require('../../electron/autostart-service');

const APP_ID = 'com.ustc.usshtc107';
const EXE = 'C:\\Program Files\\usshtc107\\usshtc107.exe';
const unavailable = { supported: false, enabled: false, approvalRequired: false, errorCode: 'AUTOSTART_UNAVAILABLE' };
const state = (enabled = false, approvalRequired = false, errorCode = null) => ({ supported: true, enabled, approvalRequired, errorCode });
// POSIX permission bits and directory fsync are exercised on Linux/macOS;
// Windows/macOS login registration above always uses injected native adapters.
const linuxTest = process.platform === 'win32' ? test.skip : test;
function nativeFixture(platform, initial = {}) {
  const queries = [];
  const changes = [];
  let current = initial;
  const app = {
    isPackaged: true,
    getLoginItemSettings(options) { queries.push(options); return current; },
    setLoginItemSettings(options) {
      changes.push(options);
      current = platform === 'darwin' ? { status: options.openAtLogin ? 'enabled' : 'not-registered' }
        : { launchItems: options.openAtLogin ? [{ name: APP_ID, path: EXE, args: ['--autostart'], scope: 'user', enabled: options.enabled }] : [] };
    },
  };
  const service = createAutostartService({ platform, app, executablePath: EXE });
  return { app, service, queries, changes, setCurrent(value) { current = value; } };
}
function linuxFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc107-autostart-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, options.filename || 'usshtc107');
  fs.writeFileSync(executable, 'test-only executable fixture', { mode: 0o700 });
  const config = path.join(root, 'config');
  const desktop = path.join(config, 'autostart', 'usshtc107.desktop');
  const deps = {
    platform: 'linux', app: { isPackaged: true }, homePath: root,
    executablePath: executable, env: { XDG_CONFIG_HOME: config },
  };
  const service = createAutostartService(deps);
  return { root, executable, config, desktop, deps, service };
}
function instrument(overrides) {
  return new Proxy(fs, {
    get(target, key) { return overrides[key] || target[key]; },
  });
}
function writeDesktop(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, text, { mode: 0o600 });
}

for (const platform of ['win32', 'darwin', 'linux', 'freebsd']) {
  test(`${platform} development runtime never queries or registers OS startup`, async () => {
    let calls = 0;
    const trap = () => { calls++; throw new Error('must not access OS'); };
    const service = createAutostartService({
      platform, app: { isPackaged: false, getLoginItemSettings: trap, setLoginItemSettings: trap },
      fs: new Proxy({}, { get: () => trap }), env: {}, homePath: '/fixture', executablePath: '/fixture/app',
    });
    assert.deepEqual(await service.getStatus(), unavailable);
    await assert.rejects(service.setEnabled(true), { code: 'AUTOSTART_UNAVAILABLE' });
    assert.equal(calls, 0);
  });
}

test('unsupported packaged platform is unavailable without native requests', async () => {
  const service = createAutostartService({ platform: 'freebsd', app: { isPackaged: true } });
  assert.deepEqual(await service.getStatus(), unavailable);
  await assert.rejects(service.setEnabled(false), { code: 'AUTOSTART_UNAVAILABLE' });
});

test('Windows reports own Task Manager enabled state, never openAtLogin or another launch item', async () => {
  const f = nativeFixture('win32', {
    openAtLogin: true, executableWillLaunchAtLogin: true,
    launchItems: [
      { name: APP_ID, path: EXE, args: ['--autostart'], scope: 'user', enabled: false },
      { name: 'some.other.app', path: EXE, args: ['--autostart'], scope: 'user', enabled: true },
      { name: APP_ID, path: 'C:\\Other\\app.exe', args: ['--autostart'], scope: 'user', enabled: true },
      { name: APP_ID, path: EXE, args: [], scope: 'user', enabled: true },
      { name: APP_ID, path: EXE, args: ['--autostart', '--extra'], scope: 'user', enabled: true },
      { name: APP_ID, path: EXE, args: ['--autostart'], scope: 'machine', enabled: true },
    ],
  });
  assert.deepEqual(await f.service.getStatus(), state(false));
  assert.deepEqual(f.queries, [{ path: EXE, args: ['--autostart'] }]);
  assert.equal(f.changes.length, 0);
  f.setCurrent({ openAtLogin: false, launchItems: [{ name: APP_ID, path: EXE.toUpperCase(), args: ['--autostart'], scope: 'user', enabled: true }] });
  assert.deepEqual(await f.service.getStatus(), state(true));
});

test('Windows sets fixed app ID and real NSIS executable with matching arguments and approval flag', async () => {
  const f = nativeFixture('win32', { launchItems: [] });
  assert.deepEqual(await f.service.setEnabled(true), state(true));
  assert.deepEqual(await f.service.setEnabled(false), state(false));
  assert.deepEqual(f.changes, [true, false].map(enabled => ({ name: APP_ID, path: EXE, args: ['--autostart'], openAtLogin: enabled, enabled })));
  assert.ok(f.queries.every(query => query.path === EXE && query.args.join() === '--autostart'));
  assert.doesNotMatch(JSON.stringify(f.changes), /Update\.exe|stub/i);
});

test('Windows missing launchItems is unavailable rather than using openAtLogin', async () => {
  const f = nativeFixture('win32', { openAtLogin: true });
  assert.deepEqual(await f.service.getStatus(), state(false, false, 'AUTOSTART_UNAVAILABLE'));
});

test('Windows OS denial after a setter is a fixed failure, not a fake success', async () => {
  const f = nativeFixture('win32', { launchItems: [] });
  f.app.setLoginItemSettings = () => {};
  await assert.rejects(f.service.setEnabled(true), { code: 'AUTOSTART_FAILED', message: 'AUTOSTART_FAILED' });
});

for (const [nativeStatus, enabled, approvalRequired] of [
  ['enabled', true, false], ['requires-approval', false, true],
  ['not-registered', false, false], ['not-found', false, false],
]) {
  test(`macOS ${nativeStatus} reflects registration, not launch origin`, async () => {
    const f = nativeFixture('darwin', { status: nativeStatus, wasOpenedAtLogin: !enabled, openAtLogin: !enabled });
    assert.deepEqual(await f.service.getStatus(), state(enabled, approvalRequired));
    assert.deepEqual(f.queries, [{ type: 'mainAppService' }]);
    assert.equal(f.changes.length, 0);
  });
}

test('macOS user approval is a successful pending OS registration, not enabled startup', async () => {
  const f = nativeFixture('darwin', { status: 'not-registered' });
  f.app.setLoginItemSettings = options => {
    f.changes.push(options);
    f.setCurrent({ status: options.openAtLogin ? 'requires-approval' : 'not-registered' });
  };
  assert.deepEqual(await f.service.setEnabled(true), state(false, true));
  assert.deepEqual(await f.service.setEnabled(false), state(false));
  assert.deepEqual(f.changes, [{ type: 'mainAppService', openAtLogin: true }, { type: 'mainAppService', openAtLogin: false }]);
});

test('native unknown status and missing APIs fail closed without disclosing native exceptions', async () => {
  const f = nativeFixture('darwin', { status: 'surprise', openAtLogin: true });
  assert.deepEqual(await f.service.getStatus(), state(false, false, 'AUTOSTART_UNAVAILABLE'));
  f.app.getLoginItemSettings = () => { throw new Error('private account and path'); };
  assert.deepEqual(await f.service.getStatus(), state(false, false, 'AUTOSTART_FAILED'));
  await assert.rejects(f.service.setEnabled(true), { code: 'AUTOSTART_FAILED', message: 'AUTOSTART_FAILED' });
  const missing = createAutostartService({ app: { isPackaged: true }, platform: 'darwin' });
  assert.deepEqual(await missing.getStatus(), state(false, false, 'AUTOSTART_UNAVAILABLE'));
});

test('setEnabled rejects nonbooleans without accessing native settings', async () => {
  const f = nativeFixture('win32');
  for (const input of [undefined, null, 0, 1, 'true', {}, []]) {
    await assert.rejects(f.service.setEnabled(input), { code: 'INVALID_ARGUMENT' });
  }
  assert.deepEqual(f.queries, []);
  assert.deepEqual(f.changes, []);
});

linuxTest('Linux startup status is read-only and follows actual owned file, not preference state', async t => {
  const f = linuxFixture(t);
  assert.deepEqual(await f.service.getStatus(), state(false));
  assert.equal(fs.existsSync(f.config), false);
  assert.deepEqual(await f.service.setEnabled(true), state(true));
  const content = fs.readFileSync(f.desktop, 'utf8');
  assert.match(content, /^\[Desktop Entry\]\nType=Application\nName=usshtc107\n/);
  assert.match(content, /X-usshtc107-Managed=true\n$/);
  assert.equal(fs.statSync(f.desktop).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(f.desktop)).mode & 0o777, 0o700);
  fs.writeFileSync(f.desktop, `${content}Hidden=true\n`);
  assert.deepEqual(await f.service.getStatus(), state(false));
  await f.service.setEnabled(true);
  assert.deepEqual(await f.service.getStatus(), state(true));
  assert.deepEqual(await f.service.setEnabled(false), state(false));
  assert.equal(fs.existsSync(f.desktop), false);
  assert.deepEqual(await f.service.setEnabled(false), state(false));
});

linuxTest('Linux falls back from relative XDG_CONFIG_HOME to the injected home config directory', async t => {
  const f = linuxFixture(t);
  const service = createAutostartService({ ...f.deps, env: { XDG_CONFIG_HOME: 'relative-config' } });
  await service.setEnabled(true);
  assert.equal(fs.existsSync(path.join(f.root, '.config', 'autostart', 'usshtc107.desktop')), true);
  assert.equal(fs.existsSync(f.desktop), false);
});

linuxTest('Linux quotes both Desktop Entry and Exec layers, expands no shell and escapes field codes', async t => {
  const f = linuxFixture(t, { filename: 'app "quoted" \\ $HOME `whoami` %U ; end' });
  await f.service.setEnabled(true);
  const line = fs.readFileSync(f.desktop, 'utf8').split('\n').find(value => value.startsWith('Exec=')).slice(5);
  assert.ok(line.endsWith('" --autostart'));
  assert.ok(line.includes('%%U'));
  assert.ok(line.includes('\\\\"quoted\\\\"'));
  assert.ok(line.includes('\\\\\\\\'));
  assert.ok(line.includes('\\\\$HOME'));
  assert.ok(line.includes('\\\\`whoami\\\\`'));
  // Independently undo Desktop Entry string escapes, then the quoted Exec
  // argument escapes and field-code percent escaping. No process is launched.
  const decoded = line.replace(/\\([\\sntr])/g, (_, character) => ({ '\\': '\\', s: ' ', n: '\n', t: '\t', r: '\r' })[character]);
  const argument = decoded.slice(1, -'" --autostart'.length).replace(/\\([\\"$`])/g, '$1').replace(/%%/g, '%');
  assert.equal(argument, f.executable);
  assert.deepEqual(await f.service.getStatus(), state(true));
});

linuxTest('Linux uses real AppImage path rather than the mounted executable and resolves symlinks', async t => {
  const f = linuxFixture(t);
  const appImage = path.join(f.root, 'Real Application.AppImage');
  fs.writeFileSync(appImage, 'test-only AppImage fixture', { mode: 0o700 });
  const link = path.join(f.root, 'Application.AppImage');
  fs.symlinkSync(appImage, link);
  const service = createAutostartService({ ...f.deps, env: { ...f.deps.env, APPIMAGE: link } });
  await service.setEnabled(true);
  const content = fs.readFileSync(f.desktop, 'utf8');
  assert.ok(content.includes(`Exec="${appImage}" --autostart`));
  assert.ok(!content.includes(`Exec="${f.executable}"`));
});

for (const suffix of ['\nunsafe', '\runsafe', '\u0000unsafe', '=unsafe']) {
  linuxTest(`Linux refuses unsafe executable path ${JSON.stringify(suffix)}`, async t => {
    const f = linuxFixture(t);
    const service = createAutostartService({ ...f.deps, executablePath: f.executable + suffix });
    await assert.rejects(service.setEnabled(true), { code: 'AUTOSTART_UNAVAILABLE' });
    assert.equal(fs.existsSync(f.desktop), false);
  });
}

linuxTest('Linux missing or non-executable target cannot be registered', async t => {
  const f = linuxFixture(t);
  fs.chmodSync(f.executable, 0o600);
  await assert.rejects(f.service.setEnabled(true), { code: 'AUTOSTART_UNAVAILABLE' });
  fs.unlinkSync(f.executable);
  await assert.rejects(f.service.setEnabled(true), { code: 'AUTOSTART_UNAVAILABLE' });
  assert.equal(fs.existsSync(f.desktop), false);
});

for (const content of [
  '[Desktop Entry]\nType=Application\nExec=someone-else\n',
  '[Other Group]\nX-usshtc107-Managed=true\n',
  '[Desktop Entry]\nX-usshtc107-Managed=false\n',
  '[Desktop Entry]\nX-usshtc107-Managed=true\nX-usshtc107-Managed=true\n',
  '[Desktop Entry]\nX-usshtc107-Managed=true\n[Desktop Entry]\n',
  Buffer.from([0xff, 0xfe, 0x00]),
  'x'.repeat(64 * 1024 + 1),
]) {
  linuxTest(`Linux protects unowned or malformed desktop input (${typeof content === 'string' ? content.length : 'invalid UTF-8'})`, async t => {
    const f = linuxFixture(t);
    writeDesktop(f.desktop, content);
    const before = fs.readFileSync(f.desktop);
    assert.deepEqual(await f.service.getStatus(), state(false, false, 'AUTOSTART_CONFLICT'));
    await assert.rejects(f.service.setEnabled(true), { code: 'AUTOSTART_CONFLICT' });
    await assert.rejects(f.service.setEnabled(false), { code: 'AUTOSTART_CONFLICT' });
    assert.deepEqual(fs.readFileSync(f.desktop), before);
  });
}

linuxTest('Linux refuses symlink and nonregular desktop sources without touching their targets', async t => {
  const f = linuxFixture(t);
  const target = path.join(f.root, 'other.desktop');
  fs.writeFileSync(target, '[Desktop Entry]\nX-usshtc107-Managed=true\n');
  fs.mkdirSync(path.dirname(f.desktop), { recursive: true });
  fs.symlinkSync(target, f.desktop);
  await assert.rejects(f.service.setEnabled(true), { code: 'AUTOSTART_CONFLICT' });
  await assert.rejects(f.service.setEnabled(false), { code: 'AUTOSTART_CONFLICT' });
  assert.equal(fs.lstatSync(f.desktop).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(target, 'utf8'), '[Desktop Entry]\nX-usshtc107-Managed=true\n');
  fs.unlinkSync(f.desktop);
  fs.mkdirSync(f.desktop);
  await assert.rejects(f.service.setEnabled(true), { code: 'AUTOSTART_CONFLICT' });
});

linuxTest('Linux detects disabled GNOME startup and changed executable registration', async t => {
  const f = linuxFixture(t);
  await f.service.setEnabled(true);
  const original = fs.readFileSync(f.desktop, 'utf8');
  fs.writeFileSync(f.desktop, `${original}X-GNOME-Autostart-enabled=false\n`);
  assert.deepEqual(await f.service.getStatus(), state(false));
  fs.writeFileSync(f.desktop, original.replace(/^Exec=.*$/m, 'Exec="/different/application" --autostart'));
  assert.deepEqual(await f.service.getStatus(), state(false));
  await f.service.setEnabled(false);
  assert.equal(fs.existsSync(f.desktop), false);
});

linuxTest('Linux permissions are set on temporary fd before file fsync and replacement, never after rename', async t => {
  const f = linuxFixture(t);
  await f.service.setEnabled(true);
  const calls = [];
  const io = instrument({
    fchmodSync(fd, mode) { calls.push('fchmod'); return fs.fchmodSync(fd, mode); },
    chmodSync() { assert.fail('must not chmod path after replacement'); },
    fsyncSync(fd) { calls.push(fs.fstatSync(fd).isDirectory() ? 'directory-fsync' : 'file-fsync'); return fs.fsyncSync(fd); },
    renameSync(from, to) { calls.push('rename'); return fs.renameSync(from, to); },
  });
  await createAutostartService({ ...f.deps, fs: io }).setEnabled(true);
  assert.deepEqual(calls, ['fchmod', 'file-fsync', 'rename', 'directory-fsync']);
  assert.deepEqual(fs.readdirSync(path.dirname(f.desktop)), ['usshtc107.desktop']);
});

linuxTest('Linux permission errors are fixed unavailable results and do not overwrite an owned file', async t => {
  const f = linuxFixture(t);
  await f.service.setEnabled(true);
  const before = fs.readFileSync(f.desktop);
  const io = instrument({ fchmodSync() { const error = new Error('private path denied'); error.code = 'EACCES'; throw error; } });
  await assert.rejects(createAutostartService({ ...f.deps, fs: io }).setEnabled(true), { code: 'AUTOSTART_UNAVAILABLE', message: 'AUTOSTART_UNAVAILABLE' });
  assert.deepEqual(fs.readFileSync(f.desktop), before);
  assert.deepEqual(fs.readdirSync(path.dirname(f.desktop)), ['usshtc107.desktop']);
  const queryIO = instrument({ lstatSync() { const error = new Error('private path denied'); error.code = 'EPERM'; throw error; } });
  assert.deepEqual(await createAutostartService({ ...f.deps, fs: queryIO }).getStatus(), state(false, false, 'AUTOSTART_UNAVAILABLE'));
});

linuxTest('Linux no-replace creation preserves a competing application file', async t => {
  const f = linuxFixture(t);
  const competing = '[Desktop Entry]\nExec=other-app\n';
  const io = instrument({
    linkSync(from, to) { fs.writeFileSync(to, competing); return fs.linkSync(from, to); },
  });
  await assert.rejects(createAutostartService({ ...f.deps, fs: io }).setEnabled(true), { code: 'AUTOSTART_CONFLICT' });
  assert.equal(fs.readFileSync(f.desktop, 'utf8'), competing);
  assert.deepEqual(fs.readdirSync(path.dirname(f.desktop)), ['usshtc107.desktop']);
});

linuxTest('Linux replacement rechecks ownership after staging', async t => {
  const f = linuxFixture(t);
  await f.service.setEnabled(true);
  const competing = '[Desktop Entry]\nExec=other-app\n';
  const io = instrument({
    fchmodSync(fd, mode) { fs.writeFileSync(f.desktop, competing); return fs.fchmodSync(fd, mode); },
  });
  await assert.rejects(createAutostartService({ ...f.deps, fs: io }).setEnabled(true), { code: 'AUTOSTART_CONFLICT' });
  assert.equal(fs.readFileSync(f.desktop, 'utf8'), competing);
});

linuxTest('Linux post-replacement fsync failure is reported while actual state remains queryable for parent rollback', async t => {
  const f = linuxFixture(t);
  const io = instrument({
    fsyncSync(fd) {
      if (fs.fstatSync(fd).isDirectory()) { const error = new Error('directory durability failure'); error.code = 'EIO'; throw error; }
      return fs.fsyncSync(fd);
    },
  });
  const service = createAutostartService({ ...f.deps, fs: io });
  await assert.rejects(service.setEnabled(true), { code: 'AUTOSTART_FAILED' });
  assert.deepEqual(await f.service.getStatus(), state(true));
  // The root-commit owner can restore previous OS state even when apply rejected.
  assert.deepEqual(await f.service.setEnabled(false), state(false));
});

linuxTest('Linux deletion durability failure never pretends OS state is still enabled', async t => {
  const f = linuxFixture(t);
  await f.service.setEnabled(true);
  const io = instrument({ fsyncSync() { throw new Error('private directory failed'); } });
  await assert.rejects(createAutostartService({ ...f.deps, fs: io }).setEnabled(false), { code: 'AUTOSTART_FAILED' });
  assert.deepEqual(await f.service.getStatus(), state(false));
  await f.service.setEnabled(true);
  assert.deepEqual(await f.service.getStatus(), state(true));
});

test('native permission failures disclose no OS exception detail', async () => {
  const f = nativeFixture('win32', { launchItems: [] });
  f.app.setLoginItemSettings = () => { const error = new Error('private registry account'); error.code = 'EACCES'; throw error; };
  await assert.rejects(f.service.setEnabled(true), { code: 'AUTOSTART_UNAVAILABLE', message: 'AUTOSTART_UNAVAILABLE' });
});

test('parent can restore native OS state after a partially mutating setter rejects', async () => {
  const f = nativeFixture('win32', { launchItems: [] });
  const nativeSet = f.app.setLoginItemSettings;
  f.app.setLoginItemSettings = options => {
    nativeSet(options);
    throw new Error('private native failure after OS mutation');
  };
  await assert.rejects(f.service.setEnabled(true), { code: 'AUTOSTART_FAILED' });
  assert.deepEqual(await f.service.getStatus(), state(true));
  f.app.setLoginItemSettings = nativeSet;
  assert.deepEqual(await f.service.setEnabled(false), state(false));
});

linuxTest('Linux refuses a symlink autostart directory for both reads and deletion', async t => {
  const f = linuxFixture(t);
  const other = path.join(f.root, 'other-autostart');
  fs.mkdirSync(other);
  const target = path.join(other, 'usshtc107.desktop');
  const original = '[Desktop Entry]\nX-usshtc107-Managed=true\n';
  fs.writeFileSync(target, original);
  fs.mkdirSync(f.config);
  fs.symlinkSync(other, path.dirname(f.desktop));
  assert.deepEqual(await f.service.getStatus(), state(false, false, 'AUTOSTART_CONFLICT'));
  await assert.rejects(f.service.setEnabled(false), { code: 'AUTOSTART_CONFLICT' });
  await assert.rejects(f.service.setEnabled(true), { code: 'AUTOSTART_CONFLICT' });
  assert.equal(fs.readFileSync(target, 'utf8'), original);
});

linuxTest('Linux relative AppImage path is rejected rather than falling back to mounted executable', async t => {
  const f = linuxFixture(t);
  const service = createAutostartService({ ...f.deps, env: { ...f.deps.env, APPIMAGE: 'relative.AppImage' } });
  await assert.rejects(service.setEnabled(true), { code: 'AUTOSTART_UNAVAILABLE' });
  assert.equal(fs.existsSync(f.desktop), false);
});

linuxTest('Linux can remove owned startup when its executable no longer exists', async t => {
  const f = linuxFixture(t);
  await f.service.setEnabled(true);
  fs.unlinkSync(f.executable);
  assert.deepEqual(await f.service.getStatus(), state(false, false, 'AUTOSTART_UNAVAILABLE'));
  assert.deepEqual(await f.service.setEnabled(false), state(false));
});

linuxTest('AppImage rename updates only enabled owned Desktop Entry Exec after the old image has moved', async t => {
  const f = linuxFixture(t, { filename: 'usshtc107-1.2.1-linux-x86_64.AppImage' });
  await f.service.setEnabled(true);
  const original = fs.readFileSync(f.desktop, 'utf8').replaceAll('\n', '\r\n')
    + '# keep user additions\r\nOnlyShowIn=GNOME;\r\n[Desktop Action help]\r\nExec=/usr/bin/help\r\n';
  fs.writeFileSync(f.desktop, original);
  const next = path.join(f.root, 'usshtc107-1.3.0-linux-x86_64.AppImage');
  const plan = f.service.prepareAppImageUpdate(f.executable, next);
  assert.equal(plan.enabled, true);
  assert.equal(fs.readFileSync(f.desktop, 'utf8'), original);
  fs.renameSync(f.executable, next);
  assert.deepEqual(f.service.applyAppImageUpdate(plan), { updated: true });
  assert.equal(fs.readFileSync(f.desktop, 'utf8'), original.replace(/^Exec=[^\r\n]*/m, `Exec="${next}" --autostart`));
  assert.equal(fs.statSync(f.desktop).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(f.executable), false);
});

linuxTest('AppImage install never rewrites disabled or unrelated startup files', async t => {
  for (const mode of ['disabled', 'unrelated', 'absent', 'same-name']) {
    const f = linuxFixture(t, { filename: 'usshtc107-1.2.1-linux-x86_64.AppImage' });
    if (mode !== 'absent') await f.service.setEnabled(true);
    if (mode === 'disabled') fs.appendFileSync(f.desktop, 'Hidden=true\n');
    if (mode === 'unrelated') fs.writeFileSync(f.desktop, '[Desktop Entry]\nType=Application\nExec=/user/application\n');
    const before = fs.existsSync(f.desktop) ? fs.readFileSync(f.desktop) : null;
    const plan = f.service.prepareAppImageUpdate(f.executable, mode === 'same-name' ? f.executable : path.join(f.root, 'next.AppImage'));
    assert.equal(plan.enabled, false);
    assert.deepEqual(f.service.applyAppImageUpdate(plan), { updated: false });
    assert.deepEqual(fs.existsSync(f.desktop) ? fs.readFileSync(f.desktop) : null, before);
  }
});

linuxTest('a user disabling owned startup between preflight and rename is not re-enabled', async t => {
  const f = linuxFixture(t);
  await f.service.setEnabled(true);
  const plan = f.service.prepareAppImageUpdate(f.executable, path.join(f.root, 'next.AppImage'));
  fs.appendFileSync(f.desktop, 'X-GNOME-Autostart-enabled=false\n');
  const before = fs.readFileSync(f.desktop);
  assert.deepEqual(f.service.applyAppImageUpdate(plan), { updated: false });
  assert.deepEqual(fs.readFileSync(f.desktop), before);
});

linuxTest('AppImage startup preflight rejects unwritable directory or an out-of-directory target before installation', async t => {
  const f = linuxFixture(t);
  await f.service.setEnabled(true);
  const io = instrument({ accessSync(target, flags) {
    if (target === path.dirname(f.desktop)) throw Object.assign(new Error('fixture denial'), { code: 'EACCES' });
    return fs.accessSync(target, flags);
  } });
  const service = createAutostartService({ ...f.deps, fs: io });
  assert.throws(() => service.prepareAppImageUpdate(f.executable, path.join(f.root, 'next.AppImage')), { code: 'AUTOSTART_UPDATE_FAILED' });
  assert.throws(() => f.service.prepareAppImageUpdate(f.executable, path.join(f.root, 'other', 'next.AppImage')), { code: 'AUTOSTART_UPDATE_FAILED' });
});

linuxTest('startup rewrite failure preserves actual renamed image and never claims the previous path still exists', async t => {
  const f = linuxFixture(t);
  await f.service.setEnabled(true);
  const before = fs.readFileSync(f.desktop);
  const service = createAutostartService({ ...f.deps, fs: instrument({ renameSync() { throw Object.assign(new Error('fixture rename failure'), { code: 'EIO' }); } }) });
  const next = path.join(f.root, 'next.AppImage');
  const plan = service.prepareAppImageUpdate(f.executable, next);
  fs.renameSync(f.executable, next);
  assert.throws(() => service.applyAppImageUpdate(plan), { code: 'AUTOSTART_UPDATE_FAILED' });
  assert.equal(fs.existsSync(next), true);
  assert.equal(fs.existsSync(f.executable), false);
  assert.deepEqual(fs.readFileSync(f.desktop), before);
});
