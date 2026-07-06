import { describe, expect, it } from 'vitest';

import { createCachedTokenSource } from './index.js';

function clock(startMs = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = startMs;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('createCachedTokenSource', () => {
  it('mints once and serves the cached token until expiry', async () => {
    const c = clock();
    let mints = 0;
    const source = createCachedTokenSource({
      mint: async () => {
        mints += 1;
        return { token: `t${mints}`, ttlMs: 100_000 };
      },
      now: c.now,
    });
    expect(await source.getToken()).toBe('t1');
    c.advance(10_000);
    expect(await source.getToken()).toBe('t1');
    expect(mints).toBe(1);
  });

  it('re-mints proactively inside the expiry buffer', async () => {
    const c = clock();
    let mints = 0;
    const source = createCachedTokenSource({
      mint: async () => {
        mints += 1;
        return { token: `t${mints}`, ttlMs: 100_000 };
      },
      bufferMs: 60_000,
      now: c.now,
    });
    await source.getToken();
    c.advance(45_000); // 55s left < 60s buffer → re-mint
    expect(await source.getToken()).toBe('t2');
    expect(mints).toBe(2);
  });

  it('accepts an absolute expiresAt (Date or epoch ms)', async () => {
    const c = clock();
    let mints = 0;
    const source = createCachedTokenSource({
      mint: async () => {
        mints += 1;
        return { token: `t${mints}`, expiresAt: new Date(c.now() + 200_000) };
      },
      now: c.now,
    });
    await source.getToken();
    c.advance(100_000);
    expect(await source.getToken()).toBe('t1');
    expect(mints).toBe(1);
  });

  it('applies defaultTtlMs when the mint returns no expiry', async () => {
    const c = clock();
    let mints = 0;
    const source = createCachedTokenSource({
      mint: async () => {
        mints += 1;
        return { token: `t${mints}` };
      },
      defaultTtlMs: 50_000,
      bufferMs: 0,
      now: c.now,
    });
    await source.getToken();
    c.advance(49_000);
    expect(await source.getToken()).toBe('t1');
    c.advance(2_000);
    expect(await source.getToken()).toBe('t2');
  });

  it('coalesces concurrent mints (single flight)', async () => {
    let mints = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const source = createCachedTokenSource({
      mint: async () => {
        mints += 1;
        await gate;
        return { token: 'tok', ttlMs: 100_000 };
      },
      now: () => 0,
    });
    const p1 = source.getToken();
    const p2 = source.getToken();
    release();
    expect(await p1).toBe('tok');
    expect(await p2).toBe('tok');
    expect(mints).toBe(1);
  });

  it('invalidate() forces a fresh mint (the 401-replay hook)', async () => {
    let mints = 0;
    const source = createCachedTokenSource({
      mint: async () => {
        mints += 1;
        return { token: `t${mints}`, ttlMs: 100_000 };
      },
      now: () => 0,
    });
    await source.getToken();
    source.invalidate();
    expect(await source.getToken()).toBe('t2');
  });

  it('a rejected mint does not poison the next call', async () => {
    let mints = 0;
    const source = createCachedTokenSource({
      mint: async () => {
        mints += 1;
        if (mints === 1) throw new Error('endpoint down');
        return { token: 'ok', ttlMs: 100_000 };
      },
      now: () => 0,
    });
    await expect(source.getToken()).rejects.toThrow('endpoint down');
    expect(await source.getToken()).toBe('ok');
  });
});
