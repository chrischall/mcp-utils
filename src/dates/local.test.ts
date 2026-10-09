import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ensureSeconds,
  isValidTimeZone,
  resolveUserTimeZone,
  shiftIsoDate,
  toIsoDateUtc,
  todayIso,
  USER_TIME_ZONE_ENV,
} from './index.js';

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

describe('todayIso — time zones', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // 2026-01-05T12:00Z is already Jan 6 in Auckland (UTC+13) and still Jan 5 in LA.
  const noonUtc = new Date(Date.UTC(2026, 0, 5, 12, 0));
  // 2026-01-05T03:00Z is still Jan 4 in LA (UTC-8) — the hosted-UTC off-by-one.
  const earlyUtc = new Date(Date.UTC(2026, 0, 5, 3, 0));

  it('reads the calendar date in an explicit IANA zone', () => {
    expect(todayIso({ now: noonUtc, timeZone: 'Pacific/Auckland', env: {} })).toBe('2026-01-06');
    expect(todayIso({ now: earlyUtc, timeZone: 'America/Los_Angeles', env: {} })).toBe('2026-01-04');
    expect(todayIso({ now: earlyUtc, timeZone: 'UTC', env: {} })).toBe('2026-01-05');
  });

  it(`honours ${'MCP_USER_TZ'} when no zone is passed`, () => {
    expect(USER_TIME_ZONE_ENV).toBe('MCP_USER_TZ');
    expect(todayIso({ now: earlyUtc, env: { MCP_USER_TZ: 'America/Los_Angeles' } })).toBe('2026-01-04');
  });

  it('an explicit timeZone beats MCP_USER_TZ', () => {
    expect(
      todayIso({ now: earlyUtc, timeZone: 'UTC', env: { MCP_USER_TZ: 'America/Los_Angeles' } }),
    ).toBe('2026-01-05');
  });

  it('the legacy todayIso(date) form also honours MCP_USER_TZ from process.env', () => {
    vi.stubEnv('MCP_USER_TZ', 'America/Los_Angeles');
    expect(todayIso(earlyUtc)).toBe('2026-01-04');
    vi.stubEnv('MCP_USER_TZ', 'Pacific/Auckland');
    expect(todayIso({ now: noonUtc })).toBe('2026-01-06');
  });

  it('falls back to the host zone when MCP_USER_TZ is unset, blank, a placeholder or not a zone', () => {
    const local = new Date(2026, 0, 5, 23, 30);
    for (const v of [undefined, '', '${MCP_USER_TZ}', 'Not/AZone']) {
      expect(todayIso({ now: local, env: { MCP_USER_TZ: v } })).toBe('2026-01-05');
    }
  });

  it('throws a RangeError naming an invalid explicit zone', () => {
    expect(() => todayIso({ now: noonUtc, timeZone: 'Mars/Olympus' })).toThrow(RangeError);
    expect(() => todayIso({ now: noonUtc, timeZone: 'Mars/Olympus' })).toThrow(/Mars\/Olympus/);
  });

  it('defaults now to the current time', () => {
    expect(todayIso({ timeZone: 'UTC', env: {} })).toBe(toIsoDateUtc(new Date()));
    expect(todayIso({})).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(todayIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('resolveUserTimeZone / isValidTimeZone', () => {
  it('prefers the explicit zone, then MCP_USER_TZ, else undefined (host zone)', () => {
    expect(resolveUserTimeZone({ timeZone: 'Europe/London', env: { MCP_USER_TZ: 'UTC' } })).toBe(
      'Europe/London',
    );
    expect(resolveUserTimeZone({ env: { MCP_USER_TZ: ' America/New_York ' } })).toBe('America/New_York');
    expect(resolveUserTimeZone({ env: { MCP_USER_TZ: 'bogus' } })).toBeUndefined();
    expect(resolveUserTimeZone({ env: {} })).toBeUndefined();
  });

  it('validates IANA zone names', () => {
    expect(isValidTimeZone('America/Chicago')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
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
