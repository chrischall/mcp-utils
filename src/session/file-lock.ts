/**
 * An advisory, cross-process lock file — the read-modify-write guard that
 * several fleet servers hand-rolled around a shared state file.
 *
 * Why it exists: more than one process routinely shares a server's state file
 * (Claude Desktop beside a Claude Code session; two children of one `mcp-host`
 * registration on the same data dir). An atomic rename keeps the file from
 * tearing, but it does nothing for a read-modify-write: two writers each read
 * the old content and the second rename silently drops the first one's change.
 * For a credential that rotates on use, "dropped" means an account lockout.
 *
 * The reference implementation is freshbooks-mcp's `withRefreshLock`
 * (`src/auth.ts`, fleet-audit#1008): an `O_EXCL` lock file next to the state
 * file holding `<pid>:<uuid>`; a lock whose holder is dead, or that has been
 * held past `staleMs`, is broken rather than waited on forever; release is
 * owner-checked so a lock broken as stale and re-taken by someone else is not
 * removed out from under them. If the lock file cannot be created at all (an
 * unwritable directory) the critical section runs UNLOCKED — the state write
 * inside it fails the same way, and that failure is the one worth reporting.
 *
 * Advisory only: it coordinates processes that use it, nothing else.
 */

import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** Options for {@link withFileLock} and {@link withFileLockSync}. */
export interface FileLockOptions {
  /**
   * How long a held lock may be before a waiter breaks it even though its holder
   * is still alive. Defaults to 60 s for {@link withFileLock} (it is held across
   * a network round-trip — freshbooks' refresh) and 5 s for
   * {@link withFileLockSync} (held across one small file write, and a waiter
   * blocks the event loop).
   */
  staleMs?: number;
  /** Delay between attempts while another holder has the lock. Default 25 ms. */
  pollMs?: number;
  /**
   * {@link withFileLock} only: stop WAITING when this aborts, rejecting with its
   * reason. A critical section already entered is not interrupted.
   */
  signal?: AbortSignal;
}

const DEFAULT_POLL_MS = 25;

/** Whether the process named in a lock file is still running. */
function holderAlive(lockPath: string): boolean {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, 'utf8'), 10);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

type Attempt = 'acquired' | 'unlockable' | 'busy';

/** One acquisition attempt; breaks a dead or stale lock so the next attempt can win. */
function tryAcquire(lockPath: string, owner: string, staleMs: number): Attempt {
  try {
    const fd = openSync(lockPath, 'wx', 0o600);
    try {
      writeSync(fd, owner);
    } finally {
      closeSync(fd);
    }
    return 'acquired';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return 'unlockable';
  }
  let stale: boolean;
  try {
    stale = !holderAlive(lockPath) || Date.now() - statSync(lockPath).mtimeMs > staleMs;
  } catch {
    return 'busy'; // released between our open and stat — retry
  }
  if (stale) {
    try {
      unlinkSync(lockPath);
    } catch {
      /* someone else broke it first */
    }
  }
  return 'busy';
}

/** Remove the lock only if it is still ours — it may have been broken and re-taken. */
function release(lockPath: string, owner: string): void {
  try {
    if (readFileSync(lockPath, 'utf8') === owner) unlinkSync(lockPath);
  } catch {
    /* already gone */
  }
}

function prepare(lockPath: string): string {
  try {
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  } catch {
    /* fall through: openSync reports the real problem */
  }
  return `${process.pid}:${randomUUID()}`;
}

/**
 * Run `fn` holding the advisory lock at `lockPath` (conventionally
 * `<stateFile>.lock`), waiting for any other holder first.
 *
 * Waits are polled (`pollMs`) and bounded: a dead holder is broken at once, a
 * live one after `staleMs`. Pass `signal` to give up waiting early.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const staleMs = opts.staleMs ?? 60_000;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const { signal } = opts;
  const owner = prepare(lockPath);
  let held = false;
  for (;;) {
    signal?.throwIfAborted();
    const r = tryAcquire(lockPath, owner, staleMs);
    if (r === 'acquired') {
      held = true;
      break;
    }
    if (r === 'unlockable') break; // run unlocked: the write will report the real failure
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, pollMs);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
  try {
    return await fn();
  } finally {
    if (held) release(lockPath, owner);
  }
}

/** Block the thread for `ms` without spinning the CPU. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Synchronous form of {@link withFileLock}, for stores whose API is synchronous
 * ({@link SessionStore}). A waiter BLOCKS the thread between polls, so keep the
 * critical section to a file read and write — which is all it is meant for —
 * and note the shorter default `staleMs` (5 s).
 */
export function withFileLockSync<T>(lockPath: string, fn: () => T, opts: FileLockOptions = {}): T {
  const staleMs = opts.staleMs ?? 5_000;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const owner = prepare(lockPath);
  let held = false;
  for (;;) {
    const r = tryAcquire(lockPath, owner, staleMs);
    if (r === 'acquired') {
      held = true;
      break;
    }
    if (r === 'unlockable') break;
    sleepSync(pollMs);
  }
  try {
    return fn();
  } finally {
    if (held) release(lockPath, owner);
  }
}
