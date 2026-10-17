/**
 * fleet-audit#1305: microsoft-teams-mcp `chatsvc.ts` `#tokenManager` (the
 * reference; copied into `sharepoint.ts` / `substrate.ts`) and
 * office-outlook-mcp `client.ts` build the same TokenManager over a token
 * captured from the browser: no refresh grant, so "refresh" means re-capture
 * (a sentinel refresh token makes TokenManager call it), a JWT's `exp` or a
 * short fallback TTL, a cache that never holds an operator-supplied token,
 * and a directly supplied token that is NEVER silently swapped for whichever
 * account a browser tab is signed into.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  RECAPTURE_SENTINEL,
  UNKNOWN_CAPTURED_TOKEN_TTL_MS,
  capturedBearerTokens,
  createCapturedTokenManager,
  isBearerTokens,
  type BearerTokens,
  type SyncStatePersistence,
} from './index.js';

function jwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(claims)}.sig`;
}

const NOW = 1_700_000_000_000;
const ok = () => new Response('{}', { status: 200 });
const unauthorized = () => new Response('{}', { status: 401 });

function memoryStore(initial: BearerTokens | null = null): SyncStatePersistence<BearerTokens> & { saved: BearerTokens[] } {
  let value = initial;
  const saved: BearerTokens[] = [];
  return {
    saved,
    load: () => value,
    save: (t) => {
      saved.push(t);
      value = t;
    },
    clear: () => {
      value = null;
    },
  };
}

describe('capturedBearerTokens', () => {
  it("expires a JWT at its own exp claim, with the recapture sentinel as refresh token", () => {
    const token = jwt({ exp: NOW / 1000 + 3600 });
    expect(capturedBearerTokens(token, { now: () => NOW })).toEqual({
      accessToken: token,
      refreshToken: RECAPTURE_SENTINEL,
      expiresAt: NOW + 3_600_000,
    });
  });

  it('gives an opaque token the short fallback lifetime (being wrong costs one 401-and-replay)', () => {
    expect(capturedBearerTokens('opaque', { now: () => NOW }).expiresAt).toBe(NOW + UNKNOWN_CAPTURED_TOKEN_TTL_MS);
    expect(UNKNOWN_CAPTURED_TOKEN_TTL_MS).toBe(10 * 60 * 1000);
    expect(capturedBearerTokens('opaque', { now: () => NOW, unknownTtlMs: 5 }).expiresAt).toBe(NOW + 5);
  });

  it('uses the recapture sentinel teams and outlook both chose', () => {
    expect(RECAPTURE_SENTINEL).toBe('fetchproxy:recapture');
  });
});

describe('isBearerTokens', () => {
  it('accepts a token record and rejects anything else (the per-repo isToken validator)', () => {
    expect(isBearerTokens({ accessToken: 'a', expiresAt: 1 })).toBe(true);
    expect(isBearerTokens({ accessToken: 'a', expiresAt: 1, refreshToken: 'r' })).toBe(true);
    expect(isBearerTokens({ accessToken: '', expiresAt: 1 })).toBe(false);
    expect(isBearerTokens({ accessToken: 'a', expiresAt: '1' })).toBe(false);
    expect(isBearerTokens({ accessToken: 'a', expiresAt: 1, refreshToken: 2 })).toBe(false);
    expect(isBearerTokens(null)).toBe(false);
  });
});

describe('createCapturedTokenManager', () => {
  it('captures on first use, once, and serves the captured token', async () => {
    const capture = vi.fn(async () => 'captured-1');
    const tm = createCapturedTokenManager({ capture, onDirectRejected: () => new Error('n/a'), now: () => NOW });
    expect(capture).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([tm.getAccessToken(), tm.getAccessToken()]);
    expect([a, b]).toEqual(['captured-1', 'captured-1']);
    expect(capture).toHaveBeenCalledOnce();
  });

  it('re-captures on a 401 and replays once', async () => {
    const capture = vi.fn().mockResolvedValueOnce('first').mockResolvedValueOnce('second');
    const tm = createCapturedTokenManager({ capture, onDirectRejected: () => new Error('n/a'), now: () => NOW });
    const seen: string[] = [];
    const res = await tm.withAuth(async (t) => {
      seen.push(t);
      return t === 'first' ? unauthorized() : ok();
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual(['first', 'second']);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it('serves a directly supplied token without ever capturing', async () => {
    const capture = vi.fn(async () => 'browser');
    const tm = createCapturedTokenManager({ capture, direct: 'operator-token', onDirectRejected: () => new Error('n/a') });
    expect(await tm.getAccessToken()).toBe('operator-token');
    expect(capture).not.toHaveBeenCalled();
  });

  it('NEVER re-captures for a rejected direct token: the 401 comes back for the caller to map', async () => {
    const capture = vi.fn(async () => 'someone-elses-tab');
    const onDirectRejected = vi.fn(() => new Error('TEAMS_ACCESS_TOKEN was rejected by Teams (401).'));
    const tm = createCapturedTokenManager({ capture, direct: 'operator-token', onDirectRejected });
    const seen: string[] = [];
    const res = await tm.withAuth(async (t) => {
      seen.push(t);
      return unauthorized();
    });
    expect(capture).not.toHaveBeenCalled();
    expect(onDirectRejected).toHaveBeenCalled();
    expect(seen.every((t) => t === 'operator-token')).toBe(true);
    expect(res.status).toBe(401);
  });

  it('a direct token past its fallback lifetime is re-served, never swapped for a capture', async () => {
    let now = NOW;
    const capture = vi.fn(async () => 'browser');
    const tm = createCapturedTokenManager({ capture, direct: 'opaque-operator', now: () => now });
    expect(await tm.getAccessToken()).toBe('opaque-operator');
    now += UNKNOWN_CAPTURED_TOKEN_TTL_MS;
    expect(await tm.getAccessToken()).toBe('opaque-operator');
    expect(capture).not.toHaveBeenCalled();
  });

  it('caches a captured token and reuses it across a restart', async () => {
    const store = memoryStore();
    const token = jwt({ exp: NOW / 1000 + 3600 });
    const capture = vi.fn(async () => token);
    const first = createCapturedTokenManager({ capture, persistence: store, onDirectRejected: () => new Error('n/a'), now: () => NOW });
    expect(await first.getAccessToken()).toBe(token);
    expect(store.saved).toHaveLength(1);
    const second = createCapturedTokenManager({ capture, persistence: store, onDirectRejected: () => new Error('n/a'), now: () => NOW });
    expect(await second.getAccessToken()).toBe(token);
    expect(capture).toHaveBeenCalledOnce();
  });

  it('never consults or writes the cache for a direct token (that would copy a credential onto disk)', async () => {
    const store = memoryStore({ accessToken: 'stale-captured', refreshToken: RECAPTURE_SENTINEL, expiresAt: NOW + 3_600_000 });
    const load = vi.spyOn(store, 'load');
    const tm = createCapturedTokenManager({ capture: async () => 'x', direct: 'operator', persistence: store, onDirectRejected: () => new Error('n/a'), now: () => NOW });
    expect(await tm.getAccessToken()).toBe('operator');
    expect(load).not.toHaveBeenCalled();
    expect(store.saved).toHaveLength(0);
  });

  it('a failed cache write does not fail the call, and is reported', async () => {
    const reported: unknown[] = [];
    const store: SyncStatePersistence<BearerTokens> = {
      load: () => null,
      save: () => {
        throw new Error('EROFS');
      },
      clear: () => {
        throw new Error('EROFS');
      },
    };
    const tm = createCapturedTokenManager({
      capture: async () => 'tok',
      persistence: store,
      onPersistError: (e) => reported.push(e),
      onDirectRejected: () => new Error('n/a'),
    });
    expect(await tm.getAccessToken()).toBe('tok');
    expect(reported).toHaveLength(1);
    expect((reported[0] as Error).message).toBe('EROFS');
  });

  it('reports the held token\'s expiry', async () => {
    const tm = createCapturedTokenManager({ capture: async () => jwt({ exp: NOW / 1000 + 3600 }), onDirectRejected: () => new Error('n/a'), now: () => NOW });
    await tm.getAccessToken();
    expect(tm.getExpiresAt()).toBe(NOW + 3_600_000);
  });
});
