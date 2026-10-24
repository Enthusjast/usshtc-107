#!/usr/bin/env node
'use strict';

const { parseArgs, loadConfig } = require('./config.cjs');
const { startService, loadIdentity } = require('./service.cjs');
const { connectTransport } = require('./ssh-transport.cjs');
const { upload, download } = require('./transfers.cjs');

const HELP = `Usage: usshtc107 [serve] [options]
       usshtc107 get [options] -- REMOTE LOCAL
       usshtc107 put [options] -- LOCAL REMOTE

serve starts the headless proxy; get/put connect to an already running proxy.
Options:
  --cookie VALUE       Cookie header or SCOW_USER token (visible in process argv)
  --port NUMBER        Local SSH port (default 3000)
  --host HOST          Bind/connect host (default 127.0.0.1)
  --cluster NAME       Remote cluster
  --login-node HOST    Remote login node
  --path DIRECTORY     Remote shell starting directory
  --startup-command CMD  Optional canonical command: tmux new -A -s usshtc
  --health-probe BOOL  Enable read-only periodic true probes (default false)
  --config FILE        Strict JSON configuration; unknown keys are rejected
  --data-dir DIR       Stable proxy host-key directory
  --ssh-directory DIR  Stable client identity directory (default ~/.ssh)
  --max-bytes NUMBER   Transfer cap, default/maximum 67108864 (64 MiB)
  --timeout-ms NUMBER  Total transfer deadline, default 600000 (10 minutes)
  --help               Show this help
  --version            Show package version

Use SCOW_TOKEN instead of --cookie to avoid process-argument visibility.
Config keys: port, host, cluster, loginNode, path, startupCommand,
healthProbeEnabled, dataDir, sshDirectory, maxBytes, timeoutMs. Config never
stores credentials. Transfers never overwrite targets.
Remote transfers require GNU base64, dd, stat, sha256sum, ln and rm; no SFTP/scp.
`;
const MESSAGES = Object.freeze({
  CLI_USAGE: 'Invalid arguments. Use --help for usage.',
  CLI_CONFIG: 'Invalid or unreadable CLI configuration.',
  CLI_COOKIE_REQUIRED: 'A cookie is required for serve; set SCOW_TOKEN.',
  CLI_ABORTED: 'Operation interrupted.',
  CLI_TIMEOUT: 'Operation exceeded its deadline.',
  CLI_SSH: 'Local SSH connection failed; check the running proxy, identity and pinned host key.',
  CLI_REMOTE: 'Remote operation failed; check dependencies, paths and destination conflicts.',
  CLI_OUTPUT_LIMIT: 'Remote response exceeded the bounded output limit.',
  CLI_INPUT_LIMIT: 'Remote command encoding exceeds the bounded SSH request limit.',
  TRANSFER_PATH: 'Invalid transfer path.',
  TRANSFER_LIMIT: 'Transfer exceeds its configured resource limit.',
  TRANSFER_EXISTS: 'Destination already exists; nothing was overwritten.',
  TRANSFER_CHANGED: 'Source changed during transfer; no destination was published.',
  TRANSFER_METADATA: 'Remote file metadata is invalid or exceeds the transfer limit.',
  TRANSFER_HASH: 'File integrity verification failed; no destination was published.',
  TRANSFER_ENCODING: 'Remote file encoding is invalid.',
  TRANSFER_IO: 'Local file write failed.',
});
async function run(argv = process.argv.slice(2), dependencies = {}) {
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  const signals = dependencies.signals || process;
  const env = dependencies.env || process.env;
  const controller = new AbortController();
  const abort = () => controller.abort();
  let service;
  let transport;
  let registered = false;
  try {
    const parsed = parseArgs(argv);
    if (parsed.help) { stdout.write(HELP); return 0; }
    if (parsed.version) { stdout.write(`${require('../package.json').version}\n`); return 0; }
    if (parsed.values.cookie) stderr.write('Warning: --cookie is visible in process arguments; prefer SCOW_TOKEN.\n');
    const options = await loadConfig(parsed, env);
    signals.on('SIGINT', abort);
    signals.on('SIGTERM', abort);
    registered = true;
    if (parsed.command === 'serve') {
      if (!['127.0.0.1', '::1', 'localhost'].includes(options.host)) {
        stderr.write('Warning: non-loopback SSH binding exposes this proxy to the network.\n');
      }
      service = await (dependencies.startService || startService)(options);
      service.proxy.on('remote-not-ready', () => stderr.write('REMOTE_READY_TIMEOUT: remote shell readiness was not established; credentials were not invalidated.\n'));
      service.proxy.on('auth-error', () => stderr.write('Authentication rejected by HTTP 401/403; replace the cookie.\n'));
      service.proxy.on('health-state', state => {
        if (state.remoteStatus === 'reachable') stdout.write('Health probe: remote command succeeded.\n');
        else if (state.remoteStatus === 'error') stderr.write('Health probe: remote availability was not established.\n');
      });
      stdout.write('Local SSH proxy started.\n');
      if (!controller.signal.aborted) await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
      return 0;
    }
    const deadline = Date.now() + options.timeoutMs;
    const material = (dependencies.loadIdentity || loadIdentity)(options);
    const host = options.host === '0.0.0.0' ? '127.0.0.1' : options.host === '::' ? '::1' : options.host;
    transport = await (dependencies.connectTransport || connectTransport)({
      host, port: options.port, ...material, signal: controller.signal,
      timeoutMs: Math.min(15000, options.timeoutMs),
    });
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw Object.assign(new Error('CLI_TIMEOUT'), { code: 'CLI_TIMEOUT' });
    const [first, second] = parsed.operands;
    const transfer = parsed.command === 'put' ? upload : download;
    await transfer({ ...options, timeoutMs: remainingMs, transport, signal: controller.signal,
      localPath: parsed.command === 'put' ? first : second,
      remotePath: parsed.command === 'put' ? second : first,
    });
    stdout.write('Transfer complete; SHA-256 verified.\n');
    return 0;
  } catch (error) {
    const message = typeof error?.code === 'string' && Object.hasOwn(MESSAGES, error.code)
      ? MESSAGES[error.code] : 'Operation failed; no sensitive diagnostic details were printed.';
    stderr.write(`${message}\n`);
    return controller.signal.aborted ? 130 : 1;
  } finally {
    if (registered) { signals.removeListener('SIGINT', abort); signals.removeListener('SIGTERM', abort); }
    transport?.close();
    if (service) await service.stop();
  }
}
if (require.main === module) {
  run().then(code => { process.exitCode = code; }, () => {
    process.stderr.write('CLI shutdown failed.\n');
    process.exitCode = 1;
  });
}
module.exports = { run, HELP };
