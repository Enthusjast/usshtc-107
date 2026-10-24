const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { BEGIN_MARKER, END_MARKER, SshConfigService, buildManagedBlock } = require('../../electron/ssh-config-service');

const OPTIONS = { profileId: 'default', alias: 'usshtc107', host: '127.0.0.1', port: 3000 };
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const sha256 = (content) => createHash('sha256').update(content).digest('hex');
const expected = (preview) => ({ expectedSourceHash: preview.sourceHash, expectedConfigHash: preview.configHash });
const hasCode = (code) => (error) => error?.code === code;

function fixture(t, source) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc107-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const service = new SshConfigService({ sshDirectory: directory, privateKeyPath: path.join(directory, 'client key') });
  if (source !== undefined) fs.writeFileSync(service.configPath, source);
  return service;
}

function assertUnchanged(service, source, backup = undefined) {
  assert.deepEqual(fs.readFileSync(service.configPath), source);
  if (backup === undefined) assert.equal(fs.existsSync(service.backupPath), false);
  else assert.deepEqual(fs.readFileSync(service.backupPath), backup);
}

test('missing source is an empty Buffer hash and preview does not create any files', (t) => {
  const service = fixture(t);
  const preview = service.preview(OPTIONS);
  assert.equal(Buffer.isBuffer(preview.content), true);
  assert.equal(preview.sourceHash, sha256(Buffer.alloc(0)));
  assert.match(preview.configHash, /^[a-f0-9]{64}$/);
  assert.equal(preview.changed, true);
  assert.deepEqual(preview.content, Buffer.from(`${preview.block}\n`));
  assert.deepEqual(fs.readdirSync(service.sshDirectory), []);
  const result = service.write(OPTIONS, expected(preview));
  assert.equal(result.backupPath, null);
  assert.equal(result.path, service.configPath);
  assert.deepEqual(fs.readFileSync(service.configPath), preview.content);
});

test('existing empty files are backed up rather than treated as absent', (t) => {
  const service = fixture(t, Buffer.alloc(0));
  const result = service.write(OPTIONS, expected(service.preview(OPTIONS)));
  assert.equal(result.backupPath, service.backupPath);
  assert.deepEqual(fs.readFileSync(service.backupPath), Buffer.alloc(0));
});

test('managed alias comes first and resets Host scope before the original bytes', (t) => {
  const source = Buffer.from('Port 2222\r\nUser custom\r\n# 中文🙂\r\nHost personal\r\n  HostName personal.invalid');
  const service = fixture(t, source);
  const preview = service.preview(OPTIONS);
  assert.match(preview.block, /^# BEGIN usshtc107 managed\nHost usshtc107\n/);
  assert.match(preview.block, /\nHost \*\n# END usshtc107 managed$/);
  assert.deepEqual(preview.content.subarray(Buffer.byteLength(`${preview.block}\n`)), source);
  assert.equal(preview.sourceHash, sha256(source));
  service.write(OPTIONS, expected(preview));
  assert.deepEqual(fs.readFileSync(service.backupPath), source);
  const next = service.preview(OPTIONS);
  assert.equal(next.changed, false);
  assert.deepEqual(next.content, preview.content);
  const result = service.write(OPTIONS, expected(next));
  assert.equal(result.changed, false);
  assert.equal(result.backupPath, null);
  assert.deepEqual(fs.readFileSync(service.backupPath), source);
});

test('BOM stays at the first three bytes, with CRLF and absent final newline untouched', (t) => {
  const unmanaged = Buffer.from('# comment\r\nHost personal\r\n  HostName 中文.example');
  const source = Buffer.concat([BOM, unmanaged]);
  const service = fixture(t, source);
  const preview = service.preview(OPTIONS);
  assert.deepEqual(preview.content.subarray(0, 3), BOM);
  assert.deepEqual(preview.content.subarray(3 + Buffer.byteLength(`${preview.block}\n`)), unmanaged);
  assert.equal(preview.sourceHash, sha256(source));
  service.write(OPTIONS, expected(preview));
  assert.deepEqual(fs.readFileSync(service.backupPath), source);
  assert.equal(service.preview(OPTIONS).changed, false);
});

test('replacement removes only the explicit owned byte span wherever it occurred', (t) => {
  const before = Buffer.from('# leading 中文\r\n\r\nPort 2222\r\n');
  const after = Buffer.from('\r\nHost personal\r\n  HostName personal.invalid');
  const oldBlock = Buffer.from(`${BEGIN_MARKER}\r\nHost old-alias\r\n  Port 9999\r\n${END_MARKER}\r\n`);
  const source = Buffer.concat([BOM, before, oldBlock, after]);
  const service = fixture(t, source);
  const preview = service.preview(OPTIONS);
  assert.deepEqual(preview.content, Buffer.concat([BOM, Buffer.from(`${preview.block}\n`), before, after]));
  service.write(OPTIONS, expected(preview));
  assert.deepEqual(fs.readFileSync(service.backupPath), source);
  assert.equal(service.preview(OPTIONS).changed, false);
});

test('an owned block ending at EOF needs no invented separator in the unmanaged bytes', (t) => {
  const service = fixture(t, `${BEGIN_MARKER}\nHost old\n${END_MARKER}`);
  const preview = service.preview(OPTIONS);
  assert.deepEqual(preview.content, Buffer.from(`${preview.block}\n`));
});

for (const [label, bytes] of [
  ['truncated multibyte', [0xe4, 0xb8]],
  ['invalid continuation', [0xc3, 0x28]],
  ['overlong encoding', [0xc0, 0xaf]],
  ['encoded surrogate', [0xed, 0xa0, 0x80]],
  ['out-of-range codepoint', [0xf4, 0x90, 0x80, 0x80]],
]) {
  test(`invalid UTF-8 fails before backup or write: ${label}`, (t) => {
    const source = Buffer.concat([Buffer.from('# original\r\n'), Buffer.from(bytes)]);
    const service = fixture(t, source);
    const backup = Buffer.from('previous private backup');
    fs.writeFileSync(service.backupPath, backup);
    assert.throws(() => service.preview(OPTIONS), hasCode('SSH_CONFIG_INVALID'));
    assert.throws(() => service.write(OPTIONS, { expectedSourceHash: sha256(source), expectedConfigHash: 'reviewed' }), hasCode('SSH_CONFIG_INVALID'));
    assertUnchanged(service, source, backup);
  });
}

for (const [label, source] of [
  ['missing END', `${BEGIN_MARKER}\nHost old\n`],
  ['isolated END', `${END_MARKER}\n`],
  ['nested BEGIN', `${BEGIN_MARKER}\n${BEGIN_MARKER}\n${END_MARKER}\n${END_MARKER}\n`],
  ['duplicate blocks', `${BEGIN_MARKER}\n${END_MARKER}\n${BEGIN_MARKER}\n${END_MARKER}\n`],
  ['extra END', `${BEGIN_MARKER}\n${END_MARKER}\n${END_MARKER}\n`],
]) {
  test(`malformed ownership markers fail closed: ${label}`, (t) => {
    const service = fixture(t, source);
    assert.throws(() => service.preview(OPTIONS), hasCode('SSH_CONFIG_INVALID'));
    assert.throws(() => service.write(OPTIONS, { expectedSourceHash: sha256(source), expectedConfigHash: 'reviewed' }), hasCode('SSH_CONFIG_INVALID'));
    assertUnchanged(service, Buffer.from(source));
  });
}

for (const directive of [
  'Host usshtc107',
  '  hOsT UsShTc107\r\n  Port 2222',
  'Host "usshtc107" # exact quoted pattern',
  'Host=usshtc107',
  'Host = "usshtc107"',
  'Host personal usshtc107 another',
  '# usshtc107-auto-generated\nHost usshtc107\n  Port 2222',
]) {
  test(`unowned exact alias conflicts without touching source: ${JSON.stringify(directive)}`, (t) => {
    const source = Buffer.from(`${directive}\n`);
    const service = fixture(t, source);
    assert.throws(() => service.preview(OPTIONS), hasCode('SSH_ALIAS_CONFLICT'));
    assert.throws(() => service.write(OPTIONS, { expectedSourceHash: sha256(source), expectedConfigHash: 'reviewed' }), hasCode('SSH_ALIAS_CONFLICT'));
    assertUnchanged(service, source);
  });
}

test('wildcards, negated aliases, comments and other Host directives remain legal user bytes', (t) => {
  const source = Buffer.from('# Host usshtc107\r\nHost * !usshtc107\r\nHost usshtc*\r\nHost personal # usshtc107\r\nHost usshtc107-other');
  const service = fixture(t, source);
  const preview = service.preview(OPTIONS);
  assert.deepEqual(preview.content.subarray(Buffer.byteLength(`${preview.block}\n`)), source);
});

test('a single legacy marker never authorizes removal of following directives', (t) => {
  const source = Buffer.from('# usshtc107-auto-generated\r\nHost legacy\r\n  Port 2222\r\nMatch user deploy\r\n  Compression yes');
  const service = fixture(t, source);
  const preview = service.preview(OPTIONS);
  assert.deepEqual(preview.content.subarray(Buffer.byteLength(`${preview.block}\n`)), source);
});

test('unterminated quoted Host arguments fail closed', (t) => {
  const service = fixture(t, 'Host "usshtc107\n');
  assert.throws(() => service.preview(OPTIONS), hasCode('SSH_CONFIG_INVALID'));
});

test('write requires both reviewed hashes and does not create a directory on rejection', (t) => {
  const root = fixture(t);
  const service = new SshConfigService({ sshDirectory: path.join(root.sshDirectory, 'absent'), privateKeyPath: root.privateKeyPath });
  const preview = service.preview(OPTIONS);
  for (const hashes of [undefined, {}, { expectedSourceHash: preview.sourceHash }, { expectedConfigHash: preview.configHash }]) {
    assert.throws(() => service.write(OPTIONS, hashes), hasCode('SSH_CONFIG_CHANGED'));
  }
  assert.equal(fs.existsSync(service.sshDirectory), false);
});

test('source changes after preview require a new review even if only line endings changed', (t) => {
  const service = fixture(t, '# user\n');
  const preview = service.preview(OPTIONS);
  const changed = Buffer.from('# user\r\n');
  fs.writeFileSync(service.configPath, changed);
  assert.throws(() => service.write(OPTIONS, expected(preview)), hasCode('SSH_CONFIG_CHANGED'));
  assertUnchanged(service, changed);
});

test('source creation and deletion invalidate the reviewed source hash', (t) => {
  const service = fixture(t);
  const missingPreview = service.preview(OPTIONS);
  fs.writeFileSync(service.configPath, '# created');
  assert.throws(() => service.write(OPTIONS, expected(missingPreview)), hasCode('SSH_CONFIG_CHANGED'));
  const existingPreview = service.preview(OPTIONS);
  fs.unlinkSync(service.configPath);
  assert.throws(() => service.write(OPTIONS, expected(existingPreview)), hasCode('SSH_CONFIG_CHANGED'));
  assert.equal(fs.existsSync(service.configPath), false);
  assert.equal(fs.existsSync(service.backupPath), false);
});

for (const patch of [{ profileId: 'other' }, { alias: 'other' }, { host: '::1' }, { port: 4000 }]) {
  test(`saved configuration changes invalidate config hash: ${JSON.stringify(patch)}`, (t) => {
    const source = Buffer.from('# source');
    const service = fixture(t, source);
    const preview = service.preview(OPTIONS);
    assert.throws(() => service.write({ ...OPTIONS, ...patch }, expected(preview)), hasCode('SSH_CONFIG_CHANGED'));
    assertUnchanged(service, source);
  });
}

test('fixed constructor key path participates in configHash; option overrides cannot change it', (t) => {
  const service = fixture(t, '# source');
  const preview = service.preview(OPTIONS);
  const other = new SshConfigService({ sshDirectory: service.sshDirectory, privateKeyPath: path.join(service.sshDirectory, 'other') });
  assert.throws(() => other.write(OPTIONS, expected(preview)), hasCode('SSH_CONFIG_CHANGED'));
  const ignoredOverride = service.preview({ ...OPTIONS, privateKeyPath: '/attacker/key' });
  assert.equal(ignoredOverride.configHash, preview.configHash);
  assert.equal(ignoredOverride.block, preview.block);
});

test('normalized equivalent values share config hashes without bypassing raw input validation', (t) => {
  const service = fixture(t);
  const preview = service.preview(OPTIONS);
  assert.equal(service.preview({ ...OPTIONS, alias: ' usshtc107 ', host: ' 127.0.0.1 ', port: '3000' }).configHash, preview.configHash);
  for (const [patch, code] of [
    [{ alias: 'usshtc107\nHost *' }, 'invalid_token'],
    [{ host: 'localhost\r\nProxyCommand anything' }, 'invalid_host'],
    [{ port: 0 }, 'integer_range'],
    [{ profileId: 'default\n' }, 'invalid_token'],
  ]) {
    assert.throws(() => service.preview({ ...OPTIONS, ...patch }), hasCode(code));
  }
});

test('IdentityFile is quoted and security options are fixed', () => {
  const block = buildManagedBlock({ ...OPTIONS, privateKeyPath: 'C:\\User Files\\a"b' });
  assert.ok(block.includes('  IdentityFile "C:\\\\User Files\\\\a\\"b"'));
  assert.match(block, /\n  IdentitiesOnly yes\n  StrictHostKeyChecking accept-new\n/);
  for (const privateKeyPath of ['/key\nHost *', '/key\0', '/key\t', '/key\u007f']) {
    assert.throws(() => buildManagedBlock({ ...OPTIONS, privateKeyPath }), TypeError);
  }
});

test('nonregular source is refused without creating a backup', (t) => {
  const service = fixture(t);
  fs.mkdirSync(service.configPath);
  assert.throws(() => service.preview(OPTIONS), hasCode('SSH_CONFIG_INVALID'));
  assert.throws(() => service.write(OPTIONS, { expectedSourceHash: 'reviewed', expectedConfigHash: 'reviewed' }), hasCode('SSH_CONFIG_INVALID'));
  assert.equal(fs.existsSync(service.backupPath), false);
  assert.equal(fs.statSync(service.configPath).isDirectory(), true);
});

test('symlink source and dangling symlink are refused without reading or modifying targets', { skip: process.platform === 'win32' }, (t) => {
  const service = fixture(t);
  const target = path.join(service.sshDirectory, 'target');
  const original = Buffer.from('# private target');
  fs.writeFileSync(target, original);
  fs.symlinkSync(target, service.configPath);
  assert.throws(() => service.preview(OPTIONS), hasCode('SSH_CONFIG_INVALID'));
  assert.throws(() => service.write(OPTIONS, { expectedSourceHash: 'reviewed', expectedConfigHash: 'reviewed' }), hasCode('SSH_CONFIG_INVALID'));
  assert.equal(fs.lstatSync(service.configPath).isSymbolicLink(), true);
  assert.deepEqual(fs.readFileSync(target), original);
  fs.unlinkSync(target);
  assert.throws(() => service.preview(OPTIONS), hasCode('SSH_CONFIG_INVALID'));
  assert.equal(fs.existsSync(service.backupPath), false);
});

test('source replacement by a symlink after review fails closed', { skip: process.platform === 'win32' }, (t) => {
  const source = Buffer.from('# user');
  const service = fixture(t, source);
  const preview = service.preview(OPTIONS);
  const target = path.join(service.sshDirectory, 'target');
  fs.writeFileSync(target, source);
  fs.unlinkSync(service.configPath);
  fs.symlinkSync(target, service.configPath);
  assert.throws(() => service.write(OPTIONS, expected(preview)), hasCode('SSH_CONFIG_INVALID'));
  assert.deepEqual(fs.readFileSync(target), source);
  assert.equal(fs.existsSync(service.backupPath), false);
});

test('atomic backup replaces an old backup symlink instead of following it', { skip: process.platform === 'win32' }, (t) => {
  const source = Buffer.from('# user');
  const service = fixture(t, source);
  const target = path.join(service.sshDirectory, 'unrelated');
  fs.writeFileSync(target, 'unrelated bytes');
  fs.symlinkSync(target, service.backupPath);
  service.write(OPTIONS, expected(service.preview(OPTIONS)));
  assert.equal(fs.lstatSync(service.backupPath).isFile(), true);
  assert.deepEqual(fs.readFileSync(service.backupPath), source);
  assert.equal(fs.readFileSync(target, 'utf8'), 'unrelated bytes');
});

test('atomic byte writer applies mode and fsync before rename, never chmods the target', (t) => {
  const service = fixture(t, '# user');
  const preview = service.preview(OPTIONS);
  const calls = [];
  const originalFchmod = fs.fchmodSync;
  const originalFsync = fs.fsyncSync;
  const originalRename = fs.renameSync;
  t.mock.method(fs, 'fchmodSync', (fd, mode) => { calls.push(['fchmod', fd, mode]); return originalFchmod(fd, mode); });
  t.mock.method(fs, 'fsyncSync', (fd) => { calls.push(['fsync', fd]); return originalFsync(fd); });
  t.mock.method(fs, 'renameSync', (from, to) => { calls.push(['rename', from, to]); return originalRename(from, to); });
  t.mock.method(fs, 'chmodSync', () => { assert.fail('target chmod must not occur after rename'); });
  service.write(OPTIONS, expected(preview));
  for (const destination of [service.backupPath, service.configPath]) {
    const renameIndex = calls.findIndex((call) => call[0] === 'rename' && call[2] === destination);
    assert.ok(renameIndex >= 2);
    const precedingRename = calls.slice(0, renameIndex).findLastIndex((call) => call[0] === 'rename');
    const segment = calls.slice(precedingRename + 1, renameIndex);
    const modeIndex = segment.findIndex((call) => call[0] === 'fchmod' && call[2] === 0o600);
    assert.ok(modeIndex >= 0);
    assert.ok(segment.slice(modeIndex + 1).some((call) => call[0] === 'fsync' && call[1] === segment[modeIndex][1]));
    if (process.platform !== 'win32') assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  }
});

test('failed atomic config replacement retains original bytes and cleans temporary files', (t) => {
  const source = Buffer.from('# user\r\n');
  const service = fixture(t, source);
  const preview = service.preview(OPTIONS);
  const originalRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === service.configPath) throw Object.assign(new Error('fixture rename failure'), { code: 'EACCES' });
    return originalRename(from, to);
  });
  assert.throws(() => service.write(OPTIONS, expected(preview)), hasCode('EACCES'));
  assertUnchanged(service, source, source);
  assert.deepEqual(fs.readdirSync(service.sshDirectory).sort(), ['config', 'config.usshtc107.bak']);
});

// This is deliberately a controlled temporary fixture. Never run ssh -G against
// user config: Match exec is executable, and Include may load arbitrary config.
test('controlled OpenSSH fixture proves first-value precedence and unaffected personal config', (t) => {
  const service = fixture(t);
  const includePath = path.join(service.sshDirectory, 'included config');
  const quote = (value) => `"${value.replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
  fs.writeFileSync(includePath, 'Host *\n  ServerAliveInterval 17\n');
  const source = Buffer.from([
    'Port 2222',
    'User custom',
    `Include ${quote(includePath)}`,
    'Host personal',
    '  HostName personal.example.invalid',
    '  Port 2200',
    '  User individual',
    'Host *',
    '  Compression no',
    'Match host personal',
    '  ServerAliveCountMax 7',
  ].join('\r\n'));
  fs.writeFileSync(service.configPath, source);
  const evaluate = (alias) => {
    const result = spawnSync('ssh', ['-G', '-F', service.configPath, alias], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const fields = new Map(result.stdout.split(/\r?\n/).map((line) => {
      const split = line.indexOf(' ');
      return [line.slice(0, split), line.slice(split + 1)];
    }));
    return fields;
  };
  const personalBefore = evaluate('personal');
  assert.equal(personalBefore.get('port'), '2222');
  assert.equal(personalBefore.get('user'), 'custom');
  const preview = service.preview(OPTIONS);
  service.write(OPTIONS, expected(preview));
  const managed = evaluate(OPTIONS.alias);
  assert.equal(managed.get('hostname'), '127.0.0.1');
  assert.equal(managed.get('port'), '3000');
  assert.equal(managed.get('user'), 'user');
  assert.equal(managed.get('identitiesonly'), 'yes');
  assert.equal(managed.get('stricthostkeychecking'), 'accept-new');
  assert.equal(managed.get('serveraliveinterval'), '17');
  assert.deepEqual(evaluate('personal'), personalBefore);
  assert.deepEqual(fs.readFileSync(service.configPath).subarray(Buffer.byteLength(`${preview.block}\n`)), source);
  assert.deepEqual(fs.readFileSync(service.backupPath), source);
});

test('diagnostic inspection distinguishes absent ownership, mismatches and matches without writes', (t) => {
  const service = fixture(t);
  assert.deepEqual(service.inspect(OPTIONS), { code: 'SSH_CONFIG_MISSING' });
  assert.deepEqual(fs.readdirSync(service.sshDirectory), []);
  const personal = Buffer.from('Host personal\r\n  Port 2222');
  fs.writeFileSync(service.configPath, personal);
  assert.deepEqual(service.inspect(OPTIONS), { code: 'SSH_CONFIG_MISSING' });
  assertUnchanged(service, personal);
  service.write(OPTIONS, expected(service.preview(OPTIONS)));
  const managed = fs.readFileSync(service.configPath);
  const backup = fs.readFileSync(service.backupPath);
  assert.deepEqual(service.inspect(OPTIONS), { code: 'SSH_CONFIG_OK' });
  assert.deepEqual(service.inspect({ ...OPTIONS, port: 4000 }), { code: 'SSH_CONFIG_MISMATCH' });
  assertUnchanged(service, managed, backup);
  fs.writeFileSync(service.configPath, Buffer.from('Host usshtc107\n  Port 2222'));
  assert.throws(() => service.inspect(OPTIONS), hasCode('SSH_ALIAS_CONFLICT'));
  fs.writeFileSync(service.configPath, Buffer.from(`${BEGIN_MARKER}\nHost usshtc107`));
  assert.throws(() => service.inspect(OPTIONS), hasCode('SSH_CONFIG_INVALID'));
});
