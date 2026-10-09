import { describe, it, expect, vi } from 'vitest';
import { withCallSignal } from '../cancel/index.js';
import { createThrottle } from './throttle.js';

/**
 * Fleet audit 2026-09 #577 (musicbrainz): a call queued behind a 1 req/s
 * throttle waited out the WHOLE queue after its caller had gone — about two
 * minutes of a cancelled tool call holding its slot. A slot that has not
 * started must give up the moment its caller does.
 */

/** A clock whose sleeps only end when the test says so. */
function manualClock() {
  let t = 0;
  const pending: Array<{ ms: number; resolve: () => void }> = [];
  return {
    now: () => t,
    sleep: (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        pending.push({
          ms,
          resolve: () => {
            t += ms;
            resolve();
          },
        });
      }),
    pending,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createThrottle cancellation', () => {
  it('rejects a queued call as soon as its caller cancels, and never runs it', async () => {
    const clock = manualClock();
    const throttle = createThrottle({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
    let release!: () => void;
    const first = throttle(() => new Promise<string>((r) => (release = () => r('first'))));

    const ac = new AbortController();
    let ran = false;
    const second = withCallSignal(ac.signal, () =>
      throttle(async () => {
        ran = true;
        return 'second';
      }),
    );
    await tick();
    ac.abort(new Error('caller went away'));
    await expect(second).rejects.toThrow('caller went away');

    release();
    await expect(first).resolves.toBe('first');
    await tick();
    expect(ran).toBe(false);
  });

  it('aborts the spacing sleep of a call that is waiting its turn', async () => {
    const clock = manualClock();
    const throttle = createThrottle({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
    await throttle(async () => 'a');

    const ac = new AbortController();
    let ran = false;
    const b = throttle(
      async () => {
        ran = true;
      },
      { signal: ac.signal },
    );
    await tick();
    expect(clock.pending).toHaveLength(1); // sleeping its 1000 ms
    ac.abort(new Error('stop'));
    await expect(b).rejects.toThrow('stop');
    expect(ran).toBe(false);
  });

  it('rejects at once, without queueing, when the caller has already gone', async () => {
    const throttle = createThrottle({ minIntervalMs: 1000 });
    let ran = false;
    const p = throttle(
      async () => {
        ran = true;
      },
      { signal: AbortSignal.abort(new Error('already gone')) },
    );
    await expect(p).rejects.toThrow('already gone');
    expect(ran).toBe(false);
  });

  it('wraps a non-Error abort reason in an Error', async () => {
    const throttle = createThrottle({ minIntervalMs: 0 });
    const ac = new AbortController();
    ac.abort('plain reason');
    await expect(throttle(async () => 1, { signal: ac.signal })).rejects.toThrow('plain reason');
  });

  it('a cancelled slot does not consume the interval or wedge the queue', async () => {
    const clock = manualClock();
    const throttle = createThrottle({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
    await throttle(async () => 'a'); // starts at t=0

    const ac = new AbortController();
    const b = throttle(async () => 'b', { signal: ac.signal });
    const c = throttle(async () => 'c');
    await tick();
    ac.abort(new Error('b cancelled'));
    await expect(b).rejects.toThrow('b cancelled');
    await tick();
    // c waits only the remainder of a's interval: b never started.
    expect(clock.pending.map((p) => p.ms)).toEqual([1000, 1000]);
    clock.pending[1]!.resolve();
    await expect(c).resolves.toBe('c');
  });

  it('does not cut short a task that has already started', async () => {
    const throttle = createThrottle({ minIntervalMs: 0 });
    const ac = new AbortController();
    let release!: () => void;
    const p = throttle(() => new Promise<string>((r) => (release = () => r('finished'))), { signal: ac.signal });
    await tick();
    ac.abort(new Error('late'));
    release();
    // Once started, the task owns its own cancellation (it can read the same
    // signal); the throttle reports what the task did.
    await expect(p).resolves.toBe('finished');
  });

  it('combines a per-call signal with the ambient one (either cancels)', async () => {
    const clock = manualClock();
    const throttle = createThrottle({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
    await throttle(async () => 'a');
    const ambient = new AbortController();
    const own = new AbortController();
    const p = withCallSignal(ambient.signal, () => throttle(async () => 'b', { signal: own.signal }));
    await tick();
    ambient.abort(new Error('ambient'));
    await expect(p).rejects.toThrow('ambient');
  });

  it('runs normally when the signal never fires', async () => {
    const throttle = createThrottle({ minIntervalMs: 0 });
    const ac = new AbortController();
    expect(await throttle(async () => 7, { signal: ac.signal })).toBe(7);
    ac.abort(); // after settling: must not surface anywhere
    await tick();
  });
});

describe('createThrottle default sleep', () => {
  it('releases its spacing timer when the caller cancels', async () => {
    vi.useFakeTimers();
    try {
      const throttle = createThrottle({ minIntervalMs: 60_000 });
      await throttle(async () => 'a');
      const ac = new AbortController();
      const p = throttle(async () => 'b', { signal: ac.signal });
      await vi.advanceTimersByTimeAsync(1);
      expect(vi.getTimerCount()).toBe(1); // the 60 s spacing sleep
      ac.abort(new Error('bye'));
      await expect(p).rejects.toThrow('bye');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('completes the default sleep normally when the signal never fires', async () => {
    const throttle = createThrottle({ minIntervalMs: 5 });
    const ac = new AbortController();
    await throttle(async () => 'a');
    await expect(throttle(async () => 'b', { signal: ac.signal })).resolves.toBe('b');
  });

  it('passes the call signal to an injected sleep', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    let t = 0;
    const throttle = createThrottle({
      minIntervalMs: 10,
      now: () => t,
      sleep: async (ms, signal) => {
        seen.push(signal);
        t += ms;
      },
    });
    const ac = new AbortController();
    await throttle(async () => 1);
    await throttle(async () => 2, { signal: ac.signal });
    expect(seen).toEqual([ac.signal]);
  });
});
