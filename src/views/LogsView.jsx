import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { getLogs, clearLogs, onNewLog, copyToClipboard } from '../lib/electron';
import { useToast } from '../components/Toast';
import { useLocale } from '../i18n/LocaleContext';
import { IconScrollText } from '../components/Icons';

export default function LogsView() {
  const pushToast = useToast();
  const { t } = useLocale();
  const [logs, setLogs] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef(null);

  useEffect(() => {
    getLogs()
      .then((l) => setLogs(l))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    const unsub = onNewLog((entry) => {
      setLogs((prev) => [...prev, entry]);
    });
    return () => unsub?.();
  }, []);

  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const handleScroll = useCallback(() => {
    if (!listRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  }, []);

  const handleClear = async () => {
    await clearLogs();
    setLogs([]);
    pushToast('info', t('logsCleared'));
  };

  const handleCopyAll = async () => {
    const text = logs
      .map((l) => `[${new Date(l.time).toLocaleTimeString()}] [${l.source}] ${l.message}`)
      .join('\n');
    await copyToClipboard(text);
    pushToast('info', t('logsCopied'), t('nEntries', logs.length));
  };

  const skeletonWidths = useMemo(() => Array.from({ length: 8 }, () => 60 + Math.random() * 40), []);
  const formatTime = (iso) => new Date(iso).toLocaleTimeString();

  return (
    <div className="log-viewer">
      <div className="log-toolbar">
        <button className="btn btn-sm" onClick={handleCopyAll}>{t('copyAll')}</button>
        <button className="btn btn-sm btn-danger" onClick={handleClear}>{t('clear')}</button>
        <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--text-dim)', fontWeight: 500 }}>
          {t('nEntries', logs.length)}
        </span>
      </div>
      <div className="log-list" ref={listRef} onScroll={handleScroll}>
        {!loaded ? (
          <div style={{ padding: '1rem' }}>
            {skeletonWidths.map((w, i) => (
              <div key={i} className="skeleton skeleton-text" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : logs.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon"><IconScrollText /></div>
            <div style={{ fontWeight: 500 }}>{t('noLogEntries')}</div>
          </div>
        ) : (
          logs.map((entry) => (
            <div key={entry.id} className="log-entry">
              <span className="log-time">{formatTime(entry.time)}</span>
              <span className="log-source">{entry.source}</span>
              <span className={`log-level-${entry.level}`}>{entry.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
