import { describe, it, expect } from 'vitest';
import { createThrottle } from './throttle.js';

// A deterministic fake clock: `sleep` records the requested delay and advances
// the clock by it, so spacing math is exact and tests never wait real time.
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number): Promise<void> => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

describe('createThrottle', () => {
  it('runs the first task immediately with no spacing wait', async () => {
    const clock = fakeClock();
    const throttle = createThrottle({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
    const r = await throttle(async () => 42);
    expect(r).toBe(42);
    expect(clock.sleeps).toEqual([]);
  });

  it('spaces consecutive tasks by minIntervalMs', async () => {
    const clock = fakeClock();
    const throttle = createThrottle({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
    await throttle(async () => 'a');
    await throttle(async () => 'b');
    await throttle(async () => 'c');
    // First runs at t=0; each subsequent waits the full interval.
    expect(clock.sleeps).toEqual([1000, 1000]);
  });

  it('only waits the remaining interval when time already elapsed', async () => {
    const clock = fakeClock();
    const throttle = createThrottle({ minIntervalMs: 1000, now: clock.now, sleep: clock.sleep });
    await throttle(async () => 'a'); // runs at t=0
    clock.advance(600); // 600ms passed doing other work
    await throttle(async () => 'b'); // only needs 400ms more
    expect(clock.sleeps).toEqual([400]);
  });

  it('preserves submission order', async () => {
    const clock = fakeClock();
    const throttle = createThrottle({ minIntervalMs: 10, now: clock.now, sleep: clock.sleep });
    const order: number[] = [];
    await Promise.all([
      throttle(async () => order.push(1)),
      throttle(async () => order.push(2)),
      throttle(async () => order.push(3)),
    ]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('a failing task does not wedge the queue', async () => {
    const clock = fakeClock();
    const throttle = createThrottle({ minIntervalMs: 5, now: clock.now, sleep: clock.sleep });
    const boom = throttle(async () => {
      throw new Error('boom');
    });
    await expect(boom).rejects.toThrow('boom');
    const after = await throttle(async () => 'ok');
    expect(after).toBe('ok');
  });

  it('clamps a negative minIntervalMs to zero (no spacing waits)', async () => {
    const clock = fakeClock();
    const throttle = createThrottle({ minIntervalMs: -5, now: clock.now, sleep: clock.sleep });
    await throttle(async () => 'a');
    await throttle(async () => 'b');
    expect(clock.sleeps).toEqual([]);
  });

  it('defaults now/sleep so it works without injection', async () => {
    const throttle = createThrottle({ minIntervalMs: 0 });
    expect(await throttle(async () => 'real')).toBe('real');
  });
});
