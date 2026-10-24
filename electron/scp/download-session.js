'use strict';

const path = require('node:path');
const { compileGlob } = require('./glob');

function sameMetadata(left, right) {
  return left.kind === right.kind && left.entry?.size === right.entry?.size
    && left.entry?.mode === right.entry?.mode && left.entry?.mtime === right.entry?.mtime;
}

async function sendTime(context, entry) {
  if (!context.command.preserve) return;
  const milliseconds = Date.parse(entry.mtime);
  const seconds = Math.floor(milliseconds / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw context.failure('SCP_METADATA');
  // The official list API has no atime. mtime is an explicit derived fallback,
  // not a claim that the server's access time was observed or preserved.
  const microseconds = (milliseconds - seconds * 1000) * 1000;
  await context.writeRecord({ type: 'T', mtime: seconds, mtimeUsec: microseconds, atime: seconds, atimeUsec: microseconds });
  await context.readAck();
}

async function expandSources(context) {
  const { command, failure } = context;
  const absolute = await context.resolvePath(command.path);
  const sourceParts = command.path.split('/').filter(part => part && part !== '.');
  const patternParts = (command.globPattern ?? command.path).split('/').filter(part => part && part !== '.');
  if (sourceParts.length !== patternParts.length) throw failure('SCP_PATH');
  const patterns = patternParts.map(part => compileGlob(part));
  if (!patterns.some(pattern => pattern.magic)) {
    const source = await context.inspect(absolute);
    if (source.path === '/') throw failure('SCP_PATH');
    return [source];
  }
  let candidates = [command.path.startsWith('/') ? '/' : await context.resolvePath('.')];
  for (let index = 0; index < sourceParts.length; index++) {
    const next = [];
    for (const directory of candidates) {
      const parent = await context.inspect(directory);
      if (parent.kind !== 'dir') throw failure('SCP_NOT_DIRECTORY');
      const entries = await context.list(directory);
      for (const entry of entries) {
        if (patterns[index].magic ? !patterns[index].test(entry.name) : entry.name !== sourceParts[index]) continue;
        const kind = context.entryKind(entry);
        if (index < sourceParts.length - 1 && kind !== 'dir') throw failure('SCP_NOT_DIRECTORY');
        next.push(path.posix.join(directory, entry.name));
        if (next.length > 10_000) throw failure('SCP_LIMIT');
      }
    }
    candidates = next;
    if (!candidates.length) throw failure('SCP_NOT_FOUND');
  }
  const sources = [];
  for (const candidate of candidates) sources.push(await context.inspect(candidate));
  return sources;
}

async function sendFile(context, source) {
  const { failure } = context;
  const size = source.entry.size;
  context.acceptEntry(size);
  const stream = await context.call('download', { path: source.path });
  let iterator;
  const cancel = () => {
    try { stream?.cancel?.(); } finally { stream?.body?.destroy?.(); }
  };
  const unregister = context.addCancellation(cancel);
  try {
    if (!stream || !stream.body || typeof stream.body[Symbol.asyncIterator] !== 'function'
        || stream.contentLength != null && stream.contentLength !== size) throw failure('SCP_METADATA');
    const fresh = await context.inspect(source.path);
    if (!sameMetadata(source, fresh)) throw failure('SCP_METADATA');
    await sendTime(context, source.entry);
    await context.writeRecord({ type: 'C', name: path.posix.basename(source.path), mode: source.entry.mode & 0o777, size });
    await context.readAck();
    let bytes = 0;
    iterator = stream.body[Symbol.asyncIterator]();
    for (;;) {
      const result = await context.race(iterator.next());
      context.check();
      if (result.done) break;
      const block = result.value;
      if (!Buffer.isBuffer(block) && !(block instanceof Uint8Array)) throw failure('SCP_METADATA');
      if (bytes + block.byteLength > size) throw failure('SCP_METADATA');
      const buffer = Buffer.isBuffer(block) ? block : Buffer.from(block.buffer, block.byteOffset, block.byteLength);
      for (let offset = 0; offset < buffer.length; offset += 64 * 1024) {
        const part = buffer.subarray(offset, Math.min(offset + 64 * 1024, buffer.length));
        await context.writer.writePayload(part);
        bytes += part.length;
        context.traffic(0, part.length);
      }
    }
    if (bytes !== size) throw failure('SCP_METADATA');
    if (!sameMetadata(source, await context.inspect(source.path))) throw failure('SCP_METADATA');
    // The source's zero byte terminates the exact payload; it is not a second
    // header acknowledgement. Only the peer's following ACK completes the file.
    await context.writeAck();
    await context.readAck();
  } finally {
    unregister();
    try { cancel(); } catch {}
    // A broken async iterator may never settle return(); cancellation above is
    // authoritative, and teardown must not wait on a non-cooperative iterator.
    try { Promise.resolve(iterator?.return?.()).catch(() => {}); } catch {}
  }
}

async function sendEntry(context, source, depth) {
  if (depth > context.maxDepth) throw context.failure('SCP_LIMIT');
  const fresh = await context.inspect(source.path);
  if (!sameMetadata(source, fresh)) throw context.failure('SCP_METADATA');
  if (source.kind === 'file') { await sendFile(context, source); return; }
  if (!context.command.recursive) throw context.failure('SCP_RECURSIVE');
  context.acceptEntry();
  await sendTime(context, source.entry);
  await context.writeRecord({ type: 'D', name: path.posix.basename(source.path), mode: source.entry.mode & 0o777, size: 0 });
  await context.readAck();
  const entries = await context.list(source.path);
  for (const entry of entries) {
    const kind = context.entryKind(entry);
    await sendEntry(context, { path: path.posix.join(source.path, entry.name), kind, entry }, depth + 1);
  }
  const after = await context.inspect(source.path);
  if (after.kind !== 'dir') throw context.failure('SCP_UNSAFE_TYPE');
  await context.writeRecord({ type: 'E' });
  await context.readAck();
}

async function runDownloadSession(context) {
  const sources = await expandSources(context);
  for (const source of sources) {
    if (source.kind === 'dir' && !context.command.recursive) throw context.failure('SCP_RECURSIVE');
  }
  await context.readAck();
  for (const source of sources) await sendEntry(context, source, 1);
}

module.exports = { runDownloadSession };
