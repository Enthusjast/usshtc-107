import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, getUpdateState, onUpdateState, checkForUpdates, downloadUpdate, installUpdate, openUpdateRelease } from '../lib/electron';
import { useRuntime } from './RuntimeContext';

const UpdateContext = createContext(null);
const PHASES = new Set(['idle', 'checking', 'current', 'available', 'downloading', 'downloaded', 'staging', 'installing', 'error']);
const MODES = new Set(['in-app', 'manual', 'unsupported']);
export const UPDATE_BUSY_PHASES = new Set(['checking', 'downloading', 'staging', 'installing']);

function validState(value) {
  return value && PHASES.has(value.phase) && MODES.has(value.installMode)
    && typeof value.currentVersion === 'string'
    && (value.availableVersion === null || typeof value.availableVersion === 'string');
}

export function UpdateProvider({ children }) {
  const { flushDraft } = useRuntime();
  const [state, setState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [pending, setPending] = useState(null);
  const alive = useRef(false);
  const eventVersion = useRef(0);
  const requestVersion = useRef(0);
  const activeAction = useRef(null);
  const subscription = useRef(null);

  // UpdateState is global and intentionally has no profile/epoch/revision. Fence
  // each snapshot read against events received after it began instead.
  const accept = useCallback((value) => {
    if (!alive.current) return;
    if (!validState(value)) throw new ApiError('API_UNAVAILABLE');
    setState(value);
    setError(null);
    setActionError(null);
    setLoading(false);
  }, []);
  const retry = useCallback(async () => {
    const request = ++requestVersion.current;
    const events = eventVersion.current;
    setLoading(true);
    setError(null);
    try {
      if (!subscription.current) {
        subscription.current = onUpdateState((value) => {
          if (!alive.current) return;
          eventVersion.current += 1;
          try { accept(value); }
          catch (failure) { setError(failure); setLoading(false); }
        });
      }
      const value = await getUpdateState();
      if (alive.current && request === requestVersion.current && events === eventVersion.current) accept(value);
    } catch (failure) {
      if (alive.current && request === requestVersion.current && events === eventVersion.current) setError(failure);
    } finally {
      if (alive.current && request === requestVersion.current) setLoading(false);
    }
  }, [accept]);

  useEffect(() => {
    alive.current = true;
    void retry();
    return () => {
      alive.current = false;
      requestVersion.current += 1;
      subscription.current?.();
      subscription.current = null;
    };
  }, [retry]);

  const run = useCallback(async (name, action) => {
    if (activeAction.current) throw new ApiError('OPERATION_IN_PROGRESS');
    activeAction.current = name;
    setPending(name);
    setActionError(null);
    try { return await action(); }
    catch (failure) { if (alive.current) setActionError(failure); throw failure; }
    finally {
      activeAction.current = null;
      if (alive.current) setPending(null);
    }
  }, []);
  const check = useCallback(() => run('check', checkForUpdates), [run]);
  const download = useCallback((version) => run('download', () => downloadUpdate({ version })), [run]);
  const install = useCallback((version) => run('install', async () => {
    await flushDraft();
    return installUpdate({ version });
  }), [run, flushDraft]);
  const openRelease = useCallback(() => run('release', openUpdateRelease), [run]);
  const value = useMemo(() => ({ state, loading, error, actionError, pending, retry, check, download, install, openRelease }), [state, loading, error, actionError, pending, retry, check, download, install, openRelease]);
  return <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>;
}

export function useUpdates() {
  const value = useContext(UpdateContext);
  if (!value) throw new Error('UpdateProvider is required');
  return value;
}
