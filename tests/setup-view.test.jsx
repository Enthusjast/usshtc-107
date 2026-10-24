import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SetupView from '../src/views/SetupView';
import SetupResume from '../src/components/SetupResume';
import { ProfileProvider, useProfiles } from '../src/contexts/ProfileContext';
import { LocaleProvider } from '../src/i18n/LocaleContext';
import { ToastProvider } from '../src/components/Toast';
import en from '../src/i18n/en';
import zh from '../src/i18n/zh';

const api = vi.hoisted(() => ({
  getProfiles: vi.fn(), saveOnboarding: vi.fn(), getStatus: vi.fn(), getSettings: vi.fn(), onRuntimeState: vi.fn(),
  startLogin: vi.fn(), startProxy: vi.fn(), restartProxy: vi.fn(), retryRecovery: vi.fn(),
  previewSshConfig: vi.fn(), generateSshConfig: vi.fn(), getDiagnostics: vi.fn(), startDiagnostics: vi.fn(),
  cancelDiagnostics: vi.fn(), onDiagnosticsState: vi.fn(), saveSsoCredentials: vi.fn(), setAutostart: vi.fn(),
}));
const runtime = vi.hoisted(() => ({ scope: null, snapshot: null, getScope: vi.fn(), getSnapshot: vi.fn(), retry: vi.fn(), flushDraft: vi.fn() }));
vi.mock('../src/lib/electron', async (original) => ({ ...await original(), ...api }));
vi.mock('../src/contexts/RuntimeContext', async (original) => ({ ...await original(), useRuntime: () => runtime }));

const config = { host: '127.0.0.1', port: 3000, cluster: 'training', loginNode: '11.11.10.202', cols: 80, rows: 24, useRoot: false, path: '', startupCommand: '', wssUrl: 'wss://fixed.invalid/' };
const preview = { block: '# managed\nHost usshtc107\n  Port 3000\nHost *\n', changed: true, sourceHash: 'a'.repeat(64), configHash: 'b'.repeat(64), backupPath: null };
const ids = ['settings', 'keys', 'ssh-config', 'local-listener', 'dns', 'tls', 'token', 'setup', 'wss', 'remote-command'];
const codes = ['SETTINGS_OK', 'KEYS_OK', 'SSH_CONFIG_OK', 'LOCAL_SSH_OK', 'DNS_OK', 'TLS_OK', 'TOKEN_OK', 'SETUP_OK', 'WSS_SHELL_READY', 'REMOTE_COMMAND_OK'];
let profiles;
let listeners;
const emit = (value) => listeners.forEach((listener) => listener(value));
const validRun = (extra = {}) => ({
  ...runtime.scope, runId: 'run-1', configFingerprint: 'main-only-fingerprint',
  startedAt: '2026-10-24T00:00:00.000Z', finishedAt: '2026-10-24T00:00:01.000Z',
  checks: ids.map((id, index) => ({ id, status: 'passed', code: codes[index], durationMs: 12, ...(id === 'local-listener' ? { mode: 'ssh-auth' } : {}) })),
  ...extra,
});
const changeCheck = (run, id, change) => ({ ...run, checks: run.checks.map((check) => check.id === id ? { ...check, ...change } : check) });
function setStep(step, status = 'new') {
  profiles = { activeProfileId: 'default', profiles: [{ id: 'default', name: 'Default', settings: { ...config, sshAlias: 'usshtc107' }, onboarding: { status, step } }] };
}
function Ready({ children }) { return useProfiles().data ? children : null; }
function Harness(props) {
  return <LocaleProvider><ToastProvider><ProfileProvider><Ready>{props.resume ? <SetupResume onNavigate={props.onNavigate} /> : <SetupView {...props} />}</Ready></ProfileProvider></ToastProvider></LocaleProvider>;
}
function mount(props = {}) { return render(<Harness {...props} />); }

beforeEach(() => {
  vi.resetAllMocks();
  runtime.scope = { profileId: 'default', epoch: 1 };
  runtime.snapshot = { ...runtime.scope, revision: 1, desiredConfig: config, runningConfig: config, proxyStatus: 'started', loginStatus: 'success', loginStage: null, cookieValid: true, operation: null, storageErrorCode: null };
  runtime.getScope.mockImplementation(() => runtime.scope);
  runtime.getSnapshot.mockImplementation(() => runtime.snapshot);
  runtime.retry.mockResolvedValue();
  runtime.flushDraft.mockResolvedValue();
  setStep('login');
  api.getProfiles.mockImplementation(async () => profiles);
  api.saveOnboarding.mockImplementation(async ({ status, step }) => {
    profiles = { ...profiles, profiles: profiles.profiles.map((profile) => profile.id === runtime.scope.profileId ? { ...profile, onboarding: { status, step } } : profile) };
    return profiles;
  });
  api.getStatus.mockImplementation(async () => runtime.snapshot);
  api.getSettings.mockResolvedValue({ locale: 'en' });
  api.onRuntimeState.mockReturnValue(vi.fn());
  api.startLogin.mockResolvedValue({});
  api.startProxy.mockResolvedValue({});
  api.restartProxy.mockResolvedValue({});
  api.retryRecovery.mockResolvedValue({});
  api.previewSshConfig.mockResolvedValue(preview);
  api.generateSshConfig.mockResolvedValue({ ...preview, changed: true });
  api.getDiagnostics.mockResolvedValue(null);
  api.startDiagnostics.mockImplementation(async () => validRun());
  api.cancelDiagnostics.mockResolvedValue({ cancelled: true });
  listeners = new Set();
  api.onDiagnosticsState.mockImplementation((listener) => { listeners.add(listener); return () => listeners.delete(listener); });
});

describe('Temporary first-use setup', () => {
  it('waits for a valid login and never changes passwords, OS registration or SSH config automatically', async () => {
    runtime.snapshot = { ...runtime.snapshot, loginStatus: 'idle', cookieValid: false, runningConfig: null, proxyStatus: 'stopped' };
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Login' }));
    await waitFor(() => expect(api.startLogin).toHaveBeenCalledExactlyOnceWith(runtime.scope));
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByText(en.setupNoAutomaticChanges)).toBeInTheDocument();
    expect(api.saveOnboarding).not.toHaveBeenCalled();
    expect(api.saveSsoCredentials).not.toHaveBeenCalled();
    expect(api.setAutostart).not.toHaveBeenCalled();
    expect(api.previewSshConfig).not.toHaveBeenCalled();
    expect(api.generateSshConfig).not.toHaveBeenCalled();
  });

  it('persists Next and Back before changing steps and moves focus to the step heading', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await screen.findByRole('heading', { name: 'Review SSH config' });
    expect(api.saveOnboarding).toHaveBeenLastCalledWith({ scope: runtime.scope, status: 'new', step: 'config' });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Review SSH config' })).toHaveFocus());
    expect(api.previewSshConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { name: 'Log in' });
    expect(api.saveOnboarding).toHaveBeenLastCalledWith({ scope: runtime.scope, status: 'new', step: 'login' });
  });

  it('retains the current step when progress saving fails and Retry repeats only the failed save', async () => {
    api.saveOnboarding.mockRejectedValueOnce({ code: 'SETTINGS_SAVE_FAILED', message: '/private/account-secret' });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('alert')).not.toHaveTextContent('/private/account-secret');
    expect(screen.getByRole('heading', { name: 'Log in' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('heading', { name: 'Review SSH config' });
    expect(api.saveOnboarding).toHaveBeenCalledTimes(2);
    expect(api.startLogin).not.toHaveBeenCalled();
  });

  it('requires explicit preview and generation when the existing block differs', async () => {
    setStep('config');
    mount();
    const next = await screen.findByRole('button', { name: 'Next' });
    expect(next).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview saved SSH config' }));
    expect(await screen.findByLabelText(en.sshConfigManagedPreview)).toHaveTextContent('Host usshtc107');
    expect(next).toBeDisabled();
    expect(api.generateSshConfig).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: en.generateSshConfig }));
    await waitFor(() => expect(next).toBeEnabled());
    expect(api.generateSshConfig).toHaveBeenCalledExactlyOnceWith({ scope: runtime.scope, sourceHash: preview.sourceHash, configHash: preview.configHash });
    fireEvent.click(next);
    await screen.findByRole('heading', { name: 'Start the proxy' });
  });

  it('accepts an explicitly reviewed existing match without rewriting it', async () => {
    setStep('config');
    api.previewSshConfig.mockResolvedValue({ ...preview, changed: false });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Preview saved SSH config' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    expect(screen.getByText(en.setupConfigReady)).toBeInTheDocument();
    expect(api.generateSshConfig).not.toHaveBeenCalled();
  });

  it('shows config pending and cancellation, and preserves the step for another explicit attempt', async () => {
    setStep('config');
    let finish;
    api.generateSshConfig.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const onBusyChange = vi.fn();
    mount({ onBusyChange });
    fireEvent.click(await screen.findByRole('button', { name: 'Preview saved SSH config' }));
    await waitFor(() => expect(screen.getByRole('button', { name: en.generateSshConfig })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: en.generateSshConfig }));
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeDisabled();
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));
    await act(async () => finish({ cancelled: true }));
    expect(screen.getByText(en.sshConfigCancelled)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Preview saved SSH config' })).toBeEnabled();
    expect(api.saveOnboarding).not.toHaveBeenCalled();
  });

  it('invalidates a reviewed config when saved configuration or scope changes', async () => {
    setStep('config');
    api.previewSshConfig.mockResolvedValue({ ...preview, changed: false });
    const view = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Preview saved SSH config' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
    runtime.snapshot = { ...runtime.snapshot, desiredConfig: { ...config, port: 4000 } };
    view.rerender(<Harness />);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(screen.queryByText(en.setupConfigReady)).not.toBeInTheDocument();
  });

  it('saves Skip as dismissed with the current step and resumes that step without side effects', async () => {
    setStep('config');
    const onSetupExit = vi.fn();
    const view = mount({ onSetupExit });
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(onSetupExit).toHaveBeenCalledOnce());
    expect(api.saveOnboarding).toHaveBeenCalledExactlyOnceWith({ scope: runtime.scope, status: 'dismissed', step: 'config' });
    view.unmount();
    const onNavigate = vi.fn();
    const resume = mount({ resume: true, onNavigate });
    fireEvent.click(await screen.findByRole('button', { name: 'Resume setup' }));
    expect(onNavigate).toHaveBeenCalledWith('setup');
    resume.unmount();
    mount();
    expect(await screen.findByRole('heading', { name: 'Review SSH config' })).toBeInTheDocument();
    expect(api.generateSshConfig).not.toHaveBeenCalled();
    expect(api.startLogin).not.toHaveBeenCalled();
  });

  it('hides Resume for completed profiles instead of inferring newness from absent credentials', async () => {
    setStep('verify', 'completed');
    runtime.snapshot = { ...runtime.snapshot, cookieValid: false, loginStatus: 'idle' };
    mount({ resume: true, onNavigate: vi.fn() });
    await waitFor(() => expect(api.getProfiles).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Resume setup' })).not.toBeInTheDocument();
    expect(api.saveOnboarding).not.toHaveBeenCalled();
  });

  it('retains its own login failure across an epoch change and retries with the new scope', async () => {
    let reject;
    api.startLogin.mockReturnValueOnce(new Promise((resolve, fail) => { reject = fail; }));
    const busy = vi.fn();
    const view = mount({ onBusyChange: busy });
    fireEvent.click(await screen.findByRole('button', { name: 'Re-login' }));
    await waitFor(() => expect(api.startLogin).toHaveBeenCalled());
    runtime.scope = { profileId: 'default', epoch: 2 };
    runtime.snapshot = { ...runtime.snapshot, ...runtime.scope, revision: 2, loginStatus: 'failure', cookieValid: false, errorCode: 'INTERNAL_ERROR' };
    view.rerender(<Harness onBusyChange={busy} />);
    await act(async () => reject({ code: 'INTERNAL_ERROR' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(en.error_INTERNAL_ERROR);
    await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false));
    api.startLogin.mockResolvedValueOnce({ cancelled: true });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.startLogin).toHaveBeenLastCalledWith(runtime.scope));
    expect(await screen.findByText(en.setupActionCancelled)).toBeInTheDocument();
  });

  it('requires running=desired, confirms restart through the existing action, and keeps its own epoch result', async () => {
    setStep('connect');
    runtime.snapshot = { ...runtime.snapshot, runningConfig: { ...config, port: 2000 }, needsRestart: true };
    let finish;
    api.restartProxy.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const view = mount();
    const confirm = vi.spyOn(window, 'confirm');
    const next = await screen.findByRole('button', { name: 'Next' });
    expect(next).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Restart and apply' }));
    await waitFor(() => expect(api.restartProxy).toHaveBeenCalledWith(runtime.scope));
    expect(runtime.flushDraft.mock.invocationCallOrder[0]).toBeLessThan(api.restartProxy.mock.invocationCallOrder[0]);
    runtime.scope = { profileId: 'default', epoch: 2 };
    runtime.snapshot = { ...runtime.snapshot, ...runtime.scope, runningConfig: config, needsRestart: false };
    view.rerender(<Harness />);
    await act(async () => finish({}));
    expect(await screen.findByText(en.setupConnectFinished)).toBeInTheDocument();
    expect(next).toBeEnabled();
    expect(confirm).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('keeps its own start failure after an epoch change and retries against the current scope', async () => {
    setStep('connect');
    runtime.snapshot = { ...runtime.snapshot, proxyStatus: 'stopped', runningConfig: null };
    let reject;
    api.startProxy.mockReturnValueOnce(new Promise((resolve, fail) => { reject = fail; }));
    const view = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Start' }));
    await waitFor(() => expect(api.startProxy).toHaveBeenCalledExactlyOnceWith({ profileId: 'default', epoch: 1 }));
    runtime.scope = { profileId: 'default', epoch: 2 };
    runtime.snapshot = { ...runtime.snapshot, ...runtime.scope, proxyStatus: 'error', errorCode: 'PORT_IN_USE' };
    view.rerender(<Harness />);
    await act(async () => reject({ code: 'PORT_IN_USE' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(en.error_PORT_IN_USE);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.startProxy).toHaveBeenLastCalledWith(runtime.scope));
    expect(await screen.findByText(en.setupConnectFinished)).toBeInTheDocument();
  });

  it('does not deliver a previous profile’s pending action into the next profile’s guide', async () => {
    let reject;
    api.startLogin.mockReturnValueOnce(new Promise((resolve, fail) => { reject = fail; }));
    const view = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Re-login' }));
    await waitFor(() => expect(api.startLogin).toHaveBeenCalled());
    runtime.scope = { profileId: 'work', epoch: 2 };
    runtime.snapshot = { ...runtime.snapshot, ...runtime.scope };
    profiles = { activeProfileId: 'work', profiles: [{ ...profiles.profiles[0], id: 'work', name: 'Work', onboarding: { status: 'new', step: 'login' } }] };
    view.rerender(<Harness key="work" />);
    await screen.findByRole('button', { name: 'Re-login' });
    await act(async () => reject({ code: 'INTERNAL_ERROR' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });

  it.each([
    ['bind-only', (run) => changeCheck(run, 'local-listener', { code: 'LOCAL_PORT_AVAILABLE', mode: 'bind-only' })],
    ['bind-only with an SSH code', (run) => changeCheck(run, 'local-listener', { mode: 'bind-only' })],
    ['a failed WSS upgrade', (run) => changeCheck(run, 'wss', { status: 'failed', code: 'WSS_FAILED' })],
    ['a handshake-only result', (run) => changeCheck(run, 'wss', { code: 'WSS_HANDSHAKE_OK' })],
    ['readiness silence', (run) => changeCheck(run, 'wss', { status: 'failed', code: 'REMOTE_READY_TIMEOUT' })],
    ['a failed marker command', (run) => changeCheck(run, 'remote-command', { status: 'failed', code: 'REMOTE_COMMAND_FAILED' })],
    ['a missing marker command', (run) => ({ ...run, checks: run.checks.filter((check) => check.id !== 'remote-command') })],
    ['a missing token check', (run) => ({ ...run, checks: run.checks.filter((check) => check.id !== 'token') })],
    ['a missing setup check', (run) => ({ ...run, checks: run.checks.filter((check) => check.id !== 'setup') })],
    ['old eight-check proof', (run) => ({ ...run, checks: run.checks.filter((check) => !['token', 'setup'].includes(check.id)) })],
    ['a rejected token', (run) => changeCheck(run, 'token', { status: 'failed', code: 'AUTH_REQUIRED' })],
    ['a skipped token check', (run) => changeCheck(run, 'token', { status: 'skipped' })],
    ['token success with the wrong code', (run) => changeCheck(run, 'token', { code: 'SETUP_OK' })],
    ['an unsuccessful setup request', (run) => changeCheck(run, 'setup', { status: 'failed', code: 'PORTAL_NETWORK' })],
    ['a skipped setup check', (run) => changeCheck(run, 'setup', { status: 'skipped' })],
    ['setup success with the wrong code', (run) => changeCheck(run, 'setup', { code: 'TOKEN_OK' })],
    ['a skipped independent check', (run) => changeCheck(run, 'keys', { status: 'skipped', code: 'DEPENDENCY_FAILED' })],
    ['an invalid completion timestamp', (run) => ({ ...run, finishedAt: 'invalid' })],
    ['a mismatched managed block', (run) => changeCheck(run, 'ssh-config', { status: 'failed', code: 'SSH_CONFIG_MISMATCH' })],
    ['an unfinished run', (run) => ({ ...run, finishedAt: null })],
  ])('does not treat %s as completed setup', async (label, modify) => {
    setStep('verify');
    api.getDiagnostics.mockResolvedValue(modify(validRun()));
    mount();
    await screen.findByRole('list', { name: en.diagnosticsChecks });
    await waitFor(() => expect(api.getDiagnostics).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Finish setup' })).toBeDisabled();
    expect(api.saveOnboarding).not.toHaveBeenCalled();
  });

  it('completes only with the latest scoped proof and sends its main-issued runId', async () => {
    setStep('verify');
    api.getDiagnostics.mockResolvedValue(validRun());
    const onSetupExit = vi.fn();
    mount({ onSetupExit });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Finish setup' })).toBeEnabled());
    act(() => emit(validRun({ runId: 'run-2', startedAt: '2026-10-24T00:00:02.000Z', finishedAt: '2026-10-24T00:00:03.000Z' })));
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(onSetupExit).toHaveBeenCalledOnce());
    expect(api.saveOnboarding).toHaveBeenCalledExactlyOnceWith({ scope: runtime.scope, status: 'completed', step: 'verify', runId: 'run-2' });
    expect(screen.getByText(en.setupProofScope)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: en.diagnosticsChecks })).toHaveTextContent('12 ms');
  });

  it('discards stale proof on config, epoch and explicit main invalidation, including replayed old runs', async () => {
    setStep('verify');
    const old = validRun();
    api.getDiagnostics.mockResolvedValue(old);
    const view = mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Finish setup' })).toBeEnabled());
    api.getDiagnostics.mockResolvedValue(null);
    runtime.snapshot = { ...runtime.snapshot, desiredConfig: { ...config, port: 4000 } };
    view.rerender(<Harness />);
    expect(screen.getByRole('button', { name: 'Finish setup' })).toBeDisabled();
    act(() => emit(old));
    expect(screen.getByRole('button', { name: 'Finish setup' })).toBeDisabled();
    runtime.scope = { profileId: 'default', epoch: 2 };
    runtime.snapshot = { ...runtime.snapshot, ...runtime.scope, runningConfig: runtime.snapshot.desiredConfig };
    view.rerender(<Harness />);
    act(() => emit(old));
    expect(screen.getByRole('button', { name: 'Finish setup' })).toBeDisabled();
    const current = validRun({ runId: 'run-current' });
    act(() => emit(current));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Finish setup' })).toBeEnabled());
    act(() => emit({ ...runtime.scope, invalidated: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Finish setup' })).toBeDisabled());
    act(() => emit(current));
    expect(screen.getByRole('button', { name: 'Finish setup' })).toBeDisabled();
  });

  it('keeps backend completion rejection visible and Retry uses a newer successful run rather than the rejected proof', async () => {
    setStep('verify');
    api.getDiagnostics.mockResolvedValue(validRun());
    api.saveOnboarding.mockRejectedValueOnce({ code: 'ONBOARDING_NOT_READY', message: 'unsafe internal detail' });
    const onSetupExit = vi.fn();
    mount({ onSetupExit });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Finish setup' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Finish setup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(en.error_ONBOARDING_NOT_READY);
    expect(screen.getByRole('alert')).not.toHaveTextContent('unsafe internal detail');
    expect(onSetupExit).not.toHaveBeenCalled();
    act(() => emit({ ...runtime.scope, invalidated: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeDisabled());
    act(() => emit(validRun({ runId: 'run-3', startedAt: '2026-10-24T00:00:03.000Z' })));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled());
    expect(screen.getByRole('alert')).toHaveTextContent(en.error_ONBOARDING_NOT_READY);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(onSetupExit).toHaveBeenCalledOnce());
    expect(api.saveOnboarding).toHaveBeenLastCalledWith({ scope: runtime.scope, status: 'completed', step: 'verify', runId: 'run-3' });
  });

  it('surfaces diagnostic pending/cancellation and permits a genuine retry without false completion', async () => {
    setStep('verify');
    let finish;
    api.startDiagnostics.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run diagnostics' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Run diagnostics' }));
    const active = validRun({ finishedAt: null, checks: ids.map((id) => ({ id, status: 'pending', code: null, durationMs: 0 })) });
    act(() => emit(active));
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel diagnostics' }));
    await waitFor(() => expect(api.cancelDiagnostics).toHaveBeenCalledExactlyOnceWith({ scope: runtime.scope, runId: active.runId }));
    const cancelled = { ...active, finishedAt: '2026-10-24T00:00:01.000Z', checks: active.checks.map((check) => ({ ...check, status: 'skipped', code: 'CANCELLED' })) };
    await act(async () => { emit(cancelled); finish(cancelled); });
    expect(screen.getByText(en.diagnosticsCancelled)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Finish setup' })).toBeDisabled();
    api.startDiagnostics.mockResolvedValueOnce(validRun({ runId: 'run-retry', startedAt: '2026-10-24T00:00:02.000Z' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Finish setup' })).toBeEnabled());
    expect(api.startDiagnostics).toHaveBeenCalledTimes(2);
  });

  it('uses safe navigation and scoped manual recovery instead of killing listeners or issuing commands', async () => {
    setStep('connect');
    const onNavigate = vi.fn();
    mount({ onNavigate });
    fireEvent.click(await screen.findByRole('button', { name: 'Open settings' }));
    expect(onNavigate).toHaveBeenCalledWith('settings');
    fireEvent.click(screen.getByRole('button', { name: 'Retry connection' }));
    await waitFor(() => expect(api.retryRecovery).toHaveBeenCalledExactlyOnceWith(runtime.scope));
    expect(api.startProxy).not.toHaveBeenCalled();
    expect(api.restartProxy).not.toHaveBeenCalled();
  });

  it('drops a delayed login failure after an unrelated epoch change in the same profile', async () => {
    let reject;
    api.startLogin.mockReturnValueOnce(new Promise((resolve, fail) => { reject = fail; }));
    const busy = vi.fn();
    const view = mount({ onBusyChange: busy });
    fireEvent.click(await screen.findByRole('button', { name: 'Re-login' }));
    await waitFor(() => expect(api.startLogin).toHaveBeenCalled());
    runtime.scope = { profileId: 'default', epoch: 2 };
    runtime.snapshot = { ...runtime.snapshot, ...runtime.scope, revision: 3, operation: 'starting', errorCode: null };
    view.rerender(<Harness onBusyChange={busy} />);
    await act(async () => reject({ code: 'INTERNAL_ERROR' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(en.setupLoginOpened)).not.toBeInTheDocument();
    await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false));
  });

  it('drops a failed progress save after an unrelated same-profile epoch change', async () => {
    let reject;
    api.saveOnboarding.mockReturnValueOnce(new Promise((resolve, fail) => { reject = fail; }));
    const exit = vi.fn();
    const view = mount({ onSetupExit: exit });
    fireEvent.click(await screen.findByRole('button', { name: 'Skip for now' }));
    await waitFor(() => expect(api.saveOnboarding).toHaveBeenCalled());
    runtime.scope = { profileId: 'default', epoch: 2 };
    runtime.snapshot = { ...runtime.snapshot, ...runtime.scope, revision: 3 };
    view.rerender(<Harness onSetupExit={exit} />);
    await act(async () => reject({ code: 'SETTINGS_SAVE_FAILED' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(exit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeEnabled();
  });

  it('renders translated setup and error messages with button semantics and non-color progress', async () => {
    api.getSettings.mockResolvedValue({ locale: 'zh' });
    mount();
    await screen.findByRole('heading', { name: zh.setupTitle });
    expect(screen.getByRole('list', { name: zh.setupProgress }).querySelector('[aria-current="step"]')).toHaveTextContent(zh.setupStep_login);
    for (const button of screen.getAllByRole('button')) expect(button).toHaveAttribute('type', 'button');
    expect(within(screen.getByRole('region', { name: zh.setupStep_login })).getByRole('button', { name: zh.reLogin })).toBeInTheDocument();
  });
  it('does not enable completion between shell readiness and successful remote command proof', async () => {
    setStep('verify');
    const pending = changeCheck(validRun({ finishedAt: null }), 'remote-command', { status: 'running', code: null });
    api.getDiagnostics.mockResolvedValue(pending);
    mount();
    await screen.findByRole('list', { name: en.diagnosticsChecks });
    await screen.findByText(en.diagnostic_WSS_SHELL_READY);
    expect(screen.getByRole('button', { name: en.setupFinish })).toBeDisabled();
    act(() => emit(changeCheck({ ...pending, finishedAt: '2026-10-24T00:00:01.000Z' }, 'remote-command', { status: 'failed', code: 'REMOTE_COMMAND_FAILED' })));
    expect(await screen.findByText(en.diagnostic_REMOTE_COMMAND_FAILED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.setupFinish })).toBeDisabled();
    expect(api.saveOnboarding).not.toHaveBeenCalled();
    act(() => emit(validRun({ runId: 'run-complete', startedAt: '2026-10-24T00:00:02.000Z' })));
    await waitFor(() => expect(screen.getByRole('button', { name: en.setupFinish })).toBeEnabled());
  });

  it.each([{ path: '/work with spaces' }, { startupCommand: 'tmux new -A -s usshtc' }])('requires fresh proof when matching running and desired settings change %j', async (patch) => {
    setStep('verify');
    const old = validRun();
    api.getDiagnostics.mockResolvedValueOnce(old).mockResolvedValue(null);
    const view = mount();
    await waitFor(() => expect(screen.getByRole('button', { name: en.setupFinish })).toBeEnabled());
    const changed = { ...config, ...patch };
    runtime.snapshot = { ...runtime.snapshot, desiredConfig: changed, runningConfig: changed };
    view.rerender(<Harness />);
    expect(screen.getByRole('button', { name: en.setupFinish })).toBeDisabled();
    act(() => emit(old));
    expect(screen.getByRole('button', { name: en.setupFinish })).toBeDisabled();
  });

  it('keeps connection proof across a health preference change but not a visible authentication transition', async () => {
    setStep('verify');
    api.getDiagnostics.mockResolvedValueOnce(validRun()).mockResolvedValue(null);
    const view = mount();
    await waitFor(() => expect(screen.getByRole('button', { name: en.setupFinish })).toBeEnabled());
    runtime.snapshot = { ...runtime.snapshot, healthProbeEnabled: true };
    view.rerender(<Harness />);
    expect(screen.getByRole('button', { name: en.setupFinish })).toBeEnabled();
    runtime.snapshot = { ...runtime.snapshot, cookieValid: false, loginStatus: 'idle' };
    view.rerender(<Harness />);
    expect(screen.getByRole('button', { name: en.setupFinish })).toBeDisabled();
    runtime.snapshot = { ...runtime.snapshot, cookieValid: true, loginStatus: 'success' };
    view.rerender(<Harness />);
    await waitFor(() => expect(api.getDiagnostics).toHaveBeenCalledTimes(3));
    expect(screen.getByRole('button', { name: en.setupFinish })).toBeDisabled();
  });

});
