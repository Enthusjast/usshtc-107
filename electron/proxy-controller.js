'use strict';

const { ServiceError } = require('./ipc-contract');

function createProxyController(deps) {
  const clock = deps.clock || globalThis;
  const publish = deps.publish || (() => {});
  const changed = deps.onState || (() => {});
  const log = deps.log || (() => {});
  const history = deps.history;
  const monotonicNow = () => typeof clock.now === 'function' ? clock.now() : performance.now();
  const wallNow = () => typeof clock.wallNow === 'function' ? clock.wallNow() : Date.now();
  const terminalReason = (reason) => reason === 'app_exit' || reason === 'fatal' ? 'app_exit'
    : reason === 'auth_error' ? 'auth_error' : 'proxy_stop';
  let scope = { profileId: 'default', epoch: 0 };
  let current = null;
  let lifecycle = Promise.resolve();
  let disposed = false;
  let sequence = 0;
  let sampleTimer = null;
  let trafficTimer = null;
  let startGeneration = 0;
  let lastStatsAt = -Infinity;

  const enqueue = (fn) => {
    const result = lifecycle.then(fn, fn);
    lifecycle = result.catch(() => {});
    return result;
  };
  const owns = (record) => current === record;
  const visible = (record) => owns(record) && !disposed && !record.candidate
    && record.historyScope.profileId === scope.profileId;
  const notify = (record, patch) => {
    if (visible(record)) changed({ ...record.scope, instanceId: record.id, ...patch });
  };
  const clearTimers = () => {
    if (sampleTimer !== null) clock.clearInterval(sampleTimer);
    if (trafficTimer !== null) clock.clearTimeout(trafficTimer);
    sampleTimer = trafficTimer = null;
  };
  const sampleHistory = (record, sessions) => {
    if (!history || !owns(record) || record.candidate) return;
    for (const session of sessions) {
      const registered = record.sessions.get(session.id);
      if (!registered) continue;
      registered.bytesSent = Math.max(registered.bytesSent, session.bytesSent || 0);
      registered.bytesReceived = Math.max(registered.bytesReceived, session.bytesReceived || 0);
      history.sample(registered.sessionKey, registered);
    }
  };
  const finalizeSession = (record, data) => {
    const registered = record.sessions.get(data.sessionId);
    if (!registered) return;
    record.sessions.delete(data.sessionId);
    history?.finalize(registered.sessionKey, { endedAt: data.endedAt ?? wallNow(),
      bytesSent: data.session?.bytesSent ?? registered.bytesSent,
      bytesReceived: data.session?.bytesReceived ?? registered.bytesReceived,
      exitCode: data.exitCode ?? null, reason: data.reason });
  };
  const finalizeRemaining = (record, reason) => {
    sampleHistory(record, record.server.getSessions());
    for (const sessionId of record.sessions.keys()) {
      finalizeSession(record, { sessionId, reason: terminalReason(reason) });
    }
    record.historyClosed = true;
  };
  const sample = () => {
    const record = current;
    const source = record && !record.candidate ? record.server.getStats() : null;
    if (source) sampleHistory(record, source.sessions);
    const stats = record && visible(record) ? source : {
      uptimeMs: 0, totalBytesSent: 0, totalBytesReceived: 0, sessionCount: 0, sessions: [],
    };
    return { ...stats, ...scope, sequence: ++sequence, sampledAt: monotonicNow() };
  };
  const sendStats = (record) => {
    if (!visible(record) || monotonicNow() - lastStatsAt < 500) return;
    lastStatsAt = monotonicNow();
    publish('stats-update', sample());
  };
  const startTimers = (record) => {
    clearTimers();
    sampleTimer = clock.setInterval(() => sendStats(record), 1000);
    sampleTimer?.unref?.();
  };
  const release = (record) => {
    if (!owns(record)) return;
    clearTimers();
    // A failed stop must retain its server and error listener until a later stop succeeds.
    record.server.removeAllListeners();
    current = null;
  };
  const stopRecord = async (record, reason) => {
    if (!owns(record)) return;
    record.cancelled = true;
    record.server.setAcceptingConnections?.(false);
    notify(record, { proxyStatus: 'stopping' });
    clearTimers();
    sampleHistory(record, record.server.getSessions());
    record.stopReason = reason;
    try {
      await record.server.stop(reason);
      if (!owns(record)) return;
      finalizeRemaining(record, reason);
      notify(record, { proxyStatus: 'stopped', runningConfig: null, connectionCount: 0, errorCode: null });
      release(record);
    } catch (error) {
      if (owns(record)) notify(record, { proxyStatus: 'error', errorCode: 'PROXY_STOP_FAILED' });
      log('error', 'proxy', `Stop failed: ${error.message}`);
      throw new ServiceError('PROXY_STOP_FAILED');
    }
  };

  const attach = (record) => {
    const server = record.server;
    server.on('proxy-log', (level, source, message) => {
      if (owns(record) && !disposed) log(level, source, message);
    });
    server.on('started', ({ port }) => {
      if (!owns(record)) return;
      record.started = true;
      // A resolved IP is not a settings change. Preserve the hostname used to
      // start this instance; the bound port is authoritative even for a request of 0.
      record.config = Object.freeze({ ...record.config, port });
      if (!record.cancelled) notify(record, {
        proxyStatus: 'started', runningConfig: { ...record.config }, connectionCount: 0, errorCode: null,
      });
    });
    server.on('connection', (connectionCount) => notify(record, { connectionCount }));
    server.on('stopped', () => {
      if (!owns(record)) return;
      clearTimers();
      finalizeRemaining(record, record.stopReason);
      record.started = false;
      notify(record, { proxyStatus: 'stopped', runningConfig: null, connectionCount: 0 });
    });
    server.on('error', (error) => {
      if (!owns(record)) return;
      log('error', 'proxy', error.message);
      notify(record, { proxyStatus: 'error', errorCode: record.cancelled ? 'PROXY_STOP_FAILED' : 'PROXY_START_FAILED' });
    });
    server.on('auth-error', ({ statusCode }) => {
      if (visible(record) && (statusCode === 401 || statusCode === 403)) {
        deps.onAuthRequired?.({ ...record.scope, instanceId: record.id, statusCode });
      }
    });
    server.on('session-open', (session) => {
      if (!owns(record) || record.candidate || record.cancelled || record.historyClosed) return;
      const sessionKey = `${record.id}:${session.id}`;
      if (!record.sessions.has(session.id)) {
        record.sessions.set(session.id, { sessionKey,
          bytesSent: session.bytesSent || 0, bytesReceived: session.bytesReceived || 0 });
        history?.register({ sessionKey, profileId: record.historyScope.profileId,
          kind: session.kind, startedAt: session.connectedAt,
          bytesSent: session.bytesSent || 0, bytesReceived: session.bytesReceived || 0 });
      }
      if (!visible(record)) return;
      publish('session-update', { ...record.scope, sequence: ++sequence,
        type: 'open', session, all: server.getSessions() });
      deps.onSession?.('new-session', { ...record.scope });
    });
    server.on('session-close', (data) => {
      if (!owns(record)) return;
      finalizeSession(record, data);
      if (!visible(record)) return;
      publish('session-update', { ...record.scope, sequence: ++sequence,
        type: 'close', ...data, all: server.getSessions().filter((session) => session.id !== data.sessionId) });
      if (!record.cancelled && !record.stopRequested && !record.historyClosed && data.reason === 'network_error') {
        deps.onNetworkError?.({ ...record.scope, instanceId: record.id });
      }
    });
    server.on('traffic', () => {
      if (!visible(record) || trafficTimer !== null) return;
      trafficTimer = clock.setTimeout(() => {
        trafficTimer = null;
        sendStats(record);
      }, 500);
    });
  };

  const cancelListen = () => {
    if (!current || (current.started && !current.candidate)) return;
    current.cancelled = true;
    current.server.setAcceptingConnections?.(false);
    // Do not wait behind start: stop interrupts its pending listen.
    try {
      Promise.resolve(current.server.stop()).catch((error) => log('warn', 'proxy', error.message));
    } catch (error) { log('warn', 'proxy', error.message); }
  };

  const begin = (config, cookie, nextScope, candidate, transactionId, keyMaterial) => {
    const generation = startGeneration;
    return enqueue(async () => {
      if (disposed) throw new ServiceError('SHUTTING_DOWN');
      if (generation !== startGeneration) return { cancelled: true };
      if (current?.started && !current.cancelled && !current.candidate && !candidate) {
        current.server.updateCookie(cookie);
        return { alreadyRunning: true };
      }
      if (current) await stopRecord(current, 'replace');
      if (disposed || generation !== startGeneration) return { cancelled: true };
      let server;
      try {
        const material = keyMaterial || await deps.getKeyMaterial();
        if (disposed || generation !== startGeneration) return { cancelled: true };
        server = deps.createServer({ ...config, ...material, cookie, acceptingConnections: !candidate });
      } catch (error) {
        if (disposed || generation !== startGeneration) return { cancelled: true };
        const failure = error instanceof ServiceError ? error : new ServiceError('PROXY_START_FAILED');
        changed({ ...scope, proxyStatus: 'error', runningConfig: null, errorCode: failure.code });
        log('error', 'proxy', `Initialization failed: ${error.message}`);
        throw failure;
      }
      const record = { server, config: Object.freeze({ ...config }), scope: { ...nextScope },
        id: (deps.createId || require('crypto').randomUUID)(), candidate, transactionId,
        cancelled: false, started: false };
      current = record;
      record.historyScope = Object.freeze({ ...nextScope });
      record.sessions = new Map();
      record.historyClosed = false;
      lastStatsAt = -Infinity;
      attach(record);
      notify(record, { proxyStatus: 'starting', runningConfig: null, connectionCount: 0, errorCode: null });
      try {
        const started = await server.start();
        if (record.cancelled || disposed || generation !== startGeneration || started === false) {
          await stopRecord(record, 'cancelled_start');
          return { cancelled: true };
        }
        // Adapters must still provide a truthful started event/address when using port zero.
        if (!record.started) {
          record.started = true;
          notify(record, { proxyStatus: 'started', runningConfig: { ...record.config }, errorCode: null });
        }
        if (!candidate) {
          startTimers(record);
          sendStats(record);
        }
        return {};
      } catch (error) {
        const cancelled = record.cancelled || disposed || generation !== startGeneration;
        try { await stopRecord(record, 'failed_start'); } catch (stopError) { throw stopError; }
        if (cancelled) return { cancelled: true };
        changed({ ...scope, proxyStatus: 'error', runningConfig: null, errorCode: 'PROXY_START_FAILED' });
        log('error', 'proxy', `Start failed: ${error.message}`);
        throw new ServiceError('PROXY_START_FAILED');
      }
    });
  };

  return {
    start: (config, cookie, nextScope) => begin(config, cookie, nextScope, false),
    startCandidate: ({ config, cookie, scope: nextScope, transactionId, keyMaterial }) => {
      if (typeof transactionId !== 'string' || !transactionId || !keyMaterial) {
        return Promise.reject(new ServiceError('INVALID_ARGUMENT'));
      }
      return begin(config, cookie, nextScope, true, transactionId, keyMaterial);
    },
    activateCandidate: async (transactionId) => {
      const record = current;
      if (!record?.candidate || record.transactionId !== transactionId || !record.started
          || record.cancelled || disposed) throw new ServiceError('INVALID_ARGUMENT');
      const generation = startGeneration;
      const activationScope = { ...scope };
      const committed = await deps.isTransactionCommitted?.(transactionId);
      if (!committed || !owns(record) || record.cancelled || disposed || generation !== startGeneration
          || activationScope.profileId !== scope.profileId || activationScope.epoch !== scope.epoch) {
        throw new ServiceError('KEY_TRANSACTION_FAILED');
      }
      record.server.setAcceptingConnections(true);
      record.candidate = false;
      notify(record, { proxyStatus: 'started', runningConfig: { ...record.config }, errorCode: null });
      startTimers(record);
      sendStats(record);
      return {};
    },
    cancelPendingStart: () => {
      startGeneration += 1;
      cancelListen();
    },
    stop: (reason = 'user_stop') => {
      startGeneration += 1;
      if (current) current.stopRequested = true;
      current?.server.setAcceptingConnections?.(false);
      cancelListen();
      return enqueue(() => current ? stopRecord(current, reason) : {});
    },
    getStats: sample,
    disconnectSession: (id) => current ? current.server.disconnectSession(id) : false,
    setScope: (nextScope) => {
      scope = { ...nextScope };
      if (current) current.scope = { ...nextScope };
      lastStatsAt = -Infinity;
    },
    dispose: async () => {
      disposed = true;
      startGeneration += 1;
      clearTimers();
      cancelListen();
      await enqueue(() => current ? stopRecord(current, 'app_exit') : undefined);
    },
  };
}

module.exports = { createProxyController };
