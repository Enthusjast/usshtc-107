'use strict';

const { randomUUID } = require('crypto');
const { buildWssUrl } = require('./wss-connection');
const { fingerprintConfig } = require('./diagnostics-service');
const semver = require('semver');
const { validateSettingsPatch, PROFILE_DEFAULTS, PROFILE_SETTING_KEYS, APP_SETTING_KEYS } = require('../shared/settings-schema.mjs');
const { publicSettings, validateProfileName } = require('./settings-store');
const { ServiceError } = require('./ipc-contract');

const CONFIG_KEYS = ['host', 'port', 'cluster', 'loginNode', 'cols', 'rows', 'useRoot'];
const keyActionError = (error, fallback) => error instanceof ServiceError ? error : new ServiceError(
  ['SSH_KEY_MISSING', 'SSH_KEY_INVALID', 'SSH_KEY_PERMISSIONS', 'SSH_KEY_FINGERPRINT_MISMATCH',
    'KEY_BACKUP_INVALID', 'KEY_TRANSACTION_FAILED', 'KEY_ROLLBACK_FAILED', 'SECURE_STORAGE_UNAVAILABLE',
    'OPERATION_CANCELLED', 'PROFILE_CHANGED', 'DRAFT_CHANGED', 'AUTH_REQUIRED', 'SETTINGS_LOCKED',
    'SETTINGS_SAVE_FAILED', 'SETTINGS_DURABILITY_UNCERTAIN', 'SETTINGS_COMMIT_UNKNOWN'].includes(error.code) ? error.code : fallback);
const OPERATIONS = {
  start: 'starting', stop: 'stopping', restart: 'starting', login: 'logging_in',
  'save-settings': null, 'save-credentials': null, 'clear-credentials': null,
  disconnect: null, 'preview-config': null, 'generate-config': null, theme: null, locale: null,
  'save-app-settings': null, 'save-onboarding': null, 'retry-load': null,
  'set-autostart': null,
  'create-profile': null, 'rename-profile': null, 'delete-profile': 'switching_profile',
  'activate-profile': 'switching_profile', exit: 'stopping',
  'clear-history': 'stopping',
  'export-key-backup': 'changing_keys', 'import-key-backup': 'changing_keys',
  'install-update': 'preparing_update',
  'rotate-keys': 'changing_keys', 'rebuild-keys': 'changing_keys',
};
const sameScope = (a, b) => a?.profileId === b?.profileId && a?.epoch === b?.epoch;
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};

function createAppController(deps) {
  const store = deps.settingsStore;
  const root = () => store.getRoot();
  const settings = () => publicSettings(root());
  const profile = (id = scope.profileId) => root().profiles.find((item) => item.id === id);
  const proxy = deps.proxy;
  const login = deps.login;
  let credentials = deps.createCredentialStore(root().activeProfileId);
  const log = deps.log || (() => {});
  let scope = { profileId: root().activeProfileId, epoch: 0 };
  let revision = 0;
  let authGeneration = 0;
  let active = null;
  let pendingStop = null;
  let draft = { dirty: false, draftRevision: 0 };
  let disposed = false;
  let shuttingDown = false;
  let preparingExit = null;
  let preparingReason = null;
  let exitPrepared = false;
  let pendingAuthentication = null;
  let storageStopRequested = false;
  const config = () => {
    const saved = settings();
    const value = Object.fromEntries(CONFIG_KEYS.map((key) => [key, saved[key]]));
    value.wssUrl = buildWssUrl(value);
    return value;
  };
  const state = {
    loginStatus: 'idle', loginStage: null, cookieValid: false, cookieCount: 0,
    proxyStatus: 'stopped', runningConfig: null, connectionCount: 0,
    desiredRunning: !store.isLocked() && Boolean(settings().autoConnect), remoteStatus: 'unknown',
    operation: null, errorCode: deps.keyErrorCode || null, storageErrorCode: store.getStorageErrorCode(),
  };
  const snapshot = () => {
    const desiredConfig = config();
    return { ...scope, revision, ...state, desiredConfig,
      runningConfig: state.runningConfig ? { ...state.runningConfig } : null,
      needsRestart: Boolean(state.runningConfig && CONFIG_KEYS.some(
        (key) => state.runningConfig[key] !== desiredConfig[key])),
    };
  };
  const publish = () => {
    revision += 1;
    const value = snapshot();
    deps.publish?.('runtime-state', value);
    deps.onSnapshot?.(value);
  };
  const assertScope = (candidate) => {
    if (!candidate || typeof candidate.profileId !== 'string' || !Number.isSafeInteger(candidate.epoch)
        || !sameScope(candidate, scope)) throw new ServiceError('PROFILE_CHANGED');
  };
  const assertToken = (token, requireAuth = false) => {
    if (disposed || token.signal.aborted || (active?.token !== token && pendingStop?.token !== token)) {
      throw new ServiceError('OPERATION_CANCELLED');
    }
    if (!sameScope(token.executionScope, scope)) throw new ServiceError('PROFILE_CHANGED');
    if (token.confirmedDraft && draft.draftRevision !== token.draftRevision) {
      throw new ServiceError('DRAFT_CHANGED');
    }
    if (requireAuth && (token.authGeneration !== authGeneration || !state.cookieValid
        || state.loginStatus !== 'success' || !login.getCookie())) throw new ServiceError('AUTH_REQUIRED');
  };
  const waitFor = async (token, promise, requireAuth = false) => {
    assertToken(token, requireAuth);
    let cancelled;
    const abort = new Promise((_resolve, reject) => {
      cancelled = () => reject(new ServiceError('OPERATION_CANCELLED'));
      token.signal.addEventListener('abort', cancelled, { once: true });
    });
    try {
      const value = await Promise.race([promise, abort]);
      assertToken(token, requireAuth);
      return value;
    } finally { token.signal.removeEventListener('abort', cancelled); }
  };
  const advanceEpoch = (token, _reason, nextProfileId = scope.profileId) => {
    assertToken(token);
    if (active?.token !== token) throw new ServiceError('OPERATION_CANCELLED');
    scope = { profileId: nextProfileId, epoch: scope.epoch + 1 };
    token.executionScope = Object.freeze({ ...scope });
    proxy.setScope(scope);
    login.setScope(scope);
    publish();
  };
  const assertWritable = () => {
    if (store.isLocked()) throw new ServiceError('SETTINGS_LOCKED');
  };
  const lockStorage = async (token) => {
    if (storageStopRequested) return;
    storageStopRequested = true;
    state.storageErrorCode = store.getStorageErrorCode() || 'SETTINGS_COMMIT_UNKNOWN';
    state.desiredRunning = false;
    pendingAuthentication = null;
    login.deactivate();
    publish();
    await stopStage(token, 'storage_error');
    assertToken(token);
  };
  const persist = async (token, candidate) => {
    assertToken(token);
    assertWritable();
    const pending = store.save(candidate);
    const result = pending?.then ? await waitFor(token, pending) : pending;
    assertToken(token);
    if (result.state === 'committed' && root().activeProfileId !== scope.profileId) {
      scope = { profileId: root().activeProfileId, epoch: scope.epoch };
      token.executionScope = Object.freeze({ ...scope });
      proxy.setScope(scope);
      login.setScope(scope);
    }
    if (result.state === 'unknown' || (result.state === 'committed' && !result.durable)) {
      await lockStorage(token);
      assertToken(token);
      throw new ServiceError(result.errorCode || state.storageErrorCode);
    }
    if (result.state !== 'committed') throw new ServiceError(result.errorCode || 'SETTINGS_WRITE_FAILED');
    state.storageErrorCode = null;
  };
  const profilesDto = () => ({ activeProfileId: root().activeProfileId,
    profiles: root().profiles.map(({ id, name, settings: value, onboarding }) => ({
      id, name, settings: { ...value }, onboarding: { ...onboarding },
    })) });
  const assertAlias = (alias, exceptId) => {
    if (root().profiles.some((item) => item.id !== exceptId
        && item.settings.sshAlias.toLowerCase() === alias.toLowerCase())) {
      throw new ServiceError('PROFILE_ALIAS_CONFLICT');
    }
  };
  const parsePatch = (patch, current, allowed) => {
    const parsed = validateSettingsPatch(patch, current);
    if (!parsed.ok) throw new ServiceError('VALIDATION_FAILED', parsed.fieldErrors);
    const errors = {};
    for (const key of Object.keys(patch)) if (!allowed.includes(key)) errors[key] = 'unknown_key';
    if (Object.keys(errors).length) throw new ServiceError('VALIDATION_FAILED', errors);
    return Object.fromEntries(Object.keys(patch).sort().map((key) => [key, parsed.value[key]]));
  };
  const confirm = async (token, action, connectionCount = state.connectionCount, always = false, metadata = {}) => {
    assertToken(token);
    const capturedRevision = draft.draftRevision;
    token.draftRevision = capturedRevision;
    if (draft.dirty || connectionCount > 0 || always) {
      const accepted = await waitFor(token, deps.confirmInterrupt({ action, connectionCount,
        dirty: draft.dirty, draftRevision: capturedRevision, ...metadata }));
      assertToken(token);
      if (draft.draftRevision !== capturedRevision) throw new ServiceError('DRAFT_CHANGED');
      if (!accepted) return false;
    }
    assertToken(token);
    if (draft.draftRevision !== capturedRevision) throw new ServiceError('DRAFT_CHANGED');
    token.confirmedDraft = true;
    return true;
  };
  const consume = (token, result = {}) => {
    assertToken(token);
    if (draft.draftRevision !== token.draftRevision) throw new ServiceError('DRAFT_CHANGED');
    draft = { dirty: false, draftRevision: draft.draftRevision };
    return { ...result, consumedDraftRevision: token.draftRevision };
  };
  const stopStage = async (token, reason) => {
    assertToken(token);
    await waitFor(token, proxy.stop(reason));
    assertToken(token);
    state.proxyStatus = 'stopped';
    state.runningConfig = null;
    state.connectionCount = 0;
    publish();
  };
  const startStage = async (token) => {
    assertToken(token, true);
    assertWritable();
    deps.assertKeys?.();
    if (state.proxyStatus === 'started') {
      const result = await waitFor(token, proxy.start(config(), login.getCookie(), token.executionScope), true);
      assertToken(token, true);
      return result;
    }
    advanceEpoch(token, 'proxy_start');
    assertToken(token, true);
    const result = await waitFor(token, proxy.start(config(), login.getCookie(), token.executionScope), true);
    assertToken(token, true);
    return result;
  };
  const prepareStage = async (token, reason) => {
    assertToken(token);
    state.desiredRunning = false;
    advanceEpoch(token, reason);
    await stopStage(token, reason);
    assertToken(token);
    await waitFor(token, deps.flush?.());
    assertToken(token);
  };
  const bindProfile = (token) => {
    assertToken(token);
    credentials = deps.createCredentialStore(scope.profileId);
    state.remoteStatus = 'unknown';
    state.errorCode = null;
    state.desiredRunning = !store.isLocked() && Boolean(settings().autoConnect);
    login.setProfile(scope, credentials);
    publish();
  };
  const activateStage = async (token, id, autoStart = true) => {
    assertToken(token);
    if (!profile(id)) throw new ServiceError('PROFILE_NOT_FOUND');
    state.desiredRunning = false;
    pendingAuthentication = null;
    advanceEpoch(token, 'profile_switch');
    login.deactivate();
    await stopStage(token, 'profile_switch');
    assertToken(token);
    await waitFor(token, login.resetForProfile({ assertCurrent: () => assertToken(token) }));
    assertToken(token);
    await persist(token, { ...root(), activeProfileId: id });
    assertToken(token);
    bindProfile(token);
    token.authGeneration = authGeneration;
    if (autoStart && state.desiredRunning && state.cookieValid) {
      await startStage(token);
      assertToken(token);
    }
  };
  const normalize = (action, payload) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ServiceError('INVALID_ARGUMENT');
    if (!payload.scope || typeof payload.scope.profileId !== 'string'
        || !Number.isSafeInteger(payload.scope.epoch)) throw new ServiceError('PROFILE_CHANGED');
    if (!sameScope(payload.scope, scope) && !sameScope(payload.scope, active?.token.originScope)
        && !sameScope(payload.scope, pendingStop?.token.originScope)) assertScope(payload.scope);
    const fields = {
      'save-settings': ['patch'], 'save-app-settings': ['patch'], 'save-credentials': ['username', 'password'],
      'save-onboarding': ['status', 'step', 'runId'],
      'create-profile': ['name', 'settings'], 'rename-profile': ['id', 'name'],
      'activate-profile': ['id'], 'delete-profile': ['id'],
      disconnect: ['sessionId'], theme: ['value'], locale: ['value'],
      'generate-config': ['sourceHash', 'configHash'],
      'install-update': ['version'],
      'set-autostart': ['enabled'],
      'rotate-keys': ['target'], 'rebuild-keys': ['target'],
    };
    if (Object.keys(payload).some((key) => !['scope', 'draftRevision', ...(fields[action] || [])].includes(key))) {
      throw new ServiceError('INVALID_ARGUMENT');
    }
    const value = { scope: { profileId: payload.scope.profileId, epoch: payload.scope.epoch } };
    switch (action) {
      case 'install-update':
        if (typeof payload.version !== 'string' || semver.valid(payload.version) !== payload.version
            || semver.prerelease(payload.version) !== null) throw new ServiceError('UPDATE_VERSION_REJECTED');
        value.version = payload.version;
        break;
      case 'save-onboarding':
        if (Array.isArray(payload.scope) || Object.keys(payload.scope).some((key) => !['profileId', 'epoch'].includes(key))
            || Object.hasOwn(payload, 'draftRevision')
            || !['new', 'dismissed', 'completed'].includes(payload.status)
            || !['login', 'config', 'connect', 'verify'].includes(payload.step)
            || (payload.runId !== undefined && (typeof payload.runId !== 'string' || !payload.runId
              || payload.runId.length > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(payload.runId)))) {
          throw new ServiceError('INVALID_ARGUMENT');
        }
        value.status = payload.status;
        value.step = payload.step;
        if (payload.runId !== undefined) value.runId = payload.runId;
        break;
      case 'rotate-keys': case 'rebuild-keys':
        if (payload.target !== undefined && !['client', 'host', 'both'].includes(payload.target)) {
          throw new ServiceError('INVALID_ARGUMENT');
        }
        value.target = payload.target || 'client';
        break;
      case 'save-settings': {
        value.patch = parsePatch(payload.patch, profile().settings, PROFILE_SETTING_KEYS);
        break;
      }
      case 'save-app-settings':
        value.patch = parsePatch(payload.patch, root().app, APP_SETTING_KEYS.filter((key) => key !== 'launchAtLogin'));
        break;
      case 'set-autostart':
        if (typeof payload.enabled !== 'boolean') throw new ServiceError('INVALID_ARGUMENT');
        value.enabled = payload.enabled;
        break;
      case 'create-profile': case 'rename-profile':
        try { value.name = validateProfileName(payload.name); }
        catch (_) { throw new ServiceError('PROFILE_NAME_INVALID'); }
        if (action === 'create-profile') {
          value.settings = parsePatch(payload.settings === undefined ? {} : payload.settings, PROFILE_DEFAULTS, PROFILE_SETTING_KEYS);
          break;
        }
        // Rename and activate/delete share strict target validation.
      case 'activate-profile': case 'delete-profile':
        if (typeof payload.id !== 'string' || !payload.id || payload.id.length > 64) {
          throw new ServiceError('PROFILE_NOT_FOUND');
        }
        value.id = payload.id;
        break;
      case 'save-credentials':
        if (typeof payload.username !== 'string' || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(payload.username)
            || payload.username.length > 128 || Buffer.byteLength(payload.username, 'utf8') > 512
            || (payload.password !== undefined && typeof payload.password !== 'string')) {
          throw new ServiceError('INVALID_ARGUMENT');
        }
        if (payload.password !== undefined && Buffer.byteLength(payload.password, 'utf8') > 4096) {
          throw new ServiceError('CREDENTIAL_TOO_LARGE');
        }
        value.username = payload.username.trim();
        if (payload.password !== undefined) value.password = payload.password;
        break;
      case 'generate-config':
        if (typeof payload.sourceHash !== 'string' || typeof payload.configHash !== 'string'
            || !/^[a-f0-9]{64}$/.test(payload.sourceHash) || !/^[a-f0-9]{64}$/.test(payload.configHash)) {
          throw new ServiceError('SSH_CONFIG_CHANGED');
        }
        value.sourceHash = payload.sourceHash;
        value.configHash = payload.configHash;
        break;
      case 'disconnect':
        if (!Number.isSafeInteger(payload.sessionId) || payload.sessionId < 1) throw new ServiceError('INVALID_ARGUMENT');
        value.sessionId = payload.sessionId;
        break;
      case 'theme': case 'locale': {
        const parsed = validateSettingsPatch({ [action]: payload.value }, root().app);
        if (!parsed.ok) throw new ServiceError('VALIDATION_FAILED', parsed.fieldErrors);
        value.value = parsed.value[action];
        break;
      }
      default: break;
    }
    if (payload.draftRevision !== undefined) {
      if (!Number.isSafeInteger(payload.draftRevision) || payload.draftRevision < 0) throw new ServiceError('INVALID_ARGUMENT');
      value.draftRevision = payload.draftRevision;
    }
    return value;
  };
  const execute = async (action, payload, token) => {
    assertToken(token);
    if (!['stop', 'disconnect', 'exit', 'retry-load'].includes(action)) assertWritable();
    if (payload.id !== undefined && !profile(payload.id)) throw new ServiceError('PROFILE_NOT_FOUND');
    if (payload.draftRevision !== undefined && payload.draftRevision !== draft.draftRevision) {
      throw new ServiceError('DRAFT_CHANGED');
    }
    switch (action) {
      case 'install-update': {
        if (!deps.installUpdate) throw new ServiceError('API_UNAVAILABLE');
        let handedOff = false;
        let consumed = null;
        const result = await waitFor(token, deps.installUpdate({ version: payload.version }, {
          signal: token.signal,
          assertCurrent: () => assertToken(token),
          prepare: async () => {
            if (!await confirm(token, 'install')) return { cancelled: true };
            assertToken(token);
            deps.onUpdatePreparing?.();
            pendingAuthentication = null;
            try {
              await prepareStage(token, 'update');
              assertToken(token);
            } catch (_) {
              assertToken(token);
              throw new ServiceError('UPDATE_PREPARATION_FAILED');
            }
            return {};
          },
          onHandoff: () => {
            if (handedOff) return;
            assertToken(token);
            consumed = consume(token);
            handedOff = true;
            shuttingDown = true;
            login.dispose();
            deps.onUpdateHandoff?.();
          },
        }));
        assertToken(token);
        return handedOff ? { ...result, ...consumed } : result;
      }
      case 'export-key-backup': {
        if (!deps.keys) throw new ServiceError('API_UNAVAILABLE');
        try {
          const result = await deps.keys.exportBackup({ signal: token.signal, assertCurrent: () => assertToken(token) });
          assertToken(token);
          return result;
        } catch (error) { throw keyActionError(error, 'KEY_BACKUP_INVALID'); }
      }
      case 'import-key-backup': case 'rotate-keys': case 'rebuild-keys': {
        if (!deps.keys) throw new ServiceError('API_UNAVAILABLE');
        const originallyRunning = state.proxyStatus === 'started';
        const originalConfig = state.runningConfig ? { ...state.runningConfig } : null;
        const assertCurrent = () => {
          assertToken(token, originallyRunning);
          if (token.authGeneration !== authGeneration) throw new ServiceError('OPERATION_CANCELLED');
        };
        const context = { signal: token.signal, assertCurrent };
        try {
          const plan = action === 'import-key-backup' ? await deps.keys.prepareImport(context)
            : action === 'rotate-keys' ? deps.keys.prepareRotate(payload.target, context)
              : deps.keys.prepareRebuild(payload.target, context);
          assertCurrent();
          if (plan.cancelled) return { cancelled: true };
          if (!await confirm(token, 'keys', state.connectionCount, true, { keyChange: deps.keys.summary(plan) })) {
            return { cancelled: true };
          }
          assertCurrent();
          const result = await deps.keys.execute(plan, {
            ...context,
            beforeInstall: async () => {
              assertCurrent();
              deps.cancelRecovery?.('changing_keys');
              advanceEpoch(token, 'changing_keys');
              await stopStage(token, 'changing_keys');
              assertCurrent();
            },
            startCandidate: async ({ transactionId, keyMaterial }) => {
              assertCurrent();
              const started = await proxy.startCandidate({ transactionId, keyMaterial,
                config: originalConfig || config(), cookie: login.getCookie(), scope: token.executionScope });
              assertCurrent();
              return started;
            },
            activateCandidate: async (id) => {
              assertCurrent();
              const activated = originallyRunning ? await proxy.activateCandidate(id)
                : await proxy.stop('key_bind_verified');
              assertCurrent();
              return activated;
            },
            // This security cleanup must run even after the transaction token is aborted.
            stopCandidate: () => proxy.stop('key_transaction_failed'),
            restoreOriginal: originallyRunning ? async () => {
              assertCurrent();
              deps.keys.assertReady();
              await proxy.start(originalConfig, login.getCookie(), token.executionScope);
              assertCurrent();
            } : undefined,
          });
          assertCurrent();
          if (result.cancelled) return result;
          state.errorCode = null;
          publish();
          return consume(token, { ...result, scope: { ...token.executionScope } });
        } catch (error) {
          throw keyActionError(error, 'KEY_TRANSACTION_FAILED');
        }
      }
      case 'save-onboarding': {
        const completed = payload.status === 'completed';
        if (completed) {
          const saved = { ...settings() };
          const fingerprint = fingerprintConfig(saved);
          const cookie = login.getCookie();
          const assertProof = () => {
            assertToken(token);
            const desired = config();
            const run = deps.getDiagnostics?.(token.executionScope);
            const passed = (id, code, mode) => run?.checks?.some((check) => check.id === id
              && check.status === 'passed' && check.code === code && (mode === undefined || check.mode === mode));
            if (payload.step !== 'verify' || !payload.runId || run?.runId !== payload.runId
                || !sameScope(run, token.executionScope)
                || typeof run?.finishedAt !== 'string' || !Number.isFinite(Date.parse(run.finishedAt))
                || run.configFingerprint !== fingerprint || fingerprintConfig(settings()) !== fingerprint
                || !passed('local-listener', 'LOCAL_SSH_OK', 'ssh-auth')
                || !passed('wss', 'WSS_HANDSHAKE_OK')
                || state.proxyStatus !== 'started' || !state.runningConfig
                || Object.keys(desired).some((key) => state.runningConfig[key] !== desired[key])
                || Object.keys(state.runningConfig).some((key) => !Object.hasOwn(desired, key))
                || token.authGeneration !== authGeneration || !state.cookieValid || state.loginStatus !== 'success'
                || !cookie || login.getCookie() !== cookie) throw new ServiceError('ONBOARDING_NOT_READY');
          };
          assertProof();
          let inspected;
          try {
            inspected = await waitFor(token, deps.inspectSshConfig?.({ ...token.executionScope }, saved), true);
          } catch (_) {
            assertToken(token);
            throw new ServiceError('ONBOARDING_NOT_READY');
          }
          assertProof();
          if (inspected?.code !== 'SSH_CONFIG_OK') throw new ServiceError('ONBOARDING_NOT_READY');
          assertToken(token, true);
        }
        await persist(token, { ...root(), profiles: root().profiles.map((item) => item.id === scope.profileId
          ? { ...item, onboarding: { status: payload.status, step: payload.step } } : item) });
        assertToken(token, completed);
        publish();
        return profilesDto();
      }
      case 'create-profile': {
        if (root().profiles.length >= 8) throw new ServiceError('PROFILE_LIMIT');
        let alias = payload.settings.sshAlias;
        if (alias === undefined) {
          let suffix = 2;
          const used = new Set(root().profiles.map((item) => item.settings.sshAlias.toLowerCase()));
          while (used.has(`usshtc107-${suffix}`)) suffix += 1;
          alias = `usshtc107-${suffix}`;
        }
        assertAlias(alias);
        const created = { id: (deps.createId || randomUUID)(), name: payload.name,
          settings: { ...PROFILE_DEFAULTS, ...payload.settings, sshAlias: alias },
          secrets: { ssoUsername: '', ssoPassword: '', savedCookieEncrypted: '' },
          onboarding: { status: 'new', step: 'login' } };
        await persist(token, { ...root(), profiles: [...root().profiles, created] });
        assertToken(token);
        publish();
        return profilesDto();
      }
      case 'rename-profile':
        await persist(token, { ...root(), profiles: root().profiles.map((item) => item.id === payload.id
          ? { ...item, name: payload.name } : item) });
        assertToken(token);
        publish();
        return profilesDto();
      case 'activate-profile':
        if (payload.id === scope.profileId) return profilesDto();
        if (!await confirm(token, 'profile')) return { cancelled: true };
        assertToken(token);
        await activateStage(token, payload.id);
        assertToken(token);
        return consume(token, profilesDto());
      case 'delete-profile': {
        if (root().profiles.length === 1) throw new ServiceError('PROFILE_LAST');
        const deletingActive = payload.id === scope.profileId;
        if (!await confirm(token, 'delete-profile', deletingActive ? state.connectionCount : 0, true)) return { cancelled: true };
        assertToken(token);
        if (deletingActive) {
          await activateStage(token, root().profiles.find((item) => item.id !== payload.id).id, false);
          assertToken(token);
        }
        await persist(token, { ...root(), profiles: root().profiles.filter((item) => item.id !== payload.id) });
        assertToken(token);
        deps.forgetCredentialStore?.(payload.id);
        await waitFor(token, deps.clearHistory(payload.id));
        assertToken(token);
        publish();
        if (deletingActive && state.desiredRunning && state.cookieValid) {
          await startStage(token);
          assertToken(token);
        }
        return consume(token, profilesDto());
      }
      case 'clear-history': {
        if (!await confirm(token, 'clear-history', state.connectionCount, true)) return { cancelled: true };
        assertToken(token);
        state.desiredRunning = false;
        pendingAuthentication = null;
        advanceEpoch(token, 'history_clear');
        await stopStage(token, 'proxy_stop');
        assertToken(token);
        await waitFor(token, deps.clearHistory(scope.profileId));
        assertToken(token);
        return consume(token);
      }
      case 'set-autostart': {
        const before = await waitFor(token, deps.getAutostartStatus());
        if (!before.supported) throw new ServiceError('AUTOSTART_UNAVAILABLE');
        if (before.errorCode) throw new ServiceError(before.errorCode);
        try {
          const actual = await waitFor(token, deps.setAutostartEnabled(payload.enabled));
          await persist(token, { ...root(), app: { ...root().app, launchAtLogin: payload.enabled } });
          assertToken(token);
          publish();
          return actual;
        } catch (error) {
          try { await deps.setAutostartEnabled(before.enabled); }
          catch (_) {
            log('error', 'autostart', 'Autostart rollback failed');
            throw new ServiceError('AUTOSTART_FAILED');
          }
          throw error;
        }
      }
      case 'save-app-settings':
        await persist(token, { ...root(), app: { ...root().app, ...payload.patch } });
        assertToken(token);
        if (Object.hasOwn(payload.patch, 'theme')) deps.publish?.('theme-changed', payload.patch.theme);
        publish();
        return null;
      case 'retry-load': {
        const corrupt = store.getStorageErrorCode() === 'SETTINGS_RECOVERY_REQUIRED';
        if (!await confirm(token, corrupt ? 'recover-settings' : 'retry-load', state.connectionCount, corrupt)) {
          return { cancelled: true };
        }
        assertToken(token);
        state.desiredRunning = false;
        pendingAuthentication = null;
        advanceEpoch(token, 'retry_load');
        login.deactivate();
        await stopStage(token, 'retry_load');
        assertToken(token);
        await waitFor(token, login.resetForProfile({ assertCurrent: () => assertToken(token) }));
        assertToken(token);
        try { store.retryLoad({ allowCorruptRecovery: corrupt }); }
        catch (error) {
          state.storageErrorCode = store.getStorageErrorCode() || 'SETTINGS_LOCKED';
          publish();
          throw new ServiceError(state.storageErrorCode);
        }
        assertToken(token);
        if (store.isLocked()) throw new ServiceError(store.getStorageErrorCode() || 'SETTINGS_LOCKED');
        scope = { profileId: root().activeProfileId, epoch: scope.epoch };
        token.executionScope = Object.freeze({ ...scope });
        proxy.setScope(scope);
        login.setScope(scope);
        state.storageErrorCode = null;
        storageStopRequested = false;
        bindProfile(token);
        token.authGeneration = authGeneration;
        const keyError = deps.initializeKeys?.();
        if (keyError) throw new ServiceError(keyError);
        deps.assertKeys?.();
        if (state.desiredRunning && state.cookieValid) {
          await startStage(token);
          assertToken(token);
        }
        return consume(token, profilesDto());
      }
      default: break;
    }
    switch (action) {
      case 'start':
        state.desiredRunning = true;
        publish();
        return startStage(token);
      case 'stop':
        if (!token.confirmedDraft && !await confirm(token, 'stop')) return { cancelled: true };
        assertToken(token);
        state.desiredRunning = false;
        advanceEpoch(token, 'proxy_stop');
        await stopStage(token, 'user_stop');
        return consume(token);
      case 'restart':
        if (!await confirm(token, 'restart')) return { cancelled: true };
        assertToken(token, true);
        state.desiredRunning = true;
        advanceEpoch(token, 'proxy_restart');
        await stopStage(token, 'restart');
        assertToken(token, true);
        await startStage(token);
        assertToken(token, true);
        return consume(token);
      case 'login':
        if (state.loginStatus === 'pending' || state.loginStatus === 'sso_done') {
          state.desiredRunning = true;
          publish();
          const existing = await waitFor(token, login.start({ signal: token.signal }));
          assertToken(token);
          return existing;
        }
        if (!await confirm(token, 'login')) return { cancelled: true };
        assertWritable();
        assertToken(token);
        state.desiredRunning = true;
        advanceEpoch(token, 'login');
        await stopStage(token, 'login');
        assertToken(token);
        await waitFor(token, login.resetForProfile({ revoke: true, loginStatus: 'idle',
          assertCurrent: () => assertToken(token) }));
        assertToken(token);
        token.authGeneration = authGeneration;
        const opened = await waitFor(token, login.start({ signal: token.signal }));
        assertToken(token);
        return consume(token, opened);
      case 'disconnect':
        if (!await confirm(token, 'disconnect', 1)) return { cancelled: true };
        assertToken(token);
        return consume(token, { disconnected: proxy.disconnectSession(payload.sessionId) });
      case 'save-settings': {
        assertAlias(payload.patch.sshAlias || profile().settings.sshAlias, scope.profileId);
        const candidate = { ...root(), profiles: root().profiles.map((item) => item.id === scope.profileId
          ? { ...item, settings: { ...item.settings, ...payload.patch } } : item) };
        await persist(token, candidate);
        assertToken(token);
        if (Object.keys(payload.patch).some((key) => CONFIG_KEYS.includes(key) || key === 'sshAlias')) {
          deps.onConfigSaved?.({ ...scope });
        }
        publish();
        return { needsRestart: snapshot().needsRestart };
      }
      case 'save-credentials': case 'clear-credentials': {
        const changedAccount = action === 'clear-credentials'
          || payload.username !== credentials.getSsoStatus().username;
        if (changedAccount) {
          if (!await confirm(token, 'account')) return { cancelled: true };
          assertToken(token);
          state.desiredRunning = false;
          advanceEpoch(token, 'account');
          pendingAuthentication = null;
          login.deactivate();
          await stopStage(token, 'account');
          assertToken(token);
          await waitFor(token, login.resetForProfile({ revoke: true, loginStatus: 'idle',
            assertCurrent: () => assertToken(token) }));
          assertToken(token);
        }
        const value = action === 'clear-credentials' ? credentials.clearSso()
          : credentials.saveSso({ username: payload.username, password: payload.password });
        assertToken(token);
        return changedAccount ? consume(token, { ...value, profileId: scope.profileId })
          : { ...value, profileId: scope.profileId };
      }
      case 'preview-config': {
        assertToken(token);
        const result = await waitFor(token, deps.previewSshConfig(token.executionScope));
        assertToken(token);
        return result;
      }
      case 'generate-config': {
        assertToken(token);
        const result = await waitFor(token, deps.generateSshConfig(payload, token.executionScope));
        assertToken(token);
        return result;
      }
      case 'theme': case 'locale': {
        await persist(token, { ...root(), app: { ...root().app, [action]: payload.value } });
        assertToken(token);
        if (action === 'theme') deps.publish?.('theme-changed', payload.value);
        publish();
        return null;
      }
      case 'exit':
        if (!await confirm(token, 'exit')) return { cancelled: true };
        assertToken(token);
        await prepareStage(token, 'app_exit');
        assertToken(token);
        const result = consume(token);
        shuttingDown = true;
        exitPrepared = true;
        deps.onExitPrepared?.();
        return result;
      default: throw new ServiceError('INVALID_ARGUMENT');
    }
  };
  const createOperation = (action, key) => {
    const abort = new AbortController();
    const token = { operationId: randomUUID(),
      executionScope: Object.freeze({ ...scope }), signal: abort.signal,
      draftRevision: draft.draftRevision, authGeneration };
    Object.defineProperty(token, 'originScope', { enumerable: true, value: Object.freeze({ ...scope }) });
    return { action, key, token, abort, promise: null };
  };
  const launch = (action, key, operation, body, previous = null, adopted = null) => {
    const record = adopted || createOperation(action, key);
    const { token } = record;
    active = record;
    state.operation = operation;
    state.errorCode = null;
    publish();
    const result = Promise.resolve(previous).then(() => body(token))
      .catch(async (error) => {
        if (error.code === 'OPERATION_CANCELLED') return { cancelled: true };
        if (active === record) {
          if (store.isLocked()) {
            try { await lockStorage(token); } catch (stopError) { log('error', 'settings', stopError.code); }
          }
          if (active !== record || token.signal.aborted) return { cancelled: true };
          assertToken(token);
          state.errorCode = error instanceof ServiceError ? error.code : 'INTERNAL_ERROR';
          publish();
        }
        throw error;
      }).finally(() => {
        if (active === record) {
          active = null;
          state.operation = null;
          publish();
          queueMicrotask(drainAuthentication);
        }
      });
    if (!adopted) record.promise = result;
    return result;
  };
  const drainAuthentication = () => {
    if (active || pendingStop || disposed || shuttingDown || store.isLocked() || !pendingAuthentication) return;
    const auth = pendingAuthentication;
    pendingAuthentication = null;
    if (!sameScope(auth.scope, scope) || auth.authGeneration !== authGeneration || !state.cookieValid) return;
    if (login.getCookie() !== auth.cookie) return;
    const shouldStart = state.desiredRunning;
    // An authentication callback never recursively waits for the action that opened its window.
    launch(shouldStart ? 'start' : 'authenticated', null, shouldStart ? 'starting' : null, async (token) => {
      assertToken(token, true);
      if (auth.authGeneration !== authGeneration || login.getCookie() !== auth.cookie) return;
      let persistenceFailed = false;
      try { credentials.saveCookie(auth.cookie); }
      catch (error) {
        persistenceFailed = true;
        state.storageErrorCode = 'AUTH_PERSIST_FAILED';
        log('error', 'cookie', `Cookie persistence failed: ${error.message}`);
      }
      if (store.isLocked()) {
        await lockStorage(token);
        assertToken(token);
        throw new ServiceError(state.storageErrorCode);
      }
      if (!persistenceFailed && state.storageErrorCode === 'AUTH_PERSIST_FAILED') {
        state.storageErrorCode = null;
        publish();
      }
      assertToken(token, true);
      if (state.desiredRunning) await startStage(token);
      assertToken(token, true);
      if (persistenceFailed) {
        state.errorCode = 'AUTH_PERSIST_FAILED';
        publish();
      }
    }).catch((error) => {
      if (error.code !== 'OPERATION_CANCELLED') log('error', 'auth', error.code || error.message);
    });
  };
  const confirmPendingStop = (payload, key) => {
    const original = active;
    const record = createOperation('stop', key);
    pendingStop = record;
    record.promise = Promise.resolve().then(async () => {
      if (!await confirm(record.token, 'stop')) return { cancelled: true };
      assertToken(record.token);
      const previous = active === original ? original.promise.catch(() => {}) : null;
      if (active && active !== original) throw new ServiceError('OPERATION_IN_PROGRESS');
      original.abort.abort();
      proxy.cancelPendingStart();
      state.desiredRunning = false;
      pendingStop = null;
      return launch('stop', key, 'stopping', (token) => execute('stop', payload, token), previous, record);
    }).catch((error) => {
      if (error.code === 'OPERATION_CANCELLED') return { cancelled: true };
      throw error;
    }).finally(() => {
      if (pendingStop === record) pendingStop = null;
      queueMicrotask(drainAuthentication);
      publish();
    });
    return record.promise;
  };
  function run(action, input) {
    if (action === 'set-dirty') {
      try {
        assertScope(input?.scope);
        if (typeof input.dirty !== 'boolean' || !Number.isSafeInteger(input.draftRevision) || input.draftRevision < 0) {
          throw new ServiceError('INVALID_ARGUMENT');
        }
        if (input.draftRevision < draft.draftRevision) throw new ServiceError('DRAFT_CHANGED');
        draft = { dirty: input.dirty, draftRevision: input.draftRevision };
        return Promise.resolve({ ...draft });
      } catch (error) { return Promise.reject(error); }
    }
    if (!Object.hasOwn(OPERATIONS, action)) return Promise.reject(new ServiceError('INVALID_ARGUMENT'));
    if (disposed || shuttingDown) return Promise.reject(new ServiceError('SHUTTING_DOWN'));
    let payload;
    try { payload = normalize(action, input); } catch (error) { return Promise.reject(error); }
    const key = JSON.stringify([action, canonical(payload)]);
    if (active?.key === key) return active.promise;
    if (pendingStop?.key === key) return pendingStop.promise;
    if (pendingStop) return Promise.reject(new ServiceError('OPERATION_IN_PROGRESS'));
    try { assertScope(payload.scope); } catch (error) { return Promise.reject(error); }
    if (action === 'stop') deps.cancelRecovery?.('user_stop');
    let previous = null;
    if (active) {
      const cancellable = active.action === 'start'
        || (active.action === 'restart' && state.proxyStatus === 'starting');
      if (action !== 'stop' || !cancellable) {
        return Promise.reject(new ServiceError('OPERATION_IN_PROGRESS'));
      }
      if (draft.dirty || state.connectionCount > 0) return confirmPendingStop(payload, key);
      state.desiredRunning = false;
      active.abort.abort();
      proxy.cancelPendingStart();
      previous = active.promise.catch(() => {});
    }
    return launch(action, key, OPERATIONS[action], (token) => execute(action, payload, token), previous);
  }

  const onLoginState = (patch) => {
    if (disposed || !sameScope(patch, scope) || !Number.isSafeInteger(patch.authGeneration)
        || patch.authGeneration < authGeneration) return;
    authGeneration = patch.authGeneration;
    for (const key of ['loginStatus', 'loginStage', 'cookieValid', 'cookieCount', 'errorCode']) {
      if (Object.hasOwn(patch, key)) state[key] = patch[key];
    }
    if (patch.cookieValid) state.remoteStatus = 'unknown';
    if (patch.errorCode === 'AUTH_PERSIST_FAILED') state.storageErrorCode = 'AUTH_PERSIST_FAILED';
    publish();
  };
  const onProxyState = (patch) => {
    if (disposed || !sameScope(patch, scope)) return;
    for (const key of ['proxyStatus', 'connectionCount', 'errorCode']) {
      if (Object.hasOwn(patch, key)) state[key] = patch[key];
    }
    if (Object.hasOwn(patch, 'runningConfig')) {
      state.runningConfig = patch.runningConfig ? Object.freeze({ ...patch.runningConfig }) : null;
    }
    publish();
  };
  const onAuthenticated = (auth) => {
    if (disposed || shuttingDown || !sameScope(auth.scope, scope) || auth.authGeneration !== authGeneration
        || !state.cookieValid || login.getCookie() !== auth.cookie) return;
    pendingAuthentication = { scope: { ...auth.scope }, authGeneration: auth.authGeneration, cookie: auth.cookie };
    queueMicrotask(drainAuthentication);
  };
  const onAuthRequired = (source) => {
    if (disposed || shuttingDown || !sameScope(source, scope)) return;
    if (source.authGeneration !== undefined && source.authGeneration !== authGeneration) return;
    if (!state.cookieValid && state.remoteStatus === 'auth_required') return;
    active?.abort.abort();
    pendingStop?.abort.abort();
    proxy.cancelPendingStart();
    pendingAuthentication = null;
    state.cookieValid = false;
    state.cookieCount = 0;
    state.loginStatus = 'failure';
    state.loginStage = null;
    state.remoteStatus = 'auth_required';
    state.errorCode = 'AUTH_REQUIRED';
    publish();
    deps.notify?.('auth', {});
    // This security path bypasses user confirmation and does not recursively acquire the action slot.
    const previous = active?.promise.catch(() => {});
    const reset = login.resetForProfile({ revoke: true, loginStatus: 'failure' });
    reset.catch(() => {});
    launch('auth-revoked', null, 'stopping', async (token) => {
      assertToken(token);
      advanceEpoch(token, 'auth_revoked');
      await stopStage(token, 'auth_error');
      assertToken(token);
      await waitFor(token, reset);
      assertToken(token);
      state.errorCode = 'AUTH_REQUIRED';
      publish();
    }, previous).catch((error) => log('error', 'auth', `Authentication shutdown failed: ${error.message}`));
  };
  let remoteErrorCode = null;
  const onRemoteState = (source) => {
    if (disposed || shuttingDown || !sameScope(source, scope)
        || !['unknown', 'checking', 'reachable', 'offline', 'auth_required', 'error'].includes(source.remoteStatus)) return;
    const nextCode = source.errorCode || null;
    const errorCode = state.errorCode === null || state.errorCode === remoteErrorCode ? nextCode : state.errorCode;
    remoteErrorCode = nextCode;
    if (state.remoteStatus === source.remoteStatus && state.errorCode === errorCode) return;
    state.remoteStatus = source.remoteStatus;
    state.errorCode = errorCode;
    publish();
  };
  const requestRecoveryStart = async (candidate, { signal } = {}) => {
    const origin = { profileId: candidate.profileId, epoch: candidate.epoch };
    if (signal?.aborted) return { cancelled: true };
    const previous = active?.promise.catch(() => {});
    if (previous) await previous;
    if (signal?.aborted || disposed || shuttingDown || store.isLocked() || !sameScope(origin, scope)
        || !state.desiredRunning || !state.cookieValid || state.loginStatus !== 'success'
        || state.proxyStatus !== 'stopped') return { cancelled: true };
    return run('start', { scope: origin });
  };
  deps.bindCallbacks?.({ onLoginState, onProxyState, onAuthenticated, onAuthRequired, onRemoteState, requestRecoveryStart });
  proxy.setScope(scope);
  if (!store.isLocked()) login.setProfile(scope, credentials);
  publish();

  return {
    getSnapshot: snapshot,
    getDraftRevision: () => draft.draftRevision,
    getProfiles: profilesDto,
    getCredentials: (candidate) => {
      assertScope(candidate);
      if (store.isLocked()) return { profileId: scope.profileId, username: '', hasPassword: false, storageAvailable: false };
      return credentials.getSsoStatus();
    },
    run,
    prepareExit: (reason = 'app_exit') => {
      if (preparingExit && (reason !== 'fatal' || preparingReason === 'fatal')) return preparingExit;
      if (exitPrepared) {
        login.dispose();
        preparingExit = Promise.resolve({});
        return preparingExit;
      }
      preparingReason = reason;
      shuttingDown = true;
      active?.abort.abort();
      pendingStop?.abort.abort();
      proxy.cancelPendingStart();
      pendingAuthentication = null;
      state.desiredRunning = false;
      const previous = active?.promise.catch(() => {});
      preparingExit = launch('prepare-exit', null, 'stopping', async (token) => {
        assertToken(token);
        advanceEpoch(token, reason);
        await stopStage(token, reason);
        assertToken(token);
        await waitFor(token, deps.flush?.());
        assertToken(token);
        login.dispose();
        return {};
      }, previous);
      return preparingExit;
    },
    dispose: async () => {
      await preparingExit?.catch(() => {});
      disposed = true;
      shuttingDown = true;
      active?.abort.abort();
      pendingStop?.abort.abort();
      login.dispose();
      await proxy.dispose();
    },
  };
}

module.exports = { createAppController };
