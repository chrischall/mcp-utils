/**
 * "Accepted is not confirmed": after a write that acts on the physical world
 * (unlock a door, arm an alarm, start a car, set a charge limit) the upstream's
 * 2xx says only that the command was queued. The proof is a re-read that shows
 * the new state — and the device takes seconds, sometimes a minute, to report.
 *
 * kiaaccess-mcp (`KiaClient.verifyCommand`, the reference: abort-aware sleep,
 * progress, a `cancelled` flag) and simplisafe-mcp (the lock poll and the alarm
 * re-read) each hand-rolled this loop (fleet-audit#1176). simplisafe's lock poll
 * slept with a bare `setTimeout` and never consulted the caller's cancellation,
 * and nothing bounded a hung re-read (fleet-audit#1117) — so the shared loop
 * makes both bounds structural:
 *
 *  - **Deadline.** `timeoutMs` is a hard bound on the whole verification. Each
 *    read is handed an `AbortSignal` that fires at the deadline (pass it to
 *    `fetch`), and a wait that would end at or past the deadline is not started.
 *  - **Cancellation.** The caller's signal — by default the running tool call's
 *    ({@link currentCallSignal}) — ends a wait at once and is folded into the
 *    read's signal, so a client that cancelled stops being polled for.
 *  - **A failed re-read never throws.** The write already went out; reporting
 *    the read's failure as the command's would invite a retry of a door that is
 *    already open. It comes back as `outcome: 'read_failed'` with the `error`
 *    and the last good `snapshot`, for the caller to report as unverified.
 *
 * Progress is reported before each re-read through {@link reportProgress} (a
 * no-op unless the client sent a progress token); a failing reporter is ignored.
 */

import { currentCallSignal, reportProgress } from '../cancel/index.js';

/** Options for {@link verifyAfterWrite}. */
export interface VerifyAfterWriteOptions<T> {
  /** Read the current state. Pass `signal` on to the request so a hung read is bounded. */
  read: (signal: AbortSignal) => Promise<T>;
  /**
   * Whether `snapshot` ends the wait — the requested state, OR a terminal one
   * that will not change by waiting (simplisafe's `jammed`). Classify the final
   * snapshot yourself; this only decides when to stop reading.
   */
  isSettled: (snapshot: T) => boolean;
  /** Hard bound on the whole verification, in ms. */
  timeoutMs: number;
  /** Delay between re-reads. Default 2 000 ms. */
  intervalMs?: number;
  /** Delay before the FIRST read (a device that cannot have moved yet). Default 0. */
  initialDelayMs?: number;
  /** Cancellation. Defaults to the running tool call's ({@link currentCallSignal}). */
  signal?: AbortSignal;
  /**
   * Called before each re-read after the first. Defaults to {@link reportProgress}
   * with "Waiting for the change to be confirmed (read N)". Errors are ignored.
   */
  onProgress?: (info: { attempt: number; elapsedMs: number; timeoutMs: number }) => void | Promise<void>;
}

/** What {@link verifyAfterWrite} observed. */
export interface VerifyAfterWriteResult<T> {
  /**
   * - `settled` — a read satisfied `isSettled`.
   * - `timeout` — the deadline passed first.
   * - `cancelled` — the caller's signal aborted.
   * - `read_failed` — a read threw (not because of the deadline or the caller).
   */
  outcome: 'settled' | 'timeout' | 'cancelled' | 'read_failed';
  /** `outcome === 'settled'`. */
  settled: boolean;
  /** The last snapshot successfully read, or `undefined` when none was. */
  snapshot: T | undefined;
  /** Reads that returned a snapshot. */
  attempts: number;
  elapsedMs: number;
  /** The read's error, for `read_failed`. */
  error?: unknown;
}

/** Resolve after `ms`, or as soon as `signal` aborts. Never rejects. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * After a write, re-read until the observed state settles, the deadline passes,
 * or the caller cancels — see the module notes for the bounds it guarantees.
 */
export async function verifyAfterWrite<T>(opts: VerifyAfterWriteOptions<T>): Promise<VerifyAfterWriteResult<T>> {
  const { read, isSettled, timeoutMs } = opts;
  const intervalMs = opts.intervalMs ?? 2_000;
  const caller = opts.signal ?? currentCallSignal();
  const onProgress =
    opts.onProgress ??
    ((p: { attempt: number; elapsedMs: number; timeoutMs: number }) =>
      reportProgress(p.elapsedMs, p.timeoutMs, `Waiting for the change to be confirmed (read ${p.attempt})`));

  const started = Date.now();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error(`verification deadline of ${timeoutMs}ms passed`)), timeoutMs);
  const signal = caller ? AbortSignal.any([deadline.signal, caller]) : deadline.signal;

  let snapshot: T | undefined;
  let attempts = 0;
  const result = (outcome: VerifyAfterWriteResult<T>['outcome'], error?: unknown): VerifyAfterWriteResult<T> => ({
    outcome,
    settled: outcome === 'settled',
    snapshot,
    attempts,
    elapsedMs: Date.now() - started,
    ...(outcome === 'read_failed' ? { error } : {}),
  });
  /** Why the loop must stop now, if it must. The caller wins a tie with the deadline. */
  const stopped = (): 'cancelled' | 'timeout' | null =>
    caller?.aborted ? 'cancelled' : deadline.signal.aborted ? 'timeout' : null;

  try {
    if (opts.initialDelayMs !== undefined && opts.initialDelayMs > 0) {
      if (Date.now() - started + opts.initialDelayMs >= timeoutMs) return result(stopped() ?? 'timeout');
      await wait(opts.initialDelayMs, signal);
    }
    for (;;) {
      const halt = stopped();
      if (halt) return result(halt);
      if (attempts > 0) {
        try {
          await onProgress({ attempt: attempts + 1, elapsedMs: Date.now() - started, timeoutMs });
        } catch {
          /* a failed progress notification must never cost the verification */
        }
      }
      try {
        snapshot = await read(signal);
      } catch (err) {
        return result(stopped() ?? 'read_failed', err);
      }
      attempts += 1;
      if (isSettled(snapshot)) return result('settled');
      if (Date.now() - started + intervalMs >= timeoutMs) return result(stopped() ?? 'timeout');
      await wait(intervalMs, signal);
    }
  } finally {
    clearTimeout(timer);
  }
}
