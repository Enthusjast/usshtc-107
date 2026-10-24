'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRemoteSessionService, REMOTE_SESSION_TIMEOUT_MS } = require('../../electron/remote-session/service');
const { PortalApiError } = require('../../electron/portal-api/client');

const scope = { profileId: 'default', epoch: 1 };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function harness(overrides = {}) {
  const value = { scope: { ...scope }, cookie: 'SCOW_USER=fixture-only', cluster: 'c', authGeneration: 1 };
  const calls = [], opened = [], copied = [], clients = [];
  const fixture = path => {
    if (path.endsWith('listDesktops')) return { userDesktops: [{ host: 'login01', desktops: [
      { type: 'vnc', vnc: { displayId: 1, desktopName: 'Desktop', wm: 'xfce', createTime: '2026-10-24' } },
    ] }] };
    if (path.endsWith('getAppSessions')) return { sessions: [{ sessionId: 's1', jobId: 42, appId: 'jupyter',
      appName: 'Notebook', state: 'RUNNING', runningTime: '00:01', dataPath: '/private', password: 'never-dto' }] };
    if (path.endsWith('listAvailableApps')) return { apps: [{ id: 'jupyter', name: 'Notebook', logoPath: '/private' }] };
    if (path.endsWith('launchDesktop')) return { vnc: { host: 'node01', port: 5901, password: 'fixture-vnc-secret' } };
    if (path.endsWith('connectToApp')) return { type: 'web', host: 'node01', port: 8888, password: 'fixture-app-secret',
      proxyType: 'relative', connect: { method: 'GET', path: '/lab', query: { token: '{{ PASSWORD }}' } } };
    assert.fail(`Unexpected fixture path ${path}`);
  };
  const service = createRemoteSessionService({ getContext: () => value,
    createClient: options => {
      const client = { options, disposed: false,
        async json(path, request) { calls.push({ path, request }); return overrides.json ? overrides.json(path, request, fixture) : fixture(path); },
        dispose() { client.disposed = true; } };
      clients.push(client); return client;
    },
    openExternal: async url => { opened.push(url); if (overrides.open) await overrides.open(url); },
    copyToClipboard: async url => { copied.push(url); if (overrides.copy) await overrides.copy(url); },
    ...(overrides.clock ? { clock: overrides.clock } : {}),
  });
  service.update();
  return { service, value, calls, opened, copied, clients };
}
const list = (h, requestId = 'list-1') => h.service.list({ scope: h.value.scope, requestId });
const act = (h, targetId, action = 'open', requestId = 'action-1') => h.service.act({ scope: h.value.scope, requestId, targetId, action });

test('lists safe DTOs without launching and performs exactly one explicit launch per open/copy', async () => {
  const h = harness();
  const data = await list(h);
  assert.deepEqual(Object.keys(data).sort(), ['profileId', 'epoch', 'desktops', 'apps', 'catalog', 'sectionErrors'].sort());
  assert.equal(h.calls.length, 3);
  assert.equal(h.opened.length, 0);
  assert.equal(h.copied.length, 0);
  const serialized = JSON.stringify(data);
  for (const secret of ['fixture-only', 'password', '/private', 'sessionId', '5901', 'token=']) assert.equal(serialized.includes(secret), false);
  assert.deepEqual(await act(h, data.desktops[0].targetId), { ...scope, opened: true });
  assert.deepEqual(await act(h, data.desktops[0].targetId, 'copy', 'action-2'), { ...scope, copied: true, warning: 'SESSION_LINK_CREDENTIALS' });
  assert.equal(h.calls.filter(call => call.path.endsWith('launchDesktop')).length, 2);
  assert.equal(h.opened.length, 1);
  assert.equal(h.copied.length, 1);
  assert.equal(new URL(h.copied[0]).searchParams.get('password'), 'fixture-vnc-secret');
  assert.equal(h.clients.every(client => client.disposed), true);
  h.service.dispose();
});

test('GET application links connect only on click; endpoint remains POST and VNC response stays flat', async () => {
  const h = harness();
  const data = await list(h);
  await act(h, data.apps[0].targetId);
  const url = new URL(h.opened[0]);
  assert.equal(url.pathname, '/api/proxy/c/relative/node01/8888/lab');
  assert.equal(url.searchParams.get('token'), 'fixture-app-secret');
  const call = h.calls.find(item => item.path.endsWith('connectToApp'));
  assert.deepEqual(call.request.body, { cluster: 'c', sessionId: 's1', jobId: 42 });
  h.service.dispose();
  const vnc = harness({ json: (path, options, fixture) => path.endsWith('connectToApp')
    ? { type: 'vnc', host: 'node01', port: 5902, password: 'fixture-app-vnc' } : fixture(path) });
  const vncData = await list(vnc);
  await act(vnc, vncData.apps[0].targetId);
  assert.equal(new URL(vnc.opened[0]).pathname, '/vnc/vnc.html');
  vnc.service.dispose();
});

test('POST app and unsupported desktop types never open or copy fabricated connections', async () => {
  const h = harness({ json: (path, options, fixture) => path.endsWith('connectToApp')
    ? { type: 'web', connect: { method: 'POST', path: '/', formData: { password: 'secret' } } } : fixture(path) });
  const data = await list(h);
  await assert.rejects(act(h, data.apps[0].targetId), { code: 'REMOTE_SESSION_UNSUPPORTED' });
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.copied, []);
  h.service.dispose();
});

test('REST auth failures are safe prompts, never credential deletion; file permission is not auth', async () => {
  const h = harness({ json: path => { throw new PortalApiError(path.endsWith('listDesktops') ? 'AUTH' : 'PERMISSION', 403); } });
  const cookie = h.value.cookie;
  await assert.rejects(list(h), { code: 'AUTH_REQUIRED' });
  assert.equal(h.value.cookie, cookie);
  assert.equal(h.value.authGeneration, 1);
  h.service.dispose();
  const denied = harness({ json: (path, options, fixture) => { if (path.endsWith('listDesktops')) throw new PortalApiError('PERMISSION', 403); return fixture(path); } });
  const data = await list(denied);
  assert.equal(data.sectionErrors.desktops, 'PORTAL_PERMISSION');
  assert.equal(data.apps.length, 1);
  denied.service.dispose();
});

test('404 and 409 connect results are expired/not-ready and are not retried', async () => {
  for (const [status, code] of [[404, 'REMOTE_SESSION_EXPIRED'], [409, 'REMOTE_SESSION_NOT_READY']]) {
    const h = harness({ json: (path, options, fixture) => { if (path.endsWith('connectToApp')) throw new PortalApiError('UNKNOWN', status); return fixture(path); } });
    const data = await list(h);
    await assert.rejects(act(h, data.apps[0].targetId), { code });
    assert.equal(h.calls.filter(call => call.path.endsWith('connectToApp')).length, 1);
    assert.deepEqual(h.opened, []);
    h.service.dispose();
  }
});

test('late launch results cannot open links after auth generation, cookie, scope or cluster changes', async () => {
  for (const change of [value => { value.authGeneration += 1; }, value => { value.cookie = 'SCOW_USER=new-fixture'; },
    value => { value.scope = { profileId: 'other', epoch: 2 }; }, value => { value.cluster = 'other'; }]) {
    const pending = deferred();
    const h = harness({ json: (path, options, fixture) => path.endsWith('launchDesktop') ? pending.promise : fixture(path) });
    const data = await list(h);
    const result = act(h, data.desktops[0].targetId);
    await Promise.resolve();
    change(h.value);
    pending.resolve({ vnc: { host: 'node01', port: 5901, password: 'must-not-open' } });
    await assert.rejects(result, { code: 'PROFILE_CHANGED' });
    assert.deepEqual(h.opened, []);
    h.service.dispose();
  }
});

test('cancellation aborts exact operation and ignores a late response without launch retries', async () => {
  const pending = deferred();
  let signal;
  const h = harness({ json: (path, options, fixture) => { if (path.endsWith('launchDesktop')) { signal = options.signal; return pending.promise; } return fixture(path); } });
  const data = await list(h);
  const result = act(h, data.desktops[0].targetId);
  await Promise.resolve();
  assert.deepEqual(h.service.cancel({ scope, requestId: 'unrelated' }), { ...scope, cancelled: false });
  assert.equal(signal.aborted, false);
  h.service.cancel({ scope, requestId: 'action-1' });
  await assert.rejects(result, { code: 'PORTAL_CANCELLED' });
  assert.equal(signal.aborted, true);
  pending.resolve({ vnc: { host: 'node01', port: 5901, password: 'late' } });
  await Promise.resolve();
  assert.deepEqual(h.opened, []);
  assert.equal(h.clients.every(client => client.disposed), true);
  h.service.dispose();
});

test('whole operation deadline bounds an adapter that ignores cancellation', async () => {
  const timers = new Map(); let next = 0;
  const clock = { setTimeout(callback, ms) { const id = ++next; timers.set(id, { callback, ms }); return id; }, clearTimeout(id) { timers.delete(id); } };
  const h = harness({ clock, json: () => new Promise(() => {}) });
  const result = list(h);
  const [timer] = timers.values();
  assert.equal(timer.ms, REMOTE_SESSION_TIMEOUT_MS);
  timer.callback();
  await assert.rejects(result, { code: 'PORTAL_TIMEOUT' });
  assert.equal(timers.size, 0);
  assert.equal(h.clients[0].disposed, true);
  h.service.dispose();
});

test('refresh retires target IDs; arbitrary URLs and unknown payload fields are rejected', async () => {
  const h = harness();
  const old = await list(h);
  await list(h, 'list-2');
  await assert.rejects(act(h, old.desktops[0].targetId), { code: 'REMOTE_SESSION_EXPIRED' });
  await assert.rejects(act(h, 'https://evil.test'), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(h.service.act({ scope, requestId: 'action-2', targetId: 'anything', action: 'open', url: 'https://evil.test' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(h.service.list({ scope: { ...scope, cookie: 'injected' }, requestId: 'invalid' }), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(h.opened, []);
  h.service.dispose();
});

test('auth update and disposal abort in-flight operations and bound concurrent requests', async () => {
  const h = harness({ json: () => new Promise(() => {}) });
  const results = ['a', 'b', 'c', 'd'].map(id => list(h, id));
  const settled = Promise.all(results.map(result => assert.rejects(result, { code: 'PORTAL_CANCELLED' })));
  await assert.rejects(list(h, 'e'), { code: 'OPERATION_IN_PROGRESS' });
  h.value.authGeneration += 1;
  h.service.update();
  await settled;
  assert.equal(h.clients.every(client => client.disposed), true);
  h.service.dispose();
  await assert.rejects(list(h, 'f'), { code: 'PORTAL_CANCELLED' });
});

test('an unsafe backend response or browser exception cannot leak credentials in errors', async () => {
  const h = harness({ open: () => { throw new Error('password=fixture-vnc-secret Cookie=fixture-only https://private'); } });
  const data = await list(h);
  await assert.rejects(act(h, data.desktops[0].targetId), error => {
    assert.equal(error.message, 'REMOTE_SESSION_OPEN_FAILED');
    assert.deepEqual(Object.keys(error), ['code']);
    return true;
  });
  h.service.dispose();
});
