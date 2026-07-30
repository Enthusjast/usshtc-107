import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getSessions, disconnectSession,
  onSessionUpdate, onProxyStatus,
} from '../lib/electron';
import { useToast } from '../components/Toast';
import LoadError from '../components/LoadError';
import { useLocale } from '../i18n/LocaleContext';
import { IconTerminal, IconUsers } from '../components/Icons';
import { formatBytes, formatDuration, formatTime } from '../lib/format';

export default function SessionsView() {
  const pushToast = useToast();
  const { t } = useLocale();
  const [sessions, setSessions] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [disconnectingIds, setDisconnectingIds] = useState(() => new Set());
  const [now, setNow] = useState(Date.now());
  const sessionVersionRef = useRef(0);

  useEffect(() => {
    if (sessions.length === 0) return undefined;
    setNow(Date.now());
    const ti = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(ti);
  }, [sessions.length]);

  const loadSessions = useCallback(async () => {
    const sessionVersionAtStart = sessionVersionRef.current;
    setLoaded(false);
    setLoadError(false);
    try {
      const nextSessions = await getSessions();
      if (!Array.isArray(nextSessions)) throw new Error('Invalid sessions response');
      if (sessionVersionRef.current === sessionVersionAtStart) {
        if (nextSessions.length > 0) setNow(Date.now());
        setSessions(nextSessions);
      }
    } catch {
      if (sessionVersionRef.current === sessionVersionAtStart) setLoadError(true);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    const unsubscribeSession = onSessionUpdate((data) => {
      if (Array.isArray(data?.all)) {
        sessionVersionRef.current += 1;
        if (data.all.length > 0) setNow(Date.now());
        setSessions(data.all);
      }
      if (data?.type === 'close') {
        setDisconnectingIds((prev) => {
          const next = new Set(prev);
          next.delete(data.sessionId);
          return next;
        });
        pushToast('info', t('sessionClosed'), `${t('disconnected')} #${data.sessionId}`);
      }
      if (data?.type === 'open') {
        pushToast('info', t('newSession'), data.session?.remoteAddress);
      }
    });
    const unsubscribeProxy = onProxyStatus((data) => {
      if (data?.proxyStatus !== 'stopped') return;
      sessionVersionRef.current += 1;
      setSessions([]);
      setDisconnectingIds(new Set());
    });
    return () => {
      unsubscribeSession?.();
      unsubscribeProxy?.();
    };
  }, [pushToast, t]);

  const handleDisconnect = useCallback(async (session) => {
    if (!window.confirm(t('confirmDisconnectSession', session.id, session.remoteAddress))) return;
    setDisconnectingIds((prev) => new Set(prev).add(session.id));
    try {
      const ok = await disconnectSession(session.id);
      if (ok) {
        pushToast('info', t('disconnecting'), `#${session.id}`);
      } else {
        pushToast('error', t('failed'), t('disconnectFailed'));
        setDisconnectingIds((prev) => {
          const next = new Set(prev);
          next.delete(session.id);
          return next;
        });
      }
    } catch (error) {
      pushToast('error', t('disconnectFailed'), error?.message || t('unknownError'));
      setDisconnectingIds((prev) => {
        const next = new Set(prev);
        next.delete(session.id);
        return next;
      });
    }
  }, [pushToast, t]);

  if (loaded && loadError) {
    return (
      <LoadError
        title={t('sessionsLoadError')}
        detail={t('loadErrorHint')}
        retryLabel={t('retry')}
        retryingLabel={t('retrying')}
        onRetry={loadSessions}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '900px' }}>
      <div className="card">
        <h2 className="card-header">
          <span className="card-header-icon"><IconTerminal /></span> {t('activeSessions')}
        </h2>

        {!loaded ? (
          <div aria-busy="true" aria-label={t('loadingSessions')}>
            {[1,2].map((i) => (
              <div key={i} style={{ padding: '0.5rem 0' }}>
                <div className="skeleton skeleton-text" style={{ height: '1.5rem' }} />
              </div>
            ))}
          </div>
        ) : sessions.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><IconTerminal /></div>
            <div style={{ fontWeight: 500 }}>{t('noActiveSSHSessions')}</div>
            <div style={{ fontSize: '0.8rem' }}>{t('sessionsHint')}</div>
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="sessions-table">
              <caption className="sr-only">{t('activeSessions')}</caption>
              <thead>
                <tr>
                  <th>#</th>
                  <th>{t('remoteAddress')}</th>
                  <th>{t('connected')}</th>
                  <th>{t('duration')}</th>
                  <th>{t('sent')}</th>
                  <th>{t('received')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.id}>
                    <td data-label="#" className="mono" style={{ color: 'var(--accent)', fontWeight: 600 }}>{s.id}</td>
                    <td data-label={t('remoteAddress')} className="mono">{s.remoteAddress}</td>
                    <td data-label={t('connected')}>{formatTime(s.connectedAt)}</td>
                    <td data-label={t('duration')} className="mono">{formatDuration(now - s.connectedAt)}</td>
                    <td data-label={t('sent')} className="mono">{formatBytes(s.bytesSent)}</td>
                    <td data-label={t('received')} className="mono">{formatBytes(s.bytesReceived)}</td>
                    <td className="sessions-table-action">
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => handleDisconnect(s)}
                        disabled={disconnectingIds.has(s.id)}
                      >
                        {disconnectingIds.has(s.id) ? t('disconnecting') : t('disconnect')}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {sessions.length > 0 && (
        <div className="card">
          <h2 className="card-header">
            <span className="card-header-icon"><IconUsers /></span> {t('aggregate')}
          </h2>
          <div className="stats-row">
            <div className="stat-card">
              <div className="stat-card-value">{sessions.length}</div>
              <div className="stat-card-label">{t('totalSessions')}</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-value">
                {formatBytes(sessions.reduce((sum, s) => sum + s.bytesSent, 0))}
              </div>
              <div className="stat-card-label">{t('totalSent')}</div>
            </div>
            <div className="stat-card">
              <div className="stat-card-value">
                {formatBytes(sessions.reduce((sum, s) => sum + s.bytesReceived, 0))}
              </div>
              <div className="stat-card-label">{t('totalReceived')}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
