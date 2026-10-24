'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { fileURLToPath } = require('url');
const { SettingsStore, publicSettings } = require('./settings-store');
const { CredentialStore } = require('./credential-store');
const { ProxyServer } = require('./proxy-server');
const { SshConfigService } = require('./ssh-config-service');
const { inspect, getSsh2ClientIdentity, createSshKeyService } = require('./ssh-key-service');
const { createTrustedHandler, ServiceError } = require('./ipc-contract');
const { redactLogMessage } = require('./log-redaction');
const { parseHttpsUrl } = require('./login-navigation');
const { createShutdownCoordinator } = require('./shutdown-coordinator');
const { createProxyController } = require('./proxy-controller');
const { createLoginController } = require('./login-controller');
const { createAppController } = require('./app-controller');
const { createTrayService } = require('./tray-service');
const { createSessionHistoryStore } = require('./session-history-store');
const { createDiagnosticsService, fingerprintConfig } = require('./diagnostics-service');
const { createDiagnosticExportService } = require('./diagnostic-export-service');
const { buildWssUrl } = require('./wss-connection');
const { createAutostartService } = require('./autostart-service');
const { createRecoveryController } = require('./recovery-controller');
const { createUpdateService } = require('./update-service');

function startApplication(deps = {}) {
  const electron = deps.electron || require('electron');
  const { app } = electron;
  const fileSystem = deps.fs || fs;
  const clock = deps.clock || globalThis;
  const processEvents = deps.process || process;

  // Electron parses this switch itself. Resolve paths before the first store, logger or partition access.
  const override = app.commandLine.hasSwitch('user-data-dir');
  const requested = override ? app.commandLine.getSwitchValue('user-data-dir') : null;
  if (override && (typeof requested !== 'string' || !requested || !path.isAbsolute(requested)
      || /[\0\r\n]/.test(requested))) {
    throw new TypeError('--user-data-dir must be a nonempty absolute path');
  }
  const userDataPath = override ? path.resolve(requested) : app.getPath('userData');
  const sessionDataPath = override ? path.join(userDataPath, 'sessionData') : app.getPath('sessionData');
  const logsPath = override ? path.join(userDataPath, 'logs') : app.getPath('logs');
  for (const directory of new Set([userDataPath, sessionDataPath, logsPath])) {
    fileSystem.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fileSystem.chmodSync(directory, 0o700);
  }
  app.setPath('userData', userDataPath);
  app.setPath('sessionData', sessionDataPath);
  app.setAppLogsPath(logsPath);
  const { BrowserWindow, session, ipcMain, clipboard, dialog, shell,
    Tray, Menu, nativeImage, Notification, safeStorage, net, powerMonitor } = electron;

  const logger = deps.log || require('electron-log');
  if (logger.transports?.file) logger.transports.file.level = 'info';
  if (logger.transports?.console) logger.transports.console.level = 'debug';
  const isDev = !app.isPackaged && process.env.ELECTRON_DEV === 'true';
  const sshDirectory = deps.sshDirectory || path.join(os.homedir(), '.ssh');
  const settingsPath = path.join(userDataPath, 'settings.json');
  let mainWindow = null;
  let settingsStore = null;
  let sshKeys = null;
  const currentSettings = () => publicSettings(settingsStore.getRoot());
  let controller = null;
  let tray = null;
  let history = null;
  let historyRevision = 0;
  let diagnostics = null;
  let diagnosticExports = null;
  let diagnosticOwner = null;
  let activeDiagnostic = null;
  let validDiagnosticRunId = null;
  let autostart = null;
  let recovery = null;
  let recoveryOwnerScope = null;
  let updates = null;
  let updatePreference = null;
  let autostartImagePlan = null;
  let updateInstallation = null;
  let recoveryUpdateQueued = false;
  let recoveryHeldForExclusive = false;
  let recoveryNeedsResume = false;
  let systemSuspended = false;
  const queueRecoveryUpdate = () => {
    if (!recovery || systemSuspended || recoveryHeldForExclusive || recoveryUpdateQueued) return;
    recoveryUpdateQueued = true;
    queueMicrotask(() => {
      recoveryUpdateQueued = false;
      if (!recovery || systemSuspended || recoveryHeldForExclusive) return;
      recovery.update();
      if (recoveryNeedsResume) { recoveryNeedsResume = false; recovery.resume(); }
    });
  };
  const suspendRecovery = () => { systemSuspended = true; recovery?.suspend(); };
  const resumeRecovery = () => { systemSuspended = false; recoveryNeedsResume = true; queueRecoveryUpdate(); };
  let allowAppQuit = false;
  let autoConnectTimer = null;
  let preparation = null;
  let fatalRequested = false;
  let callbacks = null;
  const logs = [];
  let logId = 0;
  const handlers = [];
  const startupWarnings = [];
  const publish = (channel, data) => {
    if (channel === 'runtime-state' && diagnostics) {
      const configFingerprint = fingerprintConfig(currentSettings());
      if (!diagnosticOwner || diagnosticOwner.profileId !== data.profileId
          || diagnosticOwner.epoch !== data.epoch || diagnosticOwner.configFingerprint !== configFingerprint) {
        invalidateDiagnostics(data);
      }
    }
    if (channel === 'runtime-state' && recovery) {
      if (recoveryOwnerScope?.profileId !== data.profileId || recoveryOwnerScope?.epoch !== data.epoch) {
        recovery.cancel('scope_changed');
        recoveryOwnerScope = { profileId: data.profileId, epoch: data.epoch };
      }
      const hold = data.operation === 'changing_keys' || data.operation === 'preparing_update';
      if (hold) {
        recoveryHeldForExclusive = true;
        recovery.cancel(data.operation);
      } else if (recoveryHeldForExclusive) {
        recoveryHeldForExclusive = false;
        recoveryNeedsResume = true;
      }
      queueRecoveryUpdate();
    }
    if (channel === 'runtime-state' && updates) {
      const enabled = !settingsStore.isLocked() && currentSettings().autoCheckUpdates;
      if (enabled !== updatePreference) { updatePreference = enabled; updates.setAutoCheck(enabled); }
    }
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
  };
  const invalidateDiagnostics = (scope) => {
    if (!diagnostics) return;
    validDiagnosticRunId = null;
    if (activeDiagnostic) {
      activeDiagnostic.invalidated = true;
      activeDiagnostic.abort.abort();
    }
    diagnosticOwner = { profileId: scope.profileId, epoch: scope.epoch,
      configFingerprint: fingerprintConfig(currentSettings()) };
    publish('diagnostics:state', { profileId: scope.profileId, epoch: scope.epoch, invalidated: true });
  };
  const currentDiagnostic = (scope) => {
    assertScope(scope);
    const value = diagnostics.get(scope);
    return value?.runId === validDiagnosticRunId
      && value.configFingerprint === fingerprintConfig(currentSettings()) ? value : null;
  };
  const startDiagnostic = (scope) => {
    assertScope(scope);
    const configFingerprint = fingerprintConfig(currentSettings());
    if (activeDiagnostic && !activeDiagnostic.abort.signal.aborted
        && activeDiagnostic.profileId === scope.profileId && activeDiagnostic.epoch === scope.epoch
        && activeDiagnostic.configFingerprint === configFingerprint) return activeDiagnostic.promise;
    activeDiagnostic?.abort.abort();
    const record = { ...scope, configFingerprint, abort: new AbortController(), runId: null, invalidated: false };
    activeDiagnostic = record;
    try {
      record.promise = diagnostics.run({ ...scope, signal: record.abort.signal }).finally(() => {
        if (activeDiagnostic === record) activeDiagnostic = null;
      });
      return record.promise;
    } catch (error) {
      if (activeDiagnostic === record) activeDiagnostic = null;
      throw error;
    }
  };
  const addLog = (level, source, message) => {
    const scope = controller?.getSnapshot() || { profileId: 'default', epoch: 0 };
    const entry = { id: ++logId, time: new Date().toISOString(), level, source,
      message: redactLogMessage(message), profileId: scope.profileId, epoch: scope.epoch };
    logs.push(entry);
    if (logs.length > 500) logs.shift();
    publish('new-log', entry);
    const write = typeof logger[level] === 'function' ? logger[level] : logger.info;
    write?.call(logger, `[${source}] ${entry.message}`);
  };
  const coordinator = createShutdownCoordinator({
    stop: () => preparation || Promise.resolve(),
    exit: (code) => app.exit(code),
    onPrepare: () => {
      allowAppQuit = true;
      updates?.dispose();
      if (diagnostics && controller) invalidateDiagnostics(currentScope());
      recovery?.dispose();
      if (autoConnectTimer !== null) clock.clearTimeout(autoConnectTimer);
      autoConnectTimer = null;
      preparation = controller?.prepareExit(fatalRequested ? 'fatal' : 'app_exit') || Promise.resolve();
      tray?.dispose();
      tray = null;
    },
    onCleanupError: (error) => addLog('error', 'app', `Shutdown cleanup failed: ${error.message}`),
    setTimer: clock.setTimeout.bind(clock), clearTimer: clock.clearTimeout.bind(clock),
  });
  const fatal = (context, error) => {
    addLog('error', 'app', `${context}: ${error?.message || String(error)}`);
    fatalRequested = true;
    updates?.dispose();
    if (diagnostics && controller) invalidateDiagnostics(currentScope());
    recovery?.dispose();
    preparation = controller?.prepareExit('fatal') || Promise.resolve();
    preparation.catch((cleanupError) => addLog('error', 'app', `Fatal cleanup failed: ${cleanupError.message}`));
    return coordinator.request(1);
  };
  const trustedUrl = (url) => {
    try {
      const parsed = new URL(url);
      if (isDev) return parsed.origin === 'http://localhost:5173';
      return parsed.protocol === 'file:' && path.resolve(fileURLToPath(parsed))
        === path.resolve(__dirname, '..', 'dist', 'index.html');
    } catch (_) { return false; }
  };
  const assertTrustedIpc = (event) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
        || !event.senderFrame || event.senderFrame !== event.sender.mainFrame
        || !trustedUrl(event.senderFrame.url)) throw new Error('Untrusted IPC sender');
  };
  const currentScope = () => {
    const { profileId, epoch } = controller.getSnapshot();
    return { profileId, epoch };
  };
  const assertScope = (scope) => {
    const current = currentScope();
    if (!scope || scope.profileId !== current.profileId || scope.epoch !== current.epoch) {
      throw new ServiceError('PROFILE_CHANGED');
    }
  };
  const hostKeyPath = path.join(userDataPath, 'proxy_host_ed25519');
  const inspectKeys = () => sshKeys.inspect();
  const inspectExistingIdentity = (raw) => {
    const value = inspect({ sshDirectory, hostKeyPath });
    return { initialized: Boolean(raw?.sshPublicKey || raw?.sshPublicKeyRaw
      || value.client.state !== 'missing' || value.host.state !== 'missing'),
    clientFingerprint: value.client.fingerprint, hostFingerprint: value.host.fingerprint };
  };
  const initializeKeys = () => {
    if (settingsStore.isLocked()) return null;
    try {
      sshKeys.initialize();
      return null;
    } catch (error) {
      startupWarnings.push(`SSH identity unavailable: ${error.code || 'SSH_KEY_INVALID'}`);
      return error.code || 'SSH_KEY_INVALID';
    }
  };
  const createWindow = () => {
    mainWindow = new BrowserWindow({
      width: 1120, height: 720, minWidth: 960, minHeight: 640, center: true,
      show: settingsStore.isLocked() || !currentSettings().startMinimized, autoHideMenuBar: true, title: 'usshtc107',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true,
        nodeIntegration: false, sandbox: true, webSecurity: true,
        allowRunningInsecureContent: false, spellcheck: false },
    });
    const ownedWindow = mainWindow;
    const navigation = isDev ? mainWindow.loadURL('http://localhost:5173')
      : mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
    Promise.resolve(navigation).catch((error) => fatal('Main window navigation failed', error));
    mainWindow.once('ready-to-show', () => {
      if (settingsStore.isLocked() || !currentSettings().startMinimized) ownedWindow.show();
    });
    mainWindow.on('close', (event) => {
      if (!allowAppQuit) { event.preventDefault(); ownedWindow.hide(); }
    });
    mainWindow.on('closed', () => { if (mainWindow === ownedWindow) mainWindow = null; });
    mainWindow.on('page-title-updated', (event) => event.preventDefault());
    const guard = (event, url) => { if (!trustedUrl(url)) event.preventDefault(); };
    mainWindow.webContents.on('will-navigate', guard);
    mainWindow.webContents.on('will-redirect', guard);
    mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  };
  const confirmInterrupt = async ({ action, connectionCount, dirty, keyChange }) => {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    if (action === 'keys') {
      const fingerprint = /^SHA256:[A-Za-z0-9+/]{43}$/;
      if (!keyChange || !['client', 'host', 'both'].includes(keyChange.target)
          || !keyChange.before || !keyChange.after
          || (keyChange.unbacked !== undefined && (!Array.isArray(keyChange.unbacked)
            || keyChange.unbacked.some((role) => !['client', 'host'].includes(role))))) throw new ServiceError('KEY_TRANSACTION_FAILED');
      for (const role of ['client', 'host']) {
        const previous = keyChange.before[`${role}Fingerprint`];
        const next = keyChange.after[`${role}Fingerprint`];
        if ((previous !== null && previous !== undefined && (typeof previous !== 'string' || !fingerprint.test(previous)))
            || ((keyChange.target === role || keyChange.target === 'both') && (typeof next !== 'string' || !fingerprint.test(next)))) {
          throw new ServiceError('KEY_TRANSACTION_FAILED');
        }
      }
    }
    const chinese = currentSettings().locale === 'zh';
    const labels = chinese ? {
      stop: '停止代理', restart: '重启并应用', login: '重新登录', disconnect: '断开会话',
      account: '更改账号', profile: '切换档案', 'delete-profile': '删除档案',
      'recover-settings': '覆盖损坏的设置', exit: '退出', install: '安装更新并重启',
      'clear-history': '清空历史并停止会话',
      keys: '更换 SSH 密钥',
      'retry-load': '重新加载设置并恢复密钥',
    } : {
      stop: 'Stop Proxy', restart: 'Restart and Apply', login: 'Log In Again', disconnect: 'Disconnect Session',
      account: 'Change Account', profile: 'Switch Profile', 'delete-profile': 'Delete Profile',
      'recover-settings': 'Replace Corrupt Settings', exit: 'Quit', install: 'Install Update and Restart',
      'clear-history': 'Clear History and Stop Sessions',
      keys: 'Replace SSH Keys',
      'retry-load': 'Reload Settings and Key Recovery',
    };
    const detail = [
      connectionCount > 0 ? (chinese ? `将中断 ${connectionCount} 个活动连接。` : `${connectionCount} active connection(s) will be interrupted.`) : '',
      dirty ? (chinese ? '未保存的设置更改将被放弃。' : 'Unsaved settings changes will be discarded.') : '',
      action === 'keys' && ['client', 'both'].includes(keyChange.target)
        ? `${chinese ? '客户端指纹' : 'Client fingerprint'}: ${keyChange.before.clientFingerprint || (chinese ? '未记录' : 'not recorded')} → ${keyChange.after.clientFingerprint}` : '',
      action === 'keys' && ['host', 'both'].includes(keyChange.target)
        ? `${chinese ? '主机指纹' : 'Host fingerprint'}: ${keyChange.before.hostFingerprint || (chinese ? '未记录' : 'not recorded')} → ${keyChange.after.hostFingerprint}` : '',
      action === 'keys' && ['host', 'both'].includes(keyChange.target) ? (chinese
        ? '代理主机身份变化会影响 SSH 信任。请核对新指纹；应用不会修改 known_hosts，也不会关闭主机密钥校验。'
        : 'A proxy host identity change affects SSH trust. Verify the new fingerprint; the application will not edit known_hosts or disable host-key checking.') : '',
      action === 'keys' && keyChange.unbacked?.length ? (chinese
        ? `本次恢复不为以下未就绪身份创建旧私钥备份：${keyChange.unbacked.map((role) => role === 'client' ? '客户端' : '主机').join('、')}。替换可能永久丢弃现有私钥材料，如仍需要请取消。`
        : `These non-ready identities are NOT backed up by this repair: ${keyChange.unbacked.join(', ')}. Replacing them can permanently discard current private material; cancel if it is still needed.`) : '',
      action === 'clear-history' ? (chinese ? '代理将停止，当前档案的会话历史将被清空。' : 'The proxy will stop and this profile’s session history will be cleared.') : '',
      action === 'delete-profile' ? (chinese ? '该档案保存的凭据和会话历史也将被删除。' : 'This profile’s saved credentials and session history will also be deleted.') : '',
      action === 'recover-settings' ? (chinese
        ? '损坏的设置源文件将被默认设置覆盖。已创建的私有损坏备份将保留。'
        : 'The corrupt settings source will be replaced with defaults. Any existing private corrupt backup is retained.') : '',
    ].filter(Boolean).join('\n');
    mainWindow.show();
    mainWindow.focus();
    try {
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning', buttons: [labels[action] || (chinese ? '继续' : 'Continue'), chinese ? '取消' : 'Cancel'],
        defaultId: 1, cancelId: 1, noLink: true,
        title: chinese ? '确认中断' : 'Confirm Interruption',
        message: chinese ? '是否继续？' : 'Continue with this action?', detail,
      });
      return result.response === 0;
    } catch (error) {
      addLog('error', 'app', `Interruption confirmation failed: ${error.message}`);
      return false;
    }
  };
  const setupIPC = (proxy) => {
    const handle = (channel, fn) => {
      ipcMain.handle(channel, createTrustedHandler(assertTrustedIpc, fn,
        (message) => addLog('error', 'ipc', message)));
      handlers.push(channel);
    };
    handle('runtime:get-info', () => ({ isElectron: true, platform: process.platform,
      electronVersion: process.versions.electron, nodeVersion: process.versions.node, devMode: isDev,
      logPath: path.join(logsPath, 'main.log'), scope: currentScope(), draftRevision: controller.getDraftRevision() }));
    handle('status:get', () => controller.getSnapshot());
    handle('settings:get', (scope) => { assertScope(scope); return currentSettings(); });
    handle('settings:save', (payload) => controller.run('save-settings', payload));
    handle('settings:save-app', (patch) => controller.run('save-app-settings', { scope: currentScope(), patch }));
    handle('onboarding:save', (payload) => controller.run('save-onboarding', payload));
    const updateVersion = (payload) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
          || Object.keys(payload).some((key) => key !== 'version') || typeof payload.version !== 'string') {
        throw new ServiceError('INVALID_ARGUMENT');
      }
      return { version: payload.version };
    };
    handle('updates:get-state', () => updates.getState());
    handle('updates:check', () => updates.check());
    handle('updates:download', (payload) => updates.download(updateVersion(payload)));
    handle('updates:install', (payload) => {
      const request = updateVersion(payload);
      if (updateInstallation) {
        if (updateInstallation.version !== request.version) throw new ServiceError('OPERATION_IN_PROGRESS');
        return updateInstallation.promise;
      }
      const record = { version: request.version, promise: null };
      record.promise = controller.run('install-update', { scope: currentScope(), ...request }).finally(() => {
        if (updateInstallation === record) updateInstallation = null;
      });
      updateInstallation = record;
      return record.promise;
    });
    handle('updates:open-release', () => updates.openRelease());
    handle('settings:retry-load', (scope) => controller.run('retry-load', { scope }));
    handle('profiles:get', () => controller.getProfiles());
    handle('profiles:create', (payload) => controller.run('create-profile', payload));
    handle('profiles:rename', (payload) => controller.run('rename-profile', payload));
    handle('profiles:delete', (payload) => controller.run('delete-profile', payload));
    handle('profiles:activate', (payload) => controller.run('activate-profile', payload));
    handle('sso:get-credentials', (scope) => controller.getCredentials(scope));
    handle('sso:save-credentials', (payload) => controller.run('save-credentials', payload));
    handle('sso:clear-credentials', (scope) => controller.run('clear-credentials', { scope }));
    handle('login:start', (scope) => controller.run('login', { scope }));
    handle('proxy:start', (scope) => controller.run('start', { scope }));
    handle('proxy:stop', (scope) => controller.run('stop', { scope }));
    handle('proxy:restart', (scope) => controller.run('restart', { scope }));
    handle('sessions:get', () => {
      const stats = proxy.getStats();
      return { profileId: stats.profileId, epoch: stats.epoch, sequence: stats.sequence, sessions: stats.sessions };
    });
    handle('sessions:disconnect', (payload) => controller.run('disconnect', payload));
    handle('stats:get', () => proxy.getStats());
    handle('history:get', (payload) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
          || Object.keys(payload).some((key) => !['scope', 'days'].includes(key))
          || ![7, 30].includes(payload.days)) throw new ServiceError('INVALID_ARGUMENT');
      assertScope(payload.scope);
      if (history.get({ profileId: payload.scope.profileId, days: payload.days }).errorCode) history.retry();
      return { ...currentScope(), revision: ++historyRevision,
        ...history.get({ profileId: payload.scope.profileId, days: payload.days }) };
    });
    handle('history:clear', (scope) => controller.run('clear-history', { scope }));
    handle('logs:get', () => [...logs]);
    handle('logs:clear', () => { logs.length = 0; return { clearedThroughId: logId }; });
    handle('ssh-key:get-info', (scope) => { assertScope(scope); return sshKeys.inspect(); });
    handle('ssh-key:backup', (scope) => controller.run('export-key-backup', { scope }));
    handle('ssh-key:restore', (scope) => controller.run('import-key-backup', { scope }));
    handle('ssh-key:rotate', (payload) => controller.run('rotate-keys', payload));
    handle('ssh-key:rebuild', (payload) => controller.run('rebuild-keys', payload));
    handle('ssh-config:preview', (scope) => controller.run('preview-config', { scope }));
    handle('ssh-config:generate', (payload) => controller.run('generate-config', payload));
    handle('diagnostics:start', startDiagnostic);
    handle('diagnostics:get', currentDiagnostic);
    handle('diagnostics:cancel', (payload) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
          || Object.keys(payload).some((key) => !['scope', 'runId'].includes(key))
          || typeof payload.runId !== 'string' || payload.runId.length > 128) throw new ServiceError('INVALID_ARGUMENT');
      assertScope(payload.scope);
      if (activeDiagnostic?.runId === payload.runId) activeDiagnostic.abort.abort();
      else if (currentDiagnostic(payload.scope)?.runId !== payload.runId) throw new ServiceError('INVALID_ARGUMENT');
      return { cancelled: true };
    });
    handle('exports:logs', (payload) => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
          || Object.keys(payload).some((key) => !['scope', 'filters'].includes(key))) throw new ServiceError('INVALID_ARGUMENT');
      return diagnosticExports.exportLogs(payload);
    });
    handle('exports:diagnostics', (scope) => diagnosticExports.exportDiagnostics(scope));
    handle('autostart:get', () => autostart.getStatus());
    handle('autostart:set', (enabled) => controller.run('set-autostart', { scope: currentScope(), enabled }));
    handle('recovery:retry', async (scope) => {
      assertScope(scope);
      const result = await recovery.retry(scope);
      if (result.errorCode) throw new ServiceError(result.errorCode);
      return result;
    });
    handle('theme:get', () => currentSettings().theme);
    handle('theme:set', (theme) => controller.run('theme', { scope: currentScope(), value: theme }));
    handle('locale:set', (locale) => controller.run('locale', { scope: currentScope(), value: locale }));
    handle('clipboard:write', (text) => {
      if (typeof text !== 'string' || text.length > 1024 * 1024) throw new ServiceError('INVALID_ARGUMENT');
      clipboard.writeText(text);
      return null;
    });
    handle('external:open', async (url) => {
      if (typeof url !== 'string' || url.length > 2048) throw new ServiceError('INVALID_ARGUMENT');
      const parsed = parseHttpsUrl(url);
      if (!parsed) throw new ServiceError('INVALID_ARGUMENT');
      await shell.openExternal(parsed.href);
      return null;
    });
    handle('app:set-dirty', (payload) => controller.run('set-dirty', payload));
    handle('app:exit', (payload) => controller.run('exit', payload));
  };

  const hasLock = app.requestSingleInstanceLock();
  if (!hasLock) {
    app.quit();
    return { ready: Promise.resolve(null) };
  }
  const ready = app.whenReady().then(() => {
    if (coordinator.isStarted()) return null;
    settingsStore = deps.settingsStore || new SettingsStore({ filePath: settingsPath,
      onWarning: (message) => startupWarnings.push(message), inspectExistingIdentity,
      migrateLegacySecrets: (raw) => CredentialStore.migrateLegacySecrets({ safeStorage, userDataPath,
        onWarning: (message) => startupWarnings.push(message) }, raw) });
    try { settingsStore.load(); }
    catch (error) { startupWarnings.push(`Settings unavailable: ${error.code || 'SETTINGS_LOCKED'}`); }
    history = deps.history || createSessionHistoryStore({ filePath: path.join(userDataPath, 'session-history.json'),
      clock: deps.historyClock || { now: Date.now, setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock) },
      onWarning: (message) => startupWarnings.push(message),
      onState: () => { historyRevision += 1; } });
    const credentialStores = new Map();
    const createCredentialStore = (profileId) => {
      if (!credentialStores.has(profileId)) {
        const supplied = deps.createCredentialStore?.(profileId);
        const value = supplied || new CredentialStore({ safeStorage, profileId, userDataPath,
          readSecrets: () => settingsStore.getRoot().profiles.find((item) => item.id === profileId)?.secrets,
          commitSecrets: (patch) => {
            if (settingsStore.isLocked()) throw new ServiceError('SETTINGS_LOCKED');
            const root = settingsStore.getRoot();
            if (!root.profiles.some((item) => item.id === profileId)) throw new ServiceError('PROFILE_CHANGED');
            return settingsStore.save({ ...root, profiles: root.profiles.map((item) => item.id === profileId
              ? { ...item, secrets: { ...item.secrets, ...patch } } : item) });
          }, onWarning: (message) => startupWarnings.push(message) });
        credentialStores.set(profileId, value);
      }
      return credentialStores.get(profileId);
    };
    const migratedCookie = settingsStore.takeMigratedCookie();
    if (migratedCookie) createCredentialStore(settingsStore.getRoot().activeProfileId).restoreEphemeralCookie(migratedCookie);
    sshKeys = deps.sshKeyService || createSshKeyService({ sshDirectory, hostKeyPath,
      readRoot: () => settingsStore.getRoot(), commitRoot: (candidate) => settingsStore.save(candidate),
      reloadRoot: () => { settingsStore.retryLoad(); return settingsStore.getRoot(); },
      isLocked: () => settingsStore.isLocked(),
      seal: (value) => createCredentialStore(settingsStore.getRoot().activeProfileId).seal(value),
      unseal: (value) => createCredentialStore(settingsStore.getRoot().activeProfileId).unseal(value),
      isEncryptionAvailable: () => createCredentialStore(settingsStore.getRoot().activeProfileId).isEncryptionAvailable(),
      dialog, getWindow: () => mainWindow, io: deps.keyFileSystem,
    });
    const keyErrorCode = initializeKeys();
    createWindow();
    const proxy = createProxyController({ clock, publish, log: addLog, history,
      createServer: deps.createProxyServer || ((options) => new ProxyServer({ ...deps.transport, ...options })),
      getKeyMaterial: () => sshKeys.getKeyMaterial(),
      isTransactionCommitted: (id) => !settingsStore.isLocked()
        && settingsStore.getRoot().keyTransaction?.id === id
        && settingsStore.getRoot().keyTransaction.phase === 'committed',
      onState: (patch) => callbacks?.onProxyState(patch),
      onAuthRequired: (source) => callbacks?.onAuthRequired(source),
      onSession: (kind, data) => tray?.notify(kind, data),
      onNetworkError: (source) => recovery?.networkError(source),
    });
    const login = createLoginController({ clock, log: addLog,
      getSession: (partition) => session.fromPartition(partition),
      createWindow: (options) => new BrowserWindow(options), getWindow: () => mainWindow,
      getConfig: currentSettings,
      onState: (patch) => callbacks?.onLoginState(patch),
      onAuthenticated: (auth) => callbacks?.onAuthenticated(auth),
      onAuthRequired: (source) => callbacks?.onAuthRequired(source),
    });
    autostart = deps.autostartService || createAutostartService({ app, appId: 'com.ustc.usshtc107' });
    controller = createAppController({ settingsStore, proxy, login, createCredentialStore, keyErrorCode,
      keys: sshKeys,
      onConfigSaved: invalidateDiagnostics,
      installUpdate: (payload, context) => updates.install(payload, context),
      onUpdatePreparing: () => {
        recovery?.cancel('update');
        if (autoConnectTimer !== null) clock.clearTimeout(autoConnectTimer);
        autoConnectTimer = null;
      },
      onUpdateHandoff: () => {
        if (diagnostics) invalidateDiagnostics(currentScope());
        diagnostics?.dispose();
        recovery?.dispose();
        tray?.dispose();
        tray = null;
      },
      getDiagnostics: currentDiagnostic,
      inspectSshConfig: (scope, config) => {
        assertScope(scope);
        return new SshConfigService({ sshDirectory,
          privateKeyPath: path.join(sshDirectory, 'usshtc107_ed25519') }).inspect({
          profileId: scope.profileId, alias: config.sshAlias, host: config.host, port: config.port,
        });
      },
      getAutostartStatus: () => autostart.getStatus(),
      setAutostartEnabled: (enabled) => autostart.setEnabled(enabled),
      cancelRecovery: (reason) => recovery?.cancel(reason),
      forgetCredentialStore: (id) => credentialStores.delete(id), initializeKeys,
      assertKeys: () => {
        const errorCode = initializeKeys();
        if (errorCode) throw new ServiceError(errorCode);
      },
      publish, log: addLog, confirmInterrupt,
      bindCallbacks: (value) => { callbacks = value; },
      onSnapshot: (value) => tray?.update(value),
      flush: async () => {
        const result = history.flush();
        if (result.errorCode) throw new ServiceError(result.errorCode);
        await deps.flush?.();
      },
      clearHistory: (profileId) => {
        const result = history.clear(profileId);
        if (result.errorCode) throw new ServiceError(result.errorCode);
      },
      previewSshConfig: (scope) => {
        const service = new SshConfigService({ sshDirectory,
          privateKeyPath: path.join(sshDirectory, 'usshtc107_ed25519') });
        const saved = currentSettings();
        const result = service.preview({ profileId: scope.profileId,
          host: saved.host, port: saved.port, alias: saved.sshAlias });
        return { block: result.block, changed: result.changed, sourceHash: result.sourceHash,
          configHash: result.configHash, backupPath: service.backupPath };
      },
      generateSshConfig: (payload, scope) => {
        const service = new SshConfigService({ sshDirectory,
          privateKeyPath: path.join(sshDirectory, 'usshtc107_ed25519') });
        const saved = currentSettings();
        const result = service.write({ profileId: scope.profileId,
          host: saved.host, port: saved.port, alias: saved.sshAlias },
        { expectedSourceHash: payload.sourceHash, expectedConfigHash: payload.configHash });
        addLog('info', 'ssh-config', 'SSH config generated');
        return { block: result.block, changed: result.changed, sourceHash: result.sourceHash,
          configHash: result.configHash, path: result.path, backupPath: result.backupPath };
      },
      onExitPrepared: () => { queueMicrotask(() => { void coordinator.request(0); }); },
    });
    diagnostics = deps.diagnosticsService || createDiagnosticsService({
      getConfig: (scope) => {
        assertScope(scope);
        const saved = currentSettings();
        return { ...saved, wssUrl: buildWssUrl(saved) };
      },
      getRuntime: (scope) => { assertScope(scope); return controller.getSnapshot(); },
      getAuthGeneration: () => controller.getAuthGeneration(),
      getKeys: (scope) => { assertScope(scope); return inspectKeys(); },
      getClientIdentity: (scope) => { assertScope(scope); return getSsh2ClientIdentity({ sshDirectory }); },
      inspectSshConfig: (scope, config) => new SshConfigService({ sshDirectory,
        privateKeyPath: path.join(sshDirectory, 'usshtc107_ed25519') }).inspect({ profileId: scope.profileId,
        alias: config.sshAlias, host: config.host, port: config.port }),
      getCookie: (scope) => {
        const current = controller.getSnapshot();
        return current.profileId === scope.profileId && current.epoch === scope.epoch && current.cookieValid
          ? login.getCookie() : '';
      },
      onState: (value) => {
        const record = activeDiagnostic;
        if (!record || record.invalidated || record.profileId !== value.profileId || record.epoch !== value.epoch
            || record.configFingerprint !== value.configFingerprint
            || (record.runId !== null && record.runId !== value.runId)) return;
        record.runId = value.runId;
        validDiagnosticRunId = value.runId;
        publish('diagnostics:state', value);
      },
      onAuthRequired: (scope) => callbacks?.onAuthRequired(scope),
      adapters: deps.diagnosticsAdapters,
    });
    diagnosticOwner = { ...currentScope(), configFingerprint: fingerprintConfig(currentSettings()) };
    diagnosticExports = deps.diagnosticExportService || createDiagnosticExportService({
      dialog, getWindow: () => mainWindow,
      getRuntime: () => ({ appVersion: app.getVersion(), electronVersion: process.versions.electron,
        nodeVersion: process.versions.node, osVersion: `${os.platform()} ${os.release()}`, arch: process.arch }),
      getSettings: (scope) => { assertScope(scope); const saved = currentSettings(); return { ...saved, wssUrl: buildWssUrl(saved) }; },
      getDiagnostics: currentDiagnostic, getLogs: () => [...logs], homePath: os.homedir(), userDataPath,
      assertCurrent: (scope) => {
        assertScope(scope);
        if (fatalRequested || allowAppQuit || !mainWindow || mainWindow.isDestroyed()) throw new ServiceError('SHUTTING_DOWN');
      },
    });
    recovery = deps.recoveryController || createRecoveryController({
      clock, net: deps.recoveryNet || net,
      getSnapshot: () => controller.getSnapshot(), getPreferences: currentSettings,
      getConfig: (scope) => { assertScope(scope); const saved = currentSettings(); return { ...saved, wssUrl: buildWssUrl(saved) }; },
      getCookie: (scope) => {
        const value = controller.getSnapshot();
        return value.profileId === scope.profileId && value.epoch === scope.epoch && value.cookieValid ? login.getCookie() : '';
      },
      requestStart: (scope, options) => callbacks.requestRecoveryStart(scope, options),
      onRemoteState: (source) => callbacks?.onRemoteState(source),
      onAuthRequired: ({ cookie, ...source }) => {
        const value = controller.getSnapshot();
        if ((source.statusCode === 401 || source.statusCode === 403) && value.profileId === source.profileId
            && value.epoch === source.epoch && value.cookieValid && cookie === login.getCookie()) callbacks?.onAuthRequired(source);
      },
      onRecovered: (scope) => {
        const value = controller.getSnapshot();
        if (value.profileId === scope.profileId && value.epoch === scope.epoch) tray?.notify('recovery', {});
      },
      adapters: deps.recoveryAdapters,
    });
    recoveryOwnerScope = currentScope();
    queueRecoveryUpdate();
    powerMonitor?.on('suspend', suspendRecovery);
    powerMonitor?.on('resume', resumeRecovery);
    tray = createTrayService({ Tray, Menu, nativeImage, Notification, getWindow: () => mainWindow,
      getPreferences: currentSettings, log: addLog,
      run: (action) => controller.run(action, { scope: currentScope() }),
    });
    tray.update(controller.getSnapshot());
    updates = createUpdateService({ app, nativeUpdater: electron.autoUpdater, shell, clock, log: addLog,
      adapters: deps.updateAdapters,
      onState: (value) => publish('updates:state', value),
      onAvailable: () => tray?.notify('update'),
      beforeAppImageInstall: (candidate, oldPath) => {
        const newPath = /\d+\.\d+\.\d+/.test(path.basename(oldPath))
          ? path.join(path.dirname(oldPath), candidate.assetName) : oldPath;
        autostartImagePlan = autostart.prepareAppImageUpdate(oldPath, newPath);
      },
      onAppImageRenamed: ({ candidate, oldPath, newPath }) => {
        if (!autostartImagePlan || autostartImagePlan.oldPath !== oldPath || autostartImagePlan.newPath !== newPath
            || newPath !== path.join(path.dirname(oldPath), candidate.assetName)) throw new ServiceError('AUTOSTART_UPDATE_FAILED');
        autostart.applyAppImageUpdate(autostartImagePlan);
      },
    });
    updatePreference = !settingsStore.isLocked() && currentSettings().autoCheckUpdates;
    updates.setAutoCheck(updatePreference);
    setupIPC(proxy);
    void Promise.resolve(autostart.getStatus()).then((status) => {
      if (status.supported && status.errorCode) addLog('warn', 'autostart', status.errorCode);
    }).catch(() => addLog('warn', 'autostart', 'AUTOSTART_FAILED'));
    addLog('info', 'app', 'Application started');
    for (const warning of startupWarnings.splice(0)) addLog('warn', 'startup', warning);
    autoConnectTimer = clock.setTimeout(() => {
      autoConnectTimer = null;
      const value = controller.getSnapshot();
      if (!coordinator.isStarted() && !settingsStore.isLocked() && !keyErrorCode && value.desiredRunning && value.cookieValid) {
        controller.run('start', { scope: currentScope() }).catch((error) => {
          addLog('warn', 'app', `Auto-connect failed: ${error.code || error.message}`);
        });
      }
    }, 1000);
    return controller;
  }).catch((error) => { void fatal('Startup failed', error); throw error; });
  // The default entrypoint reports startup failures through the coordinated fatal exit.
  ready.catch(() => {});
  const showWindow = () => {
    if (coordinator.isStarted()) return;
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (settingsStore) createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };
  const beforeQuit = (event) => {
    if (fatalRequested) {
      updates?.dispose();
      updates?.consumeQuitMarker();
      event.preventDefault();
      return;
    }
    const updateMarker = updates?.consumeQuitMarker();
    if (updateMarker) {
      if (updateMarker.valid) allowAppQuit = true;
      else event.preventDefault();
      return;
    }
    if (allowAppQuit) return;
    event.preventDefault();
    if (controller) {
      controller.run('exit', { scope: currentScope() }).catch((error) => {
        addLog('error', 'app', `Exit preparation failed: ${error.code || error.message}`);
      });
    } else void coordinator.request(0);
  };
  const noOp = () => {};
  const unhandled = (error) => { void fatal('Unhandled rejection', error); };
  const uncaught = (error) => { void fatal('Uncaught exception', error); };
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', noOp);
  app.on('before-quit', beforeQuit);
  processEvents.on('unhandledRejection', unhandled);
  processEvents.on('uncaughtException', uncaught);
  return {
    ready,
    getController: () => controller,
    getWindow: () => mainWindow,
    dispose: async () => {
      if (autoConnectTimer !== null) clock.clearTimeout(autoConnectTimer);
      updates?.dispose();
      for (const channel of handlers) ipcMain.removeHandler(channel);
      app.removeListener('second-instance', showWindow);
      app.removeListener('activate', showWindow);
      app.removeListener('window-all-closed', noOp);
      app.removeListener('before-quit', beforeQuit);
      processEvents.removeListener('unhandledRejection', unhandled);
      processEvents.removeListener('uncaughtException', uncaught);
      tray?.dispose();
      activeDiagnostic?.abort.abort();
      diagnostics?.dispose();
      recovery?.dispose();
      powerMonitor?.removeListener('suspend', suspendRecovery);
      powerMonitor?.removeListener('resume', resumeRecovery);
      await controller?.dispose();
      history?.dispose();
    },
  };
}

module.exports = { startApplication };

// Electron's default-app loader may import the CJS entry without assigning require.main.
// Compare the configured application root so importing from a source fixture stays inert.
if (process.versions.electron && process.type === 'browser'
    && path.resolve(require('electron').app.getAppPath(), 'electron/main.js') === __filename) {
  startApplication();
}
