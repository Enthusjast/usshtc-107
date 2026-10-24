import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TransfersView from '../src/views/TransfersView';

const api = vi.hoisted(() => ({ listTransfers: vi.fn(), startTransfer: vi.fn(), cancelTransfer: vi.fn(), onTransferState: vi.fn(), startLogin: vi.fn() }));
const runtime = vi.hoisted(() => ({ scope: null, snapshot: null, getScope: vi.fn() }));
vi.mock('../src/lib/electron', async original => ({ ...await original(), ...api }));
vi.mock('../src/contexts/RuntimeContext', async original => ({ ...await original(), useRuntime: () => runtime }));
vi.mock('../src/i18n/LocaleContext', () => ({ useLocale: () => ({ locale: 'en', t: key => key }) }));

const scope = { profileId: 'default', epoch: 1 };
const listeners = new Set();
const transfer = overrides => ({ id: 'transfer-1', filename: 'results.csv', direction: 'upload', bytes: 0, total: 100,
  phase: 'queued', status: 'queued', remoteTempsRetained: false, ...overrides });
const envelope = (items = [], overrides) => ({ ...runtime.scope, items, ...overrides });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const emit = async value => act(async () => { for (const listener of listeners) listener(value); });
const setPath = (path = '/home/user/results.csv') => fireEvent.change(screen.getByLabelText('transfersRemotePath'), { target: { value: path } });
const ready = async () => {
  const view = render(<TransfersView />);
  await screen.findByText('transfersEmpty');
  await waitFor(() => expect(screen.getByRole('button', { name: 'transfersUpload' })).toBeEnabled());
  return view;
};

describe('Portal transfers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    listeners.clear();
    runtime.scope = { ...scope };
    runtime.snapshot = { ...scope, desiredConfig: { cluster: 'c' }, loginStatus: 'logged-in', cookieValid: true };
    runtime.getScope.mockImplementation(() => runtime.scope);
    api.listTransfers.mockImplementation(async () => envelope());
    api.startTransfer.mockImplementation(async payload => {
      const id = `transfer-${api.startTransfer.mock.calls.length}`;
      return envelope([transfer({ id, direction: payload.direction })], { transferId: id });
    });
    api.cancelTransfer.mockImplementation(async ({ id }) => envelope([transfer({ id, status: 'cancelled' })]));
    api.onTransferState.mockImplementation(callback => { listeners.add(callback); return () => listeners.delete(callback); });
    api.startLogin.mockResolvedValue({});
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('subscribes before listing and starts both native dialogs without any local path or credentials', async () => {
    await ready();
    expect(api.listTransfers).toHaveBeenCalledExactlyOnceWith({ scope });
    expect(api.onTransferState.mock.invocationCallOrder[0]).toBeLessThan(api.listTransfers.mock.invocationCallOrder[0]);
    expect(screen.getByText('transfersNativeDialogs')).toBeInTheDocument();
    expect(screen.getByText('transfersPreflightRace')).toBeInTheDocument();
    expect(screen.getByText('transfersNoDirectories')).toBeInTheDocument();
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(document.querySelector('a[href]')).toBeNull();
    setPath();
    fireEvent.click(screen.getByRole('button', { name: 'transfersUpload' }));
    await screen.findByRole('heading', { name: 'results.csv' });
    expect(api.startTransfer).toHaveBeenLastCalledWith({ scope, direction: 'upload', remotePath: '/home/user/results.csv', overwrite: false });
    await waitFor(() => expect(screen.getByRole('button', { name: 'transfersDownload' })).toBeEnabled());
    setPath('/home/user/input.dat');
    fireEvent.click(screen.getByRole('button', { name: 'transfersDownload' }));
    await waitFor(() => expect(api.startTransfer).toHaveBeenCalledTimes(2));
    expect(api.startTransfer).toHaveBeenLastCalledWith({ scope, direction: 'download', remotePath: '/home/user/input.dat', overwrite: false });
    for (const [payload] of api.startTransfer.mock.calls) expect(Object.keys(payload).sort()).toEqual(['direction', 'overwrite', 'remotePath', 'scope']);
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('guards duplicate starts while a native dialog is pending and handles dialog cancellation', async () => {
    const pending = deferred();
    api.startTransfer.mockReturnValueOnce(pending.promise);
    await ready();
    setPath();
    const upload = screen.getByRole('button', { name: 'transfersUpload' });
    fireEvent.click(upload);
    fireEvent.click(upload);
    fireEvent.click(screen.getByRole('button', { name: 'transfersDownload' }));
    expect(api.startTransfer).toHaveBeenCalledOnce();
    expect(upload).toBeDisabled();
    expect(screen.getByText('transfersChoosingFile')).toHaveAttribute('role', 'status');
    await act(async () => pending.resolve(envelope([], { cancelled: true })));
    expect(await screen.findByText('transfersDialogCancelled')).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(upload).toBeEnabled();
  });

  it.each(['relative/file', '/', '/home/user/\u007ffile'])('rejects a non-file absolute path safely: %s', async path => {
    await ready();
    setPath(path);
    fireEvent.click(screen.getByRole('button', { name: 'transfersUpload' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('transferError_TRANSFER_PATH');
    expect(screen.getByLabelText('transfersRemotePath')).toHaveAttribute('aria-invalid', 'true');
    expect(api.startTransfer).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation every time before sending overwrite true', async () => {
    await ready();
    setPath();
    fireEvent.click(screen.getByRole('checkbox', { name: 'transfersOverwrite' }));
    window.confirm.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'transfersUpload' }));
    expect(window.confirm).toHaveBeenCalledWith('transfersOverwriteConfirm');
    expect(api.startTransfer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'transfersDownload' }));
    await waitFor(() => expect(api.startTransfer).toHaveBeenCalledOnce());
    expect(api.startTransfer).toHaveBeenCalledWith({ scope, direction: 'download', remotePath: '/home/user/results.csv', overwrite: true });
    expect(window.confirm).toHaveBeenCalledTimes(2);
  });

  it('renders bounded live progress and cancels queued or running jobs once per pending request', async () => {
    api.listTransfers.mockResolvedValueOnce(envelope([transfer()]));
    const pending = deferred();
    api.cancelTransfer.mockReturnValueOnce(pending.promise);
    render(<TransfersView />);
    const card = (await screen.findByRole('heading', { name: 'results.csv' })).closest('article');
    expect(within(card).getByRole('status')).toHaveTextContent('transferStatus_queued');
    expect(within(card).getByRole('button', { name: 'transfersCancel — results.csv' })).toBeEnabled();
    await emit(envelope([transfer({ bytes: 150, status: 'running', phase: 'uploading', mode: 'multipart' })]));
    expect(within(card).getByRole('progressbar')).toHaveAttribute('value', '100');
    expect(within(card).getByRole('status')).toHaveTextContent('transferStatus_running');
    expect(within(card).getByText('transferPhase_uploading — transferMode_multipart')).toBeInTheDocument();
    const cancel = within(card).getByRole('button', { name: 'transfersCancel — results.csv' });
    fireEvent.click(cancel);
    fireEvent.click(cancel);
    expect(api.cancelTransfer).toHaveBeenCalledExactlyOnceWith({ scope, id: 'transfer-1' });
    expect(cancel).toBeDisabled();
    await emit(envelope([transfer({ status: 'cancelled', remoteTempsRetained: true })]));
    await act(async () => pending.resolve(envelope([transfer({ status: 'running' })])));
    expect(within(card).getByRole('status')).toHaveTextContent('transferStatus_cancelled');
    expect(within(card).queryByRole('button', { name: 'transfersCancel — results.csv' })).not.toBeInTheDocument();
    expect(within(card).getByText('transfersRemoteTempsRetained')).toBeInTheDocument();
  });

  it.each(['failed', 'cancelled'])('retries a %s transfer using remembered direction/path and a new native dialog', async status => {
    await ready();
    setPath('/home/user/original.csv');
    fireEvent.click(screen.getByRole('button', { name: 'transfersDownload' }));
    await screen.findByRole('heading', { name: 'results.csv' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'transfersUpload' })).toBeEnabled());
    setPath('/home/user/different.csv');
    await emit(envelope([transfer({ direction: 'download', status, errorCode: status === 'failed' ? 'TRANSFER_HASH' : undefined })]));
    fireEvent.click(screen.getByRole('button', { name: 'transfersRetry — results.csv' }));
    await waitFor(() => expect(api.startTransfer).toHaveBeenCalledTimes(2));
    expect(api.startTransfer).toHaveBeenLastCalledWith({ scope, direction: 'download', remotePath: '/home/user/original.csv', overwrite: false });
    await waitFor(() => expect(screen.getByRole('button', { name: 'transfersUpload' })).toBeEnabled());
  });

  it('remembers the explicit transferId when a newer event precedes the start response', async () => {
    const pending = deferred();
    api.startTransfer.mockReturnValueOnce(pending.promise);
    await ready();
    setPath();
    fireEvent.click(screen.getByRole('button', { name: 'transfersUpload' }));
    await emit(envelope([transfer({ status: 'failed', errorCode: 'TRANSFER_HASH' })]));
    await act(async () => pending.resolve(envelope([transfer({ status: 'queued' })], { transferId: 'transfer-1' })));
    expect(screen.getByRole('status')).toHaveTextContent('transferStatus_failed');
    fireEvent.click(screen.getByRole('button', { name: 'transfersRetry — results.csv' }));
    await waitFor(() => expect(api.startTransfer).toHaveBeenCalledTimes(2));
  });

  it('does not guess retry paths for pre-existing records after mounting', async () => {
    api.listTransfers.mockResolvedValueOnce(envelope([transfer({ status: 'failed', errorCode: 'TRANSFER_IO' })]));
    render(<TransfersView />);
    await screen.findByText('transfersRetryNewSelection');
    expect(screen.queryByRole('button', { name: 'transfersRetry — results.csv' })).not.toBeInTheDocument();
    expect(api.startTransfer).not.toHaveBeenCalled();
  });

  it('does not replace newer event progress with a stale initial list response', async () => {
    const pending = deferred();
    api.listTransfers.mockReturnValueOnce(pending.promise);
    render(<TransfersView />);
    await emit(envelope([transfer({ bytes: 75, phase: 'verifying', status: 'running' })]));
    await act(async () => pending.resolve(envelope([transfer({ bytes: 0 })])));
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '75');
    expect(screen.getByRole('status')).toHaveTextContent('transferStatus_running');
  });

  it('resets form and cards on scope change and ignores stale events and start completions', async () => {
    const pending = deferred();
    api.startTransfer.mockReturnValueOnce(pending.promise);
    const view = await ready();
    const oldListener = api.onTransferState.mock.calls[0][0];
    setPath();
    fireEvent.click(screen.getByRole('checkbox', { name: 'transfersOverwrite' }));
    fireEvent.click(screen.getByRole('button', { name: 'transfersUpload' }));
    runtime.scope = { profileId: 'other', epoch: 2 };
    runtime.snapshot = { ...runtime.snapshot, ...runtime.scope, desiredConfig: { cluster: 'other-c' } };
    view.rerender(<TransfersView />);
    await screen.findByText('transfersEmpty');
    expect(screen.getByLabelText('transfersRemotePath')).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: 'transfersOverwrite' })).not.toBeChecked();
    expect(listeners.size).toBe(1);
    await act(async () => {
      oldListener({ ...scope, items: [transfer()] });
      for (const listener of listeners) listener({ ...scope, items: [transfer()] });
      pending.resolve({ ...scope, items: [transfer()], transferId: 'transfer-1' });
    });
    expect(screen.queryByRole('heading', { name: 'results.csv' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.listTransfers).toHaveBeenLastCalledWith({ scope: runtime.scope });
    expect(api.cancelTransfer).not.toHaveBeenCalled();
    view.unmount();
    expect(listeners.size).toBe(0);
  });

  it.each(['epoch', 'cluster', 'auth'])('invalidates stale list work when %s changes', async kind => {
    const pending = deferred();
    api.listTransfers.mockReturnValueOnce(pending.promise);
    const view = render(<TransfersView />);
    const old = { ...scope, items: [transfer()] };
    if (kind === 'epoch') runtime.scope = { ...scope, epoch: 2 };
    if (kind === 'cluster') runtime.snapshot = { ...runtime.snapshot, desiredConfig: { cluster: 'new-cluster' } };
    if (kind === 'auth') runtime.snapshot = { ...runtime.snapshot, cookieValid: false, loginStatus: 'logged-out' };
    view.rerender(<TransfersView />);
    await screen.findByText('transfersEmpty');
    await act(async () => pending.resolve(old));
    expect(screen.queryByRole('heading', { name: 'results.csv' })).not.toBeInTheDocument();
  });

  it('uses fixed localized errors, retries failed start with a new dialog and never shows upstream messages', async () => {
    api.startTransfer.mockRejectedValueOnce(Object.assign(new Error('Cookie=private-fixture password=private-fixture'), { code: 'TRANSFER_HASH' }));
    await ready();
    setPath();
    fireEvent.click(screen.getByRole('button', { name: 'transfersUpload' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('transferError_TRANSFER_HASH');
    expect(alert).not.toHaveTextContent('private-fixture');
    api.startTransfer.mockRejectedValueOnce({ code: 'SECRET_PRIVATE_CODE', message: 'private-fixture' });
    fireEvent.click(within(alert).getByRole('button', { name: 'retry' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('transferError_PORTAL_UNKNOWN'));
    expect(api.startTransfer).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('SECRET_PRIVATE_CODE');
    expect(document.body.textContent).not.toContain('private-fixture');
  });

  it.each(['AUTH_REQUIRED', 'PORTAL_AUTH'])('offers guarded sign-in recovery for %s without restarting automatically', async code => {
    api.listTransfers.mockRejectedValueOnce({ code });
    const pending = deferred();
    api.startLogin.mockReturnValueOnce(pending.promise);
    render(<TransfersView />);
    expect(await screen.findByRole('alert')).toHaveTextContent(`transferError_${code}`);
    const login = screen.getByRole('button', { name: 'transfersLogin' });
    fireEvent.click(login);
    fireEvent.click(login);
    expect(api.startLogin).toHaveBeenCalledExactlyOnceWith(scope);
    await act(async () => pending.resolve({}));
    expect(await screen.findByText('transfersLoginStarted')).toBeInTheDocument();
    expect(api.startTransfer).not.toHaveBeenCalled();
  });

  it('keeps permission errors distinct and offers cancellation retry without starting a dialog', async () => {
    api.listTransfers.mockResolvedValueOnce(envelope([transfer({ status: 'running' })]));
    api.cancelTransfer.mockRejectedValueOnce({ code: 'PORTAL_PERMISSION' });
    render(<TransfersView />);
    fireEvent.click(await screen.findByRole('button', { name: 'transfersCancel — results.csv' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('transferError_PORTAL_PERMISSION');
    expect(screen.queryByRole('button', { name: 'transfersLogin' })).not.toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', { name: 'retry' }));
    await waitFor(() => expect(api.cancelTransfer).toHaveBeenCalledTimes(2));
    expect(api.startTransfer).not.toHaveBeenCalled();
    await screen.findByText('transferStatus_cancelled');
  });

  it('bounds history and invalid numeric progress and does not display arbitrary phase or mode values', async () => {
    const many = Array.from({ length: 105 }, (_, index) => transfer({ id: `job-${index}`, filename: `file-${index}`,
      status: 'running', bytes: Infinity, total: null, phase: 'SECRET_PHASE', mode: 'SECRET_MODE' }));
    api.listTransfers.mockResolvedValueOnce(envelope(many));
    render(<TransfersView />);
    await screen.findByRole('heading', { name: 'file-104' });
    expect(screen.getAllByRole('article')).toHaveLength(100);
    expect(screen.queryByRole('heading', { name: 'file-0' })).not.toBeInTheDocument();
    for (const progress of screen.getAllByRole('progressbar')) expect(progress).not.toHaveAttribute('value');
    expect(document.body.textContent).not.toContain('SECRET_PHASE');
    expect(document.body.textContent).not.toContain('SECRET_MODE');
    expect(screen.getAllByText('0 B / transfersUnknownTotal')).toHaveLength(100);
  });

  it('cancels a queued job without opening another native dialog', async () => {
    api.listTransfers.mockResolvedValueOnce(envelope([transfer()]));
    render(<TransfersView />);
    fireEvent.click(await screen.findByRole('button', { name: 'transfersCancel — results.csv' }));
    await screen.findByText('transferStatus_cancelled');
    expect(api.cancelTransfer).toHaveBeenCalledExactlyOnceWith({ scope, id: 'transfer-1' });
    expect(api.startTransfer).not.toHaveBeenCalled();
  });

  it('ignores late cancellation failure after the scope changes', async () => {
    const pending = deferred();
    api.listTransfers.mockResolvedValueOnce(envelope([transfer({ status: 'running' })]));
    api.cancelTransfer.mockReturnValueOnce(pending.promise);
    const view = render(<TransfersView />);
    fireEvent.click(await screen.findByRole('button', { name: 'transfersCancel — results.csv' }));
    runtime.scope = { ...scope, epoch: 2 };
    runtime.snapshot = { ...runtime.snapshot, ...runtime.scope };
    view.rerender(<TransfersView />);
    await screen.findByText('transfersEmpty');
    await act(async () => pending.reject({ code: 'PORTAL_NETWORK' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'results.csv' })).not.toBeInTheDocument();
  });

  it('unsubscribes without cancelling background jobs and ignores late unmounted work', async () => {
    const pending = deferred();
    api.listTransfers.mockReturnValueOnce(pending.promise);
    const view = render(<TransfersView />);
    const listener = api.onTransferState.mock.calls[0][0];
    view.unmount();
    expect(listeners.size).toBe(0);
    await act(async () => {
      listener(envelope([transfer()]));
      pending.resolve(envelope([transfer()]));
    });
    expect(api.cancelTransfer).not.toHaveBeenCalled();
  });

  it('handles a malformed snapshot with a safe error and waits without a scope', async () => {
    api.listTransfers.mockResolvedValueOnce(envelope([{ filename: 'not-a-transfer' }]));
    const view = render(<TransfersView />);
    expect(await screen.findByRole('alert')).toHaveTextContent('transferError_API_UNAVAILABLE');
    runtime.scope = null;
    runtime.snapshot = null;
    view.rerender(<TransfersView />);
    expect(screen.getByText('transfersWaiting')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'transfersUpload' })).toBeDisabled();
    expect(listeners.size).toBe(0);
  });
});
