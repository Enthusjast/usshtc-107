'use strict';

const { createPortalApiClient } = require('./portal-api/client');
const { createRemoteSessionService } = require('./remote-session/service');
const { createFileTransferController } = require('./file-transfer/controller');
const { createTokenValidationService } = require('./token-validation-service');

const failure = code => Object.assign(new Error(code), { code });
function createPortalServices(deps) {
  let disposed = false;
  let suspended = false;
  const context = () => {
    if (disposed || suspended || deps.isUnavailable?.()) throw failure('PORTAL_CANCELLED');
    const snapshot = deps.getSnapshot();
    if (snapshot.operation) throw failure('OPERATION_IN_PROGRESS');
    if (snapshot.storageErrorCode || !snapshot.cookieValid || snapshot.loginStatus !== 'success') throw failure('AUTH_REQUIRED');
    const settings = deps.getPreferences();
    return { scope: { profileId: snapshot.profileId, epoch: snapshot.epoch },
      authGeneration: deps.getAuthGeneration(), cookie: deps.getCookie(), cluster: settings.cluster,
      tlsCa: deps.apiOptions?.tlsCa };
  };
  const createClient = options => createPortalApiClient({ ...deps.apiOptions, ...options });
  const sessions = createRemoteSessionService({ clock: deps.clock, getContext: context, createClient,
    openExternal: url => deps.shell.openExternal(url), copyToClipboard: url => deps.clipboard.writeText(url) });
  const transfers = createFileTransferController({ getContext: context, createClient,
    getLocale: () => deps.getPreferences().locale,
    dialog: deps.dialog, getWindow: deps.getWindow, onState: state => deps.publish('transfers:state', state) });
  const tokens = createTokenValidationService({ clock: deps.clock, portalPreflight: deps.portalPreflight,
    getSnapshot: deps.getSnapshot, getAuthGeneration: deps.getAuthGeneration,
    getCookie: () => deps.getSnapshot().cookieValid ? deps.getCookie() : '',
    getPreferences: deps.getPreferences,
    onResult(result) {
      if (disposed || suspended || deps.isUnavailable?.()) return;
      const snapshot = deps.getSnapshot();
      if (snapshot.profileId !== result.profileId || snapshot.epoch !== result.epoch
          || deps.getAuthGeneration() !== result.authGeneration) return;
      if (result.status === 'invalid') {
        // REST rejection is a gate/prompt, not authority to delete a cookie or end existing SSH.
        deps.cancelRecovery?.(); deps.cancelHealth?.();
        deps.onRemoteState({ ...result, remoteStatus: 'auth_required', errorCode: 'AUTH_REQUIRED' });
        deps.notifyAuth?.();
      } else if (result.status === 'network_error') {
        deps.onRemoteState({ ...result, remoteStatus: 'error', errorCode: result.errorCode });
      }
      // A valid token is not proof of shell or command reachability.
    },
  });
  const update = () => {
    if (disposed) return;
    sessions.update(); transfers.update();
    if (suspended || deps.isUnavailable?.()) tokens.cancel(); else tokens.update();
  };
  return {
    update,
    suspend() { suspended = true; tokens.suspend(); sessions.update(); transfers.update(); },
    resume() { if (disposed) return; suspended = false; tokens.resume(); update(); },
    dispose() { disposed = true; tokens.dispose(); sessions.dispose(); transfers.dispose(); },
    register(handle) {
      handle('remote-sessions:list', payload => sessions.list(payload));
      handle('remote-sessions:open', payload => sessions.act({ ...payload, action: 'open' }));
      handle('remote-sessions:copy', payload => sessions.act({ ...payload, action: 'copy' }));
      handle('remote-sessions:cancel', payload => sessions.cancel(payload));
      handle('transfers:list', payload => transfers.list(payload));
      handle('transfers:start', payload => transfers.start(payload));
      handle('transfers:cancel', payload => transfers.cancel(payload));
    },
  };
}
module.exports = { createPortalServices };
