const fs = require('fs');
const path = require('path');
const { parseHost, parseInteger, parseToken } = require('./settings-store');

const BEGIN_MARKER = '# BEGIN usshtc107 managed';
const END_MARKER = '# END usshtc107 managed';
const LEGACY_MARKER = '# usshtc107-auto-generated';

function quoteSshValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function stripManagedBlocks(content) {
  const lines = String(content || '').replace(/\r\n/g, '\n').split('\n');
  const output = [];
  const startsSshBlock = (line) => /^\s*(?:Host|Match)\s+/i.test(line);
  for (let index = 0; index < lines.length;) {
    const trimmed = lines[index].trim();
    if (trimmed === BEGIN_MARKER) {
      const beginLine = index + 1;
      index += 1;
      while (index < lines.length && lines[index].trim() !== END_MARKER) index += 1;
      if (index >= lines.length) {
        const error = new Error(`Managed SSH config block at line ${beginLine} is missing its END marker`);
        error.code = 'SSH_CONFIG_UNTERMINATED_MANAGED_BLOCK';
        throw error;
      }
      index += 1;
      continue;
    }
    if (trimmed === LEGACY_MARKER) {
      index += 1;
      while (index < lines.length && lines[index].trim() === '') index += 1;
      if (index < lines.length && /^\s*Host\s+/i.test(lines[index])) {
        index += 1;
        while (index < lines.length
          && !startsSshBlock(lines[index])
          && lines[index].trim() !== BEGIN_MARKER
          && lines[index].trim() !== LEGACY_MARKER) index += 1;
      }
      continue;
    }
    output.push(lines[index]);
    index += 1;
  }
  return output.join('\n').trim();
}

function buildManagedBlock({ alias, host, port, privateKeyPath }) {
  const safeAlias = parseToken(alias, 'alias', 64);
  const safeHost = parseHost(host, 'host');
  const safePort = parseInteger(port, 'port', 1, 65535);
  if (typeof privateKeyPath !== 'string' || !privateKeyPath || /[\r\n\0]/.test(privateKeyPath)) {
    throw new TypeError('privateKeyPath is invalid');
  }
  return [
    BEGIN_MARKER,
    `Host ${safeAlias}`,
    `  HostName ${safeHost}`,
    `  Port ${safePort}`,
    '  User user',
    `  IdentityFile ${quoteSshValue(privateKeyPath)}`,
    '  IdentitiesOnly yes',
    '  StrictHostKeyChecking accept-new',
    END_MARKER,
  ].join('\n');
}

function atomicWriteText(filePath, content, mode = 0o600) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', mode);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, mode);
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

  preview(options) {
    const existing = (() => {
      try { return fs.readFileSync(this.configPath, 'utf8'); } catch (error) {
        if (error.code === 'ENOENT') return '';
        throw error;
      }
    })();
    const block = buildManagedBlock({ ...options, privateKeyPath: this.privateKeyPath });
    const unmanaged = stripManagedBlocks(existing);
    const content = `${unmanaged ? `${unmanaged}\n\n` : ''}${block}\n`;
    return { block, content, changed: content !== existing.replace(/\r\n/g, '\n') };
  }

  write(options) {
    fs.mkdirSync(this.sshDirectory, { recursive: true, mode: 0o700 });
    const preview = this.preview(options);
    if (!preview.changed) return { ...preview, path: this.configPath, backupPath: null };
    if (fs.existsSync(this.configPath)) {
      fs.copyFileSync(this.configPath, this.backupPath);
      fs.chmodSync(this.backupPath, 0o600);
    }
    atomicWriteText(this.configPath, preview.content, 0o600);
    return {
      ...preview,
      path: this.configPath,
      backupPath: fs.existsSync(this.backupPath) ? this.backupPath : null,
    };
  }
}

module.exports = {
  BEGIN_MARKER,
  END_MARKER,
  SshConfigService,
  buildManagedBlock,
  stripManagedBlocks,
};
