'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const { createHealthProbeService, HEALTH_PROBE_INTERVAL_MS } = require('../../electron/health-probe-service');
const { REMOTE_COMMAND_TIMEOUT_MS } = require('../../electron/remote-command-probe');

const flush = async () => { for (let index = 0; index < 40; index += 1) await Promise.resolve(); };
function fakeClock() {
  let now = 0;
  let id = 0;
  const timers = new Map();
  return {
    timers, now: () => now,
    setTimeout(fn, delay) { const handle = ++id; timers.set(handle, { at: now + delay, fn }); return handle; },
    clearTimeout(handle) { timers.delete(handle); },
    async tick(ms) {
      await flush();
      const target = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= target);
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn(); await flush();
      }
      now = target; await flush();
    },
  };
}

function fixture(options = {}) {
  const clock = fakeClock();
  const snapshot = { profileId: 'default', epoch: 1, proxyStatus: 'started', desiredRunning: true,
    operation: null, remoteStatus: 'unknown', errorCode: null };
  const preferences = { healthProbeEnabled: options.enabled === true };
  let cookie = 'SCOW_USER=private-health-cookie';
  let config = { host: '0.0.0.0', port: 2222, cluster: 'cluster-a', loginNode: 'node-a' };
  const wire = Buffer.from('fixture pinned SSH host wire');
  const hostFingerprint = `SHA256:${crypto.createHash('sha256').update(wire).digest('base64').replace(/=+$/, '')}`;
  const keys = { client: { state: 'ready' }, host: { state: 'ready', fingerprint: hostFingerprint } };
  const identity = { privateKey: Buffer.from('fixture private key') };
  const states = [], clients = [], commands = [], forbidden = [];
  let service;
  const deps = {
    clock, getSnapshot: () => snapshot, getPreferences: () => preferences,
    getConfig: () => config, getCookie: () => cookie,
    getKeys: options.getKeys || (() => keys), getClientIdentity: options.getClientIdentity || (() => identity),
    onRemoteState(value) { states.push(value); Object.assign(snapshot, value); service.update(); },
    requestStart: () => forbidden.push('start'), login: () => forbidden.push('login'),
    onAuthRequired: () => forbidden.push('auth'), deleteCookie: () => forbidden.push('delete'),
    adapters: { createSshClient() {
      const client = new EventEmitter();
      client.destroy = () => { client.destroyed = true; };
      client.connect = (connection) => {
        client.connection = connection;
        if (!options.hangHandshake) queueMicrotask(() => client.emit('ready'));
      };
      client.exec = (command, callback) => {
        commands.push({ at: clock.now(), command });
        const channel = new EventEmitter();
        channel.stderr = new EventEmitter();
        channel.destroy = () => { channel.destroyed = true; };
        channel.end = () => { channel.ended = true; };
        client.channel = channel;
        callback(null, channel);
        if (!options.hangCommand) queueMicrotask(() => {
          if (options.stdout) channel.emit('data', Buffer.from(options.stdout));
          if (options.stderr) channel.stderr.emit('data', Buffer.from(options.stderr));
          if (options.exit !== undefined) channel.emit('exit', options.exit, options.exitSignal);
          channel.emit('close', options.closeCode === undefined ? options.exit === undefined ? 0 : options.exit : options.closeCode,
            options.closeSignal);
        });
      };
      clients.push(client);
      return client;
    } },
  };
  service = createHealthProbeService(deps);
  return { service, deps, clock, snapshot, preferences, clients, commands, states, keys, identity, wire, forbidden,
    setCookie(value) { cookie = value; }, setConfig(value) { config = value; } };
}

async function begin(f) {
  f.service.update();
  await f.clock.tick(HEALTH_PROBE_INTERVAL_MS);
}

function stop(f) {
  f.service.dispose();
  assert.equal(f.clock.timers.size, 0);
  assert.deepEqual(f.forbidden, []);
}

test('health is opt-in, waits sixty seconds, and executes only true on the running pinned listener', async () => {
  const f = fixture();
  f.service.update(); f.service.resume();
  await f.clock.tick(120000);
  assert.equal(f.clients.length, 0);
  assert.equal(f.clock.timers.size, 0);
  f.preferences.healthProbeEnabled = true;
  f.snapshot.runningConfig = { host: '::', port: 3333 };
  f.service.update();
  await f.clock.tick(59999);
  assert.equal(f.clients.length, 0);
  await f.clock.tick(1);
  assert.equal(f.clients.length, 1);
  assert.equal(f.commands[0].command, 'true');
  const client = f.clients[0];
  assert.equal(client.connection.host, '::1');
  assert.equal(client.connection.port, 3333);
  assert.equal(client.connection.username, 'user');
  assert.strictEqual(client.connection.privateKey, f.identity.privateKey);
  assert.equal(client.connection.readyTimeout, REMOTE_COMMAND_TIMEOUT_MS);
  assert.equal(client.connection.hostVerifier(f.wire), true);
  assert.equal(client.connection.hostVerifier(Buffer.from('different host')), false);
  assert.equal(f.snapshot.remoteStatus, 'reachable');
  assert.equal(client.destroyed, true);
  assert.equal(client.channel.destroyed, true);
  await f.clock.tick(59999);
  assert.equal(f.clients.length, 1);
  await f.clock.tick(1);
  assert.equal(f.clients.length, 2);
  assert.equal(JSON.stringify(f.states).includes('private'), false);
  stop(f);
});

test('health single-flight spans handshake and command; every observation has a total time bound', async () => {
  for (const stage of ['hangHandshake', 'hangCommand']) {
    const f = fixture({ enabled: true, [stage]: true });
    await begin(f);
    for (let index = 0; index < 10; index += 1) f.service.update();
    await f.clock.tick(REMOTE_COMMAND_TIMEOUT_MS - 1);
    assert.equal(f.clients.length, 1);
    assert.equal(f.snapshot.remoteStatus, 'checking');
    await f.clock.tick(1);
    assert.equal(f.clients[0].destroyed, true);
    assert.equal(f.snapshot.remoteStatus, 'error');
    assert.equal(f.snapshot.errorCode, 'TIMEOUT');
    await f.clock.tick(HEALTH_PROBE_INTERVAL_MS - 1);
    assert.equal(f.clients.length, 1);
    await f.clock.tick(1);
    assert.equal(f.clients.length, 2);
    stop(f);
  }
});

test('only exact numeric exit zero succeeds; failed, signalled, absent and output-spoofed results fail', async () => {
  for (const options of [
    { exit: 0 }, { closeCode: 0 }, { exit: 1 }, { exit: 255 }, { exit: '0' },
    { closeCode: null }, { exit: 0, exitSignal: 'TERM' }, { exit: 0, closeSignal: 'TERM' },
    { exit: 0, stdout: 'untrusted-output' }, { exit: 0, stderr: 'x'.repeat(4097) },
  ]) {
    const f = fixture({ enabled: true, ...options });
    await begin(f);
    const success = (options.exit === 0 || options.closeCode === 0)
      && !options.stdout && !options.stderr && !options.exitSignal && !options.closeSignal;
    assert.equal(f.snapshot.remoteStatus, success ? 'reachable' : 'error', JSON.stringify(options).slice(0, 100));
    assert.equal(f.snapshot.errorCode, success ? null : 'REMOTE_COMMAND_FAILED');
    assert.equal(JSON.stringify(f.states).includes('untrusted-output'), false);
    stop(f);
  }
});

test('stopped, starting, busy, missing-auth and locked contexts never start a listener or a health SSH session', async () => {
  for (const mutate of [
    (f) => { f.snapshot.proxyStatus = 'stopped'; },
    (f) => { f.snapshot.proxyStatus = 'starting'; },
    (f) => { f.snapshot.desiredRunning = false; },
    (f) => { f.snapshot.operation = 'logging_in'; },
    (f) => { f.snapshot.storageErrorCode = 'SETTINGS_LOCKED'; },
    (f) => { f.snapshot.remoteStatus = 'auth_required'; f.snapshot.errorCode = 'AUTH_REQUIRED'; },
    (f) => f.setCookie(''),
  ]) {
    const f = fixture({ enabled: true }); mutate(f);
    await begin(f); await f.clock.tick(120000);
    assert.equal(f.clients.length, 0);
    assert.equal(f.clock.timers.size, 0);
    stop(f);
  }
});

test('scope, config, authentication, preference, suspend, stop and shutdown abort resources and discard late results', async () => {
  for (const mutate of [
    (f) => { f.snapshot.epoch += 1; f.service.update(); },
    (f) => { f.snapshot.profileId = 'other'; f.service.update(); },
    (f) => { f.setConfig({ host: '127.0.0.1', port: 4444 }); f.service.update(); },
    (f) => { f.setCookie('SCOW_USER=new-auth'); f.service.update(); },
    (f) => { f.setCookie(''); f.service.update(); },
    (f) => { f.preferences.healthProbeEnabled = false; f.service.update(); },
    (f) => { f.snapshot.proxyStatus = 'stopped'; f.service.update(); },
    (f) => f.service.suspend(),
    (f) => f.service.cancel('changing_keys'),
    (f) => f.service.dispose(),
  ]) {
    const f = fixture({ enabled: true, hangCommand: true });
    await begin(f);
    const old = f.clients[0];
    assert.equal(f.snapshot.remoteStatus, 'checking');
    mutate(f);
    assert.equal(old.destroyed, true);
    assert.equal(old.channel.destroyed, true);
    const states = f.states.length;
    old.channel.emit('exit', 0); old.channel.emit('close', 0);
    old.emit('ready'); old.emit('error', new Error('private stale failure'));
    await flush();
    assert.equal(f.states.length, states);
    assert.equal(f.commands.length, 1);
    stop(f);
  }
});

test('suspend and explicit pause stay idle until resume, which waits a fresh interval', async () => {
  const f = fixture({ enabled: true, hangCommand: true });
  await begin(f);
  f.service.suspend();
  assert.equal(f.snapshot.remoteStatus, 'unknown');
  f.service.update(); await f.clock.tick(120000);
  assert.equal(f.clients.length, 1);
  f.service.resume(); await f.clock.tick(59999);
  assert.equal(f.clients.length, 1);
  await f.clock.tick(1);
  assert.equal(f.clients.length, 2);
  f.service.cancel('changing_keys');
  f.service.update(); await f.clock.tick(120000);
  assert.equal(f.clients.length, 2);
  f.service.resume(); await f.clock.tick(60000);
  assert.equal(f.clients.length, 3);
  stop(f);
});

test('untrusted key state never opens SSH and an unresponsive identity provider is bounded', async () => {
  const f = fixture({ enabled: true });
  f.keys.host.state = 'changed';
  f.keys.host.errorCode = 'SSH_KEY_FINGERPRINT_MISMATCH';
  await begin(f);
  assert.equal(f.clients.length, 0);
  assert.equal(f.snapshot.errorCode, 'SSH_KEY_FINGERPRINT_MISMATCH');
  stop(f);
  let release;
  const delayed = fixture({ enabled: true, getClientIdentity: () => new Promise((resolve) => { release = resolve; }) });
  await begin(delayed);
  await delayed.clock.tick(REMOTE_COMMAND_TIMEOUT_MS);
  assert.equal(delayed.snapshot.errorCode, 'TIMEOUT');
  assert.equal(delayed.clients.length, 0);
  const states = delayed.states.length;
  release({ privateKey: 'late private key' }); await flush();
  assert.equal(delayed.states.length, states);
  assert.equal(delayed.clients.length, 0);
  stop(delayed);
});

test('remote readiness timeout cancels pending or active health and explicit recovery can re-enable it', async () => {
  for (const stage of ['pending', 'active']) {
    const f = fixture({ enabled: true, hangCommand: true });
    f.service.update();
    await f.clock.tick(stage === 'pending' ? 30000 : HEALTH_PROBE_INTERVAL_MS);
    const old = f.clients[0];
    f.snapshot.remoteStatus = 'error';
    f.snapshot.errorCode = 'REMOTE_READY_TIMEOUT';
    f.service.update();
    if (old) {
      assert.equal(old.destroyed, true);
      assert.equal(old.channel.destroyed, true);
      old.channel.emit('exit', 0); old.channel.emit('close', 0);
    }
    const count = f.clients.length;
    const states = f.states.length;
    f.service.resume();
    f.preferences.healthProbeEnabled = false; f.service.update();
    f.preferences.healthProbeEnabled = true; f.service.update();
    await f.clock.tick(180000);
    assert.equal(f.clients.length, count);
    assert.equal(f.states.length, states);
    assert.equal(f.snapshot.remoteStatus, 'error');
    assert.equal(f.snapshot.errorCode, 'REMOTE_READY_TIMEOUT');
    assert.equal(f.clock.timers.size, 0);
    // Explicit recovery retry clears the terminal error and publishes checking.
    f.snapshot.errorCode = null;
    f.snapshot.remoteStatus = 'checking';
    f.service.update();
    await f.clock.tick(HEALTH_PROBE_INTERVAL_MS - 1);
    assert.equal(f.clients.length, count);
    await f.clock.tick(1);
    assert.equal(f.clients.length, count + 1);
    f.clients.at(-1).channel.emit('exit', 0);
    f.clients.at(-1).channel.emit('close', 0);
    await flush();
    assert.equal(f.snapshot.remoteStatus, 'reachable');
    assert.equal(f.snapshot.errorCode, null);
    stop(f);
  }
});
