const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { utils: sshUtils } = require('ssh2');

function openSshEd25519PublicKey(privateKeyPem, comment = 'usshtc107') {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('SSH client private key must be Ed25519');
  }
  const publicKey = crypto.createPublicKey(privateKey);
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const raw = spki.subarray(spki.length - 32);
  const type = Buffer.from('ssh-ed25519');
  const wire = Buffer.alloc(4 + type.length + 4 + raw.length);
  wire.writeUInt32BE(type.length, 0);
  type.copy(wire, 4);
  wire.writeUInt32BE(raw.length, 4 + type.length);
  raw.copy(wire, 8 + type.length);
  return {
    openSsh: `ssh-ed25519 ${wire.toString('base64')} ${comment}`,
    raw: raw.toString('base64'),
  };
}

function generateEd25519PrivateKey() {
  return crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;
}

function ensurePrivateKey(filePath) {
  try {
    const existing = fs.readFileSync(filePath, 'utf8');
    const parsed = crypto.createPrivateKey(existing);
    if (parsed.asymmetricKeyType !== 'ed25519') throw new Error('key is not Ed25519');
    fs.chmodSync(filePath, 0o600);
    return existing;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Existing SSH key is invalid: ${filePath}: ${error.message}`);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const generated = generateEd25519PrivateKey();
  try {
    fs.writeFileSync(filePath, generated, { mode: 0o600, flag: 'wx' });
    return generated;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = fs.readFileSync(filePath, 'utf8');
    const parsed = crypto.createPrivateKey(existing);
    if (parsed.asymmetricKeyType !== 'ed25519') {
      throw new Error(`Existing SSH key is invalid: ${filePath}: key is not Ed25519`);
    }
    fs.chmodSync(filePath, 0o600);
    return existing;
  }
}

function ensureClientKeyPair({ sshDirectory, keyName = 'usshtc107_ed25519' }) {
  const privateKeyPath = path.join(sshDirectory, keyName);
  const publicKeyPath = `${privateKeyPath}.pub`;
  const privateKey = ensurePrivateKey(privateKeyPath);
  const publicKey = openSshEd25519PublicKey(privateKey);
  fs.writeFileSync(publicKeyPath, `${publicKey.openSsh}\n`, { mode: 0o644 });
  return {
    privateKeyPath,
    publicKeyPath,
    publicKey: publicKey.openSsh,
    publicKeyRaw: publicKey.raw,
  };
}

function parseSsh2PrivateKey(value) {
  try {
    const parsed = sshUtils.parseKey(value);
    const candidate = Array.isArray(parsed) ? parsed[0] : parsed;
    if (candidate instanceof Error || candidate?.isPrivateKey?.() !== true) return null;
    return candidate;
  } catch (_) {
    return null;
  }
}

function generateOpenSshEd25519PrivateKey() {
  const generated = sshUtils.generateKeyPairSync('ed25519').private;
  const parsed = parseSsh2PrivateKey(generated);
  if (!parsed || parsed.type !== 'ssh-ed25519') {
    throw new Error('Failed to generate a compatible Ed25519 proxy host key');
  }
  return generated;
}

function writePrivateKeyAtomically(filePath, privateKey) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    fs.writeFileSync(tempPath, privateKey, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch (_) {}
    throw error;
  }
}

function ensureProxyHostKey(filePath) {
  let existing;
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (existing !== undefined) {
    const parsed = parseSsh2PrivateKey(existing);
    if (parsed?.type === 'ssh-ed25519') {
      fs.chmodSync(filePath, 0o600);
      return existing;
    }

    // Migrate only the PKCS#8 Ed25519 format written by older app versions.
    try {
      const legacyKey = crypto.createPrivateKey(existing);
      if (legacyKey.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 key');
    } catch (error) {
      throw new Error(`Existing proxy SSH host key is invalid: ${filePath}: ${error.message}`);
    }
  }

  const generated = generateOpenSshEd25519PrivateKey();
  if (existing === undefined) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(filePath, generated, { mode: 0o600, flag: 'wx' });
      return generated;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return ensureProxyHostKey(filePath);
    }
  }

  writePrivateKeyAtomically(filePath, generated);
  return generated;
}

module.exports = {
  ensureClientKeyPair,
  ensurePrivateKey,
  ensureProxyHostKey,
  openSshEd25519PublicKey,
};
