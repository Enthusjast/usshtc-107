'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { Client, utils } = require('ssh2');
const { ProxyServer } = require('../../electron/proxy-server');
const keys = require('../../electron/ssh-key-service');
const { portalFixture, sha256 } = require('../fixtures/portal-file-api.cjs');

function killClient(child, signal = 'SIGTERM') {
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function fixture(t, options = {}) {
  const f = await portalFixture(t, options.portal);
  const sshDirectory = path.join(f.root, '.ssh');
  const pair = keys.ensureClientKeyPair({ sshDirectory });
  const identity = keys.getSsh2ClientIdentity({ sshDirectory });
  const privateKey = path.join(f.local, 'client-key');
  await fs.writeFile(privateKey, identity.privateKey, { mode: 0o600 });
  const hostKey = keys.ensureProxyHostKey(path.join(f.root, 'host-key'));
  const hostBlob = utils.parseKey(hostKey).getPublicSSH();
  const proxy = new ProxyServer({ host: '127.0.0.1', port: 0, cluster: 'cluster-1',
    cookie: 'SCOW_USER=fixture-token', hostKey, hostKeyPath: path.join(f.root, 'host-key'),
    authorizedKey: Buffer.from(pair.publicKeyRaw, 'base64'), authorizedKeyOpenSSH: pair.publicKey,
    portalApiOptions: { baseUrl: f.baseUrl, tlsCa: f.tlsCa }, scpTempDirectory: path.join(f.root, 'scp-tmp'),
    webSocketFactory: () => { throw new Error('SCP must not create WSS'); }, shutdownTimeoutMs: 2000,
    ...options.proxy });
  proxy.on('error', () => {});
  const terminals = [];
  proxy.on('session-close', value => terminals.push(value));
  const children = new Set();
  t.after(async () => { for (const child of children) killClient(child, 'SIGKILL'); await proxy.stop(); });
  let address;
  proxy.once('started', value => { address = value; });
  await proxy.start();
  const knownHosts = path.join(f.root, 'known_hosts');
  await fs.writeFile(knownHosts, `[127.0.0.1]:${address.port} ssh-ed25519 ${hostBlob.toString('base64')}\n`, { mode: 0o600 });
  const config = path.join(f.root, 'ssh_config');
  await fs.writeFile(config, `Host fixture\n  HostName 127.0.0.1\n  Port ${address.port}\n  User fixture\n  IdentityFile "${privateKey}"\n  IdentitiesOnly yes\n  BatchMode yes\n  StrictHostKeyChecking yes\n  UserKnownHostsFile "${knownHosts}"\n  LogLevel ERROR\n`, { mode: 0o600 });
  async function run(binary, args, { onSpawn, timeout = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      children.add(child);
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { killClient(child, 'SIGKILL'); }, timeout);
      child.stdout.on('data', bytes => { if (stdout.length < 65536) stdout += bytes.toString(); });
      child.stderr.on('data', bytes => { if (stderr.length < 65536) stderr += bytes.toString(); });
      child.once('error', reject);
      child.once('close', (code, signal) => {
        clearTimeout(timer); children.delete(child); resolve({ code, signal, stdout, stderr });
      });
      onSpawn?.(child);
    });
  }
  const scp = (args, extra) => run(process.env.SCP_BINARY || 'scp', ['-O', '-F', config, ...args], extra);
  const remote = name => `fixture:${name.replace(/[^/\p{L}\p{N}._-]/gu, char => `\\${char}`)}`;
  const fingerprint = `SHA256:${crypto.createHash('sha256').update(hostBlob).digest('base64').replace(/=+$/, '')}`;
  async function connect() {
    const client = new Client();
    client.on('error', () => {});
    client.connect({ host: address.host, port: address.port, username: 'fixture', privateKey: identity.privateKey,
      hostVerifier: key => key.equals(hostBlob), readyTimeout: 5000 });
    t.after(() => client.destroy());
    await once(client, 'ready');
    return client;
  }
  return { ...f, proxy, terminals, scp, remote, connect, run, privateKey, address, fingerprint };
}

const posix = process.platform !== 'win32';

test('real OpenSSH legacy SCP downloads exact binary, Unicode and space filenames without WSS', { skip: !posix, timeout: 40000 }, async t => {
  const f = await fixture(t);
  const payload = crypto.randomBytes(256 * 1024 + 17);
  const name = "/remote/中文 it's a file $literal`semi;?.bin";
  f.files.set(name, payload);
  const destination = path.join(f.local, 'received.bin');
  const result = await f.scp([f.remote(name), destination]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(sha256(await fs.readFile(destination)), sha256(payload));
  assert.equal(f.terminals.at(-1).exitCode, 0);
  assert.equal(f.terminals.at(-1).session.bytesReceived, payload.length);
  assert.equal(f.proxy.getSessions().length, 0);
});

test('real OpenSSH legacy SCP upload ACK follows verified multipart publication and supports overwrite policy', { skip: !posix, timeout: 60000 }, async t => {
  const f = await fixture(t, { portal: { chunkSizeByte: 65537 } });
  const payload = crypto.randomBytes(1024 * 1024 + 9);
  const source = path.join(f.local, '中文 upload.bin');
  await fs.writeFile(source, payload);
  const destination = '/remote/published.bin';
  f.files.set(destination, Buffer.from('old data'));
  const result = await f.scp([source, f.remote(destination)]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(sha256(f.files.get(destination)), sha256(payload));
  assert.ok(f.requests.some(request => request.pathname.endsWith('/mergeFileChunks')));
  assert.equal(f.terminals.at(-1).session.bytesSent, payload.length);
  assert.equal(f.terminals.at(-1).exitCode, 0);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'scp-tmp')), []);
  f.proxy.scpNoOverwrite = true;
  await fs.writeFile(source, 'must not replace');
  const denied = await f.scp([source, f.remote(destination)]);
  assert.notEqual(denied.code, 0);
  assert.equal(sha256(f.files.get(destination)), sha256(payload));
});

test('real OpenSSH recursive SCP preserves tree content and download timestamps but does not apply upload mode', { skip: !posix, timeout: 60000 }, async t => {
  const f = await fixture(t);
  const directory = path.join(f.local, 'tree');
  await fs.mkdir(path.join(directory, '子目录'), { recursive: true });
  await fs.mkdir(path.join(directory, 'empty-directory'));
  await fs.writeFile(path.join(directory, 'empty.bin'), Buffer.alloc(0));
  await fs.writeFile(path.join(directory, 'one.log'), 'one\n');
  await fs.writeFile(path.join(directory, '子目录', '中文 two.bin'), Buffer.from([0, 255, 10, 13]));
  const uploaded = await f.scp(['-rp', directory, f.remote('/remote')]);
  assert.equal(uploaded.code, 0, uploaded.stderr);
  assert.equal(f.files.get('/remote/tree/one.log').toString(), 'one\n');
  assert.deepEqual(f.files.get('/remote/tree/子目录/中文 two.bin'), Buffer.from([0, 255, 10, 13]));
  assert.deepEqual(f.files.get('/remote/tree/empty.bin'), Buffer.alloc(0));
  f.metadata.set('/remote/tree/one.log', { mtime: '2020-01-02T03:04:05.000Z', mode: 0o100640 });
  const returned = path.join(f.local, 'returned');
  await fs.mkdir(returned);
  const downloaded = await f.scp(['-rp', f.remote('/remote/tree'), returned]);
  assert.equal(downloaded.code, 0, downloaded.stderr);
  assert.equal((await fs.readFile(path.join(returned, 'tree', 'one.log'))).toString(), 'one\n');
  assert.deepEqual(await fs.readFile(path.join(returned, 'tree', '子目录', '中文 two.bin')), Buffer.from([0, 255, 10, 13]));
  assert.deepEqual(await fs.readFile(path.join(returned, 'tree', 'empty.bin')), Buffer.alloc(0));
  assert.deepEqual(await fs.readdir(path.join(returned, 'tree', 'empty-directory')), []);
  const stat = await fs.stat(path.join(returned, 'tree', 'one.log'));
  assert.equal(Math.floor(stat.mtimeMs / 1000), Date.parse('2020-01-02T03:04:05.000Z') / 1000);
  assert.equal(stat.mode & 0o777, 0o640);
});

test('real OpenSSH glob expands only matching files, preserves quoted literals, and resolves relative paths via getHome', { skip: !posix, timeout: 60000 }, async t => {
  const f = await fixture(t);
  f.files.set('/remote/a.log', Buffer.from('a'));
  f.files.set('/remote/b.log', Buffer.from('b'));
  f.files.set('/remote/c.txt', Buffer.from('c'));
  f.files.set('/remote/.private.log', Buffer.from('hidden file selected only explicitly'));
  f.files.set('/remote/literal*.dat', Buffer.from('literal'));
  const target = path.join(f.local, 'glob');
  await fs.mkdir(target);
  const match = await f.scp(['fixture:*.log', target]);
  assert.equal(match.code, 0, match.stderr);
  assert.deepEqual((await fs.readdir(target)).sort(), ['a.log', 'b.log']);
  const literal = await f.scp([f.remote('/remote/literal*.dat'), path.join(f.local, 'literal')]);
  assert.equal(literal.code, 0, literal.stderr);
  assert.equal((await fs.readFile(path.join(f.local, 'literal'))).toString(), 'literal');
  const hidden = await f.scp([f.remote('/remote/.private.log'), path.join(f.local, 'explicit-hidden')]);
  assert.equal(hidden.code, 0, hidden.stderr);
  assert.equal((await fs.readFile(path.join(f.local, 'explicit-hidden'))).toString(), 'hidden file selected only explicitly');
  const noMatch = await f.scp(['fixture:missing?.log', target]);
  assert.notEqual(noMatch.code, 0);
  assert.match(noMatch.stderr, /not found|No such file|No matches/i);
});

test('real OpenSSH rejects missing, denied, symlink and oversize entries without false success', { skip: !posix, timeout: 60000 }, async t => {
  const f = await fixture(t, { proxy: { scpMaxFileBytes: 16 }, portal: {
    permission: request => request.query.path === '/denied',
  } });
  f.dirs.add('/denied');
  f.files.set('/remote/large', Buffer.alloc(17));
  f.symlinks.set('/remote/link', '/remote/large');
  for (const name of ['/remote/missing', '/denied/file', '/remote/link', '/remote/large']) {
    const result = await f.scp([f.remote(name), path.join(f.local, 'invalid-download')]);
    assert.notEqual(result.code, 0, name);
    assert.equal(result.signal, null, 'protocol error must not rely on process timeout');
    if (name.startsWith('/denied/')) assert.match(result.stderr, /permission.*denied/i);
  }
  const source = path.join(f.local, 'oversize');
  await fs.writeFile(source, Buffer.alloc(17));
  const upload = await f.scp([source, f.remote('/remote/new')]);
  assert.notEqual(upload.code, 0);
  assert.equal(f.files.has('/remote/new'), false);
});

test('real SSH malformed SCP is rejected locally and ordinary exec remains on existing bridge', { skip: !posix, timeout: 15000 }, async t => {
  const f = await fixture(t);
  const client = await f.connect();
  async function exec(command) {
    const channel = await new Promise((resolve, reject) => client.exec(command, (error, value) => error ? reject(error) : resolve(value)));
    let code, output = '';
    channel.on('data', bytes => { output += bytes.toString(); });
    channel.stderr.on('data', bytes => { output += bytes.toString(); });
    channel.on('exit', value => { code = value; });
    await once(channel, 'close');
    return { code, output };
  }
  const malformed = await exec('scp -t /remote/target; touch /remote/escape');
  assert.notEqual(malformed.code, 0);
  assert.match(malformed.output, /malformed SCP/);
  assert.equal(f.requests.length, 0);
  const normal = await exec('printf normal');
  assert.match(normal.output, /WSS setup failed/);
  assert.equal(f.requests.length, 0);
});

test('real PuTTY pscp forced SCP uploads and downloads matching bytes with pinned host key', {
  skip: !process.env.PSCP_BINARY || !process.env.PUTTYGEN_BINARY ? 'Requires PSCP_BINARY and PUTTYGEN_BINARY' : false,
  timeout: 60000,
}, async t => {
  const f = await fixture(t);
  const ppk = path.join(f.local, 'client.ppk');
  const converted = spawnSync(process.env.PUTTYGEN_BINARY, [f.privateKey, '-O', 'private', '-o', ppk, '--new-passphrase', '/dev/null'], { timeout: 5000 });
  assert.equal(converted.status, 0, converted.stderr.toString());
  const payload = crypto.randomBytes(128 * 1024 + 3);
  const source = path.join(f.local, 'putty-source.bin');
  await fs.writeFile(source, payload);
  const args = ['-scp', '-batch', '-hostkey', f.fingerprint, '-P', String(f.address.port), '-i', ppk];
  const remote = 'fixture@127.0.0.1:/remote/putty.bin';
  const upload = await f.run(process.env.PSCP_BINARY, [...args, source, remote]);
  assert.equal(upload.code, 0, upload.stderr);
  assert.equal(sha256(f.files.get('/remote/putty.bin')), sha256(payload));
  const destination = path.join(f.local, 'putty-returned.bin');
  const download = await f.run(process.env.PSCP_BINARY, [...args, remote, destination]);
  assert.equal(download.code, 0, download.stderr);
  assert.equal(sha256(await fs.readFile(destination)), sha256(payload));
});

test('real OpenSSH transfers a file above GUI 64 MiB cap through SCP multipart without changing GUI limits', { skip: !posix, timeout: 120000 }, async t => {
  const f = await fixture(t, { portal: { chunkSizeByte: 4 * 1024 * 1024 } });
  const source = path.join(f.local, 'large-source');
  const handle = await fs.open(source, 'wx', 0o600);
  const size = 64 * 1024 * 1024 + 1;
  try {
    await handle.truncate(size);
    await handle.write(Buffer.from('SCP binary boundary'), 0, 19, 0);
    await handle.write(Buffer.from([255]), 0, 1, size - 1);
  } finally { await handle.close(); }
  const expected = crypto.createHash('sha256');
  for await (const block of require('node:fs').createReadStream(source)) expected.update(block);
  const hash = expected.digest('hex');
  const uploaded = await f.scp([source, f.remote('/remote/large-source')], { timeout: 100000 });
  assert.equal(uploaded.code, 0, uploaded.stderr);
  assert.equal(sha256(f.files.get('/remote/large-source')), hash);
  const destination = path.join(f.local, 'large-returned');
  const downloaded = await f.scp([f.remote('/remote/large-source'), destination], { timeout: 100000 });
  assert.equal(downloaded.code, 0, downloaded.stderr);
  const actual = crypto.createHash('sha256');
  for await (const block of require('node:fs').createReadStream(destination)) actual.update(block);
  assert.equal(actual.digest('hex'), hash);
  assert.equal(require('../../electron/file-transfer/orchestrator').MAX_BYTES, 64 * 1024 * 1024);
});

for (const action of ['client-disconnect', 'proxy-stop', 'cookie-change']) {
  test(`real OpenSSH ${action} cancels pending HTTP publication and cleans local spool`, { skip: !posix, timeout: 10000 }, async t => {
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    t.after(() => release());
    const f = await fixture(t, { portal: { beforeRequest: async ctx => {
      if (ctx.pathname === '/api/file/upload') { enter(); await gate; }
    } } });
    const source = path.join(f.local, 'cancel-source');
    await fs.writeFile(source, crypto.randomBytes(128 * 1024));
    let child;
    const running = f.scp([source, f.remote('/remote/not-published')], { timeout: 5000, onSpawn: value => { child = value; } });
    await entered;
    const closed = once(f.proxy, 'session-close');
    if (action === 'proxy-stop') await f.proxy.stop();
    else if (action === 'cookie-change') f.proxy.updateCookie('SCOW_USER=changed-fixture-token');
    else killClient(child);
    await closed;
    release();
    const result = await running;
    assert.notEqual(result.code, 0);
    assert.notEqual(result.signal, 'SIGKILL', 'cancellation must not depend on the client timeout');
    assert.equal(f.files.has('/remote/not-published'), false);
    assert.equal(f.requests.some(request => request.pathname.endsWith('/move')), false);
    assert.deepEqual(await fs.readdir(path.join(f.root, 'scp-tmp')), []);
    assert.equal(f.proxy.getSessions().length, 0);
  });
}

test('real OpenSSH receives failure when in-place overwrite readback differs, with honest changed-target warning', { skip: !posix, timeout: 40000 }, async t => {
  const destination = '/remote/existing';
  const f = await fixture(t, { portal: { beforeDownload({ fixture, query }) {
    if (query.path === destination) fixture.files.set(destination, Buffer.from('bad bytes'));
  } } });
  f.files.set(destination, Buffer.from('original'));
  const source = path.join(f.local, 'overwrite-source');
  await fs.writeFile(source, 'new bytes');
  const result = await f.scp([source, f.remote(destination)]);
  assert.notEqual(result.code, 0, 'the final ACK must not report corrupt publication as success');
  assert.match(result.stderr, /incomplete|truncated|changed/i);
  assert.equal(f.files.get(destination).toString(), 'bad bytes');
  assert.equal(f.requests.some(request => request.method === 'DELETE'), false);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'scp-tmp')), []);
});
