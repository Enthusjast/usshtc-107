import { formatApiError } from '../lib/api-errors';
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  startLogin, startProxy, stopProxy,
  copyToClipboard, getSshKeyInfo, retryRecovery,
} from '../lib/electron';
import { useToast } from '../components/Toast';
import LoadError from '../components/LoadError';
import TrafficTrend from '../components/TrafficTrend';
import SetupResume from '../components/SetupResume';
import { useLocale } from '../i18n/LocaleContext';
import {
  IconKey, IconZap, IconLink, IconGlobe,
  IconActivity, IconClipboard,
} from '../components/Icons';
import { formatBytes, formatUptime } from '../lib/format';
import { useRuntime, sameScope } from '../contexts/RuntimeContext';

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
  stopping: ['stopping', 'yellow'],
  error:    ['error', 'red'],
};

const REMOTE_STATUS_KEYS = {
  unknown: 'remoteStatusUnknown', checking: 'remoteStatusChecking', reachable: 'remoteStatusReachable',
  offline: 'remoteStatusOffline', auth_required: 'remoteStatusAuthRequired', error: 'remoteStatusError',
};


export default function DashboardView({ onNavigate }) {
  const pushToast = useToast();
  const { t } = useLocale();

  const { snapshot, scope, getScope, loading, error, retry, flushDraft, stats, rates, ratePoints, statsLoading, statsError, retryStats } = useRuntime();
  const config = snapshot?.runningConfig ?? snapshot?.desiredConfig;
  const state = { ...snapshot, ...config, error: snapshot?.errorCode };


  const loaded = !loading && Boolean(snapshot);
  const statusLoaded = Boolean(snapshot);
  const loadError = Boolean(error);
  const [pendingAction, setPendingAction] = useState(null);
  const [copied, setCopied] = useState(false);
  const [sshKeyPath, setSshKeyPath] = useState('');
  const previousLoginStatusRef = useRef(state.loginStatus);
  const previousProxyStatusRef = useRef(state.proxyStatus);
  const pendingActionRef = useRef(null);
  const copyTimerRef = useRef(null);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const [recoveryError, setRecoveryError] = useState(null);
  const recoveryRequest = useRef(null);
  const activeScope = useRef(scope);
  activeScope.current = scope;

  useEffect(() => {
    setRecoveryPending(false);
    setRecoveryError(null);
    return () => { recoveryRequest.current = null; };
  }, [scope?.profileId, scope?.epoch]);

  const handleRecoveryRetry = async () => {
    if (recoveryRequest.current || snapshot?.storageErrorCode || snapshot?.operation || snapshot?.remoteStatus === 'checking' || snapshot?.remoteStatus === 'auth_required') return;
    const token = { scope };
    recoveryRequest.current = token;
    const accepts = () => recoveryRequest.current === token && sameScope(getScope?.() ?? activeScope.current, token.scope);
    setRecoveryPending(true);
    setRecoveryError(null);
    try {
      await flushDraft();
      if (!accepts()) return;
      await retryRecovery(token.scope);
    } catch (failure) {
      if (accepts() && failure?.code !== 'OPERATION_CANCELLED') setRecoveryError(failure);
    } finally {
      if (accepts()) { recoveryRequest.current = null; setRecoveryPending(false); }
    }
  };
  const targetHost = state.host === '0.0.0.0' ? '127.0.0.1' : state.host === '::' ? '::1' : state.host;
  const sshHost = targetHost?.includes(':') ? `[${targetHost}]` : targetHost;
  const sshCommand = sshKeyPath
    ? `ssh -o StrictHostKeyChecking=accept-new -i "${sshKeyPath}" -p ${state.port} user@${sshHost}`
    : `ssh -o StrictHostKeyChecking=accept-new -p ${state.port} user@${sshHost}`;

  const loadDashboard = retry;
  useEffect(() => {
    let active = true;
    setSshKeyPath('');
    if (!scope) return () => { active = false; };
    getSshKeyInfo(scope).then((value) => {
      if (active && sameScope(scope, getScope())) setSshKeyPath(value.scope === 'application' && value.client?.state === 'ready' ? value.client.privateKeyPath || '' : '');
    }).catch(() => {});
    return () => { active = false; };
  }, [scope]);

  useEffect(() => () => {
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
  }, []);


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
      if (state.proxyStatus === 'error') pushToast('error', t('proxyError'), formatApiError({ code: state.error }, t));
      previousProxyStatusRef.current = state.proxyStatus;
    }
  }, [statusLoaded, state.loginStatus, state.proxyStatus, t, pushToast, state.host, state.port, state.error]);

  const handleCopy = useCallback(async () => {
    try {
      await copyToClipboard(sshCommand);
    } catch (error) {
      pushToast('error', t('copyFailed'), formatApiError(error, t));
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
    if (snapshot?.storageErrorCode && action !== 'stop') return;
    if (pendingActionRef.current !== null && !(action === 'stop' && pendingActionRef.current.action === 'start')) return;
    const actionToken = { action };
    pendingActionRef.current = actionToken;
    setPendingAction(action);
    try {
      await flushDraft();
      await fn(scope);

    } catch (error) {
      if (error?.code !== 'OPERATION_CANCELLED') pushToast('error', t('actionFailed'), formatApiError(error, t));
    } finally {
      if (pendingActionRef.current === actionToken) {
        pendingActionRef.current = null;
        setPendingAction(null);
      }
    }
  }, [pushToast, t, flushDraft, scope, snapshot?.storageErrorCode]);

  const handleStartProxy = useCallback(() => runAction('start', startProxy), [runAction]);
  const handleStopProxy = useCallback(() => runAction('stop', stopProxy), [runAction]);

  const [loginStatusKey, loginColor] = LOGIN_META_KEYS[state.loginStatus] || ['unknownStatus', 'yellow'];
  const [proxyStatusKey, proxyColor] = PROXY_META_KEYS[state.proxyStatus] || ['unknownStatus', 'yellow'];
  const canStartProxy = state.loginStatus === 'success'
    && state.cookieValid
    && !state.storageErrorCode && !state.operation && ['stopped', 'error'].includes(state.proxyStatus);
  const canStopProxy = ['starting', 'started', 'error'].includes(state.proxyStatus);
  const isRunning = state.proxyStatus === 'started';

  if (!loaded && !loadError) {
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
      <SetupResume onNavigate={onNavigate} />
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
          {state.loginStage && <p role="status">{t(state.loginStage === 'opening' ? 'openingLoginPage' : state.loginStage === 'sso' ? 'loggingIn' : 'openWebSSHPage')}</p>}
        </div>
        <button
          className={`btn ${state.loginStatus === 'success' ? '' : 'btn-primary'}`}
          type="button"
          onClick={() => runAction('login', startLogin)}
          disabled={Boolean(state.storageErrorCode) || pendingAction !== null || Boolean(state.operation) || state.loginStatus === 'pending' || state.loginStatus === 'sso_done'}
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
                ? formatApiError({ code: state.error }, t)
                : t('notRunning')}
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button type="button" className="btn btn-primary" onClick={handleStartProxy} disabled={!canStartProxy || pendingAction !== null}>
            {pendingAction === 'start' ? t('starting') : t('start')}
          </button>
          <button type="button" className="btn btn-danger" onClick={handleStopProxy} disabled={!canStopProxy || (pendingAction !== null && pendingAction !== 'start')}>
            {pendingAction === 'stop' ? t('stopping') : t('stop')}
          </button>
        </div>
      </div>

      <section className="card dashboard-grid-wide network-recovery" aria-labelledby="recovery-heading" aria-busy={recoveryPending || state.remoteStatus === 'checking'}>
        <h2 id="recovery-heading" className="card-header">
          <span className="card-header-icon" aria-hidden="true"><IconGlobe /></span> {t('networkRecovery')}
        </h2>
        <p role="status">{t(REMOTE_STATUS_KEYS[state.remoteStatus] ?? 'remoteStatusUnknown')}</p>
        <p className="settings-help">{t(state.desiredRunning ? 'recoveryDesiredRunning' : 'recoveryStoppedByUser')}</p>
        {state.remoteStatus === 'auth_required' && <p className="settings-warning">{t('recoveryLoginRequired')}</p>}
        {(recoveryError || (['offline', 'error'].includes(state.remoteStatus) && state.error)) && <p className="field-error" role="alert">{formatApiError(recoveryError ?? { code: state.error }, t)}</p>}
        <button type="button" className="btn" disabled={recoveryPending || state.remoteStatus === 'checking' || state.remoteStatus === 'auth_required' || Boolean(state.storageErrorCode) || Boolean(state.operation)} onClick={() => { void handleRecoveryRetry(); }}>
          {t(recoveryPending || state.remoteStatus === 'checking' ? 'recoveryChecking' : 'recoveryRetry')}
        </button>
        <p className="settings-help">{t('recoveryProofScope')}</p>
        <p className="settings-help">{t('recoveryReconnectClients')}</p>
      </section>

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
          {statsLoading && <p role="status">{t('loadingTraffic')}</p>}
          {statsError && <div role="alert">{formatApiError(statsError, t)} <button type="button" className="btn" onClick={retryStats}>{t('retry')}</button></div>}
          <TrafficTrend rates={rates} points={ratePoints} />
        </div>
      )}

      {/* SSH Command Card (wide) */}
      <div className="card dashboard-grid-wide">
        <h2 className="card-header">
          <span className="card-header-icon"><IconLink /></span> {t('sshConnection')}
        </h2>
        {!isRunning && <p>{t('nextStartConfig')}</p>}
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
