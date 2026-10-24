'use strict';

const v = require('../remote-session/validation');

// Deployed v1.9.11 consumes a nested desktop union, not the public flat mock.
function createDesktopApi({ client }) {
  return {
    async listDesktops(cluster, options = {}) {
      const value = await client.json('/api/desktop/listDesktops', { ...options, query: { cluster: v.segment(cluster) } });
      let count = 0;
      return v.array(value?.userDesktops).flatMap(group => {
        const loginNode = v.host(group?.host);
        return v.array(group?.desktops).map(desktop => {
          if (++count > 2000) throw v.invalid();
          v.record(desktop);
          if (desktop.type !== 'vnc') return { kind: 'unsupported', name: '', loginNode };
          const info = v.record(desktop.vnc);
          return { kind: 'desktop', loginNode, displayId: v.integer(info.displayId),
            name: v.text(info.desktopName, 256), wm: v.text(info.wm, 128),
            createTime: v.text(info.createTime, 128, true) };
        });
      });
    },
    async launchDesktop({ cluster, loginNode, displayId }, options = {}) {
      v.segment(cluster); v.host(loginNode); v.integer(displayId);
      const value = await client.json('/api/desktop/launchDesktop', { ...options, method: 'POST',
        body: { cluster, loginNode, displayId, desktopInfo: { desktop: { $case: 'vnc', vnc: { displayId } } } } });
      // No flat-response fallback: that is a different public API contract.
      return v.connection(value?.vnc);
    },
  };
}

module.exports = { createDesktopApi };
