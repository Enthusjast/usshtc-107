'use strict';

const { createPortalApiClient } = require('../electron/portal-api/client');
const { createFileApi } = require('../electron/portal-api/file-api');
const { upload, download } = require('../electron/file-transfer/orchestrator');

// CLI transfers authenticate directly to the portal. No local SSH service, key,
// remote shell utility, or alternate transport participates in this lifecycle.
async function transferFile(options, dependencies = {}) {
  const client = (dependencies.createPortalApiClient || createPortalApiClient)({ cookie: options.cookie });
  try {
    const api = createFileApi({ client });
    return await (options.direction === 'upload' ? upload : download)({ ...options, api });
  } finally { client.dispose(); }
}
module.exports = { transferFile };
