import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatTime, formatUptime } from '../src/lib/format';

describe('format utilities', () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'handles non-finite numeric input %s',
    (value) => {
      expect(formatBytes(value)).toBe('0 B');
      expect(formatUptime(value)).toBe('0s');
      expect(formatDuration(value)).toBe('--');
    },
  );

  it('returns a placeholder for invalid dates', () => {
    expect(formatTime('not-a-date')).toBe('--');
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe('--');
  });
});
