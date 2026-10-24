'use strict';

const v = require('../remote-session/validation');

function strings(value) {
  if (value == null) return {};
  const entries = Object.entries(v.record(value));
  if (entries.length > 128) throw v.invalid();
  return Object.fromEntries(entries.map(([key, item]) => [v.text(key, 256), v.text(item, 4096)]));
}
function createAppApi({ client }) {
  return {
    async getAppSessions(cluster, options = {}) {
      const value = await client.json('/api/app/getAppSessions', { ...options, query: { cluster: v.segment(cluster) } });
      return v.array(value?.sessions).map(item => ({ sessionId: v.text(item?.sessionId, 256),
        jobId: v.integer(item?.jobId), appId: v.text(item?.appId, 256),
        name: v.text(item?.appName, 256, true), state: v.text(item?.state, 128),
        runningTime: v.text(item?.runningTime, 128), submitTime: v.text(item?.submitTime, 128, true) }));
    },
    async listAvailableApps(cluster, options = {}) {
      const value = await client.json('/api/app/listAvailableApps', { ...options, query: { cluster: v.segment(cluster) } });
      return v.array(value?.apps).map(item => ({ id: v.text(item?.id, 256), name: v.text(item?.name, 256) }));
    },
    async connectToApp({ cluster, sessionId, jobId }, options = {}) {
      v.segment(cluster); v.text(sessionId, 256); v.integer(jobId);
      // The deployed v1.9.11 client includes jobId as well as sessionId.
      const value = await client.json('/api/app/connectToApp', { ...options, method: 'POST', body: { cluster, sessionId, jobId } });
      v.record(value);
      if (value.type !== 'vnc' && value.type !== 'web') return { type: 'unsupported' };
      if (value.type === 'vnc') return { type: 'vnc', ...v.connection(value) };
      const connect = v.record(value.connect);
      if (connect.method !== 'GET') return { type: 'unsupported' };
      if (!['relative', 'absolute'].includes(value.proxyType)) throw v.invalid();
      return { type: 'web', ...v.connection(value), proxyType: value.proxyType,
        connect: { method: 'GET', path: v.text(connect.path, 8192), query: strings(connect.query) },
        customFormData: strings(value.customFormData) };
    },
  };
}

module.exports = { createAppApi };
