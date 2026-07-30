const { app, BrowserWindow, session, ipcMain, clipboard, dialog, shell, Tray, Menu, nativeImage, Notification, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { fileURLToPath } = require('url');
const log = require('electron-log');
const { ProxyServer } = require('./proxy-server');
const { CredentialStore, validateCookie } = require('./credential-store');
const {
  SettingsStore,
  normalizePublicSettings,
  publicSettings,
} = require('./settings-store');
const { SshConfigService } = require('./ssh-config-service');
const { ensureClientKeyPair, ensureProxyHostKey } = require('./ssh-key-service');
const { redactLogMessage } = require('./log-redaction');
const { createAuthStateController } = require('./auth-state');
const { createShutdownCoordinator } = require('./shutdown-coordinator');
const {
  isAllowedLoginUrl,
  loadOwnedWindowUrl,
  parseHttpsUrl,
} = require('./login-navigation');
const {
  DEFAULTS,
  PLATFORM,
  LOGIN_PAGE_PATTERNS,
  TERMINAL_PATTERNS,
} = require('./constants');

const IS_DEV = !app.isPackaged && process.env.ELECTRON_DEV === 'true';

// =========================================================================
// Ed25519 SSH key pair — generated once, used for proxy authentication
// =========================================================================

const SSH_KEY_NAME = 'usshtc107_ed25519';
const SSH_HOST_KEY_NAME = 'proxy_host_ed25519';
const startupWarnings = [];
const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const settingsStore = new SettingsStore({
  filePath: settingsPath,
  defaults: DEFAULTS,
  onWarning: (message) => startupWarnings.push(message),
});
const settings = settingsStore.load();

function persistSettings(value) {
  settingsStore.save(value);
}

const credentialStore = new CredentialStore({
  safeStorage,
  settings,
  persist: persistSettings,
  userDataPath: app.getPath('userData'),
  onWarning: (message) => startupWarnings.push(message),
});

function ensureSshKeyPair() {
  const sshDir = path.join(os.homedir(), '.ssh');
  const result = ensureClientKeyPair({ sshDirectory: sshDir, keyName: SSH_KEY_NAME });
  const changed = settings.sshPublicKey !== result.publicKey
    || settings.sshPublicKeyRaw !== result.publicKeyRaw;
  if (changed) {
    settings.sshPublicKey = result.publicKey;
    settings.sshPublicKeyRaw = result.publicKeyRaw;
    persistSettings(settings);
  }
  addLog('info', 'ssh-key', `SSH client key ready: ${result.privateKeyPath}`);
  return result;
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
let proxyLifecycle = Promise.resolve();
const proxyStopRequests = new WeakSet();
const proxySilentStops = new WeakSet();
let allowAppQuit = false;
let tray = null;
let authSession = null;
let cookieChangeTimer = null;
let authCookieResetPromise = null;
let autoConnectTimer = null;
let cookieStateGeneration = 0;
let cookieQueryRevision = 0;
let shutdownCoordinator = null;
let rendererHasUnsavedChanges = false;

function getAuthSession() {
  if (!authSession) {
    authSession = session.fromPartition('persist:usshtc107-auth');
    authSession.setPermissionCheckHandler(() => false);
    authSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    authSession.on('will-download', (event) => {
      event.preventDefault();
      addLog('warn', 'security', 'Blocked download from login session');
    });
  }
  return authSession;
}

function clearAuthSessionCookies() {
  if (authCookieResetPromise) return authCookieResetPromise;
  const operation = Promise.resolve()
    .then(() => getAuthSession().clearStorageData({ storages: ['cookies'] }));
  const tracked = operation.finally(() => {
    if (authCookieResetPromise === tracked) authCookieResetPromise = null;
  });
  authCookieResetPromise = tracked;
  tracked.catch(() => {});
  return tracked;
}

const state = {
  loginStatus: 'idle',
  proxyStatus: 'stopped',
  connectionCount: 0,
  cookieValid: false,
  cookieCount: 0,
  host: settings.host,
  port: settings.port,
  wssUrl: '',
  error: null,
};

// Log buffer
const MAX_LOGS = 500;
const logs = [];
let logId = 0;

function addLog(level, source, message) {
  const safeMessage = redactLogMessage(message);
  const entry = {
    id: ++logId,
    time: new Date().toISOString(),
    level,
    source,
    message: safeMessage,
  };
  logs.push(entry);
  if (logs.length > MAX_LOGS) logs.shift();
  sendToMain('new-log', entry);
  if (typeof log[level] === 'function') log[level](`[${source}] ${safeMessage}`);
  else log.info(`[${source}] ${safeMessage}`);
}

// =========================================================================
// Helpers
// =========================================================================

function isLoginPage(url) {
  const lower = url.toLowerCase();
  return LOGIN_PAGE_PATTERNS.some((p) => lower.includes(p));
}

function isTrustedMainUrl(url) {
  try {
    const parsed = new URL(url);
    if (IS_DEV) {
      return parsed.origin === 'http://localhost:5173';
    }
    if (parsed.protocol !== 'file:') return false;
    const expected = path.resolve(path.join(__dirname, '..', 'dist', 'index.html'));
    return path.resolve(fileURLToPath(parsed)) === expected;
  } catch (_) {
    return false;
  }
}

function assertTrustedIpc(event) {
  const senderFrame = event.senderFrame;
  if (!mainWindow || mainWindow.isDestroyed()
    || event.sender !== mainWindow.webContents
    || !senderFrame
    || senderFrame !== event.sender.mainFrame
    || !isTrustedMainUrl(senderFrame.url)) {
    throw new Error('IPC request rejected from an untrusted renderer');
  }
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

function countCookiePairs(cookieString) {
  return String(cookieString || '').split(';').filter((part) => part.trim().includes('=')).length;
}

function isShuttingDown() {
  return shutdownCoordinator?.isStarted() === true;
}

function invalidateCookieQueries() {
  cookieStateGeneration += 1;
  cookieQueryRevision += 1;
}

function beginCookieQuery() {
  return {
    generation: cookieStateGeneration,
    revision: ++cookieQueryRevision,
  };
}

function isCurrentCookieQuery(query) {
  return !isShuttingDown()
    && query.generation === cookieStateGeneration
    && query.revision === cookieQueryRevision;
}

function isCurrentCookieGeneration(generation) {
  return !isShuttingDown() && generation === cookieStateGeneration;
}

function buildCookieHeader(cookies) {
  const cookie = cookies.map((item) => `${item.name}=${item.value}`).join('; ');
  return validateCookie(cookie);
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

function mainText(key, ...args) {
  const dictionary = settings.locale === 'zh' ? {
    startProxy: '启动代理',
    stopProxy: '停止代理',
    connections: (count) => `连接数: ${count}`,
    showWindow: '显示窗口',
    quit: '退出',
    sshConnection: 'SSH 连接',
    newSession: (address) => `来自 ${address} 的新会话`,
  } : {
    startProxy: 'Start Proxy',
    stopProxy: 'Stop Proxy',
    connections: (count) => `Connections: ${count}`,
    showWindow: 'Show Window',
    quit: 'Quit',
    sshConnection: 'SSH Connection',
    newSession: (address) => `New session from ${address}`,
  };
  const value = dictionary[key];
  return typeof value === 'function' ? value(...args) : value;
}

function buildTrayMenu() {
  const proxyRunning = state.proxyStatus === 'started';
  const proxyStopped = state.proxyStatus === 'stopped';

  return Menu.buildFromTemplate([
    {
      label: proxyRunning ? mainText('stopProxy') : mainText('startProxy'),
      enabled: proxyRunning || (proxyStopped && state.loginStatus === 'success' && state.cookieValid),
      click: () => {
        if (proxyRunning) stopProxyServer();
        else startProxyServer();
      },
    },
    { type: 'separator' },
    {
      label: mainText('connections', state.connectionCount),
      enabled: false,
    },
    { type: 'separator' },
    {
      label: mainText('showWindow'),
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: mainText('quit'),
      click: () => {
        void requestShutdown(0);
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
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });

  if (IS_DEV) {
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
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedMainUrl(url)) {
      event.preventDefault();
      addLog('warn', 'security', 'Blocked unexpected main-window navigation');
    }
  });
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (!isTrustedMainUrl(url)) {
      event.preventDefault();
      addLog('warn', 'security', 'Blocked unexpected main-window redirect');
    }
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

// =========================================================================
// Login Window
// =========================================================================

async function createLoginWindow() {
  if (isShuttingDown()) return shutdownStartResult();
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return { ok: true, alreadyOpen: true };
  }

  const authWindow = new BrowserWindow({
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
      webSecurity: true,
      allowRunningInsecureContent: false,
      partition: 'persist:usshtc107-auth',
    },
  });
  loginWindow = authWindow;
  const authWebContents = authWindow.webContents;
  const isCurrentWindow = () => !isShuttingDown()
    && loginWindow === authWindow
    && !authWindow.isDestroyed();
  const loadLoginUrl = (url, description) => loadOwnedWindowUrl({
    window: authWindow,
    url,
    isCurrent: isCurrentWindow,
    onError: (error) => addLog('error', 'login', `${description} failed to load: ${error.message}`),
  });

  function autoClickAuthButton() {
    if (!isCurrentWindow()) return;
    authWebContents.executeJavaScript(`
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
      if (found && isCurrentWindow()) addLog('info', 'login', 'auto-clicked authButton');
    }).catch(() => {});
  }

  // Auto-click SSO button on 107 platform + auto-fill on CAS page
  authWebContents.on('did-finish-load', () => {
    if (!isCurrentWindow()) return;
    const url = authWebContents.getURL();
    // On 107 platform: auto-click SSO button or redirect to shell page
    const hostname = (() => { try { return new URL(url).hostname; } catch (_) { return ''; } })();
    if (hostname === PLATFORM.domain) {
      const shellUrl = 'https://107.ustc.edu.cn/shell/' + settings.cluster + '/' + settings.loginNode;
      // After login, user lands on home/dashboard → auto-redirect to shell page
      if (url !== shellUrl && !url.includes('/auth') && !url.includes('scowAuth')) {
        // Check if we just came from CAS redirect (has SCOW_USER cookie = logged in)
        getAuthSession().cookies.get({ domain: PLATFORM.domain }).then((cookies) => {
          if (!isCurrentWindow()) return;
          const hasUserCookie = cookies.some((c) => c.name === 'SCOW_USER');
          if (hasUserCookie) {
            addLog('info', 'login', 'logged in, redirecting to shell: ' + shellUrl);
            loadLoginUrl(shellUrl, 'Shell page');
          } else {
            // Not logged in — show login page, auto-click auth button
            autoClickAuthButton();
          }
        }).catch((error) => {
          if (isCurrentWindow()) addLog('error', 'login', `Cookie check failed: ${error.message}`);
        });
        return;
      }
      // On auth page or shell page: auto-click auth button if present
      autoClickAuthButton();
    }
    // On id.ustc.edu.cn: auto-fill credentials and submit
    if (hostname === 'id.ustc.edu.cn') {
      const password = credentialStore.getSsoPassword();
      if (!password) return;

      const username = settings.ssoUsername;
      authWebContents.executeJavaScript(`
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

  authWebContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedLoginUrl(url) && isCurrentWindow()) {
      loadLoginUrl(url, 'Login popup navigation');
    }
    else addLog('warn', 'security', 'Blocked unexpected login popup');
    return { action: 'deny' };
  });

  // Two-phase login detection
  const checkUrl = async (url) => {
    if (!isCurrentWindow() || state.loginStatus === 'success') return;
    const parsed = parseHttpsUrl(url);
    if (!parsed || parsed.origin !== PLATFORM.origin) return;
    if (isLoginPage(url)) {
      if (state.loginStatus === 'sso_done') {
        state.loginStatus = 'pending';
        sendToMain('login-status', 'pending');
      }
      return;
    }

    const cookies = await getAuthSession().cookies.get({ domain: PLATFORM.domain });
    if (!isCurrentWindow()) return;
    const currentUrl = authWebContents.getURL();
    const currentParsed = parseHttpsUrl(currentUrl);
    if (!currentParsed || currentParsed.origin !== PLATFORM.origin) return;
    if (cookies.length === 0) return;

    if (isTerminalPage(currentUrl)) {
      onLoginFinalized(cookies, authWindow);
      return;
    }

    if (state.loginStatus === 'pending') {
      state.loginStatus = 'sso_done';
      addLog('info', 'auth', 'SSO complete — waiting for Web SSH page');
      sendToMain('login-status', 'sso_done');
      sendToMain('login-progress', {
        status: 'sso_done',
      });
    }
  };

  const guardNavigation = (event, url) => {
    if (!isAllowedLoginUrl(url)) {
      event.preventDefault();
      addLog('warn', 'security', 'Blocked unexpected login navigation');
    }
  };
  authWebContents.on('will-navigate', guardNavigation);
  authWebContents.on('will-redirect', guardNavigation);
  authWebContents.on('did-navigate-in-page', (_event, url) => {
    checkUrl(url).catch((error) => {
      if (isCurrentWindow()) addLog('error', 'login', `Login state check failed: ${error.message}`);
    });
  });

  let pollTimer = null;
  authWebContents.on('did-navigate', (_event, url) => {
    checkUrl(url).catch((error) => {
      if (isCurrentWindow()) addLog('error', 'login', `Login state check failed: ${error.message}`);
    });
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (!isCurrentWindow() || state.loginStatus === 'success') {
        clearInterval(pollTimer);
        pollTimer = null;
        return;
      }
      try {
        const currentUrl = authWebContents.getURL();
        const parsed = parseHttpsUrl(currentUrl);
        if (!parsed || parsed.origin !== PLATFORM.origin || isLoginPage(currentUrl)) return;
        const cookies = await getAuthSession().cookies.get({ domain: PLATFORM.domain });
        if (isCurrentWindow() && cookies.length > 0 && isTerminalPage(authWebContents.getURL())) {
          onLoginFinalized(cookies, authWindow);
          clearInterval(pollTimer);
          pollTimer = null;
        }
      } catch (_) {}
    }, 2000);
  });

  authWindow.on('closed', () => {
    if (pollTimer) clearInterval(pollTimer);
    const wasCurrentWindow = loginWindow === authWindow;
    if (wasCurrentWindow) loginWindow = null;
    if (wasCurrentWindow && !isShuttingDown()
        && state.loginStatus !== 'success' && state.loginStatus !== 'failure') {
      state.loginStatus = 'idle';
      sendToMain('login-status', 'idle');
    }
  });

  sendToMain('login-progress', { status: 'navigating' });
  loadOwnedWindowUrl({
    window: authWindow,
    url: PLATFORM.url,
    isCurrent: isCurrentWindow,
    onError: (error) => {
      addLog('error', 'login', `Login page failed to load: ${error.message}`);
      state.loginStatus = 'failure';
      sendToMain('login-status', 'failure');
      if (!authWindow.isDestroyed()) authWindow.destroy();
    },
  });
  return { ok: true };
}

// Store cookies captured during login so they survive window close
let capturedCookieString = '';
const authStateController = createAuthStateController({
  state,
  invalidateQueries: invalidateCookieQueries,
  setCapturedCookie: (value) => { capturedCookieString = value; },
  clearStoredCookie: () => credentialStore.clearCookie(),
  publish: sendToMain,
  onStateChanged: updateTrayMenu,
  onClearError: (error) => addLog('error', 'cookie', `Cookie removal failed: ${error.message}`),
});

async function onLoginFinalized(cookies, sourceWindow) {
  if (isShuttingDown()
    || state.loginStatus === 'success'
    || !sourceWindow
    || sourceWindow.isDestroyed()
    || loginWindow !== sourceWindow) return;

  let nextCookie;
  try {
    nextCookie = buildCookieHeader(cookies);
  } catch (error) {
    authStateController.invalidate('failure');
    addLog('error', 'auth', `Cookie capture rejected: ${error.message}`);
    return;
  }

  invalidateCookieQueries();
  state.loginStatus = 'success';
  state.cookieValid = true;
  state.cookieCount = cookies.length;
  state.wssUrl = buildWssUrl();

  // Build cookie string BEFORE closing login window (session cookies get deleted on close)
  capturedCookieString = nextCookie;

  try {
    const persisted = credentialStore.saveCookie(capturedCookieString);
    if (!persisted) addLog('warn', 'auth', 'Cookie is available for this run only because OS encryption is unavailable');
  } catch (error) {
    addLog('error', 'auth', `Cookie persistence failed: ${error.message}`);
  }

  addLog('info', 'auth', `Web SSH page reached — ${cookies.length} cookies read`);
  sendToMain('login-status', 'success');
  sendToMain('cookie-status', { cookieValid: true, cookieCount: cookies.length });
  sendToMain('login-progress', { status: 'done' });

  // Close login window first so user isn't blocked if proxy start takes time
  if (loginWindow === sourceWindow && !sourceWindow.isDestroyed()) {
    sourceWindow.close();
  }

  await startProxyServer(capturedCookieString);
}

// =========================================================================
// Cookie Monitoring
// =========================================================================

function setupCookieMonitoring() {
  getAuthSession().cookies.on('changed', (_event, cookie, cause) => {
    if (isShuttingDown() || cookie.domain?.replace(/^\./, '') !== PLATFORM.domain) return;
    addLog('debug', 'cookie', `Session cookie state changed (${cause})`);
    if (cookieChangeTimer) clearTimeout(cookieChangeTimer);
    cookieChangeTimer = setTimeout(() => {
      cookieChangeTimer = null;
      if (!isShuttingDown()) void updateCookieState();
    }, 250);
  });
}

async function updateCookieState() {
  if (isShuttingDown()) return;
  const query = beginCookieQuery();
  try {
    const cookies = await getAuthSession().cookies.get({ domain: PLATFORM.domain });
    if (!isCurrentCookieQuery(query)) return;
    let cookieStr;
    try {
      cookieStr = buildCookieHeader(cookies);
    } catch (error) {
      if (!isCurrentCookieQuery(query)) return;
      authStateController.invalidate('failure');
      addLog('error', 'cookie', `Cookie update rejected: ${error.message}`);
      await stopProxyServer();
      return;
    }
    if (!isCurrentCookieQuery(query)) return;
    if (cookies.length > 0) {
      state.cookieValid = true;
      state.cookieCount = cookies.length;
      capturedCookieString = cookieStr; // keep captured cookies in sync
      try {
        const persisted = credentialStore.saveCookie(cookieStr);
        if (!persisted) addLog('warn', 'cookie', 'Cookie update was not persisted because OS encryption is unavailable');
      } catch (error) {
        addLog('error', 'cookie', `Cookie persistence failed: ${error.message}`);
      }
      if (proxyServer && !proxySilentStops.has(proxyServer)) proxyServer.updateCookie(cookieStr);
      sendToMain('cookie-status', { cookieValid: true, cookieCount: cookies.length });
    } else {
      authStateController.expireCookie();
      await stopProxyServer();
    }
  } catch (err) {
    if (!isCurrentCookieQuery(query)) return;
    addLog('error', 'cookie', `Error: ${err.message}`);
  }
}

// =========================================================================
// Proxy Server
// =========================================================================

let _statsTimer = null;
let _statsThrottleTimer = null;

function clearProxyStatsTimers() {
  if (_statsTimer) clearInterval(_statsTimer);
  if (_statsThrottleTimer) clearTimeout(_statsThrottleTimer);
  _statsTimer = null;
  _statsThrottleTimer = null;
}

function publishProxyStopped(force = false) {
  const changed = state.proxyStatus !== 'stopped'
    || state.connectionCount !== 0
    || state.error !== null;
  state.proxyStatus = 'stopped';
  state.connectionCount = 0;
  state.error = null;
  if (changed || force) {
    sendToMain('proxy-status', { proxyStatus: 'stopped', connectionCount: 0, error: null });
    updateTrayIcon();
    updateTrayMenu();
  }
}

function enqueueProxyLifecycle(operation) {
  const result = proxyLifecycle.then(operation, operation);
  proxyLifecycle = result.catch(() => {});
  return result;
}

function shutdownStartResult() {
  return { ok: false, shuttingDown: true, error: 'Application is shutting down' };
}

function isActiveProxyInstance(instance) {
  return !isShuttingDown()
    && proxyServer === instance
    && !proxySilentStops.has(instance);
}

function startProxyServer(cookieString) {
  if (isShuttingDown()) return Promise.resolve(shutdownStartResult());
  if (!authStateController.canStartProxy()) {
    return Promise.resolve({ ok: false, error: 'Login is required before starting the proxy' });
  }
  return enqueueProxyLifecycle(() => startProxyServerNow(cookieString));
}

async function startProxyServerNow(cookieString) {
  if (isShuttingDown()) return shutdownStartResult();
  if (!authStateController.canStartProxy()) {
    return { ok: false, error: 'Login is required before starting the proxy' };
  }
  if (state.proxyStatus === 'started' && proxyServer) {
    return { ok: true, alreadyRunning: true };
  }

  state.proxyStatus = 'starting';
  state.connectionCount = 0;
  state.error = null;
  sendToMain('proxy-status', { proxyStatus: 'starting', connectionCount: 0, error: null });
  updateTrayIcon();
  updateTrayMenu();

  clearProxyStatsTimers();
  if (proxyServer) {
    const previous = proxyServer;
    proxySilentStops.add(previous);
    try {
      await previous.stop();
    } catch (error) {
      proxySilentStops.delete(previous);
      state.proxyStatus = 'error';
      state.error = error.message;
      addLog('error', 'proxy', `Previous instance cleanup failed: ${error.message}`);
      sendToMain('proxy-status', {
        proxyStatus: 'error',
        connectionCount: 0,
        error: error.message,
      });
      updateTrayIcon();
      updateTrayMenu();
      return { ok: false, error: error.message };
    }
    proxySilentStops.delete(previous);
    previous.removeAllListeners();
    if (proxyServer === previous) proxyServer = null;
    if (isShuttingDown()) return shutdownStartResult();
    if (!authStateController.canStartProxy()) {
      return { ok: false, error: 'Login is required before starting the proxy' };
    }
  }

  // A captured login cookie survives the dedicated login window closing.
  let currentCookie;
  try {
    const cookieGeneration = cookieStateGeneration;
    if (authCookieResetPromise) await authCookieResetPromise;
    if (isShuttingDown()) return shutdownStartResult();
    if (cookieGeneration !== cookieStateGeneration) {
      throw new Error('Authentication state changed while starting the proxy');
    }
    const cookieCandidate = cookieString === undefined ? capturedCookieString : cookieString;
    currentCookie = validateCookie(cookieCandidate);
    if (!currentCookie) {
      const cookies = await getAuthSession().cookies.get({ domain: PLATFORM.domain });
      if (isShuttingDown()) return shutdownStartResult();
      if (!isCurrentCookieGeneration(cookieGeneration)) {
        throw new Error('Authentication state changed while starting the proxy');
      }
      currentCookie = buildCookieHeader(cookies);
    }
  } catch (error) {
    state.proxyStatus = 'error';
    state.error = error.message;
    addLog('error', 'proxy', `Cookie initialization failed: ${error.message}`);
    sendToMain('proxy-status', {
      proxyStatus: 'error',
      connectionCount: 0,
      error: error.message,
    });
    updateTrayIcon();
    updateTrayMenu();
    return { ok: false, error: error.message };
  }

  if (isShuttingDown()) return shutdownStartResult();
  state.wssUrl = buildWssUrl();

  if (!currentCookie) {
    const error = new Error('Login is required before starting the proxy');
    state.proxyStatus = 'error';
    state.error = error.message;
    addLog('error', 'proxy', error.message);
    sendToMain('proxy-status', { proxyStatus: 'error', connectionCount: 0, error: error.message });
    updateTrayIcon();
    updateTrayMenu();
    return { ok: false, error: error.message };
  }

  let keyInfo;
  let hostKey;
  let authorizedKey;
  try {
    keyInfo = ensureSshKeyPair();
    hostKey = ensureProxyHostKey(path.join(app.getPath('userData'), SSH_HOST_KEY_NAME));
    authorizedKey = Buffer.from(keyInfo.publicKeyRaw, 'base64');
    if (authorizedKey.length !== 32) throw new Error('SSH public key is invalid');
  } catch (error) {
    state.proxyStatus = 'error';
    state.error = error.message;
    addLog('error', 'ssh-key', error.message);
    sendToMain('proxy-status', { proxyStatus: 'error', connectionCount: 0, error: error.message });
    updateTrayIcon();
    updateTrayMenu();
    return { ok: false, error: error.message };
  }

  if (isShuttingDown()) return shutdownStartResult();

  let instance;
  try {
    instance = new ProxyServer({
      port: state.port,
      host: state.host,
      cookie: currentCookie,
      cluster: settings.cluster,
      loginNode: settings.loginNode,
      cols: settings.cols,
      rows: settings.rows,
      useRoot: settings.useRoot,
      authorizedKey,
      authorizedKeyOpenSSH: keyInfo.publicKey,
      hostKey,
    });
  } catch (error) {
    state.proxyStatus = 'error';
    state.error = error.message;
    addLog('error', 'proxy', `Initialization failed: ${error.message}`);
    sendToMain('proxy-status', {
      proxyStatus: 'error',
      connectionCount: 0,
      error: error.message,
    });
    updateTrayIcon();
    updateTrayMenu();
    return { ok: false, error: error.message };
  }
  proxyServer = instance;

  // ---- Proxy events ----

  // Forward proxy-internal logs to app log UI
  instance.on('proxy-log', (level, source, message) => {
    if (!isActiveProxyInstance(instance)) return;
    addLog(level, source, message);
  });

  instance.on('started', ({ host, port }) => {
    if (!isActiveProxyInstance(instance)) return;
    state.proxyStatus = 'started';
    state.error = null;
    addLog('info', 'proxy', `Server started on ${host}:${port}`);
    sendToMain('proxy-status', {
      proxyStatus: 'started',
      connectionCount: 0,
      wssUrl: state.wssUrl,
      error: null,
    });
    sendToMain('stats-update', instance.getStats());
    updateTrayIcon();
    updateTrayMenu();
  });

  instance.on('connection', (count) => {
    if (!isActiveProxyInstance(instance)) return;
    state.connectionCount = count;
    updateTrayMenu();
    sendToMain('proxy-status', {
      proxyStatus: 'started',
      connectionCount: count,
      wssUrl: state.wssUrl,
      error: null,
    });
  });

  instance.on('stopped', () => {
    if (!isActiveProxyInstance(instance)) return;
    clearProxyStatsTimers();
    publishProxyStopped();
  });

  instance.on('error', (err) => {
    if (!isActiveProxyInstance(instance)) return;
    state.proxyStatus = 'error';
    state.error = err.message;
    addLog('error', 'proxy', err.message);
    sendToMain('proxy-status', {
      proxyStatus: 'error',
      connectionCount: state.connectionCount,
      error: err.message,
    });
    updateTrayIcon();
    updateTrayMenu();
  });

  instance.on('auth-error', ({ statusCode }) => {
    if (!isActiveProxyInstance(instance)) return;
    addLog('warn', 'auth', `Auth error (${statusCode}) — session may have expired`);
    authStateController.invalidate('failure');
    const stopPromise = stopProxyServer();
    void clearAuthSessionCookies()
      .catch((error) => {
        addLog('error', 'auth', `Login-session Cookie removal failed: ${error.message}`);
      })
      .then(() => stopPromise)
      .catch((error) => {
        addLog('error', 'proxy', `Auth-failure shutdown failed: ${error.message}`);
      });
  });

  // Session events
  instance.on('session-open', (session) => {
    if (!isActiveProxyInstance(instance)) return;
    addLog('info', 'session', `Opened: ${session.remoteAddress} (#${session.id})`);
    sendToMain('session-update', {
      type: 'open',
      session,
      all: instance.getSessions(),
    });
    // System notification for new connection
    showNotification(mainText('sshConnection'), mainText('newSession', session.remoteAddress));
  });

  instance.on('session-close', ({ sessionId }) => {
    if (!isActiveProxyInstance(instance)) return;
    addLog('info', 'session', `Closed: #${sessionId}`);
    sendToMain('session-update', {
      type: 'close',
      sessionId,
      all: instance.getSessions(),
    });
  });

  // Traffic / stats — throttle to ~2 Hz (500ms) to avoid flooding renderer
  instance.on('traffic', () => {
    if (!isActiveProxyInstance(instance)) return;
    if (!_statsThrottleTimer) {
      _statsThrottleTimer = setTimeout(() => {
        _statsThrottleTimer = null;
        if (isActiveProxyInstance(instance)) sendToMain('stats-update', instance.getStats());
      }, 500);
    }
  });

  // Periodic stats update (uptime ticks, session count changes)
  _statsTimer = setInterval(() => {
    if (isActiveProxyInstance(instance)) sendToMain('stats-update', instance.getStats());
  }, 1000);

  try {
    const started = await instance.start();
    if (!started && proxyStopRequests.has(instance)) {
      clearProxyStatsTimers();
      return { ok: true, cancelled: true };
    }
    if (!started) throw new Error('Proxy start was cancelled');
    if (isShuttingDown()) return { ok: true, cancelled: true };
    return { ok: true };
  } catch (err) {
    const cancelled = isShuttingDown() || proxyStopRequests.has(instance);
    if (cancelled) {
      clearProxyStatsTimers();
      instance.removeAllListeners();
      try { await instance.stop(); } catch (_) { /* queued shutdown reports cleanup failures */ }
      if (proxyServer === instance) proxyServer = null;
      return { ok: true, cancelled: true };
    }
    state.proxyStatus = 'error';
    state.error = err.message;
    clearProxyStatsTimers();
    instance.removeAllListeners();
    try { await instance.stop(); } catch (stopError) {
      addLog('warn', 'proxy', `Cleanup after failed start: ${stopError.message}`);
    }
    if (proxyServer === instance) proxyServer = null;
    addLog('error', 'proxy', `Start failed: ${err.message}`);
    sendToMain('proxy-status', {
      proxyStatus: 'error',
      connectionCount: 0,
      error: err.message,
    });
    updateTrayIcon();
    updateTrayMenu();
    return { ok: false, error: err.message };
  }
}

function stopProxyServer() {
  const instance = proxyServer;
  if (instance && state.proxyStatus === 'starting') {
    proxyStopRequests.add(instance);
    try {
      instance.stop().catch((error) => {
        addLog('warn', 'proxy', `Start cancellation failed: ${error.message}`);
      });
    } catch (error) {
      addLog('warn', 'proxy', `Start cancellation failed: ${error.message}`);
    }
  }
  return enqueueProxyLifecycle(stopProxyServerNow);
}

async function stopProxyServerNow() {
  const instance = proxyServer;
  if (!instance) {
    clearProxyStatsTimers();
    publishProxyStopped();
    return { ok: true, alreadyStopped: true };
  }

  clearProxyStatsTimers();
  try {
    await instance.stop();
    if (proxyServer === instance) publishProxyStopped();
    instance.removeAllListeners();
    if (proxyServer === instance) proxyServer = null;
    return { ok: true };
  } catch (error) {
    state.proxyStatus = 'error';
    state.error = error.message;
    addLog('error', 'proxy', `Stop failed: ${error.message}`);
    sendToMain('proxy-status', {
      proxyStatus: 'error',
      connectionCount: state.connectionCount,
      error: error.message,
    });
    updateTrayIcon();
    updateTrayMenu();
    return { ok: false, error: error.message };
  }
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
  if (isShuttingDown() || !settings.autoConnect) return;
  try {
    // Prefer saved cookie (captured at login time, guaranteed complete)
    // over Electron session cookies (session cookies like SCOW_USER may be lost)
    if (capturedCookieString) {
      addLog('info', 'app', 'Auto-connect: using saved cookie from previous session');
      state.cookieValid = true;
      state.cookieCount = countCookiePairs(capturedCookieString);
      state.loginStatus = 'success';
      state.wssUrl = buildWssUrl();
      sendToMain('login-status', 'success');
      sendToMain('cookie-status', { cookieValid: true, cookieCount: state.cookieCount });
      if (isShuttingDown()) return;
      await startProxyServer(capturedCookieString);
    } else {
      // No saved cookie — check Electron session for fresh login
      const cookieGeneration = cookieStateGeneration;
      const cookies = await getAuthSession().cookies.get({ domain: PLATFORM.domain });
      if (!isCurrentCookieGeneration(cookieGeneration)) return;
      if (cookies.length > 0) {
        addLog('info', 'app', `Auto-connect: ${cookies.length} cookies found`);
        capturedCookieString = buildCookieHeader(cookies);
        state.cookieValid = true;
        state.cookieCount = cookies.length;
        state.loginStatus = 'success';
        state.wssUrl = buildWssUrl();
        try { credentialStore.saveCookie(capturedCookieString); } catch (error) {
          addLog('error', 'cookie', `Cookie persistence failed: ${error.message}`);
        }
        sendToMain('login-status', 'success');
        sendToMain('cookie-status', { cookieValid: true, cookieCount: cookies.length });
        if (isShuttingDown()) return;
        await startProxyServer(capturedCookieString);
      } else {
        addLog('info', 'app', 'Auto-connect: no cookies found, waiting for manual login');
      }
    }
  } catch (err) {
    if (isShuttingDown()) return;
    addLog('warn', 'app', `Auto-connect check failed: ${err.message}`);
  }
}

// =========================================================================
// IPC Handlers
// =========================================================================

function setupIPCHandlers() {
  let logPath = '';
  try { logPath = log.transports.file.getFile().path; } catch (_) {}

  const handle = (channel, handler) => {
    ipcMain.handle(channel, (event, ...args) => {
      assertTrustedIpc(event);
      return handler(...args);
    });
  };

  handle('runtime:get-info', () => ({
    isElectron: true,
    platform: process.platform,
    electronVersion: process.versions.electron,
    nodeVersion: process.versions.node,
    devMode: IS_DEV,
    logPath,
  }));

  handle('status:get', () => ({ ...state }));

  // ---- Settings ----
  handle('settings:get', () => publicSettings(settings));
  handle('settings:save', (input) => {
    const next = normalizePublicSettings(input, settings);
    const needsRestart = state.proxyStatus !== 'stopped' && [
      'port', 'host', 'cluster', 'loginNode', 'cols', 'rows', 'useRoot',
    ].some((key) => next[key] !== settings[key]);
    persistSettings(next);
    Object.assign(settings, next);
    state.port = settings.port;
    state.host = settings.host;
    state.wssUrl = buildWssUrl();
    addLog('info', 'settings', 'Settings saved');
    return { ok: true, needsRestart };
  });

  // ---- SSO Credentials (write-only password) ----
  handle('sso:save-credentials', (username, password) => {
    const status = credentialStore.saveSso({ username: username ?? '', password });
    addLog('info', 'settings', 'SSO credentials updated');
    return { ok: true, ...status };
  });
  handle('sso:get-credentials', () => credentialStore.getSsoStatus());
  handle('sso:clear-credentials', () => {
    const status = credentialStore.clearSso();
    addLog('info', 'settings', 'SSO credentials cleared');
    return { ok: true, ...status };
  });

  // ---- Login ----
  handle('login:start', async () => {
    if (isShuttingDown()) return shutdownStartResult();
    if (loginWindow && !loginWindow.isDestroyed()) {
      return createLoginWindow();
    }

    const stopResult = await stopProxyServer();
    if (stopResult?.ok === false) return stopResult;
    if (isShuttingDown()) return shutdownStartResult();
    authStateController.invalidate('idle');

    try {
      await clearAuthSessionCookies();
    } catch (error) {
      if (isShuttingDown()) return shutdownStartResult();
      state.loginStatus = 'failure';
      addLog('error', 'auth', `Login-session Cookie removal failed: ${error.message}`);
      sendToMain('login-status', 'failure');
      throw error;
    }

    if (isShuttingDown()) return shutdownStartResult();
    state.loginStatus = 'pending';
    sendToMain('login-status', 'pending');
    return createLoginWindow();
  });

  // ---- Proxy ----
  handle('proxy:start', () => startProxyServer());
  handle('proxy:stop', () => stopProxyServer());

  // ---- Logs ----
  handle('logs:get', () => [...logs]);
  handle('logs:clear', () => {
    const clearedThroughId = logId;
    logs.length = 0;
    return { ok: true, clearedThroughId };
  });

  // ---- Sessions ----
  handle('sessions:get', () => {
    return proxyServer ? proxyServer.getSessions() : [];
  });

  handle('sessions:disconnect', (sessionId) => {
    if (!Number.isSafeInteger(sessionId) || sessionId < 1) throw new TypeError('sessionId is invalid');
    if (proxyServer) {
      const ok = proxyServer.disconnectSession(sessionId);
      if (ok) addLog('info', 'session', `Force-disconnected #${sessionId}`);
      return ok;
    }
    return false;
  });

  // ---- Stats ----
  handle('stats:get', () => {
    return proxyServer ? proxyServer.getStats() : {
      uptimeMs: 0, totalBytesSent: 0, totalBytesReceived: 0, sessionCount: 0, sessions: [],
    };
  });

  // ---- SSH Key Info ----
  handle('ssh-key:get-info', () => {
    const keyInfo = ensureSshKeyPair();
    return {
      publicKey: keyInfo.publicKey,
      privateKeyPath: keyInfo.privateKeyPath,
      exists: fs.existsSync(keyInfo.privateKeyPath),
    };
  });

  // ---- SSH Config ----
  handle('ssh-config:generate', (options = {}) => {
    const sshDir = path.join(os.homedir(), '.ssh');
    const keyInfo = ensureSshKeyPair();
    const service = new SshConfigService({
      sshDirectory: sshDir,
      privateKeyPath: keyInfo.privateKeyPath,
    });
    const result = service.write({
      host: options.host ?? state.host,
      port: options.port ?? state.port,
      alias: options.alias ?? settings.sshAlias,
    });
    addLog('info', 'ssh-config', `Written ${result.path}`);
    return { success: true, path: result.path, content: result.block, backupPath: result.backupPath };
  });

  // ---- Theme ----
  handle('theme:get', () => settings.theme || 'dark');
  handle('theme:set', (theme) => {
    const next = normalizePublicSettings({ theme }, settings);
    persistSettings(next);
    Object.assign(settings, next);
    sendToMain('theme-changed', theme);
    return { ok: true };
  });

  handle('locale:set', (locale) => {
    const next = normalizePublicSettings({ locale }, settings);
    persistSettings(next);
    Object.assign(settings, next);
    updateTrayMenu();
    return { ok: true };
  });

  // ---- Clipboard ----
  handle('clipboard:write', (text) => {
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw new TypeError('clipboard text is invalid');
    clipboard.writeText(text);
    return { ok: true };
  });

  handle('external:open', async (url) => {
    if (typeof url !== 'string' || url.length > 2048) throw new TypeError('URL is invalid');
    const parsed = parseHttpsUrl(url);
    if (!parsed) throw new TypeError('Only HTTPS URLs can be opened');
    await shell.openExternal(parsed.href);
    return { ok: true };
  });

  handle('app:set-dirty', (dirty) => {
    if (typeof dirty !== 'boolean') throw new TypeError('dirty state must be a boolean');
    rendererHasUnsavedChanges = dirty;
    return { ok: true };
  });

  // ---- App exit ----
  handle('app:exit', () => {
    void requestShutdown(0);
    return { ok: true };
  });
}

// =========================================================================
// App Lifecycle
// =========================================================================

const hasSingleInstanceLock = app.requestSingleInstanceLock();

function confirmDiscardUnsavedChanges() {
  if (!rendererHasUnsavedChanges) return true;
  const isChinese = settings.locale === 'zh';
  const options = {
    type: 'warning',
    buttons: isChinese ? ['放弃更改并退出', '取消'] : ['Discard Changes and Quit', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    title: isChinese ? '未保存的设置' : 'Unsaved Settings',
    message: isChinese ? '设置中有尚未保存的更改。' : 'You have unsaved settings changes.',
    detail: isChinese ? '退出将放弃这些更改。' : 'Quitting will discard those changes.',
  };
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      return dialog.showMessageBoxSync(mainWindow, options) === 0;
    }
    return dialog.showMessageBoxSync(options) === 0;
  } catch (error) {
    log.error(`[app] Unsaved-changes confirmation failed: ${redactLogMessage(error?.message)}`);
    return false;
  }
}

function requestShutdown(exitCode) {
  if (!(exitCode > 0) && !isShuttingDown() && !confirmDiscardUnsavedChanges()) {
    return Promise.resolve({ ok: false, cancelled: true });
  }
  if (!shutdownCoordinator) {
    app.exit(exitCode > 0 ? exitCode : 0);
    return Promise.resolve();
  }
  return shutdownCoordinator.request(exitCode);
}

function beginFatalShutdown(context, error) {
  const message = error?.message || String(error);
  try {
    addLog('error', 'app', `${context}: ${message}`);
  } catch (_) {
    log.error(`[app] ${context}: ${redactLogMessage(message)}`);
  }
  return requestShutdown(1);
}

shutdownCoordinator = createShutdownCoordinator({
  stop: () => stopProxyServer(),
  exit: (exitCode) => app.exit(exitCode),
  onPrepare: () => {
    allowAppQuit = true;
    rendererHasUnsavedChanges = false;
    invalidateCookieQueries();
    const authWindow = loginWindow;
    loginWindow = null;
    if (authWindow && !authWindow.isDestroyed()) authWindow.destroy();
    if (cookieChangeTimer) {
      clearTimeout(cookieChangeTimer);
      cookieChangeTimer = null;
    }
    if (autoConnectTimer) {
      clearTimeout(autoConnectTimer);
      autoConnectTimer = null;
    }
    if (tray) {
      tray.destroy();
      tray = null;
    }
  },
  onCleanupError: (error) => {
    log.error(`[app] Shutdown cleanup failed: ${redactLogMessage(error?.message)}`);
  },
});

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (isShuttingDown()) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    if (isShuttingDown()) return;
    try {
      credentialStore.migrateLegacySecrets();
      capturedCookieString = credentialStore.getCookie();
    } catch (error) {
      startupWarnings.push(`Credential migration failed: ${error.message}`);
      capturedCookieString = '';
    }

    setupIPCHandlers();
    setupCookieMonitoring();
    createTray();
    createMainWindow();
    try {
      ensureSshKeyPair();
      ensureProxyHostKey(path.join(app.getPath('userData'), SSH_HOST_KEY_NAME));
    } catch (error) {
      startupWarnings.push(error.message);
    }
    addLog('info', 'app', 'Application started');
    for (const warning of startupWarnings.splice(0)) addLog('warn', 'startup', warning);

    // Auto-connect after a short delay to let the cookie store initialize.
    autoConnectTimer = setTimeout(() => {
      autoConnectTimer = null;
      if (!isShuttingDown()) void tryAutoConnect();
    }, 1000);
  }).catch((error) => beginFatalShutdown('Startup failed', error));

  app.on('window-all-closed', () => {
    // The tray owns the app lifetime on every platform.
  });

  app.on('before-quit', (event) => {
    event.preventDefault();
    void requestShutdown(0);
  });

  app.on('activate', () => {
    if (isShuttingDown()) return;
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    } else if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
}

process.on('unhandledRejection', (reason) => {
  void beginFatalShutdown('Unhandled rejection', reason);
});

process.on('uncaughtException', (err) => {
  void beginFatalShutdown('Uncaught exception', err);
});
