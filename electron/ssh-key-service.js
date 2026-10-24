const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { utils: sshUtils } = require('ssh2');

const MAX_KEY_BYTES = 64 * 1024;
const DEFAULT_KEY_NAME = 'usshtc107_ed25519';

function keyError(code, message) {
  return Object.assign(new Error(message), { code });
}

function sshString(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function fingerprint(wire) {
  return `SHA256:${crypto.createHash('sha256').update(wire).digest('base64').replace(/=+$/, '')}`;
}

function parseSsh2PrivateKey(value) {
  const parsed = sshUtils.parseKey(value);
  const candidate = Array.isArray(parsed) ? (parsed.length === 1 ? parsed[0] : null) : parsed;
  return candidate && !(candidate instanceof Error) && candidate.isPrivateKey?.() === true
    && candidate.type === 'ssh-ed25519' ? candidate : null;
}

function pkcs8Identity(value) {
  const key = crypto.createPrivateKey(value);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('key is not Ed25519; not an Ed25519 key');
  const jwk = key.export({ format: 'jwk' });
  const seed = Buffer.from(jwk.d, 'base64url');
  const raw = Buffer.from(jwk.x, 'base64url');
  if (seed.length !== 32 || raw.length !== 32) throw new Error('Invalid Ed25519 key');
  const wire = Buffer.concat([sshString('ssh-ed25519'), sshString(raw)]);
  return { seed, raw, wire };
}

function describeIdentity(wire, comment = 'usshtc107') {
  return {
    publicKey: `ssh-ed25519 ${wire.toString('base64')} ${comment}`,
    publicKeyRaw: wire.subarray(wire.length - 32).toString('base64'),
    fingerprint: fingerprint(wire),
  };
}

function openSshEd25519PublicKey(privateKeyPem, comment = 'usshtc107') {
  const identity = describeIdentity(pkcs8Identity(privateKeyPem).wire, comment);
  return { openSsh: identity.publicKey, raw: identity.publicKeyRaw, fingerprint: identity.fingerprint };
}

// OpenSSH's unencrypted container encodes the existing seed; it does not generate a new identity.
function encodeOpenSshPrivateKey(value) {
  const { seed, raw, wire } = pkcs8Identity(value);
  const check = crypto.randomBytes(4);
  let body = Buffer.concat([
    check, check, sshString('ssh-ed25519'), sshString(raw),
    sshString(Buffer.concat([seed, raw])), sshString('usshtc107'),
  ]);
  const paddingLength = 8 - (body.length % 8);
  body = Buffer.concat([body, Buffer.from(Array.from({ length: paddingLength }, (_, index) => index + 1))]);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(1);
  const container = Buffer.concat([
    Buffer.from('openssh-key-v1\0'), sshString('none'), sshString('none'),
    sshString(''), count, sshString(wire), sshString(body),
  ]);
  const encoded = container.toString('base64').match(/.{1,70}/g).join('\n');
  const result = `-----BEGIN OPENSSH PRIVATE KEY-----\n${encoded}\n-----END OPENSSH PRIVATE KEY-----\n`;
  const parsed = parseSsh2PrivateKey(result);
  if (!parsed || !parsed.getPublicSSH().equals(wire)) throw keyError('SSH_KEY_INVALID', 'Ed25519 identity conversion failed');
  return result;
}

function readPrivateKey(filePath, { checkPermissions = false } = {}) {
  let fd;
  try {
    const before = fs.lstatSync(filePath);
    if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_KEY_BYTES) {
      throw keyError('SSH_KEY_INVALID', 'SSH key must be a regular non-symlink file within 64KiB');
    }
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > MAX_KEY_BYTES) {
      throw keyError('SSH_KEY_INVALID', 'SSH key changed while reading');
    }
    if (checkPermissions && process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw keyError('SSH_KEY_PERMISSIONS', 'SSH private key permissions are unsafe');
    }
    const buffer = Buffer.alloc(MAX_KEY_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_KEY_BYTES) throw keyError('SSH_KEY_INVALID', 'SSH key exceeds 64KiB');
    return buffer.subarray(0, length).toString('utf8');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function identityFromPrivateKey(value) {
  const parsed = parseSsh2PrivateKey(value);
  if (parsed) {
    const wire = parsed.getPublicSSH();
    const publicKey = crypto.createPublicKey({ format: 'der', type: 'spki',
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), wire.subarray(-32)]) });
    const challenge = Buffer.from('usshtc107 Ed25519 identity validation');
    const signature = parsed.sign(challenge);
    if (!Buffer.isBuffer(signature) || !crypto.verify(null, challenge, publicKey, signature)) {
      throw keyError('SSH_KEY_INVALID', 'Ed25519 private/public identity mismatch');
    }
    return describeIdentity(wire);
  }
  return describeIdentity(pkcs8Identity(value).wire);
}

function generateEd25519PrivateKey() {
  return crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
}

function ensurePrivateKey(filePath) {
  try {
    const existing = readPrivateKey(filePath);
    pkcs8Identity(existing);
    fs.chmodSync(filePath, 0o600);
    return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const generated = generateEd25519PrivateKey();
  try {
    fs.writeFileSync(filePath, generated, { mode: 0o600, flag: 'wx' });
    return generated;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return ensurePrivateKey(filePath);
  }
}

function clientPath(sshDirectory, keyName = DEFAULT_KEY_NAME) {
  if (!keyName || path.basename(keyName) !== keyName || keyName === '.' || keyName === '..') {
    throw keyError('SSH_KEY_INVALID', 'Invalid SSH key name');
  }
  return path.join(sshDirectory, keyName);
}

function ensureClientKeyPair({ sshDirectory, keyName = DEFAULT_KEY_NAME }) {
  const privateKeyPath = clientPath(sshDirectory, keyName);
  const privateKey = ensurePrivateKey(privateKeyPath);
  const identity = openSshEd25519PublicKey(privateKey);
  const publicKeyPath = `${privateKeyPath}.pub`;
  fs.writeFileSync(publicKeyPath, `${identity.openSsh}\n`, { mode: 0o644 });
  return { privateKeyPath, publicKeyPath, publicKey: identity.openSsh, publicKeyRaw: identity.raw, fingerprint: identity.fingerprint };
}

function writePrivateKeyAtomically(filePath, privateKey) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${crypto.randomBytes(16).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', 0o600);
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, privateKey);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, filePath);
    if (process.platform !== 'win32') {
      const directoryFd = fs.openSync(directory, 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(tempPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function ensureProxyHostKey(filePath) {
  let existing;
  try { existing = readPrivateKey(filePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing !== undefined) {
    if (parseSsh2PrivateKey(existing)) {
      fs.chmodSync(filePath, 0o600);
      return existing;
    }
    const converted = encodeOpenSshPrivateKey(existing);
    writePrivateKeyAtomically(filePath, converted);
    return converted;
  }
  const generated = encodeOpenSshPrivateKey(generateEd25519PrivateKey());
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(filePath, generated, { mode: 0o600, flag: 'wx' });
    return generated;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return ensureProxyHostKey(filePath);
  }
}

function getSsh2ClientIdentity({ sshDirectory, keyName = DEFAULT_KEY_NAME }) {
  const value = readPrivateKey(clientPath(sshDirectory, keyName), { checkPermissions: true });
  const privateKey = parseSsh2PrivateKey(value) ? value : encodeOpenSshPrivateKey(value);
  return { privateKey, ...identityFromPrivateKey(privateKey) };
}

function inspect({ sshDirectory, hostKeyPath, keyName = DEFAULT_KEY_NAME, expected = {} }) {
  function inspectOne(privateKeyPath, expectedFingerprint, includePublic) {
    try {
      const value = readPrivateKey(privateKeyPath, { checkPermissions: true });
      const identity = identityFromPrivateKey(value);
      const changed = expectedFingerprint && identity.fingerprint !== expectedFingerprint;
      return {
        state: changed ? 'changed' : 'ready', privateKeyPath,
        fingerprint: identity.fingerprint,
        ...(includePublic ? { publicKey: identity.publicKey } : {}),
        ...(changed ? { errorCode: 'SSH_KEY_FINGERPRINT_MISMATCH' } : {}),
      };
    } catch (error) {
      const missing = error.code === 'ENOENT';
      return {
        state: missing ? 'missing' : 'invalid', privateKeyPath, fingerprint: null,
        ...(includePublic ? { publicKey: null } : {}),
        errorCode: missing ? 'SSH_KEY_MISSING' : error.code === 'SSH_KEY_PERMISSIONS' ? error.code : 'SSH_KEY_INVALID',
      };
    }
  }
  const client = inspectOne(clientPath(sshDirectory, keyName), expected.clientFingerprint, true);
  const host = inspectOne(hostKeyPath, expected.hostFingerprint, false);
  return { scope: 'application', client, host, recoveryRequired: client.state !== 'ready' || host.state !== 'ready' };
}

const BACKUP_PLAINTEXT_BYTES = 64 * 1024;
const BACKUP_CIPHERTEXT_BYTES = 256 * 1024;
const BACKUP_FILE_BYTES = 512 * 1024;
const TRANSACTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_HASH = /^[0-9a-f]{64}$/;
const KEY_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

function createSshKeyService(deps) {
  const io = deps.io || fs;
  const platform = deps.platform || process.platform;
  const locations = Object.freeze({
    'client-private': clientPath(path.resolve(deps.sshDirectory)),
    'client-public': `${clientPath(path.resolve(deps.sshDirectory))}.pub`,
    'host-private': path.resolve(deps.hostKeyPath),
  });
  if (path.basename(locations['host-private']) !== 'proxy_host_ed25519') {
    throw keyError('SSH_KEY_INVALID', 'Invalid application host key location');
  }
  const plans = new WeakMap();
  let failure = null;
  let busy = false;
  const fail = (code) => keyError(code, code);
  const transactionFailure = (error) => fail(['OPERATION_CANCELLED', 'PROFILE_CHANGED', 'DRAFT_CHANGED', 'AUTH_REQUIRED',
    'SSH_KEY_MISSING', 'SSH_KEY_INVALID', 'SSH_KEY_PERMISSIONS', 'SSH_KEY_FINGERPRINT_MISMATCH',
    'KEY_BACKUP_INVALID', 'KEY_ROLLBACK_FAILED', 'SECURE_STORAGE_UNAVAILABLE', 'SETTINGS_LOCKED', 'SETTINGS_SAVE_FAILED',
    'SETTINGS_DURABILITY_UNCERTAIN', 'SETTINGS_COMMIT_UNKNOWN'].includes(error.code) ? error.code : 'KEY_TRANSACTION_FAILED');
  const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const currentRoot = () => deps.readRoot();
  const assertUnlocked = () => { if (deps.isLocked?.()) throw fail('SETTINGS_LOCKED'); };
  const sameFingerprints = (a, b) => a.clientFingerprint === b.clientFingerprint
    && a.hostFingerprint === b.hostFingerprint;
  const directorySync = (directory) => {
    if (platform === 'win32') return;
    const fd = io.openSync(directory, 'r');
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
  };
  const readFile = (filePath, maxBytes = MAX_KEY_BYTES, permissions = false) => {
    let fd;
    try {
      const before = io.lstatSync(filePath);
      if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw fail('SSH_KEY_INVALID');
      fd = io.openSync(filePath, io.constants.O_RDONLY | (io.constants.O_NOFOLLOW || 0));
      const after = io.fstatSync(fd);
      if (!after.isFile() || before.dev !== after.dev || before.ino !== after.ino || after.size > maxBytes) {
        throw fail('SSH_KEY_INVALID');
      }
      if (permissions && platform !== 'win32' && (after.mode & 0o077) !== 0) throw fail('SSH_KEY_PERMISSIONS');
      const bytes = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const count = io.readSync(fd, bytes, length, bytes.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > maxBytes) throw fail('SSH_KEY_INVALID');
      return bytes.subarray(0, length);
    } finally { if (fd !== undefined) io.closeSync(fd); }
  };
  const maybeRead = (filePath) => {
    try { return readFile(filePath); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const writeExclusive = (filePath, bytes) => {
    const directory = path.dirname(filePath);
    const created = io.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (created) {
      let child = directory;
      while (true) {
        directorySync(path.dirname(child));
        if (child === path.resolve(created)) break;
        child = path.dirname(child);
      }
    }
    const fd = io.openSync(filePath, 'wx', 0o600);
    try {
      io.fchmodSync(fd, 0o600);
      io.writeFileSync(fd, bytes);
      io.fsyncSync(fd);
    } finally { io.closeSync(fd); }
    directorySync(path.dirname(filePath));
  };
  const unlink = (filePath) => {
    try { io.unlinkSync(filePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  const replace = (source, destination) => {
    io.renameSync(source, destination);
    directorySync(path.dirname(destination));
  };
  const rootCommit = (patch) => {
    assertUnlocked();
    const result = deps.commitRoot({ ...currentRoot(), ...patch });
    if (result?.state === 'committed' && result.durable === true) return;
    const uncertain = result?.state === 'unknown' || (result?.state === 'committed' && result.durable !== true);
    throw Object.assign(fail(result?.errorCode || (uncertain ? 'SETTINGS_COMMIT_UNKNOWN' : 'KEY_TRANSACTION_FAILED')),
      { uncertain });
  };
  const inspectOne = (role, expected, publicKey) => {
    try {
      const identity = identityFromPrivateKey(readFile(locations[role], MAX_KEY_BYTES, true));
      const changed = Boolean(expected && expected !== identity.fingerprint);
      return { state: changed ? 'changed' : 'ready', fingerprint: identity.fingerprint,
        privateKeyPath: locations[role], ...(publicKey ? { publicKey: identity.publicKey } : {}),
        ...(changed ? { errorCode: 'SSH_KEY_FINGERPRINT_MISMATCH' } : {}) };
    } catch (error) {
      return { state: error.code === 'ENOENT' ? 'missing' : 'invalid', fingerprint: null,
        privateKeyPath: locations[role], ...(publicKey ? { publicKey: null } : {}),
        errorCode: error.code === 'ENOENT' ? 'SSH_KEY_MISSING'
          : error.code === 'SSH_KEY_PERMISSIONS' ? error.code : 'SSH_KEY_INVALID' };
    }
  };
  const inspectKeys = () => {
    const expected = currentRoot().keys;
    const client = inspectOne('client-private', expected.clientFingerprint, true);
    const host = inspectOne('host-private', expected.hostFingerprint, false);
    return { scope: 'application', client, host,
      recoveryRequired: Boolean(failure || !expected.initialized || currentRoot().keyTransaction
        || client.state !== 'ready' || host.state !== 'ready') };
  };
  const assertReady = () => {
    assertUnlocked();
    if (failure) throw fail(failure);
    if (currentRoot().keyTransaction) throw fail('KEY_TRANSACTION_FAILED');
    const value = inspectKeys();
    for (const key of [value.client, value.host]) {
      if (key.state !== 'ready') throw fail(key.errorCode || 'SSH_KEY_INVALID');
    }
    if (!currentRoot().keys.initialized) throw fail('SSH_KEY_MISSING');
    return value;
  };
  const material = (clientPrivateKey, hostPrivateKey) => {
    const client = identityFromPrivateKey(clientPrivateKey);
    const hostKey = parseSsh2PrivateKey(hostPrivateKey) ? hostPrivateKey.toString() : encodeOpenSshPrivateKey(hostPrivateKey);
    return { authorizedKey: Buffer.from(client.publicKeyRaw, 'base64'),
      authorizedKeyOpenSSH: client.publicKey, hostKey };
  };
  const transactionFiles = (transaction) => {
    if (!transaction || Object.keys(transaction).length !== 6 || typeof transaction.id !== 'string'
        || !TRANSACTION_ID.test(transaction.id) || !['client', 'host', 'both'].includes(transaction.target)
        || !['prepared', 'installed', 'committed'].includes(transaction.phase)) throw fail('KEY_ROLLBACK_FAILED');
    const expectedRoles = transaction.target === 'host' ? ['host-private']
      : transaction.target === 'client' ? ['client-private', 'client-public']
        : ['client-private', 'client-public', 'host-private'];
    if (!Array.isArray(transaction.files) || transaction.files.length !== expectedRoles.length) throw fail('KEY_ROLLBACK_FAILED');
    for (const value of [transaction.before, transaction.after]) {
      if (!value || Object.keys(value).length !== 2
          || !['clientFingerprint', 'hostFingerprint'].every((key) => value[key] === null
            || typeof value[key] === 'string' && KEY_FINGERPRINT.test(value[key]))) {
        throw fail('KEY_ROLLBACK_FAILED');
      }
    }
    if (!transaction.after.clientFingerprint || !transaction.after.hostFingerprint
        || transaction.target === 'client' && transaction.before.hostFingerprint !== null
          && transaction.before.hostFingerprint !== transaction.after.hostFingerprint
        || transaction.target === 'host' && transaction.before.clientFingerprint !== null
          && transaction.before.clientFingerprint !== transaction.after.clientFingerprint) throw fail('KEY_ROLLBACK_FAILED');
    const roles = new Set();
    return transaction.files.map((file) => {
      if (Object.keys(file).length !== 6 || !expectedRoles.includes(file.role) || roles.has(file.role)
          || typeof file.existed !== 'boolean' || typeof file.newSha256 !== 'string' || !HEX_HASH.test(file.newSha256)
          || (file.existed ? typeof file.oldSha256 !== 'string' || !HEX_HASH.test(file.oldSha256) : file.oldSha256 !== null)) {
        throw fail('KEY_ROLLBACK_FAILED');
      }
      roles.add(file.role);
      const destination = locations[file.role];
      const prefix = `${path.basename(destination)}.usshtc107-txn-${transaction.id}`;
      if (file.stageBasename !== `${prefix}.new` || file.rollbackBasename !== `${prefix}.old`) throw fail('KEY_ROLLBACK_FAILED');
      return { ...file, destination,
        stage: path.join(path.dirname(destination), file.stageBasename),
        rollback: path.join(path.dirname(destination), file.rollbackBasename) };
    });
  };
  const cleanup = (transaction) => {
    const files = transactionFiles(transaction);
    for (const file of files) { unlink(file.stage); unlink(file.rollback); }
    for (const directory of new Set(files.map((file) => path.dirname(file.destination)))) directorySync(directory);
  };
  const rollback = (transaction) => {
    const files = transactionFiles(transaction);
    // Validate every target and every required rollback before making any changes.
    const states = files.map((file) => {
      const existing = maybeRead(file.destination);
      const actual = existing === null ? null : hash(existing);
      if (file.existed && actual === file.oldSha256) return { file, restore: null };
      if (!file.existed && actual === null) return { file, restore: null };
      if (actual !== file.newSha256) throw fail('KEY_ROLLBACK_FAILED');
      if (!file.existed) return { file, remove: true };
      const old = readFile(file.rollback, MAX_KEY_BYTES, true);
      if (hash(old) !== file.oldSha256) throw fail('KEY_ROLLBACK_FAILED');
      return { file, restore: old };
    });
    for (const { file, restore, remove } of states) {
      if (remove) { unlink(file.destination); directorySync(path.dirname(file.destination)); }
      else if (restore) {
        // Copy through the stage so a second crash never consumes the only rollback material.
        unlink(file.stage);
        writeExclusive(file.stage, restore);
        replace(file.stage, file.destination);
      }
    }
  };
  const validateCommitted = (transaction) => {
    if (!sameFingerprints(currentRoot().keys, transaction.after)) throw fail('KEY_ROLLBACK_FAILED');
    for (const file of transactionFiles(transaction)) {
      const existing = readFile(file.destination, MAX_KEY_BYTES, file.role !== 'client-public');
      if (hash(existing) !== file.newSha256) throw fail('KEY_ROLLBACK_FAILED');
    }
    const actual = inspectKeys();
    if (actual.client.state !== 'ready' || actual.host.state !== 'ready') throw fail('KEY_ROLLBACK_FAILED');
  };
  const recover = () => {
    assertUnlocked();
    const transaction = currentRoot().keyTransaction;
    if (!transaction) { failure = null; return; }
    try {
      transactionFiles(transaction);
      if (transaction.phase === 'committed') validateCommitted(transaction);
      else rollback(transaction);
      cleanup(transaction);
      // Its removal is the last root write, after every filesystem change is durable.
      rootCommit({ keys: { initialized: true,
        ...(transaction.phase === 'committed' ? transaction.after : transaction.before) }, keyTransaction: null });
      failure = null;
    } catch (error) {
      failure = error.uncertain ? error.code : 'KEY_ROLLBACK_FAILED';
      throw fail(failure);
    }
  };
  const initialize = () => {
    assertUnlocked();
    recover();
    const saved = currentRoot().keys;
    const existing = inspectKeys();
    if (!saved.initialized || !saved.clientFingerprint || !saved.hostFingerprint) {
      // Any existing identity proves this is not a fresh installation. Never fill a missing peer silently.
      if (!saved.initialized && existing.client.state === 'missing' && existing.host.state === 'missing'
          && maybeRead(locations['client-public']) === null) {
        const client = generateEd25519PrivateKey();
        const host = encodeOpenSshPrivateKey(generateEd25519PrivateKey());
        writeExclusive(locations['client-private'], client);
        writeExclusive(locations['client-public'], `${identityFromPrivateKey(client).publicKey}\n`);
        writeExclusive(locations['host-private'], host);
      }
      const verified = inspectKeys();
      for (const key of [verified.client, verified.host]) if (key.state !== 'ready') throw fail(key.errorCode);
      rootCommit({ keys: { initialized: true, clientFingerprint: verified.client.fingerprint,
        hostFingerprint: verified.host.fingerprint } });
    }
    assertReady();
    // A legacy PKCS8 host is converted only after the recorded identity has been verified.
    const host = readFile(locations['host-private'], MAX_KEY_BYTES, true);
    if (!parseSsh2PrivateKey(host)) {
      const converted = encodeOpenSshPrivateKey(host);
      const temp = `${locations['host-private']}.${crypto.randomUUID()}.tmp`;
      try { writeExclusive(temp, converted); replace(temp, locations['host-private']); }
      finally { unlink(temp); }
    }
    return assertReady();
  };
  const assertAvailable = () => {
    if (typeof deps.isEncryptionAvailable !== 'function' || !deps.isEncryptionAvailable()) {
      throw fail('SECURE_STORAGE_UNAVAILABLE');
    }
  };
  const checkCurrent = (context = {}) => {
    if (context.signal?.aborted) throw fail('OPERATION_CANCELLED');
    context.assertCurrent?.();
  };
  const waitCurrent = async (context, promise) => {
    checkCurrent(context);
    let cancel;
    const aborted = new Promise((_resolve, reject) => {
      cancel = () => reject(fail('OPERATION_CANCELLED'));
      context.signal?.addEventListener('abort', cancel, { once: true });
      if (context.signal?.aborted) cancel();
    });
    try {
      const value = await Promise.race([promise, aborted]);
      checkCurrent(context);
      return value;
    } finally { context.signal?.removeEventListener('abort', cancel); }
  };
  const privatePair = (checkPermissions = true) => ({
    clientPrivateKey: readFile(locations['client-private'], MAX_KEY_BYTES, checkPermissions).toString(),
    hostPrivateKey: readFile(locations['host-private'], MAX_KEY_BYTES, checkPermissions).toString(),
  });
  const describePair = (pair) => ({ clientFingerprint: identityFromPrivateKey(pair.clientPrivateKey).fingerprint,
    hostFingerprint: identityFromPrivateKey(pair.hostPrivateKey).fingerprint });
  const writeBackup = async (context = {}) => {
    assertUnlocked();
    checkCurrent(context);
    assertAvailable();
    let pair;
    try { pair = privatePair(false); } catch (_) { throw fail('KEY_BACKUP_INVALID'); }
    let plaintext;
    try { plaintext = JSON.stringify({ ...pair, ...describePair(pair) }); }
    catch (_) { throw fail('KEY_BACKUP_INVALID'); }
    if (Buffer.byteLength(plaintext) > BACKUP_PLAINTEXT_BYTES) throw fail('KEY_BACKUP_INVALID');
    const ciphertext = deps.seal(plaintext);
    if (typeof ciphertext !== 'string' || ciphertext.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)
        || Buffer.from(ciphertext, 'base64').length > BACKUP_CIPHERTEXT_BYTES) throw fail('KEY_BACKUP_INVALID');
    checkCurrent(context);
    const selected = await waitCurrent(context, deps.dialog.showSaveDialog(deps.getWindow?.(), {
      title: 'Export machine-bound SSH key backup', defaultPath: 'usshtc107-keys.json',
      filters: [{ name: 'Encrypted SSH key backup', extensions: ['json'] }],
    }));
    checkCurrent(context);
    if (selected.canceled || !selected.filePath) return { cancelled: true };
    const destination = path.resolve(selected.filePath);
    // A dialog selection may never overwrite any application identity or its active journal material.
    if (Object.values(locations).includes(destination) || /^known_hosts(?:\.|$)/i.test(path.basename(destination))
        || path.basename(destination).includes('.usshtc107-txn-')
        || currentRoot().keyTransaction?.files.some((file) =>
          [file.stageBasename, file.rollbackBasename].some((name) => path.basename(destination) === name))) throw fail('KEY_BACKUP_INVALID');
    try {
      const stat = io.lstatSync(destination);
      if (!stat.isFile() || stat.isSymbolicLink()) throw fail('KEY_BACKUP_INVALID');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const bytes = Buffer.from(`${JSON.stringify({ format: 'usshtc107-key-backup', schemaVersion: 1, ciphertext }, null, 2)}\n`);
    if (bytes.length > BACKUP_FILE_BYTES) throw fail('KEY_BACKUP_INVALID');
    const temp = path.join(path.dirname(destination), `.usshtc107-backup-${crypto.randomUUID()}.tmp`);
    try {
      checkCurrent(context);
      writeExclusive(temp, bytes);
      checkCurrent(context);
      replace(temp, destination);
    } finally { unlink(temp); }
    return { exported: true };
  };
  const exportBackup = async (context = {}) => {
    try { return await writeBackup(context); }
    catch (error) {
      throw fail(['OPERATION_CANCELLED', 'PROFILE_CHANGED', 'DRAFT_CHANGED', 'AUTH_REQUIRED',
        'SETTINGS_LOCKED', 'SECURE_STORAGE_UNAVAILABLE'].includes(error.code) ? error.code : 'KEY_BACKUP_INVALID');
    }
  };
  const prepare = (target, replacement, rebuild, context = {}) => {
    assertUnlocked();
    checkCurrent(context);
    if (busy || currentRoot().keyTransaction || failure) throw fail(failure || 'KEY_TRANSACTION_FAILED');
    if (!['client', 'host', 'both'].includes(target)) throw fail('INVALID_ARGUMENT');
    const old = {};
    for (const [role, filePath] of Object.entries(locations)) old[role] = maybeRead(filePath);
    const before = { clientFingerprint: currentRoot().keys.clientFingerprint,
      hostFingerprint: currentRoot().keys.hostFingerprint };
    const status = inspectKeys();
    const retained = target === 'client' ? status.host : target === 'host' ? status.client : null;
    if (retained && retained.state !== 'ready') throw fail(retained.errorCode || 'SSH_KEY_INVALID');
    const keepClient = target === 'host' || rebuild && status.client.state === 'ready';
    const keepHost = target === 'client' || rebuild && status.host.state === 'ready';
    const pair = {
      clientPrivateKey: replacement?.clientPrivateKey || (keepClient ? old['client-private']?.toString() : generateEd25519PrivateKey()),
      hostPrivateKey: replacement?.hostPrivateKey || (keepHost ? old['host-private']?.toString()
        : encodeOpenSshPrivateKey(generateEd25519PrivateKey())),
    };
    let after;
    try { after = describePair(pair); material(pair.clientPrivateKey, pair.hostPrivateKey); }
    catch (_) { throw fail('SSH_KEY_INVALID'); }
    const roles = target === 'host' ? ['host-private'] : target === 'client'
      ? ['client-private', 'client-public'] : ['client-private', 'client-public', 'host-private'];
    let needsBackup = false;
    const unbacked = [];
    for (const role of roles.filter((role) => role !== 'client-public')) {
      const name = role === 'client-private' ? 'client' : 'host';
      const usable = status[name].state === 'ready';
      if (!rebuild && !usable) throw fail(status[name].errorCode || 'SSH_KEY_INVALID');
      const candidate = role === 'client-private' ? pair.clientPrivateKey : pair.hostPrivateKey;
      const replacing = old[role] === null || !old[role].equals(Buffer.from(candidate));
      needsBackup ||= usable && replacing;
      if (!usable && replacing) unbacked.push(name);
    }
    if (!rebuild) assertReady();
    const dto = {};
    plans.set(dto, { target, before, after, old, pair, roles, needsBackup, unbacked });
    return dto;
  };
  const prepareImport = async (context = {}) => {
    assertUnlocked();
    checkCurrent(context);
    assertAvailable();
    const selected = await waitCurrent(context, deps.dialog.showOpenDialog(deps.getWindow?.(), {
      title: 'Import machine-bound SSH key backup', properties: ['openFile'],
      filters: [{ name: 'Encrypted SSH key backup', extensions: ['json'] }],
    }));
    checkCurrent(context);
    assertUnlocked();
    if (selected.canceled || !selected.filePaths?.length) return { cancelled: true };
    let pair;
    try {
      const doc = JSON.parse(readFile(path.resolve(selected.filePaths[0]), BACKUP_FILE_BYTES).toString('utf8'));
      if (!doc || Object.keys(doc).length !== 3 || doc.format !== 'usshtc107-key-backup' || doc.schemaVersion !== 1
          || typeof doc.ciphertext !== 'string' || doc.ciphertext.length % 4 !== 0
          || doc.ciphertext.length > Math.ceil(BACKUP_CIPHERTEXT_BYTES / 3) * 4
          || !/^[A-Za-z0-9+/]+={0,2}$/.test(doc.ciphertext)
          || Buffer.from(doc.ciphertext, 'base64').length > BACKUP_CIPHERTEXT_BYTES) throw fail('KEY_BACKUP_INVALID');
      const plaintext = deps.unseal(doc.ciphertext);
      if (typeof plaintext !== 'string' || Buffer.byteLength(plaintext) > BACKUP_PLAINTEXT_BYTES) throw fail('KEY_BACKUP_INVALID');
      pair = JSON.parse(plaintext);
      const fields = ['clientPrivateKey', 'hostPrivateKey', 'clientFingerprint', 'hostFingerprint'];
      if (!pair || Object.keys(pair).length !== fields.length || fields.some((field) => typeof pair[field] !== 'string')) {
        throw fail('KEY_BACKUP_INVALID');
      }
      const derived = describePair(pair);
      if (!sameFingerprints(pair, derived)) throw fail('KEY_BACKUP_INVALID');
      material(pair.clientPrivateKey, pair.hostPrivateKey);
    } catch (error) { throw fail(error.code === 'SECURE_STORAGE_UNAVAILABLE' ? error.code : 'KEY_BACKUP_INVALID'); }
    checkCurrent(context);
    return prepare('both', pair, true, context);
  };
  const summary = (plan) => {
    const value = plans.get(plan);
    if (!value) throw fail('INVALID_ARGUMENT');
    return { target: value.target, before: { ...value.before }, after: { ...value.after }, unbacked: [...value.unbacked] };
  };
  const execute = async (plan, context = {}) => {
    const value = plans.get(plan);
    if (!value || busy || ['assertCurrent', 'beforeInstall', 'startCandidate', 'activateCandidate', 'stopCandidate']
      .some((name) => typeof context[name] !== 'function')) throw fail('KEY_TRANSACTION_FAILED');
    plans.delete(plan);
    checkCurrent(context);
    busy = true;
    let transaction = null;
    let prepared = false;
    let interrupted = false;
    let committed = false;
    let candidate = false;
    const assertOriginal = (roles = Object.keys(value.old)) => {
      for (const role of roles) {
        const actual = maybeRead(locations[role]);
        const original = value.old[role];
        if ((actual === null) !== (original === null) || actual && !actual.equals(original)) {
          throw fail('SSH_KEY_FINGERPRINT_MISMATCH');
        }
      }
    };
    const assertInstalled = () => {
      for (const file of transactionFiles(transaction)) {
        if (hash(readFile(file.destination, MAX_KEY_BYTES, true)) !== file.newSha256) throw fail('KEY_TRANSACTION_FAILED');
      }
      assertOriginal(Object.keys(value.old).filter((role) => !value.roles.includes(role)));
    };
    try {
      if (value.needsBackup) {
        const backup = await exportBackup(context);
        checkCurrent(context);
        if (backup.cancelled) return backup;
      }
      if (!sameFingerprints(currentRoot().keys, value.before) || currentRoot().keyTransaction) throw fail('KEY_TRANSACTION_FAILED');
      assertOriginal();
      checkCurrent(context);
      await context.beforeInstall();
      interrupted = true;
      checkCurrent(context);
      assertOriginal();
      const id = (deps.createId || crypto.randomUUID)();
      if (!TRANSACTION_ID.test(id)) throw fail('KEY_TRANSACTION_FAILED');
      const bytes = { 'client-private': Buffer.from(value.pair.clientPrivateKey),
        'client-public': Buffer.from(`${identityFromPrivateKey(value.pair.clientPrivateKey).publicKey}\n`),
        'host-private': Buffer.from(value.pair.hostPrivateKey) };
      transaction = { id, target: value.target, phase: 'prepared', before: value.before, after: value.after,
        files: value.roles.map((role) => ({ role, existed: value.old[role] !== null,
          oldSha256: value.old[role] === null ? null : hash(value.old[role]), newSha256: hash(bytes[role]),
          stageBasename: `${path.basename(locations[role])}.usshtc107-txn-${id}.new`,
          rollbackBasename: `${path.basename(locations[role])}.usshtc107-txn-${id}.old` })) };
      for (const file of transactionFiles(transaction)) {
        checkCurrent(context);
        writeExclusive(file.stage, bytes[file.role]);
        if (file.existed) writeExclusive(file.rollback, value.old[file.role]);
      }
      assertOriginal();
      for (const file of transactionFiles(transaction)) {
        if (hash(readFile(file.stage, MAX_KEY_BYTES, true)) !== file.newSha256
            || file.existed && hash(readFile(file.rollback, MAX_KEY_BYTES, true)) !== file.oldSha256) {
          throw fail('KEY_TRANSACTION_FAILED');
        }
      }
      checkCurrent(context);
      rootCommit({ keys: { initialized: true, ...value.before }, keyTransaction: transaction });
      prepared = true;
      for (const file of transactionFiles(transaction)) {
        checkCurrent(context);
        assertOriginal([file.role]);
        if (hash(readFile(file.stage, MAX_KEY_BYTES, true)) !== file.newSha256) throw fail('KEY_TRANSACTION_FAILED');
        replace(file.stage, file.destination);
      }
      checkCurrent(context);
      assertInstalled();
      transaction = { ...transaction, phase: 'installed' };
      rootCommit({ keyTransaction: transaction });
      checkCurrent(context);
      candidate = true;
      const started = await context.startCandidate({ transactionId: id,
        keyMaterial: material(value.pair.clientPrivateKey, value.pair.hostPrivateKey) });
      checkCurrent(context);
      if (started?.cancelled) throw fail('OPERATION_CANCELLED');
      assertInstalled();
      checkCurrent(context);
      const final = { ...transaction, phase: 'committed' };
      rootCommit({ keys: { initialized: true, ...value.after }, keyTransaction: final });
      committed = true;
      transaction = final;
      checkCurrent(context);
      validateCommitted(transaction);
      if (candidate) {
        await context.activateCandidate(id);
        checkCurrent(context);
      }
      cleanup(transaction);
      rootCommit({ keyTransaction: null });
      failure = null;
      return inspectKeys();
    } catch (error) {
      if (candidate) {
        // Closing the admission gate is the first effect even when the root outcome is unknown.
        try { await context.stopCandidate(); } catch (_) { failure = 'KEY_ROLLBACK_FAILED'; throw fail(failure); }
      }
      if (error.uncertain) {
        failure = error.code;
        try {
          const loaded = deps.reloadRoot();
          if (!loaded || loaded?.then) throw fail('KEY_ROLLBACK_FAILED');
          if (loaded.keyTransaction?.id === transaction?.id) {
            transaction = loaded.keyTransaction;
            prepared = true;
            committed = transaction.phase === 'committed';
          } else if (loaded.keyTransaction || !sameFingerprints(loaded.keys, value.before)) {
            throw fail('KEY_ROLLBACK_FAILED');
          }
          failure = null;
        } catch (_) { throw fail(error.code); }
      }
      const rootTransaction = currentRoot().keyTransaction;
      if (committed || (transaction && rootTransaction?.id === transaction.id
          && rootTransaction.phase === 'committed')) {
        // The committed identity must never be replaced with pre-commit bytes, including after a failed activation.
        failure = transactionFailure(error).code;
        throw fail(failure);
      }
      if (transaction) {
        try {
          if (prepared || currentRoot().keyTransaction?.id === transaction.id) {
            rollback(transaction);
            checkCurrent(context);
          }
          cleanup(transaction);
          checkCurrent(context);
          if (currentRoot().keyTransaction?.id === transaction.id) {
            rootCommit({ keys: { initialized: true, ...value.before }, keyTransaction: null });
          }
          failure = null;
        } catch (rollbackError) {
          if (['OPERATION_CANCELLED', 'PROFILE_CHANGED', 'DRAFT_CHANGED', 'AUTH_REQUIRED'].includes(rollbackError.code)) {
            throw rollbackError;
          }
          failure = 'KEY_ROLLBACK_FAILED';
          throw fail(failure);
        }
      }
      if (interrupted) {
        checkCurrent(context);
        await context.restoreOriginal?.();
        checkCurrent(context);
      }
      throw transactionFailure(error);
    } finally { busy = false; }
  };
  return {
    initialize, recover, inspect: inspectKeys, assertReady,
    getKeyMaterial: () => { assertReady(); const pair = privatePair(); return material(pair.clientPrivateKey, pair.hostPrivateKey); },
    getSsh2ClientIdentity: () => {
      assertReady();
      const value = readFile(locations['client-private'], MAX_KEY_BYTES, true);
      return { privateKey: parseSsh2PrivateKey(value) ? value.toString() : encodeOpenSshPrivateKey(value), ...identityFromPrivateKey(value) };
    },
    exportBackup, prepareImport,
    prepareRotate: (target = 'client', context) => prepare(target, null, false, context),
    prepareRebuild: (target = 'client', context) => prepare(target, null, true, context),
    summary, execute,
  };
}

module.exports = {
  ensureClientKeyPair, ensurePrivateKey, ensureProxyHostKey, openSshEd25519PublicKey,
  encodeOpenSshPrivateKey, getSsh2ClientIdentity, inspect, createSshKeyService,
};
