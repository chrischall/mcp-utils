/**
 * `createThrottle` — serialized min-interval scheduler.
 *
 * Hoisted verbatim from musicbrainz-mcp (`src/throttle.ts`), where it enforces
 * MusicBrainz's one-request-per-second rule proactively rather than reacting to
 * 503s: every upstream call is funnelled through a single serialized queue that
 * guarantees a minimum spacing between request *starts*. Concurrent tool calls
 * therefore can't burst — they line up and fire one-per-interval.
 */

/** Options for {@link createThrottle}. */
export interface ThrottleOptions {
  /** Minimum milliseconds between the start of consecutive scheduled calls. */
  minIntervalMs: number;
  /** Injectable clock (defaults to `Date.now`) — for tests. */
  now?: () => number;
  /** Injectable sleep (defaults to `setTimeout`) — for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** A scheduler returned by {@link createThrottle}: wrap any async task to serialize + space it. */
export type Throttle = <T>(fn: () => Promise<T>) => Promise<T>;

/**
 * Build a serialized, rate-spacing scheduler. Tasks run strictly in submission
 * order, each starting no sooner than `minIntervalMs` after the previous one
 * started. A task that throws does not stall the queue — the next task is
 * scheduled regardless of the prior outcome.
 */
export function createThrottle(opts: ThrottleOptions): Throttle {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
  const interval = Math.max(0, opts.minIntervalMs);

  // `tail` is the promise the next task waits on; `lastStart` is when the most
  // recent task actually began (after any spacing wait).
  let tail: Promise<unknown> = Promise.resolve();
  let lastStart = Number.NEGATIVE_INFINITY;

  return function schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const wait = lastStart + interval - now();
      if (wait > 0) await sleep(wait);
      lastStart = now();
      return fn();
    };
    // Chain regardless of whether the previous task fulfilled or rejected, so a
    // failure never wedges the queue. The caller still sees this task's result.
    const result = tail.then(run, run);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}
