'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Server, utils } = require('ssh2');
const keys = require('../electron/ssh-key-service');
const { connectTransport } = require('../cli/ssh-transport.cjs');

async function shellFixture(t, { disconnectAt = Infinity, beforeExec } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usshtc-cli-'));
  const local = path.join(root, 'local');
  const remote = path.join(root, 'remote');
  await fs.mkdir(local);
  await fs.mkdir(remote);
  const sshDirectory = path.join(root, 'ssh');
  keys.ensureClientKeyPair({ sshDirectory });
  const identity = keys.getSsh2ClientIdentity({ sshDirectory });
  const hostKey = keys.ensureProxyHostKey(path.join(root, 'host-key'));
  const publicKey = utils.parseKey(identity.privateKey).getPublicSSH();
  const signer = utils.parseKey(identity.privateKey);
  const clients = new Set();
  const children = new Set();
  let commands = 0;
  let longestCommand = 0;
  const server = new Server({ hostKeys: [hostKey] }, client => {
    clients.add(client);
    client.setNoDelay(true);
    client.on('error', () => {});
    client.on('close', () => clients.delete(client));
    client.on('authentication', context => {
      if (context.method !== 'publickey' || !context.key.data.equals(publicKey)) return context.reject();
      if (context.signature && !signer.verify(context.blob, context.signature, context.hashAlgo)) return context.reject();
      context.accept();
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('exec', (acceptCommand, rejectCommand, info) => {
        commands++;
        longestCommand = Math.max(longestCommand, Buffer.byteLength(info.command));
        if (commands === disconnectAt) { client.end(); return; }
        beforeExec?.(info.command, commands, remote);
        const stream = acceptCommand();
        const child = spawn('/bin/sh', ['-c', info.command], { cwd: remote, stdio: ['ignore', 'pipe', 'pipe'] });
        children.add(child);
        child.stdout.pipe(stream, { end: false });
        child.stderr.pipe(stream.stderr, { end: false });
        stream.on('error', () => {});
        stream.once('close', () => { if (child.exitCode === null) child.kill('SIGKILL'); });
        child.once('error', () => { stream.exit(127); stream.end(); });
        child.once('close', code => { children.delete(child); if (!stream.destroyed) { stream.exit(code ?? 255); stream.end(); } });
      });
    }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const transport = await connectTransport({ host: '127.0.0.1', port: server.address().port, identity, hostKey });
  t.after(async () => {
    transport.close();
    for (const client of clients) client.end();
    for (const child of children) child.kill('SIGKILL');
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, local, remote, transport, identity, hostKey, port: server.address().port,
    get commands() { return commands; }, get longestCommand() { return longestCommand; } };
}
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
module.exports = { shellFixture, sha256 };
