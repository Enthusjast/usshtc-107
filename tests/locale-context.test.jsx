import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { LocaleProvider, useLocale } from '../src/i18n/LocaleContext';

const mocks = vi.hoisted(() => ({ getStatus: vi.fn(), getSettings: vi.fn(), onRuntimeState: vi.fn(), setAppLocale: vi.fn() }));
vi.mock('../src/lib/electron', () => mocks);
let emit;
function Probe() {
  const { locale, setLocale } = useLocale();
  return <><output>{locale}</output><button type="button" onClick={() => { void setLocale('zh').catch(() => {}); }}>Chinese</button><button type="button" onClick={() => { void setLocale('en').catch(() => {}); }}>English</button></>;
}
function mount() { return render(<LocaleProvider><Probe /></LocaleProvider>); }
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  mocks.getStatus.mockResolvedValue({ profileId: 'default', epoch: 1, revision: 1 });
  mocks.getSettings.mockResolvedValue({ locale: 'en' });
  mocks.onRuntimeState.mockImplementation((callback) => { emit = callback; return vi.fn(); });
  mocks.setAppLocale.mockResolvedValue({});
});

it('loads locale from scoped main settings and ignores the former localStorage authority', async () => {
  localStorage.setItem('usshtc107-locale', 'zh');
  mocks.getSettings.mockResolvedValue({ locale: 'en' });
  mount();
  await waitFor(() => expect(mocks.getSettings).toHaveBeenCalledWith({ profileId: 'default', epoch: 1 }));
  expect(screen.getByText('en')).toBeInTheDocument();
  expect(mocks.setAppLocale).not.toHaveBeenCalled();
});

it('does not save the fallback while loading and does not let a late initial read overwrite an explicit preference', async () => {
  let finishRead;
  let finishWrite;
  mocks.getSettings.mockImplementation(() => new Promise((resolve) => { finishRead = resolve; }));
  mocks.setAppLocale.mockImplementation(() => new Promise((resolve) => { finishWrite = resolve; }));
  mount();
  await waitFor(() => expect(mocks.getSettings).toHaveBeenCalled());
  expect(mocks.setAppLocale).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Chinese' }));
  await act(async () => { finishRead({ locale: 'en' }); });
  expect(screen.getByText('en')).toBeInTheDocument();
  await act(async () => { finishWrite({}); });
  expect(screen.getByText('zh')).toBeInTheDocument();
  expect(document.documentElement.lang).toBe('zh-CN');
  expect(mocks.setAppLocale).toHaveBeenCalledExactlyOnceWith('zh');
});

it('rejects a stale scoped preference read after a newer runtime scope arrives', async () => {
  const finish = new Map();
  mocks.getSettings.mockImplementation((scope) => new Promise((resolve) => { finish.set(scope.profileId, resolve); }));
  mount();
  await waitFor(() => expect(finish.has('default')).toBe(true));
  act(() => emit({ profileId: 'b', epoch: 2, revision: 2 }));
  await waitFor(() => expect(finish.has('b')).toBe(true));
  await act(async () => { finish.get('b')({ locale: 'zh' }); finish.get('default')({ locale: 'en' }); });
  expect(screen.getByText('zh')).toBeInTheDocument();
});

it('keeps the prior locale when saving fails and never persists a failed initial-read fallback', async () => {
  mocks.getSettings.mockRejectedValue({ code: 'SETTINGS_LOCKED' });
  mocks.setAppLocale.mockRejectedValue({ code: 'SETTINGS_LOCKED' });
  mount();
  await waitFor(() => expect(mocks.getSettings).toHaveBeenCalled());
  expect(mocks.setAppLocale).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Chinese' }));
  await waitFor(() => expect(mocks.setAppLocale).toHaveBeenCalledWith('zh'));
  expect(screen.getByText('en')).toBeInTheDocument();
});

it('unsubscribes and ignores preference reads completing after unmount', async () => {
  const unsubscribe = vi.fn();
  mocks.onRuntimeState.mockReturnValue(unsubscribe);
  let finish;
  mocks.getSettings.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = mount();
  await waitFor(() => expect(mocks.getSettings).toHaveBeenCalled());
  view.unmount();
  await act(async () => { finish({ locale: 'zh' }); });
  expect(unsubscribe).toHaveBeenCalledTimes(1);
  expect(mocks.setAppLocale).not.toHaveBeenCalled();
});
