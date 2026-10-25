'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { createFileTransferController, MAX_QUEUED, MAX_HISTORY } = require('../../electron/file-transfer/controller');
const flush = () => new Promise(resolve => setImmediate(resolve));
const localDirectory = path.join(os.tmpdir(), 'usshtc107-native', 'private');
const uploadPath = path.join(localDirectory, 'upload.bin');
const downloadPath = path.join(localDirectory, 'download.bin');
function harness(t, overrides = {}) {
  const state = { scope: { profileId: 'primary', epoch: 1 }, authGeneration: 1,
    cookie: 'SCOW_USER=private-test-token', cluster: 'cluster' };
  const snapshots = [];
  const calls = [];
  const clients = [];
  const native = [];
  const dialog = {
    async showOpenDialog(window, options) { native.push({ kind: 'open', options }); return { canceled: false, filePaths: [uploadPath] }; },
    async showSaveDialog(window, options) { native.push({ kind: 'save', options }); return { canceled: false, filePath: downloadPath }; },
    async showMessageBox(window, options) { native.push({ kind: 'confirm', options }); return { response: 1 }; },
    ...overrides.dialog,
  };
  function transfer(options) {
    return new Promise((resolve, reject) => {
      const call = { options, resolve, reject };
      calls.push(call);
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('private upstream details'), { code: 'PORTAL_CANCELLED', remoteTempsRetained: true })), { once: true });
    });
  }
  const controller = createFileTransferController({ getContext: () => state, getWindow: () => ({}), dialog,
    onState: value => snapshots.push(value),
    getLocale: overrides.getLocale,
    createClient() { const client = { disposed: false, dispose() { this.disposed = true; } }; clients.push(client); return client; },
    transfers: overrides.transfers || { upload: transfer, download: transfer },
  });
  t.after(() => controller.dispose());
  const request = (direction = 'upload', extra = {}) => ({ scope: { ...state.scope }, direction, remotePath: '/remote/file.bin', ...extra });
  return { state, snapshots, calls, clients, native, dialog, controller, request };
}
function completed(call, extra = {}) { call.resolve({ bytes: 3, sha256: 'a'.repeat(64), mode: 'single', remoteTempsRetained: false, ...extra }); }

test('native-only selection keeps cookie, local and remote paths outside safe transfer snapshots', async t => {
  const h = harness(t);
  const result = await h.controller.start(h.request());
  assert.equal(result.items[0].filename, 'upload.bin');
  assert.equal(result.transferId, result.items[0].id);
  assert.equal(h.calls[0].options.localPath, uploadPath);
  assert.equal(h.calls[0].options.remotePath, '/remote/file.bin');
  assert.equal(h.native[0].kind, 'open');
  h.calls[0].options.onProgress({ bytes: 2, total: 3, phase: 'uploading', mode: 'single' });
  h.calls[0].options.onProgress({ bytes: 1, total: 3, phase: 'uploading', mode: 'single' });
  assert.equal(h.controller.list({ scope: h.state.scope }).items[0].bytes, 2);
  completed(h.calls[0]);
  await flush();
  const item = h.controller.list({ scope: h.state.scope }).items[0];
  assert.equal(item.status, 'completed');
  assert.equal(item.bytes, 3);
  assert.equal(h.clients[0].disposed, true);
  const safe = JSON.stringify(h.snapshots);
  assert.doesNotMatch(safe, /private-test-token|SCOW_USER|usshtc107-native|\/remote\//);
  for (const privatePath of [localDirectory, uploadPath, downloadPath]) {
    assert.equal(safe.includes(JSON.stringify(privatePath).slice(1, -1)), false);
  }
  assert.deepEqual(Object.keys(item).sort(), ['bytes', 'direction', 'filename', 'id', 'mode', 'phase', 'remoteTempsRetained', 'status', 'total']);
});

test('controller rejects arbitrary renderer local paths, cookies and unsafe remote paths', async t => {
  const h = harness(t);
  for (const extra of [{ localPath: uploadPath }, { cookie: 'bad' }, { filePaths: [uploadPath] }]) {
    await assert.rejects(h.controller.start(h.request('upload', extra)), { code: 'INVALID_ARGUMENT' });
  }
  for (const remotePath of ['relative', '/root/../target', '/root/..\\target', '/root/']) {
    await assert.rejects(h.controller.start(h.request('upload', { remotePath })), { code: 'TRANSFER_PATH' });
  }
  assert.equal(h.native.length, 0);
  assert.throws(() => h.controller.list({ scope: { ...h.state.scope, cookie: 'bad' } }), { code: 'INVALID_ARGUMENT' });
});

test('two inflight cap, queued cancellation and bounded queue are enforced', async t => {
  const h = harness(t);
  const first = await h.controller.start(h.request());
  await h.controller.start(h.request('download'));
  const queued = await h.controller.start(h.request());
  assert.equal(h.calls.length, 2);
  assert.equal(queued.items.find(item => item.id === queued.transferId).status, 'queued');
  h.controller.cancel({ scope: h.state.scope, id: queued.transferId });
  completed(h.calls[0]);
  await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.controller.list({ scope: h.state.scope }).items.find(item => item.id === queued.transferId).status, 'cancelled');
  assert.equal(first.items[0].status, 'running');
  // One existing active slot plus one new active job, then exactly MAX_QUEUED waiting.
  await h.controller.start(h.request());
  for (let i = 0; i < MAX_QUEUED; i++) await h.controller.start(h.request());
  await assert.rejects(h.controller.start(h.request()), { code: 'OPERATION_IN_PROGRESS' });
  assert.equal(h.calls.length, 3);
});

test('cancelling running work aborts, retains truthful temporary warning and never starts another request', async t => {
  const h = harness(t);
  const result = await h.controller.start(h.request());
  h.calls[0].options.onProgress({ bytes: 1, total: 3, phase: 'uploading', mode: 'multipart' });
  h.controller.cancel({ scope: h.state.scope, id: result.transferId });
  await flush();
  const item = h.controller.list({ scope: h.state.scope }).items[0];
  assert.equal(item.status, 'cancelled');
  assert.equal(item.remoteTempsRetained, true);
  assert.equal(h.calls[0].options.signal.aborted, true);
  assert.equal(h.calls.length, 1);
});

test('upload and download overwrite both require native destructive confirmation', async t => {
  const h = harness(t);
  const upload = await h.controller.start(h.request('upload', { overwrite: true }));
  assert.equal(h.native[1].kind, 'confirm');
  assert.equal(h.native[1].options.defaultId, 0);
  assert.equal(h.calls[0].options.overwrite, true);
  assert.ok(upload.transferId);
  const download = await h.controller.start(h.request('download', { overwrite: true }));
  assert.equal(h.native[2].kind, 'save');
  assert.equal(h.native[2].options.defaultPath, 'file.bin');
  assert.equal(h.native[3].kind, 'confirm');
  assert.ok(download.transferId);
  const denied = harness(t, { dialog: { async showMessageBox() { return { response: 0 }; } } });
  assert.equal((await denied.controller.start(denied.request('upload', { overwrite: true }))).cancelled, true);
  assert.equal(denied.calls.length, 0);
});

test('native file and overwrite dialogs use the requested locale with English fallback', async t => {
  for (const locale of ['zh', 'en', 'unsupported']) {
    const h = harness(t, { getLocale: () => locale });
    await h.controller.start(h.request('upload', { overwrite: true }));
    await h.controller.start(h.request('download', { overwrite: true }));
    const chinese = locale === 'zh';
    assert.equal(h.native[0].options.title, chinese ? '上传文件' : 'Upload file');
    assert.equal(h.native[2].options.title, chinese ? '下载文件' : 'Download file');
    for (const entry of [h.native[1], h.native[3]]) {
      assert.equal(entry.options.title, chinese ? '替换现有文件？' : 'Replace existing file?');
      assert.equal(entry.options.message, chinese ? '允许此次传输替换现有的普通文件吗？' : 'Allow this transfer to replace an existing regular file?');
      assert.match(entry.options.detail, chinese ? /并非原子/ : /not an atomic/);
      assert.deepEqual(entry.options.buttons, chinese ? ['取消', '替换文件'] : ['Cancel', 'Replace file']);
      assert.equal(entry.options.defaultId, 0);
      assert.equal(entry.options.cancelId, 0);
    }
  }
});

test('native dialog cancellation and stale native results do not enqueue work', async t => {
  const h = harness(t, { dialog: { async showOpenDialog() { return { canceled: true }; } } });
  assert.equal((await h.controller.start(h.request())).cancelled, true);
  assert.equal(h.calls.length, 0);
  let finish;
  h.dialog.showOpenDialog = () => new Promise(resolve => { finish = resolve; });
  const pending = h.controller.start(h.request());
  h.state.authGeneration++;
  h.controller.update();
  finish({ canceled: false, filePaths: [uploadPath] });
  await assert.rejects(pending, { code: 'PROFILE_CHANGED' });
  assert.equal(h.calls.length, 0);
});

test('scope or credential rotation clears old jobs and prevents stale state export', async t => {
  const h = harness(t);
  await h.controller.start(h.request());
  const oldProgress = h.calls[0].options.onProgress;
  h.state.scope = { profileId: 'next', epoch: 2 };
  h.controller.update();
  await flush();
  oldProgress({ bytes: 3, total: 3, phase: 'completed', mode: 'single' });
  assert.deepEqual(h.controller.list({ scope: h.state.scope }).items, []);
  assert.equal(h.calls[0].options.signal.aborted, true);
  const last = h.snapshots.at(-1);
  assert.equal(last.profileId, 'next');
  assert.deepEqual(last.items, []);
});

test('midtransfer authentication is a fixed safe error and never deletes the credential', async t => {
  const h = harness(t);
  await h.controller.start(h.request());
  h.calls[0].reject(Object.assign(new Error('secret raw Cookie and upstream URL'), { code: 'PORTAL_AUTH', remoteTempsRetained: true }));
  await flush();
  const item = h.controller.list({ scope: h.state.scope }).items[0];
  assert.equal(item.errorCode, 'PORTAL_AUTH');
  assert.equal(item.status, 'failed');
  assert.equal(h.state.cookie, 'SCOW_USER=private-test-token');
  assert.doesNotMatch(JSON.stringify(h.snapshots), /secret raw|Cookie|upstream URL/);
});

test('completed transfer history is bounded and disposal aborts remaining work', async t => {
  const h = harness(t, { transfers: { async upload() { return { bytes: 0, mode: 'single', remoteTempsRetained: false }; } } });
  for (let i = 0; i < MAX_HISTORY + 5; i++) { await h.controller.start(h.request()); await flush(); }
  assert.equal(h.controller.list({ scope: h.state.scope }).items.length, MAX_HISTORY);
  h.controller.dispose();
  assert.throws(() => h.controller.list({ scope: h.state.scope }), { code: 'PORTAL_CANCELLED' });
});
