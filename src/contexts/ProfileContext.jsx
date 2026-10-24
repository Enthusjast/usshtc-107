import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { ApiError, getProfiles, createProfile, renameProfile, deleteProfile, activateProfile, saveOnboarding } from '../lib/electron';
import { sameScope, useRuntime } from './RuntimeContext';

const ProfileContext = createContext(null);
const ACTIONS = { create: createProfile, rename: renameProfile, delete: deleteProfile, activate: activateProfile, onboarding: saveOnboarding };

export function ProfileProvider({ children }) {
  const { scope, snapshot, flushDraft, getScope } = useRuntime();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null);
  const active = useRef(false);
  const sequence = useRef(0);
  const inFlight = useRef(null);
  const reload = useCallback(async () => {
    const request = ++sequence.current;
    const origin = getScope();
    try {
      const value = await getProfiles();
      if (active.current && request === sequence.current && sameScope(origin, getScope())) { setData(value); setError(null); }
      return value;
    } catch (failure) {
      if (active.current && request === sequence.current && sameScope(origin, getScope())) setError(failure);
      throw failure;
    }
  }, [getScope]);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; sequence.current += 1; };
  }, []);
  useEffect(() => { if (scope) void reload().catch(() => {}); }, [scope?.profileId, scope?.epoch, reload]);

  const run = useCallback((action, payload = {}) => {
    const origin = getScope();
    const requestKey = JSON.stringify({ action, scope: origin, ...payload });
    if (inFlight.current) {
      return inFlight.current.key === requestKey
        ? inFlight.current.promise
        : Promise.reject(new ApiError('OPERATION_IN_PROGRESS'));
    }
    if (snapshot?.storageErrorCode) return Promise.reject(new ApiError('SETTINGS_LOCKED'));
    if (!origin) return Promise.reject(new ApiError('PROFILE_CHANGED'));
    if (!Object.hasOwn(ACTIONS, action)) return Promise.reject(new ApiError('INVALID_ARGUMENT'));
    const operation = { key: requestKey, action, id: payload.id ?? null };
    const promise = (async () => {
      await flushDraft();
      if (!sameScope(origin, getScope())) throw new ApiError('PROFILE_CHANGED');
      try {
        const result = await ACTIONS[action]({ scope: origin, ...payload });
        if (!result?.cancelled) {
          if (action === 'onboarding' && active.current && sameScope(origin, getScope())) {
            sequence.current += 1;
            setData(result);
            setError(null);
          }
          else await reload().catch(() => {});
        }
        return result;
      } catch (failure) {
        // A root mutation may have committed before history storage failed. Refresh public
        // profiles without treating the failed action as success or consuming its draft.
        await reload().catch(() => {});
        throw failure;
      }
    })();
    operation.promise = promise.finally(() => {
      if (inFlight.current === operation) {
        inFlight.current = null;
        if (active.current) setPending(null);
      }
    });
    inFlight.current = operation;
    setPending({ action, id: operation.id });
    return operation.promise;
  }, [flushDraft, getScope, reload, snapshot?.storageErrorCode]);

  return <ProfileContext.Provider value={{ data, error, pending, reload, run }}>{children}</ProfileContext.Provider>;
}

export function useProfiles() {
  return useContext(ProfileContext);
}
