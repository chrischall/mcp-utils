/**
 * A bounded zip reader for hostile Office files (xlsx, pptx).
 *
 * Attachments come from anyone who can email the user, so the archive is
 * treated as an attack: the central directory is read first, an entry whose
 * DECLARED uncompressed size exceeds the per-entry cap is refused, and so is
 * an archive whose declared total exceeds `maxUnzippedBytes`. Declared sizes
 * lie, so inflation is streamed in small input chunks and stopped as soon as
 * an entry passes its declared size (or the per-entry cap), or the running
 * ACTUAL total across reads passes `maxUnzippedBytes`. Only the entries a
 * converter asks for are inflated.
 *
 * Zip64, encrypted entries and compression methods other than STORE/DEFLATE
 * are refused — Office never writes them for files under the input cap.
 */

import { McpToolError } from '../errors/index.js';
import { importPeer } from './peer.js';
import { resolveConvertLimits, ZIP_ENTRY_MAX_BYTES, type ConvertLimits } from './types.js';

/** One central-directory entry. */
export interface ZipEntryInfo {
  name: string;
  /** 0 = STORE, 8 = DEFLATE. */
  method: number;
  compressedSize: number;
  /** Declared (untrusted) uncompressed size. */
  size: number;
  /** Offset of the entry's local header. */
  localOffset: number;
}

/** A zip archive opened by {@link openZip}. */
export interface ZipReader {
  /** Every entry name, in central-directory order. */
  names(): string[];
  /** The central-directory record for `name`, if present. */
  entry(name: string): ZipEntryInfo | undefined;
  /** Inflate `name` (bounded); `undefined` when there is no such entry. */
  read(name: string): Promise<Uint8Array | undefined>;
  /** {@link ZipReader.read} decoded as UTF-8 (BOM stripped). */
  readText(name: string): Promise<string | undefined>;
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
/** Input fed to the inflater per step; DEFLATE's ~1032:1 ceiling bounds one step's output to ~4 MiB. */
const INFLATE_CHUNK = 4 * 1024;

function invalid(detail: string): McpToolError {
  return new McpToolError(`Not a valid zip archive: ${detail}.`, { kind: 'unknown' });
}

function tooLarge(detail: string): McpToolError {
  return new McpToolError(`Archive refused: ${detail}.`, {
    kind: 'too_large',
    hint: 'The file inflates past the converter\'s safety cap (a possible zip bomb); raise limits.maxUnzippedBytes only for a trusted file.',
  });
}

function mib(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

function readCentralDirectory(bytes: Uint8Array): ZipEntryInfo[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 22) throw invalid('too short');
  let eocd = -1;
  const stop = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= stop; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw invalid('no end-of-central-directory record');
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw invalid('zip64 archives are not supported');
  if (cdOffset + cdSize > eocd) throw invalid('central directory out of bounds');

  const decoder = new TextDecoder();
  const entries: ZipEntryInfo[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || view.getUint32(p, true) !== SIG_CENTRAL) throw invalid('corrupt central directory');
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    if (p + 46 + nameLen > eocd) throw invalid('corrupt central directory');
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) {
      throw invalid('zip64 archives are not supported');
    }
    if (flags & 0x1) throw invalid(`entry "${name}" is encrypted`);
    if (method !== 0 && method !== 8) throw invalid(`entry "${name}" uses unsupported compression method ${method}`);
    entries.push({ name, method, compressedSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Open a zip archive under `limits.maxUnzippedBytes` (default 200 MiB total,
 * at most 50 MiB per entry). Throws an {@link McpToolError} — kind
 * `'too_large'` for a cap, `'unknown'` for a malformed archive — before
 * anything is inflated when the declared sizes already break a cap.
 */
export async function openZip(bytes: Uint8Array, limits?: ConvertLimits, signal?: AbortSignal): Promise<ZipReader> {
  return (await open(bytes, limits, signal)).reader;
}

async function open(
  bytes: Uint8Array,
  limits: ConvertLimits | undefined,
  signal: AbortSignal | undefined,
): Promise<{ reader: ZipReader; inflateAll: () => Promise<void> }> {
  signal?.throwIfAborted();
  const totalCap = resolveConvertLimits(limits).maxUnzippedBytes;
  const entryCap = Math.min(ZIP_ENTRY_MAX_BYTES, totalCap);
  const entries = readCentralDirectory(bytes);

  const byName = new Map<string, ZipEntryInfo>();
  let declaredTotal = 0;
  for (const e of entries) {
    if (e.size > entryCap) throw tooLarge(`entry "${e.name}" declares ${mib(e.size)}, over the ${mib(entryCap)} per-entry cap`);
    declaredTotal += e.size;
    if (declaredTotal > totalCap) throw tooLarge(`entries declare more than the ${mib(totalCap)} total cap`);
    // Libraries disagree on which copy of a duplicated name wins (JSZip, under
    // exceljs, keeps the LAST), and undecodable name bytes all become U+FFFD
    // here while JSZip decodes them as CP437 — so a collision would let a
    // guarded copy stand in for an unguarded one. Office never writes either.
    if (byName.has(e.name)) throw invalid(`duplicate entry name "${e.name}"`);
    byName.set(e.name, e);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let inflatedTotal = 0;
  const counted = new Set<ZipEntryInfo>();

  const readEntry = async (e: ZipEntryInfo): Promise<Uint8Array> => {
    signal?.throwIfAborted();
    const name = e.name;
    const lh = e.localOffset;
    if (lh + 30 > bytes.length || view.getUint32(lh, true) !== SIG_LOCAL) throw invalid(`bad local header for "${name}"`);
    const start = lh + 30 + view.getUint16(lh + 26, true) + view.getUint16(lh + 28, true);
    const end = start + e.compressedSize;
    if (end > bytes.length) throw invalid(`entry "${name}" runs past the end of the file`);
    const data = bytes.subarray(start, end);
    // An entry may not inflate past what it declared (already within the caps).
    // Each central-directory entry counts once toward the running actual total.
    const seen = counted.has(e);
    const cap = seen ? e.size : Math.min(e.size, totalCap - inflatedTotal);
    const overflow = (): McpToolError =>
      tooLarge(`entry "${name}" inflates past its declared ${e.size} bytes or the ${mib(totalCap)} total cap`);

    let out: Uint8Array;
    if (e.method === 0) {
      if (data.length > cap) throw overflow();
      out = data.slice();
    } else {
      const { Inflate } = await importPeer('fflate', () => import('fflate'));
      const chunks: Uint8Array[] = [];
      let got = 0;
      let over = false;
      const inflater = new Inflate((chunk) => {
        got += chunk.length;
        if (got > cap) {
          over = true;
          throw overflow();
        }
        chunks.push(chunk);
      });
      try {
        for (let i = 0; i < data.length; i += INFLATE_CHUNK) {
          signal?.throwIfAborted();
          const end2 = Math.min(i + INFLATE_CHUNK, data.length);
          inflater.push(data.subarray(i, end2), end2 === data.length);
        }
        if (data.length === 0) inflater.push(new Uint8Array(0), true);
      } catch (err) {
        if (over) throw overflow();
        if (err instanceof McpToolError || signal?.aborted) throw err;
        throw invalid(`entry "${name}" is corrupt (${err instanceof Error ? err.message : String(err)})`);
      }
      out = new Uint8Array(got);
      let o = 0;
      for (const c of chunks) {
        out.set(c, o);
        o += c.length;
      }
    }
    if (!seen) {
      counted.add(e);
      inflatedTotal += out.length;
    }
    return out;
  };

  const read = async (name: string): Promise<Uint8Array | undefined> => {
    signal?.throwIfAborted();
    const e = byName.get(name);
    return e ? readEntry(e) : undefined;
  };

  const reader: ZipReader = {
    names: () => entries.map((e) => e.name),
    entry: (name) => byName.get(name),
    read,
    readText: async (name) => {
      const b = await read(name);
      if (b === undefined) return undefined;
      return new TextDecoder().decode(b).replace(/^﻿/, '');
    },
  };
  // By central-directory entry, not by name: whatever a library resolves a
  // name to, every entry it could inflate has been inflated here first.
  const inflateAll = async (): Promise<void> => {
    for (const e of entries) await readEntry(e);
  };
  return { reader, inflateAll };
}

/**
 * Inflate every entry of `bytes` under the same caps as {@link openZip}, for a
 * library (exceljs) that would otherwise inflate a zip bomb unguarded.
 *
 * This doubles the inflate work on a good archive (the library inflates it all
 * again), which is the price of guarding a library that cannot be bounded
 * itself; a cheaper path would hand the library the already-inflated entries. Resolves
 * to the entry names when the archive is within limits; throws like
 * {@link ZipReader.read}.
 */
export async function assertZipWithinLimits(bytes: Uint8Array, limits?: ConvertLimits, signal?: AbortSignal): Promise<string[]> {
  const { reader, inflateAll } = await open(bytes, limits, signal);
  await inflateAll();
  return reader.names();
}
