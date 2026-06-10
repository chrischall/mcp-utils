import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  statSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHarness, parseToolResult } from '../test/index.js';
import {
  createSessionRegistry,
  SessionRegistry,
  registerSessionTools,
  SessionStore,
  normalizeOrigin,
  TokenManager,
  CookieSessionManager,
  createCookieSessionManager,
  type SessionToken,
} from './index.js';

// ---------------------------------------------------------------------------
// SessionRegistry — in-memory
// ---------------------------------------------------------------------------

describe('SessionRegistry', () => {
  it('createSessionRegistry returns a SessionRegistry', () => {
    expect(createSessionRegistry()).toBeInstanceOf(SessionRegistry);
  });

  it('register returns a session with a label id and marks it active (first wins)', () => {
    const reg = createSessionRegistry();
    const s = reg.register({ account_identity: 'a@example.com' });
    expect(s.session_id).toMatch(/^[a-z0-9]+$/);
    expect(s.account_identity).toBe('a@example.com');
    expect(s.auth_ready).toBe(true);
    expect(reg.getContext().active_session_id).toBe(s.session_id);
  });

  it('label ids are unique across registrations', () => {
    const reg = createSessionRegistry();
    const a = reg.register({ account_identity: 'a' });
    const b = reg.register({ account_identity: 'b' });
    expect(a.session_id).not.toBe(b.session_id);
  });

  it('dedupes by account_identity — re-register updates in place, keeps id', () => {
    const reg = createSessionRegistry();
    const a = reg.register({ account_identity: 'a@x.com', auth_expires_at: '2020-01-01' });
    const a2 = reg.register({ account_identity: 'a@x.com' });
    expect(a2.session_id).toBe(a.session_id);
    expect(reg.getContext().sessions).toHaveLength(1);
    // undefined auth_expires_at means "keep existing"
    expect(a2.auth_expires_at).toBe('2020-01-01');
  });

  it('re-register with explicit null clears expiry; with a value replaces it', () => {
    const reg = createSessionRegistry();
    reg.register({ account_identity: 'a', auth_expires_at: '2020-01-01' });
    expect(reg.register({ account_identity: 'a', auth_expires_at: null }).auth_expires_at).toBeNull();
    expect(reg.register({ account_identity: 'a', auth_expires_at: '2030-01-01' }).auth_expires_at).toBe(
      '2030-01-01',
    );
  });

  it('trims identity and rejects empty', () => {
    const reg = createSessionRegistry();
    expect(reg.register({ account_identity: '  a  ' }).account_identity).toBe('a');
    expect(() => reg.register({ account_identity: '   ' })).toThrow();
  });

  it('setActive returns false for unknown, true + switches for known', () => {
    const reg = createSessionRegistry();
    const a = reg.register({ account_identity: 'a' });
    const b = reg.register({ account_identity: 'b' });
    expect(reg.getContext().active_session_id).toBe(a.session_id);
    expect(reg.setActive('nope')).toBe(false);
    expect(reg.setActive(b.session_id)).toBe(true);
    expect(reg.getContext().active_session_id).toBe(b.session_id);
  });

  it('getContext returns a deep-ish snapshot (mutation does not leak)', () => {
    const reg = createSessionRegistry();
    reg.register({ account_identity: 'a' });
    const ctx = reg.getContext();
    ctx.sessions[0]!.account_identity = 'mutated';
    expect(reg.getContext().sessions[0]!.account_identity).toBe('a');
  });

  it('resolve: known requested → it; unknown → throws; undefined → active; none → null', () => {
    const reg = createSessionRegistry();
    expect(reg.resolve(undefined)).toBeNull();
    const a = reg.register({ account_identity: 'a' });
    expect(reg.resolve(undefined)).toBe(a.session_id);
    expect(reg.resolve(a.session_id)).toBe(a.session_id);
    expect(() => reg.resolve('nope')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// registerSessionTools — MCP surface
// ---------------------------------------------------------------------------

describe('registerSessionTools', () => {
  it('registers the three prefixed tools', async () => {
    const reg = createSessionRegistry();
    const h = await createTestHarness((server) => registerSessionTools(server, reg, { prefix: 'zillow' }));
    const names = (await h.listTools()).map((t) => t.name).sort();
    expect(names).toEqual([
      'zillow_get_session_context',
      'zillow_register_session',
      'zillow_set_active_session',
    ]);
    await h.close();
  });

  it('register_session adds a session and returns it', async () => {
    const reg = createSessionRegistry();
    const h = await createTestHarness((server) => registerSessionTools(server, reg, { prefix: 'redfin' }));
    const res = await h.callTool('redfin_register_session', { account_identity: 'me@x.com' });
    const body = parseToolResult<{ session: SessionToken; active_session_id: string }>(res);
    expect(body.active_session_id).toBe(reg.getContext().active_session_id);
    expect(reg.getContext().sessions).toHaveLength(1);
    await h.close();
  });

  it('register_session with mark_active:true makes the new session active', async () => {
    const reg = createSessionRegistry();
    reg.register({ account_identity: 'first@x.com' });
    const firstActive = reg.activeSessionId();
    const h = await createTestHarness((server) => registerSessionTools(server, reg, { prefix: 'redfin' }));
    const res = await h.callTool('redfin_register_session', {
      account_identity: 'second@x.com',
      mark_active: true,
    });
    const body = parseToolResult<{ session: SessionToken; active_session_id: string }>(res);
    expect(body.session.account_identity).toBe('second@x.com');
    expect(body.active_session_id).toBe(body.session.session_id);
    expect(reg.activeSessionId()).toBe(body.session.session_id);
    expect(reg.activeSessionId()).not.toBe(firstActive);
    await h.close();
  });

  it('register_session without mark_active leaves the active session unchanged', async () => {
    const reg = createSessionRegistry();
    reg.register({ account_identity: 'first@x.com' });
    const firstActive = reg.activeSessionId();
    const h = await createTestHarness((server) => registerSessionTools(server, reg, { prefix: 'redfin' }));
    const res = await h.callTool('redfin_register_session', {
      account_identity: 'second@x.com',
    });
    const body = parseToolResult<{ session: SessionToken; active_session_id: string }>(res);
    expect(body.session.account_identity).toBe('second@x.com');
    expect(reg.activeSessionId()).toBe(firstActive);
    expect(body.active_session_id).toBe(firstActive);
    await h.close();
  });

  it('set_active_session errors on unknown id', async () => {
    const reg = createSessionRegistry();
    const h = await createTestHarness((server) => registerSessionTools(server, reg, { prefix: 'homes' }));
    const res = await h.callTool('homes_set_active_session', { session_id: 'nope' });
    expect(res.isError).toBe(true);
    await h.close();
  });

  it('get_session_context returns the registry snapshot', async () => {
    const reg = createSessionRegistry();
    reg.register({ account_identity: 'a' });
    const h = await createTestHarness((server) => registerSessionTools(server, reg, { prefix: 'compass' }));
    const body = parseToolResult<{ sessions: unknown[] }>(
      await h.callTool('compass_get_session_context', {}),
    );
    expect(body.sessions).toHaveLength(1);
    await h.close();
  });
});

// ---------------------------------------------------------------------------
// normalizeOrigin
// ---------------------------------------------------------------------------

describe('normalizeOrigin', () => {
  it('strips path + trailing slash from a full url', () => {
    expect(normalizeOrigin('https://x.hbportal.co/app/workspace_file/123')).toBe('https://x.hbportal.co');
    expect(normalizeOrigin('https://x.hbportal.co/')).toBe('https://x.hbportal.co');
  });
  it('passes through a bare origin and trims trailing slash on invalid input', () => {
    expect(normalizeOrigin('not a url/')).toBe('not a url');
  });
});

// ---------------------------------------------------------------------------
// SessionStore — disk-persisted
// ---------------------------------------------------------------------------

interface TestSession extends Record<string, unknown> {
  origin: string;
  token: string;
}

function makeStore(dir: string) {
  return new SessionStore<TestSession>({
    filePath: join(dir, 'nested', 'sessions.json'),
    keyOf: (s) => s.origin,
    normalizeKey: normalizeOrigin,
  });
}

describe('SessionStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-utils-store-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('add + get by key, normalizing the key', () => {
    const store = makeStore(dir);
    store.add({ origin: 'https://a.com/page', token: 't1' });
    // keyed by the normalized origin, so any path under the origin resolves it
    expect(store.get('https://a.com')!.token).toBe('t1');
    expect(store.get('https://a.com/other')!.token).toBe('t1');
  });

  it('get() with no arg returns the most-recently-added (active) session', () => {
    const store = makeStore(dir);
    store.add({ origin: 'https://a.com', token: 't1' });
    store.add({ origin: 'https://b.com', token: 't2' });
    expect(store.getActiveSession()!.token).toBe('t2');
    expect(store.get()!.token).toBe('t2');
  });

  it('persists to disk and reloads in a new instance', () => {
    const store = makeStore(dir);
    store.add({ origin: 'https://a.com', token: 't1' });
    const reopened = makeStore(dir);
    expect(reopened.get('https://a.com')!.token).toBe('t1');
    expect(reopened.getActiveSession()!.origin).toBe('https://a.com');
  });

  it('writes the file with mode 0600 and the dir with mode 0700', () => {
    const store = makeStore(dir);
    store.add({ origin: 'https://a.com', token: 't1' });
    const filePath = join(dir, 'nested', 'sessions.json');
    expect(existsSync(filePath)).toBe(true);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700);
  });

  it('remove deletes a session and fixes up the active pointer', () => {
    const store = makeStore(dir);
    store.add({ origin: 'https://a.com', token: 't1' });
    store.add({ origin: 'https://b.com', token: 't2' });
    expect(store.remove('https://b.com')).toBe(true);
    expect(store.get('https://b.com')).toBeNull();
    // active falls back to a.com
    expect(store.getActiveSession()!.origin).toBe('https://a.com');
    expect(store.remove('https://b.com')).toBe(false);
  });

  it('list returns all sessions in insertion order', () => {
    const store = makeStore(dir);
    store.add({ origin: 'https://a.com', token: 't1' });
    store.add({ origin: 'https://b.com', token: 't2' });
    expect(store.list().map((s) => s.origin)).toEqual(['https://a.com', 'https://b.com']);
  });

  it('tolerates a corrupt disk file (starts empty)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const filePath = join(dir, 'nested', 'sessions.json');
      mkdirSync(join(dir, 'nested'), { recursive: true });
      writeFileSync(filePath, '{ not json');
      const store = makeStore(dir);
      expect(store.list()).toHaveLength(0);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('preserves a corrupt disk file as a backup and warns on stderr', () => {
    const filePath = join(dir, 'nested', 'sessions.json');
    mkdirSync(join(dir, 'nested'), { recursive: true });
    const corruptBytes = '{ not json';
    writeFileSync(filePath, corruptBytes);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const store = makeStore(dir);
      expect(store.list()).toHaveLength(0);
      // original bytes preserved next to the store file before anything can overwrite them
      const backupPath = `${filePath}.corrupt`;
      expect(existsSync(backupPath)).toBe(true);
      expect(readFileSync(backupPath, 'utf8')).toBe(corruptBytes);
      // one-line warning on stderr (stdout is reserved for JSON-RPC)
      expect(errSpy).toHaveBeenCalledOnce();
      expect(String(errSpy.mock.calls[0]![0])).toContain('sessions.json');
      // a subsequent save writes a fresh store file but never clobbers the backup
      store.add({ origin: 'https://a.com', token: 't1' });
      expect(readFileSync(backupPath, 'utf8')).toBe(corruptBytes);
      expect(makeStore(dir).get('https://a.com')!.token).toBe('t1');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('does not clobber an existing backup of a previous corruption', () => {
    const filePath = join(dir, 'nested', 'sessions.json');
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(`${filePath}.corrupt`, 'first corruption');
    writeFileSync(filePath, '{ second corruption');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      makeStore(dir);
      expect(readFileSync(`${filePath}.corrupt`, 'utf8')).toBe('first corruption');
      expect(readFileSync(`${filePath}.corrupt-1`, 'utf8')).toBe('{ second corruption');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('refuses to clobber the last backup slot when all 101 are taken', () => {
    const filePath = join(dir, 'nested', 'sessions.json');
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(`${filePath}.corrupt`, 'slot 0');
    for (let n = 1; n <= 100; n++) writeFileSync(`${filePath}.corrupt-${n}`, `slot ${n}`);
    writeFileSync(filePath, '{ one corruption too many');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      makeStore(dir);
      // The exhausted-slots path must not overwrite any existing backup...
      expect(readFileSync(`${filePath}.corrupt-100`, 'utf8')).toBe('slot 100');
      // ...and leaves the corrupt file in place (the "could not preserve" path).
      expect(readFileSync(filePath, 'utf8')).toBe('{ one corruption too many');
      expect(errSpy.mock.calls.flat().join(' ')).toMatch(/could not preserve/i);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('creates intermediate directories with mode 0700', () => {
    const filePath = join(dir, 'a', 'b', 'sessions.json');
    const store = new SessionStore<TestSession>({
      filePath,
      keyOf: (s) => s.origin,
      normalizeKey: normalizeOrigin,
    });
    store.add({ origin: 'https://a.com', token: 't1' });
    // BOTH created dirs must be 0700 — the intermediate one is only covered by
    // mkdirSync's mode (the trailing chmod only touches dirname(filePath)).
    expect(statSync(join(dir, 'a')).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'a', 'b')).mode & 0o777).toBe(0o700);
  });

  it('tightens a pre-existing loose file to 0600 BEFORE writing new secret content', () => {
    const filePath = join(dir, 'nested', 'sessions.json');
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(filePath, JSON.stringify([{ origin: 'https://old.com', token: 'old' }]));
    // owner-read-only: the save can only succeed if the store chmods the file
    // BEFORE opening it for write (chmod-then-write-then-chmod ordering)
    chmodSync(filePath, 0o444);
    const store = makeStore(dir);
    store.add({ origin: 'https://a.com', token: 't1' });
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as TestSession[];
    expect(onDisk.map((s) => s.origin)).toContain('https://a.com');
  });

  it('re-tightens a pre-existing 0644 file to 0600 after a save', () => {
    const filePath = join(dir, 'nested', 'sessions.json');
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(filePath, '[]');
    chmodSync(filePath, 0o644);
    const store = makeStore(dir);
    store.add({ origin: 'https://a.com', token: 't1' });
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('serialize/deserialize round-trips through the on-disk JSON array', () => {
    const store = makeStore(dir);
    store.add({ origin: 'https://a.com', token: 't1' });
    const raw = readFileSync(join(dir, 'nested', 'sessions.json'), 'utf8');
    const parsed = JSON.parse(raw) as TestSession[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0]!.origin).toBe('https://a.com');
  });
});

// ---------------------------------------------------------------------------
// TokenManager — expiry skew, proactive + reactive refresh, race-safety
// ---------------------------------------------------------------------------

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('TokenManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the current token when it is far from expiry', async () => {
    const refresh = vi.fn();
    const tm = new TokenManager({
      initial: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 60 * 60 * 1000 },
      refresh,
    });
    expect(await tm.getAccessToken()).toBe('AT');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('proactively refreshes within the 5-minute skew window', async () => {
    const refresh = vi.fn().mockResolvedValue({ accessToken: 'AT2', refreshToken: 'RT2', expiresAt: 60 * 60 * 1000 });
    const tm = new TokenManager({
      // expires in 4 minutes — inside the 5-min skew
      initial: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 4 * 60 * 1000 },
      refresh,
    });
    expect(await tm.getAccessToken()).toBe('AT2');
    expect(refresh).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledWith('RT');
  });

  it('does NOT refresh when expiry is just outside the skew window', async () => {
    const refresh = vi.fn();
    const tm = new TokenManager({
      initial: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 5 * 60 * 1000 + 1000 },
      refresh,
    });
    expect(await tm.getAccessToken()).toBe('AT');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('keeps the old refresh token when the refresh response omits one', async () => {
    const refresh = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: 'AT2', expiresAt: 60 * 60 * 1000 })
      .mockResolvedValueOnce({ accessToken: 'AT3', expiresAt: 60 * 60 * 1000 });
    const tm = new TokenManager({
      initial: { accessToken: 'AT', refreshToken: 'RT', expiresAt: -1 },
      refresh,
    });
    await tm.getAccessToken();
    await tm.refreshNow();
    expect(refresh).toHaveBeenNthCalledWith(2, 'RT');
  });

  it('reactively refreshes once on a 401 then replays via withAuth', async () => {
    const refresh = vi.fn().mockResolvedValue({ accessToken: 'AT2', refreshToken: 'RT2', expiresAt: 60 * 60 * 1000 });
    const tm = new TokenManager({
      initial: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 60 * 60 * 1000 },
      refresh,
    });
    const seen: string[] = [];
    const call = vi.fn(async (token: string) => {
      seen.push(token);
      return new Response(null, { status: seen.length === 1 ? 401 : 200 });
    });
    const res = await tm.withAuth(call);
    expect(res.status).toBe(200);
    expect(seen).toEqual(['AT', 'AT2']);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not loop forever — a second 401 after refresh is surfaced', async () => {
    const refresh = vi.fn().mockResolvedValue({ accessToken: 'AT2', expiresAt: 60 * 60 * 1000 });
    const tm = new TokenManager({
      initial: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 60 * 60 * 1000 },
      refresh,
    });
    const call = vi.fn(async () => new Response(null, { status: 401 }));
    const res = await tm.withAuth(call);
    expect(res.status).toBe(401);
    expect(refresh).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent refreshes into a SINGLE refresh call (race-safe)', async () => {
    const d = deferred<SessionToken>();
    const refresh = vi.fn().mockReturnValue(d.promise);
    const tm = new TokenManager({
      // already expired → both callers hit the proactive-refresh branch
      initial: { accessToken: 'OLD', refreshToken: 'RT', expiresAt: -1 },
      refresh,
    });
    const p1 = tm.getAccessToken();
    const p2 = tm.getAccessToken();
    // both started before the single refresh resolves
    expect(refresh).toHaveBeenCalledOnce();
    d.resolve({ accessToken: 'NEW', refreshToken: 'RT2', expiresAt: 60 * 60 * 1000 });
    expect(await p1).toBe('NEW');
    expect(await p2).toBe('NEW');
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('a failed refresh rejects and clears the in-flight promise so a retry can run', async () => {
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ accessToken: 'AT2', refreshToken: 'RT2', expiresAt: 60 * 60 * 1000 });
    const tm = new TokenManager({
      initial: { accessToken: 'AT', refreshToken: 'RT', expiresAt: -1 },
      refresh,
    });
    await expect(tm.getAccessToken()).rejects.toThrow('boom');
    // in-flight cleared — second attempt issues a fresh refresh and succeeds
    expect(await tm.getAccessToken()).toBe('AT2');
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('does not double-refresh when a late 401 lands after another caller already refreshed', async () => {
    const refresh = vi
      .fn()
      .mockResolvedValue({ accessToken: 'AT2', refreshToken: 'RT2', expiresAt: 60 * 60 * 1000 });
    const tm = new TokenManager({
      initial: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 60 * 60 * 1000 },
      refresh,
    });

    // Caller A's request hangs; its 401 (sent under the OLD token) lands late.
    const lateA = deferred<Response>();
    const tokensA: string[] = [];
    const callA = vi.fn(async (token: string) => {
      tokensA.push(token);
      if (tokensA.length === 1) return lateA.promise;
      return new Response(null, { status: 200 });
    });

    // Caller B 401s immediately under the old token, refreshes, replays fine.
    const callB = vi.fn(async (token: string) =>
      new Response(null, { status: token === 'AT' ? 401 : 200 }),
    );

    const pA = tm.withAuth(callA);
    const pB = tm.withAuth(callB);
    expect((await pB).status).toBe(200);
    expect(refresh).toHaveBeenCalledOnce();

    // Now A's stale-token 401 arrives — AFTER B's refresh settled and cleared
    // the single-flight promise. A must NOT trigger a second refresh (under
    // rotation that would consume/invalidate the freshly-issued refresh token);
    // it should just replay with the already-refreshed token.
    lateA.resolve(new Response(null, { status: 401 }));
    expect((await pA).status).toBe(200);
    expect(refresh).toHaveBeenCalledOnce();
    expect(tokensA).toEqual(['AT', 'AT2']);
  });

  it('throws when no refresh token is available and a refresh is needed', async () => {
    const refresh = vi.fn();
    const tm = new TokenManager({
      initial: { accessToken: 'AT', expiresAt: -1 },
      refresh,
    });
    await expect(tm.getAccessToken()).rejects.toThrow();
    expect(refresh).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CookieSessionManager — single-flight login, heuristic expiry, replay-once
// ---------------------------------------------------------------------------

interface FakeSession {
  cookieHeader: string;
  csrfToken?: string;
}

describe('CookieSessionManager', () => {
  it('ensure() runs login lazily and memoizes the session', async () => {
    const login = vi.fn(async (): Promise<FakeSession> => ({ cookieHeader: 'sid=1' }));
    const mgr = new CookieSessionManager<FakeSession>({ login, isExpired: () => false });

    expect(mgr.current).toBeUndefined();
    const a = await mgr.ensure();
    const b = await mgr.ensure();
    expect(a).toEqual({ cookieHeader: 'sid=1' });
    expect(b).toBe(a);
    expect(mgr.current).toBe(a);
    expect(login).toHaveBeenCalledOnce();
  });

  it('coalesces concurrent ensure() callers into a SINGLE login', async () => {
    const d = deferred<FakeSession>();
    const login = vi.fn(() => d.promise);
    const mgr = new CookieSessionManager<FakeSession>({ login, isExpired: () => false });

    const p1 = mgr.ensure();
    const p2 = mgr.ensure();
    expect(login).toHaveBeenCalledOnce();
    d.resolve({ cookieHeader: 'sid=1' });
    expect(await p1).toEqual({ cookieHeader: 'sid=1' });
    expect(await p2).toBe(await p1);
    expect(login).toHaveBeenCalledOnce();
  });

  it('a rejected login clears the in-flight promise so the next ensure() retries (evite H1)', async () => {
    const login = vi
      .fn<() => Promise<FakeSession>>()
      .mockRejectedValueOnce(new Error('network blip'))
      .mockResolvedValueOnce({ cookieHeader: 'sid=2' });
    const mgr = new CookieSessionManager<FakeSession>({ login, isExpired: () => false });

    await expect(mgr.ensure()).rejects.toThrow('network blip');
    // poisoned promise must NOT stick — a second ensure() retries fresh
    expect(await mgr.ensure()).toEqual({ cookieHeader: 'sid=2' });
    expect(login).toHaveBeenCalledTimes(2);
  });

  it('caches a PERMANENT config error and rethrows it without retrying login (skylight marker)', async () => {
    const login = vi
      .fn<() => Promise<FakeSession>>()
      .mockRejectedValue(new Error('NO_ENV_CONFIG: set ARTSONIA_USERNAME/PASSWORD'));
    const mgr = new CookieSessionManager<FakeSession>({
      login,
      isExpired: () => false,
      isPermanentError: (err) => err instanceof Error && err.message.includes('NO_ENV_CONFIG'),
    });

    await expect(mgr.ensure()).rejects.toThrow('NO_ENV_CONFIG');
    await expect(mgr.ensure()).rejects.toThrow('NO_ENV_CONFIG');
    // permanent → login only attempted once, error replayed from cache
    expect(login).toHaveBeenCalledOnce();
  });

  it('a TRANSIENT login failure is not cached — next ensure() retries (skylight marker)', async () => {
    const login = vi
      .fn<() => Promise<FakeSession>>()
      .mockRejectedValueOnce(new Error('502 from login endpoint'))
      .mockResolvedValueOnce({ cookieHeader: 'sid=3' });
    const mgr = new CookieSessionManager<FakeSession>({
      login,
      isExpired: () => false,
      isPermanentError: (err) => err instanceof Error && err.message.includes('NO_ENV_CONFIG'),
    });

    await expect(mgr.ensure()).rejects.toThrow('502');
    expect(await mgr.ensure()).toEqual({ cookieHeader: 'sid=3' });
    expect(login).toHaveBeenCalledTimes(2);
  });

  it('invalidate() drops the session so the next ensure() re-logs-in', async () => {
    const login = vi
      .fn<() => Promise<FakeSession>>()
      .mockResolvedValueOnce({ cookieHeader: 'sid=1' })
      .mockResolvedValueOnce({ cookieHeader: 'sid=2' });
    const mgr = new CookieSessionManager<FakeSession>({ login, isExpired: () => false });

    expect((await mgr.ensure()).cookieHeader).toBe('sid=1');
    mgr.invalidate();
    expect(mgr.current).toBeUndefined();
    expect((await mgr.ensure()).cookieHeader).toBe('sid=2');
    expect(login).toHaveBeenCalledTimes(2);
  });

  it('withSession() replays exactly once on expiry then succeeds, re-logging-in', async () => {
    const login = vi
      .fn<() => Promise<FakeSession>>()
      .mockResolvedValueOnce({ cookieHeader: 'sid=stale' })
      .mockResolvedValueOnce({ cookieHeader: 'sid=fresh' });
    const mgr = new CookieSessionManager<FakeSession>({
      login,
      isExpired: (res) => res.status === 401,
    });

    const seen: string[] = [];
    const call = vi.fn(async (s: FakeSession) => {
      seen.push(s.cookieHeader);
      return new Response(null, { status: seen.length === 1 ? 401 : 200 });
    });

    const res = await mgr.withSession(call);
    expect(res.status).toBe(200);
    expect(seen).toEqual(['sid=stale', 'sid=fresh']);
    expect(login).toHaveBeenCalledTimes(2);
  });

  it('withSession() surfaces a persistent expiry after EXACTLY one replay (no infinite loop)', async () => {
    const login = vi.fn(async (): Promise<FakeSession> => ({ cookieHeader: 'sid' }));
    const mgr = new CookieSessionManager<FakeSession>({
      login,
      isExpired: (res) => res.status === 401,
    });
    const call = vi.fn(async () => new Response(null, { status: 401 }));

    const res = await mgr.withSession(call);
    expect(res.status).toBe(401);
    // initial login + one re-login; call invoked exactly twice (no loop)
    expect(call).toHaveBeenCalledTimes(2);
    expect(login).toHaveBeenCalledTimes(2);
  });

  it('withSession() detects expiry by BODY heuristic — a 200 login-page is treated expired (signupgenius)', async () => {
    const login = vi
      .fn<() => Promise<FakeSession>>()
      .mockResolvedValueOnce({ cookieHeader: 'sid=stale' })
      .mockResolvedValueOnce({ cookieHeader: 'sid=fresh' });
    const mgr = new CookieSessionManager<FakeSession>({
      login,
      // status alone is insufficient: a 200 whose body is the login form means expired.
      isExpired: async (res) => {
        if (res.status === 401 || res.status === 403) return true;
        const body = await res.clone().text();
        return /<form[^>]*id="login"/i.test(body);
      },
    });

    const seen: string[] = [];
    const call = vi.fn(async (s: FakeSession) => {
      seen.push(s.cookieHeader);
      return seen.length === 1
        ? new Response('<html><form id="login"></form></html>', { status: 200 })
        : new Response('{"ok":true}', { status: 200 });
    });

    const res = await mgr.withSession(call);
    expect(await res.text()).toBe('{"ok":true}');
    expect(seen).toEqual(['sid=stale', 'sid=fresh']);
    expect(login).toHaveBeenCalledTimes(2);
  });

  it('withSession() detects expiry by URL/redirect heuristic — redirect to login is expired (artsonia)', async () => {
    const login = vi
      .fn<() => Promise<FakeSession>>()
      .mockResolvedValueOnce({ cookieHeader: 'sid=stale' })
      .mockResolvedValueOnce({ cookieHeader: 'sid=fresh' });
    const mgr = new CookieSessionManager<FakeSession>({
      login,
      // expiry manifests as a 302 redirect back to the login page, not a 401.
      isExpired: (res) =>
        (res.status === 301 || res.status === 302) &&
        /login\.asp/i.test(res.headers.get('location') ?? ''),
    });

    const seen: string[] = [];
    const call = vi.fn(async (s: FakeSession) => {
      seen.push(s.cookieHeader);
      return seen.length === 1
        ? new Response(null, { status: 302, headers: { location: '/members/login.asp' } })
        : new Response(null, { status: 200 });
    });

    const res = await mgr.withSession(call);
    expect(res.status).toBe(200);
    expect(seen).toEqual(['sid=stale', 'sid=fresh']);
  });

  it('withSession() returns the original expired response if the re-login itself fails (evite/canvas surface clean error)', async () => {
    const login = vi
      .fn<() => Promise<FakeSession>>()
      .mockResolvedValueOnce({ cookieHeader: 'sid=stale' })
      .mockRejectedValueOnce(new Error('no creds — fetchproxy path'));
    const mgr = new CookieSessionManager<FakeSession>({
      login,
      isExpired: (res) => res.status === 401,
    });
    const call = vi.fn(async () => new Response(null, { status: 401 }));

    const res = await mgr.withSession(call);
    // re-login failed → original 401 surfaces (caller maps it to a sign-in error),
    // and call is NOT replayed a second time.
    expect(res.status).toBe(401);
    expect(call).toHaveBeenCalledOnce();
    expect(login).toHaveBeenCalledTimes(2);
  });

  it('withSession() passes the session (cookieHeader + csrfToken) through to call', async () => {
    const session: FakeSession = { cookieHeader: 'sid=1; csrftoken=abc', csrfToken: 'abc' };
    const login = vi.fn(async () => session);
    const mgr = new CookieSessionManager<FakeSession>({ login, isExpired: () => false });

    let received: FakeSession | undefined;
    await mgr.withSession(async (s) => {
      received = s;
      return new Response(null, { status: 200 });
    });
    expect(received).toEqual(session);
  });

  it('createCookieSessionManager() builds an equivalent manager', async () => {
    const login = vi.fn(async (): Promise<FakeSession> => ({ cookieHeader: 'sid=1' }));
    const mgr = createCookieSessionManager<FakeSession>({ login, isExpired: () => false });
    expect(mgr).toBeInstanceOf(CookieSessionManager);
    expect(await mgr.ensure()).toEqual({ cookieHeader: 'sid=1' });
  });

  it('concurrent withSession() callers under an expired session re-login ONCE (single-flight replay)', async () => {
    const login = vi
      .fn<() => Promise<FakeSession>>()
      .mockResolvedValueOnce({ cookieHeader: 'sid=stale' })
      .mockResolvedValueOnce({ cookieHeader: 'sid=fresh' });
    const mgr = new CookieSessionManager<FakeSession>({
      login,
      isExpired: (res) => res.status === 401,
    });

    // Prime a (stale) session so both concurrent calls start from it.
    await mgr.ensure();

    const call = vi.fn(async (s: FakeSession) =>
      new Response(null, { status: s.cookieHeader === 'sid=fresh' ? 200 : 401 }),
    );

    const [r1, r2] = await Promise.all([mgr.withSession(call), mgr.withSession(call)]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // both detected expiry, but the re-login coalesced into ONE login call
    expect(login).toHaveBeenCalledTimes(2); // 1 initial ensure + 1 coalesced re-login
  });

  it('isExpired is OPTIONAL — omitting it means withSession NEVER replays (skylight ensure-only)', async () => {
    // Skylight has no per-request expiry path (its re-auth lives in TokenManager),
    // so it should not need to pass a meaningless `isExpired: () => false` stub.
    const login = vi.fn(async (): Promise<FakeSession> => ({ cookieHeader: 'sid=1' }));
    const mgr = new CookieSessionManager<FakeSession>({ login });

    // A 401-equivalent response is returned AS-IS (the default never flags expiry),
    // and login is called exactly once (no replay, no second login).
    const call = vi.fn(async () => new Response(null, { status: 401 }));
    const res = await mgr.withSession(call);

    expect(res.status).toBe(401);
    expect(call).toHaveBeenCalledOnce();
    expect(login).toHaveBeenCalledOnce();
  });

  it('a custom response type R flows through withSession + a provided isExpired<R> and replays once on expiry (artsonia non-fetch transport)', async () => {
    // Artsonia returns a custom transport response, not the Fetch `Response`.
    interface ArtsoniaResponse {
      setCookie?: string;
      location?: string;
      url: string;
      body: string;
    }
    const login = vi
      .fn<() => Promise<FakeSession>>()
      .mockResolvedValueOnce({ cookieHeader: 'sid=stale' })
      .mockResolvedValueOnce({ cookieHeader: 'sid=fresh' });

    // R is the custom response; isExpired reads R-specific members (location/url).
    const mgr = new CookieSessionManager<FakeSession, ArtsoniaResponse>({
      login,
      isExpired: (res) => /login\.asp/i.test(res.location ?? res.url),
    });

    const seen: string[] = [];
    const call = vi.fn(async (s: FakeSession): Promise<ArtsoniaResponse> => {
      seen.push(s.cookieHeader);
      return seen.length === 1
        ? { url: '/members/page.asp', location: '/members/login.asp', body: '' }
        : { url: '/members/page.asp', body: '{"ok":true}' };
    });

    const res = await mgr.withSession(call);
    expect(res.body).toBe('{"ok":true}');
    expect(seen).toEqual(['sid=stale', 'sid=fresh']);
    expect(call).toHaveBeenCalledTimes(2); // exactly one replay
    expect(login).toHaveBeenCalledTimes(2);
  });
});
