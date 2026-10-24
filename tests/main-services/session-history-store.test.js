'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionHistoryStore, MAX_HISTORY_BYTES, MAX_HISTORY_SESSIONS,
  HISTORY_RETENTION_MS } = require('../../electron/session-history-store');

const NOW = Date.UTC(2026, 9, 24, 12);
const DAY = 86400000;
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc107-history-'));
  const filePath = path.join(root, 'session-history.json');
  if (options.document !== undefined) fs.writeFileSync(filePath,
    typeof options.document === 'string' || Buffer.isBuffer(options.document)
      ? options.document : JSON.stringify(options.document));
  let now = NOW;
  let timerId = 0;
  const timers = new Map(), warnings = [], states = [];
  const clock = {
    now: () => now,
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
  };
  const store = createSessionHistoryStore({ filePath, clock, io: options.io || fs,
    onWarning: (code) => warnings.push(code), onState: (state) => states.push(state) });
  t.after(() => { store.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const tick = (ms = 5000) => {
    now += ms;
    for (const [id, timer] of [...timers]) { timers.delete(id); timer.fn(); }
  };
  return { root, filePath, store, timers, warnings, states, clock, tick };
}
function row(id, overrides = {}) {
  return { id: `test-run:${id}`, profileId: 'default', kind: 'shell', startedAt: NOW - 1000,
    endedAt: NOW, bytesSent: 1, bytesReceived: 2, exitCode: 0, reason: 'completed', ...overrides };
}
const readDocument = (f) => JSON.parse(fs.readFileSync(f.filePath, 'utf8'));
const get = (f, profileId = 'default', days = 30) => f.store.get({ profileId, days }).sessions;
const register = (f, id = 'run:1', extra = {}) => f.store.register({ sessionKey: id,
  profileId: 'default', kind: 'shell', startedAt: NOW, ...extra });

test('active summaries coalesce for five seconds and final counters flush immediately without private content', (t) => {
  const f = fixture(t);
  assert.equal(register(f, 'run:1', { kind: 'exec', command: 'NEVER_PERSIST_COMMAND',
    output: 'NEVER_PERSIST_OUTPUT', username: 'NEVER_PERSIST_USER', remoteAddress: 'NEVER_PERSIST_ADDRESS' }), true);
  assert.equal(fs.existsSync(f.filePath), false);
  assert.equal(f.store.sample('run:1', { bytesSent: 13, bytesReceived: 29 }), true);
  assert.equal(f.store.sample('run:1', { bytesSent: 14, bytesReceived: 31 }), true);
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 5000);
  f.tick();
  assert.equal(readDocument(f).sessions[0].endedAt, null);
  assert.equal(readDocument(f).sessions[0].bytesReceived, 31);
  assert.equal(f.store.sample('run:1', { bytesSent: 20, bytesReceived: 40 }), true);
  assert.equal(f.store.finalize('run:1', { endedAt: NOW + 6000, bytesSent: 21,
    bytesReceived: 45, exitCode: 7, reason: 'completed' }), true);
  assert.equal(f.timers.size, 0);
  const document = readDocument(f);
  assert.deepEqual(Object.keys(document).sort(), ['schemaVersion', 'sessions']);
  assert.deepEqual(document.sessions[0], { id: 'run:1', profileId: 'default', kind: 'exec',
    startedAt: NOW, endedAt: NOW + 6000, bytesSent: 21, bytesReceived: 45, exitCode: 7, reason: 'completed' });
  assert.doesNotMatch(fs.readFileSync(f.filePath, 'utf8'), /NEVER_PERSIST|command|output|username|remoteAddress/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.filePath).mode & 0o777, 0o600);
  assert.ok(f.states.length >= 4, 'data changes notify the owner to advance its history revision');
});

test('only registered session keys finalize once; counters never regress or become invalid', (t) => {
  const f = fixture(t);
  assert.equal(f.store.finalize('unknown', { reason: 'completed' }), false);
  assert.equal(register(f), true);
  assert.equal(register(f), false);
  assert.equal(f.store.sample('run:1', { bytesSent: 10, bytesReceived: 20 }), true);
  for (const counters of [{ bytesSent: -1, bytesReceived: 21 }, { bytesSent: NaN, bytesReceived: 21 },
    { bytesSent: 10, bytesReceived: Infinity }, { bytesSent: 9, bytesReceived: 20 },
    { bytesSent: Number.MAX_SAFE_INTEGER + 1, bytesReceived: 21 }]) {
    assert.equal(f.store.sample('run:1', counters), false);
  }
  assert.equal(f.store.finalize('run:1', { reason: 'arbitrary_backend_error' }), false);
  assert.equal(f.store.finalize('run:1', { reason: 'completed', exitCode: 256 }), false);
  assert.equal(f.store.finalize('run:1', { reason: 'completed', endedAt: NOW - 1,
    bytesSent: 1, bytesReceived: 2 }), true);
  assert.equal(get(f)[0].bytesSent, 10);
  assert.equal(get(f)[0].bytesReceived, 20);
  assert.equal(get(f)[0].endedAt, NOW, 'backwards wall clock cannot make duration negative');
  assert.equal(f.store.finalize('run:1', { reason: 'network_error' }), false);
  assert.equal(f.store.sample('run:1', { bytesSent: 100, bytesReceived: 100 }), false);
  assert.equal(get(f).length, 1);
  const copy = get(f)[0];
  copy.bytesSent = 999;
  assert.equal(get(f)[0].bytesSent, 10);
  for (const extra of [{ kind: 'sftp' }, { startedAt: -1 }, { profileId: 'bad\nprofile' },
    { sessionKey: '' }, { bytesSent: -1 }]) assert.equal(register(f, 'run:bad', extra), false);
});

test('startup finalizes unclosed summaries as interrupted and preserves completed terminal reasons', (t) => {
  const f = fixture(t, { document: { schemaVersion: 1, sessions: [
    row('active', { kind: 'exec', endedAt: null, exitCode: null, reason: null, bytesReceived: 999 }),
    row('completed', { reason: 'timeout', exitCode: 124 }),
  ] } });
  const interrupted = get(f).find((record) => record.id.endsWith('active'));
  assert.equal(interrupted.reason, 'interrupted');
  assert.equal(interrupted.exitCode, null);
  assert.equal(interrupted.endedAt, NOW);
  assert.equal(interrupted.bytesReceived, 999);
  assert.equal(f.store.finalize(interrupted.id, { reason: 'completed' }), false);
  assert.equal(get(f).find((record) => record.id.endsWith('completed')).reason, 'timeout');
  assert.equal(readDocument(f).sessions.find((record) => record.id.endsWith('active')).reason, 'interrupted');
});

test('retention first removes expired records, then the oldest complete records beyond 1000', (t) => {
  const sessions = Array.from({ length: MAX_HISTORY_SESSIONS + 8 }, (_, id) => row(id,
    { startedAt: NOW - 20000 + id, endedAt: NOW - 10000 + id }));
  sessions.unshift(row('expired', { startedAt: NOW - HISTORY_RETENTION_MS - DAY,
    endedAt: NOW - HISTORY_RETENTION_MS - 1 }));
  const f = fixture(t, { document: { schemaVersion: 1, sessions } });
  assert.equal(get(f).length, MAX_HISTORY_SESSIONS);
  assert.equal(get(f).some((record) => record.id.endsWith('expired')), false);
  assert.equal(get(f).some((record) => record.id === 'test-run:0'), false);
  assert.equal(get(f).some((record) => record.id === 'test-run:7'), false);
  assert.equal(get(f).some((record) => record.id === 'test-run:8'), true);
  assert.equal(readDocument(f).sessions.length, MAX_HISTORY_SESSIONS);
  assert.ok(fs.statSync(f.filePath).size <= MAX_HISTORY_BYTES);
});

test('byte bound evicts oldest complete records without losing registered active ownership', (t) => {
  const f = fixture(t);
  const long = '中'.repeat(1000);
  // Start with one large active population and turn a subset into complete rows.
  for (let id = 0; id < 310; id += 1) assert.equal(register(f, `${id}:${long}`), true);
  for (let id = 0; id < 10; id += 1) {
    assert.equal(f.store.finalize(`${id}:${long}`, { reason: 'completed' }), true);
  }
  for (let id = 310; id < 340; id += 1) register(f, `${id}:${long}`);
  assert.ok(get(f).length < 340);
  assert.equal(get(f).some((record) => record.id === `0:${long}`), false);
  assert.equal(f.store.finalize(`309:${long}`, { bytesSent: 9, bytesReceived: 8,
    reason: 'user_disconnect' }), true);
  assert.ok(fs.statSync(f.filePath).size <= MAX_HISTORY_BYTES);
  assert.equal(f.store.get({ profileId: 'default', days: 30 }).errorCode, null);
});

test('seven/thirty-day reads filter the profile and days while UTC timestamps stay numeric', (t) => {
  const f = fixture(t, { document: { schemaVersion: 1, sessions: [
    row('recent'), row('older', { startedAt: NOW - 10 * DAY, endedAt: NOW - 9 * DAY }),
    row('other', { profileId: 'other-profile' }),
  ] } });
  assert.equal(get(f, 'default', 7).length, 1);
  assert.equal(get(f, 'default', 30).length, 2);
  assert.equal(get(f, 'other-profile', 7).length, 1);
  assert.equal(typeof get(f)[0].startedAt, 'number');
});

test('write failure retains bounded memory and cleaned state until Retry, never resurrecting a late close', (t) => {
  let failing = true;
  const io = { ...fs, renameSync: (...args) => {
    if (failing) throw Object.assign(new Error('PRIVATE_PATH_AND_ERROR'), { code: 'EACCES' });
    return fs.renameSync(...args);
  } };
  const f = fixture(t, { io });
  register(f);
  assert.equal(f.store.finalize('run:1', { reason: 'network_error', bytesReceived: 99, exitCode: 255 }), true);
  assert.equal(f.store.get({ profileId: 'default', days: 7 }).errorCode, 'HISTORY_STORAGE_FAILED');
  assert.equal(get(f)[0].bytesReceived, 99);
  register(f, 'run:2');
  assert.deepEqual(f.store.clear('default'), { errorCode: 'HISTORY_STORAGE_FAILED' });
  assert.equal(get(f).length, 0);
  assert.equal(f.store.finalize('run:2', { reason: 'completed', bytesReceived: 100 }), false);
  assert.deepEqual(f.warnings, ['HISTORY_STORAGE_FAILED']);
  assert.doesNotMatch(JSON.stringify(f.states), /PRIVATE_PATH/);
  failing = false;
  assert.deepEqual(f.store.retry(), { errorCode: null });
  assert.deepEqual(readDocument(f), { schemaVersion: 1, sessions: [] });
  assert.equal(f.timers.size, 0);
});

test('corrupt JSON/schema/UTF8 backups are private, bounded and replaced by empty safe history', (t) => {
  for (const document of ['{invalid json', { schemaVersion: 2, sessions: [] },
    { schemaVersion: 1, sessions: [row('bad', { username: 'private-original' })] }, Buffer.from([0xff, 0xfe])]) {
    const f = fixture(t, { document });
    assert.deepEqual(get(f), []);
    assert.equal(f.warnings.includes('HISTORY_CORRUPT'), true);
    assert.deepEqual(readDocument(f), { schemaVersion: 1, sessions: [] });
    const backups = fs.readdirSync(f.root).filter((name) => name.includes('.corrupt-'));
    assert.equal(backups.length, 1);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(f.root, backups[0])).mode & 0o777, 0o600);
    if (Buffer.isBuffer(document)) assert.deepEqual(fs.readFileSync(path.join(f.root, backups[0])), document);
  }
});

test('failed corrupt backup preserves original until retry can complete a private backup', (t) => {
  let failing = true;
  const io = { ...fs, openSync: (target, ...args) => {
    if (failing && String(target).includes('.corrupt-')) throw new Error('Cannot back up');
    return fs.openSync(target, ...args);
  } };
  const f = fixture(t, { document: '{broken', io });
  assert.equal(fs.readFileSync(f.filePath, 'utf8'), '{broken');
  assert.equal(f.store.get({ profileId: 'default', days: 30 }).errorCode, 'HISTORY_STORAGE_FAILED');
  failing = false;
  assert.deepEqual(f.store.retry(), { errorCode: null });
  assert.deepEqual(readDocument(f).sessions, []);
});

test('clear during a startup read failure remains cleared when Retry recovers the older disk document', (t) => {
  let failing = true;
  const io = { ...fs, openSync: (target, flags, ...args) => {
    if (failing && flags === 'r') throw new Error('Read unavailable');
    return fs.openSync(target, flags, ...args);
  } };
  const f = fixture(t, { document: { schemaVersion: 1, sessions: [row('old'), row('other', { profileId: 'other' })] }, io });
  register(f, 'new-run:1', { profileId: 'other' });
  f.store.clear('default');
  failing = false;
  assert.deepEqual(f.store.retry(), { errorCode: null });
  assert.deepEqual(get(f), []);
  assert.equal(get(f, 'other').length, 2);
  assert.equal(readDocument(f).sessions.some((record) => record.profileId === 'default'), false);
});

test('oversized unreadable sources are not overwritten; disposal flushes and cancels all active timers', (t) => {
  const oversized = fixture(t, { document: Buffer.alloc(MAX_HISTORY_BYTES + 1, 0x20) });
  assert.equal(oversized.store.get({ profileId: 'default', days: 7 }).errorCode, 'HISTORY_STORAGE_FAILED');
  assert.equal(fs.statSync(oversized.filePath).size, MAX_HISTORY_BYTES + 1);
  const f = fixture(t);
  register(f);
  f.store.sample('run:1', { bytesSent: 1, bytesReceived: 2 });
  assert.equal(f.timers.size, 1);
  assert.deepEqual(f.store.dispose(), { errorCode: null });
  assert.equal(f.timers.size, 0);
  assert.equal(readDocument(f).sessions[0].bytesReceived, 2);
  assert.equal(register(f, 'run:after-dispose'), false);
});

test('remote readiness timeouts persist as distinct session outcomes', t => {
  const f = fixture(t);
  register(f, 'run:ready-timeout');
  assert.equal(f.store.finalize('run:ready-timeout', { endedAt: NOW + 10000,
    exitCode: 255, reason: 'remote_not_ready' }), true);
  const record = readDocument(f).sessions.find(item => item.id === 'run:ready-timeout');
  assert.equal(record.reason, 'remote_not_ready');
  assert.equal(record.exitCode, 255);
  assert.equal(record.endedAt, NOW + 10000);
});
