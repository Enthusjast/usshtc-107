import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateProvider, useUpdates } from '../src/contexts/UpdateContext';
import UpdatePanel from '../src/components/UpdatePanel';
import UpdateBanner from '../src/components/UpdateBanner';
import { LocaleProvider } from '../src/i18n/LocaleContext';
import en from '../src/i18n/en';
import zh from '../src/i18n/zh';

const api = vi.hoisted(() => ({
  getSettings: vi.fn(), setAppLocale: vi.fn(), getStatus: vi.fn(), onRuntimeState: vi.fn(), getUpdateState: vi.fn(), onUpdateState: vi.fn(),
  checkForUpdates: vi.fn(), downloadUpdate: vi.fn(), installUpdate: vi.fn(), openUpdateRelease: vi.fn(),
}));
const runtime = vi.hoisted(() => ({ flushDraft: vi.fn() }));
vi.mock('../src/lib/electron', async (original) => ({ ...await original(), ...api }));
vi.mock('../src/contexts/RuntimeContext', () => ({ useRuntime: () => runtime }));

const initial = (extra = {}) => ({ phase: 'idle', currentVersion: '1.2.1', availableVersion: null, releaseDate: null, releaseNotes: '', checkedAt: null, progress: null, installMode: 'in-app', errorCode: null, ...extra });
let listeners;
let state;
const emit = (extra) => { state = { ...state, ...extra }; listeners.forEach((callback) => callback(state)); };
function mount(props = {}) {
  return render(<LocaleProvider><UpdateProvider><UpdateBanner onReview={props.onReview ?? vi.fn()} /><UpdatePanel {...props} /></UpdateProvider></LocaleProvider>);
}
function DeferredDraft({ consumed }) {
  const [draft, setDraft] = useState('retain this draft');
  return <><label>Draft<input value={draft} onChange={(event) => setDraft(event.target.value)} /></label><UpdatePanel onConsumedDraft={(value) => { consumed(value); setDraft(''); }} /></>;
}
beforeEach(() => {
  vi.resetAllMocks();
  listeners = new Set();
  state = initial();
  api.getSettings.mockResolvedValue({ locale: 'en' });
  api.getUpdateState.mockImplementation(async () => state);
  api.onUpdateState.mockImplementation((callback) => { listeners.add(callback); return () => listeners.delete(callback); });
  api.getStatus.mockResolvedValue({ profileId: 'default', epoch: 1, revision: 1 });
  api.onRuntimeState.mockReturnValue(vi.fn());
  api.checkForUpdates.mockResolvedValue(initial({ phase: 'current' }));
  api.downloadUpdate.mockResolvedValue(initial({ phase: 'downloaded', availableVersion: '1.3.0' }));
  api.installUpdate.mockResolvedValue({ cancelled: true });
  api.openUpdateRelease.mockResolvedValue({});
  runtime.flushDraft.mockResolvedValue();
});

describe('Global update state', () => {
  it('subscribes before the initial read and never overwrites a newer event with its stale snapshot', async () => {
    let finish;
    api.getUpdateState.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    mount();
    expect(api.onUpdateState.mock.invocationCallOrder[0]).toBeLessThan(api.getUpdateState.mock.invocationCallOrder[0]);
    act(() => emit({ phase: 'downloaded', availableVersion: '1.3.0' }));
    expect(screen.getByRole('button', { name: en.updateInstallRestart })).toBeEnabled();
    await act(async () => finish(initial({ phase: 'current' })));
    expect(screen.getAllByText(en.updatePhase_downloaded).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: en.updateInstallRestart })).toBeEnabled();
  });

  it('ignores an initial read rejection after a valid event and unsubscribes on unmount', async () => {
    let fail;
    api.getUpdateState.mockReturnValue(new Promise((_, reject) => { fail = reject; }));
    const view = mount();
    act(() => emit({ phase: 'available', availableVersion: '1.3.0' }));
    await act(async () => fail({ code: 'INTERNAL_ERROR' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.updateDownload })).toBeEnabled();
    expect(listeners.size).toBe(1);
    view.unmount();
    expect(listeners.size).toBe(0);
  });

  it('does not disguise missing APIs or malformed state as an unsupported installation', async () => {
    api.getUpdateState.mockResolvedValueOnce(undefined).mockResolvedValueOnce(initial());
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent(en.error_API_UNAVAILABLE);
    expect(screen.queryByText(en.updateUnsupported)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.updateCheckNow })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('button', { name: en.updateCheckNow })).toBeEnabled());
  });

  it('reports subscription errors rather than fabricating a current or unsupported state', async () => {
    api.onUpdateState.mockImplementation(() => { throw { code: 'API_UNAVAILABLE' }; });
    mount();
    expect(await screen.findByRole('alert')).toHaveTextContent(en.error_API_UNAVAILABLE);
    expect(api.getUpdateState).not.toHaveBeenCalled();
    expect(screen.queryByText(en.updateUnsupported)).not.toBeInTheDocument();
    expect(api.downloadUpdate).not.toHaveBeenCalled();
  });

  it('fences overlapping retries and their failures behind the latest snapshot and events', async () => {
    const reads = [];
    api.getUpdateState.mockImplementation(() => new Promise((resolve, reject) => reads.push({ resolve, reject })));
    function RetryHarness() {
      const { retry, state: value } = useUpdates();
      return <><button type="button" onClick={retry}>Read status</button><span>{value?.phase}</span></>;
    }
    render(<UpdateProvider><RetryHarness /></UpdateProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Read status' }));
    await act(async () => reads[1].resolve(initial({ phase: 'available', availableVersion: '1.3.0' })));
    await act(async () => reads[0].reject({ code: 'INTERNAL_ERROR' }));
    expect(screen.getByText('available')).toBeInTheDocument();
  });
});

describe('Explicit update controls', () => {
  it('never automatically checks, downloads or installs on mount or available/downloaded events', async () => {
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: en.updateCheckNow })).toBeEnabled());
    act(() => emit({ phase: 'available', availableVersion: '1.3.0' }));
    act(() => emit({ phase: 'downloaded' }));
    expect(api.checkForUpdates).not.toHaveBeenCalled();
    expect(api.downloadUpdate).not.toHaveBeenCalled();
    expect(api.installUpdate).not.toHaveBeenCalled();
    expect(runtime.flushDraft).not.toHaveBeenCalled();
  });

  it('separates Check, Download and Install with a stable displayed version and a draft flush before install', async () => {
    let flush;
    runtime.flushDraft.mockReturnValue(new Promise((resolve) => { flush = resolve; }));
    const consumed = vi.fn();
    mount({ onConsumedDraft: consumed });
    await waitFor(() => expect(screen.getByRole('button', { name: en.updateCheckNow })).toBeEnabled());
    fireEvent.click(await screen.findByRole('button', { name: en.updateCheckNow }));
    await waitFor(() => expect(api.checkForUpdates).toHaveBeenCalledExactlyOnceWith());
    act(() => emit({ phase: 'available', availableVersion: '1.3.0' }));
    fireEvent.click(screen.getByRole('button', { name: en.updateDownload }));
    await waitFor(() => expect(api.downloadUpdate).toHaveBeenCalledExactlyOnceWith({ version: '1.3.0' }));
    expect(api.installUpdate).not.toHaveBeenCalled();
    expect(runtime.flushDraft).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: en.updateCheckNow })).toBeEnabled());
    act(() => emit({ phase: 'downloaded' }));
    const confirm = vi.spyOn(window, 'confirm');
    fireEvent.click(screen.getByRole('button', { name: en.updateInstallRestart }));
    await waitFor(() => expect(runtime.flushDraft).toHaveBeenCalledTimes(1));
    expect(api.installUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: en.updateInstallRestart })).toBeDisabled();
    act(() => emit({ phase: 'downloaded', availableVersion: '1.4.0' }));
    await act(async () => flush());
    await waitFor(() => expect(api.installUpdate).toHaveBeenCalledExactlyOnceWith({ version: '1.3.0' }));
    expect(consumed).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each(['manual', 'unsupported'])('respects %s mode and opens only the fixed release through its API', async (installMode) => {
    state = initial({ installMode, phase: 'available', availableVersion: '1.3.0' });
    mount();
    const check = await screen.findByRole('button', { name: en.updateCheckNow });
    await waitFor(() => expect(check.disabled).toBe(installMode === 'unsupported'));
    expect(screen.queryByRole('button', { name: en.updateDownload })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.updateInstallRestart })).not.toBeInTheDocument();
    if (installMode === 'manual') {
      fireEvent.click(check);
      await waitFor(() => expect(api.checkForUpdates).toHaveBeenCalledExactlyOnceWith());
    }
    await waitFor(() => expect(screen.getByRole('button', { name: en.updateOpenRelease })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: en.updateOpenRelease }));
    await waitFor(() => expect(api.openUpdateRelease).toHaveBeenCalledExactlyOnceWith());
    expect(api.downloadUpdate).not.toHaveBeenCalled();
    expect(api.installUpdate).not.toHaveBeenCalled();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('reports pending actions and finite progress, and prevents concurrent checks/downloads', async () => {
    state = initial({ phase: 'available', availableVersion: '1.3.0' });
    let finish;
    api.downloadUpdate.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const busy = vi.fn();
    mount({ onBusyChange: busy });
    await waitFor(() => expect(screen.getByRole('button', { name: en.updateDownload })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: en.updateDownload }));
    expect(screen.getByRole('button', { name: en.updateDownload })).toBeDisabled();
    expect(screen.getByRole('button', { name: en.updateCheckNow })).toBeDisabled();
    expect(busy).toHaveBeenLastCalledWith(true);
    act(() => emit({ phase: 'downloading', progress: { percent: 25, transferred: 1024, total: 4096, bytesPerSecond: 512 } }));
    expect(screen.getByRole('progressbar', { name: en.updateDownloadProgress })).toHaveAttribute('value', '25');
    expect(screen.getByText(/25% · 1.0 KB \/ 4.0 KB · 512 B\/s/)).toBeInTheDocument();
    await act(async () => { emit({ phase: 'downloaded', progress: null }); finish(); });
    expect(busy).toHaveBeenLastCalledWith(false);
    expect(api.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(api.installUpdate).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'flush', 'prepare'])('retains the draft after %s and does not send client confirmation', async (failure) => {
    state = initial({ phase: 'downloaded', availableVersion: '1.3.0' });
    if (failure === 'flush') runtime.flushDraft.mockRejectedValue({ code: 'DRAFT_CHANGED' });
    if (failure === 'prepare') api.installUpdate.mockRejectedValue({ code: 'UPDATE_PREPARATION_FAILED', message: '/private/path with secret' });
    const consumed = vi.fn();
    const confirm = vi.spyOn(window, 'confirm');
    render(<LocaleProvider><UpdateProvider><DeferredDraft consumed={consumed} /></UpdateProvider></LocaleProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: en.updateInstallRestart })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: en.updateInstallRestart }));
    await waitFor(() => expect(screen.getByRole('button', { name: en.updateInstallRestart })).toBeEnabled());
    expect(screen.getByLabelText('Draft')).toHaveValue('retain this draft');
    expect(consumed).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByText(/private\/path/)).not.toBeInTheDocument();
    if (failure === 'flush') expect(api.installUpdate).not.toHaveBeenCalled();
  });

  it('consumes only a successful install result and permits preparation retry, not automatic retry', async () => {
    state = initial({ phase: 'error', availableVersion: '1.3.0', errorCode: 'UPDATE_PREPARATION_FAILED' });
    api.installUpdate.mockResolvedValue({ consumedDraftRevision: 7 });
    const consumed = vi.fn();
    mount({ onConsumedDraft: consumed });
    await waitFor(() => expect(screen.getByRole('button', { name: en.updateInstallRestart })).toBeEnabled());
    expect(screen.getByRole('alert')).toHaveTextContent(en.error_UPDATE_PREPARATION_FAILED);
    expect(api.installUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: en.updateInstallRestart }));
    await waitFor(() => expect(consumed).toHaveBeenCalledExactlyOnceWith({ consumedDraftRevision: 7 }));
  });

  it.each(['UPDATE_INSTALL_FAILED', 'UPDATE_RESTART_REQUIRED'])('requires application restart after native %s, with no in-process install or download retry', async (errorCode) => {
    state = initial({ phase: 'error', availableVersion: '1.3.0', errorCode });
    mount();
    expect(await screen.findByText(en.updateRestartRequiredHint)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.updateInstallRestart })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.updateRetryDownload })).not.toBeInTheDocument();
    expect(api.installUpdate).not.toHaveBeenCalled();
  });

  it('preserves safe fixed download errors and offers only an explicit retry download', async () => {
    state = initial({ phase: 'available', availableVersion: '1.3.0' });
    api.downloadUpdate.mockRejectedValue({ code: 'UPDATE_CHECKSUM_MISMATCH', message: '/private/cache secret' });
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: en.updateDownload })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: en.updateDownload }));
    expect(await screen.findByRole('alert')).toHaveTextContent(en.error_UPDATE_CHECKSUM_MISMATCH);
    act(() => emit({ phase: 'error', errorCode: 'UPDATE_CHECKSUM_MISMATCH' }));
    expect(screen.getByRole('button', { name: en.updateRetryDownload })).toBeEnabled();
    expect(api.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/private\/cache/)).not.toBeInTheDocument();
    expect(api.installUpdate).not.toHaveBeenCalled();
  });

  it('renders release notes as text, never markup or navigable links, and review never installs', async () => {
    const notes = '<img src=x onerror=alert(1)>\n<a href="https://evil.invalid">not a link</a>';
    state = initial({ phase: 'available', availableVersion: '1.3.0', releaseNotes: notes });
    const review = vi.fn();
    const view = mount({ onReview: review });
    const summary = await screen.findByText(en.updateReleaseNotes);
    fireEvent.click(summary);
    expect(view.container.querySelector('.update-release-notes pre').textContent).toBe(notes);
    expect(view.container.querySelector('.update-release-notes img, .update-release-notes a')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: en.updateReview }));
    expect(review).toHaveBeenCalledTimes(1);
    expect(api.downloadUpdate).not.toHaveBeenCalled();
    expect(api.installUpdate).not.toHaveBeenCalled();
  });

  it('shows Chinese controls and the same actionable fixed error contract', async () => {
    api.getSettings.mockResolvedValue({ locale: 'zh' });
    state = initial({ phase: 'error', availableVersion: '1.3.0', errorCode: 'UPDATE_RESTART_REQUIRED' });
    mount();
    expect(await screen.findByRole('button', { name: zh.updateOpenRelease })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(zh.error_UPDATE_RESTART_REQUIRED);
    expect(screen.getByText(zh.updateRestartRequiredHint)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: zh.updateReview })).toBeInTheDocument();
  });
});
