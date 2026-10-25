'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runner = path.resolve(__dirname, '../scripts/run-node-tests.cjs');

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc-ci-reporter-')));
  fs.mkdirSync(path.join(root, 'tests'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function run(root) {
  const env = { ...process.env, CI: 'true' };
  // This is an independent runner process, not a nested node:test child.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [runner, '--test-concurrency=1'], {
    cwd: root, env, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  });
}
function reports(root) {
  const directories = fs.readdirSync(path.join(root, 'test-results'));
  assert.equal(directories.length, 1);
  const directory = path.join(root, 'test-results', directories[0]);
  return Object.fromEntries(fs.readdirSync(directory).map(name => [name,
    fs.readFileSync(path.join(directory, name), 'utf8').trim().split('\n').map(line => JSON.parse(line))]));
}

test('CI keeps the first failure fatal and reruns only failed files once, even when the diagnostic rerun passes', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'tests/a.test.js'), `const {test}=require('node:test'); const fs=require('node:fs');
    test('passing file',()=>fs.appendFileSync('passing-count','P'));`);
  fs.writeFileSync(path.join(root, 'tests/b.test.js'), `const {test}=require('node:test'); const fs=require('node:fs');
    test('one-shot failure',()=>{ const first=!fs.existsSync('failing-count'); fs.appendFileSync('failing-count','F'); if(first)throw new Error('first failure'); });`);
  const result = run(root);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'passing-count'), 'utf8'), 'P');
  assert.equal(fs.readFileSync(path.join(root, 'failing-count'), 'utf8'), 'FF');
  const recorded = reports(root);
  assert.equal(recorded['initial.jsonl'].filter(row => row.event === 'failure').length, 1);
  assert.equal(recorded['diagnostic-rerun.jsonl'].filter(row => row.event === 'failure').length, 0);
  assert.match(result.stderr, /"diagnosticRerunExitCode":0/);
  assert.match(result.stderr, /"originalExitCode":1/);
});

test('CI reports non-enumerable verification causes and checkpoints without exposing credential values', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'tests/failure.test.js'), `const {test}=require('node:test');
    test('verification failure',()=>{ const cause=Object.assign(new Error('Cookie: fixture-sensitive-value'),{code:'EACCES'});
      const error=Object.assign(new Error('UPDATE_CHECKSUM_MISMATCH',{cause}),{code:'UPDATE_CHECKSUM_MISMATCH'});
      Object.defineProperty(error,'verificationStep',{value:'open'}); throw error; });`);
  const result = run(root);
  assert.equal(result.status, 1, result.stderr);
  const recorded = reports(root);
  const text = JSON.stringify(recorded);
  assert.doesNotMatch(text + result.stdout + result.stderr, /fixture-sensitive-value/);
  assert.match(text, /UPDATE_CHECKSUM_MISMATCH/);
  assert.match(text, /"verificationStep":"open"/);
  assert.match(text, /EACCES/);
  const environment = recorded['initial.jsonl'].find(row => row.event === 'environment');
  assert.equal(environment.platform, process.platform);
  assert.equal(environment.node, process.version);
});

test('CI successful runs create no diagnostic rerun or duplicate test execution', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'tests/success.test.js'), `const {test}=require('node:test'); const fs=require('node:fs');
    test('success',()=>fs.appendFileSync('count','once'));`);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'count'), 'utf8'), 'once');
  assert.deepEqual(Object.keys(reports(root)), ['initial.jsonl']);
});
