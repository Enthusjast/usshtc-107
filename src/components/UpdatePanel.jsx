import { useEffect } from 'react';
import { useUpdates, UPDATE_BUSY_PHASES } from '../contexts/UpdateContext';
import { useLocale } from '../i18n/LocaleContext';
import { formatApiError } from '../lib/api-errors';
import { formatBytes } from '../lib/format';
import { IconInfo } from './Icons';

const RESTART_ERRORS = new Set(['UPDATE_INSTALL_FAILED', 'UPDATE_RESTART_REQUIRED']);
const INSTALL_RETRY_ERRORS = new Set(['UPDATE_PREPARATION_FAILED', 'AUTOSTART_UPDATE_FAILED']);

export default function UpdatePanel({ disabled = false, onBusyChange, onConsumedDraft }) {
  const { state, loading, error, actionError, pending, retry, check, download, install, openRelease } = useUpdates();
  const { t } = useLocale();
  const busy = Boolean(pending) || UPDATE_BUSY_PHASES.has(state?.phase);
  const failure = error || actionError || (state?.errorCode ? { code: state.errorCode } : null);
  const restartRequired = RESTART_ERRORS.has(state?.errorCode) || RESTART_ERRORS.has(actionError?.code);
  const candidate = state?.availableVersion;
  const inApp = state?.installMode === 'in-app';
  const supported = state && state.installMode !== 'unsupported';
  const canInstall = inApp && candidate && !restartRequired && (state.phase === 'downloaded' || (state.phase === 'error' && INSTALL_RETRY_ERRORS.has(state.errorCode)));
  const canDownload = inApp && candidate && !restartRequired && (state.phase === 'available' || (state.phase === 'error' && !INSTALL_RETRY_ERRORS.has(state.errorCode)));
  const frozenCandidate = ['downloading', 'downloaded', 'staging', 'installing'].includes(state?.phase) || canInstall;
  const blocked = disabled || busy || loading || Boolean(error);

  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  const act = async (action) => {
    try { await action(); }
    catch { /* The global context retains the fixed API error for this panel. */ }
  };
  const handleInstall = () => act(async () => {
    // Capture this button's candidate before any asynchronous draft flush. Main
    // performs the sole native confirmation and rejects stale candidates.
    const result = await install(candidate);
    if (!result?.cancelled) await onConsumedDraft?.(result);
  });

  return <section className="card update-panel" aria-labelledby="updates-heading" aria-busy={busy || loading}>
    <h2 id="updates-heading" className="card-header" tabIndex={-1}><span className="card-header-icon" aria-hidden="true"><IconInfo /></span> {t('updates')}</h2>
    <p className="settings-help">{t('updatePolicy')}</p>
    {loading && <p role="status">{t('updateLoading')}</p>}
    {state && <>
      <dl className="update-details">
        <div><dt>{t('updateCurrentVersion')}</dt><dd className="mono">{state.currentVersion}</dd></div>
        {candidate && <div><dt>{t('updateAvailableVersion')}</dt><dd className="mono">{candidate}</dd></div>}
        {state.checkedAt && <div><dt>{t('updateLastChecked')}</dt><dd>{new Date(state.checkedAt).toLocaleString()}</dd></div>}
        {state.releaseDate && <div><dt>{t('updateReleaseDate')}</dt><dd>{new Date(state.releaseDate).toLocaleDateString()}</dd></div>}
      </dl>
      <p role="status">{t(`updatePhase_${state.phase}`)}</p>
      {state.installMode !== 'in-app' && <p className="settings-help">{t(state.installMode === 'manual' ? 'updateManualOnly' : 'updateUnsupported')}</p>}
      {state.progress && <div className="update-progress">
        <progress aria-label={t('updateDownloadProgress')} max="100" value={state.progress.percent} />
        <span>{t('updateProgress', Math.round(state.progress.percent), formatBytes(state.progress.transferred), formatBytes(state.progress.total), formatBytes(state.progress.bytesPerSecond))}</span>
      </div>}
      {state.releaseNotes && <details className="update-release-notes"><summary>{t('updateReleaseNotes')}</summary><pre>{state.releaseNotes}</pre></details>}
    </>}
    {failure && <div className="field-error" role="alert">{formatApiError(failure, t)}</div>}
    {restartRequired && <p className="settings-warning" role="status">{t('updateRestartRequiredHint')}</p>}
    <div className="update-actions">
      {error && <button type="button" className="btn" disabled={busy || loading} onClick={() => { void retry(); }}>{t('retry')}</button>}
      <button type="button" className="btn" disabled={blocked || !supported || frozenCandidate || restartRequired} onClick={() => { void act(check); }}>{t('updateCheckNow')}</button>
      {canDownload && <button type="button" className="btn btn-primary" disabled={blocked} onClick={() => { void act(() => download(candidate)); }}>{t(state.phase === 'error' ? 'updateRetryDownload' : 'updateDownload')}</button>}
      {canInstall && <button type="button" className="btn btn-primary" disabled={blocked} onClick={handleInstall}>{t('updateInstallRestart')}</button>}
      <button type="button" className="btn" disabled={busy || loading || !state} onClick={() => { void act(openRelease); }}>{t('updateOpenRelease')}</button>
    </div>
    {pending && <p role="status">{t(`updatePending_${pending}`)}</p>}
  </section>;
}
