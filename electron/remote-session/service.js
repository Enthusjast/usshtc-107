'use strict';

const { randomUUID } = require('node:crypto');
const { createPortalApiClient } = require('../portal-api/client');
const { createDesktopApi } = require('../portal-api/desktop-api');
const { createAppApi } = require('../portal-api/app-api');
const { buildVncUrl, buildAppUrl, validatePortalUrl } = require('./links');
const v = require('./validation');

const REMOTE_SESSION_TIMEOUT_MS = 15000;
const ERROR_CODES = new Set(['AUTH_REQUIRED', 'PROFILE_CHANGED', 'INVALID_ARGUMENT', 'OPERATION_IN_PROGRESS',
  'REMOTE_SESSION_EXPIRED', 'REMOTE_SESSION_NOT_READY', 'REMOTE_SESSION_UNSUPPORTED', 'REMOTE_SESSION_INVALID',
  'REMOTE_SESSION_OPEN_FAILED', 'REMOTE_SESSION_COPY_FAILED', 'PORTAL_NETWORK', 'PORTAL_TIMEOUT', 'PORTAL_PERMISSION',
  'PORTAL_NOT_FOUND', 'PORTAL_UNIMPLEMENTED', 'PORTAL_QUOTA', 'PORTAL_UNKNOWN', 'PORTAL_CANCELLED']);
function failure(code) { return Object.assign(new Error(code), { code }); }
function safeCode(error) {
  if (error?.kind === 'AUTH' || error?.code === 'PORTAL_AUTH') return 'AUTH_REQUIRED';
  if (error?.statusCode === 404) return 'REMOTE_SESSION_EXPIRED';
  if (error?.statusCode === 409) return 'REMOTE_SESSION_NOT_READY';
  return ERROR_CODES.has(error?.code) ? error.code : 'REMOTE_SESSION_INVALID';
}
const sameScope = (a, b) => Boolean(a && b && a.profileId === b.profileId && a.epoch === b.epoch);
function createRemoteSessionService(deps) {
  const clock = deps.clock || globalThis;
  const createClient = deps.createClient || createPortalApiClient;
  const active = new Map();
  let targets = new Map();
  let observedKey = null;
  let targetKey = null;
  let listGeneration = 0;
  let disposed = false;

  function context(scope) {
    if (disposed) throw failure('PORTAL_CANCELLED');
    const value = deps.getContext();
    if (!sameScope(value?.scope, scope)) throw failure('PROFILE_CHANGED');
    if (!value.cookie) throw failure('AUTH_REQUIRED');
    v.segment(value.cluster);
    if (!Number.isSafeInteger(value.authGeneration) || value.authGeneration < 0) throw failure('REMOTE_SESSION_INVALID');
    return { ...value, key: JSON.stringify([value.scope.profileId, value.scope.epoch, value.authGeneration,
      value.cookie, value.cluster, value.tlsCa || null]) };
  }
  function assertCurrent(round) {
    if (round.controller.signal.aborted) throw failure('PORTAL_CANCELLED');
    if (context(round.context.scope).key !== round.context.key) throw failure('PROFILE_CHANGED');
  }
  function validate(payload, keys) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(key => !keys.includes(key))
        || !payload.scope || typeof payload.scope.profileId !== 'string' || payload.scope.profileId.length > 128
        || !payload.scope.profileId || !Number.isSafeInteger(payload.scope.epoch) || payload.scope.epoch < 0
        || Object.keys(payload.scope).some(key => !['profileId', 'epoch'].includes(key))
        || typeof payload.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.requestId)) throw failure('INVALID_ARGUMENT');
  }
  async function run(payload, action, execute) {
    if (active.has(payload.requestId) || active.size >= 4 || action && [...active.values()].some(round => round.action)) throw failure('OPERATION_IN_PROGRESS');
    const value = context(payload.scope);
    const round = { context: value, controller: new AbortController(), action };
    active.set(payload.requestId, round);
    let client, timer, abort;
    try {
      const cancelled = new Promise((_, reject) => {
        abort = () => reject(failure(round.timeout ? 'PORTAL_TIMEOUT' : 'PORTAL_CANCELLED'));
        round.controller.signal.addEventListener('abort', abort, { once: true });
      });
      timer = clock.setTimeout(() => { round.timeout = true; round.controller.abort(); }, REMOTE_SESSION_TIMEOUT_MS);
      timer?.unref?.();
      client = createClient({ cookie: value.cookie, tlsCa: value.tlsCa });
      const options = { scope: value.scope, signal: round.controller.signal, assertCurrent: () => assertCurrent(round) };
      const result = await Promise.race([Promise.resolve().then(() => {
        assertCurrent(round);
        return execute({ round, client, options });
      }), cancelled]);
      assertCurrent(round);
      return result;
    } catch (error) { throw failure(safeCode(error)); }
    finally {
      clock.clearTimeout(timer);
      round.controller.signal.removeEventListener('abort', abort);
      round.controller.abort();
      client?.dispose();
      active.delete(payload.requestId);
    }
  }
  async function list(payload) {
    validate(payload, ['scope', 'requestId']);
    return run(payload, false, async ({ round, client, options }) => {
      const generation = ++listGeneration;
      const desktopApi = createDesktopApi({ client });
      const appApi = createAppApi({ client });
      const results = await Promise.allSettled([desktopApi.listDesktops(round.context.cluster, options),
        appApi.getAppSessions(round.context.cluster, options), appApi.listAvailableApps(round.context.cluster, options)]);
      assertCurrent(round);
      if (generation !== listGeneration) throw failure('PORTAL_CANCELLED');
      const sectionErrors = {};
      const values = results.map((result, index) => {
        if (result.status === 'fulfilled') return result.value;
        const code = safeCode(result.reason);
        if (code === 'AUTH_REQUIRED') throw failure(code);
        sectionErrors[['desktops', 'apps', 'catalog'][index]] = code;
        return [];
      });
      const next = new Map();
      const desktops = values[0].map(desktop => {
        const targetId = randomUUID();
        if (desktop.kind === 'desktop') next.set(targetId, desktop);
        return { targetId, name: desktop.name, loginNode: desktop.loginNode, wm: desktop.wm || '',
          createTime: desktop.createTime || '', supported: desktop.kind === 'desktop' };
      });
      const apps = values[1].map(app => {
        const targetId = randomUUID();
        next.set(targetId, { kind: 'app', ...app });
        return { targetId, name: app.name || app.appId, jobId: app.jobId, state: app.state,
          runningTime: app.runningTime, submitTime: app.submitTime };
      });
      targets = next;
      targetKey = round.context.key;
      return { ...round.context.scope, desktops, apps, catalog: values[2], sectionErrors };
    });
  }
  async function act(payload) {
    validate(payload, ['scope', 'requestId', 'targetId', 'action']);
    if (!['open', 'copy'].includes(payload.action) || typeof payload.targetId !== 'string'
        || !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.targetId)) throw failure('INVALID_ARGUMENT');
    return run(payload, true, async ({ round, client, options }) => {
      if (targetKey !== round.context.key || !targets.has(payload.targetId)) throw failure('REMOTE_SESSION_EXPIRED');
      const target = targets.get(payload.targetId);
      if (target.kind === 'app' && target.state !== 'RUNNING') throw failure('REMOTE_SESSION_NOT_READY');
      const connection = target.kind === 'desktop'
        ? await createDesktopApi({ client }).launchDesktop({ cluster: round.context.cluster, ...target }, options)
        : await createAppApi({ client }).connectToApp({ cluster: round.context.cluster, ...target }, options);
      assertCurrent(round);
      if (connection.type === 'unsupported') throw failure('REMOTE_SESSION_UNSUPPORTED');
      const url = validatePortalUrl(target.kind === 'desktop' ? buildVncUrl(round.context.cluster, connection)
        : buildAppUrl(round.context.cluster, connection));
      assertCurrent(round);
      // Secrets stay in this stack frame. Only the selected main-owned adapter sees them.
      try {
        if (payload.action === 'open') await deps.openExternal(url);
        else await deps.copyToClipboard(url);
      } catch (_) { throw failure(payload.action === 'open' ? 'REMOTE_SESSION_OPEN_FAILED' : 'REMOTE_SESSION_COPY_FAILED'); }
      assertCurrent(round);
      return payload.action === 'open' ? { ...round.context.scope, opened: true }
        : { ...round.context.scope, copied: true, warning: 'SESSION_LINK_CREDENTIALS' };
    });
  }
  function cancel(payload) {
    validate(payload, ['scope', 'requestId']);
    context(payload.scope);
    const round = active.get(payload.requestId);
    if (round && sameScope(round.context.scope, payload.scope)) round.controller.abort();
    return { ...payload.scope, cancelled: Boolean(round) };
  }
  function invalidate() {
    targets.clear(); targetKey = null; listGeneration += 1;
    for (const round of active.values()) round.controller.abort();
  }
  return {
    list, act, cancel,
    update() {
      let key;
      try { const value = deps.getContext(); key = context(value.scope).key; } catch (_) { key = null; }
      if (key !== observedKey) { observedKey = key; invalidate(); }
    },
    dispose() { disposed = true; invalidate(); },
  };
}

module.exports = { createRemoteSessionService, REMOTE_SESSION_TIMEOUT_MS, ERROR_CODES };
