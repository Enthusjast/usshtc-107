'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ServiceError, createTrustedHandler } = require('../../electron/ipc-contract');

test('untrusted senders never run the action or receive internal exception text', async () => {
  let ran = false;
  const logs = [];
  const handler = createTrustedHandler(() => { throw new Error('untrusted sender detail'); }, () => { ran = true; }, value => logs.push(value));
  assert.deepEqual(await handler({}), { ok: false, error: { code: 'INTERNAL_ERROR' } });
  assert.equal(ran, false);
  assert.equal(logs.length, 1);
});

test('validation preserves safe field errors and cancellation is a successful result', async () => {
  const reject = createTrustedHandler(() => {}, () => { throw new ServiceError('VALIDATION_FAILED', { host: 'invalid_host' }); }, () => {});
  assert.deepEqual(await reject({}), { ok: false, error: { code: 'VALIDATION_FAILED', fieldErrors: { host: 'invalid_host' } } });
  const cancel = createTrustedHandler(() => {}, async () => ({ cancelled: true }), () => {});
  assert.deepEqual(await cancel({}), { ok: true, value: { cancelled: true } });
});

test('unknown exceptions only expose INTERNAL_ERROR and main logs redact credentials', async () => {
  const logs = [];
  const handler = createTrustedHandler(() => {}, () => { throw new Error('Cookie: session=secret-value'); }, value => logs.push(value));
  assert.deepEqual(await handler({}), { ok: false, error: { code: 'INTERNAL_ERROR' } });
  assert.equal(logs.some(value => value.includes('secret-value')), false);
});
