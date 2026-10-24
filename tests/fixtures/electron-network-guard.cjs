'use strict';

// Test-side containment only. This helper is never included in builder.files.
const net = require('node:net');
const dns = require('node:dns');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');

const loopback = (host) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(String(host).toLowerCase());
function installNetworkGuard(electron, { authUrls = [] } = {}) {
  if (electron.app.__acceptanceNetwork) return electron.app.__acceptanceNetwork;
  const denied = [];
  const sessions = new Set();
  const fixedAuth = new Set(authUrls);
  const reject = (kind, target) => {
    denied.push({ kind, target: String(target) });
    throw Object.assign(new Error(`Acceptance fixture blocked external ${kind}`), { code: 'FIXTURE_EXTERNAL_NETWORK' });
  };
  const checkHost = (kind, host) => { if (!loopback(host)) reject(kind, host); };
  const checkPipe = (value) => {
    if (typeof value === 'string' && value.startsWith('\\\\') && !value.startsWith('\\\\.\\pipe\\')) reject('remote pipe', value);
  };
  const checkUrl = (kind, value) => {
    const url = new URL(typeof value === 'string' ? value : value.url || value.href);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || !loopback(url.hostname)) reject(kind, url.origin);
  };
  const socketConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const options = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (options && typeof options === 'object') {
      if (options.path) checkPipe(options.path);
      else checkHost('TCP', options.host || options.hostname || 'localhost');
    } else if (typeof options === 'number') checkHost('TCP', typeof args[1] === 'string' ? args[1] : 'localhost');
    else if (typeof options === 'string') checkPipe(options);
    else reject('TCP', 'unknown target');
    return socketConnect.apply(this, args);
  };
  const tlsConnect = tls.connect;
  tls.connect = function (...args) {
    const options = args.find((value) => value && typeof value === 'object' && !Array.isArray(value)) || {};
    checkHost('TLS', options.host || options.hostname || (typeof args[1] === 'string' ? args[1] : 'localhost'));
    if (options.rejectUnauthorized === false) reject('TLS policy', 'rejectUnauthorized=false');
    return tlsConnect.apply(this, args);
  };
  for (const module of [http, https]) {
    const request = module.request;
    module.request = function (input, ...args) {
      if (typeof input === 'string' || input instanceof URL) checkUrl('HTTP', input);
      else checkHost('HTTP', input?.hostname || input?.host || 'localhost');
      return request.call(this, input, ...args);
    };
    module.get = function (...args) { const request = module.request(...args); request.end(); return request; };
  }
  for (const object of [dns, dns.promises, dns.Resolver.prototype, dns.promises.Resolver.prototype]) {
    for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNs', 'resolveTxt', 'resolveSrv', 'resolveNaptr', 'resolveSoa', 'resolvePtr', 'reverse']) {
      if (typeof object[name] !== 'function') continue;
      const original = object[name];
      object[name] = function (host, ...args) {
        checkHost('DNS', host);
        // Native resolve/reverse uses a UDP resolver even for a localhost
        // name. Fixed diagnostic DNS is injected separately; only numeric
        // lookup is allowed here, which never contacts a DNS server.
        if (name !== 'lookup') reject('DNS resolver', host);
        return original.call(this, host === 'localhost' ? '127.0.0.1' : host, ...args);
      };
    }
  }
  if (typeof globalThis.fetch === 'function') {
    const fetch = globalThis.fetch;
    globalThis.fetch = (input, ...args) => { checkUrl('fetch', input); return fetch(input, ...args); };
  }
  if (electron.net) {
    for (const name of ['fetch', 'request']) {
      const original = electron.net[name];
      if (typeof original !== 'function') continue;
      electron.net[name] = function (input, ...args) {
        if (typeof input === 'string' || input instanceof URL || input?.url) checkUrl(`Electron ${name}`, input);
        else checkHost(`Electron ${name}`, input?.hostname || input?.host || 'localhost');
        return original.call(this, input, ...args);
      };
    }
  }
  const guardSession = (session) => {
    if (sessions.has(session)) return;
    sessions.add(session);
    session.webRequest.onBeforeRequest((details, callback) => {
      try {
        const url = new URL(details.url);
        const local = ['file:', 'data:', 'devtools:', 'chrome-devtools:', 'about:'].includes(url.protocol)
          || (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && loopback(url.hostname));
        const fixtureAuth = session === electron.session.fromPartition('persist:usshtc107-auth')
          && fixedAuth.has(url.href);
        if (!local && !fixtureAuth) {
          denied.push({ kind: 'session', target: url.origin });
          callback({ cancel: true });
        } else callback({ cancel: false });
      } catch (_) { denied.push({ kind: 'session', target: 'invalid URL' }); callback({ cancel: true }); }
    });
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
  };
  electron.app.on('session-created', guardSession);
  if (electron.app.isReady()) {
    guardSession(electron.session.defaultSession);
    guardSession(electron.session.fromPartition('persist:usshtc107-auth'));
    for (const contents of electron.webContents.getAllWebContents()) guardSession(contents.session);
  } else electron.app.whenReady().then(() => {
    guardSession(electron.session.defaultSession);
    guardSession(electron.session.fromPartition('persist:usshtc107-auth'));
  });
  const state = { denied, get sessionCount() { return sessions.size; } };
  Object.defineProperty(electron.app, '__acceptanceNetwork', { value: state });
  return state;
}

module.exports = { installNetworkGuard };
