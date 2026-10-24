import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import ProfileManagement from '../src/components/ProfileManagement';
import { LocaleProvider } from '../src/i18n/LocaleContext';
import { ToastProvider } from '../src/components/Toast';

const profiles = vi.hoisted(() => ({ data: null, pending: null, run: vi.fn() }));
const mocks = vi.hoisted(() => ({ getStatus: vi.fn(), getSettings: vi.fn(), onRuntimeState: vi.fn(), setAppLocale: vi.fn() }));
vi.mock('../src/lib/electron', () => mocks);
vi.mock('../src/contexts/ProfileContext', () => ({ useProfiles: () => profiles }));
vi.mock('../src/contexts/RuntimeContext', () => ({ useRuntime: () => ({ scope: { profileId: 'default', epoch: 1 } }) }));

function mount(props = {}) {
  return render(<LocaleProvider><ToastProvider><ProfileManagement disabled={false} onEdit={vi.fn()} onDirtyChange={vi.fn()} onConsumedDraft={vi.fn()} {...props} /></ToastProvider></LocaleProvider>);
}
beforeEach(() => {
  vi.resetAllMocks();
  profiles.data = { activeProfileId: 'default', profiles: [{ id: 'default', name: 'Default', settings: {}, onboarding: {} }, { id: 'b', name: 'Work', settings: {}, onboarding: {} }] };
  profiles.pending = null;
  profiles.run.mockResolvedValue({});
  mocks.getStatus.mockResolvedValue({ profileId: 'default', epoch: 1, revision: 1 });
  mocks.getSettings.mockResolvedValue({ locale: 'en' });
  mocks.onRuntimeState.mockReturnValue(vi.fn());
});

it('creates an empty-credential profile from only its name, then clears that name draft', async () => {
  const edit = vi.fn(); const dirty = vi.fn();
  mount({ onEdit: edit, onDirtyChange: dirty });
  fireEvent.change(screen.getByLabelText('New profile name'), { target: { value: 'Personal' } });
  expect(edit).toHaveBeenCalled();
  expect(dirty).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole('button', { name: 'Create profile' }));
  await waitFor(() => expect(profiles.run).toHaveBeenCalledWith('create', { name: 'Personal' }));
  await waitFor(() => expect(screen.getByLabelText('New profile name')).toHaveValue(''));
  expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
});

it('renames the selected profile without deriving its name from account credentials', async () => {
  mount();
  expect(screen.getByLabelText('Profile name')).toHaveValue('Default');
  fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Research' } });
  fireEvent.click(screen.getByRole('button', { name: 'Rename profile' }));
  await waitFor(() => expect(profiles.run).toHaveBeenCalledWith('rename', { id: 'default', name: 'Research' }));
});

it('preserves every name draft on native delete cancellation without a renderer confirmation', async () => {
  const confirm = vi.spyOn(window, 'confirm');
  const consumed = vi.fn();
  profiles.run.mockResolvedValue({ cancelled: true });
  mount({ onConsumedDraft: consumed });
  fireEvent.change(screen.getByLabelText('Profile name'), { target: { value: 'Unsubmitted' } });
  fireEvent.change(screen.getByLabelText('New profile name'), { target: { value: 'New draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Delete active profile' }));
  await waitFor(() => expect(profiles.run).toHaveBeenCalledWith('delete', { id: 'default' }));
  expect(screen.getByLabelText('Profile name')).toHaveValue('Unsubmitted');
  expect(screen.getByLabelText('New profile name')).toHaveValue('New draft');
  expect(confirm).not.toHaveBeenCalled();
  expect(consumed).not.toHaveBeenCalled();
});

it('shows safe translated name validation without raw backend errors', async () => {
  profiles.run.mockRejectedValue({ code: 'PROFILE_NAME_INVALID', message: '/private/source/secret' });
  mount();
  fireEvent.change(screen.getByLabelText('New profile name'), { target: { value: 'Candidate' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create profile' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Use 1–64 characters');
  expect(screen.queryByText('/private/source/secret')).not.toBeInTheDocument();
  expect(screen.getByLabelText('New profile name')).toHaveValue('Candidate');
});

it('disables deleting the last profile and creating a ninth profile', async () => {
  profiles.data.profiles = profiles.data.profiles.slice(0, 1);
  const view = mount();
  expect(screen.getByRole('button', { name: 'Delete active profile' })).toBeDisabled();
  profiles.data = { ...profiles.data, profiles: Array.from({ length: 8 }, (_, index) => ({ id: index ? `profile-${index}` : 'default', name: `Profile ${index}`, settings: {}, onboarding: {} })) };
  view.rerender(<LocaleProvider><ToastProvider><ProfileManagement disabled={false} onEdit={vi.fn()} onDirtyChange={vi.fn()} onConsumedDraft={vi.fn()} /></ToastProvider></LocaleProvider>);
  expect(screen.getByRole('button', { name: 'Create profile' })).toBeDisabled();
  expect(screen.getByLabelText('New profile name')).toBeDisabled();
});

it('keeps profile editing disabled throughout a pending switch and reports consumed drafts only on success', async () => {
  profiles.pending = { action: 'activate', id: 'b' };
  const consumed = vi.fn();
  const view = mount({ onConsumedDraft: consumed });
  expect(screen.getByLabelText('Profile name')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Delete active profile' })).toBeDisabled();
  profiles.pending = null;
  profiles.run.mockResolvedValue({ consumedDraftRevision: 7 });
  view.rerender(<LocaleProvider><ToastProvider><ProfileManagement disabled={false} onEdit={vi.fn()} onDirtyChange={vi.fn()} onConsumedDraft={consumed} /></ToastProvider></LocaleProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Delete active profile' }));
  await waitFor(() => expect(consumed).toHaveBeenCalledWith({ consumedDraftRevision: 7 }));
});

it('localizes profile controls and name validation in Chinese', async () => {
  mocks.getSettings.mockResolvedValue({locale:'zh'});
  profiles.run.mockRejectedValue({code:'PROFILE_NAME_INVALID'});
  mount();
  await screen.findByRole('heading',{name:'档案'});
  fireEvent.change(screen.getByLabelText('新档案名称'),{target:{value:'研究'}});
  fireEvent.click(screen.getByRole('button',{name:'创建档案'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('请输入 1–64 个字符');
});

it('preserves name drafts and never consumes them when deletion reports committed history IO failure',async()=>{
 const consumed=vi.fn();profiles.run.mockRejectedValue({code:'HISTORY_STORAGE_FAILED',message:'private path'});
 mount({onConsumedDraft:consumed});
 fireEvent.change(screen.getByLabelText('Profile name'),{target:{value:'Keep my edit'}});
 fireEvent.change(screen.getByLabelText('New profile name'),{target:{value:'Keep new draft'}});
 fireEvent.click(screen.getByRole('button',{name:'Delete active profile'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('History could not be saved or loaded');
 expect(screen.getByLabelText('Profile name')).toHaveValue('Keep my edit');
 expect(screen.getByLabelText('New profile name')).toHaveValue('Keep new draft');expect(consumed).not.toHaveBeenCalled();
});
