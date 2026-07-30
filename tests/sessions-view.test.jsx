import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../src/i18n/LocaleContext';
import { ToastProvider } from '../src/components/Toast';
import SessionsView from '../src/views/SessionsView';

const electronMocks = vi.hoisted(() => ({
  getSessions: vi.fn(),
  disconnectSession: vi.fn(),
  onSessionUpdate: vi.fn(),
  onProxyStatus: vi.fn(),
  setAppLocale: vi.fn(),
}));

vi.mock('../src/lib/electron', () => electronMocks);

function session(id) {
  return {
    id,
    remoteAddress: `10.0.0.${id}`,
    connectedAt: Date.now() - 1000,
    bytesSent: id * 10,
    bytesReceived: id * 20,
  };
}

function renderSessions() {
  return render(
    <LocaleProvider>
      <ToastProvider>
        <SessionsView />
      </ToastProvider>
    </LocaleProvider>,
  );
}

describe('Sessions view async behavior', () => {
  let emitSessionUpdate;
  let emitProxyStatus;

  beforeEach(() => {
    emitSessionUpdate = undefined;
    emitProxyStatus = undefined;
    electronMocks.getSessions.mockReset();
    electronMocks.disconnectSession.mockReset().mockResolvedValue(true);
    electronMocks.onSessionUpdate.mockReset().mockImplementation((callback) => {
      emitSessionUpdate = callback;
      return vi.fn();
    });
    electronMocks.onProxyStatus.mockReset().mockImplementation((callback) => {
      emitProxyStatus = callback;
      return vi.fn();
    });
    electronMocks.setAppLocale.mockReset().mockResolvedValue(undefined);
  });

  it('keeps an authoritative event snapshot received while initial loading is pending', async () => {
    let resolveSessions;
    electronMocks.getSessions.mockReturnValue(new Promise((resolve) => {
      resolveSessions = resolve;
    }));
    renderSessions();
    expect(emitSessionUpdate).toBeTypeOf('function');

    act(() => emitSessionUpdate({ all: [session(2)] }));
    await act(async () => resolveSessions([session(1)]));

    expect(await screen.findByText('10.0.0.2')).toBeInTheDocument();
    expect(screen.queryByText('10.0.0.1')).not.toBeInTheDocument();
  });

  it('clears displayed sessions when the proxy stops', async () => {
    electronMocks.getSessions.mockResolvedValue([session(2)]);
    renderSessions();

    expect(await screen.findByText('10.0.0.2')).toBeInTheDocument();
    act(() => emitProxyStatus({ proxyStatus: 'stopped', connectionCount: 0 }));

    expect(await screen.findByText('No active SSH sessions')).toBeInTheDocument();
    expect(screen.queryByText('10.0.0.2')).not.toBeInTheDocument();
  });

  it('does not restore an older pending snapshot after the proxy stops', async () => {
    let resolveSessions;
    electronMocks.getSessions.mockReturnValue(new Promise((resolve) => {
      resolveSessions = resolve;
    }));
    renderSessions();

    act(() => emitProxyStatus({ proxyStatus: 'stopped', connectionCount: 0 }));
    await act(async () => resolveSessions([session(1)]));

    expect(await screen.findByText('No active SSH sessions')).toBeInTheDocument();
    expect(screen.queryByText('10.0.0.1')).not.toBeInTheDocument();
  });
});
