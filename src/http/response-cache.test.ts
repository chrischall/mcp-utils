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
    expect(cache.get('/ref')).toBe('r');
  });

  it('a TTL of 0 disables storing for that tier', () => {
    const cache = createResponseCache({ ttlMs: { dynamic: 0, static: 1000 }, now: () => 0 });
    cache.set('/a', 'x');
    expect(cache.get('/a')).toBeUndefined();
    cache.set('/b', 'y', 'static');
    expect(cache.get('/b')).toBe('y');
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

  it('re-setting an existing key refreshes it without evicting a peer', () => {
    const cache = createResponseCache({ ttlMs: { dynamic: 1000 }, maxEntries: 2, now: () => 0 });
    cache.set('/a', 1);
    cache.set('/b', 2);
    cache.set('/a', 3);
    expect(cache.get('/a')).toBe(3);
    expect(cache.get('/b')).toBe(2);
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
  describe('fetchThrough in-flight dedup', () => {
    function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
      let resolve!: (v: T) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }
    const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' });

    it('two concurrent misses run load once and both get the value', async () => {
      const cache = createResponseCache<string>({ ttlMs: { dynamic: 1000 }, now: () => 0 });
      const d = deferred<string>();
      let loads = 0;
      const load = (): Promise<string> => {
        loads += 1;
        return d.promise;
      };
      const a = cache.fetchThrough('/k', load);
      const b = cache.fetchThrough('/k', load);
      d.resolve('v');
      expect(await Promise.all([a, b])).toEqual(['v', 'v']);
      expect(loads).toBe(1);
      expect(cache.get('/k')).toBe('v');
    });

    it('different keys do not share a load', async () => {
      const cache = createResponseCache<string>({ ttlMs: { dynamic: 1000 }, now: () => 0 });
      let loads = 0;
      const load = async (): Promise<string> => `v${++loads}`;
      const [a, b] = await Promise.all([cache.fetchThrough('/a', load), cache.fetchThrough('/b', load)]);
      expect([a, b].sort()).toEqual(['v1', 'v2']);
      expect(loads).toBe(2);
    });

    it('a rejection reaches every waiter, is not cached, and the next call reloads', async () => {
      const cache = createResponseCache<string>({ ttlMs: { dynamic: 1000 }, now: () => 0 });
      const d = deferred<string>();
      let loads = 0;
      const load = (): Promise<string> => {
        loads += 1;
        return loads === 1 ? d.promise : Promise.resolve('ok');
      };
      const a = cache.fetchThrough('/k', load);
      const b = cache.fetchThrough('/k', load);
      d.reject(new Error('boom'));
      await expect(a).rejects.toThrow('boom');
      await expect(b).rejects.toThrow('boom');
      expect(loads).toBe(1);
      expect(cache.size).toBe(0);
      expect(await cache.fetchThrough('/k', load)).toBe('ok');
      expect(loads).toBe(2);
    });

    it('a load that throws synchronously rejects and leaves nothing pending', async () => {
      const cache = createResponseCache<string>({ ttlMs: { dynamic: 1000 }, now: () => 0 });
      const bad = (): Promise<string> => {
        throw new Error('sync');
      };
      await expect(cache.fetchThrough('/k', bad)).rejects.toThrow('sync');
      expect(await cache.fetchThrough('/k', async () => 'ok')).toBe('ok');
    });

    it('a disabled tier (ttl 0) still dedups in-flight calls but stores nothing', async () => {
      const cache = createResponseCache<string>({ ttlMs: { dynamic: 0 }, now: () => 0 });
      const d = deferred<string>();
      let loads = 0;
      const load = (): Promise<string> => {
        loads += 1;
        return d.promise;
      };
      const a = cache.fetchThrough('/k', load);
      const b = cache.fetchThrough('/k', load);
      d.resolve('v');
      expect(await Promise.all([a, b])).toEqual(['v', 'v']);
      expect(loads).toBe(1);
      expect(cache.size).toBe(0);
      // Settled → nothing pending: the next call loads again.
      void cache.fetchThrough('/k', load);
      expect(loads).toBe(2);
    });

    it('clear() during a pending load: waiters still settle, the late value is not stored, new calls reload', async () => {
      const cache = createResponseCache<string>({ ttlMs: { dynamic: 1000 }, now: () => 0 });
      const first = deferred<string>();
      const second = deferred<string>();
      let loads = 0;
      const load = (): Promise<string> => {
        loads += 1;
        return loads === 1 ? first.promise : second.promise;
      };
      const a = cache.fetchThrough('/k', load);
      cache.clear();
      const b = cache.fetchThrough('/k', load); // pending entry dropped → fresh load
      expect(loads).toBe(2);
      second.resolve('new');
      expect(await b).toBe('new');
      first.resolve('stale');
      expect(await a).toBe('stale');
      // The pre-clear load must not overwrite or repopulate the cache.
      expect(cache.get('/k')).toBe('new');

      cache.clear();
      const c = deferred<string>();
      const p = cache.fetchThrough('/z', () => c.promise);
      cache.clear();
      c.resolve('late');
      expect(await p).toBe('late');
      expect(cache.get('/z')).toBeUndefined();
      expect(cache.size).toBe(0);
    });

    it('a waiter aborting its own signal rejects only that waiter', async () => {
      const cache = createResponseCache<string>({ ttlMs: { dynamic: 1000 }, now: () => 0 });
      const d = deferred<string>();
      let loads = 0;
      const load = (): Promise<string> => {
        loads += 1;
        return d.promise;
      };
      const leader = cache.fetchThrough('/k', load);
      const ctl = new AbortController();
      const waiter = cache.fetchThrough('/k', load, 'dynamic', { signal: ctl.signal });
      ctl.abort(abortError());
      await expect(waiter).rejects.toMatchObject({ name: 'AbortError' });
      d.resolve('v');
      expect(await leader).toBe('v');
      expect(loads).toBe(1);
      expect(cache.get('/k')).toBe('v');
    });

    it('the leader aborting does not fail a live waiter: the waiter re-runs its own load', async () => {
      const cache = createResponseCache<string>({ ttlMs: { dynamic: 1000 }, now: () => 0 });
      const leaderCtl = new AbortController();
      const leaderLoad = (): Promise<string> =>
        new Promise<string>((_res, rej) => {
          leaderCtl.signal.addEventListener('abort', () => rej(abortError()));
        });
      let waiterLoads = 0;
      const waiterLoad = async (): Promise<string> => {
        waiterLoads += 1;
        return 'w';
      };
      const leader = cache.fetchThrough('/k', leaderLoad, 'dynamic', { signal: leaderCtl.signal });
      const waiterCtl = new AbortController();
      const waiter = cache.fetchThrough('/k', waiterLoad, 'dynamic', { signal: waiterCtl.signal });
      leaderCtl.abort(abortError());
      await expect(leader).rejects.toMatchObject({ name: 'AbortError' });
      expect(await waiter).toBe('w');
      expect(waiterLoads).toBe(1);
      expect(cache.get('/k')).toBe('w');
    });

    it('a shared abort is retried by a signal-less waiter but not by an aborted one', async () => {
      const cache = createResponseCache<string>({ ttlMs: { dynamic: 1000 }, now: () => 0 });
      const d = deferred<string>();
      const leader = cache.fetchThrough('/k', () => d.promise);
      const plain = cache.fetchThrough('/k', async () => 'plain');
      d.reject(Object.assign(new Error('cancelled'), { name: 'CancelledError' }));
      await expect(leader).rejects.toThrow('cancelled');
      expect(await plain).toBe('plain');
    });

    it('a signalled waiter gets a non-cancellation rejection as-is, without retrying', async () => {
      const cache = createResponseCache<string>({ ttlMs: { dynamic: 1000 }, now: () => 0 });
      const d = deferred<string>();
      let waiterLoads = 0;
      const leader = cache.fetchThrough('/k', () => d.promise);
      const waiter = cache.fetchThrough('/k', async () => `w${++waiterLoads}`, 'dynamic', {
        signal: new AbortController().signal,
      });
      d.reject('plain string failure');
      await expect(leader).rejects.toBe('plain string failure');
      await expect(waiter).rejects.toBe('plain string failure');
      expect(waiterLoads).toBe(0);
    });

    it('a shared abort is not retried by a waiter whose own signal has aborted', async () => {
      const cache = createResponseCache<string>({ ttlMs: { dynamic: 1000 }, now: () => 0 });
      const ctl = new AbortController();
      let waiterLoads = 0;
      // The shared load rejects with an AbortError in the same tick the
      // waiter's signal aborts, so the waiter sees the shared rejection.
      const leader = cache.fetchThrough('/k', async () => {
        await Promise.resolve();
        ctl.abort(abortError());
        throw abortError();
      });
      const waiter = cache.fetchThrough('/k', async () => `w${++waiterLoads}`, 'dynamic', {
        signal: ctl.signal,
      });
      await expect(leader).rejects.toMatchObject({ name: 'AbortError' });
      await expect(waiter).rejects.toMatchObject({ name: 'AbortError' });
      expect(waiterLoads).toBe(0);
    });

    it('an already-aborted signal rejects without loading', async () => {
      const cache = createResponseCache<string>({ ttlMs: { dynamic: 1000 }, now: () => 0 });
      const ctl = new AbortController();
      ctl.abort(abortError());
      let loads = 0;
      await expect(
        cache.fetchThrough('/k', async () => `v${++loads}`, undefined, { signal: ctl.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(loads).toBe(0);
    });

    it('a cache hit ignores the signal path and returns immediately', async () => {
      const cache = createResponseCache<string>({ ttlMs: { dynamic: 1000 }, now: () => 0 });
      cache.set('/k', 'hit');
      const ctl = new AbortController();
      expect(await cache.fetchThrough('/k', async () => 'miss', 'dynamic', { signal: ctl.signal })).toBe('hit');
    });
  });
});
