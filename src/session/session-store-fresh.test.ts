/**
 * SessionStore across processes (fleet-audit#1116).
 *
 * The store used to read its file once, in the constructor, and rewrite the
 * whole file from that snapshot on every add/remove. Two processes sharing the
 * file (Claude Desktop beside Claude Code) therefore each wrote their stale
 * snapshot back over the other's change. simplepractice-mcp, kiaaccess-mcp and
 * freshbooks-mcp each worked around it by re-constructing the store per access.
 *
 * Two SessionStore instances on one file stand in for the two processes: they
 * share nothing but the file, exactly as two processes would.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionStore } from './index.js';

interface Rec extends Record<string, unknown> {
  id: string;
  token: string;
}

const DEAD_PID = 2 ** 22 + 12345;

describe('SessionStore fresh mode (fleet-audit#1116)', () => {
  let dir: string;
  let filePath: string;
  const open = (fresh: boolean): SessionStore<Rec> =>
    new SessionStore<Rec>({ filePath, keyOf: (r) => r.id, normalizeKey: (k) => k.toLowerCase(), fresh });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-utils-store-fresh-'));
    filePath = join(dir, 'sessions.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('sees a record another process added after construction', () => {
    const a = open(true);
    const b = open(true);
    b.add({ id: 'x', token: 't1' });
    expect(a.get('x')?.token).toBe('t1');
    expect(a.getActiveSession()?.id).toBe('x');
    expect(a.list().map((r) => r.id)).toEqual(['x']);
  });

  it("does not write a record another process removed back to disk", () => {
    const a = open(true);
    const b = open(true);
    a.add({ id: 'x', token: 't1' });
    b.remove('x'); // the other process signs out
    a.add({ id: 'y', token: 't2' });
    expect(open(false).list().map((r) => r.id)).toEqual(['y']);
  });

  it("does not drop a record another process added between this one's read and write", () => {
    const a = open(true);
    const b = open(true);
    a.add({ id: 'x', token: 't1' });
    b.add({ id: 'y', token: 't2' });
    a.add({ id: 'z', token: 't3' });
    expect(open(false).list().map((r) => r.id).sort()).toEqual(['x', 'y', 'z']);
  });

  it('forgets everything when another process deleted the file', () => {
    const a = open(true);
    a.add({ id: 'x', token: 't1' });
    rmSync(filePath);
    expect(a.get('x')).toBeNull();
    expect(a.getActiveSession()).toBeNull();
  });

  it('remove() of a record only another process has still removes it', () => {
    const a = open(true);
    const b = open(true);
    b.add({ id: 'x', token: 't1' });
    expect(a.remove('x')).toBe(true);
    expect(b.get('x')).toBeNull();
  });

  it('takes the lock file for a write and leaves none behind', () => {
    const a = open(true);
    // A crashed writer left its lock behind: a dead holder is broken, not waited on.
    writeFileSync(`${filePath}.lock`, `${DEAD_PID}:crashed`);
    a.add({ id: 'x', token: 't1' });
    expect(existsSync(`${filePath}.lock`)).toBe(false);
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual([{ id: 'x', token: 't1' }]);
  });

  it('reload() refreshes a default-mode store on demand', () => {
    const a = open(false);
    const b = open(false);
    b.add({ id: 'x', token: 't1' });
    expect(a.get('x')).toBeNull(); // default mode: the constructor snapshot
    a.reload();
    expect(a.get('x')?.token).toBe('t1');
  });

  it('default mode keeps its constructor snapshot (unchanged behaviour)', () => {
    const a = open(false);
    const b = open(false);
    b.add({ id: 'x', token: 't1' });
    expect(a.get('x')).toBeNull();
  });
});

describe('SessionStore active pointer survives a restart after re-adding a key', () => {
  let dir: string;
  let filePath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-utils-store-mru-'));
    filePath = join(dir, 'sessions.json');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // simplepractice-mcp mostRecentSessionHost(): add() on an existing key left
  // the record in its ORIGINAL position, so the in-memory pointer named the key
  // just added while a fresh process restored the pointer as the LAST key on
  // disk — sign in to A, then B, then A again, and the next process talked to B.
  it('A, B, A again → the next process starts on A', () => {
    const open = (): SessionStore<Rec> => new SessionStore<Rec>({ filePath, keyOf: (r) => r.id, normalizeKey: (k) => k });
    const s = open();
    s.add({ id: 'A', token: '1' });
    s.add({ id: 'B', token: '2' });
    s.add({ id: 'A', token: '3' });
    expect(s.getActiveSession()?.id).toBe('A');
    expect(open().getActiveSession()?.id).toBe('A');
    expect(open().getActiveSession()?.token).toBe('3');
  });
});
