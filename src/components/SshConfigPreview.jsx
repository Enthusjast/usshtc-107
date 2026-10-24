import { useEffect, useRef, useState } from 'react';
import { generateSshConfig, previewSshConfig } from '../lib/electron';
import { formatApiError } from '../lib/api-errors';
import { useLocale } from '../i18n/LocaleContext';
import { useToast } from './Toast';

export default function SshConfigPreview({ scope, alias, unsaved, disabled, onBusyChange, isCurrent, onReviewed }) {
  const { t } = useLocale();
  const pushToast = useToast();
  const [preview, setPreview] = useState(null);
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState(null);
  const alive = useRef(true);
  const busy = phase === 'previewing' || phase === 'writing';

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  const loadPreview = async (changedError = null) => {
    if (busy || unsaved || disabled || !scope || !isCurrent(scope)) return;
    setPreview(null);
    setError(changedError);
    onReviewed?.(null);
    setPhase('previewing');
    try {
      const result = await previewSshConfig(scope);
      if (!alive.current || !isCurrent(scope)) return;
      if (result?.cancelled) { setPhase('cancelled'); return; }
      // Deliberately retain only the managed block and its optimistic-write tokens.
      setPreview({ block: result.block, changed: result.changed, sourceHash: result.sourceHash, configHash: result.configHash, backupPath: result.backupPath });
      setPhase('ready');
      onReviewed?.({ scope, matched: result.changed === false, configHash: result.configHash });
    } catch (failure) {
      if (alive.current && isCurrent(scope)) { setError(failure); setPhase('error'); }
    }
  };

  const generate = async () => {
    if (!preview || busy || unsaved || disabled) return;
    setError(null);
    onReviewed?.(null);
    setPhase('writing');
    try {
      const result = await generateSshConfig({ scope, sourceHash: preview.sourceHash, configHash: preview.configHash });
      if (!alive.current || !isCurrent(scope)) return;
      if (result?.cancelled) { setPhase('cancelled'); return; }
      setPreview({ block: result.block, changed: result.changed, sourceHash: result.sourceHash, configHash: result.configHash, backupPath: result.backupPath });
      setPhase('written');
      onReviewed?.({ scope, matched: true, configHash: result.configHash });
      pushToast('success', t('sshConfigWritten'), t('sshNowUse', alias));
    } catch (failure) {
      if (!alive.current || !isCurrent(scope)) return;
      if (failure?.code === 'SSH_CONFIG_CHANGED') await loadPreview(failure);
      else { setError(failure); setPhase('error'); }
    }
  };

  return (
    <div className="ssh-config-preview" aria-busy={busy}>
      <p className="settings-help" id="ssh-config-saved-hint">{t(unsaved ? 'saveSshConfigSettingsFirst' : 'sshConfigSavedValues')}</p>
      <div className="settings-inline-action">
        <button type="button" className="btn" onClick={() => { void loadPreview(); }} disabled={disabled || unsaved || busy || !scope} aria-describedby="ssh-config-saved-hint">
          {phase === 'previewing' ? t('previewingSshConfig') : error ? t('retrySshConfigPreview') : t('previewSshConfig')}
        </button>
        <button type="button" className="btn btn-primary" onClick={generate} disabled={disabled || unsaved || busy || !preview || phase === 'error' || phase === 'written'} aria-describedby="ssh-config-saved-hint">
          {phase === 'writing' ? t('writing') : t('generateSshConfig')}
        </button>
      </div>
      {error && <p className="field-error" role="alert">{formatApiError(error, t)}</p>}
      <div role="status" aria-live="polite">
        {busy && <p className="settings-help">{t(phase === 'writing' ? 'writing' : 'previewingSshConfig')}</p>}
        {phase === 'cancelled' && <p className="settings-help">{t('sshConfigCancelled')}</p>}
        {phase === 'written' && <p className="settings-help">{t('sshConfigWritten')}</p>}
        {preview && phase !== 'written' && <p className="settings-help">{t(preview.changed ? 'sshConfigWillChange' : 'sshConfigUnchanged')}</p>}
      </div>
      {preview && <pre className="code-block settings-config-result" aria-label={t('sshConfigManagedPreview')}>{preview.block}</pre>}
      {preview?.backupPath && <p className="settings-path settings-result-path">{t('sshConfigBackupPath')} <span className="mono">{preview.backupPath}</span></p>}
    </div>
  );
}
