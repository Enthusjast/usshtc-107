'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { upload, download, remotePath, localPath } = require('../electron/file-transfer/orchestrator');
const { portalFixture, sha256 } = require('./fixtures/portal-file-api.cjs');

const cluster = 'cluster-1';
const operations = (fixture, operation) => fixture.requests.filter(item => item.pathname === `/api/file/${operation}`);
const options = fixture => ({ api: fixture.api, cluster });
const noPublish = fixture => assert.equal(operations(fixture, 'move').length, 0);
const noRemoteCleanup = fixture => assert.equal(fixture.requests.some(item => item.method === 'DELETE'), false);
async function noParts(directory) {
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.endsWith('.part')), []);
}
function assertProgress(events, total, mode) {
  assert.ok(events.length > 0);
  let previous = 0;
  for (const event of events) {
    assert.ok(Number.isSafeInteger(event.bytes));
    assert.ok(event.total === total || (event.phase === 'hashing' && event.total === 0 && event.bytes === 0));
    assert.ok(event.bytes >= previous, `progress regressed in ${event.phase}`);
    assert.ok(event.bytes <= total, 'short final block must not overcount');
    assert.equal(typeof event.phase, 'string');
    assert.ok(['single', 'multipart'].includes(event.mode));
    previous = event.bytes;
  }
  assert.equal(events.at(-1).bytes, total);
  assert.equal(events.at(-1).phase, 'completed');
  assert.equal(events.at(-1).mode, mode);
}

for (const { label, size, block, mode } of [
  { label: 'small binary', size: 128 * 1024 + 17, block: 1024 * 1024, mode: 'single' },
  { label: '10MiB multipart binary', size: 10 * 1024 * 1024 + 29, block: 700001, mode: 'multipart' },
]) {
  test(`official HTTPS ${label} round-trip verifies raw-byte hashes before publication`, { timeout: 30000 }, async t => {
    const f = await portalFixture(t, { chunkSizeByte: block });
    const bytes = crypto.randomBytes(size);
    const source = path.join(f.local, 'source.bin');
    const destination = path.join(f.local, 'returned.bin');
    const target = "/remote/quoted ' & +?#% directory/- binary file.bin";
    f.dirs.add(path.posix.dirname(target));
    await fs.writeFile(source, bytes);
    const putProgress = [];
    const put = await upload({ ...options(f), localPath: source, remotePath: target, onProgress: item => putProgress.push(item) });
    assert.equal(put.bytes, size);
    assert.equal(put.sha256, sha256(bytes));
    assert.equal(put.mode, mode);
    assert.equal(typeof put.remoteTempsRetained, 'boolean');
    assert.equal(sha256(f.files.get(target)), sha256(bytes));
    assertProgress(putProgress, size, mode);
    const staging = operations(f, 'move')[0].body.fromPath;
    assert.match(staging, /\.usshtc107-[0-9a-f-]+\.part$/i);
    assert.notEqual(staging, target);
    const stagedDownloads = operations(f, 'download').filter(item => item.query.path === staging);
    assert.equal(stagedDownloads.length, 1, 'upload reads back the complete staged object');
    const moveIndex = f.requests.indexOf(operations(f, 'move')[0]);
    assert.ok(f.requests.indexOf(stagedDownloads[0]) < moveIndex);
    const uploads = operations(f, 'upload');
    assert.equal(uploads.length, mode === 'multipart' ? Math.ceil(size / block) : 1);
    const acknowledged = putProgress.filter(item => item.phase === 'uploading' && item.bytes > 0).map(item => item.bytes);
    assert.deepEqual(acknowledged, mode === 'multipart'
      ? Array.from({ length: Math.ceil(size / block) }, (_, index) => Math.min((index + 1) * block, size)) : [size]);
    assert.ok(uploads.every(item => item.query.path !== target), 'final name is not streamed into');
    if (mode === 'multipart') {
      assert.equal(operations(f, 'mergeFileChunks')[0].body.sizeByte, size);
      assert.equal(uploads.at(-1).body.length, size % block);
      assert.ok(uploads.every(item => item.query.originPath === staging));
      assert.ok(uploads.every(item => !item.rawUrl.includes("'quoted' &")));
    }
    const getProgress = [];
    const get = await download({ ...options(f), remotePath: target, localPath: destination, onProgress: item => getProgress.push(item) });
    assert.equal(get.bytes, size);
    assert.equal(get.sha256, sha256(bytes));
    assert.equal(get.remoteTempsRetained, false);
    assert.equal(sha256(await fs.readFile(destination)), sha256(bytes));
    assert.equal(operations(f, 'download').filter(item => item.query.path === target).length, 3,
      'download independently hashes before, during and after the local copy');
    assertProgress(getProgress, size, get.mode);
    if (process.platform !== 'win32') assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
    await noParts(f.local);
    noRemoteCleanup(f);
  });
}

test('server-selected chunk size, including exact boundary and short last block, controls multipart framing', async t => {
  const f = await portalFixture(t, { chunkSizeByte: 37 });
  for (const size of [37, 38, 112]) {
    const source = path.join(f.local, `source-${size}`);
    await fs.writeFile(source, Buffer.alloc(size, size));
    const start = f.requests.length;
    const result = await upload({ ...options(f), localPath: source, remotePath: `/remote/file-${size}` });
    const chunks = f.requests.slice(start).filter(item => item.pathname.endsWith('/upload'));
    assert.equal(result.mode, 'multipart');
    assert.equal(chunks.length, Math.ceil(size / 37));
    assert.equal(chunks.at(-1).body.length, size % 37 || 37);
  }
});

test('init501 falls back once to ordinary multipart form upload, without retry or SSH', async t => {
  const f = await portalFixture(t, { init501: true });
  const bytes = crypto.randomBytes(2 * 1024 * 1024 + 1);
  const source = path.join(f.local, 'source');
  await fs.writeFile(source, bytes);
  const result = await upload({ ...options(f), localPath: source, remotePath: '/remote/fallback' });
  assert.equal(result.mode, 'single');
  assert.equal(result.sha256, sha256(bytes));
  assert.equal(operations(f, 'initMultipartUpload').length, 1);
  assert.equal(operations(f, 'upload').length, 1);
  assert.equal(operations(f, 'upload')[0].query.chunk, 'false');
  assert.equal(operations(f, 'mergeFileChunks').length, 0);
  assert.equal(operations(f, 'download').length, 1);
  assert.deepEqual(f.files.get('/remote/fallback'), bytes);
});

test('empty files use exact zero-byte hashes and round-trip without spurious chunks', async t => {
  const f = await portalFixture(t);
  const source = path.join(f.local, 'empty');
  const destination = path.join(f.local, 'returned');
  await fs.writeFile(source, Buffer.alloc(0));
  const put = await upload({ ...options(f), localPath: source, remotePath: '/remote/empty' });
  const get = await download({ ...options(f), localPath: destination, remotePath: '/remote/empty' });
  assert.equal(put.bytes, 0);
  assert.equal(get.bytes, 0);
  assert.equal(get.sha256, sha256(Buffer.alloc(0)));
  assert.equal((await fs.stat(destination)).size, 0);
  await noParts(f.local);
});

test('default no-overwrite preserves both remote and local targets; explicit overwrite publishes verified bytes', async t => {
  const f = await portalFixture(t);
  const source = path.join(f.local, 'source');
  const destination = path.join(f.local, 'destination');
  await fs.writeFile(source, 'replacement');
  await fs.writeFile(destination, 'local original');
  f.files.set('/remote/target', Buffer.from('remote original'));
  await assert.rejects(upload({ ...options(f), localPath: source, remotePath: '/remote/target' }), { code: 'TRANSFER_EXISTS' });
  assert.equal(f.files.get('/remote/target').toString(), 'remote original');
  assert.equal(operations(f, 'upload').length, 0);
  await assert.rejects(download({ ...options(f), localPath: destination, remotePath: '/remote/target' }), { code: 'TRANSFER_EXISTS' });
  assert.equal(await fs.readFile(destination, 'utf8'), 'local original');
  await upload({ ...options(f), localPath: source, remotePath: '/remote/target', overwrite: true });
  await download({ ...options(f), localPath: destination, remotePath: '/remote/target', overwrite: true });
  assert.equal(f.files.get('/remote/target').toString(), 'replacement');
  assert.equal(await fs.readFile(destination, 'utf8'), 'replacement');
  await noParts(f.local);
});

test('directories are never overwritten and directory downloads never invoke archive endpoints', async t => {
  const f = await portalFixture(t);
  const source = path.join(f.local, 'source');
  const directory = path.join(f.local, 'directory');
  await fs.writeFile(source, 'data');
  await fs.mkdir(directory);
  f.dirs.add('/remote/directory');
  f.files.set('/remote/file', Buffer.from('data'));
  for (const overwrite of [false, true]) {
    await assert.rejects(upload({ ...options(f), localPath: source, remotePath: '/remote/directory', overwrite }), error =>
      ['TRANSFER_EXISTS', 'TRANSFER_DIRECTORY'].includes(error.code));
    await assert.rejects(download({ ...options(f), localPath: directory, remotePath: '/remote/file', overwrite }), error =>
      ['TRANSFER_EXISTS', 'TRANSFER_DIRECTORY'].includes(error.code));
  }
  await assert.rejects(download({ ...options(f), localPath: path.join(f.local, 'archive'), remotePath: '/remote/directory' }), { code: 'TRANSFER_DIRECTORY' });
  assert.deepEqual(await fs.readdir(directory), []);
  assert.equal(operations(f, 'upload').length, 0);
  assert.equal(operations(f, 'download').length, 0);
});

test('upload and download enforce byte caps without publishing or leaving local parts', async t => {
  const f = await portalFixture(t);
  const source = path.join(f.local, 'source');
  await fs.writeFile(source, Buffer.alloc(4097));
  await assert.rejects(upload({ ...options(f), localPath: source, remotePath: '/remote/too-large', maxBytes: 4096 }), { code: 'TRANSFER_LIMIT' });
  assert.equal(f.requests.length, 0);
  f.files.set('/remote/source', Buffer.alloc(4097));
  await assert.rejects(download({ ...options(f), localPath: path.join(f.local, 'final'), remotePath: '/remote/source', maxBytes: 4096 }), error =>
    ['TRANSFER_LIMIT', 'PORTAL_QUOTA'].includes(error.code));
  assert.equal(f.files.has('/remote/too-large'), false);
  assert.deepEqual(await fs.readdir(f.local), ['source']);
  noPublish(f);
});

test('upload cancellation stops subsequent requests and retains acknowledged remote chunks', async t => {
  const f = await portalFixture(t, { chunkSizeByte: 32768 });
  const source = path.join(f.local, 'source');
  await fs.writeFile(source, crypto.randomBytes(100000));
  const controller = new AbortController();
  let requestsAtAbort;
  await assert.rejects(upload({ ...options(f), localPath: source, remotePath: '/remote/final', signal: controller.signal,
    onProgress(event) {
      if (event.phase === 'uploading' && event.bytes > 0 && !controller.signal.aborted) {
        requestsAtAbort = f.requests.length;
        controller.abort();
      }
    },
  }), error => error.code === 'PORTAL_CANCELLED' && error.remoteTempsRetained === true);
  assert.ok(controller.signal.aborted);
  assert.equal(f.requests.length, requestsAtAbort, 'no merge, verification, retry or cleanup after cancellation');
  assert.ok([...f.files.keys()].some(name => name.endsWith('.scowuploadtemp')));
  assert.equal(f.files.has('/remote/final'), false);
  noPublish(f);
  noRemoteCleanup(f);
});

test('download cancellation removes its 0600 partial and makes no further requests', async t => {
  const f = await portalFixture(t, { slowMs: 1, streamChunkBytes: 8192 });
  f.files.set('/remote/source', crypto.randomBytes(256 * 1024));
  const controller = new AbortController();
  let requestsAtAbort;
  await assert.rejects(download({ ...options(f), localPath: path.join(f.local, 'final'), remotePath: '/remote/source', signal: controller.signal,
    onProgress(event) {
      if (event.phase === 'downloading' && event.bytes > 0 && !controller.signal.aborted) {
        requestsAtAbort = f.requests.length;
        controller.abort();
      }
    },
  }), { code: 'PORTAL_CANCELLED' });
  assert.ok(controller.signal.aborted);
  assert.equal(f.requests.length, requestsAtAbort);
  assert.deepEqual(await fs.readdir(f.local), []);
});

test('already-aborted transfers do not issue HTTP requests or create partial files', async t => {
  const f = await portalFixture(t);
  const source = path.join(f.local, 'source');
  await fs.writeFile(source, 'data');
  const signal = AbortSignal.abort();
  await assert.rejects(upload({ ...options(f), localPath: source, remotePath: '/remote/final', signal }), { code: 'PORTAL_CANCELLED' });
  await assert.rejects(download({ ...options(f), localPath: path.join(f.local, 'returned'), remotePath: '/remote/source', signal }), { code: 'PORTAL_CANCELLED' });
  assert.equal(f.requests.length, 0);
  await noParts(f.local);
});

for (const occurrence of [2, 3]) {
  test(`remote same-size mutation during download pass ${occurrence} prevents local publication`, async t => {
    const f = await portalFixture(t, { beforeDownload({ fixture, occurrence: pass, query }) {
      if (pass === occurrence) fixture.files.set(query.path, Buffer.alloc(100000, 9));
    } });
    f.files.set('/remote/source', Buffer.alloc(100000, 7));
    await assert.rejects(download({ ...options(f), localPath: path.join(f.local, 'final'), remotePath: '/remote/source' }), error =>
      ['TRANSFER_HASH', 'TRANSFER_CHANGED'].includes(error.code));
    assert.deepEqual(await fs.readdir(f.local), []);
    noPublish(f);
  });
}

test('staged upload readback hash mismatch never moves corrupt data and reports retained remote temporaries', async t => {
  const f = await portalFixture(t, { beforeDownload({ fixture, query }) {
    const bytes = fixture.files.get(query.path);
    fixture.files.set(query.path, Buffer.alloc(bytes.length, 99));
  } });
  const source = path.join(f.local, 'source');
  await fs.writeFile(source, Buffer.alloc(4096, 7));
  await assert.rejects(upload({ ...options(f), localPath: source, remotePath: '/remote/final' }), error =>
    error.code === 'TRANSFER_HASH' && error.remoteTempsRetained === true);
  assert.equal(f.files.has('/remote/final'), false);
  assert.ok([...f.files.keys()].some(name => name.endsWith('.part')));
  noPublish(f);
  noRemoteCleanup(f);
});

test('local source mutation between multipart blocks does not publish a mixed upload', async t => {
  let changed = false;
  let source;
  const f = await portalFixture(t, { chunkSizeByte: 32768, async afterUpload({ query }) {
    if (!changed && query.chunk === 'true') {
      changed = true;
      await fs.writeFile(source, Buffer.alloc(100000, 9));
    }
  } });
  source = path.join(f.local, 'source');
  await fs.writeFile(source, Buffer.alloc(100000, 7));
  await assert.rejects(upload({ ...options(f), localPath: source, remotePath: '/remote/final' }), error =>
    ['TRANSFER_CHANGED', 'TRANSFER_HASH'].includes(error.code) && error.remoteTempsRetained === true);
  assert.ok(changed);
  assert.equal(f.files.has('/remote/final'), false);
  noPublish(f);
  noRemoteCleanup(f);
});

test('no-overwrite rechecks remote destination after verification, without claiming atomic server no-clobber', async t => {
  const f = await portalFixture(t, { beforeDownload({ fixture }) {
    fixture.files.set('/remote/raced', Buffer.from('racer'));
  } });
  const source = path.join(f.local, 'source');
  await fs.writeFile(source, 'payload');
  await assert.rejects(upload({ ...options(f), localPath: source, remotePath: '/remote/raced' }), { code: 'TRANSFER_EXISTS' });
  assert.equal(f.files.get('/remote/raced').toString(), 'racer');
  noPublish(f);
});

test('local no-overwrite link publication preserves a target raced into existence during final verification', async t => {
  let destination;
  const f = await portalFixture(t, { async beforeDownload({ occurrence }) {
    if (occurrence === 3) await fs.writeFile(destination, 'racer', { flag: 'wx' });
  } });
  destination = path.join(f.local, 'raced');
  f.files.set('/remote/source', Buffer.from('payload'));
  await assert.rejects(download({ ...options(f), remotePath: '/remote/source', localPath: destination }), { code: 'TRANSFER_EXISTS' });
  assert.equal(await fs.readFile(destination, 'utf8'), 'racer');
  assert.deepEqual(await fs.readdir(f.local), ['raced']);
});

for (const occurrence of [1, 2, 3]) {
  test(`dropped HTTPS download pass ${occurrence} is not retried and leaves no local part`, async t => {
    const f = await portalFixture(t, { dropDownloadAt: occurrence });
    f.files.set('/remote/source', crypto.randomBytes(128 * 1024));
    await assert.rejects(download({ ...options(f), remotePath: '/remote/source', localPath: path.join(f.local, 'final') }), { code: 'PORTAL_NETWORK' });
    assert.equal(operations(f, 'download').length, occurrence);
    assert.deepEqual(await fs.readdir(f.local), []);
  });
}

test('slow HTTPS stream obeys total deadline and removes local parts without retry', async t => {
  const f = await portalFixture(t, { slowMs: 200, streamChunkBytes: 1024 });
  f.files.set('/remote/source', Buffer.alloc(8192));
  await assert.rejects(download({ ...options(f), remotePath: '/remote/source', localPath: path.join(f.local, 'final'), timeoutMs: 80 }), { code: 'PORTAL_TIMEOUT' });
  assert.ok(operations(f, 'download').length <= 1);
  assert.deepEqual(await fs.readdir(f.local), []);
});

test('mid-upload authentication expiry stops immediately and exposes only fixed code plus retention state', async t => {
  const f = await portalFixture(t, { chunkSizeByte: 32768, authAfterRequest: 3 });
  const source = path.join(f.local, 'source');
  await fs.writeFile(source, crypto.randomBytes(100000));
  await assert.rejects(upload({ ...options(f), localPath: source, remotePath: '/remote/final' }), error => {
    assert.equal(error.code, 'PORTAL_AUTH');
    assert.equal(typeof error.remoteTempsRetained, 'boolean');
    assert.equal(String(error).includes('fixture-token'), false);
    return true;
  });
  assert.equal(f.requests.length, 4);
  assert.equal(f.files.has('/remote/final'), false);
  noPublish(f);
  noRemoteCleanup(f);
});

test('403 PERMISSION_DENIED remains a permission failure, never an auth failure or fallback', async t => {
  const f = await portalFixture(t, { permission: ctx => ctx.pathname.endsWith('/initMultipartUpload') });
  const source = path.join(f.local, 'source');
  await fs.writeFile(source, 'data');
  await assert.rejects(upload({ ...options(f), localPath: source, remotePath: '/remote/final' }), { code: 'PORTAL_PERMISSION' });
  assert.equal(operations(f, 'initMultipartUpload').length, 1);
  assert.equal(operations(f, 'upload').length, 0);
  noPublish(f);
});

test('unsafe local and remote paths fail with fixed codes before any HTTP request', async t => {
  const f = await portalFixture(t);
  const source = path.join(f.local, 'source');
  await fs.writeFile(source, 'data');
  for (const candidate of ['', 'bad\0name', 'bad\nname', 'bad\rname', 'a'.repeat(4097)]) {
    assert.throws(() => remotePath(candidate), { code: 'TRANSFER_PATH' });
    assert.throws(() => localPath(candidate), { code: 'TRANSFER_PATH' });
    await assert.rejects(upload({ ...options(f), localPath: source, remotePath: candidate }), { code: 'TRANSFER_PATH' });
    await assert.rejects(download({ ...options(f), localPath: candidate, remotePath: '/remote/source' }), { code: 'TRANSFER_PATH' });
  }
  assert.equal(f.requests.length, 0);
  const literal = "/remote/-' ; $(whoami) & +?#%";
  assert.equal(remotePath(literal), literal);
});

test('default local no-overwrite protects dangling symlinks without creating their target', { skip: process.platform === 'win32' }, async t => {
  const f = await portalFixture(t);
  const destination = path.join(f.local, 'dangling');
  await fs.symlink('missing', destination);
  f.files.set('/remote/source', Buffer.from('data'));
  await assert.rejects(download({ ...options(f), localPath: destination, remotePath: '/remote/source' }), { code: 'TRANSFER_EXISTS' });
  assert.equal(await fs.readlink(destination), 'missing');
  await assert.rejects(fs.stat(path.join(f.local, 'missing')), { code: 'ENOENT' });
  await noParts(f.local);
});

test('dropped chunk upload is not retried, merged, published or remotely cleaned up', async t => {
  let uploadRequests = 0;
  const f = await portalFixture(t, { chunkSizeByte: 32768, beforeRequest({ pathname, request }) {
    if (pathname.endsWith('/upload') && ++uploadRequests === 2) request.socket.destroy();
  } });
  const source = path.join(f.local, 'source');
  await fs.writeFile(source, crypto.randomBytes(100000));
  await assert.rejects(upload({ ...options(f), localPath: source, remotePath: '/remote/final' }), error =>
    error.code === 'PORTAL_NETWORK' && error.remoteTempsRetained === true);
  assert.equal(uploadRequests, 2);
  assert.equal(operations(f, 'mergeFileChunks').length, 0);
  assert.ok([...f.files.keys()].some(name => name.endsWith('.scowuploadtemp')));
  assert.equal(f.files.has('/remote/final'), false);
  noPublish(f);
  noRemoteCleanup(f);
});

test('nonempty server filesInfo is a retained-temp conflict, never an invitation to resume unknown chunks', async t => {
  const f = await portalFixture(t, { filesInfo: [{ name: `${'a'.repeat(64)}_1.scowuploadtemp`,
    type: 'FILE', mtime: '2026-01-01T00:00:00Z', mode: 0o600, size: 17 }] });
  const source = path.join(f.local, 'source');
  await fs.writeFile(source, 'data');
  await assert.rejects(upload({ ...options(f), localPath: source, remotePath: '/remote/final' }), error =>
    error.code === 'TRANSFER_TEMP_CONFLICT' && error.remoteTempsRetained === true);
  assert.equal(operations(f, 'initMultipartUpload').length, 1);
  assert.equal(operations(f, 'upload').length, 0);
  assert.equal(operations(f, 'mergeFileChunks').length, 0);
  noPublish(f);
  noRemoteCleanup(f);
});

test('remote absolute-path validation rejects traversal, relative names, backslashes and directory roots', async t => {
  const f = await portalFixture(t);
  const source = path.join(f.local, 'source');
  await fs.writeFile(source, 'data');
  for (const candidate of ['relative', '/remote/../target', '/remote\\target', '/', '/remote/directory/']) {
    assert.throws(() => remotePath(candidate), { code: 'TRANSFER_PATH' });
    await assert.rejects(upload({ ...options(f), localPath: source, remotePath: candidate }), { code: 'TRANSFER_PATH' });
  }
  assert.equal(f.requests.length, 0);
});

test('download creates a private 0600 local part before receiving payload and removes it after publication', async t => {
  let observed = false;
  const f = await portalFixture(t, { async beforeDownload({ fixture, occurrence }) {
    if (occurrence !== 2) return;
    const names = await fs.readdir(fixture.local);
    assert.equal(names.length, 1);
    assert.match(names[0], /^\.usshtc107-[0-9a-f-]+\.part$/i);
    const stat = await fs.stat(path.join(fixture.local, names[0]));
    assert.equal(stat.size, 0);
    if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
    observed = true;
  } });
  f.files.set('/remote/source', Buffer.from('verified bytes'));
  await download({ ...options(f), remotePath: '/remote/source', localPath: path.join(f.local, 'final') });
  assert.ok(observed);
  assert.deepEqual(await fs.readdir(f.local), ['final']);
});
