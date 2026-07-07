const { contextBridge, ipcRenderer, shell } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,

  // ---- Runtime ----
  getRuntimeInfo: () => ipcRenderer.invoke('runtime:get-info'),

  // ---- Status ----
  getStatus: () => ipcRenderer.invoke('status:get'),

  // ---- Settings ----
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),

  // ---- SSO Credentials (encrypted) ----
  saveSsoCredentials: (username, password) => ipcRenderer.invoke('sso:save-credentials', username, password),
  getSsoCredentials: () => ipcRenderer.invoke('sso:get-credentials'),

  // ---- Login ----
  startLogin: () => ipcRenderer.invoke('login:start'),

  // ---- Proxy control ----
  startProxy: () => ipcRenderer.invoke('proxy:start'),
  stopProxy: () => ipcRenderer.invoke('proxy:stop'),

  // ---- Logs ----
  getLogs: () => ipcRenderer.invoke('logs:get'),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),

  // ---- Sessions ----
  getSessions: () => ipcRenderer.invoke('sessions:get'),
  disconnectSession: (sessionId) => ipcRenderer.invoke('sessions:disconnect', sessionId),

  // ---- Stats ----
  getStats: () => ipcRenderer.invoke('stats:get'),

  // ---- SSH Key Info ----
  getSshKeyInfo: () => ipcRenderer.invoke('ssh-key:get-info'),

  // ---- SSH Config ----
  generateSshConfig: (opts) => ipcRenderer.invoke('ssh-config:generate', opts),

  // ---- Theme ----
  getTheme: () => ipcRenderer.invoke('theme:get'),
  setTheme: (theme) => ipcRenderer.invoke('theme:set', theme),

  // ---- External ----
  openExternal: (url) => {
    try {
      const u = new URL(url);
      if (u.protocol === 'https:' || u.protocol === 'http:') {
        shell.openExternal(url);
      }
    } catch (_) { /* ignore invalid URLs */ }
  },
  copyToClipboard: (text) => ipcRenderer.invoke('clipboard:write', text),
  exitApp: () => ipcRenderer.invoke('app:exit'),

  // ---- Event subscriptions (each returns an unsubscribe function) ----
  onLoginStatus: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('login-status', listener);
    return () => ipcRenderer.removeListener('login-status', listener);
  },

  onProxyStatus: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('proxy-status', listener);
    return () => ipcRenderer.removeListener('proxy-status', listener);
  },

  onCookieStatus: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('cookie-status', listener);
    return () => ipcRenderer.removeListener('cookie-status', listener);
  },

  onNewLog: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('new-log', listener);
    return () => ipcRenderer.removeListener('new-log', listener);
  },

  onLoginProgress: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('login-progress', listener);
    return () => ipcRenderer.removeListener('login-progress', listener);
  },

  onSessionUpdate: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('session-update', listener);
    return () => ipcRenderer.removeListener('session-update', listener);
  },

  onStatsUpdate: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('stats-update', listener);
    return () => ipcRenderer.removeListener('stats-update', listener);
  },

  onThemeChanged: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('theme-changed', listener);
    return () => ipcRenderer.removeListener('theme-changed', listener);
  },
});
