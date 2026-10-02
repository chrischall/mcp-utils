/**
 * verifyAfterWrite (fleet-audit#1176, and the bug in #1117).
 *
 * "Accepted is not confirmed": after a physical command (unlock a door, arm an
 * alarm, start a car) the server re-reads until the state matches. kiaaccess-mcp
 * and simplisafe-mcp each hand-rolled the loop; simplisafe's ignored the caller's
 * cancellation and had no deadline on the read itself (#1117). These pin the
 * shared loop's bounds with fake timers.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { verifyAfterWrite } from './index.js';
import { withCallSignal } from '../cancel/index.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

/** A read that returns the given states in order, recording when each happened. */
function scripted<T>(states: T[]) {
  const at: number[] = [];
  let i = 0;
  const read = vi.fn(async (_signal: AbortSignal) => {
    at.push(Date.now());
    const s = states[Math.min(i, states.length - 1)] as T;
    i += 1;
    return s;
  });
  return { read, at };
}

describe('verifyAfterWrite', () => {
  it('re-reads every intervalMs and stops at the first settled snapshot', async () => {
    const { read, at } = scripted(['unlocked', 'unlocked', 'locked']);
    const p = verifyAfterWrite({ read, isSettled: (s) => s === 'locked', intervalMs: 1000, timeoutMs: 10_000, onProgress: () => {} });
    // Only as far as the third read: the 10 s deadline timer must be cleared, not run out.
    await vi.advanceTimersByTimeAsync(2000);
    const r = await p;
    expect(r).toMatchObject({ outcome: 'settled', settled: true, snapshot: 'locked', attempts: 3 });
    expect(at).toEqual([0, 1000, 2000]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits initialDelayMs before the first read', async () => {
    const { read, at } = scripted(['done']);
    const p = verifyAfterWrite({ read, isSettled: () => true, initialDelayMs: 2500, timeoutMs: 10_000 });
    await vi.runAllTimersAsync();
    expect((await p).outcome).toBe('settled');
    expect(at).toEqual([2500]);
  });

  it('gives up at the deadline and never reads after it', async () => {
    const { read, at } = scripted(['unlocked']);
    const p = verifyAfterWrite({ read, isSettled: () => false, intervalMs: 2500, timeoutMs: 10_000, onProgress: () => {} });
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r).toMatchObject({ outcome: 'timeout', settled: false, snapshot: 'unlocked' });
    // A wait that would end AT or past the deadline is not started.
    expect(at).toEqual([0, 2500, 5000, 7500]);
    expect(r.attempts).toBe(4);
    expect(r.elapsedMs).toBe(7500);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a read that hangs: the deadline aborts the signal the read was given', async () => {
    let seen: AbortSignal | undefined;
    const read = (signal: AbortSignal): Promise<string> =>
      new Promise((_resolve, reject) => {
        seen = signal;
        signal.addEventListener('abort', () => reject(signal.reason));
      });
    const p = verifyAfterWrite({ read, isSettled: () => true, timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    const r = await p;
    expect(r.outcome).toBe('timeout');
    expect(r.attempts).toBe(0);
    expect(r.snapshot).toBeUndefined();
    expect(seen?.aborted).toBe(true);
  });

  it("stops mid-wait when the caller's signal aborts (simplisafe #1117)", async () => {
    const { read, at } = scripted(['unlocked']);
    const ac = new AbortController();
    const p = verifyAfterWrite({ read, isSettled: () => false, intervalMs: 2500, timeoutMs: 15_000, signal: ac.signal, onProgress: () => {} });
    await vi.advanceTimersByTimeAsync(1000);
    ac.abort();
    const r = await p;
    expect(r).toMatchObject({ outcome: 'cancelled', settled: false, attempts: 1 });
    expect(Date.now()).toBe(1000); // returned at once, not at the next poll
    expect(at).toEqual([0]);
    await vi.runAllTimersAsync();
    expect(at).toEqual([0]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honours the ambient tool-call cancellation by default", async () => {
    const { read, at } = scripted(['unlocked']);
    const ac = new AbortController();
    const p = withCallSignal(ac.signal, () =>
      verifyAfterWrite({ read, isSettled: () => false, intervalMs: 2500, timeoutMs: 15_000, onProgress: () => {} }),
    );
    await vi.advanceTimersByTimeAsync(100);
    ac.abort();
    expect((await p).outcome).toBe('cancelled');
    expect(at).toEqual([0]);
  });

  it('does not read at all when already cancelled', async () => {
    const { read } = scripted(['x']);
    const ac = new AbortController();
    ac.abort();
    const r = await verifyAfterWrite({ read, isSettled: () => true, timeoutMs: 1000, signal: ac.signal });
    expect(r).toMatchObject({ outcome: 'cancelled', attempts: 0 });
    expect(read).not.toHaveBeenCalled();
  });

  it('reports a failed re-read as read_failed rather than throwing (the write already went out)', async () => {
    const err = new Error('502 from the base station');
    let n = 0;
    const read = vi.fn(async () => {
      n += 1;
      if (n === 2) throw err;
      return 'unlocked';
    });
    const p = verifyAfterWrite({ read, isSettled: () => false, intervalMs: 1000, timeoutMs: 10_000, onProgress: () => {} });
    await vi.runAllTimersAsync();
    const r = await p;
    expect(r).toMatchObject({ outcome: 'read_failed', settled: false, snapshot: 'unlocked', attempts: 1 });
    expect(r.error).toBe(err);
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports progress before each re-read, and a failing reporter costs nothing', async () => {
    const { read } = scripted(['a', 'a', 'b']);
    const progress: Array<{ attempt: number; elapsedMs: number; timeoutMs: number }> = [];
    const p = verifyAfterWrite({
      read,
      isSettled: (s) => s === 'b',
      intervalMs: 1000,
      timeoutMs: 10_000,
      onProgress: (info) => {
        progress.push(info);
        throw new Error('notify failed');
      },
    });
    await vi.runAllTimersAsync();
    expect((await p).outcome).toBe('settled');
    expect(progress).toEqual([
      { attempt: 2, elapsedMs: 1000, timeoutMs: 10_000 },
      { attempt: 3, elapsedMs: 2000, timeoutMs: 10_000 },
    ]);
  });
});
