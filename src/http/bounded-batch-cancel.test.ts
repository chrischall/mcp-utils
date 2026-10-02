/**
 * runBoundedBatch and the CALLER's cancellation (fleet-audit#1161 follow-on).
 *
 * The deadline half of #1161 shipped in 2.6.1 (#1183): once the deadline
 * answers, the runners stop dequeuing. But the batch still ignored the tool
 * call's own cancellation — a client that cancelled a 20-row bulk read left the
 * runners pulling rows (through the user's browser tab, for the bridge repos)
 * until the deadline, which is exactly the traffic homes-mcp's per-worker
 * `throwIfDeadlinePassed` guards exist to stop.
 */
import { describe, expect, it, vi } from 'vitest';

import { runBoundedBatch } from './index.js';
import { withCallSignal } from '../cancel/index.js';

/** A timer that only fires when the test says so. */
function manualTimer() {
  let fire: () => void = () => {};
  return {
    setTimer: (_ms: number, cb: () => void): unknown => {
      fire = cb;
      return 0;
    },
    clearTimer: () => {},
    fire: () => fire(),
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe('runBoundedBatch caller cancellation', () => {
  it('answers at once when the caller cancels, and dispatches nothing more', async () => {
    const t = manualTimer();
    const ac = new AbortController();
    const called: number[] = [];
    let seen: AbortSignal | undefined;
    let releaseFirst: () => void = () => {};
    const p = runBoundedBatch(
      [0, 1, 2, 3],
      async (n, signal) => {
        called.push(n);
        seen = signal;
        if (n === 0) await new Promise<void>((r) => (releaseFirst = r));
        return n * 10;
      },
      { deadlineMs: 60_000, concurrency: 1, onTimeout: () => -1, signal: ac.signal, setTimer: t.setTimer, clearTimer: t.clearTimer },
    );
    await flush();
    expect(called).toEqual([0]);
    ac.abort();
    // Resolved without the deadline ever firing.
    expect(await p).toEqual([-1, -1, -1, -1]);
    expect(seen?.aborted).toBe(true);
    releaseFirst();
    await flush();
    expect(called).toEqual([0]);
  });

  it('honours the ambient tool-call signal by default', async () => {
    const t = manualTimer();
    const ac = new AbortController();
    const called: number[] = [];
    let releaseFirst: () => void = () => {};
    const p = withCallSignal(ac.signal, () =>
      runBoundedBatch(
        [0, 1, 2],
        async (n) => {
          called.push(n);
          if (n === 0) await new Promise<void>((r) => (releaseFirst = r));
          return n;
        },
        { deadlineMs: 60_000, concurrency: 1, onTimeout: () => -1, setTimer: t.setTimer, clearTimer: t.clearTimer },
      ),
    );
    await flush();
    ac.abort();
    expect(await p).toEqual([-1, -1, -1]);
    releaseFirst();
    await flush();
    expect(called).toEqual([0]);
  });

  it('dispatches nothing when the caller has already cancelled', async () => {
    const ac = new AbortController();
    ac.abort();
    const worker = vi.fn(async (n: number) => n);
    expect(await runBoundedBatch([1, 2], worker, { deadlineMs: 1000, onTimeout: () => -1, signal: ac.signal })).toEqual([-1, -1]);
    expect(worker).not.toHaveBeenCalled();
  });

  it('keeps real results for rows that settled before the cancel', async () => {
    const t = manualTimer();
    const ac = new AbortController();
    let releaseSecond: () => void = () => {};
    const p = runBoundedBatch(
      [1, 2],
      async (n) => {
        if (n === 2) await new Promise<void>((r) => (releaseSecond = r));
        return n * 10;
      },
      { deadlineMs: 60_000, concurrency: 1, onTimeout: () => -1, signal: ac.signal, setTimer: t.setTimer, clearTimer: t.clearTimer },
    );
    await flush();
    ac.abort();
    expect(await p).toEqual([10, -1]);
    releaseSecond();
  });

  it("stops listening to the caller's signal once the batch has answered", async () => {
    const ac = new AbortController();
    const add = vi.spyOn(ac.signal, 'addEventListener');
    const remove = vi.spyOn(ac.signal, 'removeEventListener');
    await runBoundedBatch([1, 2], async (n) => n, { deadlineMs: 1000, onTimeout: () => -1, signal: ac.signal });
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
  });
});
