import { deflateSync, strToU8, zipSync } from 'fflate';
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

/** Hand-build a DEFLATE zip, allowing duplicate names, raw name bytes and lying sizes. */
function rawZip(entries: { name: string | Uint8Array; raw: Uint8Array; declare?: number }[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const cds: Uint8Array[] = [];
  let off = 0;
  for (const e of entries) {
    const name = typeof e.name === 'string' ? strToU8(e.name) : e.name;
    const comp = deflateSync(e.raw);
    const size = e.declare ?? e.raw.length;
    const lh = new Uint8Array(30 + name.length + comp.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(18, comp.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    lh.set(name, 30);
    lh.set(comp, 30 + name.length);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, comp.length, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, off, true);
    cd.set(name, 46);
    locals.push(lh);
    cds.push(cd);
    off += lh.length;
  }
  const cdLen = cds.reduce((a, b) => a + b.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdLen, true);
  ev.setUint32(16, off, true);
  const out = new Uint8Array(off + cdLen + 22);
  let p = 0;
  for (const x of [...locals, ...cds, eocd]) {
    out.set(x, p);
    p += x.length;
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

  it('refuses a duplicated entry name (a library may inflate the copy the guard skipped)', async () => {
    const zip = rawZip([
      { name: 'docProps/custom.bin', raw: new Uint8Array(1) },
      { name: 'docProps/custom.bin', raw: new Uint8Array(4 * MiB), declare: 1 },
    ]);
    const err = await assertZipWithinLimits(zip, { maxUnzippedBytes: MiB }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as Error).message).toMatch(/duplicate/i);
  });

  it('refuses names that only collide once undecodable bytes become U+FFFD', async () => {
    const zip = rawZip([
      { name: new Uint8Array([0x61, 0xff]), raw: new Uint8Array(1) },
      { name: new Uint8Array([0x61, 0xfe]), raw: new Uint8Array(4 * MiB), declare: 1 },
    ]);
    await expect(assertZipWithinLimits(zip, { maxUnzippedBytes: MiB })).rejects.toBeInstanceOf(McpToolError);
  });

  it('inflates every central-directory entry, not just one per name', async () => {
    // Two distinct names whose bytes differ, so no duplicate check applies;
    // the second is a lying bomb that must still be inflated and caught.
    const zip = rawZip([
      { name: 'a.bin', raw: new Uint8Array(1) },
      { name: 'b.bin', raw: new Uint8Array(4 * MiB), declare: 1 },
    ]);
    await expect(assertZipWithinLimits(zip, { maxUnzippedBytes: MiB })).rejects.toMatchObject({ kind: 'too_large' });
  });
});
