const LEVELS = new Set(['all', 'debug', 'info', 'warn', 'error']);
const KEYS = new Set(['query', 'level', 'source', 'from', 'to']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function invalid() {
  const error = new Error('INVALID_ARGUMENT');
  error.code = 'INVALID_ARGUMENT';
  throw error;
}

export function isLogTimestamp(value) {
  if (typeof value !== 'string' || !ISO.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z');
}

export function validateLogFilters(filters = {}, sources = []) {
  if (!filters || typeof filters !== 'object' || Array.isArray(filters)) invalid();
  if (Object.keys(filters).some((key) => !KEYS.has(key))) invalid();
  const value = { query: '', level: 'all', source: 'all', from: null, to: null, ...filters };
  if (typeof value.query !== 'string' || value.query.length > 256 || !LEVELS.has(value.level)) invalid();
  if (typeof value.source !== 'string' || (value.source !== 'all' && !sources.includes(value.source))) invalid();
  for (const key of ['from', 'to']) if (value[key] !== null && !isLogTimestamp(value[key])) invalid();
  if (value.from !== null && value.to !== null && Date.parse(value.from) > Date.parse(value.to)) invalid();
  return value;
}

export function filterLogs(logs, filters) {
  const query = filters.query.toLowerCase();
  const from = filters.from === null ? -Infinity : Date.parse(filters.from);
  const to = filters.to === null ? Infinity : Date.parse(filters.to);
  return logs.filter((entry) => {
    if (filters.level !== 'all' && entry.level !== filters.level) return false;
    if (filters.source !== 'all' && entry.source !== filters.source) return false;
    const time = Date.parse(entry.time);
    if (!Number.isFinite(time) || time < from || time > to) return false;
    return !query || String(entry.message ?? '').toLowerCase().includes(query);
  });
}
