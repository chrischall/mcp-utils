// Capabilities lifted from the four repos that hand-rolled token persistence
// before the shared helper existed (freshbooks, kiaaccess, alphaportal, vibo).
// Each block names the repo whose behaviour it preserves, so a future migration
// can be checked against the thing it replaces rather than against a guess.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TokenManager,
  CookieSessionManager,
  createFileStatePersistence,
  createKeyedFileStatePersistence,
  resolveStateFile,
  type BearerTokens,
} from './index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-utils-caps-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const later = () => Date.now() + 3_600_000;

// ===========================================================================
// Fatal writes — freshbooks-mcp
// ===========================================================================

describe('onPersistError (freshbooks: single-use rotating refresh tokens)', () => {
  it('by default a failed save is swallowed and the request still succeeds', async () => {
    const mgr = new TokenManager({
      initial: { accessToken: 'a1', refreshToken: 'r1', expiresAt: Date.now() - 1 },
      refresh: async () => ({ accessToken: 'a2', refreshToken: 'r2', expiresAt: later() }),
      persistence: {
        load: () => null,
        save: () => {
          throw new Error('EROFS');
        },
      },
    });
    expect(await mgr.getAccessToken()).toBe('a2');
  });

  it('surfaces the failure when the hook rethrows', async () => {
    // FreshBooks burns the old refresh token the moment the new one is issued.
    // If the new one does not reach disk, the account is locked out on the next
    // start — so losing the write has to be louder than losing the request.
    const seen: unknown[] = [];
    const mgr = new TokenManager({
      initial: { accessToken: 'a1', refreshToken: 'r1', expiresAt: Date.now() - 1 },
      refresh: async () => ({ accessToken: 'a2', refreshToken: 'r2', expiresAt: later() }),
      persistence: {
        load: () => null,
        save: () => {
          throw new Error('EROFS');
        },
      },
      onPersistError: (err) => {
        seen.push(err);
        throw new Error(`could not persist the rotated token: ${(err as Error).message}`);
      },
    });
    await expect(mgr.getAccessToken()).rejects.toThrow(/could not persist the rotated token/);
    expect(seen).toHaveLength(1);
  });

  it('reports without failing when the hook only observes', async () => {
    const seen: unknown[] = [];
    const mgr = new TokenManager({
      initial: { accessToken: 'a1', refreshToken: 'r1', expiresAt: Date.now() - 1 },
      refresh: async () => ({ accessToken: 'a2', refreshToken: 'r2', expiresAt: later() }),
      persistence: {
        load: () => null,
        save: () => {
          throw new Error('EROFS');
        },
      },
      onPersistError: (err) => void seen.push(err),
    });
    expect(await mgr.getAccessToken()).toBe('a2');
    expect(seen).toHaveLength(1);
  });

  it('CookieSessionManager takes the same hook', async () => {
    const seen: unknown[] = [];
    const mgr = new CookieSessionManager<{ cookieHeader: string }>({
      login: async () => ({ cookieHeader: 's1' }),
      persistence: {
        load: () => null,
        save: () => {
          throw new Error('EROFS');
        },
      },
      onPersistError: (err) => void seen.push(err),
    });
    await mgr.ensure();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);
  });
});

// ===========================================================================
// Credential binding — freshbooks-mcp's `seededFromEnv`
// ===========================================================================

describe('boundTo (freshbooks: re-bootstrap must invalidate the cache)', () => {
  it('returns the record when the binding matches', () => {
    const file = join(dir, 'tokens.json');
    createFileStatePersistence<BearerTokens>({ filePath: file, boundTo: 'pw-v1' }).save({
      accessToken: 'AT',
      expiresAt: 1,
    });
    expect(
      createFileStatePersistence<BearerTokens>({ filePath: file, boundTo: 'pw-v1' }).load(),
    ).toEqual({ accessToken: 'AT', expiresAt: 1 });
  });

  it('discards the record when the credential that seeded it changed', () => {
    const file = join(dir, 'tokens.json');
    createFileStatePersistence<BearerTokens>({ filePath: file, boundTo: 'pw-v1' }).save({
      accessToken: 'AT',
      expiresAt: 1,
    });
    // Operator rotated the password / re-ran the OAuth bootstrap.
    expect(
      createFileStatePersistence<BearerTokens>({ filePath: file, boundTo: 'pw-v2' }).load(),
    ).toBeNull();
  });

  it('never writes the credential itself, only a digest of it', () => {
    const file = join(dir, 'tokens.json');
    createFileStatePersistence<BearerTokens>({
      filePath: file,
      boundTo: 'hunter2-the-real-password',
    }).save({ accessToken: 'AT', expiresAt: 1 });
    const body = readFileSync(file, 'utf8');
    expect(body).not.toContain('hunter2');
  });

  it('reads a legacy bare record written before the envelope existed', () => {
    // vibo's "a stale pre-migration file degrades gracefully" concern, and the
    // files skylight-mcp already wrote with the pre-envelope helper.
    const file = join(dir, 'tokens.json');
    writeFileSync(file, JSON.stringify({ accessToken: 'LEGACY', expiresAt: 5 }), { mode: 0o600 });
    expect(createFileStatePersistence<BearerTokens>({ filePath: file }).load()).toEqual({
      accessToken: 'LEGACY',
      expiresAt: 5,
    });
  });

  it('ignores a legacy bare record when a binding is required', () => {
    const file = join(dir, 'tokens.json');
    writeFileSync(file, JSON.stringify({ accessToken: 'LEGACY', expiresAt: 5 }), { mode: 0o600 });
    // It cannot be shown to belong to this credential, so it is not trusted.
    expect(
      createFileStatePersistence<BearerTokens>({ filePath: file, boundTo: 'pw' }).load(),
    ).toBeNull();
  });

  it('still applies validate() to the enveloped state', () => {
    const file = join(dir, 'tokens.json');
    createFileStatePersistence<BearerTokens>({ filePath: file, boundTo: 'k' }).save({
      accessToken: 'AT',
      expiresAt: 1,
    });
    expect(
      createFileStatePersistence<BearerTokens>({
        filePath: file,
        boundTo: 'k',
        validate: () => null,
      }).load(),
    ).toBeNull();
  });
});

// ===========================================================================
// Keyed records — kiaaccess-mcp, alphaportal-mcp
// ===========================================================================

describe('createKeyedFileStatePersistence (kiaaccess/alphaportal: one file, many accounts)', () => {
  it('keeps accounts separate in one file', () => {
    const file = join(dir, 'sessions.json');
    const store = createKeyedFileStatePersistence<BearerTokens>({ filePath: file });
    store.forKey('a@example.com').save({ accessToken: 'A', expiresAt: 1 });
    store.forKey('b@example.com').save({ accessToken: 'B', expiresAt: 2 });

    const reopened = createKeyedFileStatePersistence<BearerTokens>({ filePath: file });
    expect(reopened.forKey('a@example.com').load()).toEqual({ accessToken: 'A', expiresAt: 1 });
    expect(reopened.forKey('b@example.com').load()).toEqual({ accessToken: 'B', expiresAt: 2 });
  });

  it('normalizes keys case-insensitively by default (accounts are emails, not origins)', () => {
    const file = join(dir, 'sessions.json');
    const store = createKeyedFileStatePersistence<BearerTokens>({ filePath: file });
    store.forKey('  A@Example.COM ').save({ accessToken: 'A', expiresAt: 1 });
    expect(store.forKey('a@example.com').load()).toEqual({ accessToken: 'A', expiresAt: 1 });
  });

  it('clearing one account leaves the others intact', () => {
    const file = join(dir, 'sessions.json');
    const store = createKeyedFileStatePersistence<BearerTokens>({ filePath: file });
    store.forKey('a').save({ accessToken: 'A', expiresAt: 1 });
    store.forKey('b').save({ accessToken: 'B', expiresAt: 2 });
    store.forKey('a').clear();
    expect(store.forKey('a').load()).toBeNull();
    expect(store.forKey('b').load()).toEqual({ accessToken: 'B', expiresAt: 2 });
  });

  it('lists the keys it holds', () => {
    const file = join(dir, 'sessions.json');
    const store = createKeyedFileStatePersistence<BearerTokens>({ filePath: file });
    store.forKey('a').save({ accessToken: 'A', expiresAt: 1 });
    store.forKey('b').save({ accessToken: 'B', expiresAt: 2 });
    expect(store.keys().sort()).toEqual(['a', 'b']);
  });

  it('a per-key view is a plain StatePersistence, so TokenManager takes it directly', async () => {
    const file = join(dir, 'sessions.json');
    const store = createKeyedFileStatePersistence<BearerTokens>({ filePath: file });
    store.forKey('alice').save({ accessToken: 'ALICE', expiresAt: later() });

    let logins = 0;
    const mgr = new TokenManager({
      initial: async () => {
        logins += 1;
        return { accessToken: 'fresh', expiresAt: later() };
      },
      refresh: async () => {
        throw new Error('no');
      },
      persistence: store.forKey('alice'),
    });
    expect(await mgr.getAccessToken()).toBe('ALICE');
    expect(logins).toBe(0);
  });

  it('hardens the file the same way the single-record store does', () => {
    const file = join(dir, 'nested', 'sessions.json');
    createKeyedFileStatePersistence<BearerTokens>({ filePath: file })
      .forKey('a')
      .save({ accessToken: 'A', expiresAt: 1 });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700);
  });

  it('survives a corrupt file rather than throwing', () => {
    const file = join(dir, 'sessions.json');
    writeFileSync(file, '{ not json', { mode: 0o600 });
    const store = createKeyedFileStatePersistence<BearerTokens>({ filePath: file });
    expect(store.forKey('a').load()).toBeNull();
    expect(() => store.forKey('a').save({ accessToken: 'A', expiresAt: 1 })).not.toThrow();
  });
});

// ===========================================================================
// Path override — all four repos, and how they keep their suites hermetic
// ===========================================================================

describe('resolveStateFile', () => {
  it('an explicit env var wins outright', () => {
    expect(
      resolveStateFile({
        envVar: 'KIA_SESSION_FILE',
        subdir: '.kiaaccess-mcp',
        fileName: 'session.json',
        env: { KIA_SESSION_FILE: '/tmp/x.json', MCP_DATA_DIR: '/data' },
      }),
    ).toBe('/tmp/x.json');
  });

  it('falls back to the state dir + subdir + file name', () => {
    expect(
      resolveStateFile({
        envVar: 'KIA_SESSION_FILE',
        subdir: '.kiaaccess-mcp',
        fileName: 'session.json',
        env: { MCP_DATA_DIR: '/data' },
      }),
    ).toBe('/data/.kiaaccess-mcp/session.json');
  });

  it('applies the same hardening to the override as to the base', () => {
    // A host that forwards an unexpanded env block must not create ./${...}.
    expect(
      resolveStateFile({
        envVar: 'KIA_SESSION_FILE',
        subdir: '.k',
        fileName: 's.json',
        env: { KIA_SESSION_FILE: '${KIA_SESSION_FILE}', HOME: '/home/u' },
      }),
    ).toBe('/home/u/.k/s.json');
    expect(
      resolveStateFile({
        envVar: 'KIA_SESSION_FILE',
        subdir: '.k',
        fileName: 's.json',
        env: { KIA_SESSION_FILE: 'null', HOME: '/home/u' },
      }),
    ).toBe('/home/u/.k/s.json');
  });

  it('works with no envVar at all', () => {
    expect(resolveStateFile({ subdir: '.s', fileName: 't.json', env: { HOME: '/h' } })).toBe(
      '/h/.s/t.json',
    );
  });
});

// ===========================================================================
// Review round 1 on #142 — a persistence failure is not a credential failure
// ===========================================================================

describe('a failed write must never be mistaken for a revoked credential', () => {
  it('does not clear the store or re-bootstrap when the hook rethrows', async () => {
    const file = join(dir, 'tokens.json');
    writeFileSync(
      file,
      JSON.stringify({ v: 1, state: { accessToken: 'a1', refreshToken: 'PRECIOUS', expiresAt: Date.now() - 1 } }),
      { mode: 0o600 },
    );
    let cleared = 0;
    let logins = 0;
    const mgr = new TokenManager({
      initial: async () => {
        logins += 1;
        return { accessToken: 'new', expiresAt: later() };
      },
      refresh: async () => ({ accessToken: 'a2', refreshToken: 'ROTATED', expiresAt: later() }),
      persistence: {
        load: () => JSON.parse(readFileSync(file, 'utf8')).state as BearerTokens,
        save: () => {
          throw new Error('EROFS');
        },
        clear: () => {
          cleared += 1;
        },
      },
      onPersistError: (err) => {
        throw new Error(`cannot persist: ${(err as Error).message}`);
      },
    });

    await expect(mgr.getAccessToken()).rejects.toThrow(/cannot persist/);
    // The refresh SUCCEEDED and burned the old token upstream. Deleting the
    // stored record here is the lockout this whole option exists to prevent.
    expect(cleared).toBe(0);
    expect(logins).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain('PRECIOUS');
  });

  it('still recovers when the refresh ITSELF is rejected', async () => {
    // The recovery path must stay intact for the case it was built for.
    let cleared = 0;
    let logins = 0;
    const mgr = new TokenManager({
      initial: async () => {
        logins += 1;
        return { accessToken: 'fresh', expiresAt: later() };
      },
      refresh: async () => {
        throw new Error('invalid_grant');
      },
      persistence: {
        load: () => ({ accessToken: 'old', refreshToken: 'revoked', expiresAt: Date.now() - 1 }),
        save: () => {},
        clear: () => {
          cleared += 1;
        },
      },
      onPersistError: () => {
        throw new Error('unused');
      },
    });
    expect(await mgr.getAccessToken()).toBe('fresh');
    expect(cleared).toBe(1);
    expect(logins).toBe(1);
  });

  it('withAuth takes the same protection', async () => {
    let cleared = 0;
    const mgr = new TokenManager({
      initial: async () => ({ accessToken: 'a1', refreshToken: 'r1', expiresAt: later() }),
      refresh: async () => ({ accessToken: 'a2', refreshToken: 'r2', expiresAt: later() }),
      persistence: {
        load: () => null,
        save: () => {
          throw new Error('ENOSPC');
        },
        clear: () => {
          cleared += 1;
        },
      },
      onPersistError: (err) => {
        throw err;
      },
    });
    await expect(mgr.withAuth(async () => new Response(null, { status: 401 }))).rejects.toThrow();
    expect(cleared).toBe(0);
  });
});

describe('binding digest hardening', () => {
  it('salts the digest, so the same credential does not produce a stable artifact', () => {
    const a = join(dir, 'a.json');
    const b = join(dir, 'b.json');
    createFileStatePersistence<BearerTokens>({ filePath: a, boundTo: 'same-password' }).save({
      accessToken: 'AT',
      expiresAt: 1,
    });
    createFileStatePersistence<BearerTokens>({ filePath: b, boundTo: 'same-password' }).save({
      accessToken: 'AT',
      expiresAt: 1,
    });
    const da = JSON.parse(readFileSync(a, 'utf8')).boundTo;
    const db = JSON.parse(readFileSync(b, 'utf8')).boundTo;
    expect(da.digest).not.toBe(db.digest); // no rainbow-table target
    // ...and each still verifies against its own salt.
    expect(createFileStatePersistence<BearerTokens>({ filePath: a, boundTo: 'same-password' }).load()).not.toBeNull();
    expect(createFileStatePersistence<BearerTokens>({ filePath: b, boundTo: 'same-password' }).load()).not.toBeNull();
  });
});

describe('resolveStateFile path expansion', () => {
  it('expands a ~ in the env override instead of creating a literal ./~', () => {
    const got = resolveStateFile({
      envVar: 'X_FILE',
      subdir: '.x',
      fileName: 't.json',
      env: { X_FILE: '~/state/t.json', HOME: '/home/u' },
    });
    expect(got.startsWith('~')).toBe(false);
    expect(got.endsWith('/state/t.json')).toBe(true);
  });
});
