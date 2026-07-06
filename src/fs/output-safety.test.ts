import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { uniquePath, writeBinaryOutput } from './index.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-utils-output-safety-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeBinaryOutput / uniquePath baseName traversal guard', () => {
  it('writes inside dir even when baseName contains ../ segments', () => {
    const path = writeBinaryOutput({
      dir,
      baseName: '../../etc/evil',
      base64: Buffer.from('x').toString('base64'),
      mimeType: 'image/png',
    });
    // The written path must stay under the resolved output dir.
    expect(resolve(dirname(path))).toBe(resolve(dir));
    expect(existsSync(path)).toBe(true);
    // Nothing escaped upward.
    expect(existsSync(join(dir, '..', '..', 'etc', 'evil.png'))).toBe(false);
  });

  it('strips path separators from a uniquePath base too', () => {
    const p = uniquePath(dir, 'a/b/../c', 'png');
    expect(resolve(dirname(p))).toBe(resolve(dir));
  });

  it('keeps a normal baseName intact', () => {
    const path = writeBinaryOutput({
      dir,
      baseName: 'shot',
      base64: Buffer.from('x').toString('base64'),
      mimeType: 'image/png',
    });
    expect(path).toBe(join(dir, 'shot.png'));
  });

  it('a baseName that sanitizes to empty still produces a file in dir', () => {
    const path = writeBinaryOutput({
      dir,
      baseName: '../..',
      base64: Buffer.from('x').toString('base64'),
      extension: 'bin',
    });
    expect(resolve(dirname(path))).toBe(resolve(dir));
    expect(existsSync(path)).toBe(true);
  });
});
