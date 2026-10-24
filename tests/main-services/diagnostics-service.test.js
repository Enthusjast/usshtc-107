const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const { WebSocket, WebSocketServer } = require('ws');
const { createDiagnosticsService, fingerprintConfig } = require('../../electron/diagnostics-service');
const { buildWssUrl } = require('../../electron/wss-connection');
const { ProxyServer } = require('../../electron/proxy-server');
const keyService = require('../../electron/ssh-key-service');
const { SshConfigService } = require('../../electron/ssh-config-service');
const { PROFILE_DEFAULTS } = require('../../shared/settings-schema.mjs');
const { PLATFORM } = require('../../electron/constants');

const scope = { profileId: 'default', epoch: 1 };
const config = { ...PROFILE_DEFAULTS };
const wire = Buffer.from('complete-host-wire-not-raw-32-byte-key');
const hostFingerprint = `SHA256:${require('node:crypto').createHash('sha256').update(wire).digest('base64').replace(/=+$/, '')}`;
const readyKeys = () => ({ client: { state: 'ready', fingerprint: 'SHA256:client' }, host: { state: 'ready', fingerprint: hostFingerprint } });
const flush = async () => { for (let index = 0; index < 100; index += 1) await Promise.resolve(); };
function clock() {
  let time = 0;
  let id = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout: (fn, ms) => { const handle = ++id; timers.set(handle, { at: time + ms, fn }); return handle; },
    clearTimeout: (handle) => timers.delete(handle),
    size: () => timers.size,
    // Simulate synchronous adapter/observer work without firing timers mid-stack.
    spend: (ms) => { time += ms; },
    async tick(ms) {
      await flush();
      const target = time + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= target);
        if (!next) break;
        timers.delete(next[0]);
        time = Math.max(time, next[1].at);
        next[1].fn();
        await flush();
      }
      time = Math.max(time, target);
      await flush();
    },
  };
}

function fixture(options = {}) {
  const time = clock();
  const states = [], resources = [], revoked = [], requests = [];
  let saved = { ...config, ...options.config };
  let cookie = options.cookie === undefined ? 'session=fixture-private' : options.cookie;
  let server;
  const resource = () => {
    const value = new EventEmitter();
    value.closed = false;
    value.destroy = value.cancel = () => { value.closed = true; };
    resources.push(value);
    return value;
  };
  const adapters = {
    ...time,
    lookup(host, callback) {
      requests.push(['dns', host]);
      const request = resource();
      if (!options.hangDns) queueMicrotask(() => callback(options.dnsError ? new Error('private DNS body') : null, ['127.0.0.1']));
      return request;
    },
    connectTls(value) {
      requests.push(['tls', value]);
      const socket = resource(); socket.authorized = !options.tlsError;
      if (!options.hangTls) queueMicrotask(() => socket.emit(options.tlsError ? 'error' : 'secureConnect', new Error('private TLS body')));
      return socket;
    },
    createWebSocket(url, value) {
      requests.push(['wss', url, value]);
      const ws = resource(); ws.readyState = 0;
      ws.close = ws.terminate = () => { ws.closed = true; };
      if (!options.hangWss) queueMicrotask(() => {
        options.beforeWssResult?.({ setCookie: (next) => { cookie = next; } });
        if (options.httpStatus) {
          const response = resource(); response.statusCode = options.httpStatus;
          ws.emit('unexpected-response', {}, response);
        } else if (options.closeCode) ws.emit('close', options.closeCode, Buffer.from('private remote body'));
        else if (options.wssError) ws.emit('error', Object.assign(new Error('private network body'), { code: options.wssError }));
        else { ws.readyState = 1; ws.emit('open'); }
      });
      return ws;
    },
    createServer(listener) {
      server = resource();
      server.listen = (value, callback) => {
        requests.push(['bind', value]);
        if (!options.hangBind) queueMicrotask(() => options.portBusy
          ? server.emit('error', Object.assign(new Error('private bind body'), { code: 'EADDRINUSE' })) : callback());
      };
      server.close = (callback) => { server.closed = true; if (callback) queueMicrotask(callback); };
      server.accept = listener;
      return server;
    },
    createSshClient() {
      const client = resource();
      client.end = () => { client.closed = true; };
      client.connect = (value) => {
        requests.push(['ssh', value]);
        assert.equal(value.privateKey, 'actual-adapter-key');
        assert.equal(value.hostVerifier(wire), true);
        assert.equal(value.hostVerifier(Buffer.alloc(32)), false);
        if (!options.hangSsh) queueMicrotask(() => client.emit(options.sshError ? 'error' : 'ready', new Error('private SSH body')));
      };
      return client;
    },
    ...options.adapters,
  };
  const deps = {
    getConfig: () => saved,
    getRuntime: () => ({ proxyStatus: options.running ? 'started' : 'stopped', runningConfig: options.runningConfig || saved,
      storageErrorCode: options.locked ? 'SETTINGS_COMMIT_UNKNOWN' : null }),
    getKeys: options.getKeys || readyKeys,
    getClientIdentity: () => ({ privateKey: 'actual-adapter-key' }),
    inspectSshConfig: options.inspectSshConfig || (() => ({ code: options.configCode || 'SSH_CONFIG_OK' })),
    getCookie: () => cookie,
    onState: (dto) => { states.push(dto); options.onState?.(dto, time); },
    onAuthRequired: (value) => revoked.push(value),
    adapters,
  };
  const service = createDiagnosticsService(deps);
  return { service, time, states, resources, revoked, requests, deps,
    setCookie: (value) => { cookie = value; }, setConfig: (value) => { saved = value; }, server: () => server };
}
const codes = (dto) => Object.fromEntries(dto.checks.map((check) => [check.id, check.code]));
const item = (dto, id) => dto.checks.find((check) => check.id === id);

test('fingerprint uses fixed fields, normalizes derived URL, binds alias and ignores unrelated settings', () => {
  const original = fingerprintConfig(config);
  assert.match(original, /^[0-9a-f]{64}$/);
  assert.equal(original, fingerprintConfig({ ...config, wssUrl: buildWssUrl(config), theme: 'light', savedCookie: 'never-hashed' }));
  assert.equal(original, fingerprintConfig(Object.fromEntries(Object.entries(config).reverse())));
  for (const [key, value] of Object.entries({ host: '::1', port: 4000, cluster: 'other', loginNode: 'localhost', cols: 100,
    rows: 30, useRoot: true, sshAlias: 'other', wssUrl: 'wss://localhost:4443/fixture' })) {
    assert.notEqual(original, fingerprintConfig({ ...config, [key]: value }), key);
  }
});

test('ordered DTO streams running and final states; stopped local check is explicitly bind-only', async () => {
  const f = fixture();
  const promise = f.service.run(scope);
  assert.strictEqual(f.service.run(scope), promise);
  const result = await promise;
  assert.deepEqual(result.checks.map((check) => check.id), ['settings', 'keys', 'ssh-config', 'local-listener', 'dns', 'tls', 'wss']);
  assert.deepEqual(codes(result), { settings: 'SETTINGS_OK', keys: 'KEYS_OK', 'ssh-config': 'SSH_CONFIG_OK',
    'local-listener': 'LOCAL_PORT_AVAILABLE', dns: 'DNS_OK', tls: 'TLS_OK', wss: 'WSS_HANDSHAKE_OK' });
  assert.ok(result.checks.every((check) => check.status === 'passed' && check.durationMs >= 0));
  assert.equal(item(result, 'local-listener').mode, 'bind-only');
  assert.match(result.startedAt, /Z$/); assert.match(result.finishedAt, /Z$/);
  assert.deepEqual(f.states.filter((state) => state.checks.some((check) => check.status === 'running'))
    .map((state) => state.checks.find((check) => check.status === 'running').id)
    .filter((id, index, ids) => id !== ids[index - 1]), result.checks.map((check) => check.id));
  assert.equal(f.time.size(), 0);
  assert.ok(f.resources.every((value) => value.closed));
  assert.deepEqual(f.service.get(scope), result);
  const copied = f.service.get(scope); copied.checks.length = 0;
  assert.equal(f.service.get(scope).checks.length, 7);
  assert.equal(f.service.get({ ...scope, epoch: 2 }), null);
  f.setConfig({ ...config, port: 4000 });
  assert.equal(f.service.get(scope), null);
  assert.equal(JSON.stringify(result).includes('fixture-private'), false);
  const tlsOptions = f.requests.find(([type]) => type === 'tls')[1];
  assert.equal(tlsOptions.host, PLATFORM.domain); assert.equal(tlsOptions.servername, PLATFORM.domain);
  assert.equal(tlsOptions.rejectUnauthorized, true);
  assert.equal(f.requests.find(([type]) => type === 'dns')[1], PLATFORM.domain);
  assert.equal(new URL(f.requests.find(([type]) => type === 'wss')[1]).hostname, PLATFORM.domain);
});

test('running local check authenticates only, pins full host wire, uses actual identity adapter and running endpoint', async () => {
  const f = fixture({ running: true, config: { port: 4000 }, runningConfig: { ...config, host: '::', port: 3000 } });
  const dto = await f.service.run(scope);
  assert.equal(item(dto, 'local-listener').mode, 'ssh-auth');
  assert.equal(item(dto, 'local-listener').code, 'LOCAL_SSH_OK');
  const ssh = f.requests.find(([type]) => type === 'ssh')[1];
  assert.equal(ssh.host, '::1'); assert.equal(ssh.port, 3000);
  assert.equal(f.requests.some(([type]) => type === 'bind'), false);
});

test('invalid settings skip dependent checks but independent key inspection and DNS/TLS continue', async () => {
  const f = fixture({ config: { port: 99999 } });
  const result = await f.service.run(scope);
  assert.equal(item(result, 'settings').code, 'SETTINGS_INVALID');
  for (const id of ['ssh-config', 'local-listener', 'wss']) {
    assert.equal(item(result, id).status, 'skipped'); assert.equal(item(result, id).code, 'DEPENDENCY_FAILED');
  }
  assert.equal(item(result, 'keys').code, 'KEYS_OK');
  assert.equal(item(result, 'dns').code, 'DNS_OK'); assert.equal(item(result, 'tls').code, 'TLS_OK');
  assert.equal(item(await fixture({ locked: true }).service.run(scope), 'settings').code, 'SETTINGS_LOCKED');
});

for (const code of ['SSH_KEY_MISSING', 'SSH_KEY_INVALID', 'SSH_KEY_PERMISSIONS', 'SSH_KEY_FINGERPRINT_MISMATCH']) {
  test(`key inspection ${code} does not block independent configuration/DNS/TLS/WSS`, async () => {
    const f = fixture({ running: true, getKeys: () => ({ ...readyKeys(), client: { state: 'invalid', errorCode: code } }) });
    const result = await f.service.run(scope);
    assert.equal(item(result, 'keys').code, code);
    assert.equal(item(result, 'local-listener').status, 'skipped');
    assert.equal(item(result, 'ssh-config').code, 'SSH_CONFIG_OK');
    assert.equal(item(result, 'dns').code, 'DNS_OK'); assert.equal(item(result, 'tls').code, 'TLS_OK');
    assert.equal(item(result, 'wss').code, 'WSS_HANDSHAKE_OK');
    assert.equal(f.requests.some(([type]) => type === 'ssh'), false);
  });
}
for (const code of ['SSH_CONFIG_MISSING', 'SSH_CONFIG_MISMATCH', 'SSH_ALIAS_CONFLICT', 'SSH_CONFIG_INVALID']) {
  test(`configuration inspection ${code} leaves local/network probes independent`, async () => {
    const f = fixture({ inspectSshConfig: () => { if (code.includes('CONFLICT') || code.includes('INVALID')) throw Object.assign(new Error('private config'), { code }); return { code }; } });
    const result = await f.service.run(scope);
    assert.equal(item(result, 'ssh-config').code, code);
    assert.equal(item(result, 'local-listener').code, 'LOCAL_PORT_AVAILABLE');
    assert.equal(item(result, 'wss').code, 'WSS_HANDSHAKE_OK');
    assert.equal(JSON.stringify(result).includes('private config'), false);
  });
}

test('port occupation and failed SSH authentication are fixed codes, not fabricated end-to-end successes', async () => {
  const stopped = await fixture({ portBusy: true }).service.run(scope);
  assert.equal(item(stopped, 'local-listener').code, 'PORT_IN_USE');
  assert.equal(item(stopped, 'wss').code, 'WSS_HANDSHAKE_OK');
  const running = await fixture({ running: true, sshError: true }).service.run(scope);
  assert.equal(item(running, 'local-listener').code, 'LOCAL_SSH_FAILED');
});

test('DNS/TLS dependency failures skip only dependent network checks; no cookie is AUTH_REQUIRED without revocation', async () => {
  const dnsFailure = await fixture({ dnsError: true }).service.run(scope);
  assert.equal(item(dnsFailure, 'dns').code, 'DNS_FAILED');
  assert.equal(item(dnsFailure, 'tls').code, 'DEPENDENCY_FAILED');
  assert.equal(item(dnsFailure, 'wss').code, 'DEPENDENCY_FAILED');
  const tlsFailure = await fixture({ tlsError: true }).service.run(scope);
  assert.equal(item(tlsFailure, 'tls').code, 'TLS_FAILED'); assert.equal(item(tlsFailure, 'wss').status, 'skipped');
  const f = fixture({ cookie: '' }); const noCookie = await f.service.run(scope);
  assert.equal(item(noCookie, 'wss').code, 'AUTH_REQUIRED'); assert.equal(item(noCookie, 'wss').status, 'skipped');
  assert.equal(f.revoked.length, 0); assert.equal(f.requests.some(([type]) => type === 'wss'), false);
});

for (const status of [401, 403, 500]) {
  test(`WSS HTTP ${status} only revokes for current-cookie 401/403`, async () => {
    const f = fixture({ httpStatus: status });
    const result = await f.service.run(scope);
    assert.equal(item(result, 'wss').code, status === 500 ? 'WSS_FAILED' : 'AUTH_REQUIRED');
    assert.equal(f.revoked.length, status === 500 ? 0 : 1);
    assert.ok(f.resources.every((resource) => resource.closed));
  });
}
for (const code of [1008, 1011]) {
  test(`WSS close ${code} is not authentication revocation`, async () => {
    const f = fixture({ closeCode: code });
    assert.equal(item(await f.service.run(scope), 'wss').code, 'WSS_FAILED');
    assert.equal(f.revoked.length, 0);
  });
}

test('late cookie A 401 cannot revoke replacement cookie B in the same scope', async () => {
  const f = fixture({ httpStatus: 401, beforeWssResult: ({ setCookie }) => setCookie('session=replacement') });
  const result = await f.service.run(scope);
  assert.equal(item(result, 'wss').code, 'CANCELLED'); assert.equal(item(result, 'wss').status, 'skipped');
  assert.equal(f.revoked.length, 0);
});

test('network unavailable errors map without retaining arbitrary transport error text', async () => {
  const result = await fixture({ wssError: 'ENETUNREACH' }).service.run(scope);
  assert.equal(item(result, 'wss').code, 'NETWORK_UNAVAILABLE');
  assert.equal(JSON.stringify(result).includes('private network body'), false);
});

for (const [option, id] of [['hangBind', 'local-listener'], ['hangDns', 'dns'], ['hangTls', 'tls'], ['hangWss', 'wss'], ['hangSsh', 'local-listener']]) {
  test(`${id} timeout closes owned resources at five seconds`, async () => {
    const f = fixture({ [option]: true, running: option === 'hangSsh' });
    const resultPromise = f.service.run(scope);
    await flush();
    assert.equal(f.states.at(-1).checks.find((check) => check.status === 'running').id, id);
    await f.time.tick(4999);
    assert.equal(f.states.at(-1).checks.find((check) => check.id === id).status, 'running');
    await f.time.tick(1);
    const result = await resultPromise;
    assert.equal(item(result, id).code, 'TIMEOUT'); assert.equal(item(result, id).durationMs, 5000);
    assert.ok(f.resources.every((resource) => resource.closed));
    assert.equal(f.time.size(), 0);
  });
}

test('stalled local inspections obey the same timeout and independent checks continue', async () => {
  const f = fixture({ getKeys: () => new Promise(() => {}), inspectSshConfig: () => new Promise(() => {}) });
  const promise = f.service.run(scope);
  await f.time.tick(10000);
  const result = await promise;
  assert.equal(item(result, 'keys').code, 'TIMEOUT'); assert.equal(item(result, 'ssh-config').code, 'TIMEOUT');
  assert.equal(item(result, 'local-listener').code, 'LOCAL_PORT_AVAILABLE');
  assert.equal(item(result, 'wss').code, 'WSS_HANDSHAKE_OK');
});

test('overall deadline closes active resource and marks every remaining check skipped', async () => {
  let spent = false;
  const f = fixture({ hangBind: true, onState: (dto, time) => {
    if (!spent && item(dto, 'local-listener').status === 'running') { spent = true; time.spend(29000); }
  } });
  const promise = f.service.run(scope);
  await flush();
  await f.time.tick(1000);
  const result = await promise;
  assert.equal(item(result, 'local-listener').code, 'DIAGNOSTIC_DEADLINE');
  for (const id of ['dns', 'tls', 'wss']) {
    assert.equal(item(result, id).status, 'skipped'); assert.equal(item(result, id).code, 'DIAGNOSTIC_DEADLINE');
  }
  assert.ok(f.resources.every((resource) => resource.closed)); assert.equal(f.time.size(), 0);
});

test('abort closes in-flight probe, finishes with CANCELLED, and disposes without retained result', async () => {
  const f = fixture({ hangDns: true });
  const abort = new AbortController();
  const promise = f.service.run({ ...scope, signal: abort.signal });
  await flush(); abort.abort();
  const result = await promise;
  for (const id of ['dns', 'tls', 'wss']) assert.equal(item(result, id).code, 'CANCELLED');
  assert.ok(f.resources.every((resource) => resource.closed)); assert.equal(f.time.size(), 0);
  f.service.dispose();
  assert.equal(f.service.get(scope), null);
  await assert.rejects(f.service.run(scope), { code: 'CANCELLED' });
});

test('a different scope/config cancels the old run without overwriting latest DTO', async () => {
  const f = fixture({ hangWss: true });
  const first = f.service.run(scope);
  await flush();
  f.setConfig({ ...config, port: 4000 });
  const abort = new AbortController();
  const nextScope = { ...scope, epoch: 2 };
  const second = f.service.run({ ...nextScope, signal: abort.signal });
  assert.notStrictEqual(first, second);
  await flush(); abort.abort();
  assert.equal(item(await first, 'wss').code, 'CANCELLED');
  const result = await second;
  assert.equal(result.epoch, 2); assert.equal(result.configFingerprint, fingerprintConfig({ ...config, port: 4000 }));
  assert.equal(f.service.get(nextScope).runId, result.runId);
  assert.equal(f.states.at(-1).epoch, 2);
});

// Real fixtures exercise the production ssh2/net/TLS/ws paths, with only fixed
// loopback remapping injected in main. No account, platform request, or command.
const certificate = fs.readFileSync(path.join(__dirname, '../fixtures/loopback-test-only-cert.pem'));
const certificateKey = fs.readFileSync(path.join(__dirname, '../fixtures/loopback-test-only-key.pem'));
async function realFixture(t, { status = 101, closeCode, running = true, trust = true, hangUpgrade = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc107-diagnostic-'));
  const sshDirectory = path.join(root, '.ssh');
  const client = keyService.ensureClientKeyPair({ sshDirectory });
  const originalPrivate = fs.readFileSync(client.privateKeyPath);
  const hostKeyPath = path.join(root, 'host-key');
  const hostKey = keyService.ensureProxyHostKey(hostKeyPath);
  const keys = keyService.inspect({ sshDirectory, hostKeyPath });
  let messages = 0, sshSessions = 0, upgrades = 0;
  const httpsServer = https.createServer({ key: certificateKey, cert: certificate });
  const wss = new WebSocketServer({ noServer: true });
  const peers = new Set();
  const sockets = new Set();
  let upgradedSocket;
  let resolveUpgrade;
  const upgradeSeen = new Promise((resolve) => { resolveUpgrade = resolve; });
  httpsServer.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  httpsServer.on('upgrade', (request, socket, head) => {
    upgrades += 1;
    assert.equal(request.headers.cookie, 'session=real-fixture');
    upgradedSocket = socket;
    resolveUpgrade();
    if (hangUpgrade) return;
    if (status !== 101) return socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (ws) => {
    peers.add(ws); ws.on('close', () => peers.delete(ws));
    ws.on('message', () => { messages += 1; });
    if (closeCode) ws.close(closeCode, 'private remote response');
  });
  httpsServer.listen(0, '127.0.0.1'); await once(httpsServer, 'listening');
  const proxy = new ProxyServer({ host: '127.0.0.1', port: 0, cookie: 'session=real-fixture', hostKey,
    authorizedKey: Buffer.from(client.publicKeyRaw, 'base64'), authorizedKeyOpenSSH: client.publicKey });
  let address;
  proxy.on('started', (value) => { address = value; });
  proxy.on('session-open', () => { sshSessions += 1; });
  await proxy.start();
  if (!running) await proxy.stop();
  const saved = { ...config, host: '127.0.0.1', port: address.port };
  const sshConfig = new SshConfigService({ sshDirectory, privateKeyPath: client.privateKeyPath });
  const preview = sshConfig.preview({ profileId: scope.profileId, alias: saved.sshAlias, host: saved.host, port: saved.port });
  sshConfig.write({ profileId: scope.profileId, alias: saved.sshAlias, host: saved.host, port: saved.port }, {
    expectedSourceHash: preview.sourceHash, expectedConfigHash: preview.configHash,
  });
  const revoked = [];
  const service = createDiagnosticsService({
    getConfig: () => saved,
    getRuntime: () => ({ proxyStatus: running ? 'started' : 'stopped', runningConfig: running ? saved : null }),
    getKeys: () => keyService.inspect({ sshDirectory, hostKeyPath, expected: {
      clientFingerprint: client.fingerprint, hostFingerprint: keys.host.fingerprint,
    } }),
    getClientIdentity: () => keyService.getSsh2ClientIdentity({ sshDirectory }),
    inspectSshConfig: () => sshConfig.inspect({ profileId: scope.profileId, alias: saved.sshAlias, host: saved.host, port: saved.port }),
    getCookie: () => 'session=real-fixture', onAuthRequired: (value) => revoked.push(value),
    adapters: {
      ...(trust ? { tlsCa: certificate } : {}),
      lookup: (host, callback) => { assert.equal(host, PLATFORM.domain); queueMicrotask(() => callback(null, ['127.0.0.1'])); },
      connectTls: (options) => {
        assert.equal(options.host, PLATFORM.domain); assert.equal(options.servername, PLATFORM.domain);
        assert.equal(options.rejectUnauthorized, true);
        return tls.connect({ ...options, host: '127.0.0.1', port: httpsServer.address().port, servername: 'localhost' });
      },
      createWebSocket: (url, options) => {
        assert.equal(new URL(url).hostname, PLATFORM.domain); assert.equal(options.rejectUnauthorized, true);
        return new WebSocket(`wss://127.0.0.1:${httpsServer.address().port}/fixture`, options);
      },
    },
  });
  t.after(async () => {
    service.dispose(); await proxy.stop();
    for (const peer of peers) peer.terminate();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => wss.close(resolve));
    httpsServer.closeAllConnections();
    await new Promise((resolve) => httpsServer.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { service, root, sshDirectory, client, originalPrivate, revoked, address, upgradeSeen, upgradeSocket: () => upgradedSocket,
    counters: () => ({ messages, sshSessions, upgrades }) };
}

test('real SSH diagnostics authenticate existing PKCS8 identity, pin host, and perform TLS/WSS without any command', { timeout: 15000 }, async (t) => {
  const f = await realFixture(t);
  const result = await f.service.run(scope);
  assert.equal(item(result, 'keys').code, 'KEYS_OK'); assert.equal(item(result, 'ssh-config').code, 'SSH_CONFIG_OK');
  assert.equal(item(result, 'local-listener').code, 'LOCAL_SSH_OK');
  assert.equal(item(result, 'local-listener').mode, 'ssh-auth');
  assert.equal(item(result, 'tls').code, 'TLS_OK'); assert.equal(item(result, 'wss').code, 'WSS_HANDSHAKE_OK');
  assert.deepEqual(fs.readFileSync(f.client.privateKeyPath), f.originalPrivate);
  assert.match(f.originalPrivate.toString(), /BEGIN PRIVATE KEY/);
  assert.deepEqual(f.counters(), { messages: 0, sshSessions: 0, upgrades: 1 });
});

test('real bind-only releases its temporary port and never claims SSH authentication', { timeout: 15000 }, async (t) => {
  const f = await realFixture(t, { running: false });
  const result = await f.service.run(scope);
  assert.equal(item(result, 'local-listener').code, 'LOCAL_PORT_AVAILABLE');
  assert.equal(item(result, 'local-listener').mode, 'bind-only');
  const listener = net.createServer();
  listener.listen(f.address.port, '127.0.0.1'); await once(listener, 'listening');
  await new Promise((resolve) => listener.close(resolve));
});

test('real untrusted TLS certificate fails closed and skips WSS', { timeout: 15000 }, async (t) => {
  const f = await realFixture(t, { trust: false });
  const result = await f.service.run(scope);
  assert.equal(item(result, 'tls').code, 'TLS_FAILED');
  assert.equal(item(result, 'wss').code, 'DEPENDENCY_FAILED');
  assert.equal(f.counters().upgrades, 0); assert.equal(f.revoked.length, 0);
});

for (const status of [401, 403]) {
  test(`real WSS ${status} revokes authentication without reading body or sending a command`, { timeout: 15000 }, async (t) => {
    const f = await realFixture(t, { status });
    const result = await f.service.run(scope);
    assert.equal(item(result, 'wss').code, 'AUTH_REQUIRED'); assert.deepEqual(f.revoked, [scope]);
    assert.equal(f.counters().messages, 0);
  });
}
for (const closeCode of [1008, 1011]) {
  test(`real WSS upgrade followed by ${closeCode} is handshake-only success, not revoked application auth`, { timeout: 15000 }, async (t) => {
    const f = await realFixture(t, { closeCode });
    const result = await f.service.run(scope);
    assert.equal(item(result, 'wss').code, 'WSS_HANDSHAKE_OK'); assert.equal(f.revoked.length, 0);
    assert.equal(f.counters().messages, 0);
  });
}

test('real pending WSS cancellation closes the TLS socket and never sends a command', { timeout: 15000 }, async (t) => {
  const f = await realFixture(t, { hangUpgrade: true });
  const abort = new AbortController();
  const promise = f.service.run({ ...scope, signal: abort.signal });
  await f.upgradeSeen;
  const closed = once(f.upgradeSocket(), 'close');
  abort.abort();
  const result = await promise;
  assert.equal(item(result, 'wss').code, 'CANCELLED');
  await closed;
  assert.equal(f.revoked.length, 0); assert.equal(f.counters().messages, 0);
});

test('real occupied local port is reported while independent TLS/WSS checks continue', { timeout: 15000 }, async (t) => {
  const f = await realFixture(t, { running: false });
  const listener = net.createServer();
  listener.listen(f.address.port, '127.0.0.1'); await once(listener, 'listening');
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const result = await f.service.run(scope);
  assert.equal(item(result, 'local-listener').code, 'PORT_IN_USE');
  assert.equal(item(result, 'wss').code, 'WSS_HANDSHAKE_OK');
});

test('real missing client key remains missing: diagnostics never ensure or repair identity files', { timeout: 15000 }, async (t) => {
  const f = await realFixture(t);
  fs.unlinkSync(f.client.privateKeyPath);
  const result = await f.service.run(scope);
  assert.equal(item(result, 'keys').code, 'SSH_KEY_MISSING');
  assert.equal(item(result, 'local-listener').status, 'skipped');
  assert.equal(fs.existsSync(f.client.privateKeyPath), false);
  assert.equal(item(result, 'wss').code, 'WSS_HANDSHAKE_OK');
});

test('authentication revocation abort after final publication retains the proven AUTH_REQUIRED result', async () => {
  const f = fixture({ httpStatus: 401 });
  const abort = new AbortController();
  f.deps.onAuthRequired = (value) => { f.revoked.push(value); abort.abort(); };
  const result = await f.service.run({ ...scope, signal: abort.signal });
  assert.equal(item(result, 'wss').code, 'AUTH_REQUIRED');
  assert.equal(item(result, 'wss').status, 'failed');
  assert.equal(f.revoked.length, 1);
});

test('already aborted run creates no transport resource', async () => {
  const f = fixture();
  const abort = new AbortController(); abort.abort();
  const result = await f.service.run({ ...scope, signal: abort.signal });
  assert.ok(result.checks.every((check) => check.status === 'skipped' && check.code === 'CANCELLED'));
  assert.equal(f.resources.length, 0); assert.equal(f.time.size(), 0);
});

test('real unsafe private-key mode is reported without chmod or repair', {
  skip: process.platform === 'win32' ? 'POSIX file modes are not available on Windows' : false,
  timeout: 15000,
}, async (t) => {
  const f = await realFixture(t);
  fs.chmodSync(f.client.privateKeyPath, 0o644);
  const result = await f.service.run(scope);
  assert.equal(item(result, 'keys').code, 'SSH_KEY_PERMISSIONS');
  assert.equal(item(result, 'local-listener').status, 'skipped');
  assert.equal(fs.statSync(f.client.privateKeyPath).mode & 0o777, 0o644);
  assert.deepEqual(fs.readFileSync(f.client.privateKeyPath), f.originalPrivate);
});
