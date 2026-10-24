import { formatApiError } from '../lib/api-errors';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { validateLogFilters, filterLogs } from '../../shared/log-filters.mjs';
import { getLogs, clearLogs, onNewLog, copyToClipboard, exportLogs, exportDiagnostics } from '../lib/electron';
import { useToast } from '../components/Toast';
import LoadError from '../components/LoadError';
import { useLocale } from '../i18n/LocaleContext';
import { IconScrollText, IconClipboard, IconFileEdit } from '../components/Icons';
import { formatTime } from '../lib/format';
import { useRuntime, sameScope } from '../contexts/RuntimeContext';

const MAX_RENDERED_LOGS = 500;
const EMPTY_FILTERS = { query: '', level: 'all', source: 'all', from: '', to: '' };
const LEVELS = ['all', 'debug', 'info', 'warn', 'error'];

function mergeLogs(...groups) {
  const byId = new Map();
  groups.flat().forEach((entry) => byId.set(entry.id, entry));
  return [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id)).slice(-MAX_RENDERED_LOGS);
}

export default function LogsView() {
  const pushToast = useToast();
  const { t } = useLocale();
  const { scope } = useRuntime();
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const [logs, setLogs] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [copying, setCopying] = useState(false);
  const [exporting, setExporting] = useState(null);
  const [exportError, setExportError] = useState(null);
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS });
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef(null);
  const streamVersionRef = useRef(0);
  const requestRef = useRef(0);
  const alive = useRef(false);
  const accepts = (origin) => alive.current && sameScope(origin, scopeRef.current);
  const sources = useMemo(() => [...new Set(logs.map((entry) => entry.source))].sort(), [logs]);
  const { normalized, fieldErrors } = useMemo(() => {
    const input = { ...filters, from: filters.from || null, to: filters.to || null };
    try { return { normalized: validateLogFilters(input, sources), fieldErrors: {} }; }
    catch {
      const errors = {};
      for (const key of Object.keys(input)) {
        try { validateLogFilters({ ...EMPTY_FILTERS, from: null, to: null, [key]: input[key] }, sources); }
        catch { errors[key] = true; }
      }
      // Cross-field ranges are also validated by the shared policy, not by a second date parser.
      if (Object.keys(errors).length === 0) { errors.from = true; errors.to = true; }
      return { normalized: null, fieldErrors: errors };
    }
  }, [filters, sources]);
  const matchingLogs = useMemo(() => normalized ? filterLogs(logs, normalized) : [], [logs, normalized]);
  const hasFilters = Object.keys(EMPTY_FILTERS).some((key) => filters[key] !== EMPTY_FILTERS[key]);
  const updateFilter = (key, value) => { setFilters((previous) => ({ ...previous, [key]: value })); setExportError(null); };

  useEffect(() => {
    if (filters.source !== 'all' && !sources.includes(filters.source)) setFilters((previous) => ({ ...previous, source: 'all' }));
  }, [sources, filters.source]);

  const loadLogs = useCallback(async () => {
    const request = ++requestRef.current;
    const streamVersionAtStart = streamVersionRef.current;
    const origin = scope;
    setLoaded(false);
    setLoadError(false);
    try {
      const entries = await getLogs();
      if (request !== requestRef.current || !accepts(origin)) return;
      if (!Array.isArray(entries)) throw new Error('Invalid logs response');
      const scoped = entries.filter((entry) => sameScope(entry, origin));
      setLogs((currentLogs) => streamVersionRef.current === streamVersionAtStart
        ? scoped.slice(-MAX_RENDERED_LOGS)
        : mergeLogs(scoped, currentLogs.filter((entry) => sameScope(entry, origin))));
    } catch {
      if (request === requestRef.current && accepts(origin) && streamVersionRef.current === streamVersionAtStart) setLoadError(true);
    } finally {
      if (request === requestRef.current && accepts(origin)) setLoaded(true);
    }
  }, [scope]);

  useEffect(() => {
    alive.current = true;
    setLogs([]);
    setFilters({ ...EMPTY_FILTERS });
    setExportError(null);
    setExporting(null);
    setCopying(false);
    setClearing(false);
    streamVersionRef.current = 0;
    let unsubscribe;
    try {
      unsubscribe = onNewLog((entry) => {
        if (!accepts(scope) || !sameScope(entry, scope)) return;
        streamVersionRef.current += 1;
        setLogs((previous) => mergeLogs(previous, [entry]));
      });
      if (scope) void loadLogs();
    } catch { setLoadError(true); setLoaded(true); }
    return () => { alive.current = false; requestRef.current += 1; unsubscribe?.(); };
  }, [scope, loadLogs]);

  useEffect(() => {
    if (autoScroll && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [matchingLogs, autoScroll]);
  const handleScroll = useCallback(() => {
    if (!listRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  }, []);

  const handleClear = async () => {
    if (logs.length === 0 || !window.confirm(t('confirmClearLogs', logs.length))) return;
    const origin = scope;
    setClearing(true);
    try {
      const result = await clearLogs();
      if (!accepts(origin) || result?.cancelled) return;
      const clearedThroughId = Number(result?.clearedThroughId);
      setLogs((currentLogs) => Number.isSafeInteger(clearedThroughId) && clearedThroughId >= 0
        ? currentLogs.filter((entry) => Number(entry.id) > clearedThroughId) : []);
      pushToast('info', t('logsCleared'));
    } catch (error) { if (accepts(origin)) pushToast('error', t('clearLogsFailed'), formatApiError(error, t)); }
    finally { if (accepts(origin)) setClearing(false); }
  };
  const handleCopy = async () => {
    const origin = scope;
    const entries = matchingLogs;
    setCopying(true);
    try {
      const text = entries.map((entry) => `[${new Date(entry.time).toISOString()}] [${entry.level}] [${entry.source}] ${entry.message}`).join('\n');
      await copyToClipboard(text);
      if (accepts(origin)) pushToast('info', t('logsCopied'), t('nEntries', entries.length));
    } catch (error) { if (accepts(origin)) pushToast('error', t('copyFailed'), formatApiError(error, t)); }
    finally { if (accepts(origin)) setCopying(false); }
  };
  const handleExport = async (kind) => {
    if (!scope || (kind === 'logs' && !normalized)) return;
    const origin = scope;
    setExporting(kind);
    setExportError(null);
    try {
      const result = kind === 'logs' ? await exportLogs({ scope, filters: normalized }) : await exportDiagnostics(scope);
      if (accepts(origin) && !result?.cancelled) pushToast('success', t(kind === 'logs' ? 'logsExported' : 'diagnosticsExported'));
    } catch (error) { if (accepts(origin)) setExportError({ error, kind }); }
    finally { if (accepts(origin)) setExporting(null); }
  };
  const invalid = !normalized;
  const filterError = (key) => fieldErrors[key] && <span className="field-error" id={`log-filter-${key}-error`}>{t(key === 'from' || key === 'to' ? 'logFilterTimeError' : 'logFilterInvalid')}</span>;

  if (loaded && loadError) return <LoadError title={t('logsLoadError')} detail={t('loadErrorHint')} retryLabel={t('retry')} retryingLabel={t('retrying')} onRetry={loadLogs} />;

  return (
    <div className="log-viewer">
      <form className="log-filters" aria-label={t('logFilters')} onSubmit={(event) => event.preventDefault()}>
        <div className="log-filter-query">
          <label className="form-label" htmlFor="log-filter-query">{t('logFilterQuery')}</label>
          <input id="log-filter-query" className="form-input" type="search" maxLength={256} value={filters.query} onChange={(event) => updateFilter('query', event.target.value)} aria-invalid={Boolean(fieldErrors.query)} aria-describedby="log-filter-query-hint" />
          <span id="log-filter-query-hint" className="settings-help">{t('logFilterQueryHint')}</span>{filterError('query')}
        </div>
        <div>
          <label className="form-label" htmlFor="log-filter-level">{t('logFilterLevel')}</label>
          <select id="log-filter-level" className="form-input" value={filters.level} onChange={(event) => updateFilter('level', event.target.value)}>{LEVELS.map((level) => <option value={level} key={level}>{t(`logLevel_${level}`)}</option>)}</select>
        </div>
        <div>
          <label className="form-label" htmlFor="log-filter-source">{t('logFilterSource')}</label>
          <select id="log-filter-source" className="form-input" value={filters.source} onChange={(event) => updateFilter('source', event.target.value)}><option value="all">{t('logSourceAll')}</option>{sources.map((source) => <option key={source} value={source}>{source}</option>)}</select>
        </div>
        {['from', 'to'].map((key) => <div key={key}>
          <label className="form-label" htmlFor={`log-filter-${key}`}>{t(key === 'from' ? 'logFilterFrom' : 'logFilterTo')}</label>
          <input id={`log-filter-${key}`} className="form-input" type="text" value={filters[key]} placeholder="2026-10-24T00:00:00.000Z" onChange={(event) => updateFilter(key, event.target.value)} aria-invalid={Boolean(fieldErrors[key])} aria-describedby={`log-filter-time-hint${fieldErrors[key] ? ` log-filter-${key}-error` : ''}`} />
          {filterError(key)}
        </div>)}
        <p id="log-filter-time-hint" className="settings-help log-filter-time-hint">{t('logFilterTimeHint')}</p>
        <button type="button" className="btn" onClick={() => { setFilters({ ...EMPTY_FILTERS }); setExportError(null); }} disabled={!hasFilters}>{t('logClearFilters')}</button>
      </form>
      <div className="log-toolbar">
        <button type="button" className="btn btn-sm" onClick={handleCopy} disabled={!loaded || invalid || matchingLogs.length === 0 || copying}><span aria-hidden="true"><IconClipboard size={15} /></span>{copying ? t('copying') : t('logCopyMatches')}</button>
        <button type="button" className="btn btn-sm" onClick={() => handleExport('logs')} disabled={!loaded || invalid || matchingLogs.length === 0 || Boolean(exporting)}><span aria-hidden="true"><IconFileEdit size={15} /></span>{exporting === 'logs' ? t('exporting') : t('logExportMatches')}</button>
        <button type="button" className="btn btn-sm" onClick={() => handleExport('diagnostics')} disabled={!scope || Boolean(exporting)}>{exporting === 'diagnostics' ? t('exporting') : t('exportDiagnostics')}</button>
        <button type="button" className="btn btn-sm btn-danger" onClick={handleClear} disabled={!loaded || logs.length === 0 || clearing}>{clearing ? t('clearing') : t('clear')}</button>
        <span className="log-count" role="status">{hasFilters ? t('logMatchingCount', matchingLogs.length, logs.length) : t('nEntries', logs.length)}</span>
      </div>
      <p className="settings-help log-export-hint">{t('diagnosticsPackageScope')}</p>
      {exportError && <div role="alert" className="log-export-error">{formatApiError(exportError.error, t)} <button type="button" className="btn" disabled={Boolean(exporting)} onClick={() => handleExport(exportError.kind)}>{t('retry')}</button></div>}
      <div className="log-list" ref={listRef} onScroll={handleScroll} role="log" aria-label={t('logs')} aria-live="off">
        {!loaded ? <div className="log-loading" aria-busy="true" aria-label={t('loadingLogs')}>{Array.from({ length: 8 }, (_, index) => <div key={index} className="skeleton skeleton-text" />)}</div>
          : invalid ? <div className="empty-state" role="status">{t('logFixFilters')}</div>
            : matchingLogs.length === 0 ? <div className="empty-state"><div className="empty-state-icon" aria-hidden="true"><IconScrollText /></div><div>{logs.length === 0 ? t('noLogEntries') : t('logNoMatches')}</div>{hasFilters && <button type="button" className="btn" onClick={() => setFilters({ ...EMPTY_FILTERS })}>{t('logClearFilters')}</button>}</div>
              : matchingLogs.map((entry) => <div key={entry.id} className="log-entry">
                <time className="log-time" dateTime={entry.time} title={entry.time}>{formatTime(entry.time)}</time>
                <span className="log-level">{t(`logLevel_${entry.level}`)}</span><span className="log-source">{entry.source}</span>
                <span className={`log-message log-level-${entry.level}`}>{entry.message}</span>
              </div>)}
      </div>
    </div>
  );
}
