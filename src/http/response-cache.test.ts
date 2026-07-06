import { describe, expect, it } from 'vitest';

import { createResponseCache } from './index.js';

function clock(startMs = 0): { now: () => number; advance: (ms: number) => void } {
  let t = startMs;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('createResponseCache', () => {
  it('serves a fresh entry and misses after its tier TTL', () => {
    const c = clock();
    const cache = createResponseCache({ ttlMs: { dynamic: 1000 }, now: c.now });
    cache.set('/a', 'v1');
    expect(cache.get('/a')).toBe('v1');
    c.advance(999);
    expect(cache.get('/a')).toBe('v1');
    c.advance(2);
    expect(cache.get('/a')).toBeUndefined();
  });

  it('applies per-tier TTLs (static outlives dynamic)', () => {
    const c = clock();
    const cache = createResponseCache({ ttlMs: { dynamic: 1000, static: 10_000 }, now: c.now });
    cache.set('/dyn', 'd');
    cache.set('/ref', 'r', 'static');
    c.advance(5000);
    expect(cache.get('/dyn')).toBeUndefined();
    expect(cache.get('/ref', 'static')).toBe('r');
  });

  it('a TTL of 0 disables storing for that tier', () => {
    const cache = createResponseCache({ ttlMs: { dynamic: 0, static: 1000 }, now: () => 0 });
    cache.set('/a', 'x');
    expect(cache.get('/a')).toBeUndefined();
    cache.set('/b', 'y', 'static');
    expect(cache.get('/b', 'static')).toBe('y');
  });

  it('evicts expired entries first when full, then the oldest insertion', () => {
    const c = clock();
    const cache = createResponseCache({ ttlMs: { dynamic: 1000 }, maxEntries: 2, now: c.now });
    cache.set('/old', 'a');
    c.advance(1500); // '/old' now expired
    cache.set('/b', 'b');
    cache.set('/c', 'c'); // full → expired '/old' evicted, '/b' survives
    expect(cache.get('/b')).toBe('b');
    expect(cache.get('/c')).toBe('c');

    cache.set('/d', 'd'); // full, nothing expired → oldest ('/b') evicted
    expect(cache.get('/b')).toBeUndefined();
    expect(cache.get('/c')).toBe('c');
    expect(cache.get('/d')).toBe('d');
  });

  it('fetchThrough caches the loader result and coalesces the hot path', async () => {
    const c = clock();
    const cache = createResponseCache<string>({ ttlMs: { dynamic: 1000 }, now: c.now });
    let loads = 0;
    const load = async (): Promise<string> => {
      loads += 1;
      return `v${loads}`;
    };
    expect(await cache.fetchThrough('/k', load)).toBe('v1');
    expect(await cache.fetchThrough('/k', load)).toBe('v1');
    expect(loads).toBe(1);
    c.advance(1500);
    expect(await cache.fetchThrough('/k', load)).toBe('v2');
  });

  it('clear() empties the cache; size reports live entries', () => {
    const cache = createResponseCache({ ttlMs: { dynamic: 1000 }, now: () => 0 });
    cache.set('/a', 1);
    cache.set('/b', 2);
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get('/a')).toBeUndefined();
  });
});
