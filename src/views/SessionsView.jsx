import { useState, useEffect, useCallback, useRef } from 'react';
import { getHistory, clearHistory, disconnectSession, ApiError } from '../lib/electron';
import { formatApiError } from '../lib/api-errors';
import { useToast } from '../components/Toast';
import LoadError from '../components/LoadError';
import TrafficTrend from '../components/TrafficTrend';
import { useLocale } from '../i18n/LocaleContext';
import { IconTerminal } from '../components/Icons';
import { formatBytes, formatDuration, formatTime } from '../lib/format';
import { aggregateHistory } from '../lib/traffic';
import { useRuntime, sameScope } from '../contexts/RuntimeContext';

export default function SessionsView() {
  const pushToast = useToast();
  const { t, locale } = useLocale();
  const { snapshot, scope, getScope, runAction, stats, rates, ratePoints, statsLoading, statsError, retryStats } = useRuntime();
  const sessions = stats.sessions;
  const [section, setSection] = useState('active');
  const [days, setDays] = useState(7);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(null);
  const [clearing, setClearing] = useState(false);
  const [disconnectingIds, setDisconnectingIds] = useState(() => new Set());
  const requestRef = useRef(0);
  const historyRevision = useRef(-1);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; requestRef.current += 1; }; }, []);

  const loadHistory = useCallback(async (origin = scope) => {
    if (!origin) return;
    const request = ++requestRef.current;
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const response = await getHistory({ scope: origin, days });
      if (!alive.current || request !== requestRef.current || !sameScope(origin, getScope())) return;
      if (!sameScope(response, origin) || !Number.isSafeInteger(response.revision) || !Array.isArray(response.sessions)) throw new ApiError('HISTORY_INVALID');
      if (response.revision < historyRevision.current) return;
      historyRevision.current = response.revision;
      setHistory(response.sessions.filter((session) => session.profileId === origin.profileId));
      setHistoryError(response.errorCode ? { code: response.errorCode } : null);
    } catch (error) {
      if (alive.current && request === requestRef.current && sameScope(origin, getScope())) setHistoryError(error);
    } finally {
      if (alive.current && request === requestRef.current && sameScope(origin, getScope())) setHistoryLoading(false);
    }
  }, [scope, days, getScope]);

  useEffect(() => {
    requestRef.current += 1;
    historyRevision.current = -1;
    setHistory([]);
    setHistoryError(null);
    setHistoryLoading(false);
    setDisconnectingIds(new Set());
    if (section === 'history') void loadHistory();
    return () => { requestRef.current += 1; };
  }, [loadHistory, section]);

  useEffect(() => {
    setDisconnectingIds((previous) => new Set([...previous].filter((id) => sessions.some((session) => session.id === id))));
  }, [sessions]);

  const handleDisconnect = async (session) => {
    const origin = scope;
    setDisconnectingIds((previous) => new Set(previous).add(session.id));
    try {
      await runAction((current) => disconnectSession({ scope: current, sessionId: session.id }), origin);
    } catch (error) {
      if (sameScope(origin, getScope())) pushToast('error', t('disconnectFailed'), formatApiError(error, t));
    } finally {
      if (alive.current && sameScope(origin, getScope())) setDisconnectingIds((previous) => { const next = new Set(previous); next.delete(session.id); return next; });
    }
  };

  const handleClear = async () => {
    if (clearing) return;
    const origin = scope;
    setClearing(true);
    try {
      const result = await runAction(clearHistory, origin);
      if (!alive.current || origin.profileId !== getScope()?.profileId || result?.cancelled) return;
      // Stopping sessions may advance the epoch; reload only after main finishes clearing.
      await loadHistory(getScope());
    } catch (error) {
      if (alive.current && origin.profileId === getScope()?.profileId) setHistoryError(error);
    } finally { if (alive.current) setClearing(false); }
  };

  const daily = aggregateHistory(history);
  const dateLabel = (day) => new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
  const timestampLabel = (value) => value ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : t('historyStillActive');
  const now = Date.now();

  return <div className="sessions-view">
    <div className="session-segments" role="group" aria-label={t('sessionSections')}>
      <button type="button" className={`btn ${section === 'active' ? 'btn-primary' : ''}`} aria-pressed={section === 'active'} onClick={() => setSection('active')}>{t('activeSessions')}</button>
      <button type="button" className={`btn ${section === 'history' ? 'btn-primary' : ''}`} aria-pressed={section === 'history'} onClick={() => setSection('history')}>{t('sessionHistory')}</button>
    </div>
    {section === 'active' ? <>
      <div className="card">
        <h2 className="card-header"><span className="card-header-icon"><IconTerminal /></span>{t('activeSessions')}</h2>
        {statsLoading ? <p role="status">{t('loadingSessions')}</p> : statsError ? <LoadError title={t('sessionsLoadError')} detail={formatApiError(statsError, t)} retryLabel={t('retry')} retryingLabel={t('retrying')} onRetry={retryStats} /> : sessions.length === 0 ? <div className="empty-state"><div className="empty-state-icon"><IconTerminal /></div><div>{t('noActiveSSHSessions')}</div><p>{t('sessionsHint')}</p></div> : <div className="traffic-table-scroll" tabIndex={0} role="region" aria-label={t('activeSessions')}>
          <table className="sessions-table"><caption className="sr-only">{t('activeSessions')}</caption><thead><tr><th scope="col">#</th><th scope="col">{t('sessionKind')}</th><th scope="col">{t('remoteAddress')}</th><th scope="col">{t('connected')}</th><th scope="col">{t('duration')}</th><th scope="col">{t('sent')}</th><th scope="col">{t('received')}</th><th scope="col"><span className="sr-only">{t('sessionActions')}</span></th></tr></thead><tbody>
            {sessions.map((session) => <tr key={session.id}>
              <th scope="row" data-label="#" className="mono">{session.id}</th>
              <td data-label={t('sessionKind')}>{t(session.kind === 'exec' ? 'sessionKindExec' : 'sessionKindShell')}</td>
              <td data-label={t('remoteAddress')} className="mono">{session.remoteAddress}</td>
              <td data-label={t('connected')}>{formatTime(session.connectedAt)}</td>
              <td data-label={t('duration')} className="mono">{formatDuration(now - session.connectedAt)}</td>
              <td data-label={t('sent')} className="mono">{formatBytes(session.bytesSent)}</td>
              <td data-label={t('received')} className="mono">{formatBytes(session.bytesReceived)}</td>
              <td className="sessions-table-action"><button type="button" className="btn btn-sm btn-danger" disabled={disconnectingIds.has(session.id) || Boolean(snapshot?.operation)} onClick={() => handleDisconnect(session)}>{disconnectingIds.has(session.id) ? t('disconnecting') : t('disconnect')}</button></td>
            </tr>)}
          </tbody></table>
        </div>}
      </div>
      <div className="card">
        <h2 className="card-header">{t('trafficStats')}</h2>
        <div className="stats-row" role="group" aria-label={t('aggregate')}>
          <div className="stat-card"><div className="stat-card-value">{sessions.length}</div><div className="stat-card-label">{t('totalSessions')}</div></div>
          <div className="stat-card"><div className="stat-card-value">{formatBytes(sessions.reduce((total, session) => total + session.bytesSent, 0))}</div><div className="stat-card-label">{t('totalSent')}</div></div>
          <div className="stat-card"><div className="stat-card-value">{formatBytes(sessions.reduce((total, session) => total + session.bytesReceived, 0))}</div><div className="stat-card-label">{t('totalReceived')}</div></div>
        </div>
        <TrafficTrend rates={rates} points={ratePoints} />
      </div>
    </> : <div className="card">
      <h2 className="card-header">{t('sessionHistory')}</h2>
      <div className="history-controls">
        <div><label htmlFor="history-days">{t('historyRange')}</label> <select className="form-input" id="history-days" value={days} onChange={(event) => setDays(Number(event.target.value))} disabled={clearing}><option value={7}>{t('historySevenDays')}</option><option value={30}>{t('historyThirtyDays')}</option></select></div>
        <button type="button" className="btn btn-danger" aria-describedby="history-clear-hint" onClick={handleClear} disabled={!scope || clearing || Boolean(snapshot?.operation)}>{clearing ? t('historyClearing') : t('historyClear')}</button>
      </div>
      <p className="text-muted">{t('historyPrivacy')}</p>
      <p id="history-clear-hint">{t('historyClearHint')}</p>
      {historyError && <div role="alert" className="settings-warning"><span>{formatApiError(historyError, t)}</span><button type="button" className="btn" disabled={historyLoading || clearing} onClick={() => loadHistory()}>{historyLoading ? t('retrying') : t('retry')}</button></div>}
      {!scope || historyLoading ? <p role="status">{t('historyLoading')}</p> : history.length === 0 ? <p className="empty-state">{t('historyEmpty')}</p> : <>
        <h3>{t('historyDaily')}</h3>
        <p className="text-muted">{t('historyUtcHint')}</p>
        <div className="traffic-table-scroll" tabIndex={0} role="region" aria-label={t('historyDaily')}>
          <table className="sessions-table">
            <caption className="sr-only">{t('historyDaily')}</caption>
            <thead><tr><th scope="col">{t('historyUtcDay')}</th><th scope="col">{t('totalSessions')}</th><th scope="col">{t('totalSent')}</th><th scope="col">{t('totalReceived')}</th></tr></thead>
            <tbody>{daily.map((day) => <tr key={day.day}>
              <th scope="row"><time dateTime={day.day}>{dateLabel(day.day)}</time></th>
              <td>{day.count}</td><td>{formatBytes(day.bytesSent)}</td><td>{formatBytes(day.bytesReceived)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <h3>{t('historyRecords')}</h3>
        <div className="traffic-table-scroll" tabIndex={0} role="region" aria-label={t('historyRecords')}>
          <table className="sessions-table">
            <caption className="sr-only">{t('historyRecords')}</caption>
            <thead><tr><th scope="col">{t('sessionKind')}</th><th scope="col">{t('connected')}</th><th scope="col">{t('historyEnded')}</th><th scope="col">{t('sent')}</th><th scope="col">{t('received')}</th><th scope="col">{t('historyOutcome')}</th></tr></thead>
            <tbody>{history.map((session) => <tr key={session.id}>
              <td>{t(session.kind === 'exec' ? 'sessionKindExec' : 'sessionKindShell')}</td>
              <td>{timestampLabel(session.startedAt)}</td><td>{timestampLabel(session.endedAt)}</td>
              <td>{formatBytes(session.bytesSent)}</td><td>{formatBytes(session.bytesReceived)}</td>
              <td>{session.reason ? t(`historyReason_${session.reason}`) : t('historyStillActive')}{session.exitCode != null && <> · {t('historyExitCode', session.exitCode)}</>}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </>}
    </div>}
  </div>;
}
