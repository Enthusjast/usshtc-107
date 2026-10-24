'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { quotePosix } = require('../electron/exec-codec');
const { MAX_TRANSFER_BYTES, DEFAULT_TIMEOUT_MS } = require('./config.cjs');

// ssh2 caps SSH packets at 35,000 bytes. Upload data is inside one exec
// request, so leave room for base64 expansion and two 4KiB quoted paths.
const CHUNK_BYTES = 16 * 1024;
// Download data uses fragmentable channel packets, not the exec request.
const DOWNLOAD_CHUNK_BYTES = 512 * 1024;
function failure(code) { return Object.assign(new Error(code), { code }); }
function remotePath(value) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > 4096
      || /[\u0000-\u001f\u007f]/.test(value)) throw failure('TRANSFER_PATH');
  // Prefix relative names so leading '-' cannot become an option to any utility.
  return value.startsWith('/') ? value : `./${value}`;
}
function scopeFor({ maxBytes = MAX_TRANSFER_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS, signal }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_TRANSFER_BYTES
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60 * 60 * 1000) {
    throw failure('TRANSFER_LIMIT');
  }
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, timeoutMs);
  return {
    maxBytes, signal: controller.signal,
    check() {
      if (signal?.aborted) throw failure('CLI_ABORTED');
      if (controller.signal.aborted || Date.now() >= deadline) throw failure('CLI_TIMEOUT');
    },
    async exec(transport, command) {
      this.check();
      try {
        return await transport.exec(command, { signal: controller.signal,
          timeoutMs: Math.max(1, Math.min(60000, deadline - Date.now())) });
      } catch (error) {
        this.check();
        throw error;
      }
    },
    close() { clearTimeout(timer); signal?.removeEventListener('abort', abort); },
  };
}
async function hashHandle(handle, size, scope) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  for (let offset = 0; offset < size;) {
    scope.check();
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (!bytesRead) throw failure('TRANSFER_CHANGED');
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if ((await handle.stat()).size !== size) throw failure('TRANSFER_CHANGED');
  return hash.digest('hex');
}
async function remoteInfo(transport, name, scope) {
  const q = quotePosix(name);
  const count = Math.ceil((scope.maxBytes + 1) / CHUNK_BYTES);
  // Bound hashing even if a remote writer grows the source after stat. Hash
  // input uses redirection, so unusual filenames never enter sha256sum output.
  const command = `[ -f ${q} ] && s=$(stat -Lc '%s' -- ${q}) && `
    + `[ "$s" -le ${scope.maxBytes} ] && `
    + `h=$(dd if=${q} bs=${CHUNK_BYTES} count=${count} 2>/dev/null | sha256sum) && `
    + `e=$(stat -Lc '%s' -- ${q}) && [ "$s" = "$e" ] && printf '%s %s\\n' "$s" "\${h%% *}"`;
  const output = (await scope.exec(transport, command)).toString('ascii').trim();
  const match = /^(0|[1-9]\d*) ([a-f0-9]{64})$/.exec(output);
  if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) > scope.maxBytes) throw failure('TRANSFER_METADATA');
  return { size: Number(match[1]), hash: match[2] };
}
async function removeRemote(transport, name) {
  // Cancellation must not cancel cleanup too. Never retry a data command.
  try { await transport.exec(`rm -f -- ${quotePosix(name)}`, { timeoutMs: 5000 }); } catch { /* disconnected remote may retain only a hidden temporary file */ }
}
async function upload(options) {
  const scope = scopeFor(options);
  let source;
  let temporary;
  let owned = false;
  try {
    const destination = remotePath(options.remotePath);
    source = await fs.open(options.localPath, 'r');
    const stat = await source.stat();
    if (!stat.isFile() || stat.size > scope.maxBytes) throw failure('TRANSFER_LIMIT');
    const before = await hashHandle(source, stat.size, scope);
    const directory = path.posix.dirname(destination);
    temporary = `${directory}/.usshtc107-${crypto.randomUUID()}.part`;
    await scope.exec(options.transport, `[ ! -e ${quotePosix(destination)} ] && [ ! -L ${quotePosix(destination)} ] && `
      + `(umask 077; set -C; : > ${quotePosix(temporary)})`);
    owned = true;
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    const sent = crypto.createHash('sha256');
    for (let offset = 0; offset < stat.size;) {
      scope.check();
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (!bytesRead) throw failure('TRANSFER_CHANGED');
      const bytes = buffer.subarray(0, bytesRead);
      sent.update(bytes);
      const encoded = bytes.toString('base64');
      // Offset verification prevents appending to an altered temporary file.
      await scope.exec(options.transport, `[ "$(stat -Lc '%s' -- ${quotePosix(temporary)})" = ${offset} ] && `
        + `printf '%s' ${quotePosix(encoded)} | base64 -d >> ${quotePosix(temporary)}`);
      offset += bytesRead;
    }
    if (sent.digest('hex') !== before || await hashHandle(source, stat.size, scope) !== before) throw failure('TRANSFER_CHANGED');
    const remote = await remoteInfo(options.transport, temporary, scope);
    if (remote.size !== stat.size || remote.hash !== before) throw failure('TRANSFER_HASH');
    // GNU ln -T treats an existing directory as a destination conflict, never as
    // a request to create a file inside it. A hard link is atomic/no-clobber.
    await scope.exec(options.transport, `ln -T -- ${quotePosix(temporary)} ${quotePosix(destination)}`);
    return { bytes: stat.size, sha256: before };
  } finally {
    scope.close();
    try { await source?.close(); }
    finally { if (owned) await removeRemote(options.transport, temporary); }
  }
}
async function download(options) {
  const scope = scopeFor(options);
  let target;
  let temporary;
  try {
    const source = remotePath(options.remotePath);
    const destination = path.resolve(options.localPath);
    // Early failure is friendly; link below is the actual race-free guard.
    try { await fs.lstat(destination); throw failure('TRANSFER_EXISTS'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const before = await remoteInfo(options.transport, source, scope);
    temporary = path.join(path.dirname(destination), `.usshtc107-${crypto.randomUUID()}.part`);
    target = await fs.open(temporary, 'wx+', 0o600);
    const hash = crypto.createHash('sha256');
    for (let offset = 0; offset < before.size; offset += DOWNLOAD_CHUNK_BYTES) {
      const encoded = (await scope.exec(options.transport,
        `dd if=${quotePosix(source)} bs=${DOWNLOAD_CHUNK_BYTES} skip=${offset / DOWNLOAD_CHUNK_BYTES} count=1 2>/dev/null | base64`)).toString('ascii').replace(/\s/g, '');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw failure('TRANSFER_ENCODING');
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length !== Math.min(DOWNLOAD_CHUNK_BYTES, before.size - offset)) throw failure('TRANSFER_CHANGED');
      hash.update(bytes);
      for (let written = 0; written < bytes.length;) {
        scope.check();
        const result = await target.write(bytes, written, bytes.length - written, offset + written);
        if (!result.bytesWritten) throw failure('TRANSFER_IO');
        written += result.bytesWritten;
      }
    }
    const after = await remoteInfo(options.transport, source, scope);
    if (after.size !== before.size || after.hash !== before.hash || hash.digest('hex') !== before.hash
        || await hashHandle(target, before.size, scope) !== before.hash) throw failure('TRANSFER_HASH');
    await target.sync();
    scope.check();
    await fs.link(temporary, destination);
    return { bytes: before.size, sha256: before.hash };
  } finally {
    scope.close();
    try { await target?.close(); }
    finally {
      if (temporary) await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
}
module.exports = { upload, download, remotePath, CHUNK_BYTES };
