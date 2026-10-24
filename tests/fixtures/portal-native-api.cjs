'use strict';

// Private native-test adapter only. Uses real local HTTPS; never packaged.
const { portalFixture } = require('./portal-file-api.cjs');
async function startNativePortalApi(control) {
  let cleanup;
  const send = (response, status, value) => {
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
  };
  const body = async request => {
    const chunks = []; let size = 0;
    for await (const bytes of request) {
      size += bytes.length;
      if (size > 4096) throw new Error('NATIVE_FIXTURE_BODY_LIMIT');
      chunks.push(bytes);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  };
  const fixture = await portalFixture({ after: close => { cleanup = close; } }, {
    token: 'fixture-A',
    async beforeRequest({ pathname, query, request, response }) {
      control.portalCalls.push(pathname); // No query, token, password or response body.
      if (pathname === '/api/setup') {
        response.writeHead(control.apiSetupFailed ? 503 : 200, { 'Content-Type': 'text/plain' });
        response.end(control.apiSetupFailed ? 'unavailable' : 'Already setup'); return;
      }
      if (pathname === '/api/auth/validateToken') {
        const valid = !control.apiReject && ['fixture-A', 'fixture-B'].includes(query.token);
        send(response, valid ? 200 : 403, valid ? { identityId: 'fixture-user' } : null); return;
      }
      if (control.apiReject) { send(response, 401, null); return; }
      if (pathname.startsWith('/api/desktop/') || pathname.startsWith('/api/app/')) {
        if (!/^SCOW_USER=fixture-(?:A|B)$/.test(request.headers.cookie || '')) { send(response, 401, null); return; }
        if (pathname === '/api/desktop/listDesktops') {
          send(response, 200, { userDesktops: [{ host: 'login.fixture.invalid', desktops: [{ type: 'vnc', vnc: {
            displayId: 1, desktopName: 'Fixture desktop', wm: 'xfce', createTime: '2026-10-24T00:00:00Z',
          } }] }] });
        } else if (pathname === '/api/desktop/launchDesktop') {
          const input = await body(request);
          if (input.displayId !== 1 || input.loginNode !== 'login.fixture.invalid'
              || input.desktopInfo?.desktop?.$case !== 'vnc' || input.desktopInfo.desktop.vnc?.displayId !== 1) {
            send(response, 400, { code: 'INVALID_ARGUMENT' }); return;
          }
          control.portalLaunches++;
          send(response, 200, { type: 'vnc', vnc: { host: 'desktop.fixture.invalid', port: 5901, password: 'fixture-vnc-private' } });
        } else if (pathname === '/api/app/getAppSessions') {
          send(response, 200, { sessions: [{ sessionId: 'fixture-session', jobId: 7, appId: 'fixture-app',
            appName: 'Fixture app session', state: 'RUNNING', runningTime: '1m', submitTime: '2026-10-24T00:00:00Z' }] });
        } else if (pathname === '/api/app/listAvailableApps') {
          send(response, 200, { apps: [{ id: 'fixture-app', name: 'Fixture application' }] });
        } else if (pathname === '/api/app/connectToApp') {
          const input = await body(request);
          if (input.sessionId !== 'fixture-session' || input.jobId !== 7) { send(response, 404, { code: 'SESSION_ID_NOT_FOUND' }); return; }
          send(response, 200, { type: 'web', host: 'app.fixture.invalid', port: 8787, password: 'fixture-app-private',
            proxyType: 'relative', connect: { method: control.apiAppMethod || 'GET', path: '/workspace',
              query: { credential: '{{ PASSWORD }}' }, formData: {} }, customFormData: {} });
        } else send(response, 404, { code: 'NOT_EXISTS' });
      }
    },
  });
  fixture.dispose = cleanup;
  return fixture;
}
module.exports = { startNativePortalApi };
