import { useCallback, useEffect, useRef, useState } from 'react';
import { startLogin, startProxy, restartProxy, retryRecovery, ApiError } from '../lib/electron';
import { formatApiError } from '../lib/api-errors';
import { sameScope, useRuntime } from '../contexts/RuntimeContext';
import { useProfiles } from '../contexts/ProfileContext';
import { useLocale } from '../i18n/LocaleContext';
import SshConfigPreview from '../components/SshConfigPreview';
import DiagnosticsView, { diagnosticIdentity } from './DiagnosticsView';
import { IconKey, IconFileEdit, IconZap, IconActivity, IconInfo } from '../components/Icons';

const STEPS = ['login', 'config', 'connect', 'verify'];
const ICONS = { login: IconKey, config: IconFileEdit, connect: IconZap, verify: IconActivity };
const CONNECTION_FIELDS = ['host', 'port', 'cluster', 'loginNode', 'cols', 'rows', 'useRoot', 'path', 'startupCommand', 'wssUrl'];
const cancelled = (error) => ['CANCELLED', 'OPERATION_CANCELLED'].includes(error?.code);

function runningMatches(snapshot) {
  return snapshot?.proxyStatus === 'started' && Boolean(snapshot.runningConfig && snapshot.desiredConfig)
    && CONNECTION_FIELDS.every((key) => snapshot.runningConfig[key] === snapshot.desiredConfig[key]);
}

export default function SetupView({ onBusyChange, onNavigate, onSetupExit }) {
  const { t } = useLocale();
  const { snapshot, scope, getScope, getSnapshot, retry, flushDraft } = useRuntime();
  const { data, run: runProfile } = useProfiles();
  const profile = data?.profiles.find((item) => item.id === scope?.profileId);
  const [step, setStep] = useState(() => STEPS.includes(profile?.onboarding.step) ? profile.onboarding.step : 'login');
  const [pending, setPending] = useState(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [diagnosticBusy, setDiagnosticBusy] = useState(false);
  const [review, setReview] = useState(null);
  const [proof, setProof] = useState(null);
  const [failedAction, setFailure] = useState(null);
  const [actionNotice, setFeedback] = useState(null);
  const alive = useRef(true);
  const action = useRef(null);
  const heading = useRef(null);
  const previousStep = useRef(step);
  const identity = diagnosticIdentity(snapshot, scope);
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const index = STEPS.indexOf(step);
  const Icon = ICONS[step];
  const locked = Boolean(snapshot?.storageErrorCode);
  const busy = Boolean(pending || previewBusy || diagnosticBusy);
  const unavailable = busy || Boolean(snapshot?.operation) || locked || !scope;
  const authenticated = snapshot?.loginStatus === 'success' && snapshot?.cookieValid === true;
  const failure = sameScope(failedAction?.scope, scope) ? failedAction : null;
  const feedback = actionNotice && sameScope(actionNotice.scope, scope) ? actionNotice.key : null;
  const connected = runningMatches(snapshot);
  const reviewed = review?.identity === identity && sameScope(review.scope, scope) && review.matched;
  const diagnostic = proof?.identity === identity && sameScope(proof.run, scope) ? proof.run : null;
  const passed = (id, code, mode) => diagnostic?.checks.some((check) => check.id === id && check.status === 'passed' && check.code === code && (!mode || check.mode === mode));
  const verified = Boolean(authenticated && connected && typeof diagnostic?.finishedAt === 'string'
    && Number.isFinite(Date.parse(diagnostic.finishedAt)) && diagnostic.checks.every((check) => check.status === 'passed')
    && passed('ssh-config', 'SSH_CONFIG_OK') && passed('local-listener', 'LOCAL_SSH_OK', 'ssh-auth')
    && passed('token', 'TOKEN_OK') && passed('setup', 'SETUP_OK')
    && passed('wss', 'WSS_SHELL_READY') && passed('remote-command', 'REMOTE_COMMAND_OK'));
  const canNext = step === 'login' ? authenticated : step === 'config' ? reviewed : step === 'connect' ? connected : verified;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; action.current = null; };
  }, []);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  useEffect(() => {
    if (previousStep.current === step) return undefined;
    previousStep.current = step;
    const frame = requestAnimationFrame(() => heading.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [step]);

  const isCurrent = useCallback((origin) => alive.current && sameScope(origin, getScope()) && currentIdentity.current === identity, [getScope, identity]);
  const handleReviewed = useCallback((value) => setReview(value ? { ...value, identity } : null), [identity]);

  // Starting, restarting and logging in may advance this profile's epoch themselves.
  // Keep their own result visible, but never deliver it into another profile or view.
  const perform = async (kind, operation) => {
    if (action.current || unavailable) return;
    const token = { kind, scope: getScope() };
    if (!sameScope(token.scope, scope)) return;
    action.current = token;
    setPending(kind);
    setFailure(null);
    setFeedback(null);
    const accepts = () => alive.current && action.current === token && getScope()?.profileId === token.scope.profileId;
    const inOrigin = () => accepts() && sameScope(token.scope, getScope());
    const notice = (key) => setFeedback({ key, scope: getScope() });
    const refresh = async () => {
      if (inOrigin()) return;
      try { await retry(); } catch { /* RuntimeContext exposes the failed authoritative read. */ }
    };
    try {
      await flushDraft();
      if (!sameScope(token.scope, getScope())) throw new ApiError('PROFILE_CHANGED');
      const result = await operation(token.scope);
      if (!accepts()) return;
      if (result?.cancelled) { if (inOrigin()) notice('setupActionCancelled'); return; }
      await refresh();
      if (!accepts()) return;
      const latest = getSnapshot();
      const owned = sameScope(latest, getScope()) && latest.operation === null
        && (kind === 'login' ? ['pending', 'sso_done', 'success'].includes(latest.loginStatus)
          : ['start', 'restart'].includes(kind) && runningMatches(latest));
      if (inOrigin() || owned) notice(kind === 'login' ? 'setupLoginOpened' : kind === 'recovery' ? 'setupRecoveryChecked' : 'setupConnectFinished');
    } catch (error) {
      if (!accepts()) return;
      if (cancelled(error)) { if (inOrigin()) notice('setupActionCancelled'); return; }
      await refresh();
      if (!accepts()) return;
      const latest = getSnapshot();
      if (inOrigin() || (sameScope(latest, getScope()) && latest.operation === null && latest.errorCode === error?.code)) {
        setFailure({ error, kind, scope: getScope() });
      }
    } finally {
      if (action.current === token) { action.current = null; if (alive.current) setPending(null); }
    }
  };

  const saveProgress = async (status, nextStep, exit = false) => {
    if (action.current || unavailable || !profile || (status === 'completed' && !verified)) return;
    const origin = getScope();
    if (!sameScope(origin, scope)) return;
    const token = { kind: 'saving', scope: origin };
    action.current = token;
    setPending('saving');
    setFailure(null);
    setFeedback(null);
    try {
      const result = await runProfile('onboarding', { status, step: nextStep, ...(status === 'completed' ? { runId: diagnostic.runId } : {}) });
      if (!alive.current || action.current !== token || !sameScope(origin, getScope())) return;
      if (result?.cancelled) { setFeedback({ key: 'setupActionCancelled', scope: origin }); return; }
      if (exit) onSetupExit?.();
      else setStep(nextStep);
    } catch (error) {
      if (alive.current && action.current === token && sameScope(origin, getScope())) {
        if (cancelled(error)) setFeedback({ key: 'setupActionCancelled', scope: origin });
        else setFailure({ error, kind: 'save', status, nextStep, exit, scope: origin });
      }
    } finally {
      if (alive.current && action.current === token) { action.current = null; setPending(null); }
    }
  };
  const progressStatus = profile?.onboarding.status === 'dismissed' ? 'dismissed' : 'new';
  const goToStep = (nextStep) => { void saveProgress(progressStatus, nextStep); };
  const login = () => { void perform('login', startLogin); };
  const connect = () => { void perform(snapshot?.proxyStatus === 'started' ? 'restart' : 'start', snapshot?.proxyStatus === 'started' ? restartProxy : startProxy); };
  const retryFailure = () => {
    if (failure.kind === 'save') void saveProgress(failure.status, failure.nextStep, failure.exit);
    else void perform(failure.kind, { login: startLogin, start: startProxy, restart: restartProxy, recovery: retryRecovery }[failure.kind]);
  };

  return (
    <div className="setup-view">
      <section className="card setup-intro" aria-labelledby="setup-intro-heading">
        <h2 id="setup-intro-heading" className="card-header">{t('setupTitle')}</h2>
        <p>{t('setupDescription')}</p>
        <p className="settings-help">{t('setupNoAutomaticChanges')}</p>
        <ol className="setup-steps" aria-label={t('setupProgress')}>
          {STEPS.map((item, position) => <li key={item} aria-current={item === step ? 'step' : undefined}>
            <span className="setup-step-number" aria-hidden="true">{position + 1}</span><span>{t(`setupStep_${item}`)}</span>
          </li>)}
        </ol>
      </section>

      <section className="card setup-stage" aria-labelledby="setup-step-heading" aria-busy={busy}>
        <h2 id="setup-step-heading" ref={heading} className="card-header" tabIndex={-1}><span className="card-header-icon" aria-hidden="true"><Icon /></span>{t(`setupStep_${step}`)}</h2>
        <p>{t(`setupHint_${step}`)}</p>
        {step === 'login' && <>
          <p role="status">{t(authenticated ? 'loggedIn' : snapshot?.loginStatus === 'failure' ? 'loginFailed' : snapshot?.loginStatus === 'pending' || snapshot?.loginStatus === 'sso_done' ? 'loggingIn' : 'notLoggedIn')}</p>
          {snapshot?.loginStage && <p className="settings-help" role="status">{t(snapshot.loginStage === 'opening' ? 'openingLoginPage' : snapshot.loginStage === 'sso' ? 'loggingIn' : 'openWebSSHPage')}</p>}
          <button type="button" className="btn" onClick={login} disabled={unavailable || ['pending', 'sso_done'].includes(snapshot?.loginStatus)}>{pending === 'login' ? t('loggingIn') : authenticated ? t('reLogin') : t('login')}</button>
        </>}
        {step === 'config' && <>
          <p className="settings-help">{t('sshConfigRulesWarning')}</p>
          <SshConfigPreview key={identity} scope={scope} alias={profile?.settings.sshAlias ?? 'usshtc107'} unsaved={false} disabled={locked || Boolean(pending) || Boolean(snapshot?.operation)} onBusyChange={setPreviewBusy} isCurrent={isCurrent} onReviewed={handleReviewed} />
          {reviewed && <p role="status">{t('setupConfigReady')}</p>}
        </>}
        {step === 'connect' && <>
          <p role="status">{t(connected ? 'setupListenerReady' : snapshot?.proxyStatus === 'starting' ? 'starting' : snapshot?.proxyStatus === 'stopping' ? 'stopping' : 'setupListenerNeeded')}</p>
          {snapshot?.runningConfig && <p className="settings-help">{t('setupRunningAddress', snapshot.runningConfig.host, snapshot.runningConfig.port)}</p>}
          {!connected && snapshot?.proxyStatus === 'started' && <p className="settings-warning">{t('proxyRunningRestart')}</p>}
          <button type="button" className="btn" onClick={connect} disabled={unavailable || connected || !authenticated || ['starting', 'stopping'].includes(snapshot?.proxyStatus)}>{pending === 'start' || pending === 'restart' ? t('starting') : snapshot?.proxyStatus === 'started' ? t('restartAndApply') : t('start')}</button>
          {!authenticated && <p className="settings-warning">{t('setupLoginRequired')}</p>}
          {snapshot?.errorCode && snapshot.errorCode !== failure?.error.code && <p className="field-error" role="alert">{formatApiError({ code: snapshot.errorCode }, t)}</p>}
        </>}
        {step === 'verify' && <>
          <p className="diagnostics-proof"><span aria-hidden="true"><IconInfo size={18} /></span>{t('setupProofScope')}</p>
          <p role="status">{t(verified ? 'setupVerified' : 'setupVerificationNeeded')}</p>
        </>}
        {feedback && <p className="settings-help" role="status">{t(feedback)}</p>}
        {failure && <div className="diagnostics-error" role="alert">{formatApiError(failure.error, t)} <button type="button" className="btn" onClick={retryFailure} disabled={unavailable || (failure.status === 'completed' && !verified)}>{t('retry')}</button></div>}
        {pending === 'saving' && <p role="status">{t('setupSaving')}</p>}
      </section>

      {step === 'verify' && <DiagnosticsView setupMode onRunChange={setProof} onBusyChange={setDiagnosticBusy} />}

      <section className="card setup-recovery" aria-labelledby="setup-recovery-heading">
        <h2 id="setup-recovery-heading" className="card-header">{t('diagnosticsNextSteps')}</h2>
        <div className="setup-actions">
          {step !== 'login' && <button type="button" className="btn" onClick={() => goToStep('login')} disabled={unavailable}>{t('setupReturnLogin')}</button>}
          {step === 'verify' && <>
            <button type="button" className="btn" onClick={() => goToStep('config')} disabled={unavailable}>{t('diagnosticsReviewConfig')}</button>
            <button type="button" className="btn" onClick={() => goToStep('connect')} disabled={unavailable}>{t('setupReturnConnect')}</button>
          </>}
          <button type="button" className="btn" onClick={() => onNavigate?.('settings')} disabled={unavailable}>{t('diagnosticsOpenSettings')}</button>
          <button type="button" className="btn" onClick={() => { void perform('recovery', retryRecovery); }} disabled={unavailable || !authenticated || snapshot?.remoteStatus === 'checking'}>{pending === 'recovery' ? t('recoveryChecking') : t('recoveryRetry')}</button>
        </div>
      </section>

      <div className="card setup-actions setup-navigation" aria-label={t('setupNavigation')}>
        <button type="button" className="btn" onClick={() => goToStep(STEPS[index - 1])} disabled={index === 0 || unavailable}>{t('setupBack')}</button>
        <button type="button" className="btn" onClick={() => { void saveProgress('dismissed', step, true); }} disabled={unavailable}>{t('setupSkip')}</button>
        <button type="button" className="btn btn-primary" onClick={() => { if (canNext) void saveProgress(step === 'verify' ? 'completed' : progressStatus, STEPS[index + 1] ?? step, step === 'verify'); }} disabled={unavailable || !canNext}>{t(step === 'verify' ? 'setupFinish' : 'setupNext')}</button>
      </div>
    </div>
  );
}
