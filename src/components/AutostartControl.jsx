import { useEffect, useRef, useState } from 'react';
import { getAutostart, setAutostart } from '../lib/electron';
import { formatApiError } from '../lib/api-errors';
import { sameScope } from '../contexts/RuntimeContext';
import { useLocale } from '../i18n/LocaleContext';

export default function AutostartControl({ scope, getScope, flushDraft, disabled, onBusyChange }) {
  const { t } = useLocale();
  const [status, setStatus] = useState(null);
  const [pending, setPending] = useState('loading');
  const [error, setError] = useState(null);
  const currentScope = useRef(scope);
  const request = useRef(0);
  const active = useRef(false);
  currentScope.current = scope;
  const accepts = (id, origin) => active.current && request.current === id && sameScope(getScope?.() ?? currentScope.current, origin);

  const refresh = async () => {
    const id = ++request.current;
    const origin = currentScope.current;
    setPending('loading');
    setError(null);
    try {
      const value = await getAutostart();
      if (accepts(id, origin)) setStatus(value);
    } catch (failure) {
      if (accepts(id, origin)) { setStatus(null); setError(failure); }
    } finally {
      if (accepts(id, origin)) setPending(null);
    }
  };

  useEffect(() => {
    active.current = true;
    void refresh();
    return () => { active.current = false; request.current += 1; onBusyChange(false); };
  }, [scope?.profileId, scope?.epoch]);

  const toggle = async (enabled) => {
    if (pending || disabled || !status?.supported) return;
    const id = ++request.current;
    const origin = currentScope.current;
    setPending('saving');
    setError(null);
    onBusyChange(true);
    try {
      await flushDraft();
      if (!accepts(id, origin)) return;
      const value = await setAutostart(enabled);
      if (accepts(id, origin) && !value?.cancelled) setStatus(value);
    } catch (failure) {
      if (!accepts(id, origin)) return;
      if (failure?.code !== 'OPERATION_CANCELLED') setError(failure);
      // A failed root commit may have rolled the OS registration back. Read the actual state.
      try {
        const value = await getAutostart();
        if (accepts(id, origin)) setStatus(value);
      } catch {
        if (accepts(id, origin)) setStatus(null);
      }
    } finally {
      if (accepts(id, origin)) { setPending(null); onBusyChange(false); }
    }
  };

  const failure = error ?? (status?.errorCode ? { code: status.errorCode } : null);
  return (
    <div className="autostart-control" aria-busy={Boolean(pending)}>
      <label className="toggle-wrapper settings-toggle-row" htmlFor="setting-launchAtLogin">
        <span className="toggle-label">{t('launchAtLogin')}</span>
        <span className="toggle-switch">
          <input id="setting-launchAtLogin" type="checkbox" checked={status?.enabled === true} disabled={disabled || Boolean(pending) || !status?.supported || Boolean(status?.errorCode)} onChange={(event) => { void toggle(event.target.checked); }} aria-describedby="autostart-help autostart-status" />
          <span className="toggle-slider" aria-hidden="true" />
        </span>
      </label>
      <p id="autostart-help" className="settings-help">{t('autostartHint')}</p>
      <p id="autostart-status" className="settings-help" role="status">
        {pending ? t(pending === 'saving' ? 'autostartSaving' : 'autostartLoading') : !status ? t('autostartUnavailable') : !status.supported ? t('autostartUnsupported') : status.approvalRequired ? t('autostartApprovalRequired') : t(status.enabled ? 'autostartEnabled' : 'autostartDisabled')}
      </p>
      {failure && <p className="field-error" role="alert">{formatApiError(failure, t)}</p>}
      <button type="button" className="btn settings-secondary-action" disabled={Boolean(pending) || disabled} onClick={() => { void refresh(); }}>{t(failure ? 'autostartRetry' : 'autostartRefresh')}</button>
    </div>
  );
}
