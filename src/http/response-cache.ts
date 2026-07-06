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
  /** Cache-through read: return the cached value or run `load` and cache it. */
  fetchThrough(key: string, load: () => Promise<V>, tier?: string): Promise<V>;
  /** Drop everything. */
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

  return {
    get,
    set,
    async fetchThrough(key: string, load: () => Promise<V>, tier = 'dynamic'): Promise<V> {
      const hit = get(key);
      if (hit !== undefined) return hit;
      const value = await load();
      set(key, value, tier);
      return value;
    },
    clear(): void {
      store.clear();
    },
    get size(): number {
      return store.size;
    },
  };
}
