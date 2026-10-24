'use strict';

const crypto = require('node:crypto');
const { Client } = require('ssh2');

const REMOTE_COMMAND_TIMEOUT_MS = 15000;
const MAX_PROBE_OUTPUT_BYTES = 4096;
const failure = (code) => Object.assign(new Error(code), { code });

// A fresh nonce proves command execution rather than an SSH login or banner.
// No command, key, or remote output escapes this resource-owning probe.
function probeRemoteCommand({ config, identity, hostFingerprint, signal,
  command, createSshClient = () => new Client(), setTimeout: setTimer = setTimeout,
  clearTimeout: clearTimer = clearTimeout, timeoutMs = REMOTE_COMMAND_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let client;
    let channel;
    let timer;
    let outputBytes = 0;
    let stdoutBytes = 0;
    let exitCode = null;
    let exitSignal = null;
    const listeners = [];
    const expected = Buffer.from(command === 'true' ? '' : crypto.randomBytes(24).toString('hex'));
    const abort = () => finish(failure(typeof signal.reason === 'string' ? signal.reason : 'CANCELLED'));
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      signal?.removeEventListener('abort', abort);
      for (const [resource, event, handler] of listeners) resource.removeListener(event, handler);
      channel?.stderr?.on('error', () => {});
      for (const resource of [channel, client]) {
        resource?.on('error', () => {});
        try { resource?.destroy(); } catch (_) {}
      }
      if (error) reject(error); else resolve('REMOTE_COMMAND_OK');
    };
    const listen = (resource, event, handler) => {
      resource.on(event, handler);
      listeners.push([resource, event, handler]);
    };
    const receive = (chunk, stdout) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > MAX_PROBE_OUTPUT_BYTES) return finish(failure('REMOTE_COMMAND_FAILED'));
      if (!stdout) return;
      if (stdoutBytes + bytes.length > expected.length
          || !bytes.equals(expected.subarray(stdoutBytes, stdoutBytes + bytes.length))) {
        return finish(failure('REMOTE_COMMAND_FAILED'));
      }
      stdoutBytes += bytes.length;
    };
    if (signal?.aborted) return abort();
    if (command !== undefined && command !== 'true') return finish(failure('REMOTE_COMMAND_FAILED'));
    if (!identity?.privateKey || typeof hostFingerprint !== 'string' || !hostFingerprint.startsWith('SHA256:')) {
      return finish(failure('REMOTE_COMMAND_FAILED'));
    }
    signal?.addEventListener('abort', abort, { once: true });
    const limit = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 30000) : REMOTE_COMMAND_TIMEOUT_MS;
    timer = setTimer(() => finish(failure('TIMEOUT')), limit);
    if (settled) return;
    try {
      client = createSshClient();
      if (settled) { client.on('error', () => {}); client.destroy(); return; }
      listen(client, 'error', () => finish(failure('REMOTE_COMMAND_FAILED')));
      listen(client, 'close', () => finish(failure('REMOTE_COMMAND_FAILED')));
      listen(client, 'ready', () => {
        if (settled) return;
        client.exec(command === 'true' ? 'true' : `printf '%s' '${expected.toString('ascii')}'`, (error, stream) => {
          if (settled) { stream?.on('error', () => {}); stream?.destroy(); return; }
          if (error || !stream) return finish(failure('REMOTE_COMMAND_FAILED'));
          channel = stream;
          listen(channel, 'error', () => finish(failure('REMOTE_COMMAND_FAILED')));
          listen(channel, 'data', (chunk) => receive(chunk, true));
          if (channel.stderr) {
            listen(channel.stderr, 'data', (chunk) => receive(chunk, false));
            listen(channel.stderr, 'error', () => finish(failure('REMOTE_COMMAND_FAILED')));
          }
          listen(channel, 'exit', (code, remoteSignal) => { exitCode = code; exitSignal = remoteSignal; });
          listen(channel, 'close', (code, remoteSignal) => {
            const resultCode = exitCode ?? code;
            if (resultCode !== 0 || exitSignal || remoteSignal || stdoutBytes !== expected.length) {
              return finish(failure('REMOTE_COMMAND_FAILED'));
            }
            finish();
          });
          channel.end();
        });
      });
      const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host;
      client.connect({ host, port: config.port, username: 'user', privateKey: identity.privateKey,
        readyTimeout: limit,
        hostVerifier: (wire) => `SHA256:${crypto.createHash('sha256').update(wire).digest('base64').replace(/=+$/, '')}` === hostFingerprint,
      });
    } catch (_) { finish(failure('REMOTE_COMMAND_FAILED')); }
  });
}

module.exports = { probeRemoteCommand, REMOTE_COMMAND_TIMEOUT_MS };
