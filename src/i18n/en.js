const en = {
  // Nav
  dashboard: 'Dashboard',
  sessions: 'Sessions',
  logs: 'Logs',
  settings: 'Settings',
  toggleSidebar: 'Toggle sidebar',

  // Theme
  light: 'Light',
  dark: 'Dark',
  switchToLight: 'Switch to light theme',
  switchToDark: 'Switch to dark theme',

  // Auth
  authentication: 'Authentication',
  notLoggedIn: 'Not logged in',
  loggingIn: 'Logging in…',
  ssoDone: 'SSO done — open Web SSH',
  loggedIn: 'Logged in',
  loginFailed: 'Login failed',
  navigateToWebSSH: 'Navigate to the Web SSH page in the login window',
  noSessionCookies: 'No session cookies',
  nCookies: (n) => `${n} cookie${n !== 1 ? 's' : ''}`,
  login: 'Login',
  reLogin: 'Re-login',

  // Proxy
  proxyServer: 'Proxy Server',
  stopped: 'Stopped',
  starting: 'Starting…',
  running: 'Running',
  error: 'Error',
  initializingSSH: 'Initializing SSH server…',
  notRunning: 'Not running',
  nActiveConnections: (n) => `${n} active connection${n !== 1 ? 's' : ''}`,
  start: 'Start',
  stop: 'Stop',

  // Traffic
  trafficStats: 'Traffic Statistics',
  uptime: 'Uptime',
  sent: 'Sent',
  received: 'Received',
  activeSessions: 'Active Sessions',

  // SSH
  sshConnection: 'SSH Connection',
  copyCommand: 'Copy command',
  copied: 'Copied!',
  copySuccess: 'Copied to clipboard',

  // WSS
  wssEndpoint: 'WSS Endpoint',

  // Summary
  cookies: 'Cookies',
  sessionValid: 'Session valid',
  noValidSession: 'No valid session',
  connections: 'Connections',
  activeSSHSessions: 'Active SSH sessions',

  // Sessions view
  noActiveSSHSessions: 'No active SSH sessions',
  sessionsHint: 'Sessions appear here when someone connects via SSH',
  remoteAddress: 'Remote Address',
  connected: 'Connected',
  duration: 'Duration',
  disconnect: 'Disconnect',
  aggregate: 'Aggregate',
  totalSessions: 'Total sessions',
  totalSent: 'Total sent',
  totalReceived: 'Total received',
  sessionClosed: 'Session closed',
  disconnected: 'Disconnected',
  newSession: 'New session',
  disconnecting: 'Disconnecting',
  disconnectFailed: 'Could not disconnect session',
  failed: 'Failed',

  // Logs
  copyAll: 'Copy all',
  clear: 'Clear',
  nEntries: (n) => `${n} entries`,
  noLogEntries: 'No log entries yet',
  logsCleared: 'Logs cleared',
  logsCopied: 'Logs copied',

  // Settings
  proxySettings: 'Proxy Settings',
  host: 'Host',
  portLabel: 'Port (1–65535)',
  clusterSettings: 'Cluster Settings',
  cluster: 'Cluster',
  loginNodeIP: 'Login Node IP',
  colsLabel: 'Cols (40–500)',
  rowsLabel: 'Rows (10–200)',
  useRoot: 'Use Root',
  behavior: 'Behavior',
  autoConnect: 'Auto-connect on startup',
  startMinimized: 'Start minimized to tray',
  sshConfig: 'SSH Config',
  sshAlias: 'SSH Alias',
  generateSshConfig: 'Generate ~/.ssh/config',
  writing: 'Writing…',
  writtenTo: 'Written to',
  saveSettings: 'Save Settings',
  savedLabel: 'Saved',
  resetDefaults: 'Reset to defaults',
  about: 'About',
  platform: 'Platform',
  mode: 'Mode',
  devMode: 'Development',
  prodMode: 'Production',
  logPath: 'Logs',
  language: 'Language',

  // Settings messages
  proxyRunningRestart: 'Proxy is running — stop and restart for changes to take effect',
  invalidPort: 'Invalid port',
  portRange: 'Port must be between 1 and 65535',
  settingsSaved: 'Settings saved',
  restartToApply: 'Restart proxy for changes to take effect',
  resetToDefaults: 'Reset to defaults',
  clickSaveToApply: 'Click Save to apply',
  sshConfigWritten: 'SSH config written',
  sshNowUse: (alias) => `Now use: ssh ${alias}`,
  sshConfigHint: (alias) => `Generate ~/.ssh/config entry. Then connect with ssh ${alias}`,
  errorPrefix: (msg) => `Error: ${msg}`,

  // Toast
  ssoComplete: 'SSO complete',
  openWebSSHPage: 'Open Web SSH page',
  proxyReady: 'Proxy ready',
  sessionExpired: 'Session expired',
  reLoginNeeded: 'Re-login needed',
  proxyRunningToast: 'Proxy running',
  listeningOn: (host, port) => `Listening on ${host}:${port}`,
  proxyError: 'Proxy error',
  shuttingDown: 'Shutting down…',
};

export default en;
