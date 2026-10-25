'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { Readable } = require('node:stream');
const { upload } = require('../file-transfer/orchestrator');
const { validateName } = require('./protocol');

function childPath(context, directory, name) {
  validateName(name);
  if (name.includes('\\')) throw context.failure('SCP_PATH');
  const result = path.posix.join(directory, name);
  if (directory !== '/' && !result.startsWith(`${directory}/`)) throw context.failure('SCP_PATH');
  return result;
}

function guardApi(context, expectedSize, destination) {
  const regular = async remotePath => {
    const info = await context.inspect(remotePath);
    if (info.kind !== 'file') throw context.failure('SCP_UNSAFE_TYPE');
    return info;
  };
  const directory = async remotePath => {
    const info = await context.inspect(remotePath);
    if (info.kind !== 'dir') throw context.failure('SCP_NOT_DIRECTORY');
  };
  const guarded = {
    remoteTargetMayBeChanged: false,
    async list(input) { return context.list(input.path); },
    async initMultipartUpload(input) {
      await directory(input.path);
      return context.call('initMultipartUpload', input);
    },
    async upload(input) {
      await context.target(input.path, { enforceNoOverwrite: input.path === destination });
      if (input.path === destination) guarded.remoteTargetMayBeChanged = true;
      const source = input.source;
      const active = Readable.from((async function* () {
        try {
          for await (const block of source) {
            context.check();
            context.touch();
            yield block;
          }
        } finally { source.destroy?.(); }
      })(), { objectMode: false, highWaterMark: 64 * 1024 });
      const unregister = context.addCancellation(() => { active.destroy(); source.destroy?.(); });
      try { return await context.call('upload', { ...input, source: active }); }
      finally { unregister(); active.destroy(); source.destroy?.(); }
    },
    async mergeFileChunks(input) {
      await directory(input.path);
      await context.target(childPath(context, input.path, input.name), { enforceNoOverwrite: false });
      return context.call('mergeFileChunks', input);
    },
    async download(input) {
      await regular(input.path);
      const stream = await context.call('download', input);
      if (!stream?.body || typeof stream.body[Symbol.asyncIterator] !== 'function') {
        stream?.cancel?.();
        throw context.failure('SCP_METADATA');
      }
      let iterator;
      const cancel = () => { try { stream.cancel?.(); } finally { stream.body.destroy?.(); } };
      const unregister = context.addCancellation(cancel);
      const body = (async function* () {
        try {
          iterator = stream.body[Symbol.asyncIterator]();
          for (;;) {
            const result = await context.race(iterator.next());
            context.check();
            if (result.done) return;
            context.touch();
            yield result.value;
          }
        } finally {
          unregister();
          try { cancel(); } catch {}
          try { Promise.resolve(iterator?.return?.()).catch(() => {}); } catch {}
        }
      })();
      return { ...stream, body, cancel() { unregister(); cancel(); } };
    },
    async move(input) {
      const staging = await regular(input.fromPath);
      if (staging.entry.size !== expectedSize) throw context.failure('SCP_METADATA');
      await context.target(input.toPath);
      const result = await context.call('move', input);
      const published = await regular(input.toPath);
      if (published.entry.size !== expectedSize) throw context.failure('SCP_METADATA');
      return result;
    },
  };
  return guarded;
}

async function verifyPublication(context, api, destination, size, expectedHash) {
  if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedHash)) throw context.failure('SCP_METADATA');
  const metadata = await context.inspect(destination);
  if (metadata.kind !== 'file' || metadata.entry.size !== size) throw context.failure('SCP_METADATA');
  const stream = await api.download({ path: destination });
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    if (stream.contentLength != null && stream.contentLength !== size) throw context.failure('SCP_METADATA');
    for await (const block of stream.body) {
      context.check();
      if (!Buffer.isBuffer(block) && !(block instanceof Uint8Array)) throw context.failure('SCP_METADATA');
      bytes += block.length;
      if (bytes > size) throw context.failure('SCP_METADATA');
      hash.update(block);
    }
    if (bytes !== size || hash.digest('hex') !== expectedHash) throw context.failure('SCP_METADATA');
    const after = await context.inspect(destination);
    if (after.kind !== 'file' || after.entry.size !== size || after.entry.mode !== metadata.entry.mode
        || after.entry.mtime !== metadata.entry.mtime) throw context.failure('SCP_METADATA');
  } finally { stream.cancel?.(); }
}

async function receiveFile(context, record, destination) {
  context.acceptEntry(record.size);
  await context.target(destination);
  const temporary = await context.temporary(record.size);
  let publicationApi;
  try {
    // A file-header ACK means the receiver is ready for exactly this body, not
    // that the API has accepted or published it.
    await context.writeAck();
    let offset = 0;
    await context.reader.readPayload(record.size, async block => {
      for (let written = 0; written < block.length;) {
        context.check();
        const result = await temporary.handle.write(block, written, block.length - written, offset + written);
        if (!result.bytesWritten) throw context.failure('SCP_IO');
        written += result.bytesWritten;
      }
      offset += block.length;
      context.traffic(block.length, 0);
    });
    await temporary.closeHandle();
    await context.readAck();
    await context.target(destination);
    publicationApi = guardApi(context, record.size, destination);
    const result = await upload({ api: publicationApi, cluster: context.cluster, remotePath: destination, localPath: temporary.path,
      signal: context.signal, assertCurrent: () => { context.check(); context.touch(); },
      timeoutMs: Math.max(1, context.deadline - Date.now()),
      maxBytes: context.maxFileBytes, overwrite: !context.noOverwrite, overwriteInPlace: true,
      onProgress: context.touch }, 1024 ** 3);
    context.retainRemoteTemps(result.remoteTempsRetained);
    await verifyPublication(context, publicationApi, destination, record.size, result.sha256);
  } catch (error) {
    context.retainRemoteTemps(error?.remoteTempsRetained);
    if (publicationApi?.remoteTargetMayBeChanged) error.remoteTargetMayBeChanged = true;
    throw error;
  } finally {
    try { await context.removeTemporary(temporary); }
    catch (error) {
      if (publicationApi?.remoteTargetMayBeChanged) error.remoteTargetMayBeChanged = true;
      throw error;
    }
  }
  // Cleanup and verified final publication precede the only completion ACK.
  await context.writeAck();
}

async function runUploadSession(context) {
  const { command, failure } = context;
  const destination = await context.resolvePath(command.path);
  const initial = await context.inspect(destination, { allowMissing: true });
  const requiresDirectory = command.targetDirectory || command.path.endsWith('/');
  if (requiresDirectory && initial.kind !== 'dir') throw failure('SCP_NOT_DIRECTORY');
  if (initial.kind === 'file' && context.noOverwrite) throw failure('SCP_EXISTS');
  const intoDirectory = initial.kind === 'dir';
  const stack = [];
  let rootEntries = 0;
  let pendingTime = false;
  // Destination and every existing ancestor have been validated before this ACK.
  await context.writeAck();
  // C and root E acknowledgements complete entries, not the session: one SCP
  // invocation may send several roots. Clients then half-close protocol input
  // and keep the channel open for our exit status; do not wait for channel close.
  for (;;) {
    const record = await context.readRecord();
    if (record === null) {
      if (stack.length || pendingTime || rootEntries === 0) throw failure('SCP_PROTOCOL');
      return;
    }
    if (record.type === 'T') {
      if (pendingTime) throw failure('SCP_PROTOCOL');
      pendingTime = true;
      await context.writeAck();
      continue;
    }
    if (record.type === 'E') {
      if (pendingTime || !stack.length) throw failure('SCP_PROTOCOL');
      stack.pop();
      await context.writeAck();
      continue;
    }
    if (record.type !== 'C' && record.type !== 'D') throw failure('SCP_PROTOCOL');
    pendingTime = false; // T is parsed and acknowledged, never applied to storage.
    let target;
    if (stack.length) target = childPath(context, stack.at(-1), record.name);
    else {
      rootEntries += 1;
      if (!intoDirectory && rootEntries > 1) throw failure('SCP_PROTOCOL');
      target = intoDirectory ? childPath(context, destination, record.name) : destination;
    }
    if (record.type === 'C') {
      if (stack.length + 1 > context.maxDepth) throw failure('SCP_LIMIT');
      await receiveFile(context, record, target);
      continue;
    }
    if (!command.recursive) throw failure('SCP_RECURSIVE');
    if (stack.length + 1 > context.maxDepth) throw failure('SCP_LIMIT');
    context.acceptEntry();
    const existing = await context.target(target, { directory: true });
    if (!existing.kind) await context.call('mkdir', { path: target });
    const created = await context.inspect(target);
    if (created.kind !== 'dir') throw failure('SCP_NOT_DIRECTORY');
    stack.push(target);
    await context.writeAck();
  }
}

module.exports = { runUploadSession };
