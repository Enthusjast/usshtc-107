'use strict';
const zlib = require('node:zlib');

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : value >>> 1;
  return value;
});

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  let crc = 0xffffffff;
  for (const bytes of [name, data]) {
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, name, data, checksum]);
}

function createTrayIcon(nativeImage, color) {
  const size = 16;
  const raw = Buffer.alloc(size * (1 + size * 4));
  const rgb = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x - 8, y - 8);
      if (distance > 7) continue;
      const offset = y * (1 + size * 4) + 1 + x * 4;
      raw[offset] = rgb[0];
      raw[offset + 1] = rgb[1];
      raw[offset + 2] = rgb[2];
      raw[offset + 3] = Math.min(255, Math.round((7 - distance) * 255));
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return nativeImage.createFromBuffer(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]));
}

const TEXT = {
  en: {
    start: 'Start Proxy', stop: 'Stop Proxy', connections: count => `Connections: ${count}`,
    show: 'Show Window', quit: 'Quit',
    'new-session': ['SSH Connection', 'A new SSH session has connected.'],
    auth: ['Login required', 'Your platform session has expired. Please log in again.'],
    recovery: ['Network recovered', 'The platform handshake is reachable. Disconnected SSH clients must reconnect.'],
    update: ['Update available', 'An application update is available. Download and install it from Settings.'],
  },
  zh: {
    start: '启动代理', stop: '停止代理', connections: count => `连接数: ${count}`,
    show: '显示窗口', quit: '退出',
    'new-session': ['SSH 连接', '新的 SSH 会话已连接。'],
    auth: ['需要登录', '平台会话已过期，请重新登录。'],
    recovery: ['网络已恢复', '平台握手已可达，已断开的 SSH 客户端仍需重新连接。'],
    update: ['有可用更新', '应用更新已可用，请在设置中手动下载和安装。'],
  },
};
const NOTIFICATION_PREF = {
  'new-session': 'notifyConnections', auth: 'notifyAuth', recovery: 'notifyRecovery', update: 'notifyUpdates',
};

function createTrayService({ Tray, Menu, nativeImage, Notification, getWindow, run, getPreferences, log = () => {} }) {
  const icons = {
    started: createTrayIcon(nativeImage, '#22c55e'),
    stopped: createTrayIcon(nativeImage, '#ef4444'),
    starting: createTrayIcon(nativeImage, '#eab308'),
  };
  let tray = new Tray(icons.stopped);
  let snapshot = null;
  const showWindow = () => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  const invoke = action => {
    Promise.resolve().then(() => run(action)).catch(() => log('warn', 'tray', 'Tray action failed'));
  };
  tray.setToolTip('usshtc107');
  tray.on('click', () => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isVisible()) window.hide();
    else showWindow();
  });

  function update(next) {
    if (!tray) return;
    snapshot = next;
    const text = TEXT[getPreferences().locale] || TEXT.en;
    const running = snapshot.proxyStatus === 'started';
    tray.setImage(icons[snapshot.proxyStatus] || icons.stopped);
    tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: running ? text.stop : text.start,
        enabled: !snapshot.operation && (running || (snapshot.proxyStatus === 'stopped' && snapshot.cookieValid && snapshot.loginStatus === 'success' && !snapshot.storageErrorCode)),
        click: () => invoke(running ? 'stop' : 'start'),
      },
      { type: 'separator' },
      { label: text.connections(snapshot.connectionCount), enabled: false },
      { type: 'separator' },
      { label: text.show, click: showWindow },
      { type: 'separator' },
      { label: text.quit, click: () => invoke('exit') },
    ]));
  }

  function notify(kind) {
    if (!tray || !Object.hasOwn(NOTIFICATION_PREF, kind)) return;
    const preferences = getPreferences();
    if (preferences[NOTIFICATION_PREF[kind]] === false || !Notification.isSupported()) return;
    const [title, body] = (TEXT[preferences.locale] || TEXT.en)[kind];
    try { new Notification({ title, body }).show(); }
    catch (_) { log('warn', 'notification', 'System notification unavailable'); }
  }

  function dispose() {
    if (!tray) return;
    tray.removeAllListeners();
    tray.destroy();
    tray = null;
    snapshot = null;
  }
  return { update, notify, dispose };
}

module.exports = { createTrayService };
