/**
 * Race-free, symlink-refusing file writes.
 *
 * Consolidates accessoticketing's `DiskFileIO.write` (an exclusive `wx` create
 * that retries under a fresh name on EEXIST, so two writers can never pick the
 * same "free" name) and infinitecampus's `writeConfined` (an
 * `O_NOFOLLOW | O_EXCL` open, so a symlink planted at the destination between
 * the pre-flight check and the write — a network fetch apart — is refused by
 * the open itself rather than written through). The previous
 * `uniquePath` + `writeFileSync` shape was a check-then-write race and, worse,
 * `existsSync` reports a DANGLING symlink as free, so the write followed it and
 * created the link's target wherever it pointed.
 *
 * `O_NOFOLLOW` is POSIX-only: on Windows it is undefined and coerces to 0 (and
 * creating a symlink there needs elevated rights anyway). `O_EXCL` alone never
 * follows a final-component symlink on any platform.
 */

import { closeSync, constants as fsConstants, mkdirSync, openSync, writeSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

import { McpToolError } from '../errors/index.js';
import { assertPathWithinRoots } from './confine.js';

const { O_WRONLY, O_CREAT, O_TRUNC, O_EXCL } = fsConstants;
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/** Why {@link writeFileSafe} / {@link writeUniqueFile} refused a write. */
export type FileWriteRefusal = 'exists' | 'symlink' | 'outside-roots';

/**
 * A write was refused for safety — the destination already exists (exclusive
 * mode), is a symlink, or lies outside `allowedRoots`. Nothing was written.
 * Other I/O failures (a missing parent, EACCES, ENOSPC) surface as the
 * original Node error.
 */
export class FileWriteRefusedError extends McpToolError {
  readonly reason: FileWriteRefusal;
  readonly path: string;
  constructor(path: string, reason: FileWriteRefusal) {
    const why =
      reason === 'exists'
        ? 'a file already exists there'
        : reason === 'symlink'
          ? 'it is a symbolic link'
          : 'it is outside the allowed directories';
    super(`Refusing to write ${path}: ${why}.`);
    this.name = 'FileWriteRefusedError';
    this.reason = reason;
    this.path = path;
  }
}

/** Options for {@link writeFileSafe}. */
export interface WriteFileSafeOptions {
  /**
   * Replace an existing regular file (`O_TRUNC`) instead of refusing it
   * (`O_EXCL`, the default). A symlink is refused either way.
   */
  overwrite?: boolean;
  /**
   * File mode for a new file (before umask), e.g. `0o600` for private data.
   * On `overwrite` the existing file is also `chmod`ed to it, since the create
   * mode only applies to a new inode. Default `0o666` (umask applies).
   */
  mode?: number;
  /** Refuse a destination that does not resolve inside one of these roots. */
  allowedRoots?: readonly string[];
}

function flagsFor(overwrite: boolean): number {
  return O_WRONLY | O_CREAT | O_NOFOLLOW | (overwrite ? O_TRUNC : O_EXCL);
}

function refusalFor(err: unknown, path: string): FileWriteRefusedError | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EEXIST') return new FileWriteRefusedError(path, 'exists');
  // Linux/macOS report a final-component symlink under O_NOFOLLOW as ELOOP;
  // FreeBSD uses EMLINK.
  if (code === 'ELOOP' || code === 'EMLINK') return new FileWriteRefusedError(path, 'symlink');
  return undefined;
}

function confine(path: string, roots: readonly string[] | undefined): string {
  if (!roots) return path;
  try {
    return assertPathWithinRoots(path, roots);
  } catch {
    throw new FileWriteRefusedError(path, 'outside-roots');
  }
}

/**
 * Write `bytes` to `path` without ever following a symlink at the final
 * component, and (by default) without clobbering anything already there —
 * one `open(O_CREAT | O_NOFOLLOW | O_EXCL)`, so there is no window between a
 * check and the write. With `allowedRoots`, the destination is first confined
 * (through symlinks, nearest existing ancestor) and the REAL path is written.
 * The parent directory must exist. Returns the path written.
 *
 * @throws {FileWriteRefusedError} when the destination exists (exclusive mode),
 *   is a symlink, or is outside `allowedRoots`.
 */
export async function writeFileSafe(path: string, bytes: Uint8Array, opts: WriteFileSafeOptions = {}): Promise<string> {
  const target = confine(path, opts.allowedRoots);
  const overwrite = opts.overwrite === true;
  let handle;
  try {
    handle = await open(target, flagsFor(overwrite), opts.mode ?? 0o666);
  } catch (err) {
    throw refusalFor(err, path) ?? err;
  }
  try {
    if (overwrite && opts.mode !== undefined) await handle.chmod(opts.mode);
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
  return target;
}

/**
 * Reduce a caller-supplied filename stem to a single safe path component:
 * strip directory separators and any `..`, so the stem can never escape the
 * output directory. A stem that sanitizes away entirely falls back to `'file'`.
 */
export function sanitizeBaseName(base: string): string {
  const safe = base
    .replace(/[/\\]+/g, '_') // kill path separators
    .replace(/\.\.+/g, '_') // neutralize .. (and longer dot runs)
    .replace(/^\.+/, '') // no leading dots (hidden-file / current-dir)
    .trim();
  return safe.length > 0 ? safe : 'file';
}

/** The n-th candidate name: `base.ext`, then `base-2.ext`, `base-3.ext`, … */
function candidate(dir: string, safeBase: string, ext: string, n: number): string {
  return join(dir, n === 1 ? `${safeBase}.${ext}` : `${safeBase}-${n}.${ext}`);
}

/** Default cap on names tried before {@link writeUniqueFile} gives up. */
const DEFAULT_MAX_ATTEMPTS = 1000;

/** Options for {@link writeUniqueFile}. */
export interface WriteUniqueFileOptions {
  /** Directory to write into; created (recursively) if missing. */
  dir: string;
  /** Filename stem (no extension); sanitized to one path component. */
  baseName: string;
  /** Extension, without the dot. */
  extension: string;
  bytes: Uint8Array;
  /** As {@link WriteFileSafeOptions.mode}. */
  mode?: number;
  /** Refuse a `dir` outside these roots (checked before it is created). */
  allowedRoots?: readonly string[];
  /** Names tried before giving up with an `exists` refusal. Default 1000. */
  maxAttempts?: number;
}

/**
 * Write `bytes` to a fresh, **never-overwriting** file in `dir` —
 * `base.ext`, else `base-2.ext`, `base-3.ext`, … — by attempting an exclusive,
 * no-follow create of each name in turn and moving on at EEXIST. Race-free (two
 * concurrent writers can't pick the same name) and a symlink planted at a
 * candidate name is skipped, never written through. Returns the path written.
 *
 * @throws {FileWriteRefusedError} `outside-roots` when `dir` is outside
 *   `allowedRoots`; `exists` after `maxAttempts` taken names.
 */
export async function writeUniqueFile(opts: WriteUniqueFileOptions): Promise<string> {
  const dir = confine(opts.dir, opts.allowedRoots);
  await mkdir(dir, { recursive: true });
  // Re-check now it exists, in case a component was swapped for a symlink.
  const realDir = confine(dir, opts.allowedRoots);
  const safe = sanitizeBaseName(opts.baseName);
  const max = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  for (let n = 1; ; n++) {
    const path = candidate(realDir, safe, opts.extension, n);
    try {
      return await writeFileSafe(path, opts.bytes, opts.mode !== undefined ? { mode: opts.mode } : {});
    } catch (err) {
      // A symlink at the name is just another taken name: skip it.
      const taken = err instanceof FileWriteRefusedError && (err.reason === 'exists' || err.reason === 'symlink');
      if (!taken || n >= max) throw err;
    }
  }
}

/**
 * Synchronous core of {@link writeUniqueFile} for the sync
 * `writeBinaryOutput`. Not exported from the package.
 */
export function writeUniqueFileSync(dir: string, baseName: string, ext: string, bytes: Uint8Array, mode?: number): string {
  mkdirSync(dir, { recursive: true });
  const safe = sanitizeBaseName(baseName);
  for (let n = 1; ; n++) {
    const path = candidate(dir, safe, ext, n);
    let fd: number;
    try {
      fd = openSync(path, flagsFor(false), mode ?? 0o666);
    } catch (err) {
      if (refusalFor(err, path) && n < DEFAULT_MAX_ATTEMPTS) continue;
      throw refusalFor(err, path) ?? err;
    }
    try {
      let off = 0;
      while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    } finally {
      closeSync(fd);
    }
    return path;
  }
}
