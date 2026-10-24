'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createTrayService } = require('../../electron/tray-service');

function fixture() {
  const shown = [];
  const warnings = [];
  let tray;
  const preferences = { locale: 'en', notifyConnections: false, notifyAuth: true };
  class Tray extends EventEmitter {
    constructor() { super(); tray = this; }
    setImage() {}
    setToolTip() {}
    setContextMenu(menu) { this.menu = menu; }
    destroy() { this.destroyed = true; }
  }
  class Notification {
    static isSupported() { return true; }
    constructor(value) { this.value = value; }
    show() { shown.push(this.value); }
  }
  const service = createTrayService({
    Tray, Notification, Menu: { buildFromTemplate: value => value },
    nativeImage: { createFromBuffer: value => value },
    getWindow: () => null, run: async () => {}, getPreferences: () => preferences,
    log: (...args) => warnings.push(args),
  });
  return { service, shown, warnings, preferences, getTray: () => tray };
}

test('notifications honor category preference and never include arbitrary event data', () => {
  const { service, shown, preferences } = fixture();
  service.notify('new-session', { username: 'private-user', command: 'private-command' });
  assert.deepEqual(shown, []);
  preferences.notifyConnections = true;
  service.notify('new-session', { username: 'private-user', command: 'private-command' });
  service.notify('auth', { cookie: 'private-cookie' });
  const output = JSON.stringify(shown);
  assert.equal(shown.length, 2);
  assert.doesNotMatch(output, /private-user|private-command|private-cookie/);
  preferences.locale = 'zh';
  service.notify('auth');
  assert.equal(shown[2].title, '需要登录');
  service.dispose();
});

test('busy or storage-locked runtime cannot be started from tray', () => {
  const { service, getTray } = fixture();
  const snapshot = { proxyStatus: 'stopped', loginStatus: 'success', cookieValid: true, connectionCount: 0, operation: 'logging_in', storageErrorCode: null };
  service.update(snapshot);
  assert.equal(getTray().menu[0].enabled, false);
  service.update({ ...snapshot, operation: null, storageErrorCode: 'SETTINGS_LOCKED' });
  assert.equal(getTray().menu[0].enabled, false);
  service.update({ ...snapshot, operation: null });
  assert.equal(getTray().menu[0].enabled, true);
  service.dispose();
});

test('disposal is idempotent and prevents late notifications or tray updates', () => {
  const { service, shown, getTray } = fixture();
  service.dispose();
  service.dispose();
  service.notify('auth');
  service.update({ proxyStatus: 'started' });
  assert.equal(getTray().destroyed, true);
  assert.equal(getTray().listenerCount('click'), 0);
  assert.deepEqual(shown, []);
});
