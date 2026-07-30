import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getStatus, getStats,
  startLogin, startProxy, stopProxy,
  onLoginStatus, onProxyStatus, onCookieStatus, onLoginProgress,
  onStatsUpdate,
  copyToClipboard, getSshKeyInfo,
} from '../lib/electron';
import { useToast } from '../components/Toast';
import LoadError from '../components/LoadError';
import { useLocale } from '../i18n/LocaleContext';
import {
  IconKey, IconZap, IconLink, IconGlobe,
  IconActivity, IconClipboard,
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

const LOGIN_PROGRESS_KEYS = {
  navigating: 'openingLoginPage',
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
    port: 3000,
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
  const [statusLoaded, setStatusLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);
  const [copied, setCopied] = useState(false);
  const [sshKeyPath, setSshKeyPath] = useState('');
  const previousLoginStatusRef = useRef(state.loginStatus);
  const previousProxyStatusRef = useRef(state.proxyStatus);
  const pendingActionRef = useRef(null);
  const copyTimerRef = useRef(null);
  const statusFieldVersionsRef = useRef({});
  const statsVersionRef = useRef(0);
  const sshCommand = sshKeyPath
    ? `ssh -o StrictHostKeyChecking=accept-new -i "${sshKeyPath}" -p ${state.port} user@${state.host}`
    : `ssh -o StrictHostKeyChecking=accept-new -p ${state.port} user@${state.host}`;

  const loadDashboard = useCallback(async () => {
    const statusVersionsAtStart = { ...statusFieldVersionsRef.current };
    const statsVersionAtStart = statsVersionRef.current;
    setLoaded(false);
    setStatusLoaded(false);
    setLoadError(false);
    const [statusResult, statsResult, keyResult] = await Promise.allSettled([
      getStatus(),
      getStats(),
      getSshKeyInfo(),
    ]);

    const status = statusResult.status === 'fulfilled' ? statusResult.value : null;
    const nextStats = statsResult.status === 'fulfilled' ? statsResult.value : null;
    const keyInfo = keyResult.status === 'fulfilled' ? keyResult.value : null;

    if (status) {
      setState((prev) => {
        const merged = { ...prev };
        Object.entries(status).forEach(([key, value]) => {
          const currentVersion = statusFieldVersionsRef.current[key] || 0;
          const versionAtStart = statusVersionsAtStart[key] || 0;
          if (currentVersion === versionAtStart) merged[key] = value;
        });
        return merged;
      });
    }
    if (nextStats && statsVersionRef.current === statsVersionAtStart) setStats(nextStats);
    if (keyInfo?.privateKeyPath) setSshKeyPath(keyInfo.privateKeyPath);
    if (!status || !nextStats) setLoadError(true);
    setStatusLoaded(Boolean(status));
    setLoaded(true);
  }, []);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
  }, []);

  useEffect(() => {
    const applyLiveStatus = (patch) => {
      Object.keys(patch).forEach((key) => {
        statusFieldVersionsRef.current[key] = (statusFieldVersionsRef.current[key] || 0) + 1;
      });
      setState((prev) => ({ ...prev, ...patch }));
    };

    const unsubs = [
      onLoginStatus((data) => applyLiveStatus({ loginStatus: data })),
      onProxyStatus((data) => { if (data) applyLiveStatus(data); }),
      onCookieStatus((data) => { if (data) applyLiveStatus(data); }),
      onLoginProgress((data) => {
        const key = LOGIN_PROGRESS_KEYS[data?.status];
        if (key) pushToast('info', t(key));
      }),
      onStatsUpdate((data) => {
        if (!data) return;
        statsVersionRef.current += 1;
        setStats(data);
      }),
    ];
    return () => unsubs.forEach((u) => u?.());
  }, [pushToast, t]);

  useEffect(() => {
    if (!statusLoaded) return;

    if (state.loginStatus !== previousLoginStatusRef.current) {
      if (state.loginStatus === 'sso_done') pushToast('info', t('ssoComplete'), t('openWebSSHPage'));
      if (state.loginStatus === 'success') pushToast('success', t('loggedIn'));
      if (state.loginStatus === 'failure') pushToast('error', t('sessionExpired'), t('reLoginNeeded'));
      previousLoginStatusRef.current = state.loginStatus;
    }

    if (state.proxyStatus !== previousProxyStatusRef.current) {
      if (state.proxyStatus === 'started') pushToast('success', t('proxyRunningToast'), t('listeningOn', state.host, state.port));
      if (state.proxyStatus === 'error') pushToast('error', t('proxyError'), state.error);
      previousProxyStatusRef.current = state.proxyStatus;
    }
  }, [statusLoaded, state.loginStatus, state.proxyStatus, t, pushToast, state.host, state.port, state.error]);

  const handleCopy = useCallback(async () => {
    const ok = await copyToClipboard(sshCommand);
    if (ok === false) {
      pushToast('error', t('copyFailed'));
      return;
    }
    setCopied(true);
    pushToast('info', t('copied'), sshCommand);
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => {
      copyTimerRef.current = null;
      setCopied(false);
    }, 2000);
  }, [pushToast, sshCommand, t]);

  const runAction = useCallback(async (action, fn) => {
    if (pendingActionRef.current !== null) return;
    const actionToken = Symbol(action);
    pendingActionRef.current = actionToken;
    setPendingAction(action);
    try {
      const result = await fn();
      if (result?.ok === false) throw new Error(result.error || t('unknownError'));
    } catch (error) {
      pushToast('error', t('actionFailed'), error?.message || t('unknownError'));
    } finally {
      if (pendingActionRef.current === actionToken) {
        pendingActionRef.current = null;
        setPendingAction(null);
      }
    }
  }, [pushToast, t]);

  const handleStartProxy = useCallback(() => {
    if (pendingActionRef.current !== null) return;
    if (state.proxyStatus === 'error'
      && state.connectionCount > 0
      && !window.confirm(t('confirmStopProxy', state.connectionCount))) return;
    runAction('start', startProxy);
  }, [runAction, state.connectionCount, state.proxyStatus, t]);

  const handleStopProxy = useCallback(() => {
    if (pendingActionRef.current !== null) return;
    if (state.connectionCount > 0 && !window.confirm(t('confirmStopProxy', state.connectionCount))) return;
    runAction('stop', stopProxy);
  }, [runAction, state.connectionCount, t]);

  const [loginStatusKey, loginColor] = LOGIN_META_KEYS[state.loginStatus] || ['unknownStatus', 'yellow'];
  const [proxyStatusKey, proxyColor] = PROXY_META_KEYS[state.proxyStatus] || ['unknownStatus', 'yellow'];
  const canStartProxy = state.loginStatus === 'success'
    && state.cookieValid
    && ['stopped', 'error'].includes(state.proxyStatus);
  const canStopProxy = ['starting', 'started', 'error'].includes(state.proxyStatus);
  const isRunning = state.proxyStatus === 'started';

  if (!loaded) {
    return (
      <div className="dashboard-grid" aria-busy="true" aria-label={t('loadingDashboard')}>
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

  if (loadError) {
    return (
      <LoadError
        title={t('dashboardLoadError')}
        detail={t('loadErrorHint')}
        retryLabel={t('retry')}
        retryingLabel={t('retrying')}
        onRetry={loadDashboard}
      />
    );
  }

  return (
    <div className="dashboard-grid">
      {/* Auth Card */}
      <div className="card">
        <h2 className="card-header">
          <span className="card-header-icon"><IconKey /></span> {t('authentication')}
        </h2>
        <span className={`status-dot ${loginColor}`} style={{ display: 'flex' }} role="status" aria-live="polite">
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
          type="button"
          onClick={() => runAction('login', startLogin)}
          disabled={pendingAction !== null || state.loginStatus === 'pending' || state.loginStatus === 'sso_done'}
        >
          {pendingAction === 'login' ? t('loggingIn') : state.loginStatus === 'success' ? t('reLogin') : t('login')}
        </button>
      </div>

      {/* Proxy Card */}
      <div className="card">
        <h2 className="card-header">
          <span className="card-header-icon"><IconZap /></span> {t('proxyServer')}
        </h2>
        <span className={`status-dot ${proxyColor} mb-2`} style={{ display: 'flex' }} role="status" aria-live="polite">
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
          <button type="button" className="btn btn-primary" onClick={handleStartProxy} disabled={!canStartProxy || pendingAction !== null}>
            {pendingAction === 'start' ? t('starting') : t('start')}
          </button>
          <button type="button" className="btn btn-danger" onClick={handleStopProxy} disabled={!canStopProxy || pendingAction !== null}>
            {pendingAction === 'stop' ? t('stopping') : t('stop')}
          </button>
        </div>
      </div>

      {/* Traffic Stats (wide) */}
      {isRunning && (
        <div className="card dashboard-grid-wide">
          <h2 className="card-header">
            <span className="card-header-icon"><IconActivity /></span> {t('trafficStats')}
          </h2>
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
        <h2 className="card-header">
          <span className="card-header-icon"><IconLink /></span> {t('sshConnection')}
        </h2>
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
        <button type="button" className="btn" onClick={handleCopy}>
          <IconClipboard size={15} />
          {copied ? t('copied') : t('copyCommand')}
        </button>
      </div>

      {/* WSS URL Card (wide) */}
      {state.wssUrl && (
        <div className="card dashboard-grid-wide">
          <h2 className="card-header">
            <span className="card-header-icon"><IconGlobe /></span> {t('wssEndpoint')}
          </h2>
          <div className="code-block" style={{ fontSize: '0.75rem' }}>
            {state.wssUrl}
          </div>
        </div>
      )}

    </div>
  );
}
