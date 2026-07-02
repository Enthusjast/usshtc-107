import { useState, useEffect, useCallback } from 'react';
import {
  getSessions, disconnectSession,
  onSessionUpdate,
} from '../lib/electron';
import { useToast } from '../components/Toast';
import { useLocale } from '../i18n/LocaleContext';
import { IconTerminal, IconUsers } from '../components/Icons';
import { formatBytes, formatDuration, formatTime } from '../lib/format';

export default function SessionsView() {
  const pushToast = useToast();
  const { t } = useLocale();
  const [sessions, setSessions] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const ti = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(ti);
  }, []);

  useEffect(() => {
    getSessions().then((s) => {
      if (Array.isArray(s)) setSessions(s);
      setLoaded(true);
    });
  }, []);

  useEffect(() => {
    const unsub = onSessionUpdate((data) => {
      if (data?.all) setSessions(data.all);
      if (data?.type === 'close') {
        pushToast('info', t('sessionClosed'), `${t('disconnected')} #${data.sessionId}`);
      }
      if (data?.type === 'open') {
        pushToast('info', t('newSession'), data.session?.remoteAddress);
      }
    });
    return () => unsub?.();
  }, [t]);

  const handleDisconnect = useCallback(async (sessionId) => {
    const ok = await disconnectSession(sessionId);
    if (ok) {
      pushToast('info', t('disconnecting'), `#${sessionId}`);
    } else {
      pushToast('error', t('failed'), t('disconnectFailed'));
    }
  }, [t]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '900px' }}>
      <div className="card">
        <div className="card-header">
          <span className="card-header-icon"><IconTerminal /></span> {t('activeSessions')}
        </div>

        {!loaded ? (
          <div>
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
                    <td className="mono" style={{ color: 'var(--accent)', fontWeight: 600 }}>{s.id}</td>
                    <td className="mono">{s.remoteAddress}</td>
                    <td>{formatTime(s.connectedAt)}</td>
                    <td className="mono">{formatDuration(now - s.connectedAt)}</td>
                    <td className="mono">{formatBytes(s.bytesSent)}</td>
                    <td className="mono">{formatBytes(s.bytesReceived)}</td>
                    <td>
                      <button
                        className="btn btn-sm btn-danger"
                        onClick={() => handleDisconnect(s.id)}
                      >
                        {t('disconnect')}
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
          <div className="card-header">
            <span className="card-header-icon"><IconUsers /></span> {t('aggregate')}
          </div>
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
