'use strict';

const { createPortalPreflight, operationalCode } = require('./portal-preflight');

const MIN_TOKEN_VALIDATION_INTERVAL_MS = 5 * 60 * 1000;

function createTokenValidationService(deps) {
  const clock = deps.clock || globalThis;
  const portalPreflight = deps.portalPreflight || createPortalPreflight();
  const intervalMs = Math.max(MIN_TOKEN_VALIDATION_INTERVAL_MS,
    Number.isFinite(deps.intervalMs) ? deps.intervalMs : MIN_TOKEN_VALIDATION_INTERVAL_MS);
  let timer = null;
  let active = null;
  let observed = null;
  let inhibited = null;
  let suspended = false;
  let disposed = false;

  function context() {
    const snapshot = deps.getSnapshot();
    const scope = { profileId: snapshot.profileId, epoch: snapshot.epoch };
    const cookie = deps.getCookie(scope);
    const authGeneration = deps.getAuthGeneration?.(scope) ?? null;
    const credentialKey = JSON.stringify([scope.profileId, authGeneration, cookie]);
    const enabled = deps.getPreferences(scope).validateTokenPeriodically === true;
    const eligible = enabled && Boolean(cookie) && snapshot.cookieValid !== false
      && !snapshot.storageErrorCode && !snapshot.operation;
    return { scope, cookie, authGeneration, credentialKey, eligible,
      key: JSON.stringify([scope.epoch, credentialKey, eligible]) };
  }

  function stopTimer() {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  }
  function cancel() {
    stopTimer();
    const previous = active;
    active = null;
    previous?.controller.abort();
  }
  function current(round) {
    if (disposed || suspended || active !== round || round.controller.signal.aborted) return false;
    try { return context().key === round.context.key; } catch (_) { return false; }
  }
  function schedule(value) {
    if (disposed || suspended || timer !== null || active || !value.eligible
        || inhibited === value.credentialKey) return;
    timer = clock.setTimeout(() => {
      timer = null;
      let latest;
      try { latest = context(); } catch (_) { return; }
      if (latest.key !== value.key) { update(); return; }
      const round = { context: latest, controller: new AbortController() };
      active = round;
      void validate(round);
    }, intervalMs);
    timer?.unref?.();
  }
  async function validate(round) {
    try {
      const result = await portalPreflight.validate({ ...round.context,
        signal: round.controller.signal,
        assertCurrent: () => {
          if (!current(round)) throw Object.assign(new Error('OPERATION_CANCELLED'), { code: 'OPERATION_CANCELLED' });
        } });
      if (!current(round)) return;
      if (result.status === 'invalid') inhibited = round.context.credentialKey;
      try {
        deps.onResult?.({ ...round.context.scope, authGeneration: round.context.authGeneration,
          status: result.status === 'valid' ? 'valid' : result.status === 'invalid' ? 'invalid' : 'network_error',
          errorCode: result.status === 'invalid' ? 'AUTH_REQUIRED'
            : result.status === 'valid' ? null : operationalCode(result.errorCode) });
      } catch (_) { /* Observers cannot change the validation outcome or retain its resources. */ }
    } catch (error) {
      if (current(round)) {
        try { deps.onResult?.({ ...round.context.scope, authGeneration: round.context.authGeneration,
          status: 'network_error', errorCode: operationalCode(error?.code) }); } catch (_) {}
      }
    } finally {
      if (active === round) {
        active = null;
        update();
      }
    }
  }
  function update() {
    if (disposed || suspended) return;
    let value;
    try { value = context(); } catch (_) { cancel(); observed = null; return; }
    if (observed !== value.key || !value.eligible) cancel();
    observed = value.key;
    if (inhibited !== value.credentialKey) inhibited = null;
    schedule(value);
  }
  return {
    update,
    cancel,
    suspend() { suspended = true; cancel(); },
    resume() { if (disposed) return; suspended = false; update(); },
    dispose() { disposed = true; cancel(); },
  };
}

module.exports = { createTokenValidationService, MIN_TOKEN_VALIDATION_INTERVAL_MS };
