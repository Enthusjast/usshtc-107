'use strict';

const { createPortalApiClient, extractScowToken } = require('./portal-api/client');
const { createAuthApi } = require('./portal-api/auth-api');

const operationalCode = (code) => ['PORTAL_NETWORK', 'PORTAL_TIMEOUT', 'PORTAL_PERMISSION',
  'PORTAL_NOT_FOUND', 'PORTAL_UNIMPLEMENTED', 'PORTAL_QUOTA', 'PORTAL_UNKNOWN',
  'OPERATION_CANCELLED'].includes(code) ? code : 'PORTAL_NETWORK';
const failure = (code) => Object.assign(new Error(code), { code });

// A call owns its HTTP client. No successful setup receipt survives a proxy lifecycle.
function createPortalPreflight({ createClient = createPortalApiClient, createApi = createAuthApi,
  baseUrl, allowedHosts, tlsCa, request } = {}) {
  async function call(context, execute) {
    const { cookie, signal, scope, authGeneration, assertCurrent } = context;
    const assertFresh = () => {
      if (signal?.aborted) throw failure('OPERATION_CANCELLED');
      assertCurrent?.();
    };
    assertFresh();
    const client = createClient({ baseUrl, allowedHosts, tlsCa, request, cookie });
    try {
      const result = await execute(createApi({ client }), {
        signal, scope: { ...scope, authGeneration }, assertCurrent: assertFresh,
      });
      assertFresh();
      return result;
    } finally { client.dispose(); }
  }
  const validate = async (context) => {
    let token;
    try { token = extractScowToken(context.cookie); } catch (_) { return { status: 'invalid', errorCode: 'AUTH_REQUIRED' }; }
    if (!token) return { status: 'invalid', errorCode: 'AUTH_REQUIRED' };
    try { return await call(context, (api, options) => api.validateToken(token, options)); }
    catch (error) { return { status: 'network_error', errorCode: operationalCode(error?.code) }; }
  };
  const setup = async (context) => {
    try { return await call(context, (api, options) => api.setup({ ...options, timeoutMs: 4000 })); }
    catch (error) { return { ok: false, errorCode: error?.code === 'OPERATION_CANCELLED'
      ? 'OPERATION_CANCELLED' : error?.code === 'PORTAL_TIMEOUT' ? 'PORTAL_TIMEOUT' : 'PORTAL_NETWORK' }; }
  };
  return {
    validate,
    setup,
    async run(context) {
      const token = await validate(context);
      if (token.status === 'invalid') throw failure('AUTH_REQUIRED');
      if (token.status !== 'valid') throw failure(operationalCode(token.errorCode));
      const result = await setup(context);
      if (!result.ok) throw failure(result.errorCode === 'OPERATION_CANCELLED'
        ? 'OPERATION_CANCELLED' : result.errorCode === 'PORTAL_TIMEOUT' ? 'PORTAL_TIMEOUT' : 'PORTAL_NETWORK');
      return { ok: true };
    },
  };
}

module.exports = { createPortalPreflight, operationalCode };
