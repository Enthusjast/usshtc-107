import React, { useEffect, useState } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

const electronMocks = vi.hoisted(() => ({
  getTheme: vi.fn(),
  setTheme: vi.fn(),
  setAppLocale: vi.fn(),
  setAppDirty: vi.fn(),
  onThemeChanged: vi.fn(),
  getStatus: vi.fn(),
  getRuntimeInfo: vi.fn(),
  onRuntimeState: vi.fn(), getSettings: vi.fn(), getProfiles: vi.fn(),
  createProfile: vi.fn(), renameProfile: vi.fn(), deleteProfile: vi.fn(), activateProfile: vi.fn(), retryLoadSettings: vi.fn(),
  getStats: vi.fn(), onStatsUpdate: vi.fn(),
  getUpdateState: vi.fn(), onUpdateState: vi.fn(), checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), installUpdate: vi.fn(), openUpdateRelease: vi.fn(),
}));
let emitRuntime;
let emitUpdate;

vi.mock('../src/lib/electron', async (importOriginal) => ({...await importOriginal(), ...electronMocks}));
vi.mock('../src/views/DashboardView', () => ({ default: () => <div>Dashboard content</div> }));
vi.mock('../src/views/SessionsView', () => ({ default: () => <div>Sessions content</div> }));
vi.mock('../src/views/LogsView', () => ({ default: () => <div>Logs content</div> }));
vi.mock('../src/views/DiagnosticsView', () => ({ default: () => <div>Diagnostics content</div> }));
vi.mock('../src/views/SetupView', () => ({ default: ({ onSetupExit, onDirtyChange, onDraftChange }) => <div>Setup content<button type="button" onClick={onSetupExit}>Exit setup</button><button type="button" onClick={() => { onDirtyChange(true); onDraftChange({ dirty: true, draftRevision: 1 }); }}>Edit setup draft</button></div> }));
vi.mock('../src/views/SettingsView', () => ({
  default: function SettingsStub({ onDirtyChange, onDraftChange, onBusyChange, initialSection }) {
    const [password, setPassword] = useState('');
    useEffect(() => {
      onDirtyChange(true);
      onDraftChange({dirty:true,draftRevision:1});
      onBusyChange(true);
      return () => {
        onDirtyChange(false);
        onDraftChange({dirty:false,draftRevision:1});
        onBusyChange(false);
      };
    }, [onBusyChange, onDirtyChange, onDraftChange]);
    return (
      <div>
        Settings content
        <span>Settings section: {initialSection}</span>
        <label>Draft password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <button type="button" onClick={() => onBusyChange(false)}>Finish operation</button>
      </div>
    );
  },
}));

describe('Application navigation guards', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    electronMocks.getTheme.mockReset().mockResolvedValue('dark');
    electronMocks.setTheme.mockReset().mockResolvedValue({});
    electronMocks.setAppLocale.mockReset().mockResolvedValue({});
    electronMocks.setAppDirty.mockReset().mockResolvedValue({});
    electronMocks.onThemeChanged.mockReset().mockReturnValue(vi.fn());
    electronMocks.getStatus.mockReset().mockResolvedValue({profileId:'default',epoch:1,revision:1});
    electronMocks.getRuntimeInfo.mockReset().mockResolvedValue({ scope: { profileId: 'default', epoch: 1 }, draftRevision: 0 });
    const listeners = new Set();
    emitRuntime = (value) => listeners.forEach((callback) => callback(value));
    electronMocks.onRuntimeState.mockReset().mockImplementation((callback) => { listeners.add(callback); return () => listeners.delete(callback); });
    electronMocks.getSettings.mockReset().mockResolvedValue({locale:'en'});
    electronMocks.getProfiles.mockReset().mockResolvedValue({activeProfileId:'default',profiles:[{id:'default',name:'Default',settings:{},onboarding:{status:'dismissed',step:'login'}},{id:'b',name:'Work',settings:{},onboarding:{status:'new',step:'login'}}]});
    electronMocks.activateProfile.mockReset().mockResolvedValue({cancelled:true});
    electronMocks.retryLoadSettings.mockReset().mockResolvedValue({});
    electronMocks.onStatsUpdate.mockReset().mockReturnValue(vi.fn());
    electronMocks.getStats.mockReset().mockResolvedValue({profileId:'default',epoch:1,sequence:1,sampledAt:1000,totalBytesSent:0,totalBytesReceived:0,sessions:[]});
    electronMocks.getUpdateState.mockReset().mockResolvedValue({ phase: 'idle', currentVersion: '1.2.1', availableVersion: null, releaseDate: null, releaseNotes: '', checkedAt: null, progress: null, installMode: 'in-app', errorCode: null });
    const updateListeners = new Set();
    emitUpdate = (value) => updateListeners.forEach((callback) => callback(value));
    electronMocks.onUpdateState.mockReset().mockImplementation((callback) => { updateListeners.add(callback); return () => updateListeners.delete(callback); });
    electronMocks.checkForUpdates.mockReset();
    electronMocks.downloadUpdate.mockReset();
    electronMocks.installUpdate.mockReset();
    electronMocks.openUpdateRelease.mockReset();
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  });

  it('navigates to diagnostics and focuses its heading', async () => {
    render(<App />);
    await screen.findByRole('option', {name:'Work'});
    fireEvent.click(screen.getByRole('button', {name:'Diagnostics'}));
    expect(await screen.findByText('Diagnostics content')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', {level:1,name:'Diagnostics'})).toHaveFocus());
  });
  it('blocks navigation while a settings operation is pending, then confirms dirty changes', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);
    await screen.findByRole('option', { name: 'Work' });

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByText('Settings content')).toBeInTheDocument();
    await waitFor(() => expect(electronMocks.setAppDirty).toHaveBeenCalledWith({scope:{profileId:'default',epoch:1},dirty:true,draftRevision:1}));

    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
    expect(screen.getByText('Settings content')).toBeInTheDocument();
    expect(await screen.findByText('Operation in progress')).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Finish operation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));

    expect(await screen.findByText('Dashboard content')).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledWith('Discard unsaved changes?');
    await waitFor(() => expect(electronMocks.setAppDirty).toHaveBeenLastCalledWith({scope:{profileId:'default',epoch:1},dirty:false,draftRevision:1}));
  });

  it('keeps authentication storage failures visible independently of auth status', async () => {
    electronMocks.getStatus.mockResolvedValue({ profileId: 'default', epoch: 1, revision: 2, errorCode: 'AUTH_REQUIRED', storageErrorCode: 'AUTH_PERSIST_FAILED' });
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Authentication could not be saved securely. Please retry.');
  });

  it('routes from the mobile dialog to the focused page heading', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    render(<App />);
    await screen.findByRole('option', { name: 'Work' });
    const toggles = screen.getAllByRole('button', { name: 'Toggle sidebar' });
    fireEvent.click(toggles.at(-1));
    const drawer = screen.getByRole('dialog', { name: 'Application navigation' });
    expect(drawer).toHaveAttribute('aria-modal', 'true');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Sessions' }));
    expect(await screen.findByText('Sessions content')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Sessions' })).toHaveFocus());
  });

  it('contains Tab focus in the mobile dialog and restores its opener on Escape', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    render(<App />);
    await screen.findByRole('option', { name: 'Work' });
    const opener = screen.getAllByRole('button', { name: 'Toggle sidebar' }).at(-1);
    opener.focus();
    fireEvent.click(opener);
    const drawer = screen.getByRole('dialog', { name: 'Application navigation' });
    const buttons = within(drawer).getAllByRole('button');
    expect(drawer.contains(document.activeElement)).toBe(true);
    buttons.at(-1).focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(buttons[0]).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(buttons.at(-1)).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('keeps drafts and the selected profile when native switching is cancelled without a second confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    render(<App />);
    await screen.findByRole('option', {name:'Work'});
    fireEvent.click(screen.getByRole('button', {name:'Settings'}));
    fireEvent.change(await screen.findByLabelText('Draft password'), {target:{value:'private draft'}});
    fireEvent.click(screen.getByRole('button', {name:'Finish operation'}));
    fireEvent.change(screen.getByLabelText('Active profile'), {target:{value:'b'}});
    await waitFor(() => expect(electronMocks.activateProfile).toHaveBeenCalledWith({scope:{profileId:'default',epoch:1},id:'b'}));
    await waitFor(() => expect(screen.getByLabelText('Active profile')).toBeEnabled());
    expect(screen.getByLabelText('Active profile')).toHaveValue('default');
    expect(screen.getByLabelText('Draft password')).toHaveValue('private draft');
    expect(confirm).not.toHaveBeenCalled();
    expect(electronMocks.setAppDirty).toHaveBeenLastCalledWith({scope:{profileId:'default',epoch:1},dirty:true,draftRevision:1});
  });

  it('remounts the current page and focuses its title after a successful profile switch', async () => {
    let finish;
    electronMocks.activateProfile.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<App />);
    await screen.findByRole('option', {name:'Work'});
    fireEvent.click(screen.getByRole('button', {name:'Settings'}));
    fireEvent.change(await screen.findByLabelText('Draft password'), {target:{value:'old profile secret'}});
    fireEvent.click(screen.getByRole('button', {name:'Finish operation'}));
    fireEvent.change(screen.getByLabelText('Active profile'), {target:{value:'b'}});
    await waitFor(() => expect(electronMocks.activateProfile).toHaveBeenCalled());
    expect(screen.getByLabelText('Active profile')).toBeDisabled();
    await act(async () => {
      const profiles = await electronMocks.getProfiles();
      electronMocks.getProfiles.mockResolvedValue({ ...profiles, activeProfileId: 'b' });
      emitRuntime({profileId:'b',epoch:2,revision:2});
      finish({consumedDraftRevision:1});
    });
    expect(screen.getByLabelText('Active profile')).toHaveValue('b');
    expect(await screen.findByText('Setup content')).toBeInTheDocument();
    expect(screen.queryByLabelText('Draft password')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', {level:1,name:'First-time setup'})).toHaveFocus());
  });

  it('offers scoped retry-load without displaying backend paths and prevents locked preferences and switching', async () => {
    electronMocks.getStatus.mockResolvedValue({profileId:'default',epoch:1,revision:2,storageErrorCode:'SETTINGS_COMMIT_UNKNOWN'});
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The saved settings could not be determined.');
    expect(screen.getByLabelText('Active profile')).toBeDisabled();
    expect(screen.getByRole('button', {name:'Switch to light theme'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button', {name:'Retry loading settings'}));
    await waitFor(() => expect(electronMocks.retryLoadSettings).toHaveBeenCalledWith({profileId:'default',epoch:1}));
  });
  it('keeps update review visible across routes and profile changes, without download or install', async () => {
    render(<App />);
    await screen.findByRole('option', { name: 'Work' });
    act(() => emitUpdate({ phase: 'available', currentVersion: '1.2.1', availableVersion: '1.3.0', releaseDate: null, releaseNotes: '', checkedAt: null, progress: null, installMode: 'in-app', errorCode: null }));
    expect(screen.getByRole('complementary', { name: 'Updates' })).toHaveTextContent('Update 1.3.0 is available');
    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    await screen.findByText('Sessions content');
    expect(screen.getByRole('button', { name: 'Review update' })).toBeInTheDocument();
    act(() => emitRuntime({ profileId: 'b', epoch: 2, revision: 2 }));
    expect(screen.getByRole('button', { name: 'Review update' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review update' }));
    expect(await screen.findByText('Settings section: updates')).toBeInTheDocument();
    expect(electronMocks.downloadUpdate).not.toHaveBeenCalled();
    expect(electronMocks.installUpdate).not.toHaveBeenCalled();
  });

  it('blocks update review navigation while busy and focuses the section without discarding a settings draft', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<App />);
    await screen.findByRole('option', { name: 'Work' });
    act(() => emitUpdate({ phase: 'available', currentVersion: '1.2.1', availableVersion: '1.3.0', releaseDate: null, releaseNotes: '', checkedAt: null, progress: null, installMode: 'in-app', errorCode: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.change(await screen.findByLabelText('Draft password'), { target: { value: 'keep this draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review update' }));
    expect(screen.getByText('Settings section:')).toBeInTheDocument();
    expect(screen.getByLabelText('Draft password')).toHaveValue('keep this draft');
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Finish operation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review update' }));
    expect(screen.getByText('Settings section: updates')).toBeInTheDocument();
    expect(screen.getByLabelText('Draft password')).toHaveValue('keep this draft');
    expect(confirm).not.toHaveBeenCalled();
  });
  it('uses the dirty navigation guard when global update review leaves another route', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    electronMocks.getProfiles.mockResolvedValue({ activeProfileId: 'default', profiles: [{ id: 'default', name: 'Default', settings: {}, onboarding: { status: 'new', step: 'login' } }] });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit setup draft' }));
    act(() => emitUpdate({ phase: 'available', currentVersion: '1.2.1', availableVersion: '1.3.0', releaseDate: null, releaseNotes: '', checkedAt: null, progress: null, installMode: 'in-app', errorCode: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Review update' }));
    expect(screen.getByText('Setup content')).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledWith('Discard unsaved changes?');
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Review update' }));
    expect(await screen.findByText('Settings section: updates')).toBeInTheDocument();
    expect(electronMocks.downloadUpdate).not.toHaveBeenCalled();
    expect(electronMocks.installUpdate).not.toHaveBeenCalled();
  });
});
