const zh = {
  // Nav
  dashboard: '仪表盘',
  sessions: '会话管理',
  logs: '日志',
  settings: '设置',
  toggleSidebar: '切换侧边栏',

  // Theme
  light: '浅色',
  dark: '深色',
  switchToLight: '切换到浅色主题',
  switchToDark: '切换到深色主题',

  // Auth
  authentication: '认证',
  notLoggedIn: '未登录',
  loggingIn: '登录中…',
  ssoDone: 'SSO 完成 — 打开 Web SSH',
  loggedIn: '已登录',
  loginFailed: '登录失败',
  navigateToWebSSH: '请在登录窗口中打开 Web SSH 页面',
  noSessionCookies: '无会话 Cookie',
  nCookies: (n) => `${n} 个 Cookie`,
  login: '登录',
  reLogin: '重新登录',

  // Proxy
  proxyServer: '代理服务器',
  stopped: '已停止',
  starting: '启动中…',
  running: '运行中',
  error: '错误',
  initializingSSH: '正在初始化 SSH 服务器…',
  notRunning: '未运行',
  nActiveConnections: (n) => `${n} 个活跃连接`,
  start: '启动',
  stop: '停止',

  // Traffic
  trafficStats: '流量统计',
  uptime: '运行时长',
  sent: '已发送',
  received: '已接收',
  activeSessions: '活跃会话',

  // SSH
  sshConnection: 'SSH 连接',
  copyCommand: '复制命令',
  copied: '已复制',
  copySuccess: '已复制到剪贴板',

  // WSS
  wssEndpoint: 'WSS 端点',

  // Summary
  cookies: 'Cookie',
  sessionValid: '会话有效',
  noValidSession: '无有效会话',
  connections: '连接数',
  activeSSHSessions: '活跃 SSH 会话',

  // Sessions view
  noActiveSSHSessions: '暂无活跃 SSH 会话',
  sessionsHint: 'SSH 连接建立后会显示在这里',
  remoteAddress: '远程地址',
  connected: '连接时间',
  duration: '持续时长',
  disconnect: '断开连接',
  aggregate: '汇总',
  totalSessions: '总会话数',
  totalSent: '总发送量',
  totalReceived: '总接收量',
  sessionClosed: '会话已关闭',
  disconnected: '已断开',
  newSession: '新会话',
  disconnecting: '正在断开',
  disconnectFailed: '无法断开会话',
  failed: '失败',

  // Logs
  copyAll: '全部复制',
  clear: '清空',
  nEntries: (n) => `${n} 条记录`,
  noLogEntries: '暂无日志',
  logsCleared: '日志已清空',
  logsCopied: '日志已复制',

  // Settings
  proxySettings: '代理设置',
  host: '主机',
  portLabel: '端口 (1–65535)',
  clusterSettings: '集群设置',
  cluster: '集群',
  loginNodeIP: '登录节点 IP',
  colsLabel: '列数 (40–500)',
  rowsLabel: '行数 (10–200)',
  useRoot: '使用 Root',
  behavior: '行为设置',
  autoConnect: '启动时自动连接',
  startMinimized: '启动时最小化到托盘',
  sshConfig: 'SSH 配置',
  sshAlias: 'SSH 别名',
  generateSshConfig: '生成 ~/.ssh/config',
  writing: '写入中…',
  writtenTo: '已写入',
  saveSettings: '保存设置',
  savedLabel: '已保存',
  resetDefaults: '恢复默认',
  about: '关于',
  platform: '平台',
  mode: '模式',
  devMode: '开发模式',
  prodMode: '生产模式',
  logPath: '日志路径',
  language: '语言',

  // Settings messages
  proxyRunningRestart: '代理正在运行 — 请停止后重启以使更改生效',
  invalidPort: '无效端口',
  portRange: '端口必须在 1 到 65535 之间',
  settingsSaved: '设置已保存',
  restartToApply: '请重启代理以使更改生效',
  resetToDefaults: '已恢复默认值',
  clickSaveToApply: '点击保存以应用',
  sshConfigWritten: 'SSH 配置已写入',
  sshNowUse: (alias) => `现在可以使用: ssh ${alias}`,
  sshConfigHint: (alias) => `生成 ~/.ssh/config 条目，然后使用 ssh ${alias} 即可连接`,
  errorPrefix: (msg) => `错误: ${msg}`,

  // Toast
  ssoComplete: 'SSO 认证完成',
  openWebSSHPage: '请打开 Web SSH 页面',
  proxyReady: '代理就绪',
  sessionExpired: '会话已过期',
  reLoginNeeded: '需要重新登录',
  proxyRunningToast: '代理运行中',
  listeningOn: (host, port) => `正在监听 ${host}:${port}`,
  proxyError: '代理错误',
  shuttingDown: '正在关闭…',
};

export default zh;
