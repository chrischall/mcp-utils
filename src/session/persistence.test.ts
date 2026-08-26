import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  TokenManager,
  CookieSessionManager,
  createFileStatePersistence,
  resolveStateDir,
  type BearerTokens,
  type StatePersistence,
} from './index.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function clock(startMs = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = startMs;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/** In-memory persistence double that records every call. */
function memory<T>(seed: T | null = null): StatePersistence<T> & {
  saves: T[];
  loads: number;
  cleared: number;
  value: T | null;
} {
  const api = {
    value: seed,
    saves: [] as T[],
    loads: 0,
    cleared: 0,
    load(): T | null {
      api.loads += 1;
      return api.value;
    },
    save(state: T): void {
      api.saves.push(state);
      api.value = state;
    },
    clear(): void {
      api.cleared += 1;
      api.value = null;
    },
  };
  return api;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-utils-persist-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// TokenManager — lazy bootstrap + persistence
// ===========================================================================

describe('TokenManager persistence', () => {
  const refreshNever = async (): Promise<never> => {
    throw new Error('refresh should not have been called');
  };

  it('keeps eager `initial` behaviour unchanged when no persistence is given', async () => {
    const mgr = new TokenManager({
      initial: { accessToken: 'a1', expiresAt: Date.now() + 3_600_000 },
      refresh: refreshNever,
    });
    expect(await mgr.getAccessToken()).toBe('a1');
  });

  it('uses a persisted, still-valid token instead of running the bootstrap login', async () => {
    const c = clock();
    let logins = 0;
    const store = memory<BearerTokens>({ accessToken: 'stored', expiresAt: c.now() + 3_600_000 });
    const mgr = new TokenManager({
      initial: async () => {
        logins += 1;
        return { accessToken: 'fresh', expiresAt: c.now() + 3_600_000 };
      },
      refresh: refreshNever,
      persistence: store,
      now: c.now,
    });
    expect(await mgr.getAccessToken()).toBe('stored');
    expect(logins).toBe(0); // the whole point: no login ran
  });

  it('runs the bootstrap login when persistence is empty', async () => {
    const c = clock();
    let logins = 0;
    const store = memory<BearerTokens>(null);
    const mgr = new TokenManager({
      initial: async () => {
        logins += 1;
        return { accessToken: 'fresh', expiresAt: c.now() + 3_600_000 };
      },
      refresh: refreshNever,
      persistence: store,
      now: c.now,
    });
    expect(await mgr.getAccessToken()).toBe('fresh');
    expect(logins).toBe(1);
    expect(store.saves).toEqual([{ accessToken: 'fresh', expiresAt: c.now() + 3_600_000 }]);
  });

  it('runs the bootstrap login when the persisted token is expired and has no refresh token', async () => {
    const c = clock();
    let logins = 0;
    const store = memory<BearerTokens>({ accessToken: 'stale', expiresAt: c.now() - 1 });
    const mgr = new TokenManager({
      initial: async () => {
        logins += 1;
        return { accessToken: 'fresh', expiresAt: c.now() + 3_600_000 };
      },
      refresh: refreshNever,
      persistence: store,
      now: c.now,
    });
    expect(await mgr.getAccessToken()).toBe('fresh');
    expect(logins).toBe(1);
  });

  it('refreshes an expired persisted token rather than re-running the login', async () => {
    const c = clock();
    let logins = 0;
    let refreshes = 0;
    const store = memory<BearerTokens>({
      accessToken: 'stale',
      refreshToken: 'r1',
      expiresAt: c.now() - 1,
    });
    const mgr = new TokenManager({
      initial: async () => {
        logins += 1;
        return { accessToken: 'fresh', expiresAt: c.now() + 3_600_000 };
      },
      refresh: async (rt) => {
        refreshes += 1;
        expect(rt).toBe('r1');
        return { accessToken: 'refreshed', refreshToken: 'r2', expiresAt: c.now() + 3_600_000 };
      },
      persistence: store,
      now: c.now,
    });
    expect(await mgr.getAccessToken()).toBe('refreshed');
    expect(refreshes).toBe(1);
    expect(logins).toBe(0); // a refresh is cheap; a login is what we are avoiding
  });

  it('persists rotated tokens after a refresh', async () => {
    const c = clock();
    const store = memory<BearerTokens>(null);
    const mgr = new TokenManager({
      initial: { accessToken: 'a1', refreshToken: 'r1', expiresAt: c.now() + 3_600_000 },
      refresh: async () => ({
        accessToken: 'a2',
        refreshToken: 'r2',
        expiresAt: c.now() + 7_200_000,
      }),
      persistence: store,
      now: c.now,
    });
    await mgr.refreshNow();
    expect(store.saves.at(-1)).toEqual({
      accessToken: 'a2',
      refreshToken: 'r2',
      expiresAt: c.now() + 7_200_000,
    });
  });

  it('a burst of first calls coalesces onto ONE bootstrap login', async () => {
    const c = clock();
    let logins = 0;
    let release!: (t: BearerTokens) => void;
    const mgr = new TokenManager({
      initial: () => {
        logins += 1;
        return new Promise<BearerTokens>((r) => {
          release = r;
        });
      },
      refresh: refreshNever,
      persistence: memory<BearerTokens>(null),
      now: c.now,
    });
    const all = Promise.all([mgr.getAccessToken(), mgr.getAccessToken(), mgr.getAccessToken()]);
    // The bootstrap path awaits persistence before the login, so let the
    // microtask queue drain rather than counting ticks.
    await new Promise((r) => setTimeout(r, 0));
    release({ accessToken: 'once', expiresAt: c.now() + 3_600_000 });
    expect(await all).toEqual(['once', 'once', 'once']);
    expect(logins).toBe(1); // a rate-limited login endpoint must see exactly one
  });

  it('falls back to the bootstrap login when a persisted refresh token is rejected', async () => {
    const c = clock();
    let logins = 0;
    const store = memory<BearerTokens>({
      accessToken: 'stale',
      refreshToken: 'revoked',
      expiresAt: c.now() - 1,
    });
    const mgr = new TokenManager({
      initial: async () => {
        logins += 1;
        return { accessToken: 'fresh', expiresAt: c.now() + 3_600_000 };
      },
      refresh: async () => {
        throw new Error('invalid_grant');
      },
      persistence: store,
      now: c.now,
    });
    // A revoked stored token must not brick the server forever.
    expect(await mgr.getAccessToken()).toBe('fresh');
    expect(logins).toBe(1);
  });

  it('surfaces a refresh failure when there is no bootstrap login to fall back to', async () => {
    const c = clock();
    const mgr = new TokenManager({
      initial: { accessToken: 'a1', refreshToken: 'r1', expiresAt: c.now() - 1 },
      refresh: async () => {
        throw new Error('invalid_grant');
      },
      now: c.now,
    });
    await expect(mgr.getAccessToken()).rejects.toThrow('invalid_grant');
  });

  it('ignores a persisted record of the wrong shape', async () => {
    const c = clock();
    let logins = 0;
    const store = memory<BearerTokens>({ nonsense: true } as unknown as BearerTokens);
    const mgr = new TokenManager({
      initial: async () => {
        logins += 1;
        return { accessToken: 'fresh', expiresAt: c.now() + 3_600_000 };
      },
      refresh: refreshNever,
      persistence: store,
      now: c.now,
    });
    expect(await mgr.getAccessToken()).toBe('fresh');
    expect(logins).toBe(1);
  });

  it('a throwing load() degrades to the bootstrap login', async () => {
    const c = clock();
    const store: StatePersistence<BearerTokens> = {
      load: () => {
        throw new Error('EACCES');
      },
      save: () => {},
    };
    const mgr = new TokenManager({
      initial: async () => ({ accessToken: 'fresh', expiresAt: c.now() + 3_600_000 }),
      refresh: refreshNever,
      persistence: store,
      now: c.now,
    });
    expect(await mgr.getAccessToken()).toBe('fresh');
  });

  it('a throwing save() does not fail the request', async () => {
    const c = clock();
    const store: StatePersistence<BearerTokens> = {
      load: () => null,
      save: () => {
        throw new Error('EROFS');
      },
    };
    const mgr = new TokenManager({
      initial: async () => ({ accessToken: 'fresh', expiresAt: c.now() + 3_600_000 }),
      refresh: refreshNever,
      persistence: store,
      now: c.now,
    });
    // The token is valid in this process even though it could not be written.
    expect(await mgr.getAccessToken()).toBe('fresh');
  });

  it('a failed bootstrap does not stick — the next call retries', async () => {
    const c = clock();
    let logins = 0;
    const mgr = new TokenManager({
      initial: async () => {
        logins += 1;
        if (logins === 1) throw new Error('network blip');
        return { accessToken: 'second', expiresAt: c.now() + 3_600_000 };
      },
      refresh: refreshNever,
      persistence: memory<BearerTokens>(null),
      now: c.now,
    });
    await expect(mgr.getAccessToken()).rejects.toThrow('network blip');
    expect(await mgr.getAccessToken()).toBe('second');
  });

  it('withAuth bootstraps lazily and still replays exactly once on 401', async () => {
    const c = clock();
    let logins = 0;
    const calls: string[] = [];
    const mgr = new TokenManager({
      initial: async () => {
        logins += 1;
        return { accessToken: 'a1', refreshToken: 'r1', expiresAt: c.now() + 3_600_000 };
      },
      refresh: async () => ({ accessToken: 'a2', expiresAt: c.now() + 3_600_000 }),
      persistence: memory<BearerTokens>(null),
      now: c.now,
    });
    const res = await mgr.withAuth(async (tok) => {
      calls.push(tok);
      return new Response(null, { status: calls.length === 1 ? 401 : 200 });
    });
    expect(res.status).toBe(200);
    expect(calls).toEqual(['a1', 'a2']);
    expect(logins).toBe(1);
  });
});

// ===========================================================================
// CookieSessionManager — persistence
// ===========================================================================

interface Sess extends Record<string, unknown> {
  cookieHeader: string;
}

describe('CookieSessionManager persistence', () => {
  it('uses a persisted session instead of logging in', async () => {
    const c = clock();
    let logins = 0;
    const store = memory<{ session: Sess; sessionAt: number }>({
      session: { cookieHeader: 'stored' },
      sessionAt: c.now(),
    });
    const mgr = new CookieSessionManager<Sess>({
      login: async () => {
        logins += 1;
        return { cookieHeader: 'fresh' };
      },
      persistence: store,
      now: c.now,
    });
    expect((await mgr.ensure()).cookieHeader).toBe('stored');
    expect(logins).toBe(0);
  });

  it('persists a session after a successful login', async () => {
    const c = clock();
    const store = memory<{ session: Sess; sessionAt: number }>(null);
    const mgr = new CookieSessionManager<Sess>({
      login: async () => ({ cookieHeader: 's1' }),
      persistence: store,
      now: c.now,
    });
    await mgr.ensure();
    expect(store.saves).toEqual([{ session: { cookieHeader: 's1' }, sessionAt: c.now() }]);
  });

  it('persists a seeded session', async () => {
    const c = clock();
    const store = memory<{ session: Sess; sessionAt: number }>(null);
    const mgr = new CookieSessionManager<Sess>({
      login: async () => ({ cookieHeader: 's1' }),
      persistence: store,
      now: c.now,
    });
    mgr.seed({ cookieHeader: 'seeded' });
    // seed() is synchronous by contract but its write is queued (writes are
    // ordered so an async backend cannot land a save after a later clear), so
    // let the queue drain before asserting.
    await new Promise((r) => setTimeout(r, 0));
    expect(store.saves.at(-1)).toEqual({
      session: { cookieHeader: 'seeded' },
      sessionAt: c.now(),
    });
  });

  it('ignores a persisted session that is already past maxAgeMs', async () => {
    const c = clock();
    let logins = 0;
    const store = memory<{ session: Sess; sessionAt: number }>({
      session: { cookieHeader: 'stored' },
      sessionAt: c.now() - 6 * 60 * 60 * 1000,
    });
    const mgr = new CookieSessionManager<Sess>({
      login: async () => {
        logins += 1;
        return { cookieHeader: 'fresh' };
      },
      maxAgeMs: 5 * 60 * 60 * 1000,
      persistence: store,
      now: c.now,
    });
    expect((await mgr.ensure()).cookieHeader).toBe('fresh');
    expect(logins).toBe(1);
  });

  it('clears persisted state on invalidate, so an expired session is not reloaded', async () => {
    const c = clock();
    let logins = 0;
    const store = memory<{ session: Sess; sessionAt: number }>({
      session: { cookieHeader: 'stored' },
      sessionAt: c.now(),
    });
    const mgr = new CookieSessionManager<Sess>({
      login: async () => {
        logins += 1;
        return { cookieHeader: `s${logins}` };
      },
      persistence: store,
      now: c.now,
    });
    expect((await mgr.ensure()).cookieHeader).toBe('stored');
    mgr.invalidate();
    // Without a clear(), ensure() would read 'stored' straight back off disk and
    // loop on the very expiry that caused the invalidate.
    expect((await mgr.ensure()).cookieHeader).toBe('s1');
    expect(store.cleared).toBe(1);
  });

  it('ignores a persisted record of the wrong shape', async () => {
    const c = clock();
    let logins = 0;
    const store = memory({ nope: 1 } as unknown as { session: Sess; sessionAt: number });
    const mgr = new CookieSessionManager<Sess>({
      login: async () => {
        logins += 1;
        return { cookieHeader: 'fresh' };
      },
      persistence: store,
      now: c.now,
    });
    expect((await mgr.ensure()).cookieHeader).toBe('fresh');
    expect(logins).toBe(1);
  });

  it('a throwing load() degrades to a login', async () => {
    const c = clock();
    const mgr = new CookieSessionManager<Sess>({
      login: async () => ({ cookieHeader: 'fresh' }),
      persistence: {
        load: () => {
          throw new Error('EACCES');
        },
        save: () => {},
      },
      now: c.now,
    });
    expect((await mgr.ensure()).cookieHeader).toBe('fresh');
  });

  it('a throwing save() does not fail the login', async () => {
    const c = clock();
    const mgr = new CookieSessionManager<Sess>({
      login: async () => ({ cookieHeader: 'fresh' }),
      persistence: {
        load: () => null,
        save: () => {
          throw new Error('EROFS');
        },
      },
      now: c.now,
    });
    expect((await mgr.ensure()).cookieHeader).toBe('fresh');
  });

  it('reads persistence at most once — a hit is not re-read on every ensure', async () => {
    const c = clock();
    const store = memory<{ session: Sess; sessionAt: number }>({
      session: { cookieHeader: 'stored' },
      sessionAt: c.now(),
    });
    const mgr = new CookieSessionManager<Sess>({
      login: async () => ({ cookieHeader: 'fresh' }),
      persistence: store,
      now: c.now,
    });
    await mgr.ensure();
    await mgr.ensure();
    await mgr.ensure();
    expect(store.loads).toBe(1);
  });
});

// ===========================================================================
// createFileStatePersistence
// ===========================================================================

describe('createFileStatePersistence', () => {
  it('round-trips a record', () => {
    const file = join(dir, 'nested', 'tokens.json');
    const p = createFileStatePersistence<BearerTokens>({ filePath: file });
    expect(p.load()).toBeNull();
    p.save({ accessToken: 'a1', refreshToken: 'r1', expiresAt: 123 });
    expect(createFileStatePersistence<BearerTokens>({ filePath: file }).load()).toEqual({
      accessToken: 'a1',
      refreshToken: 'r1',
      expiresAt: 123,
    });
  });

  it('writes the file 0600 and its directory 0700', () => {
    const file = join(dir, 'nested', 'tokens.json');
    createFileStatePersistence<BearerTokens>({ filePath: file }).save({
      accessToken: 'a1',
      expiresAt: 1,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700);
  });

  it('tightens a pre-existing world-readable file before writing secrets into it', () => {
    const file = join(dir, 'tokens.json');
    writeFileSync(file, '{}');
    chmodSync(file, 0o644);
    createFileStatePersistence<BearerTokens>({ filePath: file }).save({
      accessToken: 'secret',
      expiresAt: 1,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('returns null for corrupt JSON instead of throwing', () => {
    const file = join(dir, 'tokens.json');
    writeFileSync(file, '{ not json', { mode: 0o600 });
    expect(createFileStatePersistence<BearerTokens>({ filePath: file }).load()).toBeNull();
  });

  it('applies an optional validate() and rejects a record that fails it', () => {
    const file = join(dir, 'tokens.json');
    writeFileSync(file, JSON.stringify({ accessToken: 42 }), { mode: 0o600 });
    const p = createFileStatePersistence<BearerTokens>({
      filePath: file,
      validate: (raw) =>
        raw !== null && typeof raw === 'object' && typeof (raw as BearerTokens).accessToken === 'string'
          ? (raw as BearerTokens)
          : null,
    });
    expect(p.load()).toBeNull();
  });

  it('never leaves a partially-written file behind (atomic replace)', () => {
    const file = join(dir, 'tokens.json');
    const p = createFileStatePersistence<BearerTokens>({ filePath: file });
    p.save({ accessToken: 'first', expiresAt: 1 });
    p.save({ accessToken: 'second', expiresAt: 2 });
    // A torn write would leave trailing bytes of the longer previous body.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ accessToken: 'second', expiresAt: 2 });
  });

  it('does not throw when the destination cannot be written', () => {
    // A path whose parent is a FILE — mkdir and write both fail.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    const p = createFileStatePersistence<BearerTokens>({ filePath: join(blocker, 'tokens.json') });
    expect(() => p.save({ accessToken: 'a1', expiresAt: 1 })).not.toThrow();
    expect(p.load()).toBeNull();
  });

  it('clear() removes the file and is a no-op when it is already gone', () => {
    const file = join(dir, 'tokens.json');
    const p = createFileStatePersistence<BearerTokens>({ filePath: file });
    p.save({ accessToken: 'a1', expiresAt: 1 });
    p.clear();
    expect(p.load()).toBeNull();
    expect(() => p.clear()).not.toThrow();
  });
});

// ===========================================================================
// resolveStateDir
// ===========================================================================

describe('resolveStateDir', () => {
  it('prefers MCP_DATA_DIR — the variable mcp-host injects', () => {
    expect(resolveStateDir({ env: { MCP_DATA_DIR: '/data', HOME: '/home/u' } })).toBe('/data');
  });

  it('falls back to HOME', () => {
    expect(resolveStateDir({ env: { HOME: '/home/u' } })).toBe('/home/u');
  });

  it('ignores a placeholder/blank MCP_DATA_DIR', () => {
    expect(resolveStateDir({ env: { MCP_DATA_DIR: '   ', HOME: '/home/u' } })).toBe('/home/u');
    expect(resolveStateDir({ env: { MCP_DATA_DIR: '${MCP_DATA_DIR}', HOME: '/home/u' } })).toBe(
      '/home/u',
    );
  });

  it('joins a service-scoped subdirectory when asked', () => {
    expect(resolveStateDir({ env: { MCP_DATA_DIR: '/data' }, subdir: '.skylight-mcp' })).toBe(
      '/data/.skylight-mcp',
    );
  });

  it('falls back to the OS home directory when neither is set', () => {
    expect(resolveStateDir({ env: {} })).toBe(homedir());
  });
});

// ---------------------------------------------------------------------------
// Regression tests for the auto-review findings on PR #137
// ---------------------------------------------------------------------------

describe('TokenManager persistence — once-per-process read', () => {
  it('reads persistence at most once', async () => {
    const c = clock();
    const store = memory<BearerTokens>({ accessToken: 'stored', expiresAt: c.now() + 3_600_000 });
    const mgr = new TokenManager({
      initial: async () => ({ accessToken: 'fresh', expiresAt: c.now() + 3_600_000 }),
      refresh: async () => {
        throw new Error('no');
      },
      persistence: store,
      now: c.now,
    });
    await mgr.getAccessToken();
    await mgr.getAccessToken();
    await mgr.getAccessToken();
    expect(store.loads).toBe(1);
  });

  it('recovers from a revoked refresh token even when clear() is ABSENT', async () => {
    const c = clock();
    let logins = 0;
    // `clear` is optional on StatePersistence. Without a once-only read guard the
    // recovery path reloads this same revoked record and the failure loops.
    const store: StatePersistence<BearerTokens> = {
      load: () => ({ accessToken: 'revoked', refreshToken: 'bad', expiresAt: c.now() - 1 }),
      save: () => {},
    };
    const mgr = new TokenManager({
      initial: async () => {
        logins += 1;
        return { accessToken: 'fresh', expiresAt: c.now() + 3_600_000 };
      },
      refresh: async () => {
        throw new Error('invalid_grant');
      },
      persistence: store,
      now: c.now,
    });
    expect(await mgr.getAccessToken()).toBe('fresh');
    expect(logins).toBe(1);
  });

  it('recovers from a revoked refresh token even when clear() FAILS', async () => {
    const c = clock();
    let logins = 0;
    const store: StatePersistence<BearerTokens> = {
      load: () => ({ accessToken: 'revoked', refreshToken: 'bad', expiresAt: c.now() - 1 }),
      save: () => {},
      clear: () => {
        throw new Error('EROFS');
      },
    };
    const mgr = new TokenManager({
      initial: async () => {
        logins += 1;
        return { accessToken: 'fresh', expiresAt: c.now() + 3_600_000 };
      },
      refresh: async () => {
        throw new Error('invalid_grant');
      },
      persistence: store,
      now: c.now,
    });
    expect(await mgr.getAccessToken()).toBe('fresh');
    expect(logins).toBe(1);
  });

  it('withAuth re-mints via the bootstrap when a 401 refresh is rejected', async () => {
    const c = clock();
    let logins = 0;
    const seen: string[] = [];
    const mgr = new TokenManager({
      initial: async () => {
        logins += 1;
        return { accessToken: `a${logins}`, refreshToken: 'bad', expiresAt: c.now() + 3_600_000 };
      },
      refresh: async () => {
        throw new Error('invalid_grant');
      },
      persistence: memory<BearerTokens>(null),
      now: c.now,
    });
    const res = await mgr.withAuth(async (tok) => {
      seen.push(tok);
      return new Response(null, { status: seen.length === 1 ? 401 : 200 });
    });
    // Same revoked credential as getAccessToken's path — same outcome, not a throw.
    expect(res.status).toBe(200);
    expect(seen).toEqual(['a1', 'a2']);
    expect(logins).toBe(2);
  });
});

describe('CookieSessionManager persistence — shape guard', () => {
  it('rejects a persisted record whose session is a primitive', async () => {
    const c = clock();
    let logins = 0;
    const store = memory({ session: 'not-an-object', sessionAt: c.now() } as unknown as {
      session: Sess;
      sessionAt: number;
    });
    const mgr = new CookieSessionManager<Sess>({
      login: async () => {
        logins += 1;
        return { cookieHeader: 'fresh' };
      },
      persistence: store,
      now: c.now,
    });
    expect((await mgr.ensure()).cookieHeader).toBe('fresh');
    expect(logins).toBe(1);
  });

  it('orders fire-and-forget writes, so a save cannot land after a clear', async () => {
    const c = clock();
    const ops: string[] = [];
    let stored: unknown = null;
    const mgr = new CookieSessionManager<Sess>({
      login: async () => ({ cookieHeader: 'x' }),
      persistence: {
        load: () => null,
        // An async backend: a slow save must not overtake the clear that follows it.
        save: async (s) => {
          await new Promise((r) => setTimeout(r, 10));
          ops.push('save');
          stored = s;
        },
        clear: async () => {
          ops.push('clear');
          stored = null;
        },
      },
      now: c.now,
    });
    mgr.seed({ cookieHeader: 'seeded' });
    mgr.invalidate();
    await new Promise((r) => setTimeout(r, 50));
    expect(ops).toEqual(['save', 'clear']);
    expect(stored).toBeNull(); // an invalidated session must not survive on disk
  });
});

describe('createFileStatePersistence — directory permissions', () => {
  it('does not re-permission a directory it did not create', () => {
    // resolveStateDir() with no subdir is $HOME; chmodding that to 0700 would be
    // an invasive side effect of writing one token file.
    const file = join(dir, 'tokens.json');
    chmodSync(dir, 0o755);
    createFileStatePersistence<BearerTokens>({ filePath: file }).save({
      accessToken: 'a1',
      expiresAt: 1,
    });
    expect(statSync(dir).mode & 0o777).toBe(0o755);
    expect(statSync(file).mode & 0o777).toBe(0o600); // the file is still hardened
  });
});

describe('resolveStateDir — env hardening', () => {
  it('ignores the "null" and "undefined" sentinels', () => {
    // MCP_DATA_DIR=null would otherwise be a RELATIVE "./null" directory: tokens
    // land under the process cwd and silently stop surviving restarts.
    expect(resolveStateDir({ env: { MCP_DATA_DIR: 'null', HOME: '/home/u' } })).toBe('/home/u');
    expect(resolveStateDir({ env: { MCP_DATA_DIR: 'undefined', HOME: '/home/u' } })).toBe('/home/u');
    expect(resolveStateDir({ env: { MCP_DATA_DIR: 'null', HOME: 'undefined' } })).toBe(homedir());
  });

  it('trims surrounding whitespace like readEnvVar does', () => {
    expect(resolveStateDir({ env: { MCP_DATA_DIR: '  /data  ' } })).toBe('/data');
  });
});
