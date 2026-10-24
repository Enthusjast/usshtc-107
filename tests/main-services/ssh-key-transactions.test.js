'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { SettingsStore, validateRoot } = require('../../electron/settings-store');
const { CredentialStore } = require('../../electron/credential-store');
const { createSshKeyService, openSshEd25519PublicKey } = require('../../electron/ssh-key-service');

const ioError = () => Object.assign(new Error('fixture filesystem failure'), { code: 'EIO' });
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const generate = () => crypto.generateKeyPairSync('ed25519', {
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' },
}).privateKey;

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc-key-transactions-'));
  const sshDirectory = path.join(directory, 'ssh');
  fs.mkdirSync(sshDirectory, { mode: 0o700 });
  const hostKeyPath = path.join(directory, 'proxy_host_ed25519');
  const knownHosts = path.join(sshDirectory, 'known_hosts');
  fs.writeFileSync(knownHosts, 'fixture known hosts must remain unchanged\n');
  const knownHostsHash = sha256(fs.readFileSync(knownHosts));
  t.after(() => {
    try { assert.equal(sha256(fs.readFileSync(knownHosts)), knownHostsHash); }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  const filePath = path.join(directory, 'settings.json');
  const store = new SettingsStore({ filePath, defaults: { autoConnect: false }, io: options.rootIo || fs });
  store.load();
  assert.equal(store.save(store.getRoot()).durable, true);
  let available = true;
  const backendKey = crypto.randomBytes(32);
  const credential = new CredentialStore({ profileId: 'default', userDataPath: directory,
    readSecrets: () => store.getRoot().profiles[0].secrets,
    commitSecrets: () => { throw new Error('backup must not write profile secrets'); },
    safeStorage: {
      isEncryptionAvailable: () => available,
      encryptString(value) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', backendKey, iv);
        const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
      },
      decryptString(bytes) {
        const cipher = crypto.createDecipheriv('aes-256-gcm', backendKey, bytes.subarray(0, 12), { authTagLength: 16 });
        cipher.setAuthTag(bytes.subarray(12, 28));
        return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
      },
    },
  });
  const backupPath = path.join(directory, 'backup.json');
  let saveSelection = { canceled: false, filePath: backupPath };
  let openSelection = { canceled: false, filePaths: [backupPath] };
  const calls = [];
  const serviceOptions = { sshDirectory, hostKeyPath, io: options.io || fs,
    readRoot: () => store.getRoot(), isLocked: () => store.isLocked(),
    commitRoot: (candidate) => {
      calls.push(['root', candidate.keyTransaction?.phase || 'clear']);
      return options.commitRoot ? options.commitRoot(candidate, store) : store.save(candidate);
    },
    reloadRoot: () => { calls.push(['reload']); return store.retryLoad(); },
    seal: (value) => credential.seal(value), unseal: (value) => credential.unseal(value),
    isEncryptionAvailable: () => credential.isEncryptionAvailable(),
    dialog: {
      showSaveDialog: async () => { calls.push(['save-dialog']); return saveSelection; },
      showOpenDialog: async () => { calls.push(['open-dialog']); return openSelection; },
    },
    getWindow: () => ({ fixture: true }),
  };
  const service = createSshKeyService(serviceOptions);
  const files = { client: path.join(sshDirectory, 'usshtc107_ed25519'),
    public: path.join(sshDirectory, 'usshtc107_ed25519.pub'), host: hostKeyPath };
  const readKeys = () => Object.fromEntries(Object.entries(files).map(([role, file]) => [role, fs.readFileSync(file)]));
  const context = (overrides = {}) => ({
    assertCurrent: () => {},
    beforeInstall: async () => { calls.push(['stop-original']); },
    startCandidate: async ({ transactionId, keyMaterial }) => {
      assert.equal(store.getRoot().keyTransaction.phase, 'installed');
      assert.equal(store.getRoot().keyTransaction.id, transactionId);
      assert.equal(keyMaterial.authorizedKey.length, 32);
      calls.push(['candidate']);
      return {};
    },
    activateCandidate: async (id) => {
      const root = store.getRoot();
      assert.equal(root.keyTransaction.phase, 'committed');
      assert.equal(root.keyTransaction.id, id);
      assert.equal(store.isLocked(), false);
      assert.equal(root.keys.clientFingerprint, service.inspect().client.fingerprint);
      calls.push(['activate']);
    },
    stopCandidate: async () => { calls.push(['stop-candidate']); },
    restoreOriginal: async () => { service.assertReady(); calls.push(['restore']); },
    ...overrides,
  });
  return { service, store, files, serviceOptions, calls, backupPath, directory, sshDirectory, hostKeyPath,
    readKeys, context, credential,
    setAvailable: (value) => { available = value; },
    setSaveSelection: (value) => { saveSelection = value; },
    setOpenSelection: (value) => { openSelection = value; },
  };
}

test('fresh identities are durable before initialization and public inspection never writes', (t) => {
  const operations = [];
  const io = { ...fs,
    fsyncSync(fd) { operations.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); fs.fsyncSync(fd); },
  };
  const f = fixture(t, { io, commitRoot(candidate, store) {
    if (candidate.keys.initialized) {
      assert.equal(operations.filter((item) => item === 'file').length, 3);
      if (process.platform !== 'win32') assert.equal(operations.filter((item) => item === 'directory').length, 3);
    }
    return store.save(candidate);
  } });
  assert.equal(f.service.inspect().client.state, 'missing');
  assert.equal(operations.length, 0);
  const value = f.service.initialize();
  assert.equal(value.scope, 'application');
  assert.equal(value.recoveryRequired, false);
  assert.equal(f.store.getRoot().keys.clientFingerprint, value.client.fingerprint);
  assert.match(fs.readFileSync(f.files.client, 'utf8'), /BEGIN PRIVATE KEY/);
  const before = f.readKeys();
  assert.deepEqual(f.service.inspect(), value);
  assert.deepEqual(f.readKeys(), before);
  assert.equal(JSON.stringify(value).includes('PRIVATE KEY'), false);
  assert.equal(f.service.getKeyMaterial().authorizedKey.length, 32);
});

test('initialized identities cannot silently regenerate missing or unexpectedly changed files', (t) => {
  const f = fixture(t);
  f.service.initialize();
  fs.unlinkSync(f.files.client);
  assert.throws(() => f.service.initialize(), { code: 'SSH_KEY_MISSING' });
  assert.equal(fs.existsSync(f.files.client), false);
  fs.writeFileSync(f.files.client, generate(), { mode: 0o600 });
  const changed = fs.readFileSync(f.files.client);
  assert.throws(() => f.service.initialize(), { code: 'SSH_KEY_FINGERPRINT_MISMATCH' });
  assert.deepEqual(fs.readFileSync(f.files.client), changed);
});

test('existing public file or cached identity is never treated as fresh', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.files.public, 'existing public identity\n');
  assert.throws(() => f.service.initialize(), { code: 'SSH_KEY_MISSING' });
  assert.equal(fs.existsSync(f.files.client), false);
  fs.unlinkSync(f.files.public);
  f.store.save({ ...f.store.getRoot(), keys: { initialized: true, clientFingerprint: null, hostFingerprint: null } });
  assert.throws(() => f.service.initialize(), { code: 'SSH_KEY_MISSING' });
  assert.equal(fs.existsSync(f.files.host), false);
});

test('locked storage rejects initialization, backup and plans without creating files', async (t) => {
  const f = fixture(t);
  const service = createSshKeyService({ ...f.serviceOptions, isLocked: () => true });
  assert.throws(() => service.initialize(), { code: 'SETTINGS_LOCKED' });
  assert.throws(() => service.prepareRebuild(), { code: 'SETTINGS_LOCKED' });
  await assert.rejects(service.exportBackup(), { code: 'SETTINGS_LOCKED' });
  assert.equal(fs.existsSync(f.files.client), false);
});

test('legacy host conversion preserves its seed while retaining the real PKCS8 client', (t) => {
  const f = fixture(t);
  const client = generate(), host = generate();
  fs.writeFileSync(f.files.client, client, { mode: 0o600 });
  fs.writeFileSync(f.files.host, host, { mode: 0o600 });
  const clientFingerprint = openSshEd25519PublicKey(client).fingerprint;
  const hostFingerprint = openSshEd25519PublicKey(host).fingerprint;
  f.store.save({ ...f.store.getRoot(), keys: { initialized: true, clientFingerprint, hostFingerprint } });
  f.service.initialize();
  assert.equal(f.service.inspect().host.fingerprint, hostFingerprint);
  assert.match(fs.readFileSync(f.files.host, 'utf8'), /BEGIN OPENSSH PRIVATE KEY/);
  assert.equal(fs.readFileSync(f.files.client, 'utf8'), client);
  assert.equal(f.service.getSsh2ClientIdentity().fingerprint, clientFingerprint);
});

for (const target of ['client', 'host', 'both']) {
  test(`rotation ${target} backs up before stop and commits fingerprints before admission`, async (t) => {
    const f = fixture(t);
    f.service.initialize();
    const old = f.readKeys();
    const before = { ...f.store.getRoot().keys };
    f.calls.length = 0;
    const plan = f.service.prepareRotate(target);
    const summary = f.service.summary(plan);
    assert.equal(summary.target, target);
    assert.deepEqual(Object.keys(plan), []);
    const result = await f.service.execute(plan, f.context());
    assert.equal(result.recoveryRequired, false);
    assert.deepEqual(f.calls.map(([name, phase]) => name === 'root' ? phase : name),
      ['save-dialog', 'stop-original', 'prepared', 'installed', 'candidate', 'committed', 'activate', 'clear']);
    assert.equal(f.store.getRoot().keyTransaction, null);
    assert.equal(result.client.fingerprint === before.clientFingerprint, target === 'host');
    assert.equal(result.host.fingerprint === before.hostFingerprint, target === 'client');
    if (target === 'host') assert.deepEqual(fs.readFileSync(f.files.client), old.client);
    if (target === 'client') assert.deepEqual(fs.readFileSync(f.files.host), old.host);
    if (process.platform !== 'win32') {
      for (const file of [f.backupPath, ...Object.values(f.files)]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
    assert.equal(fs.readdirSync(f.sshDirectory).some((name) => name.includes('.usshtc107-txn-')), false);
  });
}

test('backup cancellation and unavailable backend leave identities and listener untouched', async (t) => {
  const f = fixture(t);
  f.service.initialize();
  const old = f.readKeys();
  f.calls.length = 0;
  f.setSaveSelection({ canceled: true });
  assert.deepEqual(await f.service.execute(f.service.prepareRotate(), f.context()), { cancelled: true });
  assert.deepEqual(f.readKeys(), old);
  assert.deepEqual(f.calls, [['save-dialog']]);
  f.setAvailable(false);
  await assert.rejects(f.service.execute(f.service.prepareRotate(), f.context()), { code: 'SECURE_STORAGE_UNAVAILABLE' });
  await assert.rejects(f.service.prepareImport(), { code: 'SECURE_STORAGE_UNAVAILABLE' });
  assert.deepEqual(f.readKeys(), old);
});

test('encrypted backup roundtrip verifies both actual private identities and restores them', async (t) => {
  const f = fixture(t);
  f.service.initialize();
  const original = f.readKeys();
  const expected = { ...f.store.getRoot().keys };
  await f.service.exportBackup();
  const originalBackup = fs.readFileSync(f.backupPath);
  const envelope = JSON.parse(originalBackup);
  assert.deepEqual(Object.keys(envelope).sort(), ['ciphertext', 'format', 'schemaVersion']);
  assert.equal(originalBackup.includes('PRIVATE KEY'), false);
  await f.service.execute(f.service.prepareRotate('both'), f.context());
  fs.writeFileSync(f.backupPath, originalBackup);
  const plan = await f.service.prepareImport();
  assert.deepEqual(f.service.summary(plan).after, { clientFingerprint: expected.clientFingerprint, hostFingerprint: expected.hostFingerprint });
  await f.service.execute(plan, f.context());
  assert.deepEqual(f.readKeys(), original);
  assert.deepEqual(f.store.getRoot().keys, expected);
});

test('backup metadata mismatch, ciphertext tamper, cross-backend and excess sizes never mutate keys', async (t) => {
  const f = fixture(t);
  f.service.initialize();
  await f.service.exportBackup();
  const original = f.readKeys();
  const valid = JSON.parse(fs.readFileSync(f.backupPath));
  const pair = JSON.parse(f.credential.unseal(valid.ciphertext));
  const badFingerprint = { ...valid, ciphertext: f.credential.seal(JSON.stringify({ ...pair, clientFingerprint: pair.hostFingerprint })) };
  const badType = { ...valid, ciphertext: f.credential.seal(JSON.stringify({ ...pair, clientPrivateKey: 'invalid private key' })) };
  const cases = [JSON.stringify(badFingerprint), JSON.stringify(badType),
    JSON.stringify({ ...valid, ciphertext: Buffer.from('foreign backend ciphertext').toString('base64') }),
    JSON.stringify({ ...valid, ciphertext: `${valid.ciphertext.slice(0, -8)}AAAAAAAA` }),
    JSON.stringify({ ...valid, ciphertext: Buffer.alloc(256 * 1024 + 1).toString('base64') }),
    ' '.repeat(512 * 1024 + 1)];
  for (const bytes of cases) {
    fs.writeFileSync(f.backupPath, bytes);
    await assert.rejects(f.service.prepareImport(), { code: 'KEY_BACKUP_INVALID' });
    assert.deepEqual(f.readKeys(), original);
    assert.equal(f.store.getRoot().keyTransaction, null);
  }
  const service = createSshKeyService({ ...f.serviceOptions, unseal: () => ' '.repeat(64 * 1024 + 1) });
  fs.writeFileSync(f.backupPath, JSON.stringify(valid));
  await assert.rejects(service.prepareImport(), { code: 'KEY_BACKUP_INVALID' });
});

test('backup native cancellation and forbidden destinations never overwrite identity or trust files', async (t) => {
  const f = fixture(t);
  f.service.initialize();
  const original = f.readKeys();
  f.setOpenSelection({ canceled: true, filePaths: [] });
  assert.deepEqual(await f.service.prepareImport(), { cancelled: true });
  for (const destination of [...Object.values(f.files), path.join(f.sshDirectory, 'known_hosts')]) {
    f.setSaveSelection({ canceled: false, filePath: destination });
    await assert.rejects(f.service.exportBackup(), { code: 'KEY_BACKUP_INVALID' });
    assert.deepEqual(f.readKeys(), original);
  }
});

for (const state of ['missing', 'invalid']) {
  test(`explicit ${state} client rebuild does not pretend to back up an unusable key`, async (t) => {
    const f = fixture(t);
    f.service.initialize();
    if (state === 'missing') fs.unlinkSync(f.files.client);
    else fs.writeFileSync(f.files.client, 'not a private key', { mode: 0o600 });
    f.calls.length = 0;
    await f.service.execute(f.service.prepareRebuild('client'), f.context());
    assert.equal(f.calls.some(([name]) => name === 'save-dialog'), false);
    assert.equal(f.service.inspect().recoveryRequired, false);
  });
}

for (const phase of ['prepared', 'installed', 'committed']) {
  test(`known not-committed ${phase} root failure rolls back exact bytes and restores original listener`, async (t) => {
    let failed = false;
    const f = fixture(t, { commitRoot(candidate, store) {
      if (!failed && candidate.keyTransaction?.phase === phase) {
        failed = true;
        return { state: 'not_committed', durable: false, errorCode: 'SETTINGS_SAVE_FAILED' };
      }
      return store.save(candidate);
    } });
    f.service.initialize();
    const before = f.readKeys();
    await assert.rejects(f.service.execute(f.service.prepareRotate('both'), f.context()), { code: 'SETTINGS_SAVE_FAILED' });
    assert.deepEqual(f.readKeys(), before);
    assert.equal(f.store.getRoot().keyTransaction, null);
    assert.equal(f.calls.filter(([name]) => name === 'restore').length, 1);
    assert.equal(f.calls.some(([name]) => name === 'activate'), false);
  });
}

for (const role of ['client-private', 'client-public', 'host-private']) {
  for (const operation of ['stage-write', 'rollback-write', 'file-fsync', 'rename', 'directory-fsync']) {
    test(`${role} ${operation} failure rolls back known bytes without touching known_hosts`,
      { skip: operation === 'directory-fsync' && process.platform === 'win32' }, async (t) => {
      let armed = false, fired = false;
      const tracked = new Map();
      const roleBasename = role === 'client-private' ? 'usshtc107_ed25519'
        : role === 'client-public' ? 'usshtc107_ed25519.pub' : 'proxy_host_ed25519';
      const match = (file) => String(file).includes(`${roleBasename}.usshtc107-txn-`);
      let installedDirectory = null;
      const io = { ...fs,
        openSync(file, ...args) { const fd = fs.openSync(file, ...args); tracked.set(fd, String(file)); return fd; },
        closeSync(fd) { tracked.delete(fd); return fs.closeSync(fd); },
        writeFileSync(fd, ...args) {
          const file = tracked.get(fd);
          if (armed && !fired && match(file) && (operation === 'stage-write' && file.endsWith('.new')
              || operation === 'rollback-write' && file.endsWith('.old'))) { fired = true; throw ioError(); }
          return fs.writeFileSync(fd, ...args);
        },
        fsyncSync(fd) {
          const file = tracked.get(fd);
          if (armed && !fired && (operation === 'file-fsync' && match(file)
              || operation === 'directory-fsync' && file === installedDirectory)) { fired = true; throw ioError(); }
          return fs.fsyncSync(fd);
        },
        renameSync(source, destination) {
          if (armed && !fired && operation === 'rename' && match(source)) { fired = true; throw ioError(); }
          const result = fs.renameSync(source, destination);
          if (armed && match(source)) installedDirectory = path.dirname(destination);
          return result;
        },
      };
      const f = fixture(t, { io });
      f.service.initialize();
      const original = f.readKeys();
      armed = true;
      await assert.rejects(f.service.execute(f.service.prepareRotate('both'), f.context()), { code: 'KEY_TRANSACTION_FAILED' });
      assert.equal(fired, true);
      assert.deepEqual(f.readKeys(), original);
      assert.equal(f.store.getRoot().keyTransaction, null);
      assert.equal(f.calls.filter(([name]) => name === 'restore').length, 1);
    });
  }
}

for (const unknown of [false, true]) {
  test(`committed root rename then directory fsync ${unknown ? 'and readback ' : ''}failure never rolls back new identity`,
    { skip: process.platform === 'win32' }, async (t) => {
    let armed = false, renamed = false, readFailure = false;
    const tracked = new Map();
    const rootIo = { ...fs,
      openSync(file, ...args) { const fd = fs.openSync(file, ...args); tracked.set(fd, String(file)); return fd; },
      closeSync(fd) { tracked.delete(fd); return fs.closeSync(fd); },
      renameSync(source, destination) {
        const root = JSON.parse(fs.readFileSync(source, 'utf8'));
        const result = fs.renameSync(source, destination);
        if (armed && root.keyTransaction?.phase === 'committed') renamed = true;
        return result;
      },
      fsyncSync(fd) {
        if (renamed && fs.fstatSync(fd).isDirectory()) {
          renamed = false;
          readFailure = unknown;
          throw ioError();
        }
        return fs.fsyncSync(fd);
      },
      readSync(fd, ...args) {
        if (readFailure && tracked.get(fd)?.endsWith('settings.json')) throw ioError();
        return fs.readSync(fd, ...args);
      },
    };
    const f = fixture(t, { rootIo });
    f.service.initialize();
    const before = f.readKeys();
    armed = true;
    const plan = f.service.prepareRotate('both');
    const after = f.service.summary(plan).after;
    await assert.rejects(f.service.execute(plan, f.context()),
      { code: unknown ? 'SETTINGS_COMMIT_UNKNOWN' : 'SETTINGS_DURABILITY_UNCERTAIN' });
    assert.equal(f.calls.some(([name]) => name === 'activate'), false);
    assert.equal(f.calls.some(([name]) => name === 'restore'), false);
    assert.equal(f.calls.some(([name]) => name === 'stop-candidate'), true);
    assert.notDeepEqual(f.readKeys(), before);
    const diskRoot = JSON.parse(fs.readFileSync(path.join(f.directory, 'settings.json')));
    assert.equal(diskRoot.keyTransaction.phase, 'committed');
    assert.equal(diskRoot.keys.clientFingerprint, after.clientFingerprint);
    for (const file of diskRoot.keyTransaction.files) {
      const base = file.role === 'host-private' ? f.directory : f.sshDirectory;
      assert.equal(fs.existsSync(path.join(base, file.rollbackBasename)), true);
    }
    readFailure = false;
    f.store.retryLoad();
    const restarted = createSshKeyService(f.serviceOptions);
    restarted.initialize();
    assert.equal(restarted.inspect().client.fingerprint, after.clientFingerprint);
    assert.equal(restarted.inspect().host.fingerprint, after.hostFingerprint);
    assert.equal(f.store.getRoot().keyTransaction, null);
  });
}

for (const phase of ['prepared', 'installed']) {
  for (const installedFiles of [0, 1, 2, 3]) {
    test(`restart of ${phase} with ${installedFiles} new files rolls back verified hashes before inspection`, async (t) => {
      const f = fixture(t);
      f.service.initialize();
      const before = f.readKeys();
      const abort = new AbortController();
      let newBytes;
      const executeContext = f.context({ signal: abort.signal });
      if (phase === 'installed') executeContext.startCandidate = async () => {
        const snapshot = f.readKeys();
        newBytes = { 'client-private': snapshot.client, 'client-public': snapshot.public, 'host-private': snapshot.host };
        abort.abort();
        throw Object.assign(new Error('abort'), { code: 'OPERATION_CANCELLED' });
      };
      else {
        const originalCommit = f.serviceOptions.commitRoot;
        f.serviceOptions.commitRoot = (candidate) => {
          const result = originalCommit(candidate);
          if (candidate.keyTransaction?.phase === 'prepared') abort.abort();
          return result;
        };
      }
      const service = createSshKeyService(f.serviceOptions);
      await assert.rejects(service.execute(service.prepareRotate('both'), executeContext), { code: 'OPERATION_CANCELLED' });
      const transaction = f.store.getRoot().keyTransaction;
      assert.equal(transaction.phase, phase);
      assert.equal(f.calls.some(([name]) => name === 'restore'), false);
      // Recreate each observable crash point, including partial installation before the installed root write.
      for (const file of transaction.files.slice(0, installedFiles)) {
        const directory = file.role === 'host-private' ? f.directory : f.sshDirectory;
        const destination = file.role === 'client-private' ? f.files.client
          : file.role === 'client-public' ? f.files.public : f.files.host;
        if (phase === 'prepared') fs.renameSync(path.join(directory, file.stageBasename), destination);
        else fs.writeFileSync(destination, newBytes[file.role], { mode: 0o600 });
      }
      f.serviceOptions.commitRoot = (candidate) => f.store.save(candidate);
      f.store.retryLoad();
      createSshKeyService(f.serviceOptions).initialize();
      assert.deepEqual(f.readKeys(), before);
      assert.equal(f.store.getRoot().keyTransaction, null);
    });
  }
}

test('unrecognized installed bytes or required missing rollback lock recovery without overwriting them', async (t) => {
  for (const corruption of ['unknown-target', 'missing-rollback']) {
    const f = fixture(t);
    f.service.initialize();
    const abort = new AbortController();
    await assert.rejects(f.service.execute(f.service.prepareRotate(), f.context({ signal: abort.signal,
      startCandidate: async () => {
        const transaction = f.store.getRoot().keyTransaction;
        const file = transaction.files[0];
        if (corruption === 'unknown-target') fs.writeFileSync(f.files.client, 'unrecognized external edit');
        else fs.unlinkSync(path.join(f.sshDirectory, file.rollbackBasename));
        abort.abort();
        throw Object.assign(new Error('abort'), { code: 'OPERATION_CANCELLED' });
      },
    })), { code: 'KEY_ROLLBACK_FAILED' });
    const preserved = fs.readFileSync(f.files.client);
    const restarted = createSshKeyService(f.serviceOptions);
    assert.throws(() => restarted.initialize(), { code: 'KEY_ROLLBACK_FAILED' });
    assert.deepEqual(fs.readFileSync(f.files.client), preserved);
    assert.equal(restarted.inspect().recoveryRequired, true);
  }
});

test('journal validation rejects path injection, missing roles, mismatched root identities and target drift', async (t) => {
  const f = fixture(t);
  f.service.initialize();
  const abort = new AbortController();
  await assert.rejects(f.service.execute(f.service.prepareRotate(), f.context({ signal: abort.signal,
    startCandidate: async () => { abort.abort(); throw Object.assign(new Error('abort'), { code: 'OPERATION_CANCELLED' }); },
  })), { code: 'OPERATION_CANCELLED' });
  const original = f.store.getRoot();
  for (const mutate of [
    (root) => { root.keyTransaction.files[0].stageBasename = '../arbitrary'; },
    (root) => { root.keyTransaction.files.pop(); },
    (root) => { root.keys.clientFingerprint = root.keyTransaction.after.clientFingerprint; },
    (root) => { root.keyTransaction.after.hostFingerprint = root.keyTransaction.after.clientFingerprint; },
    (root) => { root.keyTransaction.after.clientFingerprint = null; },
  ]) {
    const candidate = structuredClone(original);
    mutate(candidate);
    assert.throws(() => validateRoot(candidate), { code: 'SETTINGS_INVALID' });
  }
});

test('real candidate TCP gate rejects SSH before committed root and authenticates only the durable new identity', async (t) => {
  const net = require('node:net');
  const { Client, utils } = require('ssh2');
  const { ProxyServer } = require('../../electron/proxy-server');
  const { createProxyController } = require('../../electron/proxy-controller');
  const f = fixture(t);
  f.service.initialize();
  const oldIdentity = f.service.getSsh2ClientIdentity();
  let bound, server, websocketRequests = 0;
  const scope = { profileId: 'default', epoch: 1 };
  const controller = createProxyController({
    createServer(options) {
      server = new ProxyServer({ ...options, webSocketFactory() { websocketRequests += 1; throw new Error('No remote requests permitted'); } });
      server.once('started', (address) => { bound = address; });
      return server;
    },
    getKeyMaterial: () => f.service.getKeyMaterial(),
    isTransactionCommitted: (id) => !f.store.isLocked() && f.store.getRoot().keyTransaction?.id === id
      && f.store.getRoot().keyTransaction.phase === 'committed',
  });
  controller.setScope(scope);
  t.after(() => controller.dispose());
  await f.service.execute(f.service.prepareRotate('both'), f.context({
    async startCandidate({ transactionId, keyMaterial }) {
      await controller.startCandidate({ transactionId, keyMaterial, scope, cookie: '',
        config: { host: '127.0.0.1', port: 0, cluster: 'training' } });
      assert.equal(f.store.getRoot().keyTransaction.phase, 'installed');
      await new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port: bound.port });
        let received = 0;
        socket.setTimeout(2000, () => socket.destroy(new Error('Candidate gate did not close TCP')));
        socket.on('data', (bytes) => { received += bytes.length; });
        socket.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error); });
        socket.on('close', () => { assert.equal(received, 0); resolve(); });
      });
      assert.equal(server.getStats().sessionCount, 0);
      assert.equal(controller.getStats().sessions.length, 0);
      return {};
    },
    activateCandidate: (id) => controller.activateCandidate(id),
    stopCandidate: () => controller.stop('key_transaction_failed'),
  }));
  const material = f.service.getKeyMaterial();
  const expectedHost = utils.parseKey(material.hostKey).getPublicSSH();
  const authenticate = (identity) => new Promise((resolve, reject) => {
    const client = new Client();
    client.once('ready', () => { client.end(); resolve(); });
    client.once('error', reject);
    client.connect({ host: '127.0.0.1', port: bound.port, username: 'fixture',
      privateKey: identity.privateKey, hostVerifier: (wire) => wire.equals(expectedHost), readyTimeout: 2000 });
  });
  await assert.rejects(authenticate(oldIdentity), /authentication methods failed/i);
  await authenticate(f.service.getSsh2ClientIdentity());
  assert.equal(websocketRequests, 0);
  await controller.dispose();
});

for (const phase of ['prepared', 'installed']) {
  for (const outcome of ['committed', 'unknown']) {
    test(`${phase} ${outcome} uncertain root result is reloaded before safe rollback`, async (t) => {
      let injected = false;
      const f = fixture(t, { commitRoot(candidate, store) {
        const result = store.save(candidate);
        if (!injected && candidate.keyTransaction?.phase === phase) {
          injected = true;
          return { state: outcome, durable: false, errorCode: outcome === 'unknown'
            ? 'SETTINGS_COMMIT_UNKNOWN' : 'SETTINGS_DURABILITY_UNCERTAIN' };
        }
        return result;
      } });
      f.service.initialize();
      const before = f.readKeys();
      await assert.rejects(f.service.execute(f.service.prepareRotate('both'), f.context()),
        { code: outcome === 'unknown' ? 'SETTINGS_COMMIT_UNKNOWN' : 'SETTINGS_DURABILITY_UNCERTAIN' });
      assert.deepEqual(f.readKeys(), before);
      assert.equal(f.store.getRoot().keyTransaction, null);
      assert.ok(f.calls.findIndex(([name]) => name === 'reload') < f.calls.findIndex(([name]) => name === 'restore'));
      assert.equal(f.calls.some(([name]) => name === 'activate'), false);
    });
  }
}

test('failed activation retains committed identity and journal until verified recovery, never old-listener restoration', async (t) => {
  const f = fixture(t);
  f.service.initialize();
  const plan = f.service.prepareRotate('both');
  const expected = f.service.summary(plan).after;
  await assert.rejects(f.service.execute(plan, f.context({ activateCandidate: async () => { throw ioError(); } })),
    { code: 'KEY_TRANSACTION_FAILED' });
  assert.equal(f.store.getRoot().keyTransaction.phase, 'committed');
  assert.equal(f.calls.some(([name]) => name === 'restore'), false);
  assert.equal(f.calls.some(([name]) => name === 'stop-candidate'), true);
  assert.throws(() => f.service.assertReady(), { code: 'KEY_TRANSACTION_FAILED' });
  f.service.initialize();
  assert.equal(f.service.inspect().client.fingerprint, expected.clientFingerprint);
  assert.equal(f.service.inspect().host.fingerprint, expected.hostFingerprint);
  assert.equal(f.store.getRoot().keyTransaction, null);
});

test('oversized or failing encryption cannot interrupt a healthy listener', async (t) => {
  const f = fixture(t);
  f.service.initialize();
  const original = f.readKeys();
  for (const seal of [() => Buffer.alloc(256 * 1024 + 1).toString('base64'), () => { throw ioError(); }]) {
    const service = createSshKeyService({ ...f.serviceOptions, seal });
    await assert.rejects(service.execute(service.prepareRotate(), f.context()), { code: 'KEY_BACKUP_INVALID' });
    assert.deepEqual(f.readKeys(), original);
  }
  assert.equal(f.calls.some(([name]) => name === 'stop-original'), false);
});

test('explicit missing-key rebuild remains possible without secure storage and removes only application new files on rollback', async (t) => {
  let failCommit = false;
  const f = fixture(t, { commitRoot(candidate, store) {
    if (failCommit && candidate.keyTransaction?.phase === 'installed') {
      failCommit = false;
      return { state: 'not_committed', durable: false, errorCode: 'SETTINGS_SAVE_FAILED' };
    }
    return store.save(candidate);
  } });
  f.service.initialize();
  fs.unlinkSync(f.files.client);
  fs.unlinkSync(f.files.public);
  const host = fs.readFileSync(f.files.host);
  f.setAvailable(false);
  failCommit = true;
  await assert.rejects(f.service.execute(f.service.prepareRebuild(), f.context({ restoreOriginal: undefined })),
    { code: 'SETTINGS_SAVE_FAILED' });
  assert.equal(fs.existsSync(f.files.client), false);
  assert.equal(fs.existsSync(f.files.public), false);
  assert.deepEqual(fs.readFileSync(f.files.host), host);
  await f.service.execute(f.service.prepareRebuild(), f.context());
  assert.equal(f.service.inspect().recoveryRequired, false);
  assert.equal(f.calls.some(([name]) => name === 'save-dialog'), false);
});

for (const missing of ['client', 'host']) {
  test(`both-key repair preserves the usable ${missing === 'client' ? 'host' : 'client'} identity without a fake backup`, async (t) => {
    const f = fixture(t);
    f.service.initialize();
    const before = f.readKeys();
    fs.unlinkSync(f.files[missing]);
    f.setAvailable(false);
    f.calls.length = 0;
    await f.service.execute(f.service.prepareRebuild('both'), f.context());
    assert.equal(f.service.inspect().recoveryRequired, false);
    if (missing === 'client') assert.deepEqual(fs.readFileSync(f.files.host), before.host);
    else assert.deepEqual(fs.readFileSync(f.files.client), before.client);
    assert.equal(f.calls.some(([name]) => name === 'save-dialog'), false);
  });
}

test('explicit permission-invalid repair reports an unbacked nonready role rather than claiming a backup',
  { skip: process.platform === 'win32' }, async (t) => {
    const f = fixture(t);
    f.service.initialize();
    fs.chmodSync(f.files.client, 0o644);
    assert.equal(f.service.inspect().client.errorCode, 'SSH_KEY_PERMISSIONS');
    const plan = f.service.prepareRebuild('client');
    assert.deepEqual(f.service.summary(plan).unbacked, ['client']);
    await f.service.execute(plan, f.context());
    assert.equal(f.calls.some(([name]) => name === 'save-dialog'), false);
    assert.equal(f.service.inspect().client.state, 'ready');
    assert.equal(fs.statSync(f.files.client).mode & 0o777, 0o600);
  });

for (const kind of ['backup', 'import']) {
  test(`aborting a pending native ${kind} dialog releases the action and ignores late selection`, async (t) => {
    const f = fixture(t);
    f.service.initialize();
    const original = f.readKeys();
    const abort = new AbortController();
    let finish;
    const selection = new Promise((resolve) => { finish = resolve; });
    if (kind === 'backup') f.serviceOptions.dialog.showSaveDialog = () => selection;
    else f.serviceOptions.dialog.showOpenDialog = () => selection;
    const context = f.context({ signal: abort.signal });
    const operation = kind === 'backup' ? f.service.execute(f.service.prepareRotate(), context)
      : f.service.prepareImport(context);
    abort.abort();
    await assert.rejects(operation, { code: 'OPERATION_CANCELLED' });
    assert.equal(f.calls.some(([name]) => name === 'stop-original'), false);
    finish(kind === 'backup' ? { canceled: false, filePath: f.backupPath }
      : { canceled: false, filePaths: [f.backupPath] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fs.existsSync(f.backupPath), false);
    assert.deepEqual(f.readKeys(), original);
    assert.equal(f.store.getRoot().keyTransaction, null);
  });
}

test('mixed changed and missing identities can be explicitly repaired without a fake old-pair backup', async (t) => {
  const f = fixture(t);
  f.service.initialize();
  fs.writeFileSync(f.files.client, generate(), { mode: 0o600 });
  fs.unlinkSync(f.files.host);
  f.setAvailable(false);
  assert.equal(f.service.inspect().client.state, 'changed');
  assert.equal(f.service.inspect().host.state, 'missing');
  const plan = f.service.prepareRebuild('both');
  assert.deepEqual(f.service.summary(plan).unbacked, ['client', 'host']);
  await f.service.execute(plan, f.context());
  assert.equal(f.service.inspect().recoveryRequired, false);
  assert.equal(f.calls.some(([name]) => name === 'save-dialog'), false);
});

for (const boundary of ['after-prepare', 'backup-dialog', 'stop']) {
  test(`external key changes at ${boundary} are never adopted as transaction rollback bytes`, async (t) => {
    const f = fixture(t);
    f.service.initialize();
    const plan = f.service.prepareRotate('both');
    const originalRootKeys = { ...f.store.getRoot().keys };
    const external = generate();
    const change = () => fs.writeFileSync(f.files.client, external, { mode: 0o600 });
    const context = f.context({ restoreOriginal: undefined });
    if (boundary === 'after-prepare') change();
    if (boundary === 'backup-dialog') f.serviceOptions.dialog.showSaveDialog = async () => {
      change();
      return { canceled: false, filePath: f.backupPath };
    };
    if (boundary === 'stop') context.beforeInstall = async () => { f.calls.push(['stop-original']); change(); };
    await assert.rejects(f.service.execute(plan, context), { code: 'SSH_KEY_FINGERPRINT_MISMATCH' });
    assert.equal(fs.readFileSync(f.files.client, 'utf8'), external);
    assert.deepEqual(f.store.getRoot().keys, originalRootKeys);
    assert.equal(f.store.getRoot().keyTransaction, null);
    assert.equal(f.calls.some(([name]) => name === 'candidate'), false);
    if (boundary !== 'stop') assert.equal(f.calls.some(([name]) => name === 'stop-original'), false);
  });
}

for (const role of ['client', 'public', 'host']) {
  test(`external ${role} changes during candidate bind close admission and preserve unknown bytes`, async (t) => {
    const f = fixture(t);
    f.service.initialize();
    const external = role === 'public' ? 'unrecognized external public data\n' : generate();
    await assert.rejects(f.service.execute(f.service.prepareRotate('both'), f.context({
      startCandidate: async () => { fs.writeFileSync(f.files[role], external, { mode: 0o600 }); return {}; },
    })), { code: 'KEY_ROLLBACK_FAILED' });
    assert.equal(fs.readFileSync(f.files[role], 'utf8'), external);
    assert.equal(f.store.getRoot().keyTransaction.phase, 'installed');
    assert.equal(f.calls.some(([name]) => name === 'stop-candidate'), true);
    assert.equal(f.calls.some(([name]) => name === 'activate'), false);
    assert.equal(f.calls.some(([name]) => name === 'restore'), false);
    assert.equal(f.service.inspect().recoveryRequired, true);
  });
}

test('external edits after prepared root commit are detected before overwriting that application path', async (t) => {
  let armed = false;
  const external = generate();
  let clientPath;
  const f = fixture(t, { commitRoot(candidate, store) {
    const result = store.save(candidate);
    if (armed && candidate.keyTransaction?.phase === 'prepared') fs.writeFileSync(clientPath, external, { mode: 0o600 });
    return result;
  } });
  f.service.initialize();
  clientPath = f.files.client;
  armed = true;
  await assert.rejects(f.service.execute(f.service.prepareRotate(), f.context()), { code: 'KEY_ROLLBACK_FAILED' });
  assert.equal(fs.readFileSync(f.files.client, 'utf8'), external);
  assert.equal(f.store.getRoot().keyTransaction.phase, 'prepared');
  assert.equal(f.calls.some(([name]) => name === 'candidate'), false);
});

for (const boundary of ['file', 'directory']) {
  test(`fresh ${boundary} fsync failure cannot mark partial identities initialized`,
    { skip: boundary === 'directory' && process.platform === 'win32' }, (t) => {
      let armed = true;
      const io = { ...fs, fsyncSync(fd) {
        const kind = fs.fstatSync(fd).isDirectory() ? 'directory' : 'file';
        if (armed && kind === boundary) { armed = false; throw ioError(); }
        return fs.fsyncSync(fd);
      } };
      const f = fixture(t, { io });
      assert.throws(() => f.service.initialize());
      assert.equal(f.store.getRoot().keys.initialized, false);
      assert.equal(f.store.getRoot().keyTransaction, null);
      assert.equal(fs.existsSync(f.files.host), false);
      const existingClient = fs.readFileSync(f.files.client);
      assert.throws(() => f.service.initialize(), { code: 'SSH_KEY_MISSING' });
      assert.deepEqual(fs.readFileSync(f.files.client), existingClient);
    });
}
