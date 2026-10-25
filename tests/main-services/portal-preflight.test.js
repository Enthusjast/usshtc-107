'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { once } = require('node:events');
const { createPortalPreflight } = require('../../electron/portal-preflight');

async function fixture(t) {
  const certificate = fs.readFileSync(path.join(__dirname, '../fixtures/loopback-test-only-cert.pem'));
  const key = fs.readFileSync(path.join(__dirname, '../fixtures/loopback-test-only-key.pem'));
  const requests = [];
  let mode = 'valid';
  const server = https.createServer({ key, cert: certificate }, (request, response) => {
    const url = new URL(request.url, 'https://localhost');
    requests.push({ path: url.pathname, token: url.searchParams.get('token'), cookie: request.headers.cookie,
      method: request.method });
    if (mode === 'network') { request.socket.destroy(); return; }
    if (url.pathname === '/api/auth/validateToken') {
      const rejected = mode === 'invalid' || mode === 'invalid-empty-json';
      response.writeHead(rejected ? 403 : 200, { 'Content-Type': 'application/json' });
      response.end(mode === 'invalid-empty-json' ? '' : rejected ? 'null' : JSON.stringify({ identityId: 'fixture-only' }));
    } else {
      response.writeHead(mode === 'setup-failure' ? 403 : 200);
      response.end(mode === 'setup-failure' ? 'private setup body' : 'Already setup');
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const host = `127.0.0.1:${server.address().port}`;
  const portal = createPortalPreflight({ baseUrl: `https://${host}/`, allowedHosts: [host], tlsCa: certificate });
  return { portal, requests, setMode: value => { mode = value; } };
}
const context = () => ({ cookie: 'other=not-forwarded; SCOW_USER=local-fixture-token',
  scope: { profileId: 'test', epoch: 1 }, authGeneration: 1 });

test('real shared API validates token then setup with no cookie header; no receipt crosses lifecycles', async t => {
  const f = await fixture(t);
  await f.portal.run(context());
  await f.portal.run(context());
  assert.deepEqual(f.requests.map(value => value.path), ['/api/auth/validateToken', '/api/setup',
    '/api/auth/validateToken', '/api/setup']);
  assert.ok(f.requests.every(value => value.method === 'GET' && value.cookie === undefined));
  assert.equal(f.requests[0].token, 'local-fixture-token');
});

test('API rejection gates setup, while network and setup HTTP failures remain operational', async t => {
  const f = await fixture(t);
  f.setMode('invalid');
  await assert.rejects(f.portal.run(context()), { code: 'AUTH_REQUIRED', message: 'AUTH_REQUIRED' });
  assert.equal(f.requests.length, 1);
  f.setMode('network');
  await assert.rejects(f.portal.run(context()), { code: 'PORTAL_NETWORK', message: 'PORTAL_NETWORK' });
  f.setMode('setup-failure');
  await assert.rejects(f.portal.run(context()), { code: 'PORTAL_NETWORK', message: 'PORTAL_NETWORK' });
});

test('preflight never derives host permission from an injected base URL', async () => {
  let outgoing = 0;
  for (const baseUrl of ['https://evil.example', 'https://107.ustc.edu.cn.evil.example', 'https://127.0.0.1:444']) {
    const portal = createPortalPreflight({ baseUrl, request() { outgoing += 1; } });
    await assert.rejects(portal.run(context()), { code: 'PORTAL_UNKNOWN' });
  }
  assert.equal(outgoing, 0);
});

test('empty JSON validator rejection stops before setup and retains the supplied credential', async t => {
  const f = await fixture(t);
  f.setMode('invalid-empty-json');
  const value = context();
  const cookie = value.cookie;
  await assert.rejects(f.portal.run(value), { code: 'AUTH_REQUIRED' });
  assert.deepEqual(f.requests.map(request => request.path), ['/api/auth/validateToken']);
  assert.equal(value.cookie, cookie);
});

test('setup uses a four-second bound and disposes every client even on timeout', async () => {
  const options = [];
  let disposed = 0;
  const portal = createPortalPreflight({ createClient: () => ({ dispose() { disposed += 1; } }),
    createApi: () => ({ validateToken: async () => ({ status: 'valid' }),
      setup: async value => { options.push(value); return { ok: false, errorCode: 'PORTAL_TIMEOUT' }; } }) });
  await assert.rejects(portal.run(context()), { code: 'PORTAL_TIMEOUT' });
  assert.equal(options[0].timeoutMs, 4000);
  assert.equal(disposed, 2);
});

test('missing or malformed token never contacts the portal; cancelled contexts never start requests', async () => {
  let clients = 0;
  const portal = createPortalPreflight({ createClient: () => { clients += 1; throw new Error('must not request'); } });
  for (const cookie of ['', 'other=cookie', 'SCOW_USER=one; SCOW_USER=two']) {
    await assert.rejects(portal.run({ ...context(), cookie }), { code: 'AUTH_REQUIRED' });
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(portal.run({ ...context(), signal: controller.signal }), { code: 'OPERATION_CANCELLED' });
  assert.equal(clients, 0);
});
