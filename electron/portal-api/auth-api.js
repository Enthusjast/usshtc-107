'use strict';

const { PortalApiError } = require('./client');

function createAuthApi({ client }) {
  return {
    async validateToken(token, options = {}) {
      if (typeof token !== 'string' || !token || /[\s;,"\\\u0000-\u001f\u007f]/.test(token)) {
        return { status: 'invalid', errorCode: 'AUTH_REQUIRED' };
      }
      try {
        const value = await client.json('/api/auth/validateToken', { ...options, method: 'GET',
          authenticated: false, query: { token }, expectedStatus: [200] });
        if (!value || typeof value.identityId !== 'string' || !value.identityId
            || (value.name !== undefined && typeof value.name !== 'string')) throw new PortalApiError('UNKNOWN');
        // Identity fields are unnecessary for gating and must not escape to logs/IPC.
        return { status: 'valid' };
      } catch (error) {
        if (error?.kind === 'CANCELLED') return { status: 'network_error', errorCode: 'OPERATION_CANCELLED' };
        if (error?.kind === 'AUTH') return { status: 'invalid', errorCode: 'AUTH_REQUIRED' };
        return { status: 'network_error', errorCode: error instanceof PortalApiError ? error.code : 'PORTAL_NETWORK' };
      }
    },
    async setup(options = {}) {
      try {
        const result = await client.text('/api/setup', { ...options, method: 'GET', authenticated: false,
          timeoutMs: options.timeoutMs ?? 4000, expectedStatus: [200] });
        if (!['Setup complete', 'Already setup'].includes(result.trim())) throw new PortalApiError('UNKNOWN');
        return { ok: true };
      } catch (error) {
        // This unauthenticated endpoint never supplies evidence about a cookie.
        return { ok: false, errorCode: error?.kind === 'CANCELLED' ? 'OPERATION_CANCELLED'
          : error?.kind === 'TIMEOUT' ? 'PORTAL_TIMEOUT' : 'PORTAL_NETWORK' };
      }
    },
  };
}
module.exports = { createAuthApi };
