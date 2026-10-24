const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { utils: sshUtils } = require('ssh2');

const { ProxyServer } = require('../electron/proxy-server');
const { MAX_COOKIE_BYTES } = require('../electron/credential-store');

const defaultRawKey = Buffer.alloc(32, 7);
const algorithm = Buffer.from('ssh-ed25519');
const defaultKeyBlob = Buffer.alloc(4 + algorithm.length + 4 + defaultRawKey.length);
defaultKeyBlob.writeUInt32BE(algorithm.length, 0);
algorithm.copy(defaultKeyBlob, 4);
defaultKeyBlob.writeUInt32BE(defaultRawKey.length, 4 + algorithm.length);
defaultRawKey.copy(defaultKeyBlob, 8 + algorithm.length);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

class FakeWebSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 0;
    this.bufferedAmount = 0;
    this.sent = [];
    this.terminated = false;
    this.paused = false;
  }

  open() {
    this.readyState = 1;
    this.emit('open');
  }

  send(data, callback) {
    if (this.readyState !== 1) {
      callback?.(new Error('not open'));
      return;
    }
    this.sent.push(data);
    callback?.();
  }

  message(payload) {
    this.emit('message', Buffer.from(JSON.stringify({
      $case: 'data',
      data: { data: payload },
    })));
  }

  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.emit('close', code));
  }

  terminate() {
    if (this.readyState === 3) return;
    this.terminated = true;
    this.readyState = 3;
    queueMicrotask(() => {
      this.emit('error', new Error('handshake aborted'));
      this.emit('close', 1006);
    });
  }

  ping() {}

  pause() { this.paused = true; }

  resume() { this.paused = false; }
}

class FakeChannel extends EventEmitter {
  constructor() {
    super();
    this.closed = false;
    this.writes = [];
    this.exitCodes = [];
    this.paused = false;
    this.endCalled = false;
    this.closeCalled = false;
    this.writeResult = true;
  }

  write(data) {
    this.writes.push(Buffer.from(data));
    return this.writeResult;
  }

  exit(code) { this.exitCodes.push(code); }

  end() {
    this.endCalled = true;
    this._finish();
  }

  close() {
    this.closeCalled = true;
    this._finish();
  }

  pause() { this.paused = true; }

  resume() { this.paused = false; }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emit('close'));
  }
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.timeoutMs = null;
  }

  setTimeout(ms) { this.timeoutMs = ms; }

  setNoDelay() {}

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    queueMicrotask(() => this.emit('close'));
  }
}

class FakeTcpServer extends EventEmitter {
  constructor(connectionListener, listenDelayMs = 30) {
    super();
    this.connectionListener = connectionListener;
    this.listenDelayMs = listenDelayMs;
    this.listening = false;
    this.closed = false;
    this.listenOptions = null;
    this._listenTimer = null;
  }

  listen(options, callback) {
    this.listenOptions = options;
    options.signal?.addEventListener('abort', () => this.close(() => {}), { once: true });
    this._listenTimer = setTimeout(() => {
      this._listenTimer = null;
      if (this.closed) return;
      this.listening = true;
      callback();
    }, this.listenDelayMs);
  }

  close(callback) {
    if (this.closed) {
      const error = new Error('already closed');
      error.code = 'ERR_SERVER_NOT_RUNNING';
      queueMicrotask(() => callback?.(error));
      return;
    }
    this.closed = true;
    this.listening = false;
    if (this._listenTimer) clearTimeout(this._listenTimer);
    this._listenTimer = null;
    queueMicrotask(() => {
      this.emit('close');
      callback?.();
    });
  }
}

class StuckTcpServer extends FakeTcpServer {
  constructor(connectionListener) {
    super(connectionListener, 0);
    this.allowClose = false;
    this.forceCloseCalls = 0;
  }

  close(callback) {
    if (!this.allowClose) return;
    super.close(callback);
  }

  closeAllConnections() {
    this.forceCloseCalls += 1;
  }
}

class FakeSSHServer extends EventEmitter {
  constructor(_options, connectionListener) {
    super();
    this.connectionListener = connectionListener;
    this.maxConnections = Infinity;
    this.injected = [];
  }

  injectSocket(socket) { this.injected.push(socket); }
}

function makeProxy(overrides = {}) {
  return new ProxyServer({
    authorizedKey: defaultRawKey,
    authorizedKeyOpenSSH: 'test-key',
    parseKey: () => ({
      type: 'ssh-ed25519',
      getPublicSSH: () => defaultKeyBlob,
      verify: () => true,
    }),
    ...overrides,
  });
}

test('proxy Cookie values are bounded and type checked', () => {
  const maximumCookie = 'x'.repeat(MAX_COOKIE_BYTES);
  assert.equal(makeProxy({ cookie: maximumCookie }).cookie, maximumCookie);
  assert.throws(
    () => makeProxy({ cookie: `${maximumCookie}x` }),
    (error) => error?.code === 'CREDENTIAL_LIMIT_EXCEEDED',
  );
  assert.throws(() => makeProxy({ cookie: null }), /cookie must be a string/);

  const proxy = makeProxy({ cookie: 'session=initial' });
  assert.throws(
    () => proxy.updateCookie(`${maximumCookie}x`),
    (error) => error?.code === 'CREDENTIAL_LIMIT_EXCEEDED',
  );
  assert.throws(() => proxy.updateCookie(null), /cookie must be a string/);
  assert.equal(proxy.cookie, 'session=initial');
});

test('WSS options enforce TLS verification, custom CA, and a payload cap', async () => {
  const ws = new FakeWebSocket();
  const ca = Buffer.from('test-ca');
  let capturedOptions;
  const proxy = makeProxy({
    cookie: 'SECRET_COOKIE_VALUE',
    tlsCa: ca,
    rejectUnauthorized: false,
    maxWssPayloadBytes: 4096,
    webSocketFactory: (_url, options) => {
      capturedOptions = options;
      return ws;
    },
  });
  const logs = [];
  proxy.on('proxy-log', (...args) => logs.push(args.join(' ')));
  const channel = new FakeChannel();

  proxy._bridgeSshToWss(channel, '127.0.0.1:1');
  const [session] = proxy.getSessions();
  assert.ok(session);
  assert.equal(capturedOptions.rejectUnauthorized, true);
  assert.equal(capturedOptions.maxPayload, 4096);
  assert.deepEqual(capturedOptions.ca, [...require('node:tls').rootCertificates, ca]);
  assert.equal(logs.join('\n').includes('SECRET_COOKIE_VALUE'), false);

  assert.equal(proxy.disconnectSession(session.id), true);
  await nextTurn();
  assert.equal(ws.terminated, true);
  assert.equal(proxy.getSessions().length, 0);
});

test('public key authentication fails closed when parsed key material is missing', () => {
  const proxy = new ProxyServer({
    authorizedKey: Buffer.alloc(32, 7),
    authorizedKeyOpenSSH: '',
  });
  const client = new EventEmitter();
  client._sock = null;
  proxy._onSshClient(client);

  let accepted = 0;
  let rejected = 0;
  client.emit('authentication', {
    method: 'publickey',
    key: { algo: 'ssh-ed25519', data: Buffer.alloc(32, 7) },
    signature: Buffer.alloc(64),
    blob: Buffer.from('blob'),
    accept: () => { accepted += 1; },
    reject: () => { rejected += 1; },
  });

  assert.equal(accepted, 0);
  assert.equal(rejected, 1);
  client.emit('close');
});

test('public key authentication accepts a matching Ed25519 signature', () => {
  const keyPair = sshUtils.generateKeyPairSync('ed25519');
  const publicKey = sshUtils.parseKey(keyPair.public);
  const privateKey = sshUtils.parseKey(keyPair.private);
  const publicBlob = publicKey.getPublicSSH();
  const rawKey = publicBlob.subarray(publicBlob.length - 32);
  const proxy = new ProxyServer({
    authorizedKey: rawKey,
    authorizedKeyOpenSSH: keyPair.public,
  });
  const client = new EventEmitter();
  client._sock = null;
  proxy._onSshClient(client);

  const blob = Buffer.from('signed-authentication-request');
  const signature = privateKey.sign(blob);
  let accepted = 0;
  let rejected = 0;
  client.emit('authentication', {
    method: 'publickey',
    key: { algo: 'ssh-ed25519', data: publicBlob },
    signature,
    blob,
    accept: () => { accepted += 1; },
    reject: () => { rejected += 1; },
  });

  assert.equal(accepted, 1);
  assert.equal(rejected, 0);
  client.emit('close');
});

test('public key authentication rejects verifier errors and mismatched parsed keys', () => {
  const mismatchedRawKey = Buffer.alloc(32, 8);
  const invalidProxy = makeProxy({ authorizedKey: mismatchedRawKey });
  assert.equal(invalidProxy._authConfigValid, false);

  const proxy = makeProxy({
    parseKey: () => ({
      type: 'ssh-ed25519',
      getPublicSSH: () => defaultKeyBlob,
      verify: () => new Error('verification failed'),
    }),
  });
  const client = new EventEmitter();
  client._sock = null;
  proxy._onSshClient(client);

  let accepted = 0;
  let rejected = 0;
  client.emit('authentication', {
    method: 'publickey',
    key: { algo: 'ssh-ed25519', data: defaultKeyBlob },
    signature: Buffer.alloc(64),
    blob: Buffer.from('blob'),
    accept: () => { accepted += 1; },
    reject: () => { rejected += 1; },
  });

  assert.equal(accepted, 0);
  assert.equal(rejected, 1);
  client.emit('close');
});

test('stop cancels a server that is still starting without leaving a listener', async () => {
  let tcpServer;
  const netModule = {
    createServer: (_options, listener) => {
      tcpServer = new FakeTcpServer(listener);
      return tcpServer;
    },
  };
  const proxy = makeProxy({
    netModule,
    SSHServerClass: FakeSSHServer,
    hostKey: 'fake-host-key',
    shutdownTimeoutMs: 50,
  });
  let startedEvents = 0;
  let stoppedEvents = 0;
  proxy.on('started', () => { startedEvents += 1; });
  proxy.on('stopped', () => { stoppedEvents += 1; });

  const startPromise = proxy.start();
  await nextTurn();
  assert.equal(proxy._starting, true);
  const stopPromise = proxy.stop();
  const [startResult] = await Promise.all([startPromise, stopPromise]);

  assert.equal(startResult, false);
  assert.equal(tcpServer.listening, false);
  assert.equal(tcpServer.closed, true);
  assert.equal(proxy._started, false);
  assert.equal(proxy._server, null);
  assert.equal(startedEvents, 0);
  assert.equal(stoppedEvents, 1);
});

test('start and stop complete the normal lifecycle exactly once', async () => {
  let tcpServer;
  const netModule = {
    createServer: (_options, listener) => {
      tcpServer = new FakeTcpServer(listener, 0);
      return tcpServer;
    },
  };
  const proxy = makeProxy({
    netModule,
    SSHServerClass: FakeSSHServer,
    hostKey: 'fake-host-key',
    shutdownTimeoutMs: 50,
  });
  let startedEvents = 0;
  let stoppedEvents = 0;
  proxy.on('started', () => { startedEvents += 1; });
  proxy.on('stopped', () => { stoppedEvents += 1; });

  assert.equal(await proxy.start(), true);
  assert.equal(proxy._started, true);
  assert.equal(tcpServer.listening, true);
  await proxy.stop();

  assert.equal(proxy._started, false);
  assert.equal(proxy._server, null);
  assert.equal(tcpServer.closed, true);
  assert.equal(startedEvents, 1);
  assert.equal(stoppedEvents, 1);
});

test('start requested during stop restarts only after shutdown completes', async () => {
  const tcpServers = [];
  const netModule = {
    createServer: (_options, listener) => {
      const server = new FakeTcpServer(listener, 0);
      tcpServers.push(server);
      return server;
    },
  };
  const proxy = makeProxy({
    netModule,
    SSHServerClass: FakeSSHServer,
    hostKey: 'fake-host-key',
    shutdownTimeoutMs: 50,
  });
  let startedEvents = 0;
  let stoppedEvents = 0;
  proxy.on('started', () => { startedEvents += 1; });
  proxy.on('stopped', () => { stoppedEvents += 1; });

  assert.equal(await proxy.start(), true);
  const stopPromise = proxy.stop();
  const restartPromise = proxy.start();
  await stopPromise;
  assert.equal(await restartPromise, true);

  assert.equal(tcpServers.length, 2);
  assert.equal(tcpServers[0].closed, true);
  assert.equal(tcpServers[1].listening, true);
  assert.equal(proxy._started, true);
  assert.equal(startedEvents, 2);
  assert.equal(stoppedEvents, 1);
  await proxy.stop();
});

test('start refuses to replace a residual TCP server reference', async () => {
  let createServerCalls = 0;
  const proxy = makeProxy({
    netModule: {
      createServer: () => {
        createServerCalls += 1;
        return new FakeTcpServer(() => {}, 0);
      },
    },
    SSHServerClass: FakeSSHServer,
    hostKey: 'fake-host-key',
  });
  const retainedServer = new FakeTcpServer(() => {}, 0);
  proxy._server = retainedServer;

  await assert.rejects(
    proxy.start(),
    (error) => error.code === 'ERR_PROXY_SERVER_NOT_STOPPED'
  );

  assert.equal(createServerCalls, 0);
  assert.equal(proxy._server, retainedServer);
});

test('stop reports a TCP close timeout and retains the server for a successful retry', async () => {
  let tcpServer;
  const proxy = makeProxy({
    netModule: {
      createServer: (_options, listener) => {
        tcpServer = new StuckTcpServer(listener);
        return tcpServer;
      },
    },
    SSHServerClass: FakeSSHServer,
    hostKey: 'fake-host-key',
    shutdownTimeoutMs: 10,
  });
  let stoppedEvents = 0;
  proxy.on('stopped', () => { stoppedEvents += 1; });
  const socket = {
    destroyCalls: 0,
    destroy() { this.destroyCalls += 1; },
  };

  assert.equal(await proxy.start(), true);
  proxy._sockets.set(socket, {});
  await assert.rejects(
    proxy.stop(),
    (error) => error.code === 'ERR_PROXY_SERVER_CLOSE_TIMEOUT'
  );

  assert.equal(tcpServer.forceCloseCalls, 1);
  assert.equal(socket.destroyCalls, 2);
  assert.equal(proxy._server, tcpServer);
  assert.equal(proxy._stopping, false);
  assert.equal(stoppedEvents, 0);

  tcpServer.allowClose = true;
  await proxy.stop();
  assert.equal(proxy._server, null);
  assert.equal(stoppedEvents, 1);
});

test('start queued behind a timed-out stop does not replace the retained server', async () => {
  const tcpServers = [];
  const proxy = makeProxy({
    netModule: {
      createServer: (_options, listener) => {
        const server = new StuckTcpServer(listener);
        tcpServers.push(server);
        return server;
      },
    },
    SSHServerClass: FakeSSHServer,
    hostKey: 'fake-host-key',
    shutdownTimeoutMs: 10,
  });

  assert.equal(await proxy.start(), true);
  const retainedServer = tcpServers[0];
  const stopPromise = proxy.stop();
  const restartPromise = proxy.start();
  const isCloseTimeout = (error) => error.code === 'ERR_PROXY_SERVER_CLOSE_TIMEOUT';

  await Promise.all([
    assert.rejects(stopPromise, isCloseTimeout),
    assert.rejects(restartPromise, isCloseTimeout),
  ]);

  assert.equal(tcpServers.length, 1);
  assert.equal(proxy._server, retainedServer);
  assert.equal(proxy._started, false);

  retainedServer.allowClose = true;
  await proxy.stop();
  assert.equal(proxy._server, null);
});

test('exec timeout returns 124 and never logs command, output, or cookie', async () => {
  const ws = new FakeWebSocket();
  const secretCommand = 'echo SECRET_COMMAND_TOKEN';
  const proxy = makeProxy({
    cookie: 'SECRET_COOKIE_TOKEN',
    execTimeoutMs: 15,
    webSocketFactory: () => ws,
  });
  const logs = [];
  proxy.on('proxy-log', (...args) => logs.push(args.join(' ')));
  const channel = new FakeChannel();

  proxy._bridgeExecToWss(channel, '127.0.0.1:2', secretCommand);
  ws.open();
  await delay(35);

  assert.deepEqual(channel.exitCodes, [124]);
  assert.equal(channel.endCalled, true);
  assert.equal(logs.join('\n').includes('SECRET_COMMAND_TOKEN'), false);
  assert.equal(logs.join('\n').includes('SECRET_COOKIE_TOKEN'), false);
  assert.equal(proxy.getSessions().length, 0);
});

function execNonce(ws) {
  const bootstrap = ws.sent.map((message) => JSON.parse(message))
    .filter((message) => message.$case === 'data').map((message) => message.data.data).join('');
  const nonce = bootstrap.match(/USSHTC_([a-f0-9]{64}):READY/)?.[1];
  assert.ok(nonce, 'exec bootstrap contains the random protocol nonce');
  return nonce;
}

function startExec(ws) {
  const nonce = execNonce(ws);
  ws.message(`\x1eUSSHTC_${nonce}:READY\x1f`);
  ws.message(`\x1eUSSHTC_${nonce}:START\x1f`);
  return nonce;
}

function completeExec(ws, nonce, output, code = 0) {
  const record = Buffer.from(`\x1eUSSHTC_${nonce}:END:${code}\x1f`);
  ws.message(Buffer.concat([Buffer.from(output), record]).toString('base64'));
}

test('exec READY gates command and incremental base64 preserves exact bytes/status', async () => {
  const ws = new FakeWebSocket();
  const proxy = makeProxy({ webSocketFactory: () => ws });
  const logs = [];
  proxy.on('proxy-log', (...args) => logs.push(args.join(' ')));
  const channel = new FakeChannel();
  const command = "printf '中文🙂'\n\n";
  proxy._bridgeExecToWss(channel, 'fixture', command);
  ws.open();
  assert.equal(ws.sent.length, 1);
  const nonce = execNonce(ws);
  const ready = `\x1eUSSHTC_${nonce}:READY\x1f`;
  for (const char of ready) ws.message(char);
  assert.equal(ws.sent.length, 2);
  assert.equal(Buffer.from(JSON.parse(ws.sent[1]).data.data.trim(), 'base64').toString(), command);
  const start = `\x1eUSSHTC_${nonce}:START\x1f`;
  for (const char of start) ws.message(char);
  const expected = Buffer.from('  x\t\r\n中文🙂\x1b[31m\x00\n\n');
  const encoded = Buffer.concat([expected, Buffer.from(`\x1eUSSHTC_${nonce}:END:70\x1f`)]).toString('base64');
  for (const char of encoded) ws.message(char);
  await nextTurn();
  assert.deepEqual(channel.exitCodes, [70]);
  assert.deepEqual(Buffer.concat(channel.writes), expected);
  assert.equal(logs.join('\n').includes(command), false);
  assert.equal(proxy.getSessions().length, 0);
});

test('exec decoded output cap returns 125 without normalizing output', async () => {
  const ws = new FakeWebSocket();
  const proxy = makeProxy({ maxExecOutputBytes: 4, webSocketFactory: () => ws });
  const channel = new FakeChannel();
  proxy._bridgeExecToWss(channel, 'fixture', 'echo output');
  ws.open();
  completeExec(ws, startExec(ws), '12345');
  await nextTurn();
  assert.deepEqual(channel.exitCodes, [125]);
  assert.equal(proxy.getSessions().length, 0);
});

test('disconnectSession completes the requested bridge and removes its record', async () => {
  const ws = new FakeWebSocket();
  const proxy = makeProxy({ webSocketFactory: () => ws });
  const channel = new FakeChannel();

  proxy._bridgeSshToWss(channel, '127.0.0.1:4');
  const [session] = proxy.getSessions();
  assert.equal(proxy.disconnectSession(session.id), true);
  await nextTurn();

  assert.equal(channel.endCalled, true);
  assert.equal(proxy.getSessions().length, 0);
});

test('WSS close 1011 fails the session but does not invalidate authentication', async () => {
  const ws = new FakeWebSocket();
  const proxy = makeProxy({ webSocketFactory: () => ws });
  const channel = new FakeChannel();
  let authErrors = 0;
  proxy.on('auth-error', () => { authErrors += 1; });

  proxy._bridgeSshToWss(channel, '127.0.0.1:5');
  ws.open();
  ws.readyState = 3;
  ws.emit('close', 1011);
  await nextTurn();

  assert.equal(authErrors, 0);
  assert.deepEqual(channel.exitCodes, [255]);
  assert.equal(proxy.getSessions().length, 0);
});

test('raw TCP sockets are capped, tracked, and closed on handshake timeout', async () => {
  const proxy = makeProxy({
    maxConnections: 1,
    sshHandshakeTimeoutMs: 10,
  });
  const injected = [];
  proxy._sshServer = { injectSocket: (socket) => injected.push(socket) };
  const first = new FakeSocket();
  const second = new FakeSocket();

  proxy._handleTcpSocket(first);
  proxy._handleTcpSocket(second);
  assert.deepEqual(injected, [first]);
  assert.equal(second.destroyed, true);
  assert.equal(first.timeoutMs, proxy.socketIdleTimeoutMs);

  await delay(20);
  assert.equal(first.destroyed, true);
  assert.equal(proxy._sockets.size, 0);
});

test('SSH handshake timeout remains armed until authentication is ready', () => {
  const proxy = makeProxy({ sshHandshakeTimeoutMs: 1000 });
  const socket = new FakeSocket();
  assert.equal(proxy._trackTcpSocket(socket), true);
  const client = new EventEmitter();
  client._sock = socket;

  proxy._onSshClient(client);
  assert.ok(proxy._sockets.get(socket).handshakeTimer);
  client.emit('ready');
  assert.equal(proxy._sockets.get(socket).handshakeTimer, null);

  client.emit('close');
  socket.destroy();
});

test('SSH client close removes every channel owned by that client', () => {
  const proxy = makeProxy();
  const client = new EventEmitter();
  client._sock = null;
  proxy._onSshClient(client);
  client.emit('ready');

  const firstSession = new EventEmitter();
  const secondSession = new EventEmitter();
  client.emit('session', () => firstSession, () => {});
  client.emit('session', () => secondSession, () => {});
  assert.equal(proxy._sshChannels.size, 2);

  client.emit('close');
  assert.equal(proxy._sshChannels.size, 0);
  assert.equal(firstSession.listenerCount('close'), 0);
  assert.equal(firstSession.listenerCount('error'), 0);
  assert.equal(secondSession.listenerCount('close'), 0);
  assert.equal(secondSession.listenerCount('error'), 0);
});

test('SSH channel errors remove channel tracking and cleanup listeners', () => {
  const proxy = makeProxy();
  const client = new EventEmitter();
  client._sock = null;
  proxy._onSshClient(client);
  client.emit('ready');

  const sshSession = new EventEmitter();
  client.emit('session', () => sshSession, () => {});
  assert.equal(proxy._sshChannels.has(sshSession), true);
  sshSession.emit('error', new Error('channel failed'));

  assert.equal(proxy._sshChannels.has(sshSession), false);
  assert.equal(sshSession.listenerCount('close'), 0);
  assert.equal(sshSession.listenerCount('error'), 0);
  client.emit('close');
});

test('pending SSH input is bounded while WSS is connecting', async () => {
  const ws = new FakeWebSocket();
  const proxy = makeProxy({
    maxPendingBytes: 4,
    webSocketFactory: () => ws,
  });
  const channel = new FakeChannel();

  proxy._bridgeSshToWss(channel, '127.0.0.1:6');
  channel.emit('data', Buffer.from('12345'));
  await nextTurn();

  assert.equal(ws.terminated, true);
  assert.deepEqual(channel.exitCodes, [1]);
  assert.equal(proxy.getSessions().length, 0);
});

test('interactive bridge applies backpressure in both directions', async () => {
  const ws = new FakeWebSocket();
  const proxy = makeProxy({
    backpressurePollMs: 5,
    wssHandshakeTimeoutMs: 100,
    maxWsBufferedBytes: 64,
    webSocketFactory: () => ws,
  });
  const channel = new FakeChannel();

  proxy._bridgeSshToWss(channel, '127.0.0.1:7');
  ws.open();
  ws.bufferedAmount = 64;
  channel.emit('data', Buffer.from('input'));
  assert.equal(channel.paused, true);
  assert.equal(ws.sent.length, 0);

  ws.bufferedAmount = 0;
  await delay(15);
  assert.equal(channel.paused, false);
  assert.equal(ws.sent.length, 1);

  channel.writeResult = false;
  ws.message('output');
  assert.equal(ws.paused, true);
  channel.emit('drain');
  assert.equal(ws.paused, false);

  const [session] = proxy.getSessions();
  proxy.disconnectSession(session.id);
  await nextTurn();
  assert.equal(proxy.getSessions().length, 0);
});

function dataText(ws) {
  return ws.sent.map((message) => JSON.parse(message)).filter((message) => message.$case === 'data')
    .map((message) => message.data.data).join('');
}

test('all UTF8 byte splits survive connecting, backpressure, Unicode wire framing and EOF', async () => {
  const expected = '中文🙂é\n\t"\\\x00';
  const input = Buffer.from(expected);
  for (const mode of ['connecting', 'open', 'blocked']) {
    for (let split = 0; split <= input.length; split += 1) {
      const ws = new FakeWebSocket();
      const proxy = makeProxy({ webSocketFactory: () => ws, maxWsBufferedBytes: 52, backpressurePollMs: 1 });
      const channel = new FakeChannel();
      proxy._bridgeSshToWss(channel, 'fixture');
      if (mode !== 'connecting') ws.open();
      if (mode === 'blocked') ws.bufferedAmount = 52;
      channel.emit('data', input.subarray(0, split));
      channel.emit('data', input.subarray(split));
      channel.emit('end');
      channel.emit('end'); // decoder.end() must run only once.
      if (mode === 'connecting') ws.open();
      ws.bufferedAmount = 0;
      if (mode === 'blocked') await delay(5);
      assert.equal(dataText(ws), expected, `${mode} split ${split}`);
      for (const wire of ws.sent) {
        assert.ok(Buffer.byteLength(wire) <= 52);
        const text = JSON.parse(wire).data?.data;
        if (text) assert.doesNotMatch(text, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
      }
      assert.equal(JSON.parse(ws.sent.at(-1)).$case, 'disconnect');
      assert.equal(ws.sent.filter((wire) => JSON.parse(wire).$case === 'disconnect').length, 1);
      assert.equal(channel.endCalled, false, 'EOF still permits remote output');
      ws.message('after EOF');
      assert.equal(Buffer.concat(channel.writes).toString(), 'after EOF');
      channel.close();
      await nextTurn();
    }
  }
});

test('per-channel decoders and carry are isolated, counted, and flushed once', async () => {
  const sockets = [new FakeWebSocket(), new FakeWebSocket()];
  const proxy = makeProxy({ maxPendingBytes: 4, webSocketFactory: () => sockets.shift() });
  const firstWs = sockets[0];
  const secondWs = sockets[1];
  const first = new FakeChannel();
  const second = new FakeChannel();
  proxy._bridgeSshToWss(first, 'one');
  proxy._bridgeSshToWss(second, 'two');
  const emoji = Buffer.from('🙂');
  first.emit('data', emoji.subarray(0, 3));
  second.emit('data', Buffer.from('中'));
  firstWs.open(); secondWs.open();
  first.emit('data', emoji.subarray(3));
  assert.equal(dataText(firstWs), '🙂');
  assert.equal(dataText(secondWs), '中');
  second.emit('data', Buffer.from([0xe4, 0xb8]));
  second.emit('end'); second.emit('end');
  assert.equal(dataText(secondWs), '中�');
  first.close(); second.close();
  await nextTurn();
  const overflowWs = new FakeWebSocket();
  const overflow = makeProxy({ maxPendingBytes: 3, webSocketFactory: () => overflowWs });
  const channel = new FakeChannel();
  overflow._bridgeSshToWss(channel, 'carry-limit');
  channel.emit('data', emoji.subarray(0, 3));
  channel.emit('data', emoji.subarray(3));
  assert.deepEqual(channel.exitCodes, [1]);
});

test('EOF waits for queued input and Ctrl-D is ordinary input', async () => {
  const ws = new FakeWebSocket();
  const proxy = makeProxy({ webSocketFactory: () => ws, backpressurePollMs: 1 });
  const channel = new FakeChannel();
  proxy._bridgeSshToWss(channel, 'fixture');
  ws.open(); ws.bufferedAmount = proxy.maxWsBufferedBytes;
  channel.emit('data', Buffer.from([4]));
  channel.emit('end');
  assert.equal(ws.sent.length, 0);
  ws.bufferedAmount = 0;
  await delay(5);
  assert.deepEqual(ws.sent.map((wire) => JSON.parse(wire).$case), ['data', 'disconnect']);
  assert.equal(dataText(ws), '\x04');
  assert.equal(ws.readyState, 1);
  channel.close();
});

test('exec rejects NUL before transport and nonempty stdin locally but EOF keeps output alive', async () => {
  let sockets = 0;
  const nul = makeProxy({ webSocketFactory: () => { sockets += 1; return new FakeWebSocket(); } });
  const nulChannel = new FakeChannel();
  nul._bridgeExecToWss(nulChannel, 'fixture', 'x\0y');
  assert.equal(sockets, 0);
  assert.deepEqual(nulChannel.exitCodes, [1]);
  for (const input of [Buffer.from('x'), null]) {
    const ws = new FakeWebSocket();
    const proxy = makeProxy({ webSocketFactory: () => ws });
    const channel = new FakeChannel();
    const localErrors = [];
    channel.stderr = { write: (text) => localErrors.push(text) };
    proxy._bridgeExecToWss(channel, 'fixture', 'printf output');
    ws.open();
    const nonce = startExec(ws);
    if (input) {
      channel.emit('data', input);
      assert.deepEqual(channel.exitCodes, [1]);
      assert.equal(localErrors.join(''), 'Exec stdin is not supported.\n');
    } else {
      channel.emit('end');
      completeExec(ws, nonce, 'output', 7);
      assert.deepEqual(channel.exitCodes, [7]);
      assert.equal(Buffer.concat(channel.writes).toString(), 'output');
    }
    await nextTurn();
  }
});

test('exec transport termination cannot report success before END', async () => {
  for (const upstream of [0, 7, null, 'signal', 'close']) {
    const ws = new FakeWebSocket();
    const proxy = makeProxy({ webSocketFactory: () => ws });
    const channel = new FakeChannel();
    proxy._bridgeExecToWss(channel, 'fixture', 'true');
    ws.open(); startExec(ws);
    if (upstream === 'close') { ws.readyState = 3; ws.emit('close', 1000); }
    else ws.emit('message', Buffer.from(JSON.stringify({ $case: 'exit', exit: upstream === 'signal' ? { signal: 'TERM' } : { code: upstream } })));
    assert.deepEqual(channel.exitCodes, [upstream === 7 ? 7 : 255]);
    await nextTurn();
  }
  const ws = new FakeWebSocket();
  const channel = new FakeChannel();
  makeProxy({ webSocketFactory: () => ws })._bridgeExecToWss(channel, 'fixture', 'true');
  ws.open();
  ws.emit('message', Buffer.from(JSON.stringify({ $case: 'exit', exit: { code: 126 } })));
  assert.deepEqual(channel.exitCodes, [1]);
});

test('exec codec errors map setup/framing to 1 and encoded/prelude resource caps to 125', async () => {
  for (const kind of ['framing', 'encoded', 'prelude']) {
    const ws = new FakeWebSocket();
    const proxy = makeProxy({ webSocketFactory: () => ws, maxExecEncodedBytes: 8, maxExecPreludeBytes: 8 });
    const channel = new FakeChannel();
    proxy._bridgeExecToWss(channel, 'fixture', 'true');
    ws.open();
    if (kind === 'prelude') ws.message('123456789');
    else { startExec(ws); ws.message(kind === 'framing' ? '!' : 'QUFBQUFBQUFB'); }
    assert.deepEqual(channel.exitCodes, [kind === 'framing' ? 1 : 125]);
    await nextTurn();
  }
});

test('accepted exec output drains before exit, and queued output stays bounded', async () => {
  const ws = new FakeWebSocket();
  const proxy = makeProxy({ webSocketFactory: () => ws, maxQueuedOutputBytes: 8 });
  const channel = new FakeChannel();
  channel.writeResult = false;
  proxy._bridgeExecToWss(channel, 'fixture', 'true');
  ws.open();
  completeExec(ws, startExec(ws), '1234', 0);
  assert.equal(ws.paused, true);
  assert.deepEqual(channel.exitCodes, []);
  channel.writeResult = true;
  channel.emit('drain');
  assert.deepEqual(channel.exitCodes, [0]);
  assert.equal(Buffer.concat(channel.writes).toString(), '1234');
  await nextTurn();
  const blockedWs = new FakeWebSocket();
  const blocked = new FakeChannel();
  blocked.writeResult = false;
  const limited = makeProxy({ webSocketFactory: () => blockedWs, maxQueuedOutputBytes: 4 });
  limited._bridgeSshToWss(blocked, 'queue-limit');
  blockedWs.open();
  blockedWs.message('1234');
  blockedWs.message('1234'); // in-flight WS messages after pause still have a bound.
  blockedWs.message('5');
  blocked.writeResult = true;
  blocked.emit('drain');
  assert.deepEqual(blocked.exitCodes, [125]);
  assert.equal(Buffer.concat(blocked.writes).toString(), '12341234');
});

test('reader drain and WSS send stalls have finite resource deadlines', async () => {
  const ws = new FakeWebSocket();
  const proxy = makeProxy({ webSocketFactory: () => ws, shutdownTimeoutMs: 10 });
  const channel = new FakeChannel();
  channel.writeResult = false;
  proxy._bridgeExecToWss(channel, 'fixture', 'true');
  ws.open(); completeExec(ws, startExec(ws), 'output');
  await delay(30);
  assert.deepEqual(channel.exitCodes, [125]);
  assert.equal(proxy.getSessions().length, 0);
  const stalledWs = new FakeWebSocket();
  const stalledChannel = new FakeChannel();
  makeProxy({ webSocketFactory: () => stalledWs, wssHandshakeTimeoutMs: 10, backpressurePollMs: 1 })
    ._bridgeExecToWss(stalledChannel, 'fixture', 'true');
  stalledWs.bufferedAmount = 1024 * 1024;
  stalledWs.open();
  await delay(30);
  assert.deepEqual(stalledChannel.exitCodes, [125]);
});

test('PTY requests validate reply signatures and resize storms coalesce latest shell/exec size', async () => {
  for (const kind of ['shell', 'exec']) {
    const ws = new FakeWebSocket();
    let url;
    const proxy = makeProxy({ cols: 80, rows: 24, backpressurePollMs: 1, webSocketFactory: (value) => { url = value; return ws; } });
    const client = new EventEmitter();
    proxy._onSshClient(client); client.emit('ready');
    const session = new EventEmitter();
    client.emit('session', () => session, () => {});
    let accepted = 0;
    let rejected = 0;
    const accept = () => { accepted += 1; };
    const reject = () => { rejected += 1; };
    session.emit('window-change', accept, reject, { cols: 100, rows: 30 });
    session.emit('pty', accept, reject, { cols: 501, rows: 30 });
    session.emit('pty', accept, reject, { cols: 120, rows: 40 });
    session.emit('pty', accept, reject, { cols: 120, rows: 40 });
    assert.equal(accepted, 1);
    assert.equal(rejected, 3);
    session.emit('window-change', accept, reject, { cols: 0, rows: 0 });
    const channel = new FakeChannel();
    session.emit(kind, () => channel, reject, { command: 'true' });
    assert.equal(new URL(url).searchParams.get('cols'), '120');
    assert.equal(new URL(url).searchParams.get('rows'), '40');
    assert.equal(new URL(proxy.wssUrl).searchParams.get('cols'), '80');
    session.emit('window-change', undefined, undefined, { cols: 121, rows: 41 });
    ws.open();
    assert.ok(ws.sent.some((message) => JSON.parse(message).resize?.cols === 121));
    ws.bufferedAmount = proxy.maxWsBufferedBytes;
    for (let cols = 122; cols <= 400; cols += 1) {
      session.emit('window-change', accept, reject, { cols, rows: 42 });
    }
    session.emit('window-change', undefined, undefined, { cols: -1, rows: 42 });
    ws.bufferedAmount = 0;
    await delay(5);
    const resizes = ws.sent.map((message) => JSON.parse(message)).filter((message) => message.$case === 'resize');
    assert.equal(resizes.length, 2);
    assert.deepEqual(resizes.at(-1).resize, { cols: 400, rows: 42 });
    channel.close(); client.emit('close');
    await nextTurn();
  }
});

test('terminal snapshot contains final counters and kind before deletion and only emits once', async () => {
  const ws = new FakeWebSocket();
  const proxy = makeProxy({ webSocketFactory: () => ws });
  const channel = new FakeChannel();
  const closed = [];
  proxy.on('session-close', (value) => {
    closed.push(value);
    assert.equal(proxy.getSessions().some((session) => session.id === value.sessionId), true);
    assert.equal(value.session.kind, 'shell');
    assert.equal(value.session.bytesSent, Buffer.byteLength('中文'));
    assert.equal(value.session.bytesReceived, Buffer.byteLength('🙂reply'));
  });
  proxy._bridgeSshToWss(channel, 'private-address');
  ws.open();
  channel.emit('data', Buffer.from('中文'));
  ws.message('🙂reply');
  ws.emit('message', Buffer.from(JSON.stringify({ $case: 'exit', exit: { code: 7 } })));
  assert.equal(closed.length, 1);
  assert.equal(closed[0].exitCode, 7);
  assert.equal(closed[0].reason, 'completed');
  assert.ok(closed[0].endedAt >= closed[0].session.connectedAt);
  assert.equal(proxy.getSessions().length, 0);
  channel.emit('close');
  ws.emit('error', new Error('late transport failure'));
  await nextTurn();
  assert.equal(closed.length, 1);
});

test('history terminal reasons reflect source rather than guessing from a numeric exec exit status', async () => {
  for (const exitCode of [0, 124, 125, 255]) {
    const ws = new FakeWebSocket();
    const proxy = makeProxy({ webSocketFactory: () => ws });
    const channel = new FakeChannel();
    let terminal;
    proxy.on('session-close', (value) => { terminal = value; });
    proxy._bridgeExecToWss(channel, 'fixture', 'command is not recorded');
    ws.open();
    completeExec(ws, startExec(ws), 'output is not recorded in history', exitCode);
    assert.equal(terminal.session.kind, 'exec');
    assert.equal(terminal.reason, 'completed');
    assert.equal(terminal.exitCode, exitCode);
    assert.equal(Object.hasOwn(terminal.session, 'command'), false);
    await nextTurn();
  }
  const sources = [
    ['user_disconnect', (_ws, proxy) => proxy.disconnectSession(proxy.getSessions()[0].id)],
    ['network_error', (ws) => ws.emit('error', new Error('transport'))],
    ['auth_error', (ws) => ws.emit('unexpected-response', {}, { statusCode: 403, resume() {} })],
    ['output_limit', (ws) => ws.message('12345')],
    ['interrupted', (_ws, _proxy, channel) => channel.emit('close')],
  ];
  for (const [reason, terminate] of sources) {
    const ws = new FakeWebSocket();
    const proxy = makeProxy({ webSocketFactory: () => ws, maxQueuedOutputBytes: 4 });
    const channel = new FakeChannel();
    let terminal;
    proxy.on('session-close', (value) => { terminal = value; });
    proxy._bridgeSshToWss(channel, 'fixture');
    ws.open();
    terminate(ws, proxy, channel);
    assert.equal(terminal.reason, reason);
    await nextTurn();
  }
});

test('local exec deadlines record timeout while unrelated channel sessions remain active', async () => {
  const sockets = [new FakeWebSocket(), new FakeWebSocket()];
  const firstWs = sockets[0], secondWs = sockets[1];
  const proxy = makeProxy({ webSocketFactory: () => sockets.shift(), execTimeoutMs: 10 });
  const terminals = [];
  proxy.on('session-close', (value) => terminals.push(value));
  const execChannel = new FakeChannel();
  const shellChannel = new FakeChannel();
  proxy._bridgeExecToWss(execChannel, 'fixture', 'true');
  proxy._bridgeSshToWss(shellChannel, 'fixture');
  firstWs.open(); secondWs.open();
  await delay(30);
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].reason, 'timeout');
  assert.equal(terminals[0].exitCode, 124);
  assert.equal(proxy.getSessions().length, 1);
  shellChannel.close();
  await nextTurn();
});

test('stop finalizes even backpressured sessions before stopped and a late close is ignored', async () => {
  for (const [stopReason, terminalReason] of [['restart', 'proxy_stop'], ['auth_error', 'auth_error'],
    ['app_exit', 'app_exit'], ['fatal', 'app_exit']]) {
    const ws = new FakeWebSocket();
    const proxy = makeProxy({ webSocketFactory: () => ws, shutdownTimeoutMs: 10 });
    const channel = new FakeChannel();
    channel.writeResult = false;
    proxy._bridgeSshToWss(channel, 'fixture');
    ws.open();
    ws.message('final received bytes');
    const order = [];
    proxy.on('session-close', (value) => {
      order.push('close');
      assert.equal(value.reason, terminalReason);
      assert.equal(value.session.bytesReceived, Buffer.byteLength('final received bytes'));
    });
    proxy.on('stopped', () => {
      order.push('stopped');
      assert.equal(proxy.getSessions().length, 0);
    });
    await proxy.stop(stopReason);
    assert.deepEqual(order, ['close', 'stopped']);
    channel.emit('drain');
    channel.emit('close');
    ws.emit('close', 1006);
    await nextTurn();
    assert.deepEqual(order, ['close', 'stopped']);
  }
});

test('SSH socket timeout/error remains attributable after the socket ownership map is cleared', async () => {
  for (const source of ['timeout', 'network_error']) {
    const ws = new FakeWebSocket();
    const proxy = makeProxy({ webSocketFactory: () => ws });
    const socket = new FakeSocket();
    proxy._trackTcpSocket(socket);
    const client = new EventEmitter();
    client._sock = socket;
    proxy._onSshClient(client);
    client.emit('ready');
    const sshSession = new EventEmitter();
    client.emit('session', () => sshSession, () => {});
    const channel = new FakeChannel();
    sshSession.emit('shell', () => channel, () => {});
    ws.open();
    let terminal;
    proxy.on('session-close', (value) => { terminal = value; });
    if (source === 'timeout') socket.emit('timeout');
    else { socket.emit('error', new Error('socket reset')); socket.destroy(); }
    await nextTurn();
    assert.equal(proxy._sockets.size, 0);
    channel.emit('close');
    assert.equal(terminal.reason, source);
    assert.equal(terminal.exitCode, null);
    client.emit('close');
  }
});
