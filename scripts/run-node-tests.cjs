'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { redactLogMessage } = require('../electron/log-redaction');

function enumerate(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? enumerate(file) : entry.isFile() && entry.name.endsWith('.test.js') ? [file] : [];
  });
}

function canonical(file) {
  try {
    const value = fs.realpathSync.native(file.startsWith('file:') ? fileURLToPath(file) : file);
    return process.platform === 'win32' ? value.toLowerCase() : value;
  } catch { return null; }
}

function execute(files, args, report) {
  const reporter = pathToFileURL(path.join(__dirname, 'ci-node-reporter.cjs')).href;
  const reporters = report ? [
    `--test-reporter=${reporter}`, '--test-reporter-destination=stdout',
    `--test-reporter=${reporter}`, `--test-reporter-destination=${report}`,
  ] : [];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', ...args, ...reporters, ...files], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code: code ?? 1, signal }));
  });
}

async function main() {
  const files = enumerate('tests').sort();
  const args = process.argv.slice(2);
  const ci = process.env.CI === 'true';
  const directory = path.join('test-results', `node-ci-${process.pid}`);
  if (ci) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const report = ci ? path.join(directory, 'initial.jsonl') : null;
  const initial = await execute(files, args, report);
  if (ci && initial.code !== 0 && !initial.signal) {
    const eligible = new Map(files.map(file => [canonical(file), file]));
    eligible.delete(null);
    const failed = new Set();
    let records = [];
    try { records = fs.readFileSync(report, 'utf8').split('\n'); } catch { /* A failed reporter is an infrastructure failure, never a pass. */ }
    for (const line of records) {
      try {
        const record = JSON.parse(line);
        if (record.event === 'failure' && typeof record.file === 'string') {
          const file = eligible.get(canonical(record.file));
          if (file) failed.add(file);
        }
      } catch { /* A malformed diagnostic cannot select an arbitrary executable. */ }
    }
    if (failed.size) {
      console.error(JSON.stringify({ diagnosticRerun: [...failed], originalExitCode: initial.code,
        note: 'One diagnostic rerun only; the initial failure remains fatal.' }));
      // Coverage remains mandatory on the original run. A partial diagnostic
      // rerun measures behavior, not coverage of the excluded passing files.
      const diagnosticArgs = args.filter(value => value !== '--experimental-test-coverage' && !value.startsWith('--test-coverage-'));
      const repeated = await execute([...failed].sort(), diagnosticArgs, path.join(directory, 'diagnostic-rerun.jsonl'));
      console.error(JSON.stringify({ diagnosticRerunExitCode: repeated.code, diagnosticRerunSignal: repeated.signal,
        originalExitCode: initial.code }));
    } else console.error('No eligible failed test files were reported; retaining the initial infrastructure failure.');
  }
  if (initial.signal) process.kill(process.pid, initial.signal);
  else process.exitCode = initial.code;
}

main().catch(error => { console.error(redactLogMessage(error?.message || 'Node test runner failed')); process.exitCode = 1; });
