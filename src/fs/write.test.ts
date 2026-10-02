import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileWriteRefusedError, writeBinaryOutput, writeFileSafe, writeUniqueFile } from './index.js';

let dir: string;
let outside: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-utils-write-'));
  outside = mkdtempSync(join(tmpdir(), 'mcp-utils-write-outside-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const bytes = (s: string) => new Uint8Array(Buffer.from(s));

async function refusal(p: Promise<unknown>): Promise<FileWriteRefusedError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(FileWriteRefusedError);
  return err as FileWriteRefusedError;
}

describe('writeFileSafe', () => {
  it('creates a new file with the bytes', async () => {
    const p = join(dir, 'a.bin');
    expect(await writeFileSafe(p, bytes('hello'))).toBe(p);
    expect(readFileSync(p, 'utf8')).toBe('hello');
  });

  it('refuses to clobber an existing file by default (exclusive create)', async () => {
    const p = join(dir, 'a.bin');
    writeFileSync(p, 'old');
    const err = await refusal(writeFileSafe(p, bytes('new')));
    expect(err.reason).toBe('exists');
    expect(readFileSync(p, 'utf8')).toBe('old');
  });

  it('replaces an existing file when overwrite is set', async () => {
    const p = join(dir, 'a.bin');
    writeFileSync(p, 'old-and-longer');
    await writeFileSafe(p, bytes('new'), { overwrite: true });
    expect(readFileSync(p, 'utf8')).toBe('new');
  });

  it('never writes through a symlink at the final component (exclusive mode)', async () => {
    const victim = join(outside, 'victim.txt');
    writeFileSync(victim, 'precious');
    const link = join(dir, 'out.bin');
    symlinkSync(victim, link);
    const err = await refusal(writeFileSafe(link, bytes('pwned')));
    expect(['exists', 'symlink']).toContain(err.reason);
    expect(readFileSync(victim, 'utf8')).toBe('precious');
  });

  it('never writes through a symlink at the final component (overwrite mode)', async () => {
    const victim = join(outside, 'victim.txt');
    writeFileSync(victim, 'precious');
    const link = join(dir, 'out.bin');
    symlinkSync(victim, link);
    const err = await refusal(writeFileSafe(link, bytes('pwned'), { overwrite: true }));
    expect(err.reason).toBe('symlink');
    expect(readFileSync(victim, 'utf8')).toBe('precious');
  });

  it('never creates the target of a dangling symlink', async () => {
    const target = join(outside, 'planted.txt');
    const link = join(dir, 'out.bin');
    symlinkSync(target, link);
    await refusal(writeFileSafe(link, bytes('pwned')));
    await refusal(writeFileSafe(link, bytes('pwned'), { overwrite: true }));
    expect(existsSync(target)).toBe(false);
  });

  it('applies mode to a new file', async () => {
    const p = join(dir, 'secret.bin');
    await writeFileSafe(p, bytes('x'), { mode: 0o600 });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('tightens the mode of an overwritten file when mode is given', async () => {
    const p = join(dir, 'secret.bin');
    writeFileSync(p, 'old', { mode: 0o644 });
    await writeFileSafe(p, bytes('new'), { overwrite: true, mode: 0o600 });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  it('refuses a path outside allowedRoots before touching the disk', async () => {
    const p = join(outside, 'escape.bin');
    const err = await refusal(writeFileSafe(p, bytes('x'), { allowedRoots: [dir] }));
    expect(err.reason).toBe('outside-roots');
    expect(existsSync(p)).toBe(false);
  });

  it('refuses a path that escapes allowedRoots through a symlinked directory', async () => {
    symlinkSync(outside, join(dir, 'sneaky'));
    const err = await refusal(writeFileSafe(join(dir, 'sneaky', 'escape.bin'), bytes('x'), { allowedRoots: [dir] }));
    expect(err.reason).toBe('outside-roots');
    expect(existsSync(join(outside, 'escape.bin'))).toBe(false);
  });

  it('writes inside allowedRoots and returns the real path', async () => {
    const p = join(dir, 'ok.bin');
    const written = await writeFileSafe(p, bytes('x'), { allowedRoots: [dir] });
    expect(readFileSync(written, 'utf8')).toBe('x');
    expect(readFileSync(p, 'utf8')).toBe('x');
  });

  it('surfaces a missing parent directory as an ordinary error, not a refusal', async () => {
    const err = await writeFileSafe(join(dir, 'nope', 'a.bin'), bytes('x')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(FileWriteRefusedError);
    expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
  });
});

describe('writeUniqueFile', () => {
  it('writes base.ext, then base-2.ext, base-3.ext — never clobbering', async () => {
    const a = await writeUniqueFile({ dir, baseName: 'shot', extension: 'png', bytes: bytes('1') });
    const b = await writeUniqueFile({ dir, baseName: 'shot', extension: 'png', bytes: bytes('2') });
    const c = await writeUniqueFile({ dir, baseName: 'shot', extension: 'png', bytes: bytes('3') });
    expect([a, b, c]).toEqual([join(dir, 'shot.png'), join(dir, 'shot-2.png'), join(dir, 'shot-3.png')]);
    expect(readFileSync(a, 'utf8')).toBe('1');
    expect(readFileSync(c, 'utf8')).toBe('3');
  });

  it('creates the directory', async () => {
    const nested = join(dir, 'a', 'b');
    const p = await writeUniqueFile({ dir: nested, baseName: 'x', extension: 'bin', bytes: bytes('x') });
    expect(p).toBe(join(nested, 'x.bin'));
  });

  it('skips past a planted symlink instead of writing through it', async () => {
    const target = join(outside, 'planted.txt');
    symlinkSync(target, join(dir, 'shot.png'));
    const p = await writeUniqueFile({ dir, baseName: 'shot', extension: 'png', bytes: bytes('x') });
    expect(p).toBe(join(dir, 'shot-2.png'));
    expect(existsSync(target)).toBe(false);
  });

  it('sanitizes a traversal baseName to a single component', async () => {
    const p = await writeUniqueFile({ dir, baseName: '../../etc/evil', extension: 'bin', bytes: bytes('x') });
    expect(p.startsWith(dir)).toBe(true);
    expect(p.slice(dir.length + 1)).not.toMatch(/[/\\]/);
  });

  it('gives up after maxAttempts with an exists refusal', async () => {
    writeFileSync(join(dir, 'shot.png'), '');
    writeFileSync(join(dir, 'shot-2.png'), '');
    const err = await refusal(writeUniqueFile({ dir, baseName: 'shot', extension: 'png', bytes: bytes('x'), maxAttempts: 2 }));
    expect(err.reason).toBe('exists');
  });

  it('refuses a dir outside allowedRoots before creating it', async () => {
    const target = join(outside, 'made');
    const err = await refusal(writeUniqueFile({ dir: target, baseName: 'x', extension: 'bin', bytes: bytes('x'), allowedRoots: [dir] }));
    expect(err.reason).toBe('outside-roots');
    expect(existsSync(target)).toBe(false);
  });

  it('applies mode', async () => {
    const p = await writeUniqueFile({ dir, baseName: 'x', extension: 'bin', bytes: bytes('x'), mode: 0o600 });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});

describe('writeBinaryOutput — no longer follows a planted symlink', () => {
  it('skips a dangling symlink at the chosen name instead of creating its target', () => {
    const target = join(outside, 'planted.png');
    symlinkSync(target, join(dir, 'shot.png'));
    const p = writeBinaryOutput({ dir, baseName: 'shot', base64: Buffer.from('x').toString('base64'), mimeType: 'image/png' });
    expect(p).toBe(join(dir, 'shot-2.png'));
    expect(existsSync(target)).toBe(false);
    expect(readFileSync(p, 'utf8')).toBe('x');
  });

  it('skips a live symlink at the chosen name instead of overwriting its target', () => {
    const target = join(outside, 'victim.png');
    writeFileSync(target, 'precious');
    symlinkSync(target, join(dir, 'shot.png'));
    const p = writeBinaryOutput({ dir, baseName: 'shot', base64: Buffer.from('x').toString('base64'), mimeType: 'image/png' });
    expect(p).toBe(join(dir, 'shot-2.png'));
    expect(readFileSync(target, 'utf8')).toBe('precious');
  });

  it('still creates the directory it writes into', () => {
    const nested = join(dir, 'deep', 'er');
    const p = writeBinaryOutput({ dir: nested, baseName: 'x', base64: '', extension: 'bin' });
    expect(p).toBe(join(nested, 'x.bin'));
  });

  it('applies mode when given', () => {
    mkdirSync(join(dir, 'm'));
    const p = writeBinaryOutput({ dir: join(dir, 'm'), baseName: 'x', base64: '', extension: 'bin', mode: 0o600 });
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });
});
