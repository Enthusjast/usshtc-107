'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { Readable } = require('node:stream');
const { createPortalApiClient, PortalApiError, extractScowToken, MAX_JSON_BYTES } = require('../../electron/portal-api/client');
const { createAuthApi } = require('../../electron/portal-api/auth-api');
const ca = fs.readFileSync(path.join(__dirname, '../fixtures/loopback-test-only-cert.pem'));
const key = fs.readFileSync(path.join(__dirname, '../fixtures/loopback-test-only-key.pem'));
const cookie = 'other=unused; SCOW_USER=fixture-only-secret';

async function fixture(t, handler) {
  const sockets = new Set();
  const requests = [];
  const server = https.createServer({ key, cert: ca }, (request, response) => {
    request.on('error', () => {}); response.on('error', () => {});
    requests.push(request.url);
    Promise.resolve(handler(request, response)).catch(() => response.destroy());
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseUrl = `https://127.0.0.1:${server.address().port}`;
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.dispose();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { server, requests, baseUrl, client(options = {}) {
    const client = createPortalApiClient({ baseUrl, cookie, tlsCa: ca, ...options });
    clients.push(client); return client;
  } };
}

const json = (response, status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };

test('token validation sends only its scoped token, discards identity and accepts optional name', async t => {
  const f = await fixture(t, (request, response) => {
    const url = new URL(request.url, 'https://localhost');
    assert.equal(url.pathname, '/api/auth/validateToken');
    assert.equal(url.searchParams.get('token'), 'fixture+token/=value');
    assert.equal(request.headers.cookie, undefined);
    json(response, 200, { identityId: 'private-identity-not-returned' });
  });
  const auth = createAuthApi({ client: f.client() });
  assert.deepEqual(await auth.validateToken('fixture+token/=value'), { status: 'valid' });
  assert.equal(extractScowToken(cookie), 'fixture-only-secret');
  assert.equal(extractScowToken('other=unused'), null);
  for (const invalid of ['SCOW_USER=a; SCOW_USER=b', 'SCOW_USER=a\nCookie:x', 'SCOW_USER=']) {
    assert.throws(() => extractScowToken(invalid), { code: 'PORTAL_UNKNOWN' });
  }
});

test('endpoint-aware HTTP errors never turn file permissions or setup failures into token revocation', async t => {
  const f = await fixture(t, (request, response) => {
    const url = new URL(request.url, 'https://localhost');
    if (url.pathname === '/api/setup') {
      assert.equal(request.headers.cookie, undefined); json(response, 403, null); return;
    }
    if (url.pathname === '/api/auth/validateToken') { json(response, 403, null); return; }
    assert.equal(request.headers.cookie, 'SCOW_USER=fixture-only-secret');
    const status = Number(url.searchParams.get('status'));
    const code = url.searchParams.get('code');
    json(response, status, code ? { code, message: 'password=NEVER_RETURN_THIS_BODY' } : null);
  });
  const client = f.client();
  const auth = createAuthApi({ client });
  assert.deepEqual(await auth.validateToken('invalid-fixture'), { status: 'invalid', errorCode: 'AUTH_REQUIRED' });
  assert.deepEqual(await auth.setup(), { ok: false, errorCode: 'PORTAL_NETWORK' });
  for (const [status, code, kind] of [[401, '', 'AUTH'], [403, 'PERMISSION_DENIED', 'PERMISSION'],
    [403, 'NOT_ACCESSIBLE', 'PERMISSION'], [403, '', 'PERMISSION'], [404, '', 'NOT_FOUND'],
    [501, '', 'UNIMPLEMENTED'], [429, '', 'QUOTA'], [520, '', 'UNKNOWN']]) {
    await assert.rejects(client.json('/api/file/fileExist', { query: { status, code } }), error => {
      assert.equal(error.code, `PORTAL_${kind}`);
      assert.equal(error.statusCode, status);
      assert.doesNotMatch(JSON.stringify(error) + error.stack, /NEVER_RETURN_THIS_BODY|fixture-only-secret|password=/);
      return true;
    });
  }
});

test('setup accepts only its known successful plain-text responses and omits authentication', async t => {
  let calls = 0;
  const f = await fixture(t, (request, response) => {
    assert.equal(request.headers.cookie, undefined);
    response.end(++calls === 1 ? 'Already setup' : calls === 2 ? 'Setup complete\n' : 'unexpected private response');
  });
  const auth = createAuthApi({ client: f.client() });
  assert.deepEqual(await auth.setup(), { ok: true });
  assert.deepEqual(await auth.setup(), { ok: true });
  assert.deepEqual(await auth.setup(), { ok: false, errorCode: 'PORTAL_NETWORK' });
});

test('TLS trust remains enabled and redirects never forward token-bearing requests', async t => {
  const f = await fixture(t, (request, response) => {
    response.writeHead(302, { Location: '/api/redirected?token=fixture-only-secret' }); response.end();
  });
  await assert.rejects(f.client({ tlsCa: undefined }).json('/api/file/fileExist'), { code: 'PORTAL_NETWORK' });
  await assert.rejects(f.client().json('/api/file/fileExist'), { code: 'PORTAL_UNKNOWN' });
  assert.deepEqual(f.requests, ['/api/file/fileExist']);
});

test('network failure and a bounded response deadline remain distinct from authentication', async t => {
  const f = await fixture(t, (request, response) => {
    if (request.url.includes('reset')) request.socket.destroy();
    else { response.writeHead(200); response.flushHeaders(); }
  });
  const client = f.client();
  const auth = createAuthApi({ client });
  await assert.rejects(client.json('/api/reset'), { code: 'PORTAL_NETWORK' });
  assert.deepEqual(await auth.validateToken('valid-shaped-fixture', { timeoutMs: 25 }), { status: 'network_error', errorCode: 'PORTAL_TIMEOUT' });
});

test('stream ownership rejects late bytes after a profile/authentication change', async t => {
  let response;
  const f = await fixture(t, (_request, target) => { response = target; target.writeHead(200); target.write('before'); });
  let current = true;
  const value = await f.client().stream('/api/file/download', { assertCurrent() { if (!current) throw new Error('stale owner'); } });
  const iterator = value.body[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.toString(), 'before');
  current = false; response.end('late');
  await assert.rejects(iterator.next(), { code: 'PORTAL_CANCELLED' });
});

test('unconsumed streams time out and cancellation before dispatch creates no request', async t => {
  const f = await fixture(t, (_request, response) => { response.writeHead(200); response.flushHeaders(); });
  const client = f.client();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.json('/api/file/fileExist', { signal: controller.signal }), { code: 'PORTAL_CANCELLED' });
  assert.deepEqual(f.requests, []);
  const value = await client.stream('/api/file/download', { timeoutMs: 25 });
  await new Promise(resolve => setTimeout(resolve, 45));
  await assert.rejects(async () => { for await (const _bytes of value.body) {} }, { code: 'PORTAL_TIMEOUT' });
});

test('response size limits fail without returning a partial success or raw body', async t => {
  const f = await fixture(t, (request, response) => {
    if (request.url.includes('declared')) { response.writeHead(200, { 'Content-Length': '100' }); response.end('short'); }
    else response.end('x'.repeat(MAX_JSON_BYTES + 1));
  });
  await assert.rejects(f.client().stream('/api/declared', { maxBytes: 8 }), { code: 'PORTAL_QUOTA' });
  await assert.rejects(f.client().json('/api/large'), { code: 'PORTAL_QUOTA' });
});

test('streamed multipart bytes and JSON PATCH bodies are exact, bounded and never replayed', async t => {
  const bodies = [];
  const f = await fixture(t, async (request, response) => {
    const parts = []; for await (const bytes of request) parts.push(bytes);
    bodies.push({ method: request.method, bytes: Buffer.concat(parts) });
    response.writeHead(204); response.end();
  });
  const client = f.client();
  await client.empty('/api/file/upload', { method: 'POST', body: Readable.from([Buffer.from([0, 255]), Buffer.from([128, 10])]),
    headers: { 'Content-Type': 'multipart/form-data; boundary=fixture', 'Content-Length': '4' }, expectedStatus: [204] });
  await client.empty('/api/file/move', { method: 'PATCH', body: { cluster: 'fixture', fromPath: '/a', toPath: '/b' }, expectedStatus: [204] });
  assert.deepEqual(bodies[0], { method: 'POST', bytes: Buffer.from([0, 255, 128, 10]) });
  assert.deepEqual(JSON.parse(bodies[1].bytes), { cluster: 'fixture', fromPath: '/a', toPath: '/b' });
  for (const bytes of [Buffer.alloc(3), Buffer.alloc(5)]) await assert.rejects(client.empty('/api/file/upload', {
    method: 'POST', body: Readable.from([bytes]), headers: { 'Content-Type': 'multipart/form-data; boundary=fixture', 'Content-Length': '4' },
  }), { code: 'PORTAL_UNKNOWN' });
  assert.equal(bodies.length, 2);
});

test('invalid configuration and transport exceptions expose no secrets or credential URLs', async () => {
  assert.throws(() => createPortalApiClient({ baseUrl: 'http://127.0.0.1' }), { code: 'PORTAL_UNKNOWN' });
  const client = createPortalApiClient({ cookie, request() { throw new Error('https://secret/?token=DO_NOT_EXPOSE password=NEVER'); } });
  try {
    await assert.rejects(client.json('/api/file/list'), error => {
      assert.ok(error instanceof PortalApiError);
      assert.equal(error.code, 'PORTAL_NETWORK');
      assert.doesNotMatch(error.stack + JSON.stringify(error), /DO_NOT_EXPOSE|NEVER|token=/);
      return true;
    });
    await assert.rejects(client.json('/api/%2e%2e/leak'), { code: 'PORTAL_UNKNOWN' });
  } finally { client.dispose(); }
});
