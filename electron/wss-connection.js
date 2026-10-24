const tls = require('node:tls');
const { validateHeaderValue } = require('node:http');
const { validateCookie } = require('./credential-store');
const { PLATFORM, WSS_HANDSHAKE_TIMEOUT, MAX_WSS_PAYLOAD_BYTES } = require('./constants');

// URLs and custom trust material are main-process inputs, never renderer options.
function buildWssUrl(config = {}) {
  if (config.wssUrl) return config.wssUrl;
  const params = new URLSearchParams({
    cluster: config.cluster || 'training',
    loginNode: config.loginNode || '11.11.10.202',
    path: config.path ?? '',
    cols: config.cols || '80',
    rows: config.rows || '24',
    useRoot: config.useRoot ? 'true' : 'false',
  });
  return `${PLATFORM.wssBase}?${params.toString()}`;
}

function buildWssOptions({ cookie = '', tlsCa, handshakeTimeoutMs = WSS_HANDSHAKE_TIMEOUT,
  maxPayload = MAX_WSS_PAYLOAD_BYTES } = {}) {
  const cookieHeader = validateCookie(cookie);
  validateHeaderValue('Cookie', cookieHeader);
  const options = {
    headers: {
      Cookie: cookieHeader,
      Origin: PLATFORM.origin,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
        + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
    rejectUnauthorized: true,
    handshakeTimeout: handshakeTimeoutMs,
    maxPayload,
  };
  if (tlsCa !== undefined && tlsCa !== null) {
    options.ca = [...tls.rootCertificates, ...(Array.isArray(tlsCa) ? tlsCa : [tlsCa])];
  }
  return options;
}

module.exports = { buildWssUrl, buildWssOptions };
