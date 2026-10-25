#!/usr/bin/env node
'use strict';

const { parseArgs, loadConfig } = require('./config.cjs');
const { startService } = require('./service.cjs');
const { transferFile } = require('./transfers.cjs');

const HELP = `Usage: usshtc107 [serve] [options]
       usshtc107 get [options] -- REMOTE LOCAL
       usshtc107 put [options] -- LOCAL REMOTE

serve starts the headless proxy; get/put use the official portal HTTP file API directly.
Options:
  --cookie VALUE       Cookie header or SCOW_USER token (visible in process argv)
  --port NUMBER        Local SSH port (default 3000)
  --host HOST          Bind/connect host (default 127.0.0.1)
  --cluster NAME       Remote cluster
  --login-node HOST    Remote login node
  --path DIRECTORY     Remote shell starting directory
  --startup-command CMD  Optional canonical command: tmux new -A -s usshtc
  --health-probe BOOL  Enable read-only periodic true probes (default false)
  --validate-token-periodically BOOL  Opt-in token checks, at least five minutes apart
  --scp-max-file-bytes NUMBER  Legacy SCP cap, default/maximum 1073741824 (1 GiB)
  --scp-no-overwrite BOOL  Legacy SCP remote preflight protection (default false)
  --config FILE        Strict JSON configuration; unknown keys are rejected
  --data-dir DIR       Stable proxy host-key directory
  --ssh-directory DIR  Stable client identity directory (default ~/.ssh)
  --max-bytes NUMBER   Transfer cap, default/maximum 67108864 (64 MiB)
  --timeout-ms NUMBER  Total transfer deadline, default 600000 (10 minutes)
  --overwrite          Explicitly allow replacement of an existing regular file
  --help               Show this help
  --version            Show package version

Use SCOW_TOKEN instead of --cookie to avoid process-argument visibility.
Config keys: port, host, cluster, loginNode, path, startupCommand,
healthProbeEnabled, validateTokenPeriodically, scpMaxFileBytes, scpNoOverwrite,
dataDir, sshDirectory, maxBytes, timeoutMs. Config never stores credentials.
GUI Files and CLI get/put retain their separate 64 MiB cap and reject existing
targets unless --overwrite is set. Legacy SCP overwrites remote files by default;
scpNoOverwrite is a non-atomic preflight, not a remote symlink sandbox.
Remote paths must be absolute. Remote overwrite protection is a fileExist
preflight, not atomic: a concurrent creator may race the final publish.
Directories and directory archives are not transferred. Remote temporary files
may remain after interruption; no unverified remote cleanup is attempted.
`;
const MESSAGES = Object.freeze({
  CLI_USAGE: 'Invalid arguments. Use --help for usage.',
  CLI_CONFIG: 'Invalid or unreadable CLI configuration.',
  CLI_COOKIE_REQUIRED: 'A cookie is required; set SCOW_TOKEN.',
  CLI_ABORTED: 'Operation interrupted.',
  CLI_TIMEOUT: 'Operation exceeded its deadline.',
  AUTH_REQUIRED: 'Portal verification was rejected; verify sign-in. Stored credentials were not deleted.',
  PORTAL_AUTH: 'Portal authentication is required; verify sign-in. Stored credentials were not deleted.',
  PORTAL_NETWORK: 'Portal connection failed.',
  PORTAL_TIMEOUT: 'Portal operation exceeded its deadline.',
  PORTAL_PERMISSION: 'The portal denied permission for this operation.',
  PORTAL_NOT_FOUND: 'The remote file was not found.',
  PORTAL_UNIMPLEMENTED: 'The portal does not support this operation.',
  PORTAL_QUOTA: 'The portal reported a storage or request quota limit.',
  PORTAL_UNKNOWN: 'The portal operation failed.',
  PORTAL_CANCELLED: 'Operation interrupted.',
  TRANSFER_PATH: 'Invalid transfer path.',
  TRANSFER_LIMIT: 'Transfer exceeds its configured resource limit.',
  TRANSFER_EXISTS: 'Destination already exists; nothing was overwritten.',
  TRANSFER_CHANGED: 'Source changed during transfer; no destination was published.',
  TRANSFER_METADATA: 'Remote file metadata is invalid or exceeds the transfer limit.',
  TRANSFER_HASH: 'File integrity verification failed; no destination was published.',
  TRANSFER_IO: 'Local file operation failed.',
  TRANSFER_DIRECTORY: 'Only regular files are supported; directories are never replaced.',
  TRANSFER_UNSAFE_TYPE: 'Remote links, special files and unverified file types are refused. Choose a regular file path.',
  TRANSFER_TEMP_CONFLICT: 'The portal returned existing temporary chunks; no chunks were reused or replaced.',
});
async function run(argv = process.argv.slice(2), dependencies = {}) {
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  const signals = dependencies.signals || process;
  const env = dependencies.env || process.env;
  const controller = new AbortController();
  const abort = () => controller.abort();
  let service;
  let lastProgress = '';
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
      service = await (dependencies.startService || startService)({ ...options, signal: controller.signal });
      service.proxy.on('remote-not-ready', () => stderr.write('REMOTE_READY_TIMEOUT: remote shell readiness was not established; credentials were not invalidated.\n'));
      service.proxy.on('auth-error', () => stderr.write('Authentication rejected by HTTP 401/403; replace the cookie.\n'));
      service.proxy.on('health-state', state => {
        if (state.remoteStatus === 'reachable') stdout.write('Health probe: remote command succeeded.\n');
        else if (state.remoteStatus === 'error') stderr.write('Health probe: remote availability was not established.\n');
      });
      service.proxy.on('token-state', state => {
        if (state.status === 'invalid') stderr.write('Token verification was rejected; verify sign-in. Saved credentials were not deleted.\n');
        else if (state.status === 'network_error') stderr.write('Token verification could not reach the portal; credentials were not invalidated.\n');
        else if (state.status === 'valid') stdout.write('Token verification accepted.\n');
      });
      stdout.write('Local SSH proxy started.\n');
      if (!controller.signal.aborted) await new Promise(resolve => controller.signal.addEventListener('abort', resolve, { once: true }));
      return 0;
    }
    const [first, second] = parsed.operands;
    const result = await transferFile({ ...options, signal: controller.signal,
      direction: parsed.command === 'put' ? 'upload' : 'download',
      localPath: parsed.command === 'put' ? first : second,
      remotePath: parsed.command === 'put' ? second : first,
      onProgress(progress) {
        const percent = progress.total ? Math.floor(progress.bytes * 100 / progress.total) : 0;
        const key = `${progress.mode}:${progress.phase}:${percent}`;
        if (key !== lastProgress) {
          lastProgress = key;
          stderr.write(`Transfer ${progress.mode}: ${progress.phase} ${progress.bytes}/${progress.total} bytes.\n`);
        }
      },
    }, dependencies);
    stdout.write(`Transfer complete (${result.mode}); SHA-256 verified.\n`);
    if (result.remoteTempsRetained) stderr.write('Remote temporary files may remain; no cleanup was attempted.\n');
    return 0;
  } catch (error) {
    const message = typeof error?.code === 'string' && Object.hasOwn(MESSAGES, error.code)
      ? MESSAGES[error.code] : 'Operation failed; no sensitive diagnostic details were printed.';
    stderr.write(`${message}\n`);
    if (error?.remoteTempsRetained === true) stderr.write('Remote temporary files may remain; no cleanup was attempted.\n');
    return controller.signal.aborted ? 130 : 1;
  } finally {
    if (registered) { signals.removeListener('SIGINT', abort); signals.removeListener('SIGTERM', abort); }
    // The API transfer owns and disposes its client independently of serve.
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
