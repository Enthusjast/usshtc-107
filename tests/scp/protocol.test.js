'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Writable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { ScpProtocolReader, ScpProtocolWriter, validateName } = require('../../electron/scp/protocol');

const tick = () => new Promise(resolve => setImmediate(resolve));
function readerFixture(t, options = {}) {
  const input = new PassThrough();
  const reader = new ScpProtocolReader(input, { timeoutMs: 500, ...options });
  t.after(() => { reader.close(); input.destroy(); });
  return { input, reader };
}

function manualWriter(t, options = {}) {
  const stream = new EventEmitter();
  stream.writableLength = 0;
  stream.chunks = [];
  stream.callbacks = [];
  stream.write = (bytes, callback) => {
    stream.chunks.push(bytes);
    stream.callbacks.push(callback);
    return false;
  };
  const writer = new ScpProtocolWriter(stream, { timeoutMs: 500, ...options });
  t.after(() => writer.close());
  return { stream, writer };
}

test('coalesced records and payload preserve exact binary bytes and record boundaries', async t => {
  const { input, reader } = readerFixture(t);
  const payload = Buffer.from([0, 10, 13, 255, 67, 0, 2, 69]);
  input.end(Buffer.concat([
    Buffer.from('T1700000000 123456 1700000001 0\nD0755 0 目录 with space\nC0644 8 文件.bin\n'),
    payload, Buffer.from('\0E\n\0'),
  ]));
  assert.deepEqual(await reader.readRecord(), { type: 'T', mtime: 1700000000, mtimeUsec: 123456, atime: 1700000001, atimeUsec: 0 });
  assert.deepEqual(await reader.readRecord(), { type: 'D', mode: 0o755, size: 0, name: '目录 with space' });
  assert.deepEqual(await reader.readRecord(), { type: 'C', mode: 0o644, size: 8, name: '文件.bin' });
  const chunks = [];
  await reader.readPayload(payload.length, chunk => { chunks.push(Buffer.from(chunk)); });
  assert.deepEqual(Buffer.concat(chunks), payload);
  await reader.readAck();
  assert.deepEqual(await reader.readRecord(), { type: 'E' });
  await reader.readAck();
  assert.equal(await reader.readRecord(), null);
  assert.equal(input.readableFlowing, false);
});

test('every byte, including multibyte UTF-8 names, may arrive in a separate fragment', async t => {
  const { input, reader } = readerFixture(t);
  const result = reader.readRecord();
  const bytes = Buffer.from('C0600 0 😀 数据.txt\n');
  for (const byte of bytes) {
    input.write(Buffer.from([byte]));
    await tick();
  }
  assert.deepEqual(await result, { type: 'C', mode: 0o600, size: 0, name: '😀 数据.txt' });
  input.end();
  assert.equal(await reader.readRecord(), null);
});

test('empty EOF wakes an already waiting reader and completes without another readable event', async t => {
  const { input, reader } = readerFixture(t);
  const pending = reader.readRecord();
  await tick();
  input.end();
  assert.equal(await pending, null);
  assert.equal(input.readableEnded, true);
});

test('a paused SSH receive window plus advertised in-flight bytes stays bounded and preserves the ACK', async t => {
  const receiveWindow = 2 * 1024 * 1024;
  const input = new PassThrough({ highWaterMark: receiveWindow });
  const reader = new ScpProtocolReader(input, { timeoutMs: 500 });
  t.after(() => { reader.close(); input.destroy(); });
  // ssh2 can stop replenishing its receive window at the readable high-water
  // mark while packets from the previously advertised window are still arriving.
  const bytes = Buffer.alloc(2 * receiveWindow, 0xa5);
  bytes[bytes.length - 1] = 0;
  input.end(bytes);
  assert.equal(input.readableLength, bytes.length);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let received = 0;
  const pending = reader.readPayload(bytes.length - 1, async chunk => {
    assert.ok(chunk.length <= 64 * 1024);
    assert.ok(chunk.equals(bytes.subarray(received, received + chunk.length)));
    received += chunk.length;
    if (received === chunk.length) await blocked;
  });
  await tick();
  assert.equal(received, 64 * 1024);
  assert.equal(input.readableLength, bytes.length - received);
  assert.equal(input.readableFlowing, false);
  release();
  await pending;
  assert.equal(received, bytes.length - 1);
  await reader.readAck();
  assert.equal(await reader.readRecord(), null);
});

test('default SSH buffer budget still rejects input larger than the bounded transport allowance', async t => {
  const { input, reader } = readerFixture(t);
  input.end(Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(reader.readRecord(), { code: 'SCP_BUFFER_LIMIT' });
});

test('payload consumer backpressure stops further consumption and excludes following ACK', async t => {
  const { input, reader } = readerFixture(t, { maxChunkBytes: 2 });
  input.end(Buffer.from('abcdef\0'));
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const chunks = [];
  const payload = reader.readPayload(6, async chunk => {
    chunks.push(Buffer.from(chunk));
    if (chunks.length === 1) await blocked;
  });
  await tick();
  assert.equal(chunks.length, 1);
  assert.equal(Buffer.concat(chunks).toString(), 'ab');
  release();
  await payload;
  assert.equal(Buffer.concat(chunks).toString(), 'abcdef');
  await reader.readAck();
});

test('zero-length payload invokes no consumer and leaves the ACK untouched', async t => {
  const { input, reader } = readerFixture(t);
  input.end(Buffer.from([0]));
  await reader.readPayload(0, () => assert.fail('zero-byte consumer must not run'));
  await reader.readAck();
});

for (const [bytes, operation] of [
  [Buffer.from('C0644 1 file'), reader => reader.readRecord()],
  [Buffer.from('T1 0 2'), reader => reader.readRecord()],
  [Buffer.from('ab'), reader => reader.readPayload(3, () => {})],
  [Buffer.alloc(0), reader => reader.readAck()],
]) {
  test(`truncated framing rejects rather than treating EOF as success: ${bytes.toString()}`, async t => {
    const { input, reader } = readerFixture(t);
    input.end(bytes);
    await assert.rejects(operation(reader), { code: 'SCP_UNEXPECTED_EOF' });
  });
}

for (const line of [
  'C8888 0 file\n', 'C0644 -1 file\n', 'C0644 9007199254740992 file\n', 'D0755 1 dir\n',
  'C0644 0 .\n', 'C0644 0 ..\n', 'C0644 0 a/b\n', 'C0644 0 bad\rname\n',
  'T1 1000000 2 0\n', 'T-1 0 2 0\n', 'Eextra\n', 'Qwhatever\n',
]) {
  test(`malformed record is rejected: ${JSON.stringify(line)}`, async t => {
    const { input, reader } = readerFixture(t);
    input.end(Buffer.from(line));
    await assert.rejects(reader.readRecord());
  });
}

test('invalid UTF-8 and Unicode control names are rejected, while valid names are preserved', async t => {
  const { input, reader } = readerFixture(t);
  input.end(Buffer.concat([Buffer.from('C0644 0 '), Buffer.from([0xc3, 0x28, 10])]));
  await assert.rejects(reader.readRecord(), /UTF-8/);
  for (const name of ['', '.', '..', 'a/b', 'a\0b', 'a\nb', 'a\u0085b', '\ud800']) assert.throws(() => validateName(name));
  assert.equal(validateName('研究 a\\b:😀'), '研究 a\\b:😀');
});

test('peer errors are parsed but ACK rejection never reflects the peer message', async t => {
  const { input, reader } = readerFixture(t);
  input.end(Buffer.from('\x01recoverable\n\x02secret server detail\n'));
  assert.deepEqual(await reader.readRecord(), { type: 'error', fatal: false, message: 'recoverable' });
  await assert.rejects(reader.readAck(), error => error.code === 'SCP_PEER_FATAL' && error.fatal === true && !error.message.includes('secret'));
  const next = readerFixture(t);
  next.input.end(Buffer.from('\x01other private detail\n'));
  await assert.rejects(next.reader.readAck(), error => error.code === 'SCP_PEER_ERROR' && error.fatal === false);
});

test('bounded line, file and paused-stream buffer limits reject excessive input', async t => {
  const first = readerFixture(t, { maxLineBytes: 8 });
  first.input.end(Buffer.from('C0644 0 long-name\n'));
  await assert.rejects(first.reader.readRecord(), { code: 'SCP_BUFFER_LIMIT' });
  const second = readerFixture(t, { maxBufferBytes: 16 });
  second.input.end(Buffer.alloc(17, 65));
  await assert.rejects(second.reader.readRecord(), { code: 'SCP_BUFFER_LIMIT' });
  const third = readerFixture(t, { maxFileBytes: 4 });
  third.input.end(Buffer.from('C0644 5 file\n'));
  await assert.rejects(third.reader.readRecord(), /file size/);
});

test('read operations are exclusive and pending reads abort without consuming another record', async t => {
  const controller = new AbortController();
  const { input, reader } = readerFixture(t, { signal: controller.signal });
  const pending = reader.readRecord();
  await assert.rejects(reader.readRecord(), /Concurrent/);
  controller.abort();
  await assert.rejects(pending, { code: 'ABORT_ERR' });
  assert.equal(input.listenerCount('data'), 0);
});

test('read timeouts, abnormal closure and explicit cleanup settle pending operations', async t => {
  const first = readerFixture(t, { timeoutMs: 10 });
  await assert.rejects(first.reader.readRecord(), { code: 'SCP_TIMEOUT' });
  const second = readerFixture(t);
  const pending = second.reader.readRecord();
  second.input.destroy();
  await assert.rejects(pending, { code: 'SCP_UNEXPECTED_EOF' });
  const third = readerFixture(t);
  const closed = third.reader.readRecord();
  third.reader.close();
  await assert.rejects(closed, { code: 'SCP_CLOSED' });
  assert.equal(third.input.listenerCount('readable'), 0);
  assert.equal(third.input.listenerCount('error'), 0);
});

test('writer waits for both callback completion and drain in either order', async t => {
  for (const drainFirst of [true, false]) {
    const { stream, writer } = manualWriter(t);
    let finished = false;
    const pending = writer.writePayload(Buffer.from('payload')).then(() => { finished = true; });
    if (drainFirst) stream.emit('drain');
    else stream.callbacks.shift()();
    await tick();
    assert.equal(finished, false);
    if (drainFirst) stream.callbacks.shift()();
    else stream.emit('drain');
    await pending;
    assert.equal(finished, true);
    assert.equal(stream.listenerCount('drain'), 0);
  }
});

test('writer emits every record and binary payload with chunk bounds and round-trips', async t => {
  const chunks = [];
  const output = new Writable({ highWaterMark: 1, write(bytes, _encoding, callback) {
    chunks.push(Buffer.from(bytes));
    setImmediate(callback);
  } });
  const writer = new ScpProtocolWriter(output, { maxChunkBytes: 3, timeoutMs: 500 });
  t.after(() => { writer.close(); output.destroy(); });
  const records = [
    { type: 'T', mtime: 4, mtimeUsec: 12, atime: 9, atimeUsec: 1 },
    { type: 'D', mode: 0o755, size: 0, name: '目录' },
    { type: 'C', mode: 0o640, size: 5, name: 'a b' },
  ];
  for (const record of records) await writer.writeRecord(record);
  const payload = Buffer.from([0, 255, 10, 13, 67]);
  await writer.writePayload(payload);
  await writer.writeAck();
  await writer.writeRecord({ type: 'E' });
  await writer.writeError('Permission denied', { fatal: false });
  assert.equal(chunks.every(chunk => chunk.length <= 3), true);
  const { input, reader } = readerFixture(t);
  input.end(Buffer.concat(chunks));
  for (const record of records) assert.deepEqual(await reader.readRecord(), record);
  const recovered = [];
  await reader.readPayload(5, chunk => recovered.push(Buffer.from(chunk)));
  assert.deepEqual(Buffer.concat(recovered), payload);
  await reader.readAck();
  assert.deepEqual(await reader.readRecord(), { type: 'E' });
  assert.deepEqual(await reader.readRecord(), { type: 'error', fatal: false, message: 'Permission denied' });
});

test('writer rejects malformed records, nonbytes and error-line injection before writing', async t => {
  const { stream, writer } = manualWriter(t);
  for (const record of [
    { type: 'C', mode: 0o10000, size: 0, name: 'file' },
    { type: 'C', mode: 0o644, size: -1, name: 'file' },
    { type: 'D', mode: 0o755, size: 1, name: 'dir' },
    { type: 'C', mode: 0o644, size: 0, name: '../escape' },
    { type: 'T', mtime: 1, atime: 1, atimeUsec: 1000000 },
    { type: 'unknown' },
  ]) await assert.rejects(writer.writeRecord(record));
  await assert.rejects(writer.writePayload('not bytes'));
  await assert.rejects(writer.writeError('failure\nC0644 0 injected'));
  assert.equal(stream.chunks.length, 0);
});

test('writer aborts, times out, and observes callback and stream errors', async t => {
  const controller = new AbortController();
  const first = manualWriter(t, { signal: controller.signal });
  const aborted = first.writer.writePayload(Buffer.from('a'));
  controller.abort();
  await assert.rejects(aborted, { code: 'ABORT_ERR' });
  const second = manualWriter(t, { timeoutMs: 10 });
  await assert.rejects(second.writer.writeAck(), { code: 'SCP_TIMEOUT' });
  const third = manualWriter(t);
  const failed = third.writer.writeAck();
  third.stream.callbacks.shift()(new Error('private failure body'));
  third.stream.emit('drain');
  await assert.rejects(failed, error => error.code === 'SCP_STREAM_ERROR' && !error.message.includes('private'));
  const fourth = manualWriter(t);
  const closed = fourth.writer.writeAck();
  fourth.stream.emit('close');
  await assert.rejects(closed, { code: 'SCP_STREAM_ERROR' });
});

test('byte-stream invariant rejects object-mode and decoded streams before listener attachment', () => {
  const objectStream = new PassThrough({ objectMode: true });
  const textStream = new PassThrough();
  textStream.setEncoding('utf8');
  assert.throws(() => new ScpProtocolReader(objectStream), /byte stream/);
  assert.throws(() => new ScpProtocolReader(textStream), /byte stream/);
  assert.equal(objectStream.listenerCount('error'), 0);
  assert.equal(textStream.listenerCount('readable'), 0);
  objectStream.destroy();
  textStream.destroy();
});

test('stream errors fail pending readers without forwarding private exception text', async t => {
  const { input, reader } = readerFixture(t);
  const pending = reader.readRecord();
  input.emit('error', new Error('private body'));
  await assert.rejects(pending, error => error.code === 'SCP_STREAM_ERROR' && !error.message.includes('private'));
});

test('abort while consuming already-buffered input does not report a completed record', async t => {
  const controller = new AbortController();
  const { input, reader } = readerFixture(t, { signal: controller.signal });
  input.end(Buffer.from('E\n'));
  const pending = reader.readRecord();
  controller.abort();
  await assert.rejects(pending, { code: 'ABORT_ERR' });
});

test('writer output limit and callback timeout remain bounded while drain never arrives', async t => {
  const first = manualWriter(t, { maxBufferBytes: 4 });
  first.stream.writableLength = 4;
  await assert.rejects(first.writer.writeAck(), { code: 'SCP_BUFFER_LIMIT' });
  assert.equal(first.stream.chunks.length, 0);
  const second = manualWriter(t, { timeoutMs: 10 });
  const pending = second.writer.writeAck();
  second.stream.callbacks.shift()();
  await assert.rejects(pending, { code: 'SCP_TIMEOUT' });
  assert.equal(second.stream.listenerCount('drain'), 0);
});

test('abort after a payload fill prevents consumer invocation and handles pending rejections', async t => {
  const controller = new AbortController();
  const { input, reader } = readerFixture(t, { signal: controller.signal });
  input.end(Buffer.from('payload'));
  const originalFill = reader.fill.bind(reader);
  reader.fill = async () => {
    const available = await originalFill();
    controller.abort();
    return available;
  };
  let invoked = false;
  await assert.rejects(reader.readPayload(7, () => {
    invoked = true;
    throw new Error('consumer must not run after cancellation');
  }), { code: 'ABORT_ERR' });
  assert.equal(invoked, false);
  await tick();
});
