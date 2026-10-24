import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createAppController } from '../electron/app-controller';
import { createDefaultRoot } from '../electron/settings-store';
import { RuntimeProvider, useRuntime } from '../src/contexts/RuntimeContext';

const api = vi.hoisted(() => ({ getRuntimeInfo: vi.fn(), getStatus: vi.fn(), setAppDirty: vi.fn(),
  onRuntimeState: vi.fn(), onStatsUpdate: vi.fn(), getStats: vi.fn() }));
vi.mock('../src/lib/electron', async original => ({ ...await original(), ...api }));
let runtime;
function Consumer() {
  runtime = useRuntime();
  return <output>{runtime.error ? 'failed' : runtime.snapshot ? 'ready' : 'loading'}</output>;
}
const mount = () => render(<RuntimeProvider><Consumer /></RuntimeProvider>);

it('a recreated renderer starts above the actual main draft revision and cannot approve an old document confirmation', async () => {
  let callbacks, answer;
  let root = createDefaultRoot({ autoConnect: false });
  const stop = vi.fn(async () => {});
  const backend = createAppController({
    settingsStore: { getRoot: () => root, isLocked: () => false, getStorageErrorCode: () => null,
      save: candidate => { root = candidate; return { state: 'committed', durable: true }; } },
    proxy: { setScope() {}, stop, cancelPendingStart() {}, dispose: async () => {} },
    login: { setScope() {}, setProfile() {}, getCookie: () => '', dispose() {} },
    createCredentialStore: () => ({ getSsoStatus: () => ({ username: '', hasPassword: false }) }),
    bindCallbacks: value => { callbacks = value; },
    confirmInterrupt: () => new Promise(resolve => { answer = resolve; }),
  });
  const scope = () => { const { profileId, epoch } = backend.getSnapshot(); return { profileId, epoch }; };
  await backend.run('set-dirty', { scope: scope(), dirty: true, draftRevision: 31 });
  callbacks.onProxyState({ ...scope(), proxyStatus: 'started', runningConfig: backend.getSnapshot().desiredConfig, connectionCount: 1 });
  api.getRuntimeInfo.mockImplementation(async () => ({ scope: scope(), draftRevision: backend.getDraftRevision() }));
  api.getStatus.mockImplementation(async () => backend.getSnapshot());
  api.setAppDirty.mockImplementation(payload => backend.run('set-dirty', payload));
  api.onRuntimeState.mockReturnValue(() => {});
  api.onStatsUpdate.mockReturnValue(() => {});
  api.getStats.mockImplementation(async () => ({ ...scope(), sequence: 1, sampledAt: 0, totalBytesSent: 0, totalBytesReceived: 0, sessions: [] }));
  let view;
  try {
    view = mount(); await screen.findByText('ready');
    await act(async () => { await runtime.reportDraft({ dirty: true, draftRevision: runtime.getDraftRevision() + 1 }); });
    const previous = backend.getDraftRevision();
    const stopping = backend.run('stop', { scope: scope() });
    const rejected = expect(stopping).rejects.toMatchObject({ code: 'DRAFT_CHANGED' });
    await waitFor(() => expect(answer).toBeTypeOf('function'));
    view.unmount();
    view = mount(); await screen.findByText('ready');
    expect(backend.getDraftRevision()).toBeGreaterThan(previous);
    await act(async () => { answer(true); await rejected; });
    expect(stop).not.toHaveBeenCalled();
    expect(backend.getSnapshot()).toMatchObject({ proxyStatus: 'started', connectionCount: 1 });
    await act(async () => {
      await runtime.reportDraft({ dirty: true, draftRevision: runtime.getDraftRevision() + 1 });
      await runtime.flushDraft();
    });
    expect(screen.getByText('ready')).toBeInTheDocument();
  } finally { view?.unmount(); await backend.dispose(); }
});
