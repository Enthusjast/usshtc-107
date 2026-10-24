'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const yaml = require('js-yaml');
const semver = require('semver');

const MAX_METADATA_BYTES = 1024 * 1024;

function artifactLayout(platform, version) {
  const prefix = `usshtc107-${version}`;
  switch (platform) {
    case 'win': {
      const installer = `${prefix}-win-x64.exe`;
      return { metadata: 'latest.yml', updates: [installer], artifacts: [installer, `${installer}.blockmap`] };
    }
    case 'mac': {
      const archives = ['x64', 'arm64'].map((arch) => `${prefix}-mac-${arch}.zip`);
      return { metadata: 'latest-mac.yml', updates: archives, artifacts: [
        ...archives, ...archives.map((name) => `${name}.blockmap`),
        ...['x64', 'arm64'].map((arch) => `${prefix}-mac-${arch}.dmg`),
      ] };
    }
    case 'linux': {
      const artifacts = [`${prefix}-linux-x86_64.AppImage`, `${prefix}-linux-amd64.deb`];
      // AppImage's differential blockmap is embedded in the image, not a sidecar.
      return { metadata: 'latest-linux.yml', updates: artifacts, artifacts };
    }
    default:
      throw new Error('Expected platform win, mac, linux, or all');
  }
}

function fail(message) {
  throw new Error(`Invalid update artifacts: ${message}`);
}

function regularFile(directory, name) {
  const filePath = path.join(directory, name);
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    fail(`missing ${name}`);
  }
  if (!stat.isFile() || stat.size <= 0) fail(`not a nonempty regular file: ${name}`);
  return { filePath, stat };
}

function canonicalSha512(value) {
  return typeof value === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(value)
    && Buffer.from(value, 'base64').toString('base64') === value;
}

function scopedName(value, allowed) {
  // Metadata must reference the exact uploaded basename: no URL, encoding,
  // separator, query, fragment, or platform-dependent path interpretation.
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
    || !allowed.has(value)) fail('metadata URL is not an allowed artifact basename');
  return value;
}

async function sha512File(filePath) {
  const hash = createHash('sha512');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('base64');
}

async function verifyUpdateArtifacts({ directory, platform, version }) {
  if (typeof version !== 'string' || semver.valid(version) !== version
    || semver.prerelease(version) !== null) fail('expected a stable package version');
  const platforms = platform === 'all' ? ['win', 'mac', 'linux'] : [platform];
  const layouts = platforms.map((target) => artifactLayout(target, version));
  const allowed = new Set(layouts.flatMap((layout) => [layout.metadata, ...layout.artifacts]));
  const entries = fs.readdirSync(directory);
  for (const name of entries) {
    if (!allowed.has(name)) fail(`unexpected output ${name}`);
  }
  for (const name of allowed) regularFile(directory, name);

  for (const layout of layouts) {
    const { filePath, stat } = regularFile(directory, layout.metadata);
    if (stat.size > MAX_METADATA_BYTES) fail('metadata exceeds the size limit');
    let metadata;
    try {
      metadata = yaml.load(fs.readFileSync(filePath, 'utf8'), { schema: yaml.JSON_SCHEMA });
    } catch {
      fail(`malformed ${layout.metadata}`);
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || metadata.version !== version || !Array.isArray(metadata.files)
      || metadata.files.length !== layout.updates.length) fail(`incomplete ${layout.metadata}`);
    const expected = new Set(layout.updates);
    const verified = new Map();
    for (const file of metadata.files) {
      if (!file || typeof file !== 'object' || Array.isArray(file)) fail('malformed metadata file');
      const name = scopedName(file.url, expected);
      if (verified.has(name)) fail(`duplicate metadata asset ${name}`);
      if (!canonicalSha512(file.sha512)) fail(`missing SHA512 for ${name}`);
      const artifact = regularFile(directory, name);
      if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size !== artifact.stat.size) {
        fail(`size mismatch for ${name}`);
      }
      if (file.blockMapSize !== undefined) {
        if (!name.endsWith('.AppImage') || !Number.isSafeInteger(file.blockMapSize)
          || file.blockMapSize <= 0 || file.blockMapSize > artifact.stat.size - 4) {
          fail(`invalid embedded blockmap size for ${name}`);
        }
        const descriptor = fs.openSync(artifact.filePath, 'r');
        try {
          const trailer = Buffer.alloc(4);
          if (fs.readSync(descriptor, trailer, 0, 4, artifact.stat.size - 4) !== 4
            || trailer.readUInt32BE(0) !== file.blockMapSize) {
            fail(`embedded blockmap size mismatch for ${name}`);
          }
        } finally {
          fs.closeSync(descriptor);
        }
      }
      const digest = await sha512File(artifact.filePath);
      if (file.sha512 !== digest) fail(`SHA512 mismatch for ${name}`);
      verified.set(name, digest);
    }
    // Builder still emits legacy path/SHA512 alongside files. If present they
    // must describe the same verified asset, never a second unverified target.
    if (metadata.path !== undefined || metadata.sha512 !== undefined) {
      const name = scopedName(metadata.path, expected);
      if (metadata.sha512 !== verified.get(name)) fail('legacy metadata SHA512 mismatch');
    }
  }
  return [...allowed].sort();
}

module.exports = { verifyUpdateArtifacts };

if (require.main === module) {
  const [directory, platform, ...extra] = process.argv.slice(2);
  if (!directory || !platform || extra.length) {
    console.error('Usage: node scripts/verify-update-artifacts.cjs <directory> <win|mac|linux|all>');
    process.exitCode = 1;
  } else {
    verifyUpdateArtifacts({ directory, platform, version: require('../package.json').version })
      .then((artifacts) => console.log(`Verified ${artifacts.length} release artifacts`))
      .catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
