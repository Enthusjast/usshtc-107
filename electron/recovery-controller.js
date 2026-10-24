'use strict';

const { WebSocket } = require('ws');
const { ServiceError } = require('./ipc-contract');
const { validateSettingsPatch } = require('../shared/settings-schema.mjs');
const { buildWssUrl, buildWssOptions } = require('./wss-connection');

const RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000, 8000, 16000, 30000]);
const HANDSHAKE_TIMEOUT_MS = 5000;
const ONLINE_HINT_INTERVAL_MS = 5000;
const CONFIG_FIELDS = ['host', 'port', 'cluster', 'loginNode', 'cols', 'rows', 'useRoot'];
const CERTIFICATE_ERRORS = new Set(['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED', 'CERT_SIGNATURE_FAILURE', 'INVALID_CA']);
const sameScope = (left, right) => left?.profileId === right?.profileId && left?.epoch === right?.epoch;

function createRecoveryController(deps) {
  const clock = deps.clock || globalThis;
  const adapters = deps.adapters || {};
  const createWebSocket = adapters.createWebSocket || ((url, options) => new WebSocket(url, options));
  let active = null;
  let hintTimer = null;
  let disposed = false;
  let suspended = false;
  let enabled = deps.getPreferences().reconnectOnResume !== false;
  let observed = null;
  let blocked = null;
  let lastOnline = null;
  let unhealthy = false;
  let remoteState = null;
  let stableRemoteState = null;
  let cancelling = false;
  let paused = false;
  let rearmWhenIdle = false;

  function context() {
    const snapshot = deps.getSnapshot();
    const scope = { profileId: snapshot.profileId, epoch: snapshot.epoch };
    const config = deps.getConfig(scope);
    const cookie = deps.getCookie(scope);
    const key = JSON.stringify([scope.profileId, scope.epoch, snapshot.desiredRunning,
      snapshot.storageErrorCode, ...CONFIG_FIELDS.map((field) => config?.[field]), config?.wssUrl, cookie]);
    return { snapshot, scope, config, cookie, key };
  }

  function current(round) {
    if (disposed || suspended || active !== round || round.controller.signal.aborted) return false;
    try { return context().key === round.context.key; } catch (_) { return false; }
  }

  function publish(value, status, errorCode = null) {
    if (disposed) return;
    if (status !== 'checking') stableRemoteState = { contextKey: value.key, status, errorCode };
    const key = `${value.scope.profileId}:${value.scope.epoch}:${status}:${errorCode}`;
    if (remoteState === key) return;
    remoteState = key;
    deps.onRemoteState?.({ ...value.scope, remoteStatus: status, errorCode });
  }

  function settle(round, result) {
    if (round.timer !== null) clock.clearTimeout(round.timer);
    round.timer = null;
    if (active === round) active = null;
    round.resolve(result);
  }

  function cancel(reason = 'CANCELLED') {
    paused = true;
    const round = active;
    if (!round) return;
    active = null;
    cancelling = true;
    try {
      round.controller.abort(reason);
      settle(round, { cancelled: true });
      if (!disposed) {
        let value;
        try { value = context(); } catch (_) { /* An invalidated context has no publish authority. */ }
        if (value?.snapshot.remoteStatus === 'checking') {
          const stable = stableRemoteState?.contextKey === value.key ? stableRemoteState : null;
          publish(value, stable?.status || 'unknown', stable?.errorCode || null);
        }
      }
    } finally { cancelling = false; }
  }

  function stopHints() {
    if (hintTimer !== null) clock.clearTimeout(hintTimer);
    hintTimer = null;
  }

  function scheduleHints() {
    if (hintTimer !== null || disposed || suspended || !enabled || paused
        || deps.getSnapshot().desiredRunning !== true) return;
    hintTimer = clock.setTimeout(() => {
      hintTimer = null;
      let onlineHint;
      try { onlineHint = deps.net?.isOnline(); } catch (_) { /* A hint is not a connectivity verdict. */ }
      if (typeof onlineHint === 'boolean' && onlineHint !== lastOnline) {
        const previous = lastOnline;
        lastOnline = onlineHint;
        if (!onlineHint || previous === false) automatic();
      }
      scheduleHints();
    }, ONLINE_HINT_INTERVAL_MS);
    hintTimer?.unref?.();
  }

  function validate(value) {
    if (value.snapshot.storageErrorCode) return 'SETTINGS_LOCKED';
    if (!value.config || !validateSettingsPatch(Object.fromEntries(CONFIG_FIELDS.map((field) => [field, value.config[field]]))).ok) {
      return 'SETTINGS_INVALID';
    }
    try {
      const url = new URL(buildWssUrl(value.config));
      if (url.protocol !== 'wss:' || url.username || url.password) return 'SETTINGS_INVALID';
    } catch (_) { return 'SETTINGS_INVALID'; }
    if (!value.cookie) return 'AUTH_REQUIRED';
    try { buildWssOptions({ cookie: value.cookie }); } catch (_) { return 'AUTH_REQUIRED'; }
    if (['PORT_IN_USE', 'EADDRINUSE', 'SSH_KEY_MISSING', 'SSH_KEY_INVALID',
      'SSH_KEY_FINGERPRINT_MISMATCH', 'SETTINGS_LOCKED'].includes(value.snapshot.errorCode)) {
      return value.snapshot.errorCode === 'EADDRINUSE' ? 'PORT_IN_USE' : value.snapshot.errorCode;
    }
    return null;
  }

  function probe(round) {
    return new Promise((resolve) => {
      const signal = round.controller.signal;
      let socket;
      let timeout = null;
      let finished = false;
      const handlers = [];
      const listen = (name, fn) => { socket.on(name, fn); handlers.push([name, fn]); };
      const finish = (result) => {
        if (finished) return;
        finished = true;
        if (timeout !== null) clock.clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        if (socket) {
          for (const [name, fn] of handlers) socket.removeListener(name, fn);
          // ws emits an asynchronous error when a connecting socket is terminated.
          socket.on('error', () => {});
          try { if (socket.readyState === 1) socket.close(); socket.terminate(); } catch (_) {}
        }
        resolve(result);
      };
      const abort = () => finish({ cancelled: true });
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      timeout = clock.setTimeout(() => finish({ code: 'TIMEOUT' }), HANDSHAKE_TIMEOUT_MS);
      timeout?.unref?.();
      try {
        socket = createWebSocket(buildWssUrl(round.context.config), buildWssOptions({
          cookie: round.context.cookie, tlsCa: adapters.tlsCa, handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
        }));
        listen('open', () => finish({ ok: true }));
        listen('error', (error) => finish({ code: CERTIFICATE_ERRORS.has(error?.code)
          || String(error?.code || '').startsWith('ERR_TLS_CERT_') ? 'TLS_FAILED' : 'NETWORK_UNAVAILABLE',
        terminal: CERTIFICATE_ERRORS.has(error?.code) || String(error?.code || '').startsWith('ERR_TLS_CERT_') }));
        listen('close', () => finish({ code: 'WSS_FAILED' }));
        listen('unexpected-response', (_request, response) => {
          const statusCode = response.statusCode;
          // Never consume or retain the remote body.
          response.on('error', () => {});
          response.destroy();
          finish(statusCode === 401 || statusCode === 403
            ? { code: 'AUTH_REQUIRED', terminal: true, statusCode } : { code: 'WSS_FAILED' });
        });
      } catch (_) { finish({ code: 'SETTINGS_INVALID', terminal: true }); }
    });
  }

  async function attempt(round) {
    round.timer = null;
    if (!current(round)) { settle(round, { cancelled: true }); return; }
    publish(round.context, 'checking');
    if (!current(round)) { settle(round, { cancelled: true }); return; }
    const result = await probe(round);
    if (!current(round)) { settle(round, { cancelled: true }); return; }
    if (result.ok) {
      const recovered = unhealthy;
      unhealthy = false;
      blocked = null;
      publish(round.context, 'reachable');
      if (!current(round)) { settle(round, { cancelled: true }); return; }
      if (recovered) {
        try { Promise.resolve(deps.onRecovered?.({ ...round.context.scope })).catch(() => {}); } catch (_) {}
      }
      if (!current(round)) { settle(round, { cancelled: true }); return; }
      const latest = deps.getSnapshot();
      if (latest.proxyStatus === 'stopped' && latest.desiredRunning === true) {
        try {
          await deps.requestStart({ ...round.context.scope }, { signal: round.controller.signal });
          if (!current(round)) { settle(round, { cancelled: true }); return; }
        } catch (error) {
          if (!current(round)) { settle(round, { cancelled: true }); return; }
          const code = ['PORT_IN_USE', 'SETTINGS_INVALID', 'SETTINGS_LOCKED', 'AUTH_REQUIRED',
            'SSH_KEY_MISSING', 'SSH_KEY_INVALID', 'SSH_KEY_FINGERPRINT_MISMATCH'].includes(error?.code)
            ? error.code : 'PROXY_START_FAILED';
          blocked = round.context.key;
          publish(round.context, code === 'AUTH_REQUIRED' ? 'auth_required' : 'error', code);
          settle(round, { errorCode: code });
          return;
        }
      }
      settle(round, { reachable: true });
      return;
    }
    unhealthy = true;
    if (result.statusCode) {
      blocked = round.context.key;
      publish(round.context, 'auth_required', 'AUTH_REQUIRED');
      // Recheck after observers: they may stop, switch profile, or replace the Cookie.
      if (current(round)) {
        try {
          Promise.resolve(deps.onAuthRequired?.({ ...round.context.scope,
            statusCode: result.statusCode, cookie: round.context.cookie })).catch(() => {});
        } catch (_) {}
      }
      settle(round, { errorCode: 'AUTH_REQUIRED' });
      return;
    }
    publish(round.context, result.terminal ? 'error' : 'offline', result.code);
    if (!current(round)) { settle(round, { cancelled: true }); return; }
    if (result.terminal || round.attempt === RETRY_DELAYS_MS.length) {
      blocked = round.context.key;
      settle(round, { errorCode: result.code });
    } else scheduleAttempt(round);
  }

  function scheduleAttempt(round) {
    const delay = RETRY_DELAYS_MS[round.attempt++];
    round.timer = clock.setTimeout(() => {
      // All async adapter failures become a fixed public state, never an unhandled rejection.
      attempt(round).catch(() => {
        if (current(round)) publish(round.context, 'error', 'WSS_FAILED');
        settle(round, { errorCode: 'WSS_FAILED' });
      });
    }, delay);
    round.timer?.unref?.();
  }

  function begin(value, manual) {
    observed = value.key;
    observedScope = value.scope;
    if (active?.context.key === value.key) return active.promise;
    cancel('SUPERSEDED');
    paused = false;
    if (!manual && blocked === value.key) return Promise.resolve({ errorCode: 'RECOVERY_EXHAUSTED' });
    const invalid = validate(value);
    if (invalid) {
      blocked = value.key;
      publish(value, invalid === 'AUTH_REQUIRED' ? 'auth_required' : 'error', invalid);
      return Promise.resolve({ errorCode: invalid });
    }
    if (manual) blocked = null;
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const round = { context: value, controller: new AbortController(), timer: null, attempt: 0, resolve, promise };
    active = round;
    scheduleAttempt(round);
    scheduleHints();
    return promise;
  }

  function automatic() {
    if (disposed || suspended || !enabled || paused) return;
    let value;
    try { value = context(); } catch (_) { return; }
    if (value.snapshot.desiredRunning !== true) return;
    // Polling and transport events cannot reset a terminal or exhausted round.
    begin(value, false);
  }

  function retry(scope) {
    if (disposed) return Promise.reject(new ServiceError('SHUTTING_DOWN'));
    const value = context();
    if (!sameScope(scope, value.scope)) return Promise.reject(new ServiceError('PROFILE_CHANGED'));
    if (suspended) return Promise.resolve({ cancelled: true });
    return begin(value, true);
  }

  function update() {
    if (disposed || cancelling) return;
    const nextEnabled = deps.getPreferences().reconnectOnResume !== false;
    let value;
    try { value = context(); } catch (_) { cancel('CONFIG_CHANGED'); stopHints(); return; }
    const changed = observed !== value.key;
    const enabledNow = !enabled && nextEnabled;
    const scopeChanged = observed !== null && !sameScope(value.scope, observedScope);
    observed = value.key;
    observedScope = value.scope;
    const disabledNow = enabled && !nextEnabled;
    enabled = nextEnabled;
    if (changed || disabledNow) cancel(changed ? 'CONTEXT_CHANGED' : 'PREFERENCE_DISABLED');
    if (scopeChanged) { unhealthy = false; remoteState = null; }
    if (changed) blocked = null;
    if (!enabled || suspended || value.snapshot.desiredRunning !== true) { stopHints(); return; }
    const rearm = rearmWhenIdle && !value.snapshot.operation;
    if (rearm) rearmWhenIdle = false;
    if (changed || enabledNow || rearm) {
      paused = false;
      if (value.snapshot.desiredRunning === true) automatic();
    }
    scheduleHints();
  }
  let observedScope = null;

  return {
    retry,
    cancel(reason) {
      rearmWhenIdle = reason === 'user_stop' || reason === 'USER_STOP';
      cancel(reason);
      stopHints();
    },
    update,
    resume() { if (disposed) return; suspended = false; paused = false; scheduleHints(); automatic(); },
    suspend() { suspended = true; cancel('SUSPENDED'); stopHints(); },
    online() { if (!disposed && enabled && !suspended) { lastOnline = true; automatic(); } },
    networkError(event) {
      if (disposed || suspended || !enabled || paused) return;
      const value = context();
      if (event && !sameScope(event, value.scope)) return;
      if (blocked === value.key) return;
      unhealthy = true;
      publish(value, 'offline', 'NETWORK_UNAVAILABLE');
      automatic();
    },
    dispose() { disposed = true; cancel('SHUTTING_DOWN'); stopHints(); },
  };
}

module.exports = { createRecoveryController, RETRY_DELAYS_MS, HANDSHAKE_TIMEOUT_MS, ONLINE_HINT_INTERVAL_MS };
