'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Duplex, PassThrough, Readable } = require('node:stream');
const { startScpSession } = require('../../electron/scp/session');
const { ScpProtocolReader, ScpProtocolWriter } = require('../../electron/scp/protocol');

const MTIME = '2020-01-02T03:04:05.000Z';
const deferred = () => {
  let resolve;
  const promise = new Promise(ready => { resolve = ready; });
  return { promise, resolve };
};

function memoryApi() {
  const nodes = new Map([
    ['/', { type: 'DIR', mode: 0o040700, mtime: MTIME, size: 0 }],
    ['/remote', { type: 'DIR', mode: 0o040700, mtime: MTIME, size: 0 }],
  ]);
  const calls = [];
  const addDirectory = remotePath => nodes.set(remotePath, { type: 'DIR', mode: 0o040755, mtime: MTIME, size: 0 });
  const addFile = (remotePath, data, mode = 0o100640) => {
    const body = Buffer.from(data);
    nodes.set(remotePath, { type: 'FILE', mode, mtime: MTIME, size: body.length, body });
  };
  const api = {
    async getHome(input) { calls.push(['getHome', input]); return '/remote'; },
    async list(input) {
      calls.push(['list', input]);
      assert.equal(nodes.get(input.path)?.type, 'DIR');
      return [...nodes].filter(([name]) => name !== '/' && path.posix.dirname(name) === input.path)
        .map(([name, entry]) => ({ name: path.posix.basename(name), type: entry.type, mode: entry.mode, mtime: entry.mtime, size: entry.size }));
    },
    async mkdir(input) { calls.push(['mkdir', input]); addDirectory(input.path); },
    async initMultipartUpload(input) {
      calls.push(['initMultipartUpload', input]);
      throw Object.assign(new Error('not implemented'), { code: 'PORTAL_UNIMPLEMENTED' });
    },
    async upload(input) {
      calls.push(['upload', input]);
      const chunks = [];
      for await (const block of input.source) chunks.push(block);
      const data = Buffer.concat(chunks);
      assert.equal(data.length, input.size);
      addFile(input.path, data);
    },
    async download(input) {
      calls.push(['download', input]);
      const entry = nodes.get(input.path);
      assert.ok(entry?.body);
      const body = Readable.from([entry.body], { objectMode: false });
      return { body, contentLength: entry.body.length, cancel() { body.destroy(); } };
    },
    async move(input) {
      calls.push(['move', input]);
      nodes.set(input.toPath, nodes.get(input.fromPath));
      nodes.delete(input.fromPath);
    },
  };
  return { api, calls, nodes, addDirectory, addFile };
}

async function fixture(t, command, overrides = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'usshtc-scp-session-test-'));
  const incoming = new PassThrough({ highWaterMark: 64 * 1024 });
  const outgoing = new PassThrough({ highWaterMark: 64 * 1024 });
  const channel = Duplex.from({ readable: incoming, writable: outgoing });
  const peer = Duplex.from({ readable: outgoing, writable: incoming });
  // Duplex.from may asynchronously abort its opposite half during destroy.
  // Keep transport error listeners after protocol listeners are removed.
  channel.on('error', () => {});
  peer.on('error', () => {});
  const state = memoryApi();
  const reader = new ScpProtocolReader(peer, { timeoutMs: 2000 });
  const writer = new ScpProtocolWriter(peer, { timeoutMs: 2000 });
  const traffic = [];
  const session = startScpSession({ channel, command, api: state.api, cluster: 'cluster', tempDirectory: temporary,
    maxFileBytes: 1024 * 1024, onTraffic: update => traffic.push(update), ...overrides });
  t.after(async () => {
    session.close('app_exit');
    await session.done;
    reader.close();
    writer.close();
    channel.destroy();
    peer.destroy();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  return { ...state, session, reader, writer, peer, channel, incoming, temporary, traffic };
}

test('source expands directory segments relative to API home and preserves observed mtime/mode', async t => {
  const f = await fixture(t, 'scp -pf sets/*/x.[a-z][a-z][a-z]');
  f.addDirectory('/remote/sets');
  f.addDirectory('/remote/sets/one');
  f.addFile('/remote/sets/one/x.txt', 'hello', 0o106640);
  await f.writer.writeAck();
  const time = await f.reader.readRecord();
  assert.equal(time.type, 'T');
  assert.equal(time.mtime, Date.parse(MTIME) / 1000);
  assert.equal(time.atime, time.mtime);
  await f.writer.writeAck();
  assert.deepEqual(await f.reader.readRecord(), { type: 'C', name: 'x.txt', mode: 0o640, size: 5 });
  await f.writer.writeAck();
  const chunks = [];
  await f.reader.readPayload(5, chunk => chunks.push(Buffer.from(chunk)));
  assert.equal(Buffer.concat(chunks).toString(), 'hello');
  await f.reader.readAck();
  await f.writer.writeAck();
  assert.deepEqual(await f.session.done, { exitCode: 0, reason: 'completed', remoteTempsRetained: false });
  assert.ok(f.calls.some(([method]) => method === 'getHome'));
  assert.equal(f.traffic.reduce((sum, update) => sum + update.sent, 0), 0);
  assert.equal(f.traffic.reduce((sum, update) => sum + update.received, 0), 5);
});

test('quoted source glob characters select the exact literal name', async t => {
  const f = await fixture(t, "scp -f '/remote/*.txt'");
  f.addFile('/remote/*.txt', 'literal');
  f.addFile('/remote/other.txt', 'other');
  await f.writer.writeAck();
  const record = await f.reader.readRecord();
  assert.equal(record.name, '*.txt');
  await f.writer.writeAck();
  await f.reader.readPayload(7, () => {});
  await f.reader.readAck();
  await f.writer.writeAck();
  assert.equal((await f.session.done).exitCode, 0);
});

for (const [label, mode, type] of [
  ['link ancestor', 0o120777, 'FILE'],
  ['missing type bits', 0o755, 'DIR'],
  ['special ancestor', 0o010600, 'FILE'],
  ['mismatched enum', 0o100644, 'DIR'],
]) {
  test(`source refuses ${label} before data transfer`, async t => {
    const f = await fixture(t, 'scp -f /remote/bad/secret');
    f.nodes.set('/remote/bad', { mode, type, size: 0, mtime: MTIME });
    const error = await f.reader.readRecord();
    assert.equal(error.type, 'error');
    assert.equal(error.fatal, true);
    assert.match(error.message, /links and special files/u);
    assert.ok(!error.message.includes('secret'));
    assert.equal((await f.session.done).exitCode, 1);
    assert.equal(f.calls.some(([method]) => method === 'download'), false);
  });
}

test('source rejects wrong HTTP length before emitting a C record', async t => {
  const state = memoryApi();
  state.addFile('/remote/file', 'abc');
  state.api.download = async () => ({ body: Readable.from([Buffer.from('abc')]), contentLength: 9, cancel() {} });
  const f = await fixture(t, 'scp -f /remote/file', { api: state.api });
  await f.writer.writeAck();
  const record = await f.reader.readRecord();
  assert.equal(record.type, 'error');
  assert.match(record.message, /metadata/u);
  assert.equal((await f.session.done).exitCode, 1);
});

test('source detects a short body even when Content-Length agrees with metadata', async t => {
  const state = memoryApi();
  state.addFile('/remote/file', 'abcde');
  state.api.download = async () => ({ body: Readable.from([Buffer.from('abc')]), contentLength: 5, cancel() {} });
  const f = await fixture(t, 'scp -f /remote/file', { api: state.api });
  await f.writer.writeAck();
  assert.equal((await f.reader.readRecord()).size, 5);
  await f.writer.writeAck();
  await f.reader.readPayload(3, () => {});
  assert.equal((await f.reader.readRecord()).type, 'error');
  assert.equal((await f.session.done).exitCode, 1);
});

test('sink verifies publication and removes its private file before completion ACK', async t => {
  const moved = deferred();
  const release = deferred();
  const state = memoryApi();
  const originalMove = state.api.move;
  state.api.move = async input => { moved.resolve(); await release.promise; return originalMove(input); };
  const f = await fixture(t, 'scp -t /remote/renamed', { api: state.api });
  await f.reader.readAck();
  await f.writer.writeRecord({ type: 'C', name: 'untrusted-original-name', mode: 0o7777, size: 6 });
  await f.reader.readAck();
  const [privateName] = await fs.readdir(f.temporary);
  const privatePath = path.join(f.temporary, privateName);
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(privatePath)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(path.join(privatePath, 'payload'))).mode & 0o777, 0o600);
  }
  await f.writer.writePayload(Buffer.from('upload'));
  await f.writer.writeAck();
  await moved.promise;
  let acknowledged = false;
  const completion = f.reader.readAck().then(() => { acknowledged = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acknowledged, false);
  release.resolve();
  await completion;
  assert.equal(state.nodes.get('/remote/renamed').body.toString(), 'upload');
  assert.deepEqual(await fs.readdir(f.temporary), []);
  assert.ok(state.calls.some(([method, input]) => method === 'download' && input.path === '/remote/renamed'));
  f.peer.end();
  assert.equal((await f.session.done).exitCode, 0);
  assert.equal(f.traffic.reduce((sum, update) => sum + update.sent, 0), 6);
});

test('sink accepts recursive D/E and T records without applying sender modes/times', async t => {
  const f = await fixture(t, 'scp -rtd /remote');
  await f.reader.readAck();
  await f.writer.writeRecord({ type: 'T', mtime: 1, atime: 2 });
  await f.reader.readAck();
  await f.writer.writeRecord({ type: 'D', name: 'nested', mode: 0o7777, size: 0 });
  await f.reader.readAck();
  await f.writer.writeRecord({ type: 'C', name: 'empty', mode: 0o7777, size: 0 });
  await f.reader.readAck();
  await f.writer.writeAck();
  await f.reader.readAck();
  await f.writer.writeRecord({ type: 'E' });
  await f.reader.readAck();
  f.peer.end();
  assert.equal((await f.session.done).exitCode, 0);
  assert.equal(f.nodes.get('/remote/nested').mode, 0o040755);
  assert.equal(f.nodes.get('/remote/nested/empty').mtime, MTIME);
  assert.equal(f.nodes.get('/remote/nested/empty').mode, 0o100640);
});

test('sink acknowledges every top-level file and directory, then completes on input EOF without peer close', { timeout: 3000 }, async t => {
  const f = await fixture(t, 'scp -rtd /remote');
  let finished = false;
  f.session.done.then(() => { finished = true; });
  await f.reader.readAck();
  for (const record of [
    { type: 'C', name: 'first', mode: 0o600, size: 1 },
    { type: 'D', name: 'middle', mode: 0o700, size: 0 },
    { type: 'C', name: 'inside', mode: 0o600, size: 1 },
    { type: 'E' },
    { type: 'C', name: 'last', mode: 0o600, size: 1 },
  ]) {
    await f.writer.writeRecord(record);
    await f.reader.readAck();
    if (record.type === 'C') {
      await f.writer.writePayload(Buffer.from('x'));
      await f.writer.writeAck();
      await f.reader.readAck();
      assert.equal(f.nodes.get(`/remote/${record.name === 'inside' ? 'middle/' : ''}${record.name}`).body.toString(), 'x');
      assert.deepEqual(await fs.readdir(f.temporary), []);
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(finished, false, 'a root entry or E record is not the end of a multi-source upload');
  }
  // Real clients close their protocol output after the final ACK, while the SSH
  // channel stays open to receive the remote exit status. Do not require close.
  f.peer.end();
  assert.deepEqual(await f.session.done, { exitCode: 0, reason: 'completed', remoteTempsRetained: false });
  assert.equal(f.channel.destroyed, false);
  assert.equal(f.peer.readableEnded, false);
});

for (const [command, noOverwrite, setup] of [
  ['scp -td /remote/missing', false, () => {}],
  ['scp -t /remote/file', true, state => state.addFile('/remote/file', 'old')],
  ['scp -t /remote/link', false, state => state.nodes.set('/remote/link', { type: 'FILE', mode: 0o120777, size: 1, mtime: MTIME })],
]) {
  test(`sink validates target before initial ACK: ${command}`, async t => {
    const state = memoryApi();
    setup(state);
    const f = await fixture(t, command, { api: state.api, noOverwrite });
    assert.equal((await f.reader.readRecord()).type, 'error');
    assert.equal((await f.session.done).exitCode, 1);
    assert.equal(state.calls.some(([method]) => method === 'upload'), false);
  });
}

test('sink never publishes an incomplete body or consumes a later apparent record', async t => {
  const f = await fixture(t, 'scp -t /remote/destination');
  await f.reader.readAck();
  await f.writer.writeRecord({ type: 'C', name: 'partial', mode: 0o600, size: 200 });
  await f.reader.readAck();
  await f.writer.writePayload(Buffer.from('short\0C0600 1 later\nx\0'));
  f.peer.end();
  const result = await f.session.done;
  assert.equal(result.exitCode, 1);
  assert.equal(f.calls.some(([method]) => method === 'upload'), false);
  assert.deepEqual(await fs.readdir(f.temporary), []);
});

test('close aborts a non-cooperative pending API promise without waiting for it', async t => {
  const called = deferred();
  let signal;
  const api = {
    list(input) { signal = input.signal; called.resolve(); return new Promise(() => {}); },
  };
  const f = await fixture(t, 'scp -t /remote/target', { api });
  await called.promise;
  f.session.close('proxy_stop');
  assert.equal(signal.aborted, true);
  assert.deepEqual(await f.session.done, { exitCode: 1, reason: 'proxy_stop', remoteTempsRetained: false });
  assert.deepEqual(await fs.readdir(f.temporary), []);
});

test('close cancels an in-flight upload and cleans its received local body', async t => {
  const state = memoryApi();
  const called = deferred();
  let signal;
  state.api.upload = input => { signal = input.signal; called.resolve(); return new Promise(() => {}); };
  const f = await fixture(t, 'scp -t /remote/target', { api: state.api });
  await f.reader.readAck();
  await f.writer.writeRecord({ type: 'C', name: 'body', mode: 0o600, size: 4 });
  await f.reader.readAck();
  await f.writer.writePayload(Buffer.from('body'));
  await f.writer.writeAck();
  await called.promise;
  f.session.close('proxy_stop');
  const result = await f.session.done;
  assert.equal(signal.aborted, true);
  assert.equal(result.exitCode, 1);
  assert.equal(result.reason, 'proxy_stop');
  assert.equal(result.remoteTempsRetained, true);
  assert.equal(state.nodes.has('/remote/target'), false);
  assert.deepEqual(await fs.readdir(f.temporary), []);
});

test('server and peer error strings never enter actionable protocol errors', async t => {
  const api = { list: async () => { throw new Error('SECRET_COOKIE and /private/server/path'); } };
  const f = await fixture(t, 'scp -t /remote/target', { api });
  const error = await f.reader.readRecord();
  assert.equal(error.type, 'error');
  assert.match(error.message, /check storage/u);
  assert.ok(!error.message.includes('SECRET_COOKIE'));
  assert.equal((await f.session.done).exitCode, 1);
});

test('sink refuses completion ACK when the final published bytes differ from the verified staging file', async t => {
  const state = memoryApi();
  const move = state.api.move;
  state.api.move = async input => {
    await move(input);
    state.nodes.get(input.toPath).body = Buffer.from('bad!');
  };
  const f = await fixture(t, 'scp -t /remote/target', { api: state.api });
  await f.reader.readAck();
  await f.writer.writeRecord({ type: 'C', name: 'body', mode: 0o600, size: 4 });
  await f.reader.readAck();
  await f.writer.writePayload(Buffer.from('good'));
  await f.writer.writeAck();
  const error = await f.reader.readRecord();
  assert.equal(error.type, 'error');
  assert.match(error.message, /metadata/u);
  assert.equal((await f.session.done).exitCode, 1);
  assert.deepEqual(await fs.readdir(f.temporary), []);
});

test('close settles even when the channel never invokes a pending write callback', { timeout: 2000 }, async t => {
  const state = memoryApi();
  state.addFile('/remote/file', 'body');
  const writing = deferred();
  let supplied = false;
  const channel = new Duplex({
    allowHalfOpen: true,
    read() { if (!supplied) { supplied = true; this.push(Buffer.from([0])); } },
    write(_chunk, _encoding, _callback) { writing.resolve(); },
  });
  channel.on('error', () => {});
  t.after(() => channel.destroy());
  const session = startScpSession({ channel, command: 'scp -f /remote/file', api: state.api,
    cluster: 'cluster', maxFileBytes: 1024 });
  await writing.promise;
  session.close('proxy_stop');
  assert.deepEqual(await session.done, { exitCode: 1, reason: 'proxy_stop', remoteTempsRetained: false });
});

test('sink overwrites an existing regular file through verified in-place publication by default', async t => {
  const state = memoryApi();
  state.addFile('/remote/target', 'old');
  const f = await fixture(t, 'scp -t /remote/target', { api: state.api });
  await f.reader.readAck();
  await f.writer.writeRecord({ type: 'C', name: 'body', mode: 0o600, size: 4 });
  await f.reader.readAck();
  await f.writer.writePayload(Buffer.from('new!'));
  await f.writer.writeAck();
  await f.reader.readAck();
  assert.equal(state.nodes.get('/remote/target').body.toString(), 'new!');
  assert.ok(state.calls.some(([method, input]) => method === 'upload' && input.path === '/remote/target'));
  assert.equal(state.calls.some(([method, input]) => method === 'move' && input.toPath === '/remote/target'), false);
  f.peer.end();
  assert.deepEqual(await f.session.done, { exitCode: 0, reason: 'completed', remoteTempsRetained: true });
  assert.deepEqual(await fs.readdir(f.temporary), []);
});

test('failed in-place replacement warns explicitly about partial destination changes without leaking raw errors', async t => {
  const state = memoryApi();
  state.addFile('/remote/target', 'old');
  const upload = state.api.upload;
  state.api.upload = async input => {
    if (input.path !== '/remote/target') return upload(input);
    state.addFile(input.path, 'p');
    throw Object.assign(new Error('SECRET_SERVER_RESPONSE'), { code: 'PORTAL_NETWORK' });
  };
  const f = await fixture(t, 'scp -t /remote/target', { api: state.api });
  await f.reader.readAck();
  await f.writer.writeRecord({ type: 'C', name: 'body', mode: 0o600, size: 4 });
  await f.reader.readAck();
  await f.writer.writePayload(Buffer.from('new!'));
  await f.writer.writeAck();
  const error = await f.reader.readRecord();
  assert.equal(error.type, 'error');
  assert.match(error.message, /truncated or partially replaced; no rollback/u);
  assert.ok(!error.message.includes('SECRET_SERVER_RESPONSE'));
  assert.equal((await f.session.done).exitCode, 1);
  assert.deepEqual(await fs.readdir(f.temporary), []);
});
