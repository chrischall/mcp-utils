import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveOutputDir, sniffMimeBytes, uniquePath, writeBinaryOutput } from './index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-utils-output-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveOutputDir', () => {
  it('prefers the per-call dir, creating it', () => {
    const target = join(dir, 'nested', 'out');
    const resolved = resolveOutputDir(target, 'X_OUTPUT_DIR', { env: {} });
    expect(resolved).toBe(target);
    expect(existsSync(target)).toBe(true);
  });

  it('falls back to the env var', () => {
    const target = join(dir, 'env-out');
    const resolved = resolveOutputDir(undefined, 'X_OUTPUT_DIR', {
      env: { X_OUTPUT_DIR: target },
    });
    expect(resolved).toBe(target);
    expect(existsSync(target)).toBe(true);
  });

  it('falls back to the cwd when neither is set', () => {
    expect(resolveOutputDir(undefined, 'X_OUTPUT_DIR', { env: {} })).toBe(process.cwd());
  });
});

describe('uniquePath', () => {
  it('returns base.ext when free', () => {
    expect(uniquePath(dir, 'img', 'png')).toBe(join(dir, 'img.png'));
  });

  it('suffixes -2, -3, … when taken', () => {
    writeFileSync(join(dir, 'img.png'), 'x');
    expect(uniquePath(dir, 'img', 'png')).toBe(join(dir, 'img-2.png'));
    writeFileSync(join(dir, 'img-2.png'), 'x');
    expect(uniquePath(dir, 'img', 'png')).toBe(join(dir, 'img-3.png'));
  });
});

describe('writeBinaryOutput', () => {
  it('writes base64 bytes and derives the extension from the MIME type', () => {
    const path = writeBinaryOutput({
      dir,
      baseName: 'shot',
      base64: Buffer.from('hello').toString('base64'),
      mimeType: 'image/png',
    });
    expect(path).toBe(join(dir, 'shot.png'));
    expect(readFileSync(path, 'utf8')).toBe('hello');
  });

  it('never overwrites an existing file', () => {
    writeFileSync(join(dir, 'shot.png'), 'old');
    const path = writeBinaryOutput({
      dir,
      baseName: 'shot',
      base64: Buffer.from('new').toString('base64'),
      mimeType: 'image/png',
    });
    expect(path).toBe(join(dir, 'shot-2.png'));
    expect(readFileSync(join(dir, 'shot.png'), 'utf8')).toBe('old');
  });

  it('falls back to .bin for an unknown MIME type', () => {
    const path = writeBinaryOutput({
      dir,
      baseName: 'blob',
      base64: Buffer.from('x').toString('base64'),
    });
    expect(path).toBe(join(dir, 'blob.bin'));
  });
});

describe('sniffMimeBytes', () => {
  it('detects png, jpeg, webp, and gif magic bytes', () => {
    expect(sniffMimeBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png',
    );
    expect(sniffMimeBytes(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);
    expect(sniffMimeBytes(webp)).toBe('image/webp');
    expect(sniffMimeBytes(Buffer.from('GIF89a'))).toBe('image/gif');
  });

  it('returns undefined for unknown bytes', () => {
    expect(sniffMimeBytes(Buffer.from('plain text'))).toBeUndefined();
    expect(sniffMimeBytes(Buffer.alloc(0))).toBeUndefined();
  });
});
