import { useState, useEffect, useCallback } from 'react';
import {
  getStatus, getStats,
  startLogin, startProxy, stopProxy,
  onLoginStatus, onProxyStatus, onCookieStatus, onLoginProgress,
  onStatsUpdate,
  copyToClipboard,
} from '../lib/electron';
import { useToast } from '../components/Toast';
import { useLocale } from '../i18n/LocaleContext';
import {
  IconKey, IconZap, IconLink, IconGlobe,
  IconShield, IconActivity, IconClipboard,
} from '../components/Icons';
import { formatBytes, formatUptime } from '../lib/format';

const LOGIN_META_KEYS = {
  idle:     ['notLoggedIn', 'red'],
  pending:  ['loggingIn', 'yellow'],
  sso_done: ['ssoDone', 'yellow'],
  success:  ['loggedIn', 'green'],
  failure:  ['loginFailed', 'red'],
};

const PROXY_META_KEYS = {
  stopped:  ['stopped', 'red'],
  starting: ['starting', 'yellow'],
  started:  ['running', 'green'],
  error:    ['error', 'red'],
};

export default function DashboardView() {
  const pushToast = useToast();
  const { t } = useLocale();

  const [state, setState] = useState({
    loginStatus: 'idle',
    proxyStatus: 'stopped',
    connectionCount: 0,
    cookieValid: false,
    cookieCount: 0,
    host: '127.0.0.1',
    port: 2222,
    wssUrl: '',
    error: null,
  });

  const [stats, setStats] = useState({
    uptimeMs: 0,
    totalBytesSent: 0,
    totalBytesReceived: 0,
    sessionCount: 0,
    sessions: [],
  });

  const [loaded, setLoaded] = useState(false);
  const [copied, setCopied] = useState(false);
  const sshCommand = `ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -p ${state.port} user@${state.host}`;

  useEffect(() => {
    Promise.all([getStatus(), getStats()]).then(([s, st]) => {
      if (s) setState((prev) => ({ ...prev, ...s }));
      if (st) setStats(st);
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    const unsubs = [
      onLoginStatus((data) => setState((prev) => ({ ...prev, loginStatus: data }))),
      onProxyStatus((data) => setState((prev) => ({ ...prev, ...data }))),
      onCookieStatus((data) => setState((prev) => ({ ...prev, ...data }))),
      onLoginProgress((data) => {
        if (data?.message) pushToast('info', data.message);
      }),
      onStatsUpdate((data) => { if (data) setStats(data); }),
    ];
    return () => unsubs.forEach((u) => u?.());
  }, []);

  useEffect(() => {
    if (state.loginStatus === 'sso_done') pushToast('info', t('ssoComplete'), t('openWebSSHPage'));
    if (state.loginStatus === 'success') pushToast('success', t('proxyReady'));
    if (state.loginStatus === 'failure') pushToast('error', t('sessionExpired'), t('reLoginNeeded'));
    if (state.proxyStatus === 'started') pushToast('success', t('proxyRunningToast'), t('listeningOn', state.host, state.port));
    if (state.proxyStatus === 'error') pushToast('error', t('proxyError'), state.error);
  }, [state.loginStatus, state.proxyStatus, t, pushToast, state.host, state.port, state.error]);

  const handleCopy = useCallback(async () => {
    await copyToClipboard(sshCommand);
    setCopied(true);
    pushToast('info', t('copied'), sshCommand);
    setTimeout(() => setCopied(false), 2000);
  }, [sshCommand, t]);

  const [loginStatusKey, loginColor] = LOGIN_META_KEYS[state.loginStatus] || ['unknown', 'yellow'];
  const [proxyStatusKey, proxyColor] = PROXY_META_KEYS[state.proxyStatus] || ['unknown', 'yellow'];
  const canStartProxy = state.loginStatus === 'success' && state.proxyStatus === 'stopped';
  const canStopProxy = state.proxyStatus === 'started';
  const isRunning = state.proxyStatus === 'started';

  if (!loaded) {
    return (
      <div className="dashboard-grid">
        {[1,2,3,4,5,6].map((i) => (
          <div key={i} className="card" style={i === 3 || i === 4 ? { gridColumn: '1 / -1' } : {}}>
            <div className="skeleton skeleton-title" />
            <div className="skeleton skeleton-text" />
            <div className="skeleton skeleton-text" style={{ width: '40%' }} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="dashboard-grid">
      {/* Auth Card */}
      <div className="card">
        <div className="card-header">
          <span className="card-header-icon"><IconKey /></span> {t('authentication')}
        </div>
        <span className={`status-dot ${loginColor}`} style={{ display: 'flex' }}>
          {t(loginStatusKey)}
        </span>
        <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '0.85rem' }}>
          {state.loginStatus === 'sso_done'
            ? t('navigateToWebSSH')
            : state.cookieCount > 0
              ? t('nCookies', state.cookieCount)
              : t('noSessionCookies')}
        </div>
        <button
          className={`btn ${state.loginStatus === 'success' ? '' : 'btn-primary'}`}
          onClick={startLogin}
          disabled={state.loginStatus === 'pending' || state.loginStatus === 'sso_done'}
        >
          {state.loginStatus === 'success' ? t('reLogin') : t('login')}
        </button>
      </div>

      {/* Proxy Card */}
      <div className="card">
        <div className="card-header">
          <span className="card-header-icon"><IconZap /></span> {t('proxyServer')}
        </div>
        <span className={`status-dot ${proxyColor} mb-2`} style={{ display: 'flex' }}>
          {t(proxyStatusKey)}
        </span>
        <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '0.85rem' }}>
          {state.proxyStatus === 'started'
            ? t('nActiveConnections', state.connectionCount)
            : state.proxyStatus === 'starting'
              ? t('initializingSSH')
              : state.proxyStatus === 'error' && state.error
                ? state.error
                : t('notRunning')}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn btn-primary" onClick={startProxy} disabled={!canStartProxy}>
            {t('start')}
          </button>
          <button className="btn btn-danger" onClick={stopProxy} disabled={!canStopProxy}>
            {t('stop')}
          </button>
        </div>
      </div>

      {/* Traffic Stats (wide) */}
      {isRunning && (
        <div className="card dashboard-grid-wide">
          <div className="card-header">
            <span className="card-header-icon"><IconActivity /></span> {t('trafficStats')}
          </div>
          <div className="stats-row">
            <div className="stat-card">
              <div className="stat-card-value">{formatUptime(stats.uptimeMs)}</div>
              <div className="stat-card-label">{t('uptime')}</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-value">{formatBytes(stats.totalBytesSent)}</div>
              <div className="stat-card-label">{t('sent')}</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-value">{formatBytes(stats.totalBytesReceived)}</div>
              <div className="stat-card-label">{t('received')}</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-value">{stats.sessionCount}</div>
              <div className="stat-card-label">{t('activeSessions')}</div>
            </div>
          </div>
        </div>
      )}

      {/* SSH Command Card (wide) */}
      <div className="card dashboard-grid-wide">
        <div className="card-header">
          <span className="card-header-icon"><IconLink /></span> {t('sshConnection')}
        </div>
        <code style={{
          fontSize: '1.5rem',
          fontFamily: 'var(--font-mono)',
          color: 'var(--accent)',
          fontWeight: 600,
          display: 'block',
          marginBottom: '0.5rem',
        }}>
          {state.host}:{state.port}
        </code>
        <div className="code-block" style={{ marginBottom: '0.75rem' }}>
          {sshCommand}
        </div>
        <button className="btn" onClick={handleCopy}>
          <IconClipboard size={15} />
          {copied ? t('copied') : t('copyCommand')}
        </button>
      </div>

      {/* WSS URL Card (wide) */}
      {state.wssUrl && (
        <div className="card dashboard-grid-wide">
          <div className="card-header">
            <span className="card-header-icon"><IconGlobe /></span> {t('wssEndpoint')}
          </div>
          <div className="code-block" style={{ fontSize: '0.75rem' }}>
            {state.wssUrl}
          </div>
        </div>
      )}

      {/* Status Summary */}
      <div className="card">
        <div className="card-header">
          <span className="card-header-icon"><IconShield /></span> {t('cookies')}
        </div>
        <div style={{ fontSize: '1.5rem', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--accent)' }}>
          {state.cookieCount}
        </div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
          {state.cookieValid ? t('sessionValid') : t('noValidSession')}
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-header-icon"><IconActivity /></span> {t('connections')}
        </div>
        <div style={{ fontSize: '1.5rem', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--accent)' }}>
          {state.connectionCount}
        </div>
        <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
          {t('activeSSHSessions')}
        </div>
      </div>
    </div>
  );
}
