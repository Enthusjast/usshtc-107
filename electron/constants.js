// Shared constants — single source of truth for default settings and platform configs.
// Imported by both main process and renderer to avoid duplication.

const DEFAULTS = {
  port: 3000,
  host: '127.0.0.1',
  cluster: 'training',
  loginNode: '11.11.10.202',
  cols: 80,
  rows: 24,
  useRoot: false,
  autoConnect: true,
  startMinimized: false,
  theme: 'dark',
};

const PLATFORM = {
  url: 'https://107.ustc.edu.cn',
  domain: '107.ustc.edu.cn',
  wssBase: 'wss://107.ustc.edu.cn/api/shell',
  origin: 'https://107.ustc.edu.cn',
};

const LOGIN_PAGE_PATTERNS = [
  'login', 'passport', 'sso', 'signin',
  'auth', 'oauth', 'openid', 'cas', 'idp',
];

const TERMINAL_PATTERNS = [
  '/shell', '/terminal', '/console', '/webssh',
  '/ssh', 'xterm', 'tty', '/api/shell',
];

// WSS close codes indicating cookie expiry
// 1006 = abnormal closure (network blip, not an auth failure).
// Only 1008 (policy violation) and 1011 (server error) indicate auth issues.
const AUTH_CLOSE_CODES = new Set([1008, 1011]);

// Timeouts (ms)
const WSS_HANDSHAKE_TIMEOUT = 15000;
const PING_INTERVAL = 20000;
const PING_TIMEOUT = 10000;
const CTRL_D_DRAIN_MS = 500;

module.exports = {
  DEFAULTS,
  PLATFORM,
  LOGIN_PAGE_PATTERNS,
  TERMINAL_PATTERNS,
  AUTH_CLOSE_CODES,
  WSS_HANDSHAKE_TIMEOUT,
  PING_INTERVAL,
  PING_TIMEOUT,
  CTRL_D_DRAIN_MS,
};
