/**
 * `deliverFile` — hand a file's bytes back to an MCP caller by the first route
 * that works for THIS deployment.
 *
 * A hosted server (mcp-host) shares no filesystem with its caller, so a tool
 * that writes a download to "its" disk hands back a path nobody can open, and
 * a tool that inlines a big file trips the host's result ceiling (mcp-host
 * swaps a child result over 14 MiB for a generic error — and base64 grows the
 * bytes by a third). The fleet scan (2026-11) found the same three mistakes in
 * ~14 servers: disk-only downloads, uncapped inline bytes, and "too big — open
 * it in the web app" where a link would do. This is the one ladder:
 *
 *  1. **inline** when the bytes fit `inlineMaxBytes` — a host-renderable image
 *     as `ImageContent`, anything else as an `EmbeddedResource` blob;
 *  2. **link** — PUT to the blob store, return a signed, expiring GET URL —
 *     when the deployment has one (i.e. it is hosted);
 *  3. **disk** — a fresh, never-overwriting file under `disk.dir` — when the
 *     caller configured one (a local install);
 *  4. otherwise a `too_large` error naming the size, the cap and the routes.
 *
 * `prefer` reorders the ladder (`'link'`, `'disk'`, `'inline'`) without ever
 * choosing a route that cannot reach the caller: `'disk'` on a hosted server
 * becomes a link, with a note saying why.
 */

import { randomUUID } from 'node:crypto';
import { McpToolError } from '../errors/index.js';
import { sniffMimeBytes } from '../fs/magic.js';
import { extensionForMime } from '../fs/output.js';
import { isSafeExtension, writeUniqueFile } from '../fs/write.js';
import { blobStoreFromEnv, type BlobStore } from './blob.js';
import { mimeFromFileName } from './upload.js';

/**
 * Default inline ceiling: 10 MiB of raw bytes, ~13.3 MiB once base64-encoded —
 * under mcp-host's 14 MiB child-result cap, so this error fires first.
 */
export const INLINE_DELIVERY_MAX_BYTES = 10 * 1024 * 1024;

/** Default life of a delivery link (1h; the gateway allows at most 24h). */
export const DELIVERY_LINK_DEFAULT_TTL_MS = 60 * 60 * 1000;

/** Media types a host's inline image renderer accepts. */
const RENDERABLE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** One MCP content block of a delivered file. */
export type DeliveredContent =
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; mimeType: string; blob: string } };

/** Options for {@link deliverFile}. */
export interface DeliverFileOptions {
  bytes: Uint8Array;
  /** The name the caller should see (and a link / disk file is saved under). */
  fileName: string;
  /** Declared type; parameters (`;charset=…`) are stripped. Default: from the bytes, then the extension. */
  mimeType?: string;
  /** Route to try first. Default `'auto'` (inline → link → disk). */
  prefer?: 'auto' | 'inline' | 'link' | 'disk';
  /** The blob store. Default {@link blobStoreFromEnv}; pass `null` for none. */
  store?: BlobStore | null;
  /** First key segment for links. Default `'files'`. */
  keyPrefix?: string;
  /** Link life. Default {@link DELIVERY_LINK_DEFAULT_TTL_MS}. */
  linkTtlMs?: number;
  /** Inline ceiling in raw bytes. Default {@link INLINE_DELIVERY_MAX_BYTES}. */
  inlineMaxBytes?: number;
  /** Local-install disk route: the directory to write into, optionally confined. */
  disk?: {
    dir: string;
    allowedRoots?: readonly string[];
    /** File mode to create with (e.g. `0o600` for personal documents). Applied at create time — no chmod window. */
    mode?: number;
  };
}

/** What {@link deliverFile} did. Spread `content` into the tool result; put the rest in its JSON. */
export interface DeliveredFile {
  via: 'image' | 'resource' | 'link' | 'disk';
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Inline content blocks (empty for `link` / `disk`). */
  content: DeliveredContent[];
  /** `link`: the signed GET URL — give it only to the user; anyone holding it can download until it expires. */
  url?: string;
  /** `link`: when the URL stops working (ISO-8601). */
  expiresAt?: string;
  /** `disk`: where the file was written. */
  path?: string;
  /** Why the route differs from the one preferred, when it does. */
  note?: string;
}

function bareMime(raw: string | undefined): string | undefined {
  const bare = raw?.split(';', 1)[0]?.trim().toLowerCase();
  return bare ? bare : undefined;
}

function resolveMime(bytes: Uint8Array, declared: string | undefined, fileName: string): string {
  // Bytes never lie for the types a host renders; a declared type is often a
  // server's `application/octet-stream;charset=UTF-8` on a PNG.
  const sniffed = sniffMimeBytes(bytes);
  if (sniffed !== undefined && RENDERABLE_IMAGES.has(sniffed)) return sniffed;
  const bare = bareMime(declared);
  if (bare !== undefined && bare !== 'application/octet-stream') return bare;
  return sniffed ?? mimeFromFileName(fileName);
}

/** One key segment of the store's alphabet, never empty or dotted. */
function keySegment(fileName: string): string {
  const seg = fileName.replace(/[^A-Za-z0-9._~-]/g, '_').replace(/^\.+/, '');
  return /^[._~-]*$/.test(seg) ? 'file' : seg;
}

/**
 * Deliver `bytes` by the first route that reaches the caller — see the module
 * header for the ladder. Never writes to disk on a deployment with a blob
 * store, and never inlines past `inlineMaxBytes`.
 *
 * @throws {McpToolError} kind `'too_large'` when nothing fits.
 */
export async function deliverFile(opts: DeliverFileOptions): Promise<DeliveredFile> {
  const { bytes, fileName } = opts;
  const store = opts.store === undefined ? blobStoreFromEnv() : opts.store ?? undefined;
  const inlineMax = opts.inlineMaxBytes ?? INLINE_DELIVERY_MAX_BYTES;
  const mimeType = resolveMime(bytes, opts.mimeType, fileName);
  const base = { fileName, mimeType, sizeBytes: bytes.length };
  const fits = bytes.length <= inlineMax;
  const tooBig = `${fileName} is ${bytes.length} bytes, too large to return inline (limit ${inlineMax}).`;

  const inline = (note?: string): DeliveredFile => {
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    const content: DeliveredContent[] = RENDERABLE_IMAGES.has(mimeType)
      ? [{ type: 'image', data, mimeType }]
      : [{ type: 'resource', resource: { uri: `attachment:///${encodeURIComponent(fileName)}`, mimeType, blob: data } }];
    return { via: RENDERABLE_IMAGES.has(mimeType) ? 'image' : 'resource', ...base, content, ...(note ? { note } : {}) };
  };

  const link = async (note?: string): Promise<DeliveredFile> => {
    const key = `${opts.keyPrefix ?? 'files'}/${randomUUID()}/${keySegment(fileName)}`;
    await store!.put(key, bytes, mimeType);
    const signed = store!.signGetUrl(key, { ttlMs: opts.linkTtlMs ?? DELIVERY_LINK_DEFAULT_TTL_MS });
    return {
      via: 'link', ...base, content: [], url: signed.url, expiresAt: new Date(signed.expiresAtMs).toISOString(),
      ...(note ? { note } : {}),
    };
  };

  const disk = async (note?: string): Promise<DeliveredFile> => {
    const dot = fileName.lastIndexOf('.');
    const ownExt = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
    const extension = ownExt && isSafeExtension(ownExt) ? ownExt : extensionForMime(mimeType);
    const stem = dot > 0 && ownExt === extension ? fileName.slice(0, dot) : fileName;
    const path = await writeUniqueFile({
      dir: opts.disk!.dir, baseName: stem, extension, bytes,
      ...(opts.disk!.allowedRoots ? { allowedRoots: opts.disk!.allowedRoots } : {}),
      ...(opts.disk!.mode !== undefined ? { mode: opts.disk!.mode } : {}),
    });
    return { via: 'disk', ...base, content: [], path, ...(note ? { note } : {}) };
  };

  const noRoute = (): never => {
    throw new McpToolError(
      `${fileName} is ${bytes.length} bytes, over the ${inlineMax}-byte inline limit, and this server has no other way to hand it over (no blob store for a download link, no download directory).`,
      { kind: 'too_large', hint: 'Open the file in the service\'s own web app, or run this server where it has a download directory or a blob store.' },
    );
  };

  const prefer = opts.prefer ?? 'auto';
  if (prefer === 'link') {
    if (store) return link();
    if (opts.disk) return disk('There is no blob store for a download link here, so the file was saved to disk instead.');
    if (fits) return inline('There is no blob store for a download link here, so the file is returned inline instead.');
    return noRoute();
  }
  if (prefer === 'disk') {
    // A hosted server's disk is the runner's; nobody can open a path on it.
    if (store) return link("This server is hosted and the server's disk is not reachable from your session, so a download link is returned instead of a saved file.");
    if (opts.disk) return disk();
    if (fits) return inline('This server has no download directory configured, so the file is returned inline instead.');
    return noRoute();
  }
  // 'auto' and 'inline'
  if (fits) return inline();
  if (store) return link(`${tooBig} A download link is returned instead.`);
  if (opts.disk) return disk(`${tooBig} It was saved to disk instead.`);
  return noRoute();
}
