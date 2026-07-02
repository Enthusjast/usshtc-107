import { useState, useEffect } from 'react';
import { getSettings, saveSettings, getRuntimeInfo, generateSshConfig } from '../lib/electron';
import { useToast } from '../components/Toast';
import { useLocale } from '../i18n/LocaleContext';
import { IconSettings, IconServer, IconFileEdit, IconInfo, IconGlobe } from '../components/Icons';

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
  sshAlias: 'ustc107',
};

export default function SettingsView() {
  const pushToast = useToast();
  const { t, locale, setLocale } = useLocale();
  const [settings, setSettings] = useState({ ...DEFAULT_SETTINGS });
  const [runtime, setRuntime] = useState(null);
  const [saved, setSaved] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [sshConfigResult, setSshConfigResult] = useState(null);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    getSettings().then((s) => { if (s) setSettings((prev) => ({ ...prev, ...s })); });
    getRuntimeInfo().then(setRuntime);
  }, []);

  const update = (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const handleSave = async () => {
    const port = Number(settings.port);
    if (isNaN(port) || port < 1 || port > 65535) {
      pushToast('error', t('invalidPort'), t('portRange'));
      return;
    }
    const toSave = { ...settings, port, cols: Number(settings.cols), rows: Number(settings.rows) };
    const result = await saveSettings(toSave);
    setSaved(true);
    if (result?.needsRestart) {
      setNeedsRestart(true);
      pushToast('warn', t('settingsSaved'), t('restartToApply'));
    } else {
      pushToast('success', t('settingsSaved'));
    }
  };

  const handleReset = () => {
    setSettings({ ...DEFAULT_SETTINGS });
    setSaved(false);
    setNeedsRestart(false);
    setSshConfigResult(null);
    pushToast('info', t('resetToDefaults'), t('clickSaveToApply'));
  };

  const handleGenerateSshConfig = async () => {
    setGenerating(true);
    const result = await generateSshConfig({
      host: settings.host,
      port: settings.port,
      alias: settings.sshAlias || 'ustc107',
    });
    setSshConfigResult(result);
    setGenerating(false);
    if (result.success) {
      pushToast('success', t('sshConfigWritten'), t('sshNowUse', settings.sshAlias || 'ustc107'));
    } else {
      pushToast('error', t('failed'), t('errorPrefix', result.error));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '620px' }}>
      {needsRestart && (
        <div style={{
          background: 'var(--yellow-bg)',
          border: '1px solid rgba(234, 179, 8, 0.25)',
          color: 'var(--yellow)',
          padding: '0.7rem 1rem',
          borderRadius: 'var(--radius)',
          fontSize: '0.85rem',
          fontWeight: 500,
        }}>
          {t('proxyRunningRestart')}
        </div>
      )}

      {/* Proxy Settings */}
      <div className="card">
        <div className="card-header">
          <span className="card-header-icon"><IconServer /></span> {t('proxySettings')}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
          <div>
            <label className="form-label" htmlFor="setting-host">{t('host')}</label>
            <input id="setting-host" className="form-input" value={settings.host} onChange={(e) => update('host', e.target.value)} />
          </div>
          <div>
            <label className="form-label" htmlFor="setting-port">{t('portLabel')}</label>
            <input id="setting-port" className="form-input" type="number" min={1} max={65535} value={settings.port} onChange={(e) => update('port', e.target.value)} />
          </div>
        </div>
      </div>

      {/* Cluster Settings */}
      <div className="card">
        <div className="card-header">
          <span className="card-header-icon"><IconServer /></span> {t('clusterSettings')}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
          <div>
            <label className="form-label" htmlFor="setting-cluster">{t('cluster')}</label>
            <input id="setting-cluster" className="form-input" value={settings.cluster} onChange={(e) => update('cluster', e.target.value)} />
          </div>
          <div>
            <label className="form-label" htmlFor="setting-loginNode">{t('loginNodeIP')}</label>
            <input id="setting-loginNode" className="form-input" value={settings.loginNode} onChange={(e) => update('loginNode', e.target.value)} placeholder="e.g. 11.11.10.202" />
          </div>
          <div>
            <label className="form-label" htmlFor="setting-cols">{t('colsLabel')}</label>
            <input id="setting-cols" className="form-input" type="number" min={40} max={500} value={settings.cols} onChange={(e) => update('cols', e.target.value)} />
          </div>
          <div>
            <label className="form-label" htmlFor="setting-rows">{t('rowsLabel')}</label>
            <input id="setting-rows" className="form-input" type="number" min={10} max={200} value={settings.rows} onChange={(e) => update('rows', e.target.value)} />
          </div>
        </div>
        <div style={{ marginTop: '0.75rem' }}>
          <label className="form-label" htmlFor="setting-useRoot">{t('useRoot')}</label>
          <select id="setting-useRoot" className="form-input" value={settings.useRoot} onChange={(e) => update('useRoot', e.target.value)} style={{ width: 'auto' }}>
            <option value="false">false</option>
            <option value="true">true</option>
          </select>
        </div>
      </div>

      {/* Behavior Settings */}
      <div className="card">
        <div className="card-header">
          <span className="card-header-icon"><IconSettings /></span> {t('behavior')}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
          <div className="toggle-wrapper">
            <span className="toggle-label">{t('autoConnect')}</span>
            <label className="toggle-switch">
              <input type="checkbox" checked={settings.autoConnect} onChange={(e) => update('autoConnect', e.target.checked)} />
              <span className="toggle-slider" />
            </label>
          </div>
          <div className="toggle-wrapper">
            <span className="toggle-label">{t('startMinimized')}</span>
            <label className="toggle-switch">
              <input type="checkbox" checked={settings.startMinimized} onChange={(e) => update('startMinimized', e.target.checked)} />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>
      </div>

      {/* Language */}
      <div className="card">
        <div className="card-header">
          <span className="card-header-icon"><IconGlobe /></span> {t('language')}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            className={`btn ${locale === 'en' ? 'btn-primary' : ''}`}
            onClick={() => setLocale('en')}
          >
            English
          </button>
          <button
            className={`btn ${locale === 'zh' ? 'btn-primary' : ''}`}
            onClick={() => setLocale('zh')}
          >
            中文
          </button>
        </div>
      </div>

      {/* SSH Config */}
      <div className="card">
        <div className="card-header">
          <span className="card-header-icon"><IconFileEdit /></span> {t('sshConfig')}
        </div>
        <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '0.85rem', lineHeight: 1.5 }}>
          <>{t('sshConfigHint', settings.sshAlias || 'ustc107')}</>
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.85rem', alignItems: 'end' }}>
          <div style={{ flex: '0 0 180px' }}>
            <label className="form-label" htmlFor="setting-sshAlias">{t('sshAlias')}</label>
            <input id="setting-sshAlias" className="form-input" value={settings.sshAlias || 'ustc107'} onChange={(e) => update('sshAlias', e.target.value)} placeholder="ustc107" />
          </div>
          <button className="btn btn-primary" onClick={handleGenerateSshConfig} disabled={generating}>
            {generating ? t('writing') : t('generateSshConfig')}
          </button>
        </div>
        {sshConfigResult?.success && (
          <div className="code-block" style={{ fontSize: '0.78rem' }}>
            {sshConfigResult.content}
          </div>
        )}
        {sshConfigResult && !sshConfigResult.success && (
          <div style={{ color: 'var(--red)', fontSize: '0.82rem', fontWeight: 500 }}>
            {t('errorPrefix', sshConfigResult.error)}
          </div>
        )}
        {sshConfigResult?.success && (
          <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)', marginTop: '0.5rem' }}>
            {t('writtenTo')} <span className="mono">{sshConfigResult.path}</span>
          </div>
        )}
      </div>

      {/* Save / Reset */}
      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button className="btn btn-primary" onClick={handleSave}>
          {saved ? t('savedLabel') : t('saveSettings')}
        </button>
        <button className="btn" onClick={handleReset}>
          {t('resetDefaults')}
        </button>
      </div>

      {/* About */}
      {runtime && (
        <div className="card">
          <div className="card-header">
            <span className="card-header-icon"><IconInfo /></span> {t('about')}
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
            <div>{t('platform')}: <span className="mono">{runtime.platform}</span></div>
            <div>Electron: <span className="mono">{runtime.electronVersion}</span></div>
            <div>Node.js: <span className="mono">{runtime.nodeVersion}</span></div>
            <div>{t('mode')}: {runtime.devMode ? t('devMode') : t('prodMode')}</div>
            {runtime.logPath && <div style={{ fontSize: '0.75rem', wordBreak: 'break-all' }}>{t('logPath')}: {runtime.logPath}</div>}
          </div>
        </div>
      )}
    </div>
  );
}
