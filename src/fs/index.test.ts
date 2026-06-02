import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileBlob, readFileHead } from './index.js';

const dirs: string[] = [];
function tmpFile(name: string, bytes: Buffer | string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-utils-fs-'));
  dirs.push(dir);
  const p = join(dir, name);
  writeFileSync(p, bytes);
  return p;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('fileBlob', () => {
  it('returns a file-backed Blob with the right size and type', async () => {
    const p = tmpFile('a.bin', Buffer.from('hello world'));
    const blob = await fileBlob(p, { type: 'text/plain' });
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(11);
    expect(blob.type).toBe('text/plain');
    expect(await blob.text()).toBe('hello world');
  });

  it('works without a type', async () => {
    const p = tmpFile('b.bin', Buffer.from([1, 2, 3]));
    const blob = await fileBlob(p);
    expect(blob.size).toBe(3);
    expect(blob.type).toBe('');
  });

  it('throws a clean error for a missing file (no fs stack leak)', async () => {
    await expect(fileBlob('/no/such/file.bin')).rejects.toThrow(/Cannot read file for upload/);
  });

  it('enforces maxBytes with a labelled message', async () => {
    const p = tmpFile('big.bin', Buffer.alloc(100));
    await expect(fileBlob(p, { maxBytes: 50, label: 'Image' })).rejects.toThrow(
      /Image is 100 bytes, over the 50-byte limit/,
    );
  });

  it('defaults the size-error label to "File"', async () => {
    const p = tmpFile('big2.bin', Buffer.alloc(100));
    await expect(fileBlob(p, { maxBytes: 10 })).rejects.toThrow(/^File is 100 bytes/);
  });

  it('allows a file exactly at the limit', async () => {
    const p = tmpFile('ok.bin', Buffer.alloc(50));
    const blob = await fileBlob(p, { maxBytes: 50 });
    expect(blob.size).toBe(50);
  });
});

describe('readFileHead', () => {
  it('reads only the first N bytes', async () => {
    const p = tmpFile('head.bin', Buffer.from('ABCDEFGHIJ'));
    const head = await readFileHead(p, 4);
    expect(head).toEqual(Buffer.from('ABCD'));
  });

  it('returns a short buffer when the file is smaller than N', async () => {
    const p = tmpFile('short.bin', Buffer.from('AB'));
    const head = await readFileHead(p, 16);
    expect(head).toEqual(Buffer.from('AB'));
    expect(head.length).toBe(2);
  });
});
