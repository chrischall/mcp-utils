import { describe, expect, it } from 'vitest';

import { readIntEnv, readTtlMsEnv } from './index.js';

describe('readIntEnv', () => {
  it('parses a plain integer', () => {
    expect(readIntEnv('N', { env: { N: '123' } })).toBe(123);
  });

  it('trims surrounding whitespace', () => {
    expect(readIntEnv('N', { env: { N: '  42  ' } })).toBe(42);
  });

  it('returns undefined when unset and no default is given', () => {
    expect(readIntEnv('N', { env: {} })).toBeUndefined();
  });

  it('returns the default when unset', () => {
    expect(readIntEnv('N', { env: {}, default: 7 })).toBe(7);
  });

  it('treats an unsubstituted ${...} placeholder as unset', () => {
    expect(readIntEnv('N', { env: { N: '${N}' }, default: 7 })).toBe(7);
  });

  it('rejects non-integer junk (12abc, 1.5, 0x10, empty)', () => {
    for (const bad of ['12abc', '1.5', '0x10', 'abc', '']) {
      expect(readIntEnv('N', { env: { N: bad }, default: 9 })).toBe(9);
    }
  });

  it('rejects values below min or above max', () => {
    expect(readIntEnv('N', { env: { N: '0' }, min: 1, default: 5 })).toBe(5);
    expect(readIntEnv('N', { env: { N: '100' }, max: 50, default: 5 })).toBe(5);
    expect(readIntEnv('N', { env: { N: '50' }, min: 1, max: 50 })).toBe(50);
  });

  it('accepts a negative integer only when min allows it', () => {
    expect(readIntEnv('N', { env: { N: '-3' }, min: -10 })).toBe(-3);
    // No min → negatives are rejected (the fleet's env ints are all >= 0).
    expect(readIntEnv('N', { env: { N: '-3' }, default: 1 })).toBe(1);
  });
});

describe('readTtlMsEnv', () => {
  it('converts whole seconds to milliseconds', () => {
    expect(readTtlMsEnv('TTL', 15_000, { env: { TTL: '30' } })).toBe(30_000);
  });

  it('returns the default when unset', () => {
    expect(readTtlMsEnv('TTL', 15_000, { env: {} })).toBe(15_000);
  });

  it('honors an explicit 0 (disabled), not the default', () => {
    expect(readTtlMsEnv('TTL', 15_000, { env: { TTL: '0' } })).toBe(0);
  });

  it('falls back to the default on junk or negative values', () => {
    for (const bad of ['abc', '-5', '1.5s', '${TTL}', '']) {
      expect(readTtlMsEnv('TTL', 15_000, { env: { TTL: bad } })).toBe(15_000);
    }
  });
});
