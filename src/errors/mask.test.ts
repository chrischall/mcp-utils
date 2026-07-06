import { describe, expect, it } from 'vitest';

import { BotWallError, maskSecret } from './index.js';

describe('maskSecret', () => {
  it('shows head and tail with an ellipsis between', () => {
    expect(maskSecret('abcdefghijklmnopqrstuvwxyz')).toBe('abcdefgh…wxyz');
  });

  it('respects custom head/tail lengths', () => {
    expect(maskSecret('abcdefghijklmnop', { head: 2, tail: 2 })).toBe('ab…op');
  });

  it('fully hides values too short to mask safely', () => {
    expect(maskSecret('shorttoken')).toBe('…');
    expect(maskSecret('')).toBe('…');
  });
});

describe('BotWallError vendor', () => {
  it('weaves the detected vendor into the message and exposes it as a field', () => {
    const err = new BotWallError('/search', 30, { vendor: 'DataDome' });
    expect(err.vendor).toBe('DataDome');
    expect(err.message).toContain('DataDome');
    expect(err.retryAfterSeconds).toBe(30);
  });

  it('stays backward-compatible without the vendor option', () => {
    const err = new BotWallError('/search');
    expect(err.vendor).toBeUndefined();
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
    expect(err.name).toBe('BotWallError');
  });
});
