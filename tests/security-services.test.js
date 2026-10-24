const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Server: SSHServer, utils: sshUtils } = require('ssh2');

const { CredentialStore } = require('../electron/credential-store');
const { SettingsStore, createDefaultRoot, publicSettings } = require('../electron/settings-store');
const { validateSettingsPatch } = require('../shared/settings-schema.mjs');
const { SshConfigService } = require('../electron/ssh-config-service');
const {
  ensureClientKeyPair,
  ensurePrivateKey,
  ensureProxyHostKey,
} = require('../electron/ssh-key-service');
const { MAX_LOG_MESSAGE_CHARS, redactLogMessage } = require('../electron/log-redaction');
const {
  isAllowedLoginUrl,
  loadOwnedWindowUrl,
  parseHttpsUrl,
} = require('../electron/login-navigation');
const { createShutdownCoordinator } = require('../electron/shutdown-coordinator');
const { createAuthStateController } = require('../electron/auth-state');

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc107-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fakeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^encrypted:/, ''),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const DEFAULTS = {
  port: 3000,
  host: '127.0.0.1',
  cluster: 'training',
  loginNode: '11.11.10.202',
  cols: 80,
  rows: 24,
  useRoot: false,
  autoConnect: true,
  startMinimized: false,
  theme: 'dark',
  locale: 'en',
  sshAlias: 'usshtc107',
  savedCookieEncrypted: '',
  ssoUsername: '',
  ssoPassword: '',
  sshPublicKey: '',
  sshPublicKeyRaw: '',
};

test('settings validation rejects SSH config injection and invalid dimensions', () => {
  assert.deepEqual(validateSettingsPatch({ sshAlias: 'safe\n  ProxyCommand calc' }, DEFAULTS), {
    ok: false, fieldErrors: { sshAlias: 'invalid_token' },
  });
  assert.deepEqual(validateSettingsPatch({ host: '127.0.0.1\nProxyCommand=id' }, DEFAULTS), {
    ok: false, fieldErrors: { host: 'invalid_host' },
  });
  assert.deepEqual(validateSettingsPatch({ cols: Infinity }, DEFAULTS), {
    ok: false, fieldErrors: { cols: 'integer_range' },
  });
  assert.deepEqual(validateSettingsPatch({ unexpected: true }, DEFAULTS), {
    ok: false, fieldErrors: { unexpected: 'unknown_key' },
  });
});

test('login navigation allows only the platform and CAS HTTPS origins', () => {
  assert.equal(isAllowedLoginUrl('https://107.ustc.edu.cn/shell/training/node'), true);
  assert.equal(isAllowedLoginUrl('https://id.ustc.edu.cn/cas/login?service=x'), true);
  assert.equal(isAllowedLoginUrl('http://107.ustc.edu.cn/'), false);
  assert.equal(isAllowedLoginUrl('https://child.107.ustc.edu.cn/'), false);
  assert.equal(isAllowedLoginUrl('https://107.ustc.edu.cn.example.com/'), false);
  assert.equal(isAllowedLoginUrl('https://example.com/'), false);
  assert.equal(parseHttpsUrl('not a URL'), null);
});

test('cookie expiry invalidates a successful login and prevents proxy start', () => {
  const state = { loginStatus: 'success', cookieValid: true, cookieCount: 3 };
  const published = [];
  let generation = 0;
  let capturedCookie = 'session=secret';
  let storedCookieCleared = 0;
  let stateChanges = 0;
  const controller = createAuthStateController({
    state,
    invalidateQueries: () => { generation += 1; },
    setCapturedCookie: (value) => { capturedCookie = value; },
    clearStoredCookie: () => { storedCookieCleared += 1; },
    publish: (value) => published.push(value),
    onStateChanged: () => { stateChanges += 1; },
  });

  assert.equal(controller.canStartProxy(), true);
  controller.expireCookie();

  assert.deepEqual(state, { loginStatus: 'failure', loginStage: null, cookieValid: false, cookieCount: 0 });
  assert.equal(controller.canStartProxy(), false);
  assert.equal(capturedCookie, '');
  assert.equal(storedCookieCleared, 1);
  assert.equal(generation, 1);
  assert.equal(stateChanges, 1);
  assert.deepEqual(published, [
    { loginStatus: 'failure', loginStage: null, cookieValid: false, cookieCount: 0 },
  ]);
});

test('cookie loss does not turn an in-progress login into a failure', () => {
  const state = { loginStatus: 'pending', cookieValid: false, cookieCount: 0 };
  const published = [];
  const controller = createAuthStateController({
    state,
    invalidateQueries: () => {},
    setCapturedCookie: () => {},
    clearStoredCookie: () => {},
    publish: (value) => published.push(value),
  });

  controller.expireCookie();

  assert.equal(state.loginStatus, 'pending');
  assert.equal(controller.canStartProxy(), false);
  assert.deepEqual(published, [
    { loginStatus: 'pending', loginStage: null, cookieValid: false, cookieCount: 0 },
  ]);
});

test('redirect-related ERR_ABORTED failures are ignored', async () => {
  const errors = [];
  const window = {
    loadURL: async () => {
      const error = new Error('ERR_ABORTED (-3) loading login URL');
      error.code = -3;
      throw error;
    },
  };

  assert.equal(await loadOwnedWindowUrl({
    window,
    url: 'https://107.ustc.edu.cn',
    isCurrent: () => true,
    onError: (error) => errors.push(error),
  }), false);
  assert.deepEqual(errors, []);
});

test('real navigation errors are reported only for the owning window', async () => {
  const currentErrors = [];
  assert.equal(await loadOwnedWindowUrl({
    window: { loadURL: async () => { throw new Error('network failed'); } },
    url: 'https://107.ustc.edu.cn',
    isCurrent: () => true,
    onError: (error) => currentErrors.push(error.message),
  }), false);
  assert.deepEqual(currentErrors, ['network failed']);

  let rejectOldLoad;
  let current = true;
  const staleErrors = [];
  const pending = loadOwnedWindowUrl({
    window: {
      loadURL: () => new Promise((_resolve, reject) => { rejectOldLoad = reject; }),
    },
    url: 'https://107.ustc.edu.cn',
    isCurrent: () => current,
    onError: (error) => staleErrors.push(error.message),
  });
  current = false;
  rejectOldLoad(new Error('old window failed after replacement'));

  assert.equal(await pending, false);
  assert.deepEqual(staleErrors, []);
});

test('logs redact URL queries, CAS tickets, headers, assignments, and JSON secrets', () => {
  const redacted = redactLogMessage([
    'GET https://107.ustc.edu.cn/callback?ticket=ST-CAS-SECRET&service=SERVICE-SECRET',
    'ticket=ST-PLAIN-SECRET token="quoted token secret"',
    '{"password":"json password secret","savedCookieEncrypted":"cipher secret"}',
    'Authorization: Bearer HEADER-SECRET',
    'Cookie: session=COOKIE-SECRET',
    'Exec command: printf EXEC-SECRET',
  ].join('\n'));

  for (const secret of [
    'ST-CAS-SECRET',
    'SERVICE-SECRET',
    'ST-PLAIN-SECRET',
    'quoted token secret',
    'json password secret',
    'cipher secret',
    'HEADER-SECRET',
    'COOKIE-SECRET',
    'EXEC-SECRET',
  ]) {
    assert.equal(redacted.includes(secret), false, secret);
  }
  assert.match(redacted, /ticket=\[REDACTED\]/);
  assert.match(redacted, /"password":"\[REDACTED\]"/);
});

test('logs are truncated to a fixed per-entry limit after redaction', () => {
  const redacted = redactLogMessage(`token=SECRET ${'x'.repeat(MAX_LOG_MESSAGE_CHARS * 2)}`);
  assert.equal(redacted.includes('SECRET'), false);
  assert.equal(redacted.length, MAX_LOG_MESSAGE_CHARS);
  assert.match(redacted, /\.\.\. \[truncated\]$/);
});

test('shutdown requests share cleanup and fatal errors upgrade the exit code', async () => {
  const cleanup = deferred();
  const exits = [];
  let prepareCount = 0;
  const coordinator = createShutdownCoordinator({
    stop: () => cleanup.promise,
    exit: (code) => exits.push(code),
    onPrepare: () => { prepareCount += 1; },
  });

  const normalShutdown = coordinator.request(0);
  const fatalShutdown = coordinator.request(1);
  assert.equal(normalShutdown, fatalShutdown);
  assert.equal(coordinator.isStarted(), true);
  assert.equal(coordinator.getExitCode(), 1);
  assert.equal(prepareCount, 1);

  cleanup.resolve({ ok: true });
  await normalShutdown;
  assert.deepEqual(exits, [1]);
});

test('shutdown cleanup failures are reported and force a nonzero exit', async () => {
  const failures = [];
  const exits = [];
  const coordinator = createShutdownCoordinator({
    stop: async () => ({ ok: false, error: 'proxy would not stop' }),
    exit: (code) => exits.push(code),
    onCleanupError: (error) => failures.push(error.message),
  });

  await coordinator.request(0);
  assert.deepEqual(failures, ['proxy would not stop']);
  assert.deepEqual(exits, [1]);
});

test('shutdown survives preparation and rejected cleanup errors', async () => {
  const failures = [];
  const exits = [];
  const coordinator = createShutdownCoordinator({
    stop: async () => { throw new Error('stop rejected'); },
    exit: (code) => exits.push(code),
    onPrepare: () => { throw new Error('prepare rejected'); },
    onCleanupError: (error) => failures.push(error.message),
  });

  await coordinator.request(-1);
  assert.deepEqual(failures, ['prepare rejected', 'stop rejected']);
  assert.deepEqual(exits, [1]);
});

test('shutdown timeout uses a failing exit code while cleanup is pending', async () => {
  const cleanup = deferred();
  const exits = [];
  const clearedTimers = [];
  let forceExit;
  const coordinator = createShutdownCoordinator({
    stop: () => cleanup.promise,
    exit: (code) => exits.push(code),
    setTimer: (callback, timeoutMs) => {
      assert.equal(timeoutMs, 25);
      forceExit = callback;
      return 7;
    },
    clearTimer: (timer) => clearedTimers.push(timer),
    timeoutMs: 25,
  });

  const shutdown = coordinator.request(0);
  await Promise.resolve();
  forceExit();
  assert.deepEqual(exits, [1]);
  cleanup.resolve({ ok: true });
  await shutdown;
  assert.deepEqual(clearedTimers, [7]);
  assert.deepEqual(exits, [1]);
});

test('shutdown coordinator requires stop and exit callbacks', () => {
  assert.throws(() => createShutdownCoordinator({}), /must be functions/);
});

test('schema two root saves privately and public settings never expose profile secrets', (t) => {
  const filePath = path.join(temporaryDirectory(t), 'settings.json');
  const store = new SettingsStore({ filePath });
  const root = createDefaultRoot();
  root.profiles[0].secrets.ssoPassword = Buffer.from('opaque ciphertext').toString('base64');
  assert.deepEqual(store.save(root), { state: 'committed', durable: true, errorCode: null });
  assert.deepEqual(store.load(), root);
  if (process.platform !== 'win32') assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  const dto = publicSettings(root);
  assert.equal(dto.port, 3000);
  assert.equal('ssoPassword' in dto, false);
  assert.equal('savedCookieEncrypted' in dto, false);
});

test('credentials encrypt secrets in the shared root and status never returns a password', () => {
  let root = createDefaultRoot();
  const store = new CredentialStore({
    safeStorage: fakeSafeStorage(), profileId: 'default', userDataPath: '/test/user-data',
    readSecrets: () => root.profiles[0].secrets,
    commitSecrets: (patch) => {
      root = structuredClone(root);
      Object.assign(root.profiles[0].secrets, patch);
      return { state: 'committed', durable: true, errorCode: null };
    },
  });
  assert.deepEqual(store.saveSso({ username: 'SA123', password: 'school-password' }), {
    profileId: 'default', username: 'SA123', hasPassword: true, storageAvailable: true,
  });
  assert.equal(store.getSsoPassword(), 'school-password');
  assert.notEqual(root.profiles[0].secrets.ssoPassword, 'school-password');
  assert.equal(store.saveCookie('session=secret'), true);
  assert.equal(store.getCookie(), 'session=secret');
  assert.equal('savedCookie' in root.profiles[0].secrets, false);
});


test('SSH config prepends an owned block, preserves legacy user bytes, and backs up the source', (t) => {
  const sshDirectory = temporaryDirectory(t);
  const configPath = path.join(sshDirectory, 'config');
  const original = Buffer.from([
    'Host personal',
    '  HostName example.com',
    '',
    '# usshtc107-auto-generated',
    'Host old-alias',
    '  HostName 127.0.0.1',
    '  StrictHostKeyChecking no',
    '',
  ].join('\r\n'));
  fs.writeFileSync(configPath, original);
  const service = new SshConfigService({
    sshDirectory,
    privateKeyPath: path.join(sshDirectory, 'client key'),
  });
  const options = { profileId: 'default', alias: 'usshtc107', host: '127.0.0.1', port: 3000 };
  const preview = service.preview(options);
  const expected = { expectedSourceHash: preview.sourceHash, expectedConfigHash: preview.configHash };
  const result = service.write(options, expected);
  const written = fs.readFileSync(configPath);

  assert.deepEqual(written.subarray(Buffer.byteLength(`${preview.block}\n`)), original);
  assert.match(preview.block, /StrictHostKeyChecking accept-new/);
  assert.match(preview.block, /Host \*\n# END usshtc107 managed$/);
  assert.doesNotMatch(preview.block, /UserKnownHostsFile/);
  assert.deepEqual(fs.readFileSync(result.backupPath), original);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(result.backupPath).mode & 0o777, 0o600);
  }
  assert.throws(
    () => service.write({ ...options, alias: 'ok\nProxyCommand id' }, expected),
    (error) => error?.code === 'invalid_token',
  );
});

test('legacy SSH comments do not grant ownership of indented Host or Match directives', (t) => {
  const sshDirectory = temporaryDirectory(t);
  const original = Buffer.from([
    '# usshtc107-auto-generated',
    'Host old-alias',
    '  HostName 127.0.0.1',
    '  StrictHostKeyChecking no',
    '',
    '  Host indented-personal',
    '    HostName personal.example.com',
    'Match user deploy',
    '  IdentityFile ~/.ssh/deploy',
  ].join('\n'));
  fs.writeFileSync(path.join(sshDirectory, 'config'), original);
  const service = new SshConfigService({ sshDirectory, privateKeyPath: path.join(sshDirectory, 'key') });
  const preview = service.preview({ profileId: 'default', alias: 'usshtc107', host: 'localhost', port: 3000 });
  assert.deepEqual(preview.content.subarray(Buffer.byteLength(`${preview.block}\n`)), original);
});

test('SSH config writes fail closed when a managed block has no END marker', (t) => {
  const sshDirectory = temporaryDirectory(t);
  const configPath = path.join(sshDirectory, 'config');
  const malformed = [
    'Host personal-before',
    '  HostName before.example.com',
    '',
    '# BEGIN usshtc107 managed',
    'Host old-managed',
    '  HostName 127.0.0.1',
    '',
    'Host personal-after',
    '  HostName after.example.com',
    '',
  ].join('\n');
  fs.writeFileSync(configPath, malformed, { mode: 0o600 });
  const service = new SshConfigService({
    sshDirectory,
    privateKeyPath: path.join(sshDirectory, 'client-key'),
  });

  assert.throws(
    () => service.write(
      { profileId: 'default', alias: 'usshtc107', host: '127.0.0.1', port: 3000 },
      { expectedSourceHash: 'reviewed-source', expectedConfigHash: 'reviewed-config' },
    ),
    (error) => error?.code === 'SSH_CONFIG_INVALID',
  );
  assert.equal(fs.readFileSync(configPath, 'utf8'), malformed);
  assert.equal(fs.existsSync(service.backupPath), false);
});

test('client and proxy host keys remain stable across repeated initialization', (t) => {
  const directory = temporaryDirectory(t);
  const first = ensureClientKeyPair({ sshDirectory: directory });
  const second = ensureClientKeyPair({ sshDirectory: directory });
  assert.equal(first.publicKey, second.publicKey);
  assert.equal(Buffer.from(first.publicKeyRaw, 'base64').length, 32);
  assert.match(fs.readFileSync(first.privateKeyPath, 'utf8'), /^-----BEGIN PRIVATE KEY-----/);

  const hostKeyPath = path.join(directory, 'proxy-host-key');
  const firstHostKey = ensureProxyHostKey(hostKeyPath);
  assert.equal(firstHostKey, ensureProxyHostKey(hostKeyPath));
  assert.match(firstHostKey, /^-----BEGIN OPENSSH PRIVATE KEY-----/);
  const parsedHostKey = sshUtils.parseKey(firstHostKey);
  assert.equal(parsedHostKey.type, 'ssh-ed25519');
  assert.equal(parsedHostKey.isPrivateKey(), true);
  assert.doesNotThrow(() => new SSHServer({ hostKeys: [firstHostKey] }));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(hostKeyPath).mode & 0o777, 0o600);
  }
});

test('client key creation races still enforce private permissions', (t) => {
  const directory = temporaryDirectory(t);
  const keyPath = path.join(directory, 'raced-client-key');
  const racingKey = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
  const originalWriteFileSync = fs.writeFileSync;
  let intercepted = false;

  fs.writeFileSync = (target, value, options) => {
    if (!intercepted && target === keyPath && options?.flag === 'wx') {
      intercepted = true;
      originalWriteFileSync(keyPath, racingKey, { mode: 0o644, flag: 'w' });
      const error = new Error('simulated concurrent key creation');
      error.code = 'EEXIST';
      throw error;
    }
    return originalWriteFileSync(target, value, options);
  };

  try {
    assert.equal(ensurePrivateKey(keyPath), racingKey);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
  assert.equal(intercepted, true);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  }
});

test('legacy PKCS#8 proxy host key is migrated to an ssh2-compatible key', (t) => {
  const directory = temporaryDirectory(t);
  const hostKeyPath = path.join(directory, 'proxy-host-key');
  const legacyHostKey = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
  fs.writeFileSync(hostKeyPath, legacyHostKey, { mode: 0o600 });
  assert.throws(() => new SSHServer({ hostKeys: [legacyHostKey] }), /Unsupported key format/);

  const migrated = ensureProxyHostKey(hostKeyPath);
  assert.notEqual(migrated, legacyHostKey);
  assert.equal(fs.readFileSync(hostKeyPath, 'utf8'), migrated);
  const parsed = sshUtils.parseKey(migrated);
  assert.equal(parsed.type, 'ssh-ed25519');
  assert.equal(parsed.isPrivateKey(), true);
  const legacyPublic = crypto.createPublicKey(crypto.createPrivateKey(legacyHostKey)).export({ format: 'jwk' });
  assert.deepEqual(parsed.getPublicSSH().subarray(-32), Buffer.from(legacyPublic.x, 'base64url'));
  assert.doesNotThrow(() => new SSHServer({ hostKeys: [migrated] }));
  assert.equal(ensureProxyHostKey(hostKeyPath), migrated);
});

test('client and proxy key paths reject non-Ed25519 private keys', (t) => {
  const directory = temporaryDirectory(t);
  const rsaKey = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;

  const clientKeyPath = path.join(directory, 'usshtc107_ed25519');
  fs.writeFileSync(clientKeyPath, rsaKey, { mode: 0o600 });
  assert.throws(
    () => ensureClientKeyPair({ sshDirectory: directory }),
    /not Ed25519/,
  );

  const hostKeyPath = path.join(directory, 'proxy-host-key');
  fs.writeFileSync(hostKeyPath, rsaKey, { mode: 0o600 });
  assert.throws(
    () => ensureProxyHostKey(hostKeyPath),
    /not an Ed25519 key/,
  );
});
