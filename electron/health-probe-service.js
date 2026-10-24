'use strict';

const { probeRemoteCommand, REMOTE_COMMAND_TIMEOUT_MS } = require('./remote-command-probe');

const HEALTH_PROBE_INTERVAL_MS = 60000;
const CONFIG_FIELDS = ['host', 'port', 'cluster', 'loginNode', 'cols', 'rows', 'useRoot', 'path', 'startupCommand', 'wssUrl'];
const KEY_CODES = new Set(['SSH_KEY_MISSING', 'SSH_KEY_INVALID', 'SSH_KEY_FINGERPRINT_MISMATCH']);

// This service only observes an existing listener. It never starts one, logs in,
// changes credentials, or repeats a user's command.
function createHealthProbeService(deps) {
  const clock = deps.clock || globalThis;
  let timer = null;
  let active = null;
  let observedKey = null;
  let suspended = false;
  let disposed = false;
  let paused = false;

  function context() {
    const snapshot = deps.getSnapshot();
    const scope = { profileId: snapshot.profileId, epoch: snapshot.epoch };
    const config = { ...deps.getConfig(scope) };
    const runningConfig = { ...(snapshot.runningConfig || config) };
    const cookie = deps.getCookie(scope);
    const enabled = deps.getPreferences().healthProbeEnabled === true;
    const remoteNotReady = snapshot.errorCode === 'REMOTE_READY_TIMEOUT';
    const eligible = enabled && snapshot.desiredRunning === true && snapshot.proxyStatus === 'started'
      && !snapshot.operation && !snapshot.storageErrorCode && !remoteNotReady && Boolean(cookie);
    const authorityKey = JSON.stringify([scope.profileId, scope.epoch, cookie,
      ...CONFIG_FIELDS.map((field) => config[field]), ...CONFIG_FIELDS.map((field) => runningConfig[field])]);
    const key = JSON.stringify([authorityKey, enabled, snapshot.desiredRunning,
      snapshot.proxyStatus, snapshot.operation, snapshot.storageErrorCode, remoteNotReady]);
    return { scope, snapshot, runningConfig, key, authorityKey, eligible, remoteNotReady };
  }

  function current(round) {
    if (disposed || suspended || paused || active !== round || round.controller.signal.aborted) return false;
    try { const value = context(); return value.eligible && value.key === round.context.key; } catch (_) { return false; }
  }

  function publish(value, remoteStatus, errorCode = null) {
    if (!disposed) deps.onRemoteState?.({ ...value.scope, remoteStatus, errorCode });
  }

  function clearTimer() {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  }

  function cancel(reason = 'CANCELLED', restore = true) {
    clearTimer();
    const round = active;
    if (!round) return;
    active = null;
    clock.clearTimeout(round.timer);
    round.controller.abort(reason);
    if (!restore || disposed) return;
    let value;
    try { value = context(); } catch (_) { return; }
    if (!value.remoteNotReady && value.authorityKey === round.context.authorityKey
        && value.snapshot.remoteStatus === 'checking') {
      publish(value, round.previousStatus, round.previousError);
    }
  }

  function schedule() {
    if (timer !== null || active || disposed || suspended || paused) return;
    let value;
    try { value = context(); } catch (_) { return; }
    if (!value.eligible) return;
    timer = clock.setTimeout(() => {
      timer = null;
      let latest;
      try { latest = context(); } catch (_) { return; }
      if (!latest.eligible || latest.key !== value.key) { update(); return; }
      begin(latest);
    }, HEALTH_PROBE_INTERVAL_MS);
    timer?.unref?.();
  }

  function finish(round, errorCode = null) {
    const valid = current(round);
    if (active !== round) return;
    active = null;
    clock.clearTimeout(round.timer);
    round.controller.abort(errorCode || 'COMPLETE');
    if (valid) publish(round.context, errorCode ? 'error' : 'reachable', errorCode);
    update();
  }

  async function execute(round) {
    const keys = await deps.getKeys(round.context.scope);
    if (!current(round)) return;
    for (const role of ['client', 'host']) {
      if (keys?.[role]?.state !== 'ready') {
        const code = keys?.[role]?.errorCode;
        finish(round, KEY_CODES.has(code) ? code : keys?.[role]?.state === 'missing' ? 'SSH_KEY_MISSING' : 'SSH_KEY_INVALID');
        return;
      }
    }
    const identity = await deps.getClientIdentity(round.context.scope);
    if (!current(round)) return;
    await probeRemoteCommand({ config: round.context.runningConfig, identity, hostFingerprint: keys.host.fingerprint,
      signal: round.controller.signal, command: 'true', createSshClient: deps.adapters?.createSshClient,
      setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock),
      timeoutMs: REMOTE_COMMAND_TIMEOUT_MS });
    finish(round);
  }

  function begin(value) {
    if (active || disposed || suspended || paused) return;
    const round = { context: value, controller: new AbortController(), timer: null,
      previousStatus: value.snapshot.remoteStatus || 'unknown', previousError: value.snapshot.errorCode || null };
    active = round;
    // Bounds the entire observation, including asynchronous key/identity providers.
    round.timer = clock.setTimeout(() => finish(round, 'TIMEOUT'), REMOTE_COMMAND_TIMEOUT_MS);
    round.timer?.unref?.();
    publish(value, 'checking');
    if (!current(round)) return;
    execute(round).catch((error) => {
      if (!current(round)) return;
      finish(round, error?.code === 'TIMEOUT' ? 'TIMEOUT' : KEY_CODES.has(error?.code) ? error.code : 'REMOTE_COMMAND_FAILED');
    });
  }

  function update() {
    if (disposed) return;
    let value;
    try { value = context(); } catch (_) { cancel('CONTEXT_CHANGED', false); return; }
    const changed = observedKey !== value.key;
    observedKey = value.key;
    if (changed) { paused = false; cancel('CONTEXT_CHANGED'); }
    if (!value.eligible || suspended || paused) { cancel('PROBE_DISABLED'); return; }
    schedule();
  }

  return {
    update,
    cancel(reason) { paused = true; cancel(reason); },
    suspend() { suspended = true; cancel('SUSPENDED'); },
    resume() { if (disposed) return; suspended = false; paused = false; update(); },
    dispose() { disposed = true; cancel('SHUTTING_DOWN', false); },
  };
}

module.exports = { createHealthProbeService, HEALTH_PROBE_INTERVAL_MS };
