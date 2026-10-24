'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startApplication } = require('../../electron/main');

function fixture(t, value, hasSwitch = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usshtc107-startup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const app = new EventEmitter();
  app.commandLine = {
    hasSwitch: (name) => { calls.push(['hasSwitch', name]); return hasSwitch; },
    getSwitchValue: (name) => { calls.push(['getSwitchValue', name]); return value === 'fixture' ? root : value; },
  };
  app.getPath = (name) => { calls.push(['getPath', name]); return path.join(root, name); };
  app.setPath = (name, directory) => calls.push(['setPath', name, directory]);
  app.setAppLogsPath = (directory) => calls.push(['setAppLogsPath', directory]);
  app.requestSingleInstanceLock = () => false;
  app.quit = () => calls.push(['quit']);
  const log = {};
  Object.defineProperty(log, 'transports', { get: () => { calls.push(['logger-access']); return {}; } });
  const electron = { app };
  Object.defineProperty(electron, 'session', { get: () => { calls.push(['session-access']); return undefined; } });
  return { root, calls, deps: { electron, log } };
}

test('absolute user-data override is configured privately before any store/log/session access', async (t) => {
  const f = fixture(t, 'fixture');
  await startApplication(f.deps).ready;
  const setLogsIndex = f.calls.findIndex((call) => call[0] === 'setAppLogsPath');
  const loggerIndex = f.calls.findIndex((call) => call[0] === 'logger-access');
  assert.ok(setLogsIndex >= 0 && setLogsIndex < loggerIndex);
  assert.ok(setLogsIndex < f.calls.findIndex((call) => call[0] === 'session-access'));
  assert.equal(f.calls.some((call) => call[0] === 'getPath'), false);
  assert.deepEqual(f.calls.filter((call) => call[0] === 'setPath'), [
    ['setPath', 'userData', f.root], ['setPath', 'sessionData', path.join(f.root, 'sessionData')],
  ]);
  for (const directory of [f.root, path.join(f.root, 'sessionData'), path.join(f.root, 'logs')]) {
    assert.equal(fs.statSync(directory).isDirectory(), true);
    if (process.platform !== 'win32') assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  }
});

test('empty and relative user-data overrides fail before logger or default-path access', (t) => {
  for (const value of ['', 'relative-user-data', '.']) {
    const f = fixture(t, value);
    assert.throws(() => startApplication(f.deps), /absolute path/);
    assert.equal(f.calls.some((call) => call[0] === 'logger-access' || call[0] === 'getPath'), false);
  }
});

test('omitting override preserves each Electron default data location', async (t) => {
  const f = fixture(t, undefined, false);
  await startApplication(f.deps).ready;
  assert.deepEqual(f.calls.filter((call) => call[0] === 'setPath'), [
    ['setPath', 'userData', path.join(f.root, 'userData')],
    ['setPath', 'sessionData', path.join(f.root, 'sessionData')],
  ]);
  assert.deepEqual(f.calls.find((call) => call[0] === 'setAppLogsPath'), ['setAppLogsPath', path.join(f.root, 'logs')]);
  assert.equal(f.calls.some((call) => call[0] === 'getSwitchValue'), false);
});
