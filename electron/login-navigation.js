const { PLATFORM } = require('./constants');

const ALLOWED_LOGIN_ORIGINS = new Set([
  PLATFORM.origin,
  'https://id.ustc.edu.cn',
]);

function parseHttpsUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function isAbortedNavigation(error) {
  return error?.code === -3
    || error?.errno === -3
    || String(error?.message || '').includes('ERR_ABORTED');
}

function isAllowedLoginUrl(url) {
  const parsed = parseHttpsUrl(url);
  return Boolean(parsed && ALLOWED_LOGIN_ORIGINS.has(parsed.origin));
}

async function loadOwnedWindowUrl({ window, url, isCurrent, onError = () => {} }) {
  if (!isCurrent()) return false;
  try {
    await window.loadURL(url);
    return isCurrent();
  } catch (error) {
    if (!isAbortedNavigation(error) && isCurrent()) {
      try { onError(error); } catch (_) {}
    }
    return false;
  }
}

module.exports = {
  ALLOWED_LOGIN_ORIGINS,
  isAbortedNavigation,
  isAllowedLoginUrl,
  loadOwnedWindowUrl,
  parseHttpsUrl,
};
