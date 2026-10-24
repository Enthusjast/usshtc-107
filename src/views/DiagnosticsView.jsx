import { useCallback, useEffect, useRef, useState } from 'react';
import { startDiagnostics, cancelDiagnostics, getDiagnostics, onDiagnosticsState, exportDiagnostics, startLogin, ApiError } from '../lib/electron';
import { formatApiError } from '../lib/api-errors';
import { useRuntime, sameScope } from '../contexts/RuntimeContext';
import { useLocale } from '../i18n/LocaleContext';
import { useToast } from '../components/Toast';
import { IconActivity, IconSettings, IconKey, IconFileEdit, IconInfo } from '../components/Icons';

const CHECK_IDS = ['settings', 'keys', 'ssh-config', 'local-listener', 'dns', 'tls', 'token', 'setup', 'wss', 'remote-command'];
const CHECK_STATUSES = new Set(['pending', 'running', 'passed', 'failed', 'skipped']);
export const DIAGNOSTIC_CODES = new Set([
  'SETTINGS_OK', 'SETTINGS_INVALID', 'SETTINGS_LOCKED', 'KEYS_OK', 'SSH_KEY_MISSING', 'SSH_KEY_INVALID',
  'SSH_KEY_PERMISSIONS', 'SSH_KEY_FINGERPRINT_MISMATCH', 'SSH_CONFIG_OK', 'SSH_CONFIG_MISSING',
  'SSH_CONFIG_MISMATCH', 'SSH_ALIAS_CONFLICT', 'SSH_CONFIG_INVALID', 'LOCAL_SSH_OK', 'LOCAL_PORT_AVAILABLE',
  'PORT_IN_USE', 'LOCAL_SSH_FAILED', 'DNS_OK', 'DNS_FAILED', 'TLS_OK', 'TLS_FAILED', 'WSS_SHELL_READY',
  'AUTH_REQUIRED', 'WSS_FAILED', 'NETWORK_UNAVAILABLE', 'TIMEOUT', 'CANCELLED', 'DEPENDENCY_FAILED', 'DIAGNOSTIC_DEADLINE',
  'REMOTE_READY_TIMEOUT', 'REMOTE_COMMAND_OK', 'REMOTE_COMMAND_FAILED',
  'TOKEN_OK', 'SETUP_OK', 'PORTAL_NETWORK', 'PORTAL_TIMEOUT', 'PORTAL_PERMISSION', 'PORTAL_NOT_FOUND',
  'PORTAL_UNIMPLEMENTED', 'PORTAL_QUOTA', 'PORTAL_UNKNOWN',
]);
const CONFIG_FIELDS = ['host', 'port', 'cluster', 'loginNode', 'cols', 'rows', 'useRoot', 'path', 'startupCommand', 'wssUrl', 'sshAlias'];
export const diagnosticIdentity = (snapshot, scope) => JSON.stringify([scope?.profileId, scope?.epoch,
  snapshot?.loginStatus, snapshot?.cookieValid, ...CONFIG_FIELDS.map((key) => snapshot?.desiredConfig?.[key])]);
const isCancellation = (error) => error?.code === 'CANCELLED' || error?.code === 'OPERATION_CANCELLED';
const statusRank = (status) => status === 'pending' ? 0 : status === 'running' ? 1 : 2;

export default function DiagnosticsView({ onNavigate, setupMode = false, onRunChange, onBusyChange }) {
  const { snapshot, scope, runAction, getScope } = useRuntime();
  const { t } = useLocale();
  const pushToast = useToast();
  // This key invalidates local work; the authoritative fingerprint is computed only in main.
  const identity = diagnosticIdentity(snapshot, scope);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const latest = useRef(null);
  const blockedRuns = useRef(new Set());
  const request = useRef(0);
  const contextGeneration = useRef(0);
  const eventVersion = useRef(0);
  const startingRef = useRef(false);
  const [state, setState] = useState({ identity, run: null, loading: true, error: null });
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelledRunId, setCancelledRunId] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [actionError, setActionError] = useState(null);
  const current = state.identity === identity ? state : { run: null, loading: true, error: null };
  const run = current.run;
  const active = Boolean(run && !run.finishedAt && run.runId !== cancelledRunId);
  useEffect(() => { onRunChange?.({ identity, run: run?.runId === cancelledRunId ? null : run }); }, [identity, run, cancelledRunId, onRunChange]);
  useEffect(() => { onBusyChange?.(starting || active || cancelling); }, [starting, active, cancelling, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  const rememberBlocked = useCallback((runId) => {
    if (!runId) return;
    blockedRuns.current.add(runId);
    if (blockedRuns.current.size > 100) blockedRuns.current.delete(blockedRuns.current.values().next().value);
  }, []);

  const accept = useCallback((value) => {
    if (currentIdentity.current !== identity) return;
    if (value === null) {
      if (!latest.current) setState({ identity, run: null, loading: false, error: null });
      return;
    }
    if (!sameScope(value, scope)) return;
    if (value.invalidated === true) {
      rememberBlocked(latest.current?.runId);
      latest.current = null;
      request.current += 1;
      contextGeneration.current += 1;
      startingRef.current = false;
      setStarting(false);
      setCancelling(false);
      setExporting(false);
      setLoggingIn(false);
      setCancelledRunId(null);
      setActionError(null);
      setState({ identity, run: null, loading: false, error: null });
      return;
    }
    if (typeof value.runId !== 'string' || typeof value.configFingerprint !== 'string' || !Array.isArray(value.checks)
      || blockedRuns.current.has(value.runId)) return;
    const previous = latest.current;
    if (previous?.runId === value.runId) {
      if (previous.finishedAt && !value.finishedAt) return;
      if (previous.checks.some((check) => {
        const next = value.checks.find((item) => item.id === check.id);
        return next && statusRank(next.status) < statusRank(check.status);
      })) return;
    } else if (previous) {
      if (Date.parse(value.startedAt) < Date.parse(previous.startedAt)) return;
      rememberBlocked(previous.runId);
    }
    latest.current = value;
    setState({ identity, run: value, loading: false, error: null });
  }, [identity, scope, rememberBlocked]);

  const load = useCallback(async () => {
    if (!scope) return;
    const id = ++request.current;
    const version = eventVersion.current;
    setState((previous) => ({ ...previous, identity, loading: true, error: null }));
    try {
      const value = await getDiagnostics(scope);
      if (currentIdentity.current !== identity || request.current !== id || eventVersion.current !== version) return;
      if (value !== null && (!sameScope(value, scope) || typeof value.runId !== 'string' || typeof value.configFingerprint !== 'string' || !Array.isArray(value.checks))) throw new ApiError('API_UNAVAILABLE');
      accept(value);
    } catch (error) {
      if (currentIdentity.current === identity && request.current === id && eventVersion.current === version) {
        setState((previous) => ({ ...previous, identity, loading: false, error }));
      }
    }
  }, [identity, scope, accept]);

  useEffect(() => {
    currentIdentity.current = identity;
    contextGeneration.current += 1;
    rememberBlocked(latest.current?.runId);
    latest.current = null;
    eventVersion.current = 0;
    startingRef.current = false;
    setStarting(false);
    setCancelling(false);
    setExporting(false);
    setLoggingIn(false);
    setCancelledRunId(null);
    setActionError(null);
    setState({ identity, run: null, loading: true, error: null });
    let unsubscribe;
    try {
      // Subscribe before reading so progress cannot be lost or overwritten by an older getter.
      unsubscribe = onDiagnosticsState((value) => {
        if (currentIdentity.current !== identity || !sameScope(value, scope)) return;
        eventVersion.current += 1;
        accept(value);
      });
      void load();
    } catch (error) { setState({ identity, run: null, loading: false, error }); }
    return () => {
      request.current += 1;
      if (currentIdentity.current === identity) currentIdentity.current = null;
      unsubscribe?.();
    };
  }, [identity, scope, accept, load, rememberBlocked]);

  const handleStart = async () => {
    if (!scope || startingRef.current || active) return;
    const id = ++request.current;
    startingRef.current = true;
    setStarting(true);
    setCancelledRunId(null);
    setActionError(null);
    try {
      // A diagnostic run never takes RuntimeContext's exclusive application action slot.
      const value = await startDiagnostics(scope);
      if (currentIdentity.current === identity && request.current === id && !value?.cancelled) accept(value);
    } catch (error) {
      if (currentIdentity.current === identity && request.current === id && !isCancellation(error)) setActionError({ error, kind: 'start' });
    } finally {
      if (currentIdentity.current === identity && request.current === id) {
        startingRef.current = false;
        setStarting(false);
      }
    }
  };
  const handleCancel = async () => {
    if (!run || cancelling) return;
    const generation = contextGeneration.current;
    setCancelling(true);
    setActionError(null);
    try {
      await cancelDiagnostics({ scope, runId: run.runId });
      if (currentIdentity.current === identity && contextGeneration.current === generation) setCancelledRunId(run.runId);
    } catch (error) {
      if (currentIdentity.current === identity && contextGeneration.current === generation && !isCancellation(error)) setActionError({ error, kind: 'cancel' });
    } finally { if (currentIdentity.current === identity && contextGeneration.current === generation) setCancelling(false); }
  };
  const handleExport = async () => {
    const generation = contextGeneration.current;
    setExporting(true);
    setActionError(null);
    try {
      const result = await exportDiagnostics(scope);
      if (currentIdentity.current === identity && contextGeneration.current === generation && !result?.cancelled) pushToast('success', t('diagnosticsExported'));
    } catch (error) { if (currentIdentity.current === identity && contextGeneration.current === generation) setActionError({ error, kind: 'export' }); }
    finally { if (currentIdentity.current === identity && contextGeneration.current === generation) setExporting(false); }
  };
  const handleLogin = async () => {
    const generation = contextGeneration.current;
    setLoggingIn(true);
    setActionError(null);
    try { await runAction(startLogin, scope); }
    catch (error) {
      if (currentIdentity.current === identity && contextGeneration.current === generation && sameScope(getScope(), scope) && !isCancellation(error)) setActionError({ error, kind: 'login' });
    } finally { if (currentIdentity.current === identity && contextGeneration.current === generation) setLoggingIn(false); }
  };
  const completed = run?.checks.filter((check) => check.status === 'passed' || check.status === 'failed' || check.status === 'skipped').length ?? 0;

  return (
    <div className="diagnostics-view">
      <section className="card" aria-labelledby="diagnostics-heading">
        <h2 id="diagnostics-heading" className="card-header"><span className="card-header-icon" aria-hidden="true"><IconActivity /></span>{t('connectionDiagnostics')}</h2>
        <p className="settings-help">{t('diagnosticsDescription')}</p>
        <p className="diagnostics-proof"><span aria-hidden="true"><IconInfo size={18} /></span>{t('diagnosticsProofScope')}</p>
        <div className="diagnostics-actions">
          <button type="button" className="btn btn-primary" onClick={handleStart} disabled={!scope || current.loading || starting || active}>{starting || active ? t('diagnosticsRunning') : run ? t('diagnosticsRerun') : t('diagnosticsStart')}</button>
          {(starting || active) && <button type="button" className="btn" onClick={handleCancel} disabled={!active || cancelling}>{cancelling ? t('diagnosticsCancelling') : t('diagnosticsCancel')}</button>}
          {!setupMode && <button type="button" className="btn" onClick={handleExport} disabled={!scope || exporting}>{exporting ? t('exporting') : t('exportDiagnostics')}</button>}
        </div>
        {!setupMode && <p className="settings-help">{t('diagnosticsPackageScope')}</p>}
        {current.loading && <p role="status">{t('diagnosticsLoading')}</p>}
        {current.error && <div role="alert" className="diagnostics-error">{formatApiError(current.error, t)} <button type="button" className="btn" onClick={load}>{t('retry')}</button></div>}
        {actionError && <div role="alert" className="diagnostics-error">{formatApiError(actionError.error, t)} <button type="button" className="btn" disabled={exporting || cancelling || loggingIn || (actionError.kind === 'start' && (starting || active))} onClick={() => { void ({ start: handleStart, cancel: handleCancel, export: handleExport, login: handleLogin })[actionError.kind](); }}>{t('retry')}</button></div>}
        {run ? <>
          <p role="status" aria-live="polite">{run.runId === cancelledRunId || run.checks.some((check) => check.code === 'CANCELLED') ? t('diagnosticsCancelled') : run.finishedAt ? t('diagnosticsFinished') : t('diagnosticsProgress', completed, CHECK_IDS.length)}</p>
          <progress className="diagnostics-progress" max={CHECK_IDS.length} value={completed} aria-label={t('diagnosticsProgress', completed, CHECK_IDS.length)} />
        </> : !current.loading && !current.error && <p className="settings-help">{t('diagnosticsEmpty')}</p>}
        <ol className="diagnostics-checks" aria-label={t('diagnosticsChecks')}>
          {CHECK_IDS.map((id) => {
            const check = run?.checks.find((item) => item.id === id);
            const status = CHECK_STATUSES.has(check?.status) ? check.status : 'pending';
            return <li className="diagnostics-check" key={id}>
              <div className="diagnostics-check-title"><h3>{t(`diagnosticsCheck_${id}`)}</h3><span className={`diagnostics-status diagnostics-status-${status}`}>{t(`diagnosticsStatus_${status}`)}</span></div>
              <div className="diagnostics-check-detail"><span>{check?.code ? DIAGNOSTIC_CODES.has(check.code) ? t(`diagnostic_${check.code}`) : t('unknownError') : t('diagnosticsWaiting')}</span><span className="mono">{Number.isFinite(check?.durationMs) && check.durationMs >= 0 ? t('diagnosticsDuration', Math.round(check.durationMs)) : t('diagnosticsDurationPending')}</span></div>
              {id === 'local-listener' && (check?.mode === 'ssh-auth' || check?.mode === 'bind-only') && <p className="settings-help">{t(check.mode === 'ssh-auth' ? 'diagnosticsSshAuthMode' : 'diagnosticsBindOnlyMode')}</p>}
            </li>;
          })}
        </ol>
      </section>
      {!setupMode && <section className="card" aria-labelledby="diagnostics-actions-heading">
        <h2 id="diagnostics-actions-heading" className="card-header">{t('diagnosticsNextSteps')}</h2>
        <div className="diagnostics-actions">
          <button type="button" className="btn" onClick={() => onNavigate?.('settings')}><span aria-hidden="true"><IconSettings size={16} /></span>{t('diagnosticsOpenSettings')}</button>
          <button type="button" className="btn" onClick={handleLogin} disabled={!scope || loggingIn || Boolean(snapshot?.operation) || Boolean(snapshot?.storageErrorCode)}><span aria-hidden="true"><IconKey size={16} /></span>{loggingIn ? t('loggingIn') : t('reLogin')}</button>
          <button type="button" className="btn" onClick={() => onNavigate?.('settings', 'ssh-config')}><span aria-hidden="true"><IconFileEdit size={16} /></span>{t('diagnosticsReviewConfig')}</button>
        </div>
        <p className="settings-help">{t('diagnosticsSafeActions')}</p>
      </section>}
    </div>
  );
}
