/**
 * A retry's wait that stops when the running tool call is cancelled
 * (fleet-audit#1443). Both clients already fold the ambient call signal into
 * every fetch; without this the wait BETWEEN attempts — up to the capped
 * backoff or `Retry-After` — ran its full length before the next fetch
 * noticed the cancellation.
 */

import { currentCallSignal } from '../cancel/index.js';

/** The signal's reason, as `fetch` rejects with it (a DOMException `AbortError` by default). */
function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('This operation was aborted', 'AbortError');
}

/**
 * Wait `ms` (through `sleep` when one is injected, else a timer), rejecting
 * with the abort reason as soon as the ambient call signal fires. The timer
 * is released on abort; an injected sleep is raced.
 */
export function cancellableSleep(ms: number, sleep?: (ms: number) => Promise<void>): Promise<void> {
  const signal = currentCallSignal();
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  if (!signal) return sleep ? sleep(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      reject(abortReason(signal));
    };
    const done = (): void => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (sleep) {
      sleep(ms).then(done, (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      });
    } else {
      timer = setTimeout(done, ms);
    }
  });
}
