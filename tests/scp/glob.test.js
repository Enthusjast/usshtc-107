'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileGlob, hasGlobMagic, matchGlob } = require('../../electron/scp/glob');

test('bounded basename globs match Unicode, spaces and exact literals', () => {
  const cases = [
    ['*.txt', '研究 data.txt', true], ['*.txt', 'data.txt.bak', false],
    ['file?.txt', 'file😀.txt', true], ['file?.txt', 'fileab.txt', false],
    ['a*b*c', 'axybzc', true], ['a*b*c', 'ac', false], ['*', 'name', true],
    ['a[0-9][!ab].txt', 'a5z.txt', true], ['a[0-9][!ab].txt', 'a5a.txt', false],
    ['[研究]?', '研😀', true], ['[^0-9]', 'x', true], ['[^0-9]', '5', false],
    ['[]-]', ']', true], ['[]-]', '-', true], ['[a\\-c]', '-', true],
    ['a\\*b', 'a*b', true], ['a\\*b', 'axyb', false], ['\\?.txt', '?.txt', true],
    ['\\[ab\\]', '[ab]', true], ['a\\\\b', 'a\\b', true],
    ['plain name', 'plain name', true], ['plain name', 'plain name extra', false],
    ['a*', 'a', true], ['*a', 'a', true], ['*.txt', 'a/b.txt', false],
    ['*.log', '.private.log', false], ['?private.log', '.private.log', false],
    ['.*.log', '.private.log', true], ['\\.private.log', '.private.log', true],
  ];
  for (const [pattern, name, expected] of cases) {
    assert.equal(matchGlob(pattern, name), expected, `${pattern} / ${name}`);
  }
});

test('compiled matchers are reusable and do not retain mutable matching state', () => {
  const matcher = compileGlob('a*[0-9]');
  assert.equal(Object.isFrozen(matcher), true);
  assert.equal(matcher.magic, true);
  assert.equal(matcher.test('abc9'), true);
  assert.equal(matcher.test('abcx'), false);
  assert.equal(matcher.test('a0'), true);
  assert.equal(hasGlobMagic('file\\*.txt'), false);
  assert.equal(hasGlobMagic('file[ab].txt'), true);
  assert.equal(hasGlobMagic('literal'), false);
});

for (const pattern of ['**', 'a**b', '[', '[]', '[!]', '[z-a]', 'trailing\\', 'dir/*', '', '\0', '\ud800']) {
  test(`reject unsupported or malformed glob: ${JSON.stringify(pattern)}`, () => {
    assert.throws(() => compileGlob(pattern), { code: 'SCP_INVALID_GLOB' });
    assert.throws(() => hasGlobMagic(pattern), { code: 'SCP_INVALID_GLOB' });
  });
}

test('glob complexity and candidate names have explicit bounds', () => {
  assert.throws(() => compileGlob('a'.repeat(4097)), { code: 'SCP_INVALID_GLOB' });
  assert.throws(() => compileGlob('a'.repeat(257)), { code: 'SCP_INVALID_GLOB' });
  assert.throws(() => compileGlob('abc', { maxTokens: 2 }), { code: 'SCP_INVALID_GLOB' });
  assert.throws(() => compileGlob('*', { maxTokens: Infinity }), { code: 'SCP_INVALID_GLOB' });
  const matcher = compileGlob('*', { maxNameLength: 10 });
  for (const name of ['', '.', '..', 'a/b', 'a\nb', '\ud800', 'a'.repeat(11)]) assert.equal(matcher.test(name), false);
  assert.equal(matchGlob('a*'.repeat(100) + 'z', 'a'.repeat(1000) + 'z'), true);
  assert.equal(matchGlob('a*'.repeat(100) + 'z', 'a'.repeat(1000) + 'x'), false);
});
