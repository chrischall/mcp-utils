// ────────────────────────────────────────────────────────────────────────────
// Filesystem helpers for multipart uploads — stream files from disk instead of
// buffering them in memory.
//
// The fleet's upload tools (ofw attachments, evite photos, skylight avatars)
// repeated `new Blob([readFileSync(path)])` → which loads the WHOLE file into a
// Node Buffer before the request even starts. `fileBlob()` returns a Blob backed
// by the file on disk (`fs.openAsBlob`), so `fetch` streams the bytes straight
// off disk as it sends the multipart body — constant memory regardless of size.
// ────────────────────────────────────────────────────────────────────────────

import { openAsBlob } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';

/** Options for {@link fileBlob}. */
export interface FileBlobOptions {
  /** MIME type stamped on the Blob (becomes the multipart part's Content-Type). */
  type?: string;
  /** Reject (before any upload) when the file is larger than this many bytes. */
  maxBytes?: number;
  /** Friendly name for the size-limit error message (e.g. "Image"). */
  label?: string;
}

/**
 * A **file-backed** `Blob` for streaming multipart uploads. Backed by the file
 * on disk via `fs.openAsBlob`, so the bytes are NOT read into memory — `fetch`
 * streams them from disk as it sends the request body. Use in place of
 * `new Blob([readFileSync(path)])` when building `FormData` for an upload.
 *
 * @throws if the file can't be opened, or (when `maxBytes` is set) is too large.
 */
export async function fileBlob(path: string, opts: FileBlobOptions = {}): Promise<Blob> {
  let blob: Blob;
  try {
    blob = await openAsBlob(path, opts.type !== undefined ? { type: opts.type } : undefined);
  } catch {
    throw new Error(`Cannot read file for upload: ${path}`);
  }
  if (opts.maxBytes !== undefined && blob.size > opts.maxBytes) {
    throw new Error(
      `${opts.label ?? 'File'} is ${blob.size} bytes, over the ${opts.maxBytes}-byte limit: ${path}`,
    );
  }
  return blob;
}

/**
 * Read the first `bytes` of a file (for magic-byte / header sniffing — image
 * dimensions, file-type detection) WITHOUT loading the whole file. Returns only
 * as many bytes as were actually read (a short file yields a short buffer).
 */
export async function readFileHead(path: string, bytes: number): Promise<Buffer> {
  // Wrap the open like `fileBlob` does, so a missing file yields the same clean,
  // non-leaking message instead of a raw Node ENOENT (path + stack).
  let fh: FileHandle;
  try {
    fh = await open(path, 'r');
  } catch {
    throw new Error(`Cannot read file: ${path}`);
  }
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
