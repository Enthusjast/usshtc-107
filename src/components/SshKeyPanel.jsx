import { useEffect, useRef, useState } from 'react';
import { getSshKeyInfo, exportKeyBackup, importKeyBackup, rotateSshKeys, rebuildSshKeys, retryLoadSettings, copyToClipboard, ApiError } from '../lib/electron';
import { formatApiError } from '../lib/api-errors';
import { useRuntime, sameScope } from '../contexts/RuntimeContext';
import { useLocale } from '../i18n/LocaleContext';
import { IconKey, IconClipboard } from './Icons';

const STATES = new Set(['ready', 'missing', 'invalid', 'changed']);
const ACTIONS = { backup: exportKeyBackup, import: importKeyBackup, rotate: rotateSshKeys, rebuild: rebuildSshKeys, recover: retryLoadSettings };

export default function SshKeyPanel({ storageAvailable, disabled, recoveryDisabled, onBusyChange, onConsumedDraft }) {
  const { t } = useLocale();
  const { scope, getScope, getSnapshot, flushDraft, retry } = useRuntime();
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [errorState, setErrorState] = useState(null);
  const [pending, setPending] = useState(null);
  const [notice, setNotice] = useState(null);
  const [target, setTarget] = useState('client');
  const [copied, setCopied] = useState(false);
  const scopeRef = useRef(scope);
  const alive = useRef(false);
  const readId = useRef(0);
  const action = useRef(null);
  scopeRef.current = scope;
  const currentScope = () => getScope?.() ?? scopeRef.current;
  const accepts = (origin) => alive.current && sameScope(origin, currentScope());
  const error = sameScope(errorState?.scope, currentScope()) ? errorState.failure : null;

  const refresh = async (origin = currentScope()) => {
    const id = ++readId.current;
    if (!accepts(origin)) return;
    setLoading(true);
    try {
      const value = await getSshKeyInfo(origin);
      if (!value || value.scope !== 'application' || !STATES.has(value.client?.state) || !STATES.has(value.host?.state)) throw new ApiError('API_UNAVAILABLE');
      if (id === readId.current && accepts(origin)) { setInfo(value); setErrorState((current) => current?.source === 'read' ? null : current); setCopied(false); }
    } catch (failure) {
      if (id === readId.current && accepts(origin)) setErrorState({ failure, scope: origin, source: 'read' });
    } finally {
      if (id === readId.current && accepts(origin)) setLoading(false);
    }
  };

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; readId.current += 1; onBusyChange?.(false); };
  }, []);
  useEffect(() => {
    setInfo(null);
    setErrorState((current) => sameScope(current?.scope, currentScope()) ? current : null);
    setNotice(null);
    setCopied(false);
    setTarget('client');
    void refresh(scope);
  }, [scope?.profileId, scope?.epoch]);

  const selected = target === 'both' ? [info?.client, info?.host] : [info?.[target]];
  const canRotate = selected.every((key) => key?.state === 'ready');
  const canRebuild = selected.some((key) => key && key.state !== 'ready');
  const blocked = disabled || loading || Boolean(pending) || Boolean(error);
  const metadataRecovery = info?.recoveryRequired && info.client.state === 'ready' && info.host.state === 'ready';
  const recoveryAvailable = info?.recoveryRequired || ['KEY_TRANSACTION_FAILED', 'KEY_ROLLBACK_FAILED'].includes(error?.code);

  const run = async (kind) => {
    if (action.current || (kind === 'recover' ? recoveryDisabled || loading || Boolean(pending) : blocked || !info)) return;
    if ((kind === 'backup' || kind === 'import' || kind === 'rotate') && !storageAvailable) return;
    const token = { origin: currentScope(), kind };
    action.current = token;
    setPending(kind);
    setErrorState(null);
    setNotice(null);
    onBusyChange?.(true);
    try {
      await flushDraft();
      if (!accepts(token.origin)) return;
      const result = await ACTIONS[kind](kind === 'rotate' || kind === 'rebuild' ? { scope: token.origin, target } : token.origin);
      if (action.current !== token || !alive.current) return;
      if (result?.cancelled) {
        if (accepts(token.origin)) setNotice('keyActionCancelled');
        return;
      }
      if (kind === 'recover') {
        if (currentScope()?.profileId !== token.origin.profileId) return;
        await retry?.();
        const nextScope = currentScope();
        if (action.current !== token || !alive.current || nextScope?.profileId !== token.origin.profileId) return;
        await refresh(nextScope);
        if (!accepts(nextScope)) return;
        setNotice('keyRecoveryCompleted');
        await onConsumedDraft?.(result);
        return;
      }
      const resultScope = kind === 'backup' ? token.origin : result?.scope;
      if (!resultScope || typeof resultScope.profileId !== 'string' || !Number.isSafeInteger(resultScope.epoch)) throw new ApiError('API_UNAVAILABLE');
      if (!accepts(resultScope) || resultScope.profileId !== token.origin.profileId) return;
      await refresh(resultScope);
      if (!accepts(resultScope)) return;
      await retry?.();
      if (!accepts(resultScope)) return;
      setNotice(kind === 'backup' ? 'keyBackupExported' : 'keyActionCompleted');
      if (kind !== 'backup') await onConsumedDraft?.(result);
    } catch (failure) {
      const failureIsCurrent = () => {
        if (!alive.current || action.current !== token) return false;
        const latestScope = currentScope();
        if (sameScope(latestScope, token.origin)) return true;
        const latest = getSnapshot();
        return latestScope?.profileId === token.origin.profileId && sameScope(latest, latestScope)
          && latest.operation === null && typeof failure?.code === 'string' && latest.errorCode === failure.code;
      };
      if (!alive.current || action.current !== token || currentScope()?.profileId !== token.origin.profileId) return;
      await retry?.();
      if (!failureIsCurrent()) return;
      const failureScope = currentScope();
      await refresh(failureScope);
      if (failureIsCurrent() && accepts(failureScope)) setErrorState({ failure, scope: failureScope, source: 'action' });
    } finally {
      if (action.current === token) {
        action.current = null;
        if (alive.current) { setPending(null); onBusyChange?.(false); }
      }
    }
  };

  const copy = async () => {
    const origin = currentScope();
    try {
      await copyToClipboard(info.client.publicKey);
      if (accepts(origin)) setCopied(true);
    } catch (failure) { if (accepts(origin)) setErrorState({ failure, scope: origin, source: 'action' }); }
  };

  return (
    <section className="card ssh-key-panel" aria-labelledby="ssh-key-heading" aria-busy={loading || Boolean(pending)}>
      <h2 id="ssh-key-heading" className="card-header"><span className="card-header-icon" aria-hidden="true"><IconKey /></span> {t('sshKeysTitle')}</h2>
      <p className="settings-warning">{t('keySharedWarning')}</p>
      <p className="settings-help">{t('keyFingerprintHint')}</p>
      {loading && <p role="status">{t('keyInfoLoading')}</p>}
      {error && <p className="field-error" role="alert">{formatApiError(error, t)}</p>}
      <button type="button" className="btn" disabled={Boolean(pending) || loading} onClick={() => { setErrorState(null); void refresh(); }}>{t(error ? 'keyInfoRetry' : 'keyInfoRefresh')}</button>
      {recoveryAvailable && <button type="button" className="btn settings-secondary-action" disabled={recoveryDisabled || loading || Boolean(pending)} onClick={() => { void run('recover'); }}>{t('keyRecoveryRetry')}</button>}
      {info && <>
        <div className="settings-grid key-identities">
          {['client', 'host'].map((role) => <section key={role} aria-labelledby={`key-${role}-heading`}>
            <h3 id={`key-${role}-heading`}>{t(role === 'client' ? 'keyClient' : 'keyHost')}</h3>
            <dl className="key-details">
              <dt>{t('keyState')}</dt><dd>{t(`keyState_${info[role].state}`)}</dd>
              <dt>{t('keyFingerprint')}</dt><dd className="mono">{info[role].fingerprint || t('keyFingerprintUnavailable')}</dd>
              <dt>{t('privateKeyAt')}</dt><dd className="mono">{info[role].privateKeyPath || t('keyPathUnavailable')}</dd>
            </dl>
          </section>)}
        </div>
        {info.client.state === 'ready' && info.client.publicKey && <>
          <p className="settings-help">{t('sshPublicKeyHint')}</p>
          <div className="code-block settings-key-block">{info.client.publicKey}</div>
          <button type="button" className="btn settings-secondary-action" disabled={Boolean(pending)} onClick={() => { void copy(); }}><span aria-hidden="true"><IconClipboard size={15} /></span>{t(copied ? 'copied' : 'copyPublicKey')}</button>
        </>}
        {info.recoveryRequired && <p className="settings-warning" role="status">{t(metadataRecovery ? 'keyMetadataRecoveryHint' : 'keyRecoveryRequired')}</p>}
        <p className="settings-help" id="key-backup-help">{t('keyBackupBindingHint')}</p>
        {!storageAvailable && <p className="settings-warning" role="status">{t('keyBackupUnavailable')}</p>}
        <div className="settings-inline-action">
          <button type="button" className="btn" disabled={blocked || !storageAvailable || info.client.state !== 'ready' || info.host.state !== 'ready'} onClick={() => { void run('backup'); }}>{t('keyExportBackup')}</button>
          <button type="button" className="btn" disabled={blocked || !storageAvailable || metadataRecovery} onClick={() => { void run('import'); }}>{t('keyImportBackup')}</button>
        </div>
        {!metadataRecovery && <div className="settings-field-stack key-replacement">
          <div><label className="form-label" htmlFor="ssh-key-target">{t('keyTarget')}</label>
            <select id="ssh-key-target" className="form-input" value={target} disabled={blocked} onChange={(event) => setTarget(event.target.value)} aria-describedby="key-replacement-help">
              <option value="client">{t('keyClient')}</option><option value="host">{t('keyHost')}</option><option value="both">{t('keyBoth')}</option>
            </select>
          </div>
          <p className="settings-help" id="key-replacement-help">{t('keyRotationBackupHint')}</p>
          {target !== 'client' && <p className="settings-warning">{t('keyHostTrustWarning')}</p>}
          <p className="settings-help">{t('keyRebuildHint')}</p>
          <div className="settings-inline-action">
            <button type="button" className="btn btn-danger" disabled={blocked || !canRotate || !storageAvailable} onClick={() => { void run('rotate'); }}>{t('keyRotate')}</button>
            <button type="button" className="btn btn-danger" disabled={blocked || !canRebuild} onClick={() => { void run('rebuild'); }}>{t('keyRebuild')}</button>
          </div>
        </div>}
      </>}
      {pending && <p role="status">{t('keyActionPending')}</p>}
      {notice && <p role="status">{t(notice)}</p>}
    </section>
  );
}
