'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { fileKind } = require('../portal-api/file-api');

const MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const SAFE_CODES = new Set(['TRANSFER_PATH', 'TRANSFER_LIMIT', 'TRANSFER_EXISTS', 'TRANSFER_CHANGED',
  'TRANSFER_METADATA', 'TRANSFER_HASH', 'TRANSFER_IO', 'TRANSFER_DIRECTORY', 'TRANSFER_TEMP_CONFLICT', 'TRANSFER_UNSAFE_TYPE',
  'PROFILE_CHANGED', 'PORTAL_AUTH', 'PORTAL_NETWORK', 'PORTAL_TIMEOUT', 'PORTAL_PERMISSION',
  'PORTAL_NOT_FOUND', 'PORTAL_UNIMPLEMENTED', 'PORTAL_QUOTA', 'PORTAL_UNKNOWN', 'PORTAL_CANCELLED']);
function failure(code) { return Object.assign(new Error(code), { code }); }
function checkedPath(value) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 4096
      || /[\u0000-\u001f\u007f]/.test(value) || value.split(/[\\/]/).includes('..')) throw failure('TRANSFER_PATH');
  return value;
}
function remotePath(value) {
  checkedPath(value);
  if (!value.startsWith('/') || value.includes('\\')) throw failure('TRANSFER_PATH');
  const result = path.posix.normalize(value);
  if (result === '/' || value.endsWith('/')) throw failure('TRANSFER_PATH');
  return result;
}
function localPath(value) { return path.resolve(checkedPath(value)); }
function scopeFor(input, maxAllowedBytes = MAX_BYTES) {
  const maxBytes = input.maxBytes ?? MAX_BYTES;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxAllowedBytes) || maxAllowedBytes < 1 || maxAllowedBytes > 1024 * 1024 * 1024
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > maxAllowedBytes
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60 * 60 * 1000) throw failure('TRANSFER_LIMIT');
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const abort = () => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  const scope = {
    maxBytes, signal: controller.signal,
    check() {
      if (input.signal?.aborted) throw failure('PORTAL_CANCELLED');
      if (controller.signal.aborted || Date.now() >= deadline) throw failure('PORTAL_TIMEOUT');
      input.assertCurrent?.(input.scope);
    },
    async call(method, args) {
      this.check();
      try {
        const result = await input.api[method]({ ...args, cluster: input.cluster, signal: controller.signal,
          scope: input.scope, assertCurrent: input.assertCurrent,
          timeoutMs: Math.max(1, deadline - Date.now()), maxBytes });
        this.check();
        return result;
      } catch (error) { this.check(); throw error; }
    },
    close() { clearTimeout(timer); input.signal?.removeEventListener('abort', abort); },
  };
  return scope;
}
async function hashRange(handle, start, size, scope, expectedSize) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, size)));
  for (let offset = 0; offset < size;) {
    scope.check();
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), start + offset);
    if (!bytesRead) throw failure('TRANSFER_CHANGED');
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if ((await handle.stat()).size !== expectedSize) throw failure('TRANSFER_CHANGED');
  return hash.digest('hex');
}
function sourceRange(handle, start, size, scope) {
  // fs.ReadStream.destroy() closes even an autoClose:false descriptor. This
  // positional reader leaves ownership with the orchestrator's final hash.
  return Readable.from((async function* () {
    for (let offset = 0; offset < size;) {
      scope.check();
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start + offset);
      scope.check();
      if (!bytesRead) throw failure('TRANSFER_CHANGED');
      offset += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  })(), { objectMode: false, highWaterMark: 64 * 1024 });
}
async function inspectRemote(scope, absolute, { allowMissing = false } = {}) {
  if (absolute === '/') return 'dir';
  const parts = absolute.slice(1).split('/');
  let directory = '/';
  for (let index = 0; index < parts.length; index++) {
    const entries = await scope.call('list', { path: directory });
    if (!Array.isArray(entries)) throw failure('TRANSFER_METADATA');
    const entry = entries.find(item => item?.name === parts[index]);
    if (!entry) {
      if (allowMissing && index === parts.length - 1) return null;
      throw failure('PORTAL_NOT_FOUND');
    }
    const kind = fileKind(entry);
    if (kind !== 'file' && kind !== 'dir') throw failure('TRANSFER_UNSAFE_TYPE');
    if (index < parts.length - 1 && kind !== 'dir') throw failure('TRANSFER_DIRECTORY');
    directory = path.posix.join(directory, entry.name);
    if (index === parts.length - 1) return kind;
  }
  throw failure('TRANSFER_PATH');
}
async function requireRemoteFile(scope, source) {
  if (await inspectRemote(scope, source) !== 'file') throw failure('TRANSFER_DIRECTORY');
}
async function remoteHash(scope, source, { handle, expectedSize, onBytes } = {}) {
  // list exposes lstat mode; getFileType follows links and is not no-follow proof.
  // These checks cannot make the portal's subsequent operation atomic/no-follow.
  await requireRemoteFile(scope, source);
  const stream = await scope.call('download', { path: source });
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    if (stream.contentLength !== null && stream.contentLength !== undefined
        && (!Number.isSafeInteger(stream.contentLength) || stream.contentLength < 0 || stream.contentLength > scope.maxBytes)) throw failure('TRANSFER_LIMIT');
    for await (const block of stream.body) {
      scope.check();
      if (bytes + block.length > scope.maxBytes) throw failure('TRANSFER_LIMIT');
      if (expectedSize !== undefined && bytes + block.length > expectedSize) throw failure('TRANSFER_CHANGED');
      hash.update(block);
      if (handle) {
        for (let written = 0; written < block.length;) {
          scope.check();
          const result = await handle.write(block, written, block.length - written, bytes + written);
          if (!result.bytesWritten) throw failure('TRANSFER_IO');
          written += result.bytesWritten;
        }
      }
      bytes += block.length;
      onBytes?.(bytes);
    }
    scope.check();
    if (stream.contentLength != null && bytes !== stream.contentLength
        || expectedSize !== undefined && bytes !== expectedSize) throw failure('TRANSFER_CHANGED');
    await requireRemoteFile(scope, source);
    return { bytes, sha256: hash.digest('hex') };
  } finally { stream.cancel?.(); }
}
async function targetPreflight(scope, destination, overwrite) {
  const kind = await inspectRemote(scope, destination, { allowMissing: true });
  if (!kind) return false;
  if (!overwrite) throw failure('TRANSFER_EXISTS');
  if (kind !== 'file') throw failure('TRANSFER_DIRECTORY');
  return true;
}
function safeError(error, remoteTempsRetained, remoteTargetMayBeChanged = false) {
  const result = failure(SAFE_CODES.has(error?.code) ? error.code : 'TRANSFER_IO');
  result.remoteTempsRetained = remoteTempsRetained;
  result.remoteTargetMayBeChanged = remoteTargetMayBeChanged;
  return result;
}
async function upload(input, maxAllowedBytes = MAX_BYTES) {
  const scope = scopeFor(input, maxAllowedBytes);
  let source;
  let remoteTempsRetained = false;
  let remoteTargetMayBeChanged = false;
  let mode = 'single';
  let bytes = 0;
  let total = 0;
  const progress = phase => input.onProgress?.({ bytes, total, phase, mode });
  try {
    const destination = remotePath(input.remotePath);
    const filename = localPath(input.localPath);
    source = await fs.open(filename, 'r');
    const stat = await source.stat();
    if (!stat.isFile()) throw failure('TRANSFER_DIRECTORY');
    if (!Number.isSafeInteger(stat.size) || stat.size > scope.maxBytes) throw failure('TRANSFER_LIMIT');
    total = stat.size;
    progress('hashing');
    const before = await hashRange(source, 0, total, scope, total);
    await targetPreflight(scope, destination, input.overwrite === true);
    const directory = path.posix.dirname(destination);
    const name = `.usshtc107-${crypto.randomUUID()}.part`;
    const staging = path.posix.join(directory, name);
    progress('negotiating');
    let multipart;
    // A failed/cancelled initialization may have allocated remote state. Its ownership
    // and expiry are not known, so never delete/reuse it or promise a rollback.
    remoteTempsRetained = true;
    try { multipart = await scope.call('initMultipartUpload', { path: directory, name }); }
    catch (error) {
      if (error?.code !== 'PORTAL_UNIMPLEMENTED') throw error;
      multipart = null;
    }
    if (multipart) {
      remotePath(`${multipart.tempFileDir.replace(/\/$/, '')}/chunk`);
      if (!Number.isSafeInteger(multipart.chunkSizeByte) || multipart.chunkSizeByte < 1
          || !Array.isArray(multipart.filesInfo)) throw failure('TRANSFER_METADATA');
      if (multipart.filesInfo.length) throw failure('TRANSFER_TEMP_CONFLICT');
    }
    mode = multipart && total >= multipart.chunkSizeByte ? 'multipart' : 'single';
    progress('uploading');
    if (mode === 'single') {
      await targetPreflight(scope, staging, false);
      await scope.call('upload', { path: staging, source: sourceRange(source, 0, total, scope), size: total, chunk: false, originPath: '' });
      bytes = total;
      progress('uploading');
    } else {
      for (let offset = 0, index = 1; offset < total; index++) {
        scope.check();
        const size = Math.min(multipart.chunkSizeByte, total - offset);
        const hash = await hashRange(source, offset, size, scope, total);
        const chunkName = `${hash}_${index}.scowuploadtemp`;
        const chunkPath = path.posix.join(multipart.tempFileDir, chunkName);
        await targetPreflight(scope, chunkPath, false);
        await targetPreflight(scope, staging, false);
        await scope.call('upload', { path: chunkPath,
          source: sourceRange(source, offset, size, scope), size, chunk: true, originPath: staging });
        offset += size;
        bytes = offset;
        progress('uploading');
      }
      await targetPreflight(scope, staging, false);
      await scope.call('mergeFileChunks', { path: directory, name, sizeByte: total });
    }
    progress('verifying');
    if (await hashRange(source, 0, total, scope, total) !== before) throw failure('TRANSFER_CHANGED');
    // Full streaming readback is also used for multipart, not just the small-file path.
    const readback = await remoteHash(scope, staging, { expectedSize: total });
    if (readback.sha256 !== before) throw failure('TRANSFER_HASH');
    if (await hashRange(source, 0, total, scope, total) !== before) throw failure('TRANSFER_CHANGED');
    progress('publishing');
    // Official API preflight is intentionally NOT an atomic remote no-clobber promise.
    // A concurrent creator can race this last check and the server's move operation.
    const exists = await targetPreflight(scope, destination, input.overwrite === true);
    await requireRemoteFile(scope, staging);
    if (exists && input.overwriteInPlace === true) {
      // Standard SCP permits in-place replacement. Plain SFTP rename does not.
      // Opt-in callers retain the verified staging file and must report that a
      // failed replacement may have truncated the destination, never a rollback.
      remoteTargetMayBeChanged = true;
      await scope.call('upload', { path: destination,
        source: sourceRange(source, 0, total, scope), size: total, chunk: false, originPath: '' });
      const published = await remoteHash(scope, destination, { expectedSize: total });
      if (published.sha256 !== before || await hashRange(source, 0, total, scope, total) !== before) throw failure('TRANSFER_HASH');
      remoteTargetMayBeChanged = false;
      remoteTempsRetained = true;
    } else {
      await scope.call('move', { fromPath: staging, toPath: destination });
      // Init may leave its directory even after merge. No verified cleanup contract exists.
      remoteTempsRetained = Boolean(multipart);
    }
    progress('completed');
    return { bytes: total, sha256: before, mode, remoteTempsRetained };
  } catch (error) {
    try { scope.check(); } catch (interruption) { error = interruption; }
    throw safeError(error, remoteTempsRetained, remoteTargetMayBeChanged);
  }
  finally { scope.close(); await source?.close(); }
}
async function download(input) {
  const scope = scopeFor(input);
  let target;
  let temporary;
  let bytes = 0;
  let total = 0;
  const mode = 'single';
  const progress = phase => input.onProgress?.({ bytes, total, phase, mode });
  try {
    const source = remotePath(input.remotePath);
    const destination = localPath(input.localPath);
    try {
      const existing = await fs.lstat(destination);
      if (!input.overwrite) throw failure('TRANSFER_EXISTS');
      if (!existing.isFile()) throw failure('TRANSFER_DIRECTORY');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    progress('hashing');
    const before = await remoteHash(scope, source);
    total = before.bytes;
    temporary = path.join(path.dirname(destination), `.usshtc107-${crypto.randomUUID()}.part`);
    target = await fs.open(temporary, 'wx+', 0o600);
    progress('downloading');
    const received = await remoteHash(scope, source, { handle: target, expectedSize: total,
      onBytes(value) { bytes = value; progress('downloading'); } });
    if (received.sha256 !== before.sha256) throw failure('TRANSFER_HASH');
    progress('verifying');
    const after = await remoteHash(scope, source, { expectedSize: total });
    if (after.sha256 !== before.sha256 || await hashRange(target, 0, total, scope, total) !== before.sha256) throw failure('TRANSFER_HASH');
    await target.sync();
    await target.close();
    target = null;
    scope.check();
    progress('publishing');
    await requireRemoteFile(scope, source);
    if (input.overwrite === true) await fs.rename(temporary, destination);
    else {
      try { await fs.link(temporary, destination); }
      catch (error) { if (error.code === 'EEXIST') throw failure('TRANSFER_EXISTS'); throw error; }
    }
    progress('completed');
    return { bytes: total, sha256: before.sha256, mode, remoteTempsRetained: false };
  } catch (error) {
    try { scope.check(); } catch (interruption) { error = interruption; }
    throw safeError(error, false);
  }
  finally {
    scope.close();
    try { await target?.close(); }
    finally { if (temporary) await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw safeError(error, false); }); }
  }
}
module.exports = { upload, download, remotePath, localPath, MAX_BYTES, DEFAULT_TIMEOUT_MS };
