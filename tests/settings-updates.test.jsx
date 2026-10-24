import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SettingsView from '../src/views/SettingsView';
import { UpdateProvider } from '../src/contexts/UpdateContext';
import { LocaleProvider } from '../src/i18n/LocaleContext';
import { ToastProvider } from '../src/components/Toast';
import en from '../src/i18n/en';

const api = vi.hoisted(() => ({
  getSettings: vi.fn(), getRuntimeInfo: vi.fn(), getSsoCredentials: vi.fn(), getStatus: vi.fn(), onRuntimeState: vi.fn(),
  saveSettings: vi.fn(), saveAppSettings: vi.fn(), saveSsoCredentials: vi.fn(), setAppLocale: vi.fn(),
  getUpdateState: vi.fn(), onUpdateState: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), installUpdate: vi.fn(), openUpdateRelease: vi.fn(),
}));
const runtime = vi.hoisted(() => ({ scope: { profileId: 'default', epoch: 1 }, snapshot: {}, flushDraft: vi.fn(), retry: vi.fn(), getDraftRevision: vi.fn(), getScope: vi.fn() }));
vi.mock('../src/lib/electron', async (original) => ({ ...await original(), ...api }));
vi.mock('../src/contexts/RuntimeContext', () => ({ useRuntime: () => runtime, sameScope: (a, b) => Boolean(a && b && a.profileId === b.profileId && a.epoch === b.epoch) }));
vi.mock('../src/components/ProfileManagement', () => ({ default: () => null }));
vi.mock('../src/components/SetupResume', () => ({ default: () => null }));
vi.mock('../src/components/AutostartControl', () => ({ default: () => null }));
vi.mock('../src/components/SshKeyPanel', () => ({ default: () => null }));
vi.mock('../src/components/SshConfigPreview', () => ({ default: () => null }));
const saved = { host: '127.0.0.1', port: 3000, cluster: 'training', loginNode: 'localhost', cols: 80, rows: 24, useRoot: false, autoConnect: false, autoCheckUpdates: false, sshAlias: 'usshtc107', locale: 'en' };
let emit;
function mount(props = {}) {
  return render(<LocaleProvider><ToastProvider><UpdateProvider><SettingsView {...props} /></UpdateProvider></ToastProvider></LocaleProvider>);
}
beforeEach(() => {
  vi.resetAllMocks();
  runtime.scope = { profileId: 'default', epoch: 1 };
  runtime.snapshot = {};
  runtime.getScope.mockImplementation(() => runtime.scope);
  runtime.getDraftRevision.mockReturnValue(0);
  runtime.flushDraft.mockResolvedValue();
  runtime.retry.mockResolvedValue();
  api.getStatus.mockResolvedValue({ ...runtime.scope, revision: 1 });
  api.onRuntimeState.mockReturnValue(vi.fn());
  api.getSettings.mockResolvedValue(saved);
  api.getRuntimeInfo.mockResolvedValue({ platform: 'linux', devMode: false });
  api.getSsoCredentials.mockResolvedValue({ profileId: 'default', username: 'account', hasPassword: true, storageAvailable: true });
  api.saveAppSettings.mockResolvedValue({});
  api.getUpdateState.mockResolvedValue({ phase: 'downloaded', currentVersion: '1.2.1', availableVersion: '1.3.0', releaseDate: null, releaseNotes: '', checkedAt: null, progress: null, installMode: 'in-app', errorCode: null });
  const listeners = new Set();
  api.onUpdateState.mockImplementation((callback) => { listeners.add(callback); return () => listeners.delete(callback); });
  emit = (value) => listeners.forEach((callback) => callback(value));
  api.installUpdate.mockResolvedValue({ cancelled: true });
});

describe('Settings update and draft integration', () => {
  it('isolates updater read failure and retry from the normal settings, credentials and saved preference', async () => {
    api.getUpdateState.mockRejectedValueOnce({ code: 'UPDATE_NETWORK', message: '/private/download/cache' });
    mount();
    const host = await screen.findByLabelText('Host');
    expect(host).toBeEnabled();
    expect(screen.getByLabelText('Automatically check for updates')).not.toBeChecked();
    expect(screen.getByRole('alert')).toHaveTextContent(en.error_UPDATE_NETWORK);
    expect(screen.queryByText(/private\/download/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('button', { name: en.updateInstallRestart })).toBeEnabled());
    fireEvent.click(screen.getByLabelText('Automatically check for updates'));
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    await waitFor(() => expect(api.saveAppSettings).toHaveBeenCalledExactlyOnceWith({ autoCheckUpdates: true }));
    expect(api.downloadUpdate).not.toHaveBeenCalled();
    expect(api.installUpdate).not.toHaveBeenCalled();
  });

  it('focuses the updates review section and never auto-starts a downloaded update', async () => {
    mount({ initialSection: 'updates' });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Updates' })).toHaveFocus());
    expect(api.checkForUpdates).not.toHaveBeenCalled();
    expect(api.downloadUpdate).not.toHaveBeenCalled();
    expect(api.installUpdate).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'preparation'])('keeps the actual Settings password/connection drafts after %s', async (outcome) => {
    if (outcome === 'preparation') api.installUpdate.mockRejectedValue({ code: 'UPDATE_PREPARATION_FAILED' });
    const draft = vi.fn();
    const confirm = vi.spyOn(window, 'confirm');
    mount({ onDraftChange: draft });
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'unsaved password' } });
    fireEvent.change(screen.getByLabelText('Port (1–65535)'), { target: { value: '4000' } });
    fireEvent.click(screen.getByRole('button', { name: en.updateInstallRestart }));
    await waitFor(() => expect(api.installUpdate).toHaveBeenCalledExactlyOnceWith({ version: '1.3.0' }));
    await waitFor(() => expect(screen.getByRole('button', { name: en.updateInstallRestart })).toBeEnabled());
    expect(screen.getByLabelText('Password')).toHaveValue('unsaved password');
    expect(screen.getByLabelText('Port (1–65535)')).toHaveValue(4000);
    expect(draft).toHaveBeenLastCalledWith({ dirty: true, draftRevision: 2 });
    expect(runtime.flushDraft).toHaveBeenCalledTimes(1);
    expect(api.saveSettings).not.toHaveBeenCalled();
    expect(api.saveSsoCredentials).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('consumes exactly the confirmed draft revision on successful handoff and preserves newer edits', async () => {
    let finish;
    api.installUpdate.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const draft = vi.fn();
    mount({ onDraftChange: draft });
    fireEvent.change(await screen.findByLabelText('Password'), { target: { value: 'first draft' } });
    fireEvent.click(screen.getByRole('button', { name: en.updateInstallRestart }));
    await waitFor(() => expect(api.installUpdate).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'newer draft' } });
    await act(async () => finish({ consumedDraftRevision: 1 }));
    expect(screen.getByLabelText('Password')).toHaveValue('newer draft');
    expect(draft).toHaveBeenLastCalledWith({ dirty: true, draftRevision: 2 });
    await waitFor(() => expect(screen.getByRole('button', { name: en.updateInstallRestart })).toBeEnabled());
    api.installUpdate.mockResolvedValueOnce({ consumedDraftRevision: 2 });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.updateInstallRestart })); });
    await waitFor(() => expect(screen.getByLabelText('Password')).toHaveValue(''));
    expect(draft).toHaveBeenLastCalledWith({ dirty: false, draftRevision: 2 });
  });

  it('reports native staging busy through the existing route guard callback and clears it after error', async () => {
    const onBusyChange = vi.fn();
    mount({ onBusyChange });
    await screen.findByLabelText('Host');
    act(() => emit({ phase: 'staging', currentVersion: '1.2.1', availableVersion: '1.3.0', releaseDate: null, releaseNotes: '', checkedAt: null, progress: null, installMode: 'in-app', errorCode: null }));
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole('button', { name: 'Reset to defaults' })).toBeDisabled();
    act(() => emit({ phase: 'error', currentVersion: '1.2.1', availableVersion: '1.3.0', releaseDate: null, releaseNotes: '', checkedAt: null, progress: null, installMode: 'in-app', errorCode: 'UPDATE_INSTALL_FAILED' }));
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    expect(screen.getByText(en.updateRestartRequiredHint)).toBeInTheDocument();
    expect(screen.getByLabelText('Host')).toBeEnabled();
  });
});
