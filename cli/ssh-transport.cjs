'use strict';

const crypto = require('node:crypto');
const { Client, utils } = require('ssh2');
const OUTPUT_LIMIT = 2 * 1024 * 1024;
// SSH channel requests cannot be fragmented like channel data packets.
const COMMAND_LIMIT = 32 * 1024;
function failure(code) { return Object.assign(new Error(code), { code }); }
function connectTransport({ host, port, identity, hostKey, signal, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const parsed = utils.parseKey(hostKey);
    if (parsed instanceof Error || !parsed?.getPublicSSH) return reject(failure('CLI_SSH'));
    const expected = parsed.getPublicSSH();
    let settled = false;
    let closed = false;
    const pending = new Set();
    const timer = setTimeout(() => fail(failure('CLI_TIMEOUT')), timeoutMs);
    function fail(error) {
      if (!settled) { settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); }
      closed = true;
      for (const cancel of pending) cancel(error);
      client.destroy();
    }
    function abort() { fail(failure('CLI_ABORTED')); }
    signal?.addEventListener('abort', abort, { once: true });
    client.on('error', () => fail(failure('CLI_SSH')));
    client.on('close', () => {
      closed = true;
      for (const cancel of pending) cancel(failure('CLI_SSH'));
      signal?.removeEventListener('abort', abort);
      if (!settled) fail(failure('CLI_SSH'));
    });
    client.once('ready', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.setNoDelay(true);
      resolve({
        exec(command, { signal: commandSignal, timeoutMs: commandTimeout = 60000 } = {}) {
          return new Promise((resolveCommand, rejectCommand) => {
            if (closed || commandSignal?.aborted) return rejectCommand(failure(commandSignal?.aborted ? 'CLI_ABORTED' : 'CLI_SSH'));
            if (typeof command !== 'string' || command.includes('\0') || Buffer.byteLength(command) > COMMAND_LIMIT) {
              return rejectCommand(failure('CLI_INPUT_LIMIT'));
            }
            let channel;
            let done = false;
            let bytes = 0;
            let code = null;
            const chunks = [];
            const commandTimer = setTimeout(() => finish(failure('CLI_TIMEOUT')), commandTimeout);
            const cancel = () => finish(failure('CLI_ABORTED'));
            function finish(error) {
              if (done) return;
              done = true;
              clearTimeout(commandTimer);
              commandSignal?.removeEventListener('abort', cancel);
              pending.delete(finish);
              if (error) { channel?.destroy(); rejectCommand(error); }
              else resolveCommand(Buffer.concat(chunks, bytes));
            }
            pending.add(finish);
            commandSignal?.addEventListener('abort', cancel, { once: true });
            client.exec(command, (error, stream) => {
              if (error) return finish(failure('CLI_SSH'));
              channel = stream;
              if (done) { stream.destroy(); return; }
              const consume = chunk => {
                bytes += chunk.length;
                if (bytes > OUTPUT_LIMIT) return finish(failure('CLI_OUTPUT_LIMIT'));
                chunks.push(Buffer.from(chunk));
              };
              stream.on('data', consume);
              stream.stderr.on('data', consume);
              stream.once('error', () => finish(failure('CLI_SSH')));
              stream.once('exit', status => { code = status; });
              stream.once('close', () => finish(code === 0 ? null : failure('CLI_REMOTE')));
              // Proxy exec deliberately does not support stdin. All data is in bounded commands.
              stream.end();
            });
          });
        },
        close() { closed = true; client.end(); },
      });
    });
    if (signal?.aborted) return abort();
    try {
      client.connect({ host, port, username: 'user', privateKey: identity.privateKey,
        readyTimeout: timeoutMs, tryKeyboard: false,
        hostVerifier: key => key.length === expected.length && crypto.timingSafeEqual(key, expected),
      });
    } catch { fail(failure('CLI_SSH')); }
  });
}
module.exports = { connectTransport, OUTPUT_LIMIT, COMMAND_LIMIT };
