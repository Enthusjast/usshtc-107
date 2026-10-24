const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { TextDecoder } = require('util');
const { parseHost, parseInteger, parseToken } = require('../shared/settings-schema.mjs');

const BEGIN_MARKER = '# BEGIN usshtc107 managed';
const END_MARKER = '# END usshtc107 managed';
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function configError(code = 'SSH_CONFIG_INVALID') {
  const error = new Error(code);
  error.code = code;
  return error;
}

function hash(content) {
  return createHash('sha256').update(content).digest('hex');
}

function quoteSshValue(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function normalizeConfig({ alias, host, port, privateKeyPath }) {
  const config = {
    alias: parseToken(alias, 'alias', 64),
    host: parseHost(host, 'host'),
    port: parseInteger(port, 'port', 1, 65535),
    privateKeyPath,
  };
  if (typeof privateKeyPath !== 'string' || !privateKeyPath
      || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(privateKeyPath)) {
    throw new TypeError('privateKeyPath is invalid');
  }
  return config;
}

function buildManagedBlock(options) {
  const { alias, host, port, privateKeyPath } = normalizeConfig(options);
  return [
    BEGIN_MARKER,
    `Host ${alias}`,
    `  HostName ${host}`,
    `  Port ${port}`,
    '  User user',
    `  IdentityFile ${quoteSshValue(privateKeyPath)}`,
    '  IdentitiesOnly yes',
    '  StrictHostKeyChecking accept-new',
    'Host *',
    END_MARKER,
  ].join('\n');
}

// Tokenize only Host arguments, without evaluating Include, Match or any commands.
function hostPatterns(line) {
  const directive = /^[\t ]*Host(?:[\t ]+|[\t ]*=[\t ]*)/i.exec(line);
  if (!directive) return [];
  const patterns = [];
  let token = '';
  let quoted = false;
  let escaped = false;
  for (const character of line.slice(directive[0].length)) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (!quoted && character === '#') {
      break;
    } else if (!quoted && /[\t \r]/.test(character)) {
      if (token) patterns.push(token);
      token = '';
    } else {
      token += character;
    }
  }
  if (quoted || escaped) throw configError();
  if (token) patterns.push(token);
  return patterns;
}

// Validate text once, but remove only byte spans whose ownership is explicit.
// Legacy single comments do not establish ownership of following user directives.
function unmanagedBytes(source, alias) {
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source);
  } catch (_) {
    throw configError();
  }
  const bomLength = source.subarray(0, 3).equals(UTF8_BOM) ? 3 : 0;
  let begin = null;
  let ownedSpan = null;
  for (let offset = bomLength; offset < source.length;) {
    const newline = source.indexOf(0x0a, offset);
    const end = newline === -1 ? source.length : newline + 1;
    const line = source.subarray(offset, newline === -1 ? end : newline).toString('utf8');
    const marker = line.trim();
    if (marker === BEGIN_MARKER) {
      if (begin !== null || ownedSpan !== null) throw configError();
      begin = offset;
    } else if (marker === END_MARKER) {
      if (begin === null) throw configError();
      ownedSpan = [begin, end];
      begin = null;
    } else if (begin === null && hostPatterns(line).some((pattern) => (
      pattern.toLowerCase() === alias.toLowerCase()
    ))) {
      throw configError('SSH_ALIAS_CONFLICT');
    }
    offset = end;
  }
  if (begin !== null) throw configError();
  const content = ownedSpan
    ? Buffer.concat([source.subarray(bomLength, ownedSpan[0]), source.subarray(ownedSpan[1])])
    : source.subarray(bomLength);
  return { bom: source.subarray(0, bomLength), content, hasManagedBlock: ownedSpan !== null };
}

function readSource(filePath) {
  let descriptor;
  try {
    const entry = fs.lstatSync(filePath);
    if (!entry.isFile() || entry.isSymbolicLink()) throw configError();
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) throw configError();
    return { content: fs.readFileSync(descriptor), exists: true };
  } catch (error) {
    if (descriptor === undefined && error.code === 'ENOENT') {
      return { content: Buffer.alloc(0), exists: false };
    }
    if (error.code === 'ELOOP') throw configError();
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function atomicWriteBytes(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, content);
    fs.fchmodSync(descriptor, 0o600);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(filePath), fs.constants.O_RDONLY);
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_) {}
    }
    try { fs.unlinkSync(temporaryPath); } catch (_) {}
    throw error;
  }
}

class SshConfigService {
  constructor({ sshDirectory, privateKeyPath }) {
    this.sshDirectory = sshDirectory;
    this.privateKeyPath = privateKeyPath;
    this.configPath = path.join(sshDirectory, 'config');
    this.backupPath = path.join(sshDirectory, 'config.usshtc107.bak');
  }

  _preview(options, source) {
    const profileId = parseToken(options.profileId, 'profileId');
    const config = normalizeConfig({ ...options, privateKeyPath: this.privateKeyPath });
    const block = buildManagedBlock(config);
    const unmanaged = unmanagedBytes(source, config.alias);
    const content = Buffer.concat([unmanaged.bom, Buffer.from(`${block}\n`, 'utf8'), unmanaged.content]);
    const configHash = hash(JSON.stringify([
      profileId, config.alias, config.host, config.port, config.privateKeyPath,
    ]));
    return { block, content, changed: !source.equals(content), sourceHash: hash(source), configHash };
  }

  preview(options) {
    return this._preview(options, readSource(this.configPath).content);
  }

  inspect(options) {
    const source = readSource(this.configPath);
    const preview = this._preview(options, source.content);
    const config = normalizeConfig({ ...options, privateKeyPath: this.privateKeyPath });
    const owned = unmanagedBytes(source.content, config.alias).hasManagedBlock;
    return { code: !source.exists || !owned ? 'SSH_CONFIG_MISSING'
      : preview.changed ? 'SSH_CONFIG_MISMATCH' : 'SSH_CONFIG_OK' };
  }

  write(options, { expectedSourceHash, expectedConfigHash } = {}) {
    if (typeof expectedSourceHash !== 'string' || typeof expectedConfigHash !== 'string') {
      throw configError('SSH_CONFIG_CHANGED');
    }
    const source = readSource(this.configPath);
    const preview = this._preview(options, source.content);
    if (preview.sourceHash !== expectedSourceHash || preview.configHash !== expectedConfigHash) {
      throw configError('SSH_CONFIG_CHANGED');
    }
    if (!preview.changed) return { ...preview, path: this.configPath, backupPath: null };
    fs.mkdirSync(this.sshDirectory, { recursive: true, mode: 0o700 });
    if (source.exists) atomicWriteBytes(this.backupPath, source.content);
    atomicWriteBytes(this.configPath, preview.content);
    return {
      ...preview,
      path: this.configPath,
      backupPath: source.exists ? this.backupPath : null,
    };
  }
}

module.exports = {
  BEGIN_MARKER,
  END_MARKER,
  SshConfigService,
  buildManagedBlock,
};
