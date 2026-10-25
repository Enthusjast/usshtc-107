'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const project = path.resolve(__dirname, '..');
const cli = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const reporter = pathToFileURL(path.join(project, 'scripts/ci-vitest-reporter.cjs')).href;
const rerunner = path.join(project, 'scripts/rerun-ui-failures.cjs');

function fixture(t) {
  const results = path.join(project, 'test-results');
  fs.mkdirSync(results, { recursive: true });
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(results, '.renderer-diagnostics-test-')));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'vitest.config.mjs'), `export default { test: {
    environment: 'node', include: ['tests/**/*.test.jsx'], maxWorkers: 1, fileParallelism: false,
    coverage: { enabled: true, provider: 'v8', include: ['source.js'], thresholds: { lines: 100 } }
  } };`);
  fs.writeFileSync(path.join(root, 'source.js'), 'export const uncovered = () => 42;\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function execute(root, args, extra = {}) {
  const env = { ...process.env, CI: 'true', ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.USSHTC107_VITEST_RERUN_FILES;
  return spawnSync(process.execPath, args, {
    cwd: root, env, encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024,
  });
}
function initial(root, withDefault = false, destination = 'test-results/renderer-initial.json', coverage = false) {
  return execute(root, [cli, 'run', `--coverage.enabled=${coverage}`, '--retry=0',
    ...(withDefault ? ['--reporter=default'] : []), `--reporter=${reporter}`], {
    USSHTC107_VITEST_REPORT_FILE: destination,
  });
}
function rerun(root, reports) {
  // A stale inherited destination must never overwrite the original report.
  return execute(root, [rerunner, ...reports], { USSHTC107_VITEST_REPORT_FILE: 'test-results/renderer-initial.json' });
}
function source(root, name, body) {
  const file = path.join(root, 'tests', name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `import { test, expect } from 'vitest';\nimport fs from 'node:fs';\n${body}\n`);
}
function report(root, file = 'test-results/renderer-initial.json') {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}
function diagnosticReports(root) {
  return fs.readdirSync(path.join(root, 'test-results')).filter(name => name.startsWith('renderer-rerun-'))
    .map(name => report(root, `test-results/${name}/report.json`));
}

// These exercise the actual installed Vitest CLI and public reporter hooks.
// Counters are written by executed test files, not a fake CLI or an echo stub.
test('renderer manifests redact bounded causes and diagnostic rerun deduplicates exact failed files without overwriting originals', t => {
  const root = fixture(t);
  source(root, 'failing.test.jsx', `test('fails both initial runs', () => {
    const first = !fs.existsSync('failing-count') || fs.readFileSync('failing-count', 'utf8').length < 2;
    fs.appendFileSync('failing-count', 'F');
    if (first) {
      const cause = Object.assign(new Error('Cookie: fixture-cookie-value'), { code: 'EACCES', verificationStep: 'open' });
      const error = Object.assign(new Error('Exec command: fixture-command-value', { cause }), {
        code: 'UPDATE_CHECKSUM_MISMATCH', actual: 'fixture-actual-value', expected: 'fixture-expected-value',
        payload: 'fixture-payload-value', ignored: 'fixture-ignored-value',
      });
      error.stack += '\\npassword=fixture-password-value\\n' + 'x'.repeat(50000);
      throw error;
    }
  });
  test('same failed file is listed once', () => {
    if (fs.readFileSync('failing-count', 'utf8').length <= 2) throw new Error('safe second failure');
  });`);
  source(root, 'passing.test.jsx', `test('passing file', () => fs.appendFileSync('passing-count', 'P'));`);
  source(root, 'failing.test.jsx-extra.test.jsx', `test('prefix collision', () => fs.appendFileSync('prefix-count', 'S'));`);
  source(root, 'nested/tests/failing.test.jsx', `test('substring collision', () => fs.appendFileSync('nested-count', 'N'));`);
  const first = initial(root);
  assert.equal(first.status, 1, first.stderr);
  const originalPath = path.join(root, 'test-results/renderer-initial.json');
  const original = fs.readFileSync(originalPath, 'utf8');
  const manifest = JSON.parse(original);
  assert.deepEqual(manifest.failedFiles, ['tests/failing.test.jsx']);
  assert.equal(manifest.platform, process.platform);
  assert.equal(manifest.node, process.version);
  assert.equal(manifest.failures.length, 2);
  assert.match(original, /UPDATE_CHECKSUM_MISMATCH/);
  assert.match(original, /EACCES/);
  assert.match(original, /"verificationStep":"open"/);
  assert.match(original, /"cause":/);
  assert.match(original, /REDACTED/);
  assert.ok(original.length < 30000, 'oversized error strings must remain bounded');
  assert.doesNotMatch(original + first.stdout + first.stderr,
    /fixture-(?:cookie|command|password|actual|expected|payload|ignored)-value/);
  const coverage = initial(root, false, 'test-results/renderer-coverage.json', true);
  assert.equal(coverage.status, 1, coverage.stderr);
  const coverageOriginal = fs.readFileSync(path.join(root, 'test-results/renderer-coverage.json'), 'utf8');
  assert.deepEqual(JSON.parse(coverageOriginal).failedFiles, ['tests/failing.test.jsx']);
  fs.rmSync(path.join(root, 'coverage'), { recursive: true, force: true });
  const repeated = rerun(root, ['test-results/missing.json', 'test-results/renderer-initial.json',
    'test-results/renderer-coverage.json', 'test-results/renderer-initial.json']);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'failing-count'), 'utf8'), 'FFF');
  assert.equal(fs.readFileSync(path.join(root, 'passing-count'), 'utf8'), 'PP');
  assert.equal(fs.readFileSync(path.join(root, 'prefix-count'), 'utf8'), 'SS');
  assert.equal(fs.readFileSync(path.join(root, 'nested-count'), 'utf8'), 'NN');
  assert.equal(fs.readFileSync(originalPath, 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(root, 'test-results/renderer-coverage.json'), 'utf8'), coverageOriginal);
  assert.equal(fs.existsSync(path.join(root, 'coverage')), false, 'diagnostic run overrides configured coverage, not the original gate');
  assert.deepEqual(diagnosticReports(root).map(value => [value.reason, value.failedFiles]), [['passed', []]]);
  assert.match(repeated.stdout, /original failed step remains fatal/);
});

test('default reporter remains usable and an always-failing diagnostic run is attempted once and exits nonzero', t => {
  const root = fixture(t);
  source(root, 'failure.test.jsx', `test('persistent failure', () => {
    fs.appendFileSync('count', 'F'); throw new Error('safe persistent failure');
  });`);
  const first = initial(root, true);
  assert.equal(first.status, 1, first.stderr);
  assert.match(first.stdout + first.stderr, /persistent failure/);
  assert.equal(fs.readFileSync(path.join(root, 'count'), 'utf8'), 'F');
  const original = fs.readFileSync(path.join(root, 'test-results/renderer-initial.json'), 'utf8');
  const repeated = rerun(root, ['test-results/renderer-initial.json']);
  assert.equal(repeated.status, 1, repeated.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'count'), 'utf8'), 'FF');
  assert.equal(fs.readFileSync(path.join(root, 'test-results/renderer-initial.json'), 'utf8'), original);
  assert.deepEqual(diagnosticReports(root).map(value => value.failedFiles), [['tests/failure.test.jsx']]);
  assert.doesNotMatch(repeated.stdout + repeated.stderr, /safe persistent failure/,
    'the wrapper must not forward unstructured Vitest assertion output');
});

test('empty selections do not execute Vitest and missing, malformed, outside, and symlink paths fail closed', t => {
  const root = fixture(t);
  source(root, 'passing.test.jsx', `test('pass once', () => fs.appendFileSync('count', 'P'));`);
  assert.equal(initial(root).status, 0);
  const safe = report(root);
  const noFailures = rerun(root, ['test-results/missing.json', 'test-results/renderer-initial.json']);
  assert.equal(noFailures.status, 0, noFailures.stderr);
  assert.match(noFailures.stdout, /renderer-diagnostic-skip/);
  assert.equal(rerun(root, ['test-results/missing.json']).status, 1);
  const absent = { ...safe, reason: 'failed', failedFiles: ['tests/removed.test.jsx'] };
  fs.writeFileSync(path.join(root, 'test-results/absent.json'), JSON.stringify(absent));
  assert.equal(rerun(root, ['test-results/absent.json']).status, 0);
  const invalid = [
    '{"unlabelled":"fixture-untrusted-body",broken',
    JSON.stringify({ ...safe, expected: 'fixture-untrusted-body' }),
    JSON.stringify({ ...safe, reason: 'failed', failedFiles: ['../outside.test.jsx'] }),
    JSON.stringify({ ...safe, reason: 'failed', failedFiles: [path.join(root, 'tests/passing.test.jsx')] }),
    JSON.stringify({ ...safe, reason: 'failed', failedFiles: ['tests/../../outside.test.jsx'] }),
    JSON.stringify({ ...safe, failures: [{ file: null, error: { actual: 'fixture-untrusted-body' } }] }),
  ];
  for (const contents of invalid) {
    fs.writeFileSync(path.join(root, 'test-results/invalid.json'), contents);
    const result = rerun(root, ['test-results/renderer-initial.json', 'test-results/invalid.json']);
    assert.equal(result.status, 1, result.stdout);
    assert.doesNotMatch(result.stdout + result.stderr, /fixture-untrusted-body/);
  }
  fs.mkdirSync(path.join(root, 'outside'));
  fs.writeFileSync(path.join(root, 'outside/evil.test.jsx'), "throw new Error('must not execute');\n");
  fs.symlinkSync(path.join(root, 'outside'), path.join(root, 'tests/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(path.join(root, 'test-results/linked.json'), JSON.stringify({
    ...safe, reason: 'failed', failedFiles: ['tests/linked/evil.test.jsx'],
  }));
  assert.equal(rerun(root, ['test-results/linked.json']).status, 1);
  fs.symlinkSync(path.join(root, 'test-results'), path.join(root, 'linked-reports'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(rerun(root, ['linked-reports/renderer-initial.json']).status, 1);
  assert.equal(rerun(root, ['../outside.json']).status, 1);
  assert.equal(fs.readFileSync(path.join(root, 'count'), 'utf8'), 'P');
  assert.deepEqual(diagnosticReports(root), []);
});
