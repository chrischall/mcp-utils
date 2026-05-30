import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  PositiveInt,
  NonNegInt,
  NonEmptyString,
  IsoDate,
  IsoTime,
  schemaOrigin,
  schemaConfirm,
  paginationSchema,
  pageSchema,
  calculateOffset,
  toolAnnotations,
  extractTime,
  normalizeTime,
} from './index.js';

describe('atoms', () => {
  describe('PositiveInt', () => {
    it('accepts positive integers', () => {
      expect(PositiveInt.parse(1)).toBe(1);
      expect(PositiveInt.parse(200)).toBe(200);
    });
    it('rejects zero, negatives, and non-integers', () => {
      expect(PositiveInt.safeParse(0).success).toBe(false);
      expect(PositiveInt.safeParse(-1).success).toBe(false);
      expect(PositiveInt.safeParse(1.5).success).toBe(false);
    });
  });

  describe('NonNegInt', () => {
    it('accepts zero and positives', () => {
      expect(NonNegInt.parse(0)).toBe(0);
      expect(NonNegInt.parse(10)).toBe(10);
    });
    it('rejects negatives and non-integers', () => {
      expect(NonNegInt.safeParse(-1).success).toBe(false);
      expect(NonNegInt.safeParse(2.5).success).toBe(false);
    });
  });

  describe('NonEmptyString', () => {
    it('accepts non-empty', () => {
      expect(NonEmptyString.parse('x')).toBe('x');
    });
    it('rejects empty', () => {
      expect(NonEmptyString.safeParse('').success).toBe(false);
    });
  });

  describe('IsoDate', () => {
    it('accepts valid calendar dates', () => {
      expect(IsoDate.parse('2026-05-30')).toBe('2026-05-30');
    });
    it('rejects impossible and malformed dates', () => {
      expect(IsoDate.safeParse('2026-13-01').success).toBe(false);
      expect(IsoDate.safeParse('2026-5-3').success).toBe(false);
      expect(IsoDate.safeParse('not-a-date').success).toBe(false);
      expect(IsoDate.safeParse('2026-05-30T00:00:00').success).toBe(false);
    });
  });

  describe('IsoTime', () => {
    it('accepts HH:MM and H:MM 24h', () => {
      expect(IsoTime.parse('19:30')).toBe('19:30');
      expect(IsoTime.parse('9:05')).toBe('9:05');
      expect(IsoTime.parse('00:00')).toBe('00:00');
      expect(IsoTime.parse('23:59')).toBe('23:59');
    });
    it('rejects out-of-range, seconds, and junk', () => {
      expect(IsoTime.safeParse('24:00').success).toBe(false);
      expect(IsoTime.safeParse('19:60').success).toBe(false);
      expect(IsoTime.safeParse('19:30:00').success).toBe(false);
      expect(IsoTime.safeParse('7:5').success).toBe(false);
    });
    it('carries a helpful error message', () => {
      const r = IsoTime.safeParse('99:99');
      expect(r.success).toBe(false);
      if (!r.success) expect(r.error.issues[0]?.message).toMatch(/HH:MM/);
    });
  });

  describe('schemaOrigin', () => {
    it('is optional and accepts a string', () => {
      expect(schemaOrigin.parse(undefined)).toBeUndefined();
      expect(schemaOrigin.parse('https://x.example.co')).toBe('https://x.example.co');
    });
  });

  describe('schemaConfirm', () => {
    it('is optional boolean', () => {
      expect(schemaConfirm.parse(undefined)).toBeUndefined();
      expect(schemaConfirm.parse(true)).toBe(true);
      expect(schemaConfirm.safeParse('yes').success).toBe(false);
    });
  });
});

describe('pagination', () => {
  it('paginationSchema applies defaults and bounds', () => {
    const schema = z.object(paginationSchema);
    expect(schema.parse({})).toEqual({ offset: 0, limit: 50 });
    expect(schema.parse({ offset: 5, limit: 10 })).toEqual({ offset: 5, limit: 10 });
  });
  it('paginationSchema rejects out-of-bounds limit and negative offset', () => {
    const schema = z.object(paginationSchema);
    expect(schema.safeParse({ limit: 0 }).success).toBe(false);
    expect(schema.safeParse({ limit: 201 }).success).toBe(false);
    expect(schema.safeParse({ offset: -1 }).success).toBe(false);
  });

  it('pageSchema applies 1-based defaults and bounds', () => {
    const schema = z.object(pageSchema);
    expect(schema.parse({})).toEqual({ page_num: 1, page_size: 50 });
    expect(schema.parse({ page_num: 3, page_size: 25 })).toEqual({
      page_num: 3,
      page_size: 25,
    });
  });
  it('pageSchema rejects page_num < 1 and bad page_size', () => {
    const schema = z.object(pageSchema);
    expect(schema.safeParse({ page_num: 0 }).success).toBe(false);
    expect(schema.safeParse({ page_size: 0 }).success).toBe(false);
    expect(schema.safeParse({ page_size: 201 }).success).toBe(false);
  });

  describe('calculateOffset', () => {
    it('computes zero-based offset', () => {
      expect(calculateOffset(1, 50)).toBe(0);
      expect(calculateOffset(2, 50)).toBe(50);
      expect(calculateOffset(3, 50)).toBe(100);
    });
    it('clamps bad pages defensively', () => {
      expect(calculateOffset(0, 50)).toBe(0);
      expect(calculateOffset(-5, 50)).toBe(0);
      expect(calculateOffset(2.9, 50)).toBe(50);
      expect(calculateOffset(3, -10)).toBe(0);
    });
  });
});

describe('toolAnnotations', () => {
  it('defaults to read-only, idempotent, open-world', () => {
    expect(toolAnnotations({ title: 'Search' })).toEqual({
      title: 'Search',
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });
  it('honors overrides for mutating/local tools', () => {
    expect(
      toolAnnotations({
        title: 'Book',
        readOnly: false,
        idempotent: false,
        openWorld: true,
      })
    ).toEqual({
      title: 'Book',
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: true,
    });
  });
  it('supports closed-world (local compute) tools', () => {
    const a = toolAnnotations({ title: 'Calc mortgage', openWorld: false });
    expect(a.openWorldHint).toBe(false);
    expect(a.readOnlyHint).toBe(true);
  });
});

describe('extractTime', () => {
  it('extracts HH:MM from ISO datetime without timezone shift', () => {
    expect(extractTime('2026-05-01T19:30:00')).toBe('19:30');
    expect(extractTime('2026-05-01T00:05:00')).toBe('00:05');
  });
  it('extracts from a leading wire time', () => {
    expect(extractTime('19:00:00')).toBe('19:00');
  });
  it('returns empty string for missing/garbage', () => {
    expect(extractTime(undefined)).toBe('');
    expect(extractTime(null)).toBe('');
    expect(extractTime('')).toBe('');
    expect(extractTime('no time here')).toBe('');
  });
});

describe('normalizeTime', () => {
  it('zero-pads 24h input', () => {
    expect(normalizeTime('9:5')).toBe('09:05');
    expect(normalizeTime('19:30')).toBe('19:30');
    expect(normalizeTime('7')).toBe('07:00');
  });
  it('trims seconds', () => {
    expect(normalizeTime('19:30:45')).toBe('19:30');
  });
  it('converts 12h clock with meridiem', () => {
    expect(normalizeTime('7:30 PM')).toBe('19:30');
    expect(normalizeTime('7pm')).toBe('19:00');
    expect(normalizeTime('12am')).toBe('00:00');
    expect(normalizeTime('12pm')).toBe('12:00');
    expect(normalizeTime('11:15am')).toBe('11:15');
  });
  it('returns undefined for unparseable / out-of-range input', () => {
    expect(normalizeTime(undefined)).toBeUndefined();
    expect(normalizeTime(null)).toBeUndefined();
    expect(normalizeTime('')).toBeUndefined();
    expect(normalizeTime('   ')).toBeUndefined();
    expect(normalizeTime('nope')).toBeUndefined();
    expect(normalizeTime('25:00')).toBeUndefined();
    expect(normalizeTime('10:99')).toBeUndefined();
    expect(normalizeTime('13pm')).toBeUndefined();
    expect(normalizeTime('0am')).toBeUndefined();
  });
});
