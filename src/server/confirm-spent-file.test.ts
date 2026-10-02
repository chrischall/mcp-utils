import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileSpentTokenStore } from './confirm-spent-file.js';
import { issueConfirmToken, verifyConfirmToken, type ConfirmTokenBinding } from './confirm-token.js';

const KEY = 'k'.repeat(32);
const BINDING: ConfirmTokenBinding = { tool: 'thing_delete', target: 'id-1', payloadHash: 'h' };
const NOW = 1_800_000_000_000;

let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcpu-spent-'));
  dir = join(root, 'spent');
});
afterEach(() => {
  try { chmodSync(root, 0o700); chmodSync(dir, 0o700); } catch { /* may not exist */ }
  rmSync(root, { recursive: true, force: true });
});

describe('createFileSpentTokenStore', () => {
  it('remembers a spent nonce across store instances — the restart this exists for', () => {
    const before = createFileSpentTokenStore(dir);
    expect(before.has('n1')).toBe(false);
    before.add('n1', NOW + 60_000);
    // A new process: a new store over the same directory.
    const after = createFileSpentTokenStore(dir);
    expect(after.has('n1')).toBe(true);
    expect(after.size).toBe(1);
  });

  it('a token spent before a restart is TOKEN_REUSED after it', () => {
    const { token } = issueConfirmToken(KEY, BINDING, { now: NOW });
    expect(verifyConfirmToken(KEY, token, BINDING, { now: NOW, spent: createFileSpentTokenStore(dir) })).toEqual({ ok: true });
    expect(verifyConfirmToken(KEY, token, BINDING, { now: NOW + 1, spent: createFileSpentTokenStore(dir) }))
      .toEqual({ ok: false, error: 'TOKEN_REUSED' });
  });

  it('claim is atomic: exactly one of two stores over one directory wins a nonce', () => {
    const a = createFileSpentTokenStore(dir);
    const b = createFileSpentTokenStore(dir);
    expect(a.has('race')).toBe(false);
    expect(b.has('race')).toBe(false);
    // Both passed has(); only one may spend.
    expect(a.claim?.('race', NOW + 60_000)).toBe(true);
    expect(b.claim?.('race', NOW + 60_000)).toBe(false);
  });

  it('verify uses the atomic claim, so a second process racing past has() is still TOKEN_REUSED', () => {
    const { token } = issueConfirmToken(KEY, BINDING, { now: NOW });
    const racer = createFileSpentTokenStore(dir);
    // Another process claimed the nonce between this one's has() and its spend.
    const lagging = { ...racer, has: () => false, prune: () => {}, get size() { return 0; } };
    expect(verifyConfirmToken(KEY, token, BINDING, { now: NOW, spent: createFileSpentTokenStore(dir) })).toEqual({ ok: true });
    expect(verifyConfirmToken(KEY, token, BINDING, { now: NOW, spent: lagging })).toEqual({ ok: false, error: 'TOKEN_REUSED' });
  });

  it('writes the directory 0700 and each entry 0600', () => {
    createFileSpentTokenStore(dir).add('n1', NOW);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'n1')).mode & 0o777).toBe(0o600);
  });

  it('prunes entries past their expiry and keeps the rest — bounded by the TTL, not by history', () => {
    const store = createFileSpentTokenStore(dir);
    store.add('old', NOW - 1);
    store.add('live', NOW + 60_000);
    store.prune(NOW);
    expect(readdirSync(dir).sort()).toEqual(['live']);
    expect(store.has('old')).toBe(false);
    expect(store.has('live')).toBe(true);
  });

  it('keeps an unreadable entry (a torn write) until it is a day old — never forgets a spend early', () => {
    const store = createFileSpentTokenStore(dir);
    store.add('seed', NOW + 60_000);
    writeFileSync(join(dir, 'torn'), '', { mode: 0o600 });
    store.prune(Date.now() + 10 * 60_000);
    expect(store.has('torn')).toBe(true);
    const old = (Date.now() - 25 * 3600_000) / 1000;
    utimesSync(join(dir, 'torn'), old, old);
    store.prune(Date.now());
    expect(store.has('torn')).toBe(false);
  });

  it('ignores names that are not nonces when pruning, and refuses a non-nonce lookup', () => {
    const store = createFileSpentTokenStore(dir);
    store.add('n1', NOW - 1);
    writeFileSync(join(dir, 'not.a.nonce'), '0');
    store.prune(NOW);
    expect(readdirSync(dir).sort()).toEqual(['not.a.nonce']);
    expect(() => store.has('../escape')).toThrow(/nonce/);
    expect(() => store.add('a/b', NOW)).toThrow(/nonce/);
  });

  it('a directory that does not exist yet is an empty store', () => {
    const store = createFileSpentTokenStore(dir);
    expect(store.has('n1')).toBe(false);
    expect(store.size).toBe(0);
    expect(() => store.prune(NOW)).not.toThrow();
  });

  it('clear empties it', () => {
    const store = createFileSpentTokenStore(dir);
    store.add('a', NOW);
    store.add('b', NOW);
    store.clear();
    expect(store.size).toBe(0);
    expect(store.has('a')).toBe(false);
  });

  // Fail CLOSED: a store that cannot answer "was this spent?" must not let the
  // action through. Root ignores permission bits, so these skip under uid 0.
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(asRoot)('throws, rather than answering "not spent", when the store cannot be read', () => {
    const store = createFileSpentTokenStore(dir);
    store.add('seed', NOW + 60_000);
    chmodSync(dir, 0o000);
    expect(() => store.has('n1')).toThrow(/spent-token store/);
  });

  it.skipIf(asRoot)('a verify against an unreadable store throws and spends nothing', () => {
    const store = createFileSpentTokenStore(dir);
    store.add('seed', NOW + 60_000);
    const { token } = issueConfirmToken(KEY, BINDING, { now: NOW });
    chmodSync(dir, 0o000);
    expect(() => verifyConfirmToken(KEY, token, BINDING, { now: NOW, spent: store })).toThrow(/spent-token store/);
  });

  it.skipIf(asRoot)('throws when the spend cannot be recorded, so the action does not run unrecorded', () => {
    const store = createFileSpentTokenStore(dir);
    store.add('seed', NOW + 60_000);
    chmodSync(dir, 0o500); // readable, not writable
    expect(store.has('n1')).toBe(false);
    expect(() => store.claim?.('n1', NOW + 60_000)).toThrow(/spent-token store/);
    const { token } = issueConfirmToken(KEY, BINDING, { now: NOW });
    expect(() => verifyConfirmToken(KEY, token, BINDING, { now: NOW, spent: store })).toThrow(/spent-token store/);
  });

  it.skipIf(asRoot)('a failed prune is housekeeping, not a refusal', () => {
    const store = createFileSpentTokenStore(dir);
    store.add('old', NOW - 1);
    chmodSync(dir, 0o500);
    expect(() => store.prune(NOW)).not.toThrow();
  });
});

describe('the package exports', () => {
  it('reaches the file store and the env default from the core barrel', async () => {
    const root = await import('../index.js');
    expect(root.createFileSpentTokenStore).toBe(createFileSpentTokenStore);
    expect(typeof root.spentTokenStoreFromEnv).toBe('function');
  });
});
