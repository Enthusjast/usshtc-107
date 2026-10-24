import { createContext, useContext, useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { getStatus, getRuntimeInfo, onRuntimeState, setAppDirty, getStats, onStatsUpdate, ApiError } from '../lib/electron';
import { EMPTY_STATS, ZERO_RATES, diffRates, appendRatePoint } from '../lib/traffic';

const RuntimeContext = createContext(null);
export const sameScope = (a, b) => Boolean(a && b && a.profileId === b.profileId && a.epoch === b.epoch);
export function RuntimeProvider({ children }) {
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const latest = useRef(null);
  const [traffic, setTraffic] = useState({ stats: EMPTY_STATS, rates: ZERO_RATES, ratePoints: [] });
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState(null);
  const latestStats = useRef(null);
  const statsRequest = useRef(0);
  const alive = useRef(false);
  const draft = useRef({ dirty: false, draftRevision: 0 });
  const pendingAck = useRef(Promise.resolve());
  const draftReady = useRef(false);
  const draftBootstrap = useRef(null);
  const pendingSnapshot = useRef(null);
  const accept = useCallback((value) => {
    if (!alive.current || !value || !Number.isSafeInteger(value.revision)) return;
    if (!draftReady.current) {
      if (!pendingSnapshot.current || value.revision > pendingSnapshot.current.revision) pendingSnapshot.current = value;
      return;
    }
    if (latest.current && value.revision <= latest.current.revision) return;
    const changedScope = !sameScope(latest.current, value);
    const changedProfile = latest.current && latest.current.profileId !== value.profileId;
    if (changedProfile) draft.current = { dirty: false, draftRevision: draft.current.draftRevision };
    if (changedScope) {
      latestStats.current = null;
      statsRequest.current += 1;
      setTraffic({ stats: EMPTY_STATS, rates: ZERO_RATES, ratePoints: [] });
      setStatsLoading(true);
      setStatsError(null);
    }
    latest.current = value;
    setSnapshot(value);
    setLoading(false);
    setError(null);
    if (changedScope && (draft.current.dirty || changedProfile)) {
      const ack = setAppDirty({ scope: { profileId: value.profileId, epoch: value.epoch }, ...draft.current });
      pendingAck.current = ack;
      void ack.catch(() => {});
    }
  }, []);
  const prepareDraft = useCallback(() => {
    if (draftReady.current) return Promise.resolve();
    if (draftBootstrap.current) return draftBootstrap.current;
    const pending = (async () => {
      const info = await getRuntimeInfo();
      if (!info?.scope || typeof info.scope.profileId !== 'string' || !Number.isSafeInteger(info.scope.epoch)
          || !Number.isSafeInteger(info.draftRevision) || info.draftRevision < 0) throw new ApiError('API_UNAVAILABLE');
      // Reloads must advance the main-owned clock: an old document's confirmed
      // action must not consume a new document's draft with the same revision.
      const draftRevision = Math.max(info.draftRevision, draft.current.draftRevision) + 1;
      if (!Number.isSafeInteger(draftRevision)) throw new ApiError('API_UNAVAILABLE');
      const next = { ...draft.current, draftRevision };
      const ack = setAppDirty({ scope: info.scope, ...next });
      pendingAck.current = ack;
      await ack;
      draft.current = next;
      draftReady.current = true;
      const buffered = pendingSnapshot.current;
      pendingSnapshot.current = null;
      if (buffered) accept(buffered);
    })().finally(() => { draftBootstrap.current = null; });
    draftBootstrap.current = pending;
    return pending;
  }, [accept]);
  const retry = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { await prepareDraft(); accept(await getStatus()); }
    catch (failure) { if (alive.current && !latest.current) setError(failure); }
    finally { if (alive.current) setLoading(false); }
  }, [accept, prepareDraft]);
  const acceptStats = useCallback((value) => {
    if (!alive.current || !sameScope(value, latest.current) || !Number.isSafeInteger(value.sequence)
      || !Number.isFinite(value.sampledAt) || !Array.isArray(value.sessions)) return;
    if (latestStats.current && value.sequence <= latestStats.current.sequence) return;
    const rates = diffRates(latestStats.current, value);
    latestStats.current = value;
    setTraffic((previous) => ({ stats: value, rates, ratePoints: appendRatePoint(previous.ratePoints, value, rates) }));
    setStatsLoading(false);
    setStatsError(null);
  }, []);
  const retryStats = useCallback(async () => {
    const request = ++statsRequest.current;
    const origin = latest.current;
    if (!origin) return;
    setStatsLoading(true);
    setStatsError(null);
    try {
      const value = await getStats();
      if (request === statsRequest.current && sameScope(origin, latest.current)) {
        if (!sameScope(value, origin) || !Number.isSafeInteger(value.sequence) || !Number.isFinite(value.sampledAt) || !Array.isArray(value.sessions)) throw new ApiError('API_UNAVAILABLE');
        acceptStats(value);
      }
    } catch (failure) {
      if (alive.current && request === statsRequest.current && sameScope(origin, latest.current) && !latestStats.current) setStatsError(failure);
    } finally {
      if (alive.current && request === statsRequest.current && sameScope(origin, latest.current)) setStatsLoading(false);
    }
  }, [acceptStats]);
  useEffect(() => {
    alive.current = true;
    let unsubscribe;
    let unsubscribeStats;
    try {
      unsubscribe = onRuntimeState(accept);
      unsubscribeStats = onStatsUpdate(acceptStats);
      void retry();
    } catch (failure) { setError(failure); setLoading(false); }
    return () => { alive.current = false; statsRequest.current += 1; unsubscribe?.(); unsubscribeStats?.(); };
  }, [accept, acceptStats, retry]);
  const scope = useMemo(() => snapshot ? { profileId: snapshot.profileId, epoch: snapshot.epoch } : null, [snapshot?.profileId, snapshot?.epoch]);
  useEffect(() => { if (scope) void retryStats(); }, [scope, retryStats]);
  const reportDraft = useCallback((value) => {
    draft.current = value;
    const current = latest.current;
    if (!current) return Promise.resolve();
    const ack = setAppDirty({ scope: { profileId: current.profileId, epoch: current.epoch }, ...value });
    pendingAck.current = ack;
    // Keep immediate background acknowledgements handled; callers still receive rejection.
    void ack.catch(() => {});
    return ack;
  }, []);
  const flushDraft = useCallback(async () => {
    await prepareDraft();
    await pendingAck.current;
    await reportDraft(draft.current);
  }, [prepareDraft, reportDraft]);
  const getDraftRevision = useCallback(() => draft.current.draftRevision, []);
  const getScope = useCallback(() => latest.current ? { profileId: latest.current.profileId, epoch: latest.current.epoch } : null, []);
  const getSnapshot = useCallback(() => latest.current, []);
  const runAction = useCallback(async (action, origin = getScope()) => {
    await flushDraft();
    if (!sameScope(origin, getScope())) throw new ApiError('PROFILE_CHANGED');
    return action(origin);
  }, [flushDraft, getScope]);
  return <RuntimeContext.Provider value={{ snapshot, scope, loading, error, retry, reportDraft, flushDraft, getDraftRevision, getScope, getSnapshot, runAction, ...traffic, statsLoading, statsError, retryStats }}>{children}</RuntimeContext.Provider>;
}
export function useRuntime() {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error('RuntimeProvider is required');
  return value;
}
