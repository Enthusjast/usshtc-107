'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createAppController } = require('../../electron/app-controller');
const { createProxyController } = require('../../electron/proxy-controller');
const { ProxyServer } = require('../../electron/proxy-server');
const { createDefaultRoot } = require('../../electron/settings-store');
const { ensureClientKeyPair, ensureProxyHostKey } = require('../../electron/ssh-key-service');

test('a real hostname bind does not falsely require restart when saved configuration is unchanged', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc107-host-bind-'));
  const reservation = net.createServer();
  let controller;
  t.after(async () => {
    await controller?.dispose();
    if (reservation.listening) await new Promise(resolve => reservation.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, 'localhost', resolve); });
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const identity = ensureClientKeyPair({ sshDirectory: path.join(directory, 'ssh') });
  const hostKey = ensureProxyHostKey(path.join(directory, 'host-key'));
  let callbacks;
  let scope;
  let document = createDefaultRoot({ host: 'localhost', port, autoConnect: false });
  let bound;
  const proxy = createProxyController({
    createServer: options => {
      const server = new ProxyServer(options);
      server.on('started', address => { bound = address; });
      return server;
    },
    getKeyMaterial: () => ({ hostKey, authorizedKey: Buffer.from(identity.publicKeyRaw, 'base64'), authorizedKeyOpenSSH: identity.publicKey }),
    onState: patch => callbacks?.onProxyState(patch),
  });
  const login = {
    getCookie: () => 'fixture=local-only',
    setScope: value => { scope = value; },
    setProfile: value => {
      scope = value;
      callbacks.onLoginState({ ...scope, authGeneration: 1, loginStatus: 'success', cookieValid: true, cookieCount: 1 });
    },
    dispose() {},
  };
  controller = createAppController({ proxy, login,
    settingsStore: { getRoot: () => document, isLocked: () => false, getStorageErrorCode: () => null,
      save: candidate => { document = candidate; return { state: 'committed', durable: true }; } },
    createCredentialStore: () => ({ getSsoStatus: () => ({ username: '', hasPassword: false, storageAvailable: false }) }),
    bindCallbacks: value => { callbacks = value; },
  });
  const initial = controller.getSnapshot();
  await controller.run('start', { scope: { profileId: initial.profileId, epoch: initial.epoch } });
  assert.ok(net.isIP(bound.host));
  assert.equal(bound.port, port);
  const running = controller.getSnapshot();
  assert.equal(running.proxyStatus, 'started');
  assert.equal(running.needsRestart, false);
  assert.equal(running.runningConfig.host, 'localhost');
  assert.equal(running.runningConfig.port, port);
});
