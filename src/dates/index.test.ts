import { describe, it, expect } from 'vitest';
import { isoToDmy, dmyToIso, isoToCompactTimestamp } from './index.js';

describe('isoToDmy', () => {
  it('converts ISO yyyy-MM-dd to dd-MM-yyyy', () => {
    expect(isoToDmy('2025-08-28')).toBe('28-08-2025');
  });
  it('trims and passes non-ISO input through', () => {
    expect(isoToDmy(' 28-08-2025 ')).toBe('28-08-2025');
    expect(isoToDmy('nope')).toBe('nope');
  });
});

describe('dmyToIso', () => {
  it('converts dd-MM-yyyy to ISO yyyy-MM-dd', () => {
    expect(dmyToIso('28-08-2025')).toBe('2025-08-28');
  });
  it('is idempotent on already-ISO input', () => {
    expect(dmyToIso('2025-08-28')).toBe('2025-08-28');
  });
});

describe('isoToCompactTimestamp', () => {
  it('expands a bare date to yyyyMMddHHmmss with zero time', () => {
    expect(isoToCompactTimestamp('2025-01-31')).toBe('20250131000000');
  });
  it('converts an ISO datetime (with or without seconds)', () => {
    expect(isoToCompactTimestamp('2025-01-31T14:30:00')).toBe('20250131143000');
    expect(isoToCompactTimestamp('2025-01-31T14:30')).toBe('20250131143000');
  });
  it('passes an already-compact 14-digit value through', () => {
    expect(isoToCompactTimestamp('20250131143000')).toBe('20250131143000');
  });
  it('passes timezone-aware / sub-second inputs through untouched (no silent offset loss)', () => {
    expect(isoToCompactTimestamp('2025-01-31T14:30:00Z')).toBe('2025-01-31T14:30:00Z');
    expect(isoToCompactTimestamp('2025-01-31T14:30:00+05:30')).toBe('2025-01-31T14:30:00+05:30');
    expect(isoToCompactTimestamp('2025-01-31T14:30:00.806')).toBe('2025-01-31T14:30:00.806');
  });
});
