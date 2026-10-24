'use strict';

const { TextDecoder } = require('node:util');

// ssh2 channels use a 2 MiB readable high-water mark and receive window.
// Backpressure stops window replenishment, not packets already advertised to the
// peer, so allow the readable high-water mark plus one outstanding receive window.
const SSH_RECEIVE_WINDOW_BYTES = 2 * 1024 * 1024;
const DEFAULT_LIMITS = Object.freeze({
  timeoutMs: 30_000,
  maxBufferBytes: 2 * SSH_RECEIVE_WINDOW_BYTES,
  maxLineBytes: 16 * 1024,
  maxChunkBytes: 64 * 1024,
  maxFileBytes: Number.MAX_SAFE_INTEGER,
});
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

class ScpProtocolError extends Error {
  constructor(message, code = 'SCP_PROTOCOL_ERROR') {
    super(message);
    this.name = 'ScpProtocolError';
    this.code = code;
  }
}

function validateName(name) {
  if (typeof name !== 'string' || !name || !name.isWellFormed() || name === '.' || name === '..'
      || name.includes('/') || CONTROL.test(name)) {
    throw new ScpProtocolError('Invalid SCP entry name');
  }
  return name;
}

function decode(bytes) {
  try { return utf8.decode(bytes); } catch { throw new ScpProtocolError('Invalid SCP UTF-8'); }
}

function integer(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new ScpProtocolError(`Invalid SCP ${label}`);
  }
  return value;
}

function limits(options) {
  const result = { ...DEFAULT_LIMITS, ...options };
  if (options.maxChunkBytes === undefined) result.maxChunkBytes = Math.min(result.maxChunkBytes, result.maxBufferBytes);
  if (options.maxLineBytes === undefined) result.maxLineBytes = Math.min(result.maxLineBytes, result.maxBufferBytes);
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    integer(result[key], key);
    if (key !== 'timeoutMs' && result[key] === 0) throw new ScpProtocolError(`Invalid SCP ${key}`);
  }
  if (result.maxChunkBytes > result.maxBufferBytes || result.maxLineBytes > result.maxBufferBytes) {
    throw new ScpProtocolError('SCP limits exceed the buffer bound');
  }
  return result;
}

class ProtocolEndpoint {
  constructor(stream, options = {}) {
    this.stream = stream;
    this.options = limits(options);
    this.signal = options.signal;
    this.failure = null;
    this.closed = false;
    this.busy = false;
    this.waiters = new Set();
    this.onError = () => this.fail(new ScpProtocolError('SCP stream failed', 'SCP_STREAM_ERROR'));
    this.onAbort = () => this.fail(new ScpProtocolError('SCP transfer aborted', 'ABORT_ERR'));
    stream.on('error', this.onError);
    if (this.signal) {
      this.signal.addEventListener('abort', this.onAbort, { once: true });
      if (this.signal.aborted) this.onAbort();
    }
  }

  check() {
    if (this.failure) throw this.failure;
    if (this.closed) throw new ScpProtocolError('SCP endpoint is closed', 'SCP_CLOSED');
  }

  fail(error) {
    if (!this.failure) this.failure = error;
    for (const wake of [...this.waiters]) wake();
  }

  async operation(fn) {
    this.check();
    if (this.busy) throw new ScpProtocolError('Concurrent SCP operations are not supported');
    this.busy = true;
    try {
      const result = await fn();
      this.check();
      return result;
    } finally { this.busy = false; }
  }

  waitFor(promise) {
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error, value) => {
        clearTimeout(timer);
        this.waiters.delete(wake);
        if (error) reject(error);
        else resolve(value);
      };
      const wake = () => {
        try { this.check(); } catch (error) { finish(error); }
      };
      this.waiters.add(wake);
      if (this.options.timeoutMs) {
        timer = setTimeout(() => {
          this.fail(new ScpProtocolError('SCP operation timed out', 'SCP_TIMEOUT'));
        }, this.options.timeoutMs);
      }
      Promise.resolve(promise).then(value => finish(null, value), error => finish(error));
      // Observe the supplied promise before checking cancellation: the caller may
      // already have started work whose rejection must remain handled on abort.
      wake();
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const wake of [...this.waiters]) wake();
    this.stream.removeListener('error', this.onError);
    this.signal?.removeEventListener('abort', this.onAbort);
  }
}

// The stream stays in paused/readable mode. No data listener or unbounded input queue
// is installed. Consumers pull at most maxChunkBytes and must finish each operation.
class ScpProtocolReader extends ProtocolEndpoint {
  constructor(stream, options = {}) {
    if (stream.readableObjectMode || stream.readableEncoding) {
      throw new ScpProtocolError('SCP input must be a byte stream');
    }
    super(stream, options);
    this.buffer = null;
    this.offset = 0;
    this.readableWaiters = new Set();
    this.onReadable = () => {
      if (stream.readableLength > this.options.maxBufferBytes) {
        this.fail(new ScpProtocolError('SCP input buffer limit exceeded', 'SCP_BUFFER_LIMIT'));
      }
      for (const wake of [...this.readableWaiters]) wake();
    };
    this.onClose = () => {
      if (!stream.readableEnded) this.fail(new ScpProtocolError('SCP stream closed unexpectedly', 'SCP_UNEXPECTED_EOF'));
      this.onReadable();
    };
    stream.pause();
    stream.on('readable', this.onReadable);
    stream.on('end', this.onReadable);
    stream.on('close', this.onClose);
    this.onReadable();
  }

  async fill() {
    this.check();
    while (!this.buffer || this.offset === this.buffer.length) {
      this.check();
      if (this.stream.readableLength > this.options.maxBufferBytes) {
        this.fail(new ScpProtocolError('SCP input buffer limit exceeded', 'SCP_BUFFER_LIMIT'));
        this.check();
      }
      const length = Math.min(this.stream.readableLength, this.options.maxChunkBytes);
      // Even an empty read must reach the stream: it re-arms readable notifications
      // and lets Node emit end after EOF. readableLength alone cannot drive either.
      const chunk = this.stream.read(length || 1);
      if (chunk !== null) {
        if (!Buffer.isBuffer(chunk)) throw new ScpProtocolError('SCP input must be a byte stream');
        this.buffer = chunk;
        this.offset = 0;
        return true;
      }
      if (this.stream.readableEnded) return false;
      if (this.stream.destroyed) throw new ScpProtocolError('Unexpected SCP EOF', 'SCP_UNEXPECTED_EOF');
      let wake;
      const ready = new Promise(resolve => { wake = resolve; this.readableWaiters.add(wake); });
      try { await this.waitFor(ready); } finally { this.readableWaiters.delete(wake); }
    }
    return true;
  }

  async byte(allowEof = false) {
    if (!(await this.fill())) {
      if (allowEof) return null;
      throw new ScpProtocolError('Unexpected SCP EOF', 'SCP_UNEXPECTED_EOF');
    }
    this.check();
    return this.buffer[this.offset++];
  }

  async line() {
    const chunks = [];
    let size = 0;
    for (;;) {
      if (!(await this.fill())) throw new ScpProtocolError('Truncated SCP record', 'SCP_UNEXPECTED_EOF');
      this.check();
      const newline = this.buffer.indexOf(10, this.offset);
      const end = newline < 0 ? this.buffer.length : newline;
      const part = this.buffer.subarray(this.offset, end);
      size += part.length;
      if (size > this.options.maxLineBytes) throw new ScpProtocolError('SCP record exceeds line limit', 'SCP_BUFFER_LIMIT');
      chunks.push(part);
      this.offset = newline < 0 ? end : end + 1;
      if (newline >= 0) return decode(chunks.length === 1 ? part : Buffer.concat(chunks, size));
    }
  }

  readRecord() {
    return this.operation(async () => {
      const type = await this.byte(true);
      if (type === null) return null; // EOF is valid only between complete records.
      if (type === 0) return { type: 'ACK' };
      const line = await this.line();
      if (CONTROL.test(line)) throw new ScpProtocolError('Invalid SCP record characters');
      if (type === 1 || type === 2) return { type: 'error', fatal: type === 2, message: line };
      if (type === 69 && line === '') return { type: 'E' };
      if (type === 67 || type === 68) {
        const match = /^([0-7]{4}) ([0-9]+) (.+)$/u.exec(line);
        if (!match) throw new ScpProtocolError('Malformed SCP entry record');
        const size = integer(Number(match[2]), 'file size', this.options.maxFileBytes);
        if (type === 68 && size !== 0) throw new ScpProtocolError('SCP directory size must be zero');
        return { type: String.fromCharCode(type), mode: parseInt(match[1], 8), size, name: validateName(match[3]) };
      }
      if (type === 84) {
        const match = /^([0-9]+) ([0-9]+) ([0-9]+) ([0-9]+)$/u.exec(line);
        if (!match) throw new ScpProtocolError('Malformed SCP time record');
        return { type: 'T', mtime: integer(Number(match[1]), 'mtime'),
          mtimeUsec: integer(Number(match[2]), 'mtime microseconds', 999999),
          atime: integer(Number(match[3]), 'atime'), atimeUsec: integer(Number(match[4]), 'atime microseconds', 999999) };
      }
      throw new ScpProtocolError('Unknown SCP record');
    });
  }

  async readAck() {
    const record = await this.readRecord();
    if (record?.type === 'error') {
      const error = new ScpProtocolError('SCP peer rejected the operation', record.fatal ? 'SCP_PEER_FATAL' : 'SCP_PEER_ERROR');
      error.fatal = record.fatal;
      throw error;
    }
    if (record === null) throw new ScpProtocolError('Unexpected SCP EOF', 'SCP_UNEXPECTED_EOF');
    if (record?.type !== 'ACK') throw new ScpProtocolError('Expected SCP acknowledgement');
  }

  readPayload(size, onChunk) {
    return this.operation(async () => {
      integer(size, 'payload size', this.options.maxFileBytes);
      if (typeof onChunk !== 'function') throw new TypeError('SCP payload consumer is required');
      let remaining = size;
      while (remaining) {
        if (!(await this.fill())) throw new ScpProtocolError('Truncated SCP payload', 'SCP_UNEXPECTED_EOF');
        this.check();
        const length = Math.min(remaining, this.buffer.length - this.offset);
        const part = this.buffer.subarray(this.offset, this.offset + length);
        this.offset += length;
        await this.waitFor(Promise.resolve().then(() => onChunk(part)));
        remaining -= length;
      }
    });
  }

  close() {
    super.close();
    this.stream.removeListener('readable', this.onReadable);
    this.stream.removeListener('end', this.onReadable);
    this.stream.removeListener('close', this.onClose);
    this.readableWaiters.clear();
    this.buffer = null;
  }
}

class ScpProtocolWriter extends ProtocolEndpoint {
  constructor(stream, options = {}) {
    super(stream, options);
    this.onClose = () => this.fail(new ScpProtocolError('SCP output closed unexpectedly', 'SCP_STREAM_ERROR'));
    stream.on('close', this.onClose);
  }

  async writeChunk(chunk) {
    this.check();
    if (this.stream.destroyed || this.stream.writableEnded || this.stream.writableFinished) {
      throw new ScpProtocolError('SCP output is not writable', 'SCP_STREAM_ERROR');
    }
    if ((this.stream.writableLength || 0) + chunk.length > this.options.maxBufferBytes) {
      throw new ScpProtocolError('SCP output buffer limit exceeded', 'SCP_BUFFER_LIMIT');
    }
    let onDrain;
    const drained = new Promise(resolve => { onDrain = resolve; this.stream.once('drain', onDrain); });
    let accepted;
    const completed = new Promise((resolve, reject) => {
      try { accepted = this.stream.write(chunk, error => error ? reject(new ScpProtocolError('SCP write failed', 'SCP_STREAM_ERROR')) : resolve()); }
      catch { reject(new ScpProtocolError('SCP write failed', 'SCP_STREAM_ERROR')); }
    });
    try {
      // Both guarantees matter: drain alone does not guarantee the caller may reuse
      // its payload buffer; the write callback alone does not release backpressure.
      await this.waitFor(Promise.all([completed, ...(accepted === false ? [drained] : [])]));
    } finally { this.stream.removeListener('drain', onDrain); }
  }

  writePayload(bytes) {
    return this.operation(async () => {
      if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new TypeError('SCP payload must contain bytes');
      integer(bytes.byteLength, 'payload size', this.options.maxFileBytes);
      for (let offset = 0; offset < bytes.byteLength; offset += this.options.maxChunkBytes) {
        await this.writeChunk(bytes.subarray(offset, Math.min(bytes.byteLength, offset + this.options.maxChunkBytes)));
      }
    });
  }

  writeRecord(record) {
    return this.operation(async () => {
      if (!record || typeof record !== 'object') throw new ScpProtocolError('Invalid SCP record');
      let line;
      if (record.type === 'ACK') return this.writeChunk(Buffer.from([0]));
      if (record.type === 'E') line = 'E';
      else if (record.type === 'C' || record.type === 'D') {
        const mode = integer(record.mode, 'mode', 0o7777).toString(8).padStart(4, '0');
        const size = integer(record.size, 'file size', this.options.maxFileBytes);
        if (record.type === 'D' && size !== 0) throw new ScpProtocolError('SCP directory size must be zero');
        line = `${record.type}${mode} ${size} ${validateName(record.name)}`;
      } else if (record.type === 'T') {
        line = `T${integer(record.mtime, 'mtime')} ${integer(record.mtimeUsec ?? 0, 'mtime microseconds', 999999)} ${integer(record.atime, 'atime')} ${integer(record.atimeUsec ?? 0, 'atime microseconds', 999999)}`;
      } else if (record.type === 'error') {
        // The session supplies fixed, user-actionable messages, never peer content.
        const message = record.message ?? 'SCP transfer failed';
        if (typeof message !== 'string' || !message || !message.isWellFormed() || CONTROL.test(message)) {
          throw new ScpProtocolError('Invalid SCP error message');
        }
        line = `${record.fatal ? '\x02' : '\x01'}${message}`;
      } else throw new ScpProtocolError('Unknown SCP record');
      if (Buffer.byteLength(line, 'utf8') - 1 > this.options.maxLineBytes) throw new ScpProtocolError('SCP record exceeds line limit', 'SCP_BUFFER_LIMIT');
      const bytes = Buffer.from(`${line}\n`, 'utf8');
      for (let offset = 0; offset < bytes.length; offset += this.options.maxChunkBytes) {
        await this.writeChunk(bytes.subarray(offset, Math.min(bytes.length, offset + this.options.maxChunkBytes)));
      }
    });
  }

  writeAck() { return this.writeRecord({ type: 'ACK' }); }
  writeError(message, { fatal = true } = {}) { return this.writeRecord({ type: 'error', fatal, message }); }

  close() {
    super.close();
    this.stream.removeListener('close', this.onClose);
  }
}

module.exports = { ScpProtocolReader, ScpProtocolWriter, ScpProtocolError, validateName, DEFAULT_LIMITS };
