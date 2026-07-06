/**
 * `singleFlight` / `memoizeAsync` — in-flight promise coalescing.
 *
 * The fleet hand-rolls this shape at least nine times: honeybook's
 * `apiVersionPromise` (self-clearing memoized fetch), infinitecampus's
 * `loginInFlight`, onehome's `capturePromise`, vibo's `loginInFlight` +
 * `reauthInFlight`, alltrails's `ensureApiKey`/`bridgeReady`, tripadvisor's
 * `bridgeReady`, artsonia's `ensureStarted`, and redfin's promise-caching
 * `LocalityPoolCache`. Two primitives cover all of them:
 *
 *  - {@link singleFlight} — one shared in-flight promise, cleared on settle
 *    (the login/refresh/bridge-ready guard).
 *  - {@link memoizeAsync} — a keyed promise cache that coalesces concurrent
 *    loads and evicts a rejected load so the next call retries (the keyed
 *    loader cache).
 */

/**
 * Wrap an async `fn` so concurrent calls share ONE in-flight invocation. The
 * in-flight promise is cleared once it settles, so the next call starts fresh
 * and a rejection doesn't poison later callers (every waiter of the failed
 * flight still sees the rejection).
 *
 * This is the guard `createOAuth2Refresher` embeds, exposed standalone for
 * login flows, bridge-start, and API-version fetches.
 */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return function run(): Promise<T> {
    if (inFlight) return inFlight;
    const p = fn().finally(() => {
      if (inFlight === p) inFlight = null;
    });
    inFlight = p;
    return p;
  };
}

/** The keyed async cache returned by {@link memoizeAsync}. */
export interface AsyncMemo<K, V> {
  /** Load (or return the cached/in-flight load of) the value for `key`. */
  get(key: K): Promise<V>;
  /** Drop one key so the next {@link get} reloads it. */
  delete(key: K): void;
  /** Drop everything. */
  clear(): void;
  /** Number of cached (or in-flight) keys. */
  readonly size: number;
}

/**
 * Memoize an async `loader` by key, caching the **promise** so concurrent
 * `get`s of the same key coalesce onto one load. A load that REJECTS is
 * evicted as it settles — the rejection reaches every coalesced waiter, but
 * the next `get` retries instead of replaying the cached failure.
 *
 * `delete`/`clear` cover invalidation and the `_reset*` test hooks the donor
 * repos (redfin, zola) exposed by hand.
 */
export function memoizeAsync<K, V>(loader: (key: K) => Promise<V>): AsyncMemo<K, V> {
  const cache = new Map<K, Promise<V>>();
  return {
    get(key: K): Promise<V> {
      const hit = cache.get(key);
      if (hit) return hit;
      const p = loader(key);
      cache.set(key, p);
      // Evict a failed load so the next get() retries; guard against the slot
      // having been deleted/replaced while this load was in flight.
      p.catch(() => {
        if (cache.get(key) === p) cache.delete(key);
      });
      return p;
    },
    delete(key: K): void {
      cache.delete(key);
    },
    clear(): void {
      cache.clear();
    },
    get size(): number {
      return cache.size;
    },
  };
}
