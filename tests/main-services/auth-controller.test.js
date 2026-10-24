'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAuthStateController } = require('../../electron/auth-state');
const { CredentialStore } = require('../../electron/credential-store');

function fixture() {
  const state = { loginStatus: 'success', cookieValid: true, cookieCount: 1 };
  const changes = [];
  const errors = [];
  let captured = 'SCOW_USER=fixture';
  let clears = 0;
  const controller = createAuthStateController({ state,
    invalidateQueries: () => changes.push('invalidate'),
    setCapturedCookie: (value) => { captured = value; },
    clearStoredCookie: () => { clears += 1; throw new Error('persist failed'); },
    publish: (value) => changes.push(value), onClearError: (error) => errors.push(error),
  });
  return { state, controller, changes, errors, captured: () => captured, clears: () => clears };
}

test('runtime deactivation invalidates query authority without deleting the saved cookie', () => {
  const f = fixture();
  f.controller.deactivate();
  assert.equal(f.controller.canStartProxy(), false);
  assert.equal(f.captured(), '');
  assert.equal(f.clears(), 0);
  assert.deepEqual(f.changes, ['invalidate', { loginStatus: 'idle', loginStage: null, cookieValid: false, cookieCount: 0 }]);
});

test('persistence failure cannot leave revoked memory authorized', () => {
  const f = fixture();
  f.controller.invalidate();
  assert.equal(f.controller.canStartProxy(), false);
  assert.equal(f.captured(), '');
  assert.equal(f.clears(), 1);
  assert.equal(f.errors.length, 1);
  assert.equal(f.state.loginStatus, 'failure');
  assert.throws(() => f.controller.deactivate('success'), TypeError);
  assert.throws(() => f.controller.invalidate('unknown'), TypeError);
  assert.throws(() => createAuthStateController({}), TypeError);
});

test('CredentialStore cannot resurrect an old encrypted cookie after a failed revocation write', () => {
  let fail = false;
  let secrets = { ssoUsername: '', ssoPassword: '', savedCookieEncrypted: '' };
  const store = new CredentialStore({ profileId: 'default', readSecrets: () => secrets, userDataPath: '/fixture',
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret',
      encryptString: (value) => Buffer.from(value), decryptString: (value) => value.toString() },
    commitSecrets: (patch) => {
      if (fail) return { state: 'not_committed', durable: false, errorCode: 'SETTINGS_WRITE_FAILED' };
      secrets = { ...secrets, ...patch };
      return { state: 'committed', durable: true };
    },
  });
  store.saveCookie('SCOW_USER=fixture');
  assert.equal(store.getCookie(), 'SCOW_USER=fixture');
  fail = true;
  assert.throws(() => store.clearCookie(), { code: 'SETTINGS_WRITE_FAILED' });
  assert.equal(store.ephemeralCookie, '');
  assert.equal(store.getCookie(), '');
  assert.equal(Buffer.from(secrets.savedCookieEncrypted, 'base64').toString(), 'SCOW_USER=fixture');
  fail = false;
  store.saveCookie('SCOW_USER=new');
  assert.equal(store.getCookie(), 'SCOW_USER=new');
});

test('new controller failure codes survive strict IPC envelopes without arbitrary messages', async () => {
  const { ServiceError, createTrustedHandler } = require('../../electron/ipc-contract');
  for (const code of ['PROFILE_CHANGED', 'DRAFT_CHANGED', 'OPERATION_CANCELLED',
    'LOGIN_RESET_FAILED', 'AUTH_PERSIST_FAILED', 'SSH_KEY_INVALID', 'KEY_TRANSACTION_FAILED',
    'SETTINGS_LOCKED', 'SETTINGS_DURABILITY_UNCERTAIN', 'SETTINGS_COMMIT_UNKNOWN',
    'SETTINGS_RECOVERY_REQUIRED', 'PROFILE_LIMIT', 'PROFILE_LAST', 'PROFILE_NOT_FOUND',
    'PROFILE_ALIAS_CONFLICT', 'PROFILE_NAME_INVALID', 'SSH_KEY_MISSING', 'SSH_KEY_FINGERPRINT_MISMATCH']) {
    const handler = createTrustedHandler(() => {}, () => { throw new ServiceError(code); }, () => {});
    assert.deepEqual(await handler({}), { ok: false, error: { code } });
  }
});
