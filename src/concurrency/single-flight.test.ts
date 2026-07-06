import { describe, expect, it } from 'vitest';

import { memoizeAsync, singleFlight } from './index.js';

describe('singleFlight', () => {
  it('coalesces concurrent calls onto one invocation', async () => {
    let calls = 0;
    let release!: (v: string) => void;
    const fn = singleFlight(() => {
      calls += 1;
      return new Promise<string>((r) => {
        release = r;
      });
    });
    const p1 = fn();
    const p2 = fn();
    release('ok');
    expect(await p1).toBe('ok');
    expect(await p2).toBe('ok');
    expect(calls).toBe(1);
  });

  it('starts fresh after the in-flight call settles', async () => {
    let calls = 0;
    const fn = singleFlight(async () => {
      calls += 1;
      return calls;
    });
    expect(await fn()).toBe(1);
    expect(await fn()).toBe(2);
  });

  it('propagates a rejection to all waiters and clears for the next call', async () => {
    let calls = 0;
    const fn = singleFlight(async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return 'recovered';
    });
    const p1 = fn();
    const p2 = fn();
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).rejects.toThrow('boom');
    expect(await fn()).toBe('recovered');
    expect(calls).toBe(2);
  });
});

describe('memoizeAsync', () => {
  it('caches per key and coalesces concurrent gets', async () => {
    const started: string[] = [];
    const cache = memoizeAsync(async (key: string) => {
      started.push(key);
      return `v:${key}`;
    });
    const [a1, a2, b] = await Promise.all([cache.get('a'), cache.get('a'), cache.get('b')]);
    expect(a1).toBe('v:a');
    expect(a2).toBe('v:a');
    expect(b).toBe('v:b');
    expect(started).toEqual(['a', 'b']);
  });

  it('serves later gets from the cache without re-invoking the loader', async () => {
    let calls = 0;
    const cache = memoizeAsync(async (_key: string) => {
      calls += 1;
      return calls;
    });
    expect(await cache.get('k')).toBe(1);
    expect(await cache.get('k')).toBe(1);
    expect(calls).toBe(1);
  });

  it('evicts a rejected load so the next get retries', async () => {
    let calls = 0;
    const cache = memoizeAsync(async (_key: string) => {
      calls += 1;
      if (calls === 1) throw new Error('nope');
      return 'ok';
    });
    await expect(cache.get('k')).rejects.toThrow('nope');
    expect(await cache.get('k')).toBe('ok');
    expect(calls).toBe(2);
  });

  it('supports delete and clear for test hooks / invalidation', async () => {
    let calls = 0;
    const cache = memoizeAsync(async (_key: string) => {
      calls += 1;
      return calls;
    });
    await cache.get('k');
    cache.delete('k');
    expect(await cache.get('k')).toBe(2);
    cache.clear();
    expect(await cache.get('k')).toBe(3);
    expect(cache.size).toBe(1);
  });
});
