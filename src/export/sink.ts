/**
 * The export sink — where a bulk-export tool's files go, chosen by how the
 * server is installed, plus the small codecs every export tool needs
 * (resume cursor, JSONL line, part and attachment file names).
 *
 * A bulk export (office-outlook-mcp `outlook_export`, microsoft-teams-mcp
 * `teams_export`) pages an API server-side and writes thousands of records
 * to files so none of that content enters the model's context; the tool
 * returns only a small manifest. Where those files land depends on the
 * install, and both servers need exactly the same two answers, so the logic
 * lives here once:
 *
 *  - **disk** (any local / stdio install — no blob store configured): files
 *    are written under a fresh, exclusively-created export directory
 *    `<dir>/<baseName>-<YYYYMMDD-HHmmss>[-n]/`, where `<dir>` is the per-call
 *    `dest` → the `<SVC>_OUTPUT_DIR` env var → `~/Downloads/<name>`
 *    (`resolveOutputDir`). A per-call `dest` is confined to
 *    {@link exportAllowedRoots}. Every write goes through `writeFileSafe`
 *    confined to the export directory (exclusive, no-follow, `0600`), and
 *    the result carries ABSOLUTE paths the user or agent can open.
 *  - **blob** (mcp-host hosted children, which get `MCP_BLOB_BASE_URL` and
 *    `MCP_BLOB_SIGNING_KEY`): files are collected in memory, zipped into ONE
 *    archive (DEFLATE for text, STORE for already-compressed media), PUT to
 *    `exp/<exportId>/part-<NNNN>.zip`, and the result carries a signed GET URL
 *    (1h by default, 24h at most). A hosted child has no user-visible disk,
 *    so a link is the only deliverable. Always a zip, even for a single
 *    file, so a consumer handles one shape.
 *
 * Exports are resumable: a call that hits its item or time budget returns a
 * cursor ({@link encodeExportCursor}), and the next call re-opens the SAME
 * export — `exportId`, the next `part`, and on disk the `existingDir`, which
 * is re-validated against the roots because a cursor is model-supplied text
 * and never trusted.
 */

import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { expandPath, readEnvVar, type EnvSource } from '../config/index.js';
import { McpToolError } from '../errors/index.js';
import { assertPathWithinRoots } from '../fs/confine.js';
import { resolveOutputDir } from '../fs/output.js';
import { isSafeExtension, sanitizeBaseName, writeFileSafe } from '../fs/write.js';
import { blobStoreFromEnv, type BlobStore } from './blob.js';
import { buildZip, isCompressibleType } from './zip.js';

/** Where an export is delivered: local files, or a signed link to a zip in the hosted blob store. */
export type ExportMode = 'disk' | 'blob';

/** Options for {@link openExportSink}. */
export interface OpenExportSinkOptions {
  /** The server's name, e.g. `'office-outlook-mcp'` — the default dir is `~/Downloads/<name>`. */
  name: string;
  /** The server's output-dir env var, e.g. `'OUTLOOK_OUTPUT_DIR'`. */
  envVar: string;
  /** Per-call output directory (a tool argument) — confined to {@link exportAllowedRoots}. Ignored in blob mode. */
  dest?: string;
  /** Stem of the export directory name, e.g. `'outlook-mail'`; sanitized. */
  baseName: string;
  /** Resume: the export's id from the cursor. Default: a fresh random id. */
  exportId?: string;
  /** Part number, 1–9999 (default 1). In blob mode it names `part-<NNNN>.zip`. */
  part?: number;
  /** Resume (disk): the export directory from the cursor — re-validated, never trusted. Ignored in blob mode. */
  existingDir?: string;
  /** Environment to read the env var and `MCP_BLOB_*` from. Default `process.env`. */
  env?: EnvSource;
  /** `fetch` for the blob PUT (tests). */
  fetchImpl?: typeof fetch;
  /** "Now" in epoch ms — names the directory and dates the link. Default `Date.now()`. */
  now?: number;
  /** Blob mode: link life in ms (default 1h, max 24h). */
  ttlMs?: number;
  /** Cancels the blob upload. */
  signal?: AbortSignal;
}

/** Options for {@link ExportSink.addFile}. */
export interface AddExportFileOptions {
  /** Replace a file already added under this name (e.g. a manifest rewritten per part). Default: refuse. */
  overwrite?: boolean;
}

/** One file in an export. */
export interface ExportFileRecord {
  /** Path relative to the export root (disk directory or zip root), `/`-separated. */
  name: string;
  /** Disk mode only: the absolute path written. */
  path?: string;
  /** Uncompressed size in bytes. */
  bytes: number;
}

/** Where a finished export (part) is. */
export interface ExportLocation {
  mode: ExportMode;
  exportId: string;
  part: number;
  /** Disk: the absolute export directory. Blob: the signed GET URL of the zip (a bearer link until it expires). */
  location: string;
  /** Disk only: the absolute export directory (put it in the resume cursor). */
  dir?: string;
  /** Blob only: the object key of the zip. */
  key?: string;
  /** Blob only: when the link stops working, ISO-8601. */
  urlExpiresAt?: string;
  /** Blob only: size of the uploaded zip. */
  archiveBytes?: number;
  /** Sum of the files' uncompressed sizes. */
  bytes: number;
  files: ExportFileRecord[];
}

/** An open export (part). Add files, then {@link ExportSink.finish} exactly once. */
export interface ExportSink {
  readonly mode: ExportMode;
  readonly exportId: string;
  readonly part: number;
  /** Disk only: the absolute export directory. */
  readonly dir?: string;
  /**
   * Add a file at `relPath` (relative, `/`-separated, no `.`/`..`/empty
   * segments, no backslash or control character). A string is written as
   * UTF-8. `contentType` decides compression in blob mode (default: by
   * extension). Throws {@link McpToolError} on an unsafe or duplicate name
   * (unless `overwrite`), or after `finish`.
   */
  addFile(
    relPath: string,
    data: Uint8Array | string,
    contentType?: string,
    opts?: AddExportFileOptions,
  ): Promise<ExportFileRecord>;
  /** Disk: report the files. Blob: zip, upload and sign. Throws {@link McpToolError} if called twice. */
  finish(): Promise<ExportLocation>;
}

const EXPORT_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_PART = 9999;
const MAX_REL_PATH = 1024;
const MAX_SEGMENT = 255;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;

function badInput(message: string, hint?: string): McpToolError {
  return new McpToolError(message, hint !== undefined ? { hint, kind: 'unknown' } : { kind: 'unknown' });
}

/**
 * The roots a per-call `dest` (and a resumed export directory) must lie
 * within: the `envVar` directory when the operator set one, else the user's
 * `~/Downloads`, `~/Documents` and `~/Desktop`. Pass these as `allowedRoots`
 * wherever an export path comes from a tool argument or a cursor.
 */
export function exportAllowedRoots(envVar: string, env: EnvSource = process.env): string[] {
  const envDir = readEnvVar(envVar, { env });
  if (envDir) return [expandPath(envDir)];
  const home = homedir();
  return [join(home, 'Downloads'), join(home, 'Documents'), join(home, 'Desktop')];
}

/** `part-0001.jsonl` — the zero-padded name of part `part` (1–9999) with extension `ext`. */
export function exportPartName(part: number, ext: string): string {
  if (!Number.isInteger(part) || part < 1 || part > MAX_PART) {
    throw new TypeError(`exportPartName: part must be an integer 1-${MAX_PART}, got ${part}.`);
  }
  if (!isSafeExtension(ext)) throw new TypeError(`exportPartName: unsafe extension ${JSON.stringify(ext)}.`);
  return `part-${String(part).padStart(4, '0')}.${ext}`;
}

/**
 * Reduce an upstream file name (an attachment's, a conversation title) to one
 * safe path component: control characters and `/ \ : * ? " < > |` become
 * `_`, `..` runs become `_`, leading/trailing dots and spaces go, and the
 * result is capped at `maxLength` (default 120) characters keeping a short
 * extension. Nothing left (or only `_`) becomes `'file'`.
 */
export function sanitizeExportFileName(name: string, maxLength = 120): string {
  let s = String(name)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '');
  if (!s || /^_+$/.test(s)) return 'file';
  if (s.length > maxLength) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 17 ? s.slice(dot) : '';
    s = s.slice(0, maxLength - ext.length) + ext;
  }
  return s;
}

/** Validate a relative export path; returns its segments. */
function checkRelPath(relPath: string): string[] {
  const fail = () =>
    badInput(
      `Unsafe export file name ${JSON.stringify(String(relPath).slice(0, 80))}.`,
      'Use a relative, /-separated path with no empty, "." or ".." segment, backslash or control character (see sanitizeExportFileName).',
    );
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.length > MAX_REL_PATH) throw fail();
  if (relPath.includes('\\') || CONTROL.test(relPath)) throw fail();
  const segs = relPath.split('/');
  for (const seg of segs) {
    if (seg === '' || seg === '.' || seg === '..' || seg.length > MAX_SEGMENT) throw fail();
  }
  return segs;
}

const COMPRESSIBLE_EXT = /\.(?:jsonl|ndjson|json|md|markdown|txt|csv|tsv|html?|xml|ics|vcf|eml|svg|ya?ml)$/i;

function shouldCompress(name: string, contentType: string | undefined): boolean {
  return contentType ? isCompressibleType(contentType) : COMPRESSIBLE_EXT.test(name);
}

/** `YYYYMMDD-HHmmss` in UTC. */
function stamp(ms: number): string {
  const iso = new Date(ms).toISOString(); // 2026-10-20T09:08:07.000Z
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

function checkPart(part: number): number {
  if (!Number.isInteger(part) || part < 1 || part > MAX_PART) {
    throw badInput(`Export part must be an integer from 1 to ${MAX_PART}.`, 'Pass the cursor exactly as returned.');
  }
  return part;
}

function checkExportId(id: string | undefined): string {
  if (id === undefined) return randomBytes(12).toString('base64url');
  if (typeof id !== 'string' || !EXPORT_ID.test(id)) {
    throw badInput('Export id is malformed.', 'Pass the cursor exactly as returned, or start a new export without one.');
  }
  return id;
}

const toBytes = (data: Uint8Array | string): Uint8Array =>
  typeof data === 'string' ? new TextEncoder().encode(data) : data;

/**
 * Open an export (part) in the mode this install supports: **blob** when
 * `MCP_BLOB_BASE_URL` and `MCP_BLOB_SIGNING_KEY` are both set, else
 * **disk**. See the module header for both. Resume an export by passing the
 * cursor's `exportId`, the next `part`, and (disk) its `existingDir`.
 *
 * @throws {McpToolError} on a `dest` / `existingDir` outside
 *   {@link exportAllowedRoots}, a missing or non-directory `existingDir`, a
 *   malformed `exportId` or `part`, a TTL past 24h, or a malformed
 *   `MCP_BLOB_BASE_URL`.
 */
export async function openExportSink(opts: OpenExportSinkOptions): Promise<ExportSink> {
  const env = opts.env ?? process.env;
  const part = checkPart(opts.part ?? 1);
  const exportId = checkExportId(opts.exportId);
  const now = opts.now;
  const store = blobStoreFromEnv(env);
  if (store) return openBlobSink(store, exportId, part, opts, now);
  const dir = opts.existingDir !== undefined ? resumeDir(opts.existingDir, opts.envVar, env) : freshDir(opts, env, now);
  return openDiskSink(dir, exportId, part);
}

function outsideRoots(what: string, envVar: string): McpToolError {
  return badInput(
    `The ${what} is outside the directories exports may be written to.`,
    `Use a folder under ${envVar} if set, otherwise under ~/Downloads, ~/Documents or ~/Desktop.`,
  );
}

/** Real path of `p` inside `roots`, or an {@link McpToolError}. */
function within(p: string, roots: readonly string[], what: string, envVar: string): string {
  try {
    return assertPathWithinRoots(p, roots);
  } catch {
    throw outsideRoots(what, envVar);
  }
}

function freshDir(opts: OpenExportSinkOptions, env: EnvSource, now: number | undefined): string {
  const roots = exportAllowedRoots(opts.envVar, env);
  let parent: string;
  try {
    parent = resolveOutputDir(opts.dest, opts.envVar, { env, name: opts.name, allowedRoots: roots });
  } catch (err) {
    if (err instanceof McpToolError || err instanceof TypeError) throw err;
    throw outsideRoots('destination', opts.envVar);
  }
  // Operator-configured or confined above; resolve symlinks once so the
  // paths we report are the real ones.
  const realParent = assertPathWithinRoots(parent, [parent]);
  const stem = `${sanitizeExportFileName(sanitizeBaseName(opts.baseName), 80)}-${stamp(now ?? Date.now())}`;
  for (let n = 1; n <= 1000; n++) {
    const candidate = join(realParent, n === 1 ? stem : `${stem}-${n}`);
    try {
      // Non-recursive: EEXIST (including a planted symlink) means "taken".
      mkdirSync(candidate, { mode: 0o700 });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw badInput('Could not create a fresh export directory (1000 names taken).');
}

function resumeDir(existingDir: string, envVar: string, env: EnvSource): string {
  if (typeof existingDir !== 'string' || existingDir.length === 0) throw outsideRoots('export directory', envVar);
  const roots = exportAllowedRoots(envVar, env);
  const real = within(existingDir, roots, 'export directory', envVar);
  for (const root of roots) {
    if (real === within(root, [root], 'export directory', envVar)) throw outsideRoots('export directory', envVar);
  }
  let isDir = false;
  try {
    isDir = lstatSync(real).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw badInput(
      'The export directory to resume no longer exists.',
      'Start a new export without a cursor.',
    );
  }
  return real;
}

function openDiskSink(dir: string, exportId: string, part: number): ExportSink {
  const files = new Map<string, ExportFileRecord>();
  let finished = false;
  return {
    mode: 'disk',
    exportId,
    part,
    dir,
    async addFile(relPath, data, _contentType, o = {}) {
      if (finished) throw badInput('This export part is already finished.');
      const segs = checkRelPath(relPath);
      if (files.has(relPath) && !o.overwrite) throw badInput(`Export file ${relPath} was already written.`);
      const target = join(dir, ...segs);
      // Confined: the parent is checked against the export dir (through
      // symlinks) before it is created, and again by writeFileSafe.
      const parent = within(dirname(target), [dir], 'export file', 'the export');
      await mkdir(parent, { recursive: true, mode: 0o700 });
      const bytes = toBytes(data);
      const path = await writeFileSafe(target, bytes, {
        allowedRoots: [dir],
        mode: 0o600,
        ...(o.overwrite ? { overwrite: true } : {}),
      });
      const rec: ExportFileRecord = { name: relPath, path, bytes: bytes.byteLength };
      files.delete(relPath);
      files.set(relPath, rec);
      return rec;
    },
    async finish() {
      if (finished) throw badInput('This export part is already finished.');
      finished = true;
      const list = [...files.values()];
      return {
        mode: 'disk',
        exportId,
        part,
        location: dir,
        dir,
        bytes: list.reduce((n, f) => n + f.bytes, 0),
        files: list,
      };
    },
  };
}

function openBlobSink(
  store: BlobStore,
  exportId: string,
  part: number,
  opts: OpenExportSinkOptions,
  now: number | undefined,
): ExportSink {
  const key = `exp/${exportId}/${exportPartName(part, 'zip')}`;
  const signOpts = { ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}) };
  // Validate the key and TTL now, before the caller does an export's worth of work.
  store.signGetUrl(key, { ...signOpts, now: now ?? Date.now() });
  const entries = new Map<string, { bytes: Uint8Array; compress: boolean }>();
  let finished = false;
  return {
    mode: 'blob',
    exportId,
    part,
    async addFile(relPath, data, contentType, o = {}) {
      if (finished) throw badInput('This export part is already finished.');
      checkRelPath(relPath);
      if (entries.has(relPath) && !o.overwrite) throw badInput(`Export file ${relPath} was already written.`);
      const bytes = toBytes(data);
      entries.delete(relPath);
      entries.set(relPath, { bytes, compress: shouldCompress(relPath, contentType) });
      return { name: relPath, bytes: bytes.byteLength };
    },
    async finish() {
      if (finished) throw badInput('This export part is already finished.');
      finished = true;
      const at = now ?? Date.now();
      const zip = buildZip(
        [...entries].map(([name, e]) => ({ name, bytes: e.bytes, compress: e.compress })),
        new Date(at),
      );
      await store.put(key, zip, 'application/zip', {
        ...signOpts,
        now: at,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      const { url, expiresAtMs } = store.signGetUrl(key, { ...signOpts, now: at });
      const files = [...entries].map(([name, e]) => ({ name, bytes: e.bytes.byteLength }));
      return {
        mode: 'blob',
        exportId,
        part,
        location: url,
        key,
        urlExpiresAt: new Date(expiresAtMs).toISOString(),
        archiveBytes: zip.byteLength,
        bytes: files.reduce((n, f) => n + f.bytes, 0),
        files,
      };
    },
  };
}

/** Longest cursor {@link encodeExportCursor} emits or {@link decodeExportCursor} accepts, in characters. */
export const EXPORT_CURSOR_MAX_LENGTH = 16_384;

const CURSOR_VERSION = 1;

/**
 * Encode a resume cursor: base64url of the JSON of `{ v: 1, ...state }`.
 * Opaque to the model, but NOT secret or tamper-proof — whatever comes back
 * through {@link decodeExportCursor} must be re-validated (paths against the
 * roots, ids against their shapes).
 *
 * @throws {TypeError} when the encoded cursor would exceed {@link EXPORT_CURSOR_MAX_LENGTH}.
 */
export function encodeExportCursor(state: Record<string, unknown>): string {
  const out = Buffer.from(JSON.stringify({ v: CURSOR_VERSION, ...state }), 'utf8').toString('base64url');
  if (out.length > EXPORT_CURSOR_MAX_LENGTH) {
    throw new TypeError(`encodeExportCursor: cursor is ${out.length} characters (max ${EXPORT_CURSOR_MAX_LENGTH}).`);
  }
  return out;
}

/**
 * Decode a cursor from {@link encodeExportCursor}, returning the state object
 * (including `v`). Validate every field before use.
 *
 * @throws {McpToolError} on anything that is not a current-version cursor:
 *   not a string, too long, not base64url, not a JSON object, wrong `v`.
 */
export function decodeExportCursor(cursor: string): Record<string, unknown> & { v: number } {
  const bad = () =>
    badInput(
      'The export cursor is not valid.',
      'Pass the cursor exactly as the previous call returned it, or start a new export without one.',
    );
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > EXPORT_CURSOR_MAX_LENGTH) throw bad();
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw bad();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw bad();
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== CURSOR_VERSION) throw bad();
  return obj as Record<string, unknown> & { v: number };
}

/**
 * One JSONL line: `JSON.stringify(value) + '\n'`. Newlines inside strings are
 * escaped by JSON, so each record is exactly one line.
 *
 * @throws {TypeError} when `value` has no JSON form (`undefined`, a function).
 */
export function jsonlLine(value: unknown): string {
  const s = JSON.stringify(value);
  if (s === undefined) throw new TypeError('jsonlLine: value has no JSON representation.');
  return `${s}\n`;
}
