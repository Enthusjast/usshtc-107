export const EMPTY_STATS = Object.freeze({ uptimeMs: 0, totalBytesSent: 0, totalBytesReceived: 0, sessionCount: 0, sessions: [] });
export const ZERO_RATES = Object.freeze({ sent: 0, received: 0 });

export function diffRates(previous, sample) {
  if (!previous || previous.profileId !== sample.profileId || previous.epoch !== sample.epoch
    || sample.sequence <= previous.sequence || sample.sampledAt <= previous.sampledAt) return ZERO_RATES;
  const sent = sample.totalBytesSent - previous.totalBytesSent;
  const received = sample.totalBytesReceived - previous.totalBytesReceived;
  if (![sent, received, sample.sampledAt, previous.sampledAt].every(Number.isFinite) || sent < 0 || received < 0) return ZERO_RATES;
  const seconds = (sample.sampledAt - previous.sampledAt) / 1000;
  return { sent: sent / seconds, received: received / seconds };
}

export function appendRatePoint(points, sample, rates) {
  const second = Math.floor(sample.sampledAt / 1000);
  const point = { second, sampledAt: sample.sampledAt, ...rates };
  const recent = points.filter((value) => value.second > second - 60 && value.second < second);
  return [...recent, point].slice(-60);
}

// UTC calendar boundaries are independent of the user's timezone. Only labels are localized.
export function aggregateHistory(sessions) {
  const days = new Map();
  for (const session of sessions) {
    const timestamp = session.endedAt ?? session.startedAt;
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) continue;
    const day = date.toISOString().slice(0, 10);
    const totals = days.get(day) ?? { day, count: 0, bytesSent: 0, bytesReceived: 0 };
    totals.count += 1;
    totals.bytesSent += session.bytesSent;
    totals.bytesReceived += session.bytesReceived;
    days.set(day, totals);
  }
  return [...days.values()].sort((a, b) => b.day.localeCompare(a.day));
}
