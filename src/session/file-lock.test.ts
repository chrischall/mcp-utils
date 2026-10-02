import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withFileLock, withFileLockSync } from './index.js';

/** A pid that is not running (ESRCH) on any machine this suite runs on. */
const DEAD_PID = 2 ** 22 + 12345;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let pending timers/microtasks run (the lock polls with real, tiny timers). */
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('withFileLock (freshbooks-mcp withRefreshLock, extracted)', () => {
  let dir: string;
  let lockPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-utils-lock-'));
    lockPath = join(dir, 'state.json.lock');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('serialises two critical sections on the same lock file', async () => {
    const order: string[] = [];
    const releaseA = deferred();
    const a = withFileLock(lockPath, async () => {
      order.push('a:start');
      await releaseA.promise;
      order.push('a:end');
      return 'a';
    }, { pollMs: 1 });
    await tick();
    const b = withFileLock(lockPath, async () => {
      order.push('b:start');
      return 'b';
    }, { pollMs: 1 });
    // B must still be waiting while A holds the lock.
    await tick(20);
    expect(order).toEqual(['a:start']);
    releaseA.resolve();
    expect(await a).toBe('a');
    expect(await b).toBe('b');
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lock when the critical section throws', async () => {
    await expect(
      withFileLock(lockPath, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('breaks a lock whose holder process is dead', async () => {
    writeFileSync(lockPath, `${DEAD_PID}:someone`);
    const result = await withFileLock(lockPath, async () => 'ran', { pollMs: 1 });
    expect(result).toBe('ran');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('breaks a lock held past staleMs even when the holder is alive', async () => {
    writeFileSync(lockPath, `${process.pid}:another-owner`);
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(lockPath, old, old);
    const result = await withFileLock(lockPath, async () => 'ran', { pollMs: 1, staleMs: 60_000 });
    expect(result).toBe('ran');
  });

  it('waits on a live, fresh lock rather than breaking it', async () => {
    writeFileSync(lockPath, `${process.pid}:another-owner`);
    let ran = false;
    const p = withFileLock(lockPath, async () => {
      ran = true;
    }, { pollMs: 1, staleMs: 60_000 });
    await tick(20);
    expect(ran).toBe(false);
    rmSync(lockPath); // the other holder releases
    await p;
    expect(ran).toBe(true);
  });

  it('does not remove a lock it no longer owns (broken as stale and re-taken)', async () => {
    await withFileLock(lockPath, async () => {
      // Someone broke our lock and took it over while we were working.
      writeFileSync(lockPath, `${process.pid}:the-new-owner`);
    });
    expect(readFileSync(lockPath, 'utf8')).toBe(`${process.pid}:the-new-owner`);
  });

  it('runs unlocked when the lock file cannot be created at all', async () => {
    if (process.getuid?.() === 0) return; // root ignores the permission bits
    const ro = join(dir, 'ro');
    mkdirSync(ro);
    chmodSync(ro, 0o500);
    try {
      expect(await withFileLock(join(ro, 'x.lock'), async () => 'ran')).toBe('ran');
    } finally {
      chmodSync(ro, 0o700);
    }
  });

  it('stops waiting when its signal aborts', async () => {
    writeFileSync(lockPath, `${process.pid}:another-owner`);
    const ac = new AbortController();
    let ran = false;
    const p = withFileLock(lockPath, async () => {
      ran = true;
    }, { pollMs: 1, signal: ac.signal });
    await tick();
    ac.abort(new Error('caller went away'));
    await expect(p).rejects.toThrow('caller went away');
    expect(ran).toBe(false);
    // The other holder's lock is untouched.
    expect(readFileSync(lockPath, 'utf8')).toBe(`${process.pid}:another-owner`);
  });
});

describe('withFileLockSync', () => {
  let dir: string;
  let lockPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-utils-lock-sync-'));
    lockPath = join(dir, 'store.json.lock');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('holds the lock for the duration of fn and removes it after', () => {
    const seen = withFileLockSync(lockPath, () => readFileSync(lockPath, 'utf8'));
    expect(seen.startsWith(`${process.pid}:`)).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('breaks a dead holder immediately', () => {
    writeFileSync(lockPath, `${DEAD_PID}:someone`);
    const started = Date.now();
    expect(withFileLockSync(lockPath, () => 'ran', { pollMs: 1 })).toBe('ran');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('waits out a live holder until it goes stale, then takes over', () => {
    writeFileSync(lockPath, `${process.pid}:another-owner`);
    const started = Date.now();
    expect(withFileLockSync(lockPath, () => 'ran', { pollMs: 2, staleMs: 60 })).toBe('ran');
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('releases on throw', () => {
    expect(() =>
      withFileLockSync(lockPath, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(existsSync(lockPath)).toBe(false);
  });
});
