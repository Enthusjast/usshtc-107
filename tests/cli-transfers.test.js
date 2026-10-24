'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { upload, download, remotePath, CHUNK_BYTES } = require('../cli/transfers.cjs');
const { connectTransport } = require('../cli/ssh-transport.cjs');
const keys = require('../electron/ssh-key-service');
const { shellFixture, sha256 } = require('./cli-helpers.cjs');
const shellTest = process.platform === 'win32' ? test.skip : test;

shellTest('CLI transfers round-trip 10MiB random binary through real SSH and temporary shell', { timeout: 120000 }, async t => {
  const fixture = await shellFixture(t);
  const bytes = crypto.randomBytes(10 * 1024 * 1024);
  const source = path.join(fixture.local, 'source.bin');
  const destination = path.join(fixture.local, 'returned.bin');
  await fs.writeFile(source, bytes);
  const remote = "- binary 'quoted' ; $(touch INJECTED) file.bin";
  const put = await upload({ transport: fixture.transport, localPath: source, remotePath: remote });
  const get = await download({ transport: fixture.transport, localPath: destination, remotePath: remote });
  assert.equal(put.sha256, sha256(bytes));
  assert.deepEqual(get, put);
  assert.equal(sha256(await fs.readFile(destination)), sha256(bytes));
  assert.equal(sha256(await fs.readFile(path.join(fixture.remote, remote))), sha256(bytes));
  await assert.rejects(fs.stat(path.join(fixture.remote, 'INJECTED')), { code: 'ENOENT' });
  assert.ok(fixture.commands > 300, 'large files must use bounded per-chunk commands');
  assert.ok(fixture.longestCommand < 32 * 1024, 'exec requests must fit ssh2 transport packets');
  assert.deepEqual((await fs.readdir(fixture.remote)).filter(name => name.endsWith('.part')), []);
});

shellTest('CLI upload/download never overwrite files, symlinks or directories', async t => {
  const fixture = await shellFixture(t);
  const source = path.join(fixture.local, 'source');
  await fs.writeFile(source, 'new-data');
  await fs.writeFile(path.join(fixture.remote, 'exists'), 'original');
  await assert.rejects(upload({ transport: fixture.transport, localPath: source, remotePath: 'exists' }));
  assert.equal(await fs.readFile(path.join(fixture.remote, 'exists'), 'utf8'), 'original');
  await fs.symlink('missing', path.join(fixture.remote, 'dangling'));
  await assert.rejects(upload({ transport: fixture.transport, localPath: source, remotePath: 'dangling' }));
  await fs.mkdir(path.join(fixture.remote, 'directory'));
  await assert.rejects(upload({ transport: fixture.transport, localPath: source, remotePath: 'directory' }));
  assert.deepEqual(await fs.readdir(path.join(fixture.remote, 'directory')), []);
  await assert.rejects(download({ transport: fixture.transport, localPath: source, remotePath: 'exists' }), { code: 'TRANSFER_EXISTS' });
  assert.equal(await fs.readFile(source, 'utf8'), 'new-data');
});

shellTest('CLI limits reject oversized local and remote sources without publishing partial files', async t => {
  const fixture = await shellFixture(t);
  const source = path.join(fixture.local, 'large');
  await fs.writeFile(source, crypto.randomBytes(CHUNK_BYTES + 1));
  await assert.rejects(upload({ transport: fixture.transport, localPath: source, remotePath: 'final', maxBytes: CHUNK_BYTES }), { code: 'TRANSFER_LIMIT' });
  assert.equal(fixture.commands, 0);
  await fs.writeFile(path.join(fixture.remote, 'large'), crypto.randomBytes(CHUNK_BYTES + 1));
  await assert.rejects(download({ transport: fixture.transport, localPath: path.join(fixture.local, 'final'), remotePath: 'large', maxBytes: CHUNK_BYTES }));
  await assert.rejects(fs.stat(path.join(fixture.local, 'final')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(fixture.remote, 'final')), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(fixture.local)).filter(name => name.endsWith('.part')), []);
});

shellTest('CLI download disconnect removes local temporary file and leaves no final', async t => {
  const fixture = await shellFixture(t, { disconnectAt: 3 });
  await fs.writeFile(path.join(fixture.remote, 'source'), crypto.randomBytes(CHUNK_BYTES * 3));
  await assert.rejects(download({ transport: fixture.transport, remotePath: 'source', localPath: path.join(fixture.local, 'final') }));
  assert.deepEqual(await fs.readdir(fixture.local), []);
});

shellTest('CLI upload disconnect never publishes a final file', async t => {
  const fixture = await shellFixture(t, { disconnectAt: 3 });
  const source = path.join(fixture.local, 'source');
  await fs.writeFile(source, crypto.randomBytes(CHUNK_BYTES * 3));
  await assert.rejects(upload({ transport: fixture.transport, localPath: source, remotePath: 'final' }));
  await assert.rejects(fs.stat(path.join(fixture.remote, 'final')), { code: 'ENOENT' });
});

shellTest('CLI abort cleans a partially uploaded remote temporary file without replaying commands', async t => {
  const fixture = await shellFixture(t);
  const controller = new AbortController();
  let calls = 0;
  const transport = {
    async exec(command, options) {
      const result = await fixture.transport.exec(command, options);
      calls++;
      if (calls === 2) controller.abort();
      return result;
    },
  };
  const source = path.join(fixture.local, 'source');
  await fs.writeFile(source, crypto.randomBytes(CHUNK_BYTES * 2));
  await assert.rejects(upload({ transport, localPath: source, remotePath: 'final', signal: controller.signal }), { code: 'CLI_ABORTED' });
  assert.deepEqual(await fs.readdir(fixture.remote), []);
  assert.equal(calls, 3, 'create, one append, cleanup only; no command replay');
});

shellTest('CLI total deadline aborts a real sleeping remote command and removes local temporary file', async t => {
  const fixture = await shellFixture(t);
  await fs.writeFile(path.join(fixture.remote, 'source'), 'hello');
  let count = 0;
  const transport = { exec(command, options) {
    count++;
    return fixture.transport.exec(count === 2 ? `sleep 2; ${command}` : command, options);
  } };
  await assert.rejects(download({ transport, remotePath: 'source', localPath: path.join(fixture.local, 'final'), timeoutMs: 100 }), error => ['CLI_TIMEOUT', 'CLI_ABORTED'].includes(error.code));
  assert.deepEqual(await fs.readdir(fixture.local), []);
});

shellTest('CLI detects remote content mutation before download publication', async t => {
  const fixture = await shellFixture(t, { beforeExec(command, count, remote) {
    if (count === 3) require('node:fs').writeFileSync(path.join(remote, 'source'), Buffer.alloc(CHUNK_BYTES * 2, 9));
  } });
  await fs.writeFile(path.join(fixture.remote, 'source'), Buffer.alloc(CHUNK_BYTES * 2, 7));
  await assert.rejects(download({ transport: fixture.transport, remotePath: 'source', localPath: path.join(fixture.local, 'final') }), { code: 'TRANSFER_HASH' });
  assert.deepEqual(await fs.readdir(fixture.local), []);
});

shellTest('CLI SSH transport pins the host key and rejects unrelated client identities', async t => {
  const fixture = await shellFixture(t);
  const wrongHost = keys.ensureProxyHostKey(path.join(fixture.root, 'wrong-host'));
  await assert.rejects(connectTransport({ host: '127.0.0.1', port: fixture.port, identity: fixture.identity, hostKey: wrongHost }), { code: 'CLI_SSH' });
  const sshDirectory = path.join(fixture.root, 'unrelated');
  keys.ensureClientKeyPair({ sshDirectory });
  await assert.rejects(connectTransport({ host: '127.0.0.1', port: fixture.port, identity: keys.getSsh2ClientIdentity({ sshDirectory }), hostKey: fixture.hostKey }), { code: 'CLI_SSH' });
});

test('CLI remote path validation rejects controls and safely preserves shell metacharacters', () => {
  for (const candidate of ['', 'bad\0name', 'bad\nname', 'a'.repeat(4097)]) assert.throws(() => remotePath(candidate), { code: 'TRANSFER_PATH' });
  assert.equal(remotePath("-' ; $(whoami)"), "./-' ; $(whoami)");
});

shellTest('CLI upload atomic publication refuses a destination created after preflight', async t => {
  const fixture = await shellFixture(t, { beforeExec(command, count, remote) {
    if (command.startsWith('ln -T --')) require('node:fs').mkdirSync(path.join(remote, 'raced'));
  } });
  const source = path.join(fixture.local, 'source');
  await fs.writeFile(source, 'payload');
  await assert.rejects(upload({ transport: fixture.transport, localPath: source, remotePath: 'raced' }));
  assert.deepEqual(await fs.readdir(path.join(fixture.remote, 'raced')), []);
  assert.deepEqual((await fs.readdir(fixture.remote)).filter(name => name.endsWith('.part')), []);
});

shellTest('CLI download atomic publication refuses a destination raced in after preflight', async t => {
  const fixture = await shellFixture(t);
  const destination = path.join(fixture.local, 'raced');
  await fs.writeFile(path.join(fixture.remote, 'source'), 'payload');
  let calls = 0;
  const transport = { async exec(command, options) {
    const result = await fixture.transport.exec(command, options);
    if (++calls === 3) await fs.writeFile(destination, 'racer', { flag: 'wx' });
    return result;
  } };
  await assert.rejects(download({ transport, remotePath: 'source', localPath: destination }), { code: 'EEXIST' });
  assert.equal(await fs.readFile(destination, 'utf8'), 'racer');
  assert.deepEqual(await fs.readdir(fixture.local), ['raced']);
});

shellTest('CLI transfers preserve empty files and nested quoted directory paths', async t => {
  const fixture = await shellFixture(t);
  const directory = "-directory ' ; safe";
  await fs.mkdir(path.join(fixture.remote, directory));
  const source = path.join(fixture.local, '- source');
  const destination = path.join(fixture.local, "returned ' file");
  const remote = `${directory}/- empty ' file`;
  await fs.writeFile(source, Buffer.alloc(0));
  await upload({ transport: fixture.transport, localPath: source, remotePath: remote });
  const result = await download({ transport: fixture.transport, remotePath: remote, localPath: destination });
  assert.equal(result.bytes, 0);
  assert.equal(result.sha256, sha256(Buffer.alloc(0)));
  assert.equal((await fs.stat(destination)).size, 0);
});

shellTest('CLI rejects oversized exec requests before SSH packet encoding without losing its connection', async t => {
  const fixture = await shellFixture(t);
  await assert.rejects(fixture.transport.exec('x'.repeat(32 * 1024 + 1)), { code: 'CLI_INPUT_LIMIT' });
  await assert.rejects(fixture.transport.exec('bad\0command'), { code: 'CLI_INPUT_LIMIT' });
  assert.equal(fixture.commands, 0);
  assert.equal((await fixture.transport.exec("printf '%s' 'still-authenticated'")).toString(), 'still-authenticated');
});

shellTest('CLI follows explicit source symlinks but refuses dangling local destination links', async t => {
  const fixture = await shellFixture(t);
  const bytes = crypto.randomBytes(CHUNK_BYTES + 1);
  await fs.writeFile(path.join(fixture.remote, 'source'), bytes);
  await fs.symlink('source', path.join(fixture.remote, 'source-link'));
  const destination = path.join(fixture.local, 'downloaded');
  await download({ transport: fixture.transport, remotePath: 'source-link', localPath: destination });
  assert.equal(sha256(await fs.readFile(destination)), sha256(bytes));
  const dangling = path.join(fixture.local, 'dangling');
  await fs.symlink('must-not-be-created', dangling);
  await assert.rejects(download({ transport: fixture.transport, remotePath: 'source-link', localPath: dangling }), { code: 'TRANSFER_EXISTS' });
  assert.equal(await fs.readlink(dangling), 'must-not-be-created');
  await assert.rejects(fs.stat(path.join(fixture.local, 'must-not-be-created')), { code: 'ENOENT' });
});
