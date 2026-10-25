'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Client, utils: sshUtils } = require('ssh2');
const { ProxyServer } = require('../../electron/proxy-server');
const { ensureClientKeyPair, ensureProxyHostKey, getSsh2ClientIdentity } = require('../../electron/ssh-key-service');
const { extractScowToken } = require('../../electron/portal-api/client');

function fail(code) { throw Object.assign(new Error(code), { code }); }
function check(condition, code) { if (!condition) fail(code); }
function bounded(promise, ms, code, onTimeout = () => {}) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout(); } catch (_) {}
      reject(Object.assign(new Error(code), { code }));
    }, ms);
  })]).finally(() => clearTimeout(timer));
}
function event(emitter, name, { timeout = 15000, predicate = () => true } = {}) {
  let listener;
  const pending = new Promise(resolve => {
    listener = value => {
      if (predicate(value)) { emitter.removeListener(name, listener); resolve(value); }
    };
    emitter.on(name, listener);
  });
  const result = bounded(pending, timeout, 'LOCAL_EVENT_TIMEOUT', () => emitter.removeListener(name, listener));
  // A channel may fail before the caller reaches its event await.
  result.catch(() => {});
  return result;
}

function isLocalFixture(overrides) {
  if (!overrides || !Object.hasOwn(overrides, 'cookie') || !Object.hasOwn(overrides, 'tlsCa')) return false;
  const ca = overrides.tlsCa;
  if (!(Buffer.isBuffer(ca) && ca.length > 0) && !(typeof ca === 'string' && ca.trim())) return false;
  try {
    const endpoint = new URL(overrides.wssUrl);
    return endpoint.protocol === 'wss:' && ['127.0.0.1', '[::1]'].includes(endpoint.hostname)
      && Number(endpoint.port) > 0 && !endpoint.username && !endpoint.password && !endpoint.hash
      && Boolean(extractScowToken(overrides.cookie));
  } catch (_) { return false; }
}

async function harness(t, overrides = {}) {
  // No environment-controlled backend or production endpoint fallback.
  check(isLocalFixture(overrides), 'LOCAL_FIXTURE_REQUIRED');
  const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'usshtc107-transport-'));
  const clients = new Set();
  const channels = new Set();
  let proxy;
  let stopProxy = () => proxy.stop();
  t.after(async () => {
    let cleanupFailed = false;
    for (const channel of channels) { try { channel.destroy(); } catch (_) { cleanupFailed = true; } }
    for (const client of clients) { try { client.destroy(); } catch (_) { cleanupFailed = true; } }
    try { if (proxy) await bounded(stopProxy(), 5000, 'LOCAL_PROXY_CLEANUP_TIMEOUT'); }
    catch (_) { cleanupFailed = true; }
    try { fs.rmSync(root, { recursive: true, force: true }); }
    catch (_) { cleanupFailed = true; }
    check(!cleanupFailed, 'LOCAL_PROXY_CLEANUP_FAILED');
  });
  try {
    fs.chmodSync(root, 0o700);
    check(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'LOCAL_TLS_VERIFICATION_REQUIRED');
    const sshDirectory = path.join(root, 'identity');
    const options = {
      cookie: overrides.cookie,
      cluster: 'fixture', loginNode: '127.0.0.1', cols: 80, rows: 24,
      execTimeoutMs: 45000, remoteReadyTimeoutMs: 10000, shutdownTimeoutMs: 1500,
      ...overrides,
      // Never bind a user's configured interface or reuse a user's identity.
      host: '127.0.0.1', port: 0,
    };
    const diskIdentity = ensureClientKeyPair({ sshDirectory });
    const identity = getSsh2ClientIdentity({ sshDirectory });
    const hostKeyPath = path.join(root, 'host-key');
    const hostKey = ensureProxyHostKey(hostKeyPath);
    const hostBlob = sshUtils.parseKey(hostKey).getPublicSSH();
    proxy = new ProxyServer({ ...options, hostKey, hostKeyPath,
      scpTempDirectory: path.join(root, 'scp-tmp'),
      authorizedKey: Buffer.from(diskIdentity.publicKeyRaw, 'base64'),
      authorizedKeyOpenSSH: diskIdentity.publicKey,
    });
    proxy.on('error', () => {});
    const started = event(proxy, 'started');
    await proxy.start();
    const address = await started;
    check(address.host === '127.0.0.1' && address.port > 0, 'LOCAL_LISTENER_INVALID');
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
            host: address.host, port: address.port, username: 'fixture',
            privateKey: identity.privateKey, readyTimeout: 10000,
            hostVerifier: (key) => key.length === hostBlob.length && crypto.timingSafeEqual(key, hostBlob),
          });
        }), 12000, 'LOCAL_SSH_CONNECT_TIMEOUT', () => client.destroy());
        return client;
      } catch (_) { client.destroy(); fail('LOCAL_SSH_CONNECT_FAILED'); }
    }
    async function open(client, kind, command, options = {}) {
      const channel = await bounded(new Promise((resolve, reject) => {
        const callback = (error, stream) => error ? reject(new Error('SSH_CHANNEL_FAILED')) : resolve(stream);
        if (kind === 'exec') client.exec(command, options, callback);
        else client.shell({ term: 'xterm-256color', cols: 80, rows: 24, ...options }, callback);
      }), 12000, 'LOCAL_CHANNEL_OPEN_TIMEOUT', () => client.destroy()).catch(() => fail('LOCAL_CHANNEL_OPEN_FAILED'));
      channels.add(channel);
      channel.on('close', () => channels.delete(channel));
      return observe(channel);
    }
    return {
      proxy, connect,
      shell: (client, options) => open(client, 'shell', undefined, options),
      execChannel: (client, command, options) => open(client, 'exec', command, options),
    };
  } catch (error) { throw new Error('LOCAL_HARNESS_SETUP_FAILED', { cause: error }); }
}

function observe(channel) {
  const events = new EventEmitter();
  const chunks = [];
  const errors = [];
  let length = 0;
  let errorLength = 0;
  let closed = false;
  let code = null;
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
  channel.on('exit', value => { code = value; });
  channel.on('close', () => { closed = true; events.emit('change'); });
  const result = {
    channel,
    get code() { return code; },
    bytes: () => Buffer.concat(chunks), errors: () => Buffer.concat(errors),
    async closed(timeout = 60000) {
      if (!closed) await event(events, 'change', { timeout, predicate: () => closed });
      check(!failed, 'LOCAL_CHANNEL_FAILED');
    },
  };
  return result;
}

module.exports = { harness, check, event, bounded };
