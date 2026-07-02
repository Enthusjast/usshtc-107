/**
 * Electron API wrapper — mirrors FKUNIChat's src/lib/electron.js pattern.
 */

function hasElectronRuntime() {
  return !!(globalThis.electronAPI?.isElectron);
}

function getAPI() {
  return globalThis.electronAPI;
}

// ---- Runtime info ----

export async function getRuntimeInfo() {
  if (!hasElectronRuntime()) return { isElectron: false, platform: 'browser' };
  const api = getAPI();
  return api?.getRuntimeInfo?.() ?? null;
}

export async function getStatus() {
  if (!hasElectronRuntime()) return null;
  const api = getAPI();
  return api?.getStatus?.() ?? null;
}

// ---- Settings ----

export async function getSettings() {
  if (!hasElectronRuntime()) return null;
  const api = getAPI();
  return api?.getSettings?.() ?? null;
}

export async function saveSettings(settings) {
  if (!hasElectronRuntime()) return;
  const api = getAPI();
  return api?.saveSettings?.(settings);
}

// ---- Login ----

export async function startLogin() {
  if (!hasElectronRuntime()) return;
  const api = getAPI();
  return api?.startLogin?.();
}

// ---- Proxy control ----

export async function startProxy() {
  if (!hasElectronRuntime()) return;
  const api = getAPI();
  return api?.startProxy?.();
}

export async function stopProxy() {
  if (!hasElectronRuntime()) return;
  const api = getAPI();
  return api?.stopProxy?.();
}

// ---- Logs ----

export async function getLogs() {
  if (!hasElectronRuntime()) return [];
  const api = getAPI();
  return api?.getLogs?.() ?? [];
}

export async function clearLogs() {
  if (!hasElectronRuntime()) return;
  const api = getAPI();
  return api?.clearLogs?.();
}

// ---- Sessions ----

export async function getSessions() {
  if (!hasElectronRuntime()) return [];
  const api = getAPI();
  return api?.getSessions?.() ?? [];
}

export async function disconnectSession(sessionId) {
  if (!hasElectronRuntime()) return false;
  const api = getAPI();
  return api?.disconnectSession?.(sessionId) ?? false;
}

// ---- Stats ----

export async function getStats() {
  if (!hasElectronRuntime()) return null;
  const api = getAPI();
  return api?.getStats?.() ?? null;
}

// ---- SSH Config ----

export async function generateSshConfig(opts) {
  if (!hasElectronRuntime()) return { success: false, error: 'Not in Electron' };
  const api = getAPI();
  return api?.generateSshConfig?.(opts) ?? { success: false, error: 'API unavailable' };
}

// ---- Theme ----

export async function getTheme() {
  if (!hasElectronRuntime()) return 'dark';
  const api = getAPI();
  return api?.getTheme?.() ?? 'dark';
}

export async function setTheme(theme) {
  if (!hasElectronRuntime()) return;
  const api = getAPI();
  return api?.setTheme?.(theme);
}

// ---- Event subscriptions ----

export function onLoginStatus(cb) {
  if (!hasElectronRuntime()) return () => {};
  const api = getAPI();
  return api?.onLoginStatus?.(cb) ?? (() => {});
}

export function onProxyStatus(cb) {
  if (!hasElectronRuntime()) return () => {};
  const api = getAPI();
  return api?.onProxyStatus?.(cb) ?? (() => {});
}

export function onCookieStatus(cb) {
  if (!hasElectronRuntime()) return () => {};
  const api = getAPI();
  return api?.onCookieStatus?.(cb) ?? (() => {});
}

export function onNewLog(cb) {
  if (!hasElectronRuntime()) return () => {};
  const api = getAPI();
  return api?.onNewLog?.(cb) ?? (() => {});
}

export function onLoginProgress(cb) {
  if (!hasElectronRuntime()) return () => {};
  const api = getAPI();
  return api?.onLoginProgress?.(cb) ?? (() => {});
}

export function onSessionUpdate(cb) {
  if (!hasElectronRuntime()) return () => {};
  const api = getAPI();
  return api?.onSessionUpdate?.(cb) ?? (() => {});
}

export function onStatsUpdate(cb) {
  if (!hasElectronRuntime()) return () => {};
  const api = getAPI();
  return api?.onStatsUpdate?.(cb) ?? (() => {});
}

export function onThemeChanged(cb) {
  if (!hasElectronRuntime()) return () => {};
  const api = getAPI();
  return api?.onThemeChanged?.(cb) ?? (() => {});
}

// ---- External / clipboard ----

export async function openExternal(url) {
  if (!hasElectronRuntime()) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  const api = getAPI();
  return api?.openExternal?.(url);
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function exitApp() {
  if (!hasElectronRuntime()) return;
  const api = getAPI();
  return api?.exitApp?.();
}
