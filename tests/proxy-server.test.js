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

  proxy._bridgeSshToWss(channel, {}, '127.0.0.1:1');
  const [session] = proxy.getSessions();
  assert.ok(session);
  assert.equal(capturedOptions.rejectUnauthorized, true);
  assert.equal(capturedOptions.maxPayload, 4096);
  assert.equal(capturedOptions.ca, ca);
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
    execInitialDelayMs: 0,
    execTimeoutMs: 15,
    webSocketFactory: () => ws,
  });
  const logs = [];
  proxy.on('proxy-log', (...args) => logs.push(args.join(' ')));
  const channel = new FakeChannel();

  proxy._bridgeExecToWss(channel, {}, '127.0.0.1:2', secretCommand);
  ws.open();
  await delay(35);

  assert.deepEqual(channel.exitCodes, [124]);
  assert.equal(channel.endCalled, true);
  assert.equal(logs.join('\n').includes('SECRET_COMMAND_TOKEN'), false);
  assert.equal(logs.join('\n').includes('SECRET_COOKIE_TOKEN'), false);
  assert.equal(proxy.getSessions().length, 0);
});

test('exec completion marker is detected across WSS messages with accurate status', async () => {
  const ws = new FakeWebSocket();
  const proxy = makeProxy({
    execInitialDelayMs: 0,
    execTimeoutMs: 1000,
    webSocketFactory: () => ws,
  });
  const logs = [];
  proxy.on('proxy-log', (...args) => logs.push(args.join(' ')));
  const channel = new FakeChannel();

  proxy._bridgeExecToWss(channel, {}, '127.0.0.1:3', 'printf hello');
  ws.open();
  await delay(5);

  assert.equal(ws.sent.length, 2);
  const markerMessage = JSON.parse(ws.sent[1]).data.data;
  const markerId = markerMessage.match(/DONE_([a-f0-9]+)/)?.[1];
  assert.ok(markerId);
  ws.message(`printf hello\r\nhello\nDONE_${markerId} 7`);
  assert.deepEqual(channel.exitCodes, []);
  ws.message('0\r\n');
  await nextTurn();

  assert.deepEqual(channel.exitCodes, [70]);
  assert.equal(Buffer.concat(channel.writes).toString(), 'hello\n');
  assert.equal(logs.join('\n').includes('printf hello'), false);
  assert.equal(logs.join('\n').includes('hello\n'), false);
  assert.equal(proxy.getSessions().length, 0);
});

test('exec output is bounded and reports a distinct nonzero status', async () => {
  const ws = new FakeWebSocket();
  const proxy = makeProxy({
    execInitialDelayMs: 0,
    execTimeoutMs: 1000,
    maxExecOutputBytes: 4,
    webSocketFactory: () => ws,
  });
  const channel = new FakeChannel();

  proxy._bridgeExecToWss(channel, {}, '127.0.0.1:8', 'echo output');
  ws.open();
  ws.message('12345');
  await nextTurn();

  assert.deepEqual(channel.exitCodes, [125]);
  assert.equal(proxy.getSessions().length, 0);
});

test('disconnectSession closes only its channel, not the SSH client', async () => {
  const ws = new FakeWebSocket();
  const proxy = makeProxy({ webSocketFactory: () => ws });
  const channel = new FakeChannel();
  let clientEnds = 0;
  const client = { end: () => { clientEnds += 1; } };

  proxy._bridgeSshToWss(channel, client, '127.0.0.1:4');
  const [session] = proxy.getSessions();
  assert.equal(proxy.disconnectSession(session.id), true);
  await nextTurn();

  assert.equal(channel.closeCalled, true);
  assert.equal(clientEnds, 0);
  assert.equal(proxy.getSessions().length, 0);
});

test('WSS close 1011 fails the session but does not invalidate authentication', async () => {
  const ws = new FakeWebSocket();
  const proxy = makeProxy({ webSocketFactory: () => ws });
  const channel = new FakeChannel();
  let authErrors = 0;
  proxy.on('auth-error', () => { authErrors += 1; });

  proxy._bridgeSshToWss(channel, {}, '127.0.0.1:5');
  ws.open();
  ws.readyState = 3;
  ws.emit('close', 1011);
  await nextTurn();

  assert.equal(authErrors, 0);
  assert.deepEqual(channel.exitCodes, [1]);
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

  proxy._bridgeSshToWss(channel, {}, '127.0.0.1:6');
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

  proxy._bridgeSshToWss(channel, {}, '127.0.0.1:7');
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
