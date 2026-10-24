'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseScpCommand, MAX_COMMAND_BYTES } = require('../../electron/scp/command-parser');
const { compileGlob, hasGlobMagic } = require('../../electron/scp/glob');

const parsed = (path, overrides = {}) => {
  const result = { direction: 'source', path, recursive: false, preserve: false, targetDirectory: false, ...overrides };
  if (result.direction === 'source') result.globPattern = overrides.globPattern ?? path.replaceAll('\\', '\\\\');
  return result;
};

for (const command of ['ls -la', 'echo scp -t /tmp', 'scp-helper -t /tmp', 'ssh host scp -f /tmp', '', null]) {
  test(`non-SCP command remains untouched: ${String(command)}`, () => assert.equal(parseScpCommand(command), null));
}

test('clustered flags and quoted Unicode paths retain exact spaces', () => {
  assert.deepEqual(parseScpCommand('scp -vrpqf -- " /数据/with space/文件.txt "'), parsed(' /数据/with space/文件.txt ', { recursive: true, preserve: true }));
  assert.deepEqual(parseScpCommand('/usr/bin/scp -qtdp \'/目录/a b\''), parsed('/目录/a b', { direction: 'sink', preserve: true, targetDirectory: true }));
  assert.deepEqual(parseScpCommand('"scp" -f /tmp/a\\ b'), parsed('/tmp/a b'));
  assert.deepEqual(parseScpCommand("scp -f '/tmp/it'\\''s fine'"), parsed("/tmp/it's fine"));
  assert.deepEqual(parseScpCommand('scp -t -- -filename'), parsed('-filename', { direction: 'sink' }));
  assert.deepEqual(parseScpCommand('scp\t-f\t./literal:name'), parsed('./literal:name'));
});

test('literal shell metacharacters can only be represented with safe quoting or escaping', () => {
  assert.deepEqual(parseScpCommand("scp -f '/tmp/$literal;`file`'"), parsed('/tmp/$literal;`file`'));
  assert.deepEqual(parseScpCommand('scp -f "/tmp/\\$literal"'), parsed('/tmp/$literal'));
  assert.deepEqual(parseScpCommand('scp -f /tmp/a\\;b'), parsed('/tmp/a;b'));
  assert.deepEqual(parseScpCommand('scp -f "/tmp/back\\slash"'), parsed('/tmp/back\\slash'));
  assert.deepEqual(parseScpCommand('scp -f "/tmp/*.txt"'), parsed('/tmp/*.txt', { globPattern: '/tmp/\\*.txt' }));
});

test('shell quoting and escapes retain literal versus expandable glob semantics', () => {
  for (const command of ["scp -f '*.txt'", 'scp -f "*.txt"', 'scp -f \\*.txt']) {
    const descriptor = parseScpCommand(command);
    assert.equal(descriptor.path, '*.txt');
    assert.equal(descriptor.globPattern, '\\*.txt');
    assert.equal(hasGlobMagic(descriptor.globPattern), false);
    const matcher = compileGlob(descriptor.globPattern);
    assert.equal(matcher.test('*.txt'), true);
    assert.equal(matcher.test('other.txt'), false);
  }
  const mixed = parseScpCommand("scp -f 'literal*'?.[ab]");
  assert.equal(mixed.path, 'literal*?.[ab]');
  assert.equal(mixed.globPattern, 'literal\\*?.[ab]');
  assert.equal(compileGlob(mixed.globPattern).test('literal*x.a'), true);
  assert.equal(compileGlob(mixed.globPattern).test('literalXXXXx.a'), false);
  const literalClass = parseScpCommand("scp -f '[ab]'");
  assert.equal(literalClass.globPattern, '\\[ab\\]');
  assert.equal(hasGlobMagic(literalClass.globPattern), false);
  assert.equal(parseScpCommand('scp -f *.txt').globPattern, '*.txt');
  assert.equal('globPattern' in parseScpCommand('scp -t "*.txt"'), false);
});

for (const command of [
  'scp', 'scp /tmp', 'scp -ft /tmp', 'scp -f -t /tmp', 'scp -O -f /tmp', 'scp -3 -f /tmp',
  'scp -S ssh -f /tmp', 'scp -f a b', 'scp -f ""', 'scp -f "unfinished', "scp -t 'unfinished",
  'scp -f trailing\\', 'scp -f /tmp;id', 'scp -f /tmp && id', 'scp -f /tmp | cat',
  'scp -f < /tmp', 'scp -f /tmp > /other', 'scp -f $(id)', 'scp -f `id`',
  'scp -f "$HOME/a"', 'scp -f ~/a', 'scp -f {one,two}', 'scp -f #comment',
  'scp -f /tmp\nother', 'scp -f /tmp\r', 'scp -f "a\tb"', 'scp -f /tmp\0x',
  'scp -f host:/tmp', 'scp -f user@host:/tmp', 'scp -f [::1]:file', 'scp -f scp://host/file',
  'scp -f \ud800',
]) {
  test(`recognized malformed SCP is explicit: ${JSON.stringify(command)}`, () => {
    const result = parseScpCommand(command);
    assert.equal(result?.invalid, true);
    assert.equal(result.code, 'SCP_INVALID_COMMAND');
    assert.equal(typeof result.error, 'string');
    assert.equal('path' in result, false);
  });
}

test('oversized SCP commands fail closed without changing non-SCP handling', () => {
  assert.equal(parseScpCommand(`scp -f ${'a'.repeat(MAX_COMMAND_BYTES)}`).invalid, true);
  assert.equal(parseScpCommand(`echo ${'a'.repeat(MAX_COMMAND_BYTES)}`), null);
});
