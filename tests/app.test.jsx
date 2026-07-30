import React, { useEffect } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

const electronMocks = vi.hoisted(() => ({
  getTheme: vi.fn(),
  setTheme: vi.fn(),
  setAppLocale: vi.fn(),
  setAppDirty: vi.fn(),
  onThemeChanged: vi.fn(),
}));

vi.mock('../src/lib/electron', () => electronMocks);
vi.mock('../src/views/DashboardView', () => ({ default: () => <div>Dashboard content</div> }));
vi.mock('../src/views/SessionsView', () => ({ default: () => <div>Sessions content</div> }));
vi.mock('../src/views/LogsView', () => ({ default: () => <div>Logs content</div> }));
vi.mock('../src/views/SettingsView', () => ({
  default: function SettingsStub({ onDirtyChange, onBusyChange }) {
    useEffect(() => {
      onDirtyChange(true);
      onBusyChange(true);
      return () => {
        onDirtyChange(false);
        onBusyChange(false);
      };
    }, [onBusyChange, onDirtyChange]);
    return (
      <div>
        Settings content
        <button type="button" onClick={() => onBusyChange(false)}>Finish operation</button>
      </div>
    );
  },
}));

describe('Application navigation guards', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    electronMocks.getTheme.mockReset().mockResolvedValue('dark');
    electronMocks.setTheme.mockReset().mockResolvedValue({ ok: true });
    electronMocks.setAppLocale.mockReset().mockResolvedValue({ ok: true });
    electronMocks.setAppDirty.mockReset().mockResolvedValue({ ok: true });
    electronMocks.onThemeChanged.mockReset().mockReturnValue(vi.fn());
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  });

  it('blocks navigation while a settings operation is pending, then confirms dirty changes', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByText('Settings content')).toBeInTheDocument();
    await waitFor(() => expect(electronMocks.setAppDirty).toHaveBeenCalledWith(true));

    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));
    expect(screen.getByText('Settings content')).toBeInTheDocument();
    expect(await screen.findByText('Operation in progress')).toBeInTheDocument();
    expect(confirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Finish operation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dashboard' }));

    expect(await screen.findByText('Dashboard content')).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledWith('Discard unsaved changes?');
    await waitFor(() => expect(electronMocks.setAppDirty).toHaveBeenLastCalledWith(false));
  });

  it('uses a dismissible sidebar drawer on narrow viewports', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    render(<App />);

    const sidebar = document.querySelector('.sidebar');
    expect(sidebar).toHaveClass('collapsed');

    const toggleButtons = screen.getAllByRole('button', { name: 'Toggle sidebar' });
    fireEvent.click(toggleButtons[toggleButtons.length - 1]);
    expect(sidebar).not.toHaveClass('collapsed');
    expect(screen.getByRole('button', { name: 'Close sidebar' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sessions' }));
    expect(await screen.findByText('Sessions content')).toBeInTheDocument();
    expect(sidebar).toHaveClass('collapsed');
    expect(screen.queryByRole('button', { name: 'Close sidebar' })).not.toBeInTheDocument();
  });
});
