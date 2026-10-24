const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { utils } = require('ssh2');
const {
  ensureClientKeyPair, ensureProxyHostKey, getSsh2ClientIdentity,
  openSshEd25519PublicKey, encodeOpenSshPrivateKey, inspect,
} = require('../../electron/ssh-key-service');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc-key-identity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { sshDirectory: directory, hostKeyPath: path.join(directory, 'host') };
}

function legacyKey() {
  return crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
}

test('PKCS8 host conversion and client adaptation preserve complete wire identity', (t) => {
  const options = fixture(t);
  const client = ensureClientKeyPair(options);
  const diskClient = fs.readFileSync(client.privateKeyPath);
  const host = legacyKey();
  const expectedHost = openSshEd25519PublicKey(host);
  fs.writeFileSync(options.hostKeyPath, host, { mode: 0o600 });
  const converted = ensureProxyHostKey(options.hostKeyPath);
  const parsed = utils.parseKey(converted);
  assert.equal(parsed.getPublicSSH().toString('base64'), expectedHost.openSsh.split(' ')[1]);
  const adapted = getSsh2ClientIdentity(options);
  assert.equal(adapted.publicKey, client.publicKey);
  assert.equal(adapted.fingerprint, client.fingerprint);
  assert.deepEqual(fs.readFileSync(client.privateKeyPath), diskClient);
  const dto = inspect({ ...options, expected: { clientFingerprint: client.fingerprint, hostFingerprint: expectedHost.fingerprint } });
  assert.equal(dto.client.state, 'ready');
  assert.equal(dto.host.state, 'ready');
  assert.equal(dto.recoveryRequired, false);
  assert.equal(JSON.stringify(dto).includes('PRIVATE KEY'), false);
  assert.equal(inspect({ ...options, expected: { clientFingerprint: 'SHA256:wrong' } }).client.state, 'changed');
});

test('OpenSSH none container has matching checkints, seed/public pair and sequential padding', () => {
  const key = legacyKey();
  const jwk = crypto.createPrivateKey(key).export({ format: 'jwk' });
  const pem = encodeOpenSshPrivateKey(key);
  const data = Buffer.from(pem.split('\n').slice(1, -2).join(''), 'base64');
  let offset = Buffer.byteLength('openssh-key-v1\0');
  function string() {
    const length = data.readUInt32BE(offset); offset += 4;
    const result = data.subarray(offset, offset + length); offset += length;
    return result;
  }
  assert.equal(string().toString(), 'none');
  assert.equal(string().toString(), 'none');
  assert.equal(string().length, 0);
  assert.equal(data.readUInt32BE(offset), 1); offset += 4;
  string();
  const body = string();
  assert.equal(body.length % 8, 0);
  assert.deepEqual(body.subarray(0, 4), body.subarray(4, 8));
  let cursor = 8;
  function field() {
    const length = body.readUInt32BE(cursor); cursor += 4;
    const result = body.subarray(cursor, cursor + length); cursor += length;
    return result;
  }
  assert.equal(field().toString(), 'ssh-ed25519');
  assert.deepEqual(field(), Buffer.from(jwk.x, 'base64url'));
  assert.deepEqual(field(), Buffer.concat([Buffer.from(jwk.d, 'base64url'), Buffer.from(jwk.x, 'base64url')]));
  field();
  assert.deepEqual([...body.subarray(cursor)], Array.from({ length: body.length - cursor }, (_, index) => index + 1));
});

test('complete SSH wire fingerprints agree with system ssh-keygen', (t) => {
  const options = fixture(t);
  const client = ensureClientKeyPair(options);
  const identity = getSsh2ClientIdentity(options);
  const convertedPath = path.join(options.sshDirectory, 'converted');
  fs.writeFileSync(convertedPath, identity.privateKey, { mode: 0o600 });
  const publicLine = execFileSync('ssh-keygen', ['-y', '-f', convertedPath], { encoding: 'utf8' }).trim();
  assert.equal(publicLine.split(' ').slice(0, 2).join(' '), client.publicKey.split(' ').slice(0, 2).join(' '));
  const output = execFileSync('ssh-keygen', ['-l', '-E', 'sha256', '-f', client.publicKeyPath], { encoding: 'utf8' });
  assert.equal(output.split(/\s+/)[1], client.fingerprint);
});

test('inspect never creates missing keys or repairs unsafe permissions', (t) => {
  const options = fixture(t);
  assert.equal(inspect(options).client.state, 'missing');
  assert.deepEqual(fs.readdirSync(options.sshDirectory), []);
  const client = ensureClientKeyPair(options);
  ensureProxyHostKey(options.hostKeyPath);
  const before = fs.readFileSync(client.privateKeyPath);
  if (process.platform !== 'win32') {
    fs.chmodSync(client.privateKeyPath, 0o644);
    assert.equal(inspect(options).client.errorCode, 'SSH_KEY_PERMISSIONS');
    assert.equal(fs.statSync(client.privateKeyPath).mode & 0o777, 0o644);
    assert.throws(() => getSsh2ClientIdentity(options), { code: 'SSH_KEY_PERMISSIONS' });
  }
  assert.deepEqual(fs.readFileSync(client.privateKeyPath), before);
});

test('inspection and ensure reject oversized, invalid and nonregular files', (t) => {
  const options = fixture(t);
  const clientPath = path.join(options.sshDirectory, 'usshtc107_ed25519');
  for (const value of ['not a key', Buffer.alloc(64 * 1024 + 1)]) {
    fs.writeFileSync(clientPath, value, { mode: 0o600 });
    assert.equal(inspect(options).client.errorCode, 'SSH_KEY_INVALID');
    assert.throws(() => ensureClientKeyPair(options));
  }
  fs.unlinkSync(clientPath);
  fs.mkdirSync(clientPath);
  assert.equal(inspect(options).client.state, 'invalid');
  assert.throws(() => ensureClientKeyPair(options));
});

test('symlink key files are rejected without touching their targets', { skip: process.platform === 'win32' }, (t) => {
  const options = fixture(t);
  const target = path.join(options.sshDirectory, 'target');
  const original = legacyKey();
  fs.writeFileSync(target, original, { mode: 0o600 });
  fs.symlinkSync(target, options.hostKeyPath);
  assert.equal(inspect(options).host.state, 'invalid');
  assert.throws(() => ensureProxyHostKey(options.hostKeyPath));
  assert.equal(fs.readFileSync(target, 'utf8'), original);
});

test('host migration fsync failure before rename preserves the existing identity and removes staging', (t) => {
  const options = fixture(t);
  const original = legacyKey();
  fs.writeFileSync(options.hostKeyPath, original, { mode: 0o600 });
  const originalFsync = fs.fsyncSync;
  fs.fsyncSync = () => { throw Object.assign(new Error('fixture fsync failure'), { code: 'EIO' }); };
  try {
    assert.throws(() => ensureProxyHostKey(options.hostKeyPath), { code: 'EIO' });
  } finally {
    fs.fsyncSync = originalFsync;
  }
  assert.equal(fs.readFileSync(options.hostKeyPath, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(options.sshDirectory), ['host']);
});

test('in-memory client adaptation accepts a validated imported OpenSSH key without rewriting disk', (t) => {
  const options = fixture(t);
  const client = ensureClientKeyPair(options);
  const converted = getSsh2ClientIdentity(options).privateKey;
  fs.writeFileSync(client.privateKeyPath, converted, { mode: 0o600 });
  const identity = getSsh2ClientIdentity(options);
  assert.equal(identity.fingerprint, client.fingerprint);
  assert.equal(identity.privateKey, converted);
  assert.equal(fs.readFileSync(client.privateKeyPath, 'utf8'), converted);
});

test('OpenSSH private seed must cryptographically match the advertised public wire identity', (t) => {
  const options = fixture(t);
  const original = legacyKey();
  const seed = Buffer.from(crypto.createPrivateKey(original).export({ format: 'jwk' }).d, 'base64url');
  const converted = encodeOpenSshPrivateKey(original);
  const container = Buffer.from(converted.split('\n').slice(1, -2).join(''), 'base64');
  const offset = container.indexOf(seed);
  assert.ok(offset >= 0);
  container[offset] ^= 1;
  const corrupted = `-----BEGIN OPENSSH PRIVATE KEY-----\n${container.toString('base64').match(/.{1,70}/g).join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
  const privateKeyPath = path.join(options.sshDirectory, 'usshtc107_ed25519');
  fs.writeFileSync(privateKeyPath, corrupted, { mode: 0o600 });
  assert.equal(inspect(options).client.state, 'invalid');
  assert.throws(() => getSsh2ClientIdentity(options));
  assert.equal(fs.readFileSync(privateKeyPath, 'utf8'), corrupted);
});
