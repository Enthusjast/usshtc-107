const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const { Client, utils: sshUtils } = require('ssh2');
const { WebSocketServer } = require('ws');
const { ProxyServer } = require('../../electron/proxy-server');
const { ensureClientKeyPair, ensureProxyHostKey, getSsh2ClientIdentity } = require('../../electron/ssh-key-service');

// Public test-only loopback certificate/key. Never used by the application.
const certificate = fs.readFileSync(path.join(__dirname, '../fixtures/loopback-test-only-cert.pem'));
const tlsKey = fs.readFileSync(path.join(__dirname, '../fixtures/loopback-test-only-key.pem'));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for loopback transport');
    await delay(5);
  }
}

async function fixture(t, { mode = 'echo', status = 101, acceptingConnections = true, startupCommand = '' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc107-transport-'));
  const paneReady = `PANE_READY_${crypto.randomBytes(6).toString('hex')}`;
  const shellEnv = path.join(root, 'shell-env');
  const peerEnv = { ...process.env, TERM: 'xterm-256color', TMUX_TMPDIR: root,
    HOME: root, XDG_CONFIG_HOME: root, SHELL: '/bin/sh', ENV: shellEnv };
  delete peerEnv.TMUX;
  delete peerEnv.TMUX_PANE;
  // Only the attached tmux pane emits this prompt, not its outer PTY shell.
  fs.writeFileSync(shellEnv, `if [ -n "$TMUX" ]; then PS1='${paneReady}> '; fi\n`);
  const sshDirectory = path.join(root, '.ssh');
  const diskIdentity = ensureClientKeyPair({ sshDirectory });
  assert.match(fs.readFileSync(diskIdentity.privateKeyPath, 'utf8'), /BEGIN PRIVATE KEY/);
  const originalDiskKey = fs.readFileSync(diskIdentity.privateKeyPath);
  const identity = getSsh2ClientIdentity({ sshDirectory });
  assert.deepEqual(fs.readFileSync(diskIdentity.privateKeyPath), originalDiskKey);
  const hostKey = ensureProxyHostKey(path.join(root, 'host-key'));
  const hostBlob = sshUtils.parseKey(hostKey).getPublicSSH();
  const server = https.createServer({ key: tlsKey, cert: certificate });
  const wss = new WebSocketServer({ noServer: true });
  const peers = [];
  const children = new Set();
  const clients = new Set();
  let proxy;
  t.after(async () => {
    for (const client of clients) client.destroy();
    await proxy?.stop();
    for (const peer of peers) peer.ws.terminate();
    for (const child of children) child.kill();
    if (startupCommand) spawnSync('tmux', ['kill-server'], { env: peerEnv, timeout: 5000 });
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  server.on('upgrade', (request, socket, head) => {
    assert.equal(request.headers.cookie, 'loopback-fixture-cookie');
    assert.equal(request.headers.origin, 'https://107.ustc.edu.cn');
    if (status !== 101) {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });
  wss.on('connection', (ws, request) => {
    const peer = { ws, url: new URL(request.url, 'https://localhost'), messages: [] };
    peers.push(peer);
    // Echo fixtures model a terminal-ready frame; the real PTY emits its prompt.
    if (mode !== 'pty') ws.send(JSON.stringify({ $case: 'data', data: { data: '' } }));
    let child;
    if (mode === 'pty') {
      child = spawn('python3', [path.join(__dirname, '../fixtures/pty-peer.py')], {
        stdio: ['pipe', 'pipe', 'pipe'], env: peerEnv,
      });
      children.add(child);
      child.on('error', () => ws.terminate());
      child.stdin.on('error', () => {});
      // Fixture diagnostics remain test-local; never bridge remote stderr.
      child.stderr.resume();
      readline.createInterface({ input: child.stdout }).on('line', (line) => {
        const data = JSON.parse(line).data;
        if (ws.readyState === 1) ws.send(JSON.stringify({ $case: 'data', data: { data } }));
      });
      child.on('close', () => { children.delete(child); if (ws.readyState === 1) ws.close(1000); });
      ws.on('close', () => child.kill());
    }
    ws.on('message', (raw) => {
      const message = JSON.parse(raw);
      peer.messages.push(message);
      if (message.$case === 'data') {
        if (child) child.stdin.write(`${JSON.stringify({ input: message.data.data })}\n`);
        else ws.send(JSON.stringify(message));
      } else if (message.$case === 'disconnect') {
        ws.send(JSON.stringify({ $case: 'data', data: { data: 'after EOF' } }));
        ws.send(JSON.stringify({ $case: 'exit', exit: { code: 0 } }));
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  proxy = new ProxyServer({
    host: '127.0.0.1', port: 0, cookie: 'loopback-fixture-cookie',
    wssUrl: `wss://127.0.0.1:${server.address().port}/shell?cluster=test-only`,
    tlsCa: certificate, hostKey, authorizedKey: Buffer.from(diskIdentity.publicKeyRaw, 'base64'),
    authorizedKeyOpenSSH: diskIdentity.publicKey, cols: 80, rows: 24,
    acceptingConnections, startupCommand, execTimeoutMs: 5000, shutdownTimeoutMs: 1000,
  });
  let address;
  proxy.on('started', (value) => { address = value; });
  await proxy.start();
  assert.equal(address.host, '127.0.0.1');
  assert.ok(address.port > 0);
  async function connect(options = {}) {
    const client = new Client();
    clients.add(client);
    client.on('close', () => clients.delete(client));
    client.connect({
      host: address.host, port: address.port, username: 'fixture',
      privateKey: identity.privateKey, readyTimeout: 2000,
      hostVerifier: (key) => key.length === hostBlob.length && crypto.timingSafeEqual(key, hostBlob),
      ...options,
    });
    client.on('error', () => {});
    await once(client, 'ready');
    return client;
  }
  return { proxy, peers, connect, identity, root, address, paneReady };
}

function shell(client, pty = { term: 'xterm', cols: 120, rows: 40 }) {
  return new Promise((resolve, reject) => client.shell(pty, (error, channel) => error ? reject(error) : resolve(channel)));
}
function exec(client, command, options = {}) {
  return new Promise((resolve, reject) => client.exec(command, options, (error, channel) => error ? reject(error) : resolve(channel)));
}

test('real SSH authenticates actual disk PKCS8 identity; password and other key fail', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const client = await f.connect();
  client.end();
  await assert.rejects(f.connect({ privateKey: undefined, password: 'not-accepted' }), /authentication methods failed/i);
  const otherDir = path.join(f.root, 'other-identity');
  ensureClientKeyPair({ sshDirectory: otherDir });
  const other = getSsh2ClientIdentity({ sshDirectory: otherDir });
  await assert.rejects(f.connect({ privateKey: other.privateKey }), /authentication methods failed/i);
  assert.equal(f.peers.length, 0);
});

test('real SSH channels isolate UTF8, PTY, resize, EOF and stop resources', { timeout: 15000 }, async (t) => {
  const f = await fixture(t);
  const terminals = [];
  f.proxy.on('session-close', (value) => {
    assert.equal(f.proxy.getSessions().some((session) => session.id === value.sessionId), true);
    terminals.push(value);
  });
  const client = await f.connect();
  const first = await shell(client, { term: 'xterm', cols: 121, rows: 41 });
  const second = await shell(client, { term: 'xterm', cols: 91, rows: 31 });
  const firstOutput = [];
  const secondOutput = [];
  first.on('data', (data) => firstOutput.push(data));
  second.on('data', (data) => secondOutput.push(data));
  await until(() => f.peers.length === 2);
  assert.equal(f.peers[0].url.searchParams.get('cols'), '121');
  assert.equal(f.peers[0].url.searchParams.get('rows'), '41');
  assert.equal(f.peers[1].url.searchParams.get('cols'), '91');
  const input = Buffer.from('中文🙂é');
  for (const byte of input) first.write(Buffer.from([byte]));
  second.write('other-channel');
  await until(() => Buffer.concat(firstOutput).length === input.length && secondOutput.length > 0);
  assert.deepEqual(Buffer.concat(firstOutput), input);
  assert.equal(Buffer.concat(secondOutput).toString(), 'other-channel');
  first.setWindow(0, 0, 0, 0);
  first.setWindow(44, 144, 0, 0);
  await until(() => f.peers[0].messages.some((message) => message.$case === 'resize' && message.resize.cols === 144));
  const beforeInvalid = f.peers[0].messages.filter((message) => message.$case === 'resize').length;
  first.setWindow(201, 501, 0, 0);
  await delay(60);
  assert.equal(f.peers[0].messages.filter((message) => message.$case === 'resize').length, beforeInvalid);
  let code;
  first.on('exit', (value) => { code = value; });
  const firstClosed = once(first, 'close');
  first.end();
  await firstClosed;
  assert.equal(code, 0);
  assert.equal(Buffer.concat(firstOutput).toString(), `${input.toString()}after EOF`);
  assert.ok(f.peers[0].messages.some((message) => message.$case === 'disconnect'));
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].session.kind, 'shell');
  assert.equal(terminals[0].reason, 'completed');
  assert.equal(terminals[0].exitCode, 0);
  assert.equal(terminals[0].session.bytesSent, input.length);
  assert.equal(terminals[0].session.bytesReceived, input.length + Buffer.byteLength('after EOF'));
  second.write('still-alive');
  await until(() => Buffer.concat(secondOutput).toString().endsWith('still-alive'));
  const secondClosed = once(second, 'close');
  f.proxy.on('stopped', () => {
    assert.equal(terminals.length, 2);
    assert.equal(terminals[1].reason, 'proxy_stop');
    assert.equal(terminals[1].session.bytesReceived, Buffer.byteLength('other-channelstill-alive'));
  });
  await f.proxy.stop();
  await secondClosed;
  assert.equal(f.proxy.getSessions().length, 0);
  assert.equal(f.proxy._sockets.size, 0);
  assert.equal(f.proxy._sshChannels.size, 0);
});

test('real exec with SSH PTY preserves bytes and exit through byte-loss remote PTY', {
  skip: process.platform === 'win32' ? 'POSIX PTY fixture requires Python3 and /bin/sh' : false,
  timeout: 15000,
}, async (t) => {
  const f = await fixture(t, { mode: 'pty' });
  let terminal;
  f.proxy.on('session-close', (value) => { terminal = value; });
  const client = await f.connect();
  const channel = await exec(client, "sleep 0.1; printf '  中文🙂\\t\\r\\n\\033[31m'; printf stderr >&2; exit 7", {
    pty: { term: 'xterm', cols: 122, rows: 42 },
  });
  const chunks = [];
  const stderr = [];
  let code;
  channel.on('data', (chunk) => chunks.push(chunk));
  channel.stderr.on('data', (chunk) => stderr.push(chunk));
  channel.on('exit', (value) => { code = value; });
  const closed = once(channel, 'close');
  channel.setWindow(43, 123, 0, 0);
  channel.end(); // stdin EOF must not cancel output.
  await closed;
  assert.equal(terminal.session.kind, 'exec');
  assert.equal(terminal.reason, 'completed');
  assert.equal(terminal.exitCode, 7);
  assert.equal(code, 7);
  assert.deepEqual(Buffer.concat(chunks), Buffer.from('  中文🙂\t\r\n\x1b[31mstderr'));
  assert.equal(Buffer.concat(stderr).length, 0);
  assert.equal(f.peers[0].url.searchParams.get('cols'), '122');
  assert.ok(f.peers[0].messages.some((message) => message.$case === 'resize' && message.resize.cols === 123));
});

test('real handshake 401/403 alone revoke auth, WSS close 1008/1011 do not', { timeout: 15000 }, async (t) => {
  for (const status of [401, 403]) {
    await t.test(`HTTP ${status}`, async (sub) => {
      const f = await fixture(sub, { status });
      const revoked = [];
      f.proxy.on('auth-error', (value) => revoked.push(value.statusCode));
      const channel = await shell(await f.connect());
      channel.resume();
      await once(channel, 'close');
      assert.deepEqual(revoked, [status]);
    });
  }
  for (const code of [1008, 1011]) {
    await t.test(`WSS ${code}`, async (sub) => {
      const f = await fixture(sub);
      const revoked = [];
      f.proxy.on('auth-error', (value) => revoked.push(value));
      const channel = await shell(await f.connect());
      channel.resume();
      await until(() => f.peers.length === 1);
      const closed = once(channel, 'close');
      f.peers[0].ws.close(code);
      await closed;
      assert.deepEqual(revoked, []);
    });
  }
});

test('candidate gate rejects TCP until activated; concurrent start/stop leaves no listener', { timeout: 15000 }, async (t) => {
  const f = await fixture(t, { acceptingConnections: false });
  const accepted = [];
  const sessions = [];
  f.proxy.on('connection', count => accepted.push(count));
  f.proxy.on('session-open', session => sessions.push(session));
  const candidate = new Client();
  t.after(() => candidate.destroy());
  let ready = false;
  const errors = [];
  candidate.on('ready', () => { ready = true; });
  candidate.on('error', error => errors.push(error));
  const closed = new Promise(resolve => candidate.once('close', resolve));
  candidate.connect({
    host: f.address.host, port: f.address.port, username: 'fixture',
    privateKey: f.identity.privateKey, readyTimeout: 2000,
  });
  await closed;
  for (const error of errors) {
    assert.notEqual(error.level, 'client-timeout');
    assert.notEqual(error.code, 'ETIMEDOUT');
  }
  assert.equal(ready, false);
  assert.deepEqual(accepted, []);
  assert.deepEqual(sessions, []);
  assert.equal(f.proxy._clients.size, 0);
  assert.equal(f.proxy._sockets.size, 0);
  assert.deepEqual(f.proxy.getSessions(), []);
  assert.equal(f.peers.length, 0);
  f.proxy.setAcceptingConnections(true);
  const client = await f.connect();
  client.end();
  await Promise.all([f.proxy.stop(), f.proxy.start(), f.proxy.stop()]);
  await f.proxy.stop();
  assert.equal(f.proxy._server, null);
  assert.equal(f.proxy._sockets.size, 0);
});

test('fresh command proof executes through pinned SSH, WSS and a real remote PTY', { skip: process.platform === 'win32', timeout: 15000 }, async t => {
  const f = await fixture(t, { mode: 'pty' });
  const host = sshUtils.parseKey(fs.readFileSync(path.join(f.root, 'host-key'))).getPublicSSH();
  const hostFingerprint = `SHA256:${crypto.createHash('sha256').update(host).digest('base64').replace(/=+$/, '')}`;
  const { probeRemoteCommand } = require('../../electron/remote-command-probe');
  assert.equal(await probeRemoteCommand({ config: f.address, identity: f.identity, hostFingerprint }), 'REMOTE_COMMAND_OK');
  assert.equal(await probeRemoteCommand({ config: f.address, identity: f.identity, hostFingerprint, command: 'true' }), 'REMOTE_COMMAND_OK');
});

test('opted-in tmux preserves shell state across real SSH/WSS disconnect and reattach', {
  skip: process.platform === 'win32' || spawnSync('tmux', ['-V']).status !== 0 ? 'POSIX PTY and tmux required' : false,
  timeout: 20000,
}, async t => {
  const f = await fixture(t, { mode: 'pty', startupCommand: 'tmux new -A -s usshtc' });
  const client = await f.connect();
  const first = await shell(client);
  const marker = crypto.randomBytes(12).toString('hex');
  let firstText = '';
  first.on('data', chunk => { firstText += chunk.toString(); });
  await until(() => firstText.includes(f.paneReady));
  first.write(`USSHTC_PROOF=$(printf '%s%s' '${marker.slice(0, 12)}' '${marker.slice(12)}'); printf '\\n%s\\n' "$USSHTC_PROOF"\r`);
  await until(() => firstText.includes(marker));
  const closed = once(first, 'close'); first.close(); await closed;
  const second = await shell(client);
  const next = crypto.randomBytes(12).toString('hex');
  let secondText = '';
  second.on('data', chunk => { secondText += chunk.toString(); });
  await until(() => secondText.includes(f.paneReady));
  second.write(`printf '\\n%s%s:%s\\n' '${next.slice(0, 12)}' '${next.slice(12)}' "$USSHTC_PROOF"\r`);
  await until(() => secondText.includes(`${next}:${marker}`));
  second.close();
});
