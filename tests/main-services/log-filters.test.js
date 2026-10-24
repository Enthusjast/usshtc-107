const test = require('node:test');
const assert = require('node:assert/strict');
const { validateLogFilters, filterLogs } = require('../../shared/log-filters.mjs');

const logs = [
  { time: '2026-01-01T00:00:00.000Z', level: 'info', source: 'proxy', message: 'Literal [HELLO].*' },
  { time: '2026-01-02T00:00:00.000Z', level: 'error', source: 'app', message: 'Other message' },
];
test('filters use literal case-insensitive messages and inclusive time bounds', () => {
  assert.deepEqual(filterLogs(logs, validateLogFilters({ query: '[hello].*', from: logs[0].time, to: logs[0].time }, ['proxy', 'app'])), [logs[0]]);
  assert.deepEqual(filterLogs(logs, validateLogFilters({ level: 'error', source: 'app' }, ['app'])), [logs[1]]);
  assert.deepEqual(filterLogs(logs, validateLogFilters()), logs);
});
test('rejects unknown keys, invalid timestamps, inverted bounds and arbitrary sources', () => {
  for (const input of [null, [], { message: 'no' }, { query: 'x'.repeat(257) }, { query: 1 },
    { level: 'fatal' }, { source: 'unknown' }, { source: null }, { from: undefined },
    { from: '2026-02-30T00:00:00.000Z' }, { from: '2026-01-01' },
    { from: '2026-01-01T00:00:00+01:00' }, { from: logs[1].time, to: logs[0].time }]) {
    assert.throws(() => validateLogFilters(input, ['proxy']), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(validateLogFilters({ from: '2026-01-01T00:00:00Z' }).from, '2026-01-01T00:00:00Z');
  assert.equal(validateLogFilters({ query: 'x'.repeat(256) }).query.length, 256);
});
