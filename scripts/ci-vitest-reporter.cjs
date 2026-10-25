'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { redactLogMessage } = require('../electron/log-redaction');

const MAX_FILES = 512;
const MAX_FAILURES = 64;
const MAX_STRING = 4096;
const ERROR_BUDGET = 16 * 1024;

function diagnostic(value, limit = MAX_STRING) {
  // Redact before bounding: a credential must not become visible by truncating
  // the label that tells the shared redactor how to recognize it.
  return redactLogMessage(value).slice(0, limit);
}
function errorDetails(error, budget = { remaining: ERROR_BUDGET, nodes: 32 }, seen = new Set(), depth = 0) {
  if (error == null) return null;
  if (depth >= 6 || budget.remaining <= 0 || budget.nodes-- <= 0 || seen.has(error)) return { name: diagnostic('TruncatedCause') };
  if (typeof error !== 'object') error = { message: error };
  seen.add(error);
  const result = {};
  for (const key of ['name', 'message', 'code', 'errno', 'syscall', 'verificationStep', 'failureType', 'stack']) {
    const value = error[key];
    if (typeof value === 'string') {
      const text = diagnostic(value, Math.min(MAX_STRING, budget.remaining));
      budget.remaining -= text.length;
      result[key] = text;
    } else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
  }
  // Do not serialize the Error or assertion object itself. Vitest's diff,
  // actual, expected, payload, and custom properties can contain credentials
  // or remote output. Non-enumerable causes still need their checkpoints.
  if (error.cause != null) result.cause = errorDetails(error.cause, budget, seen, depth + 1);
  if (Array.isArray(error.errors)) {
    result.errors = error.errors.slice(0, 4).map(value => errorDetails(value, budget, seen, depth + 1));
  }
  return result;
}

// Vitest 4 public Reporter API: onInit, onTestRunStart, onTestRunEnd;
// TestModule.moduleId/errors/children and TestCase.result. The default reporter
// remains independently selectable with --reporter=default.
module.exports = class CiVitestReporter {
  onInit(vitest) {
    this.root = path.resolve(vitest.config.root);
  }

  onTestRunStart(specifications) {
    const selection = process.env.USSHTC107_VITEST_RERUN_FILES;
    if (!selection) return;
    const expected = new Set(JSON.parse(selection));
    const actual = specifications.map(specification => path.resolve(specification.moduleId));
    // CLI filename filters are substring filters, not exact paths. Fail before
    // test execution if discovery ever includes an unselected or duplicate file.
    if (actual.length !== expected.size || new Set(actual).size !== actual.length
      || actual.some(file => !expected.has(file))) {
      throw new Error('Renderer diagnostic discovery did not match the selected owned test files');
    }
  }

  onTestRunEnd(testModules, unhandledErrors, reason) {
    const root = this.root || process.cwd();
    const failedFiles = new Set();
    const failures = [];
    let truncated = false;
    const add = (file, error) => {
      if (failures.length < MAX_FAILURES) failures.push({ file, error: errorDetails(error) });
      else truncated = true;
    };
    for (const module of testModules) {
      if (module.ok()) continue;
      const file = diagnostic(path.relative(root, module.moduleId).split(path.sep).join('/'), 1024);
      if (failedFiles.size < MAX_FILES) failedFiles.add(file);
      else truncated = true;
      const start = failures.length;
      for (const error of module.errors()) add(file, error);
      for (const suite of module.children.allSuites()) {
        for (const error of suite.errors()) add(file, error);
      }
      for (const test of module.children.allTests('failed')) {
        for (const error of test.result().errors || []) add(file, error);
      }
      if (failures.length === start && failures.length < MAX_FAILURES) add(file, null);
    }
    for (const error of unhandledErrors) add(null, error);
    const report = {
      schemaVersion: 1,
      reporter: 'usshtc107-vitest',
      platform: diagnostic(process.platform),
      arch: diagnostic(process.arch),
      node: diagnostic(process.version),
      reason: diagnostic(reason),
      failedFiles: [...failedFiles].sort(),
      failures,
      truncated,
    };
    const destination = path.resolve(process.env.USSHTC107_VITEST_REPORT_FILE || 'test-results/renderer-initial.json');
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, `${JSON.stringify(report)}\n`, { mode: 0o600 });
  }
};
