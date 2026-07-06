import { describe, expect, it } from 'vitest';

import { CookieSessionManager } from './index.js';

interface Sess {
  cookieHeader: string;
}

function clock(startMs = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = startMs;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('CookieSessionManager maxAgeMs', () => {
  it('re-logs-in when the session is older than maxAgeMs', async () => {
    const c = clock();
    let logins = 0;
    const mgr = new CookieSessionManager<Sess>({
      login: async () => ({ cookieHeader: `s${++logins}` }),
      maxAgeMs: 5 * 60 * 60 * 1000, // the IC 5h TTL
      now: c.now,
    });
    expect((await mgr.ensure()).cookieHeader).toBe('s1');
    c.advance(4 * 60 * 60 * 1000);
    expect((await mgr.ensure()).cookieHeader).toBe('s1'); // still fresh
    c.advance(2 * 60 * 60 * 1000); // now 6h old
    expect((await mgr.ensure()).cookieHeader).toBe('s2'); // stale → re-login
    expect(logins).toBe(2);
  });

  it('a TTL-stale burst coalesces onto ONE re-login', async () => {
    const c = clock();
    let logins = 0;
    let release!: (s: Sess) => void;
    const mgr = new CookieSessionManager<Sess>({
      login: async () => {
        logins += 1;
        if (logins === 1) return { cookieHeader: 's1' };
        return new Promise<Sess>((r) => {
          release = r;
        });
      },
      maxAgeMs: 1000,
      now: c.now,
    });
    await mgr.ensure();
    c.advance(2000);
    const p1 = mgr.ensure();
    const p2 = mgr.ensure();
    release({ cookieHeader: 's2' });
    expect((await p1).cookieHeader).toBe('s2');
    expect((await p2).cookieHeader).toBe('s2');
    expect(logins).toBe(2);
  });

  it('without maxAgeMs a session never goes stale by age', async () => {
    const c = clock();
    let logins = 0;
    const mgr = new CookieSessionManager<Sess>({
      login: async () => ({ cookieHeader: `s${++logins}` }),
      now: c.now,
    });
    await mgr.ensure();
    c.advance(365 * 24 * 60 * 60 * 1000);
    expect((await mgr.ensure()).cookieHeader).toBe('s1');
  });
});

describe('CookieSessionManager seed()', () => {
  it('installs a session without running login', async () => {
    let logins = 0;
    const mgr = new CookieSessionManager<Sess>({
      login: async () => ({ cookieHeader: `login${++logins}` }),
    });
    mgr.seed({ cookieHeader: 'seeded' });
    expect((await mgr.ensure()).cookieHeader).toBe('seeded');
    expect(logins).toBe(0);
  });

  it('a login already in flight does NOT overwrite a seeded session when it settles', async () => {
    let release!: (s: Sess) => void;
    const mgr = new CookieSessionManager<Sess>({
      login: async () =>
        new Promise<Sess>((r) => {
          release = r;
        }),
    });
    const inFlight = mgr.ensure(); // starts the slow login
    mgr.seed({ cookieHeader: 'seeded' });
    release({ cookieHeader: 'late-login' });
    await inFlight; // the in-flight waiter still gets its result…
    expect(mgr.current?.cookieHeader).toBe('seeded'); // …but state keeps the seed
    expect((await mgr.ensure()).cookieHeader).toBe('seeded');
  });

  it('a seeded session gets a fresh maxAgeMs clock', async () => {
    const c = clock();
    let logins = 0;
    const mgr = new CookieSessionManager<Sess>({
      login: async () => ({ cookieHeader: `login${++logins}` }),
      maxAgeMs: 1000,
      now: c.now,
    });
    await mgr.ensure(); // login1 at t0
    c.advance(900);
    mgr.seed({ cookieHeader: 'seeded' }); // re-stamps freshness at t900
    c.advance(900); // t1800: login1 would be stale, seed is only 900ms old
    expect((await mgr.ensure()).cookieHeader).toBe('seeded');
    c.advance(200); // seed now 1100ms old → stale
    expect((await mgr.ensure()).cookieHeader).toBe('login2');
  });
});

describe('CookieSessionManager onReplayLoginError', () => {
  const expiredRes = { status: 401 } as unknown as Response;
  const okRes = { status: 200 } as unknown as Response;

  it('receives the re-login error while the original response is still returned', async () => {
    let logins = 0;
    const seen: unknown[] = [];
    const mgr = new CookieSessionManager<Sess>({
      login: async () => {
        logins += 1;
        if (logins === 1) return { cookieHeader: 's1' };
        throw new Error('fetchproxy bridge down — open a signed-in tab');
      },
      isExpired: (res) => res.status === 401,
      onReplayLoginError: (err) => {
        seen.push(err);
      },
    });
    const res = await mgr.withSession(async () => expiredRes);
    expect(res).toBe(expiredRes); // default behavior preserved
    expect(seen).toHaveLength(1);
    expect((seen[0] as Error).message).toContain('bridge down');
  });

  it('a throwing callback surfaces the re-login error instead of the stale response', async () => {
    let logins = 0;
    const mgr = new CookieSessionManager<Sess>({
      login: async () => {
        logins += 1;
        if (logins === 1) return { cookieHeader: 's1' };
        throw new Error('login rejected');
      },
      isExpired: (res) => res.status === 401,
      onReplayLoginError: (err) => {
        throw err;
      },
    });
    await expect(mgr.withSession(async () => expiredRes)).rejects.toThrow('login rejected');
  });

  it('is not called on a successful replay', async () => {
    let calls = 0;
    let requests = 0;
    const mgr = new CookieSessionManager<Sess>({
      login: async () => ({ cookieHeader: 's' }),
      isExpired: (res) => res.status === 401,
      onReplayLoginError: () => {
        calls += 1;
      },
    });
    const res = await mgr.withSession(async () => (++requests === 1 ? expiredRes : okRes));
    expect(res).toBe(okRes);
    expect(calls).toBe(0);
  });
});

describe('CookieSessionManager seed() vs a cached permanent error (PR #69 follow-up)', () => {
  it('a seeded session is served even when a permanent login error is cached', async () => {
    const mgr = new CookieSessionManager<Sess>({
      login: async () => {
        throw new Error('SETLIST_USERNAME is not set');
      },
      isPermanentError: () => true,
    });
    await expect(mgr.ensure()).rejects.toThrow('is not set');
    mgr.seed({ cookieHeader: 'seeded' });
    expect((await mgr.ensure()).cookieHeader).toBe('seeded'); // seed bypasses the cache
  });

  it('once the seed goes stale, the cached permanent error is rethrown (login is still misconfigured)', async () => {
    const c = clock();
    const mgr = new CookieSessionManager<Sess>({
      login: async () => {
        throw new Error('no creds');
      },
      isPermanentError: () => true,
      maxAgeMs: 1000,
      now: c.now,
    });
    await expect(mgr.ensure()).rejects.toThrow('no creds');
    mgr.seed({ cookieHeader: 'seeded' });
    await mgr.ensure();
    c.advance(2000); // seed stale → falls through to the cached permanent error
    await expect(mgr.ensure()).rejects.toThrow('no creds');
  });
});
