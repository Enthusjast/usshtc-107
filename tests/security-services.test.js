const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Server: SSHServer, utils: sshUtils } = require('ssh2');

const {
  CredentialStore,
  MAX_COOKIE_BYTES,
  MAX_ENCRYPTED_SECRET_BYTES,
  MAX_SSO_PASSWORD_BYTES,
  validateCookie,
} = require('../electron/credential-store');
const {
  MAX_SETTINGS_FILE_BYTES,
  SettingsStore,
  normalizePublicSettings,
  publicSettings,
} = require('../electron/settings-store');
const {
  SshConfigService,
  stripManagedBlocks,
} = require('../electron/ssh-config-service');
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
  assert.throws(
    () => normalizePublicSettings({ sshAlias: 'safe\n  ProxyCommand calc' }, DEFAULTS),
    /unsupported characters/,
  );
  assert.throws(
    () => normalizePublicSettings({ host: '127.0.0.1\nProxyCommand=id' }, DEFAULTS),
    /valid host/,
  );
  assert.throws(() => normalizePublicSettings({ cols: Infinity }, DEFAULTS), /integer/);
  assert.throws(() => normalizePublicSettings({ unexpected: true }, DEFAULTS), /Unknown setting/);
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
    publish: (channel, value) => published.push([channel, value]),
    onStateChanged: () => { stateChanges += 1; },
  });

  assert.equal(controller.canStartProxy(), true);
  controller.expireCookie();

  assert.deepEqual(state, { loginStatus: 'failure', cookieValid: false, cookieCount: 0 });
  assert.equal(controller.canStartProxy(), false);
  assert.equal(capturedCookie, '');
  assert.equal(storedCookieCleared, 1);
  assert.equal(generation, 1);
  assert.equal(stateChanges, 1);
  assert.deepEqual(published, [
    ['login-status', 'failure'],
    ['cookie-status', { cookieValid: false, cookieCount: 0 }],
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
    publish: (channel, value) => published.push([channel, value]),
  });

  controller.expireCookie();

  assert.equal(state.loginStatus, 'pending');
  assert.equal(controller.canStartProxy(), false);
  assert.deepEqual(published, [
    ['cookie-status', { cookieValid: false, cookieCount: 0 }],
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

test('settings are written atomically with private permissions and secrets stay out of DTOs', (t) => {
  const directory = temporaryDirectory(t);
  const filePath = path.join(directory, 'settings.json');
  const store = new SettingsStore({ filePath, defaults: DEFAULTS });
  const saved = { ...DEFAULTS, ssoPassword: 'ciphertext', savedCookieEncrypted: 'cookie-ciphertext' };

  store.save(saved);
  assert.deepEqual(store.load(), saved);
  if (process.platform !== 'win32') assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  const dto = publicSettings(saved);
  assert.equal('ssoPassword' in dto, false);
  assert.equal('savedCookieEncrypted' in dto, false);
});

test('oversized settings files fail closed without creating a large backup', (t) => {
  const directory = temporaryDirectory(t);
  const filePath = path.join(directory, 'settings.json');
  const warnings = [];
  fs.writeFileSync(filePath, Buffer.alloc(MAX_SETTINGS_FILE_BYTES + 1, 0x20));
  const store = new SettingsStore({
    filePath,
    defaults: DEFAULTS,
    onWarning: (message) => warnings.push(message),
  });

  assert.deepEqual(store.load(), DEFAULTS);
  assert.match(warnings.join('\n'), /exceeds the .*byte limit/);
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.includes('.corrupt-')),
    [],
  );
});

test('corrupt settings backups are private and oversized saves are rejected', (t) => {
  const directory = temporaryDirectory(t);
  const filePath = path.join(directory, 'settings.json');
  fs.writeFileSync(filePath, '{not-json', { mode: 0o644 });
  const store = new SettingsStore({ filePath, defaults: DEFAULTS });

  assert.deepEqual(store.load(), DEFAULTS);
  const [backupName] = fs.readdirSync(directory).filter((name) => name.includes('.corrupt-'));
  assert.ok(backupName);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(directory, backupName)).mode & 0o777, 0o600);
  }

  assert.throws(
    () => store.save({ ...DEFAULTS, ssoPassword: 'x'.repeat(MAX_SETTINGS_FILE_BYTES) }),
    (error) => error?.code === 'SETTINGS_FILE_TOO_LARGE',
  );
  assert.equal(
    fs.readdirSync(directory).some((name) => name.endsWith('.tmp')),
    false,
  );
});

test('credential store encrypts secrets and never returns a decrypted password in status', () => {
  const settings = { ...DEFAULTS };
  let persisted;
  const store = new CredentialStore({
    safeStorage: fakeSafeStorage(),
    settings,
    persist: (value) => { persisted = { ...value }; },
    userDataPath: '/test/user-data',
  });

  const status = store.saveSso({ username: 'SA123', password: 'school-password' });
  assert.deepEqual(status, { username: 'SA123', hasPassword: true, storageAvailable: true });
  assert.equal('password' in status, false);
  assert.notEqual(persisted.ssoPassword, 'school-password');
  assert.equal(store.getSsoPassword(), 'school-password');

  assert.equal(store.saveCookie('session=secret'), true);
  assert.equal(settings.savedCookie, undefined);
  assert.notEqual(settings.savedCookieEncrypted, 'session=secret');
  assert.equal(store.getCookie(), 'session=secret');
});

test('credential limits are enforced using UTF-8 byte lengths', () => {
  const settings = { ...DEFAULTS };
  const store = new CredentialStore({
    safeStorage: fakeSafeStorage(),
    settings,
    persist: () => {},
    userDataPath: '/test/user-data',
  });
  const maximumCookie = 'x'.repeat(MAX_COOKIE_BYTES);

  assert.equal(validateCookie(maximumCookie), maximumCookie);
  assert.equal(store.saveCookie(maximumCookie), true);
  assert.throws(
    () => store.saveCookie(`${maximumCookie}x`),
    (error) => error?.code === 'CREDENTIAL_LIMIT_EXCEEDED',
  );
  assert.throws(() => store.saveCookie(null), /cookie must be a string/);
  assert.throws(
    () => store.saveSso({
      username: 'SA123',
      password: '\u{1F600}'.repeat(Math.floor(MAX_SSO_PASSWORD_BYTES / 4) + 1),
    }),
    (error) => error?.code === 'CREDENTIAL_LIMIT_EXCEEDED',
  );
});

test('oversized stored and legacy credentials are discarded', () => {
  const warnings = [];
  const oversizedEncrypted = Buffer.alloc(MAX_ENCRYPTED_SECRET_BYTES + 1).toString('base64');
  const settings = {
    ...DEFAULTS,
    savedCookie: 'x'.repeat(MAX_COOKIE_BYTES + 1),
    savedCookieEncrypted: oversizedEncrypted,
    ssoPassword: `xor:${'A'.repeat(MAX_ENCRYPTED_SECRET_BYTES * 2 + 1)}`,
  };
  const store = new CredentialStore({
    safeStorage: fakeSafeStorage(),
    settings,
    persist: () => {},
    userDataPath: '/test/user-data',
    onWarning: (message) => warnings.push(message),
  });

  store.migrateLegacySecrets();
  assert.equal(settings.savedCookie, undefined);
  assert.equal(settings.ssoPassword, '');
  assert.equal(store.getCookie(), '');
  assert.match(warnings.join('\n'), /invalid plaintext saved Cookie/);
  assert.match(warnings.join('\n'), /legacy-obfuscated SSO password/);
  assert.match(warnings.join('\n'), /Saved Cookie could not be decrypted/);
});

test('legacy XOR/password and plaintext Cookie are migrated or removed', () => {
  const userDataPath = '/test/user-data';
  const legacyPassword = Buffer.from('legacy-password');
  const key = crypto.createHash('md5').update(userDataPath).digest();
  for (let index = 0; index < legacyPassword.length; index += 1) {
    legacyPassword[index] ^= key[index % key.length];
  }
  const settings = {
    ...DEFAULTS,
    savedCookie: 'session=plaintext',
    ssoPassword: `xor:${legacyPassword.toString('base64')}`,
  };
  const store = new CredentialStore({
    safeStorage: fakeSafeStorage(),
    settings,
    persist: () => {},
    userDataPath,
  });

  store.migrateLegacySecrets();
  assert.equal(settings.savedCookie, undefined);
  assert.equal(store.getCookie(), 'session=plaintext');
  assert.equal(store.getSsoPassword(), 'legacy-password');
  assert.equal(settings.ssoPassword.startsWith('xor:'), false);

  const unavailableSettings = { ...DEFAULTS, savedCookie: 'session=plaintext' };
  const unavailableStore = new CredentialStore({
    safeStorage: fakeSafeStorage(false),
    settings: unavailableSettings,
    persist: () => {},
    userDataPath,
  });
  unavailableStore.migrateLegacySecrets();
  assert.equal(unavailableSettings.savedCookie, undefined);
  assert.throws(
    () => unavailableStore.saveSso({ username: 'SA123', password: 'password' }),
    /unavailable/,
  );
});

test('SSH config replaces legacy blocks, preserves user config, and creates a backup', (t) => {
  const sshDirectory = temporaryDirectory(t);
  const configPath = path.join(sshDirectory, 'config');
  fs.writeFileSync(configPath, [
    'Host personal',
    '  HostName example.com',
    '',
    '# usshtc107-auto-generated',
    'Host old-alias',
    '  HostName 127.0.0.1',
    '  StrictHostKeyChecking no',
    '',
  ].join('\n'));

  const service = new SshConfigService({
    sshDirectory,
    privateKeyPath: path.join(sshDirectory, 'client key'),
  });
  const result = service.write({ alias: 'usshtc107', host: '127.0.0.1', port: 3000 });
  const written = fs.readFileSync(configPath, 'utf8');

  assert.match(written, /Host personal/);
  assert.doesNotMatch(written, /old-alias/);
  assert.match(written, /StrictHostKeyChecking accept-new/);
  assert.doesNotMatch(written, /UserKnownHostsFile \/dev\/null/);
  assert.ok(result.backupPath && fs.existsSync(result.backupPath));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(result.backupPath).mode & 0o777, 0o600);
  }
  assert.throws(
    () => service.write({ alias: 'ok\nProxyCommand id', host: '127.0.0.1', port: 3000 }),
    /unsupported characters/,
  );
  assert.equal(stripManagedBlocks(written).includes('usshtc107'), false);
});

test('legacy SSH config migration preserves indented Host and Match blocks', () => {
  const config = [
    '# usshtc107-auto-generated',
    'Host old-alias',
    '  HostName 127.0.0.1',
    '  StrictHostKeyChecking no',
    '',
    '  Host indented-personal',
    '    HostName personal.example.com',
    'Match user deploy',
    '  IdentityFile ~/.ssh/deploy',
  ].join('\n');

  const stripped = stripManagedBlocks(config);
  assert.doesNotMatch(stripped, /old-alias|StrictHostKeyChecking no/);
  assert.match(stripped, /Host indented-personal/);
  assert.match(stripped, /HostName personal\.example\.com/);
  assert.match(stripped, /Match user deploy/);
  assert.match(stripped, /IdentityFile ~\/\.ssh\/deploy/);
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
    () => service.write({ alias: 'usshtc107', host: '127.0.0.1', port: 3000 }),
    (error) => error?.code === 'SSH_CONFIG_UNTERMINATED_MANAGED_BLOCK',
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
