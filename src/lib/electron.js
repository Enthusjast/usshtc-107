export class ApiError extends Error {
  constructor(code, fieldErrors) {
    super(code);
    this.name = 'ApiError';
    this.code = code;
    if (fieldErrors) this.fieldErrors = fieldErrors;
  }
}

function method(name) {
  const api = globalThis.electronAPI;
  if (!api?.isElectron) throw new ApiError('RUNTIME_UNAVAILABLE');
  if (typeof api[name] !== 'function') throw new ApiError('API_UNAVAILABLE');
  return api[name].bind(api);
}

async function invoke(name, ...args) {
  let result;
  try {
    result = await method(name)(...args);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('INTERNAL_ERROR');
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new ApiError('API_UNAVAILABLE');
  if (result.ok === true && Object.hasOwn(result, 'value') && !Object.hasOwn(result, 'error') && Object.keys(result).length === 2) return result.value;
  if (result.ok === false && Object.keys(result).length === 2 && result.error && typeof result.error === 'object' && !Array.isArray(result.error) && typeof result.error.code === 'string' && result.error.code && Object.keys(result.error).every((key) => key === 'code' || key === 'fieldErrors') && (result.error.fieldErrors === undefined || (result.error.fieldErrors && typeof result.error.fieldErrors === 'object' && !Array.isArray(result.error.fieldErrors) && Object.values(result.error.fieldErrors).every((value) => typeof value === 'string')))) {
    throw new ApiError(result.error.code, result.error.fieldErrors);
  }
  throw new ApiError('API_UNAVAILABLE');
}

export const getRuntimeInfo = () => invoke('getRuntimeInfo');
export const getStatus = () => invoke('getStatus');
export const getSettings = (scope) => invoke('getSettings', scope);
export const saveSettings = (payload) => invoke('saveSettings', payload);
export const saveAppSettings = (patch) => invoke('saveAppSettings', patch);
export const retryLoadSettings = (scope) => invoke('retryLoadSettings', scope);
export const getAutostart = () => invoke('getAutostart');
export const setAutostart = (enabled) => invoke('setAutostart', enabled);
export const retryRecovery = (scope) => invoke('retryRecovery', scope);
export const getProfiles = () => invoke('getProfiles');
export const createProfile = (payload) => invoke('createProfile', payload);
export const renameProfile = (payload) => invoke('renameProfile', payload);
export const deleteProfile = (payload) => invoke('deleteProfile', payload);
export const activateProfile = (payload) => invoke('activateProfile', payload);
export const saveOnboarding = (payload) => invoke('saveOnboarding', payload);
export const getUpdateState = () => invoke('getUpdateState');
export const checkForUpdates = () => invoke('checkForUpdates');
export const downloadUpdate = (payload) => invoke('downloadUpdate', payload);
export const installUpdate = (payload) => invoke('installUpdate', payload);
export const openUpdateRelease = () => invoke('openUpdateRelease');
export const saveSsoCredentials = (payload) => invoke('saveSsoCredentials', payload);
export const getSsoCredentials = (scope) => invoke('getSsoCredentials', scope);
export const clearSsoCredentials = (scope) => invoke('clearSsoCredentials', scope);
export const startLogin = (scope) => invoke('startLogin', scope);
export const startProxy = (scope) => invoke('startProxy', scope);
export const stopProxy = (scope) => invoke('stopProxy', scope);
export const restartProxy = (scope) => invoke('restartProxy', scope);
export const getLogs = () => invoke('getLogs');
export const clearLogs = () => invoke('clearLogs');
export const getSessions = () => invoke('getSessions');
export const disconnectSession = (payload) => invoke('disconnectSession', payload);
export const getStats = () => invoke('getStats');
export const getHistory = (payload) => invoke('getHistory', payload);
export const clearHistory = (scope) => invoke('clearHistory', scope);
export const startDiagnostics = (scope) => invoke('startDiagnostics', scope);
export const cancelDiagnostics = (payload) => invoke('cancelDiagnostics', payload);
export const getDiagnostics = (scope) => invoke('getDiagnostics', scope);
export const exportLogs = (payload) => invoke('exportLogs', payload);
export const exportDiagnostics = (scope) => invoke('exportDiagnostics', scope);
export const getSshKeyInfo = (scope) => invoke('getSshKeyInfo', scope);
export const exportKeyBackup = (scope) => invoke('exportKeyBackup', scope);
export const importKeyBackup = (scope) => invoke('importKeyBackup', scope);
export const rotateSshKeys = (payload) => invoke('rotateSshKeys', payload);
export const rebuildSshKeys = (payload) => invoke('rebuildSshKeys', payload);
export const previewSshConfig = (scope) => invoke('previewSshConfig', scope);
export const generateSshConfig = (payload) => invoke('generateSshConfig', payload);
export const getTheme = () => invoke('getTheme');
export const setTheme = (theme) => invoke('setTheme', theme);
export const setAppLocale = (locale) => invoke('setLocale', locale);
export const openExternal = (url) => invoke('openExternal', url);
export const copyToClipboard = (text) => invoke('copyToClipboard', text);
export const setAppDirty = (payload) => invoke('setAppDirty', payload);
export const exitApp = (payload) => invoke('exitApp', payload);

function subscribe(name, callback) {
  if (!globalThis.electronAPI?.isElectron) return () => {};
  const unsubscribe = method(name)(callback);
  if (typeof unsubscribe !== 'function') throw new ApiError('API_UNAVAILABLE');
  return unsubscribe;
}
export const onRuntimeState = (cb) => subscribe('onRuntimeState', cb);
export const onNewLog = (cb) => subscribe('onNewLog', cb);
export const onSessionUpdate = (cb) => subscribe('onSessionUpdate', cb);
export const onStatsUpdate = (cb) => subscribe('onStatsUpdate', cb);
export const onDiagnosticsState = (cb) => subscribe('onDiagnosticsState', cb);
export const onUpdateState = (callback) => subscribe('onUpdateState', callback);
export const onThemeChanged = (cb) => subscribe('onThemeChanged', cb);
