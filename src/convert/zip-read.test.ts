import { deflateSync, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { McpToolError } from '../errors/index.js';
import { crc32 } from '../export/zip.js';
import { assertZipWithinLimits, openZip, repackZipWithinLimits } from './zip-read.js';

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

/** Offset of the end-of-central-directory record (no archive comment). */
function eocdAt(zip: Uint8Array): number {
  return zip.length - 22;
}

/** The archive with its EOCD claiming one entry fewer than its central directory holds. */
function understateCount(zip: Uint8Array): Uint8Array {
  const out = zip.slice();
  const v = new DataView(out.buffer);
  const e = eocdAt(out);
  const n = v.getUint16(e + 10, true);
  v.setUint16(e + 8, n - 1, true);
  v.setUint16(e + 10, n - 1, true);
  return out;
}

/** The archive with `junk` bytes between the central directory and the EOCD. */
function gapBeforeEocd(zip: Uint8Array, junk: number): Uint8Array {
  const e = eocdAt(zip);
  const out = new Uint8Array(zip.length + junk);
  out.set(zip.subarray(0, e), 0);
  out.set(zip.subarray(e), e + junk);
  return out;
}

describe('central-directory parsing agrees with other zip readers', () => {
  // JSZip (under exceljs) reads central-directory records while the signature
  // matches, takes its zip64 path on any 0xFFFF EOCD field, and shifts every
  // offset by a gap before the EOCD. Each shape would let it see entries the
  // guard never inflated, so each is refused.
  const bombed = (): Uint8Array =>
    rawZip([
      { name: 'a.txt', raw: strToU8('x') },
      { name: 'zz/bomb.bin', raw: new Uint8Array(8 * MiB) },
    ]);

  it('refuses an EOCD that understates the entry count', async () => {
    const zip = understateCount(bombed());
    const err = await assertZipWithinLimits(zip, { maxUnzippedBytes: MiB }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as Error).message).toMatch(/central directory/i);
    await expect(openZip(zip, { maxUnzippedBytes: MiB })).rejects.toBeInstanceOf(McpToolError);
  });

  for (const [field, off] of [
    ['disk number', 4],
    ['central-directory start disk', 6],
    ['entries on this disk', 8],
  ] as const) {
    it(`refuses a 0xFFFF ${field} field (a zip64 marker)`, async () => {
      const zip = rawZip([{ name: 'a.txt', raw: strToU8('x') }]);
      new DataView(zip.buffer).setUint16(eocdAt(zip) + off, 0xffff, true);
      await expect(openZip(zip)).rejects.toBeInstanceOf(McpToolError);
    });
  }

  it('refuses a multi-disk archive', async () => {
    const zip = rawZip([{ name: 'a.txt', raw: strToU8('x') }]);
    new DataView(zip.buffer).setUint16(eocdAt(zip) + 4, 1, true);
    await expect(openZip(zip)).rejects.toBeInstanceOf(McpToolError);
  });

  it('refuses a gap between the central directory and the EOCD', async () => {
    const zip = gapBeforeEocd(rawZip([{ name: 'a.txt', raw: strToU8('x') }]), 16);
    const err = await openZip(zip).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as Error).message).toMatch(/central directory/i);
  });
});

describe('repackZipWithinLimits', () => {
  it('refuses a name that no longer fits a 16-bit length once re-encoded, rather than writing a corrupt archive', async () => {
    // 30 000 invalid UTF-8 bytes decode to U+FFFD each, which re-encodes as 3 bytes: ~90 000 > 0xFFFF.
    const long = 'a'.repeat(30_000);
    const zip = zipSync({ [long]: new Uint8Array([1, 2, 3]) });
    const needle = new TextEncoder().encode(long);
    for (let i = 0; i + needle.length <= zip.length; i++) {
      if (zip[i] === 0x61 && zip[i + needle.length - 1] === 0x61 && zip.subarray(i, i + needle.length).every((b) => b === 0x61)) {
        zip.fill(0xff, i, i + needle.length);
        i += needle.length - 1;
      }
    }
    const err = await repackZipWithinLimits(zip).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).message).toMatch(/name/i);
  });

  it('rebuilds the archive from exactly the entries it inflated', async () => {
    const src = zipSync({ 'a.txt': strToU8('hello'), 'dir/b.txt': strToU8('world') });
    const { names, bytes } = await repackZipWithinLimits(src);
    expect(names).toEqual(['a.txt', 'dir/b.txt']);
    const back = unzipSync(bytes);
    expect(Object.keys(back).sort()).toEqual(['a.txt', 'dir/b.txt']);
    expect(new TextDecoder().decode(back['a.txt'])).toBe('hello');
    expect(new TextDecoder().decode(back['dir/b.txt'])).toBe('world');
  });

  it('refuses a lying zip bomb', async () => {
    const zip = lieAboutSizes(zipSync({ 'bomb.bin': new Uint8Array(8 * MiB) }), 10);
    await expect(repackZipWithinLimits(zip, { maxUnzippedBytes: MiB })).rejects.toMatchObject({ kind: 'too_large' });
  });

  it('writes STORE entries with their real sizes and CRC-32, names flagged UTF-8, directories dropped', async () => {
    const files = { 'xl/workbook.xml': strToU8('<workbook/>'.repeat(50)), 'Données €.xml': strToU8('é'), 'empty.txt': new Uint8Array(0) };
    const src = zipSync({ ...files, 'folder/': new Uint8Array(0) });
    const { names, bytes } = await repackZipWithinLimits(src);
    expect(names).toEqual(['xl/workbook.xml', 'Données €.xml', 'empty.txt', 'folder/']);

    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const e = bytes.length - 22;
    expect(v.getUint32(e, true)).toBe(0x06054b50);
    expect(v.getUint16(e + 10, true)).toBe(3);
    let p = v.getUint32(e + 16, true);
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      expect(v.getUint32(p, true)).toBe(0x02014b50);
      const nameLen = v.getUint16(p + 28, true);
      const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
      const content = files[name as keyof typeof files];
      expect(v.getUint16(p + 8, true) & 0x800).toBe(0x800);
      expect(v.getUint16(p + 10, true)).toBe(0); // STORE
      expect(v.getUint32(p + 16, true)).toBe(crc32(content));
      expect(v.getUint32(p + 20, true)).toBe(content.length);
      expect(v.getUint32(p + 24, true)).toBe(content.length);
      const lh = v.getUint32(p + 42, true);
      expect(v.getUint32(lh, true)).toBe(0x04034b50);
      expect(v.getUint32(lh + 14, true)).toBe(crc32(content));
      const start = lh + 30 + v.getUint16(lh + 26, true) + v.getUint16(lh + 28, true);
      expect(bytes.subarray(start, start + content.length)).toEqual(content);
      seen.push(name);
      p += 46 + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
    }
    expect(seen).toEqual(['xl/workbook.xml', 'Données €.xml', 'empty.txt']);
    expect(p).toBe(e);
  });

  it('honours an aborted signal', async () => {
    await expect(repackZipWithinLimits(zipSync({ 'a.txt': strToU8('a') }), {}, AbortSignal.abort())).rejects.toThrow();
  });
});

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

  it('inflates an entry at most once: a re-read returns the cached bytes (#436)', async () => {
    const zip = zipSync({ 'a.bin': new Uint8Array(600 * 1024) });
    const z = await openZip(zip, { maxUnzippedBytes: MiB });
    const first = await z.read('a.bin');
    expect(await z.read('a.bin')).toBe(first);
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
