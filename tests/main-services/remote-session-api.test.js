'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDesktopApi } = require('../../electron/portal-api/desktop-api');
const { createAppApi } = require('../../electron/portal-api/app-api');
const { buildVncUrl, buildAppUrl, validatePortalUrl } = require('../../electron/remote-session/links');
const { host } = require('../../electron/remote-session/validation');

const connection = { host: 'node01.cluster', port: 5901, password: 'fixture-p+ /&?' };
const web = overrides => ({ type: 'web', ...connection, proxyType: 'relative',
  connect: { method: 'GET', path: '/lab/{{ PORT }}/{{ MISSING }}', query: { token: '{{ PASSWORD }}', text: 'a+b /%' } },
  customFormData: {}, ...overrides });

test('desktop API consumes only deployed nested union and sends exact explicit launch body', async () => {
  const calls = [];
  const api = createDesktopApi({ client: { async json(path, options) {
    calls.push({ path, options });
    return path.endsWith('listDesktops') ? { userDesktops: [{ host: 'login01', desktops: [
      { type: 'vnc', vnc: { displayId: 7, desktopName: 'Work', wm: 'xfce', createTime: '2026-10-24' } },
      { type: 'shadowdesk', shadowdesk: { password: 'never-expose' } },
    ] }] } : { vnc: connection };
  } } });
  const desktops = await api.listDesktops('cluster-1');
  assert.equal(desktops[0].displayId, 7);
  assert.equal(desktops[1].kind, 'unsupported');
  assert.equal(JSON.stringify(desktops).includes('never-expose'), false);
  assert.deepEqual(await api.launchDesktop({ cluster: 'cluster-1', loginNode: 'login01', displayId: 7 }), connection);
  assert.deepEqual(calls[1], { path: '/api/desktop/launchDesktop', options: { method: 'POST', body: {
    cluster: 'cluster-1', loginNode: 'login01', displayId: 7,
    desktopInfo: { desktop: { $case: 'vnc', vnc: { displayId: 7 } } },
  } } });
});

test('desktop flat mock responses and malformed display IDs do not trigger a fallback', async () => {
  for (const response of [connection, { vnc: { ...connection, port: 70000 } }]) {
    let calls = 0;
    const api = createDesktopApi({ client: { json: async () => { calls += 1; return response; } } });
    await assert.rejects(api.launchDesktop({ cluster: 'c', loginNode: 'n', displayId: 1 }), { code: 'PORTAL_UNKNOWN' });
    assert.equal(calls, 1);
  }
  const api = createDesktopApi({ client: { json() { assert.fail('must reject before sending'); } } });
  await assert.rejects(api.launchDesktop({ cluster: '../c', loginNode: 'n', displayId: 1 }));
  await assert.rejects(api.launchDesktop({ cluster: 'c', loginNode: 'n', displayId: '1' }));
});

test('app API uses POST JSON including deployed jobId for GET connections and drops unused fields', async () => {
  let call;
  const api = createAppApi({ client: { async json(path, options) { call = { path, options }; return {
    ...web(), connect: { ...web().connect, formData: { password: 'not-used-for-get' } }, cookie: 'never-expose',
  }; } } });
  const result = await api.connectToApp({ cluster: 'c', sessionId: 's1', jobId: 42 });
  assert.equal(call.path, '/api/app/connectToApp');
  assert.deepEqual(call.options.body, { cluster: 'c', sessionId: 's1', jobId: 42 });
  assert.equal(call.options.method, 'POST');
  assert.equal(result.connect.method, 'GET');
  assert.equal(Object.hasOwn(result.connect, 'formData'), false);
  assert.equal(Object.hasOwn(result, 'cookie'), false);
});

test('POST forms and unknown types are explicitly unsupported, never converted into GET', async () => {
  for (const response of [{ ...web(), connect: { method: 'POST', path: '/', formData: { token: 'secret' } } },
    { type: 'shadowDesk' }, { ...web(), connect: { method: 'get', path: '/' } }]) {
    const api = createAppApi({ client: { json: async () => response } });
    assert.deepEqual(await api.connectToApp({ cluster: 'c', sessionId: 's', jobId: 1 }), { type: 'unsupported' });
  }
});

test('VNC URL uses portal host, encoded proxy path, and exact portal flags', () => {
  const url = new URL(buildVncUrl('c', connection));
  assert.equal(url.origin, 'https://107.ustc.edu.cn');
  assert.equal(url.pathname, '/vnc/vnc.html');
  assert.equal(url.searchParams.get('path'), '/api/proxy/c/absolute/node01.cluster/5901');
  assert.equal(url.searchParams.get('host'), '107.ustc.edu.cn');
  assert.equal(url.searchParams.get('port'), '');
  assert.equal(url.searchParams.get('password'), connection.password);
  assert.equal(url.searchParams.get('autoconnect'), 'true');
  assert.equal(url.searchParams.get('resize'), 'remote');
});

test('GET web links follow exact one-pass placeholders and query encoding with custom overrides', () => {
  const url = new URL(buildAppUrl('c', web({ customFormData: { PORT: 'custom', PASSWORD: '{{ HOST }}' } })));
  assert.equal(url.pathname, '/api/proxy/c/relative/node01.cluster/5901/lab/custom/');
  assert.equal(url.searchParams.get('token'), '{{ HOST }}');
  assert.equal(url.searchParams.get('text'), 'a+b /%');
  assert.match(url.search, /text=a%2Bb\+%2F%25/);
  const exact = new URL(buildAppUrl('c', web({ connect: { method: 'GET', path: '/', query: { value: '{{HOST}} ${HOST} %HOST% {{ missing }}' } } })));
  assert.equal(exact.searchParams.get('value'), '{{HOST}} ${HOST} %HOST% ');
});

test('link paths reject traversal, URL injection, nested escapes and unsafe host/port/cluster', () => {
  for (const path of ['../admin', '/a/../../', '%2e%2e/admin', '%252e%252e/admin', '//evil.test', 'https://evil.test',
    'ok?token=secret', 'ok#fragment', 'ok\\escape', '{{ PASSWORD }}']) {
    assert.throws(() => buildAppUrl('c', web({ password: '../admin', connect: { method: 'GET', path } })), { code: 'PORTAL_UNKNOWN' });
  }
  for (const value of ['localhost', '127.0.0.1', '169.254.169.254', '2130706433', '0x7f000001', '999.1.1.1',
    'node/evil', 'user@host', 'host:443', '::1', 'fe80::1', '-node', 'node..test']) assert.throws(() => host(value));
  for (const url of ['http://107.ustc.edu.cn/vnc/vnc.html', 'https://evil.test/vnc/vnc.html',
    'https://107.ustc.edu.cn@evil.test/api/proxy/c', 'https://107.ustc.edu.cn/settings',
    'https://107.ustc.edu.cn/vnc/vnc.html#secret']) assert.throws(() => validatePortalUrl(url));
  assert.throws(() => buildVncUrl('c/../admin', connection));
  assert.throws(() => buildVncUrl('c', { ...connection, port: 0 }));
});

test('session/catalog DTO normalization omits backend paths, credentials, logos and unknown fields', async () => {
  const api = createAppApi({ client: { json: async path => path.endsWith('getAppSessions') ? { sessions: [{
    sessionId: 's', jobId: 42, appId: 'app', appName: 'App', state: 'RUNNING', runningTime: '00:01',
    dataPath: '/secret', host: 'node', port: 1234, password: 'secret', cookie: 'secret',
  }] } : { apps: [{ id: 'app', name: 'App', logoPath: 'https://evil.test/track' }] } } });
  const sessions = await api.getAppSessions('c');
  assert.deepEqual(Object.keys(sessions[0]).sort(), ['sessionId', 'jobId', 'appId', 'name', 'state', 'runningTime', 'submitTime'].sort());
  assert.deepEqual(await api.listAvailableApps('c'), [{ id: 'app', name: 'App' }]);
});
