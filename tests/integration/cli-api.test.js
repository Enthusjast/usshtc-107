'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { run } = require('../../cli/main.cjs');
const { createPortalApiClient } = require('../../electron/portal-api/client');
const { portalFixture, sha256 } = require('../fixtures/portal-file-api.cjs');

async function cli(fixture, argv, { env = { SCOW_TOKEN: 'fixture-token' }, signals = new EventEmitter() } = {}) {
  let stdout = '';
  let stderr = '';
  const clientOptions = [];
  const forbidden = () => assert.fail('file CLI must not start or connect a proxy or load SSH keys');
  const code = await run(argv, {
    env, signals,
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
    startService: forbidden,
    connectTransport: forbidden,
    loadIdentity: forbidden,
    createPortalApiClient(options) {
      clientOptions.push(options);
      return createPortalApiClient({ ...options, baseUrl: fixture.baseUrl, allowedHosts: fixture.allowedHosts, tlsCa: fixture.tlsCa });
    },
  });
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  return { code, stdout, stderr, clientOptions };
}

test('CLI put/get uses SCOW_TOKEN and verified TLS official HTTP directly, with no proxy or SSH identity', { timeout: 30000 }, async t => {
  const f = await portalFixture(t, { chunkSizeByte: 65537 });
  const bytes = crypto.randomBytes(128 * 1024 + 31);
  const source = path.join(f.local, 'source.bin');
  const destination = path.join(f.local, 'returned.bin');
  const target = "/remote/- uploaded ' & +?#% binary.bin";
  await fs.writeFile(source, bytes);
  const put = await cli(f, ['put', '--cluster', 'cluster-1', '--', source, target]);
  assert.equal(put.code, 0, put.stderr);
  assert.match(put.stdout, /SHA-256 verified/);
  assert.match(put.stderr, /Transfer multipart:/);
  assert.match(put.stderr, /Remote temporary files may remain/);
  assert.equal(put.clientOptions.length, 1);
  assert.equal(put.clientOptions[0].cookie, 'SCOW_USER=fixture-token');
  assert.equal(sha256(f.files.get(target)), sha256(bytes));
  assert.equal(f.requests.filter(item => item.pathname.endsWith('/move')).length, 1);
  const get = await cli(f, ['get', '--cluster', 'cluster-1', '--', target, destination]);
  assert.equal(get.code, 0, get.stderr);
  assert.match(get.stdout, /SHA-256 verified/);
  assert.equal(sha256(await fs.readFile(destination)), sha256(bytes));
  assert.equal(f.requests.filter(item => item.pathname.endsWith('/download') && item.query.path === target).length, 3);
  assert.ok(f.requests.every(item => item.headers.cookie === 'SCOW_USER=fixture-token'));
  assert.ok(f.requests.every(item => item.pathname.startsWith('/api/file/')));
  assert.deepEqual((await fs.readdir(f.local)).sort(), ['returned.bin', 'source.bin']);
  assert.deepEqual((await fs.readdir(f.root)).sort(), ['local', 'remote'], 'transfer creates no keys or proxy state');
  assert.equal(`${put.stdout}${put.stderr}${get.stdout}${get.stderr}`.includes('fixture-token'), false);
});

test('CLI overwrite requires explicit permission and a replacement-capable backend', async t => {
  const f = await portalFixture(t, { moveOverwrite: true });
  const source = path.join(f.local, 'source');
  const destination = path.join(f.local, 'destination');
  await fs.writeFile(source, 'replacement');
  await fs.writeFile(destination, 'local original');
  f.files.set('/remote/target', Buffer.from('remote original'));
  const putConflict = await cli(f, ['put', '--', source, '/remote/target']);
  assert.equal(putConflict.code, 1);
  assert.equal(f.files.get('/remote/target').toString(), 'remote original');
  const put = await cli(f, ['put', '--overwrite', '--', source, '/remote/target']);
  assert.equal(put.code, 0, put.stderr);
  assert.equal(f.files.get('/remote/target').toString(), 'replacement');
  const getConflict = await cli(f, ['get', '--', '/remote/target', destination]);
  assert.equal(getConflict.code, 1);
  assert.equal(await fs.readFile(destination, 'utf8'), 'local original');
  const get = await cli(f, ['get', '--overwrite', '--', '/remote/target', destination]);
  assert.equal(get.code, 0, get.stderr);
  assert.equal(await fs.readFile(destination, 'utf8'), 'replacement');
  assert.equal(f.requests.some(item => item.method === 'DELETE'), false);
});

test('CLI rejects origin and allowlist flags rather than exposing credential forwarding controls', async t => {
  const f = await portalFixture(t);
  for (const [flag, value] of [['--base-url', f.baseUrl], ['--allowed-hosts', f.allowedHosts[0]]]) {
    const result = await cli(f, ['get', flag, value, '--', '/remote/source', path.join(f.local, 'final')]);
    assert.equal(result.code, 1);
    assert.equal(result.clientOptions.length, 0);
    assert.equal(f.requests.length, 0);
  }
});

test('CLI transfers require SCOW_TOKEN even when no proxy configuration or key exists', async t => {
  const f = await portalFixture(t);
  const result = await cli(f, ['get', '--', '/remote/source', path.join(f.local, 'final')], { env: {} });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /SCOW_TOKEN|cookie|credential/i);
  assert.equal(f.requests.length, 0);
  assert.deepEqual(await fs.readdir(f.local), []);
});

for (const { label, fixtureOptions } of [
  { label: 'expired authentication', fixtureOptions: { authAfterRequest: 0 } },
  { label: '403 PERMISSION_DENIED', fixtureOptions: { permission: true } },
]) {
  test(`CLI ${label} reports sanitized failure without proxy fallback or local output`, async t => {
    const f = await portalFixture(t, fixtureOptions);
    f.files.set('/remote/source', Buffer.from('data'));
    const result = await cli(f, ['get', '--', '/remote/source', path.join(f.local, 'final')]);
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes('fixture-token'), false);
    assert.equal(result.stderr.includes(f.baseUrl), false);
    assert.equal(f.requests.length, 1, 'no retry or transport fallback');
    assert.deepEqual(await fs.readdir(f.local), []);
  });
}

test('CLI SIGINT cancels a live HTTPS download and removes temporary local output', async t => {
  const signals = new EventEmitter();
  const f = await portalFixture(t, { slowMs: 20, beforeDownload({ occurrence }) {
    if (occurrence === 2) signals.emit('SIGINT');
  } });
  f.files.set('/remote/source', crypto.randomBytes(32768));
  const result = await cli(f, ['get', '--', '/remote/source', path.join(f.local, 'final')], { signals });
  assert.equal(result.code, 130);
  assert.equal(f.requests.filter(item => item.pathname.endsWith('/download')).length, 2);
  assert.deepEqual(await fs.readdir(f.local), []);
});
