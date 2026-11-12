import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { McpToolError } from '../errors/index.js';
import { assertZipWithinLimits, openZip } from './zip-read.js';

const MiB = 1024 * 1024;

/** Rewrite every central-directory entry's declared uncompressed size. */
function lieAboutSizes(zip: Uint8Array, declared: number): Uint8Array {
  const out = zip.slice();
  const view = new DataView(out.buffer);
  for (let i = 0; i + 4 <= out.length; i++) {
    if (view.getUint32(i, true) === 0x02014b50) view.setUint32(i + 24, declared, true);
    if (view.getUint32(i, true) === 0x04034b50) view.setUint32(i + 22, declared, true);
  }
  return out;
}

describe('openZip', () => {
  it('lists entries and reads them on demand', async () => {
    const zip = zipSync({ 'a.txt': strToU8('hello'), 'dir/b.xml': strToU8('<x/>') });
    const z = await openZip(zip);
    expect(z.names().sort()).toEqual(['a.txt', 'dir/b.xml']);
    expect(await z.readText('a.txt')).toBe('hello');
    expect(new TextDecoder().decode(await z.read('dir/b.xml'))).toBe('<x/>');
    expect(await z.read('missing')).toBeUndefined();
    expect(await z.readText('missing')).toBeUndefined();
  });

  it('reads stored (uncompressed) entries', async () => {
    const zip = zipSync({ 's.txt': [strToU8('stored body'), { level: 0 }] });
    const z = await openZip(zip);
    expect(await z.readText('s.txt')).toBe('stored body');
  });

  it('refuses an entry whose declared size exceeds the per-entry cap', async () => {
    const zip = zipSync({ 'big.bin': new Uint8Array(3 * MiB) });
    const err = await openZip(zip, { maxUnzippedBytes: 2 * MiB }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).kind).toBe('too_large');
    expect((err as Error).message).toMatch(/big\.bin/);
  });

  it('refuses when the declared total exceeds maxUnzippedBytes', async () => {
    const zip = zipSync({ 'a.bin': new Uint8Array(MiB), 'b.bin': new Uint8Array(MiB), 'c.bin': new Uint8Array(MiB) });
    const err = await openZip(zip, { maxUnzippedBytes: 2.5 * MiB }).catch((e: unknown) => e);
    expect((err as McpToolError).kind).toBe('too_large');
  });

  it('enforces the cap on ACTUAL inflated bytes when declared sizes lie', async () => {
    const zip = lieAboutSizes(zipSync({ 'bomb.bin': new Uint8Array(8 * MiB) }), 10);
    const z = await openZip(zip, { maxUnzippedBytes: MiB });
    const err = await z.read('bomb.bin').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).kind).toBe('too_large');
  });

  it('does not count a re-read entry twice against maxUnzippedBytes', async () => {
    const zip = zipSync({ 'a.bin': new Uint8Array(600 * 1024) });
    const z = await openZip(zip, { maxUnzippedBytes: MiB });
    await z.read('a.bin');
    await expect(z.read('a.bin')).resolves.toHaveLength(600 * 1024);
  });

  it('rejects bytes that are not a zip with a clear McpToolError', async () => {
    const err = await openZip(strToU8('definitely not a zip file')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as Error).message).toMatch(/zip/i);
  });

  it('rejects a corrupt entry with a clear McpToolError', async () => {
    const zip = zipSync({ 'a.txt': strToU8('hello hello hello hello hello hello') });
    const view = new DataView(zip.buffer);
    // Corrupt the deflate stream right after the local header.
    const nameLen = view.getUint16(26, true);
    const extraLen = view.getUint16(28, true);
    zip[30 + nameLen + extraLen] = 0xff;
    zip[31 + nameLen + extraLen] = 0xff;
    const z = await openZip(zip);
    await expect(z.read('a.txt')).rejects.toBeInstanceOf(McpToolError);
  });

  it('honours an aborted signal', async () => {
    const zip = zipSync({ 'a.txt': strToU8('x') });
    await expect(openZip(zip, {}, AbortSignal.abort())).rejects.toThrow();
  });
});

describe('assertZipWithinLimits', () => {
  it('passes a small archive', async () => {
    await expect(assertZipWithinLimits(zipSync({ 'a.txt': strToU8('x') }))).resolves.toEqual(['a.txt']);
  });

  it('inflates every entry so a lying zip bomb is caught before a library loads it', async () => {
    const zip = lieAboutSizes(zipSync({ 'bomb.bin': new Uint8Array(8 * MiB) }), 10);
    await expect(assertZipWithinLimits(zip, { maxUnzippedBytes: MiB })).rejects.toMatchObject({ kind: 'too_large' });
  });
});
