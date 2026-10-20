/**
 * Minimal ZIP writer — STORE or raw DEFLATE per entry — for bundling a bulk
 * export (JSONL / Markdown parts plus attachments) into the one archive a
 * hosted server uploads to the blob store.
 *
 * Ported from gemini-mcp `src/zip.ts` (STORE-only, for already-compressed
 * PNG/JPEG bundles) and extended with DEFLATE via `node:zlib`
 * `deflateRawSync`: an export is mostly text, which shrinks 5–10×, while its
 * attachments (images, PDFs, Office files) are already compressed and are
 * STOREd. An entry asked to DEFLATE is still STOREd when compression would
 * not make it smaller.
 *
 * Layout: [local header + name + data]* [central directory]* [EOCD]. No
 * ZIP64 (an export part is bounded by the caller's item and time budget; a
 * part that would exceed 4 GiB or 65 535 entries throws), no encryption, no
 * data descriptors, no streaming. Names are UTF-8 (general-purpose bit 11).
 */

import { deflateRawSync } from 'node:zlib';

/** One file to put in the archive. */
export interface ZipEntry {
  /** Path inside the archive, `/`-separated and relative, e.g. `attachments/ab12/photo.png`. */
  name: string;
  bytes: Uint8Array;
  /**
   * DEFLATE this entry (default `true`). Pass `false` for already-compressed
   * media — see {@link isCompressibleType}. Even when `true`, an entry DEFLATE
   * would not shrink is STOREd.
   */
  compress?: boolean;
}

/** Standard CRC-32 (IEEE 802.3), table-driven. The table is immutable. */
const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE) of `bytes`, as an unsigned 32-bit number — the checksum ZIP stores per entry. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Whether content of this MIME type is worth DEFLATing: `text/*`, JSON / XML
 * (including `+json` / `+xml` suffixes and NDJSON / JSONL), JavaScript and
 * SVG. Everything else — images, audio, video, archives, PDF, Office
 * documents, `application/octet-stream` — is treated as already compressed or
 * opaque and STOREd. Parameters (`; charset=…`) and case are ignored.
 */
export function isCompressibleType(contentType: string): boolean {
  const type = contentType.split(';', 1)[0]!.trim().toLowerCase();
  if (!type) return false;
  if (type.startsWith('text/')) return true;
  if (type.endsWith('+json') || type.endsWith('+xml')) return true;
  return COMPRESSIBLE.has(type);
}

const COMPRESSIBLE = new Set([
  'application/json',
  'application/jsonl',
  'application/x-ndjson',
  'application/ndjson',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/yaml',
  'application/x-yaml',
]);

/** MS-DOS date/time pair (ZIP's native timestamp format). */
function dosDateTime(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getUTCFullYear());
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | (at.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const EOCD = 0x06054b50;
/** Version 2.0 — the minimum that understands DEFLATE + directories. */
const VERSION = 20;
/** General-purpose bit 11: names are UTF-8. */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const MAX_U32 = 0xffffffff;
const MAX_ENTRIES = 0xffff;

/** Reject a name an extractor could resolve outside its target directory, or a duplicate. */
function checkName(name: string, seen: Set<string>): void {
  const bad =
    typeof name !== 'string' ||
    name.length === 0 ||
    name.includes('\\') ||
    name.includes('\0') ||
    name.split('/').some((seg) => seg === '' || seg === '.' || seg === '..');
  if (bad) throw new TypeError(`buildZip: unsafe entry name ${JSON.stringify(name)}.`);
  if (seen.has(name)) throw new TypeError(`buildZip: duplicate entry name ${JSON.stringify(name)}.`);
  seen.add(name);
}

/**
 * Build a zip of `entries`. Each entry is DEFLATEd unless `compress: false`
 * (or DEFLATE would not shrink it), and every entry's CRC-32 is recorded.
 * `modifiedAt` stamps every entry (injectable so a given input always yields
 * identical bytes; defaults to 1980-01-01, the format's epoch).
 *
 * @throws {TypeError} on an empty, absolute, `.`/`..`-segmented, backslashed
 *   or duplicate entry name, or an archive needing ZIP64 (> 65 535 entries or
 *   > 4 GiB).
 */
export function buildZip(entries: ZipEntry[], modifiedAt: Date = new Date(Date.UTC(1980, 0, 1))): Uint8Array {
  if (entries.length > MAX_ENTRIES) throw new TypeError(`buildZip: more than ${MAX_ENTRIES} entries needs ZIP64.`);
  const { time, date } = dosDateTime(modifiedAt);
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    checkName(entry.name, seen);
    const name = encoder.encode(entry.name);
    const size = entry.bytes.byteLength;
    const crc = crc32(entry.bytes);
    let method = METHOD_STORE;
    let data = entry.bytes;
    if (entry.compress !== false && size > 0) {
      const deflated = new Uint8Array(deflateRawSync(entry.bytes));
      if (deflated.byteLength < size) {
        method = METHOD_DEFLATE;
        data = deflated;
      }
    }
    const csize = data.byteLength;

    const local = new Uint8Array(30 + name.byteLength);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_HEADER, true);
    lv.setUint16(4, VERSION, true);
    lv.setUint16(6, FLAG_UTF8, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, csize, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.byteLength, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(name, 30);

    const dir = new Uint8Array(46 + name.byteLength);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, CENTRAL_HEADER, true);
    dv.setUint16(4, VERSION, true); // version made by
    dv.setUint16(6, VERSION, true); // version needed
    dv.setUint16(8, FLAG_UTF8, true);
    dv.setUint16(10, method, true);
    dv.setUint16(12, time, true);
    dv.setUint16(14, date, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, csize, true);
    dv.setUint32(24, size, true);
    dv.setUint16(28, name.byteLength, true);
    // extra len, comment len, disk start, internal attrs, external attrs = 0
    dv.setUint32(42, offset, true);
    dir.set(name, 46);

    parts.push(local, data);
    central.push(dir);
    offset += local.byteLength + csize;
    if (offset > MAX_U32) throw new TypeError('buildZip: archive larger than 4 GiB needs ZIP64.');
  }

  const centralSize = central.reduce((n, c) => n + c.byteLength, 0);
  if (offset + centralSize > MAX_U32) throw new TypeError('buildZip: archive larger than 4 GiB needs ZIP64.');
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD, true);
  ev.setUint16(8, entries.length, true); // entries on this disk
  ev.setUint16(10, entries.length, true); // entries total
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true); // central directory offset
  // comment length = 0

  const out = new Uint8Array(offset + centralSize + eocd.byteLength);
  let cursor = 0;
  for (const part of [...parts, ...central, eocd]) {
    out.set(part, cursor);
    cursor += part.byteLength;
  }
  return out;
}
