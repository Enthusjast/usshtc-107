'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { readUtf8FileLimited, atomicWriteJson, syncDirectory } = require('./settings-store');

const MAX_HISTORY_BYTES = 1024 * 1024;
const MAX_HISTORY_SESSIONS = 1000;
const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const HISTORY_ERROR = 'HISTORY_STORAGE_FAILED';
const HISTORY_REASONS = Object.freeze([
  'completed', 'user_disconnect', 'proxy_stop', 'network_error', 'auth_error', 'remote_not_ready',
  'timeout', 'output_limit', 'app_exit', 'interrupted',
]);
const RECORD_FIELDS = ['id', 'profileId', 'kind', 'startedAt', 'endedAt', 'bytesSent', 'bytesReceived', 'exitCode', 'reason'];
const isCounter = (value) => Number.isSafeInteger(value) && value >= 0;
const isTime = (value) => Number.isSafeInteger(value) && value >= 0;
const isToken = (value, max) => typeof value === 'string' && value.length > 0
  && value.length <= max && !/[\s\x00-\x1f\x7f]/u.test(value);
const isExitCode = (value) => value === null || (Number.isInteger(value) && value >= 0 && value <= 255);
const documentFor = (sessions) => ({ schemaVersion: 1, sessions });
const serializedBytes = (sessions) => Buffer.byteLength(`${JSON.stringify(documentFor(sessions), null, 2)}\n`);

function validateDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some((key) => key !== 'schemaVersion' && key !== 'sessions')
      || value.schemaVersion !== 1 || !Array.isArray(value.sessions)) throw new Error('Invalid history');
  const ids = new Set();
  for (const record of value.sessions) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
        || Object.keys(record).length !== RECORD_FIELDS.length
        || RECORD_FIELDS.some((key) => !Object.hasOwn(record, key))
        || !isToken(record.id, 1024) || !isToken(record.profileId, 256)
        || ids.has(record.id) || !['shell', 'exec'].includes(record.kind)
        || !isTime(record.startedAt) || !isCounter(record.bytesSent) || !isCounter(record.bytesReceived)
        || !isExitCode(record.exitCode)
        || (record.endedAt === null ? record.exitCode !== null || record.reason !== null
          : !isTime(record.endedAt) || record.endedAt < record.startedAt || !HISTORY_REASONS.includes(record.reason))) {
      throw new Error('Invalid history');
    }
    ids.add(record.id);
  }
  return value.sessions;
}

class SessionHistoryStore {
  constructor({ filePath, onWarning = () => {}, onState = () => {}, clock = globalThis,
    io = fs, platform = process.platform }) {
    this.filePath = filePath;
    this.onWarning = onWarning;
    this.onState = onState;
    this.clock = clock;
    this.io = io;
    this.platform = platform;
    this.sessions = [];
    this.registered = new Map();
    this.clearedProfiles = new Set();
    this.errorCode = null;
    this.dirty = false;
    this.timer = null;
    this.disposed = false;
    this.needsRead = false;
    this.pendingCorrupt = null;
    this._load();
  }

  _now() { return Math.max(0, Math.floor(typeof this.clock.now === 'function' ? this.clock.now() : Date.now())); }
  _changed() { this.onState({ errorCode: this.errorCode }); }
  _state(code) {
    if (this.errorCode === code) return;
    this.errorCode = code;
    this.onState({ errorCode: code });
    if (code) this.onWarning(code);
  }
  _cancelTimer() {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
  _schedule() {
    this.dirty = true;
    if (this.timer !== null || this.disposed) return;
    this.timer = this.clock.setTimeout(() => { this.timer = null; this.flush(); }, 5000);
    this.timer?.unref?.();
  }
  _readRawLimited() {
    const descriptor = this.io.openSync(this.filePath, 'r');
    try {
      const bytes = Buffer.alloc(MAX_HISTORY_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = this.io.readSync(descriptor, bytes, length, bytes.length - length, null);
        if (!count) break;
        length += count;
      }
      if (length > MAX_HISTORY_BYTES) throw new Error('Invalid history size');
      return bytes.subarray(0, length);
    } finally { this.io.closeSync(descriptor); }
  }
  _backupCorrupt(text) {
    const backupPath = `${this.filePath}.corrupt-${crypto.randomUUID()}`;
    let descriptor;
    try {
      descriptor = this.io.openSync(backupPath, 'wx', 0o600);
      this.io.fchmodSync(descriptor, 0o600);
      this.io.writeFileSync(descriptor, text, 'utf8');
      this.io.fsyncSync(descriptor);
      this.io.closeSync(descriptor);
      descriptor = undefined;
      syncDirectory(require('node:path').dirname(this.filePath), { io: this.io, platform: this.platform });
      this.onWarning('HISTORY_CORRUPT');
      return true;
    } catch (_) {
      this._state(HISTORY_ERROR);
      return false;
    } finally {
      if (descriptor !== undefined) { try { this.io.closeSync(descriptor); } catch (_) {} }
    }
  }
  _load() {
    let text;
    try { text = readUtf8FileLimited(this.filePath, MAX_HISTORY_BYTES, this.io); }
    catch (error) {
      if (error.code === 'ENOENT') { this.needsRead = false; return; }
      if (error instanceof TypeError) {
        try {
          const bytes = this._readRawLimited();
          this.needsRead = false;
          if (!this._backupCorrupt(bytes)) this.pendingCorrupt = bytes;
          this.dirty = true;
          this.flush();
          return;
        } catch (_) { /* Keep the original file on an unreadable/oversized source. */ }
      }
      this.needsRead = true;
      this._state(HISTORY_ERROR);
      return;
    }
    let loaded;
    try { loaded = validateDocument(JSON.parse(text)); }
    catch (_) {
      this.needsRead = false;
      if (!this._backupCorrupt(text)) { this.pendingCorrupt = text; return; }
      this.dirty = true;
      this.flush();
      return;
    }
    this.needsRead = false;
    const existing = new Set(this.sessions.map((record) => record.id));
    const now = this._now();
    for (const record of loaded) {
      if (this.clearedProfiles.has(record.profileId)) { this.dirty = true; continue; }
      if (existing.has(record.id)) continue;
      if (record.endedAt === null) {
        record.endedAt = Math.max(record.startedAt, now);
        record.reason = 'interrupted';
        record.exitCode = null;
        this.dirty = true;
      }
      this.sessions.push(record);
    }
    this._prune();
    if (this.dirty) this.flush();
  }
  _prune() {
    const cutoff = this._now() - HISTORY_RETENTION_MS;
    const kept = this.sessions.filter((record) => record.endedAt === null || record.endedAt >= cutoff);
    kept.sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt) || a.startedAt - b.startedAt);
    let bytes = serializedBytes(kept);
    const emptyBytes = serializedBytes([]);
    while (kept.length > MAX_HISTORY_SESSIONS || bytes > MAX_HISTORY_BYTES) {
      const index = kept.findIndex((record) => record.endedAt !== null);
      if (index === -1) break;
      const removedBytes = serializedBytes([kept[index]]) - emptyBytes;
      bytes -= removedBytes - (kept.length > 1 ? 2 : 0);
      kept.splice(index, 1);
    }
    if (kept.length !== this.sessions.length) this.dirty = true;
    this.sessions = kept;
    return kept.length <= MAX_HISTORY_SESSIONS && bytes <= MAX_HISTORY_BYTES;
  }

  register({ sessionKey, profileId, kind, startedAt, bytesSent = 0, bytesReceived = 0 }) {
    if (this.disposed || !isToken(sessionKey, 1024) || !isToken(profileId, 256)
        || !['shell', 'exec'].includes(kind) || !isTime(startedAt)
        || !isCounter(bytesSent) || !isCounter(bytesReceived)
        || this.sessions.some((record) => record.id === sessionKey)) return false;
    const record = { id: sessionKey, profileId, kind, startedAt, endedAt: null,
      bytesSent, bytesReceived, exitCode: null, reason: null };
    this.sessions.push(record);
    if (!this._prune()) {
      this.sessions = this.sessions.filter((entry) => entry !== record);
      return false;
    }
    this.registered.set(sessionKey, record);
    this._schedule();
    this._changed();
    return true;
  }
  sample(sessionKey, { bytesSent, bytesReceived }) {
    const record = this.registered.get(sessionKey);
    if (this.disposed || !record || !isCounter(bytesSent) || !isCounter(bytesReceived)
        || bytesSent < record.bytesSent || bytesReceived < record.bytesReceived) return false;
    if (record.bytesSent !== bytesSent || record.bytesReceived !== bytesReceived) {
      record.bytesSent = bytesSent;
      record.bytesReceived = bytesReceived;
      this._schedule();
      this._changed();
    }
    return true;
  }
  finalize(sessionKey, { endedAt = this._now(), bytesSent, bytesReceived, exitCode = null, reason }) {
    const record = this.registered.get(sessionKey);
    if (this.disposed || !record || !isTime(endedAt) || !isExitCode(exitCode)
        || !HISTORY_REASONS.includes(reason)
        || (bytesSent !== undefined && !isCounter(bytesSent))
        || (bytesReceived !== undefined && !isCounter(bytesReceived))) return false;
    record.endedAt = Math.max(record.startedAt, endedAt);
    record.bytesSent = Math.max(record.bytesSent, bytesSent ?? record.bytesSent);
    record.bytesReceived = Math.max(record.bytesReceived, bytesReceived ?? record.bytesReceived);
    record.exitCode = exitCode;
    record.reason = reason;
    this.registered.delete(sessionKey);
    this.dirty = true;
    this._changed();
    this.flush();
    return true;
  }
  get({ profileId, days }) {
    this._prune();
    const cutoff = this._now() - (days === 7 ? 7 : 30) * 24 * 60 * 60 * 1000;
    return { sessions: this.sessions.filter((record) => record.profileId === profileId
      && (record.endedAt ?? record.startedAt) >= cutoff).map((record) => ({ ...record })).reverse(),
    errorCode: this.errorCode };
  }
  clear(profileId) {
    this.clearedProfiles.add(profileId);
    for (const [key, record] of this.registered) {
      if (record.profileId === profileId) this.registered.delete(key);
    }
    this.sessions = this.sessions.filter((record) => record.profileId !== profileId);
    this.dirty = true;
    this._changed();
    return this.flush();
  }
  flush() {
    this._cancelTimer();
    this._prune();
    if (this.needsRead || this.pendingCorrupt !== null) return { errorCode: this.errorCode };
    if (this.dirty || this.errorCode) {
      try {
        atomicWriteJson(this.filePath, documentFor(this.sessions), { maxBytes: MAX_HISTORY_BYTES,
          io: this.io, platform: this.platform });
        this.dirty = false;
        this.clearedProfiles.clear();
        this._state(null);
      } catch (_) { this.dirty = true; this._state(HISTORY_ERROR); }
    }
    return { errorCode: this.errorCode };
  }
  retry() {
    if (this.needsRead) this._load();
    if (this.pendingCorrupt !== null && this._backupCorrupt(this.pendingCorrupt)) {
      this.pendingCorrupt = null;
      this.dirty = true;
    }
    return this.flush();
  }
  dispose() {
    const result = this.flush();
    this.disposed = true;
    return result;
  }
}

const createSessionHistoryStore = (deps) => new SessionHistoryStore(deps);
module.exports = { SessionHistoryStore, createSessionHistoryStore, HISTORY_REASONS,
  MAX_HISTORY_BYTES, MAX_HISTORY_SESSIONS, HISTORY_RETENTION_MS };
