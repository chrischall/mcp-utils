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
 *   GET  signs  `<prefix>/<key>\n<exp>`
 *   PUT  signs  `put\0<prefix>/<key>\0<contentType>\0<exp>`
 *
 * HMAC-SHA256 under `MCP_BLOB_SIGNING_KEY`, base64url, and the URL is
 * `${base}/${key}?exp=<ms>&sig=<urlencoded sig>`. `prefix` is the base URL's
 * path with the leading `b/` stripped; `exp` is epoch MILLISECONDS. The PUT
 * signature commits to the content type, so a URL minted for a zip cannot
 * store anything else, and a read signature can never be replayed as a write.
 *
 * Signing is synchronous (`node:crypto`) on purpose: callers build the store
 * while constructing module-level singletons, where an `await` would put a
 * top-level await into every consumer's module graph for pure string work.
 */

import { createHmac } from 'node:crypto';
import { readEnvVar, type EnvSource } from '../config/index.js';
import { McpToolError } from '../errors/index.js';

/** Default life of a signed link: one hour. */
export const BLOB_DEFAULT_TTL_MS = 60 * 60 * 1000;

/** The longest link life the gateway accepts (24h); anything longer is refused here, not at the gateway. */
export const BLOB_MAX_TTL_MS = 24 * 60 * 60 * 1000;

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

/** A standalone ArrayBuffer holding exactly the view's bytes. */
function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.slice().buffer as ArrayBuffer;
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

  return { baseUrl: base, prefix, signGetUrl, signPutUrl, put };
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
