import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { ProfileProvider, useProfiles } from '../src/contexts/ProfileContext';

const mocks = vi.hoisted(() => ({ getProfiles: vi.fn(), createProfile: vi.fn(), renameProfile: vi.fn(), deleteProfile: vi.fn(), activateProfile: vi.fn(), getSsoCredentials: vi.fn(), saveOnboarding: vi.fn() }));
const runtime = vi.hoisted(() => ({ scope: { profileId: 'default', epoch: 1 }, snapshot: {}, flushDraft: vi.fn(), getScope: vi.fn() }));
vi.mock('../src/lib/electron', async (importOriginal) => ({ ...await importOriginal(), ...mocks }));
vi.mock('../src/contexts/RuntimeContext', () => ({ useRuntime: () => runtime, sameScope: (a, b) => Boolean(a && b && a.profileId === b.profileId && a.epoch === b.epoch) }));

let context;
const dto = { activeProfileId: 'default', profiles: [{ id: 'default', name: 'Default', settings: { port: 3000 }, onboarding: { status: 'dismissed', step: 'login' } }, { id: 'b', name: 'Work', settings: { port: 4000 }, onboarding: { status: 'new', step: 'login' } }] };
function Probe() {
  context = useProfiles();
  return <output>{context.pending ? `${context.pending.action}:${context.pending.id}` : context.data ? context.data.profiles.map((profile) => profile.name).join(',') : 'loading'}</output>;
}
function mount() { return render(<ProfileProvider><Probe /></ProfileProvider>); }
beforeEach(() => {
  vi.resetAllMocks();
  runtime.scope = { profileId: 'default', epoch: 1 };
  runtime.snapshot = {};
  runtime.getScope.mockImplementation(() => runtime.scope);
  runtime.flushDraft.mockResolvedValue();
  mocks.getProfiles.mockResolvedValue(dto);
});

it('loads only the public profile DTO without querying account credentials', async () => {
  mount();
  await screen.findByText('Default,Work');
  expect(context.data).toEqual(dto);
  expect(mocks.getSsoCredentials).not.toHaveBeenCalled();
  expect(Object.keys(context.data.profiles[0]).sort()).toEqual(['id', 'name', 'onboarding', 'settings']);
});

it('reuses identical target requests but rejects a different target while switching', async () => {
  let finish;
  mocks.activateProfile.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  mount(); await screen.findByText('Default,Work');
  let first;
  act(() => {
    first = context.run('activate', { id: 'b' });
    expect(context.run('activate', { id: 'b' })).toBe(first);
  });
  await expect(context.run('activate', { id: 'different' })).rejects.toMatchObject({ code: 'OPERATION_IN_PROGRESS' });
  await waitFor(() => expect(mocks.activateProfile).toHaveBeenCalledWith({ scope: runtime.scope, id: 'b' }));
  expect(runtime.flushDraft.mock.invocationCallOrder[0]).toBeLessThan(mocks.activateProfile.mock.invocationCallOrder[0]);
  await act(async () => { finish({ cancelled: true }); await first; });
  expect(mocks.activateProfile).toHaveBeenCalledTimes(1);
  expect(context.pending).toBeNull();
  expect(mocks.getProfiles).toHaveBeenCalledTimes(1);
});

it('distinguishes different rename payloads for the same profile', async () => {
  let finish;
  mocks.renameProfile.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  mount(); await screen.findByText('Default,Work');
  let first;
  act(() => { first = context.run('rename', { id: 'default', name: 'First' }); });
  await expect(context.run('rename', { id: 'default', name: 'Second' })).rejects.toMatchObject({ code: 'OPERATION_IN_PROGRESS' });
  await waitFor(() => expect(mocks.renameProfile).toHaveBeenCalled());
  await act(async () => { finish({}); await first; });
  expect(mocks.getProfiles).toHaveBeenCalledTimes(2);
});

it('rejects a request whose scope changed while the draft acknowledgement was pending', async () => {
  let acknowledge;
  runtime.flushDraft.mockImplementation(() => new Promise((resolve) => { acknowledge = resolve; }));
  mount(); await screen.findByText('Default,Work');
  let request;
  act(() => { request = context.run('activate', { id: 'b' }); });
  runtime.scope = { profileId: 'b', epoch: 2 };
  await act(async () => {
    acknowledge();
    await expect(request).rejects.toMatchObject({ code: 'PROFILE_CHANGED' });
  });
  expect(mocks.activateProfile).not.toHaveBeenCalled();
});

it('blocks every profile write while root storage is locked', async () => {
  runtime.snapshot = { storageErrorCode: 'SETTINGS_DURABILITY_UNCERTAIN' };
  mount(); await screen.findByText('Default,Work');
  for (const action of ['create', 'rename', 'delete', 'activate', 'onboarding']) {
    await expect(context.run(action, { id: 'b', name: 'Work' })).rejects.toMatchObject({ code: 'SETTINGS_LOCKED' });
  }
  expect(runtime.flushDraft).not.toHaveBeenCalled();
  expect(mocks.activateProfile).not.toHaveBeenCalled();
});

it('keeps a committed action successful when refreshing the profile list fails', async () => {
  mocks.createProfile.mockResolvedValue({ id: 'new-profile' });
  mount(); await screen.findByText('Default,Work');
  mocks.getProfiles.mockRejectedValue({ code: 'INTERNAL_ERROR' });
  await act(async () => { await expect(context.run('create', { name: 'New' })).resolves.toEqual({ id: 'new-profile' }); });
  expect(context.error).toMatchObject({ code: 'INTERNAL_ERROR' });
});

it('rejects a late profile list from before the current scope change', async () => {
  let finishOld;
  mocks.getProfiles.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
  const view = mount();
  await waitFor(() => expect(mocks.getProfiles).toHaveBeenCalledTimes(1));
  runtime.scope = {profileId:'b',epoch:2};
  mocks.getProfiles.mockResolvedValue({activeProfileId:'b',profiles:[{id:'b',name:'Current profile',settings:{},onboarding:{}}]});
  view.rerender(<ProfileProvider><Probe /></ProfileProvider>);
  await screen.findByText('Current profile');
  await act(async () => { finishOld(dto); });
  expect(screen.getByText('Current profile')).toBeInTheDocument();
  expect(screen.queryByText('Default,Work')).not.toBeInTheDocument();
});

it('refreshes profiles after a committed deletion reports history storage failure without consuming a draft',async()=>{
 mount();await screen.findByText('Default,Work');
 const failure={code:'HISTORY_STORAGE_FAILED'};
 mocks.deleteProfile.mockRejectedValue(failure);
 mocks.getProfiles.mockResolvedValue({...dto,profiles:[dto.profiles[0]]});
 let caught;
 await act(async()=>{try{await context.run('delete',{id:'b'});}catch(error){caught=error;}});
 expect(caught).toBe(failure);expect(screen.getByText('Default')).toBeInTheDocument();
 expect(context.pending).toBeNull();expect(mocks.getProfiles).toHaveBeenCalledTimes(2);
 expect(runtime.flushDraft).toHaveBeenCalledTimes(1);
});

it('saves scoped onboarding and adopts its public profiles DTO without a second getter', async () => {
  mount(); await screen.findByText('Default,Work');
  const updated = { ...dto, profiles: dto.profiles.map((profile) => profile.id === 'default' ? { ...profile, onboarding: { status: 'dismissed', step: 'config' } } : profile) };
  mocks.saveOnboarding.mockResolvedValue(updated);
  await act(async () => { await expect(context.run('onboarding', { status: 'dismissed', step: 'config' })).resolves.toEqual(updated); });
  expect(mocks.saveOnboarding).toHaveBeenCalledExactlyOnceWith({ scope: runtime.scope, status: 'dismissed', step: 'config' });
  expect(context.data).toEqual(updated);
  expect(mocks.getProfiles).toHaveBeenCalledOnce();
  expect(runtime.flushDraft.mock.invocationCallOrder[0]).toBeLessThan(mocks.saveOnboarding.mock.invocationCallOrder[0]);
});

it('does not let a getter started before saving overwrite the saved onboarding DTO', async () => {
  mount(); await screen.findByText('Default,Work');
  let finish;
  mocks.getProfiles.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  let reload;
  act(() => { reload = context.reload(); });
  const updated = { ...dto, profiles: dto.profiles.map((profile) => profile.id === 'default' ? { ...profile, onboarding: { status: 'completed', step: 'verify' } } : profile) };
  mocks.saveOnboarding.mockResolvedValue(updated);
  await act(async () => { await context.run('onboarding', { status: 'completed', step: 'verify', runId: 'latest-run' }); });
  await act(async () => { finish(dto); await reload; });
  expect(context.data.profiles[0].onboarding).toEqual({ status: 'completed', step: 'verify' });
});
