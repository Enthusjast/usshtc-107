'use strict';

const path = require('node:path');
const { ProxyServer } = require('../electron/proxy-server');
const keys = require('../electron/ssh-key-service');
const { createHealthProbeService } = require('../electron/health-probe-service');

function loadIdentity(options) {
  const client = keys.ensureClientKeyPair({ sshDirectory: options.sshDirectory });
  const hostKey = keys.ensureProxyHostKey(path.join(options.dataDir, 'proxy_host_ed25519'));
  const identity = keys.getSsh2ClientIdentity({ sshDirectory: options.sshDirectory });
  return { client, hostKey, identity };
}
async function startService(options, { ProxyServerClass = ProxyServer, healthClock } = {}) {
  const material = loadIdentity(options);
  const proxy = new ProxyServerClass({
    ...options,
    hostKey: material.hostKey,
    authorizedKey: Buffer.from(material.client.publicKeyRaw, 'base64'),
    authorizedKeyOpenSSH: material.client.publicKey,
  });
  let address;
  proxy.once('started', bound => { address = bound; });
  // Errors are represented by fixed CLI messages, never by upstream response text.
  proxy.on('error', () => {});
  try { await proxy.start(); } catch (error) {
    await proxy.stop().catch(() => {});
    throw error;
  }
  let stopping;
  let health;
  const host = address?.host || proxy.host;
  const port = address?.port ?? proxy.port;
  if (options.healthProbeEnabled === true) {
    const hostKeyPath = path.join(options.dataDir, 'proxy_host_ed25519');
    const initialKeys = keys.inspect({ sshDirectory: options.sshDirectory, hostKeyPath });
    const expected = { clientFingerprint: material.client.fingerprint, hostFingerprint: initialKeys.host.fingerprint };
    const runningConfig = { ...options, host, port };
    let remoteState = { remoteStatus: 'unknown', errorCode: null };
    health = createHealthProbeService({
      clock: healthClock,
      getSnapshot: () => ({ profileId: 'cli', epoch: 1, desiredRunning: !stopping,
        proxyStatus: stopping ? 'stopped' : 'started', operation: null, runningConfig, ...remoteState }),
      getConfig: () => runningConfig,
      getCookie: () => options.cookie,
      getPreferences: () => ({ healthProbeEnabled: true }),
      getKeys: () => keys.inspect({ sshDirectory: options.sshDirectory, hostKeyPath, expected }),
      getClientIdentity: () => keys.getSsh2ClientIdentity({ sshDirectory: options.sshDirectory }),
      onRemoteState: state => { remoteState = state; proxy.emit('health-state', state); },
    });
    proxy.on('auth-error', () => health.cancel('AUTH_REQUIRED'));
    proxy.on('remote-not-ready', event => {
      if (stopping || event?.code !== 'REMOTE_READY_TIMEOUT'
          || event.cookieGeneration !== proxy.getCookieGeneration()
          || !proxy.getSessions().some(session => session.id === event.sessionId)) return;
      remoteState = { ...remoteState, remoteStatus: 'error', errorCode: 'REMOTE_READY_TIMEOUT' };
      proxy.emit('health-state', remoteState);
      health.update();
    });
    proxy.once('stopped', () => health.dispose());
    health.update();
  }
  return {
    proxy, ...material, host, port,
    stop: () => (stopping ||= Promise.resolve().then(() => { health?.dispose(); return proxy.stop(); })),
  };
}
module.exports = { loadIdentity, startService };
