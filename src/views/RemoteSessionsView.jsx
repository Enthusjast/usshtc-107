import { useCallback, useEffect, useRef, useState } from 'react';
import { listRemoteSessions, openRemoteSession, copyRemoteSession, cancelRemoteSession, startLogin, ApiError } from '../lib/electron';
import { useRuntime, sameScope } from '../contexts/RuntimeContext';
import { useLocale } from '../i18n/LocaleContext';
import { IconMonitor, IconGlobe, IconClipboard } from '../components/Icons';

const CODES = new Set(['AUTH_REQUIRED', 'PROFILE_CHANGED', 'INVALID_ARGUMENT', 'OPERATION_IN_PROGRESS',
  'REMOTE_SESSION_EXPIRED', 'REMOTE_SESSION_NOT_READY', 'REMOTE_SESSION_UNSUPPORTED', 'REMOTE_SESSION_INVALID',
  'REMOTE_SESSION_OPEN_FAILED', 'REMOTE_SESSION_COPY_FAILED', 'PORTAL_NETWORK', 'PORTAL_TIMEOUT', 'PORTAL_PERMISSION',
  'PORTAL_NOT_FOUND', 'PORTAL_UNIMPLEMENTED', 'PORTAL_QUOTA', 'PORTAL_UNKNOWN', 'PORTAL_CANCELLED']);
const STATES = new Set(['RUNNING', 'PENDING', 'SUSPENDED', 'ENDED']);
let sequence = 0;
const requestId = () => `sessions-${Date.now()}-${++sequence}`;
const cancelled = error => ['PORTAL_CANCELLED', 'OPERATION_CANCELLED', 'PROFILE_CHANGED'].includes(error?.code);

export default function RemoteSessionsView() {
  const { scope, snapshot, getScope } = useRuntime();
  const { t } = useLocale();
  const identity = JSON.stringify([scope?.profileId, scope?.epoch, snapshot?.desiredConfig?.cluster,
    snapshot?.loginStatus, snapshot?.cookieValid]);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const pending = useRef(null);
  const [state, setState] = useState({ identity, data: null, busy: false, error: null, notice: null });
  const visible = state.identity === identity ? state : { data: null, busy: false, error: null, notice: null };
  const isCurrent = useCallback(operation => pending.current === operation && currentIdentity.current === operation.identity
    && sameScope(operation.scope, getScope()), [getScope]);
  const detail = error => t(`remoteSessionError_${CODES.has(error?.code) ? error.code : 'REMOTE_SESSION_INVALID'}`);

  const execute = useCallback(async (kind, targetId) => {
    if (!scope || pending.current) return;
    const operation = { scope, identity, requestId: requestId(), kind, targetId };
    pending.current = operation;
    setState(previous => ({ ...previous, identity, busy: true, error: null, notice: null }));
    try {
      const payload = { scope, requestId: operation.requestId };
      const result = kind === 'list' ? await listRemoteSessions(payload)
        : await (kind === 'open' ? openRemoteSession : copyRemoteSession)({ ...payload, targetId });
      if (!isCurrent(operation)) return;
      if (!sameScope(result, scope)) throw new ApiError('PROFILE_CHANGED');
      if (kind === 'list') {
        if (!Array.isArray(result.desktops) || !Array.isArray(result.apps) || !Array.isArray(result.catalog)
            || !result.sectionErrors || typeof result.sectionErrors !== 'object') throw new ApiError('REMOTE_SESSION_INVALID');
        setState({ identity, data: result, busy: false, error: null, notice: null });
      } else {
        if (kind === 'open' && result.opened !== true || kind === 'copy' && (result.copied !== true || result.warning !== 'SESSION_LINK_CREDENTIALS')) throw new ApiError('REMOTE_SESSION_INVALID');
        setState(previous => ({ ...previous, busy: false, notice: kind === 'copy' ? 'remoteSessionsCopiedWarning' : 'remoteSessionsOpened' }));
      }
    } catch (error) {
      if (isCurrent(operation)) setState(previous => ({ ...previous, busy: false,
        error: cancelled(error) ? null : { code: error?.code, kind, targetId },
        notice: cancelled(error) ? 'remoteSessionsCancelled' : null }));
    } finally { if (pending.current === operation) pending.current = null; }
  }, [scope, identity, isCurrent]);

  useEffect(() => {
    setState({ identity, data: null, busy: false, error: null, notice: null });
    void execute('list');
    return () => {
      const operation = pending.current;
      pending.current = null;
      if (operation) void cancelRemoteSession({ scope: operation.scope, requestId: operation.requestId }).catch(() => {});
    };
  }, [identity, execute]);

  const cancel = useCallback(async () => {
    const operation = pending.current;
    if (!operation || operation.kind === 'login' || operation.cancelling) return;
    operation.cancelling = true;
    try {
      await cancelRemoteSession({ scope: operation.scope, requestId: operation.requestId });
      if (!isCurrent(operation)) return;
      pending.current = null;
      setState(previous => ({ ...previous, busy: false, error: null, notice: 'remoteSessionsCancelled' }));
    } catch (error) {
      operation.cancelling = false;
      if (isCurrent(operation)) setState(previous => ({ ...previous, error: { code: error?.code, kind: 'cancel' } }));
    }
  }, [isCurrent]);
  useEffect(() => {
    const onKeyDown = event => {
      if (event.key === 'Escape' && pending.current && pending.current.kind !== 'login') {
        event.preventDefault();
        void cancel();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [cancel]);
  const login = async () => {
    if (!scope || pending.current) return;
    const operation = { scope, identity, requestId: requestId(), kind: 'login' };
    pending.current = operation;
    setState(previous => ({ ...previous, busy: true, error: null }));
    try { await startLogin(scope); }
    catch (error) { if (isCurrent(operation)) setState(previous => ({ ...previous, error: { code: error?.code, kind: 'list' } })); }
    finally {
      if (isCurrent(operation)) { pending.current = null; setState(previous => ({ ...previous, busy: false })); }
    }
  };
  const actions = (item, supported = true) => <div className="session-segments">
    <button type="button" className="btn btn-sm btn-primary" disabled={visible.busy || !supported} onClick={() => execute('open', item.targetId)} aria-label={`${t('remoteSessionsOpen')} — ${item.name || t('remoteSessionsDesktopUnnamed')}`}><IconGlobe size={16} aria-hidden="true" />{t('remoteSessionsOpen')}</button>
    <button type="button" className="btn btn-sm" disabled={visible.busy || !supported} onClick={() => execute('copy', item.targetId)} aria-label={`${t('remoteSessionsCopy')} — ${item.name || t('remoteSessionsDesktopUnnamed')}`}><IconClipboard size={16} aria-hidden="true" />{t('remoteSessionsCopy')}</button>
  </div>;
  const sectionError = section => visible.data?.sectionErrors[section] && <div role="alert" className="settings-warning"><p>{detail({ code: visible.data.sectionErrors[section] })}</p><button type="button" className="btn" disabled={visible.busy} onClick={() => execute('list')}>{t('retry')}</button></div>;

  return <div className="sessions-view">
    <div className="card">
      <h2 className="card-header"><span className="card-header-icon"><IconMonitor aria-hidden="true" /></span>{t('remoteSessionsTitle')}</h2>
      <p className="text-muted">{t('remoteSessionsPrivacy')}</p>
      <p id="remote-session-credentials-warning">{t('remoteSessionsCredentialWarning')}</p>
      <div className="session-segments">
        <button type="button" className="btn" disabled={!scope || visible.busy} onClick={() => execute('list')}>{t('remoteSessionsRefresh')}</button>
        {visible.busy && pending.current?.kind !== 'login' && <button type="button" className="btn" onClick={cancel}>{t('remoteSessionsCancel')}</button>}
      </div>
      {visible.busy && <p role="status">{t(pending.current?.kind === 'list' ? 'remoteSessionsLoading' : 'remoteSessionsConnecting')}</p>}
      {visible.notice && <p role="status">{t(visible.notice)}</p>}
      {visible.error && <div role="alert" className="settings-warning"><p>{detail(visible.error)}</p>
        {visible.error.code === 'AUTH_REQUIRED' ? <button type="button" className="btn" disabled={visible.busy} onClick={login}>{t('remoteSessionsLogin')}</button>
          : <button type="button" className="btn" disabled={visible.busy} onClick={() => visible.error.kind === 'cancel' ? cancel() : execute(visible.error.kind, visible.error.targetId)}>{t('retry')}</button>}
      </div>}
      {!scope && <p>{t('remoteSessionsWaiting')}</p>}
    </div>
    {visible.data && <>
      <section className="card" aria-labelledby="remote-desktops-title" aria-describedby="remote-session-credentials-warning">
        <h2 className="card-header" id="remote-desktops-title">{t('remoteSessionsDesktops')}</h2>
        {sectionError('desktops')}
        {!visible.data.sectionErrors.desktops && visible.data.desktops.length === 0 && <p className="empty-state">{t('remoteSessionsNoDesktops')}</p>}
        {visible.data.desktops.map(item => <article key={item.targetId} className="card">
          <h3>{item.name || t('remoteSessionsDesktopUnnamed')}</h3>
          <dl><dt>{t('remoteSessionsNode')}</dt><dd className="mono">{item.loginNode}</dd>{item.wm && <><dt>{t('remoteSessionsWm')}</dt><dd>{item.wm}</dd></>}</dl>
          {!item.supported && <p>{t('remoteSessionsUnsupportedDesktop')}</p>}{actions(item, item.supported)}
        </article>)}
      </section>
      <section className="card" aria-labelledby="remote-apps-title" aria-describedby="remote-session-credentials-warning">
        <h2 className="card-header" id="remote-apps-title">{t('remoteSessionsApps')}</h2>
        <p className="text-muted">{t('remoteSessionsGetOnly')}</p>{sectionError('apps')}
        {!visible.data.sectionErrors.apps && visible.data.apps.length === 0 && <p className="empty-state">{t('remoteSessionsNoApps')}</p>}
        {visible.data.apps.map(item => <article key={item.targetId} className="card"><h3>{item.name}</h3>
          <dl><dt>{t('remoteSessionsJob')}</dt><dd className="mono">{item.jobId}</dd><dt>{t('remoteSessionsState')}</dt><dd>{t(`remoteSessionState_${STATES.has(item.state) ? item.state : 'UNKNOWN'}`)}</dd><dt>{t('remoteSessionsRunningTime')}</dt><dd>{item.runningTime}</dd></dl>
          {actions(item, item.state === 'RUNNING')}
        </article>)}
      </section>
      <section className="card" aria-labelledby="remote-catalog-title"><h2 className="card-header" id="remote-catalog-title">{t('remoteSessionsCatalog')}</h2><p className="text-muted">{t('remoteSessionsCatalogHint')}</p>{sectionError('catalog')}
        {!visible.data.sectionErrors.catalog && (visible.data.catalog.length ? <ul>{visible.data.catalog.map((app, index) => <li key={`${app.id}-${index}`}>{app.name}</li>)}</ul> : <p>{t('remoteSessionsNoCatalog')}</p>)}
      </section>
    </>}
  </div>;
}
