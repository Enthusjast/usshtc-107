import React, { useEffect, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import SetupResume from '../src/components/SetupResume';
import en from '../src/i18n/en';

const api = vi.hoisted(() => ({
  getTheme: vi.fn(), setTheme: vi.fn(), setAppLocale: vi.fn(), onThemeChanged: vi.fn(), getSettings: vi.fn(),
  getStatus: vi.fn(), onRuntimeState: vi.fn(), getStats: vi.fn(), onStatsUpdate: vi.fn(), setAppDirty: vi.fn(),
  getRuntimeInfo: vi.fn(),
  getProfiles: vi.fn(), saveOnboarding: vi.fn(), activateProfile: vi.fn(),
  previewSshConfig: vi.fn(), generateSshConfig: vi.fn(), getDiagnostics: vi.fn(), onDiagnosticsState: vi.fn(),
  getUpdateState: vi.fn(), onUpdateState: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), installUpdate: vi.fn(), openUpdateRelease: vi.fn(),
}));
vi.mock('../src/lib/electron', async (original) => ({ ...await original(), ...api }));
vi.mock('../src/views/DashboardView', () => ({ default: ({ onNavigate }) => <div>Dashboard panel<SetupResume onNavigate={onNavigate} /></div> }));
vi.mock('../src/views/SessionsView', () => ({ default: () => <div>Sessions panel</div> }));
vi.mock('../src/views/LogsView', () => ({ default: () => <div>Logs panel</div> }));
vi.mock('../src/views/SettingsView', () => ({
  default: function SettingsStub({ onNavigate, onDirtyChange, onDraftChange }) {
    const [draft, setDraft] = useState('');
    useEffect(() => {
      onDirtyChange(Boolean(draft));
      onDraftChange({ dirty: Boolean(draft), draftRevision: draft ? 1 : 0 });
    }, [draft, onDirtyChange, onDraftChange]);
    useEffect(() => () => { onDirtyChange(false); onDraftChange({ dirty: false, draftRevision: 1 }); }, [onDirtyChange, onDraftChange]);
    return <div>Settings panel<label htmlFor="setup-test-draft">Settings draft</label><input id="setup-test-draft" value={draft} onChange={(event) => setDraft(event.target.value)} /><SetupResume onNavigate={onNavigate} /></div>;
  },
}));

const config = { host: '127.0.0.1', port: 3000, cluster: 'training', loginNode: '11.11.10.202', cols: 80, rows: 24, useRoot: false, wssUrl: 'wss://fixed.invalid/' };
let profiles;
let snapshot;
let listeners;
function publish(extra) { snapshot = { ...snapshot, revision: snapshot.revision + 1, ...extra }; listeners.forEach((listener) => listener(snapshot)); }
function profile(id, status = 'new', step = 'login') { return { id, name: id === 'default' ? 'Default' : id, settings: { ...config, sshAlias: id === 'default' ? 'usshtc107' : `usshtc107-${id}` }, onboarding: { status, step } }; }
function initial(status = 'new', step = 'login') { profiles = { activeProfileId: 'default', profiles: [profile('default', status, step), profile('Work', 'dismissed', 'config'), profile('Fresh', 'new', 'config')] }; }

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  initial();
  snapshot = { profileId: 'default', epoch: 1, revision: 1, loginStatus: 'idle', cookieValid: false, proxyStatus: 'stopped', runningConfig: null, desiredConfig: config, operation: null, storageErrorCode: null };
  listeners = new Set();
  api.getTheme.mockResolvedValue('dark');
  api.onThemeChanged.mockReturnValue(vi.fn());
  api.getSettings.mockResolvedValue({ ...config, locale: 'en' });
  api.getStatus.mockImplementation(async () => snapshot);
  api.getRuntimeInfo.mockImplementation(async () => ({ scope: { profileId: snapshot.profileId, epoch: snapshot.epoch }, draftRevision: 0 }));
  api.onRuntimeState.mockImplementation((listener) => { listeners.add(listener); return () => listeners.delete(listener); });
  api.getStats.mockResolvedValue({ ...snapshot, sequence: 1, sampledAt: 1000, totalBytesSent: 0, totalBytesReceived: 0, sessions: [] });
  api.onStatsUpdate.mockReturnValue(vi.fn());
  api.setAppDirty.mockResolvedValue({});
  api.getProfiles.mockImplementation(async () => profiles);
  api.saveOnboarding.mockImplementation(async ({ scope, status, step }) => {
    profiles = { ...profiles, profiles: profiles.profiles.map((item) => item.id === scope.profileId ? { ...item, onboarding: { status, step } } : item) };
    return profiles;
  });
  api.activateProfile.mockImplementation(async ({ id }) => {
    profiles = { ...profiles, activeProfileId: id };
    publish({ profileId: id, epoch: snapshot.epoch + 1 });
    return { consumedDraftRevision: 0 };
  });
  api.previewSshConfig.mockResolvedValue({ block: '# managed\nHost usshtc107\nHost *', changed: true, sourceHash: 'a'.repeat(64), configHash: 'b'.repeat(64), backupPath: null });
  api.generateSshConfig.mockResolvedValue({ cancelled: true });
  api.getDiagnostics.mockResolvedValue(null);
  api.onDiagnosticsState.mockReturnValue(vi.fn());
  api.getUpdateState.mockResolvedValue({ phase: 'idle', currentVersion: '1.2.1', availableVersion: null, releaseDate: null, releaseNotes: '', checkedAt: null, progress: null, installMode: 'in-app', errorCode: null });
  api.onUpdateState.mockReturnValue(vi.fn());
});

describe('Setup route integration', () => {
  it('automatically enters only a new profile on initial activation, without adding a permanent navigation item', async () => {
    render(<App />);
    expect(await screen.findByRole('heading', { level: 1, name: en.setupTitle })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: en.setupStep_login })).toBeInTheDocument();
    const navigation = screen.getByRole('navigation', { name: 'Primary navigation' });
    expect([...navigation.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Dashboard', 'Sessions', 'Logs', 'Diagnostics']);
    expect(api.saveOnboarding).not.toHaveBeenCalled();
    expect(api.generateSshConfig).not.toHaveBeenCalled();
  });

  it.each(['dismissed', 'completed'])('does not force a %s profile into setup when it has no Cookie', async (status) => {
    initial(status);
    render(<App />);
    await screen.findByRole('option', { name: 'Fresh' });
    expect(screen.getByText('Dashboard panel')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: en.setupTitle })).not.toBeInTheDocument();
    expect(Boolean(screen.queryByRole('button', { name: en.setupResume }))).toBe(status === 'dismissed');
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    await screen.findByText('Sessions panel');
    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
    expect(await screen.findByText('Dashboard panel')).toBeInTheDocument();
  });

  it('does not reopen a new profile’s guide on ordinary navigation, refresh or its own epoch changes', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: en.setupTitle });
    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
    expect(await screen.findByText('Dashboard panel')).toBeInTheDocument();
    act(() => publish({ epoch: 2 }));
    await waitFor(() => expect(api.getProfiles).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    await screen.findByText('Sessions panel');
    expect(screen.queryByRole('heading', { level: 1, name: en.setupTitle })).not.toBeInTheDocument();
  });

  it('persists Skip, focuses Dashboard on exit and resumes the saved step from both Dashboard and Settings', async () => {
    initial('new', 'config');
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: en.setupSkip }));
    await screen.findByText('Dashboard panel');
    expect(api.saveOnboarding).toHaveBeenCalledExactlyOnceWith({ scope: { profileId: 'default', epoch: 1 }, status: 'dismissed', step: 'config' });
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: en.setupResume }));
    expect(await screen.findByRole('heading', { name: en.setupStep_config })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByText('Settings panel');
    fireEvent.click(screen.getByRole('button', { name: en.setupResume }));
    expect(await screen.findByRole('heading', { name: en.setupStep_config })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: en.setupTitle })).toHaveFocus());
    expect(api.previewSshConfig).not.toHaveBeenCalled();
    expect(api.generateSshConfig).not.toHaveBeenCalled();
  });

  it('returns a switched dismissed profile to Dashboard and auto-enters a newly activated fresh profile, with title focus', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1, name: en.setupTitle });
    fireEvent.change(screen.getByLabelText('Active profile'), { target: { value: 'Work' } });
    await screen.findByText('Dashboard panel');
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toHaveFocus());
    await waitFor(() => expect(screen.getByLabelText('Active profile')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Active profile'), { target: { value: 'Fresh' } });
    await screen.findByRole('heading', { name: en.setupStep_config });
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: en.setupTitle })).toHaveFocus());
    expect(screen.getByLabelText('Active profile')).toHaveValue('Fresh');
    expect(api.saveOnboarding).not.toHaveBeenCalled();
  });

  it('keeps the current guide and step when native profile switching is cancelled', async () => {
    initial('new', 'config');
    api.activateProfile.mockResolvedValue({ cancelled: true });
    const confirm = vi.spyOn(window, 'confirm');
    render(<App />);
    await screen.findByRole('heading', { name: en.setupStep_config });
    fireEvent.change(screen.getByLabelText('Active profile'), { target: { value: 'Work' } });
    await waitFor(() => expect(api.activateProfile).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByLabelText('Active profile')).toBeEnabled());
    expect(screen.getByLabelText('Active profile')).toHaveValue('default');
    expect(screen.getByRole('heading', { name: en.setupStep_config })).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('keeps the existing dirty navigation guard when resuming from Settings', async () => {
    initial('dismissed', 'config');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<App />);
    await screen.findByRole('option', { name: 'Work' });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.change(await screen.findByLabelText('Settings draft'), { target: { value: 'unsaved' } });
    fireEvent.click(screen.getByRole('button', { name: en.setupResume }));
    expect(screen.getByLabelText('Settings draft')).toHaveValue('unsaved');
    expect(confirm).toHaveBeenCalledWith('Discard unsaved changes?');
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: en.setupResume }));
    await screen.findByRole('heading', { name: en.setupStep_config });
    expect(screen.queryByLabelText('Settings draft')).not.toBeInTheDocument();
    expect(api.saveOnboarding).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('blocks navigation and profile switching during an explicit config write and leaves cancellation recoverable', async () => {
    initial('new', 'config');
    let finish;
    api.generateSshConfig.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: en.previewSshConfig }));
    await waitFor(() => expect(screen.getByRole('button', { name: en.generateSshConfig })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: en.generateSshConfig }));
    await waitFor(() => expect(screen.getByLabelText('Active profile')).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
    expect(await screen.findByText('Operation in progress')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: en.setupTitle })).toBeInTheDocument();
    await act(async () => finish({ cancelled: true }));
    expect(screen.getByText(en.sshConfigCancelled)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Active profile')).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
    await screen.findByText('Dashboard panel');
  });

  it('exits only after main accepts diagnostic completion and does not offer Resume afterward', async () => {
    initial('new', 'verify');
    snapshot = { ...snapshot, loginStatus: 'success', cookieValid: true, proxyStatus: 'started', runningConfig: config };
    const codes = { settings: 'SETTINGS_OK', keys: 'KEYS_OK', 'ssh-config': 'SSH_CONFIG_OK', 'local-listener': 'LOCAL_SSH_OK', dns: 'DNS_OK', tls: 'TLS_OK', wss: 'WSS_HANDSHAKE_OK' };
    api.getDiagnostics.mockResolvedValue({ profileId: 'default', epoch: 1, runId: 'verified-run', configFingerprint: 'main-fingerprint', startedAt: '2026-10-24T00:00:00.000Z', finishedAt: '2026-10-24T00:00:01.000Z', checks: Object.entries(codes).map(([id, code]) => ({ id, status: 'passed', code, durationMs: 4, ...(id === 'local-listener' ? { mode: 'ssh-auth' } : {}) })) });
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', { name: en.setupFinish })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: en.setupFinish }));
    await screen.findByText('Dashboard panel');
    expect(api.saveOnboarding).toHaveBeenCalledExactlyOnceWith({ scope: { profileId: 'default', epoch: 1 }, status: 'completed', step: 'verify', runId: 'verified-run' });
    expect(screen.queryByRole('button', { name: en.setupResume })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toHaveFocus());
  });
});
