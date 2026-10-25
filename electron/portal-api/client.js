'use strict';

const https = require('node:https');
const tls = require('node:tls');
const { validateHeaderValue } = require('node:http');
const { isIP } = require('node:net');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { validateCookie } = require('../credential-store');
const { PLATFORM } = require('../constants');

const MAX_JSON_BYTES = 1024 * 1024;
const DEFAULT_STREAM_BYTES = 64 * 1024 * 1024;
const KINDS = new Set(['AUTH', 'NETWORK', 'TIMEOUT', 'PERMISSION', 'NOT_FOUND', 'UNIMPLEMENTED', 'QUOTA', 'UNKNOWN', 'CANCELLED']);
class PortalApiError extends Error {
  constructor(kind, statusCode) {
    const safe = KINDS.has(kind) ? kind : 'UNKNOWN';
    super(`PORTAL_${safe}`);
    this.name = 'PortalApiError';
    this.kind = safe;
    this.code = `PORTAL_${safe}`;
    if (Number.isInteger(statusCode)) this.statusCode = statusCode;
  }
}
function extractScowToken(cookie) {
  try {
    validateCookie(cookie);
    if (/[\u0000-\u0020\u007f-\u009f]/.test(cookie.replace(/; */g, ';'))) throw new Error();
    const matches = cookie.split(';').map(part => part.trim()).filter(part => part.startsWith('SCOW_USER='));
    if (!matches.length) return null;
    const token = matches[0].slice('SCOW_USER='.length);
    if (matches.length !== 1 || !token || /[\s;,"\\]/.test(token)) throw new Error();
    return token;
  } catch (_) { throw new PortalApiError('UNKNOWN'); }
}
function classifyStatus(status, body, path) {
  let value;
  try { value = JSON.parse(body.toString('utf8')); } catch (_) {}
  const code = value?.code;
  if (status === 401) return 'AUTH';
  if (status === 403) return path === '/api/auth/validateToken' && value === null ? 'AUTH' : 'PERMISSION';
  if (status === 404) return 'NOT_FOUND';
  if (status === 501) return 'UNIMPLEMENTED';
  if ([413, 429, 507].includes(status) || ['QUOTA_EXCEEDED', 'TOO_MANY_DESKTOPS'].includes(code)) return 'QUOTA';
  return 'UNKNOWN';
}
function validateAllowedHost(host) {
  if (typeof host !== 'string' || /[\u0000-\u0020\u007f-\u009f]/.test(host)) throw new Error();
  const match = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::([0-9]+))?$/.exec(host);
  if (!match) throw new Error();
  const hostname = match[1];
  if (hostname.startsWith('[')) {
    if (isIP(hostname.slice(1, -1)) !== 6) throw new Error();
  } else {
    if (hostname.length > 253 || !hostname.replace(/\.$/, '').split('.').every(label =>
      /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) throw new Error();
  }
  if (match[2] !== undefined && (!/^(?:0|[1-9][0-9]{0,4})$/.test(match[2]) || Number(match[2]) > 65535)) throw new Error();
  // Reject URL-invalid numeric addresses as well as malformed DNS/IP authorities.
  new URL(`https://${host}`);
}
function createPortalApiClient({ baseUrl = PLATFORM.url, allowedHosts = [PLATFORM.domain], cookie = '', tlsCa, request = https.request,
  clock = globalThis, timeoutMs = 10000 } = {}) {
  let base;
  try {
    if (!Array.isArray(allowedHosts)) throw new Error();
    for (const host of allowedHosts) validateAllowedHost(host);
    base = new URL(baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error();
    if (!allowedHosts.includes(base.host)) throw new Error();
  } catch (_) { throw new PortalApiError('UNKNOWN'); }
  const token = extractScowToken(cookie);
  const ca = tlsCa == null ? undefined : [...tls.rootCertificates, ...(Array.isArray(tlsCa) ? tlsCa : [tlsCa])];
  const agent = new https.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2, rejectUnauthorized: true, ...(ca ? { ca } : {}) });
  const active = new Set();
  let disposed = false;

  async function perform(path, options = {}, mode) {
    if (disposed) throw new PortalApiError('CANCELLED');
    const method = options.method || 'GET';
    if (!['GET', 'POST', 'PATCH'].includes(method) || typeof path !== 'string'
        || !/^\/api\/[A-Za-z0-9/_-]+$/.test(path)) throw new PortalApiError('UNKNOWN');
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(options.query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const headers = { Accept: mode === 'stream' ? 'application/octet-stream' : 'application/json', 'Accept-Encoding': 'identity' };
    for (const [name, value] of Object.entries(options.headers || {})) {
      const key = name.toLowerCase();
      if (!['content-type', 'content-length', 'accept'].includes(key)) throw new PortalApiError('UNKNOWN');
      try { validateHeaderValue(name, String(value)); } catch (_) { throw new PortalApiError('UNKNOWN'); }
      headers[key] = String(value);
    }
    if (options.authenticated !== false) {
      if (!token) throw new PortalApiError('AUTH');
      headers.Cookie = `SCOW_USER=${token}`;
    }
    let body = options.body;
    if (body !== undefined && body !== null && !(body instanceof Readable) && !Buffer.isBuffer(body) && typeof body !== 'string') {
      try { body = Buffer.from(JSON.stringify(body)); } catch (_) { throw new PortalApiError('UNKNOWN'); }
      headers['content-type'] ||= 'application/json';
    }
    if (body instanceof Readable) {
      if (!/^(?:0|[1-9]\d*)$/.test(headers['content-length'] || '') || !Number.isSafeInteger(Number(headers['content-length']))) throw new PortalApiError('UNKNOWN');
      body.on('error', () => {});
    } else if (body !== undefined && body !== null) headers['content-length'] = String(Buffer.byteLength(body));
    const maximum = options.maxBytes ?? (mode === 'stream' ? DEFAULT_STREAM_BYTES : MAX_JSON_BYTES);
    const duration = options.timeoutMs ?? (mode === 'stream' ? 600000 : timeoutMs);
    if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(duration) || duration < 1) throw new PortalApiError('UNKNOWN');
    let req, response, failure, timer;
    let uploading = Promise.resolve();
    let released = false;
    const check = () => {
      if (failure) throw failure;
      if (disposed || options.signal?.aborted) throw new PortalApiError('CANCELLED');
      try { options.assertCurrent?.(options.scope); } catch (_) { throw new PortalApiError('CANCELLED'); }
    };
    const stop = kind => {
      failure ||= new PortalApiError(kind);
      req?.destroy(failure);
      response?.destroy(failure);
      if (body instanceof Readable) body.destroy(failure);
      release();
    };
    const abort = () => stop('CANCELLED');
    const context = { cancel: abort };
    const release = () => {
      if (released) return;
      released = true;
      clock.clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      active.delete(context);
      if (response && !response.complete) { response.destroy(); req?.destroy(); }
    };
    const normalized = error => failure || (error instanceof PortalApiError ? error : new PortalApiError('NETWORK'));
    async function* receive(limit) {
      let count = 0;
      try {
        for await (const bytes of response) {
          check();
          count += bytes.length;
          if (count > limit) throw new PortalApiError('QUOTA');
          yield bytes;
        }
        check();
        if (!response.complete) throw new PortalApiError('NETWORK');
      } catch (error) { throw normalized(error); }
    }
    const collect = async limit => {
      const chunks = [];
      let size = 0;
      for await (const bytes of receive(limit)) { chunks.push(bytes); size += bytes.length; }
      return Buffer.concat(chunks, size);
    };
    let streamed = false;
    try {
      check();
      active.add(context);
      options.signal?.addEventListener('abort', abort, { once: true });
      timer = clock.setTimeout(() => stop('TIMEOUT'), duration);
      timer?.unref?.();
      check();
      response = await new Promise((resolve, reject) => {
        req = request(url, { method, headers, agent, rejectUnauthorized: true, ...(ca ? { ca } : {}) }, resolve);
        req.on('error', error => reject(normalized(error)));
        if (body instanceof Readable) {
          const expected = Number(headers['content-length']);
          const counted = Readable.from((async function* () {
            let sent = 0;
            for await (const chunk of body) {
              check();
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              sent += bytes.length;
              if (sent > expected) throw new PortalApiError('UNKNOWN');
              yield bytes;
            }
            if (sent !== expected) throw new PortalApiError('UNKNOWN');
          })());
          uploading = pipeline(counted, req);
          uploading.catch(error => { failure ||= normalized(error); req.destroy(failure); reject(failure); });
        }
        else req.end(body);
      });
      // Keep abort errors handled even when a consumer has not started iteration.
      response.on('error', () => {});
      check();
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new PortalApiError('UNKNOWN');
      const status = response.statusCode;
      if (status < 200 || status >= 300) {
        const errorBody = await collect(MAX_JSON_BYTES);
        failure = new PortalApiError(classifyStatus(status, errorBody, path), status);
        throw failure;
      }
      if (options.expectedStatus && !options.expectedStatus.includes(status)) throw new PortalApiError('UNKNOWN', status);
      await uploading;
      check();
      if (mode === 'stream') {
        const rawLength = response.headers['content-length'];
        if (rawLength !== undefined && (!/^(?:0|[1-9]\d*)$/.test(rawLength) || !Number.isSafeInteger(Number(rawLength)))) throw new PortalApiError('UNKNOWN');
        const contentLength = rawLength === undefined ? null : Number(rawLength);
        if (contentLength !== null && contentLength > maximum) throw new PortalApiError('QUOTA');
        const guarded = Readable.from((async function* () { try { yield* receive(maximum); } finally { release(); } })());
        guarded.once('close', release);
        streamed = true;
        return { body: guarded, contentLength, contentType: String(response.headers['content-type'] || '').slice(0, 256),
          cancel() { stop('CANCELLED'); guarded.destroy(); release(); } };
      }
      const bytes = await collect(Math.min(maximum, MAX_JSON_BYTES));
      if (mode === 'empty') return null;
      if (mode === 'text') return bytes.toString('utf8');
      if (!bytes.length && status === 204) return null;
      try { return JSON.parse(bytes.toString('utf8')); } catch (_) { throw new PortalApiError('UNKNOWN'); }
    } catch (error) {
      req?.destroy();
      response?.destroy();
      if (body instanceof Readable) body.destroy();
      throw normalized(error);
    }
    finally { if (!streamed) release(); }
  }
  return {
    json: (path, options) => perform(path, options, 'json'),
    text: (path, options) => perform(path, options, 'text'),
    empty: (path, options) => perform(path, options, 'empty'),
    stream: (path, options) => perform(path, options, 'stream'),
    dispose() { disposed = true; for (const context of active) context.cancel(); agent.destroy(); },
  };
}
module.exports = { createPortalApiClient, PortalApiError, extractScowToken, MAX_JSON_BYTES };
