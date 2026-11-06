/**
 * `resolveUploadSource` — one entry point for "the caller is giving this tool
 * a file", whichever way it arrives:
 *
 *  - **path** — a file on THIS machine (local installs), vetted by
 *    {@link vetUploadFile}: root confinement through symlinks, extension
 *    allowlist, regular file, size cap, magic bytes;
 *  - **inline** — `{filename, contentBase64, mimeType?}`, strictly decoded;
 *  - **blobKey** — a file the caller PUT to an upload slot
 *    ({@link mintUploadSlot}), read back from the blob store.
 *
 * Every route ends in the same validated {@link UploadSource}: name, type,
 * bytes, size and SHA-256 (what a confirmation binds). The fleet scan
 * (2026-11) found the same gaps repeated per server — path-only uploads that
 * cannot work on a hosted deployment, base64 decoded with `Buffer.from`/`atob`
 * (which silently drop bad characters) and no size cap, and private copies of
 * the extension→MIME table.
 *
 * Reading never deletes. A gated tool resolves on its preview call (binding
 * `sha256`) and again on the confirmed call, does its upstream write, and only
 * then calls `release()` — which deletes a blob-store upload and reports
 * (never throws) a failed delete, because the write has already happened and
 * an error would invite a duplicate.
 */

import { createHash } from 'node:crypto';
import { readEnvVar, type EnvSource } from '../config/index.js';
import { McpToolError } from '../errors/index.js';
import { bytesMatchMime } from '../fs/magic.js';
import { vetUploadFile, type VetUploadOptions } from '../fs/upload-guard.js';
import { blobStoreFromEnv, type BlobStore } from './blob.js';
import {
  checkUploadSize,
  decodeBase64Strict,
  resolveUploadMime,
  sanitizeUploadFilename,
  uploadFileNameFromKey,
  UPLOAD_KEY_PREFIX,
  type InlineFile,
} from './upload.js';

/** The caller's file, in whichever form it arrived. Exactly one is allowed. */
export interface UploadSourceInput {
  path?: string;
  inline?: InlineFile;
  blobKey?: string;
}

/** Options for {@link resolveUploadSource}. */
export interface ResolveUploadSourceOptions {
  /** Largest file accepted, in bytes (every route). */
  maxBytes: number;
  /**
   * Bare MIME types accepted. When set, every route must resolve to one of
   * them AND its bytes must match it ({@link bytesMatchMime}, which fails
   * closed for a type it cannot verify). The path route also needs
   * `path.mimeByExt`.
   */
  allowedMimeTypes?: readonly string[];
  /** Accept `path`, vetted with these options. Omit to refuse paths. */
  path?: Omit<VetUploadOptions, 'maxBytes' | 'readAll'>;
  /** The blob store. Default {@link blobStoreFromEnv}; `null` for none. */
  store?: BlobStore | null;
  /** True on a hosted deployment (paths refused). Default {@link isHostedEnv}. */
  hosted?: boolean;
  /** Key prefix the slots were minted under. Default `uploads`. */
  keyPrefix?: string;
  /** The tool's own parameter names (and slot tool), for messages. */
  names?: { path?: string; inline?: string; blobKey?: string; slotTool?: string };
}

/** What deleting the upload achieved: `null` when there was nothing to delete (path / inline). */
export type UploadRelease = { deleted: true } | { deleted: false; error: string } | { deleted: null };

/** A caller's file, validated, from any route. */
export interface UploadSource {
  origin: 'path' | 'inline' | 'blob';
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  sizeBytes: number;
  /** Hex SHA-256 of `bytes` — bind it into a confirmation. */
  sha256: string;
  /** The blob-store key, for `origin: 'blob'`. */
  blobKey?: string;
  /** Delete the blob-store upload (call after the upstream write succeeds). Never throws. */
  release(): Promise<UploadRelease>;
}

/**
 * True on mcp-host: it injects `MCP_DATA_DIR` (the per-registration state
 * dir) and, with a blob store, `MCP_BLOB_BASE_URL`. A local stdio install has
 * neither. Read through `readEnvVar`, so placeholders count as unset.
 */
export function isHostedEnv(env: EnvSource = process.env): boolean {
  return readEnvVar('MCP_DATA_DIR', { env }) !== undefined || readEnvVar('MCP_BLOB_BASE_URL', { env }) !== undefined;
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const noRelease = async (): Promise<UploadRelease> => ({ deleted: null });

function checkType(fileName: string, mimeType: string, bytes: Uint8Array, allowed: readonly string[] | undefined): void {
  if (allowed === undefined) return;
  if (!allowed.includes(mimeType)) {
    throw new McpToolError(`${fileName}: ${mimeType} is not accepted here (accepted: ${allowed.join(', ')}).`, { kind: 'unknown' });
  }
  if (!bytesMatchMime(bytes, mimeType)) {
    throw new McpToolError(`${fileName}: the file's contents do not look like ${mimeType}. Check that it is the file you meant, with the right extension.`, { kind: 'unknown' });
  }
}

/**
 * Resolve the caller's file from exactly one of `path` / `inline` / `blobKey`
 * — see the module header. Throws {@link McpToolError} (or the
 * `UploadRefusedError` from {@link vetUploadFile}) naming what is wrong and,
 * for a path on a hosted deployment, what to do instead.
 */
export async function resolveUploadSource(input: UploadSourceInput, opts: ResolveUploadSourceOptions): Promise<UploadSource> {
  const n = { path: 'path', inline: 'inline', blobKey: 'blobKey', ...opts.names };
  const given = [input.path, input.inline, input.blobKey].filter((v) => v !== undefined).length;
  if (given !== 1) {
    throw new McpToolError(`Pass exactly one of ${n.path}, ${n.inline} or ${n.blobKey}.`, { kind: 'unknown' });
  }
  const store = opts.store === undefined ? blobStoreFromEnv() : opts.store ?? undefined;
  const hosted = opts.hosted ?? isHostedEnv();
  const slotRoute = n.slotTool !== undefined
    ? `call ${n.slotTool} to get an upload URL, PUT the file to it, then pass ${n.blobKey}`
    : `upload it to an upload slot and pass ${n.blobKey}`;

  if (input.path !== undefined) {
    if (hosted) {
      throw new McpToolError(
        `This server is remote and can't read files on your machine, so ${n.path} cannot work here. `
        + (store ? `To send a file, ${slotRoute}; for a small file you can instead pass ${n.inline} with base64 content.` : `Pass the bytes with ${n.inline} (base64) instead.`),
        { kind: 'unknown' },
      );
    }
    if (opts.path === undefined) {
      throw new McpToolError(`This tool does not accept a path; pass ${n.inline} or ${n.blobKey}.`, { kind: 'unknown' });
    }
    const vetted = await vetUploadFile(input.path, { ...opts.path, maxBytes: opts.maxBytes, readAll: true });
    const bytes = vetted.bytes!;
    const fileName = vetted.requested.split(/[/\\]/).pop()!;
    checkType(fileName, vetted.mime, bytes, opts.allowedMimeTypes);
    return { origin: 'path', fileName, mimeType: vetted.mime, bytes, sizeBytes: bytes.length, sha256: sha256Hex(bytes), release: noRelease };
  }

  if (input.inline !== undefined) {
    const fileName = sanitizeUploadFilename(input.inline.filename);
    const mimeType = resolveUploadMime(fileName, input.inline.mimeType);
    const bytes = decodeBase64Strict(input.inline.contentBase64, { fileName, maxBytes: opts.maxBytes });
    checkType(fileName, mimeType, bytes, opts.allowedMimeTypes);
    return { origin: 'inline', fileName, mimeType, bytes, sizeBytes: bytes.length, sha256: sha256Hex(bytes), release: noRelease };
  }

  const key = input.blobKey!;
  if (!store) {
    throw new McpToolError(`${n.blobKey} needs the blob store a hosted deployment provides, and this server has no blob store. Pass ${n.path} or ${n.inline} instead.`, { kind: 'unknown' });
  }
  const fileName = uploadFileNameFromKey(key, { prefix: opts.keyPrefix ?? UPLOAD_KEY_PREFIX });
  const object = await store.get(key, { maxBytes: opts.maxBytes });
  checkUploadSize(fileName, object.bytes.length, opts.maxBytes);
  // The stored type is the one the PUT signature committed to — the one the slot was minted for.
  const mimeType = resolveUploadMime(fileName, object.contentType);
  checkType(fileName, mimeType, object.bytes, opts.allowedMimeTypes);
  return {
    origin: 'blob', blobKey: key, fileName, mimeType, bytes: object.bytes, sizeBytes: object.bytes.length, sha256: sha256Hex(object.bytes),
    release: async () => {
      try {
        await store.delete(key);
        return { deleted: true };
      } catch (e) {
        if ((e as { status?: number }).status === 404) return { deleted: true };
        return { deleted: false, error: (e as Error).message };
      }
    },
  };
}
