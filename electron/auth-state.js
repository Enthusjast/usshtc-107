'use strict';

const LOGIN_STATUSES = new Set(['idle', 'pending', 'sso_done', 'success', 'failure']);

function createAuthStateController({
  state, invalidateQueries, setCapturedCookie, clearStoredCookie, publish,
  onStateChanged = () => {}, onClearError = () => {},
}) {
  if (!state || typeof invalidateQueries !== 'function' || typeof setCapturedCookie !== 'function'
      || typeof clearStoredCookie !== 'function' || typeof publish !== 'function') {
    throw new TypeError('auth state controller dependencies are invalid');
  }
  const deactivate = (loginStatus = 'idle') => {
    if (!LOGIN_STATUSES.has(loginStatus) || loginStatus === 'success') {
      throw new TypeError('invalid authentication status');
    }
    invalidateQueries();
    state.loginStatus = loginStatus;
    state.loginStage = null;
    state.cookieValid = false;
    state.cookieCount = 0;
    setCapturedCookie('');
    publish({ loginStatus, loginStage: null, cookieValid: false, cookieCount: 0 });
    onStateChanged();
  };
  const invalidate = (loginStatus = 'failure') => {
    // Revoke memory before attempting persistence: a locked keyring/disk cannot preserve authority.
    deactivate(loginStatus);
    try { clearStoredCookie(); return true; }
    catch (error) { onClearError(error); return false; }
  };
  return {
    canStartProxy: () => state.loginStatus === 'success' && state.cookieValid === true,
    deactivate,
    invalidate,
    expireCookie: () => invalidate(state.loginStatus === 'success' ? 'failure' : state.loginStatus),
  };
}

module.exports = { createAuthStateController };
