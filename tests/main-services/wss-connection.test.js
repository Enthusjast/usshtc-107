const test = require('node:test');
const assert = require('node:assert/strict');
const tls = require('node:tls');
const { buildWssUrl, buildWssOptions } = require('../../electron/wss-connection');
const { PLATFORM, WSS_HANDSHAKE_TIMEOUT, MAX_WSS_PAYLOAD_BYTES } = require('../../electron/constants');

test('WSS URL preserves platform defaults and safely encodes saved connection fields', () => {
  const defaults = new URL(buildWssUrl());
  assert.equal(`${defaults.origin}${defaults.pathname}`, PLATFORM.wssBase);
  assert.deepEqual(Object.fromEntries(defaults.searchParams), {
    cluster: 'training', loginNode: '11.11.10.202', path: '', cols: '80', rows: '24', useRoot: 'false',
  });
  const config = Object.freeze({ cluster: 'cluster-2', loginNode: '2001:db8::1', cols: 132, rows: 42, useRoot: true });
  const url = new URL(buildWssUrl(config));
  assert.equal(url.searchParams.get('loginNode'), '2001:db8::1');
  assert.equal(url.searchParams.get('useRoot'), 'true');
  assert.equal(url.searchParams.get('cols'), '132');
  assert.equal(buildWssUrl({ wssUrl: 'wss://localhost:4443/main-only-fixture' }), 'wss://localhost:4443/main-only-fixture');
});

test('WSS options preserve immutable TLS policy and append custom trust to default roots', () => {
  const defaults = buildWssOptions();
  assert.equal(defaults.rejectUnauthorized, true);
  assert.equal(defaults.handshakeTimeout, WSS_HANDSHAKE_TIMEOUT);
  assert.equal(defaults.maxPayload, MAX_WSS_PAYLOAD_BYTES);
  assert.equal(defaults.headers.Origin, PLATFORM.origin);
  assert.equal(defaults.headers.Cookie, '');
  assert.equal('ca' in defaults, false);
  const ca = Buffer.from('fixture CA');
  const options = buildWssOptions({ cookie: 'session=fixture', tlsCa: ca, handshakeTimeoutMs: 5000, maxPayload: 4096,
    rejectUnauthorized: false });
  assert.deepEqual(options.ca, [...tls.rootCertificates, ca]);
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.headers.Cookie, 'session=fixture');
  assert.equal(options.handshakeTimeout, 5000);
  assert.equal(options.maxPayload, 4096);
  const input = [ca, 'second CA'];
  const multiple = buildWssOptions({ tlsCa: input });
  assert.deepEqual(multiple.ca, [...tls.rootCertificates, ...input]);
  multiple.ca.pop();
  assert.equal(input.length, 2);
  assert.throws(() => buildWssOptions({ cookie: 'session=fixture\r\nInjected: value' }));
});
