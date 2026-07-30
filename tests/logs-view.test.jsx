import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../src/i18n/LocaleContext';
import { ToastProvider } from '../src/components/Toast';
import LogsView from '../src/views/LogsView';

const electronMocks = vi.hoisted(() => ({
  getLogs: vi.fn(),
  clearLogs: vi.fn(),
  onNewLog: vi.fn(),
  copyToClipboard: vi.fn(),
  setAppLocale: vi.fn(),
}));

vi.mock('../src/lib/electron', () => electronMocks);

function logEntry(id) {
  return {
    id,
    time: '2026-07-30T00:00:00.000Z',
    source: 'test',
    level: 'info',
    message: `entry ${id}`,
  };
}

function renderLogs() {
  return render(
    <LocaleProvider>
      <ToastProvider>
        <LogsView />
      </ToastProvider>
    </LocaleProvider>,
  );
}

describe('Logs view async behavior', () => {
  let emitLog;

  beforeEach(() => {
    emitLog = undefined;
    electronMocks.getLogs.mockReset();
    electronMocks.clearLogs.mockReset().mockResolvedValue({ ok: true });
    electronMocks.onNewLog.mockReset().mockImplementation((callback) => {
      emitLog = callback;
      return vi.fn();
    });
    electronMocks.copyToClipboard.mockReset().mockResolvedValue(true);
    electronMocks.setAppLocale.mockReset().mockResolvedValue(undefined);
  });

  it('recovers from an initial load failure when Retry is selected', async () => {
    electronMocks.getLogs
      .mockRejectedValueOnce(new Error('read failed'))
      .mockResolvedValueOnce([logEntry(1)]);

    renderLogs();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load logs');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('entry 1')).toBeInTheDocument();
    expect(electronMocks.getLogs).toHaveBeenCalledTimes(2);
  });

  it('keeps only the newest 500 initial and streamed entries', async () => {
    electronMocks.getLogs.mockResolvedValue(Array.from({ length: 510 }, (_, id) => logEntry(id)));

    renderLogs();

    expect(await screen.findByText('entry 509')).toBeInTheDocument();
    expect(screen.getByText('500 entries')).toBeInTheDocument();
    expect(screen.queryByText('entry 9')).not.toBeInTheDocument();
    expect(screen.getByText('entry 10')).toBeInTheDocument();

    act(() => emitLog(logEntry(510)));

    await waitFor(() => expect(screen.getByText('entry 510')).toBeInTheDocument());
    expect(screen.queryByText('entry 10')).not.toBeInTheDocument();
    expect(screen.getByText('500 entries')).toBeInTheDocument();
  });

  it('keeps streamed entries received while the initial snapshot is pending', async () => {
    let resolveLogs;
    electronMocks.getLogs.mockReturnValue(new Promise((resolve) => {
      resolveLogs = resolve;
    }));

    renderLogs();
    expect(emitLog).toBeTypeOf('function');

    act(() => emitLog(logEntry(2)));
    await act(async () => resolveLogs([logEntry(1)]));

    expect(await screen.findByText('entry 2')).toBeInTheDocument();
    expect(screen.getByText('entry 1')).toBeInTheDocument();
    expect(screen.getByText('2 entries')).toBeInTheDocument();
  });

  it('keeps new entries that arrive while the main process is clearing older logs', async () => {
    let resolveClear;
    electronMocks.getLogs.mockResolvedValue([logEntry(1)]);
    electronMocks.clearLogs.mockReturnValue(new Promise((resolve) => {
      resolveClear = resolve;
    }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderLogs();

    expect(await screen.findByText('entry 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    act(() => emitLog(logEntry(2)));
    expect(screen.getByText('entry 2')).toBeInTheDocument();

    await act(async () => resolveClear({ ok: true, clearedThroughId: 1 }));

    expect(screen.queryByText('entry 1')).not.toBeInTheDocument();
    expect(screen.getByText('entry 2')).toBeInTheDocument();
    expect(screen.getByText('1 entries')).toBeInTheDocument();
  });

  it('retains existing logs when the clear operation reports a failure', async () => {
    electronMocks.getLogs.mockResolvedValue([logEntry(1)]);
    electronMocks.clearLogs.mockResolvedValue({ ok: false, error: 'clear failed' });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderLogs();

    expect(await screen.findByText('entry 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(await screen.findByText('clear failed')).toBeInTheDocument();
    expect(screen.getByText('entry 1')).toBeInTheDocument();
  });
});
