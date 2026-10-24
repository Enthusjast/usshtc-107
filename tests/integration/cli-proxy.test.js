'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');
const { startService } = require('../../cli/service.cjs');
const { connectTransport } = require('../../cli/ssh-transport.cjs');
const { download } = require('../../cli/transfers.cjs');

const certificate = fs.readFileSync(path.join(__dirname, '../fixtures/loopback-test-only-cert.pem'));
const tlsKey = fs.readFileSync(path.join(__dirname, '../fixtures/loopback-test-only-key.pem'));
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'usshtc-cli-proxy-'));
  const remote = path.join(root, 'remote');
  const local = path.join(root, 'local');
  await fsp.mkdir(remote);
  await fsp.mkdir(local);
  const peers = new Set();
  const children = new Set();
  const transports = new Set();
  const server = https.createServer({ key: tlsKey, cert: certificate });
  const wss = new WebSocketServer({ noServer: true });
  let service;
  let sessions = 0;
  let silentSession = -1;
  t.after(async () => {
    for (const transport of transports) transport.close();
    await service?.stop();
    for (const ws of peers) ws.terminate();
    await Promise.all([...children].map(child => {
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      return closed;
    }));
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await fsp.rm(root, { recursive: true, force: true });
  });
  server.on('upgrade', (request, socket, head) => {
    assert.equal(request.headers.cookie, 'SCOW_USER=local-cli-fixture');
    assert.equal(request.headers.origin, 'https://107.ustc.edu.cn');
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    const silent = ++sessions === silentSession;
    peers.add(ws);
    const child = spawn('python3', [path.join(__dirname, '../fixtures/pty-peer.py')], {
      cwd: remote, stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.add(child);
    child.on('error', () => ws.terminate());
    child.stdin.on('error', () => {});
    child.stderr.resume();
    // The real PTY peer independently decodes every output byte. Batching its
    // JSON records only limits fixture frame overhead; it cannot repair UTF-8.
    let pending = '';
    let scheduled = false;
    function flush() {
      scheduled = false;
      if (pending && !silent && ws.readyState === 1) ws.send(JSON.stringify({ $case: 'data', data: { data: pending } }));
      pending = '';
    }
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => {
      pending += JSON.parse(line).data;
      if (pending.length >= 8192) flush();
      else if (!scheduled) { scheduled = true; setImmediate(flush); }
    });
    child.once('close', () => {
      children.delete(child);
      flush();
      if (ws.readyState === 1) ws.close(1000);
    });
    ws.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.$case === 'data') child.stdin.write(`${JSON.stringify({ input: message.data.data })}\n`);
    });
    ws.once('close', () => { peers.delete(ws); child.kill('SIGTERM'); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const options = {
    host: '127.0.0.1', port: 0, cookie: 'SCOW_USER=local-cli-fixture',
    dataDir: path.join(root, 'data'), sshDirectory: path.join(root, 'ssh'),
    wssUrl: `wss://127.0.0.1:${server.address().port}/shell`, tlsCa: certificate,
    execTimeoutMs: 10000, remoteReadyTimeoutMs: 3000, shutdownTimeoutMs: 1000,
  };
  service = await startService(options);
  async function cli(command, operands) {
    const child = spawn(process.execPath, [path.resolve(__dirname, '../../cli/main.cjs'), command,
      '--host', service.host, '--port', String(service.port), '--data-dir', options.dataDir,
      '--ssh-directory', options.sshDirectory, '--timeout-ms', '20000', '--', ...operands],
    { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SCOW_TOKEN: '' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
  }
  async function transport() {
    const connection = await connectTransport({ host: service.host, port: service.port,
      identity: service.identity, hostKey: service.hostKey });
    transports.add(connection);
    return connection;
  }
  return { root, remote, local, service, cli, transport,
    silenceDownloadChunk() { silentSession = sessions + 2; },
    get sessions() { return sessions; } };
}

test('actual CLI put/get preserves 128KiB binary through pinned SSH, ProxyServer, TLS/WSS and Unix PTY exec codec', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const bytes = crypto.randomBytes(128 * 1024);
  const expected = digest(bytes);
  const source = path.join(f.local, 'input.bin');
  const destination = path.join(f.local, 'output.bin');
  const remoteName = "- uploaded ' quoted file.bin";
  const remotePath = path.join(f.remote, remoteName);
  await fsp.writeFile(source, bytes);
  const published = [];
  const watcher = fs.watch(f.remote, (event, name) => {
    if (name === remoteName) published.push(digest(fs.readFileSync(remotePath)));
  });
  t.after(() => watcher.close());
  let put;
  try { put = await f.cli('put', [source, remoteName]); }
  finally { watcher.close(); }
  assert.equal(put.code, 0, put.stderr);
  assert.match(put.stdout, /SHA-256 verified/);
  assert.equal(digest(await fsp.readFile(remotePath)), expected);
  assert.ok(published.length > 0, 'the final name must be observed only after atomic publication');
  assert.ok(published.every(hash => hash === expected), 'no partial content may appear at the final name');
  assert.deepEqual((await fsp.readdir(f.remote)).filter(name => name.endsWith('.part')), []);
  const get = await f.cli('get', [remoteName, destination]);
  assert.equal(get.code, 0, get.stderr);
  assert.match(get.stdout, /SHA-256 verified/);
  assert.equal(digest(await fsp.readFile(destination)), expected);
  assert.deepEqual((await fsp.readdir(f.local)).filter(name => name.endsWith('.part')), []);
  assert.ok(f.sessions >= 15, 'all chunks must traverse actual independent remote exec sessions');
  const conflict = await f.cli('put', [source, remoteName]);
  assert.equal(conflict.code, 1);
  assert.equal(digest(await fsp.readFile(remotePath)), expected);
});

test('direct CLI download deadline through ProxyServer readiness silence cleans temporary output without auth invalidation', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  await fsp.writeFile(path.join(f.remote, 'source.bin'), crypto.randomBytes(32 * 1024));
  const transport = await f.transport();
  let authErrors = 0;
  f.service.proxy.on('auth-error', () => authErrors++);
  f.silenceDownloadChunk();
  await assert.rejects(download({ transport, remotePath: 'source.bin',
    localPath: path.join(f.local, 'must-not-exist.bin'), timeoutMs: 1000 }), { code: 'CLI_TIMEOUT' });
  assert.equal(f.sessions, 2, 'metadata succeeds, then the actual chunk session stalls before readiness');
  assert.equal(authErrors, 0);
  assert.deepEqual(await fsp.readdir(f.local), []);
  assert.equal((await fsp.stat(path.join(f.remote, 'source.bin'))).size, 32 * 1024);
});
