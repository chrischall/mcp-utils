/**
 * `createResponseCache` — bounded, tiered-TTL, in-memory response cache for
 * billed / rate-limited APIs.
 *
 * Hoists the cache triplicated across flightaware / viator / tripadvisor:
 * per-key `Map` of `{ expiresAt, value }`, a short `dynamic` tier for live data
 * and a long `static` tier for reference data (airports, canonical lookups),
 * a hard entry bound with expired-first-then-oldest eviction, and an
 * injectable clock for deterministic tests. Pair the TTLs with
 * `readTtlMsEnv('<SVC>_CACHE_TTL', …)` / `readTtlMsEnv('<SVC>_STATIC_CACHE_TTL', …)`.
 *
 * `fetchThrough` single-flights per key: concurrent misses for the same key
 * share ONE in-flight `load()` (the fan-out case — an agent issuing parallel
 * tool calls against a per-query-billed API like AeroAPI would otherwise pay
 * for every duplicate). A rejection is never cached and the pending entry is
 * dropped, so the next call reloads.
 *
 * Writes must never be cached — only route reads through this.
 */

/** Default maximum number of live entries (the donor fleets' shared bound). */
export const RESPONSE_CACHE_MAX_ENTRIES = 256;

/** Options for {@link createResponseCache}. */
export interface ResponseCacheOptions {
  /**
   * TTL per tier, in milliseconds. `dynamic` is the default tier; add any
   * named tiers you need (the fleet convention is `static` for reference
   * data). A tier with TTL `0` never stores — caching disabled.
   */
  ttlMs: { dynamic: number } & Record<string, number>;
  /** Max live entries before eviction. Defaults to {@link RESPONSE_CACHE_MAX_ENTRIES}. */
  maxEntries?: number;
  /** Injectable clock (defaults to `Date.now`) — for tests. */
  now?: () => number;
}

/** Per-call options for {@link ResponseCache.fetchThrough}. */
export interface FetchThroughOptions {
  /**
   * The caller's cancellation signal. When it aborts, THIS call rejects with
   * `signal.reason` — other callers sharing the same in-flight load are
   * unaffected. Your `load` should close over the same signal so the request
   * itself is cancelled when you lead the load. If the shared load rejects
   * after the caller leading it cancelled (that caller's signal aborted —
   * whatever the rejection looks like, e.g. the MCP SDK's string reason), or
   * rejects with an `AbortError`/`CancelledError`/`CanceledError`, and this
   * signal is still live, this call re-runs its own `load` instead of failing.
   */
  signal?: AbortSignal;
}

/** The cache returned by {@link createResponseCache}. */
export interface ResponseCache<V = unknown> {
  /**
   * The cached value for `key`, or `undefined` on miss/expiry. Tiers matter at
   * WRITE time only — the TTL is baked into the entry by {@link set} /
   * {@link fetchThrough} — so lookups take no tier.
   */
  get(key: string): V | undefined;
  /** Store `value` for `key` under `tier`'s TTL (no-op when that TTL is 0). */
  set(key: string, value: V, tier?: string): void;
  /**
   * Cache-through read: return the cached value or run `load` and cache it.
   * Concurrent misses for the same `key` share one in-flight `load` (the
   * first caller's); every caller gets its value or its rejection. The first
   * caller's `tier` also decides how that shared result is stored — a caller
   * joining an in-flight load does not change its TTL. A rejection is not
   * cached. A disabled tier (TTL 0) still dedups in-flight
   * calls but stores nothing. Pass `options.signal` so one caller's
   * cancellation never fails the others.
   */
  fetchThrough(
    key: string,
    load: () => Promise<V>,
    tier?: string,
    options?: FetchThroughOptions,
  ): Promise<V>;
  /**
   * Drop everything, including in-flight loads: callers already awaiting one
   * still settle with its outcome, but a load started before `clear()` never
   * writes into the cache, and the next call starts a fresh load.
   */
  clear(): void;
  /** Number of entries currently held (including not-yet-swept expired ones). */
  readonly size: number;
}

/**
 * Build a bounded in-memory TTL cache with named tiers. Keys are caller-chosen
 * — the donors key on the full request path (and body, for POST-read APIs like
 * viator). Eviction on insert when full: expired entries first, then the
 * oldest by insertion order.
 */
export function createResponseCache<V = unknown>(opts: ResponseCacheOptions): ResponseCache<V> {
  const now = opts.now ?? Date.now;
  const maxEntries = opts.maxEntries ?? RESPONSE_CACHE_MAX_ENTRIES;
  const store = new Map<string, { expiresAt: number; value: V }>();
  /** In-flight loads, keyed like `store`. Entries are compared by identity. */
  const inflight = new Map<string, InflightLoad<V>>();
  /** Bumped by `clear()` so a load started before it never repopulates the cache. */
  let generation = 0;

  const ttlFor = (tier: string): number => opts.ttlMs[tier] ?? 0;

  function evictForInsert(): void {
    if (store.size < maxEntries) return;
    // Pass 1: drop everything already expired.
    const t = now();
    for (const [key, entry] of store) {
      if (entry.expiresAt <= t) store.delete(key);
    }
    // Pass 2: still full → drop oldest insertions until under the bound.
    while (store.size >= maxEntries) {
      const oldest = store.keys().next();
      if (oldest.done) break;
      store.delete(oldest.value);
    }
  }

  function get(key: string): V | undefined {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function set(key: string, value: V, tier = 'dynamic'): void {
    const ttl = ttlFor(tier);
    if (ttl <= 0) return; // tier disabled
    // Re-setting an existing key must not trigger eviction of a peer.
    if (!store.has(key)) evictForInsert();
    else store.delete(key); // refresh insertion order
    store.set(key, { expiresAt: now() + ttl, value });
  }

  /** Start the shared load for `key`, registering it as in-flight. */
  function startLoad(
    key: string,
    load: () => Promise<V>,
    tier: string,
    signal: AbortSignal | undefined,
  ): InflightLoad<V> {
    const gen = generation;
    // The async wrapper turns a synchronous throw from `load` into a
    // rejection, while still invoking `load` synchronously.
    const shared = (async () => load())().then((value) => {
      if (gen === generation) set(key, value, tier);
      return value;
    });
    const entry: InflightLoad<V> = { promise: shared, signal };
    inflight.set(key, entry);
    // Registered before any caller awaits `shared`, so the pending entry is
    // gone by the time a waiter's continuation runs (and can retry).
    const drop = (): void => {
      if (inflight.get(key) === entry) inflight.delete(key);
    };
    shared.then(drop, drop);
    return entry;
  }

  async function fetchThrough(
    key: string,
    load: () => Promise<V>,
    tier = 'dynamic',
    options: FetchThroughOptions = {},
  ): Promise<V> {
    const { signal } = options;
    for (;;) {
      signal?.throwIfAborted();
      const hit = get(key);
      if (hit !== undefined) return hit;
      const pending = inflight.get(key);
      if (!pending) return withSignal(startLoad(key, load, tier, signal).promise, signal);
      try {
        return await withSignal(pending.promise, signal);
      } catch (err) {
        // Someone else's load was cancelled; ours is still wanted → re-run.
        // The leader's own signal is the authoritative test: real cancellations
        // often carry no recognisable name (the MCP SDK aborts with a string
        // reason, which fetch rejects with as-is and fetchBounded wraps in a
        // plain `Error`). The error name is a fallback for loads cancelled by
        // something other than the leader's signal.
        const cancelled = pending.signal?.aborted === true || isCancellation(err);
        if (cancelled && !signal?.aborted) continue;
        throw err;
      }
    }
  }

  return {
    get,
    set,
    fetchThrough,
    clear(): void {
      store.clear();
      inflight.clear();
      generation += 1;
    },
    get size(): number {
      return store.size;
    },
  };
}

/** A pending shared load and the signal of the caller that started it. */
interface InflightLoad<V> {
  promise: Promise<V>;
  signal: AbortSignal | undefined;
}

/** Race `promise` against `signal`: reject with `signal.reason` if it aborts first. */
function withSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** An abort/cancel error (matched on `name`, as the rest of the package does). */
function isCancellation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === 'AbortError' || name === 'CancelledError' || name === 'CanceledError';
}
