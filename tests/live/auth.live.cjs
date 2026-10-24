'use strict';

const crypto = require('node:crypto');
const { liveTest, harness, check, cookie, event } = require('./helpers.cjs');

async function rejectedCredential(t, token, backend = process.env.LIVE_BACKEND || 'proxy') {
  const timeoutMs = 10000;
  if (backend === 'cli') {
    let listening = false;
    let rejection;
    try {
      await harness(t, { cookie: cookie(token) }, { backend,
        onListening: () => { listening = true; } });
    } catch (error) { rejection = error; }
    check(rejection?.code === 'AUTH_REQUIRED', 'LIVE_CLI_PREFLIGHT_REJECTION_MISSING');
    check(!listening, 'LIVE_CLI_REJECTED_TOKEN_BOUND_LISTENER');
    return;
  }
  const f = await harness(t, { cookie: cookie(token), remoteReadyTimeoutMs: timeoutMs, execTimeoutMs: 20000 }, { backend });
  const auth = [];
  const notReady = [];
  let readyCount = 0;
  f.proxy.on('auth-error', (value) => auth.push(value.statusCode));
  f.proxy.on('remote-not-ready', (value) => notReady.push(value));
  f.proxy.on('remote-ready', () => { readyCount += 1; });
  const closed = event(f.proxy, 'session-close', { timeout: 25000 });
  const started = performance.now();
  const result = await f.exec('true', { timeout: 25000 });
  const terminal = await closed;
  check(result.code === 255 && readyCount === 0 && result.output.length === 0, 'LIVE_BAD_CREDENTIAL_SUCCEEDED');
  check(performance.now() - started < timeoutMs + 5000, 'LIVE_BAD_CREDENTIAL_NOT_BOUNDED');
  if (terminal.reason === 'remote_not_ready') {
    check(notReady.length === 1 && notReady[0].code === 'REMOTE_READY_TIMEOUT', 'LIVE_SILENCE_TIMEOUT_EVENT');
    check(notReady[0].sessionId === terminal.sessionId, 'LIVE_SILENCE_TIMEOUT_SESSION');
    check(auth.length === 0, 'LIVE_SILENCE_MISCLASSIFIED_AUTH');
    check(result.stderr.toString('utf8').startsWith('REMOTE_READY_TIMEOUT:'), 'LIVE_SILENCE_DIAGNOSTIC_MISSING');
  } else {
    check(terminal.reason === 'auth_error' && auth.length === 1 && [401, 403].includes(auth[0]), 'LIVE_CREDENTIAL_FAILURE_UNCLASSIFIED');
    check(notReady.length === 0, 'LIVE_AUTH_REPORTED_AS_SILENCE');
  }
}

liveTest('live invalid token gates CLI preflight before listener binding', { timeout: 35000 }, async (t) => {
  await rejectedCredential(t, `invalid-live-test-${crypto.randomBytes(24).toString('hex')}`, 'cli');
});

liveTest('live raw proxy invalid token fails within the readiness deadline without false readiness', { timeout: 35000 }, async (t) => {
  await rejectedCredential(t, `invalid-live-test-${crypto.randomBytes(24).toString('hex')}`, 'proxy');
});

liveTest('live expired token fails without false readiness', {
  timeout: 35000,
  skip: process.env.SCOW_EXPIRED_TOKEN ? false : 'Optional SCOW_EXPIRED_TOKEN is absent',
}, async (t) => {
  await rejectedCredential(t, process.env.SCOW_EXPIRED_TOKEN);
});
