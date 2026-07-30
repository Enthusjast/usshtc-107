import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { getLogs, clearLogs, onNewLog, copyToClipboard } from '../lib/electron';
import { useToast } from '../components/Toast';
import LoadError from '../components/LoadError';
import { useLocale } from '../i18n/LocaleContext';
import { IconScrollText } from '../components/Icons';
import { formatTime } from '../lib/format';

const MAX_RENDERED_LOGS = 500;

function mergeLogs(...groups) {
  const byId = new Map();
  groups.flat().forEach((entry) => byId.set(entry.id, entry));
  return [...byId.values()]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .slice(-MAX_RENDERED_LOGS);
}

export default function LogsView() {
  const pushToast = useToast();
  const { t } = useLocale();
  const [logs, setLogs] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef(null);
  const streamVersionRef = useRef(0);

  const loadLogs = useCallback(async () => {
    const streamVersionAtStart = streamVersionRef.current;
    setLoaded(false);
    setLoadError(false);
    try {
      const entries = await getLogs();
      if (!Array.isArray(entries)) throw new Error('Invalid logs response');
      setLogs((currentLogs) => (
        streamVersionRef.current === streamVersionAtStart
          ? entries.slice(-MAX_RENDERED_LOGS)
          : mergeLogs(entries, currentLogs)
      ));
    } catch {
      if (streamVersionRef.current === streamVersionAtStart) setLoadError(true);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  useEffect(() => {
    const unsub = onNewLog((entry) => {
      streamVersionRef.current += 1;
      setLogs((prev) => mergeLogs(prev, [entry]));
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
    if (logs.length === 0 || !window.confirm(t('confirmClearLogs', logs.length))) return;
    setClearing(true);
    try {
      const result = await clearLogs();
      if (result?.ok === false) throw new Error(result.error || t('clearLogsFailed'));
      const clearedThroughId = Number(result?.clearedThroughId);
      setLogs((currentLogs) => (
        Number.isSafeInteger(clearedThroughId) && clearedThroughId >= 0
          ? currentLogs.filter((entry) => Number(entry.id) > clearedThroughId)
          : []
      ));
      pushToast('info', t('logsCleared'));
    } catch (error) {
      pushToast('error', t('clearLogsFailed'), error?.message || t('unknownError'));
    } finally {
      setClearing(false);
    }
  };

  const handleCopyAll = async () => {
    const text = logs
      .map((l) => `[${formatTime(l.time)}] [${l.source}] ${l.message}`)
      .join('\n');
    const ok = await copyToClipboard(text);
    if (ok === false) {
      pushToast('error', t('copyFailed'));
      return;
    }
    pushToast('info', t('logsCopied'), t('nEntries', logs.length));
  };

  const skeletonWidths = useMemo(() => Array.from({ length: 8 }, () => 60 + Math.random() * 40), []);

  if (loaded && loadError) {
    return (
      <LoadError
        title={t('logsLoadError')}
        detail={t('loadErrorHint')}
        retryLabel={t('retry')}
        retryingLabel={t('retrying')}
        onRetry={loadLogs}
      />
    );
  }

  return (
    <div className="log-viewer">
      <div className="log-toolbar">
        <button type="button" className="btn btn-sm" onClick={handleCopyAll} disabled={!loaded || logs.length === 0}>{t('copyAll')}</button>
        <button type="button" className="btn btn-sm btn-danger" onClick={handleClear} disabled={!loaded || logs.length === 0 || clearing}>
          {clearing ? t('clearing') : t('clear')}
        </button>
        <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--text-dim)', fontWeight: 500 }}>
          {t('nEntries', logs.length)}
        </span>
      </div>
      <div className="log-list" ref={listRef} onScroll={handleScroll} role="log" aria-label={t('logs')} aria-live="off">
        {!loaded ? (
          <div style={{ padding: '1rem' }} aria-busy="true" aria-label={t('loadingLogs')}>
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
              <span className={`log-message log-level-${entry.level}`}>{entry.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
