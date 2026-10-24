'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createProxyController } = require('../../electron/proxy-controller');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const turn = () => new Promise((resolve) => setImmediate(resolve));
class Server extends EventEmitter {
  constructor(options) { super(); this.options = options; this.accepting = options.acceptingConnections; this.stops = 0; }
  async start() { this.emit('started', { host: this.options.host, port: this.options.port }); return true; }
  async stop() { this.stops += 1; this.emit('stopped'); }
  setAcceptingConnections(value) { this.accepting = value; }
  updateCookie(value) { this.cookie = value; }
  getSessions() { return [{ id: 1 }]; }
  getStats() { return { uptimeMs: 100, totalBytesSent: 7, totalBytesReceived: 9, sessions: this.getSessions() }; }
  disconnectSession(id) { return id === 1; }
}
function fixture(options = {}) {
  const timers = new Map();
  let timerId = 0;
  let now = 123;
  const clock = {
    now: () => now,
    wallNow: () => 1700000000000 + now,
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn: () => { now += delay; fn(); }, delay, interval: false }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, delay) => { const id = ++timerId; timers.set(id, { fn: () => { now += delay; fn(); }, delay, interval: true }); return id; },
    clearInterval: (id) => timers.delete(id),
  };
  const servers = [], states = [], events = [], auth = [], networkErrors = [];
  const controller = createProxyController({ clock,
    history: options.history,
    createServer: (config) => { const server = new Server(config); servers.push(server); options.configure?.(server); return server; },
    getKeyMaterial: options.getKeyMaterial || (() => ({ hostKey: 'test-only' })),
    isTransactionCommitted: options.committed || (() => true),
    onState: (patch) => states.push(patch),
    onAuthRequired: (source) => auth.push(source),
    onNetworkError: (source) => networkErrors.push(source),
    publish: (name, value) => events.push([name, value]),
  });
  const scope = { profileId: 'default', epoch: 1 };
  controller.setScope(scope);
  return { controller, servers, states, events, auth, networkErrors, timers, scope };
}
const config = { host: '127.0.0.1', port: 3000, cluster: 'training' };

test('normal lifecycle freezes actual started configuration and samples scoped stats', async () => {
  const f = fixture();
  await f.controller.start(config, 'session=one', f.scope);
  assert.equal(f.servers[0].accepting, true);
  assert.equal(f.states.at(-1).runningConfig.port, 3000);
  const first = f.controller.getStats();
  assert.equal(first.profileId, 'default');
  assert.equal(first.epoch, 1);
  assert.equal(first.sampledAt, 123);
  assert.ok(f.controller.getStats().sequence > first.sequence);
  assert.equal(f.controller.disconnectSession(1), true);
  f.servers[0].emit('session-open', { id: 1 });
  assert.equal(f.events.at(-1)[0], 'session-update');
  assert.equal(f.events.at(-1)[1].epoch, 1);
  await f.controller.stop();
  assert.equal(f.timers.size, 0);
  assert.equal(f.states.at(-1).proxyStatus, 'stopped');
  assert.equal(f.states.at(-1).runningConfig, null);
  await f.controller.dispose();
});

test('stop timeout retains instance ownership/listeners across UI epoch changes', async () => {
  const f = fixture();
  await f.controller.start(config, 'session=one', f.scope);
  const server = f.servers[0];
  server.stop = async () => { throw new Error('stop timeout'); };
  const stopping = f.controller.stop();
  assert.equal(server.accepting, false);
  await assert.rejects(stopping, { code: 'PROXY_STOP_FAILED' });
  f.controller.setScope({ profileId: 'default', epoch: 2 });
  assert.doesNotThrow(() => server.emit('error', new Error('late owned error')));
  assert.equal(f.states.at(-1).epoch, 2);
  assert.equal(f.states.at(-1).proxyStatus, 'error');
  await assert.rejects(f.controller.start(config, 'session=two', { profileId: 'default', epoch: 2 }), { code: 'PROXY_STOP_FAILED' });
  assert.equal(f.servers.length, 1);
  server.stop = async () => server.emit('stopped');
  await f.controller.stop();
  await f.controller.start(config, 'session=two', { profileId: 'default', epoch: 2 });
  assert.equal(f.servers.length, 2);
  await f.controller.dispose();
});

test('cancelPendingStart interrupts listening without waiting behind its start promise', async () => {
  const start = deferred();
  const f = fixture({ configure: (server) => {
    server.start = () => start.promise;
    server.stop = async () => { server.stops += 1; start.resolve(false); server.emit('stopped'); };
  } });
  const operation = f.controller.start(config, 'session=one', f.scope);
  await turn();
  f.controller.cancelPendingStart();
  assert.deepEqual(await operation, { cancelled: true });
  await f.controller.stop();
  assert.ok(f.servers[0].stops >= 1);
  assert.equal(f.timers.size, 0);
});

test('candidate listener admits nothing until durable root transaction is committed', async () => {
  let committed = false;
  const f = fixture({ committed: (id) => id === 'transaction' && committed });
  await f.controller.startCandidate({ config, cookie: 'session=one', scope: f.scope,
    transactionId: 'transaction', keyMaterial: { hostKey: 'candidate-only' } });
  assert.equal(f.servers[0].accepting, false);
  assert.equal(f.states.length, 0);
  await assert.rejects(f.controller.activateCandidate('transaction'), { code: 'KEY_TRANSACTION_FAILED' });
  assert.equal(f.servers[0].accepting, false);
  committed = true;
  await f.controller.activateCandidate('transaction');
  assert.equal(f.servers[0].accepting, true);
  assert.equal(f.states.at(-1).proxyStatus, 'started');
  await f.controller.dispose();
});

test('candidate cannot be activated after a stop while root commitment is awaited', async () => {
  const commitment = deferred();
  const f = fixture({ committed: () => commitment.promise });
  await f.controller.startCandidate({ config, cookie: 'session=one', scope: f.scope,
    transactionId: 'transaction', keyMaterial: { hostKey: 'candidate-only' } });
  const activation = f.controller.activateCandidate('transaction');
  await f.controller.stop();
  commitment.resolve(true);
  await assert.rejects(activation, { code: 'KEY_TRANSACTION_FAILED' });
  assert.equal(f.servers[0].accepting, false);
});

test('only 401/403 handshake responses revoke authentication; stale instance events are ignored', async () => {
  const f = fixture();
  await f.controller.start(config, 'session=one', f.scope);
  const old = f.servers[0];
  old.emit('auth-error', { statusCode: 1008 });
  old.emit('auth-error', { statusCode: 1011 });
  old.emit('auth-error', { statusCode: 403 });
  assert.equal(f.auth.length, 1);
  await f.controller.stop();
  await f.controller.start(config, 'session=two', f.scope);
  old.emit('auth-error', { statusCode: 401 });
  assert.equal(f.auth.length, 1);
  await f.controller.dispose();
});

test('traffic events coalesce at 500ms, periodic sampling remains one second', async () => {
  const f = fixture();
  await f.controller.start(config, 'session=one', f.scope);
  const before = f.events.length;
  f.servers[0].emit('traffic');
  f.servers[0].emit('traffic');
  assert.equal([...f.timers.values()].filter((timer) => timer.delay === 500).length, 1);
  const [id, timer] = [...f.timers].find(([, value]) => value.delay === 500);
  f.timers.delete(id);
  timer.fn();
  assert.equal(f.events.length, before + 1);
  assert.equal([...f.timers.values()].filter((value) => value.interval && value.delay === 1000).length, 1);
  await f.controller.dispose();
});

test('repeated normal start updates only its cookie and never applies unsaved running configuration', async () => {
  const f = fixture();
  await f.controller.start(config, 'session=one', f.scope);
  assert.deepEqual(await f.controller.start({ ...config, port: 4000 }, 'session=two', f.scope), { alreadyRunning: true });
  assert.equal(f.servers.length, 1);
  assert.equal(f.servers[0].options.port, 3000);
  assert.equal(f.servers[0].cookie, 'session=two');
  await f.controller.dispose();
  await assert.rejects(f.controller.start(config, 'session=one', f.scope), { code: 'SHUTTING_DOWN' });
});

test('failed key initialization/start clean up without orphaning listeners or accepting a second instance', async () => {
  const keys = fixture({ getKeyMaterial: () => { throw new Error('invalid key'); } });
  await assert.rejects(keys.controller.start(config, 'session=one', keys.scope), { code: 'PROXY_START_FAILED' });
  assert.equal(keys.servers.length, 0);
  assert.equal(keys.states.at(-1).proxyStatus, 'error');
  const f = fixture({ configure: (server) => {
    server.start = async () => { server.emit('error', new Error('bind failed')); throw new Error('bind failed'); };
  } });
  await assert.rejects(f.controller.start(config, 'session=one', f.scope), { code: 'PROXY_START_FAILED' });
  assert.equal(f.servers[0].stops, 1);
  assert.equal(f.servers[0].listenerCount('error'), 0);
  assert.equal(f.states.at(-1).errorCode, 'PROXY_START_FAILED');
  assert.deepEqual(f.controller.getStats().sessions, []);
  await f.controller.dispose();
});

test('cancelling during asynchronous key loading never constructs a listener', async () => {
  const keys = deferred();
  const f = fixture({ getKeyMaterial: () => keys.promise });
  const started = f.controller.start(config, 'session=one', f.scope);
  await turn();
  f.controller.cancelPendingStart();
  keys.resolve({ hostKey: 'test-only' });
  assert.deepEqual(await started, { cancelled: true });
  assert.equal(f.servers.length, 0);
  assert.deepEqual(await f.controller.stop(), {});
  await assert.rejects(f.controller.startCandidate({ config, cookie: '', scope: f.scope }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.controller.activateCandidate('missing'), { code: 'INVALID_ARGUMENT' });
});

test('ProxyServer TCP admission gate itself rejects before SSH injection and defaults open', () => {
  const { ProxyServer } = require('../../electron/proxy-server');
  const server = new ProxyServer({ acceptingConnections: false });
  let rejected = 0;
  let injected = 0;
  const socket = { destroy: () => { rejected += 1; } };
  server._trackTcpSocket = () => true;
  server._sshServer = { injectSocket: () => { injected += 1; } };
  server._handleTcpSocket(socket);
  assert.equal(rejected, 1);
  assert.equal(injected, 0);
  server.setAcceptingConnections(true);
  server._handleTcpSocket(socket);
  assert.equal(injected, 1);
  const normal = new ProxyServer();
  normal._trackTcpSocket = () => true;
  normal._sshServer = { injectSocket: () => { injected += 1; } };
  normal._handleTcpSocket(socket);
  assert.equal(injected, 2);
});

test('cancelPendingStart also closes an uncommitted candidate gate after bind has succeeded', async () => {
  const commitment = deferred();
  const f = fixture({ committed: () => commitment.promise });
  await f.controller.startCandidate({ config, cookie: 'session=one', scope: f.scope,
    transactionId: 'transaction', keyMaterial: { hostKey: 'candidate-only' } });
  const activation = f.controller.activateCandidate('transaction');
  f.controller.cancelPendingStart();
  commitment.resolve(true);
  await assert.rejects(activation, { code: 'KEY_TRANSACTION_FAILED' });
  assert.equal(f.servers[0].accepting, false);
  assert.ok(f.servers[0].stops > 0);
  await f.controller.dispose();
});

test('history keeps immutable instance/profile ownership across epochs and finalizes before stopped', async () => {
  const calls = [];
  const history = {
    register: (value) => { calls.push(['register', value]); return true; },
    sample: (key, value) => calls.push(['sample', key, { ...value }]),
    finalize: (key, value) => calls.push(['finalize', key, value]),
  };
  const f = fixture({ history });
  await f.controller.start(config, 'session=one', f.scope);
  const server = f.servers[0];
  let sessions = [{ id: 9, kind: 'exec', connectedAt: 1700000000000, bytesSent: 1, bytesReceived: 2 }];
  server.getSessions = () => sessions;
  server.emit('session-open', sessions[0]);
  const registration = calls.find(([name]) => name === 'register')[1];
  assert.equal(registration.profileId, 'default');
  assert.equal(registration.kind, 'exec');
  assert.match(registration.sessionKey, /^[a-f0-9-]+:9$/);
  sessions[0] = { ...sessions[0], bytesSent: 40, bytesReceived: 90 };
  const interval = [...f.timers.values()].find((timer) => timer.interval);
  interval.fn();
  assert.equal(calls.filter(([name]) => name === 'sample').at(-1)[2].bytesReceived, 90);
  f.controller.setScope({ profileId: 'other-profile', epoch: 8 });
  assert.deepEqual(f.controller.getStats().sessions, [], 'old profile counters never wear the new scope');
  const before = f.events.length;
  server.emit('session-close', { sessionId: 9, session: { ...sessions[0], bytesReceived: 100 },
    endedAt: 1700000001000, exitCode: 7, reason: 'completed' });
  assert.equal(f.events.length, before, 'old-profile UI events are filtered, not history finalization');
  assert.equal(calls.filter(([name]) => name === 'finalize').length, 1);
  assert.equal(calls.at(-1)[1], registration.sessionKey);
  assert.equal(calls.at(-1)[2].bytesReceived, 100);
  server.emit('session-close', { sessionId: 9, reason: 'network_error' });
  assert.equal(calls.filter(([name]) => name === 'finalize').length, 1);
  sessions = [];
  await f.controller.stop();
  await f.controller.dispose();
});

test('stop fallback finalizes registered sessions before stopped and cannot resurrect cleared history', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createSessionHistoryStore } = require('../../electron/session-history-store');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc107-controller-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const history = createSessionHistoryStore({ filePath: path.join(root, 'history.json') });
  const f = fixture({ history });
  await f.controller.start(config, 'session=one', f.scope);
  const server = f.servers[0];
  const session = { id: 3, kind: 'shell', connectedAt: Date.now(), bytesSent: 10, bytesReceived: 20 };
  server.getSessions = () => [session];
  server.emit('session-open', session);
  f.controller.setScope({ ...f.scope, epoch: 2 });
  server.on('stopped', () => {
    const [record] = history.get({ profileId: 'default', days: 7 }).sessions;
    assert.equal(record.reason, 'app_exit');
    assert.equal(record.endedAt !== null, true);
    assert.equal(JSON.parse(fs.readFileSync(history.filePath, 'utf8')).sessions[0].reason, 'app_exit');
  });
  await f.controller.stop('app_exit');
  assert.deepEqual(history.clear('default'), { errorCode: null });
  server.emit('session-close', { sessionId: 3, session, reason: 'network_error', exitCode: 255 });
  assert.deepEqual(history.get({ profileId: 'default', days: 7 }).sessions, []);
  history.dispose();
  await f.controller.dispose();
});

test('candidate admission creates no history and failed stops retain late terminal ownership', async () => {
  const finalized = [], registered = [];
  const f = fixture({ history: {
    register: (value) => registered.push(value), sample() {},
    finalize: (key, value) => finalized.push([key, value]),
  } });
  await f.controller.startCandidate({ config, cookie: 'session=one', scope: f.scope,
    transactionId: 'history-candidate', keyMaterial: { hostKey: 'test-only' } });
  const server = f.servers[0];
  const session = { id: 8, kind: 'shell', connectedAt: Date.now(), bytesSent: 0, bytesReceived: 0 };
  server.emit('session-open', session);
  assert.equal(registered.length, 0);
  await f.controller.activateCandidate('history-candidate');
  server.getSessions = () => [session];
  server.emit('session-open', session);
  server.stop = async () => { throw new Error('stop timeout'); };
  await assert.rejects(f.controller.stop('auth_error'), { code: 'PROXY_STOP_FAILED' });
  f.controller.setScope({ profileId: 'other', epoch: 99 });
  server.emit('session-close', { sessionId: 8, session: { ...session, bytesReceived: 33 },
    exitCode: 255, reason: 'auth_error', endedAt: Date.now() });
  assert.equal(finalized.length, 1);
  assert.equal(finalized[0][0], registered[0].sessionKey);
  assert.equal(registered[0].profileId, 'default');
  assert.equal(finalized[0][1].bytesReceived, 33);
  server.stop = async () => server.emit('stopped');
  await f.controller.stop();
  await f.controller.dispose();
});

test('periodic and traffic publications share a two-Hz cap and increasing monotonic sample sequence', async () => {
  const f = fixture();
  await f.controller.start(config, 'session=one', f.scope);
  f.servers[0].emit('traffic');
  const traffic = [...f.timers.values()].find((timer) => !timer.interval);
  traffic.fn();
  const samples = f.events.filter(([name]) => name === 'stats-update').map(([, value]) => value);
  assert.equal(samples.length, 2);
  assert.equal(samples[1].sampledAt - samples[0].sampledAt, 500);
  assert.ok(samples[1].sequence > samples[0].sequence);
  f.controller.setScope({ ...f.scope, epoch: 2 });
  const next = f.controller.getStats();
  assert.equal(next.epoch, 2);
  assert.ok(next.sequence > samples[1].sequence);
  await f.controller.dispose();
});

test('terminal network failures notify recovery only for the current visible nonstopping instance', async () => {
  const f = fixture();
  await f.controller.start(config, 'session=one', f.scope);
  const server = f.servers[0];
  for (const reason of ['completed', 'user_disconnect', 'proxy_stop', 'auth_error', 'timeout', 'output_limit']) {
    server.emit('session-close', { sessionId: 1, reason });
  }
  assert.equal(f.networkErrors.length, 0);
  server.emit('session-close', { sessionId: 1, reason: 'network_error' });
  assert.equal(f.networkErrors.length, 1);
  assert.equal(f.networkErrors[0].epoch, f.scope.epoch);
  assert.equal(f.networkErrors[0].profileId, f.scope.profileId);
  assert.equal(typeof f.networkErrors[0].instanceId, 'string');
  f.controller.setScope({ profileId: 'other', epoch: 2 });
  server.emit('session-close', { sessionId: 1, reason: 'network_error' });
  assert.equal(f.networkErrors.length, 1);
  f.controller.setScope(f.scope);
  server.stop = async () => {
    server.emit('session-close', { sessionId: 1, reason: 'network_error' });
    throw new Error('stop timeout');
  };
  const stopping = f.controller.stop();
  server.emit('session-close', { sessionId: 1, reason: 'network_error' });
  assert.equal(f.networkErrors.length, 1);
  await assert.rejects(stopping, { code: 'PROXY_STOP_FAILED' });
  server.emit('session-close', { sessionId: 1, reason: 'network_error' });
  assert.equal(f.networkErrors.length, 1);
  server.stop = async () => server.emit('stopped');
  await f.controller.stop();
  await f.controller.start(config, 'session=two', f.scope);
  server.emit('session-close', { sessionId: 1, reason: 'network_error' });
  assert.equal(f.networkErrors.length, 1);
  await f.controller.dispose();
});

test('uncommitted candidate network failures never initiate recovery', async () => {
  const f = fixture();
  await f.controller.startCandidate({ config, cookie: 'session=one', scope: f.scope,
    transactionId: 'network-candidate', keyMaterial: { hostKey: 'candidate-only' } });
  f.servers[0].emit('session-close', { sessionId: 1, reason: 'network_error' });
  assert.equal(f.networkErrors.length, 0);
  await f.controller.dispose();
});
