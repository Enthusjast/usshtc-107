import { APP_DEFAULTS, PROFILE_DEFAULTS, PROFILE_SETTING_KEYS, TMUX_STARTUP_COMMAND, validateSettingsPatch } from '../../shared/settings-schema.mjs';
import { formatApiError, formatValidationError } from '../lib/api-errors';
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getSettings, saveSettings, saveAppSettings, getRuntimeInfo,
  saveSsoCredentials, getSsoCredentials, clearSsoCredentials,
  restartProxy,
} from '../lib/electron';
import { useToast } from '../components/Toast';
import LoadError from '../components/LoadError';
import ProfileManagement from '../components/ProfileManagement';
import SshConfigPreview from '../components/SshConfigPreview';
import AutostartControl from '../components/AutostartControl';
import SshKeyPanel from '../components/SshKeyPanel';
import SetupResume from '../components/SetupResume';
import UpdatePanel from '../components/UpdatePanel';
import { useLocale } from '../i18n/LocaleContext';
import { IconSettings, IconServer, IconFileEdit, IconInfo, IconGlobe, IconKey } from '../components/Icons';
import { useRuntime, sameScope } from '../contexts/RuntimeContext';

const SETTINGS_DEFAULTS = { ...APP_DEFAULTS, ...PROFILE_DEFAULTS };
const APP_PREFERENCE_KEYS = ['startMinimized', 'reconnectOnResume', 'autoCheckUpdates', 'notifyConnections', 'notifyAuth', 'notifyRecovery', 'notifyUpdates'];
const EDITABLE_SETTING_KEYS = [...PROFILE_SETTING_KEYS, ...APP_PREFERENCE_KEYS];
const CONNECTION_SETTING_KEYS = ['host', 'port', 'cluster', 'loginNode', 'path', 'startupCommand', 'cols', 'rows', 'useRoot', 'sshAlias'];

function FieldError({ id, message }) {
  if (!message) return null;
  return <div id={id} className="field-error">{message}</div>;
}

export default function SettingsView({ onDirtyChange, onDraftChange, onBusyChange, initialSection, onNavigate }) {
  const pushToast = useToast();
  const { t, locale, setLocale } = useLocale();
  const { snapshot, scope, flushDraft, getDraftRevision, getScope, retry: refreshRuntime } = useRuntime();
  const draftRevision = useRef(getDraftRevision?.() ?? 0);
  const scopeRef = useRef(scope);
  const alive = useRef(true);
  const draftCallbackRef = useRef(onDraftChange);
  draftCallbackRef.current = onDraftChange;
  scopeRef.current = scope;
  const locked = Boolean(snapshot?.storageErrorCode);
  const needsRestart = snapshot?.needsRestart === true;
  const [settings, setSettings] = useState({ ...SETTINGS_DEFAULTS });
  const [runtime, setRuntime] = useState(null);
  const [loadState, setLoadState] = useState('loading');
  const [saveState, setSaveState] = useState('idle');
  const [profileSaveState, setProfileSaveState] = useState('idle');
  const [appSaveState, setAppSaveState] = useState('idle');
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [managementDirty, setManagementDirty] = useState(false);
  const [managementReset, setManagementReset] = useState(0);
  const [fieldErrors, setFieldErrors] = useState({});
  const [configRevision, setConfigRevision] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [consumingDraft, setConsumingDraft] = useState(false);
  const [ssoUsername, setSsoUsername] = useState('');
  const [initialSsoUsername, setInitialSsoUsername] = useState('');
  const [ssoPassword, setSsoPassword] = useState('');
  const [passwordDirty, setPasswordDirty] = useState(false);
  const [hasStoredPassword, setHasStoredPassword] = useState(false);
  const [secureStorageAvailable, setSecureStorageAvailable] = useState(false);
  const [clearingCredentials, setClearingCredentials] = useState(false);
  const [credentialError, setCredentialError] = useState(null);
  const dirtySettingKeysRef = useRef(new Set());

  const credentialsDirty = ssoUsername !== initialSsoUsername || passwordDirty;
  const dirty = settingsDirty || credentialsDirty || managementDirty;
  const isSaving = saveState === 'saving';
  const busy = isSaving || generating || clearingCredentials || autostartBusy || keyBusy || updateBusy || consumingDraft;
  const canClearCredentials = hasStoredPassword || Boolean(ssoUsername);
  const nonLoopbackBinding = !['127.0.0.1', '::1', 'localhost'].includes(settings.host.trim().toLowerCase());
  const currentScope = () => getScope?.() ?? scopeRef.current;
  const accepts = (origin) => alive.current && sameScope(currentScope(), origin);

  const applyCredentials = (credentials) => {
    setSsoUsername(credentials.username || '');
    setInitialSsoUsername(credentials.username || '');
    setSsoPassword('');
    setPasswordDirty(false);
    setHasStoredPassword(Boolean(credentials.hasPassword));
    setSecureStorageAvailable(credentials.storageAvailable !== false);
    setCredentialError(null);
  };

  const loadSettingsData = useCallback(async (targetScope = scopeRef.current, preserveView = false) => {
    if (!accepts(targetScope)) return false;
    if (!preserveView) setLoadState('loading');
    const revision = draftRevision.current;
    const [settingsResult, runtimeResult, credentialsResult] = await Promise.allSettled([
      getSettings(targetScope), getRuntimeInfo(), getSsoCredentials(targetScope),
    ]);
    if (!accepts(targetScope) || draftRevision.current !== revision) return false;
    if (settingsResult.status !== 'fulfilled') { setLoadState('error'); return false; }
    setSettings({ ...SETTINGS_DEFAULTS, ...settingsResult.value });
    setRuntime(runtimeResult.status === 'fulfilled' ? runtimeResult.value : null);
    if (credentialsResult.status === 'fulfilled' && credentialsResult.value.profileId === targetScope.profileId) {
      applyCredentials(credentialsResult.value);
    } else setCredentialError(credentialsResult.status === 'rejected' ? credentialsResult.reason : { code: 'PROFILE_CHANGED' });
    dirtySettingKeysRef.current.clear();
    setSettingsDirty(false);
    setFieldErrors({});
    setSaveState('idle');
    setLoadState('ready');
    return credentialsResult.status === 'fulfilled' && credentialsResult.value.profileId === targetScope.profileId;
  }, [getScope]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (scope && !dirty) void loadSettingsData(scope, true);
  }, [scope?.profileId, scope?.epoch, locked]);
  useEffect(() => {
    onDirtyChange?.(dirty);
    onDraftChange?.({ dirty, draftRevision: draftRevision.current });
  }, [dirty, onDirtyChange, onDraftChange]);
  useEffect(() => () => {
    draftCallbackRef.current?.({ dirty: false, draftRevision: draftRevision.current });
  }, []);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  useEffect(() => {
    if (!['ssh-config', 'updates'].includes(initialSection) || loadState !== 'ready') return;
    const frame = requestAnimationFrame(() => {
      const heading = document.getElementById(`${initialSection}-heading`);
      heading?.scrollIntoView?.({ block: 'start' });
      heading?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [initialSection, loadState]);

  const markEdited = (nextDirty = true) => {
    draftRevision.current += 1;
    onDraftChange?.({ dirty: nextDirty, draftRevision: draftRevision.current });
    setSaveState('idle');
  };
  const update = (key, value) => {
    dirtySettingKeysRef.current.add(key);
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSettingsDirty(true);
    if (PROFILE_SETTING_KEYS.includes(key)) setProfileSaveState('idle');
    else setAppSaveState('idle');
    setFieldErrors((prev) => ({ ...prev, [key]: undefined }));
    if (CONNECTION_SETTING_KEYS.includes(key)) setConfigRevision((value) => value + 1);
    markEdited();
  };
  const updateSsoUsername = (value) => {
    setSsoUsername(value);
    markEdited(settingsDirty || managementDirty || value !== initialSsoUsername || passwordDirty);
  };
  const updateSsoPassword = (value) => {
    setSsoPassword(value);
    setPasswordDirty(value.length > 0);
    markEdited(settingsDirty || managementDirty || ssoUsername !== initialSsoUsername || value.length > 0);
  };
  const consumeDraft = async (result) => {
    if (!alive.current || result?.cancelled || result?.consumedDraftRevision !== draftRevision.current) return;
    const revision = draftRevision.current;
    const origin = currentScope();
    setConsumingDraft(true);
    try {
      // The IPC reply can beat this action's final runtime-state event.
      await refreshRuntime();
      if (!alive.current || currentScope()?.profileId !== origin?.profileId || revision !== draftRevision.current) return;
      const applied = await loadSettingsData(currentScope(), true);
      if (applied && alive.current && revision === draftRevision.current) {
        setManagementDirty(false);
        setManagementReset((value) => value + 1);
        onDraftChange?.({ dirty: false, draftRevision: revision });
      }
    } finally { if (alive.current) setConsumingDraft(false); }
  };

  const handleSave = async () => {
    if (locked || busy) return;
    const revision = draftRevision.current;
    const origin = currentScope();
    const patch = Object.fromEntries([...dirtySettingKeysRef.current].map((key) => [key, settings[key]]));
    const validation = validateSettingsPatch(patch, settings);
    const errors = validation.ok ? {} : Object.fromEntries(Object.entries(validation.fieldErrors).map(([key, code]) => [key, formatValidationError(code, t)]));
    setFieldErrors(errors);
    if (!validation.ok) { pushToast('error', t('invalidSettings'), t('fixHighlightedFields')); return; }
    setSaveState('saving');
    let failed = false;
    let cancelled = false;
    let credentialsRemaining = credentialsDirty;
    let managementRemaining = managementDirty;
    let restartRequired = false;
    const stillCurrent = () => accepts(origin) && draftRevision.current === revision;
    const commitPatch = async (keys, save, setState) => {
      if (!keys.length || cancelled || !stillCurrent()) return;
      try {
        await flushDraft();
        if (!stillCurrent()) return;
        const changes = Object.fromEntries(keys.map((key) => [key, validation.value[key]]));
        const result = await save(changes);
        if (!stillCurrent()) return;
        if (result?.cancelled) { cancelled = true; return; }
        restartRequired ||= Boolean(result?.needsRestart);
        keys.forEach((key) => dirtySettingKeysRef.current.delete(key));
        setSettings((previous) => ({ ...previous, ...changes }));
        setSettingsDirty(dirtySettingKeysRef.current.size > 0);
        setState('saved');
      } catch (error) {
        if (!stillCurrent()) return;
        failed = true;
        setState('error');
        if (error?.fieldErrors) setFieldErrors((previous) => ({ ...previous, ...Object.fromEntries(Object.entries(error.fieldErrors).map(([key, code]) => [key, formatValidationError(code, t)])) }));
        pushToast('error', t('settingsSaveFailed'), formatApiError(error, t));
      }
    };
    try {
      await commitPatch(Object.keys(patch).filter((key) => PROFILE_SETTING_KEYS.includes(key)), (changes) => saveSettings({ scope: origin, patch: changes }), setProfileSaveState);
      await commitPatch(Object.keys(patch).filter((key) => !PROFILE_SETTING_KEYS.includes(key)), saveAppSettings, setAppSaveState);
      if (credentialsDirty && !cancelled && stillCurrent()) {
        try {
          await flushDraft();
          if (!stillCurrent()) return;
          const result = await saveSsoCredentials({ scope: origin, username: ssoUsername.trim(), ...(passwordDirty ? { password: ssoPassword } : {}) });
          if (!alive.current || currentScope()?.profileId !== origin.profileId || revision !== draftRevision.current) return;
          if (result?.cancelled) cancelled = true;
          else if (accepts(origin) || result?.consumedDraftRevision === revision) {
            credentialsRemaining = false;
            if (passwordDirty) setHasStoredPassword(true);
            setInitialSsoUsername(ssoUsername.trim());
            setSsoUsername(ssoUsername.trim());
            setSsoPassword('');
            setPasswordDirty(false);
            if (result?.consumedDraftRevision === revision) {
              await consumeDraft(result);
              managementRemaining = false;
            }
          }
        } catch (error) {
          if (!alive.current || currentScope()?.profileId !== origin.profileId) return;
          failed = true;
          pushToast('error', t('credentialsSaveFailed'), formatApiError(error, t));
        }
      }
      if (!alive.current || currentScope()?.profileId !== origin.profileId || revision !== draftRevision.current) return;
      const remaining = dirtySettingKeysRef.current.size > 0 || credentialsRemaining || managementRemaining;
      onDraftChange?.({ dirty: remaining, draftRevision: revision });
      setSaveState(failed || cancelled || remaining ? 'idle' : 'saved');
      if (!failed && !cancelled) pushToast(restartRequired ? 'warn' : 'success', t('settingsSaved'), restartRequired ? t('restartToApply') : undefined);
    } finally {
      if (alive.current) setSaveState((previous) => previous === 'saving' ? 'idle' : previous);
    }
  };

  const handleReset = () => {
    if (locked) return;
    markEdited();
    setSettings((previous) => ({ ...previous, ...Object.fromEntries(EDITABLE_SETTING_KEYS.map((key) => [key, SETTINGS_DEFAULTS[key]])) }));
    dirtySettingKeysRef.current = new Set(EDITABLE_SETTING_KEYS);
    setSettingsDirty(true);
    setProfileSaveState('idle');
    setAppSaveState('idle');
    setFieldErrors({});
    setConfigRevision((value) => value + 1);
    pushToast('info', t('resetToDefaults'), t('clickSaveToApply'));
  };

  const handleClearCredentials = async () => {
    if (locked) return;
    setClearingCredentials(true);
    const origin = currentScope();
    try {
      const revision = draftRevision.current;
      await flushDraft();
      if (!accepts(origin)) return;
      const result = await clearSsoCredentials(origin);
      if (!alive.current || result?.cancelled || currentScope()?.profileId !== origin.profileId || revision !== draftRevision.current) return;
      if (!accepts(origin) && result?.consumedDraftRevision !== revision) return;
      applyCredentials({ username: '', hasPassword: false, storageAvailable: secureStorageAvailable });
      await consumeDraft(result);
      pushToast('success', t('ssoCredentialsCleared'));
    } catch (error) {
      if (alive.current) pushToast('error', t('clearCredentialsFailed'), formatApiError(error, t));
    } finally { if (alive.current) setClearingCredentials(false); }
  };

  const retryCredentials = async () => {
    const origin = currentScope();
    try {
      const value = await getSsoCredentials(origin);
      if (accepts(origin) && value.profileId === origin.profileId) applyCredentials(value);
    } catch (error) {
      if (accepts(origin)) setCredentialError(error);
    }
  };


  if (loadState === 'loading') {
    return (
      <div className="settings-view" aria-busy="true" aria-label={t('loadingSettings')}>
        {[1, 2, 3].map((item) => (
          <div className="card skeleton-card" key={item}>
            <div className="skeleton skeleton-title" />
            <div className="skeleton skeleton-text" />
            <div className="skeleton skeleton-text" style={{ width: '70%' }} />
          </div>
        ))}
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <LoadError
        title={t('settingsLoadError')}
        detail={t('loadErrorHint')}
        retryLabel={t('retry')}
        retryingLabel={t('retrying')}
        onRetry={loadSettingsData}
      />
    );
  }

  return (
    <div className="settings-view">
      {consumingDraft && <p role="status">{t('loadingSettings')}</p>}
      <SetupResume onNavigate={onNavigate} disabled={busy} />
      <fieldset className="settings-form-fields" disabled={locked}>
      <ProfileManagement key={managementReset} disabled={busy || locked || Boolean(snapshot?.operation)} onEdit={markEdited} onDirtyChange={setManagementDirty} onConsumedDraft={consumeDraft} />
      {needsRestart && (
        <div className="settings-warning" role="status">
          {t('proxyRunningRestart')}
          <button type="button" className="btn" disabled={locked || busy || Boolean(snapshot?.operation)} onClick={async () => {
            try {
              await flushDraft();
              const origin = currentScope();
              const result = await restartProxy(origin);
              if (alive.current && currentScope()?.profileId === origin?.profileId) await consumeDraft(result);
            } catch (error) { pushToast('error', t('actionFailed'), formatApiError(error, t)); }
          }}>{t('restartAndApply')}</button>
        </div>
      )}

      <section className="card" aria-labelledby="proxy-settings-heading">
        <h2 id="proxy-settings-heading" className="card-header">
          <span className="card-header-icon" aria-hidden="true"><IconServer /></span> {t('proxySettings')}
        </h2>
        <div className="settings-grid">
          <div>
            <label className="form-label" htmlFor="setting-host">{t('host')}</label>
            <input id="setting-host" className="form-input" value={settings.host} onChange={(e) => update('host', e.target.value)} aria-invalid={Boolean(fieldErrors.host)} aria-describedby={[fieldErrors.host && 'setting-host-error', nonLoopbackBinding && 'setting-host-warning'].filter(Boolean).join(' ') || undefined} disabled={isSaving || generating} />
            <FieldError id="setting-host-error" message={fieldErrors.host} />
            {nonLoopbackBinding && <p id="setting-host-warning" className="settings-warning" role="status">{t('nonLoopbackBindingWarning')}</p>}
          </div>
          <div>
            <label className="form-label" htmlFor="setting-port">{t('portLabel')}</label>
            <input id="setting-port" className="form-input" type="number" min={1} max={65535} value={settings.port} onChange={(e) => update('port', e.target.value)} aria-invalid={Boolean(fieldErrors.port)} aria-describedby={fieldErrors.port ? 'setting-port-error' : undefined} disabled={isSaving || generating} />
            <FieldError id="setting-port-error" message={fieldErrors.port} />
          </div>
        </div>
      </section>

      <section className="card" aria-labelledby="cluster-settings-heading">
        <h2 id="cluster-settings-heading" className="card-header">
          <span className="card-header-icon" aria-hidden="true"><IconServer /></span> {t('clusterSettings')}
        </h2>
        <div className="settings-grid">
          <div>
            <label className="form-label" htmlFor="setting-cluster">{t('cluster')}</label>
            <input id="setting-cluster" className="form-input" value={settings.cluster} onChange={(e) => update('cluster', e.target.value)} aria-invalid={Boolean(fieldErrors.cluster)} aria-describedby={fieldErrors.cluster ? 'setting-cluster-error' : undefined} disabled={isSaving} />
            <FieldError id="setting-cluster-error" message={fieldErrors.cluster} />
          </div>
          <div>
            <label className="form-label" htmlFor="setting-loginNode">{t('loginNodeIP')}</label>
            <input id="setting-loginNode" className="form-input" value={settings.loginNode} onChange={(e) => update('loginNode', e.target.value)} placeholder="e.g. 11.11.10.202" aria-invalid={Boolean(fieldErrors.loginNode)} aria-describedby={fieldErrors.loginNode ? 'setting-login-node-error' : undefined} disabled={isSaving} />
            <FieldError id="setting-login-node-error" message={fieldErrors.loginNode} />
          </div>
          <div>
            <label className="form-label" htmlFor="setting-path">{t('startingDirectory')}</label>
            <input id="setting-path" className="form-input" value={settings.path} maxLength={1024} onChange={(e) => update('path', e.target.value)} aria-invalid={Boolean(fieldErrors.path)} aria-describedby={['setting-path-help', fieldErrors.path && 'setting-path-error'].filter(Boolean).join(' ')} disabled={isSaving} />
            <p id="setting-path-help" className="settings-help">{t('startingDirectoryHint')}</p>
            <FieldError id="setting-path-error" message={fieldErrors.path} />
          </div>
          <div>
            <label className="form-label" htmlFor="setting-cols">{t('colsLabel')}</label>
            <input id="setting-cols" className="form-input" type="number" min={40} max={500} value={settings.cols} onChange={(e) => update('cols', e.target.value)} aria-invalid={Boolean(fieldErrors.cols)} aria-describedby={fieldErrors.cols ? 'setting-cols-error' : undefined} disabled={isSaving} />
            <FieldError id="setting-cols-error" message={fieldErrors.cols} />
          </div>
          <div>
            <label className="form-label" htmlFor="setting-rows">{t('rowsLabel')}</label>
            <input id="setting-rows" className="form-input" type="number" min={10} max={200} value={settings.rows} onChange={(e) => update('rows', e.target.value)} aria-invalid={Boolean(fieldErrors.rows)} aria-describedby={fieldErrors.rows ? 'setting-rows-error' : undefined} disabled={isSaving} />
            <FieldError id="setting-rows-error" message={fieldErrors.rows} />
          </div>
        </div>
        <label className="toggle-wrapper settings-toggle-row">
          <span className="toggle-label">{t('useRoot')}</span>
          <span className="toggle-switch">
            <input type="checkbox" checked={Boolean(settings.useRoot)} onChange={(e) => update('useRoot', e.target.checked)} disabled={isSaving} aria-describedby="setting-root-help" />
            <span className="toggle-slider" aria-hidden="true" />
          </span>
        </label>
        <p id="setting-root-help" className="settings-help">{t('useRootHint')}</p>
      </section>

      <section className="card" aria-labelledby="behavior-settings-heading">
        <h2 id="behavior-settings-heading" className="card-header">
          <span className="card-header-icon" aria-hidden="true"><IconSettings /></span> {t('behavior')}
        </h2>
        <div className="settings-toggle-list">
          <label className="toggle-wrapper">
            <span className="toggle-label">{t('autoConnect')}</span>
            <span className="toggle-switch">
              <input type="checkbox" checked={Boolean(settings.autoConnect)} onChange={(e) => update('autoConnect', e.target.checked)} disabled={isSaving} />
              <span className="toggle-slider" aria-hidden="true" />
            </span>
          </label>
          <div>
            <label className="toggle-wrapper" htmlFor="setting-startupCommand">
              <span className="toggle-label">{t('keepTmuxSession')}</span>
              <span className="toggle-switch">
                <input id="setting-startupCommand" type="checkbox" checked={settings.startupCommand === TMUX_STARTUP_COMMAND} onChange={(e) => update('startupCommand', e.target.checked ? TMUX_STARTUP_COMMAND : '')} disabled={isSaving} aria-invalid={Boolean(fieldErrors.startupCommand)} aria-describedby={['setting-tmux-help', fieldErrors.startupCommand && 'setting-startupCommand-error'].filter(Boolean).join(' ')} />
                <span className="toggle-slider" aria-hidden="true" />
              </span>
            </label>
            <p id="setting-tmux-help" className="settings-help">{t('keepTmuxSessionHint')}</p>
            <FieldError id="setting-startupCommand-error" message={fieldErrors.startupCommand} />
          </div>
          <div>
            <label className="toggle-wrapper" htmlFor="setting-healthProbeEnabled">
              <span className="toggle-label">{t('healthProbeEnabled')}</span>
              <span className="toggle-switch">
                <input id="setting-healthProbeEnabled" type="checkbox" checked={settings.healthProbeEnabled === true} onChange={(e) => update('healthProbeEnabled', e.target.checked)} disabled={isSaving} aria-invalid={Boolean(fieldErrors.healthProbeEnabled)} aria-describedby={['setting-health-help', fieldErrors.healthProbeEnabled && 'setting-healthProbeEnabled-error'].filter(Boolean).join(' ')} />
                <span className="toggle-slider" aria-hidden="true" />
              </span>
            </label>
            <p id="setting-health-help" className="settings-help">{t('healthProbeEnabledHint')}</p>
            <FieldError id="setting-healthProbeEnabled-error" message={fieldErrors.healthProbeEnabled} />
          </div>
          <label className="toggle-wrapper">
            <span className="toggle-label">{t('startMinimized')}</span>
            <span className="toggle-switch">
              <input type="checkbox" checked={Boolean(settings.startMinimized)} onChange={(e) => update('startMinimized', e.target.checked)} disabled={isSaving} />
              <span className="toggle-slider" aria-hidden="true" />
            </span>
          </label>
        </div>
      </section>

      <section className="card" aria-labelledby="os-preferences-heading">
        <h2 id="os-preferences-heading" className="card-header">
          <span className="card-header-icon" aria-hidden="true"><IconSettings /></span> {t('osPreferences')}
        </h2>
        <AutostartControl scope={scope} getScope={getScope} flushDraft={flushDraft} disabled={locked || isSaving || generating || clearingCredentials || Boolean(snapshot?.operation)} onBusyChange={setAutostartBusy} />
        <div className="settings-toggle-list">
          {APP_PREFERENCE_KEYS.filter((key) => key !== 'startMinimized').map((key) => (
            <div key={key}>
              <label className="toggle-wrapper" htmlFor={`setting-${key}`}>
                <span className="toggle-label">{t(key)}</span>
                <span className="toggle-switch">
                  <input id={`setting-${key}`} type="checkbox" checked={settings[key] === true} onChange={(event) => update(key, event.target.checked)} disabled={busy} aria-describedby={key === 'reconnectOnResume' ? 'reconnect-help' : key === 'autoCheckUpdates' ? 'auto-check-updates-help' : undefined} />
                  <span className="toggle-slider" aria-hidden="true" />
                </span>
              </label>
              <FieldError id={`setting-${key}-error`} message={fieldErrors[key]} />
            </div>
          ))}
        </div>
        <p id="reconnect-help" className="settings-help">{t('reconnectOnResumeHint')}</p>
        <p id="auto-check-updates-help" className="settings-help">{t('autoCheckUpdatesHint')}</p>
        <p className="settings-help">{t('notificationPrivacyHint')}</p>
      </section>

      <section className="card" aria-labelledby="sso-settings-heading">
        <h2 id="sso-settings-heading" className="card-header">
          <span className="card-header-icon" aria-hidden="true"><IconKey /></span> {t('ssoCredentials')}
        </h2>
        <p className="settings-help">
          {secureStorageAvailable ? t('ssoCredentialsHint') : t('secureStorageUnavailable')}
        </p>
        {credentialError && <div className="field-error" role="alert">{formatApiError(credentialError, t)} <button type="button" className="btn" onClick={() => { void retryCredentials(); }}>{t('retry')}</button></div>}
        <fieldset className="settings-form-fields" disabled={Boolean(credentialError)}>
        <div className="settings-field-stack">
          <div>
            <label className="form-label" htmlFor="setting-ssoUsername">{t('ssoUsernameLabel')}</label>
            <input id="setting-ssoUsername" className="form-input" value={ssoUsername} onChange={(e) => updateSsoUsername(e.target.value)} placeholder={t('ssoUsernamePlaceholder')} autoComplete="username" disabled={isSaving || clearingCredentials} />
          </div>
          <div>
            <label className="form-label" htmlFor="setting-ssoPassword">{t('ssoPasswordLabel')}</label>
            <input id="setting-ssoPassword" className="form-input" type="password" value={ssoPassword} onChange={(e) => updateSsoPassword(e.target.value)} placeholder={hasStoredPassword ? t('keepStoredPassword') : t('enterSsoPassword')} autoComplete="new-password" disabled={!secureStorageAvailable || isSaving || clearingCredentials} />
            {hasStoredPassword && !passwordDirty && <div className="field-hint">{t('passwordStored')}</div>}
          </div>
        </div>
        {canClearCredentials && (
          <button type="button" className="btn btn-danger settings-secondary-action" onClick={handleClearCredentials} disabled={busy}>
            {clearingCredentials ? t('clearingCredentials') : t('clearCredentials')}
          </button>
        )}
        </fieldset>
      </section>

      <section className="card" aria-labelledby="language-settings-heading">
        <h2 id="language-settings-heading" className="card-header">
          <span className="card-header-icon" aria-hidden="true"><IconGlobe /></span> {t('language')}
        </h2>
        <div className="segmented-control" aria-label={t('language')}>
          <button type="button" className={`btn ${locale === 'en' ? 'btn-primary' : ''}`} onClick={() => setLocale('en').catch((error) => pushToast('error', t('actionFailed'), formatApiError(error, t)))} aria-pressed={locale === 'en'}>English</button>
          <button type="button" className={`btn ${locale === 'zh' ? 'btn-primary' : ''}`} onClick={() => setLocale('zh').catch((error) => pushToast('error', t('actionFailed'), formatApiError(error, t)))} aria-pressed={locale === 'zh'}>中文</button>
        </div>
      </section>
      </fieldset>

      <SshKeyPanel
        storageAvailable={secureStorageAvailable && !credentialError}
        disabled={locked || isSaving || generating || clearingCredentials || autostartBusy || Boolean(snapshot?.operation)}
        recoveryDisabled={isSaving || generating || clearingCredentials || autostartBusy || Boolean(snapshot?.operation)}
        onBusyChange={setKeyBusy}
        onConsumedDraft={consumeDraft}
      />
      <fieldset className="settings-form-fields" disabled={locked}>

      <section className="card" aria-labelledby="ssh-config-heading">
        <h2 id="ssh-config-heading" className="card-header" tabIndex={-1}>
          <span className="card-header-icon" aria-hidden="true"><IconFileEdit /></span> {t('sshConfig')}
        </h2>
        <p className="settings-help">{t('sshConfigHint', settings.sshAlias || PROFILE_DEFAULTS.sshAlias)}</p>
        <p className="settings-help">{t('sshConfigProfileWarning')}</p>
        <p className="settings-help">{t('sshConfigRulesWarning')}</p>
        <div className="settings-config-action">
          <div className="settings-alias-field">
            <label className="form-label" htmlFor="setting-sshAlias">{t('sshAlias')}</label>
            <input id="setting-sshAlias" className="form-input" value={settings.sshAlias || ''} onChange={(e) => update('sshAlias', e.target.value)} placeholder={PROFILE_DEFAULTS.sshAlias} aria-invalid={Boolean(fieldErrors.sshAlias)} aria-describedby={fieldErrors.sshAlias ? 'setting-ssh-alias-error' : undefined} disabled={isSaving || generating} />
            <FieldError id="setting-ssh-alias-error" message={fieldErrors.sshAlias} />
          </div>
        </div>
        <SshConfigPreview
          key={JSON.stringify([scope?.profileId, scope?.epoch, configRevision, snapshot?.desiredConfig])}
          scope={scope}
          alias={settings.sshAlias || PROFILE_DEFAULTS.sshAlias}
          unsaved={CONNECTION_SETTING_KEYS.some((key) => dirtySettingKeysRef.current.has(key))}
          disabled={locked || isSaving || clearingCredentials || autostartBusy || keyBusy}
          onBusyChange={setGenerating}
          isCurrent={accepts}
        />
      </section>

      <div className="settings-actions">
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={(!settingsDirty && !credentialsDirty) || busy}>
          {isSaving ? t('saving') : saveState === 'saved' ? t('savedLabel') : t('saveSettings')}
        </button>
        <button type="button" className="btn" onClick={handleReset} disabled={busy}>{t('resetDefaults')}</button>
        {dirty && <span className="settings-dirty-status" role="status">{t('unsavedChanges')}</span>}
        {profileSaveState === 'saved' && <span role="status">{t('profileSettingsSaved')}</span>}
        {appSaveState === 'saved' && <span role="status">{t('appSettingsSaved')}</span>}
      </div>
      </fieldset>
      <UpdatePanel
        disabled={locked || isSaving || generating || clearingCredentials || autostartBusy || keyBusy || Boolean(snapshot?.operation)}
        onBusyChange={setUpdateBusy}
        onConsumedDraft={consumeDraft}
      />
      <fieldset className="settings-form-fields" disabled={locked}>

      {runtime && (
        <section className="card" aria-labelledby="about-heading">
          <h2 id="about-heading" className="card-header">
            <span className="card-header-icon" aria-hidden="true"><IconInfo /></span> {t('about')}
          </h2>
          <div className="about-list">
            <div>{t('platform')}: <span className="mono">{runtime.platform}</span></div>
            <div>Electron: <span className="mono">{runtime.electronVersion}</span></div>
            <div>Node.js: <span className="mono">{runtime.nodeVersion}</span></div>
            <div>{t('mode')}: {runtime.devMode ? t('devMode') : t('prodMode')}</div>
            {runtime.logPath && <div className="settings-log-path">{t('logPath')}: {runtime.logPath}</div>}
          </div>
        </section>
      )}
      </fieldset>
    </div>
  );
}
