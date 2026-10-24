'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { gzipSync, deflateRawSync } = require('node:zlib');
const yaml = require('js-yaml');
const { verifyUpdateArtifacts } = require('../../scripts/verify-update-artifacts.cjs');

const version = '1.2.1';
const prefix = `usshtc107-${version}`;
const definitions = {
  win: { metadata: 'latest.yml', files: [`${prefix}-win-x64.exe`], maps: true, manual: [] },
  mac: { metadata: 'latest-mac.yml', files: [`${prefix}-mac-x64.zip`, `${prefix}-mac-arm64.zip`],
    maps: true, manual: [`${prefix}-mac-x64.dmg`, `${prefix}-mac-arm64.dmg`] },
  linux: { metadata: 'latest-linux.yml', files: [`${prefix}-linux-x86_64.AppImage`, `${prefix}-linux-amd64.deb`],
    maps: false, manual: [] },
};
const digest = (data) => createHash('sha512').update(data).digest('base64');

function fixture(t, platform) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc-update-release-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const platforms = platform === 'all' ? ['win', 'mac', 'linux'] : [platform];
  const documents = {};
  for (const target of platforms) {
    const layout = definitions[target];
    const metadata = { version, files: [] };
    for (const name of [...layout.files, ...layout.manual]) {
      let content = Buffer.from(`Final signed fixture bytes for ${name}\n`, 'utf8');
      const blockmap = Buffer.from(JSON.stringify({ version: '2', files: [
        { name: 'file', offset: 0, checksums: ['fixture'], sizes: [content.length] },
      ] }));
      let blockMapSize;
      if (name.endsWith('.AppImage')) {
        const compressed = deflateRawSync(blockmap);
        const trailer = Buffer.alloc(4);
        trailer.writeUInt32BE(compressed.length);
        content = Buffer.concat([content, compressed, trailer]);
        blockMapSize = compressed.length;
      }
      fs.writeFileSync(path.join(directory, name), content);
      if (layout.files.includes(name)) {
        metadata.files.push({ url: name, size: content.length, sha512: digest(content),
          ...(blockMapSize === undefined ? {} : { blockMapSize }) });
        if (layout.maps) fs.writeFileSync(path.join(directory, `${name}.blockmap`), gzipSync(blockmap));
      }
    }
    metadata.path = metadata.files[0].url;
    metadata.sha512 = metadata.files[0].sha512;
    documents[target] = metadata;
    fs.writeFileSync(path.join(directory, layout.metadata), yaml.dump(metadata));
  }
  return {
    directory, documents,
    write(target) {
      fs.writeFileSync(path.join(directory, definitions[target].metadata), yaml.dump(documents[target]));
    },
    verify: () => verifyUpdateArtifacts({ directory, platform, version }),
  };
}

for (const platform of ['win', 'mac', 'linux', 'all']) {
  test(`verifies the final ${platform} artifact set and metadata against actual files`, async (t) => {
    const source = fixture(t, platform);
    const result = await source.verify();
    assert.deepEqual(result, fs.readdirSync(source.directory).sort());
    if (platform === 'all') assert.equal(result.length, 13);
    if (platform === 'linux') assert.equal(result.some((name) => name.endsWith('.AppImage.blockmap')), false);
  });
}

test('rejects same-length installer tampering after signing and metadata generation', async (t) => {
  const source = fixture(t, 'win');
  const filename = path.join(source.directory, definitions.win.files[0]);
  const changed = fs.readFileSync(filename);
  changed[0] ^= 1;
  fs.writeFileSync(filename, changed);
  await assert.rejects(source.verify(), /SHA512 mismatch/);
});

test('rejects changed artifact sizes and absent SHA512 without falling back to SHA256', async (t) => {
  const source = fixture(t, 'win');
  const file = source.documents.win.files[0];
  file.size += 1;
  source.write('win');
  await assert.rejects(source.verify(), /size mismatch/);
  file.size -= 1;
  delete file.sha512;
  file.sha2 = 'a'.repeat(64);
  source.write('win');
  await assert.rejects(source.verify(), /missing SHA512/);
});

test('requires both actual Mac ZIP architectures and their metadata entries', async (t) => {
  const source = fixture(t, 'mac');
  const arm64 = definitions.mac.files[1];
  const bytes = fs.readFileSync(path.join(source.directory, arm64));
  fs.unlinkSync(path.join(source.directory, arm64));
  await assert.rejects(source.verify(), /missing .*arm64\.zip/);
  fs.writeFileSync(path.join(source.directory, arm64), bytes);
  source.documents.mac.files.pop();
  source.write('mac');
  await assert.rejects(source.verify(), /incomplete latest-mac/);
});

test('requires each external ZIP/installer map without inventing an AppImage sidecar', async (t) => {
  const source = fixture(t, 'mac');
  const map = path.join(source.directory, `${definitions.mac.files[1]}.blockmap`);
  fs.unlinkSync(map);
  await assert.rejects(source.verify(), /missing .*arm64\.zip\.blockmap/);
  fs.writeFileSync(map, Buffer.alloc(0));
  await assert.rejects(source.verify(), /nonempty regular file/);
});

test('validates embedded AppImage map sizes against the actual trailing length field', async (t) => {
  const source = fixture(t, 'linux');
  const entry = source.documents.linux.files[0];
  entry.blockMapSize -= 1;
  source.write('linux');
  await assert.rejects(source.verify(), /embedded blockmap size mismatch/);
  entry.blockMapSize = entry.size;
  source.write('linux');
  await assert.rejects(source.verify(), /invalid embedded blockmap size/);
});

test('rejects an embedded-map claim on an external-map ZIP asset', async (t) => {
  const source = fixture(t, 'mac');
  source.documents.mac.files[0].blockMapSize = 1;
  source.write('mac');
  await assert.rejects(source.verify(), /invalid embedded blockmap size/);
});

test('rejects unsafe, encoded, absolute, and cross-platform metadata URLs', async (t) => {
  const source = fixture(t, 'win');
  const name = definitions.win.files[0];
  for (const url of [
    `../${name}`, `sub/${name}`, `sub\\${name}`, `/${name}`, `C:\\${name}`,
    `https://github.com/Enthusjast/usshtc-107/${name}`, `file:///${name}`,
    `${name}?token=private`, `${name}#fragment`, `%2e%2e%2f${name}`, `${name}%00`,
    definitions.mac.files[0], '.', '..', '',
  ]) {
    source.documents.win.files[0].url = url;
    source.write('win');
    await assert.rejects(source.verify(), /allowed artifact basename/, url);
  }
});

test('rejects duplicate metadata assets and legacy metadata drift', async (t) => {
  const source = fixture(t, 'mac');
  const original = source.documents.mac.files[1];
  source.documents.mac.files[1] = { ...source.documents.mac.files[0] };
  source.write('mac');
  await assert.rejects(source.verify(), /duplicate metadata asset/);
  source.documents.mac.files[1] = original;
  source.documents.mac.sha512 = digest(Buffer.from('different signed version'));
  source.write('mac');
  await assert.rejects(source.verify(), /legacy metadata SHA512 mismatch/);
});

test('rejects unexpected builder output instead of uploading it', async (t) => {
  const source = fixture(t, 'linux');
  fs.writeFileSync(path.join(source.directory, 'builder-debug.yml'), 'private build diagnostic');
  await assert.rejects(source.verify(), /unexpected output builder-debug/);
});

test('rejects malformed YAML, mismatched versions, and unstable package versions', async (t) => {
  const source = fixture(t, 'win');
  fs.writeFileSync(path.join(source.directory, 'latest.yml'), 'version: [unterminated');
  await assert.rejects(source.verify(), /malformed latest/);
  source.documents.win.version = '1.2.2';
  source.write('win');
  await assert.rejects(source.verify(), /incomplete latest/);
  for (const invalid of ['1.2.1-beta.1', 'v1.2.1', '../1.2.1', 'invalid']) {
    await assert.rejects(verifyUpdateArtifacts({ directory: source.directory, platform: 'win', version: invalid }),
      /stable package version/);
  }
});

test('rejects symlinked artifacts even when their target has matching bytes', { skip: process.platform === 'win32' }, async (t) => {
  const source = fixture(t, 'win');
  const name = definitions.win.files[0];
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc-external-update-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const target = path.join(outside, name);
  fs.renameSync(path.join(source.directory, name), target);
  fs.symlinkSync(target, path.join(source.directory, name));
  await assert.rejects(source.verify(), /nonempty regular file/);
});
