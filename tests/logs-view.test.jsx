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
  exportLogs: vi.fn(), exportDiagnostics: vi.fn(),
  getStatus: vi.fn(), getSettings: vi.fn(), onRuntimeState: vi.fn(),
}));

vi.mock('../src/lib/electron', () => electronMocks);
const logRuntime = vi.hoisted(() => ({ scope: { profileId: 'default', epoch: 1 } }));
vi.mock('../src/contexts/RuntimeContext', () => ({ useRuntime: () => logRuntime, sameScope: (a, b) => a?.profileId === b?.profileId && a?.epoch === b?.epoch }));

function logEntry(id) {
  return {
    id,
    profileId: 'default', epoch: 1,
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
    logRuntime.scope = { profileId: 'default', epoch: 1 };
    electronMocks.getStatus.mockResolvedValue({profileId:'default',epoch:1,revision:1});
    electronMocks.getSettings.mockResolvedValue({locale:'en'});
    electronMocks.onRuntimeState.mockReturnValue(vi.fn());
    electronMocks.getLogs.mockReset();
    electronMocks.clearLogs.mockReset().mockResolvedValue({});
    electronMocks.onNewLog.mockReset().mockImplementation((callback) => {
      emitLog = callback;
      return vi.fn();
    });
    electronMocks.copyToClipboard.mockReset().mockResolvedValue(true);
    electronMocks.setAppLocale.mockReset().mockResolvedValue(undefined);
    electronMocks.exportLogs.mockReset().mockResolvedValue({exported:true});
    electronMocks.exportDiagnostics.mockReset().mockResolvedValue({exported:true});
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

    await act(async () => resolveClear({ clearedThroughId: 1 }));

    expect(screen.queryByText('entry 1')).not.toBeInTheDocument();
    expect(screen.getByText('entry 2')).toBeInTheDocument();
    expect(screen.getByText('1 entries')).toBeInTheDocument();
  });

  it('retains existing logs when the clear operation reports a failure', async () => {
    electronMocks.getLogs.mockResolvedValue([logEntry(1)]);
    electronMocks.clearLogs.mockRejectedValue(Object.assign(new Error('secret backend message'), { code: 'INTERNAL_ERROR' }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderLogs();

    expect(await screen.findByText('entry 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(await screen.findByText('An internal error occurred. Please retry.')).toBeInTheDocument();
    expect(screen.getByText('entry 1')).toBeInTheDocument();
  });

  it('uses case-insensitive literal search without discarding the raw records', async () => {
    electronMocks.getLogs.mockResolvedValue([{...logEntry(1),message:'Connected [OK]'}, {...logEntry(2),message:'Connected XX'}]);
    renderLogs();
    await screen.findByText('Connected [OK]');
    fireEvent.change(screen.getByLabelText('Plain-text search'), {target:{value:'[ok]'}});
    expect(screen.getByText('Connected [OK]')).toBeInTheDocument();
    expect(screen.queryByText('Connected XX')).not.toBeInTheDocument();
    expect(screen.getByText('1 of 2 entries match')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Plain-text search'), {target:{value:'.*'}});
    expect(screen.getByText('No logs match these filters.')).toBeInTheDocument();
    expect(screen.getByRole('button', {name:'Copy matches'})).toBeDisabled();
    fireEvent.click(screen.getAllByRole('button', {name:'Clear filters'})[0]);
    expect(screen.getByText('Connected [OK]')).toBeInTheDocument();
    expect(screen.getByText('Connected XX')).toBeInTheDocument();
  });

  it('combines level, source and inclusive ISO time filters when copying and exporting', async () => {
    const one = {...logEntry(1),source:'proxy',level:'warn',message:'Token [REDACTED]',time:'2026-07-30T01:00:00.000Z'};
    electronMocks.getLogs.mockResolvedValue([one,{...logEntry(2),source:'login',level:'warn'},{...logEntry(3),source:'proxy',level:'info'}]);
    renderLogs();
    await screen.findByText('Token [REDACTED]');
    fireEvent.change(screen.getByLabelText('Level'), {target:{value:'warn'}});
    fireEvent.change(screen.getByLabelText('Source'), {target:{value:'proxy'}});
    fireEvent.change(screen.getByLabelText('From (ISO UTC)'), {target:{value:one.time}});
    fireEvent.change(screen.getByLabelText('To (ISO UTC)'), {target:{value:one.time}});
    fireEvent.click(screen.getByRole('button', {name:'Copy matches'}));
    await waitFor(() => expect(electronMocks.copyToClipboard).toHaveBeenCalledExactlyOnceWith('[2026-07-30T01:00:00.000Z] [warn] [proxy] Token [REDACTED]'));
    fireEvent.click(screen.getByRole('button', {name:'Export matches'}));
    await waitFor(() => expect(electronMocks.exportLogs).toHaveBeenCalledExactlyOnceWith({scope:logRuntime.scope,filters:{query:'',level:'warn',source:'proxy',from:one.time,to:one.time}}));
    expect(electronMocks.exportLogs.mock.calls[0][0]).not.toHaveProperty('logs');
    expect(electronMocks.exportLogs.mock.calls[0][0]).not.toHaveProperty('message');
    expect(screen.getByText(/latest 500 safe log records, not just the filtered matches/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name:'Export diagnostic package'}));
    await waitFor(() => expect(electronMocks.exportDiagnostics).toHaveBeenCalledExactlyOnceWith(logRuntime.scope));
  });

  it('labels invalid dates and inverted ranges and prevents copy or export until corrected', async () => {
    electronMocks.getLogs.mockResolvedValue([logEntry(1)]);
    renderLogs();
    await screen.findByText('entry 1');
    const from = screen.getByLabelText('From (ISO UTC)');
    const to = screen.getByLabelText('To (ISO UTC)');
    fireEvent.change(from, {target:{value:'2026-02-30T00:00:00.000Z'}});
    expect(from).toHaveAttribute('aria-invalid','true');
    expect(screen.getByText('Enter a valid ISO UTC time and a range with From no later than To.')).toBeInTheDocument();
    expect(screen.getByRole('button', {name:'Export matches'})).toBeDisabled();
    fireEvent.change(from, {target:{value:'2026-07-31T00:00:00.000Z'}});
    fireEvent.change(to, {target:{value:'2026-07-29T00:00:00.000Z'}});
    expect(from).toHaveAttribute('aria-invalid','true');
    expect(to).toHaveAttribute('aria-invalid','true');
    expect(screen.getByRole('button', {name:'Copy matches'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button', {name:'Clear filters'}));
    expect(screen.getByRole('button', {name:'Copy matches'})).toBeEnabled();
  });

  it('treats native cancellation as success without a failure toast and retries redacted export errors', async () => {
    electronMocks.getLogs.mockResolvedValue([logEntry(1)]);
    electronMocks.exportLogs.mockResolvedValueOnce({cancelled:true}).mockRejectedValueOnce(Object.assign(new Error('Cookie=secret /private/home'),{code:'EXPORT_FAILED'})).mockResolvedValueOnce({exported:true});
    renderLogs();
    await screen.findByText('entry 1');
    fireEvent.click(screen.getByRole('button', {name:'Export matches'}));
    await waitFor(() => expect(screen.getByRole('button', {name:'Export matches'})).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('Matching logs exported')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name:'Export matches'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('The export could not be saved. Check file access and retry.');
    expect(screen.queryByText(/Cookie=secret/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name:'Retry'}));
    expect(await screen.findByText('Matching logs exported')).toBeInTheDocument();
    expect(electronMocks.exportLogs).toHaveBeenCalledTimes(3);
  });

  it('clears old-scope data and filters and rejects late reads and streamed logs', async () => {
    let finishOld;
    electronMocks.getLogs.mockReturnValueOnce(new Promise((resolve) => {finishOld=resolve;})).mockResolvedValueOnce([{...logEntry(3),profileId:'b',epoch:2}]);
    const view=renderLogs();
    const oldListener=emitLog;
    fireEvent.change(screen.getByLabelText('Plain-text search'), {target:{value:'old filter'}});
    logRuntime.scope={profileId:'b',epoch:2};
    view.rerender(<LocaleProvider><ToastProvider><LogsView /></ToastProvider></LocaleProvider>);
    expect(await screen.findByText('entry 3')).toBeInTheDocument();
    expect(screen.getByLabelText('Plain-text search')).toHaveValue('');
    await act(async () => {finishOld([logEntry(1)]);oldListener(logEntry(2));});
    expect(screen.queryByText('entry 1')).not.toBeInTheDocument();
    expect(screen.queryByText('entry 2')).not.toBeInTheDocument();
    expect(screen.getByText('entry 3')).toBeInTheDocument();
  });

  it('renders the log filters in Chinese using the saved language', async () => {
    electronMocks.getSettings.mockResolvedValue({locale:'zh'});
    electronMocks.getLogs.mockResolvedValue([logEntry(1)]);
    renderLogs();
    expect(await screen.findByLabelText('纯文本搜索')).toBeInTheDocument();
    expect(screen.getByRole('button', {name:'复制匹配结果'})).toBeInTheDocument();
    expect(screen.getByLabelText('起始时间（ISO UTC）')).toBeInTheDocument();
  });
});
