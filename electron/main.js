const { app, BrowserWindow, session, ipcMain, clipboard, Tray, Menu, nativeImage, Notification, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const log = require('electron-log');
const { ProxyServer } = require('./proxy-server');
const {
  DEFAULTS,
  PLATFORM,
  LOGIN_PAGE_PATTERNS,
  TERMINAL_PATTERNS,
} = require('./constants');

// =========================================================================
// Ed25519 SSH key pair — generated once, used for proxy authentication
// =========================================================================

const SSH_KEY_NAME = 'usshtc107_ed25519';

function ensureSshKeyPair() {
  const sshDir = path.join(os.homedir(), '.ssh');
  const privPath = path.join(sshDir, SSH_KEY_NAME);
  const pubPath = privPath + '.pub';

  // Key already exists on disk and public key stored in settings
  if (fs.existsSync(privPath) && settings.sshPublicKey) {
    // Migration: if raw bytes missing, extract from public key file
    if (!settings.sshPublicKeyRaw && fs.existsSync(pubPath)) {
      try {
        const pubContent = fs.readFileSync(pubPath, 'utf-8').trim();
        const parts = pubContent.split(' ');
        if (parts.length >= 2 && parts[0] === 'ssh-ed25519') {
          const keyBuf = Buffer.from(parts[1], 'base64');
          // Extract raw 32 bytes: skip 4 len + "ssh-ed25519" + 4 len = 4+11+4 = 19
          const rawBytes = keyBuf.subarray(19);
          settings.sshPublicKeyRaw = rawBytes.toString('base64');
          persistSettings(settings);
          addLog('info', 'ssh-key', 'Migrated: extracted raw public key bytes');
        }
      } catch (_) {}
    }
    return { privPath, pubPath, publicKey: settings.sshPublicKey };
  }

  // Generate ed25519 key pair
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Export public key as DER → extract raw 32 bytes (last 32 of SPKI wrapper)
  const keyObj = crypto.createPublicKey(publicKey);
  const spkiDer = keyObj.export({ type: 'spki', format: 'der' });
  const rawPubBytes = spkiDer.subarray(spkiDer.length - 32);

  // Build OpenSSH format for display: ssh-ed25519 <base64> comment
  // OpenSSH format: [len("ssh-ed25519")]["ssh-ed25519"][len(raw)][raw]
  const typeStr = 'ssh-ed25519';
  const typeBuf = Buffer.from(typeStr);
  const parts = Buffer.alloc(4 + typeBuf.length + 4 + rawPubBytes.length);
  parts.writeUInt32BE(typeBuf.length, 0);
  typeBuf.copy(parts, 4);
  parts.writeUInt32BE(rawPubBytes.length, 4 + typeBuf.length);
  rawPubBytes.copy(parts, 8 + typeBuf.length);
  const openSshPub = `${typeStr} ${parts.toString('base64')} usshtc107`;

  // Ensure ~/.ssh directory exists
  if (!fs.existsSync(sshDir)) {
    fs.mkdirSync(sshDir, { mode: 0o700 });
  }

  // Write private key (owner-only read)
  fs.writeFileSync(privPath, privateKey, { mode: 0o600 });
  // Write public key
  fs.writeFileSync(pubPath, openSshPub + '\n', { mode: 0o644 });

  // Store public key in settings (OpenSSH format for display + raw for auth)
  settings.sshPublicKey = openSshPub;
  settings.sshPublicKeyRaw = rawPubBytes.toString('base64');
  persistSettings(settings);

  addLog('info', 'ssh-key', `Generated ed25519 key pair: ${privPath}`);
  return { privPath, pubPath, publicKey: openSshPub };
}

function autoGenerateSshConfig() {
  const sshDir = path.join(os.homedir(), '.ssh');
  const configPath = path.join(sshDir, 'config');
  const privPath = path.join(sshDir, SSH_KEY_NAME);
  const alias = settings.sshAlias || 'usshtc107';
  const h = settings.host || '127.0.0.1';
  const p = settings.port || 3000;
  const marker = '# usshtc107-auto-generated';

  const block = `${marker}
Host ${alias}
  HostName ${h}
  Port ${p}
  User user
  IdentityFile ${privPath}
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null`;

  try {
    if (!fs.existsSync(sshDir)) {
      fs.mkdirSync(sshDir, { mode: 0o700 });
    }

    let existing = '';
    if (fs.existsSync(configPath)) {
      existing = fs.readFileSync(configPath, 'utf-8');
    }

    // Remove old usshtc107 block
    const escMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const NL = '(\\r?\\n)';
    const regex = new RegExp(
      `${NL}*${escMarker}${NL}` +
      `Host ${escAlias}[\\s\\S]*?` +
      `(?=${NL}Host |${escMarker}|$)`,
      'g'
    );
    let newConfig = existing.replace(regex, '').trim();

    if (newConfig) newConfig += '\n\n';
    newConfig += block + '\n';

    fs.writeFileSync(configPath, newConfig, { mode: 0o644 });
    addLog('info', 'ssh-config', `Auto-generated SSH config for alias '${alias}'`);
  } catch (err) {
    addLog('warn', 'ssh-config', `Auto-generate failed: ${err.message}`);
  }
}

// =========================================================================
// Tray icon generator — creates a 16×16 colored-circle PNG in memory
// =========================================================================

function createTrayIcon(hexColor) {
  const SIZE = 16, CX = 8, CY = 8, RADIUS = 6;
  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);

  const raw = Buffer.alloc(SIZE * (1 + SIZE * 4)); // filter byte + 4 bytes per pixel per row
  for (let y = 0; y < SIZE; y++) {
    const rowOff = y * (1 + SIZE * 4);
    raw[rowOff] = 0; // filter: none
    for (let x = 0; x < SIZE; x++) {
      const dist = Math.sqrt((x - CX) ** 2 + (y - CY) ** 2);
      const off = rowOff + 1 + x * 4;
      if (dist <= RADIUS) {
        raw[off] = r; raw[off + 1] = g; raw[off + 2] = b; raw[off + 3] = 255;
      } else if (dist <= RADIUS + 1) {
        const a = Math.round((RADIUS + 1 - dist) * 255);
        raw[off] = r; raw[off + 1] = g; raw[off + 2] = b; raw[off + 3] = Math.min(255, a);
      } else {
        raw[off] = 0; raw[off + 1] = 0; raw[off + 2] = 0; raw[off + 3] = 0;
      }
    }
  }

  // Build minimal PNG
  const deflated = zlib.deflateSync(raw);
  const chunks = [];

  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  chunks.push(pngChunk('IHDR', ihdr));
  // IDAT
  chunks.push(pngChunk('IDAT', deflated));
  // IEND
  chunks.push(pngChunk('IEND', Buffer.alloc(0)));

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const png = Buffer.concat([sig, ...chunks]);
  return nativeImage.createFromBuffer(png);
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeB, data]);
  const crc = crc32(crcInput);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeB, data, crcBuf]);
}

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

// Pre-render tray icons
let trayIconGreen, trayIconRed, trayIconYellow;
function getTrayIcons() {
  if (!trayIconGreen) {
    trayIconGreen = createTrayIcon('#22c55e');
    trayIconRed = createTrayIcon('#ef4444');
    trayIconYellow = createTrayIcon('#eab308');
  }
  return { green: trayIconGreen, red: trayIconRed, yellow: trayIconYellow };
}

// =========================================================================
// Persistent settings
// =========================================================================

let settingsPath = '';

function loadSettings() {
  try {
    settingsPath = path.join(app.getPath('userData'), 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf-8');
      return { ...DEFAULTS, ...JSON.parse(raw) };
    }
  } catch (_) { /* use defaults */ }
  return { ...DEFAULTS };
}

function persistSettings(s) {
  try {
    if (!settingsPath) settingsPath = path.join(app.getPath('userData'), 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2));
  } catch (_) { /* best-effort */ }
}

// =========================================================================
// Persistent logging
// =========================================================================

try {
  log.transports.file.level = 'info';
  log.transports.console.level = 'debug';
} catch (_) {
  log.transports.console.level = 'debug';
}

// =========================================================================
// Global state
// =========================================================================

let mainWindow = null;
let loginWindow = null;
let proxyServer = null;
let allowAppQuit = false;
let tray = null;

// Settings loaded from disk on startup
const settings = loadSettings();

const state = {
  loginStatus: 'idle',
  proxyStatus: 'stopped',
  connectionCount: 0,
  cookieValid: false,
  cookieCount: 0,
  host: settings.host,
  port: settings.port,
  wssUrl: '',
};

// Log buffer
const MAX_LOGS = 500;
const logs = [];
let logId = 0;

function addLog(level, source, message) {
  const entry = {
    id: ++logId,
    time: new Date().toISOString(),
    level,
    source,
    message,
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  sendToMain('new-log', entry);
  log[level]?.(`[${source}] ${message}`) ?? log.info(`[${source}] ${message}`);
}

// =========================================================================
// Helpers
// =========================================================================

function isLoginPage(url) {
  const lower = url.toLowerCase();
  return LOGIN_PAGE_PATTERNS.some((p) => lower.includes(p));
}

function isTerminalPage(url) {
  const lower = url.toLowerCase();
  return TERMINAL_PATTERNS.some((p) => lower.includes(p));
}

function buildWssUrl() {
  const params = new URLSearchParams({
    cluster: settings.cluster,
    loginNode: settings.loginNode,
    path: '',
    cols: settings.cols,
    rows: settings.rows,
    useRoot: settings.useRoot ? 'true' : 'false',
  });
  return `${PLATFORM.wssBase}?${params.toString()}`;
}

function sendToMain(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

// =========================================================================
// Tray
// =========================================================================

function updateTrayIcon() {
  if (!tray) return;
  const icons = getTrayIcons();
  let icon;
  switch (state.proxyStatus) {
    case 'started': icon = icons.green; break;
    case 'starting': icon = icons.yellow; break;
    default: icon = icons.red; break;
  }
  tray.setImage(icon);
}

function buildTrayMenu() {
  const proxyRunning = state.proxyStatus === 'started';
  const proxyStopped = state.proxyStatus === 'stopped';

  return Menu.buildFromTemplate([
    {
      label: proxyRunning ? '⏹ Stop Proxy' : '▶ Start Proxy',
      enabled: proxyRunning || (proxyStopped && state.loginStatus === 'success'),
      click: () => {
        if (proxyRunning) stopProxyServer();
        else startProxyServer();
      },
    },
    { type: 'separator' },
    {
      label: `Connections: ${state.connectionCount}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Show Window',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: async () => {
        allowAppQuit = true;
        await stopProxyServer();
        app.quit();
      },
    },
  ]);
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  const icons = getTrayIcons();
  tray = new Tray(icons.red);

  // Click tray icon to toggle window visibility
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  updateTrayMenu();
  tray.setToolTip('usshtc107');
}

// =========================================================================
// Main Window
// =========================================================================

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 960,
    minHeight: 640,
    center: true,
    show: !settings.startMinimized,
    autoHideMenuBar: true,
    title: 'usshtc107',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.ELECTRON_DEV) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    if (!settings.startMinimized) mainWindow.show();
  });

  // Minimize to tray instead of closing
  mainWindow.on('close', (event) => {
    if (!allowAppQuit) {
      event.preventDefault();
      mainWindow.hide();
      addLog('info', 'app', 'Minimized to tray');
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('page-title-updated', (e) => e.preventDefault());
}

// =========================================================================
// Login Window
// =========================================================================

async function createLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }

  loginWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 980,
    minHeight: 680,
    parent: mainWindow,
    modal: false,
    title: 'USTC Login',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  loginWindow.loadURL(PLATFORM.url);

  function autoClickAuthButton() {
    loginWindow.webContents.executeJavaScript(`
      new Promise((resolve) => {
        function tryClick() {
          const btn = document.getElementById('authButton');
          if (btn) { btn.click(); resolve(true); return; }
          let tries = 0;
          const timer = setInterval(() => {
            const b = document.getElementById('authButton');
            if (b) { b.click(); clearInterval(timer); resolve(true); }
            else if (++tries > 15) { clearInterval(timer); resolve(false); }
          }, 200);
        }
        tryClick();
      })
    `).then((found) => {
      if (found) addLog('info', 'login', 'auto-clicked authButton');
    }).catch(() => {});
  }

  // Auto-click SSO button on 107 platform + auto-fill on CAS page
  loginWindow.webContents.on('did-finish-load', () => {
    const url = loginWindow.webContents.getURL();
    // On 107 platform: auto-click SSO button or redirect to shell page
    const hostname = (() => { try { return new URL(url).hostname; } catch (_) { return ''; } })();
    if (hostname === PLATFORM.domain || hostname.endsWith('.' + PLATFORM.domain)) {
      const shellUrl = 'https://107.ustc.edu.cn/shell/' + settings.cluster + '/' + settings.loginNode;
      // After login, user lands on home/dashboard → auto-redirect to shell page
      if (url !== shellUrl && !url.includes('/auth') && !url.includes('scowAuth')) {
        // Check if we just came from CAS redirect (has SCOW_USER cookie = logged in)
        session.defaultSession.cookies.get({ domain: PLATFORM.domain }).then((cookies) => {
          const hasUserCookie = cookies.some((c) => c.name === 'SCOW_USER');
          if (hasUserCookie) {
            addLog('info', 'login', 'logged in, redirecting to shell: ' + shellUrl);
            loginWindow.loadURL(shellUrl);
          } else {
            // Not logged in — show login page, auto-click auth button
            autoClickAuthButton();
          }
        });
        return;
      }
      // On auth page or shell page: auto-click auth button if present
      autoClickAuthButton();
    }
    // On id.ustc.edu.cn: auto-fill credentials and submit
    if (hostname === 'id.ustc.edu.cn') {
      let password = '';
      try {
        if (settings.ssoPassword && settings.ssoPassword.startsWith('xor:')) {
          const crypto = require('crypto');
          const key = crypto.createHash('md5').update(app.getPath('userData')).digest();
          const buf = Buffer.from(settings.ssoPassword.slice(4), 'base64');
          for (let i = 0; i < buf.length; i++) buf[i] ^= key[i % key.length];
          password = buf.toString('utf-8');
        } else if (settings.ssoPassword) {
          const buf = Buffer.from(settings.ssoPassword, 'base64');
          password = safeStorage.decryptString(buf);
        }
      } catch (_) {}
      if (!password) return;

      const username = settings.ssoUsername;
      loginWindow.webContents.executeJavaScript(`
        (function() {
          var nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;

          function setVal(el, val) {
            el.focus();
            nativeSetter.call(el, val);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
          }

          function tryFill() {
            var u = document.getElementById('nameInput');
            var p = document.querySelector('input[type="password"][maxlength="200"]');
            if (!u || !p) return false;
            setVal(u, ${JSON.stringify(username)});
            setVal(p, ${JSON.stringify(password)});
            // Submit via button click (Angular handles the rest)
            setTimeout(function() {
              var btn = document.getElementById('submitBtn');
              if (btn) btn.click();
            }, 200);
            return true;
          }

          if (tryFill()) return;
          var obs = new MutationObserver(function() { if (tryFill()) obs.disconnect(); });
          obs.observe(document, { childList: true, subtree: true });
          setTimeout(function() { obs.disconnect(); }, 10000);
        })();
      `).catch(() => {});
    }
  });

  loginWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      const host = parsed.hostname;
      // Allow 107 platform and USTC SSO domains
      const allowed = host === PLATFORM.domain
        || host.endsWith('.' + PLATFORM.domain)
        || host === 'id.ustc.edu.cn'
        || host.endsWith('.ustc.edu.cn');
      console.log(`[login] host=${host} allowed=${allowed}`);
      if (allowed) {
        loginWindow.loadURL(url);
      }
    } catch (_) { /* ignore unparseable URLs */ }
    return { action: 'deny' };
  });

  // Two-phase login detection
  const checkUrl = async (url) => {
    if (state.loginStatus === 'success') return;
    if (!url.includes(PLATFORM.domain)) return;
    if (isLoginPage(url)) {
      if (state.loginStatus === 'sso_done') {
        state.loginStatus = 'pending';
        sendToMain('login-status', 'pending');
      }
      return;
    }

    const cookies = await session.defaultSession.cookies.get({ domain: PLATFORM.domain });
    if (cookies.length === 0) return;

    if (isTerminalPage(url)) {
      onLoginFinalized(cookies);
      return;
    }

    if (state.loginStatus === 'pending') {
      state.loginStatus = 'sso_done';
      addLog('info', 'auth', 'SSO complete — waiting for Web SSH page');
      sendToMain('login-status', 'sso_done');
      sendToMain('login-progress', {
        status: 'sso_done',
        message: 'SSO login complete. Please navigate to Web SSH page.',
      });
    }
  };

  loginWindow.webContents.on('did-navigate', (_e, url) => checkUrl(url));
  loginWindow.webContents.on('will-navigate', (_e, url) => checkUrl(url));
  loginWindow.webContents.on('did-navigate-in-page', (_e, url) => checkUrl(url));

  let pollTimer = null;
  loginWindow.webContents.on('did-navigate', () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (!loginWindow || loginWindow.isDestroyed() || state.loginStatus === 'success') {
        clearInterval(pollTimer);
        return;
      }
      try {
        const url = loginWindow.webContents.getURL();
        if (!url.includes(PLATFORM.domain) || isLoginPage(url)) return;
        const cookies = await session.defaultSession.cookies.get({ domain: PLATFORM.domain });
        if (cookies.length > 0 && isTerminalPage(url)) {
          onLoginFinalized(cookies);
          clearInterval(pollTimer);
        }
      } catch (_) {}
    }, 2000);
  });

  loginWindow.on('closed', () => {
    if (pollTimer) clearInterval(pollTimer);
    loginWindow = null;
    if (state.loginStatus !== 'success') {
      state.loginStatus = 'idle';
      sendToMain('login-status', 'idle');
    }
  });

  sendToMain('login-progress', { status: 'navigating', message: 'Opening login page...' });
}

let loggedIn = false;

// Store cookies captured during login so they survive window close
let capturedCookieString = '';

// Restore captured cookie from settings (persists across app restarts)
if (settings.savedCookie) {
  capturedCookieString = settings.savedCookie;
}

async function onLoginFinalized(cookies) {
  if (state.loginStatus === 'success') return;

  loggedIn = true;
  state.loginStatus = 'success';
  state.cookieValid = true;
  state.cookieCount = cookies.length;
  state.wssUrl = buildWssUrl();

  // Build cookie string BEFORE closing login window (session cookies get deleted on close)
  capturedCookieString = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

  // Persist cookie to settings so it survives app restart
  settings.savedCookie = capturedCookieString;
  persistSettings(settings);

  addLog('info', 'auth', `Web SSH page reached — ${cookies.length} cookies read`);
  addLog('info', 'auth', `Cookie names: ${cookies.map(c => c.name).join(', ')}`);
  sendToMain('login-status', 'success');
  sendToMain('cookie-status', { cookieValid: true, cookieCount: cookies.length });
  sendToMain('login-progress', { status: 'done', message: 'Cookies captured — starting proxy' });

  // Close login window first so user isn't blocked if proxy start takes time
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.close();
  }

  await startProxyServer(capturedCookieString);
}

// =========================================================================
// Cookie Monitoring
// =========================================================================

function setupCookieMonitoring() {
  session.defaultSession.cookies.on('changed', (_event, cookie, cause) => {
    if (!cookie.domain?.includes(PLATFORM.domain)) return;
    addLog('debug', 'cookie', `Changed: ${cookie.name} (${cause})`);
    updateCookieState();
  });
}

async function updateCookieState() {
  try {
    const cookies = await session.defaultSession.cookies.get({ domain: PLATFORM.domain });
    const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    if (cookies.length > 0) {
      state.cookieValid = true;
      state.cookieCount = cookies.length;
      capturedCookieString = cookieStr; // keep captured cookies in sync
      if (proxyServer) proxyServer.updateCookie(cookieStr);
      sendToMain('cookie-status', { cookieValid: true, cookieCount: cookies.length });
    } else {
      state.cookieValid = false;
      state.cookieCount = 0;
      sendToMain('cookie-status', { cookieValid: false, cookieCount: 0 });
    }
  } catch (err) {
    addLog('error', 'cookie', `Error: ${err.message}`);
  }
}

// =========================================================================
// Proxy Server
// =========================================================================

async function startProxyServer(cookieString) {
  if (state.proxyStatus === 'started' || state.proxyStatus === 'starting') return;

  state.proxyStatus = 'starting';
  sendToMain('proxy-status', { proxyStatus: 'starting', connectionCount: 0 });
  updateTrayIcon();
  updateTrayMenu();

  // Properly stop old proxy to release port and TCP/SSH server resources
  if (proxyServer) {
    await proxyServer.stop();
    proxyServer.removeAllListeners();
    proxyServer = null;
  }

  // Use provided cookie string (from login capture) or query from session (auto-connect)
  let currentCookie = cookieString || '';
  if (!currentCookie) {
    let cookies;
    try {
      cookies = await session.defaultSession.cookies.get({ domain: PLATFORM.domain });
    } catch (_) {
      cookies = [];
    }
    currentCookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  state.wssUrl = buildWssUrl();

  // Load authorized public key for client authentication
  let authorizedKey = null;
  if (settings.sshPublicKeyRaw) {
    authorizedKey = Buffer.from(settings.sshPublicKeyRaw, 'base64');
  }

  proxyServer = new ProxyServer({
    port: state.port,
    host: state.host,
    cookie: currentCookie,
    cluster: settings.cluster,
    loginNode: settings.loginNode,
    cols: settings.cols,
    rows: settings.rows,
    useRoot: settings.useRoot,
    authorizedKey,
    authorizedKeyOpenSSH: settings.sshPublicKey || '',
  });

  // ---- Proxy events ----

  // Forward proxy-internal logs to app log UI
  proxyServer.on('proxy-log', (level, source, message) => {
    addLog(level, source, message);
  });

  proxyServer.on('started', ({ host, port }) => {
    state.proxyStatus = 'started';
    addLog('info', 'proxy', `Server started on ${host}:${port}`);
    sendToMain('proxy-status', {
      proxyStatus: 'started',
      connectionCount: 0,
      wssUrl: state.wssUrl,
    });
    sendToMain('stats-update', proxyServer.getStats());
    updateTrayIcon();
    updateTrayMenu();
  });

  proxyServer.on('connection', (count) => {
    state.connectionCount = count;
    updateTrayMenu();
    sendToMain('proxy-status', {
      proxyStatus: 'started',
      connectionCount: count,
      wssUrl: state.wssUrl,
    });
  });

  proxyServer.on('stopped', () => {
    state.proxyStatus = 'stopped';
    sendToMain('proxy-status', { proxyStatus: 'stopped', connectionCount: 0 });
    updateTrayIcon();
    updateTrayMenu();
  });

  proxyServer.on('error', (err) => {
    state.proxyStatus = 'error';
    addLog('error', 'proxy', err.message);
    sendToMain('proxy-status', {
      proxyStatus: 'error',
      connectionCount: state.connectionCount,
      error: err.message,
    });
    updateTrayIcon();
    updateTrayMenu();
  });

  proxyServer.on('auth-error', ({ statusCode }) => {
    addLog('warn', 'auth', `Auth error (${statusCode}) — session may have expired`);
    state.loginStatus = 'failure';
    state.cookieValid = false;
    loggedIn = false;
    sendToMain('login-status', 'failure');
    sendToMain('cookie-status', { cookieValid: false, cookieCount: 0 });
    stopProxyServer();
  });

  // Session events
  proxyServer.on('session-open', (session) => {
    addLog('info', 'session', `Opened: ${session.remoteAddress} (#${session.id})`);
    sendToMain('session-update', {
      type: 'open',
      session,
      all: proxyServer.getSessions(),
    });
    // System notification for new connection
    showNotification('SSH Connection', `New session from ${session.remoteAddress}`);
  });

  proxyServer.on('session-close', ({ sessionId }) => {
    addLog('info', 'session', `Closed: #${sessionId}`);
    sendToMain('session-update', {
      type: 'close',
      sessionId,
      all: proxyServer.getSessions(),
    });
  });

  // Traffic / stats — throttle to ~2 Hz (500ms) to avoid flooding renderer
  let statsThrottle = null;
  proxyServer.on('traffic', () => {
    if (!statsThrottle) {
      statsThrottle = setTimeout(() => {
        statsThrottle = null;
        if (proxyServer) sendToMain('stats-update', proxyServer.getStats());
      }, 500);
    }
  });

  // Periodic stats update (uptime ticks, session count changes)
  _statsTimer = setInterval(() => {
    if (proxyServer) sendToMain('stats-update', proxyServer.getStats());
  }, 1000);

  try {
    await proxyServer.start();
  } catch (err) {
    state.proxyStatus = 'error';
    if (_statsTimer) { clearInterval(_statsTimer); _statsTimer = null; }
    addLog('error', 'proxy', `Start failed: ${err.message}`);
    sendToMain('proxy-status', {
      proxyStatus: 'error',
      connectionCount: 0,
      error: err.message,
    });
    updateTrayIcon();
    updateTrayMenu();
  }
}

let _statsTimer = null;

async function stopProxyServer() {
  if (!proxyServer || state.proxyStatus === 'stopped') return;
  if (_statsTimer) { clearInterval(_statsTimer); _statsTimer = null; }
  await proxyServer.stop();
  proxyServer.removeAllListeners();
  proxyServer = null;
}

function showNotification(title, body) {
  if (!Notification.isSupported()) return;
  try {
    new Notification({ title, body }).show();
  } catch (_) { /* best-effort */ }
}

// =========================================================================
// Auto-connect on startup
// =========================================================================

async function tryAutoConnect() {
  if (!settings.autoConnect) return;
  try {
    // Prefer saved cookie (captured at login time, guaranteed complete)
    // over Electron session cookies (session cookies like SCOW_USER may be lost)
    if (capturedCookieString) {
      addLog('info', 'app', 'Auto-connect: using saved cookie from previous session');
      state.cookieValid = true;
      state.cookieCount = 2;
      state.loginStatus = 'success';
      state.wssUrl = buildWssUrl();
      loggedIn = true;
      sendToMain('login-status', 'success');
      sendToMain('cookie-status', { cookieValid: true, cookieCount: 2 });
      await startProxyServer(capturedCookieString);
    } else {
      // No saved cookie — check Electron session for fresh login
      const cookies = await session.defaultSession.cookies.get({ domain: PLATFORM.domain });
      if (cookies.length > 0) {
        addLog('info', 'app', `Auto-connect: ${cookies.length} cookies found`);
        capturedCookieString = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        state.cookieValid = true;
        state.cookieCount = cookies.length;
        state.loginStatus = 'success';
        state.wssUrl = buildWssUrl();
        loggedIn = true;
        sendToMain('login-status', 'success');
        sendToMain('cookie-status', { cookieValid: true, cookieCount: cookies.length });
        await startProxyServer(capturedCookieString);
      } else {
        addLog('info', 'app', 'Auto-connect: no cookies found, waiting for manual login');
      }
    }
  } catch (err) {
    addLog('warn', 'app', `Auto-connect check failed: ${err.message}`);
  }
}

// =========================================================================
// IPC Handlers
// =========================================================================

function setupIPCHandlers() {
  let logPath = '';
  try { logPath = log.transports.file.getFile().path; } catch (_) {}

  ipcMain.handle('runtime:get-info', () => ({
    isElectron: true,
    platform: process.platform,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    devMode: !!process.env.ELECTRON_DEV,
    logPath,
  }));

  ipcMain.handle('status:get', () => ({ ...state }));

  // ---- Settings ----
  ipcMain.handle('settings:get', () => ({ ...settings }));
  ipcMain.handle('settings:save', (_e, s) => {
    // Whitelist allowed keys to prevent injection of unexpected properties
    // savedCookie is managed internally, not user-editable
    const ALLOWED = new Set(Object.keys(DEFAULTS).filter((k) => k !== 'savedCookie' && k !== 'ssoPassword' && k !== 'sshPublicKeyRaw'));
    for (const key of Object.keys(s)) {
      if (!ALLOWED.has(key)) continue;
      settings[key] = s[key];
    }
    // Validate port
    if (s.port !== undefined) {
      const p = Number(s.port);
      if (Number.isInteger(p) && p > 0 && p < 65536) state.port = p;
    }
    if (s.host !== undefined) state.host = s.host;
    // Normalize useRoot: frontend sends strings, we store boolean
    if (s.useRoot !== undefined) settings.useRoot = s.useRoot === true || s.useRoot === 'true';
    state.wssUrl = buildWssUrl();
    persistSettings(settings);
    addLog('info', 'settings', 'Settings saved');
    if (state.proxyStatus === 'started') {
      return { needsRestart: true };
    }
    return { needsRestart: false };
  });

  // ---- SSO Credentials (encrypted with safeStorage) ----
  ipcMain.handle('sso:save-credentials', (_e, username, password) => {
    addLog('info', 'settings', 'sso:save-credentials called: username=' + (username || 'none') + ' password=' + (password ? password.length + ' chars' : 'EMPTY'));
    settings.ssoUsername = username || '';
    if (password) {
      try {
        if (safeStorage.isEncryptionAvailable()) {
          const encrypted = safeStorage.encryptString(password);
          settings.ssoPassword = encrypted.toString('base64');
          addLog('info', 'settings', 'ssoPassword encrypted via safeStorage: ' + settings.ssoPassword.length + ' chars');
        } else {
          // Fallback: XOR obfuscation with app path hash (dev mode)
          const crypto = require('crypto');
          const key = crypto.createHash('md5').update(app.getPath('userData')).digest();
          const buf = Buffer.from(password, 'utf-8');
          for (let i = 0; i < buf.length; i++) buf[i] ^= key[i % key.length];
          settings.ssoPassword = 'xor:' + buf.toString('base64');
          addLog('info', 'settings', 'ssoPassword obfuscated (dev mode): ' + settings.ssoPassword.length + ' chars');
        }
      } catch (e) {
        addLog('error', 'settings', 'ssoPassword encrypt failed: ' + e.message);
        settings.ssoPassword = '';
      }
    } else {
      settings.ssoPassword = '';
    }
    persistSettings(settings);
    return { ok: true };
  });

  ipcMain.handle('sso:get-credentials', () => {
    let password = '';
    if (settings.ssoPassword) {
      try {
        if (settings.ssoPassword.startsWith('xor:')) {
          // Dev mode: XOR obfuscated
          const key = crypto.createHash('md5').update(app.getPath('userData')).digest();
          const buf = Buffer.from(settings.ssoPassword.slice(4), 'base64');
          for (let i = 0; i < buf.length; i++) buf[i] ^= key[i % key.length];
          password = buf.toString('utf-8');
        } else {
          const buf = Buffer.from(settings.ssoPassword, 'base64');
          password = safeStorage.decryptString(buf);
        }
      } catch (_) { /* corrupted or empty */ }
    }
    return { username: settings.ssoUsername || '', password };
  });

  // ---- Login ----
  ipcMain.handle('login:start', () => {
    // Allow re-login: reset state if already logged in
    if (state.loginStatus === 'success') {
      state.loginStatus = 'idle';
      loggedIn = false;
      capturedCookieString = '';
      settings.savedCookie = '';
      persistSettings(settings);
    }
    if (state.loginStatus === 'sso_done') return;
    state.loginStatus = 'pending';
    sendToMain('login-status', 'pending');
    createLoginWindow();
  });

  // ---- Proxy ----
  ipcMain.handle('proxy:start', () => startProxyServer());
  ipcMain.handle('proxy:stop', () => stopProxyServer());

  // ---- Logs ----
  ipcMain.handle('logs:get', () => [...logs]);
  ipcMain.handle('logs:clear', () => {
    logs.length = 0;
    logId = 0;
  });

  // ---- Sessions ----
  ipcMain.handle('sessions:get', () => {
    return proxyServer ? proxyServer.getSessions() : [];
  });

  ipcMain.handle('sessions:disconnect', (_e, sessionId) => {
    if (proxyServer) {
      const ok = proxyServer.disconnectSession(sessionId);
      if (ok) addLog('info', 'session', `Force-disconnected #${sessionId}`);
      return ok;
    }
    return false;
  });

  // ---- Stats ----
  ipcMain.handle('stats:get', () => {
    return proxyServer ? proxyServer.getStats() : {
      uptimeMs: 0, totalBytesSent: 0, totalBytesReceived: 0, sessionCount: 0, sessions: [],
    };
  });

  // ---- SSH Key Info ----
  ipcMain.handle('ssh-key:get-info', () => {
    const sshDir = path.join(os.homedir(), '.ssh');
    const privPath = path.join(sshDir, SSH_KEY_NAME);
    return {
      publicKey: settings.sshPublicKey || '',
      privateKeyPath: privPath,
      exists: fs.existsSync(privPath),
    };
  });

  // ---- SSH Config ----
  ipcMain.handle('ssh-config:generate', async (_e, { host, port, alias } = {}) => {
    const h = host || state.host || '127.0.0.1';
    const p = port || state.port || 3000;
    const a = alias || 'usshtc107';

    const sshDir = path.join(os.homedir(), '.ssh');
    const configPath = path.join(sshDir, 'config');
    const marker = '# usshtc107-auto-generated';

    const privKeyPath = path.join(os.homedir(), '.ssh', SSH_KEY_NAME);
    const block = `${marker}
Host ${a}
  HostName ${h}
  Port ${p}
  User user
  IdentityFile ${privKeyPath}
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null`;

    try {
      // Ensure .ssh directory
      if (!fs.existsSync(sshDir)) {
        fs.mkdirSync(sshDir, { mode: 0o700 });
      }

      let existing = '';
      if (fs.existsSync(configPath)) {
        existing = fs.readFileSync(configPath, 'utf-8');
      }

      // Remove old usshtc107 block (handles both LF and CRLF line endings)
      const escMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escAlias = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const NL = '(\\r?\\n)';
      const regex = new RegExp(
        `${NL}*${escMarker}${NL}` +
        `Host ${escAlias}[\\s\\S]*?` +
        `(?=${NL}Host |${escMarker}|$)`,
        'g'
      );
      let newConfig = existing.replace(regex, '').trim();

      if (newConfig) newConfig += '\n\n';
      newConfig += block + '\n';

      fs.writeFileSync(configPath, newConfig, { mode: 0o644 });
      addLog('info', 'ssh-config', `Written ${configPath}`);
      return { success: true, path: configPath, content: block };
    } catch (err) {
      addLog('error', 'ssh-config', `Failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  });

  // ---- Theme ----
  ipcMain.handle('theme:get', () => settings.theme || 'dark');
  ipcMain.handle('theme:set', (_e, theme) => {
    settings.theme = theme;
    persistSettings(settings);
    sendToMain('theme-changed', theme);
  });

  // ---- Clipboard ----
  ipcMain.handle('clipboard:write', (_e, text) => {
    clipboard.writeText(text);
  });

  // ---- App exit ----
  ipcMain.handle('app:exit', async () => {
    allowAppQuit = true;
    await stopProxyServer();
    app.quit();
  });
}

// =========================================================================
// App Lifecycle
// =========================================================================

app.whenReady().then(async () => {
  setupIPCHandlers();
  setupCookieMonitoring();
  createTray();
  createMainWindow();
  ensureSshKeyPair();
  autoGenerateSshConfig();
  addLog('info', 'app', 'Application started');

  // Auto-connect after a short delay to let cookie store initialize
  setTimeout(() => tryAutoConnect(), 1000);
});

app.on('window-all-closed', () => {
  // Don't quit — stay in tray
  if (process.platform !== 'darwin') {
    // On non-macOS, just hide. App stays alive via tray.
  }
});

app.on('before-quit', (event) => {
  // Electron does not await async handlers on before-quit.
  // We must prevent default, clean up, then explicitly exit.
  event.preventDefault();
  allowAppQuit = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  stopProxyServer().finally(() => {
    app.exit(0);
  });
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  log.error(`[app] Unhandled rejection: ${msg}`);
  addLog('error', 'app', `Unhandled: ${msg}`);
});

process.on('uncaughtException', (err) => {
  log.error(`[app] Uncaught exception: ${err.message}`);
  addLog('error', 'app', `Uncaught: ${err.message}`);
  // Don't crash the app — log and continue
});
