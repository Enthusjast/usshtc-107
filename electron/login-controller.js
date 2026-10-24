'use strict';

const { PLATFORM, LOGIN_PAGE_PATTERNS, TERMINAL_PATTERNS } = require('./constants');
const { validateCookie } = require('./credential-store');
const { createAuthStateController } = require('./auth-state');
const { ServiceError } = require('./ipc-contract');
const { isAllowedLoginUrl, parseHttpsUrl, loadOwnedWindowUrl } = require('./login-navigation');

function createLoginController(deps) {
  const clock = deps.clock || globalThis;
  const log = deps.log || (() => {});
  let scope = { profileId: 'default', epoch: 0 };
  let credentials = null;
  let authSession = null;
  let window = null;
  let owner = null;
  let authGeneration = 0;
  let queryRevision = 0;
  let debounceTimer = null;
  let pollTimer = null;
  let resetPromise = null;
  let needsPartitionReset = true;
  let disposed = false;
  let cookie = '';
  const state = { loginStatus: 'idle', loginStage: null, cookieValid: false, cookieCount: 0 };
  const sameScope = (a, b) => a.profileId === b.profileId && a.epoch === b.epoch;
  const emit = (patch) => {
    Object.assign(state, patch);
    if (!disposed) deps.onState?.({ ...scope, authGeneration, ...patch });
  };
  const cancelQueries = () => {
    queryRevision += 1;
    if (debounceTimer !== null) clock.clearTimeout(debounceTimer);
    debounceTimer = null;
  };
  const cancelPoll = () => {
    if (pollTimer !== null) clock.clearInterval(pollTimer);
    pollTimer = null;
  };
  const closeWindow = () => {
    cancelPoll();
    const old = window;
    window = null;
    if (old && !old.isDestroyed()) old.destroy();
  };
  const auth = createAuthStateController({
    state,
    invalidateQueries: () => { authGeneration += 1; owner = null; cancelQueries(); },
    setCapturedCookie: (value) => { cookie = value; },
    clearStoredCookie: () => credentials?.clearCookie(),
    publish: emit,
    onClearError: (error) => {
      log('error', 'auth', `Cookie removal failed: ${error.message}`);
      emit({ errorCode: 'AUTH_PERSIST_FAILED' });
    },
  });
  const queryIdentity = () => ({ scope: { ...scope }, authGeneration,
    queryRevision: ++queryRevision, owner });
  const currentQuery = (query) => !disposed && sameScope(query.scope, scope)
    && query.authGeneration === authGeneration && query.queryRevision === queryRevision
    && query.owner !== null && query.owner === owner
    && owner.profileId === scope.profileId && owner.authGeneration === authGeneration;
  const loginPage = (url) => LOGIN_PAGE_PATTERNS.some((part) => url.toLowerCase().includes(part));
  const terminalPage = (url) => TERMINAL_PATTERNS.some((part) => url.toLowerCase().includes(part));
  const platformPage = (url) => parseHttpsUrl(url)?.origin === PLATFORM.origin;
  const acceptCookies = (query, values, finalize) => {
    if (!currentQuery(query)) return;
    if (values.length === 0) {
      if (state.cookieValid) {
        const revokedScope = { ...scope };
        auth.expireCookie();
        closeWindow();
        deps.onAuthRequired?.({ ...revokedScope, authGeneration });
      }
      return;
    }
    let next;
    try { next = validateCookie(values.map((item) => `${item.name}=${item.value}`).join('; ')); }
    catch (error) {
      log('error', 'cookie', `Cookie capture rejected: ${error.message}`);
      const revokedScope = { ...scope };
      auth.invalidate('failure');
      closeWindow();
      deps.onAuthRequired?.({ ...revokedScope, authGeneration });
      return;
    }
    if (!finalize && state.loginStatus !== 'success') return;
    const authenticated = cookie !== next || state.loginStatus !== 'success' || !state.cookieValid;
    cookie = next;
    if (authenticated) {
      emit({ loginStatus: 'success', loginStage: null, cookieValid: true, cookieCount: values.length });
      // An epoch refresh only observes existing credentials; it is not a new
      // login and must not rearm the app's authentication/start lifecycle.
      deps.onAuthenticated?.({ scope: { ...query.scope }, authGeneration: query.authGeneration, cookie: next });
    }
    if (finalize) {
      cancelPoll();
      const old = window;
      window = null;
      if (old && !old.isDestroyed()) old.close();
    }
  };
  const queryCookies = async (finalize = false, sourceWindow = null) => {
    if (!owner || disposed) return;
    const query = queryIdentity();
    try {
      const values = await getSession().cookies.get({ domain: PLATFORM.domain });
      if (!currentQuery(query) || (sourceWindow && window !== sourceWindow)) return;
      if (sourceWindow) {
        const url = sourceWindow.webContents.getURL();
        if (!platformPage(url) || loginPage(url)) return;
        if (terminalPage(url)) acceptCookies(query, values, true);
        else if (values.length && state.loginStatus !== 'success') {
          emit({ loginStatus: 'sso_done', loginStage: 'shell' });
        }
      } else acceptCookies(query, values, finalize);
    } catch (error) {
      if (currentQuery(query)) log('error', 'cookie', `Cookie query failed: ${error.message}`);
    }
  };
  const cookieChanged = (_event, changedCookie) => {
    if (!owner || disposed || changedCookie.domain?.replace(/^\./, '') !== PLATFORM.domain) return;
    const captured = { scope: { ...scope }, authGeneration, owner };
    if (debounceTimer !== null) clock.clearTimeout(debounceTimer);
    debounceTimer = clock.setTimeout(() => {
      debounceTimer = null;
      if (!disposed && captured.owner === owner && captured.authGeneration === authGeneration
          && sameScope(captured.scope, scope)) void queryCookies(false, window);
    }, 250);
  };
  function getSession() {
    if (!authSession) {
      authSession = deps.getSession('persist:usshtc107-auth');
      authSession.setPermissionCheckHandler(() => false);
      authSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      authSession.on('will-download', preventDownload);
      authSession.cookies.on('changed', cookieChanged);
    }
    return authSession;
  }
  function preventDownload(event) {
    event.preventDefault();
    log('warn', 'security', 'Blocked download from login session');
  }
  const reset = (options = {}) => {
    if (resetPromise) {
      if (options.revoke) {
        closeWindow();
        auth.invalidate(options.loginStatus || 'failure');
        needsPartitionReset = true;
      }
      return resetPromise.catch((error) => {
        if (options.revoke && error.code === 'OPERATION_CANCELLED' && !disposed) return reset(options);
        throw error;
      });
    }
    closeWindow();
    const revoked = options.revoke ? auth.invalidate(options.loginStatus || 'idle') : true;
    if (!options.revoke) auth.deactivate(options.loginStatus || 'idle');
    needsPartitionReset = true;
    const generation = authGeneration;
    const check = () => {
      if (disposed || authGeneration !== generation) throw new ServiceError('OPERATION_CANCELLED');
      options.assertCurrent?.();
    };
    resetPromise = Promise.resolve().then(async () => {
      try {
        check();
        const partition = getSession();
        await partition.clearData();
        check();
        await partition.clearCache();
        check();
        await partition.clearAuthCache();
        check();
        await partition.closeAllConnections();
        check();
        needsPartitionReset = false;
        if (!revoked) throw new ServiceError('AUTH_PERSIST_FAILED');
      } catch (error) {
        if (error.code === 'OPERATION_CANCELLED' || error.code === 'AUTH_PERSIST_FAILED') throw error;
        log('error', 'login', `Login partition reset failed: ${error.message}`);
        if (!disposed && authGeneration === generation) emit({ loginStatus: 'failure', loginStage: null });
        throw new ServiceError('LOGIN_RESET_FAILED');
      } finally { resetPromise = null; }
    });
    return resetPromise;
  };
  const start = async ({ signal } = {}) => {
    if (disposed || signal?.aborted) throw new ServiceError('OPERATION_CANCELLED');
    if (window && !window.isDestroyed()) {
      window.focus();
      return { alreadyOpen: true };
    }
    if (resetPromise) await resetPromise;
    if (disposed || signal?.aborted) throw new ServiceError('OPERATION_CANCELLED');
    if (needsPartitionReset) await reset();
    if (disposed || signal?.aborted) throw new ServiceError('OPERATION_CANCELLED');
    getSession();
    owner = { profileId: scope.profileId, authGeneration };
    const generation = authGeneration;
    const authWindow = deps.createWindow({
      width: 1180, height: 800, minWidth: 980, minHeight: 680,
      parent: deps.getWindow(), modal: false, title: 'USTC Login', autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true,
        webSecurity: true, allowRunningInsecureContent: false, partition: 'persist:usshtc107-auth' },
    });
    window = authWindow;
    const contents = authWindow.webContents;
    const currentWindow = () => !disposed && window === authWindow && !authWindow.isDestroyed()
      && authGeneration === generation && owner?.authGeneration === generation;
    const navigate = (url) => loadOwnedWindowUrl({ window: authWindow, url, isCurrent: currentWindow,
      onError: (error) => {
        log('error', 'login', `Login navigation failed: ${error.message}`);
        emit({ loginStatus: 'failure', loginStage: null });
        closeWindow();
      } });
    const autoClick = () => {
      if (!currentWindow()) return;
      contents.executeJavaScript(`new Promise(resolve => {
        let tries = 0; const timer = setInterval(() => {
          const button = document.getElementById('authButton');
          if (button) { clearInterval(timer); button.click(); resolve(true); }
          else if (++tries > 15) { clearInterval(timer); resolve(false); }
        }, 200);
      })`).catch(() => {});
    };
    contents.on('did-finish-load', () => {
      if (!currentWindow()) return;
      const url = contents.getURL();
      const hostname = parseHttpsUrl(url)?.hostname;
      if (hostname === PLATFORM.domain) {
        const query = queryIdentity();
        const shellUrl = `${PLATFORM.origin}/shell/${deps.getConfig().cluster}/${deps.getConfig().loginNode}`;
        if (url !== shellUrl && !url.includes('/auth') && !url.includes('scowAuth')) {
          getSession().cookies.get({ domain: PLATFORM.domain }).then((values) => {
            if (!currentWindow() || !currentQuery(query)) return;
            if (values.some((value) => value.name === 'SCOW_USER')) void navigate(shellUrl);
            else autoClick();
          }).catch((error) => { if (currentWindow()) log('error', 'login', error.message); });
        } else autoClick();
      }
      if (hostname === 'id.ustc.edu.cn') {
        emit({ loginStage: 'sso' });
        const password = credentials?.getSsoPassword();
        if (!password) return;
        const username = credentials.getSsoStatus().username;
        contents.executeJavaScript(`(() => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          const fill = () => {
            const user = document.getElementById('nameInput');
            const pass = document.querySelector('input[type="password"][maxlength="200"]');
            if (!user || !pass) return false;
            for (const [element, value] of [[user, ${JSON.stringify(username)}], [pass, ${JSON.stringify(password)}]]) {
              setter.call(element, value); element.dispatchEvent(new Event('input', {bubbles:true}));
              element.dispatchEvent(new Event('change', {bubbles:true}));
            }
            setTimeout(() => document.getElementById('submitBtn')?.click(), 200); return true;
          };
          if (fill()) return;
          const observer = new MutationObserver(() => { if (fill()) observer.disconnect(); });
          observer.observe(document, {childList:true, subtree:true});
          setTimeout(() => observer.disconnect(), 10000);
        })()`).catch(() => {});
      }
    });
    const guard = (event, url) => { if (!isAllowedLoginUrl(url)) event.preventDefault(); };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedLoginUrl(url) && currentWindow()) void navigate(url);
      return { action: 'deny' };
    });
    const navigated = (_event, url) => {
      if (!currentWindow()) return;
      if (platformPage(url) && loginPage(url)) emit({ loginStatus: 'pending', loginStage: 'sso' });
      void queryCookies(false, authWindow);
    };
    contents.on('did-navigate', navigated);
    contents.on('did-navigate-in-page', navigated);
    authWindow.on('closed', () => {
      if (window !== authWindow) return;
      window = null;
      cancelPoll();
      if (state.loginStatus !== 'success' && state.loginStatus !== 'failure') {
        emit({ loginStatus: 'idle', loginStage: null });
      }
    });
    emit({ loginStatus: 'pending', loginStage: 'opening' });
    pollTimer = clock.setInterval(() => {
      if (currentWindow()) void queryCookies(false, authWindow);
    }, 2000);
    pollTimer?.unref?.();
    // Start navigation without holding the exclusive app slot until human login/navigation completes.
    void navigate(PLATFORM.url);
    return {};
  };

  return {
    setProfile: (nextScope, store) => {
      closeWindow();
      auth.deactivate();
      scope = { ...nextScope };
      credentials = store;
      cookie = validateCookie(store.getCookie());
      emit({ loginStatus: cookie ? 'success' : 'idle', loginStage: null,
        cookieValid: Boolean(cookie), cookieCount: cookie.split(';').filter((part) => part.includes('=')).length });
    },
    setScope: (nextScope) => {
      const sameProfile = scope.profileId === nextScope.profileId;
      scope = { ...nextScope };
      cancelQueries();
      if (sameProfile && owner?.profileId === scope.profileId && owner.authGeneration === authGeneration) {
        void queryCookies(false, window);
      }
    },
    start,
    deactivate: () => {
      closeWindow();
      auth.deactivate();
      needsPartitionReset = true;
    },
    resetForProfile: reset,
    getCookie: () => cookie,
    dispose: () => {
      disposed = true;
      owner = null;
      cookie = '';
      authGeneration += 1;
      cancelQueries();
      closeWindow();
      if (authSession) {
        authSession.cookies.removeListener('changed', cookieChanged);
        authSession.removeListener('will-download', preventDownload);
      }
    },
  };
}

module.exports = { createLoginController };
