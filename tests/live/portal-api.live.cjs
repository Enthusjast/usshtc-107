'use strict';

const crypto = require('node:crypto');
const { liveTest, portalClient, check } = require('./helpers.cjs');
const { DEFAULTS } = require('../../electron/constants');
const { createAuthApi } = require('../../electron/portal-api/auth-api');
const { createDesktopApi } = require('../../electron/portal-api/desktop-api');
const { createAppApi } = require('../../electron/portal-api/app-api');

// The shared Node client supplies verified TLS, bounded requests and SCOW_USER
// headers. Tests never print response data, identities, tokens or session links.
liveTest('live portal validates the configured token without exposing its identity', async (t) => {
  const auth = createAuthApi({ client: portalClient(t) });
  const result = await auth.validateToken(process.env.SCOW_TOKEN);
  check(result.status === 'valid', result.errorCode || 'LIVE_CONFIGURED_TOKEN_REJECTED');
});

liveTest('live portal rejects a generated invalid token without credential mutation', async (t) => {
  const invalid = `invalid-live-test-${crypto.randomBytes(24).toString('hex')}`;
  const auth = createAuthApi({ client: portalClient(t, invalid) });
  const result = await auth.validateToken(invalid);
  check(result.status === 'invalid', result.errorCode || 'LIVE_INVALID_TOKEN_ACCEPTED');
  check(result.errorCode === 'AUTH_REQUIRED', 'LIVE_TOKEN_REJECTION_UNCLASSIFIED');
});

liveTest('live portal setup completes within its four-second request bound', async (t) => {
  const auth = createAuthApi({ client: portalClient(t) });
  const result = await auth.setup({ timeoutMs: 4000 });
  check(result.ok, result.errorCode || 'LIVE_SETUP_FAILED');
});

liveTest('live portal lists desktops and applications read-only without launching sessions', async (t) => {
  const client = portalClient(t);
  const desktop = createDesktopApi({ client });
  const app = createAppApi({ client });
  const cluster = process.env.SCOW_CLUSTER || DEFAULTS.cluster;
  const desktops = await desktop.listDesktops(cluster);
  check(Array.isArray(desktops), 'LIVE_DESKTOP_LIST_INVALID');
  const sessions = await app.getAppSessions(cluster);
  check(Array.isArray(sessions), 'LIVE_APP_SESSION_LIST_INVALID');
  const available = await app.listAvailableApps(cluster);
  check(Array.isArray(available), 'LIVE_APP_CATALOG_INVALID');
});
