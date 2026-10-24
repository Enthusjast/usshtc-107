'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createFileApi } = require('../../electron/portal-api/file-api');

const cluster = 'cluster-1';
const target = "/remote/quoted ' & +?#%/file.bin";
async function collect(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
const info = { name: 'file.bin', type: 'FILE', mtime: '2026-10-24T00:00:00Z', mode: 0o600, size: 17 };

function fakeClient(responses = {}) {
  const calls = [];
  const client = Object.fromEntries(['json', 'empty', 'stream'].map(mode => [mode, async (path, options) => {
    calls.push({ mode, path, options });
    return typeof responses[path] === 'function' ? responses[path](options) : responses[path];
  }]));
  return { client, calls, api: createFileApi({ client }) };
}
function expectedStatus(value, status) {
  assert.deepEqual(value, [status], 'shared client expectedStatus contract is an array');
}

test('file download forwards exact encoded-query inputs and streaming lifetime controls', async () => {
  const body = Readable.from([Buffer.from('binary')]);
  const cancel = () => {};
  const response = { body, contentLength: 6, cancel };
  const { api, calls } = fakeClient({ '/api/file/download': response });
  const signal = new AbortController().signal;
  const scope = { profileId: 'profile', epoch: 4 };
  const assertCurrent = () => {};
  const result = await api.download({ cluster, path: target, signal, scope, assertCurrent, maxBytes: 1234, timeoutMs: 5678 });
  assert.equal(result, response);
  assert.equal(calls[0].mode, 'stream');
  assert.equal(calls[0].path, '/api/file/download');
  assert.deepEqual(calls[0].options.query, { cluster, path: target, download: true });
  assert.equal(calls[0].options.signal, signal);
  assert.equal(calls[0].options.scope, scope);
  assert.equal(calls[0].options.assertCurrent, assertCurrent);
  assert.equal(calls[0].options.maxBytes, 1234);
  assert.equal(calls[0].options.timeoutMs, 5678);
  expectedStatus(calls[0].options.expectedStatus, 200);
  assert.equal((await collect(result.body)).toString(), 'binary');
});

for (const chunk of [false, true]) {
  test(`file upload uses one streaming binary multipart part; chunk=${chunk} metadata stays in query`, async () => {
    const bytes = Buffer.from([0, 255, 128, 13, 10, 34, 0, 1, 2]);
    let frame;
    const { api, calls } = fakeClient({ '/api/file/upload': async options => { frame = await collect(options.body); } });
    const signal = new AbortController().signal;
    const originPath = chunk ? target : '';
    const source = Readable.from([bytes.subarray(0, 3), bytes.subarray(3)]);
    await api.upload({ cluster, path: '/temporary/encoded & +?#%/chunk', source, size: bytes.length,
      chunk, originPath, signal, maxBytes: 1000, timeoutMs: 2000 });
    const call = calls[0];
    assert.equal(call.mode, 'empty');
    assert.equal(call.path, '/api/file/upload');
    assert.equal(call.options.method, 'POST');
    expectedStatus(call.options.expectedStatus, 204);
    assert.deepEqual(call.options.query, { cluster, path: '/temporary/encoded & +?#%/chunk', chunk, originPath });
    assert.equal(call.options.signal, signal);
    assert.equal(call.options.maxBytes, 1000);
    assert.equal(call.options.timeoutMs, 2000);
    const headers = Object.fromEntries(Object.entries(call.options.headers).map(([name, value]) => [name.toLowerCase(), value]));
    assert.match(headers['content-type'], /^multipart\/form-data; boundary=[A-Za-z0-9-]+$/);
    assert.equal(Number(headers['content-length']), frame.length);
    const boundary = headers['content-type'].split('boundary=')[1];
    const prefix = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="file"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    assert.deepEqual(frame, Buffer.concat([prefix, bytes, suffix]));
    assert.equal(frame.includes(Buffer.from('name="chunk"')), false);
    assert.equal(frame.includes(Buffer.from('name="originPath"')), false);
    assert.equal(frame.includes(Buffer.from('base64')), false);
    assert.equal(source.destroyed, true);
  });
}

test('zero-byte upload still emits a valid bounded multipart frame without a local filename', async () => {
  let frame;
  const { api, calls } = fakeClient({ '/api/file/upload': async options => { frame = await collect(options.body); } });
  await api.upload({ cluster, path: target, source: Readable.from([]), size: 0 });
  assert.equal(Number(calls[0].options.headers['Content-Length']), frame.length);
  assert.match(frame.toString(), /filename="file"/);
  assert.equal(frame.includes(Buffer.from(target)), false);
  assert.deepEqual(calls[0].options.query, { cluster, path: target, chunk: false, originPath: '' });
});

test('upload rejects source-length mismatches while consuming the stream and always closes the source', async () => {
  for (const size of [2, 4]) {
    const source = Readable.from([Buffer.from('abc')]);
    const { api } = fakeClient({ '/api/file/upload': async options => collect(options.body) });
    await assert.rejects(api.upload({ cluster, path: target, source, size }), { code: 'TRANSFER_METADATA' });
    assert.equal(source.destroyed, true);
  }
});

test('upload propagates an operational failure unchanged and closes its source without retry', async () => {
  const failure = Object.assign(new Error('PORTAL_PERMISSION'), { code: 'PORTAL_PERMISSION' });
  const source = Readable.from([Buffer.from('abc')]);
  const { api, calls } = fakeClient({ '/api/file/upload': () => { throw failure; } });
  await assert.rejects(api.upload({ cluster, path: target, source, size: 3 }), error => error === failure);
  assert.equal(calls.length, 1);
  assert.equal(source.destroyed, true);
});

test('init and merge use official JSON schemas, server-selected size and original total byte count', async () => {
  const initialized = { tempFileDir: '/tmp/server selected & +?#%', chunkSizeByte: 37, filesInfo: [info], internal: 'discard' };
  const { api, calls } = fakeClient({ '/api/file/initMultipartUpload': initialized });
  const signal = new AbortController().signal;
  const init = await api.initMultipartUpload({ cluster, path: '/remote', name: 'destination.bin', signal });
  assert.deepEqual(init, { tempFileDir: initialized.tempFileDir, chunkSizeByte: 37, filesInfo: [info] });
  assert.equal(calls[0].path, '/api/file/initMultipartUpload');
  assert.equal(calls[0].mode, 'json');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.signal, signal);
  assert.deepEqual(calls[0].options.body, { cluster, path: '/remote', name: 'destination.bin' });
  expectedStatus(calls[0].options.expectedStatus, 200);
  await api.mergeFileChunks({ cluster, path: '/remote', name: 'destination.bin', sizeByte: 112, signal });
  assert.equal(calls[1].path, '/api/file/mergeFileChunks');
  assert.equal(calls[1].mode, 'empty');
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(calls[1].options.body, { cluster, path: '/remote', name: 'destination.bin', sizeByte: 112 });
  expectedStatus(calls[1].options.expectedStatus, 204);
});

test('existence/type/list unwrap only official response envelopes and listing never touches access times', async () => {
  const { api, calls } = fakeClient({
    '/api/file/fileExist': { result: false },
    '/api/file/getFileType': { type: 'FILE' },
    '/api/file/list': { items: [{ ...info, backendPath: '/private/path', password: 'discard' },
      { ...info, name: 'directory', type: 'DIR', size: 0 }] },
  });
  assert.equal(await api.fileExist({ cluster, path: target }), false);
  assert.equal(await api.getFileType({ cluster, path: target }), 'FILE');
  assert.deepEqual(await api.list({ cluster, path: '/remote' }), [info, { ...info, name: 'directory', type: 'DIR', size: 0 }]);
  for (const call of calls) {
    assert.equal(call.mode, 'json');
    expectedStatus(call.options.expectedStatus, 200);
  }
  assert.deepEqual(calls[0].options.query, { cluster, path: target });
  assert.deepEqual(calls[1].options.query, { cluster, path: target });
  assert.deepEqual(calls[2].options.query, { cluster, path: '/remote', updateAccessTime: false });
});

test('publication uses PATCH move with only cluster/fromPath/toPath and no deletion or overwrite flag', async () => {
  const { api, calls } = fakeClient();
  const scope = { profileId: 'p', epoch: 1 };
  const assertCurrent = () => {};
  await api.move({ cluster, fromPath: '/remote/.usshtc107-fixture.part', toPath: target, scope, assertCurrent });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, 'empty');
  assert.equal(calls[0].path, '/api/file/move');
  assert.equal(calls[0].options.method, 'PATCH');
  assert.equal(calls[0].options.scope, scope);
  assert.equal(calls[0].options.assertCurrent, assertCurrent);
  assert.deepEqual(calls[0].options.body, { cluster, fromPath: '/remote/.usshtc107-fixture.part', toPath: target });
  expectedStatus(calls[0].options.expectedStatus, 204);
});

for (const { method, endpoint, responses } of [
  { method: 'fileExist', endpoint: 'fileExist', responses: [null, true, {}, { result: 'true' }, { result: 1 }] },
  { method: 'getFileType', endpoint: 'getFileType', responses: [null, 'FILE', {}, { type: 1 }] },
  { method: 'list', endpoint: 'list', responses: [null, [], {}, { items: null }, { items: [null] },
    { items: [{ ...info, type: 'SYMLINK' }] }, { items: [{ ...info, size: -1 }] },
    { items: [{ ...info, size: 1.5 }] }, { items: [{ ...info, mtime: 1 }] }, { items: [{ ...info, mode: NaN }] }] },
  { method: 'initMultipartUpload', endpoint: 'initMultipartUpload', responses: [null, {},
    { tempFileDir: 'relative', chunkSizeByte: 37, filesInfo: [] },
    { tempFileDir: '/tmp/files', chunkSizeByte: 0, filesInfo: [] },
    { tempFileDir: '/tmp/files', chunkSizeByte: 1.5, filesInfo: [] },
    { tempFileDir: '/tmp/files', chunkSizeByte: 37, filesInfo: {} }] },
]) {
  test(`${method} rejects malformed official response envelopes with fixed metadata errors`, async () => {
    for (const response of responses) {
      const { api, calls } = fakeClient({ [`/api/file/${endpoint}`]: response });
      await assert.rejects(async () => api[method]({ cluster, path: target, name: 'file.bin' }), { code: 'TRANSFER_METADATA' });
      assert.equal(calls.length, 1, 'invalid schema never selects another endpoint');
    }
  });
}

test('invalid upload parameters and merge sizes fail before sending a request', async () => {
  const { api, calls } = fakeClient();
  for (const parameters of [
    { source: null, size: 0 }, { source: Buffer.from('abc'), size: 3 },
    { source: Readable.from([]), size: -1 }, { source: Readable.from([]), size: 1.5 },
    { source: Readable.from([]), size: 0, chunk: 'true' }, { source: Readable.from([]), size: 0, originPath: null },
  ]) await assert.rejects(api.upload({ cluster, path: target, ...parameters }), { code: 'TRANSFER_METADATA' });
  for (const sizeByte of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(async () => api.mergeFileChunks({ cluster, path: '/remote', name: 'file', sizeByte }), { code: 'TRANSFER_METADATA' });
  }
  assert.equal(calls.length, 0);
});
