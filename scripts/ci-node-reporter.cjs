'use strict';

const { redactLogMessage } = require('../electron/log-redaction');

function errorDetails(error, seen = new Set(), depth = 0) {
  if (error == null) return null;
  if (depth >= 6 || seen.has(error)) return { name: 'TruncatedCause' };
  if (typeof error !== 'object') return { message: redactLogMessage(error) };
  seen.add(error);
  const result = {};
  for (const key of ['name', 'message', 'code', 'errno', 'syscall', 'verificationStep', 'failureType', 'stack']) {
    const value = error[key];
    if (typeof value === 'string') result[key] = redactLogMessage(value);
    else if (typeof value === 'number' && Number.isFinite(value)) result[key] = value;
  }
  // Error.cause and AggregateError.errors are normally non-enumerable. Do not
  // inspect arbitrary properties such as assertion actual/expected or payloads.
  if (error.cause != null) result.cause = errorDetails(error.cause, seen, depth + 1);
  if (Array.isArray(error.errors)) result.errors = error.errors.slice(0, 8).map(value => errorDetails(value, seen, depth + 1));
  return result;
}

module.exports = async function* report(source) {
  let passed = 0, failed = 0, skipped = 0;
  yield `${JSON.stringify({ event: 'environment', platform: process.platform, arch: process.arch, node: process.version })}\n`;
  for await (const { type, data } of source) {
    if (type === 'test:pass') {
      if (data.skip) skipped += 1; else passed += 1;
    } else if (type === 'test:fail') {
      failed += 1;
      yield `${JSON.stringify({ event: 'failure', platform: process.platform, node: process.version,
        file: typeof data.file === 'string' ? redactLogMessage(data.file) : null,
        line: data.line, column: data.column, name: redactLogMessage(data.name),
        error: errorDetails(data.details?.error) })}\n`;
    } else if (['test:diagnostic', 'test:stdout', 'test:stderr'].includes(type)) {
      yield `${JSON.stringify({ event: type, message: redactLogMessage(data.message) })}\n`;
    } else if (type === 'test:coverage') {
      const totals = Object.fromEntries(Object.entries(data.summary?.totals || {}).filter(([, value]) => typeof value === 'number'));
      yield `${JSON.stringify({ event: 'coverage', totals })}\n`;
    }
  }
  yield `${JSON.stringify({ event: 'summary', passed, failed, skipped })}\n`;
};
