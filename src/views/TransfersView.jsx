import { useCallback, useEffect, useRef, useState } from 'react';
import { listTransfers, startTransfer, cancelTransfer, onTransferState, startLogin, ApiError } from '../lib/electron';
import { useRuntime, sameScope } from '../contexts/RuntimeContext';
import { useLocale } from '../i18n/LocaleContext';
import { IconFileEdit } from '../components/Icons';
import { formatBytes } from '../lib/format';

const CODES = new Set(['AUTH_REQUIRED', 'PROFILE_CHANGED', 'INVALID_ARGUMENT', 'OPERATION_IN_PROGRESS',
  'API_UNAVAILABLE', 'RUNTIME_UNAVAILABLE', 'INTERNAL_ERROR', 'OPERATION_CANCELLED',
  'PORTAL_AUTH', 'PORTAL_NETWORK', 'PORTAL_TIMEOUT', 'PORTAL_PERMISSION', 'PORTAL_NOT_FOUND',
  'PORTAL_UNIMPLEMENTED', 'PORTAL_QUOTA', 'PORTAL_UNKNOWN', 'PORTAL_CANCELLED',
  'TRANSFER_PATH', 'TRANSFER_LIMIT', 'TRANSFER_EXISTS', 'TRANSFER_CHANGED', 'TRANSFER_METADATA',
  'TRANSFER_HASH', 'TRANSFER_IO', 'TRANSFER_DIRECTORY', 'TRANSFER_UNSAFE_TYPE', 'TRANSFER_TEMP_CONFLICT']);
const STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
const PHASES = new Set(['queued', 'hashing', 'negotiating', 'uploading', 'downloading', 'verifying', 'publishing', 'completed']);
const MODES = new Set(['single', 'multipart']);
const ACTIVE = new Set(['queued', 'running']);
const MAX_ITEMS = 100;
const initial = identity => ({ identity, items: [], remotePath: '', overwrite: false, busy: null, cancelling: [], error: null, notice: null, loaded: false });
const validPath = value => value.startsWith('/') && value !== '/' && !/[\u0000-\u001f\u007f]/.test(value);
const errorCode = error => CODES.has(error?.code) ? error.code : 'PORTAL_UNKNOWN';

function readItems(result, scope) {
  if (!sameScope(result, scope)) throw new ApiError('PROFILE_CHANGED');
  if (!Array.isArray(result.items) || result.items.some(item => !item || typeof item.id !== 'string'
    || !item.id || typeof item.filename !== 'string' || !['upload', 'download'].includes(item.direction)
    || !STATUSES.has(item.status))) throw new ApiError('API_UNAVAILABLE');
  return result.items.slice(-MAX_ITEMS);
}

export default function TransfersView() {
  const { scope, snapshot, getScope } = useRuntime();
  const { t } = useLocale();
  const translate = useRef(t);
  translate.current = t;
  const identity = JSON.stringify([scope?.profileId, scope?.epoch, snapshot?.desiredConfig?.cluster,
    snapshot?.loginStatus, snapshot?.cookieValid]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const session = useRef(null);
  const pending = useRef(null);
  const cancellations = useRef(new Map());
  const intents = useRef(new Map());
  const items = useRef([]);
  const [state, setState] = useState(() => initial(identity));
  const visible = state.identity === identity ? state : initial(identity);
  const current = useCallback(origin => session.current === origin && currentIdentity.current === origin.identity
    && sameScope(origin.scope, getScope()), [getScope]);

  const apply = useCallback((result, origin, revision) => {
    const next = readItems(result, origin.scope);
    if (!current(origin) || revision !== undefined && revision !== origin.revision) return next;
    items.current = next;
    const retainedIds = new Set(next.map(item => item.id));
    for (const id of intents.current.keys()) if (!retainedIds.has(id)) intents.current.delete(id);
    setState(previous => ({ ...previous, items: next, loaded: true }));
    return next;
  }, [current]);

  const execute = useCallback(async (kind, intent) => {
    const origin = session.current;
    if (!origin || !current(origin) || pending.current) return;
    if (kind === 'start' && !validPath(intent.remotePath)) {
      setState(previous => ({ ...previous, error: { code: 'TRANSFER_PATH', kind, intent } }));
      return;
    }
    if (kind === 'start' && intent.overwrite && !window.confirm(translate.current('transfersOverwriteConfirm'))) return;
    const operation = { origin, kind };
    pending.current = operation;
    const revision = origin.revision;
    const before = new Set(items.current.map(item => item.id));
    setState(previous => ({ ...previous, busy: kind, error: null, notice: null }));
    try {
      if (kind === 'login') {
        await startLogin(origin.scope);
        if (current(origin)) setState(previous => ({ ...previous, notice: 'transfersLoginStarted' }));
      } else {
        const result = kind === 'list' ? await listTransfers({ scope: origin.scope })
          : await startTransfer({ scope: origin.scope, direction: intent.direction, remotePath: intent.remotePath, overwrite: intent.overwrite });
        if (!current(origin) || pending.current !== operation) return;
        const next = apply(result, origin, revision);
        if (kind === 'start' && !result.cancelled) {
          const created = next.filter(item => item.direction === intent.direction && (result.transferId
            ? item.id === result.transferId : !before.has(item.id)));
          if (created.length === 1) intents.current.set(created[0].id, intent);
          // Also render remembered actions when an event arrived before the response.
          setState(previous => ({ ...previous }));
        }
        if (kind === 'start' && result.cancelled) setState(previous => ({ ...previous, notice: 'transfersDialogCancelled' }));
      }
    } catch (error) {
      if (current(origin) && pending.current === operation) setState(previous => ({ ...previous,
        error: { code: errorCode(error), kind, intent } }));
    } finally {
      if (pending.current === operation) {
        pending.current = null;
        if (current(origin)) setState(previous => ({ ...previous, busy: null }));
      }
    }
  }, [apply, current]);

  useEffect(() => {
    const origin = { identity, scope, revision: 0 };
    session.current = origin;
    pending.current = null;
    cancellations.current.clear();
    intents.current.clear();
    items.current = [];
    setState(initial(identity));
    let unsubscribe;
    if (scope) {
      try {
        unsubscribe = onTransferState(result => {
          if (!current(origin) || !sameScope(result, origin.scope)) return;
          try { apply(result, origin); origin.revision += 1; }
          catch (error) { setState(previous => ({ ...previous, error: { code: errorCode(error), kind: 'list' } })); }
        });
        void execute('list');
      } catch (error) {
        setState(previous => ({ ...previous, error: { code: errorCode(error), kind: 'list' } }));
      }
    }
    return () => {
      if (session.current === origin) session.current = null;
      pending.current = null;
      unsubscribe?.();
    };
  }, [identity, scope?.profileId, scope?.epoch, apply, current, execute]);

  const cancel = async id => {
    const origin = session.current;
    if (!origin || !current(origin) || cancellations.current.has(id)) return;
    const operation = { origin };
    cancellations.current.set(id, operation);
    setState(previous => ({ ...previous, cancelling: [...cancellations.current.keys()], error: null }));
    const revision = origin.revision;
    try {
      const result = await cancelTransfer({ scope: origin.scope, id });
      if (current(origin) && cancellations.current.get(id) === operation) apply(result, origin, revision);
    } catch (error) {
      if (current(origin) && cancellations.current.get(id) === operation) setState(previous => ({ ...previous,
        error: { code: errorCode(error), kind: 'cancel', id } }));
    } finally {
      if (cancellations.current.get(id) === operation) {
        cancellations.current.delete(id);
        if (current(origin)) setState(previous => ({ ...previous, cancelling: [...cancellations.current.keys()] }));
      }
    }
  };
  const start = direction => execute('start', { direction, remotePath: visible.remotePath, overwrite: visible.overwrite });
  const failure = visible.error;
  const auth = code => ['AUTH_REQUIRED', 'PORTAL_AUTH'].includes(code);
  const detail = code => t(`transferError_${CODES.has(code) ? code : 'PORTAL_UNKNOWN'}`);

  return <div className="sessions-view">
    <section className="card" aria-labelledby="transfers-title">
      <h2 id="transfers-title" className="card-header"><span className="card-header-icon"><IconFileEdit aria-hidden="true" /></span>{t('transfersTitle')}</h2>
      <p className="text-muted">{t('transfersNativeDialogs')}</p>
      <div className="settings-field-stack">
        <div><label className="form-label" htmlFor="transfer-remote-path">{t('transfersRemotePath')}</label>
          <input id="transfer-remote-path" className="form-input mono" value={visible.remotePath} maxLength={4096}
            autoComplete="off" spellCheck={false} disabled={!scope || Boolean(visible.busy)}
            aria-invalid={failure?.code === 'TRANSFER_PATH'} aria-describedby="transfer-path-help"
            onChange={event => setState(previous => ({ ...previous, remotePath: event.target.value }))} />
          <p id="transfer-path-help" className="settings-help">{t('transfersRemotePathHint')}</p></div>
        <label className="toggle-row" htmlFor="transfer-overwrite"><span>{t('transfersOverwrite')}</span>
          <span className="toggle-switch"><input id="transfer-overwrite" type="checkbox" checked={visible.overwrite}
            disabled={!scope || Boolean(visible.busy)} aria-describedby="transfer-overwrite-help"
            onChange={event => setState(previous => ({ ...previous, overwrite: event.target.checked }))} /><span className="toggle-slider" aria-hidden="true" /></span></label>
        <p id="transfer-overwrite-help" className="settings-help">{t('transfersOverwriteHint')}</p>
      </div>
      <div className="session-segments">
        <button type="button" className="btn btn-primary" disabled={!scope || Boolean(visible.busy)} onClick={() => start('upload')}>{t('transfersUpload')}</button>
        <button type="button" className="btn" disabled={!scope || Boolean(visible.busy)} onClick={() => start('download')}>{t('transfersDownload')}</button>
        <button type="button" className="btn" disabled={!scope || Boolean(visible.busy)} onClick={() => execute('list')}>{t('transfersRefresh')}</button>
      </div>
      <p className="settings-help">{t('transfersNoDirectories')}</p>
      <p className="settings-warning">{t('transfersPreflightRace')}</p>
      {visible.busy && <p role="status">{t(visible.busy === 'start' ? 'transfersChoosingFile' : visible.busy === 'login' ? 'transfersSigningIn' : 'transfersLoading')}</p>}
      {visible.notice && <p role="status">{t(visible.notice)}</p>}
      {!scope && <p>{t('transfersWaiting')}</p>}
      {failure && <div role="alert" className="settings-warning"><p>{detail(failure.code)}</p>
        {auth(failure.code) ? <button type="button" className="btn" disabled={Boolean(visible.busy)} onClick={() => execute('login')}>{t('transfersLogin')}</button>
          : <button type="button" className="btn" disabled={Boolean(visible.busy) || visible.cancelling.includes(failure.id)}
            onClick={() => failure.kind === 'cancel' ? cancel(failure.id) : execute(failure.kind === 'login' ? 'list' : failure.kind, failure.intent)}>{t('retry')}</button>}
      </div>}
    </section>
    <section className="card" aria-labelledby="transfer-history-title">
      <h2 id="transfer-history-title" className="card-header">{t('transfersActivity')}</h2>
      <p className="settings-help">{t('transfersHistoryHint')}</p>
      {visible.loaded && visible.items.length === 0 && <p className="empty-state">{t('transfersEmpty')}</p>}
      {visible.items.map(item => {
        const total = Number.isFinite(item.total) && item.total >= 0 ? item.total : null;
        const bytes = Number.isFinite(item.bytes) ? Math.max(0, total === null ? item.bytes : Math.min(total, item.bytes)) : 0;
        const percent = total > 0 ? Math.min(100, Math.max(0, bytes / total * 100)) : item.status === 'completed' ? 100 : undefined;
        const intent = intents.current.get(item.id);
        return <article className="card" key={item.id} style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
          <h3>{item.filename}</h3>
          <p>{t(`transfersDirection_${item.direction}`)} — <span role="status">{t(`transferStatus_${item.status}`)}</span></p>
          <p className="text-muted">{t(`transferPhase_${PHASES.has(item.phase) ? item.phase : 'working'}`)}{MODES.has(item.mode) && <> — {t(`transferMode_${item.mode}`)}</>}</p>
          <progress max={100} value={percent} aria-label={`${t('transfersProgress')} — ${item.filename}`} style={{ width: '100%', maxWidth: '100%' }} />
          <p className="mono">{formatBytes(bytes)} / {total === null ? t('transfersUnknownTotal') : formatBytes(total)}</p>
          {item.status === 'failed' && <p role="alert" className="field-error">{detail(item.errorCode)}</p>}
          {item.remoteTempsRetained && <p className="settings-warning">{t('transfersRemoteTempsRetained')}</p>}
          <div className="session-segments">
            {ACTIVE.has(item.status) && <button type="button" className="btn" disabled={visible.cancelling.includes(item.id)} onClick={() => cancel(item.id)}
              aria-label={`${t('transfersCancel')} — ${item.filename}`}>{t(visible.cancelling.includes(item.id) ? 'transfersCancelling' : 'transfersCancel')}</button>}
            {['failed', 'cancelled'].includes(item.status) && (auth(item.errorCode)
              ? <button type="button" className="btn" disabled={Boolean(visible.busy)} onClick={() => execute('login')}>{t('transfersLogin')}</button>
              : intent ? <button type="button" className="btn" disabled={Boolean(visible.busy)} onClick={() => execute('start', intent)}
                aria-label={`${t('transfersRetry')} — ${item.filename}`}>{t('transfersRetry')}</button> : <p className="settings-help">{t('transfersRetryNewSelection')}</p>)}
          </div>
        </article>;
      })}
    </section>
  </div>;
}
