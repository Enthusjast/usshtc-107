import React from 'react';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { beforeEach, it, expect, vi } from 'vitest';
import SessionsView from '../src/views/SessionsView';
import { RuntimeProvider, useRuntime } from '../src/contexts/RuntimeContext';
import { LocaleProvider } from '../src/i18n/LocaleContext';
import { ToastProvider } from '../src/components/Toast';
import { aggregateHistory } from '../src/lib/traffic';
const mocks = vi.hoisted(() => ({ getRuntimeInfo: vi.fn(), getStats: vi.fn(), getHistory: vi.fn(), clearHistory: vi.fn(), disconnectSession: vi.fn(), onStatsUpdate: vi.fn(), setAppLocale: vi.fn(), getStatus: vi.fn(), getSettings: vi.fn(), onRuntimeState: vi.fn(), setAppDirty: vi.fn() }));
vi.mock('../src/lib/electron', async (importOriginal) => ({ ...await importOriginal(), ...mocks }));
const scope = { profileId: 'default', epoch: 1 };
const session = { id: 1, kind: 'shell', remoteAddress: '127.0.0.1', connectedAt: Date.now(), bytesSent: 0, bytesReceived: 0 };
const record = { id: 'run:1', profileId: 'default', kind: 'exec', startedAt: '2026-10-22T23:00:00Z', endedAt: '2026-10-23T00:10:00Z', bytesSent: 2048, bytesReceived: 4096, exitCode: 0, reason: 'completed' };
const sample = (sequence, sampledAt, extra = {}) => ({ ...scope, sequence, sampledAt, totalBytesSent: 0, totalBytesReceived: 0, sessions: [session], ...extra });
let emitStats, emitRuntime, runtime;
function DraftProbe() { runtime = useRuntime(); return null; }
function mount() { return render(<LocaleProvider><ToastProvider><RuntimeProvider><DraftProbe /><SessionsView /></RuntimeProvider></ToastProvider></LocaleProvider>); }
function openHistory() { fireEvent.click(screen.getByRole('button', { name: 'History' })); }
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getStatus.mockResolvedValue({ ...scope, revision: 1, proxyStatus: 'started' });
  mocks.getRuntimeInfo.mockResolvedValue({ scope, draftRevision: 0 });
  mocks.getSettings.mockResolvedValue({ locale: 'en' });
  const listeners = new Set();
  mocks.onRuntimeState.mockImplementation((callback) => { listeners.add(callback); return () => listeners.delete(callback); });
  emitRuntime = (value) => listeners.forEach((callback) => callback(value));
  mocks.onStatsUpdate.mockImplementation((callback) => { emitStats = callback; return vi.fn(); });
  mocks.getStats.mockResolvedValue(sample(1, 1000));
  mocks.getHistory.mockResolvedValue({ ...scope, revision: 1, sessions: [record] });
  mocks.clearHistory.mockResolvedValue({ cancelled: true });
  mocks.disconnectSession.mockResolvedValue({ cancelled: true });
  mocks.setAppDirty.mockResolvedValue({});
});

it('updates full active-session counters from traffic with no page polling or extra subscription', async () => {
  mount(); await screen.findByText('127.0.0.1');
  act(() => emitStats(sample(2, 2000, { totalBytesSent: 2048, totalBytesReceived: 4096, sessions: [{ ...session, bytesSent: 2048, bytesReceived: 4096 }] })));
  const table = screen.getByRole('table', { name: 'Active Sessions' });
  expect(within(table).getByText('2.0 KB')).toBeInTheDocument(); expect(within(table).getByText('4.0 KB')).toBeInTheDocument();
  expect(screen.getByText('2.0 KB/s', { selector: 'dd' })).toBeInTheDocument(); expect(screen.getByText('4.0 KB/s', { selector: 'dd' })).toBeInTheDocument();
  act(() => emitStats(sample(99, 3000, { epoch: 0, sessions: [] })));
  expect(screen.getByText('127.0.0.1')).toBeInTheDocument();
  act(() => emitStats(sample(3, 3000, { sessions: [] })));
  expect(screen.queryByText('127.0.0.1')).not.toBeInTheDocument();
  expect(mocks.getStats).toHaveBeenCalledTimes(1); expect(mocks.onStatsUpdate).toHaveBeenCalledTimes(1);
});

it('leaves disconnect confirmation to main and flushes the latest draft before invoking', async () => {
  const confirm = vi.spyOn(window, 'confirm'); mount(); await screen.findByText('127.0.0.1');
  await act(async () => runtime.reportDraft({ dirty: true, draftRevision: 3 }));
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
  await waitFor(() => expect(mocks.disconnectSession).toHaveBeenCalledWith({ scope, sessionId: 1 }));
  expect(confirm).not.toHaveBeenCalled(); expect(screen.getByText('127.0.0.1')).toBeInTheDocument();
  expect(mocks.setAppDirty.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.disconnectSession.mock.invocationCallOrder[0]);
  expect(mocks.setAppDirty).toHaveBeenLastCalledWith({ scope, dirty: true, draftRevision: 3 }); confirm.mockRestore();
});

it('shows scoped history and requests only the selected 7 or 30 day range', async () => {
  mocks.getHistory.mockResolvedValue({ ...scope, revision: 1, sessions: [record, { ...record, id: 'foreign', profileId: 'b', bytesSent: 123456789 }] });
  mount(); await screen.findByText('127.0.0.1'); openHistory();
  expect(await screen.findByText(/Completed.*Exit 0/)).toBeInTheDocument();
  expect(mocks.getHistory).toHaveBeenLastCalledWith({ scope, days: 7 });
  const records = screen.getByRole('table', { name: 'Session records' }); expect(within(records).getAllByRole('row')).toHaveLength(2);
  fireEvent.change(screen.getByLabelText('History range'), { target: { value: '30' } });
  await waitFor(() => expect(mocks.getHistory).toHaveBeenLastCalledWith({ scope, days: 30 }));
  expect(screen.getByRole('button', { name: 'History' })).toHaveAttribute('aria-pressed', 'true');
});

it('preserves history, connections and dirty draft when native clear is cancelled', async () => {
  const confirm = vi.spyOn(window, 'confirm'); mount(); await screen.findByText('127.0.0.1');
  await act(async () => runtime.reportDraft({ dirty: true, draftRevision: 7 }));
  openHistory(); await screen.findByText(/Completed.*Exit 0/);
  expect(screen.getByText(/Clearing history stops and finalizes/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Clear profile history' }));
  await waitFor(() => expect(mocks.clearHistory).toHaveBeenCalledWith(scope));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Clear profile history' })).toBeEnabled());
  expect(screen.getByText(/Completed.*Exit 0/)).toBeInTheDocument(); expect(mocks.getHistory).toHaveBeenCalledTimes(1);
  expect(confirm).not.toHaveBeenCalled(); expect(mocks.disconnectSession).not.toHaveBeenCalled();
  expect(mocks.setAppDirty).toHaveBeenLastCalledWith({ scope, dirty: true, draftRevision: 7 });
  expect(mocks.setAppDirty.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.clearHistory.mock.invocationCallOrder[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Active Sessions' })); expect(screen.getByText('127.0.0.1')).toBeInTheDocument(); confirm.mockRestore();
});

it('reloads only after clear completes, using the epoch main advanced while stopping sessions', async () => {
  let finish;
  mocks.clearHistory.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  mount(); await screen.findByText('127.0.0.1'); openHistory(); await screen.findByText(/Completed.*Exit 0/);
  fireEvent.click(screen.getByRole('button', { name: 'Clear profile history' })); await waitFor(() => expect(finish).toBeTypeOf('function'));
  const nextScope = { profileId: 'default', epoch: 2 };
  mocks.getHistory.mockResolvedValue({ ...nextScope, revision: 2, sessions: [record] });
  act(() => emitRuntime({ ...nextScope, revision: 2, proxyStatus: 'stopped' }));
  await waitFor(() => expect(mocks.getHistory).toHaveBeenLastCalledWith({ scope: nextScope, days: 7 }));
  mocks.getHistory.mockResolvedValue({ ...nextScope, revision: 3, sessions: [] });
  await act(async () => finish({}));
  expect(await screen.findByText('No session history in this range.')).toBeInTheDocument();
  expect(screen.queryByText(/Completed.*Exit 0/)).not.toBeInTheDocument();
});

it('shows history storage errors with bounded memory records and an independent Retry', async () => {
  mocks.getHistory.mockResolvedValueOnce({ ...scope, revision: 1, sessions: [record], errorCode: 'HISTORY_STORAGE_FAILED' });
  mount(); await screen.findByText('127.0.0.1'); openHistory();
  expect(await screen.findByRole('alert')).toHaveTextContent('History could not be saved or loaded'); expect(screen.getByText(/Completed.*Exit 0/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Active Sessions' })); expect(screen.getByText('127.0.0.1')).toBeInTheDocument();
});

it('makes history available when active stats loading fails and handles history rejection with Retry', async () => {
  mocks.getStats.mockRejectedValue({ code: 'INTERNAL_ERROR' }); mocks.getHistory.mockRejectedValueOnce({ code: 'HISTORY_LOAD_FAILED', message: 'private path' });
  mount(); await screen.findByText('Could not load sessions'); openHistory();
  expect(await screen.findByRole('alert')).toHaveTextContent('History could not be loaded'); expect(screen.queryByText('private path')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' })); expect(await screen.findByText(/Completed.*Exit 0/)).toBeInTheDocument();
});

it('rejects a mismatched history DTO rather than displaying another scope', async () => {
  mocks.getHistory.mockResolvedValueOnce({ profileId: 'b', epoch: 1, revision: 1, sessions: [record] });
  mount(); await screen.findByText('127.0.0.1'); openHistory();
  expect(await screen.findByRole('alert')).toHaveTextContent('The history response is invalid'); expect(screen.queryByText(/Completed.*Exit 0/)).not.toBeInTheDocument();
});

it('clears history and rates on profile switch and ignores the old pending history response', async () => {
  let finish; mocks.getHistory.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  mount(); await screen.findByText('127.0.0.1');
  act(() => emitStats(sample(2, 2000, { totalBytesSent: 1024, totalBytesReceived: 2048 })));
  expect(screen.getByText('1.0 KB/s', { selector: 'dd' })).toBeInTheDocument(); openHistory(); await screen.findByText('Loading history…');
  const nextScope = { profileId: 'b', epoch: 2 };
  mocks.getHistory.mockResolvedValue({ ...nextScope, revision: 2, sessions: [] });
  mocks.getStats.mockResolvedValue({ ...sample(1, 3000, { sessions: [] }), ...nextScope });
  act(() => emitRuntime({ ...nextScope, revision: 2, proxyStatus: 'stopped' }));
  await screen.findByText('No session history in this range.');
  await act(async () => finish({ ...scope, revision: 99, sessions: [record] }));
  expect(screen.queryByText(/Completed.*Exit 0/)).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Active Sessions' }));
  expect(screen.queryByText('1.0 KB/s')).not.toBeInTheDocument(); expect(screen.getAllByText('0 B/s', { selector: 'dd' })).toHaveLength(2);
});

it('shows clear persistence failure without hiding history or affecting the active view', async () => {
  mocks.clearHistory.mockRejectedValue({ code: 'HISTORY_STORAGE_FAILED' });
  mount(); await screen.findByText('127.0.0.1'); openHistory(); await screen.findByText(/Completed.*Exit 0/);
  fireEvent.click(screen.getByRole('button', { name: 'Clear profile history' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('History could not be saved or loaded');
  expect(screen.getByText(/Completed.*Exit 0/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' })); await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
});

it('groups by UTC calendar day across timezone offsets and localizes dates without moving the bucket', async () => {
  const nearMidnight = [
    { ...record, id: 'a', endedAt: '2026-10-23T00:30:00+14:00' },
    { ...record, id: 'b', endedAt: '2026-10-22T23:30:00-10:00' },
    { ...record, id: 'c', startedAt: '2026-10-22T12:00:00Z', endedAt: null },
  ];
  expect(aggregateHistory(nearMidnight)).toEqual([
    { day: '2026-10-23', count: 1, bytesSent: 2048, bytesReceived: 4096 },
    { day: '2026-10-22', count: 2, bytesSent: 4096, bytesReceived: 8192 },
  ]);
  mocks.getSettings.mockResolvedValue({ locale: 'zh' }); mocks.getHistory.mockResolvedValue({ ...scope, revision: 1, sessions: nearMidnight });
  mount(); fireEvent.click(await screen.findByRole('button', { name: '历史记录' }));
  const table = await screen.findByRole('table', { name: '每日汇总' });
  const times = table.querySelectorAll('time'); expect([...times].map((node) => node.dateTime)).toEqual(['2026-10-23', '2026-10-22']);
  expect(times[0]).toHaveTextContent(new Intl.DateTimeFormat('zh', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date('2026-10-23T00:00:00Z')));
});
