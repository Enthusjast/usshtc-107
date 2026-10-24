const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  SettingsStore, AtomicWriteError, atomicWriteJson, createDefaultRoot, validateRoot,
  validateProfileName, publicSettings, MAX_SETTINGS_FILE_BYTES,
} = require('../../electron/settings-store');
const { CredentialStore, MAX_ENCRYPTED_SECRET_BYTES } = require('../../electron/credential-store');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc107-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'settings.json');
  return { directory, filePath, store: new SettingsStore({ filePath, ...options }) };
}
const failure = () => Object.assign(new Error('Injected I/O failure'), { code: 'EIO' });
const safeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (value) => Buffer.from(`encrypted:${value}`),
  decryptString: (value) => value.toString().replace(/^encrypted:/, ''),
});
function write(filePath, root) { fs.writeFileSync(filePath, JSON.stringify(root)); }
function nextProfile(root, alias = 'usshtc107-2') {
  const profile = structuredClone(root.profiles[0]);
  profile.id = crypto.randomUUID();
  profile.name = 'Second';
  profile.settings.sshAlias = alias;
  return profile;
}

test('fresh schema is complete, has empty isolated secrets and does not create a file on read', (t) => {
  const { store, filePath } = fixture(t);
  const root = store.load();
  assert.deepEqual(root, createDefaultRoot());
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(root.app.launchAtLogin, false);
  assert.equal(root.app.reconnectOnResume, true);
  assert.equal(root.profiles[0].onboarding.status, 'new');
  assert.deepEqual(root.keys, { initialized: false, clientFingerprint: null, hostFingerprint: null });
  assert.equal(root.keyTransaction, null);
  assert.equal(store.isLocked(), false);
  assert.deepEqual(publicSettings(root), { ...root.app, ...root.profiles[0].settings });
});

test('full root validation rejects malformed references, duplicates and additional secret fields', () => {
  const mutations = [
    (root) => { root.activeProfileId = crypto.randomUUID(); },
    (root) => { root.profiles.push(structuredClone(root.profiles[0])); },
    (root) => { root.profiles.push(nextProfile(root, 'USSHTC107')); },
    (root) => { root.profiles[0].secrets.savedCookie = 'plaintext'; },
    (root) => { root.profiles[0].settings.theme = 'light'; },
    (root) => { root.profiles[0].settings.port = '3000'; },
    (root) => { root.profiles[0].onboarding.status = 'unverified'; },
    (root) => { root.keys.initialized = 'true'; },
    (root) => { root.keyTransaction = { phase: 'committed' }; },
    (root) => { root.app.notifyAuth = 'true'; },
  ];
  for (const mutate of mutations) {
    const root = createDefaultRoot();
    mutate(root);
    assert.throws(() => validateRoot(root));
  }
  const root = createDefaultRoot();
  for (let index = 2; index <= 8; index += 1) root.profiles.push(nextProfile(root, `usshtc107-${index}`));
  assert.equal(validateRoot(root), root);
  root.profiles.push(nextProfile(root, 'usshtc107-9'));
  assert.throws(() => validateRoot(root), { code: 'SETTINGS_INVALID' });
});

test('profile names reject controls and bound both characters and UTF-8 bytes', () => {
  assert.equal(validateProfileName('  Account B  '), 'Account B');
  for (const value of ['', ' ', 'x'.repeat(65), 'A\n', '\u0085name', '\u2028name', null]) {
    assert.throws(() => validateProfileName(value), { code: 'PROFILE_NAME_INVALID' });
  }
  assert.equal(validateProfileName('界'.repeat(64)).length, 64);
  assert.equal(validateProfileName('🙂'.repeat(64)), '🙂'.repeat(64));
  assert.throws(() => validateProfileName('🙂'.repeat(65)), { code: 'PROFILE_NAME_INVALID' });
});

test('atomic writes chmod the temporary fd before fsync and rename, then sync the directory', { skip: process.platform === 'win32' }, (t) => {
  const { filePath } = fixture(t);
  const calls = [];
  const io = {
    ...fs,
    fchmodSync: (fd, mode) => { calls.push('chmod-fd'); return fs.fchmodSync(fd, mode); },
    fsyncSync: (fd) => { calls.push(fs.fstatSync(fd).isDirectory() ? 'sync-directory' : 'sync-file'); return fs.fsyncSync(fd); },
    renameSync: (from, to) => { calls.push('rename'); return fs.renameSync(from, to); },
    chmodSync: () => assert.fail('Never chmod the destination after replacement'),
  };
  const root = createDefaultRoot();
  const result = atomicWriteJson(filePath, root, { io, platform: 'linux' });
  assert.deepEqual(calls, ['chmod-fd', 'sync-file', 'rename', 'sync-directory']);
  assert.equal(result.replacement, 'replaced');
  assert.equal(result.durable, true);
  assert.equal(result.contentHash, crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'));
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test('Windows writes never attempt a directory fsync', (t) => {
  const { filePath } = fixture(t);
  const io = { ...fs, fsyncSync: (fd) => { assert.equal(fs.fstatSync(fd).isDirectory(), false); fs.fsyncSync(fd); } };
  assert.equal(atomicWriteJson(filePath, createDefaultRoot(), { io, platform: 'win32' }).durable, true);
});

test('atomic write failures accurately report replacement boundary and candidate hash', { skip: process.platform === 'win32' }, (t) => {
  const { filePath } = fixture(t);
  assert.throws(() => atomicWriteJson(filePath, {}, { io: { ...fs, fchmodSync: () => { throw failure(); } } }),
    (error) => error instanceof AtomicWriteError && error.replacement === 'not_replaced' && /^[a-f0-9]{64}$/.test(error.candidateHash));
  assert.throws(() => atomicWriteJson(filePath, {}, { io: { ...fs, fsyncSync: (fd) => { if (fs.fstatSync(fd).isDirectory()) throw failure(); fs.fsyncSync(fd); } }, platform: 'linux' }),
    (error) => error instanceof AtomicWriteError && error.replacement === 'replaced');
  assert.throws(() => atomicWriteJson(filePath, {}, { io: { ...fs, renameSync: () => { throw failure(); } } }),
    (error) => error instanceof AtomicWriteError && error.replacement === 'unknown');
});

test('post-rename directory failure adopts the committed root and locks until durable reload', { skip: process.platform === 'win32' }, (t) => {
  let failDirectory = false;
  const io = { ...fs, fsyncSync: (fd) => { if (failDirectory && fs.fstatSync(fd).isDirectory()) throw failure(); fs.fsyncSync(fd); } };
  const { store } = fixture(t, { io, platform: 'linux' });
  assert.equal(store.save(createDefaultRoot()).state, 'committed');
  const candidate = structuredClone(store.getRoot());
  candidate.profiles.push(nextProfile(candidate));
  candidate.activeProfileId = candidate.profiles[1].id;
  failDirectory = true;
  assert.deepEqual(store.save(candidate), { state: 'committed', durable: false, errorCode: 'SETTINGS_DURABILITY_UNCERTAIN' });
  assert.equal(store.getRoot().activeProfileId, candidate.activeProfileId);
  assert.equal(store.isLocked(), true);
  assert.equal(store.save(createDefaultRoot()).errorCode, 'SETTINGS_LOCKED');
  assert.throws(() => store.retryLoad());
  failDirectory = false;
  assert.equal(store.retryLoad().activeProfileId, candidate.activeProfileId);
  assert.equal(store.isLocked(), false);
});

test('post-rename read failure reports unknown without adopting or overwriting and retains journal data', { skip: process.platform === 'win32' }, (t) => {
  let fail = false;
  let filePath;
  const io = {
    ...fs,
    fsyncSync: (fd) => { if (fail && fs.fstatSync(fd).isDirectory()) throw failure(); fs.fsyncSync(fd); },
    openSync: (target, flags, mode) => { if (fail && target === filePath && flags === 'r') throw failure(); return fs.openSync(target, flags, mode); },
  };
  const f = fixture(t, { io, platform: 'linux' });
  filePath = f.filePath;
  f.store.save(createDefaultRoot());
  const candidate = structuredClone(f.store.getRoot());
  candidate.profiles[0].settings.port = 4000;
  candidate.keys.initialized = true;
  candidate.keys.clientFingerprint = `SHA256:${'A'.repeat(43)}`;
  const transactionId = crypto.randomUUID();
  candidate.keyTransaction = {
    id: transactionId, target: 'host', phase: 'installed',
    before: { clientFingerprint: candidate.keys.clientFingerprint, hostFingerprint: null },
    after: { clientFingerprint: candidate.keys.clientFingerprint, hostFingerprint: `SHA256:${'B'.repeat(43)}` },
    files: [{
      role: 'host-private', existed: false, oldSha256: null, newSha256: 'a'.repeat(64),
      stageBasename: `proxy_host_ed25519.usshtc107-txn-${transactionId}.new`,
      rollbackBasename: `proxy_host_ed25519.usshtc107-txn-${transactionId}.old`,
    }],
  };
  fail = true;
  assert.deepEqual(f.store.save(candidate), { state: 'unknown', durable: false, errorCode: 'SETTINGS_COMMIT_UNKNOWN' });
  assert.equal(f.store.getRoot().profiles[0].settings.port, 3000);
  assert.equal(JSON.parse(fs.readFileSync(filePath)).profiles[0].settings.port, 4000);
  assert.equal(f.store.save(createDefaultRoot()).errorCode, 'SETTINGS_LOCKED');
  fail = false;
  assert.equal(f.store.retryLoad().profiles[0].settings.port, 4000);
  assert.equal(f.store.getRoot().keys.initialized, true);
  assert.deepEqual(f.store.getRoot().keyTransaction, candidate.keyTransaction);
});

test('a failed rename with old bytes confirmed is not committed and does not mutate memory', (t) => {
  let fail = false;
  const io = { ...fs, renameSync: (from, to) => { if (fail) throw failure(); fs.renameSync(from, to); } };
  const { store, filePath } = fixture(t, { io });
  store.save(createDefaultRoot());
  const previous = fs.readFileSync(filePath);
  const root = structuredClone(store.getRoot());
  root.profiles[0].settings.port = 4000;
  fail = true;
  assert.deepEqual(store.save(root), { state: 'not_committed', durable: false, errorCode: 'SETTINGS_SAVE_FAILED' });
  assert.equal(store.getRoot().profiles[0].settings.port, 3000);
  assert.deepEqual(fs.readFileSync(filePath), previous);
  assert.equal(store.isLocked(), false);
});

test('future, invalid, oversized and invalid-UTF8 sources stay untouched and cannot be overwritten', (t) => {
  const invalid = createDefaultRoot();
  invalid.activeProfileId = 'missing';
  const sources = [JSON.stringify({ schemaVersion: 3 }), JSON.stringify(invalid), Buffer.alloc(MAX_SETTINGS_FILE_BYTES + 1, 0x20), Buffer.from([0xff])];
  for (const source of sources) {
    const { store, filePath, directory } = fixture(t);
    fs.writeFileSync(filePath, source);
    assert.throws(() => store.load());
    assert.equal(store.isLocked(), true);
    assert.deepEqual(store.getRoot().profiles[0].secrets, { ssoUsername: '', ssoPassword: '', savedCookieEncrypted: '' });
    assert.equal(store.save(createDefaultRoot()).errorCode, 'SETTINGS_LOCKED');
    assert.throws(() => store.retryLoad({ allowCorruptRecovery: true }));
    assert.deepEqual(fs.readFileSync(filePath), Buffer.from(source));
    assert.equal(fs.readdirSync(directory).some((name) => name.includes('.corrupt-')), false);
  }
});

test('corrupt JSON recovers only after explicit consent; backups remain private', (t) => {
  const { store, filePath, directory } = fixture(t);
  fs.writeFileSync(filePath, '{invalid json', { mode: 0o644 });
  assert.throws(() => store.load(), { code: 'SETTINGS_RECOVERY_REQUIRED' });
  assert.throws(() => store.retryLoad(), { code: 'SETTINGS_RECOVERY_REQUIRED' });
  assert.equal(fs.readFileSync(filePath, 'utf8'), '{invalid json');
  const backups = fs.readdirSync(directory).filter((name) => name.includes('.corrupt-'));
  assert.equal(backups.length, 1);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(directory, backups[0])).mode & 0o777, 0o600);
  assert.deepEqual(store.retryLoad({ allowCorruptRecovery: true }), createDefaultRoot());
  assert.equal(store.isLocked(), false);
});

test('legacy clean migration uses credential policy, records existing identity and strips old public caches', (t) => {
  const storage = safeStorage();
  const { store, filePath } = fixture(t, {
    migrateLegacySecrets: (raw) => CredentialStore.migrateLegacySecrets({ safeStorage: storage, userDataPath: '/legacy' }, raw),
    inspectExistingIdentity: () => ({ initialized: true, clientFingerprint: `SHA256:${'A'.repeat(43)}`, hostFingerprint: null }),
  });
  write(filePath, { port: 4000, savedCookie: 'session=raw', ssoUsername: 'A', sshPublicKey: 'old-public-cache', sshPublicKeyRaw: 'old-raw-cache' });
  const root = store.load();
  assert.equal(root.profiles[0].settings.port, 4000);
  assert.equal(root.profiles[0].onboarding.status, 'dismissed');
  assert.equal(root.keys.initialized, true);
  assert.equal(root.keys.clientFingerprint, `SHA256:${'A'.repeat(43)}`);
  assert.equal(store.takeMigratedCookie(), 'session=raw');
  assert.equal(store.takeMigratedCookie(), '');
  const text = fs.readFileSync(filePath, 'utf8');
  for (const secret of ['session=raw', 'old-public-cache', 'old-raw-cache', '"savedCookie"']) assert.equal(text.includes(secret), false);
  assert.equal('savedCookie' in root, false);
});

test('locked ciphertext survives migration and wins over stale plaintext cookie', (t) => {
  const ciphertext = Buffer.from('locked-opaque-OS-secret').toString('base64');
  const { store, filePath } = fixture(t, {
    migrateLegacySecrets: (raw) => CredentialStore.migrateLegacySecrets({ safeStorage: safeStorage(false), userDataPath: '/legacy' }, raw),
  });
  write(filePath, { savedCookieEncrypted: ciphertext, savedCookie: 'stale=plaintext', ssoPassword: ciphertext });
  const root = store.load();
  assert.equal(root.profiles[0].secrets.savedCookieEncrypted, ciphertext);
  assert.equal(root.profiles[0].secrets.ssoPassword, ciphertext);
  assert.equal(store.takeMigratedCookie(), '');
  assert.equal(fs.readFileSync(filePath, 'utf8').includes('stale=plaintext'), false);
});

test('migration failures preserve original secret source without plaintext or XOR backup copies', (t) => {
  for (const raw of [
    { savedCookieEncrypted: Buffer.alloc(MAX_ENCRYPTED_SECRET_BYTES + 1).toString('base64'), savedCookie: 'raw=secret' },
    { port: 'invalid', savedCookie: 'raw=secret' },
  ]) {
    const { store, filePath, directory } = fixture(t, {
      migrateLegacySecrets: (value) => CredentialStore.migrateLegacySecrets({ safeStorage: safeStorage(), userDataPath: '/legacy' }, value),
    });
    write(filePath, raw);
    const original = fs.readFileSync(filePath);
    assert.throws(() => store.load());
    assert.equal(store.isLocked(), true);
    assert.deepEqual(fs.readFileSync(filePath), original);
    assert.deepEqual(fs.readdirSync(directory), ['settings.json']);
  }
});

test('the aggregate root size limit applies even with individually permitted ciphertext', (t) => {
  const { store, filePath } = fixture(t);
  const root = createDefaultRoot();
  const cipher = Buffer.alloc(MAX_ENCRYPTED_SECRET_BYTES).toString('base64');
  root.profiles[0].secrets.ssoPassword = cipher;
  root.profiles[0].secrets.savedCookieEncrypted = cipher;
  root.profiles.push(nextProfile(root));
  assert.deepEqual(store.save(root), { state: 'not_committed', durable: false, errorCode: 'SETTINGS_FILE_TOO_LARGE' });
  assert.equal(fs.existsSync(filePath), false);
});

test('migration rename failure keeps the original source and never creates a secret backup', (t) => {
  const { store, filePath, directory } = fixture(t, {
    io: { ...fs, renameSync: () => { throw failure(); } },
    migrateLegacySecrets: (raw) => CredentialStore.migrateLegacySecrets({ safeStorage: safeStorage(), userDataPath: '/legacy' }, raw),
  });
  write(filePath, { savedCookie: 'session=plaintext' });
  const original = fs.readFileSync(filePath);
  assert.throws(() => store.load(), { code: 'SETTINGS_SAVE_FAILED' });
  assert.deepEqual(fs.readFileSync(filePath), original);
  assert.deepEqual(fs.readdirSync(directory), ['settings.json']);
  assert.equal(store.takeMigratedCookie(), '');
  assert.equal(store.getRoot().profiles[0].secrets.savedCookieEncrypted, '');
});

test('committed but non-durable legacy migration adopts only the clean root and stays locked', { skip: process.platform === 'win32' }, (t) => {
  const { store, filePath, directory } = fixture(t, {
    platform: 'linux',
    io: { ...fs, fsyncSync: (fd) => { if (fs.fstatSync(fd).isDirectory()) throw failure(); fs.fsyncSync(fd); } },
    migrateLegacySecrets: (raw) => CredentialStore.migrateLegacySecrets({ safeStorage: safeStorage(), userDataPath: '/legacy' }, raw),
  });
  write(filePath, { savedCookie: 'session=plaintext' });
  assert.throws(() => store.load(), { code: 'SETTINGS_DURABILITY_UNCERTAIN' });
  assert.equal(store.getRoot().schemaVersion, 2);
  assert.notEqual(store.getRoot().profiles[0].secrets.savedCookieEncrypted, '');
  assert.equal(fs.readFileSync(filePath, 'utf8').includes('session=plaintext'), false);
  assert.deepEqual(fs.readdirSync(directory), ['settings.json']);
  assert.equal(store.takeMigratedCookie(), '');
  assert.equal(store.save(createDefaultRoot()).errorCode, 'SETTINGS_LOCKED');
});

test('retry reload unlocks repaired roots but never treats a removed uncertain root as fresh', (t) => {
  const { store, filePath } = fixture(t);
  write(filePath, { schemaVersion: 99 });
  assert.throws(() => store.load(), { code: 'SETTINGS_VERSION_UNSUPPORTED' });
  fs.unlinkSync(filePath);
  assert.throws(() => store.retryLoad(), { code: 'SETTINGS_VERSION_UNSUPPORTED' });
  assert.equal(store.isLocked(), true);
  const root = createDefaultRoot();
  root.profiles[0].settings.port = 4001;
  write(filePath, root);
  assert.equal(store.retryLoad().profiles[0].settings.port, 4001);
  assert.equal(store.isLocked(), false);
});

test('cached legacy public identity is retained as initialized even when inspection finds missing files', (t) => {
  const { store, filePath } = fixture(t, {
    inspectExistingIdentity: () => ({ initialized: false, clientFingerprint: null, hostFingerprint: null }),
  });
  write(filePath, { sshPublicKey: 'prior-identity' });
  assert.equal(store.load().keys.initialized, true);
  assert.equal(fs.readFileSync(filePath, 'utf8').includes('prior-identity'), false);
});
