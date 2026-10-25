const fs = require('node:fs');
const path = require('node:path');
const { createHash, timingSafeEqual } = require('node:crypto');
const { execFile } = require('node:child_process');
const semver = require('semver');
const yaml = require('js-yaml');
const { parseDn } = require('builder-util-runtime');

const RELEASE_DOWNLOAD = 'https://github.com/Enthusjast/usshtc-107/releases/download/';
const MAX_NOTES_BYTES = 64 * 1024;
const MAX_CONFIG_BYTES = 64 * 1024;
const SIGNATURE_INVALID = 'UPDATE_SIGNATURE_INVALID';
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f]/;

function updateError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function canonicalVersion(value) {
  return typeof value === 'string' && semver.valid(value) === value && semver.prerelease(value) === null;
}

function validDigest(value) {
  return typeof value === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(value)
    && Buffer.from(value, 'base64').length === 64
    && Buffer.from(value, 'base64').toString('base64') === value;
}

function validSize(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function assetBasename(value, version) {
  if (typeof value !== 'string') throw updateError('UPDATE_INVALID_METADATA');
  const prefix = `${RELEASE_DOWNLOAD}v${version}/`;
  const name = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  // No URL decoding or path normalization: either the canonical repository URL or
  // a single ordinary builder basename is accepted, never another feed or path.
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name) || name.includes('..')) {
    throw updateError('UPDATE_INVALID_METADATA');
  }
  return name;
}

function plainReleaseNotes(notes) {
  let source;
  if (notes == null) return '';
  if (typeof notes === 'string') source = notes;
  else if (Array.isArray(notes) && notes.every(item => item && typeof item === 'object' && !Array.isArray(item)
      && (item.note == null || typeof item.note === 'string'))) {
    source = notes.map(item => item.note || '').join('\n\n');
  } else throw updateError('UPDATE_INVALID_METADATA');
  const text = source.toWellFormed()
    .replace(/&(?:lt|#0*60|#x0*3c);/gi, '<')
    .replace(/&(?:gt|#0*62|#x0*3e);/gi, '>')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    .replace(/<\s*\/?(?:br|p|div|li|h[1-6])\b[^>]*>/gi, '\n')
    .replace(/<[^>]*(?:>|$)/g, '')
    .replace(/[<>]/g, '')
    .replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'")
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '');
  // Iterate code points so a UTF-8 boundary never produces a replacement glyph.
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const length = Buffer.byteLength(character);
    if (bytes + length > MAX_NOTES_BYTES) break;
    bytes += length;
    end += character.length;
  }
  return text.slice(0, end);
}

function validateUpdateInfo(info, { currentVersion, platform, arch }) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) throw updateError('UPDATE_INVALID_METADATA');
  if (!canonicalVersion(currentVersion) || !canonicalVersion(info.version)
      || !semver.gt(info.version, currentVersion)) throw updateError('UPDATE_VERSION_REJECTED');
  const target = { win32: ['win', 'exe'], darwin: ['mac', 'zip'], linux: ['linux', 'AppImage'] }[platform];
  if (!target || !['x64', 'arm64', 'ia32', 'armv7l'].includes(arch)) throw updateError('UPDATE_INVALID_METADATA');
  const aliases = platform === 'linux' && arch === 'x64' ? ['x64', 'x86_64'] : [arch];
  const expected = aliases.map(alias => `usshtc107-${info.version}-${target[0]}-${alias}.${target[1]}`);
  if (!Array.isArray(info.files) || info.files.length === 0) throw updateError('UPDATE_INVALID_METADATA');
  const names = new Set();
  const matches = [];
  for (const file of info.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw updateError('UPDATE_INVALID_METADATA');
    const name = assetBasename(file.url, info.version);
    if (names.has(name) || !validSize(file.size) || !validDigest(file.sha512)) throw updateError('UPDATE_INVALID_METADATA');
    names.add(name);
    if (expected.includes(name)) matches.push({ name, file });
  }
  if (matches.length !== 1) throw updateError('UPDATE_INVALID_METADATA');
  let releaseDate = null;
  if (info.releaseDate != null) {
    if (typeof info.releaseDate !== 'string' || !Number.isFinite(Date.parse(info.releaseDate))) throw updateError('UPDATE_INVALID_METADATA');
    releaseDate = new Date(info.releaseDate).toISOString();
  }
  const { name, file } = matches[0];
  const candidate = Object.freeze({ version: info.version, platform, arch, assetName: name, size: file.size, sha512: file.sha512 });
  return { candidate, releaseDate, releaseNotes: plainReleaseNotes(info.releaseNotes) };
}

function sameFile(left, right) {
  return ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => left[key] === right[key]);
}

async function verifyUpdateFile(filePath, candidate, { signal, fs: fileSystem = fs } = {}) {
  let handle;
  let stream;
  let verificationStep = 'input';
  const assertActive = () => {
    if (signal?.aborted) {
      verificationStep = 'abort';
      throw updateError('UPDATE_PREPARATION_FAILED');
    }
  };
  const abort = () => {
    verificationStep = 'abort';
    stream?.destroy(updateError('UPDATE_PREPARATION_FAILED'));
  };
  try {
    assertActive();
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.normalize(filePath) !== filePath
        || UNSAFE_TEXT.test(filePath) || !candidate || !validSize(candidate.size) || !validDigest(candidate.sha512)) {
      throw updateError('UPDATE_CHECKSUM_MISMATCH');
    }
    const api = fileSystem.promises;
    verificationStep = 'realpath';
    if (await api.realpath(filePath) !== filePath) throw updateError('UPDATE_CHECKSUM_MISMATCH');
    verificationStep = 'lstat';
    const initial = await api.lstat(filePath, { bigint: true });
    if (!initial.isFile() || initial.isSymbolicLink()) throw updateError('UPDATE_CHECKSUM_MISMATCH');
    verificationStep = 'size';
    if (initial.size !== BigInt(candidate.size)) throw updateError('UPDATE_CHECKSUM_MISMATCH');
    verificationStep = 'open';
    handle = await api.open(filePath, fileSystem.constants.O_RDONLY | (fileSystem.constants.O_NOFOLLOW || 0));
    verificationStep = 'stat';
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile()) throw updateError('UPDATE_CHECKSUM_MISMATCH');
    verificationStep = 'sameFile';
    if (!sameFile(initial, opened)) throw updateError('UPDATE_CHECKSUM_MISMATCH');
    assertActive();
    const digest = createHash('sha512');
    let size = 0;
    verificationStep = 'stream';
    stream = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
    signal?.addEventListener('abort', abort, { once: true });
    assertActive();
    for await (const chunk of stream) {
      assertActive();
      size += chunk.length;
      if (size > candidate.size) {
        verificationStep = 'size';
        throw updateError('UPDATE_CHECKSUM_MISMATCH');
      }
      digest.update(chunk);
    }
    assertActive();
    verificationStep = 'statAfter';
    const after = await handle.stat({ bigint: true });
    verificationStep = 'lstatAfter';
    const final = await api.lstat(filePath, { bigint: true });
    if (!final.isFile() || final.isSymbolicLink()) throw updateError('UPDATE_CHECKSUM_MISMATCH');
    verificationStep = 'size';
    if (size !== candidate.size) throw updateError('UPDATE_CHECKSUM_MISMATCH');
    verificationStep = 'sameFileAfter';
    if (!sameFile(opened, after)) throw updateError('UPDATE_CHECKSUM_MISMATCH');
    verificationStep = 'sameFileFinal';
    if (!sameFile(after, final)) throw updateError('UPDATE_CHECKSUM_MISMATCH');
    verificationStep = 'realpathAfter';
    if (await api.realpath(filePath) !== filePath) throw updateError('UPDATE_CHECKSUM_MISMATCH');
    verificationStep = 'digest';
    if (!timingSafeEqual(digest.digest(), Buffer.from(candidate.sha512, 'base64'))) {
      throw updateError('UPDATE_CHECKSUM_MISMATCH');
    }
    assertActive();
  } catch (error) {
    const code = signal?.aborted || error?.code === 'UPDATE_PREPARATION_FAILED'
      ? 'UPDATE_PREPARATION_FAILED'
      : error?.code === 'EACCES' || error?.code === 'EPERM' ? 'UPDATE_PERMISSION_DENIED' : 'UPDATE_CHECKSUM_MISMATCH';
    const failure = updateError(code);
    // Internal diagnostics retain the exact failure without changing the public
    // code/message or serializing private filesystem details into IPC payloads.
    Object.defineProperties(failure, {
      cause: { value: error },
      verificationStep: { value: signal?.aborted ? 'abort' : verificationStep },
    });
    throw failure;
  } finally {
    signal?.removeEventListener('abort', abort);
    stream?.destroy();
    await handle?.close().catch(() => {});
  }
}

function validPublisherNames(names) {
  return Array.isArray(names) && names.length > 0
    && names.every(name => typeof name === 'string' && name.length > 0 && name === name.trim()
      && name.length <= 4096 && !UNSAFE_TEXT.test(name));
}

function readPublisherNames(configPath, { fs: fileSystem = fs } = {}) {
  let descriptor;
  try {
    descriptor = fileSystem.openSync(configPath, fileSystem.constants.O_RDONLY | (fileSystem.constants.O_NOFOLLOW || 0));
    const stat = fileSystem.fstatSync(descriptor);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_CONFIG_BYTES) throw updateError(SIGNATURE_INVALID);
    const text = fileSystem.readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) throw updateError(SIGNATURE_INVALID);
    const config = yaml.load(text, { schema: yaml.JSON_SCHEMA, json: false });
    if (!config || !validPublisherNames(config.publisherName)) throw updateError(SIGNATURE_INVALID);
    return Object.freeze([...config.publisherName]);
  } catch {
    throw updateError(SIGNATURE_INVALID);
  } finally {
    if (descriptor !== undefined) {
      try { fileSystem.closeSync(descriptor); } catch { throw updateError(SIGNATURE_INVALID); }
    }
  }
}

// parseDn is the public electron-builder parser. Validate the complete syntax
// first: the parser itself deliberately tolerates truncated/duplicate attributes.
function completeDn(value) {
  if (typeof value !== 'string' || !value || value.length > 16 * 1024 || UNSAFE_TEXT.test(value)) return null;
  let quote = false;
  let escaped = false;
  let segment = '';
  const attributes = [];
  const append = () => {
    if (!/^\s*[A-Za-z][A-Za-z0-9.]*\s*=\s*\S[\s\S]*$/.test(segment)) return false;
    attributes.push(segment);
    segment = '';
    return true;
  };
  for (const character of value) {
    if (escaped) { segment += character; escaped = false; continue; }
    if (character === '\\') { segment += character; escaped = true; continue; }
    if (character === '"') { quote = !quote; segment += character; continue; }
    if (!quote && /[,;+]/.test(character)) {
      if (!append()) return null;
    } else segment += character;
  }
  if (quote || escaped || !append()) return null;
  const result = parseDn(value);
  // Reject duplicate keys, empty decoded values, and any discarded fragments.
  if (result.size !== attributes.length || [...result].some(([key, val]) => !key || !val || UNSAFE_TEXT.test(val))) return null;
  return result;
}

const SIGNATURE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  '$signature = Get-AuthenticodeSignature -LiteralPath $env:USSHTC107_UPDATE_INSTALLER',
  'if ($null -eq $signature -or $null -eq $signature.SignerCertificate) { exit 1 }',
  "[pscustomobject]@{ Status = $signature.Status.ToString(); Path = $signature.Path; SignerCertificate = @{ Subject = $signature.SignerCertificate.Subject } } | ConvertTo-Json -Compress -Depth 3",
].join('; ');

function canonicalWindowsPath(value) {
  return typeof value === 'string' && !UNSAFE_TEXT.test(value)
    && /^[A-Za-z]:\\/.test(value) && !value.slice(2).includes(':')
    && path.win32.normalize(value) === value;
}

async function verifyWindowsSignature(publisherNames, filePath, { execFile: run = execFile, env = process.env } = {}) {
  try {
    if (!validPublisherNames(publisherNames) || !canonicalWindowsPath(filePath)) return SIGNATURE_INVALID;
    const publishers = publisherNames.map(name => {
      const dn = completeDn(name);
      if (name.includes('=') && !dn) throw updateError(SIGNATURE_INVALID);
      return { name, dn };
    });
    const systemRoot = env.SystemRoot || env.SYSTEMROOT;
    if (!canonicalWindowsPath(systemRoot) || systemRoot.endsWith('\\')) return SIGNATURE_INVALID;
    const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return await new Promise(resolve => {
      let settled = false;
      const finish = value => { if (!settled) { settled = true; resolve(value); } };
      try {
        run(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command', SIGNATURE_SCRIPT], {
          shell: false,
          windowsHide: true,
          timeout: 5000,
          maxBuffer: 64 * 1024,
          encoding: 'utf8',
          env: { ...env, PSModulePath: '', USSHTC107_UPDATE_INSTALLER: filePath },
        }, (error, stdout, stderr) => {
          try {
            if (error || (stderr && stderr.length) || typeof stdout !== 'string' || Buffer.byteLength(stdout) > 64 * 1024) return finish(SIGNATURE_INVALID);
            const data = JSON.parse(stdout);
            if (!data || Array.isArray(data) || data.Status !== 'Valid' || !canonicalWindowsPath(data.Path)
                || data.Path !== filePath || !data.SignerCertificate || Array.isArray(data.SignerCertificate)) return finish(SIGNATURE_INVALID);
            const subject = completeDn(data.SignerCertificate.Subject);
            if (!subject || !subject.get('CN')) return finish(SIGNATURE_INVALID);
            const matches = publishers.some(({ name, dn }) => dn
              ? [...dn].every(([key, value]) => subject.get(key) === value)
              : subject.get('CN') === name);
            finish(matches ? null : SIGNATURE_INVALID);
          } catch { finish(SIGNATURE_INVALID); }
        });
      } catch { finish(SIGNATURE_INVALID); }
    });
  } catch { return SIGNATURE_INVALID; }
}

module.exports = { validateUpdateInfo, verifyUpdateFile, readPublisherNames, verifyWindowsSignature };
