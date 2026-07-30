import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../src/i18n/LocaleContext';
import { ToastProvider } from '../src/components/Toast';
import DashboardView from '../src/views/DashboardView';

const electronMocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getStats: vi.fn(),
  startLogin: vi.fn(),
  startProxy: vi.fn(),
  stopProxy: vi.fn(),
  onLoginStatus: vi.fn(),
  onProxyStatus: vi.fn(),
  onCookieStatus: vi.fn(),
  onLoginProgress: vi.fn(),
  onStatsUpdate: vi.fn(),
  copyToClipboard: vi.fn(),
  getSshKeyInfo: vi.fn(),
  setAppLocale: vi.fn(),
}));

vi.mock('../src/lib/electron', () => electronMocks);

const INITIAL_STATUS = {
  loginStatus: 'idle',
  proxyStatus: 'stopped',
  connectionCount: 0,
  cookieValid: false,
  cookieCount: 0,
  host: '127.0.0.1',
  port: 3000,
  wssUrl: '',
  error: null,
};

const INITIAL_STATS = {
  uptimeMs: 0,
  totalBytesSent: 0,
  totalBytesReceived: 0,
  sessionCount: 0,
  sessions: [],
};

function renderDashboard() {
  return render(
    <LocaleProvider>
      <ToastProvider>
        <DashboardView />
      </ToastProvider>
    </LocaleProvider>,
  );
}

describe('Dashboard view async behavior', () => {
  let emitLoginStatus;
  let emitProxyStatus;
  let emitStatsUpdate;

  beforeEach(() => {
    emitLoginStatus = undefined;
    emitProxyStatus = undefined;
    emitStatsUpdate = undefined;
    electronMocks.getStatus.mockReset().mockResolvedValue({ ...INITIAL_STATUS });
    electronMocks.getStats.mockReset().mockResolvedValue({ ...INITIAL_STATS });
    electronMocks.getSshKeyInfo.mockReset().mockResolvedValue({ privateKeyPath: '' });
    electronMocks.startLogin.mockReset();
    electronMocks.startProxy.mockReset();
    electronMocks.stopProxy.mockReset();
    electronMocks.copyToClipboard.mockReset().mockResolvedValue(true);
    electronMocks.setAppLocale.mockReset().mockResolvedValue(undefined);
    electronMocks.onLoginStatus.mockReset().mockImplementation((callback) => {
      emitLoginStatus = callback;
      return vi.fn();
    });
    electronMocks.onProxyStatus.mockReset().mockImplementation((callback) => {
      emitProxyStatus = callback;
      return vi.fn();
    });
    electronMocks.onCookieStatus.mockReset().mockReturnValue(vi.fn());
    electronMocks.onLoginProgress.mockReset().mockReturnValue(vi.fn());
    electronMocks.onStatsUpdate.mockReset().mockImplementation((callback) => {
      emitStatsUpdate = callback;
      return vi.fn();
    });
  });

  it('preserves fields updated by live events while merging an older initial status', async () => {
    let resolveStatus;
    electronMocks.getStatus.mockReturnValue(new Promise((resolve) => {
      resolveStatus = resolve;
    }));
    renderDashboard();

    act(() => {
      emitLoginStatus('success');
      emitProxyStatus({
        proxyStatus: 'started',
        connectionCount: 3,
        wssUrl: 'wss://live.example.test',
        error: null,
      });
    });
    expect(screen.queryByText('Listening on 127.0.0.1:3000')).not.toBeInTheDocument();
    await act(async () => resolveStatus({
      ...INITIAL_STATUS,
      host: 'localhost',
      port: 4000,
    }));

    expect(await screen.findByText('Logged in', { selector: '.status-dot' })).toBeInTheDocument();
    expect(screen.getByText('Running', { selector: '.status-dot' })).toBeInTheDocument();
    expect(screen.getByText('3 active connections')).toBeInTheDocument();
    expect(screen.getByText('localhost:4000', { selector: 'code' })).toBeInTheDocument();
    expect(screen.getByText('Listening on localhost:4000')).toBeInTheDocument();
    expect(screen.queryByText('Listening on 127.0.0.1:3000')).not.toBeInTheDocument();
  });

  it('keeps a live stats snapshot received while initial loading is pending', async () => {
    let resolveStats;
    electronMocks.getStatus.mockResolvedValue({
      ...INITIAL_STATUS,
      loginStatus: 'success',
      proxyStatus: 'started',
    });
    electronMocks.getStats.mockReturnValue(new Promise((resolve) => {
      resolveStats = resolve;
    }));
    renderDashboard();

    act(() => emitStatsUpdate({
      ...INITIAL_STATS,
      totalBytesSent: 2048,
      sessionCount: 7,
    }));
    await act(async () => resolveStats({
      ...INITIAL_STATS,
      totalBytesSent: 1,
      sessionCount: 1,
    }));

    expect(await screen.findByText('2.0 KB')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.queryByText('1 B')).not.toBeInTheDocument();
  });

  it('does not announce a default address when the initial status snapshot fails', async () => {
    let rejectStatus;
    electronMocks.getStatus.mockReturnValue(new Promise((_, reject) => {
      rejectStatus = reject;
    }));
    renderDashboard();

    act(() => emitProxyStatus({
      proxyStatus: 'started',
      connectionCount: 1,
      error: null,
    }));
    await act(async () => rejectStatus(new Error('status unavailable')));

    expect(await screen.findByText('Could not load dashboard')).toBeInTheDocument();
    expect(screen.queryByText('Listening on 127.0.0.1:3000')).not.toBeInTheDocument();
  });

  it('allows stopping a proxy that is still starting', async () => {
    electronMocks.getStatus.mockResolvedValue({
      ...INITIAL_STATUS,
      loginStatus: 'success',
      proxyStatus: 'starting',
    });
    electronMocks.stopProxy.mockResolvedValue({ ok: true });
    renderDashboard();

    const stopButton = await screen.findByRole('button', { name: 'Stop' });
    expect(stopButton).toBeEnabled();
    fireEvent.click(stopButton);

    await waitFor(() => expect(electronMocks.stopProxy).toHaveBeenCalledTimes(1));
  });

  it('allows stopping an errored proxy', async () => {
    electronMocks.getStatus.mockResolvedValue({
      ...INITIAL_STATUS,
      loginStatus: 'success',
      cookieValid: true,
      proxyStatus: 'error',
      error: 'startup failed',
    });
    electronMocks.stopProxy.mockResolvedValue({ ok: true });
    renderDashboard();

    const stopButton = await screen.findByRole('button', { name: 'Stop' });
    expect(stopButton).toBeEnabled();
    fireEvent.click(stopButton);

    await waitFor(() => expect(electronMocks.stopProxy).toHaveBeenCalledTimes(1));
  });

  it('confirms before restarting an errored proxy with active connections', async () => {
    electronMocks.getStatus.mockResolvedValue({
      ...INITIAL_STATUS,
      loginStatus: 'success',
      cookieValid: true,
      proxyStatus: 'error',
      connectionCount: 2,
      error: 'startup failed',
    });
    electronMocks.startProxy.mockResolvedValue({ ok: true });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderDashboard();

    const startButton = await screen.findByRole('button', { name: 'Start' });
    fireEvent.click(startButton);
    expect(electronMocks.startProxy).not.toHaveBeenCalled();

    fireEvent.click(startButton);
    await waitFor(() => expect(electronMocks.startProxy).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledWith('Stop the proxy and disconnect 2 active connections?');
  });

  it('does not run start and stop concurrently in the same render', async () => {
    let resolveStart;
    electronMocks.getStatus.mockResolvedValue({
      ...INITIAL_STATUS,
      loginStatus: 'success',
      cookieValid: true,
      proxyStatus: 'error',
      error: 'startup failed',
    });
    electronMocks.startProxy.mockReturnValue(new Promise((resolve) => {
      resolveStart = resolve;
    }));
    renderDashboard();

    const startButton = await screen.findByRole('button', { name: 'Start' });
    const stopButton = screen.getByRole('button', { name: 'Stop' });
    expect(startButton).toBeEnabled();
    act(() => {
      fireEvent.click(startButton);
      fireEvent.click(stopButton);
    });

    expect(electronMocks.startProxy).toHaveBeenCalledTimes(1);
    expect(electronMocks.stopProxy).not.toHaveBeenCalled();
    await act(async () => resolveStart({ ok: true }));
  });

  it('keeps proxy start disabled when the login label is stale but cookies are invalid', async () => {
    electronMocks.getStatus.mockResolvedValue({
      ...INITIAL_STATUS,
      loginStatus: 'success',
      cookieValid: false,
      proxyStatus: 'stopped',
    });
    renderDashboard();

    expect(await screen.findByRole('button', { name: 'Start' })).toBeDisabled();
  });
});
