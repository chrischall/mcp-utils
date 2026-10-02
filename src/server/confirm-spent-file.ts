/**
 * A {@link SpentTokenStore} on disk, so "single use" survives a restart.
 *
 * The in-memory store forgets every spend when the process exits. With a
 * random per-process key that is harmless — a restart invalidates every
 * outstanding token anyway. With a STABLE key (an operator's
 * `MCP_CONFIRM_SECRET`, or the one mcp-host derives per child) it is a replay
 * window: a token spent just before a restart verifies again after it, until it
 * expires. A hosted child idle-stops after about ten minutes, close to the
 * default 600 s TTL, so that window is the normal case there, not an edge
 * (fleet audit 2026-09-24, kiaaccess-mcp BUG-2).
 *
 * One file per spent nonce, named by the nonce and holding its expiry:
 * - **Atomic spend.** `claim` creates the file with `O_EXCL` (`wx`), so of two
 *   processes sharing the directory that both passed `has`, exactly one spends.
 * - **Bounded.** Every verify prunes entries past their expiry, so the
 *   directory holds at most one TTL's worth of approvals.
 * - **Fails closed.** A lookup or a spend that cannot be done THROWS rather
 *   than answering "not spent", so the gate errors and nothing runs. Only
 *   `prune` swallows errors — it is housekeeping. An entry whose expiry cannot
 *   be read (a write torn by a crash) is kept until it is a day old rather
 *   than forgotten early.
 *
 * 0700 directory, 0600 entries, like the session store.
 */
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SpentTokenStore } from './confirm-token.js';

/** Nonces are 16 random bytes base64url (`issueConfirmToken`); anything else is not ours. */
const NONCE = /^[A-Za-z0-9_-]{1,128}$/;
/** How long an entry whose expiry cannot be read is kept: far beyond any sane TTL. */
const UNREADABLE_KEEP_MS = 24 * 3600_000;

function code(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * A spent-token store backed by `dir` (created 0700 on the first spend). Share
 * one directory between every process that verifies tokens under the same key.
 */
export function createFileSpentTokenStore(dir: string): SpentTokenStore {
  const fail = (what: string, err: unknown): never => {
    throw new Error(
      `confirm token: the spent-token store at ${dir} could not be ${what} (${code(err) ?? String(err)}); `
      + 'refusing rather than risking a second use of an approval.',
    );
  };
  const entry = (nonce: string): string => {
    if (!NONCE.test(nonce)) throw new TypeError(`confirm token: ${JSON.stringify(nonce)} is not a nonce.`);
    return join(dir, nonce);
  };
  const names = (): string[] => {
    try {
      return readdirSync(dir).filter((n) => NONCE.test(n));
    } catch (err) {
      if (code(err) === 'ENOENT') return [];
      throw err;
    }
  };
  const claim = (nonce: string, expiresAtMs: number): boolean => {
    const path = entry(nonce);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      writeFileSync(path, String(expiresAtMs), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (err) {
      if (code(err) === 'EEXIST') return false;
      return fail('written', err);
    }
  };
  return {
    has(nonce) {
      const path = entry(nonce);
      try {
        statSync(path);
        return true;
      } catch (err) {
        if (code(err) === 'ENOENT') return false;
        return fail('read', err);
      }
    },
    add(nonce, expiresAtMs) {
      claim(nonce, expiresAtMs);
    },
    claim,
    prune(now) {
      try {
        for (const name of names()) {
          const path = join(dir, name);
          try {
            const raw = readFileSync(path, 'utf8').trim();
            const exp = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
            const expired = Number.isFinite(exp) ? exp < now : statSync(path).mtimeMs < now - UNREADABLE_KEEP_MS;
            if (expired) unlinkSync(path);
          } catch {
            // One entry we cannot judge or remove stays; the next prune retries.
          }
        }
      } catch {
        // Housekeeping only: `has` and `claim` are what refuse.
      }
    },
    clear() {
      for (const name of names()) rmSync(join(dir, name), { force: true });
    },
    get size() {
      return names().length;
    },
  };
}
