'use strict';

const { liveTest, harness, check } = require('./helpers.cjs');

liveTest('live exec validates identity without disclosing it', async (t) => {
  const f = await harness(t);
  const result = await f.exec("printf '%s\\0' \"$(hostname)\" \"$(id -un)\" \"$(pwd -P)\" \"$(uname -n)\" \"$(whoami)\" \"$PWD\"");
  check(result.code === 0, 'LIVE_IDENTITY_EXIT');
  const fields = result.output.toString('utf8').split('\0');
  check(fields.length === 7 && fields[6] === '', 'LIVE_IDENTITY_FORMAT');
  const [host, user, directory, repeatedHost, repeatedUser, shellDirectory] = fields;
  check(host.length > 0 && host === repeatedHost && !/[\s\0]/.test(host), 'LIVE_HOST_IDENTITY');
  check(user.length > 0 && user === repeatedUser && !/[\s\0]/.test(user), 'LIVE_USER_IDENTITY');
  check(directory.startsWith('/') && shellDirectory.startsWith('/'), 'LIVE_DIRECTORY_IDENTITY');
  // Resolve logical PWD remotely rather than assuming a particular account/home.
  const directoryCheck = await f.exec('[ "$(pwd -P)" = "$(cd -- "$PWD" && pwd -P)" ]');
  check(directoryCheck.code === 0, 'LIVE_DIRECTORY_CONSISTENCY');
});

liveTest('live exec preserves exit status three', async (t) => {
  const f = await harness(t);
  const result = await f.exec('exit 3');
  check(result.code === 3 && result.output.length === 0, 'LIVE_EXIT_STATUS');
});

liveTest('live exec preserves exact Unicode bytes and whitespace', async (t) => {
  const f = await harness(t);
  const expected = Buffer.from('  中文🙂é\t\r\n\n', 'utf8');
  const result = await f.exec("printf '%s' '  中文🙂é'; printf '\\t\\r\\n\\n'");
  check(result.code === 0 && result.output.equals(expected), 'LIVE_UNICODE_BYTES');
});

liveTest('live exec delivers all twenty thousand lines', async (t) => {
  const f = await harness(t);
  const result = await f.exec("awk 'BEGIN { for (i = 1; i <= 20000; i++) printf \"line-%05d\\n\", i }'");
  check(result.code === 0, 'LIVE_LARGE_OUTPUT_EXIT');
  const lines = result.output.toString('ascii').split('\n');
  check(lines.length === 20001 && lines[20000] === '', 'LIVE_LARGE_OUTPUT_COUNT');
  check(lines.slice(0, -1).every((line, index) => line === `line-${String(index + 1).padStart(5, '0')}`), 'LIVE_LARGE_OUTPUT_CONTENT');
});

liveTest('live exec rejects nonempty SSH stdin explicitly', async (t) => {
  const f = await harness(t);
  const result = await f.exec('true', { input: Buffer.from('not-remote-command-input\n') });
  check(result.code === 1, 'LIVE_STDIN_NOT_REJECTED');
  check(/stdin.*(?:not supported|unsupported)|(?:not supported|unsupported).*stdin/i.test(result.stderr.toString('utf8')), 'LIVE_STDIN_DIAGNOSTIC');
});
