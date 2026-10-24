# Opt-in portal acceptance tests

These tests contact the real portal and open remote login sessions. They are **not part of default CI** and must not be used to stress a shared cluster. Smoke tests use read-only commands; they do not create remote files, install tools, or change account settings. Each invocation generates an isolated local client identity and host key, listens on loopback port `0`, pins that exact host key with `ssh2`, and removes its local keys and connections during cleanup. It never reads or changes your SSH configuration, normal keys, or known-hosts file.

## Credentials and execution

Install the repository dependencies first. Use the Node version required by the root package. Run commands below from the repository root.

Every live test skips unless **both** `LIVE_SMOKE=1` and a nonempty `SCOW_TOKEN` are present. `SCOW_TOKEN` is only the value of the `SCOW_USER` cookie, not a complete `Cookie:` header. Use a short-lived token from an authorized account. Do not put credentials in a command argument, source file, checked-in environment file, CI output, or shell history. For example, in Bash:

```sh
read -r -s -p 'Short-lived SCOW_USER value: ' SCOW_TOKEN; printf '\n'
export SCOW_TOKEN
LIVE_SMOKE=1 node --test --test-concurrency=1 tests/live/exec.live.cjs tests/live/interactive.live.cjs tests/live/auth.live.cjs
unset SCOW_TOKEN
```

`SCOW_CLUSTER` and `SCOW_LOGIN_NODE` optionally override the shared settings schema's defaults. The tests do not hard-code a cluster or login-node address. The portal URL and trusted public TLS roots remain the application's normal defaults. TLS verification is never disabled. Do not use `NODE_TLS_REJECT_UNAUTHORIZED=0` or attach SSH/WebSocket debug logging when credentials are available.

The default backend is the directly constructed `ProxyServer` used by the desktop application. Set `LIVE_BACKEND=cli` to run the identical tests through the headless CLI's `startService`, including its generated identity, bound address, and shutdown lifecycle:

```sh
LIVE_SMOKE=1 LIVE_BACKEND=cli node --test --test-concurrency=1 tests/live/exec.live.cjs tests/live/interactive.live.cjs tests/live/auth.live.cjs
```

The CLI backend also uses isolated temporary service/key directories and loopback port `0`. It does not attach to or alter an existing user service. `LIVE_BACKEND=proxy` selects the default explicitly; other values fail safely. The local fault-injection suite always selects the direct backend, independently of this environment setting.

To check default skipping without contacting the portal:

```sh
node --test tests/live/*.live.cjs
```

Remove `LIVE_SMOKE` or `SCOW_TOKEN` from the environment before that command if previously exported. An optional `SCOW_EXPIRED_TOKEN` enables a separate expired-credential test; without it, that one test explicitly skips. Treat it with the same secrecy as the current token.

## Coverage and failure semantics

- **Exec:** validates hostname, account and absolute working directory internally, checks exit code `3`, exact Unicode/whitespace bytes, all 20,000 numbered output lines, and explicit rejection of nonempty SSH stdin. No remote identity or output is printed, including on assertion failure.
- **Interactive:** requests a real SSH PTY, queues input before the portal readiness event, checks `setWindow(40, 100)` through remote `stty size`, verifies Unicode output generated from ASCII-only input, and checks an immediate marker command's output survives input EOF followed by bounded local closure. EOF closure is not evidence of a portal exit frame or remote exit status, and this case makes no guarantee for arbitrarily slow piped commands.
- **Logout:** observes a standalone `logout` line and checks the channel remains open for a bounded 2.5-second observation. It then explicitly closes the local channel. This documents the portal's current lack of an exit frame; it does not infer an exit from arbitrary matching output or wait forever.
- **Authentication:** a random invalid token, and optionally an expired token, must fail rather than report readiness. A silent upgraded WSS session must produce `REMOTE_READY_TIMEOUT`, exit `255`, stderr beginning with the stable `REMOTE_READY_TIMEOUT:` code, and session reason `remote_not_ready`. It must **not** emit `auth-error` or invalidate the credential. Only observed HTTP `401`/`403` may classify the failure as authentication. The 10-second readiness timer starts after WSS upgrade; the test allows additional bounded local/handshake overhead.

Readiness is the `remote-ready` event, emitted only after a valid JSON `{$case: 'data', data: {data: string}}` message; an empty string counts. Prompt formatting and arbitrary sleeps are not used as readiness signals. The bounded logout observation is intentionally different: it measures the absence of closure after observed output.

Test failures expose fixed diagnostic identifiers, not commands, tokens, remote output, user names, host names or directories. Do not replace these checks with assertions that render actual buffers/strings. Do not enable diagnostic dumps containing process environments or raw proxy events. The suite records no credential files and never automatically replays failed exec operations.

## Manual concurrency observations

Concurrency is a separate opt-in and must never be added to default CI. Run only with the cluster operator's permission, preferably when the cluster is idle:

```sh
# Supply SCOW_TOKEN securely as above first.
LIVE_SMOKE=1 LIVE_CONCURRENCY=1 node --test --test-concurrency=1 tests/live/concurrency.live.cjs
```

The test performs exactly three rounds at each concurrency level `2`, `4`, and `8`, using only `hostname`: 42 remote invocations total, without retries. For each round and each level it reports attempted/successful/failed counts, observed success rate, p50/p95/maximum elapsed milliseconds, and fixed error-category counts. Durations include local SSH setup and remote execution. Neither command output nor identities are printed. Success is determined internally from exit status and a nonempty hostname-shaped response; the test does not assume 100% success. A passing observation test means the measurements completed, **not** that every remote invocation succeeded. Review the reported failure counts before accepting a release. Increasing failures may indicate portal or sshd limits; investigate those limits instead of adding command retries.

## Local TLS/WSS fault injection

The independent integration suite does not need a token and makes no external connections:

```sh
node --test tests/integration/remote-ready.test.js
```

It uses the existing public loopback-only certificate as an explicitly trusted CA, actual TLS/WSS sockets, real local SSH authentication, generated isolated identities, and ephemeral loopback ports. It injects silence, malformed/irrelevant frames, delayed empty readiness frames, and a first frame after the readiness deadline. Ping/pong provides an event barrier before releasing delayed frames. Assertions cover both exec bootstrap and interactive input: no data may be transmitted before valid readiness, timeout must not be mislabeled as authentication, and late data must not resurrect/replay a closed channel. All peers, listeners, SSH clients, channels and temporary keys are closed or removed at teardown.

The live suite is deliberately a portal acceptance layer, not a substitute for CLI argument/configuration, transfer, tmux, health, or ordinary fixture/unit suites. Keep those suites in release verification as well.
