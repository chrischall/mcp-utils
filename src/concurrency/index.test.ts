import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from './index.js';

/** A deferred promise plus its resolve, for hand-driving in-flight settling. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of settle order', async () => {
    // Later items settle first, so an order-preserving impl must place by index.
    const out = await mapWithConcurrency([10, 20, 30, 40], 2, async (n) => {
      await new Promise((r) => setTimeout(r, (40 - n) / 4));
      return n * 2;
    });
    expect(out).toEqual([20, 40, 60, 80]);
  });

  it('passes the input index to fn', async () => {
    const out = await mapWithConcurrency(['a', 'b', 'c'], 2, async (item, i) => `${item}${i}`);
    expect(out).toEqual(['a0', 'b1', 'c2']);
  });

  it('never exceeds the concurrency cap (tracks max in flight)', async () => {
    const gates = Array.from({ length: 6 }, () => deferred<void>());
    let inFlight = 0;
    let maxInFlight = 0;

    const all = mapWithConcurrency(gates, 2, async (gate, i) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate.promise;
      inFlight -= 1;
      return i;
    });

    // Let the microtask queue start the initial pool, then release one at a time.
    for (let i = 0; i < gates.length; i += 1) {
      await Promise.resolve();
      expect(inFlight).toBeLessThanOrEqual(2);
      gates[i]!.resolve();
    }

    expect(await all).toEqual([0, 1, 2, 3, 4, 5]);
    expect(maxInFlight).toBe(2);
  });

  it('returns [] for empty input without calling fn', async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], 4, async () => {
      calls += 1;
      return 1;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  it('rejects the whole call when fn rejects (no swallowing)', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });

  it('behaves like Promise.all when limit >= items.length', async () => {
    const out = await mapWithConcurrency([1, 2, 3], 10, async (n) => n + 1);
    expect(out).toEqual([2, 3, 4]);
  });

  it('runs at most one at a time with limit 1 (serial)', async () => {
    const order: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const out = await mapWithConcurrency([1, 2, 3], 1, async (n) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      order.push(n);
      inFlight -= 1;
      return n;
    });
    expect(out).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
    expect(maxInFlight).toBe(1);
  });

  it('clamps limit <= 0 to serial (still correct, never zero runners)', async () => {
    for (const limit of [0, -3]) {
      let inFlight = 0;
      let maxInFlight = 0;
      const out = await mapWithConcurrency([1, 2, 3], limit, async (n) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return n * 2;
      });
      expect(out).toEqual([2, 4, 6]); // all items still processed, in order
      expect(maxInFlight).toBe(1); // clamped to 1, not 0 (which would hang)
    }
  });
});
