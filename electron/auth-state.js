'use strict';

const LOGIN_STATUSES = new Set(['idle', 'pending', 'sso_done', 'success', 'failure']);

function createAuthStateController({
  state,
  invalidateQueries,
  setCapturedCookie,
  clearStoredCookie,
  publish,
  onStateChanged = () => {},
  onClearError = () => {},
}) {
  if (!state || typeof state !== 'object'
      || typeof invalidateQueries !== 'function'
      || typeof setCapturedCookie !== 'function'
      || typeof clearStoredCookie !== 'function'
      || typeof publish !== 'function') {
    throw new TypeError('auth state controller dependencies are invalid');
  }

  const canStartProxy = () => state.loginStatus === 'success' && state.cookieValid === true;

  const invalidate = (loginStatus = 'failure') => {
    if (!LOGIN_STATUSES.has(loginStatus) || loginStatus === 'success') {
      throw new TypeError('invalid authentication status');
    }

    const previousLoginStatus = state.loginStatus;
    invalidateQueries();
    state.loginStatus = loginStatus;
    state.cookieValid = false;
    state.cookieCount = 0;
    setCapturedCookie('');
    try {
      clearStoredCookie();
    } catch (error) {
      onClearError(error);
    }

    if (previousLoginStatus !== loginStatus) publish('login-status', loginStatus);
    publish('cookie-status', { cookieValid: false, cookieCount: 0 });
    onStateChanged();
  };

  const expireCookie = () => {
    const nextStatus = state.loginStatus === 'success' ? 'failure' : state.loginStatus;
    invalidate(nextStatus);
  };

  return { canStartProxy, expireCookie, invalidate };
}

module.exports = { createAuthStateController };
