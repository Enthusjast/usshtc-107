'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { WebSocketServer } = require('ws');
const { harness, check, event, bounded } = require('../fixtures/ssh-transport.cjs');

// Public loopback-only test trust material. Certificate verification stays on;
// the application is given this CA rather than disabling TLS verification.
const certificate = fs.readFileSync(path.join(__dirname, '../fixtures/loopback-test-only-cert.pem'));
const tlsKey = fs.readFileSync(path.join(__dirname, '../fixtures/loopback-test-only-key.pem'));

async function faultServer(t) {
  const server = https.createServer({ key: tlsKey, cert: certificate });
  const wss = new WebSocketServer({ noServer: true });
  const events = new EventEmitter();
  const peers = [];
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (ws) => {
    const peer = { ws, messages: [], earlyInput: false, released: false, events: new EventEmitter() };
    peers.push(peer);
    ws.on('error', () => {});
    ws.on('message', (raw) => {
      const value = JSON.parse(raw.toString('utf8'));
      peer.messages.push(value);
      if (!peer.released) peer.earlyInput = true;
      peer.events.emit('message', value);
    });
    ws.on('close', () => peer.events.emit('closed'));
    // Upgrade/open, control traffic, malformed JSON, an unknown message and a
    // data-shaped message with non-string payload are not readiness evidence.
    ws.ping();
    ws.send('not-json');
    ws.send(JSON.stringify({ $case: 'heartbeat' }));
    ws.send(JSON.stringify({ $case: 'data', data: { data: 0 } }));
    events.emit('peer', peer);
  });
  t.after(async () => {
    for (const peer of peers) peer.ws.terminate();
    for (const socket of sockets) socket.destroy();
    await bounded(new Promise((resolve) => wss.close(resolve)), 3000, 'FAULT_WSS_CLEANUP_TIMEOUT');
    await bounded(new Promise((resolve) => server.close(resolve)), 3000, 'FAULT_TLS_CLEANUP_TIMEOUT');
  });
  const listening = event(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  return {
    options: {
      cookie: 'SCOW_USER=loopback-fault-only',
      wssUrl: `wss://127.0.0.1:${server.address().port}/shell`, tlsCa: certificate,
      execTimeoutMs: 3000, remoteReadyTimeoutMs: 250,
    },
    peer: () => event(events, 'peer'),
    release(peer, payload = '') {
      peer.released = true;
      peer.ws.send(JSON.stringify({ $case: 'data', data: { data: payload } }));
    },
  };
}

test('transport harness requires explicit loopback WSS, fixture credentials and trusted test CA', async t => {
  const valid = { cookie: 'SCOW_USER=loopback-fault-only', tlsCa: certificate, wssUrl: 'wss://127.0.0.1:12345/shell' };
  for (const options of [{}, { ...valid, cookie: undefined }, { ...valid, tlsCa: undefined },
    { ...valid, wssUrl: 'wss://example.invalid:443/shell' },
    { ...valid, wssUrl: 'https://127.0.0.1:12345/shell' },
    { ...valid, wssUrl: 'wss://127.0.0.1/shell' }]) {
    await assert.rejects(harness(t, options), { code: 'LOCAL_FIXTURE_REQUIRED' });
  }
});

for (const kind of ['exec', 'shell']) {
  test(`real TLS/WSS ${kind} silence times out without auth invalidation or early input`, { timeout: 12000 }, async (t) => {
    const remote = await faultServer(t);
    const f = await harness(t, remote.options);
    const auth = [];
    const ready = [];
    f.proxy.on('auth-error', (value) => auth.push(value));
    f.proxy.on('remote-ready', (value) => ready.push(value));
    const notReady = event(f.proxy, 'remote-not-ready');
    const terminalClosed = event(f.proxy, 'session-close');
    const client = await f.connect();
    const connected = remote.peer();
    const stream = kind === 'exec' ? await f.execChannel(client, 'true') : await f.shell(client);
    if (kind === 'shell') stream.channel.write('queued-input\r');
    const peer = await connected;
    const timeout = await notReady;
    await stream.closed(5000);
    const terminal = await terminalClosed;
    check(timeout.code === 'REMOTE_READY_TIMEOUT', 'FAULT_TIMEOUT_CODE');
    check(timeout.sessionId === terminal.sessionId, 'FAULT_TIMEOUT_SESSION');
    check(stream.code === 255 && terminal.reason === 'remote_not_ready', 'FAULT_TIMEOUT_EXIT');
    check(auth.length === 0 && ready.length === 0, 'FAULT_SILENCE_AUTH_OR_READY');
    check(peer.messages.length === 0 && !peer.earlyInput, 'FAULT_EARLY_INPUT');
    check(stream.errors().toString('utf8').startsWith('REMOTE_READY_TIMEOUT:'), 'FAULT_CLEAR_DIAGNOSTIC');
  });
}

for (const kind of ['exec', 'shell']) {
  test(`real TLS/WSS ${kind} delayed empty data releases input only after readiness`, { timeout: 12000 }, async (t) => {
    const remote = await faultServer(t);
    const f = await harness(t, { ...remote.options, remoteReadyTimeoutMs: 2000 });
    const client = await f.connect();
    const connected = remote.peer();
    const ready = event(f.proxy, 'remote-ready');
    const stream = kind === 'exec' ? await f.execChannel(client, 'true') : await f.shell(client);
    if (kind === 'shell') stream.channel.write('queued-input\r');
    const peer = await connected;
    // A round-trip ping proves the pre-readiness frames were delivered and the
    // transport is live. This is an event barrier, not a scheduling sleep.
    const pong = event(peer.ws, 'pong');
    peer.ws.ping();
    await pong;
    check(peer.messages.length === 0 && !peer.earlyInput, 'FAULT_INPUT_BEFORE_VALID_DATA');
    const received = event(peer.events, 'message', { predicate: (value) => value.$case === 'data' });
    remote.release(peer, '');
    const proof = await ready;
    const input = await received;
    check(Boolean(proof.sessionId), 'FAULT_READY_SESSION');
    check(!peer.earlyInput && typeof input.data?.data === 'string' && input.data.data.length > 0, 'FAULT_INPUT_NOT_RELEASED');
    check(stream.bytes().length === 0, 'FAULT_EMPTY_FRAME_OUTPUT');
    // The synthetic endpoint need not execute a command to prove wire gating.
    peer.ws.send(JSON.stringify({ $case: 'exit', exit: { code: 3 } }));
    await stream.closed(5000);
    check(stream.code === 3, 'FAULT_RELEASED_CHANNEL_EXIT');
  });
}

test('real TLS/WSS first data after timeout cannot resurrect or replay the channel', { timeout: 12000 }, async (t) => {
  const remote = await faultServer(t);
  const f = await harness(t, remote.options);
  const client = await f.connect();
  const connected = remote.peer();
  const timedOut = event(f.proxy, 'remote-not-ready');
  let readyCount = 0;
  f.proxy.on('remote-ready', () => { readyCount += 1; });
  const stream = await f.execChannel(client, 'true');
  const peer = await connected;
  // Inject as soon as the timeout is emitted, while the real WSS socket can
  // still be OPEN, instead of replacing the network with a FakeWebSocket.
  await timedOut;
  if (peer.ws.readyState === 1) remote.release(peer, 'late-first-frame');
  await stream.closed(5000);
  check(stream.code === 255 && readyCount === 0, 'FAULT_LATE_FRAME_RESURRECTED');
  check(peer.messages.length === 0 && stream.bytes().length === 0, 'FAULT_LATE_FRAME_REPLAYED');
});
