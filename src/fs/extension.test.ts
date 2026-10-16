import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extensionForMime, isSafeExtension, uniquePath, writeBinaryOutput, writeUniqueFile } from './index.js';

let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mcp-utils-ext-'));
  dir = join(root, 'out');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// fleet-audit#1303: the stem was sanitised but the extension was joined
// verbatim, so an extension carrying `/..` wrote outside `dir`.
describe('extension validation (fleet-audit#1303)', () => {
  const hostile = ['/../../elsewhere/pwned', '../x', 'a/b', 'a\\b', '.hidden', '', 'x'.repeat(17), 'p\0ng', 'png ', 'p:ng'];

  it.each(hostile)('writeBinaryOutput refuses extension %j and writes nothing', (extension) => {
    expect(() => writeBinaryOutput({ dir, baseName: 'img', base64: 'aGk=', extension })).toThrow(TypeError);
    expect(existsSync(join(root, 'elsewhere'))).toBe(false);
  });

  it.each(hostile)('writeUniqueFile refuses extension %j', async (extension) => {
    await expect(writeUniqueFile({ dir, baseName: 'img', extension, bytes: new Uint8Array([1]) })).rejects.toThrow(TypeError);
    expect(existsSync(join(root, 'elsewhere'))).toBe(false);
  });

  it.each(hostile)('uniquePath refuses extension %j', (extension) => {
    expect(() => uniquePath(dir, 'img', extension)).toThrow(TypeError);
  });

  it('accepts ordinary extensions, multi-part ones included', async () => {
    for (const ext of ['png', 'JPG', 'tar.gz', 'mp4', 'x-y_z', 'a'.repeat(16)]) expect(isSafeExtension(ext)).toBe(true);
    const written = await writeUniqueFile({ dir, baseName: 'a', extension: 'tar.gz', bytes: new Uint8Array([1]) });
    expect(written).toBe(join(dir, 'a.tar.gz'));
    expect(readdirSync(root)).toEqual(['out']);
  });
});

// fleet-audit#1301: one MIME → extension table instead of three hand-rolled ones.
describe('extensionForMime (fleet-audit#1301)', () => {
  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['IMAGE/JPEG; charset=binary', 'jpg'],
    ['image/webp', 'webp'],
    ['image/gif', 'gif'],
    ['image/heic', 'heic'],
    ['image/tiff', 'tif'],
    ['image/svg+xml', 'svg'],
    ['application/pdf', 'pdf'],
    ['application/json', 'json'],
    ['audio/midi', 'mid'],
    ['audio/mpeg', 'mp3'],
    ['audio/wav', 'wav'],
    ['audio/x-wav', 'wav'],
    ['audio/ogg', 'ogg'],
    ['video/mp4', 'mp4'],
    ['video/quicktime', 'mov'],
    ['video/webm', 'webm'],
    ['text/plain', 'txt'],
    ['text/csv', 'csv'],
  ])('%s → %s', (mime, ext) => {
    expect(extensionForMime(mime)).toBe(ext);
  });

  it('falls back to a plain MIME subtype, then the URL extension, then the fallback', () => {
    expect(extensionForMime('image/x-icon')).toBe('icon');
    expect(extensionForMime('application/x-7z')).toBe('7z');
    expect(extensionForMime('application/octet-stream', { url: 'https://cdn.test/r/receipt.JPG?sig=1' })).toBe('jpg');
    expect(extensionForMime(undefined, { url: 'https://cdn.test/r/receipt.heic' })).toBe('heic');
    expect(extensionForMime('application/octet-stream')).toBe('bin');
    expect(extensionForMime('', { fallback: 'dat' })).toBe('dat');
    expect(extensionForMime(null, { url: 'not a url' })).toBe('bin');
    expect(extensionForMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('bin');
  });

  it('only ever returns an extension the writers accept', () => {
    for (const mime of ['a/../../x', 'image/..', 'x/y/z', 'text/ plain', 'image/p\0ng']) {
      expect(isSafeExtension(extensionForMime(mime, { url: 'https://x.test/a.b/..%2f' }))).toBe(true);
    }
    expect(() => extensionForMime('x/unknown-type', { fallback: '../x' })).toThrow(TypeError);
  });

  it('writeBinaryOutput derives its extension through it', () => {
    expect(writeBinaryOutput({ dir, baseName: 'a', base64: 'aGk=', mimeType: 'image/svg+xml' })).toBe(join(dir, 'a.svg'));
    expect(writeBinaryOutput({ dir, baseName: 'b', base64: 'aGk=', mimeType: 'application/octet-stream' })).toBe(join(dir, 'b.bin'));
  });
});
