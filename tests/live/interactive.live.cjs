'use strict';

const { liveTest, harness, check, event, nonce } = require('./helpers.cjs');

// Split the marker across printf arguments so terminal command echo cannot satisfy
// the output assertion. No fixed delay stands in for the first valid data event.
function markerCommand(marker) {
  return `printf '\\n%s%s\\n' '${marker.slice(0, 16)}' '${marker.slice(16)}'`;
}

liveTest('live interactive queues early input until first data readiness', async (t) => {
  const f = await harness(t);
  const client = await f.connect();
  const ready = event(f.proxy, 'remote-ready');
  const terminal = await f.shell(client);
  const marker = nonce();
  terminal.channel.write(`${markerCommand(marker)}\r`);
  const proof = await ready;
  check(Boolean(proof.sessionId), 'LIVE_READY_EVENT_INVALID');
  await terminal.waitFor((value) => value.text().includes(`\r\n${marker}\r\n`) || value.text().includes(`\n${marker}\n`));
  check(!terminal.isClosed, 'LIVE_EARLY_INPUT_CHANNEL_CLOSED');
});

liveTest('live interactive PTY accepts actual resize and reports stty dimensions', async (t) => {
  const f = await harness(t);
  const client = await f.connect();
  const ready = event(f.proxy, 'remote-ready');
  const terminal = await f.shell(client, { cols: 80, rows: 24 });
  await ready;
  terminal.channel.setWindow(40, 100, 0, 0);
  const marker = nonce();
  terminal.channel.write(`stty size; ${markerCommand(marker)}\r`);
  await terminal.waitFor((value) => /(?:^|[\r\n])40 100\r?\n/.test(value.text()) && value.text().includes(`\n${marker}`));
});

liveTest('live interactive preserves Unicode terminal output', async (t) => {
  const f = await harness(t);
  const client = await f.connect();
  const ready = event(f.proxy, 'remote-ready');
  const terminal = await f.shell(client);
  await ready;
  const marker = nonce();
  const unicode = '中文🙂é';
  // The command is ASCII: echoed input cannot masquerade as Unicode output.
  const octal = [...Buffer.from(unicode)].map((byte) => `\\${byte.toString(8).padStart(3, '0')}`).join('');
  terminal.channel.write(`printf '\\n${octal}\\n'; ${markerCommand(marker)}\r`);
  await terminal.waitFor((value) => value.text().includes(`\n${marker}`));
  check(terminal.bytes().includes(Buffer.from(unicode)), 'LIVE_INTERACTIVE_UNICODE_BYTES');
  check(!terminal.text().includes('\ufffd'), 'LIVE_INTERACTIVE_UNICODE_REPLACEMENT');
});

liveTest('live interactive pipe EOF retains queued command output and closes boundedly', async (t) => {
  const f = await harness(t);
  const client = await f.connect();
  const ready = event(f.proxy, 'remote-ready');
  const terminal = await f.shell(client);
  const marker = nonce();
  terminal.channel.end(`${markerCommand(marker)}\r`);
  await ready;
  await terminal.closed(15000);
  check(terminal.text().includes(`\n${marker}\r\n`) || terminal.text().includes(`\n${marker}\n`), 'LIVE_EOF_OUTPUT_TRUNCATED');
  // Bounded local EOF closure does not prove a portal exit frame or a remote
  // shell exit status; only the marker proves this immediate command ran.
});

liveTest('live interactive logout does not imply a portal close frame', async (t) => {
  const f = await harness(t);
  const client = await f.connect();
  const ready = event(f.proxy, 'remote-ready');
  const terminal = await f.shell(client);
  await ready;
  // Avoid mistaking the shell's command echo for its logout output.
  terminal.channel.write('ex' + 'it\r');
  await terminal.waitFor((value) => /(?:^|[\r\n])logout\r?(?:\n|$)/.test(value.text()));
  await terminal.remainsOpen(2500);
  terminal.channel.close();
  await terminal.closed(5000);
});
