import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assertPathWithinRoots, fileBlob, readFileHead, resolveOutputDir } from './index.js';

// audit 2026-09 (SEC-5): opt-in root confinement for tool-supplied paths.

let base: string;
let root: string;
let outside: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'mcp-utils-confine-'));
  root = join(base, 'root');
  outside = join(base, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(root, 'in.txt'), 'inside');
  writeFileSync(join(outside, 'secret.json'), '{"refresh_token":"x"}');
  symlinkSync(join(outside, 'secret.json'), join(root, 'link.json'));
  symlinkSync(outside, join(root, 'escape-dir'));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('fileBlob allowedRoots', () => {
  it('reads a file inside an allowed root', async () => {
    const blob = await fileBlob(join(root, 'in.txt'), { allowedRoots: [root] });
    expect(await blob.text()).toBe('inside');
  });

  it('rejects a file outside every allowed root', async () => {
    await expect(fileBlob(join(outside, 'secret.json'), { allowedRoots: [root] })).rejects.toThrow(/outside/);
  });

  it('rejects a .. traversal out of the root', async () => {
    await expect(fileBlob(join(root, '..', 'outside', 'secret.json'), { allowedRoots: [root] })).rejects.toThrow(
      /outside/,
    );
  });

  it('rejects a symlink inside the root that points out of it', async () => {
    await expect(fileBlob(join(root, 'link.json'), { allowedRoots: [root] })).rejects.toThrow(/outside/);
  });

  it('is unchanged without allowedRoots', async () => {
    const blob = await fileBlob(join(outside, 'secret.json'));
    expect(blob.size).toBeGreaterThan(0);
  });
});

describe('readFileHead allowedRoots', () => {
  it('reads inside, rejects outside', async () => {
    expect((await readFileHead(join(root, 'in.txt'), 3, { allowedRoots: [root] })).toString()).toBe('ins');
    await expect(readFileHead(join(root, 'link.json'), 3, { allowedRoots: [root] })).rejects.toThrow(/outside/);
  });
});

describe('resolveOutputDir allowedRoots', () => {
  it('accepts and creates a new per-call dir inside the root', () => {
    const target = join(root, 'a', 'b');
    expect(resolveOutputDir(target, 'X_OUT', { env: {}, allowedRoots: [root] })).toBe(target);
    expect(existsSync(target)).toBe(true);
  });

  it('rejects a per-call dir outside the root without creating it', () => {
    const target = join(outside, 'new');
    expect(() => resolveOutputDir(target, 'X_OUT', { env: {}, allowedRoots: [root] })).toThrow(/outside/);
    expect(existsSync(target)).toBe(false);
  });

  it('rejects a per-call dir that escapes through a symlinked parent', () => {
    const target = join(root, 'escape-dir', 'new');
    expect(() => resolveOutputDir(target, 'X_OUT', { env: {}, allowedRoots: [root] })).toThrow(/outside/);
    expect(existsSync(join(outside, 'new'))).toBe(false);
  });

  it('does not constrain the operator-set env var', () => {
    const target = join(outside, 'env-out');
    expect(resolveOutputDir(undefined, 'X_OUT', { env: { X_OUT: target }, allowedRoots: [root] })).toBe(target);
  });
});

describe('assertPathWithinRoots', () => {
  it('returns the resolved real path when contained', () => {
    expect(assertPathWithinRoots(join(root, 'in.txt'), [root])).toMatch(/in\.txt$/);
  });

  it('treats a sibling with a shared prefix as outside', () => {
    mkdirSync(join(base, 'root-evil'));
    writeFileSync(join(base, 'root-evil', 'x'), 'x');
    expect(() => assertPathWithinRoots(join(base, 'root-evil', 'x'), [root])).toThrow(/outside/);
  });
});
