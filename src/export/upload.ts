/**
 * Getting a caller's file INTO a hosted server — the inbound half of the
 * mcp-host blob store.
 *
 * A server on mcp-host shares no filesystem with its caller (a claude.ai
 * session, a phone), so a tool input that names a file by PATH cannot work
 * there. Two ways in, by size:
 *
 *  - **Upload slots** (the main path). The server mints a signed PUT URL
 *    ({@link mintUploadSlot}); the caller `curl`s the file to it; the server
 *    reads the object back and deletes it once used (`BlobStore.consume`,
 *    keyed by the slot's `blobKey`, validated by {@link uploadFileNameFromKey}).
 *    No base64 in the tool call, no request-size ceiling.
 *  - **Inline base64** ({@link inlineFileSchema} + {@link decodeBase64Strict}).
 *    Works on any deployment, but every byte rides inside one JSON-RPC request
 *    (mcp-host caps the body at ~9.9 MiB) and a model has to emit it as text —
 *    right for a small file, wrong for a batch of phone photos.
 *
 * Consolidates ofw-mcp `src/tools/uploads.ts` (slots, strict base64, filename
 * rules) and splitwise-mcp `src/tools/uploads.ts` + `_receipt.ts` (the first
 * inbound slot, `sw_get_upload_url`), and replaces gogcli-mcp's base64-only
 * `attachInline` path for files too large to inline.
 *
 * ## The key carries the filename, losslessly
 *
 * `<prefix>/<uuid>/<base64url(filename)>`. The blob store only accepts
 * `[A-Za-z0-9._~-]` key segments and a photo name routinely has spaces, so a
 * readable-but-lossy key would lose the name the upstream should show. The
 * random UUID makes the key unguessable and per-slot unique.
 * {@link uploadFileNameFromKey} accepts ONLY that shape, so a caller cannot
 * aim an upload input at another object in the registration's store (an
 * export zip, a calendar file) and pass it off as their upload.
 *
 * Messages here are tool-agnostic; the refusal that names a tool ("call
 * x_upload with uploadSlots…") belongs to the consuming server.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BlobSignOptions, BlobStore } from './blob.js';

/** Fleet ceiling on files per call (inline array, upload slots, blob keys). */
export const MAX_UPLOAD_FILES = 10;

/** Default object-key prefix for caller uploads. */
export const UPLOAD_KEY_PREFIX = 'uploads';

/**
 * Default life of an upload slot's PUT URL: long enough to find the file and
 * run a curl, short because the URL is a credential to write that key.
 */
export const UPLOAD_SLOT_DEFAULT_TTL_MS = 30 * 60 * 1000;

const MIB = 1024 * 1024;
const OCTET_STREAM = 'application/octet-stream';

/** One inline file: `{filename, contentBase64, mimeType?}`. Re-describe per tool as needed. */
export const inlineFileSchema = z.object({
  filename: z.string().describe('Filename the upstream will show — a bare name, no path, not starting with a dot. Its extension sets the MIME type when mimeType is omitted.'),
  contentBase64: z.string().describe('The file\'s bytes, standard base64 (line breaks and a "data:<type>;base64," prefix are tolerated).'),
  mimeType: z.string().describe('MIME type, e.g. "image/jpeg". Default: inferred from the filename extension.').optional(),
});
/** An inline file, as parsed by {@link inlineFileSchema}. */
export type InlineFile = z.infer<typeof inlineFileSchema>;

/** One upload-slot request: `{filename, mimeType?}`. */
export const uploadSlotRequestSchema = z.object({
  filename: z.string().describe('Filename the upstream will show — a bare name, no path, not starting with a dot.'),
  mimeType: z.string().describe('MIME type. Default: inferred from the filename extension. The PUT must send exactly this Content-Type.').optional(),
});
/** An upload-slot request, as parsed by {@link uploadSlotRequestSchema}. */
export type UploadSlotRequest = z.infer<typeof uploadSlotRequestSchema>;

/**
 * A caller-supplied filename, as the name the upstream will show. It must be
 * ONE plain segment: a path or a hidden-file name has no legitimate use there
 * and is refused rather than repaired. Returns it trimmed.
 */
export function sanitizeUploadFilename(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) throw new Error('filename is empty.');
  if (/[/\\]/.test(name)) {
    throw new Error(`filename ${JSON.stringify(name)} must be a bare filename, not a path — pass just the name to show, e.g. "photo.jpg".`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) throw new Error(`filename ${JSON.stringify(name)} contains control characters.`);
  if (name.startsWith('.')) {
    throw new Error(`filename ${JSON.stringify(name)} must not start with a dot (hidden files are never uploaded).`);
  }
  if (name.length > 200) throw new Error('filename is longer than 200 characters.');
  return name;
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif',
  tif: 'image/tiff', tiff: 'image/tiff',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html', htm: 'text/html',
  json: 'application/json',
  xml: 'application/xml',
  ics: 'text/calendar',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
};

/** MIME type from a filename's extension; `application/octet-stream` when unknown. */
export function mimeFromFileName(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return OCTET_STREAM;
  return MIME_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? OCTET_STREAM;
}

const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

/**
 * The MIME type to upload under: an explicit one (parameters stripped,
 * lowercased, validated as `type/subtype`), else the extension's.
 */
export function resolveUploadMime(fileName: string, mimeType?: string): string {
  if (mimeType === undefined) return mimeFromFileName(fileName);
  const bare = (mimeType.split(';', 1)[0] ?? '').trim().toLowerCase();
  if (!MEDIA_TYPE.test(bare)) {
    throw new Error(`mimeType ${JSON.stringify(mimeType)} is not a type/subtype media type such as "image/jpeg".`);
  }
  return bare;
}

/** `"25 MiB (26214400 bytes)"` — floored, so the stated limit is one that can actually be sent. */
function limitText(maxBytes: number): string {
  return `${Math.floor(maxBytes / MIB)} MiB (${maxBytes} bytes)`;
}

/** Refuse an empty file or one over `maxBytes`, naming the file and the limit. */
export function checkUploadSize(fileName: string, size: number, maxBytes: number): void {
  if (size === 0) throw new Error(`${fileName} is empty (0 bytes); nothing to upload.`);
  if (size > maxBytes) throw new Error(`${fileName} is too large (${size} bytes); the upload limit is ${limitText(maxBytes)}.`);
}

/** Options for {@link decodeBase64Strict}. */
export interface DecodeBase64Options {
  /** Named in every error. */
  fileName: string;
  /** Largest decoded size accepted. */
  maxBytes: number;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decode caller base64 STRICTLY. `Buffer.from(s, 'base64')` never throws — it
 * silently drops characters it does not recognise — so a truncated or mangled
 * payload would otherwise be uploaded as a corrupt file and only discovered by
 * its recipient. A `data:…;base64,` prefix and whitespace are tolerated; the
 * size is checked from the encoded length before anything is allocated; and a
 * non-canonical spelling (stray padding bits) is refused by round trip.
 */
export function decodeBase64Strict(content: string, opts: DecodeBase64Options): Uint8Array {
  const { fileName, maxBytes } = opts;
  const compact = content.replace(/^data:[^,]*;base64,/i, '').replace(/\s+/g, '');
  if (compact.length === 0) throw new Error(`${fileName} is empty (0 bytes); nothing to upload.`);
  const invalid = () => new Error(
    `${fileName}: contentBase64 is not valid base64 (standard alphabet A-Z a-z 0-9 + /, padded with = to a multiple of 4 characters). It may have been truncated.`,
  );
  if (compact.length % 4 !== 0 || !BASE64.test(compact)) throw invalid();
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  checkUploadSize(fileName, (compact.length / 4) * 3 - padding, maxBytes);
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.toString('base64') !== compact) throw invalid();
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Options for {@link mintUploadSlot}. */
export interface MintUploadSlotOptions extends BlobSignOptions {
  /** First key segment. Default {@link UPLOAD_KEY_PREFIX}. TTL defaults to {@link UPLOAD_SLOT_DEFAULT_TTL_MS}. */
  prefix?: string;
}

/** A signed slot the caller PUTs one file into. */
export interface UploadSlot {
  filename: string;
  mimeType: string;
  /** Hand back to the server once the PUT succeeded; it reads (and deletes) this key. */
  blobKey: string;
  method: 'PUT';
  /** Signed PUT URL — a credential to write this one key until it expires. */
  uploadUrl: string;
  expiresAtMs: number;
  /** `expiresAtMs` as ISO-8601 UTC. */
  expiresAt: string;
  /** A ready upload command; the caller replaces the `<path to …>` placeholder. */
  curl: string;
}

const PREFIX = /^[A-Za-z0-9._~-]+$/;

function checkPrefix(prefix: string): void {
  if (!PREFIX.test(prefix) || prefix === '.' || prefix === '..') {
    throw new Error(`Upload key prefix ${JSON.stringify(prefix)} must be one key segment of [A-Za-z0-9._~-].`);
  }
}

/**
 * Mint one signed PUT slot for a caller upload: validate the filename and MIME
 * type, build a fresh `<prefix>/<uuid>/<base64url(filename)>` key, and sign a
 * PUT committed to the MIME type — so the curl must send exactly that
 * `Content-Type`, which the returned `curl` does.
 */
export function mintUploadSlot(store: BlobStore, req: UploadSlotRequest, opts: MintUploadSlotOptions = {}): UploadSlot {
  const prefix = opts.prefix ?? UPLOAD_KEY_PREFIX;
  checkPrefix(prefix);
  const filename = sanitizeUploadFilename(req.filename);
  const mimeType = resolveUploadMime(filename, req.mimeType);
  const blobKey = `${prefix}/${randomUUID()}/${Buffer.from(filename, 'utf8').toString('base64url')}`;
  const { url, expiresAtMs } = store.signPutUrl(blobKey, mimeType, {
    ttlMs: opts.ttlMs ?? UPLOAD_SLOT_DEFAULT_TTL_MS,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  const shellName = filename.replace(/'/g, `'\\''`);
  return {
    filename,
    mimeType,
    blobKey,
    method: 'PUT',
    uploadUrl: url,
    expiresAtMs,
    expiresAt: new Date(expiresAtMs).toISOString(),
    // --fail turns a refused PUT (expired, wrong Content-Type) into a non-zero exit.
    curl: `curl -sS --fail -X PUT -H 'Content-Type: ${mimeType}' --data-binary @'<path to ${shellName}>' '${url}'`,
  };
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * The filename an upload key was minted for. Only the exact shape
 * {@link mintUploadSlot} produces under `prefix` is accepted, and the decoded
 * name must still pass {@link sanitizeUploadFilename}.
 */
export function uploadFileNameFromKey(key: string, opts: { prefix?: string } = {}): string {
  const prefix = opts.prefix ?? UPLOAD_KEY_PREFIX;
  checkPrefix(prefix);
  const escaped = prefix.replace(/[.~-]/g, '\\$&');
  const match = new RegExp(`^${escaped}/${UUID}/([A-Za-z0-9_-]+)$`).exec(key);
  if (!match) {
    throw new Error(`blobKey ${JSON.stringify(key)} is not an upload key. Pass the blobKey exactly as the upload slot returned it.`);
  }
  return sanitizeUploadFilename(Buffer.from(match[1]!, 'base64url').toString('utf8'));
}
