/**
 * `createThrottle` — serialized min-interval scheduler.
 *
 * Hoisted verbatim from musicbrainz-mcp (`src/throttle.ts`), where it enforces
 * MusicBrainz's one-request-per-second rule proactively rather than reacting to
 * 503s: every upstream call is funnelled through a single serialized queue that
 * guarantees a minimum spacing between request *starts*. Concurrent tool calls
 * therefore can't burst — they line up and fire one-per-interval.
 *
 * Cancellable (fleet audit 2026-09 #577): a slot that has not started yet
 * gives up the moment its caller does — the ambient tool-call signal
 * ({@link currentCallSignal}) and/or a per-call `signal`. Before this, a call
 * queued behind a 1 req/s upstream waited out the whole queue (about two
 * minutes on musicbrainz) after the caller had gone, holding its place and
 * then firing a request nobody wanted.
 */

import { withAmbientCancellation } from '../cancel/index.js';

/** Options for {@link createThrottle}. */
export interface ThrottleOptions {
  /** Minimum milliseconds between the start of consecutive scheduled calls. */
  minIntervalMs: number;
  /** Injectable clock (defaults to `Date.now`) — for tests. */
  now?: () => number;
  /**
   * Injectable sleep (defaults to `setTimeout`) — for tests. Given the call's
   * signal when it has one; the default clears its timer on abort. A sleep
   * that ignores the signal is still cut short (the throttle races it).
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Per-call options for a {@link Throttle}. */
export interface ThrottleCallOptions {
  /**
   * Cancels this call while it is still waiting — queued behind earlier
   * tasks, or sleeping its spacing interval. Combined with the ambient
   * tool-call signal; either one firing cancels.
   */
  signal?: AbortSignal;
}

/**
 * A scheduler returned by {@link createThrottle}: wrap any async task to
 * serialize + space it. The optional second argument is additive — existing
 * `throttle(fn)` callers are unchanged.
 */
export type Throttle = <T>(fn: () => Promise<T>, opts?: ThrottleCallOptions) => Promise<T>;

/**
 * Build a serialized, rate-spacing scheduler. Tasks run strictly in submission
 * order, each starting no sooner than `minIntervalMs` after the previous one
 * started. A task that throws does not stall the queue — the next task is
 * scheduled regardless of the prior outcome.
 *
 * Cancellation: the signal is read when the call is SCHEDULED (the ambient
 * one, combined with `opts.signal`). If it fires before the task starts, the
 * call rejects at once with the signal's reason, `fn` never runs, and the
 * slot is skipped without consuming the interval — the next task is spaced
 * from the last task that actually started. Once `fn` has started the
 * throttle no longer intervenes: the task owns its own cancellation (a
 * `createApiClient` request already honours the same ambient signal), and the
 * caller sees whatever `fn` settles with.
 */
export function createThrottle(opts: ThrottleOptions): Throttle {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const interval = Math.max(0, opts.minIntervalMs);

  // `tail` is the promise the next task waits on; `lastStart` is when the most
  // recent task actually began (after any spacing wait).
  let tail: Promise<unknown> = Promise.resolve();
  let lastStart = Number.NEGATIVE_INFINITY;

  return function schedule<T>(fn: () => Promise<T>, callOpts?: ThrottleCallOptions): Promise<T> {
    const signal = withAmbientCancellation(callOpts?.signal);
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    // Rejects when the caller cancels BEFORE the task starts; inert after.
    let started = false;
    let detach = (): void => {};
    const cancelled = signal
      ? new Promise<never>((_resolve, reject) => {
          const onAbort = (): void => {
            if (!started) reject(abortReason(signal));
          };
          signal.addEventListener('abort', onAbort, { once: true });
          detach = () => signal.removeEventListener('abort', onAbort);
        })
      : undefined;
    // Observed by the races below; never an unhandled rejection on its own.
    cancelled?.catch(() => {});

    const run = async (): Promise<T> => {
      if (signal?.aborted) throw abortReason(signal);
      const wait = lastStart + interval - now();
      if (wait > 0) await (cancelled ? Promise.race([sleep(wait, signal), cancelled]) : sleep(wait));
      started = true;
      lastStart = now();
      return fn();
    };
    // Chain regardless of whether the previous task fulfilled or rejected, so a
    // failure never wedges the queue. The caller still sees this task's result.
    const queued = tail.then(run, run);
    tail = queued.then(
      () => undefined,
      () => undefined,
    );
    if (!cancelled) return queued;
    void tail.then(detach);
    // A queued caller must not wait for the queue to reach it to learn it was
    // cancelled — that wait is the bug this closes.
    return Promise.race([queued, cancelled]);
  };
}

/** `setTimeout` sleep that releases its timer when `signal` aborts (the race rejects the caller). */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => clearTimeout(timer);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** The signal's own reason as an Error, as `throwIfCancelled` reports it. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason));
}
