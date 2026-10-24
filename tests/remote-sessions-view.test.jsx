import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import RemoteSessionsView from '../src/views/RemoteSessionsView';

const api = vi.hoisted(() => ({ listRemoteSessions: vi.fn(), openRemoteSession: vi.fn(), copyRemoteSession: vi.fn(), cancelRemoteSession: vi.fn(), startLogin: vi.fn() }));
const runtime = vi.hoisted(() => ({ scope: null, snapshot: null, getScope: vi.fn() }));
vi.mock('../src/lib/electron', async original => ({ ...await original(), ...api }));
vi.mock('../src/contexts/RuntimeContext', async original => ({ ...await original(), useRuntime: () => runtime }));
vi.mock('../src/i18n/LocaleContext', () => ({ useLocale: () => ({ locale: 'en', t: key => key }) }));

const scope = { profileId: 'default', epoch: 1 };
const fixture = overrides => ({ ...runtime.scope,
  desktops: [{ targetId: 'desktop-safe-id', name: 'Work desktop', loginNode: 'login01', wm: 'xfce', createTime: '', supported: true }],
  apps: [{ targetId: 'app-safe-id', name: 'Notebook', jobId: 42, state: 'RUNNING', runningTime: '00:01' }],
  catalog: [{ id: 'jupyter', name: 'Jupyter' }], sectionErrors: {}, ...overrides });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

describe('Remote sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.scope = { ...scope };
    runtime.snapshot = { ...scope, desiredConfig: { cluster: 'c' }, loginStatus: 'logged-in', cookieValid: true };
    runtime.getScope.mockImplementation(() => runtime.scope);
    api.listRemoteSessions.mockImplementation(async () => fixture());
    api.openRemoteSession.mockImplementation(async () => ({ ...runtime.scope, opened: true }));
    api.copyRemoteSession.mockImplementation(async () => ({ ...runtime.scope, copied: true, warning: 'SESSION_LINK_CREDENTIALS' }));
    api.cancelRemoteSession.mockImplementation(async payload => ({ ...payload.scope, cancelled: true }));
    api.startLogin.mockResolvedValue({});
  });

  it('loads safe lists without prefetching launch credentials or displaying links', async () => {
    render(<RemoteSessionsView />);
    expect(screen.getByRole('status')).toHaveTextContent('remoteSessionsLoading');
    await screen.findByRole('heading', { name: 'Work desktop' });
    expect(screen.getByRole('heading', { name: 'Notebook' })).toBeInTheDocument();
    expect(screen.getByText('Jupyter')).toBeInTheDocument();
    expect(screen.getByText('remoteSessionsGetOnly')).toBeInTheDocument();
    expect(screen.getByText('remoteSessionsCredentialWarning')).toBeInTheDocument();
    expect(api.listRemoteSessions).toHaveBeenCalledOnce();
    expect(api.openRemoteSession).not.toHaveBeenCalled();
    expect(api.copyRemoteSession).not.toHaveBeenCalled();
    expect(document.querySelector('a[href]')).toBeNull();
  });

  it('opens explicitly once per click with only opaque IDs and disables duplicate pending actions', async () => {
    const pending = deferred();
    api.openRemoteSession.mockReturnValue(pending.promise);
    render(<RemoteSessionsView />);
    const open = await screen.findByRole('button', { name: 'remoteSessionsOpen — Work desktop' });
    fireEvent.click(open);
    fireEvent.click(open);
    expect(api.openRemoteSession).toHaveBeenCalledOnce();
    expect(open).toBeDisabled();
    expect(api.openRemoteSession).toHaveBeenCalledWith({ scope, requestId: expect.any(String), targetId: 'desktop-safe-id' });
    expect(screen.getByRole('status')).toHaveTextContent('remoteSessionsConnecting');
    await act(async () => pending.resolve({ ...scope, opened: true }));
    expect(screen.getByRole('status')).toHaveTextContent('remoteSessionsOpened');
    expect(open).toBeEnabled();
    fireEvent.click(open);
    await waitFor(() => expect(api.openRemoteSession).toHaveBeenCalledTimes(2));
  });

  it('copies via main only and displays a credential/clipboard warning without a returned secret', async () => {
    render(<RemoteSessionsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'remoteSessionsCopy — Notebook' }));
    await screen.findByText('remoteSessionsCopiedWarning');
    expect(api.copyRemoteSession).toHaveBeenCalledWith({ scope, requestId: expect.any(String), targetId: 'app-safe-id' });
    expect(document.body.textContent).not.toContain('password=');
    expect(document.body.textContent).not.toContain('https://');
  });

  it('shows loading failure with safe localized errors and an actionable retry', async () => {
    api.listRemoteSessions.mockRejectedValueOnce(Object.assign(new Error('Cookie=private-fixture password=private-fixture'), { code: 'PORTAL_NETWORK' }));
    render(<RemoteSessionsView />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('remoteSessionError_PORTAL_NETWORK');
    expect(alert).not.toHaveTextContent('private-fixture');
    fireEvent.click(within(alert).getByRole('button', { name: 'retry' }));
    await screen.findByRole('heading', { name: 'Work desktop' });
    expect(api.listRemoteSessions).toHaveBeenCalledTimes(2);
  });

  it('unknown upstream messages are never rendered and unsupported POST responses stay unsupported', async () => {
    api.openRemoteSession.mockRejectedValueOnce(Object.assign(new Error('secret'), { code: 'REMOTE_SESSION_UNSUPPORTED' }));
    render(<RemoteSessionsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'remoteSessionsOpen — Notebook' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('remoteSessionError_REMOTE_SESSION_UNSUPPORTED');
    api.openRemoteSession.mockRejectedValueOnce(Object.assign(new Error('secret'), { code: 'UNTRUSTED_SECRET_CODE' }));
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('remoteSessionError_REMOTE_SESSION_INVALID'));
    expect(document.body.textContent).not.toContain('UNTRUSTED_SECRET_CODE');
    expect(document.body.textContent).not.toContain('secret');
  });

  it('cancels the exact pending operation and ignores its late successful completion', async () => {
    const pending = deferred();
    api.openRemoteSession.mockReturnValueOnce(pending.promise);
    render(<RemoteSessionsView />);
    fireEvent.click(await screen.findByRole('button', { name: 'remoteSessionsOpen — Work desktop' }));
    const payload = api.openRemoteSession.mock.calls[0][0];
    fireEvent.click(screen.getByRole('button', { name: 'remoteSessionsCancel' }));
    await screen.findByText('remoteSessionsCancelled');
    expect(api.cancelRemoteSession).toHaveBeenCalledWith({ scope, requestId: payload.requestId });
    await act(async () => pending.resolve({ ...scope, opened: true }));
    expect(screen.queryByText('remoteSessionsOpened')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'remoteSessionsOpen — Work desktop' })).toBeEnabled();
  });

  it('supports Escape cancellation and removes the keyboard listener when leaving the view', async () => {
    const pending = deferred();
    api.listRemoteSessions.mockReturnValueOnce(pending.promise);
    const view = render(<RemoteSessionsView />);
    const payload = api.listRemoteSessions.mock.calls[0][0];
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(document, { key: 'Escape' });
    await screen.findByText('remoteSessionsCancelled');
    expect(api.cancelRemoteSession).toHaveBeenCalledExactlyOnceWith(payload);
    view.unmount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(api.cancelRemoteSession).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(fixture()));
  });

  it('cleans up requests on unmount and suppresses old profile/cluster completion', async () => {
    const pending = deferred();
    api.listRemoteSessions.mockReturnValueOnce(pending.promise);
    const view = render(<RemoteSessionsView />);
    const original = api.listRemoteSessions.mock.calls[0][0];
    runtime.scope = { profileId: 'other', epoch: 2 };
    runtime.snapshot = { ...runtime.snapshot, ...runtime.scope, desiredConfig: { cluster: 'other-c' } };
    api.listRemoteSessions.mockResolvedValueOnce(fixture({ desktops: [], apps: [], catalog: [] }));
    view.rerender(<RemoteSessionsView />);
    await screen.findByText('remoteSessionsNoDesktops');
    expect(api.cancelRemoteSession).toHaveBeenCalledWith(original);
    await act(async () => pending.resolve({ ...fixture(), ...scope }));
    expect(screen.queryByRole('heading', { name: 'Work desktop' })).not.toBeInTheDocument();
    const stillPending = deferred();
    api.listRemoteSessions.mockReturnValueOnce(stillPending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'remoteSessionsRefresh' }));
    const latest = api.listRemoteSessions.mock.calls.at(-1)[0];
    view.unmount();
    expect(api.cancelRemoteSession).toHaveBeenLastCalledWith(latest);
    await act(async () => stillPending.resolve(fixture()));
  });

  it('renders section failures separately from empty success and disables unsupported/not-running entries', async () => {
    api.listRemoteSessions.mockResolvedValueOnce(fixture({
      desktops: [{ targetId: 'unsupported', name: '', loginNode: 'login01', supported: false, wm: '' }],
      apps: [{ targetId: 'pending', name: 'Pending app', jobId: 43, state: 'PENDING', runningTime: '00:00' },
        { targetId: 'unknown', name: 'Other app', jobId: 44, state: 'NEW_PRIVATE_STATE', runningTime: '00:00' }],
      catalog: [], sectionErrors: { catalog: 'PORTAL_UNIMPLEMENTED' },
    }));
    render(<RemoteSessionsView />);
    await screen.findByText('remoteSessionsUnsupportedDesktop');
    expect(screen.getByRole('button', { name: 'remoteSessionsOpen — remoteSessionsDesktopUnnamed' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'remoteSessionsOpen — Pending app' })).toBeDisabled();
    expect(screen.getByText('remoteSessionState_UNKNOWN')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('remoteSessionError_PORTAL_UNIMPLEMENTED');
    expect(screen.queryByText('remoteSessionsNoCatalog')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('NEW_PRIVATE_STATE');
  });

  it('offers non-destructive sign-in on REST auth failure and keeps permission failures distinct', async () => {
    api.listRemoteSessions.mockRejectedValueOnce({ code: 'AUTH_REQUIRED' });
    render(<RemoteSessionsView />);
    expect(await screen.findByRole('alert')).toHaveTextContent('remoteSessionError_AUTH_REQUIRED');
    fireEvent.click(screen.getByRole('button', { name: 'remoteSessionsLogin' }));
    await waitFor(() => expect(api.startLogin).toHaveBeenCalledWith(scope));
    expect(api.openRemoteSession).not.toHaveBeenCalled();
    api.listRemoteSessions.mockRejectedValueOnce({ code: 'PORTAL_PERMISSION' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'remoteSessionsRefresh' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'remoteSessionsRefresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('remoteSessionError_PORTAL_PERMISSION');
    expect(screen.queryByRole('button', { name: 'remoteSessionsLogin' })).not.toBeInTheDocument();
  });
});
