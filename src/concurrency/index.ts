/**
 * `concurrency` — small, pure async-iteration primitives with zero runtime
 * dependencies.
 *
 * Hoists the hand-rolled bounded-fan-out `mapLimit` copy-pasted across the fleet
 * (e.g. artsonia's `src/tools/download.ts`): a pool of `limit` runners pulling
 * the next index off a shared cursor, results collected by index so the output
 * stays in input order.
 */

/**
 * Map `fn` over `items` with at most `limit` calls in flight at once, returning
 * the results in **input order** (not completion order).
 *
 * A pool of `min(limit, items.length)` runners pulls the next index off a shared
 * cursor; each result is written to its slot, so a later item that settles first
 * never reorders the output. Standard `Promise.all` semantics for failure: the
 * **first** rejecting `fn` rejects the whole call (the rejection is not
 * swallowed). Like `Promise.all`, work already in flight is NOT cancelled, and
 * the other pool runners keep pulling — so a few not-yet-started items may still
 * begin before the rejection propagates; their results are discarded along with
 * the rejected promise. (Use {@link runBoundedBatch} if you need each item's
 * outcome captured rather than all-or-nothing.) Empty input resolves to `[]`
 * without calling `fn`; `limit >= items.length` behaves like
 * `Promise.all(items.map(fn))`.
 *
 * This is the **zero-dependency core** map. Distinct relatives:
 *  - `@chrischall/mcp-utils/fetchproxy` re-exports a same-named
 *    `mapWithConcurrency` from `@fetchproxy/server` — use that one only in bridge
 *    repos that already depend on the fetchproxy server; this core one needs no
 *    optional peer.
 *  - {@link runBoundedBatch} (the `http` module) is for *resilience*: an overall
 *    hard deadline plus a per-item timeout/error backfill, always returning a
 *    full-length array even when rows hang or throw. Reach for that when you need
 *    a deadline; reach for this when you just want an ordered, all-or-nothing map.
 *
 * @param items The inputs to map over (read-only; never mutated).
 * @param limit Max concurrent `fn` calls. Values `>= items.length` (or larger)
 *   run everything at once; `<= 1` runs serially.
 * @param fn Async mapper, called with each `item` and its input `index`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const poolSize = Math.min(Math.max(limit, 1), items.length);
  await Promise.all(
    Array.from({ length: poolSize }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!, i);
      }
    }),
  );
  return results;
}

export * from './single-flight.js';
