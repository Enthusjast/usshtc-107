const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const {
  validateUpdateInfo, verifyUpdateFile, readPublisherNames, verifyWindowsSignature,
} = require('../../electron/update-security');

const VERSION = '1.3.0';
const BODY = Buffer.from('update payload 中文🙂\n');
const SHA512 = createHash('sha512').update(BODY).digest('base64');
const LINUX_ASSET = `usshtc107-${VERSION}-linux-x86_64.AppImage`;
const RELEASE_URL = `https://github.com/Enthusjast/usshtc-107/releases/download/v${VERSION}/`;
const TARGET = { currentVersion: '1.2.1', platform: 'linux', arch: 'x64' };
const INVALID = 'UPDATE_SIGNATURE_INVALID';

function file(url = LINUX_ASSET, extras = {}) {
  return { url, size: BODY.length, sha512: SHA512, ...extras };
}
function metadata(extras = {}) {
  return { version: VERSION, files: [file()], releaseDate: '2026-10-24T01:02:03.000Z', ...extras };
}
function candidate() {
  return validateUpdateInfo(metadata(), TARGET).candidate;
}
function hasCode(code) {
  return error => error.code === code && error.message === code;
}
function temporary(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc-update-security-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function payload(t, data = BODY) {
  const root = temporary(t);
  const location = path.join(root, LINUX_ASSET);
  fs.writeFileSync(location, data);
  return { root, location };
}

// This stream adapter keeps the real descriptor/stat/path operations and allows
// a deterministic change at an actual stream boundary, without timing races.
function interceptStream(intercept) {
  return {
    ...fs,
    promises: {
      ...fs.promises,
      async open(...args) {
        const handle = await fs.promises.open(...args);
        return {
          stat: (...options) => handle.stat(...options),
          close: () => handle.close(),
          createReadStream(options) {
            const source = handle.createReadStream(options);
            return Readable.from((async function* () {
              let index = 0;
              for await (const chunk of source) {
                await intercept({ chunk, index: index++, options });
                yield chunk;
              }
            })());
          },
        };
      },
    },
  };
}

test('metadata selects one frozen target candidate, including builder architecture aliases', () => {
  const cases = [
    ['linux', 'x64', LINUX_ASSET],
    ['linux', 'x64', `usshtc107-${VERSION}-linux-x64.AppImage`],
    ['linux', 'arm64', `usshtc107-${VERSION}-linux-arm64.AppImage`],
    ['darwin', 'x64', `usshtc107-${VERSION}-mac-x64.zip`],
    ['darwin', 'arm64', `usshtc107-${VERSION}-mac-arm64.zip`],
    ['win32', 'x64', `usshtc107-${VERSION}-win-x64.exe`],
  ];
  for (const [platform, arch, assetName] of cases) {
    const result = validateUpdateInfo(metadata({ files: [file(assetName)] }), { ...TARGET, platform, arch });
    assert.deepEqual(result.candidate, { version: VERSION, platform, arch, assetName, size: BODY.length, sha512: SHA512 });
    assert.equal(Object.isFrozen(result.candidate), true);
    assert.equal(result.releaseDate, '2026-10-24T01:02:03.000Z');
    assert.equal(result.releaseNotes, '');
  }
  const mac = validateUpdateInfo(metadata({ files: [
    file(`usshtc107-${VERSION}-mac-x64.zip`),
    file(`usshtc107-${VERSION}-mac-arm64.zip`),
    file(`usshtc107-${VERSION}-mac-arm64.dmg`),
  ] }), { ...TARGET, platform: 'darwin', arch: 'arm64' });
  assert.equal(mac.candidate.assetName, `usshtc107-${VERSION}-mac-arm64.zip`);
  assert.equal(validateUpdateInfo(metadata({ files: [file(RELEASE_URL + LINUX_ASSET)] }), TARGET).candidate.assetName, LINUX_ASSET);
});

test('versions must be canonical raw semver, greater than current, and stable', () => {
  for (const version of ['1.2.1', '1.2.0', '0.0.0', '1.3.0-beta.1', '1.3.0+build.1', 'v1.3.0', '=1.3.0', ' 1.3.0', '1.3.0 ', '01.3.0', '1.3', 130, null, 'garbage']) {
    assert.throws(() => validateUpdateInfo(metadata({ version }), TARGET), hasCode('UPDATE_VERSION_REJECTED'), String(version));
  }
  for (const currentVersion of ['v1.2.1', '1.2.1 ', '1.2.1-beta.1', '', undefined]) {
    assert.throws(() => validateUpdateInfo(metadata(), { ...TARGET, currentVersion }), hasCode('UPDATE_VERSION_REJECTED'));
  }
});

test('metadata rejects unsupported, absent, duplicate, ambiguous, or wrong target assets', () => {
  const invalid = [
    null, [], metadata({ files: [] }), metadata({ files: null }),
    metadata({ files: [null] }), metadata({ files: [file(), file()] }),
    metadata({ files: [file(), file(RELEASE_URL + LINUX_ASSET)] }),
    metadata({ files: [file(), file(`usshtc107-${VERSION}-linux-x64.AppImage`)] }),
    metadata({ files: [file(`usshtc107-${VERSION}-linux-arm64.AppImage`)] }),
    metadata({ files: [file(`usshtc107-${VERSION}-linux-x86_64.deb`)] }),
    metadata({ files: [file(`usshtc107-${VERSION}-mac-x64.zip`)] }),
    metadata({ files: [file(`other-${VERSION}-linux-x86_64.AppImage`)] }),
    metadata({ files: [file('usshtc107-1.4.0-linux-x86_64.AppImage')] }),
  ];
  for (const info of invalid) assert.throws(() => validateUpdateInfo(info, TARGET), hasCode('UPDATE_INVALID_METADATA'));
  assert.throws(() => validateUpdateInfo(metadata(), { ...TARGET, platform: 'freebsd' }), hasCode('UPDATE_INVALID_METADATA'));
  assert.throws(() => validateUpdateInfo(metadata(), { ...TARGET, arch: 'universal' }), hasCode('UPDATE_INVALID_METADATA'));
});

test('metadata URLs never escape the fixed repository, tag, or ordinary basename', () => {
  for (const url of [
    `https://example.com/${LINUX_ASSET}`, `http://github.com/Enthusjast/usshtc-107/releases/download/v${VERSION}/${LINUX_ASSET}`,
    RELEASE_URL.replace('Enthusjast/', 'attacker/') + LINUX_ASSET,
    RELEASE_URL.replace('usshtc-107/', 'usshtc-107.evil/') + LINUX_ASSET,
    RELEASE_URL.replace(`v${VERSION}`, 'v9.9.9') + LINUX_ASSET,
    `https://github.com@evil.test/Enthusjast/usshtc-107/releases/download/v${VERSION}/${LINUX_ASSET}`,
    `${RELEASE_URL}${LINUX_ASSET}?token=secret`, `${RELEASE_URL}${LINUX_ASSET}#fragment`,
    `//github.com/Enthusjast/usshtc-107/${LINUX_ASSET}`, `../${LINUX_ASSET}`, `./${LINUX_ASSET}`,
    `sub/${LINUX_ASSET}`, `sub\\${LINUX_ASSET}`, `/tmp/${LINUX_ASSET}`, `C:\\temp\\${LINUX_ASSET}`,
    `%2e%2e%2f${LINUX_ASSET}`, `${RELEASE_URL}../v${VERSION}/${LINUX_ASSET}`, `${LINUX_ASSET}\n`, '', null,
  ]) {
    assert.throws(() => validateUpdateInfo(metadata({ files: [file(url)] }), TARGET), hasCode('UPDATE_INVALID_METADATA'), String(url));
  }
  // Even an unselected file must not introduce an alternative arbitrary feed.
  assert.throws(() => validateUpdateInfo(metadata({ files: [file(), file('https://evil.test/other.zip')] }), TARGET), hasCode('UPDATE_INVALID_METADATA'));
});

test('metadata requires positive safe integer sizes and full canonical SHA512, never sha2-only', () => {
  for (const size of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '24', null, undefined]) {
    assert.throws(() => validateUpdateInfo(metadata({ files: [file(LINUX_ASSET, { size })] }), TARGET), hasCode('UPDATE_INVALID_METADATA'));
  }
  const noncanonical = `${SHA512.slice(0, 85)}${'ABCDEFGHIJKLMNOP'.includes(SHA512[85]) ? 'B' : 'R'}==`;
  for (const sha512 of ['', null, undefined, SHA512.slice(0, -2), SHA512 + '\n', SHA512.replace('==', '='), 'a'.repeat(128), noncanonical]) {
    assert.throws(() => validateUpdateInfo(metadata({ files: [file(LINUX_ASSET, { sha512, sha2: 'a'.repeat(64) })] }), TARGET), hasCode('UPDATE_INVALID_METADATA'));
  }
  assert.throws(() => validateUpdateInfo(metadata({ files: [file(LINUX_ASSET, { sha512: undefined })], sha512: SHA512 }), TARGET), hasCode('UPDATE_INVALID_METADATA'));
});

test('release notes are plain text with a 64KiB UTF8 boundary and no markup or active content', () => {
  const releaseNotes = '<h1>Changes &amp; fixes</h1><script>alert("secret")</script><style>hidden</style>'
    + '<p>中文🙂<br/>safe <a href="javascript:bad">link</a></p><!-- comment -->'
    + '&lt;img src=x onerror=bad&gt;\0end';
  const result = validateUpdateInfo(metadata({ releaseNotes }), TARGET);
  assert.match(result.releaseNotes, /Changes & fixes/);
  assert.match(result.releaseNotes, /中文🙂/);
  assert.match(result.releaseNotes, /safe link/);
  assert.doesNotMatch(result.releaseNotes, /[<>\0]|secret|hidden|onerror|javascript|comment/);
  const prefix = 'a'.repeat(64 * 1024 - 3);
  assert.equal(validateUpdateInfo(metadata({ releaseNotes: prefix + '🙂tail' }), TARGET).releaseNotes, prefix);
  const exact = '中'.repeat(21845) + 'x';
  assert.equal(Buffer.byteLength(exact), 64 * 1024);
  assert.equal(validateUpdateInfo(metadata({ releaseNotes: exact + 'more' }), TARGET).releaseNotes, exact);
  assert.equal(validateUpdateInfo(metadata({ releaseNotes: [{ version: '1.3.0', note: '<b>one</b>' }, { note: null }, { note: 'two' }] }), TARGET).releaseNotes, 'one\n\n\n\ntwo');
  assert.throws(() => validateUpdateInfo(metadata({ releaseNotes: { html: 'bad' } }), TARGET), hasCode('UPDATE_INVALID_METADATA'));
  assert.throws(() => validateUpdateInfo(metadata({ releaseNotes: [false] }), TARGET), hasCode('UPDATE_INVALID_METADATA'));
  assert.equal(validateUpdateInfo(metadata({ releaseDate: null }), TARGET).releaseDate, null);
  assert.throws(() => validateUpdateInfo(metadata({ releaseDate: 'not a date' }), TARGET), hasCode('UPDATE_INVALID_METADATA'));
});

test('stream verification accepts exact files, rechecks the same cached file, and refuses tampering', async t => {
  const { location } = payload(t);
  await verifyUpdateFile(location, candidate());
  await verifyUpdateFile(location, candidate());
  fs.writeFileSync(location, Buffer.alloc(BODY.length, 65));
  await assert.rejects(verifyUpdateFile(location, candidate()), hasCode('UPDATE_CHECKSUM_MISMATCH'));
  for (const data of [BODY.subarray(0, -1), Buffer.concat([BODY, Buffer.from('x')]), Buffer.alloc(0)]) {
    fs.writeFileSync(location, data);
    await assert.rejects(verifyUpdateFile(location, candidate()), hasCode('UPDATE_CHECKSUM_MISMATCH'));
  }
});

test('stream verification checks 64KiB boundaries without loading the whole payload', async t => {
  for (const size of [1, 65535, 65536, 65537, 3 * 65536 + 17]) {
    const data = Buffer.alloc(size, size % 251);
    const { location } = payload(t, data);
    const expected = { ...candidate(), size, sha512: createHash('sha512').update(data).digest('base64') };
    let chunks = 0;
    const adapter = interceptStream(({ chunk, options }) => {
      chunks += 1;
      assert.equal(options.highWaterMark, 64 * 1024);
      assert.ok(chunk.length <= 64 * 1024);
    });
    adapter.readFileSync = adapter.readFile = () => { throw new Error('whole-file read forbidden'); };
    adapter.promises.readFile = () => { throw new Error('whole-file read forbidden'); };
    await verifyUpdateFile(location, expected, { fs: adapter });
    assert.ok(chunks >= Math.ceil(size / 65536));
  }
});

test('stream verification rejects noncanonical, relative, missing, directory, and symlink paths', async t => {
  const { location, root } = payload(t);
  for (const locationToCheck of [path.basename(location), path.join(root, 'missing'), root, `${root}${path.sep}..${path.sep}${path.basename(root)}${path.sep}${LINUX_ASSET}`, location + '\0']) {
    await assert.rejects(verifyUpdateFile(locationToCheck, candidate()), hasCode('UPDATE_CHECKSUM_MISMATCH'));
  }
  if (process.platform !== 'win32') {
    const link = path.join(root, 'link');
    fs.symlinkSync(location, link);
    await assert.rejects(verifyUpdateFile(link, candidate()), hasCode('UPDATE_CHECKSUM_MISMATCH'));
    const directoryLink = path.join(root, 'directory-link');
    fs.symlinkSync(root, directoryLink);
    await assert.rejects(verifyUpdateFile(path.join(directoryLink, LINUX_ASSET), candidate()), hasCode('UPDATE_CHECKSUM_MISMATCH'));
  }
  await assert.rejects(verifyUpdateFile(location, { ...candidate(), size: 0 }), hasCode('UPDATE_CHECKSUM_MISMATCH'));
  await assert.rejects(verifyUpdateFile(location, { ...candidate(), sha512: 'bad' }), hasCode('UPDATE_CHECKSUM_MISMATCH'));
});

test('mutation during hashing fails even when bytes and final size match the frozen digest', async t => {
  const { location } = payload(t, Buffer.alloc(3 * 65536, 42));
  const original = fs.readFileSync(location);
  const expected = { ...candidate(), size: original.length, sha512: createHash('sha512').update(original).digest('base64') };
  const adapter = interceptStream(({ index }) => {
    if (index !== 0) return;
    // Preserve all bytes, but change the file while the descriptor is being read.
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(location, future, future);
  });
  await assert.rejects(verifyUpdateFile(location, expected, { fs: adapter }), hasCode('UPDATE_CHECKSUM_MISMATCH'));
});

test('replacement of a path during hashing fails despite identical bytes', async t => {
  const { location, root } = payload(t);
  const replacement = path.join(root, 'replacement');
  fs.writeFileSync(replacement, BODY);
  const adapter = interceptStream(({ index }) => {
    if (index === 0) fs.renameSync(replacement, location);
  });
  await assert.rejects(verifyUpdateFile(location, candidate(), { fs: adapter }), hasCode('UPDATE_CHECKSUM_MISMATCH'));
});

test('growing, truncating, and failing streams never verify and close their descriptors', async t => {
  for (const mutate of [
    location => fs.appendFileSync(location, 'extra'),
    location => fs.truncateSync(location, 0),
    () => { throw new Error('private stream failure'); },
  ]) {
    const { location } = payload(t);
    const adapter = interceptStream(({ index }) => { if (index === 0) mutate(location); });
    let closed = 0;
    const open = adapter.promises.open;
    adapter.promises.open = async (...args) => {
      const handle = await open(...args);
      const close = handle.close;
      handle.close = async () => { closed += 1; await close(); };
      return handle;
    };
    await assert.rejects(verifyUpdateFile(location, candidate(), { fs: adapter }), hasCode('UPDATE_CHECKSUM_MISMATCH'));
    assert.equal(closed, 1);
  }
});

test('a replacement between lstat and open is rejected before accepting its stream', async t => {
  const { location, root } = payload(t);
  const replacement = path.join(root, 'replacement');
  fs.writeFileSync(replacement, BODY);
  const adapter = {
    ...fs,
    promises: {
      ...fs.promises,
      async open(...args) {
        fs.renameSync(replacement, location);
        return fs.promises.open(...args);
      },
    },
  };
  await assert.rejects(verifyUpdateFile(location, candidate(), { fs: adapter }), hasCode('UPDATE_CHECKSUM_MISMATCH'));
});

test('abort before or during hashing is fixed-code, closes the descriptor, and never returns success', async t => {
  const { location } = payload(t);
  const before = new AbortController();
  before.abort();
  await assert.rejects(verifyUpdateFile(location, candidate(), { signal: before.signal }), hasCode('UPDATE_PREPARATION_FAILED'));
  const during = new AbortController();
  const adapter = interceptStream(() => during.abort());
  let closed = 0;
  const open = adapter.promises.open;
  adapter.promises.open = async (...args) => {
    const handle = await open(...args);
    const close = handle.close;
    handle.close = async () => { closed += 1; await close(); };
    return handle;
  };
  await assert.rejects(verifyUpdateFile(location, candidate(), { signal: during.signal, fs: adapter }), hasCode('UPDATE_PREPARATION_FAILED'));
  assert.equal(closed, 1);
});

test('filesystem errors expose only fixed codes, not private paths or original errors', async t => {
  const { location } = payload(t);
  for (const [code, expected] of [['EACCES', 'UPDATE_PERMISSION_DENIED'], ['EPERM', 'UPDATE_PERMISSION_DENIED'], ['EIO', 'UPDATE_CHECKSUM_MISMATCH']]) {
    const adapter = { ...fs, promises: { ...fs.promises, realpath: async () => { throw Object.assign(new Error('secret path certificate raw JSON'), { code }); } } };
    await assert.rejects(verifyUpdateFile(location, candidate(), { fs: adapter }), hasCode(expected));
  }
});

test('publisher config is parsed as YAML and requires a nonempty array of exact nonempty strings', t => {
  const root = temporary(t);
  const config = path.join(root, 'app-update.yml');
  fs.writeFileSync(config, 'provider: github\npublisherName:\n  - "Acme, Inc."\n  - \'CN=Publisher, O=Organization, C=US\'\n');
  const names = readPublisherNames(config);
  assert.deepEqual(names, ['Acme, Inc.', 'CN=Publisher, O=Organization, C=US']);
  assert.equal(Object.isFrozen(names), true);
  for (const source of [
    '', 'provider: github\n', 'publisherName: Publisher\n', 'publisherName: []\n', 'publisherName: [null]\n',
    'publisherName: [true]\n', 'publisherName: [123]\n', 'publisherName: [""]\n', 'publisherName: [" padded "]\n',
    'publisherName: ["line\\nbreak"]\n', 'publisherName: [Valid]\npublisherName: [Other]\n',
    'publisherName: [\n', 'publisherName: !!js/function >\n function () {}\n', 'publisherName: [' + 'x'.repeat(65536) + ']\n',
  ]) {
    fs.writeFileSync(config, source);
    assert.throws(() => readPublisherNames(config), hasCode(INVALID), source.slice(0, 80));
  }
  assert.throws(() => readPublisherNames(path.join(root, 'missing')), hasCode(INVALID));
  assert.throws(() => readPublisherNames(root), hasCode(INVALID));
});

const WINDOWS_FILE = 'C:\\Users\\Example\\update cache\\installer-1.3.0.exe';
const WINDOWS_ENV = { SystemRoot: 'C:\\Windows', EXAMPLE: 'retained' };
function signatureData(extras = {}) {
  return { Status: 'Valid', Path: WINDOWS_FILE, SignerCertificate: { Subject: 'CN=Publisher, O=Organization, C=US' }, ...extras };
}
function signatureRunner(data = signatureData(), error = null, stderr = '') {
  return (_executable, _args, _options, callback) => callback(error, typeof data === 'string' ? data : JSON.stringify(data), stderr);
}
function signature(names, data = signatureData(), extras = {}) {
  return verifyWindowsSignature(names, WINDOWS_FILE, { env: WINDOWS_ENV, execFile: signatureRunner(data), ...extras });
}

test('signature verification uses one fixed system executable/script with independent installer environment', async () => {
  const calls = [];
  const paths = [WINDOWS_FILE, "C:\\cache\\installer';`$evil&name.exe"];
  for (const installer of paths) {
    const result = await verifyWindowsSignature(['Publisher'], installer, {
      env: WINDOWS_ENV,
      execFile(executable, args, options, callback) {
        calls.push({ executable, args, options });
        callback(null, JSON.stringify(signatureData({ Path: installer })), '');
      },
    });
    assert.equal(result, null);
  }
  assert.equal(calls[0].executable, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(calls[0].args, calls[1].args);
  assert.deepEqual(calls[0].args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-InputFormat', 'None', '-Command']);
  assert.match(calls[0].args.at(-1), /Get-AuthenticodeSignature -LiteralPath \$env:USSHTC107_UPDATE_INSTALLER/);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.options.shell, false);
    assert.equal(call.options.timeout, 5000);
    assert.equal(call.options.maxBuffer, 65536);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.encoding, 'utf8');
    assert.equal(call.options.env.PSModulePath, '');
    assert.equal(call.options.env.EXAMPLE, 'retained');
    assert.equal(call.options.env.USSHTC107_UPDATE_INSTALLER, paths[index]);
    assert.equal(call.args.join(' ').includes(paths[index]), false);
  }
});

test('simple publishers match entire CN, never a substring or another subject field', async () => {
  assert.equal(await signature(['Publisher']), null);
  assert.equal(await signature(['Other', 'Publisher']), null);
  for (const name of ['Publish', 'publisher', 'Organization', 'Publisher ', '']) assert.equal(await signature([name]), INVALID);
  for (const Subject of ['CN=Publisher Evil, O=Organization', 'CN=Evil Publisher, O=Organization', 'CN=Other, O=Publisher']) {
    assert.equal(await signature(['Publisher'], signatureData({ SignerCertificate: { Subject } })), INVALID);
  }
});

test('configured DN requires every exact attribute and handles quotes, escaped separators, and hex escaping', async () => {
  assert.equal(await signature(['CN=Publisher, O=Organization']), null);
  assert.equal(await signature(['O=Organization, C=US']), null);
  for (const name of ['CN=Publisher,O=Other', 'CN=Publisher,C=GB', 'CN=Publisher,OU=Absent', 'CN=publisher', 'CN=Publisher, O=Organization, discarded']) {
    assert.equal(await signature([name]), INVALID, name);
  }
  const Subject = 'CN="Acme, Inc.", O=Example\\2c Org, C=US';
  const data = signatureData({ SignerCertificate: { Subject } });
  assert.equal(await signature(['Acme, Inc.'], data), null);
  assert.equal(await signature(['CN=Acme\\, Inc., O="Example, Org", C=US'], data), null);
  assert.equal(await signature(['CN=Acme\\2c Inc., O=Example\\, Org'], data), null);
  assert.equal(await signature(['CN="Acme, Inc.", O=Other'], data), INVALID);
});

test('malformed or incomplete certificate Subjects fail closed, including duplicate or truncated DN fields', async () => {
  for (const Subject of [null, undefined, '', 1, 'Publisher', 'O=Organization', 'CN=', 'CN=Publisher,', 'CN=Publisher, ignored', 'CN=Other,CN=Publisher', 'CN="Publisher', 'CN=Publisher\\', 'CN=Publisher\nO=Organization', 'CN=Publisher, O=""']) {
    assert.equal(await signature(['Publisher'], signatureData({ SignerCertificate: { Subject } })), INVALID, String(Subject));
  }
  for (const SignerCertificate of [null, undefined, [], 'Publisher', {}]) assert.equal(await signature(['Publisher'], signatureData({ SignerCertificate })), INVALID);
  for (const publishers of [null, undefined, [], [''], [null], [' Publisher'], ['Publisher\n'], ['CN=Publisher,'], ['CN=Publisher,CN=Other']]) {
    assert.equal(await signature(publishers), INVALID);
  }
});

test('signature result requires Valid, canonical exact absolute path, and bounded complete JSON', async () => {
  for (const Status of [0, '0', 'valid', 'NotSigned', 'HashMismatch', 'UnknownError', null, undefined]) {
    assert.equal(await signature(['Publisher'], signatureData({ Status })), INVALID);
  }
  for (const Path of [null, undefined, '', 'installer-1.3.0.exe', 'C:installer-1.3.0.exe', WINDOWS_FILE.toLowerCase(), WINDOWS_FILE + '.other', 'C:\\cache\\..\\installer.exe', WINDOWS_FILE + '\0']) {
    assert.equal(await signature(['Publisher'], signatureData({ Path })), INVALID, String(Path));
  }
  for (const data of ['{', 'null', '[]', '{}', JSON.stringify(signatureData()) + 'trailer', 'x'.repeat(65537)]) {
    assert.equal(await signature(['Publisher'], data), INVALID);
  }
  for (const SystemRoot of ['', 'Windows', 'C:Windows', 'C:\\Windows\\..\\other', '\\\\server\\Windows']) {
    assert.equal(await signature(['Publisher'], signatureData(), { env: { SystemRoot } }), INVALID);
  }
});

test('process errors, timeouts, stderr, throws, and repeated cache verifications all fail closed or reverify', async () => {
  for (const error of [new Error('private process error'), Object.assign(new Error('timeout'), { killed: true, code: 'ETIMEDOUT' }), Object.assign(new Error('overflow'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })]) {
    assert.equal(await signature(['Publisher'], signatureData(), { execFile: signatureRunner(signatureData(), error) }), INVALID);
  }
  assert.equal(await signature(['Publisher'], signatureData(), { execFile: signatureRunner(signatureData(), null, 'warning') }), INVALID);
  assert.equal(await signature(['Publisher'], signatureData(), { execFile() { throw new Error('private path'); } }), INVALID);
  let calls = 0;
  const verifier = () => signature(['Publisher'], signatureData(), { execFile(...args) {
    calls += 1;
    signatureRunner(calls === 1 ? signatureData() : signatureData({ Status: 'HashMismatch' }))(...args);
  } });
  assert.equal(await verifier(), null);
  assert.equal(await verifier(), INVALID);
  assert.equal(calls, 2);
});
