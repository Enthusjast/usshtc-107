'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  let api;
  const renderer = new EventEmitter();
  renderer.invoke = () => Promise.resolve({ ok: true, value: null });
  const contextBridge = { exposeInMainWorld: (name, value) => {
    assert.equal(name, 'electronAPI'); api = value;
  } };
  const source = fs.readFileSync(path.join(__dirname, '../../electron/preload.js'), 'utf8');
  vm.runInNewContext(source, { require: (name) => {
    assert.equal(name, 'electron'); return { contextBridge, ipcRenderer: renderer };
  } });
  return { api, renderer };
}

test('preload denies generic IPC and releases runtime event subscriptions', async () => {
  const f = fixture();
  assert.equal(f.api.invoke, undefined);
  const values = [];
  const unsubscribe = f.api.onRuntimeState((value) => values.push(value));
  f.renderer.emit('runtime-state', {}, { revision: 1 });
  unsubscribe();
  f.renderer.emit('runtime-state', {}, { revision: 2 });
  assert.deepEqual(values, [{ revision: 1 }]);
  assert.equal(f.renderer.listenerCount('runtime-state'), 0);
});
