import { beforeEach, describe, expect, it, vi } from 'vitest';
import { copyToClipboard, getSsoCredentials, setAppDirty } from '../src/lib/electron';

describe('Electron credential wrapper', () => {
  beforeEach(() => {
    globalThis.electronAPI = {
      isElectron: true,
      getSsoCredentials: vi.fn(),
    };
  });

  it('converts a legacy plaintext response into a write-only credential status', async () => {
    globalThis.electronAPI.getSsoCredentials.mockResolvedValue({
      username: 'SA123',
      password: 'legacy-plaintext-password',
    });

    const credentials = await getSsoCredentials();

    expect(credentials).toEqual({
      username: 'SA123',
      hasPassword: true,
      storageAvailable: true,
    });
    expect(credentials).not.toHaveProperty('password');
    expect(JSON.stringify(credentials)).not.toContain('legacy-plaintext-password');
  });

  it('preserves the secure-storage availability signal without exposing secrets', async () => {
    globalThis.electronAPI.getSsoCredentials.mockResolvedValue({
      username: 'SA123',
      hasPassword: false,
      storageAvailable: false,
      password: '',
    });

    await expect(getSsoCredentials()).resolves.toEqual({
      username: 'SA123',
      hasPassword: false,
      storageAvailable: false,
    });
  });
});

describe('clipboard wrapper', () => {
  beforeEach(() => {
    globalThis.electronAPI = {
      isElectron: true,
      copyToClipboard: vi.fn(),
    };
  });

  it('returns true when Electron confirms the clipboard write', async () => {
    globalThis.electronAPI.copyToClipboard.mockResolvedValue({ ok: true });

    await expect(copyToClipboard('text')).resolves.toBe(true);
  });

  it('returns false when Electron rejects or does not expose the clipboard method', async () => {
    globalThis.electronAPI.copyToClipboard.mockRejectedValueOnce(new Error('clipboard unavailable'));

    await expect(copyToClipboard('text')).resolves.toBe(false);

    delete globalThis.electronAPI.copyToClipboard;
    await expect(copyToClipboard('text')).resolves.toBe(false);
  });

  it('returns false when the browser clipboard write rejects', async () => {
    globalThis.electronAPI.isElectron = false;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('permission denied')) },
    });

    await expect(copyToClipboard('text')).resolves.toBe(false);
  });
});

describe('application dirty-state wrapper', () => {
  it('normalizes and forwards dirty state to the trusted Electron bridge', async () => {
    globalThis.electronAPI = {
      isElectron: true,
      setAppDirty: vi.fn().mockResolvedValue({ ok: true }),
    };

    await expect(setAppDirty('dirty')).resolves.toEqual({ ok: true });
    expect(globalThis.electronAPI.setAppDirty).toHaveBeenCalledWith(true);
  });

  it('does nothing when the bridge is unavailable', async () => {
    globalThis.electronAPI = { isElectron: false };
    await expect(setAppDirty(true)).resolves.toBeUndefined();
  });

  it('returns a failure result instead of leaking a rejected IPC promise', async () => {
    globalThis.electronAPI = {
      isElectron: true,
      setAppDirty: vi.fn().mockRejectedValue(new Error('renderer unavailable')),
    };

    await expect(setAppDirty(true)).resolves.toEqual({
      ok: false,
      error: 'renderer unavailable',
    });
  });
});
