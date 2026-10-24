'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { parseArgs, loadConfig } = require('../cli/config.cjs');
const { startService } = require('../cli/service.cjs');
const { run } = require('../cli/main.cjs');
const { shellFixture } = require('./cli-helpers.cjs');

function capture() {
  let content = '';
  return { write(value) { content += value; }, get value() { return content; } };
}
async function temporary(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usshtc-cli-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function child(args, env = {}) {
  return new Promise((resolve, reject) => {
    const process = spawn(require('node:process').execPath, [path.resolve('cli/main.cjs'), ...args], {
      env: { ...require('node:process').env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    process.stdout.on('data', bytes => { stdout += bytes; });
    process.stderr.on('data', bytes => { stderr += bytes; });
    process.once('error', reject);
    process.once('close', code => resolve({ code, stdout, stderr }));
  });
}

test('CLI executable prints help/version without Electron or credentials', async () => {
  const help = await child(['--help'], { SCOW_TOKEN: '' });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /Usage: usshtc107/);
  assert.match(help.stdout, /get\/put connect to an already running proxy/);
  assert.equal(help.stderr, '');
  const version = await child(['--version']);
  assert.equal(version.code, 0);
  assert.equal(version.stdout.trim(), require('../package.json').version);
  assert.ok(!Object.keys(require.cache).some(file => /node_modules[/\\]electron[/\\]/.test(file)));
});

test('CLI parses default serve, explicit commands, options and dash-prefixed operands', () => {
  assert.equal(parseArgs([]).command, 'serve');
  assert.deepEqual(parseArgs(['put', '--port=3022', '--', '-local', "remote ' path"]).operands, ['-local', "remote ' path"]);
  assert.equal(parseArgs(['--host', '::1', 'serve']).values.host, '::1');
  for (const args of [['get'], ['serve', 'unexpected'], ['--unknown', 'SECRET'], ['--port'], ['--port', '3', '--port', '4']]) {
    assert.throws(() => parseArgs(args), { code: 'CLI_USAGE' });
  }
});

test('CLI reuses schema, accepts strict JSON and applies command-line precedence', async t => {
  const root = await temporary(t);
  const config = path.join(root, 'cli.json');
  await fs.writeFile(config, JSON.stringify({ port: 3001, host: '::1', cluster: 'test-cluster', loginNode: 'node.example', dataDir: root, sshDirectory: path.join(root, 'ssh') }));
  const options = await loadConfig(parseArgs(['--config', config, '--port', '3002']), { SCOW_TOKEN: 'opaque-token' });
  assert.equal(options.port, 3002);
  assert.equal(options.host, '::1');
  assert.equal(options.cluster, 'test-cluster');
  assert.equal(options.cookie, 'SCOW_USER=opaque-token');
  assert.equal(options.maxBytes, 64 * 1024 * 1024);
  assert.equal(options.timeoutMs, 600000);
  assert.equal(options.dataDir, root);
});

test('CLI fails closed on invalid JSON, unknown fields, invalid schema and unsafe limits', async t => {
  const root = await temporary(t);
  const config = path.join(root, 'cli.json');
  for (const content of ['{', 'null', '[]', '{"cookie":"secret"}', '{"host":"a;evil"}', '{"port":0}', '{"port":65536}', '{"cluster":"x\\ny"}', '{"maxBytes":67108865}', '{"timeoutMs":0}', '{"dataDir":12}']) {
    await fs.writeFile(config, content);
    await assert.rejects(loadConfig(parseArgs(['--config', config]), { SCOW_TOKEN: 'SECRET' }), { code: 'CLI_CONFIG' });
  }
  await fs.writeFile(config, ' '.repeat(65537));
  await assert.rejects(loadConfig(parseArgs(['--config', config]), { SCOW_TOKEN: 'SECRET' }), { code: 'CLI_CONFIG' });
  await assert.rejects(loadConfig(parseArgs([]), {}), { code: 'CLI_COOKIE_REQUIRED' });
  await assert.rejects(loadConfig(parseArgs([]), { SCOW_TOKEN: 'token\r\nInjected: true' }), { code: 'CLI_CONFIG' });
});

test('CLI never prints secret-bearing upstream errors or argv values', async () => {
  const stdout = capture();
  const stderr = capture();
  const secret = 'unique-sensitive-cookie-command-output';
  const code = await run(['--cookie', secret], {
    stdout, stderr, env: {},
    startService: async () => { throw new Error(secret); },
  });
  assert.equal(code, 1);
  assert.match(stderr.value, /visible in process arguments/);
  assert.ok(!`${stdout.value}${stderr.value}`.includes(secret));
  assert.match(stderr.value, /no sensitive diagnostic details/);
});

test('CLI serve awaits graceful stop for both SIGINT and SIGTERM', async () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const signals = new EventEmitter();
    const proxy = new EventEmitter();
    const stdout = capture();
    const stderr = capture();
    let stopped = false;
    let stopPromise;
    const running = run(['serve'], {
      stdout, stderr, signals, env: { SCOW_TOKEN: 'secret' },
      startService: async () => {
        setImmediate(() => signals.emit(signal));
        return { proxy, stop: () => (stopPromise ||= new Promise(resolve => setTimeout(() => { stopped = true; resolve(); }, 10))) };
      },
    });
    assert.equal(await running, 0);
    assert.equal(stopped, true);
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
  }
});

test('CLI distinguishes readiness silence from authentication rejection without invalidating cookies', async () => {
  const signals = new EventEmitter();
  const proxy = new EventEmitter();
  const stderr = capture();
  const code = await run(['serve', '--host', '0.0.0.0'], {
    stdout: capture(), stderr, signals, env: { SCOW_TOKEN: 'secret' },
    startService: async () => {
      setImmediate(() => { proxy.emit('remote-not-ready', { code: 'REMOTE_READY_TIMEOUT' }); signals.emit('SIGTERM'); });
      return { proxy, stop: async () => {} };
    },
  });
  assert.equal(code, 0);
  assert.match(stderr.value, /non-loopback/);
  assert.match(stderr.value, /REMOTE_READY_TIMEOUT/);
  assert.match(stderr.value, /credentials were not invalidated/);
  assert.ok(!stderr.value.includes('Authentication rejected'));
});

test('CLI service persists stable host/client keys and stops the real local listener', async t => {
  const root = await temporary(t);
  const options = { port: 0, host: '127.0.0.1', cookie: 'SCOW_USER=test', dataDir: path.join(root, 'data'), sshDirectory: path.join(root, 'ssh') };
  const first = await startService(options);
  t.after(() => first.stop());
  const fingerprint = first.client.fingerprint;
  const hostKey = first.hostKey;
  assert.ok(first.proxy._server.listening);
  await Promise.all([first.stop(), first.stop()]);
  const second = await startService(options);
  t.after(() => second.stop());
  assert.equal(second.client.fingerprint, fingerprint);
  assert.deepEqual(second.hostKey, hostKey);
  if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(options.dataDir, 'proxy_host_ed25519'))).mode & 0o777, 0o600);
  await second.stop();
  assert.equal(second.proxy._server, null);
});

(process.platform === 'win32' ? test.skip : test)('CLI get/put entrypoints use authenticated pinned SSH and verify binary content', async t => {
  const fixture = await shellFixture(t);
  const local = path.join(fixture.local, 'input');
  const output = path.join(fixture.local, 'output');
  const bytes = Buffer.from([0, 255, 128, 10, 13, 0, 42]);
  await fs.writeFile(local, bytes);
  const common = ['--port', String(fixture.port), '--data-dir', fixture.root, '--ssh-directory', path.join(fixture.root, 'ssh')];
  // The fixture's host file is installed at the same stable path the CLI uses.
  await fs.writeFile(path.join(fixture.root, 'proxy_host_ed25519'), fixture.hostKey, { mode: 0o600 });
  const put = await child(['put', ...common, '--', local, 'remote-file']);
  assert.equal(put.code, 0, put.stderr);
  assert.match(put.stdout, /SHA-256 verified/);
  const get = await child(['get', ...common, '--', 'remote-file', output]);
  assert.equal(get.code, 0, get.stderr);
  assert.deepEqual(await fs.readFile(output), bytes);
});

test('CLI exposes validated remote path, canonical tmux startup and opt-in health configuration', async t => {
  const root = await temporary(t);
  const config = path.join(root, 'profile.json');
  await fs.writeFile(config, JSON.stringify({ path: '/remote directory', startupCommand: 'tmux new -A -s usshtc', healthProbeEnabled: true }));
  const options = await loadConfig(parseArgs(['--config', config]), { SCOW_TOKEN: 'secret' });
  assert.equal(options.path, '/remote directory');
  assert.equal(options.startupCommand, 'tmux new -A -s usshtc');
  assert.equal(options.healthProbeEnabled, true);
  const overridden = await loadConfig(parseArgs(['--config', config, '--path', '/different path', '--startup-command', 'tmux new -A -s usshtc', '--health-probe', 'false']), { SCOW_TOKEN: 'secret' });
  assert.equal(overridden.path, '/different path');
  assert.equal(overridden.healthProbeEnabled, false);
  await assert.rejects(loadConfig(parseArgs(['--startup-command', 'rm -rf /']), { SCOW_TOKEN: 'secret' }), { code: 'CLI_CONFIG' });
  await assert.rejects(loadConfig(parseArgs(['--path', '/bad\npath']), { SCOW_TOKEN: 'secret' }), { code: 'CLI_CONFIG' });
  await assert.rejects(loadConfig(parseArgs(['--health-probe', 'sometimes']), { SCOW_TOKEN: 'secret' }), { code: 'CLI_CONFIG' });
  assert.equal((await loadConfig(parseArgs([]), { SCOW_TOKEN: 'secret' })).healthProbeEnabled, false);
});

test('CLI opt-in health service schedules without opening an immediate remote session and disposes on stop', async t => {
  const root = await temporary(t);
  const service = await startService({ port: 0, host: '127.0.0.1', cookie: 'SCOW_USER=secret',
    dataDir: path.join(root, 'data'), sshDirectory: path.join(root, 'ssh'), healthProbeEnabled: true });
  t.after(() => service.stop());
  assert.ok(service.port > 0);
  assert.equal(service.proxy.getStats().sessionCount, 0);
  await service.stop();
  assert.equal(service.proxy._server, null);
});

test('CLI health cancels in-flight work and future scheduling only for active-session current-generation readiness timeout', async t => {
  const root = await temporary(t);
  let now = 0;
  let timerId = 0;
  const timers = new Map();
  const clock = {
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, deadline: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(milliseconds) {
      now += milliseconds;
      for (;;) {
        const next = [...timers].filter(([, value]) => value.deadline <= now)
          .sort((left, right) => left[1].deadline - right[1].deadline)[0];
        if (!next) return;
        timers.delete(next[0]);
        next[1].callback();
      }
    },
  };
  class ScopedProxy extends EventEmitter {
    constructor(options) { super(); this.cookie = options.cookie; this.host = options.host; this.port = options.port; }
    async start() { this.emit('started', { host: this.host, port: this.port }); }
    async stop() { this.emit('stopped'); }
    getCookieGeneration() { return 7; }
    getSessions() { return [{ id: 41 }]; }
  }
  const service = await startService({ port: 0, host: '127.0.0.1', cookie: 'SCOW_USER=unchanged',
    dataDir: path.join(root, 'data'), sshDirectory: path.join(root, 'ssh'), healthProbeEnabled: true },
  { ProxyServerClass: ScopedProxy, healthClock: clock });
  t.after(() => service.stop());
  const states = [];
  service.proxy.on('health-state', state => states.push(state));
  const identityProvider = t.mock.method(require('../electron/ssh-key-service'), 'getSsh2ClientIdentity', () => {
    throw new Error('Cancelled health work must not acquire an SSH identity');
  });
  assert.equal(timers.size, 1, 'one periodic observation is initially scheduled');
  service.proxy.emit('remote-not-ready', { code: 'REMOTE_READY_TIMEOUT', sessionId: 41, cookieGeneration: 6 });
  service.proxy.emit('remote-not-ready', { code: 'REMOTE_READY_TIMEOUT', sessionId: 999, cookieGeneration: 7 });
  assert.equal(timers.size, 1, 'stale generation and retired session cannot inhibit health');
  clock.advance(60000);
  assert.equal(states.at(-1).remoteStatus, 'checking');
  assert.equal(timers.size, 1, 'the active observation owns its bounded deadline');
  // execute() is waiting for its asynchronous key-provider continuation here.
  // Cancelling now must prevent it reaching SSH, not merely hide its result.
  service.proxy.emit('remote-not-ready', { code: 'REMOTE_READY_TIMEOUT', sessionId: 41, cookieGeneration: 7 });
  assert.equal(states.at(-1).errorCode, 'REMOTE_READY_TIMEOUT');
  assert.equal(states.at(-1).remoteStatus, 'error');
  assert.equal(timers.size, 0, 'in-flight deadline and future probe timers are cancelled');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(identityProvider.mock.callCount(), 0, 'cancellation stops work before SSH identity acquisition');
  clock.advance(3 * 60000);
  assert.equal(timers.size, 0);
  assert.equal(states.filter(state => state.remoteStatus === 'checking').length, 1);
  assert.equal(states.at(-1).errorCode, 'REMOTE_READY_TIMEOUT', 'cancelled continuations cannot overwrite inhibition');
  assert.equal(service.proxy.cookie, 'SCOW_USER=unchanged');
  assert.equal(service.proxy.getCookieGeneration(), 7);
  await service.stop();
  service.proxy.emit('remote-not-ready', { code: 'REMOTE_READY_TIMEOUT', sessionId: 41, cookieGeneration: 7 });
  assert.equal(timers.size, 0);
});
