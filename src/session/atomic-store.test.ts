/**
 * mcp-utils#330 (auto-review of #326): a fresh-mode reader racing a writer.
 *
 * `SessionStore` used to rewrite its file IN PLACE (`writeFileSync` on the
 * target). A sibling's lock-free fresh-mode `get()` that landed mid-write read a
 * truncated file, failed to parse it, and `preserveCorruptFile()` renamed the
 * LIVE store to `.corrupt` — every session gone.
 *
 * Two fixes, each pinned here: every store writes a temp file and renames it
 * over the target (a reader sees the old file or the new one, never half of
 * one), and a fresh-mode parse failure is re-read UNDER THE LOCK before
 * anything is quarantined.
 *
 * `node:fs` is wrapped so a test can (a) see every write's target path and
 * (b) hand the next read of the store a torn copy, which is what a reader
 * racing an in-place writer observed.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const hooks = vi.hoisted(() => ({
  writes: [] as string[],
  exclusiveOpens: [] as string[],
  tornReads: 0,
  tornFor: '' as string,
}));

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    writeFileSync: (...args: Parameters<typeof real.writeFileSync>) => {
      if (typeof args[0] === 'string') hooks.writes.push(args[0]);
      return real.writeFileSync(...args);
    },
    openSync: (...args: Parameters<typeof real.openSync>) => {
      if (typeof args[0] === 'string' && args[1] === 'wx') hooks.exclusiveOpens.push(args[0]);
      return real.openSync(...args);
    },
    readFileSync: (...args: Parameters<typeof real.readFileSync>) => {
      const out = real.readFileSync(...args);
      if (hooks.tornReads > 0 && args[0] === hooks.tornFor) {
        hooks.tornReads -= 1;
        // Half the bytes: what a reader saw while an in-place writer was mid-write.
        const text = String(out);
        return text.slice(0, Math.floor(text.length / 2)) as never;
      }
      return out;
    },
  };
});

import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionStore, createFileStatePersistence, createKeyedFileStatePersistence } from './index.js';

interface Rec extends Record<string, unknown> {
  id: string;
  token: string;
}

let dir: string;
let filePath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-utils-atomic-'));
  filePath = join(dir, 'sessions.json');
  hooks.writes.length = 0;
  hooks.exclusiveOpens.length = 0;
  hooks.tornReads = 0;
  hooks.tornFor = filePath;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const open = (fresh: boolean): SessionStore<Rec> =>
  new SessionStore<Rec>({ filePath, keyOf: (r) => r.id, normalizeKey: (k) => k, fresh });

describe('every store replaces its file atomically (never writes the target in place)', () => {
  it('SessionStore', () => {
    open(false).add({ id: 'a', token: '1' });
    expect(existsSync(filePath)).toBe(true);
    expect(hooks.writes).not.toContain(filePath);
    expect(readdirSync(dir)).toEqual(['sessions.json']); // no temp file left behind
  });

  it('createFileStatePersistence', () => {
    createFileStatePersistence<{ x: number }>({ filePath }).save({ x: 1 });
    expect(hooks.writes).not.toContain(filePath);
    expect(readdirSync(dir)).toEqual(['sessions.json']);
  });

  it('createKeyedFileStatePersistence', () => {
    createKeyedFileStatePersistence<{ x: number }>({ filePath }).forKey('k').save({ x: 1 });
    expect(hooks.writes).not.toContain(filePath);
    expect(readdirSync(dir)).toEqual(['sessions.json']);
  });
});

describe('a fresh-mode torn read is re-read under the lock, not quarantined', () => {
  it('get() keeps every session and the live file when the locked re-read parses', () => {
    const writer = open(true);
    writer.add({ id: 'a', token: '1' });
    writer.add({ id: 'b', token: '2' });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reader = open(true);
    hooks.tornReads = 1; // the lock-free read lands mid-write; the locked re-read does not
    expect(reader.get('a')?.token).toBe('1');
    expect(reader.list().map((r) => r.id)).toEqual(['a', 'b']);
    expect(existsSync(filePath)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes('.corrupt'))).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('still quarantines a file that is corrupt under the lock too', () => {
    const writer = open(true);
    writer.add({ id: 'a', token: '1' });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    hooks.tornReads = 2; // corrupt on both reads: genuinely damaged
    expect(open(true).get('a')).toBeNull();
    expect(readdirSync(dir).some((f) => f.includes('.corrupt'))).toBe(true);
    errors.mockRestore();
  });
});

describe('the lock file is never created empty (mcp-utils#330)', () => {
  it('appears with its owner already written (staged file hard-linked into place)', () => {
    open(true).add({ id: 'a', token: '1' });
    // An O_EXCL create of the lock path itself would leave a window in which
    // the file exists with no owner in it.
    expect(hooks.exclusiveOpens).not.toContain(`${filePath}.lock`);
    expect(readdirSync(dir)).toEqual(['sessions.json']);
  });
});
