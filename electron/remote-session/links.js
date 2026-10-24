'use strict';

const { posix } = require('node:path');
const { PLATFORM } = require('../constants');
const v = require('./validation');

function validatePortalUrl(value) {
  let url;
  try { url = new URL(value); } catch (_) { throw v.invalid(); }
  if (url.protocol !== 'https:' || url.origin !== PLATFORM.origin || url.username || url.password || url.hash
      || !['/vnc/vnc.html'].includes(url.pathname) && !url.pathname.startsWith('/api/proxy/')) throw v.invalid();
  if (url.href.length > 32768) throw v.invalid();
  return url.href;
}
function proxyPrefix(cluster, mode, node, port) {
  v.segment(cluster); v.host(node); v.port(port);
  if (!['absolute', 'relative'].includes(mode)) throw v.invalid();
  return `/api/proxy/${cluster}/${mode}/${node}/${port}`;
}
function buildVncUrl(cluster, connection) {
  const { host, port, password } = v.connection(connection);
  const url = new URL('/vnc/vnc.html', PLATFORM.origin);
  url.search = new URLSearchParams({ path: proxyPrefix(cluster, 'absolute', host, port),
    host: url.hostname, port: url.port, password, autoconnect: 'true', reconnect: 'true', resize: 'remote' }).toString();
  return validatePortalUrl(url.href);
}
function interpolate(value, variables) {
  return value.replace(/\{\{ ([a-zA-Z0-9_]+) \}\}/g, (_, key) => Object.hasOwn(variables, key) ? variables[key] ?? '' : '');
}
function safePath(value) {
  v.text(value, 8192);
  // URL and proxy servers may decode at different layers. Reject traversal and
  // routing delimiters at every encoded layer, rather than normalizing them away.
  let decoded = value;
  for (let pass = 0; pass < 8; pass += 1) {
    if (/[\\?#:\u0000-\u001f\u007f]/.test(decoded) || decoded.startsWith('//')
        || decoded.split('/').some(part => part === '..' || part === '.')) throw v.invalid();
    if (!/%[0-9a-f]{2}/i.test(decoded)) return value;
    let next;
    try { next = decodeURIComponent(decoded); } catch (_) { throw v.invalid(); }
    if (next === decoded) return value;
    decoded = next;
  }
  throw v.invalid();
}
function buildAppUrl(cluster, connection) {
  if (connection.type === 'vnc') return buildVncUrl(cluster, connection);
  if (connection.type !== 'web' || connection.connect?.method !== 'GET') throw v.invalid();
  const { host, port, password } = v.connection(connection);
  const prefix = proxyPrefix(cluster, connection.proxyType, host, port);
  const variables = { HOST: host, PORT: port, PASSWORD: password, ...connection.customFormData };
  const path = safePath(interpolate(connection.connect.path, variables));
  const url = new URL(PLATFORM.origin);
  url.pathname = posix.join(prefix, path);
  // Explicit containment check before any credentials leave this process.
  if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`)) throw v.invalid();
  url.search = new URLSearchParams(Object.entries(connection.connect.query || {})
    .map(([key, value]) => [key, interpolate(value, variables)])).toString();
  return validatePortalUrl(url.href);
}

module.exports = { buildVncUrl, buildAppUrl, validatePortalUrl };
