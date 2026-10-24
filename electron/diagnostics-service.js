const crypto = require('node:crypto');
const dns = require('node:dns');
const net = require('node:net');
const tls = require('node:tls');
const { Client } = require('ssh2');
const { WebSocket } = require('ws');
const { validateSettingsPatch } = require('../shared/settings-schema.mjs');
const { PLATFORM, MAX_WSS_PAYLOAD_BYTES } = require('./constants');
const { buildWssUrl, buildWssOptions } = require('./wss-connection');

const CHECK_IDS = Object.freeze(['settings', 'keys', 'ssh-config', 'local-listener', 'dns', 'tls', 'wss']);
const CONFIG_FIELDS = Object.freeze(['host', 'port', 'cluster', 'loginNode', 'cols', 'rows', 'useRoot', 'sshAlias', 'wssUrl']);
const KEY_CODES = new Set(['SSH_KEY_MISSING', 'SSH_KEY_INVALID', 'SSH_KEY_PERMISSIONS', 'SSH_KEY_FINGERPRINT_MISMATCH']);
const CONFIG_CODES = new Set(['SSH_CONFIG_OK', 'SSH_CONFIG_MISSING', 'SSH_CONFIG_MISMATCH', 'SSH_ALIAS_CONFLICT', 'SSH_CONFIG_INVALID']);
const CHECK_TIMEOUT_MS = 5000;
const RUN_TIMEOUT_MS = 30000;
const clone = (value) => structuredClone(value);
const failure = (code) => Object.assign(new Error(code), { code });

function fingerprintConfig(config = {}) {
  return crypto.createHash('sha256').update(JSON.stringify(CONFIG_FIELDS.map((key) => (
    key === 'wssUrl' ? buildWssUrl(config || {}) : config?.[key] ?? null
  )))).digest('hex');
}

function defaultLookup(host, callback) {
  const resolver = new dns.Resolver();
  resolver.resolve(host, callback);
  return resolver;
}

// A probe owns every resource it creates. All completion paths, including abort,
// remove its handlers and close resources; late transport errors are discarded.
function probe(signal, start) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      for (const close of cleanup.reverse()) { try { close(); } catch (_) {} }
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(failure(signal.reason || 'CANCELLED'));
    const own = (resource, close) => {
      const disposeResource = () => {
        resource?.on?.('error', () => {});
        close();
      };
      if (settled) disposeResource(); else cleanup.push(disposeResource);
      return resource;
    };
    const listen = (resource, event, handler) => {
      if (settled) return;
      resource.on(event, handler);
      cleanup.push(() => resource.removeListener(event, handler));
    };
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    try { start({ finish, own, listen }); } catch (error) { finish(error); }
  });
}

function createDiagnosticsService(deps) {
  const adapters = deps.adapters || {};
  const now = adapters.now || Date.now;
  const setTimer = adapters.setTimeout || setTimeout;
  const clearTimer = adapters.clearTimeout || clearTimeout;
  const lookup = adapters.lookup || defaultLookup;
  const connectTls = adapters.connectTls || ((options) => tls.connect(options));
  const createWebSocket = adapters.createWebSocket || ((url, options) => new WebSocket(url, options));
  const createSshClient = adapters.createSshClient || (() => new Client());
  const createServer = adapters.createServer || ((listener) => net.createServer(listener));
  let active = null;
  let currentRunId = null;
  let latest = null;
  let disposed = false;

  function publish(dto) {
    if (disposed || currentRunId !== dto.runId) return;
    latest = clone(dto);
    try { deps.onState?.(clone(dto)); } catch (_) { /* Observers cannot retain probe resources. */ }
  }

  function get(scope) {
    if (!latest || latest.profileId !== scope.profileId || latest.epoch !== scope.epoch) return null;
    try {
      if (latest.configFingerprint !== fingerprintConfig(deps.getConfig(scope))) return null;
    } catch (_) { return null; }
    return clone(latest);
  }

  function run({ profileId, epoch, signal }) {
    if (disposed) return Promise.reject(failure('CANCELLED'));
    const scope = Object.freeze({ profileId, epoch });
    let config;
    let configError = null;
    try { config = Object.freeze({ ...deps.getConfig(scope) }); } catch (error) { configError = error; config = Object.freeze({}); }
    const configFingerprint = fingerprintConfig(config);
    if (active && active.profileId === profileId && active.epoch === epoch
        && active.configFingerprint === configFingerprint) return active.promise;
    active?.controller.abort('CANCELLED');
    const controller = new AbortController();
    const entry = { profileId, epoch, configFingerprint, controller, promise: null };
    active = entry;
    const externalAbort = () => controller.abort('CANCELLED');
    if (signal?.aborted) externalAbort();
    else signal?.addEventListener('abort', externalAbort, { once: true });
    const deadline = setTimer(() => controller.abort('DIAGNOSTIC_DEADLINE'), RUN_TIMEOUT_MS);
    const dto = {
      runId: crypto.randomUUID(), profileId, epoch, configFingerprint,
      startedAt: new Date(now()).toISOString(), finishedAt: null,
      checks: CHECK_IDS.map((id) => ({ id, status: 'pending', code: null, durationMs: 0 })),
    };
    entry.runId = dto.runId;
    currentRunId = dto.runId;
    const runtime = (() => { try { return clone(deps.getRuntime(scope)) || {}; } catch (_) { return {}; } })();
    let keys;
    let cookie;
    try { cookie = deps.getCookie(scope); } catch (_) { cookie = ''; }
    let authRequired = false;
    const passed = (id) => dto.checks.find((check) => check.id === id).status === 'passed';

    async function check(id, dependencies, execute, fallback, mode) {
      const item = dto.checks.find((value) => value.id === id);
      if (mode) item.mode = mode;
      if (controller.signal.aborted || dependencies.some((dependency) => !passed(dependency))) {
        item.status = 'skipped';
        item.code = controller.signal.aborted ? controller.signal.reason : 'DEPENDENCY_FAILED';
        publish(dto);
        return;
      }
      item.status = 'running';
      const started = now();
      publish(dto);
      const checkController = new AbortController();
      const abort = () => checkController.abort(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
      const timer = setTimer(() => checkController.abort('TIMEOUT'), CHECK_TIMEOUT_MS);
      try {
        // Race even injected asynchronous local inspections; a stalled adapter
        // cannot hold the single-flight slot past the check deadline.
        const code = await probe(checkController.signal, ({ finish }) => {
          Promise.resolve().then(() => execute(checkController.signal)).then((value) => finish(null, value), finish);
        });
        item.code = code;
        item.status = code.endsWith('_OK') || code === 'LOCAL_PORT_AVAILABLE' ? 'passed' : 'failed';
      } catch (error) {
        const reason = checkController.signal.aborted ? checkController.signal.reason : null;
        item.code = reason || fallback(error);
        item.status = item.code === 'CANCELLED' ? 'skipped' : 'failed';
      } finally {
        clearTimer(timer);
        controller.signal.removeEventListener('abort', abort);
        item.durationMs = Math.max(0, now() - started);
        publish(dto);
      }
    }

    async function execute() {
      publish(dto);
      await check('settings', [], () => {
        if (runtime.storageErrorCode || configError?.code === 'SETTINGS_LOCKED') return 'SETTINGS_LOCKED';
        if (configError) return 'SETTINGS_INVALID';
        const input = Object.fromEntries(CONFIG_FIELDS.filter((key) => key !== 'wssUrl').map((key) => [key, config[key]]));
        return validateSettingsPatch(input).ok ? 'SETTINGS_OK' : 'SETTINGS_INVALID';
      }, () => 'SETTINGS_INVALID');
      await check('keys', [], async () => {
        keys = await deps.getKeys(scope);
        for (const role of ['client', 'host']) {
          const key = keys?.[role];
          if (key?.state !== 'ready') {
            if (KEY_CODES.has(key?.errorCode)) return key.errorCode;
            return key?.state === 'missing' ? 'SSH_KEY_MISSING' : key?.state === 'changed'
              ? 'SSH_KEY_FINGERPRINT_MISMATCH' : 'SSH_KEY_INVALID';
          }
        }
        return 'KEYS_OK';
      }, (error) => KEY_CODES.has(error?.code) ? error.code : 'SSH_KEY_INVALID');
      await check('ssh-config', ['settings'], async () => {
        const result = await deps.inspectSshConfig(scope, config);
        return CONFIG_CODES.has(result?.code) ? result.code : 'SSH_CONFIG_INVALID';
      }, (error) => CONFIG_CODES.has(error?.code) ? error.code : 'SSH_CONFIG_INVALID');
      const running = runtime.proxyStatus === 'started';
      await check('local-listener', running ? ['settings', 'keys'] : ['settings'], async (checkSignal) => {
        if (!running) {
          return probe(checkSignal, ({ finish, own, listen }) => {
            const sockets = new Set();
            const server = own(createServer((socket) => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); socket.destroy(); }), () => {
              for (const socket of sockets) socket.destroy();
              server.close();
            });
            listen(server, 'error', (error) => finish(failure(error.code === 'EADDRINUSE' ? 'PORT_IN_USE' : 'LOCAL_SSH_FAILED')));
            server.listen({ host: config.host, port: config.port, exclusive: true }, () => {
              // Do not report success until the temporary listener has closed.
              server.close((error) => finish(error, 'LOCAL_PORT_AVAILABLE'));
            });
          });
        }
        const identity = await deps.getClientIdentity(scope);
        if (checkSignal.aborted) throw failure(checkSignal.reason);
        const runningConfig = runtime.runningConfig || config;
        const host = runningConfig.host === '0.0.0.0' ? '127.0.0.1' : runningConfig.host === '::' ? '::1' : runningConfig.host;
        return probe(checkSignal, ({ finish, own, listen }) => {
          const client = own(createSshClient(), () => client.destroy());
          listen(client, 'ready', () => { client.end(); finish(null, 'LOCAL_SSH_OK'); });
          listen(client, 'error', () => finish(failure('LOCAL_SSH_FAILED')));
          listen(client, 'close', () => finish(failure('LOCAL_SSH_FAILED')));
          client.connect({ host, port: runningConfig.port, username: 'user', privateKey: identity.privateKey,
            readyTimeout: CHECK_TIMEOUT_MS,
            hostVerifier: (wire) => {
              const fingerprint = `SHA256:${crypto.createHash('sha256').update(wire).digest('base64').replace(/=+$/, '')}`;
              return fingerprint === keys.host.fingerprint;
            },
          });
        });
      }, (error) => error?.code === 'PORT_IN_USE' ? 'PORT_IN_USE' : 'LOCAL_SSH_FAILED', running ? 'ssh-auth' : 'bind-only');
      await check('dns', [], (checkSignal) => probe(checkSignal, ({ finish, own }) => {
        const request = lookup(PLATFORM.domain, (error, addresses) => {
          finish(error || (!addresses?.length ? failure('DNS_FAILED') : null), 'DNS_OK');
        });
        if (request?.cancel) own(request, () => request.cancel());
      }), () => 'DNS_FAILED');
      await check('tls', ['dns'], (checkSignal) => probe(checkSignal, ({ finish, own, listen }) => {
        const sharedOptions = buildWssOptions({ tlsCa: adapters.tlsCa });
        const socket = own(connectTls({ host: PLATFORM.domain, port: 443, servername: PLATFORM.domain,
          rejectUnauthorized: sharedOptions.rejectUnauthorized, ...(sharedOptions.ca ? { ca: sharedOptions.ca } : {}) }), () => socket.destroy());
        listen(socket, 'secureConnect', () => finish(socket.authorized === true ? null : failure('TLS_FAILED'), 'TLS_OK'));
        listen(socket, 'error', () => finish(failure('TLS_FAILED')));
        listen(socket, 'close', () => finish(failure('TLS_FAILED')));
      }), () => 'TLS_FAILED');
      if (!cookie && !controller.signal.aborted && passed('settings') && passed('tls')) {
        const item = dto.checks.find((value) => value.id === 'wss');
        item.status = 'skipped'; item.code = 'AUTH_REQUIRED'; publish(dto);
      } else {
        await check('wss', ['settings', 'tls'], (checkSignal) => probe(checkSignal, ({ finish, own, listen }) => {
          const ws = own(createWebSocket(buildWssUrl(config), buildWssOptions({ cookie, tlsCa: adapters.tlsCa,
            handshakeTimeoutMs: CHECK_TIMEOUT_MS, maxPayload: MAX_WSS_PAYLOAD_BYTES })), () => {
            if (ws.readyState === 1) ws.close();
            ws.terminate();
          });
          listen(ws, 'open', () => finish(null, 'WSS_HANDSHAKE_OK'));
          listen(ws, 'unexpected-response', (_request, response) => {
            response.on?.('error', () => {});
            response.destroy?.();
            const auth = response.statusCode === 401 || response.statusCode === 403;
            if (auth) {
              let currentCookie;
              try { currentCookie = deps.getCookie(scope); } catch (_) {}
              if (active !== entry || checkSignal.aborted || currentCookie !== cookie) {
                return finish(failure('CANCELLED'));
              }
              authRequired = true;
            }
            finish(failure(auth ? 'AUTH_REQUIRED' : 'WSS_FAILED'));
          });
          listen(ws, 'error', (error) => finish(failure(['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'ECONNREFUSED'].includes(error?.code)
            ? 'NETWORK_UNAVAILABLE' : 'WSS_FAILED')));
          listen(ws, 'close', () => finish(failure('WSS_FAILED')));
        }), (error) => ['AUTH_REQUIRED', 'NETWORK_UNAVAILABLE', 'CANCELLED'].includes(error?.code) ? error.code : 'WSS_FAILED');
      }
      dto.finishedAt = new Date(now()).toISOString();
      publish(dto);
      if (authRequired && active === entry && !controller.signal.aborted) {
        let currentCookie;
        try { currentCookie = deps.getCookie(scope); } catch (_) {}
        if (currentCookie === cookie) {
          try { Promise.resolve(deps.onAuthRequired?.(scope)).catch(() => {}); } catch (_) {}
        }
      }
      return clone(dto);
    }
    // Defer execution so the entry already owns its promise when observers run.
    entry.promise = Promise.resolve().then(execute).finally(() => {
      clearTimer(deadline);
      signal?.removeEventListener('abort', externalAbort);
      if (active === entry) active = null;
    });
    return entry.promise;
  }

  function dispose() {
    disposed = true;
    active?.controller.abort('CANCELLED');
    latest = null;
  }

  return { run, get, dispose };
}

module.exports = { createDiagnosticsService, fingerprintConfig };
