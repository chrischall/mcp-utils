import { describe, expect, it } from 'vitest';

import { ensureSeconds, shiftIsoDate, toIsoDateUtc, todayIso } from './index.js';

describe('todayIso', () => {
  it('formats the LOCAL calendar date as yyyy-MM-dd', () => {
    // Construct via local-time parts so the expectation is timezone-proof.
    const d = new Date(2026, 0, 5, 23, 30); // Jan 5, 2026 local
    expect(todayIso(d)).toBe('2026-01-05');
  });

  it('zero-pads month and day', () => {
    expect(todayIso(new Date(2026, 8, 7))).toBe('2026-09-07');
  });
});

describe('toIsoDateUtc', () => {
  it('formats the UTC calendar date as yyyy-MM-dd', () => {
    expect(toIsoDateUtc(new Date(Date.UTC(2026, 6, 6, 1, 0)))).toBe('2026-07-06');
  });

  it('differs from the local date around UTC midnight', () => {
    // 2026-03-01T23:30Z is 2026-03-01 in UTC regardless of local zone.
    expect(toIsoDateUtc(new Date(Date.UTC(2026, 2, 1, 23, 30)))).toBe('2026-03-01');
  });
});

describe('shiftIsoDate', () => {
  it('adds days across a month boundary', () => {
    expect(shiftIsoDate('2026-01-30', 3)).toBe('2026-02-02');
  });

  it('subtracts days across a year boundary', () => {
    expect(shiftIsoDate('2026-01-02', -3)).toBe('2025-12-30');
  });

  it('handles leap days', () => {
    expect(shiftIsoDate('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('passes non-ISO input through trimmed (module convention)', () => {
    expect(shiftIsoDate(' not-a-date ', 5)).toBe('not-a-date');
  });
});

describe('ensureSeconds', () => {
  it('appends :00 to a bare HH:MM', () => {
    expect(ensureSeconds('17:30')).toBe('17:30:00');
  });

  it('passes HH:MM:SS through unchanged', () => {
    expect(ensureSeconds('17:30:45')).toBe('17:30:45');
  });

  it('passes unrecognized input through trimmed', () => {
    expect(ensureSeconds(' 5pm ')).toBe('5pm');
  });
});
