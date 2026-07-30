import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../src/i18n/LocaleContext';
import { ToastProvider } from '../src/components/Toast';
import SettingsView from '../src/views/SettingsView';

const electronMocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  saveSettings: vi.fn(),
  getRuntimeInfo: vi.fn(),
  generateSshConfig: vi.fn(),
  saveSsoCredentials: vi.fn(),
  getSsoCredentials: vi.fn(),
  clearSsoCredentials: vi.fn(),
  supportsClearSsoCredentials: vi.fn(),
  getSshKeyInfo: vi.fn(),
  copyToClipboard: vi.fn(),
  setAppLocale: vi.fn(),
}));

vi.mock('../src/lib/electron', () => electronMocks);

const SETTINGS = {
  port: 3000,
  host: '127.0.0.1',
  cluster: 'training',
  loginNode: '11.11.10.202',
  cols: 80,
  rows: 24,
  useRoot: false,
  autoConnect: true,
  startMinimized: false,
  theme: 'dark',
  sshAlias: 'usshtc107',
  locale: 'en',
};

function renderSettings() {
  return render(
    <LocaleProvider>
      <ToastProvider>
        <SettingsView onDirtyChange={vi.fn()} />
      </ToastProvider>
    </LocaleProvider>,
  );
}

describe('Settings SSO credentials', () => {
  beforeEach(() => {
    electronMocks.getSettings.mockReset().mockResolvedValue({ ...SETTINGS });
    electronMocks.saveSettings.mockReset().mockResolvedValue({ ok: true, needsRestart: false });
    electronMocks.getRuntimeInfo.mockReset().mockResolvedValue({
      platform: 'linux',
      electronVersion: '43.2.0',
      nodeVersion: '22.0.0',
      devMode: false,
    });
    electronMocks.generateSshConfig.mockReset().mockResolvedValue({ success: true });
    electronMocks.saveSsoCredentials.mockReset().mockResolvedValue({
      ok: true,
      username: 'SA123',
      hasPassword: true,
      storageAvailable: true,
    });
    electronMocks.getSsoCredentials.mockReset().mockResolvedValue({
      username: 'SA123',
      hasPassword: true,
      storageAvailable: true,
      password: 'legacy-plaintext-password',
    });
    electronMocks.clearSsoCredentials.mockReset().mockResolvedValue({
      ok: true,
      username: '',
      hasPassword: false,
      storageAvailable: true,
    });
    electronMocks.supportsClearSsoCredentials.mockReset().mockReturnValue(true);
    electronMocks.getSshKeyInfo.mockReset().mockResolvedValue({
      publicKey: 'ssh-ed25519 public-key',
      privateKeyPath: '/tmp/test key',
    });
    electronMocks.copyToClipboard.mockReset().mockResolvedValue(true);
    electronMocks.setAppLocale.mockReset().mockResolvedValue(undefined);
  });

  it('never renders a stored password and preserves it when only the username changes', async () => {
    renderSettings();

    const username = await screen.findByLabelText('USTC ID / GID');
    const password = screen.getByLabelText('Password');

    expect(password).toHaveValue('');
    expect(password).toHaveAttribute('placeholder', 'Leave blank to keep the stored password');
    expect(screen.queryByDisplayValue('legacy-plaintext-password')).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('legacy-plaintext-password');

    fireEvent.change(username, { target: { value: 'SA456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));

    await waitFor(() => {
      expect(electronMocks.saveSsoCredentials).toHaveBeenCalledWith('SA456', undefined);
    });
    expect(electronMocks.saveSettings).not.toHaveBeenCalled();
    expect(password).toHaveValue('');
  });

  it('saves only settings edited on this page without overwriting theme or locale', async () => {
    electronMocks.getSettings.mockResolvedValueOnce({
      ...SETTINGS,
      theme: 'light',
      locale: 'zh',
    });
    renderSettings();

    const host = await screen.findByLabelText('Host');
    fireEvent.change(host, { target: { value: ' localhost ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));

    await waitFor(() => {
      expect(electronMocks.saveSettings).toHaveBeenCalledWith({ host: 'localhost' });
    });
    const savedPatch = electronMocks.saveSettings.mock.calls[0][0];
    expect(savedPatch).not.toHaveProperty('theme');
    expect(savedPatch).not.toHaveProperty('locale');
    expect(electronMocks.saveSsoCredentials).not.toHaveBeenCalled();
  });

  it('resets only settings owned by this page', async () => {
    electronMocks.getSettings.mockResolvedValueOnce({
      ...SETTINGS,
      theme: 'light',
      locale: 'zh',
    });
    renderSettings();
    await screen.findByLabelText('Host');

    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));

    await waitFor(() => {
      expect(electronMocks.saveSettings).toHaveBeenCalledWith({
        host: '127.0.0.1',
        port: 3000,
        cluster: 'training',
        loginNode: '11.11.10.202',
        cols: 80,
        rows: 24,
        useRoot: false,
        autoConnect: true,
        startMinimized: false,
        sshAlias: 'usshtc107',
      });
    });
    const savedPatch = electronMocks.saveSettings.mock.calls[0][0];
    expect(savedPatch).not.toHaveProperty('theme');
    expect(savedPatch).not.toHaveProperty('locale');
  });

  it('uses the full labeled row as the click target for setting toggles', async () => {
    renderSettings();

    const autoConnect = await screen.findByLabelText('Auto-connect on startup');
    expect(autoConnect).toBeChecked();
    fireEvent.click(screen.getByText('Auto-connect on startup'));
    expect(autoConnect).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    await waitFor(() => {
      expect(electronMocks.saveSettings).toHaveBeenCalledWith({ autoConnect: false });
    });
  });

  it('keeps the proxy restart warning after a later credentials-only save', async () => {
    electronMocks.saveSettings.mockResolvedValueOnce({ ok: true, needsRestart: true });
    renderSettings();

    const host = await screen.findByLabelText('Host');
    fireEvent.change(host, { target: { value: 'localhost' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));

    expect(await screen.findByText(/stop and restart/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('USTC ID / GID'), { target: { value: 'SA456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));

    await waitFor(() => expect(electronMocks.saveSsoCredentials).toHaveBeenCalledWith('SA456', undefined));
    expect(electronMocks.saveSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/stop and restart/i)).toBeInTheDocument();
  });

  it('commits saved settings when credentials fail and preserves restart state on retry', async () => {
    electronMocks.saveSettings.mockResolvedValueOnce({ ok: true, needsRestart: true });
    electronMocks.saveSsoCredentials
      .mockResolvedValueOnce({ ok: false, error: 'credential storage locked' })
      .mockResolvedValueOnce({
        ok: true,
        username: 'SA456',
        hasPassword: true,
        storageAvailable: true,
      });
    renderSettings();

    fireEvent.change(await screen.findByLabelText('Host'), { target: { value: 'localhost' } });
    fireEvent.change(screen.getByLabelText('USTC ID / GID'), { target: { value: 'SA456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));

    expect(await screen.findByText(/stop and restart/i)).toBeInTheDocument();
    expect(await screen.findByText('credential storage locked')).toBeInTheDocument();
    expect(electronMocks.saveSettings).toHaveBeenCalledWith({ host: 'localhost' });
    expect(electronMocks.saveSsoCredentials).toHaveBeenCalledTimes(1);

    const retry = screen.getByRole('button', { name: 'Save Settings' });
    await waitFor(() => expect(retry).not.toBeDisabled());
    fireEvent.click(retry);

    await waitFor(() => expect(electronMocks.saveSsoCredentials).toHaveBeenCalledTimes(2));
    expect(electronMocks.saveSettings).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/stop and restart/i)).toBeInTheDocument();
  });

  it('sends a replacement password once, then clears credentials only after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderSettings();

    const password = await screen.findByLabelText('Password');
    fireEvent.change(password, { target: { value: 'replacement-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));

    await waitFor(() => {
      expect(electronMocks.saveSsoCredentials).toHaveBeenCalledWith('SA123', 'replacement-password');
    });
    expect(electronMocks.saveSsoCredentials).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(password).toHaveValue(''));

    fireEvent.click(screen.getByRole('button', { name: 'Clear credentials' }));
    expect(electronMocks.clearSsoCredentials).not.toHaveBeenCalled();
    expect(screen.getByLabelText('USTC ID / GID')).toHaveValue('SA123');

    fireEvent.click(screen.getByRole('button', { name: 'Clear credentials' }));

    await waitFor(() => expect(electronMocks.clearSsoCredentials).toHaveBeenCalledTimes(1));
    expect(window.confirm).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('USTC ID / GID')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Clear credentials' })).not.toBeInTheDocument();
  });

  it('does not generate SSH config from settings that have not been saved', async () => {
    renderSettings();

    fireEvent.change(await screen.findByLabelText('Host'), { target: { value: 'localhost' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate ~/.ssh/config' }));

    expect(await screen.findByText('Save settings first')).toBeInTheDocument();
    expect(electronMocks.generateSshConfig).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));
    await waitFor(() => expect(electronMocks.saveSettings).toHaveBeenCalledWith({ host: 'localhost' }));
    fireEvent.click(screen.getByRole('button', { name: 'Generate ~/.ssh/config' }));

    await waitFor(() => {
      expect(electronMocks.generateSshConfig).toHaveBeenCalledWith({
        host: 'localhost',
        port: 3000,
        alias: 'usshtc107',
      });
    });
  });
});
