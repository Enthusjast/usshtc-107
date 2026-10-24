'use strict';

const { liveTest, harness, check, quantile } = require('./helpers.cjs');

liveTest('live manual hostname concurrency observations', {
  timeout: 600000,
  skip: process.env.LIVE_CONCURRENCY === '1' ? false : 'Manual load requires LIVE_CONCURRENCY=1',
}, async (t) => {
  const f = await harness(t);
  for (const width of [2, 4, 8]) {
    const totals = [];
    for (let round = 1; round <= 3; round += 1) {
      const results = await Promise.all(Array.from({ length: width }, async () => {
        const started = performance.now();
        try {
          const result = await f.exec('hostname');
          const valid = result.code === 0 && /^[^\s\0]+\r?\n?$/.test(result.output.toString('utf8'));
          const category = valid ? 'ok' : result.code === 124 ? 'exec_timeout'
            : result.stderr.toString('utf8').startsWith('REMOTE_READY_TIMEOUT:') ? 'remote_not_ready'
              : result.code === 255 ? 'connection_or_remote_failure' : 'exit_or_output_failure';
          return { ok: valid, category, latencyMs: result.latencyMs };
        } catch (error) {
          const category = error?.message === 'LIVE_SSH_CONNECT_FAILED' ? 'ssh_connect_failure'
            : error?.message === 'LIVE_CHANNEL_OPEN_FAILED' ? 'channel_open_failure'
              : error?.message === 'LIVE_EVENT_TIMEOUT' || error?.message === 'LIVE_OUTPUT_TIMEOUT' ? 'observation_timeout'
                : 'transport_failure';
          return { ok: false, category, latencyMs: performance.now() - started };
        }
      }));
      totals.push(...results);
      summarize(t, width, round, results);
    }
    check(totals.length === width * 3, 'LIVE_CONCURRENCY_SAMPLE_COUNT');
    summarize(t, width, 'all', totals);
  }
});

function summarize(t, width, round, results) {
  const successful = results.filter((result) => result.ok);
  const errors = {};
  for (const result of results) {
    if (!result.ok) errors[result.category] = (errors[result.category] || 0) + 1;
  }
  const latencies = results.map((result) => result.latencyMs);
  // Counts, durations and a fixed error vocabulary only: never remote identities,
  // raw exceptions, remote output, credentials or commands.
  t.diagnostic(JSON.stringify({
    concurrency: width, round, count: results.length, successful: successful.length,
    failed: results.length - successful.length,
    successRate: Number((successful.length / results.length).toFixed(3)),
    latencyMs: { p50: quantile(latencies, 0.5), p95: quantile(latencies, 0.95), max: quantile(latencies, 1) },
    errors,
  }));
}
