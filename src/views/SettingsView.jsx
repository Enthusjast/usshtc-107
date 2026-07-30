import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getSettings,
  saveSettings,
  getRuntimeInfo,
  generateSshConfig,
  saveSsoCredentials,
  getSsoCredentials,
  clearSsoCredentials,
  supportsClearSsoCredentials,
  getSshKeyInfo,
  copyToClipboard,
} from '../lib/electron';
import { useToast } from '../components/Toast';
import LoadError from '../components/LoadError';
import { useLocale } from '../i18n/LocaleContext';
import { IconSettings, IconServer, IconFileEdit, IconInfo, IconGlobe, IconKey, IconClipboard } from '../components/Icons';

const DEFAULT_SETTINGS = {
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
  sshAlias: 'usshtc107',
};

const TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/;
const EDITABLE_SETTING_KEYS = [
  'host',
  'port',
  'cluster',
  'loginNode',
  'cols',
  'rows',
  'useRoot',
  'autoConnect',
  'startMinimized',
  'sshAlias',
];

function isValidHost(value) {
  const host = String(value || '').trim();
  if (!host || host.length > 253 || /[\r\n\0\s]/.test(host)) return false;
  if (host.includes(':')) {
    try {
      return new URL(`http://[${host}]/`).hostname.length > 0;
    } catch {
      return false;
    }
  }
  if (host === 'localhost') return true;
  return host.split('.').every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)
  ));
}

function validateSettings(settings, t) {
  const errors = {};
  const port = Number(settings.port);
  const cols = Number(settings.cols);
  const rows = Number(settings.rows);
  const host = String(settings.host || '').trim();
  const cluster = String(settings.cluster || '').trim();
  const loginNode = String(settings.loginNode || '').trim();
  const sshAlias = String(settings.sshAlias || '').trim();

  if (!host) errors.host = t('fieldRequired');
  else if (!isValidHost(host)) errors.host = t('hostFormat');
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.port = t('portRange');
  if (!cluster) errors.cluster = t('fieldRequired');
  else if (cluster.length > 128 || !TOKEN_PATTERN.test(cluster)) errors.cluster = t('clusterFormat');
  if (!loginNode) errors.loginNode = t('fieldRequired');
  else if (!isValidHost(loginNode)) errors.loginNode = t('hostFormat');
  if (!Number.isInteger(cols) || cols < 40 || cols > 500) errors.cols = t('colsRange');
  if (!Number.isInteger(rows) || rows < 10 || rows > 200) errors.rows = t('rowsRange');
  if (!sshAlias) errors.sshAlias = t('fieldRequired');
  else if (sshAlias.length > 64 || !TOKEN_PATTERN.test(sshAlias)) errors.sshAlias = t('sshAliasFormat');

  return errors;
}

function FieldError({ id, message }) {
  if (!message) return null;
  return <div id={id} className="field-error">{message}</div>;
}

export default function SettingsView({ onDirtyChange, onBusyChange }) {
  const pushToast = useToast();
  const { t, locale, setLocale } = useLocale();
  const [settings, setSettings] = useState({ ...DEFAULT_SETTINGS });
  const [runtime, setRuntime] = useState(null);
  const [loadState, setLoadState] = useState('loading');
  const [saveState, setSaveState] = useState('idle');
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [sshConfigResult, setSshConfigResult] = useState(null);
  const [generating, setGenerating] = useState(false);
  const [ssoUsername, setSsoUsername] = useState('');
  const [initialSsoUsername, setInitialSsoUsername] = useState('');
  const [ssoPassword, setSsoPassword] = useState('');
  const [passwordDirty, setPasswordDirty] = useState(false);
  const [hasStoredPassword, setHasStoredPassword] = useState(false);
  const [secureStorageAvailable, setSecureStorageAvailable] = useState(true);
  const [clearingCredentials, setClearingCredentials] = useState(false);
  const [sshPubKey, setSshPubKey] = useState('');
  const [sshKeyPath, setSshKeyPath] = useState('');
  const [keyCopied, setKeyCopied] = useState(false);
  const dirtySettingKeysRef = useRef(new Set());
  const keyCopyTimerRef = useRef(null);

  const credentialsDirty = ssoUsername !== initialSsoUsername || passwordDirty;
  const dirty = settingsDirty || credentialsDirty;
  const isSaving = saveState === 'saving';
  const busy = isSaving || generating || clearingCredentials;
  const canClearCredentials = supportsClearSsoCredentials() && (hasStoredPassword || Boolean(ssoUsername));

  const loadSettingsData = useCallback(async () => {
    setLoadState('loading');
    const [settingsResult, runtimeResult, keyResult, credentialsResult] = await Promise.allSettled([
      getSettings(),
      getRuntimeInfo(),
      getSshKeyInfo(),
      getSsoCredentials(),
    ]);

    const loadedSettings = settingsResult.status === 'fulfilled' ? settingsResult.value : null;
    const loadedRuntime = runtimeResult.status === 'fulfilled' ? runtimeResult.value : null;
    const keyInfo = keyResult.status === 'fulfilled' ? keyResult.value : null;
    const credentials = credentialsResult.status === 'fulfilled' ? credentialsResult.value : null;

    if (!loadedSettings || !loadedRuntime || !keyInfo || !credentials) {
      setLoadState('error');
      return;
    }

    setSettings((prev) => ({ ...prev, ...loadedSettings }));
    setRuntime(loadedRuntime);
    setSshPubKey(keyInfo.publicKey || '');
    setSshKeyPath(keyInfo.privateKeyPath || '');
    setSsoUsername(credentials.username || '');
    setInitialSsoUsername(credentials.username || '');
    setSsoPassword('');
    setPasswordDirty(false);
    setHasStoredPassword(Boolean(credentials.hasPassword));
    setSecureStorageAvailable(credentials.storageAvailable !== false);
    dirtySettingKeysRef.current.clear();
    setSettingsDirty(false);
    setFieldErrors({});
    setSaveState('idle');
    setLoadState('ready');
  }, []);

  useEffect(() => {
    loadSettingsData();
  }, [loadSettingsData]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  useEffect(() => () => {
    if (keyCopyTimerRef.current !== null) clearTimeout(keyCopyTimerRef.current);
  }, []);

  useEffect(() => {
    if (!dirty) return undefined;
    const warnBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [dirty]);

  const markEdited = () => setSaveState('idle');

  const update = (key, value) => {
    dirtySettingKeysRef.current.add(key);
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSettingsDirty(true);
    setFieldErrors((prev) => ({ ...prev, [key]: undefined }));
    if (key === 'host' || key === 'port' || key === 'sshAlias') setSshConfigResult(null);
    markEdited();
  };

  const updateSsoUsername = (value) => {
    setSsoUsername(value);
    markEdited();
  };

  const updateSsoPassword = (value) => {
    setSsoPassword(value);
    setPasswordDirty(value.length > 0);
    markEdited();
  };

  const handleSave = async () => {
    const errors = settingsDirty ? validateSettings(settings, t) : {};
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      pushToast('error', t('invalidSettings'), t('fixHighlightedFields'));
      return;
    }

    const normalizedSettings = {
      ...settings,
      host: String(settings.host).trim(),
      cluster: String(settings.cluster).trim(),
      loginNode: String(settings.loginNode).trim(),
      sshAlias: String(settings.sshAlias).trim(),
      port: Number(settings.port),
      cols: Number(settings.cols),
      rows: Number(settings.rows),
      useRoot: Boolean(settings.useRoot),
    };
    const settingsPatch = Object.fromEntries(
      [...dirtySettingKeysRef.current].map((key) => [key, normalizedSettings[key]]),
    );

    setSaveState('saving');
    let failureTitle = t('settingsSaveFailed');
    let restartRequired = needsRestart;
    try {
      if (Object.keys(settingsPatch).length > 0) {
        const result = await saveSettings(settingsPatch);
        if (result?.ok === false) throw new Error(result.error || t('settingsSaveFailed'));
        restartRequired ||= Boolean(result?.needsRestart);
        setNeedsRestart(restartRequired);
        setSettings(normalizedSettings);
        for (const key of Object.keys(settingsPatch)) dirtySettingKeysRef.current.delete(key);
        setSettingsDirty(dirtySettingKeysRef.current.size > 0);
      }
      if (credentialsDirty) {
        failureTitle = t('credentialsSaveFailed');
        const credentialResult = await saveSsoCredentials(
          ssoUsername.trim(),
          passwordDirty ? ssoPassword : undefined,
        );
        if (credentialResult?.ok === false) throw new Error(credentialResult.error || t('credentialsSaveFailed'));
        if (passwordDirty) setHasStoredPassword(true);
        setInitialSsoUsername(ssoUsername.trim());
        setSsoUsername(ssoUsername.trim());
        setSsoPassword('');
        setPasswordDirty(false);
      }
      setSaveState('saved');
      if (restartRequired) {
        pushToast('warn', t('settingsSaved'), t('restartToApply'));
      } else {
        pushToast('success', t('settingsSaved'));
      }
    } catch (error) {
      setSaveState('idle');
      pushToast('error', failureTitle, error?.message || t('unknownError'));
    }
  };

  const handleReset = () => {
    setSettings((prev) => {
      const resetSettings = { ...prev };
      EDITABLE_SETTING_KEYS.forEach((key) => {
        resetSettings[key] = DEFAULT_SETTINGS[key];
      });
      return resetSettings;
    });
    dirtySettingKeysRef.current = new Set(EDITABLE_SETTING_KEYS);
    setSettingsDirty(true);
    setSaveState('idle');
    setFieldErrors({});
    setSshConfigResult(null);
    pushToast('info', t('resetToDefaults'), t('clickSaveToApply'));
  };

  const handleClearCredentials = async () => {
    if (!window.confirm(t('confirmClearCredentials'))) return;
    setClearingCredentials(true);
    try {
      const result = await clearSsoCredentials();
      if (result?.ok === false) throw new Error(result.error || t('clearCredentialsFailed'));
      setSsoUsername('');
      setInitialSsoUsername('');
      setSsoPassword('');
      setPasswordDirty(false);
      setHasStoredPassword(false);
      setSaveState('idle');
      pushToast('success', t('ssoCredentialsCleared'));
    } catch (error) {
      pushToast('error', t('clearCredentialsFailed'), error?.message || t('unknownError'));
    } finally {
      setClearingCredentials(false);
    }
  };

  const handleGenerateSshConfig = async () => {
    const configKeys = ['host', 'port', 'sshAlias'];
    if (configKeys.some((key) => dirtySettingKeysRef.current.has(key))) {
      pushToast('error', t('saveSettingsFirst'), t('saveSshConfigSettingsFirst'));
      return;
    }
    const errors = validateSettings(settings, t);
    const configErrors = Object.fromEntries(
      Object.entries(errors).filter(([key]) => ['host', 'port', 'sshAlias'].includes(key)),
    );
    if (Object.keys(configErrors).length > 0) {
      setFieldErrors((prev) => ({ ...prev, ...configErrors }));
      pushToast('error', t('invalidSettings'), t('fixHighlightedFields'));
      return;
    }

    setGenerating(true);
    setSshConfigResult(null);
    try {
      const result = await generateSshConfig({
        host: String(settings.host).trim(),
        port: Number(settings.port),
        alias: String(settings.sshAlias).trim(),
      });
      setSshConfigResult(result);
      if (result?.success) {
        pushToast('success', t('sshConfigWritten'), t('sshNowUse', settings.sshAlias || 'usshtc107'));
      } else {
        pushToast('error', t('failed'), t('errorPrefix', result?.error || t('unknownError')));
      }
    } catch (error) {
      setSshConfigResult({ success: false, error: error?.message || t('unknownError') });
      pushToast('error', t('failed'), error?.message || t('unknownError'));
    } finally {
      setGenerating(false);
    }
  };

  const handleCopyPubKey = async () => {
    if (!sshPubKey) return;
    const ok = await copyToClipboard(sshPubKey);
    if (ok === false) {
      pushToast('error', t('copyFailed'));
      return;
    }
    setKeyCopied(true);
    pushToast('info', t('copied'));
    if (keyCopyTimerRef.current !== null) clearTimeout(keyCopyTimerRef.current);
    keyCopyTimerRef.current = setTimeout(() => {
      keyCopyTimerRef.current = null;
      setKeyCopied(false);
    }, 2000);
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
      {needsRestart && (
        <div className="settings-warning" role="status">
          {t('proxyRunningRestart')}
        </div>
      )}

      <section className="card" aria-labelledby="proxy-settings-heading">
        <h2 id="proxy-settings-heading" className="card-header">
          <span className="card-header-icon" aria-hidden="true"><IconServer /></span> {t('proxySettings')}
        </h2>
        <div className="settings-grid">
          <div>
            <label className="form-label" htmlFor="setting-host">{t('host')}</label>
            <input id="setting-host" className="form-input" value={settings.host} onChange={(e) => update('host', e.target.value)} aria-invalid={Boolean(fieldErrors.host)} aria-describedby={fieldErrors.host ? 'setting-host-error' : undefined} disabled={isSaving || generating} />
            <FieldError id="setting-host-error" message={fieldErrors.host} />
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
            <input type="checkbox" checked={Boolean(settings.useRoot)} onChange={(e) => update('useRoot', e.target.checked)} disabled={isSaving} />
            <span className="toggle-slider" aria-hidden="true" />
          </span>
        </label>
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
          <label className="toggle-wrapper">
            <span className="toggle-label">{t('startMinimized')}</span>
            <span className="toggle-switch">
              <input type="checkbox" checked={Boolean(settings.startMinimized)} onChange={(e) => update('startMinimized', e.target.checked)} disabled={isSaving} />
              <span className="toggle-slider" aria-hidden="true" />
            </span>
          </label>
        </div>
      </section>

      <section className="card" aria-labelledby="sso-settings-heading">
        <h2 id="sso-settings-heading" className="card-header">
          <span className="card-header-icon" aria-hidden="true"><IconKey /></span> {t('ssoCredentials')}
        </h2>
        <p className="settings-help">
          {secureStorageAvailable ? t('ssoCredentialsHint') : t('secureStorageUnavailable')}
        </p>
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
          <button type="button" className="btn btn-danger settings-secondary-action" onClick={handleClearCredentials} disabled={clearingCredentials || isSaving}>
            {clearingCredentials ? t('clearingCredentials') : t('clearCredentials')}
          </button>
        )}
      </section>

      <section className="card" aria-labelledby="language-settings-heading">
        <h2 id="language-settings-heading" className="card-header">
          <span className="card-header-icon" aria-hidden="true"><IconGlobe /></span> {t('language')}
        </h2>
        <div className="segmented-control" aria-label={t('language')}>
          <button type="button" className={`btn ${locale === 'en' ? 'btn-primary' : ''}`} onClick={() => setLocale('en')} aria-pressed={locale === 'en'}>English</button>
          <button type="button" className={`btn ${locale === 'zh' ? 'btn-primary' : ''}`} onClick={() => setLocale('zh')} aria-pressed={locale === 'zh'}>中文</button>
        </div>
      </section>

      <section className="card" aria-labelledby="ssh-key-heading">
        <h2 id="ssh-key-heading" className="card-header">
          <span className="card-header-icon" aria-hidden="true"><IconKey /></span> {t('sshPublicKeyTitle')}
        </h2>
        <p className="settings-help">{t('sshPublicKeyHint')}</p>
        {sshPubKey ? (
          <>
            <div className="code-block settings-key-block">{sshPubKey}</div>
            <div className="settings-inline-action">
              <button type="button" className="btn" onClick={handleCopyPubKey}>
                <span aria-hidden="true"><IconClipboard size={15} /></span>
                {keyCopied ? t('copied') : t('copyPublicKey')}
              </button>
              {sshKeyPath && <span className="settings-path">{t('privateKeyAt')} <span className="mono">{sshKeyPath}</span></span>}
            </div>
          </>
        ) : (
          <div className="settings-help">{t('noSshKey')}</div>
        )}
      </section>

      <section className="card" aria-labelledby="ssh-config-heading">
        <h2 id="ssh-config-heading" className="card-header">
          <span className="card-header-icon" aria-hidden="true"><IconFileEdit /></span> {t('sshConfig')}
        </h2>
        <p className="settings-help">{t('sshConfigHint', settings.sshAlias || 'usshtc107')}</p>
        <div className="settings-config-action">
          <div className="settings-alias-field">
            <label className="form-label" htmlFor="setting-sshAlias">{t('sshAlias')}</label>
            <input id="setting-sshAlias" className="form-input" value={settings.sshAlias || ''} onChange={(e) => update('sshAlias', e.target.value)} placeholder="usshtc107" aria-invalid={Boolean(fieldErrors.sshAlias)} aria-describedby={fieldErrors.sshAlias ? 'setting-ssh-alias-error' : undefined} disabled={isSaving || generating} />
            <FieldError id="setting-ssh-alias-error" message={fieldErrors.sshAlias} />
          </div>
          <button type="button" className="btn btn-primary" onClick={handleGenerateSshConfig} disabled={generating || isSaving}>
            {generating ? t('writing') : t('generateSshConfig')}
          </button>
        </div>
        {sshConfigResult?.success && <div className="code-block settings-config-result">{sshConfigResult.content}</div>}
        {sshConfigResult && !sshConfigResult.success && <div className="field-error">{t('errorPrefix', sshConfigResult.error)}</div>}
        {sshConfigResult?.success && <div className="settings-path settings-result-path">{t('writtenTo')} <span className="mono">{sshConfigResult.path}</span></div>}
      </section>

      <div className="settings-actions">
        <button type="button" className="btn btn-primary" onClick={handleSave} disabled={!dirty || isSaving || clearingCredentials || generating}>
          {isSaving ? t('saving') : saveState === 'saved' ? t('savedLabel') : t('saveSettings')}
        </button>
        <button type="button" className="btn" onClick={handleReset} disabled={isSaving || clearingCredentials || generating}>{t('resetDefaults')}</button>
        {dirty && <span className="settings-dirty-status" role="status">{t('unsavedChanges')}</span>}
      </div>

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
    </div>
  );
}
