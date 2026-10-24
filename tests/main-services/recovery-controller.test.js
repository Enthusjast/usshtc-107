'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { WebSocketServer } = require('ws');
const { createRecoveryController, RETRY_DELAYS_MS } = require('../../electron/recovery-controller');
const { PROFILE_DEFAULTS } = require('../../shared/settings-schema.mjs');

const flush = async () => { for (let index = 0; index < 40; index += 1) await Promise.resolve(); };
function fakeClock() {
  let now = 0;
  let id = 0;
  const timers = new Map();
  return {
    now: () => now, timers,
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
  const snapshot = { profileId: 'default', epoch: 1, desiredRunning: true, proxyStatus: 'stopped', operation: null };
  const preferences = { reconnectOnResume: options.enabled !== false };
  let cookie = 'session=test-only';
  let config = { ...PROFILE_DEFAULTS };
  let online = true;
  let controller;
  const sockets = [], states = [], auth = [], recovered = [], starts = [], requests = [], hintReads = [];
  const deps = {
    portalPreflight: options.portalPreflight || { run: async () => ({ ok: true }) },
    clock, net: { isOnline: () => { hintReads.push(clock.now()); return online; } },
    remoteReadyTimeoutMs: options.remoteReadyTimeoutMs,
    getSnapshot: () => snapshot, getConfig: () => config, getCookie: () => cookie, getPreferences: () => preferences,
    onRemoteState: (value) => {
      states.push(value); Object.assign(snapshot, value);
      options.onState?.(value);
      // Exercise the actual integration: publications synchronously call update.
      controller.update();
    },
    onAuthRequired: (value) => auth.push(value), onRecovered: (value) => recovered.push(value),
    requestStart: async (scope, request) => {
      assert.ok(request.signal instanceof AbortSignal);
      starts.push(scope);
      if (options.start) return options.start(request);
    },
    adapters: { createWebSocket(url, transport) {
      requests.push({ at: clock.now(), url, transport });
      const socket = new EventEmitter(); socket.readyState = 0; socket.closed = false;
      socket.close = socket.terminate = () => { socket.closed = true; };
      socket.send = () => { throw new Error('Recovery must never send a command'); };
      sockets.push(socket);
      if (!options.hang) queueMicrotask(() => {
        options.beforeResult?.();
        if (options.status) {
          const response = new EventEmitter(); response.statusCode = options.status;
          response.destroy = () => { response.destroyed = true; };
          socket.emit('unexpected-response', {}, response);
          assert.equal(response.destroyed, true);
        } else if (options.closeCode) socket.emit('close', options.closeCode, Buffer.from('untrusted private body'));
        else if (options.error) socket.emit('error', Object.assign(new Error('untrusted private error'), { code: options.error }));
        else {
          socket.readyState = 1;
          socket.emit('open');
          if (!options.silent) socket.emit('message', Buffer.from(JSON.stringify({ $case: 'data', data: { data: '' } })));
        }
      });
      return socket;
    } },
  };
  controller = createRecoveryController(deps);
  return { controller, deps, clock, snapshot, preferences, states, auth, recovered, starts, requests, sockets, hintReads,
    setCookie: (value) => { cookie = value; }, setConfig: (value) => { config = value; }, setOnline: (value) => { online = value; } };
}
const scopeOf = (f) => ({ profileId: f.snapshot.profileId, epoch: f.snapshot.epoch });

test('six exact backoffs are single-flight and exhaustion needs explicit Retry', async () => {
  const f = fixture({ error: 'ECONNREFUSED' });
  const round = f.controller.retry(scopeOf(f));
  assert.strictEqual(f.controller.retry(scopeOf(f)), round);
  let elapsed = 0;
  for (const delay of RETRY_DELAYS_MS) {
    await f.clock.tick(delay - 1);
    assert.equal(f.requests.length, RETRY_DELAYS_MS.indexOf(delay));
    await f.clock.tick(1); elapsed += delay;
    assert.equal(f.requests.at(-1).at, elapsed);
    f.controller.online(); f.controller.networkError(scopeOf(f));
  }
  assert.deepEqual(await round, { errorCode: 'NETWORK_UNAVAILABLE' });
  await f.clock.tick(120000);
  assert.equal(f.requests.length, 6);
  assert.equal(f.auth.length, 0);
  assert.equal(f.starts.length, 0);
  assert.ok(f.sockets.every((socket) => socket.closed));
  const again = f.controller.retry(scopeOf(f));
  await f.clock.tick(1000);
  assert.equal(f.requests.length, 7);
  f.controller.cancel('USER_STOP');
  assert.deepEqual(await again, { cancelled: true });
  assert.equal(f.clock.timers.size, 0);
  f.controller.dispose();
});

test('five second handshake limit bounds stalled adapters and disables while busy', async () => {
  const f = fixture({ hang: true });
  const round = f.controller.retry(scopeOf(f));
  await f.clock.tick(1000);
  assert.equal(f.requests[0].transport.handshakeTimeout, 5000);
  assert.equal(f.requests[0].transport.rejectUnauthorized, true);
  await f.clock.tick(4999);
  assert.equal(f.sockets[0].closed, false);
  await f.clock.tick(1);
  assert.equal(f.sockets[0].closed, true);
  assert.equal(f.states.at(-1).errorCode, 'TIMEOUT');
  await f.clock.tick(2000);
  assert.equal(f.requests.length, 2);
  f.preferences.reconnectOnResume = false;
  f.controller.update();
  assert.deepEqual(await round, { cancelled: true });
  assert.notEqual(f.snapshot.remoteStatus, 'checking');
  assert.ok(f.sockets.every((socket) => socket.closed));
  assert.equal(f.clock.timers.size, 0);
  f.controller.resume(); f.controller.online(); f.controller.networkError(scopeOf(f));
  await f.clock.tick(120000);
  assert.equal(f.requests.length, 2);
  f.controller.dispose();
});

test('disabled preference still permits an explicit bounded round without automatic probes', async () => {
  const f = fixture({ enabled: false });
  f.controller.update(); f.controller.resume(); f.controller.online(); f.controller.networkError(scopeOf(f));
  await f.clock.tick(10000);
  assert.equal(f.requests.length, 0);
  const round = f.controller.retry(scopeOf(f));
  await f.clock.tick(1000);
  assert.deepEqual(await round, { reachable: true });
  assert.equal(f.starts.length, 1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.clock.timers.size, 0);
  f.controller.dispose();
});

test('enabling schedules current intent immediately; polling is only a five second hint', async () => {
  const f = fixture({ enabled: false });
  f.controller.update();
  f.preferences.reconnectOnResume = true; f.controller.update();
  await f.clock.tick(1000);
  assert.equal(f.requests.length, 1);
  f.snapshot.proxyStatus = 'started';
  f.setOnline(false);
  await f.clock.tick(4000);
  assert.equal(f.hintReads.length, 1);
  assert.notEqual(f.states.at(-1).remoteStatus, 'offline');
  await f.clock.tick(1000);
  assert.equal(f.requests.length, 2);
  assert.equal(f.starts.length, 1);
  f.setOnline(true);
  await f.clock.tick(5000);
  assert.equal(f.requests.length, 3);
  assert.equal(f.starts.length, 1);
  f.controller.dispose();
});

test('probe success never restarts a healthy, starting, stopping or error listener', async () => {
  for (const proxyStatus of ['started', 'starting', 'stopping', 'error']) {
    const f = fixture(); f.snapshot.proxyStatus = proxyStatus;
    const round = f.controller.retry(scopeOf(f));
    await f.clock.tick(1000); await round;
    assert.equal(f.starts.length, 0, proxyStatus);
    assert.equal(f.states.at(-1).remoteStatus, 'reachable');
    f.controller.dispose();
  }
  const f = fixture(); f.snapshot.desiredRunning = false;
  const round = f.controller.retry(scopeOf(f)); await f.clock.tick(1000); await round;
  assert.equal(f.starts.length, 0); f.controller.dispose();
});

test('current 401/403 only revoke the probed Cookie; 1008/1011 never revoke', async () => {
  for (const status of [401, 403]) {
    const f = fixture({ status });
    const round = f.controller.retry(scopeOf(f)); await f.clock.tick(1000);
    assert.deepEqual(await round, { errorCode: 'AUTH_REQUIRED' });
    assert.equal(f.auth.length, 1);
    assert.equal(f.auth[0].cookie, 'session=test-only');
    await f.clock.tick(120000); assert.equal(f.requests.length, 1);
    f.controller.dispose();
  }
  for (const closeCode of [1008, 1011]) {
    const f = fixture({ closeCode }); const round = f.controller.retry(scopeOf(f));
    await f.clock.tick(61000); await round;
    assert.equal(f.requests.length, 6); assert.equal(f.auth.length, 0);
    f.controller.dispose();
  }
});

test('Cookie replacement, scope change and user stop discard late responses and starts', async () => {
  for (const mutate of [
    (f) => f.setCookie('session=new-cookie'),
    (f) => { f.snapshot.epoch += 1; },
    (f) => { f.snapshot.profileId = 'other'; },
    (f) => { f.snapshot.desiredRunning = false; },
    (f) => f.setConfig({ ...PROFILE_DEFAULTS, port: 4000 }),
    (f) => f.controller.cancel('USER_STOP'),
  ]) {
    const f = fixture({ hang: true }); const round = f.controller.retry(scopeOf(f));
    await f.clock.tick(1000); mutate(f);
    const response = new EventEmitter(); response.statusCode = 401; response.destroy = () => {};
    f.sockets[0].emit('unexpected-response', {}, response);
    await flush();
    assert.deepEqual(await round, { cancelled: true });
    assert.equal(f.auth.length, 0); assert.equal(f.starts.length, 0);
    f.controller.dispose(); assert.equal(f.clock.timers.size, 0);
  }
});

test('suspend aborts recovery resources without stopping healthy channels and resume retries', async () => {
  const f = fixture({ hang: true }); f.snapshot.proxyStatus = 'started';
  const round = f.controller.retry(scopeOf(f)); await f.clock.tick(1000);
  f.controller.suspend();
  assert.deepEqual(await round, { cancelled: true });
  assert.equal(f.sockets[0].closed, true); assert.equal(f.clock.timers.size, 0);
  assert.equal(f.snapshot.proxyStatus, 'started');
  f.controller.online(); f.controller.networkError(scopeOf(f));
  await f.clock.tick(10000); assert.equal(f.requests.length, 1);
  f.controller.resume(); await f.clock.tick(1000); assert.equal(f.requests.length, 2);
  assert.equal(f.starts.length, 0); f.controller.dispose();
});

test('invalid configuration, unavailable credentials, storage/port and certificate failures are terminal', async () => {
  for (const setup of [
    (f) => f.setConfig({ ...PROFILE_DEFAULTS, port: 70000 }),
    (f) => f.setCookie(''),
    (f) => f.setCookie('invalid\ncookie'),
    (f) => { f.snapshot.storageErrorCode = 'SETTINGS_COMMIT_UNKNOWN'; },
    (f) => { f.snapshot.errorCode = 'PORT_IN_USE'; },
    (f) => f.setConfig({ ...PROFILE_DEFAULTS, wssUrl: 'ws://localhost/insecure' }),
  ]) {
    const f = fixture(); setup(f);
    assert.ok((await f.controller.retry(scopeOf(f))).errorCode);
    await f.clock.tick(120000); assert.equal(f.requests.length, 0);
    assert.equal(f.auth.length, 0); f.controller.dispose();
  }
  for (const error of ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
    const f = fixture({ error }); const round = f.controller.retry(scopeOf(f));
    await f.clock.tick(1000); assert.deepEqual(await round, { errorCode: 'TLS_FAILED' });
    f.controller.resume(); f.controller.online(); f.controller.networkError(scopeOf(f));
    await f.clock.tick(120000); assert.equal(f.requests.length, 1); f.controller.dispose();
  }
});

test('recovery notifications deduplicate failed-to-reachable edges and stale scope events', async () => {
  const f = fixture(); f.snapshot.proxyStatus = 'started';
  f.controller.update();
  f.controller.networkError({ ...scopeOf(f), epoch: 0 });
  assert.equal(f.states.length, 0);
  f.controller.networkError(scopeOf(f));
  f.controller.networkError(scopeOf(f));
  await f.clock.tick(1000);
  assert.equal(f.recovered.length, 1); assert.equal(f.starts.length, 0);
  const round = f.controller.retry(scopeOf(f)); await f.clock.tick(1000); await round;
  assert.equal(f.recovered.length, 1);
  f.controller.networkError(scopeOf(f)); await f.clock.tick(1000);
  assert.equal(f.recovered.length, 2);
  assert.equal(JSON.stringify(f.states).includes('test-only'), false);
  f.controller.dispose();
});

test('a blocked app start finishes without retry storms and async cancellation cannot publish stale failure', async () => {
  const port = fixture({ start: async () => { throw Object.assign(new Error('private port detail'), { code: 'PORT_IN_USE' }); } });
  const round = port.controller.retry(scopeOf(port)); await port.clock.tick(1000);
  assert.deepEqual(await round, { errorCode: 'PORT_IN_USE' });
  port.controller.online(); await port.clock.tick(120000);
  assert.equal(port.starts.length, 1); port.controller.dispose();
  let finish;
  const f = fixture({ start: () => new Promise((resolve) => { finish = resolve; }) });
  const pending = f.controller.retry(scopeOf(f)); await f.clock.tick(1000);
  f.controller.cancel('USER_STOP'); finish(); await flush();
  assert.deepEqual(await pending, { cancelled: true }); f.controller.dispose();
});

test('canceled native stop rearms only at idle when user intent remains enabled', async () => {
  const f = fixture({ hang: true });
  const round = f.controller.retry(scopeOf(f)); await f.clock.tick(1000);
  f.snapshot.operation = 'stopping';
  f.controller.cancel('user_stop'); f.controller.update();
  assert.deepEqual(await round, { cancelled: true });
  await f.clock.tick(10000); assert.equal(f.requests.length, 1);
  f.snapshot.operation = null;
  f.controller.update(); await f.clock.tick(1000);
  assert.equal(f.requests.length, 2);
  f.controller.cancel('scope_changed'); f.controller.update();
  await f.clock.tick(10000); assert.equal(f.requests.length, 2);
  f.controller.dispose();
});

test('disabling preferences aborts the signal of an app start waiting for the action slot', async () => {
  let release;
  let signal;
  const f = fixture({ start: (request) => {
    signal = request.signal;
    return new Promise((resolve) => { release = resolve; });
  } });
  const round = f.controller.retry(scopeOf(f)); await f.clock.tick(1000);
  assert.equal(signal.aborted, false);
  f.preferences.reconnectOnResume = false; f.controller.update();
  assert.equal(signal.aborted, true);
  release(); await flush();
  assert.deepEqual(await round, { cancelled: true });
  assert.equal(f.clock.timers.size, 0); f.controller.dispose();
});

test('scope validation and disposal reject requests without creating transport', async () => {
  const f = fixture();
  await assert.rejects(f.controller.retry({ profileId: 'other', epoch: 1 }), { code: 'PROFILE_CHANGED' });
  f.controller.dispose();
  await assert.rejects(f.controller.retry(scopeOf(f)), { code: 'SHUTTING_DOWN' });
  f.controller.update(); f.controller.resume(); f.controller.online(); f.controller.networkError(scopeOf(f));
  assert.equal(f.clock.timers.size, 0); assert.equal(f.requests.length, 0);
});

test('real TLS/WSS loopback handshake sends no command, closes and honors certificate trust and HTTP auth', { timeout: 15000 }, async (t) => {
  const certificate = fs.readFileSync(path.join(__dirname, '../fixtures/loopback-test-only-cert.pem'));
  const key = fs.readFileSync(path.join(__dirname, '../fixtures/loopback-test-only-key.pem'));
  const server = https.createServer({ key, cert: certificate });
  const wss = new WebSocketServer({ noServer: true });
  const peers = new Set();
  let status = 101;
  let messageCount = 0;
  server.on('upgrade', (request, socket, head) => {
    assert.equal(request.headers.cookie, 'session=test-only');
    assert.equal(request.headers.origin, 'https://107.ustc.edu.cn');
    if (status !== 101) { socket.end(`HTTP/1.1 ${status} Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
    wss.handleUpgrade(request, socket, head, (ws) => {
      peers.add(ws); ws.on('message', () => { messageCount += 1; }); ws.on('close', () => peers.delete(ws));
      ws.send(JSON.stringify({ $case: 'data', data: { data: '' } }));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    for (const peer of peers) peer.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  });
  for (const mode of ['trusted', 'untrusted', 'auth']) {
    status = mode === 'auth' ? 403 : 101;
    const f = fixture();
    f.deps.adapters = mode === 'untrusted' ? {} : { tlsCa: certificate };
    f.deps.getConfig = () => ({ ...PROFILE_DEFAULTS, wssUrl: `wss://127.0.0.1:${server.address().port}/shell` });
    f.controller.dispose();
    const controller = createRecoveryController(f.deps);
    // The fixture's publication observer belongs to its disposed fake controller;
    // this real service has no renderer or app-global injection.
    const round = controller.retry(scopeOf(f));
    await f.clock.tick(1000);
    const result = await round;
    assert.equal(mode === 'trusted' ? result.reachable : result.errorCode,
      mode === 'trusted' ? true : mode === 'untrusted' ? 'TLS_FAILED' : 'AUTH_REQUIRED');
    assert.equal(f.auth.length, mode === 'auth' ? 1 : 0);
    controller.dispose();
    assert.equal(f.clock.timers.size, 0);
  }
  assert.equal(messageCount, 0);
});

test('canceling a pending probe restores stable reachability without immediately rearming itself', async () => {
  const f = fixture({ hang: true });
  f.snapshot.proxyStatus = 'started';
  const first = f.controller.retry(scopeOf(f));
  await f.clock.tick(1000);
  f.sockets[0].readyState = 1;
  f.sockets[0].emit('open');
  f.sockets[0].emit('message', Buffer.from(JSON.stringify({ $case: 'data', data: { data: '' } })));
  await flush();
  assert.deepEqual(await first, { reachable: true });
  assert.equal(f.snapshot.remoteStatus, 'reachable');
  const second = f.controller.retry(scopeOf(f));
  await f.clock.tick(1000);
  assert.equal(f.snapshot.remoteStatus, 'checking');
  f.controller.cancel('user_stop');
  assert.deepEqual(await second, { cancelled: true });
  assert.equal(f.snapshot.remoteStatus, 'reachable');
  assert.equal(f.snapshot.proxyStatus, 'started');
  assert.equal(f.snapshot.desiredRunning, true);
  await f.clock.tick(120000);
  assert.equal(f.requests.length, 2);
  assert.equal(f.starts.length, 0);
  f.controller.update();
  await f.clock.tick(1000);
  assert.equal(f.requests.length, 3);
  f.controller.dispose();
});

test('stopped intent leaves no hint or probe timers while explicit Retry still does not start a listener', async () => {
  const f = fixture({ hang: true });
  f.controller.update();
  await f.clock.tick(1000);
  assert.equal(f.requests.length, 1);
  f.snapshot.desiredRunning = false;
  f.controller.cancel('user_stop');
  f.controller.update();
  assert.equal(f.clock.timers.size, 0);
  await f.clock.tick(120000);
  assert.equal(f.requests.length, 1);
  const manual = f.controller.retry(scopeOf(f));
  await f.clock.tick(1000);
  f.sockets[1].readyState = 1;
  f.sockets[1].emit('open');
  f.sockets[1].emit('message', Buffer.from(JSON.stringify({ $case: 'data', data: { data: '' } })));
  await flush();
  assert.deepEqual(await manual, { reachable: true });
  assert.equal(f.starts.length, 0);
  assert.equal(f.clock.timers.size, 0);
  f.controller.dispose();
});

test('open is not reachable; only a valid data frame including empty data proves readiness', async () => {
  const f = fixture({ silent: true });
  const round = f.controller.retry(scopeOf(f));
  await f.clock.tick(1000);
  assert.equal(f.snapshot.remoteStatus, 'checking');
  assert.equal(f.starts.length, 0);
  for (const raw of ['not-json', '{}', '{"$case":"data","data":{"data":42}}',
    '{"$case":"exit","exit":{"code":0}}']) f.sockets[0].emit('message', Buffer.from(raw));
  await f.clock.tick(9999);
  assert.equal(f.snapshot.remoteStatus, 'checking');
  f.sockets[0].emit('message', Buffer.from('{"$case":"data","data":{"data":""}}'));
  await flush();
  assert.deepEqual(await round, { reachable: true });
  assert.equal(f.snapshot.remoteStatus, 'reachable');
  assert.equal(f.starts.length, 1);
  assert.equal(f.auth.length, 0);
  f.controller.dispose();
  assert.equal(f.clock.timers.size, 0);
});

test('readiness deadline begins after open and silence inhibits retries without revoking Cookie', async () => {
  const f = fixture({ hang: true });
  const round = f.controller.retry(scopeOf(f));
  await f.clock.tick(5999);
  f.sockets[0].readyState = 1;
  f.sockets[0].emit('open');
  await f.clock.tick(9999);
  assert.equal(f.sockets[0].closed, false);
  await f.clock.tick(1);
  assert.deepEqual(await round, { errorCode: 'REMOTE_READY_TIMEOUT' });
  assert.equal(f.snapshot.remoteStatus, 'error');
  assert.equal(f.auth.length, 0);
  assert.equal(f.starts.length, 0);
  f.controller.resume(); f.controller.online(); f.controller.networkError(scopeOf(f));
  await f.clock.tick(120000);
  assert.equal(f.requests.length, 1);
  const manual = f.controller.retry(scopeOf(f));
  await f.clock.tick(1000);
  assert.equal(f.requests.length, 2);
  f.controller.cancel('USER_STOP');
  assert.deepEqual(await manual, { cancelled: true });
  f.controller.dispose();
});

test('proxy readiness failure inhibits only the matching scope/config/Cookie until explicit action', async () => {
  const f = fixture({ hang: true });
  const round = f.controller.retry(scopeOf(f));
  await f.clock.tick(1000);
  f.controller.remoteNotReady({ ...scopeOf(f), epoch: 0, code: 'REMOTE_READY_TIMEOUT' });
  assert.equal(f.sockets[0].closed, false);
  f.controller.remoteNotReady({ ...scopeOf(f), code: 'REMOTE_READY_TIMEOUT' });
  assert.deepEqual(await round, { cancelled: true });
  assert.equal(f.sockets[0].closed, true);
  assert.equal(f.snapshot.errorCode, 'REMOTE_READY_TIMEOUT');
  f.snapshot.desiredRunning = false; f.controller.update();
  f.snapshot.desiredRunning = true; f.controller.update();
  f.preferences.reconnectOnResume = false; f.controller.update();
  f.preferences.reconnectOnResume = true; f.controller.update();
  f.controller.resume(); f.controller.online(); f.controller.networkError(scopeOf(f));
  await f.clock.tick(120000);
  assert.equal(f.requests.length, 1);
  assert.equal(f.auth.length, 0);
  f.setCookie('session=explicit-login'); f.controller.update();
  await f.clock.tick(1000);
  assert.equal(f.requests.length, 2);
  f.controller.dispose();
});

test('custom readiness deadline is independent of handshake and is cancelled by context changes', async () => {
  const f = fixture({ silent: true, remoteReadyTimeoutMs: 25 });
  const round = f.controller.retry(scopeOf(f));
  await f.clock.tick(1024);
  assert.equal(f.snapshot.remoteStatus, 'checking');
  await f.clock.tick(1);
  assert.deepEqual(await round, { errorCode: 'REMOTE_READY_TIMEOUT' });
  assert.equal(f.auth.length, 0);
  f.controller.dispose();
  for (const mutate of [
    (g) => g.setCookie('session=changed'),
    (g) => g.setConfig({ ...PROFILE_DEFAULTS, port: 4444 }),
    (g) => { g.snapshot.epoch += 1; },
    (g) => { g.preferences.reconnectOnResume = false; },
    (g) => g.controller.suspend(),
  ]) {
    const g = fixture({ silent: true });
    const pending = g.controller.retry(scopeOf(g));
    await g.clock.tick(1000);
    mutate(g); g.controller.update();
    assert.deepEqual(await pending, { cancelled: true });
    const states = g.states.length;
    g.sockets[0].emit('message', Buffer.from('{"$case":"data","data":{"data":""}}'));
    await flush();
    assert.equal(g.states.length, states);
    assert.equal(g.starts.length, 0);
    assert.equal(g.auth.length, 0);
    assert.equal(g.sockets[0].closed, true);
    g.controller.dispose();
    assert.equal(g.clock.timers.size, 0);
  }
});

test('REST invalid token ends recovery without WSS, backoff or destructive auth callback', async () => {
  let calls = 0;
  const f = fixture({ portalPreflight: { run: async () => {
    calls += 1;
    throw Object.assign(new Error('AUTH_REQUIRED'), { code: 'AUTH_REQUIRED' });
  } } });
  const round = f.controller.retry(scopeOf(f));
  await f.clock.tick(1000);
  assert.deepEqual(await round, { errorCode: 'AUTH_REQUIRED' });
  assert.equal(f.snapshot.remoteStatus, 'auth_required');
  assert.equal(f.requests.length, 0);
  assert.equal(f.auth.length, 0);
  await f.clock.tick(120000);
  assert.equal(calls, 1);
  f.controller.dispose();
});

test('every readiness attempt redoes preflight; operational failures retry without WSS or auth revocation', async () => {
  const contexts = [];
  const f = fixture({ portalPreflight: { run: async (context) => {
    contexts.push(context);
    if (contexts.length < 3) throw Object.assign(new Error('private'), { code: 'PORTAL_NETWORK' });
    return { ok: true };
  } } });
  const round = f.controller.retry(scopeOf(f));
  await f.clock.tick(1000);
  assert.equal(f.snapshot.errorCode, 'PORTAL_NETWORK');
  await f.clock.tick(2000);
  assert.equal(f.requests.length, 0);
  await f.clock.tick(4000);
  assert.deepEqual(await round, { reachable: true });
  assert.equal(contexts.length, 3);
  assert.equal(f.requests.length, 1);
  assert.equal(f.auth.length, 0);
  f.controller.dispose();
});

test('context cancellation aborts recovery preflight and ignores late success', async () => {
  let finish;
  let context;
  const f = fixture({ portalPreflight: { run: (value) => {
    context = value;
    return new Promise((resolve) => { finish = resolve; });
  } } });
  const round = f.controller.retry(scopeOf(f));
  await f.clock.tick(1000);
  f.controller.suspend();
  assert.equal(context.signal.aborted, true);
  finish({ ok: true });
  await flush();
  assert.deepEqual(await round, { cancelled: true });
  assert.equal(f.requests.length, 0);
  assert.equal(f.auth.length, 0);
  f.controller.dispose();
});
