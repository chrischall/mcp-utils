import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 as zlibCrc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildZip, crc32, isCompressibleType } from './zip.js';

interface ParsedEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  data: Uint8Array;
}

/**
 * An independent reader: walks the END of the archive (EOCD → central
 * directory → each local header), inflating with node:zlib, rather than
 * trusting the writer's own offsets in order.
 */
function readZip(zip: Uint8Array): ParsedEntry[] {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.byteLength - 22;
  expect(v.getUint32(eocd, true)).toBe(0x06054b50);
  const count = v.getUint16(eocd + 10, true);
  const cdSize = v.getUint32(eocd + 12, true);
  let p = v.getUint32(eocd + 16, true);
  expect(p + cdSize).toBe(eocd);
  const out: ParsedEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(v.getUint32(p, true)).toBe(0x02014b50);
    const flags = v.getUint16(p + 8, true);
    expect(flags & 0x0800).toBe(0x0800);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const compressedSize = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const localOff = v.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    // Local header must agree with the central directory.
    expect(v.getUint32(localOff, true)).toBe(0x04034b50);
    expect(v.getUint16(localOff + 8, true)).toBe(method);
    expect(v.getUint32(localOff + 14, true)).toBe(crc);
    expect(v.getUint32(localOff + 18, true)).toBe(compressedSize);
    expect(v.getUint32(localOff + 22, true)).toBe(size);
    const lNameLen = v.getUint16(localOff + 26, true);
    const lExtra = v.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtra;
    const raw = zip.subarray(start, start + compressedSize);
    const data = method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw;
    expect(data.byteLength).toBe(size);
    expect(zlibCrc32(data) >>> 0).toBe(crc);
    out.push({ name, method, crc, compressedSize, size, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const enc = (s: string) => new TextEncoder().encode(s);
const text = '{"id":1,"body":"hello hello hello hello hello"}\n'.repeat(200);

describe('crc32', () => {
  it('matches node:zlib crc32 (and the standard check value)', () => {
    expect(crc32(enc('123456789'))).toBe(0xcbf43926);
    const bytes = enc(text);
    expect(crc32(bytes)).toBe(zlibCrc32(bytes) >>> 0);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('buildZip', () => {
  it('DEFLATEs compressible entries by default and STOREs when asked', () => {
    const png = new Uint8Array(64).map((_, i) => (i * 37) & 0xff);
    const zip = buildZip([
      { name: 'part-0001.jsonl', bytes: enc(text) },
      { name: 'attachments/ab12/photo.png', bytes: png, compress: false },
    ]);
    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(['part-0001.jsonl', 'attachments/ab12/photo.png']);
    expect(entries[0]!.method).toBe(8);
    expect(entries[0]!.compressedSize).toBeLessThan(entries[0]!.size);
    expect(new TextDecoder().decode(entries[0]!.data)).toBe(text);
    expect(entries[1]!.method).toBe(0);
    expect(entries[1]!.data).toEqual(png);
  });

  it('falls back to STORE when DEFLATE would not shrink the entry', () => {
    const [e] = readZip(buildZip([{ name: 'tiny.txt', bytes: enc('a') }]));
    expect(e!.method).toBe(0);
    expect(new TextDecoder().decode(e!.data)).toBe('a');
  });

  it('handles empty entries, UTF-8 names and an empty archive', () => {
    const entries = readZip(buildZip([{ name: 'café/ünï.md', bytes: new Uint8Array() }]));
    expect(entries[0]!.name).toBe('café/ünï.md');
    expect(entries[0]!.size).toBe(0);
    expect(readZip(buildZip([]))).toEqual([]);
  });

  it('honours a Uint8Array view at its own offset', () => {
    const backing = enc('XXhello worldXX');
    const [e] = readZip(buildZip([{ name: 'v.txt', bytes: backing.subarray(2, 13), compress: false }]));
    expect(new TextDecoder().decode(e!.data)).toBe('hello world');
  });

  it('is deterministic for a fixed timestamp', () => {
    const at = new Date(Date.UTC(2026, 9, 20, 12, 34, 56));
    const a = buildZip([{ name: 'a.txt', bytes: enc(text) }], at);
    const b = buildZip([{ name: 'a.txt', bytes: enc(text) }], at);
    expect(a).toEqual(b);
  });

  it('refuses unsafe or duplicate entry names', () => {
    for (const name of ['', '/abs', 'a/../b', '..', 'a\\b', 'a//b', 'dir/']) {
      expect(() => buildZip([{ name, bytes: enc('x') }]), name).toThrow(TypeError);
    }
    expect(() =>
      buildZip([
        { name: 'a.txt', bytes: enc('x') },
        { name: 'a.txt', bytes: enc('y') },
      ]),
    ).toThrow(TypeError);
  });

  it.skipIf(!hasUnzip())('is accepted by the system unzip (CRCs tested)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zip-test-'));
    try {
      const file = join(dir, 'out.zip');
      writeFileSync(
        file,
        buildZip([
          { name: 'part-0001.jsonl', bytes: enc(text) },
          { name: 'attachments/x/data.bin', bytes: new Uint8Array(5000).fill(7), compress: false },
        ]),
      );
      const test = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
      expect(test).toMatch(/No errors detected/);
      expect(execFileSync('unzip', ['-p', file, 'part-0001.jsonl'], { encoding: 'utf8' })).toBe(text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isCompressibleType', () => {
  it.each([
    ['text/plain', true],
    ['text/markdown; charset=utf-8', true],
    ['application/json', true],
    ['application/x-ndjson', true],
    ['application/jsonl', true],
    ['application/ld+json', true],
    ['application/xml', true],
    ['image/svg+xml', true],
    ['text/calendar', true],
    ['image/png', false],
    ['image/jpeg', false],
    ['application/zip', false],
    ['application/pdf', false],
    ['video/mp4', false],
    ['application/octet-stream', false],
    ['', false],
  ])('%j → %s', (type, want) => {
    expect(isCompressibleType(type)).toBe(want);
  });
});

function hasUnzip(): boolean {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
