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

// ---- SSO Credentials (encrypted) ----

export async function saveSsoCredentials(username, password) {
  if (!hasElectronRuntime()) return;
  const api = getAPI();
  return api?.saveSsoCredentials?.(username, password);
}

export async function getSsoCredentials() {
  if (!hasElectronRuntime()) return { username: '', hasPassword: false, storageAvailable: false };
  const api = getAPI();
  const credentials = await api?.getSsoCredentials?.();
  if (!credentials) return { username: '', hasPassword: false, storageAvailable: false };
  return {
    username: credentials.username || '',
    // Backward compatible during the main-process API migration without
    // exposing the legacy plaintext password to view components.
    hasPassword: Boolean(credentials.hasPassword ?? credentials.password),
    storageAvailable: credentials.storageAvailable !== false,
  };
}

export function supportsClearSsoCredentials() {
  return hasElectronRuntime() && typeof getAPI()?.clearSsoCredentials === 'function';
}

export async function clearSsoCredentials() {
  if (!supportsClearSsoCredentials()) return { ok: false, unavailable: true };
  return getAPI().clearSsoCredentials();
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

// ---- SSH Key Info ----

export async function getSshKeyInfo() {
  if (!hasElectronRuntime()) return { publicKey: '', privateKeyPath: '', exists: false };
  const api = getAPI();
  return api?.getSshKeyInfo?.() ?? { publicKey: '', privateKeyPath: '', exists: false };
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

export async function setAppLocale(locale) {
  if (!hasElectronRuntime()) return;
  return getAPI()?.setLocale?.(locale);
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
    if (hasElectronRuntime()) {
      const result = await getAPI()?.copyToClipboard?.(text);
      return result === true || result?.ok === true;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function setAppDirty(dirty) {
  if (!hasElectronRuntime()) return;
  try {
    return await getAPI()?.setAppDirty?.(Boolean(dirty));
  } catch (error) {
    return { ok: false, error: error?.message || 'Unable to update application state' };
  }
}

export async function exitApp() {
  if (!hasElectronRuntime()) return;
  const api = getAPI();
  return api?.exitApp?.();
}
