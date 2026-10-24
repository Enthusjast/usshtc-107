import { useEffect, useRef, useState } from 'react';
import { useProfiles } from '../contexts/ProfileContext';
import { useRuntime } from '../contexts/RuntimeContext';
import { useLocale } from '../i18n/LocaleContext';
import { useToast } from './Toast';
import { formatApiError, formatValidationError } from '../lib/api-errors';
import { IconSettings } from './Icons';

export default function ProfileManagement({ disabled, onEdit, onDirtyChange, onConsumedDraft }) {
  const profiles = useProfiles();
  const { scope } = useRuntime();
  const { t } = useLocale();
  const pushToast = useToast();
  const current = profiles?.data?.profiles.find((profile) => profile.id === scope?.profileId);
  const [newName, setNewName] = useState('');
  const [renameName, setRenameName] = useState(current?.name ?? '');
  const [nameError, setNameError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setRenameName(current?.name ?? ''); }, [current?.id, current?.name]);
  const dirty = Boolean(newName) || Boolean(current && renameName !== current.name);
  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  if (!profiles) return null;
  const blocked = disabled || Boolean(profiles.pending) || !current;

  const submit = async (action) => {
    setNameError(null);
    setActionError(null);
    try {
      const payload = action === 'create' ? { name: newName } : action === 'rename' ? { id: current.id, name: renameName } : { id: current.id };
      const result = await profiles.run(action, payload);
      if (!alive.current || result?.cancelled) return;
      if (action === 'create') setNewName('');
      if (result?.consumedDraftRevision !== undefined) await onConsumedDraft(result);
      pushToast('success', t(action === 'create' ? 'profileCreated' : action === 'rename' ? 'profileRenamed' : 'profileDeleted'));
    } catch (error) {
      if (!alive.current) return;
      if (error?.code === 'PROFILE_NAME_INVALID' || error?.fieldErrors?.name) {
        setNameError({ action, message: error?.fieldErrors?.name ? formatValidationError(error.fieldErrors.name, t) : t('profileNameHint') });
      } else setActionError(formatApiError(error, t));
    }
  };

  return <section className="card profile-management" aria-labelledby="profile-settings-heading" aria-busy={Boolean(profiles.pending)}>
    <h2 id="profile-settings-heading" className="card-header"><span className="card-header-icon" aria-hidden="true"><IconSettings /></span> {t('profiles')}</h2>
    <p className="settings-help">{t('profilesHint')}</p>
    <div className="settings-field-stack">
      <form onSubmit={(event) => { event.preventDefault(); void submit('rename'); }}>
        <label className="form-label" htmlFor="profile-rename-name">{t('profileName')}</label>
        <div className="settings-inline-action">
          <input id="profile-rename-name" className="form-input" required maxLength={64} value={renameName} onChange={(event) => { setRenameName(event.target.value); setNameError(null); onEdit(); }} disabled={blocked} aria-invalid={nameError?.action === 'rename'} aria-describedby="profile-name-hint" />
          <button type="submit" className="btn" disabled={blocked || renameName === current?.name}>{profiles.pending?.action === 'rename' ? t('saving') : t('renameProfile')}</button>
        </div>
        {nameError?.action === 'rename' && <p className="field-error" role="alert">{nameError.message}</p>}
      </form>
      <form onSubmit={(event) => { event.preventDefault(); void submit('create'); }}>
        <label className="form-label" htmlFor="profile-create-name">{t('newProfileName')}</label>
        <div className="settings-inline-action">
          <input id="profile-create-name" className="form-input" required maxLength={64} value={newName} onChange={(event) => { setNewName(event.target.value); setNameError(null); onEdit(); }} disabled={blocked || profiles.data?.profiles.length >= 8} aria-invalid={nameError?.action === 'create'} aria-describedby="profile-name-hint" />
          <button type="submit" className="btn" disabled={blocked || !newName.trim() || profiles.data?.profiles.length >= 8}>{profiles.pending?.action === 'create' ? t('saving') : t('createProfile')}</button>
        </div>
        {nameError?.action === 'create' && <p className="field-error" role="alert">{nameError.message}</p>}
      </form>
    </div>
    <p id="profile-name-hint" className="field-hint">{t('profileNameHint')}</p>
    {profiles.data?.profiles.length >= 8 && <p className="settings-help">{t('profileLimitHint')}</p>}
    <p className="settings-help">{t('deleteProfileHint')}</p>
    <button type="button" className="btn btn-danger" onClick={() => { void submit('delete'); }} disabled={blocked || profiles.data?.profiles.length <= 1}>{profiles.pending?.action === 'delete' ? t('deletingProfile') : t('deleteProfile')}</button>
    {actionError && <p className="field-error" role="alert">{actionError}</p>}
  </section>;
}
