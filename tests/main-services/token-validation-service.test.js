'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTokenValidationService, MIN_TOKEN_VALIDATION_INTERVAL_MS } = require('../../electron/token-validation-service');

const flush = async () => { for (let index = 0; index < 30; index += 1) await Promise.resolve(); };
function fixture(options = {}) {
  let now = 0, nextId = 0;
  const timers = new Map();
  const clock = {
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async tick(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, value]) => value.at <= end);
        if (!next) break;
        timers.delete(next[0]); now = next[1].at; next[1].fn(); await flush();
      }
      now = end; await flush();
    },
  };
  const snapshot = { profileId: 'first', epoch: 1, cookieValid: true };
  const preferences = { validateTokenPeriodically: options.enabled === true };
  const requests = [], results = [];
  let cookie = 'SCOW_USER=fixture';
  let authGeneration = 1;
  const service = createTokenValidationService({ clock, intervalMs: options.intervalMs,
    getSnapshot: () => snapshot, getPreferences: () => preferences,
    getCookie: () => cookie, getAuthGeneration: () => authGeneration,
    portalPreflight: { validate: async value => {
      requests.push(value);
      return options.validate ? options.validate(value) : { status: 'valid' };
    } },
    onResult: value => { results.push(value); service.update(); },
  });
  return { service, clock, timers, snapshot, preferences, requests, results,
    setCookie: value => { cookie = value; }, setAuthGeneration: value => { authGeneration = value; } };
}

test('periodic validation defaults off, starts no immediate request and enforces at least five minutes', async () => {
  const f = fixture({ intervalMs: 1 });
  f.service.update();
  await f.clock.tick(MIN_TOKEN_VALIDATION_INTERVAL_MS * 2);
  assert.equal(f.requests.length, 0);
  f.preferences.validateTokenPeriodically = true; f.service.update();
  await f.clock.tick(MIN_TOKEN_VALIDATION_INTERVAL_MS - 1);
  assert.equal(f.requests.length, 0);
  await f.clock.tick(1);
  assert.equal(f.requests.length, 1);
  assert.equal(f.results[0].status, 'valid');
  assert.equal(JSON.stringify(f.results).includes('SCOW_USER'), false);
  f.service.dispose(); assert.equal(f.timers.size, 0);
});

test('periodic validation is single-flight and waits a full interval after completion', async () => {
  let finish;
  const f = fixture({ enabled: true, validate: () => new Promise(resolve => { finish = resolve; }) });
  f.service.update(); await f.clock.tick(MIN_TOKEN_VALIDATION_INTERVAL_MS);
  for (let index = 0; index < 10; index += 1) f.service.update();
  await f.clock.tick(MIN_TOKEN_VALIDATION_INTERVAL_MS * 3);
  assert.equal(f.requests.length, 1);
  finish({ status: 'valid' }); await flush();
  await f.clock.tick(MIN_TOKEN_VALIDATION_INTERVAL_MS - 1);
  assert.equal(f.requests.length, 1);
  f.service.dispose();
});

test('API rejection inhibits periodic checks until credential context changes, including across epoch and preference changes', async () => {
  const f = fixture({ enabled: true, validate: async () => ({ status: 'invalid' }) });
  f.service.update(); await f.clock.tick(MIN_TOKEN_VALIDATION_INTERVAL_MS);
  assert.equal(f.results[0].errorCode, 'AUTH_REQUIRED');
  f.snapshot.epoch += 1; f.service.update();
  f.preferences.validateTokenPeriodically = false; f.service.update();
  f.preferences.validateTokenPeriodically = true; f.service.update();
  f.service.suspend(); f.service.resume();
  await f.clock.tick(MIN_TOKEN_VALIDATION_INTERVAL_MS * 3);
  assert.equal(f.requests.length, 1);
  f.setAuthGeneration(2); f.service.update();
  await f.clock.tick(MIN_TOKEN_VALIDATION_INTERVAL_MS);
  assert.equal(f.requests.length, 2);
  f.setCookie('SCOW_USER=replaced'); f.service.update();
  await f.clock.tick(MIN_TOKEN_VALIDATION_INTERVAL_MS);
  assert.equal(f.requests.length, 3);
  f.service.dispose();
});

test('network errors retain credential eligibility and continue periodic validation', async () => {
  const f = fixture({ enabled: true, validate: async () => ({ status: 'network_error', errorCode: 'PORTAL_TIMEOUT' }) });
  f.service.update(); await f.clock.tick(MIN_TOKEN_VALIDATION_INTERVAL_MS * 2);
  assert.equal(f.requests.length, 2);
  assert.equal(f.results[0].errorCode, 'PORTAL_TIMEOUT');
  assert.equal(f.snapshot.cookieValid, true);
  f.service.dispose();
});

test('scope, auth, cookie, preference, suspend and shutdown changes abort stale results', async () => {
  for (const change of [
    f => { f.snapshot.profileId = 'second'; },
    f => { f.snapshot.epoch += 1; },
    f => { f.setAuthGeneration(2); },
    f => { f.setCookie('SCOW_USER=other'); },
    f => { f.preferences.validateTokenPeriodically = false; },
    f => { f.service.suspend(); },
    f => { f.service.dispose(); },
  ]) {
    let finish;
    const f = fixture({ enabled: true, validate: () => new Promise(resolve => { finish = resolve; }) });
    f.service.update(); await f.clock.tick(MIN_TOKEN_VALIDATION_INTERVAL_MS);
    change(f); f.service.update();
    assert.equal(f.requests[0].signal.aborted, true);
    finish({ status: 'invalid' }); await flush();
    assert.equal(f.results.length, 0);
    f.service.dispose(); assert.equal(f.timers.size, 0);
  }
});

test('exclusive login, key and update operations suppress polling and rearm only after becoming idle', async () => {
  for (const operation of ['logging_in', 'changing_keys', 'preparing_update']) {
    const f = fixture({ enabled: true });
    f.snapshot.operation = operation; f.service.update();
    await f.clock.tick(MIN_TOKEN_VALIDATION_INTERVAL_MS * 2);
    assert.equal(f.requests.length, 0);
    f.snapshot.operation = null; f.service.update();
    await f.clock.tick(MIN_TOKEN_VALIDATION_INTERVAL_MS - 1);
    assert.equal(f.requests.length, 0);
    await f.clock.tick(1);
    assert.equal(f.requests.length, 1);
    f.service.dispose();
  }
});

test('starting an exclusive operation aborts in-flight validation without a stale auth prompt', async () => {
  let finish;
  const f = fixture({ enabled: true, validate: () => new Promise(resolve => { finish = resolve; }) });
  f.service.update(); await f.clock.tick(MIN_TOKEN_VALIDATION_INTERVAL_MS);
  f.snapshot.operation = 'logging_in'; f.service.update();
  assert.equal(f.requests[0].signal.aborted, true);
  finish({ status: 'invalid' }); await flush();
  assert.equal(f.results.length, 0);
  assert.equal(f.timers.size, 0);
  f.snapshot.operation = null; f.service.update();
  await f.clock.tick(MIN_TOKEN_VALIDATION_INTERVAL_MS);
  assert.equal(f.requests.length, 2);
  f.service.dispose();
});
