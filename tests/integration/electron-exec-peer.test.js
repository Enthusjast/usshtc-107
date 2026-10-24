'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { createRemoteExecPeer, findGitBash } = require('../fixtures/remote-exec-peer.cjs');
const { quotePosix, buildExecBootstrap, createExecParser } = require('../../electron/exec-codec');

function execute(command, options = {}) {
  return new Promise((resolve, reject) => {
    const nonce = randomBytes(32).toString('hex');
    const output = [];
    let settled = false;
    let peer;
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      peer?.kill();
      if (error) reject(error);
      else resolve({ code, output: Buffer.concat(output) });
    };
    const parser = createExecParser({ nonce,
      onReady: () => peer.write(`${Buffer.from(command).toString('base64')}\n`),
      onOutput: (bytes) => output.push(Buffer.from(bytes)),
      onComplete: (code) => finish(null, code),
    });
    peer = createRemoteExecPeer({ ...options,
      onData: (data) => { try { parser.write(data); } catch (error) { finish(error); } },
      onError: finish,
      onClose: () => finish(new Error('Source interpreter closed before the command completed')),
    });
    peer.write(`exec sh -c ${quotePosix(buildExecBootstrap(nonce))}\n`);
  });
}

test('native source fixture really executes the diagnostic marker using the platform interpreter', { timeout: 20000 }, async () => {
  const marker = randomBytes(24).toString('hex');
  const result = await execute(`printf '%s' '${marker}'`);
  assert.equal(result.code, 0);
  assert.deepEqual(result.output, Buffer.from(marker));
});

test('pipe source fixture executes the real codec, shell arithmetic, UTF8, stderr and nonzero exit without a PTY', { timeout: 20000 }, async () => {
  for (const [command, expected, code] of [
    ["printf '%s' ''", '', 0],
    ["printf '%s' '$not-expanded'", '$not-expanded', 0],
    ["printf '%s' \"$((6 * 7))\"; printf ' stderr' >&2; exit 7", '42 stderr', 7],
    ["printf '%s' '中文🙂'", '中文🙂', 0],
  ]) {
    const result = await execute(command, { mode: 'pipe' });
    assert.equal(result.code, code);
    assert.deepEqual(result.output, Buffer.from(expected));
  }
});

test('source interpreter rejects altered bootstrap or terminal setup rather than bypassing the protocol', () => {
  const nonce = randomBytes(32).toString('hex');
  for (const input of [
    "printf 'not a bridge bootstrap'\n",
    `exec sh -c ${quotePosix(buildExecBootstrap(nonce).replace('stty -echo', 'stty echo'))}\n`,
  ]) {
    let errors = 0;
    let received = false;
    const peer = createRemoteExecPeer({ mode: 'pipe',
      onError: () => { errors += 1; }, onData: () => { received = true; },
    });
    peer.write(input);
    peer.write('ignored after rejection');
    assert.equal(errors, 1);
    assert.equal(received, false);
    peer.kill();
  }
});

test('Windows fixture locates installed Git Bash, not a PATH WSL launcher, and fails closed when absent', () => {
  const expected = 'C:\\Program Files\\Git\\bin\\bash.exe';
  assert.equal(findGitBash({ ProgramFiles: 'C:\\Program Files', PATH: 'C:\\Windows\\System32' }, (file) => file === expected), expected);
  const perUser = 'C:\\Users\\fixture\\AppData\\Local\\Programs\\Git\\usr\\bin\\bash.exe';
  assert.equal(findGitBash({ LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local' }, (file) => file === perUser), perUser);
  assert.throws(() => findGitBash({ PATH: 'C:\\Windows\\System32' }, () => false), /requires Git Bash/);
});
