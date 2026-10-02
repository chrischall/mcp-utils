/**
 * TokenManager over a token store SHARED between processes (fleet-audit#1008).
 *
 * TokenManager reads its persistence once per process. When two processes share
 * the store (Claude Desktop plus a Claude Code session) and the service rotates
 * single-use refresh tokens — FreshBooks does — the second process to refresh
 * spends a token the first already spent: `invalid_grant`, and an account that
 * needs a human to re-run OAuth while a valid successor sits on disk.
 * freshbooks-mcp hand-rolled a lock file plus a re-read around `refresh`; the
 * `reloadBeforeRefresh` option is that, in the manager.
 *
 * Two TokenManager instances over one file stand in for the two processes.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TokenManager,
  createFileStatePersistence,
  type BearerTokens,
  type RefreshedTokens,
  type StatePersistence,
} from './index.js';

class InvalidGrant extends Error {
  readonly status = 400;
  constructor(rt: string) {
    super(`invalid_grant: ${rt} was already used`);
  }
}

/**
 * A rotating OAuth server: exactly one refresh token is live at a time, and
 * spending it mints its successor. Each exchange waits on `gate` when set, so a
 * test can hold the first refresh open while a second process arrives.
 */
function rotatingServer(start = 1) {
  let live = `RT${start}`;
  let n = start;
  const server = {
    spent: [] as string[],
    gate: null as Promise<void> | null,
    async refresh(rt: string): Promise<RefreshedTokens> {
      server.spent.push(rt);
      if (server.gate) await server.gate;
      if (rt !== live) throw new InvalidGrant(rt);
      n += 1;
      live = `RT${n}`;
      return { accessToken: `AT${n}`, refreshToken: live, expiresAt: Date.now() + 3_600_000 };
    },
  };
  return server;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const expired = (rt: string, at = 'AT-old'): BearerTokens => ({ accessToken: at, refreshToken: rt, expiresAt: 0 });

let dir: string;
let filePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-utils-tm-shared-'));
  filePath = join(dir, 'tokens.json');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('TokenManager reloadBeforeRefresh (fleet-audit#1008)', () => {
  const store = (): StatePersistence<BearerTokens> => createFileStatePersistence<BearerTokens>({ filePath });

  it('two processes refreshing at once spend the rotating token exactly once', async () => {
    const server = rotatingServer();
    store().save(expired('RT1'));
    const gate = deferred();
    server.gate = gate.promise;
    const a = new TokenManager({ initial: expired('RT1'), refresh: server.refresh, persistence: store(), reloadBeforeRefresh: true });
    const b = new TokenManager({ initial: expired('RT1'), refresh: server.refresh, persistence: store(), reloadBeforeRefresh: true });

    const pa = a.getAccessToken();
    const pb = b.getAccessToken();
    // Hold A's exchange open long enough for B to reach (and wait on) the lock.
    await new Promise((r) => setTimeout(r, 60));
    expect(server.spent).toEqual(['RT1']);
    gate.resolve();

    expect(await pa).toBe('AT2');
    // B found A's fresh token on disk under the lock and adopted it.
    expect(await pb).toBe('AT2');
    expect(server.spent).toEqual(['RT1']);
  });

  it('spends the successor on disk, not the spent token in memory, when the stored access token has also expired', async () => {
    const server = rotatingServer(2); // RT1 is already spent; RT2 is live
    const b = new TokenManager({ initial: expired('RT1'), refresh: server.refresh, persistence: store(), reloadBeforeRefresh: true });
    // Another process rotated to RT2 long enough ago that its access token is stale too.
    store().save(expired('RT2', 'AT-other'));
    expect(await b.getAccessToken()).toBe('AT3');
    expect(server.spent).toEqual(['RT2']);
  });

  it('ignores a record OLDER than the one in memory', async () => {
    const server = rotatingServer(5);
    store().save({ accessToken: 'AT-ancient', refreshToken: 'RT1', expiresAt: 1 });
    const mgr = new TokenManager({
      initial: { accessToken: 'AT-mine', refreshToken: 'RT5', expiresAt: 2 },
      refresh: server.refresh,
      persistence: store(),
      reloadBeforeRefresh: true,
    });
    expect(await mgr.getAccessToken()).toBe('AT6');
    expect(server.spent).toEqual(['RT5']);
  });

  it('writes the rotated token while still holding the lock', async () => {
    const events: string[] = [];
    let inLock = false;
    const inner = createFileStatePersistence<BearerTokens>({ filePath });
    const traced: StatePersistence<BearerTokens> = {
      load: () => inner.load(),
      save: (t) => {
        events.push(`save:${inLock ? 'locked' : 'UNLOCKED'}`);
        inner.save(t);
      },
      clear: () => inner.clear(),
      withLock: async (fn) => {
        inLock = true;
        events.push('lock');
        try {
          return await fn();
        } finally {
          inLock = false;
          events.push('unlock');
        }
      },
    };
    const server = rotatingServer();
    const mgr = new TokenManager({ initial: expired('RT1'), refresh: server.refresh, persistence: traced, reloadBeforeRefresh: true });
    await mgr.getAccessToken();
    expect(events).toEqual(['lock', 'save:locked', 'unlock']);
  });

  it('without the option, the second process spends the dead token (the bug, pinned)', async () => {
    const server = rotatingServer();
    const a = new TokenManager({ initial: expired('RT1'), refresh: server.refresh, persistence: store() });
    const b = new TokenManager({ initial: expired('RT1'), refresh: server.refresh, persistence: store() });
    expect(await a.getAccessToken()).toBe('AT2');
    await expect(b.getAccessToken()).rejects.toThrow(InvalidGrant);
    expect(server.spent).toEqual(['RT1', 'RT1']);
  });

  it('refuses reloadBeforeRefresh without persistence to reload from', () => {
    expect(
      () => new TokenManager({ initial: expired('RT1'), refresh: async () => expired('x'), reloadBeforeRefresh: true }),
    ).toThrow(/reloadBeforeRefresh/);
  });

  it('the file store exposes a lock beside the file', async () => {
    const p = createFileStatePersistence<BearerTokens>({ filePath });
    expect(typeof p.withLock).toBe('function');
    expect(await p.withLock!(async () => 'inside')).toBe('inside');
  });
});
