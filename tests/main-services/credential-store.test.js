const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  CredentialStore, MAX_COOKIE_BYTES, MAX_ENCRYPTED_SECRET_BYTES, MAX_SSO_PASSWORD_BYTES,
  validateCookie,
} = require('../../electron/credential-store');

const safeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (value) => Buffer.from(`encrypted:${value}`),
  decryptString: (value) => value.toString().replace(/^encrypted:/, ''),
});
function fixture(options = {}) {
  let root = { A: { ssoUsername: '', ssoPassword: '', savedCookieEncrypted: '' }, B: { ssoUsername: '', ssoPassword: '', savedCookieEncrypted: '' } };
  let result = { state: 'committed', durable: true, errorCode: null };
  const instances = {};
  for (const profileId of ['A', 'B']) {
    instances[profileId] = new CredentialStore({
      safeStorage: safeStorage(), profileId, userDataPath: '/test/data',
      readSecrets: () => root[profileId],
      commitSecrets: (patch) => {
        if (result.state === 'committed') root = { ...root, [profileId]: { ...root[profileId], ...patch } };
        return result;
      },
      ...options,
    });
  }
  return {
    ...instances, getRoot: () => root,
    replaceSecrets: (id, secrets) => { root = { ...root, [id]: { ...secrets } }; },
    setResult: (value) => { result = value; },
  };
}

function xorPassword(value, userDataPath) {
  const bytes = Buffer.from(value);
  const key = crypto.createHash('md5').update(userDataPath).digest();
  for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= key[index % key.length];
  return `xor:${bytes.toString('base64')}`;
}

test('credentials use current root callbacks rather than retaining replaced nested references', () => {
  const f = fixture();
  f.A.saveSso({ username: 'alice', password: 'old-password' });
  const old = f.getRoot().A;
  f.replaceSecrets('A', { ssoUsername: 'new-alice', ssoPassword: f.A.seal('new-password'), savedCookieEncrypted: f.A.seal('session=new') });
  assert.equal(f.A.getSsoStatus().username, 'new-alice');
  assert.equal(f.A.getSsoPassword(), 'new-password');
  assert.equal(f.A.getCookie(), 'session=new');
  f.A.saveSso({ username: 'third-alice', password: '' });
  assert.equal(old.ssoUsername, 'alice');
  assert.equal(f.A.getSsoPassword(), 'new-password');
});

test('profiles never merge credentials or per-instance ephemeral cookies for matching usernames', () => {
  const f = fixture({ safeStorage: safeStorage(false) });
  f.A.saveSso({ username: 'same-account' });
  f.B.saveSso({ username: 'same-account' });
  assert.equal(f.A.saveCookie('A=secret'), false);
  assert.equal(f.B.getCookie(), '');
  f.B.saveCookie('B=secret');
  assert.equal(f.A.getCookie(), 'A=secret');
  assert.equal(f.B.getCookie(), 'B=secret');
  assert.equal(f.A.getSsoStatus().profileId, 'A');
  assert.equal(f.B.getSsoStatus().profileId, 'B');
  assert.equal(f.getRoot().A.savedCookieEncrypted, '');
});

test('ordinary saves commit first and preserve runtime state on failed or uncertain persistence', () => {
  for (const result of [
    { state: 'not_committed', durable: false, errorCode: 'SETTINGS_SAVE_FAILED' },
    { state: 'committed', durable: false, errorCode: 'SETTINGS_DURABILITY_UNCERTAIN' },
    { state: 'unknown', durable: false, errorCode: 'SETTINGS_COMMIT_UNKNOWN' },
  ]) {
    const f = fixture();
    f.A.saveCookie('session=old');
    f.setResult(result);
    assert.throws(() => f.A.saveCookie('session=new'), { code: result.errorCode });
    assert.equal(f.A.getCookie(), 'session=old');
  }
});

test('true revocation clears runtime immediately even if durable removal fails', () => {
  const f = fixture();
  f.A.saveCookie('session=revoked');
  const oldCipher = f.getRoot().A.savedCookieEncrypted;
  f.setResult({ state: 'not_committed', durable: false, errorCode: 'SETTINGS_SAVE_FAILED' });
  assert.throws(() => f.A.clearCookie(), { code: 'SETTINGS_SAVE_FAILED' });
  assert.equal(f.A.getCookie(), '');
  assert.equal(f.A.ephemeralCookie, '');
  assert.equal(f.getRoot().A.savedCookieEncrypted, oldCipher);
  f.setResult({ state: 'committed', durable: true, errorCode: null });
  f.A.saveSso({ username: 'alice' });
  assert.equal(f.getRoot().A.savedCookieEncrypted, '');
  assert.equal(f.A.getCookie(), '');
  f.A.saveCookie('session=fresh');
  assert.equal(f.A.getCookie(), 'session=fresh');
});

test('credential limits count UTF-8 bytes and reject unsupported username controls', () => {
  const { A } = fixture();
  const maximum = 'x'.repeat(MAX_COOKIE_BYTES);
  assert.equal(validateCookie(maximum), maximum);
  A.saveCookie(maximum);
  assert.throws(() => A.saveCookie(`${maximum}x`), { code: 'CREDENTIAL_LIMIT_EXCEEDED' });
  assert.throws(() => A.saveCookie(null), /cookie must be a string/);
  assert.throws(() => A.saveSso({ username: 'name', password: '🙂'.repeat(MAX_SSO_PASSWORD_BYTES / 4 + 1) }), { code: 'CREDENTIAL_LIMIT_EXCEEDED' });
  for (const username of ['x\n', 'x\t', 'x\u0085', 'x'.repeat(129), 42]) assert.throws(() => A.saveSso({ username }));
  assert.equal(A.saveSso({ username: ' alice ', password: 'password' }).username, 'alice');
});

test('empty password retains existing secret, clearSso removes only its own profile credentials', () => {
  const { A, B } = fixture();
  A.saveSso({ username: 'alice', password: 'old' });
  A.saveCookie('session=A');
  B.saveSso({ username: 'bob', password: 'B-password' });
  A.saveSso({ username: 'alice', password: '' });
  assert.equal(A.getSsoPassword(), 'old');
  assert.equal('password' in A.getSsoStatus(), false);
  A.clearSso();
  assert.equal(A.getSsoPassword(), '');
  assert.equal(A.getSsoStatus().username, '');
  assert.equal(A.getCookie(), 'session=A');
  assert.equal(B.getSsoPassword(), 'B-password');
});

test('unavailable and Linux basic-text backends cannot persist passwords or seal backups', () => {
  for (const storage of [safeStorage(false), {
    ...safeStorage(), getSelectedStorageBackend: () => 'basic_text',
    isEncryptionAvailable: () => process.platform === 'linux',
  }, {
    ...safeStorage(), getSelectedStorageBackend: () => 'unknown',
    isEncryptionAvailable: () => process.platform === 'linux',
  }]) {
    const { A } = fixture({ safeStorage: storage });
    assert.equal(A.isEncryptionAvailable(), false);
    assert.throws(() => A.saveSso({ username: 'alice', password: 'secret' }), { code: 'SECURE_STORAGE_UNAVAILABLE' });
    assert.throws(() => A.seal('backup'), { code: 'SECURE_STORAGE_UNAVAILABLE' });
    assert.throws(() => A.unseal(Buffer.from('cipher').toString('base64')), { code: 'SECURE_STORAGE_UNAVAILABLE' });
  }
});

test('main-only seal/unseal uses the same backend, enforces cipher limits and rejects malformed base64', () => {
  const { A } = fixture();
  assert.equal(A.unseal(A.seal('backup-private-material')), 'backup-private-material');
  assert.throws(() => A.unseal('!!!not-base64!!!'));
  assert.throws(() => A.unseal(Buffer.alloc(MAX_ENCRYPTED_SECRET_BYTES + 1).toString('base64')), { code: 'CREDENTIAL_LIMIT_EXCEEDED' });
  const oversized = fixture({ safeStorage: { ...safeStorage(), encryptString: () => Buffer.alloc(MAX_ENCRYPTED_SECRET_BYTES + 1) } });
  assert.throws(() => oversized.A.seal('small'), { code: 'CREDENTIAL_LIMIT_EXCEEDED' });
});

test('migration encrypts raw cookies and XOR passwords with the original userData key and has no writes', () => {
  const raw = { savedCookie: 'session=raw', ssoUsername: ' alice ', ssoPassword: xorPassword('legacy-password', '/legacy') };
  const source = structuredClone(raw);
  const migrated = CredentialStore.migrateLegacySecrets({ safeStorage: safeStorage(), userDataPath: '/legacy' }, raw);
  const { A } = fixture();
  assert.equal(A.unseal(migrated.secrets.ssoPassword), 'legacy-password');
  assert.equal(A.unseal(migrated.secrets.savedCookieEncrypted), 'session=raw');
  assert.equal(migrated.secrets.ssoUsername, 'alice');
  assert.deepEqual(raw, source);
  A.restoreEphemeralCookie(migrated.ephemeralCookie);
  assert.equal(A.getCookie(), 'session=raw');
});

test('encrypted cookie wins and opaque locked values are preserved without decryption', () => {
  const cipher = Buffer.from('opaque-locked-cipher').toString('base64');
  const storage = { ...safeStorage(false), decryptString: () => assert.fail('No migration decryption') };
  const migrated = CredentialStore.migrateLegacySecrets({ safeStorage: storage, userDataPath: '/legacy' }, {
    savedCookie: 'stale=raw', savedCookieEncrypted: cipher, ssoPassword: cipher,
  });
  assert.equal(migrated.secrets.savedCookieEncrypted, cipher);
  assert.equal(migrated.secrets.ssoPassword, cipher);
  assert.equal(migrated.ephemeralCookie, '');
});

test('without secure storage migration removes XOR and raw disk secrets but returns cookie in memory only', () => {
  const warnings = [];
  const migrated = CredentialStore.migrateLegacySecrets({ safeStorage: safeStorage(false), userDataPath: '/legacy', onWarning: (message) => warnings.push(message) }, {
    savedCookie: 'session=raw', ssoPassword: xorPassword('legacy-password', '/legacy'),
  });
  assert.deepEqual(migrated.secrets, { ssoUsername: '', ssoPassword: '', savedCookieEncrypted: '' });
  assert.equal(migrated.ephemeralCookie, 'session=raw');
  assert.equal(warnings.length, 2);
  assert.equal(warnings.join('').includes('legacy-password'), false);
  assert.equal(warnings.join('').includes('session=raw'), false);
});

test('oversized legacy ciphertext is rejected rather than silently discarded', () => {
  const oversized = Buffer.alloc(MAX_ENCRYPTED_SECRET_BYTES + 1).toString('base64');
  for (const raw of [{ savedCookieEncrypted: oversized }, { ssoPassword: oversized }, { ssoPassword: `xor:${oversized}` }, { savedCookie: 'x'.repeat(MAX_COOKIE_BYTES + 1) }]) {
    assert.throws(() => CredentialStore.migrateLegacySecrets({ safeStorage: safeStorage(), userDataPath: '/legacy' }, raw), { code: 'CREDENTIAL_LIMIT_EXCEEDED' });
  }
});

test('decryption errors expose only fixed warnings and leave root ciphertext unchanged', () => {
  const warnings = [];
  const f = fixture({ safeStorage: { ...safeStorage(), decryptString: () => { throw new Error('contains-secret-and-private-path'); } }, onWarning: (message) => warnings.push(message) });
  f.replaceSecrets('A', { ssoUsername: 'alice', ssoPassword: Buffer.from('secret').toString('base64'), savedCookieEncrypted: Buffer.from('cookie').toString('base64') });
  const original = { ...f.getRoot().A };
  assert.equal(f.A.getCookie(), '');
  assert.equal(f.A.getSsoPassword(), '');
  assert.deepEqual(f.getRoot().A, original);
  assert.equal(warnings.length, 2);
  assert.equal(warnings.join('').includes('contains-secret'), false);
});
