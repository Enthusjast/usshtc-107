'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { redactLogMessage } = require('../electron/log-redaction');

const MAX_REPORT_BYTES = 8 * 1024 * 1024;
const ERROR_KEYS = new Set(['name', 'message', 'code', 'errno', 'syscall', 'verificationStep', 'failureType', 'stack']);

function malformed() { throw new Error('Invalid safe renderer diagnostic manifest'); }
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) malformed();
}
function text(value, limit = 4096) {
  if (typeof value !== 'string' || value.length > limit) malformed();
}
function testName(value) {
  text(value, 1024);
  if (!value.startsWith('tests/') || !value.endsWith('.test.jsx')
    || /[\x00-\x1f\x7f\\:]/.test(value) || path.posix.normalize(value) !== value
    || value.split('/').some(part => !part || part === '.' || part === '..')) malformed();
}
function errorDetails(value, depth = 0, budget = { nodes: 192 }) {
  if (value === null) return;
  if (depth > 6 || --budget.nodes < 0) malformed();
  object(value, [...ERROR_KEYS, 'cause', 'errors']);
  for (const [key, field] of Object.entries(value)) {
    if (key === 'cause') errorDetails(field, depth + 1, budget);
    else if (key === 'errors') {
      if (!Array.isArray(field) || field.length > 4) malformed();
      for (const error of field) errorDetails(error, depth + 1, budget);
    } else if (typeof field !== 'number' || !Number.isFinite(field)) text(field);
  }
}
function validate(report) {
  object(report, ['schemaVersion', 'reporter', 'platform', 'arch', 'node', 'reason', 'failedFiles', 'failures', 'truncated']);
  if (report.schemaVersion !== 1 || report.reporter !== 'usshtc107-vitest'
    || !['passed', 'failed', 'interrupted'].includes(report.reason) || typeof report.truncated !== 'boolean'
    || !Array.isArray(report.failedFiles) || report.failedFiles.length > 512
    || !Array.isArray(report.failures) || report.failures.length > 64) malformed();
  for (const key of ['platform', 'arch', 'node']) text(report[key]);
  for (const file of report.failedFiles) testName(file);
  if (report.reason === 'passed' && report.failedFiles.length) malformed();
  const files = new Set(report.failedFiles);
  for (const failure of report.failures) {
    object(failure, ['file', 'error']);
    if (!Object.hasOwn(failure, 'file') || !Object.hasOwn(failure, 'error')) malformed();
    if (failure.file !== null) {
      testName(failure.file);
      if (!files.has(failure.file)) malformed();
    }
    errorDetails(failure.error);
  }
  return report;
}

function inside(root, name, missing = false) {
  const absolute = path.resolve(root, name);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Renderer diagnostic paths must stay inside the project');
  }
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink()) throw new Error('Renderer diagnostic paths must not contain symbolic links');
  }
  return absolute;
}
function readReport(root, name, missing = false) {
  const file = inside(root, name, missing);
  if (file === null) return null;
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) malformed();
    let report;
    try { report = JSON.parse(fs.readFileSync(descriptor, 'utf8')); }
    catch { malformed(); }
    return validate(report);
  } finally { fs.closeSync(descriptor); }
}
function enumerate(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    // Dirent distinguishes symlinks (including directory junctions) from owned
    // regular files. Never follow them when constructing the execution allowlist.
    if (entry.isDirectory()) files.push(...enumerate(file));
    else if (entry.isFile() && entry.name.endsWith('.test.jsx')) files.push(file);
  }
  return files.sort();
}
function escapeGlob(value) { return value.replace(/[\\*?{}()[\]!+@]/g, '\\$&'); }
function log(record) {
  // Only locally selected file/environment/status data reaches stdout. Never
  // forward Vitest console output, assertion diffs, or report-supplied bodies.
  console.log(redactLogMessage(JSON.stringify(record)));
}
async function main() {
  const names = process.argv.slice(2);
  if (!names.length) throw new Error('Usage: node scripts/rerun-ui-failures.cjs REPORT...');
  const root = fs.realpathSync.native(process.cwd());
  const reports = names.map(name => readReport(root, name, true)).filter(Boolean);
  if (!reports.length) throw new Error('No initial renderer diagnostic manifest exists');
  const requested = new Set(reports.flatMap(report => report.failedFiles));
  if (!requested.size) {
    log({ event: 'renderer-diagnostic-skip', reason: 'No eligible failed renderer test files' });
    return;
  }
  const directory = inside(root, 'tests');
  const owned = enumerate(directory);
  const selected = new Set();
  for (const name of requested) {
    // Check rejected links even when the path is absent from the allowlist.
    const file = inside(root, name, true);
    if (file !== null && owned.includes(file)) selected.add(file);
  }
  if (!selected.size) {
    log({ event: 'renderer-diagnostic-skip', reason: 'No eligible failed renderer test files' });
    return;
  }
  const results = inside(root, 'test-results', true) || path.join(root, 'test-results');
  fs.mkdirSync(results, { recursive: true, mode: 0o700 });
  inside(root, 'test-results');
  const output = path.join(fs.mkdtempSync(path.join(results, 'renderer-rerun-')), 'report.json');
  const files = [...selected].sort();
  const reporter = pathToFileURL(path.join(__dirname, 'ci-vitest-reporter.cjs')).href;
  const cli = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  // Vitest filters paths by substring. Exclude every other enumerated test, and
  // let the reporter verify exact discovery before any test can execute.
  const excluded = owned.filter(file => !selected.has(file)).map(file =>
    `--exclude=${escapeGlob(path.relative(root, file).split(path.sep).join('/'))}`);
  const args = [cli, 'run', ...files, ...excluded, '--coverage.enabled=false', '--retry=0',
    '--silent=true', `--reporter=${reporter}`];
  log({ event: 'renderer-diagnostic-rerun', platform: process.platform, node: process.version,
    files: files.map(file => path.relative(root, file).split(path.sep).join('/')),
    report: path.relative(root, output).split(path.sep).join('/'),
    note: 'One diagnostic run only; the original failed step remains fatal' });
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: { ...process.env, USSHTC107_VITEST_REPORT_FILE: output, USSHTC107_VITEST_RERUN_FILES: JSON.stringify(files) },
      stdio: 'ignore',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
  const report = readReport(root, output, true);
  log({ event: 'renderer-diagnostic-result', exitCode: result.code, signal: result.signal,
    manifestWritten: report !== null, platform: process.platform, node: process.version });
  if (!report) throw new Error('Renderer diagnostic runner did not produce a safe manifest');
  process.exitCode = result.code;
}

main().catch(error => {
  console.error(redactLogMessage(error?.message || 'Renderer diagnostic rerun failed'));
  process.exitCode = 1;
});
