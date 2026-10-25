'use strict';

const path = require('node:path');
const { ScpProtocolReader, ScpProtocolWriter, validateName } = require('./protocol');
const { parseScpCommand } = require('./command-parser');
const { allocateTempFile } = require('./temp-file');
const { runDownloadSession } = require('./download-session');
const { runUploadSession } = require('./upload-session');
const { fileKind } = require('../portal-api/file-api');

const MAX_FILE_BYTES = 1024 ** 3;
const MAX_SESSION_BYTES = 8 * 1024 ** 3;
const MAX_ENTRIES = 10_000;
const MAX_DEPTH = 32;
const MAX_RECORDS = 100_000;
const IDLE_MS = 30_000;
const LIFETIME_MS = 60 * 60 * 1000;
const HISTORY_REASONS = new Set(['completed', 'user_disconnect', 'proxy_stop', 'network_error', 'auth_error',
  'remote_not_ready', 'timeout', 'output_limit', 'app_exit', 'interrupted']);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const ERRORS = Object.freeze({
  SCP_PATH: 'SCP path is unsafe or unsupported; use an absolute path without traversal or shell expansion.',
  SCP_NOT_FOUND: 'SCP path was not found; check the path and its parent directories.',
  SCP_NOT_DIRECTORY: 'SCP destination or parent is not a directory; choose a directory or remove -d.',
  SCP_RECURSIVE: 'SCP directory transfer requires the -r option.',
  SCP_UNSAFE_TYPE: 'SCP refuses links and special files; choose a regular file or directory.',
  SCP_METADATA: 'SCP metadata is incomplete or changed; check the remote file and retry.',
  SCP_EXISTS: 'SCP overwrite is disabled; choose a new destination or enable overwrite in the profile.',
  SCP_LIMIT: 'SCP transfer exceeds a file, entry, depth, or session limit; transfer fewer or smaller files.',
  SCP_TEMP_LIMIT: 'SCP temporary storage quota is full; finish other transfers and retry.',
  SCP_TEMP_SPACE: 'SCP needs more free local temporary space; free disk space and retry.',
  SCP_TEMP_UNSAFE: 'SCP temporary directory is not private or is a link; choose an owned private directory (mode 0700 on POSIX).',
  SCP_TIMEOUT: 'SCP transfer timed out; check the connection and retry.',
  SCP_CANCELLED: 'SCP transfer was cancelled; reconnect and retry when ready.',
  SCP_PROFILE_CHANGED: 'SCP connection settings changed; reconnect before retrying.',
  SCP_PERMISSION: 'SCP permission was denied; check remote directory and account permissions.',
  SCP_AUTH: 'SCP login expired; sign in again and reconnect.',
  SCP_UNSUPPORTED: 'SCP requires a portal file API that is unavailable; check server support.',
  SCP_NETWORK: 'SCP portal request failed; check the connection and retry.',
  SCP_PROTOCOL: 'SCP protocol is incomplete or unsupported; retry with a legacy SCP client using -O.',
  SCP_IO: 'SCP file transfer failed; check storage, permissions, and the connection before retrying.',
});

function failure(code) { return Object.assign(new Error(code), { code }); }
function safeCode(error) {
  const code = error?.code;
  if (Object.hasOwn(ERRORS, code)) return code;
  if (['TRANSFER_PATH', 'SCP_INVALID_COMMAND', 'SCP_INVALID_GLOB'].includes(code)) return 'SCP_PATH';
  if (['TRANSFER_LIMIT', 'PORTAL_QUOTA', 'SCP_BUFFER_LIMIT'].includes(code)) return 'SCP_LIMIT';
  if (['ENOSPC', 'EDQUOT'].includes(code)) return 'SCP_TEMP_SPACE';
  if (code === 'TRANSFER_EXISTS') return 'SCP_EXISTS';
  if (code === 'TRANSFER_UNSAFE_TYPE') return 'SCP_UNSAFE_TYPE';
  if (['TRANSFER_CHANGED', 'TRANSFER_METADATA', 'TRANSFER_HASH', 'TRANSFER_TEMP_CONFLICT'].includes(code)) return 'SCP_METADATA';
  if (['PORTAL_CANCELLED', 'ABORT_ERR'].includes(code)) return 'SCP_CANCELLED';
  if (['PORTAL_TIMEOUT', 'SCP_TIMEOUT'].includes(code)) return 'SCP_TIMEOUT';
  if (code === 'PROFILE_CHANGED') return 'SCP_PROFILE_CHANGED';
  if (code === 'PORTAL_AUTH') return 'SCP_AUTH';
  if (code === 'PORTAL_PERMISSION') return 'SCP_PERMISSION';
  if (code === 'PORTAL_NOT_FOUND') return 'SCP_NOT_FOUND';
  if (code === 'PORTAL_UNIMPLEMENTED') return 'SCP_UNSUPPORTED';
  if (code === 'PORTAL_NETWORK') return 'SCP_NETWORK';
  if (typeof code === 'string' && code.startsWith('SCP_')) return 'SCP_PROTOCOL';
  return 'SCP_IO';
}
function checkedPath(value) {
  if (typeof value !== 'string' || !value || !value.isWellFormed() || Buffer.byteLength(value) > 4096
      || CONTROL.test(value) || value.includes('\\') || value.split('/').includes('..')) throw failure('SCP_PATH');
  return value;
}
function entryKind(entry) {
  if (!entry || typeof entry !== 'object') throw failure('SCP_METADATA');
  validateName(entry.name);
  if (entry.name.includes('\\') || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0xffffffff
      || !Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.mtime !== 'string'
      || !Number.isFinite(Date.parse(entry.mtime))) throw failure('SCP_METADATA');
  const kind = fileKind(entry);
  if (kind === 'file' || kind === 'dir') return kind;
  throw failure('SCP_UNSAFE_TYPE');
}

function startScpSession(options) {
  const { channel, api, cluster, tempDirectory, assertCurrent, onTraffic } = options;
  const command = typeof options.command === 'string' ? parseScpCommand(options.command) : options.command;
  const controller = new AbortController();
  const started = Date.now();
  const deadline = started + LIFETIME_MS;
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
  const protocolOptions = { signal: controller.signal, timeoutMs: IDLE_MS,
    maxFileBytes: Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0 ? Math.min(maxFileBytes, MAX_FILE_BYTES) : MAX_FILE_BYTES };
  const reader = new ScpProtocolReader(channel, protocolOptions);
  const writer = new ScpProtocolWriter(channel, protocolOptions);
  const temporaries = new Set();
  const cancellations = new Set();
  const seenEntries = new Set();
  let idleTimer;
  let lifetimeTimer;
  let stopped = null;
  let closeReason = null;
  let completed = false;
  let records = 0;
  let acceptedEntries = 0;
  let sessionBytes = 0;
  let remoteTempsRetained = false;
  let remoteTargetMayBeChanged = false;

  const close = reason => {
    if (completed || stopped) return;
    closeReason = HISTORY_REASONS.has(reason) ? reason : 'interrupted';
    stopped = reason === 'timeout' || reason === 'SCP_TIMEOUT' ? 'SCP_TIMEOUT'
      : reason === 'profile-changed' || reason === 'PROFILE_CHANGED' || reason === 'SCP_PROFILE_CHANGED'
        ? 'SCP_PROFILE_CHANGED' : 'SCP_CANCELLED';
    controller.abort();
    reader.close();
    writer.close();
    for (const cancel of [...cancellations]) { try { cancel(); } catch { /* Cancellation remains best effort for an already failed transport. */ } }
  };
  const touch = () => {
    if (completed || stopped) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => close('timeout'), IDLE_MS);
    idleTimer.unref?.();
  };
  const check = () => {
    if (stopped || controller.signal.aborted) throw failure(stopped || 'SCP_CANCELLED');
    if (Date.now() >= deadline) { close('timeout'); throw failure('SCP_TIMEOUT'); }
    try { assertCurrent?.(); } catch { throw failure('SCP_PROFILE_CHANGED'); }
  };
  const race = promise => {
    const pending = Promise.resolve(promise);
    pending.catch(() => {});
    check();
    return new Promise((resolve, reject) => {
      const abort = () => { cleanup(); reject(failure(stopped || 'SCP_CANCELLED')); };
      const cleanup = () => controller.signal.removeEventListener('abort', abort);
      controller.signal.addEventListener('abort', abort, { once: true });
      pending.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
      if (controller.signal.aborted) abort();
    });
  };
  const frame = () => { check(); if (++records > MAX_RECORDS) throw failure('SCP_LIMIT'); touch(); };
  const context = {
    command, api, cluster, maxFileBytes, noOverwrite: options.noOverwrite === true,
    signal: controller.signal, deadline, reader, writer, check, race, touch, failure,
    maxDepth: MAX_DEPTH, entryKind,
    retainRemoteTemps(value) { remoteTempsRetained ||= Boolean(value); },
    addCancellation(cancel) { cancellations.add(cancel); return () => cancellations.delete(cancel); },
    traffic(sent, received) {
      check();
      touch();
      try { onTraffic?.({ sent, received }); } catch { /* Observability cannot corrupt a transfer. */ }
    },
    acceptEntry(size = 0) {
      check();
      if (++acceptedEntries > MAX_ENTRIES || !Number.isSafeInteger(size) || size < 0 || size > maxFileBytes
          || sessionBytes + size > MAX_SESSION_BYTES) throw failure('SCP_LIMIT');
      sessionBytes += size;
    },
    async call(method, args = {}) {
      check();
      if (typeof api?.[method] !== 'function') throw failure('SCP_UNSUPPORTED');
      touch();
      const pending = Promise.resolve().then(() => {
        check();
        return api[method]({ ...args, cluster, signal: controller.signal,
          assertCurrent: () => { check(); touch(); },
          timeoutMs: Math.max(1, deadline - Date.now()),
          maxBytes: method === 'download' || method === 'upload' ? maxFileBytes : 1024 * 1024 });
      });
      // A late stream must not outlive cancellation even if an API implementation
      // resolves after its AbortSignal fired. All real requests also receive it.
      pending.then(result => { if (controller.signal.aborted) { try { result?.cancel?.(); } catch {} } }, () => {});
      const result = await race(pending);
      check();
      touch();
      return result;
    },
    async resolvePath(value) {
      checkedPath(value);
      let absolute = value;
      if (!value.startsWith('/')) {
        const home = await context.call('getHome');
        checkedPath(home);
        if (!home.startsWith('/') || path.posix.normalize(home) !== home) throw failure('SCP_METADATA');
        absolute = path.posix.join(home, value);
      }
      absolute = path.posix.normalize(absolute);
      checkedPath(absolute);
      if (!absolute.startsWith('/') || absolute.split('/').filter(Boolean).length > MAX_DEPTH) throw failure('SCP_LIMIT');
      return absolute;
    },
    async list(directory) {
      const entries = await context.call('list', { path: directory });
      if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) throw failure('SCP_LIMIT');
      const names = new Set();
      for (const entry of entries) {
        if (!entry || typeof entry.name !== 'string') throw failure('SCP_METADATA');
        validateName(entry.name);
        if (entry.name.includes('\\') || names.has(entry.name)) throw failure('SCP_METADATA');
        names.add(entry.name);
        seenEntries.add(path.posix.join(directory, entry.name));
        if (seenEntries.size > MAX_ENTRIES) throw failure('SCP_LIMIT');
      }
      return entries;
    },
    async inspect(absolute, { allowMissing = false } = {}) {
      checkedPath(absolute);
      if (!absolute.startsWith('/') || path.posix.normalize(absolute) !== absolute) throw failure('SCP_PATH');
      if (absolute === '/') return { path: '/', kind: 'dir', entry: null };
      const parts = absolute.slice(1).split('/');
      if (parts.length > MAX_DEPTH) throw failure('SCP_LIMIT');
      let directory = '/';
      for (let index = 0; index < parts.length; index++) {
        const entries = await context.list(directory);
        const entry = entries.find(item => item.name === parts[index]);
        if (!entry) {
          if (allowMissing && index === parts.length - 1) return { path: absolute, kind: null, entry: null };
          throw failure('SCP_NOT_FOUND');
        }
        const kind = entryKind(entry);
        directory = path.posix.join(directory, entry.name);
        if (index < parts.length - 1 && kind !== 'dir') throw failure('SCP_NOT_DIRECTORY');
        if (index === parts.length - 1) return { path: absolute, kind, entry };
      }
      throw failure('SCP_PATH');
    },
    async target(absolute, { directory = false, allowMissing = true, enforceNoOverwrite = true } = {}) {
      const result = await context.inspect(absolute, { allowMissing });
      if (directory && result.kind && result.kind !== 'dir') throw failure('SCP_NOT_DIRECTORY');
      if (!directory && result.kind === 'dir') throw failure('SCP_NOT_DIRECTORY');
      if (!directory && result.kind === 'file' && enforceNoOverwrite && context.noOverwrite) throw failure('SCP_EXISTS');
      return result;
    },
    async temporary(size) {
      const temporary = await allocateTempFile({ directory: tempDirectory, size, check });
      temporaries.add(temporary);
      return temporary;
    },
    async removeTemporary(temporary) {
      await temporary.cleanup();
      temporaries.delete(temporary);
    },
    async readRecord() { frame(); const record = await reader.readRecord(); check(); touch(); return record; },
    async readAck() { frame(); await reader.readAck(); check(); touch(); },
    async writeRecord(record) { frame(); await writer.writeRecord(record); check(); touch(); },
    async writeAck() { frame(); await writer.writeAck(); check(); touch(); },
  };

  touch();
  lifetimeTimer = setTimeout(() => close('timeout'), LIFETIME_MS);
  lifetimeTimer.unref?.();
  const done = Promise.resolve().then(async () => {
    let code = null;
    try {
      check();
      if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > MAX_FILE_BYTES) throw failure('SCP_LIMIT');
      if (!command || command.invalid || !['source', 'sink'].includes(command.direction)) throw failure('SCP_PATH');
      if (command.direction === 'source') await runDownloadSession(context);
      else await runUploadSession(context);
      check();
    } catch (error) {
      remoteTempsRetained ||= error?.remoteTempsRetained === true;
      remoteTargetMayBeChanged ||= error?.remoteTargetMayBeChanged === true;
      code = stopped || safeCode(error);
    } finally {
      clearTimeout(idleTimer);
      clearTimeout(lifetimeTimer);
      controller.abort();
      reader.close();
      writer.close();
      for (const cancel of [...cancellations]) { try { cancel(); } catch {} }
      const cleanup = await Promise.allSettled([...temporaries].map(temporary => temporary.cleanup()));
      if (cleanup.some(result => result.status === 'rejected')) code = 'SCP_IO';
      if (code && !channel.destroyed && !channel.writableEnded) {
        // This endpoint deliberately has no aborted signal and a short bound: a
        // failed/stalled peer must never hold session teardown open indefinitely.
        const errors = new ScpProtocolWriter(channel, { timeoutMs: 250, maxFileBytes: MAX_FILE_BYTES });
        const warning = remoteTargetMayBeChanged
          ? ' The existing destination may have been truncated or partially replaced; no rollback was performed.' : '';
        try { await errors.writeError(`${ERRORS[code] || ERRORS.SCP_IO}${warning}`, { fatal: true }); } catch {}
        finally { errors.close(); }
      }
      completed = true;
    }
    const reason = closeReason || (code === 'SCP_TIMEOUT' ? 'timeout' : code === 'SCP_NETWORK' ? 'network_error'
      : code === 'SCP_AUTH' ? 'auth_error' : code ? 'interrupted' : 'completed');
    return { exitCode: code ? 1 : 0, reason, remoteTempsRetained };
  });
  return { done, close };
}

module.exports = { startScpSession };
