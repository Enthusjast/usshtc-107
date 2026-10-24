import { useUpdates } from '../contexts/UpdateContext';
import { useLocale } from '../i18n/LocaleContext';
import { IconInfo } from './Icons';

export default function UpdateBanner({ onReview }) {
  const { state, error, actionError } = useUpdates();
  const { t } = useLocale();
  const failure = error || actionError || state?.errorCode;
  if (!state?.availableVersion && !failure) return null;
  return <aside className="update-banner" aria-label={t('updates')}>
    <span className="update-banner-icon" aria-hidden="true"><IconInfo size={20} /></span>
    <div className="update-banner-copy" role="status">
      <strong>{state?.availableVersion ? t('updateBannerAvailable', state.availableVersion) : t('updates')}</strong>
      <span>{failure ? t('updateBannerError') : t(`updatePhase_${state.phase}`)}</span>
    </div>
    <button type="button" className="btn" onClick={onReview}>{t('updateReview')}</button>
  </aside>;
}
