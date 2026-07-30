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
  locale: 'en',
  savedCookieEncrypted: '',
  ssoUsername: '',
  ssoPassword: '',
  sshPublicKey: '',
  sshPublicKeyRaw: '',
  sshAlias: 'usshtc107',
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

// Authentication is invalidated only by an explicit HTTP 401/403 handshake.
// WebSocket close codes such as 1008/1011 are too broad to identify expiry.
const AUTH_CLOSE_CODES = new Set();

// Timeouts (ms)
const WSS_HANDSHAKE_TIMEOUT = 15000;
const PING_INTERVAL = 20000;
const PING_TIMEOUT = 10000;
const CTRL_D_DRAIN_MS = 500;
const SSH_HANDSHAKE_TIMEOUT = 15000;
const SSH_SOCKET_IDLE_TIMEOUT = 2 * 60 * 60 * 1000;
const PROXY_SHUTDOWN_TIMEOUT = 5000;
const EXEC_TIMEOUT = 60000;
const WS_BACKPRESSURE_POLL_MS = 25;

// Resource limits
const MAX_TCP_CONNECTIONS = 32;
const MAX_PROXY_SESSIONS = 64;
const MAX_WSS_PAYLOAD_BYTES = 1024 * 1024;
const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_EXEC_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_WS_BUFFERED_BYTES = 1024 * 1024;

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
  SSH_HANDSHAKE_TIMEOUT,
  SSH_SOCKET_IDLE_TIMEOUT,
  PROXY_SHUTDOWN_TIMEOUT,
  EXEC_TIMEOUT,
  WS_BACKPRESSURE_POLL_MS,
  MAX_TCP_CONNECTIONS,
  MAX_PROXY_SESSIONS,
  MAX_WSS_PAYLOAD_BYTES,
  MAX_PENDING_BYTES,
  MAX_EXEC_OUTPUT_BYTES,
  MAX_WS_BUFFERED_BYTES,
};
