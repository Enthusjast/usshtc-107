'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { allocateTempFile, MAX_RESERVED_BYTES, FREE_SPACE_MARGIN } = require('../../electron/scp/temp-file');

async function root(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'usshtc-scp-storage-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function ampleDisk(t) {
  return t.mock.method(fs, 'statfs', async () => ({ bavail: 100n * 1024n ** 3n, bsize: 1n }));
}

async function ownedDirectory(directory, pid, suffix) {
  const candidate = path.join(directory, `.usshtc107-scp-${pid}-${suffix}`);
  await fs.mkdir(candidate, { mode: 0o700 });
  await fs.writeFile(path.join(candidate, 'owner.json'), JSON.stringify({ version: 1, pid,
    token: 'a'.repeat(32), createdAt: Date.now() - 1000 }), { mode: 0o600 });
  await fs.writeFile(path.join(candidate, 'payload'), 'private', { mode: 0o600 });
  return candidate;
}

test('temporary files and directories are private, exclusively created, and cleaned idempotently', async t => {
  ampleDisk(t);
  const directory = await root(t);
  const temporary = await allocateTempFile({ directory, size: 7 });
  if (process.platform !== 'win32') {
    assert.equal((await fs.lstat(path.dirname(temporary.path))).mode & 0o777, 0o700);
    assert.equal((await fs.lstat(temporary.path)).mode & 0o777, 0o600);
  }
  await temporary.handle.write(Buffer.from('payload'));
  await temporary.cleanup();
  await temporary.cleanup();
  assert.deepEqual(await fs.readdir(directory), []);
});

test('global two-GiB reservation is enforced across distinct temporary roots and released on cleanup', async t => {
  ampleDisk(t);
  const firstRoot = await root(t);
  const secondRoot = await root(t);
  const size = MAX_RESERVED_BYTES / 2;
  const first = await allocateTempFile({ directory: firstRoot, size });
  t.after(() => first.cleanup());
  const second = await allocateTempFile({ directory: secondRoot, size });
  t.after(() => second.cleanup());
  await assert.rejects(allocateTempFile({ directory: firstRoot, size: 1 }), { code: 'SCP_TEMP_LIMIT' });
  await first.cleanup();
  const third = await allocateTempFile({ directory: firstRoot, size: 1 });
  await third.cleanup();
  await second.cleanup();
});

test('statfs reserves a free-space safety margin and a failed allocation releases its quota', async t => {
  const directory = await root(t);
  const disk = t.mock.method(fs, 'statfs', async () => ({ bavail: BigInt(FREE_SPACE_MARGIN + 31), bsize: 1n }));
  await assert.rejects(allocateTempFile({ directory, size: 32 }), { code: 'SCP_TEMP_SPACE' });
  assert.deepEqual(await fs.readdir(directory), []);
  disk.mock.restore();
  ampleDisk(t);
  const temporary = await allocateTempFile({ directory, size: 1024 ** 3 });
  await temporary.cleanup();
});

test('preexisting public roots and symlink roots are refused without touching their contents', { skip: process.platform === 'win32' }, async t => {
  ampleDisk(t);
  const directory = await root(t);
  const publicRoot = path.join(directory, 'public');
  await fs.mkdir(publicRoot, { mode: 0o755 });
  await fs.chmod(publicRoot, 0o755);
  await fs.writeFile(path.join(publicRoot, 'unknown'), 'keep');
  await assert.rejects(allocateTempFile({ directory: publicRoot, size: 1 }), { code: 'SCP_TEMP_UNSAFE' });
  assert.equal(await fs.readFile(path.join(publicRoot, 'unknown'), 'utf8'), 'keep');
  const privateRoot = path.join(directory, 'private');
  await fs.mkdir(privateRoot, { mode: 0o700 });
  const link = path.join(directory, 'link');
  await fs.symlink(privateRoot, link, 'dir');
  await assert.rejects(allocateTempFile({ directory: `${link}${path.sep}`, size: 1 }), { code: 'SCP_TEMP_UNSAFE' });
  assert.deepEqual(await fs.readdir(privateRoot), []);
});

test('scavenging deletes only marked dead-process payloads and preserves live or unknown files', { skip: process.platform === 'win32' }, async t => {
  ampleDisk(t);
  const directory = await root(t);
  const child = spawn(process.execPath, ['-e', '']);
  await once(child, 'exit');
  const dead = await ownedDirectory(directory, child.pid, 'DEAD01');
  const unknown = await ownedDirectory(directory, child.pid, 'DEAD02');
  await fs.writeFile(path.join(unknown, 'unfamiliar'), 'keep');
  const live = await ownedDirectory(directory, process.pid, 'LIVE01');
  const unmarked = path.join(directory, `.usshtc107-scp-${child.pid}-OTHER1`);
  await fs.mkdir(unmarked, { mode: 0o700 });
  await fs.writeFile(path.join(unmarked, 'payload'), 'keep');
  const linked = await ownedDirectory(directory, child.pid, 'LINK01');
  await fs.unlink(path.join(linked, 'payload'));
  const target = path.join(directory, 'unknown-target');
  await fs.writeFile(target, 'keep');
  await fs.symlink(target, path.join(linked, 'payload'));
  const temporary = await allocateTempFile({ directory, size: 1 });
  await temporary.cleanup();
  await assert.rejects(fs.stat(dead), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(unknown, 'unfamiliar'), 'utf8'), 'keep');
  assert.equal(await fs.readFile(path.join(live, 'payload'), 'utf8'), 'private');
  assert.equal(await fs.readFile(path.join(unmarked, 'payload'), 'utf8'), 'keep');
  assert.equal((await fs.lstat(path.join(linked, 'payload'))).isSymbolicLink(), true);
  assert.equal(await fs.readFile(target, 'utf8'), 'keep');
});
