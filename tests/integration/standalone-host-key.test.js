'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Client, utils } = require('ssh2');
const { ensureClientKeyPair, getSsh2ClientIdentity } = require('../../electron/ssh-key-service');

test('standalone proxy fallback persists its Ed25519 host identity across processes', { timeout: 15000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc107-host-'));
  const sshDirectory = path.join(root, 'identity');
  const pair = ensureClientKeyPair({ sshDirectory });
  const identity = getSsh2ClientIdentity({ sshDirectory });
  const hostKeyPath = path.join(root, 'proxy_host_ed25519');
  const children = new Set();
  const clients = new Set();
  t.after(async () => {
    for (const client of clients) client.destroy();
    await Promise.all([...children].map(async child => {
      const closed = once(child, 'exit');
      child.kill();
      await closed;
    }));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = `
    const fs = require('node:fs');
    const { utils } = require('ssh2');
    const { ProxyServer } = require('./electron/proxy-server');
    const options = JSON.parse(process.argv[1]);
    const proxy = new ProxyServer({ ...options, authorizedKey: Buffer.from(options.raw, 'base64'), port: 0, host: '127.0.0.1' });
    const stop = async () => { await proxy.stop(); process.exit(0); };
    process.on('message', stop);
    process.once('SIGTERM', stop);
    proxy.on('started', ({ port }) => process.send({ port, publicKey: utils.parseKey(fs.readFileSync(options.hostKeyPath)).getPublicSSH().toString('base64') }));
    proxy.start().catch(() => { process.send({ error: 'PROXY_START_FAILED' }); process.exit(1); });
  `;
  let pinned;
  for (let iteration = 0; iteration < 2; iteration++) {
    const child = spawn(process.execPath, ['-e', source, JSON.stringify({ hostKeyPath,
      authorizedKeyOpenSSH: pair.publicKey, raw: pair.publicKeyRaw })], {
      cwd: path.resolve(__dirname, '../..'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    child.once('exit', () => children.delete(child));
    child.stdout.resume(); child.stderr.resume();
    const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
    assert.equal(ready.error, undefined);
    if (pinned) assert.equal(ready.publicKey, pinned); else pinned = ready.publicKey;
    const client = new Client(); clients.add(client);
    client.on('error', () => {});
    const connected = once(client, 'ready', { signal: AbortSignal.timeout(5000) });
    client.connect({ host: '127.0.0.1', port: ready.port, username: 'user', privateKey: identity.privateKey,
      hostVerifier: wire => wire.toString('base64') === pinned });
    await connected;
    const closed = once(client, 'close'); client.end(); await closed; clients.delete(client);
    const exited = once(child, 'exit'); child.send('stop');
    assert.deepEqual(await exited, [0, null]);
  }
  const key = utils.parseKey(fs.readFileSync(hostKeyPath));
  assert.equal(key.type, 'ssh-ed25519');
  assert.equal(key.getPublicSSH().toString('base64'), pinned);
  if (process.platform !== 'win32') assert.equal(fs.statSync(hostKeyPath).mode & 0o777, 0o600);
});
