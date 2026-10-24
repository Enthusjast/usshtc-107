'use strict';

// Deliberately outside the production entry and builder.files. Only the main
// process owns fixture controls; nothing is added to preload or renderer IPC.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');
const tls = require('node:tls');
const { once } = require('node:events');
const electron = require('electron');
const { WebSocket, WebSocketServer } = require('ws');
const { installNetworkGuard } = require('./electron-network-guard.cjs');
const { createRemoteExecPeer } = require('./remote-exec-peer.cjs');

const root = fs.realpathSync(process.env.USSHTC107_FIXTURE_ROOT || '');
if (!path.isAbsolute(root) || root !== process.env.USSHTC107_FIXTURE_ROOT
    || electron.app.commandLine.getSwitchValue('user-data-dir') !== path.join(root, 'userData')) {
  throw new Error('Source acceptance requires an isolated canonical fixture root');
}
fs.chmodSync(root, 0o700);
const shellUrl = 'https://107.ustc.edu.cn/shell/training/11.11.10.202';
const platformUrl = 'https://107.ustc.edu.cn/';
const casUrl = 'https://id.ustc.edu.cn/cas/login';
const returnUrl = 'https://107.ustc.edu.cn/fixture-return';
const control = {
  root, authVisits: [], upgradeCookies: [], proxyInstances: [], confirmations: [],
  confirmResponse: 1, exports: [], nextExport: null, holdDns: false, pendingDns: null,
  releaseDns() { const callback = this.pendingDns; this.pendingDns = null; this.holdDns = false; callback?.(); },
  emitLogs(count) {
    const proxy = this.proxyInstances.at(-1);
    if (!proxy) throw new Error('Log fixture requires an actual ProxyServer instance');
    for (let index = 0; index < count; index += 1) proxy.emit('proxy-log', 'info', 'proxy',
      `fixture-log-${index} ${path.join(root, 'home')} password=fixture-secret-password ticket=fixture-secret-ticket Cookie: fixture-secret-cookie Authorization: Bearer fixture-secret-token`);
  },
};
Object.defineProperty(electron.app, '__acceptance', { value: control });

const vaultKey = crypto.randomBytes(32);
const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => 'acceptance-test-vault',
  encryptString(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', vaultKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  },
  decryptString(value) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', vaultKey, value.subarray(0, 12));
    decipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
  },
};
const dialog = {
  async showMessageBox(parent, options) {
    if (!parent || parent.isDestroyed() || options.defaultId !== 1 || options.cancelId !== 1) throw new Error('Unsafe confirmation contract');
    control.confirmations.push({ ...options, parentId: parent.id });
    return { response: control.confirmResponse };
  },
  async showSaveDialog(parent, options) {
    if (!parent || parent.isDestroyed()) throw new Error('Export must have a parent');
    const destination = control.nextExport;
    control.nextExport = null;
    if (!destination) return { canceled: true };
    const filePath = path.join(root, 'exports', path.basename(destination));
    control.exports.push({ filePath, title: options.title });
    return { canceled: false, filePath };
  },
  async showOpenDialog() { return { canceled: true, filePaths: [] }; },
};
const clock = {
  now: () => performance.now(), wallNow: () => Date.now(), setTimeout: (...args) => setTimeout(...args), clearTimeout,
  setInterval: (...args) => setInterval(...args), clearInterval,
};
const certificate = fs.readFileSync(path.join(__dirname, 'loopback-test-only-cert.pem'));
const key = fs.readFileSync(path.join(__dirname, 'loopback-test-only-key.pem'));
const server = https.createServer({ cert: certificate, key }, (_request, response) => { response.writeHead(404); response.end(); });
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  if (request.headers.origin !== 'https://107.ustc.edu.cn' || !/^SCOW_USER=fixture-(?:A|B)$/.test(request.headers.cookie || '')) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  control.upgradeCookies.push(request.headers.cookie);
  wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
});
wss.on('connection', (ws) => {
  ws.on('error', () => {});
  let peer = null;
  ws.send(JSON.stringify({ $case: 'data', data: { data: '' } }));
  ws.on('close', () => peer?.kill());
  ws.on('message', (raw) => {
    const message = JSON.parse(raw);
    if (message.$case === 'data') {
      if (!peer && message.data.data.startsWith('exec sh -c ')) {
        // Execute the actual bridge protocol; an echoed command cannot prove exec.
        peer = createRemoteExecPeer({
          onData(data) { if (ws.readyState === 1) ws.send(JSON.stringify({ $case: 'data', data: { data } })); },
          onError() { ws.terminate(); },
          onClose() { if (ws.readyState === 1) ws.close(); },
        });
      }
      if (peer) peer.write(message.data.data);
      else ws.send(JSON.stringify(message));
    }
    if (message.$case === 'disconnect') ws.send(JSON.stringify({ $case: 'exit', exit: { code: 0 } }));
  });
});
const listeningReady = once(server, 'listening').then(() => { control.tlsPort = server.address().port; });
server.listen(0, '127.0.0.1');

const authReady = electron.app.whenReady().then(() => {
  const auth = electron.session.fromPartition('persist:usshtc107-auth');
  auth.protocol.handle('https', async (request) => {
    if (![platformUrl, casUrl, returnUrl, shellUrl].includes(request.url)) throw new Error('Unexpected fixture auth URL');
    control.authVisits.push(request.url);
    let body;
    if (request.url === platformUrl) body = `<button id="authButton" onclick="location.href='${casUrl}'">Open fixture CAS</button>`;
    else if (request.url === casUrl) body = `<h1>Test-only CAS</h1><p>No real credentials are accepted.</p><button onclick="location.href='${returnUrl}'">Complete fixture sign-in</button>`;
    else if (request.url === returnUrl) {
      const owner = control.runtime.getController().getSnapshot().profileId === 'default' ? 'A' : 'B';
      await auth.cookies.set({ url: platformUrl, name: 'SCOW_USER', value: `fixture-${owner}`, secure: true, httpOnly: true, sameSite: 'no_restriction' });
      body = `<p>Fixture platform session established</p><a href="${shellUrl}">Open fixture shell</a>`;
    } else body = '<h1>Test-only platform shell</h1>';
    return new Response(`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><title>Acceptance fixture</title>${body}`, {
      status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  });
});
  const localWss = (url, options) => {
    if (new URL(url).hostname !== '107.ustc.edu.cn' || options.rejectUnauthorized !== true) throw new Error('Unexpected WSS policy');
    const local = new URL(url); local.hostname = '127.0.0.1'; local.port = String(control.tlsPort);
    return new WebSocket(local, { ...options, rejectUnauthorized: true, servername: 'localhost' });
  };
  const { ProxyServer } = require('../../electron/proxy-server');
  const { startApplication } = require('../../electron/main');
  control.runtime = startApplication({
    electron: { ...electron, safeStorage, dialog, Notification: { isSupported: () => false },
      shell: { openExternal: async () => { throw new Error('External browser is disabled in acceptance'); } } },
    clock, log: { info() {}, warn() {}, error() {}, debug() {} },
    sshDirectory: path.join(root, 'home', '.ssh'),
    portalPreflight: { validate: async () => ({ status: 'valid' }), setup: async () => ({ ok: true }), run: async () => ({ ok: true }) },
    autostartService: {
      getStatus: async () => ({ supported: false, enabled: false, approvalRequired: false, errorCode: null }),
      setEnabled: async () => { throw new Error('Acceptance must never register OS autostart'); },
    },
    createProxyServer(options) {
      const server = new ProxyServer({ ...options, wssUrl: `wss://127.0.0.1:${control.tlsPort}/api/shell`, tlsCa: certificate });
      control.proxyInstances.push(server);
      return server;
    },
    diagnosticsAdapters: {
      tlsCa: certificate,
      lookup(host, callback) {
        if (host !== '107.ustc.edu.cn') throw new Error('Unexpected diagnostic DNS');
        let cancelled = false;
        const finish = () => { if (!cancelled) callback(null, ['127.0.0.1']); };
        if (control.holdDns) control.pendingDns = finish; else queueMicrotask(finish);
        return { cancel() { cancelled = true; } };
      },
      connectTls(options) {
        if (options.host !== '107.ustc.edu.cn' || options.rejectUnauthorized !== true) throw new Error('Unexpected diagnostic TLS');
        return tls.connect({ ...options, host: '127.0.0.1', port: control.tlsPort, servername: 'localhost', rejectUnauthorized: true });
      },
      createWebSocket: localWss,
    },
    recoveryAdapters: { tlsCa: certificate, createWebSocket: localWss },
  });
installNetworkGuard(electron, { authUrls: [platformUrl, casUrl, returnUrl, shellUrl] });
control.ready = Promise.all([control.runtime.ready, listeningReady, authReady]).catch((error) => {
  console.error(error); electron.app.exit(1);
});
electron.app.once('will-quit', () => { for (const ws of wss.clients) ws.terminate(); wss.close(); server.close(); });
