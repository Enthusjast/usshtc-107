import { useProfiles } from '../contexts/ProfileContext';
import { useRuntime } from '../contexts/RuntimeContext';
import { useLocale } from '../i18n/LocaleContext';
import { IconActivity } from './Icons';

export default function SetupResume({ onNavigate, disabled = false }) {
  const profiles = useProfiles();
  const { snapshot, scope } = useRuntime();
  const { t } = useLocale();
  const onboarding = profiles?.data?.profiles.find((profile) => profile.id === scope?.profileId)?.onboarding;
  if (!onNavigate || !onboarding || onboarding.status === 'completed') return null;
  return <section className="card setup-resume dashboard-grid-wide" aria-labelledby="setup-resume-heading">
    <h2 id="setup-resume-heading" className="card-header"><span className="card-header-icon" aria-hidden="true"><IconActivity /></span>{t('setupTitle')}</h2>
    <p className="settings-help">{t('setupResumeHint')}</p>
    <button type="button" className="btn" onClick={() => onNavigate('setup')} disabled={disabled || Boolean(snapshot?.operation) || Boolean(snapshot?.storageErrorCode)}>{t('setupResume')}</button>
  </section>;
}
