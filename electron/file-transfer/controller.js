'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { createPortalApiClient } = require('../portal-api/client');
const { createFileApi } = require('../portal-api/file-api');
const orchestrator = require('./orchestrator');

const MAX_INFLIGHT = 2;
const MAX_QUEUED = 20;
const MAX_HISTORY = 50;
const ERROR_CODES = new Set(['AUTH_REQUIRED', 'PROFILE_CHANGED', 'INVALID_ARGUMENT', 'OPERATION_IN_PROGRESS',
  'TRANSFER_PATH', 'TRANSFER_LIMIT', 'TRANSFER_EXISTS', 'TRANSFER_CHANGED', 'TRANSFER_METADATA', 'TRANSFER_HASH',
  'TRANSFER_IO', 'TRANSFER_DIRECTORY', 'TRANSFER_UNSAFE_TYPE', 'TRANSFER_TEMP_CONFLICT', 'PORTAL_AUTH', 'PORTAL_NETWORK', 'PORTAL_TIMEOUT',
  'PORTAL_PERMISSION', 'PORTAL_NOT_FOUND', 'PORTAL_UNIMPLEMENTED', 'PORTAL_QUOTA', 'PORTAL_UNKNOWN', 'PORTAL_CANCELLED']);
function failure(code) { return Object.assign(new Error(code), { code }); }
const sameScope = (a, b) => Boolean(a && b && a.profileId === b.profileId && a.epoch === b.epoch);
function safeCode(error) { return ERROR_CODES.has(error?.code) ? error.code : 'TRANSFER_IO'; }
const NATIVE_COPY = Object.freeze({
  en: { upload: 'Upload file', download: 'Download file', replaceTitle: 'Replace existing file?',
    replaceMessage: 'Allow this transfer to replace an existing regular file?',
    replaceDetail: 'Remote protection uses an existence preflight, not an atomic no-clobber operation. Directories are never replaced.',
    cancel: 'Cancel', replace: 'Replace file' },
  zh: { upload: '上传文件', download: '下载文件', replaceTitle: '替换现有文件？',
    replaceMessage: '允许此次传输替换现有的普通文件吗？',
    replaceDetail: '远端覆盖保护依赖存在性预检查，并非原子的不覆盖操作。不会替换目录。',
    cancel: '取消', replace: '替换文件' },
});
function createFileTransferController(deps) {
  const createClient = deps.createClient || createPortalApiClient;
  const transfers = deps.transfers || orchestrator;
  const jobs = new Map();
  let currentKey = null;
  let currentScope = null;
  let inflight = 0;
  let dialogPending = false;
  let disposed = false;

  function context(scope) {
    if (disposed) throw failure('PORTAL_CANCELLED');
    const value = deps.getContext();
    if (!sameScope(scope, value?.scope)) throw failure('PROFILE_CHANGED');
    if (!value.cookie) throw failure('AUTH_REQUIRED');
    if (!Number.isSafeInteger(value.authGeneration) || value.authGeneration < 0
        || typeof value.cluster !== 'string' || !value.cluster || value.cluster.length > 256
        || /[\u0000-\u001f\u007f]/.test(value.cluster)) throw failure('INVALID_ARGUMENT');
    return { ...value, scope: { ...value.scope }, key: JSON.stringify([value.scope.profileId, value.scope.epoch,
      value.authGeneration, value.cookie, value.cluster, value.tlsCa || null]) };
  }
  function assertCurrent(value) {
    if (context(value.scope).key !== value.key) throw failure('PROFILE_CHANGED');
  }
  function validate(payload, allowed) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || Object.keys(payload).some(key => !allowed.includes(key))
        || !payload.scope || typeof payload.scope.profileId !== 'string' || !payload.scope.profileId
        || payload.scope.profileId.length > 128 || !Number.isSafeInteger(payload.scope.epoch) || payload.scope.epoch < 0
        || Object.keys(payload.scope).some(key => !['profileId', 'epoch'].includes(key))) throw failure('INVALID_ARGUMENT');
  }
  function dto(job) {
    return { id: job.id, filename: job.filename, direction: job.direction, bytes: job.bytes, total: job.total,
      phase: job.phase, status: job.status, mode: job.mode, remoteTempsRetained: job.remoteTempsRetained,
      ...(job.errorCode ? { errorCode: job.errorCode } : {}) };
  }
  function snapshot(scope = currentScope) { return { ...scope, items: [...jobs.values()].map(dto) }; }
  function emit() {
    if (disposed || !currentScope) return;
    try {
      if (context(currentScope).key === currentKey) deps.onState?.(snapshot());
    } catch (_) { /* Context invalidation is handled by update; never export internal errors. */ }
  }
  function trim() {
    let count = [...jobs.values()].filter(job => job.settled).length;
    for (const [id, job] of jobs) {
      if (count <= MAX_HISTORY) break;
      if (job.settled) { jobs.delete(id); count--; }
    }
  }
  function clear() {
    for (const job of jobs.values()) job.controller.abort();
    jobs.clear();
  }
  function adopt(value) {
    if (value.key !== currentKey) { clear(); currentKey = value.key; currentScope = value.scope; }
  }
  function isCurrent(job) {
    if (disposed || jobs.get(job.id) !== job || job.controller.signal.aborted) return false;
    try { assertCurrent(job.context); return true; } catch (_) { return false; }
  }
  async function execute(job) {
    inflight++;
    job.status = 'running';
    emit();
    let client;
    try {
      assertCurrent(job.context);
      if (job.controller.signal.aborted) throw failure('PORTAL_CANCELLED');
      client = createClient({ cookie: job.context.cookie, tlsCa: job.context.tlsCa });
      const result = await transfers[job.direction]({ api: createFileApi({ client }), cluster: job.context.cluster,
        localPath: job.localPath, remotePath: job.remotePath, overwrite: job.overwrite,
        signal: job.controller.signal, scope: job.context.scope, assertCurrent: () => assertCurrent(job.context),
        onProgress(progress) {
          if (!isCurrent(job)) return;
          if (!Number.isSafeInteger(progress.bytes) || !Number.isSafeInteger(progress.total)
              || progress.bytes < job.bytes || progress.total < progress.bytes || progress.total > orchestrator.MAX_BYTES) return;
          job.bytes = progress.bytes;
          job.total = progress.total;
          job.phase = progress.phase;
          job.mode = progress.mode;
          // Init/upload may already have allocated remote state; ownership is unknown.
          if (job.direction === 'upload' && ['negotiating', 'uploading', 'verifying', 'publishing'].includes(progress.phase)) job.remoteTempsRetained = true;
          emit();
        },
      });
      if (!isCurrent(job)) throw failure('PORTAL_CANCELLED');
      job.status = 'completed';
      job.phase = 'completed';
      job.bytes = result.bytes;
      job.total = result.bytes;
      job.mode = result.mode;
      job.remoteTempsRetained = result.remoteTempsRetained === true;
    } catch (error) {
      if (jobs.get(job.id) === job) {
        job.errorCode = safeCode(error);
        job.status = job.controller.signal.aborted || error?.code === 'PORTAL_CANCELLED' ? 'cancelled' : 'failed';
        if (typeof error?.remoteTempsRetained === 'boolean') job.remoteTempsRetained = error.remoteTempsRetained;
      }
    } finally {
      client?.dispose();
      job.localPath = null;
      job.remotePath = null;
      job.context = null;
      job.settled = true;
      inflight--;
      trim();
      emit();
      pump();
    }
  }
  function pump() {
    if (disposed) return;
    for (const job of jobs.values()) {
      if (inflight >= MAX_INFLIGHT) break;
      if (job.status === 'queued') void execute(job);
    }
  }
  function list(payload) {
    validate(payload, ['scope']);
    const value = context(payload.scope);
    adopt(value);
    return snapshot(value.scope);
  }
  async function start(payload) {
    validate(payload, ['scope', 'direction', 'remotePath', 'overwrite']);
    if (!['upload', 'download'].includes(payload.direction) || payload.overwrite !== undefined && typeof payload.overwrite !== 'boolean') throw failure('INVALID_ARGUMENT');
    const remote = orchestrator.remotePath(payload.remotePath);
    const value = context(payload.scope);
    adopt(value);
    if (dialogPending || [...jobs.values()].filter(job => job.status === 'queued').length >= MAX_QUEUED) throw failure('OPERATION_IN_PROGRESS');
    dialogPending = true;
    try {
      const window = deps.getWindow();
      if (!window || window.isDestroyed?.()) throw failure('PORTAL_CANCELLED');
      const copy = NATIVE_COPY[deps.getLocale?.() === 'zh' ? 'zh' : 'en'];
      const choice = payload.direction === 'upload'
        ? await deps.dialog.showOpenDialog(window, { title: copy.upload, properties: ['openFile', 'dontAddToRecent'] })
        : await deps.dialog.showSaveDialog(window, { title: copy.download, defaultPath: path.posix.basename(remote),
          properties: ['showOverwriteConfirmation', 'dontAddToRecent'] });
      assertCurrent(value);
      if (choice.canceled) return { ...snapshot(value.scope), cancelled: true };
      const selected = payload.direction === 'upload' ? choice.filePaths?.[0] : choice.filePath;
      const local = orchestrator.localPath(selected);
      if (payload.overwrite === true) {
        const confirmation = await deps.dialog.showMessageBox(window, { type: 'warning',
          title: copy.replaceTitle, message: copy.replaceMessage, detail: copy.replaceDetail,
          buttons: [copy.cancel, copy.replace], defaultId: 0, cancelId: 0, noLink: true });
        assertCurrent(value);
        if (confirmation.response !== 1) return { ...snapshot(value.scope), cancelled: true };
      }
      if ([...jobs.values()].filter(job => job.status === 'queued').length >= MAX_QUEUED) throw failure('OPERATION_IN_PROGRESS');
      const job = { id: crypto.randomUUID(), filename: path.basename(payload.direction === 'upload' ? local : remote),
        direction: payload.direction, localPath: local, remotePath: remote, overwrite: payload.overwrite === true,
        context: value, controller: new AbortController(), bytes: 0, total: 0, phase: 'hashing', mode: 'single',
        status: 'queued', remoteTempsRetained: false, settled: false };
      jobs.set(job.id, job);
      emit();
      pump();
      return { ...snapshot(value.scope), transferId: job.id };
    } catch (error) { throw failure(safeCode(error)); }
    finally { dialogPending = false; }
  }
  function cancel(payload) {
    validate(payload, ['scope', 'id']);
    if (typeof payload.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.id)) throw failure('INVALID_ARGUMENT');
    const value = context(payload.scope);
    adopt(value);
    const job = jobs.get(payload.id);
    if (job && ['queued', 'running'].includes(job.status)) {
      job.controller.abort();
      if (job.status === 'queued') { job.settled = true; job.localPath = null; job.remotePath = null; job.context = null; }
      job.status = 'cancelled';
      job.errorCode = 'PORTAL_CANCELLED';
      trim();
      emit();
    }
    return snapshot(value.scope);
  }
  return {
    list, start, cancel,
    update() {
      if (disposed) return;
      let value;
      try { const raw = deps.getContext(); value = context(raw?.scope); } catch (_) { value = null; }
      if (value) { adopt(value); emit(); }
      else { clear(); currentKey = null; currentScope = null; }
    },
    dispose() { disposed = true; clear(); currentKey = null; currentScope = null; },
  };
}
module.exports = { createFileTransferController, MAX_INFLIGHT, MAX_QUEUED, MAX_HISTORY, ERROR_CODES };
