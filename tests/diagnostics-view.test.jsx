import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DiagnosticsView, { DIAGNOSTIC_CODES, diagnosticIdentity } from '../src/views/DiagnosticsView';
import { LocaleProvider } from '../src/i18n/LocaleContext';
import { ToastProvider } from '../src/components/Toast';
import en from '../src/i18n/en';
import zh from '../src/i18n/zh';

const api = vi.hoisted(() => ({
  getDiagnostics: vi.fn(), startDiagnostics: vi.fn(), cancelDiagnostics: vi.fn(), onDiagnosticsState: vi.fn(),
  exportDiagnostics: vi.fn(), startLogin: vi.fn(), getStatus: vi.fn(), getSettings: vi.fn(),
  onRuntimeState: vi.fn(), setAppLocale: vi.fn(),
}));
const runtime = vi.hoisted(() => ({ scope: null, snapshot: null, runAction: vi.fn(), getScope: vi.fn() }));
vi.mock('../src/lib/electron', async (original) => ({ ...await original(), ...api }));
vi.mock('../src/contexts/RuntimeContext', async (original) => ({ ...await original(), useRuntime: () => runtime }));

const ids = ['settings','keys','ssh-config','local-listener','dns','tls','wss','remote-command'];
function diagnostic(overrides = {}) {
  return {
    runId: 'run-1', profileId: 'default', epoch: 1, configFingerprint: 'config-1',
    startedAt: '2026-10-24T00:00:00.000Z', finishedAt: null,
    checks: ids.map((id) => ({id,status:'pending',code:null,durationMs:0})),
    ...overrides,
  };
}
function checked(run, id, values) {
  return {...run,checks:run.checks.map((check) => check.id === id ? {...check,...values} : check)};
}
function App({ onNavigate }) {
  return <LocaleProvider><ToastProvider><DiagnosticsView onNavigate={onNavigate} /></ToastProvider></LocaleProvider>;
}

describe('Connection diagnostics', () => {
  let listeners;
  let unsubscribe;
  const emit = (value) => listeners.forEach((listener) => listener(value));
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.scope = {profileId:'default',epoch:1};
    runtime.snapshot = {profileId:'default',epoch:1,revision:1,desiredConfig:{host:'127.0.0.1',port:3000,cluster:'c',loginNode:'n',cols:120,rows:40,useRoot:false,wssUrl:'wss://fixed.invalid/'}};
    runtime.getScope.mockImplementation(() => runtime.scope);
    runtime.runAction.mockImplementation(async (action, scope) => action(scope));
    api.getStatus.mockResolvedValue(runtime.snapshot);
    api.getSettings.mockResolvedValue({locale:'en'});
    api.onRuntimeState.mockReturnValue(vi.fn());
    api.getDiagnostics.mockResolvedValue(null);
    api.startDiagnostics.mockResolvedValue(diagnostic({finishedAt:'2026-10-24T00:00:01.000Z'}));
    api.cancelDiagnostics.mockResolvedValue({cancelled:true});
    api.exportDiagnostics.mockResolvedValue({exported:true});
    api.startLogin.mockResolvedValue({});
    listeners = new Set();
    unsubscribe = vi.fn();
    api.onDiagnosticsState.mockImplementation((listener) => {
      listeners.add(listener);
      return () => {unsubscribe();listeners.delete(listener);};
    });
  });

  it('subscribes before reading and does not let a late getter replace streamed progress', async () => {
    let finishGet;
    api.getDiagnostics.mockReturnValue(new Promise((resolve) => {finishGet=resolve;}));
    const view=render(<App />);
    expect(api.onDiagnosticsState.mock.invocationCallOrder[0]).toBeLessThan(api.getDiagnostics.mock.invocationCallOrder[0]);
    const progress=checked(diagnostic(), 'settings', {status:'passed',code:'SETTINGS_OK',durationMs:12});
    act(() => emit(progress));
    expect(screen.getByText('Saved settings are valid.')).toBeInTheDocument();
    expect(screen.getByText('12 ms')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('value','1');
    await act(async () => finishGet(diagnostic()));
    expect(screen.getByText('Saved settings are valid.')).toBeInTheDocument();
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('starts only one request, displays progressive checks, and leaves navigation usable', async () => {
    let finish;
    api.startDiagnostics.mockReturnValue(new Promise((resolve) => {finish=resolve;}));
    const onNavigate=vi.fn();
    render(<App onNavigate={onNavigate} />);
    const start=await screen.findByRole('button', {name:'Run diagnostics'});
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    fireEvent.click(start);
    expect(api.startDiagnostics).toHaveBeenCalledExactlyOnceWith(runtime.scope);
    expect(runtime.runAction).not.toHaveBeenCalled();
    let run=checked(diagnostic(),'settings',{status:'passed',code:'SETTINGS_OK',durationMs:1});
    run=checked(run,'keys',{status:'running'});
    act(() => emit(run));
    expect(screen.getByText('1 of 8 checks finished')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name:'Open settings'}));
    expect(onNavigate).toHaveBeenCalledWith('settings');
    const final=checked({...run,finishedAt:'2026-10-24T00:00:01.000Z'},'wss',{status:'passed',code:'WSS_SHELL_READY',durationMs:15});
    await act(async () => {emit(final);finish(final);});
    expect(screen.getByText('Diagnostics finished. Review each check below.')).toBeInTheDocument();
    expect(screen.getByText(en.diagnostic_WSS_SHELL_READY)).toBeInTheDocument();
    expect(screen.getByText(en.diagnosticsProofScope)).toBeInTheDocument();
    expect(screen.getByRole('button', {name:'Run again'})).toBeEnabled();
  });

  it('cancels the exact run without reporting a failure and allows rerunning afterward', async () => {
    let finish;
    api.startDiagnostics.mockReturnValue(new Promise((resolve) => {finish=resolve;}));
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', {name:'Run diagnostics'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button', {name:'Run diagnostics'}));
    const running=checked(diagnostic(),'settings',{status:'running'});
    act(() => emit(running));
    fireEvent.click(screen.getByRole('button', {name:'Cancel diagnostics'}));
    await waitFor(() => expect(api.cancelDiagnostics).toHaveBeenCalledExactlyOnceWith({scope:runtime.scope,runId:'run-1'}));
    const cancelled={...running,finishedAt:'2026-10-24T00:00:01.000Z',checks:running.checks.map((check) => ({...check,status:'skipped',code:'CANCELLED'}))};
    await act(async () => {emit(cancelled);finish(cancelled);});
    expect(screen.getByText('Diagnostics cancelled. You can run again.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', {name:'Run again'})).toBeEnabled();
  });

  it('clears changed configuration and ignores old same-scope runs and request completions', async () => {
    let finish;
    api.startDiagnostics.mockReturnValue(new Promise((resolve) => {finish=resolve;}));
    const view=render(<App />);
    await waitFor(() => expect(screen.getByRole('button', {name:'Run diagnostics'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button', {name:'Run diagnostics'}));
    const old=checked(diagnostic(),'settings',{status:'passed',code:'SETTINGS_OK'});
    act(() => emit(old));
    runtime.snapshot={...runtime.snapshot,desiredConfig:{...runtime.snapshot.desiredConfig,port:4000}};
    view.rerender(<App />);
    await screen.findByText(/No current diagnostic results/);
    await act(async () => {emit(old);finish({...old,finishedAt:'2026-10-24T00:00:01.000Z'});});
    expect(screen.queryByText('Saved settings are valid.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', {name:'Run diagnostics'})).toBeEnabled();
    act(() => emit(checked(diagnostic({runId:'run-2',configFingerprint:'config-2',startedAt:'2026-10-24T00:00:02.000Z'}),'settings',{status:'failed',code:'SETTINGS_INVALID'})));
    expect(screen.getByText('Saved settings are invalid. Review connection settings.')).toBeInTheDocument();
  });

  it('invalidates an identical saved config and rejects replay of its former run', async () => {
    api.getDiagnostics.mockResolvedValue(checked(diagnostic({finishedAt:'2026-10-24T00:00:01.000Z'}),'settings',{status:'passed',code:'SETTINGS_OK'}));
    render(<App />);
    await screen.findByText('Saved settings are valid.');
    act(() => emit({...runtime.scope,invalidated:true}));
    expect(screen.getByText(/No current diagnostic results/)).toBeInTheDocument();
    act(() => emit(checked(diagnostic(),'settings',{status:'passed',code:'SETTINGS_OK'})));
    expect(screen.queryByText('Saved settings are valid.')).not.toBeInTheDocument();
  });

  it('rejects old-scope events and promises after a profile change', async () => {
    let finish;
    api.getDiagnostics.mockReturnValueOnce(new Promise((resolve) => {finish=resolve;})).mockResolvedValueOnce(null);
    const view=render(<App />);
    const oldListener=[...listeners][0];
    runtime.scope={profileId:'b',epoch:2};
    runtime.snapshot={...runtime.snapshot,...runtime.scope};
    view.rerender(<App />);
    await screen.findByText(/No current diagnostic results/);
    await act(async () => {oldListener(checked(diagnostic(),'settings',{status:'passed',code:'SETTINGS_OK'}));finish(diagnostic());});
    expect(screen.queryByText('Saved settings are valid.')).not.toBeInTheDocument();
    expect(api.getDiagnostics).toHaveBeenLastCalledWith(runtime.scope);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('reports fixed safe errors, permits Retry and never renders unknown check codes', async () => {
    api.getDiagnostics.mockRejectedValueOnce(Object.assign(new Error('Cookie=private-secret'),{code:'INTERNAL_ERROR'})).mockResolvedValueOnce(null);
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('An internal error occurred. Please retry.');
    expect(screen.queryByText(/private-secret/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name:'Retry'}));
    await screen.findByText(/No current diagnostic results/);
    act(() => emit(checked(diagnostic({finishedAt:'2026-10-24T00:00:01.000Z'}),'settings',{status:'failed',code:'Cookie=private-secret'})));
    expect(screen.getByText('Unknown error')).toBeInTheDocument();
    expect(screen.queryByText(/Cookie=private-secret/)).not.toBeInTheDocument();
    api.exportDiagnostics.mockRejectedValueOnce(Object.assign(new Error('/private/path password=value'),{code:'EXPORT_FAILED'})).mockResolvedValueOnce({exported:true});
    fireEvent.click(screen.getByRole('button', {name:'Export diagnostic package'}));
    const alert=await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The export could not be saved. Check file access and retry.');
    expect(screen.queryByText(/password=value/)).not.toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', {name:'Retry'}));
    expect(await screen.findByText('Diagnostic package exported')).toBeInTheDocument();
  });

  it('uses main-native export cancellation without a success or failure toast', async () => {
    api.exportDiagnostics.mockResolvedValue({cancelled:true});
    render(<App />);
    await waitFor(() => expect(screen.getByRole('button', {name:'Run diagnostics'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button', {name:'Export diagnostic package'}));
    await waitFor(() => expect(screen.getByRole('button', {name:'Export diagnostic package'})).toBeEnabled());
    expect(api.exportDiagnostics).toHaveBeenCalledExactlyOnceWith(runtime.scope);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Diagnostic package exported')).not.toBeInTheDocument();
  });

  it('routes SSH config review to settings and relogin through the draft-flushing action entry', async () => {
    const onNavigate=vi.fn();
    render(<App onNavigate={onNavigate} />);
    await waitFor(() => expect(screen.getByRole('button', {name:'Run diagnostics'})).toBeEnabled());
    fireEvent.click(screen.getByRole('button', {name:'Review SSH config'}));
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('settings','ssh-config');
    fireEvent.click(screen.getByRole('button', {name:'Re-login'}));
    await waitFor(() => expect(runtime.runAction).toHaveBeenCalledExactlyOnceWith(api.startLogin,runtime.scope));
    expect(api.startLogin).toHaveBeenCalledExactlyOnceWith(runtime.scope);
  });

  it('distinguishes stopped bind-only checks from authenticated local SSH', async () => {
    api.getDiagnostics.mockResolvedValue(checked(diagnostic({finishedAt:'2026-10-24T00:00:01.000Z'}),'local-listener',{status:'passed',code:'LOCAL_PORT_AVAILABLE',mode:'bind-only',durationMs:2}));
    render(<App />);
    expect(await screen.findByText('The saved local address can be bound. SSH authentication was not tested.')).toBeInTheDocument();
    expect(screen.getByText(/An available port is not proof of a working SSH connection/)).toBeInTheDocument();
    act(() => emit(checked(diagnostic({runId:'run-2',startedAt:'2026-10-24T00:00:02.000Z',finishedAt:'2026-10-24T00:00:03.000Z'}),'local-listener',{status:'passed',code:'LOCAL_SSH_OK',mode:'ssh-auth',durationMs:3})));
    expect(screen.getByText(/SSH authentication with the existing application key and pinned host key/)).toBeInTheDocument();
  });

  it('translates every fixed check code and presents diagnostics in Chinese', async () => {
    for (const dictionary of [en,zh]) for (const code of DIAGNOSTIC_CODES) expect(dictionary[`diagnostic_${code}`]).toBeTypeOf('string');
    api.getSettings.mockResolvedValue({locale:'zh'});
    render(<App />);
    expect(await screen.findByRole('button', {name:'运行诊断'})).toBeInTheDocument();
    expect(screen.getByText(zh.diagnosticsProofScope)).toBeInTheDocument();
    expect(screen.getByRole('button', {name:'检查 SSH 配置'})).toBeInTheDocument();
  });
  it('shows first-frame silence separately from authentication and keeps command evidence separate', async () => {
    let run = checked(diagnostic({ finishedAt: '2026-10-24T00:00:01.000Z' }), 'wss', { status: 'failed', code: 'REMOTE_READY_TIMEOUT', durationMs: 10000 });
    run = checked(run, 'remote-command', { status: 'skipped', code: 'DEPENDENCY_FAILED' });
    api.getDiagnostics.mockResolvedValue(run);
    render(<App />);
    expect(await screen.findByText(en.diagnostic_REMOTE_READY_TIMEOUT)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: en['diagnosticsCheck_remote-command'] })).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('max', '8');
    expect(api.startLogin).not.toHaveBeenCalled();
    expect(screen.queryByText(en.diagnostic_AUTH_REQUIRED)).not.toBeInTheDocument();
    expect(screen.queryByText(en.diagnostic_REMOTE_COMMAND_OK)).not.toBeInTheDocument();
    const next = checked(diagnostic({ runId: 'run-2', startedAt: '2026-10-24T00:00:02.000Z', finishedAt: '2026-10-24T00:00:03.000Z' }), 'remote-command', { status: 'failed', code: 'REMOTE_COMMAND_FAILED', output: 'private-output', command: 'private-command' });
    act(() => emit(checked(next, 'wss', { status: 'passed', code: 'WSS_SHELL_READY' })));
    expect(screen.getByText(en.diagnostic_WSS_SHELL_READY)).toBeInTheDocument();
    expect(screen.getByText(en.diagnostic_REMOTE_COMMAND_FAILED)).toBeInTheDocument();
    expect(screen.queryByText(/private-output|private-command/)).not.toBeInTheDocument();
  });

  it('binds identity to path, startup command and visible authentication, but not health preference', () => {
    const original = diagnosticIdentity(runtime.snapshot, runtime.scope);
    for (const patch of [{ path: '/work with spaces' }, { startupCommand: 'tmux new -A -s usshtc' }]) {
      expect(diagnosticIdentity({ ...runtime.snapshot, desiredConfig: { ...runtime.snapshot.desiredConfig, ...patch } }, runtime.scope)).not.toBe(original);
    }
    expect(diagnosticIdentity({ ...runtime.snapshot, loginStatus: 'pending' }, runtime.scope)).not.toBe(original);
    expect(diagnosticIdentity({ ...runtime.snapshot, cookieValid: false }, runtime.scope)).not.toBe(original);
    expect(diagnosticIdentity({ ...runtime.snapshot, desiredConfig: { ...runtime.snapshot.desiredConfig, healthProbeEnabled: true } }, runtime.scope)).toBe(original);
  });

  it.each([{ path: '/work with spaces' }, { startupCommand: 'tmux new -A -s usshtc' }])('rejects an old same-scope run after changing %j', async (patch) => {
    const old = checked(diagnostic({ finishedAt: '2026-10-24T00:00:01.000Z' }), 'remote-command', { status: 'passed', code: 'REMOTE_COMMAND_OK' });
    api.getDiagnostics.mockResolvedValueOnce(old).mockResolvedValue(null);
    const view = render(<App />);
    await screen.findByText(en.diagnostic_REMOTE_COMMAND_OK);
    runtime.snapshot = { ...runtime.snapshot, desiredConfig: { ...runtime.snapshot.desiredConfig, ...patch } };
    view.rerender(<App />);
    await screen.findByText(en.diagnosticsEmpty);
    act(() => emit(old));
    expect(screen.queryByText(en.diagnostic_REMOTE_COMMAND_OK)).not.toBeInTheDocument();
  });

});
