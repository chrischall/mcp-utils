/**
 * The mcp-host shared blob store — signed GET/PUT URLs and the PUT itself.
 *
 * A child server hosted on mcp-host is handed two environment variables:
 * `MCP_BLOB_BASE_URL` (`https://<host>/b/<registrationId>`) and its own derived
 * `MCP_BLOB_SIGNING_KEY`. A local stdio install has neither, and that absence
 * is what selects disk delivery instead (see {@link blobStoreFromEnv}).
 *
 * Consolidates the two copies that had grown in the fleet:
 *  - splitwise-mcp `src/tools/_blob.ts` — synchronous `node:crypto` HMAC,
 *    `readEnvVar` hardening, prefix recovered from the base path;
 *  - gemini-mcp `src/blob-store.ts` — the PUT over `fetch` with a
 *    `content-type` header, per-segment key encoding, and the 1h default /
 *    24h maximum link life the gateway enforces.
 * Office-outlook-mcp and microsoft-teams-mcp bulk export is the third
 * consumer, which is why it lives here rather than in a third copy.
 *
 * ## The payloads are the gateway's, byte for byte — do not "tidy" them
 *
 *   GET     signs  `<prefix>/<key>\n<exp>`
 *   PUT     signs  `put\0<prefix>/<key>\0<contentType>\0<exp>`
 *   DELETE  signs  `del\0<prefix>/<key>\0<exp>`
 *
 * HMAC-SHA256 under `MCP_BLOB_SIGNING_KEY`, base64url, and the URL is
 * `${base}/${key}?exp=<ms>&sig=<urlencoded sig>`. `prefix` is the base URL's
 * path with the leading `b/` stripped; `exp` is epoch MILLISECONDS. The PUT
 * signature commits to the content type, so a URL minted for a zip cannot
 * store anything else, and a read signature can never be replayed as a write.
 * Each verb leads with its own word (a read with none, and a `\n` where the
 * others carry NULs), so no signature verifies as another verb's — a link that
 * lets someone read an object can never be spent destroying it.
 *
 * ## Consuming an upload
 *
 * The store also carries bytes INTO a hosted server: the server mints a PUT
 * link, the caller `curl`s a file to it, and the server reads the object back
 * — no base64 in the tool call, no request-size ceiling. {@link BlobStore.consume}
 * is that read, plus the cleanup: the object is deleted once the caller's
 * handler has succeeded, so a user's photo does not sit in the bucket until
 * the retention prune. A handler that throws leaves it in place for a retry,
 * and a delete that fails AFTER the handler succeeded is reported, never
 * thrown — the handler's side effect has happened, and an error there would
 * read as "it failed", inviting a retry that duplicates it.
 *
 * Signing is synchronous (`node:crypto`) on purpose: callers build the store
 * while constructing module-level singletons, where an `await` would put a
 * top-level await into every consumer's module graph for pure string work.
 */

import { createHmac } from 'node:crypto';
import { readEnvVar, type EnvSource } from '../config/index.js';
import { McpToolError } from '../errors/index.js';
import { fetchBounded, RequestTimeoutError } from '../http/index.js';

/** Default life of a signed link: one hour. */
export const BLOB_DEFAULT_TTL_MS = 60 * 60 * 1000;

/** The longest link life the gateway accepts (24h); anything longer is refused here, not at the gateway. */
export const BLOB_MAX_TTL_MS = 24 * 60 * 60 * 1000;

/** The gateway's cap on one object (100 MiB) — and the default read cap for {@link BlobStore.get}. */
export const BLOB_MAX_OBJECT_BYTES = 100 * 1024 * 1024;

/** Longest object key accepted, in characters. */
const MAX_KEY_LENGTH = 1024;

/** One key segment: RFC 3986 unreserved characters only. */
const SAFE_SEGMENT = /^[A-Za-z0-9._~-]+$/;

/** Construction options for {@link createBlobStore}. */
export interface BlobStoreOptions {
  /** `https://<host>/b/<registrationId>` — normally `MCP_BLOB_BASE_URL`. */
  baseUrl: string;
  /** This registration's derived HMAC key — normally `MCP_BLOB_SIGNING_KEY`. */
  signingKey: string;
}

/** Per-call options for {@link BlobStore.signGetUrl} / {@link BlobStore.signPutUrl}. */
export interface BlobSignOptions {
  /** Link life in ms. Default {@link BLOB_DEFAULT_TTL_MS}; must be in (0, {@link BLOB_MAX_TTL_MS}]. */
  ttlMs?: number;
  /** "Now" in epoch ms (tests). Default `Date.now()`. */
  now?: number;
}

/** Per-call options for {@link BlobStore.put}. */
export interface BlobPutOptions extends BlobSignOptions {
  /** `fetch` implementation (tests). Default global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Cancels the upload. */
  signal?: AbortSignal;
}

/** Per-call options for {@link BlobStore.delete}. */
export interface BlobRequestOptions extends BlobSignOptions {
  /** `fetch` implementation (tests). Default global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Cancels the request. The ambient tool-call signal applies as well. */
  signal?: AbortSignal;
  /** Milliseconds until the exchange (body included) must finish. Default 30 s. */
  timeoutMs?: number;
}

/** Per-call options for {@link BlobStore.get} / {@link BlobStore.consume}. */
export interface BlobGetOptions extends BlobRequestOptions {
  /** Largest object this call will read. Default {@link BLOB_MAX_OBJECT_BYTES}. */
  maxBytes?: number;
}

/** An object read back from the store. */
export interface BlobObject {
  /** The object key, relative to this registration's space. */
  key: string;
  /** The object's bytes. */
  bytes: Uint8Array;
  /** The content type it was stored with, if the store reported one. */
  contentType?: string;
}

/**
 * What {@link BlobStore.consume} produced. `deleted: false` means the handler
 * SUCCEEDED but the object is still in the store (the retention prune will
 * reclaim it); `deleteError` says why, without the signed URL.
 */
export type BlobConsumeResult<T> =
  | { result: T; deleted: true }
  | { result: T; deleted: false; deleteError: string };

/** A signed link and the instant it stops working. */
export interface SignedBlobUrl {
  /** The full signed URL. Treat as a bearer credential for this one object until it expires. */
  url: string;
  /** Expiry, epoch ms — the `exp` the signature commits to. */
  expiresAtMs: number;
}

/** What {@link BlobStore.put} stored. */
export interface BlobPutResult {
  /** The object key, relative to this registration's space. */
  key: string;
  /** Bytes sent. */
  bytes: number;
}

/** A handle on this registration's slice of the mcp-host blob store. */
export interface BlobStore {
  /** The base URL, normalised (no trailing slash). */
  readonly baseUrl: string;
  /** The `<registrationId>` folded into every signature. */
  readonly prefix: string;
  /** Mint a signed GET URL for `key`. Throws {@link McpToolError} on a bad key or TTL. */
  signGetUrl(key: string, opts?: BlobSignOptions): SignedBlobUrl;
  /** Mint a signed PUT URL for `key`, committed to `contentType`. Throws {@link McpToolError} on bad input. */
  signPutUrl(key: string, contentType: string, opts?: BlobSignOptions): SignedBlobUrl;
  /**
   * PUT `body` (a string is sent as UTF-8) to `key` with a `content-type`
   * header. Throws {@link McpToolError} (kind `'http'`, with `status`) on a
   * non-2xx and kind `'transport'` when the request never completes; neither
   * message carries the signed URL or the key material.
   */
  put(key: string, body: Uint8Array | string, contentType: string, opts?: BlobPutOptions): Promise<BlobPutResult>;
  /** Mint a signed DELETE URL for `key`. Throws {@link McpToolError} on a bad key or TTL. */
  signDeleteUrl(key: string, opts?: BlobSignOptions): SignedBlobUrl;
  /**
   * Read `key` back, refusing more than `maxBytes`. A 404 (never stored,
   * expired out of retention, or already consumed) and any other non-2xx
   * throw {@link McpToolError} kind `'http'` with `status`; an over-cap object
   * throws `ResponseTooLargeError`; a network failure, kind `'transport'`.
   * No message carries the signed URL.
   */
  get(key: string, opts?: BlobGetOptions): Promise<BlobObject>;
  /**
   * Delete `key`. Idempotent at the gateway: an absent object is success.
   * Errors as {@link BlobStore.get}.
   */
  delete(key: string, opts?: BlobRequestOptions): Promise<void>;
  /**
   * Read `key`, pass it to `use`, and delete it once `use` resolves. If the
   * read fails `use` is never called; if `use` throws, the object is KEPT and
   * the error propagates; if the delete fails after `use` succeeded, that is
   * reported as `deleted: false` + `deleteError`, never thrown.
   */
  consume<T>(key: string, use: (object: BlobObject) => Promise<T> | T, opts?: BlobGetOptions): Promise<BlobConsumeResult<T>>;
}

function configError(reason: string): McpToolError {
  // Never echo the value: a base URL can carry userinfo, and a half-substituted
  // one is noise in a host's logs. Name the variable and the expected shape.
  return new McpToolError(`MCP_BLOB_BASE_URL is not usable: ${reason}.`, {
    hint: 'It should look like https://<host>/b/<registrationId> — check the deployment\'s environment.',
    kind: 'unknown',
  });
}

function parseBase(baseUrl: string): { base: string; prefix: string } {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw configError('not a valid URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw configError('scheme must be http(s)');
  if (parsed.username || parsed.password) throw configError('must not contain credentials');
  if (parsed.search || parsed.hash) throw configError('must not contain a query or fragment');
  const path = parsed.pathname.replace(/^\/+|\/+$/g, '');
  const prefix = path.startsWith('b/') ? path.slice(2) : path;
  if (!prefix || prefix === 'b') throw configError('has no registration path');
  return { base: `${parsed.origin}/${path}`, prefix };
}

function badInput(message: string): McpToolError {
  return new McpToolError(message, { kind: 'unknown' });
}

/** Validate `key` and return its URL-encoded path form. */
function encodeKey(key: string): string {
  if (typeof key !== 'string' || key.length === 0) throw badInput('Blob key must be a non-empty string.');
  if (key.length > MAX_KEY_LENGTH) throw badInput(`Blob key is longer than ${MAX_KEY_LENGTH} characters.`);
  const segments = key.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..' || !SAFE_SEGMENT.test(seg)) {
      throw badInput(
        'Blob key must be relative, slash-separated segments of [A-Za-z0-9._~-] with no empty, "." or ".." segment.',
      );
    }
  }
  return segments.map(encodeURIComponent).join('/');
}

function checkContentType(contentType: string): void {
  // The payload uses NUL delimiters; any control character would make the
  // signed string ambiguous or the header invalid.
  // eslint-disable-next-line no-control-regex
  if (typeof contentType !== 'string' || contentType.length === 0 || /[\x00-\x1f\x7f]/.test(contentType)) {
    throw badInput('Blob content type must be a non-empty string without control characters.');
  }
}

function expiry(opts: BlobSignOptions | undefined): number {
  const ttl = opts?.ttlMs ?? BLOB_DEFAULT_TTL_MS;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > BLOB_MAX_TTL_MS) {
    throw badInput(`Blob link TTL must be between 1 ms and ${BLOB_MAX_TTL_MS} ms (24h); the gateway refuses longer.`);
  }
  return Math.floor((opts?.now ?? Date.now()) + ttl);
}

/**
 * An ArrayBuffer holding exactly the view's bytes: the view's own buffer when
 * it spans all of it (a built zip, an encoded string — no second copy of a
 * whole archive, fleet-audit#1441), else a copy of just its range.
 */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const buf = view.buffer;
  if (buf instanceof ArrayBuffer && view.byteOffset === 0 && view.byteLength === buf.byteLength) return buf;
  // Uint8Array.prototype.slice, NOT view.slice(): on a Node Buffer the latter
  // returns a view of the shared allocation pool, whose .buffer is the whole
  // pool — unrelated process memory would be uploaded beside the bytes.
  return Uint8Array.prototype.slice.call(view).buffer as ArrayBuffer;
}

/**
 * Build a {@link BlobStore} from explicit settings. Throws {@link McpToolError}
 * when the base URL is malformed (no URL, non-http(s), userinfo, query/fragment,
 * or no registration path). Most callers want {@link blobStoreFromEnv}.
 */
export function createBlobStore(opts: BlobStoreOptions): BlobStore {
  const { base, prefix } = parseBase(opts.baseUrl);
  const signingKey = opts.signingKey;
  const sign = (payload: string) => createHmac('sha256', signingKey).update(payload).digest('base64url');
  const link = (encodedKey: string, exp: number, sig: string) =>
    `${base}/${encodedKey}?exp=${exp}&sig=${encodeURIComponent(sig)}`;

  const signGetUrl = (key: string, o?: BlobSignOptions): SignedBlobUrl => {
    const encoded = encodeKey(key);
    const exp = expiry(o);
    return { url: link(encoded, exp, sign(`${prefix}/${key}\n${exp}`)), expiresAtMs: exp };
  };

  const signPutUrl = (key: string, contentType: string, o?: BlobSignOptions): SignedBlobUrl => {
    const encoded = encodeKey(key);
    checkContentType(contentType);
    const exp = expiry(o);
    return { url: link(encoded, exp, sign(`put\0${prefix}/${key}\0${contentType}\0${exp}`)), expiresAtMs: exp };
  };

  const put = async (
    key: string,
    body: Uint8Array | string,
    contentType: string,
    o: BlobPutOptions = {},
  ): Promise<BlobPutResult> => {
    const { url } = signPutUrl(key, contentType, o);
    const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    const doFetch = o.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'PUT',
        headers: { 'content-type': contentType },
        body: toArrayBuffer(bytes),
        ...(o.signal ? { signal: o.signal } : {}),
      });
    } catch (cause) {
      if (o.signal?.aborted) throw cause;
      // The cause's text may embed the signed URL; keep it off the message.
      throw new McpToolError(`Blob store upload of ${key} did not complete (network error).`, {
        kind: 'transport',
      });
    }
    if (!res.ok) {
      throw new McpToolError(`Blob store upload of ${key} failed (HTTP ${res.status}).`, {
        kind: 'http',
        status: res.status,
      });
    }
    return { key, bytes: bytes.byteLength };
  };

  const signDeleteUrl = (key: string, o?: BlobSignOptions): SignedBlobUrl => {
    const encoded = encodeKey(key);
    const exp = expiry(o);
    return { url: link(encoded, exp, sign(`del\0${prefix}/${key}\0${exp}`)), expiresAtMs: exp };
  };

  /**
   * One signed exchange through {@link fetchBounded}: a timeout that covers the
   * body, the caller's and the ambient cancellation, and a byte cap. A failure
   * that is neither a cancellation, a timeout nor an over-cap body becomes a
   * transport error whose message cannot carry the signed URL.
   */
  const exchange = async <R extends 'bytes' | 'none'>(
    what: string,
    url: string,
    method: 'GET' | 'DELETE',
    read: R,
    o: BlobGetOptions,
  ) => {
    try {
      return await fetchBounded(url, { method, ...(o.signal ? { signal: o.signal } : {}) }, {
        read,
        service: 'the blob store',
        ...(read === 'bytes' ? { maxBytes: o.maxBytes ?? BLOB_MAX_OBJECT_BYTES } : {}),
        ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
        ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
      });
    } catch (cause) {
      if (o.signal?.aborted || cause instanceof McpToolError || cause instanceof RequestTimeoutError) throw cause;
      throw new McpToolError(`Blob store ${what} did not complete (network error).`, { kind: 'transport' });
    }
  };

  const get = async (key: string, o: BlobGetOptions = {}): Promise<BlobObject> => {
    const { url } = signGetUrl(key, o);
    const res = await exchange(`read of ${key}`, url, 'GET', 'bytes', o);
    if (!res.ok) {
      const why = res.status === 404 ? ' — not found (never uploaded, expired, or already consumed)' : '';
      throw new McpToolError(`Blob store read of ${key} failed (HTTP ${res.status})${why}.`, {
        kind: 'http',
        status: res.status,
      });
    }
    const contentType = res.headers.get('content-type') ?? undefined;
    return { key, bytes: res.body, ...(contentType !== undefined ? { contentType } : {}) };
  };

  const del = async (key: string, o: BlobRequestOptions = {}): Promise<void> => {
    const { url } = signDeleteUrl(key, o);
    const res = await exchange(`delete of ${key}`, url, 'DELETE', 'none', o);
    if (!res.ok) {
      throw new McpToolError(`Blob store delete of ${key} failed (HTTP ${res.status}).`, {
        kind: 'http',
        status: res.status,
      });
    }
  };

  const consume = async <T>(
    key: string,
    use: (object: BlobObject) => Promise<T> | T,
    o: BlobGetOptions = {},
  ): Promise<BlobConsumeResult<T>> => {
    const object = await get(key, o);
    const result = await use(object);
    try {
      await del(key, o);
      return { result, deleted: true };
    } catch (e) {
      return { result, deleted: false, deleteError: e instanceof Error ? e.message : String(e) };
    }
  };

  return { baseUrl: base, prefix, signGetUrl, signPutUrl, put, signDeleteUrl, get, delete: del, consume };
}

/**
 * The blob store this process was given, or `undefined` when either
 * `MCP_BLOB_BASE_URL` or `MCP_BLOB_SIGNING_KEY` is unset (read through the
 * hardened {@link readEnvVar}, so `''`, `'null'` and `${...}` placeholders
 * count as unset). `undefined` is the normal local-install case and must stay a
 * clean degrade to disk delivery. A set-but-malformed base URL throws
 * {@link McpToolError} rather than silently disabling uploads.
 */
export function blobStoreFromEnv(env: EnvSource = process.env): BlobStore | undefined {
  const baseUrl = readEnvVar('MCP_BLOB_BASE_URL', { env });
  const signingKey = readEnvVar('MCP_BLOB_SIGNING_KEY', { env });
  if (!baseUrl || !signingKey) return undefined;
  return createBlobStore({ baseUrl, signingKey });
}
