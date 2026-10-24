'use strict';

const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Client, utils: sshUtils } = require('ssh2');
const { ProxyServer } = require('../../electron/proxy-server');
const { DEFAULTS } = require('../../electron/constants');
const { ensureClientKeyPair, ensureProxyHostKey, getSsh2ClientIdentity } = require('../../electron/ssh-key-service');
const { createPortalApiClient, extractScowToken } = require('../../electron/portal-api/client');

const enabled = process.env.LIVE_SMOKE === '1' && Boolean(process.env.SCOW_TOKEN);
const skip = enabled ? false : 'Requires LIVE_SMOKE=1 and SCOW_TOKEN';
const SAFE_CODE = /^[A-Z][A-Z0-9_]{1,79}$/;
const PORTAL_CODES = new Set(['AUTH_REQUIRED', 'OPERATION_CANCELLED', 'PORTAL_AUTH', 'PORTAL_NETWORK',
  'PORTAL_TIMEOUT', 'PORTAL_PERMISSION', 'PORTAL_NOT_FOUND', 'PORTAL_UNIMPLEMENTED', 'PORTAL_QUOTA',
  'PORTAL_UNKNOWN', 'PORTAL_CANCELLED']);

function fail(code) {
  const error = new Error(SAFE_CODE.test(code) ? code : 'LIVE_OPERATION_FAILED');
  error.liveSafe = true;
  throw error;
}
function check(condition, code) { if (!condition) fail(code); }
function sanitized(error, fallback) {
  const code = error?.liveSafe === true && SAFE_CODE.test(error.message) ? error.message
    : PORTAL_CODES.has(error?.code) ? error.code : fallback;
  return Object.assign(new Error(code), { liveSafe: true, code });
}
function liveTest(name, options, body) {
  if (typeof options === 'function') { body = options; options = {}; }
  return test(name, { timeout: 90000, ...options, skip: skip || options.skip }, async (t) => {
    try { await body(t); } catch (error) { throw sanitized(error, 'LIVE_OPERATION_FAILED'); }
  });
}
function cookie(token) {
  check(typeof token === 'string' && token.length > 0 && !/[\r\n\0]/.test(token), 'LIVE_CREDENTIAL_INVALID');
  // SCOW_TOKEN is the cookie value, never a whole Cookie header.
  return `SCOW_USER=${token}`;
}
function portalClient(t, token = process.env.SCOW_TOKEN) {
  check(enabled, 'LIVE_OPT_IN_REQUIRED');
  check(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'LIVE_TLS_VERIFICATION_REQUIRED');
  const client = createPortalApiClient({ cookie: cookie(token) });
  t.after(() => client.dispose());
  return client;
}
function bounded(promise, ms, code, onTimeout = () => {}) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout(); } catch (_) {}
      reject(Object.assign(new Error(code), { liveSafe: true }));
    }, ms);
  })]).finally(() => clearTimeout(timer));
}
function event(emitter, name, { timeout = 15000, predicate = () => true } = {}) {
  let listener;
  let cancel;
  const pending = new Promise((resolve, reject) => {
    listener = (value) => {
      if (predicate(value)) { emitter.removeListener(name, listener); resolve(value); }
    };
    cancel = () => { emitter.removeListener(name, listener); reject(Object.assign(new Error('LIVE_EVENT_CANCELLED'), { liveSafe: true })); };
    emitter.on(name, listener);
  });
  const result = bounded(pending, timeout, 'LIVE_EVENT_TIMEOUT', () => emitter.removeListener(name, listener));
  // A concurrently opening SSH channel may fail before this event is awaited.
  result.catch(() => {});
  result.cancel = cancel;
  return result;
}

function isLocalFixture(overrides, backend) {
  if (backend !== 'proxy' || !Object.hasOwn(overrides, 'cookie') || !Object.hasOwn(overrides, 'tlsCa')) return false;
  const ca = overrides.tlsCa;
  if (!(Buffer.isBuffer(ca) && ca.length > 0) && !(typeof ca === 'string' && ca.trim())) return false;
  try {
    const endpoint = new URL(overrides.wssUrl);
    return endpoint.protocol === 'wss:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname)
      && Number(endpoint.port) > 0 && !endpoint.username && !endpoint.password && !endpoint.hash
      && Boolean(extractScowToken(overrides.cookie));
  } catch (_) { return false; }
}

async function harness(t, overrides = {}, { backend = process.env.LIVE_BACKEND || 'proxy', onListening } = {}) {
  const localFixture = isLocalFixture(overrides, backend);
  // Endpoint overrides belong only to explicit TLS loopback fixtures. Live runs
  // use the fixed production endpoint and still require both opt-in variables.
  check(localFixture || (enabled && !Object.hasOwn(overrides, 'wssUrl')), 'LIVE_OPT_IN_REQUIRED');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc107-live-'));
  const clients = new Set();
  const channels = new Set();
  let proxy;
  let stopProxy = () => proxy.stop();
  t.after(async () => {
    let cleanupFailed = false;
    for (const channel of channels) { try { channel.destroy(); } catch (_) { cleanupFailed = true; } }
    for (const client of clients) { try { client.destroy(); } catch (_) { cleanupFailed = true; } }
    try { if (proxy) await bounded(stopProxy(), 5000, 'LIVE_PROXY_CLEANUP_TIMEOUT'); }
    catch (_) { cleanupFailed = true; }
    try { fs.rmSync(root, { recursive: true, force: true }); }
    catch (_) { cleanupFailed = true; }
    check(!cleanupFailed, 'LIVE_PROXY_CLEANUP_FAILED');
  });
  try {
    fs.chmodSync(root, 0o700);
    check(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'LIVE_TLS_VERIFICATION_REQUIRED');
    check(backend === 'proxy' || backend === 'cli', 'LIVE_BACKEND_INVALID');
    const sshDirectory = path.join(root, 'identity');
    const options = {
      cookie: localFixture ? overrides.cookie : overrides.cookie ?? cookie(process.env.SCOW_TOKEN),
      cluster: process.env.SCOW_CLUSTER || DEFAULTS.cluster,
      loginNode: process.env.SCOW_LOGIN_NODE || DEFAULTS.loginNode,
      cols: DEFAULTS.cols, rows: DEFAULTS.rows,
      execTimeoutMs: 45000, remoteReadyTimeoutMs: 10000, shutdownTimeoutMs: 1500,
      ...overrides,
      // Never bind a user's configured interface or reuse a user's identity.
      host: '127.0.0.1', port: 0,
    };
    let identity;
    let hostBlob;
    let address;
    if (backend === 'cli') {
      const { startService } = require('../../cli/service.cjs');
      const dataDir = path.join(root, 'service');
      fs.mkdirSync(dataDir, { mode: 0o700 });
      class ObservedProxy extends ProxyServer {
        constructor(config) {
          super(config);
          this.once('started', () => onListening?.());
        }
      }
      const service = await startService({ ...options, dataDir, sshDirectory }, { ProxyServerClass: ObservedProxy });
      proxy = service.proxy;
      address = { host: service.host, port: service.port };
      identity = service.identity;
      hostBlob = sshUtils.parseKey(service.hostKey).getPublicSSH();
      stopProxy = service.stop;
    } else {
      const diskIdentity = ensureClientKeyPair({ sshDirectory });
      identity = getSsh2ClientIdentity({ sshDirectory });
      const hostKey = ensureProxyHostKey(path.join(root, 'host-key'));
      hostBlob = sshUtils.parseKey(hostKey).getPublicSSH();
      proxy = new ProxyServer({ ...options, hostKey,
        authorizedKey: Buffer.from(diskIdentity.publicKeyRaw, 'base64'),
        authorizedKeyOpenSSH: diskIdentity.publicKey,
      });
      // Do not forward proxy logs, SSH errors, commands or remote output to TAP.
      proxy.on('error', () => {});
      const started = event(proxy, 'started');
      await proxy.start();
      onListening?.();
      address = await started;
    }
    check(address.host === '127.0.0.1' && address.port > 0, 'LIVE_LISTENER_INVALID');
    async function connect() {
      const client = new Client();
      clients.add(client);
      client.on('error', () => {});
      client.on('close', () => clients.delete(client));
      try {
        await bounded(new Promise((resolve, reject) => {
          const failed = () => { client.removeListener('ready', ready); reject(new Error('SSH_CONNECT_FAILED')); };
          const ready = () => { client.removeListener('error', failed); resolve(); };
          client.once('error', failed);
          client.once('ready', ready);
          client.connect({
            host: address.host, port: address.port, username: 'live-test',
            privateKey: identity.privateKey, readyTimeout: 10000,
            hostVerifier: (key) => key.length === hostBlob.length && crypto.timingSafeEqual(key, hostBlob),
          });
        }), 12000, 'LIVE_SSH_CONNECT_TIMEOUT', () => client.destroy());
        return client;
      } catch (_) { client.destroy(); fail('LIVE_SSH_CONNECT_FAILED'); }
    }
    async function open(client, kind, command, options = {}) {
      const channel = await bounded(new Promise((resolve, reject) => {
        const callback = (error, stream) => error ? reject(new Error('SSH_CHANNEL_FAILED')) : resolve(stream);
        if (kind === 'exec') client.exec(command, options, callback);
        else client.shell({ term: 'xterm-256color', cols: 80, rows: 24, ...options }, callback);
      }), 12000, 'LIVE_CHANNEL_OPEN_TIMEOUT', () => client.destroy()).catch(() => fail('LIVE_CHANNEL_OPEN_FAILED'));
      channels.add(channel);
      channel.on('close', () => channels.delete(channel));
      return observe(channel);
    }
    return {
      proxy, connect,
      shell: (client, options) => open(client, 'shell', undefined, options),
      execChannel: (client, command, options) => open(client, 'exec', command, options),
      async exec(command, { input, timeout = 60000 } = {}) {
        const startedAt = performance.now();
        const client = await connect();
        try {
          const observation = await open(client, 'exec', command);
          if (input !== undefined) observation.channel.write(input);
          observation.channel.end();
          await observation.closed(timeout);
          return { output: observation.bytes(), stderr: observation.errors(), code: observation.code,
            signal: observation.signal, latencyMs: performance.now() - startedAt };
        } finally { client.destroy(); }
      },
    };
  } catch (error) { throw sanitized(error, 'LIVE_HARNESS_SETUP_FAILED'); }
}

function observe(channel) {
  const events = new EventEmitter();
  const chunks = [];
  const errors = [];
  let length = 0;
  let errorLength = 0;
  let closed = false;
  let code = null;
  let signal = null;
  let failed = false;
  const limit = 16 * 1024 * 1024;
  channel.on('data', (chunk) => {
    length += chunk.length;
    if (length > limit) { failed = true; channel.destroy(); }
    else chunks.push(Buffer.from(chunk));
    events.emit('change');
  });
  channel.stderr.on('data', (chunk) => {
    errorLength += chunk.length;
    if (errorLength > 65536) { failed = true; channel.destroy(); }
    else errors.push(Buffer.from(chunk));
  });
  channel.on('error', () => { failed = true; events.emit('change'); });
  channel.on('exit', (value, valueSignal) => { code = value; signal = valueSignal; });
  channel.on('close', () => { closed = true; events.emit('change'); });
  const result = {
    channel,
    get code() { return code; }, get signal() { return signal; }, get isClosed() { return closed; },
    bytes: () => Buffer.concat(chunks), errors: () => Buffer.concat(errors),
    text: () => Buffer.concat(chunks).toString('utf8'),
    async waitFor(predicate, timeout = 15000) {
      let cleanup = () => {};
      try {
        await bounded(new Promise((resolve, reject) => {
          function changed() {
            if (failed) { cleanup(); reject(Object.assign(new Error('LIVE_CHANNEL_FAILED'), { liveSafe: true })); }
            else if (predicate(result)) { cleanup(); resolve(); }
            else if (closed) { cleanup(); reject(Object.assign(new Error('LIVE_CHANNEL_CLOSED_EARLY'), { liveSafe: true })); }
          }
          cleanup = () => events.removeListener('change', changed);
          events.on('change', changed);
          changed();
        }), timeout, 'LIVE_OUTPUT_TIMEOUT');
      } finally { cleanup(); }
    },
    async closed(timeout = 60000) {
      if (!closed) await event(events, 'change', { timeout, predicate: () => closed });
      check(!failed, 'LIVE_CHANNEL_FAILED');
    },
    async remainsOpen(ms = 2000) {
      check(!closed, 'LIVE_CHANNEL_CLOSED_EARLY');
      await new Promise((resolve, reject) => {
        const changed = () => { if (closed || failed) { clearTimeout(timer); events.removeListener('change', changed); reject(Object.assign(new Error('LIVE_CHANNEL_CLOSED_EARLY'), { liveSafe: true })); } };
        const timer = setTimeout(() => { events.removeListener('change', changed); resolve(); }, ms);
        events.on('change', changed);
      });
    },
  };
  return result;
}
function nonce() { return crypto.randomBytes(16).toString('hex'); }
function quantile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil((sorted.length - 1) * fraction)]);
}

module.exports = { liveTest, enabled, harness, portalClient, check, fail, cookie, event, bounded, nonce, quantile };
