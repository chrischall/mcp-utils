/**
 * `http` — bearer-auth API-client kit.
 *
 * Consolidates the ~100-line `client.ts` boilerplate copy-pasted across ~8 MCP
 * servers (splitwise/tempo/ioffice/app-store-connect/zola): a bearer-auth fetch
 * wrapper with one-shot 429 retry, 401 mapping, 204 handling, and redacted error
 * formatting — plus the small URL/JWT/cookie utilities scattered across the
 * fleet (canvas Link-header parsing, IC/signupgenius cookie jars, zola JWT
 * decode).
 *
 * Security posture (design §"Bearer-token / error-message leakage"):
 *  - {@link formatApiError} runs every upstream body through the shared
 *    {@link truncateErrorMessage} (redaction THEN truncation) so bearer tokens
 *    and JWTs never reach a tool result, even when an upstream echoes the
 *    request back.
 *  - {@link createApiClient} never embeds the token in a thrown message; a 401
 *    yields a fixed "unauthorized" string, not the credential.
 */

import { truncateErrorMessage } from '../errors/index.js';

// ---------------------------------------------------------------------------
// createApiClient
// ---------------------------------------------------------------------------

/** Retry policy for transient (HTTP 429) responses. */
export interface RetryPolicy {
  /** Number of retries after the initial attempt. The fleet default is 1. */
  count: number;
  /** Delay before each retry, in milliseconds. The fleet default is 2000. */
  delayMs: number;
}

/** Options for {@link createApiClient}. */
/**
 * Minimal structural view of a reactive bearer-token source (e.g. the
 * `TokenManager` from `@chrischall/mcp-utils/session`). Kept structural so the
 * core `http` module stays decoupled from the optional `session` module.
 */
export interface ReactiveTokenSource {
  /**
   * Run `call` with a valid access token, refreshing proactively and replaying
   * once on a 401. Returns the final `Response`.
   */
  withAuth(call: (accessToken: string) => Promise<Response>): Promise<Response>;
}

export interface ApiClientOptions {
  /** Absolute base URL; request paths are appended verbatim. A trailing slash is trimmed. */
  baseUrl: string;
  /**
   * Resolve the current bearer token. Called per request so the caller can
   * refresh/rotate transparently. May be sync or async. Return `undefined`/`''`
   * to send no `Authorization` header (e.g. cookie-authenticated APIs).
   * Optional when {@link ApiClientOptions.tokenManager} is provided.
   */
  getToken?: () => string | undefined | Promise<string | undefined>;
  /**
   * A reactive token source (e.g. `TokenManager`). When set, every request is
   * routed through {@link ReactiveTokenSource.withAuth} — proactive refresh +
   * one reactive 401-replay — instead of {@link ApiClientOptions.getToken}.
   */
  tokenManager?: ReactiveTokenSource;
  /**
   * Default headers sent on every request (e.g. an API-version or client-id
   * header). A per-request `headers` entry of the same name overrides them.
   */
  baseHeaders?: Record<string, string>;
  /**
   * 429 retry policy. Defaults to `{ count: 1, delayMs: 2000 }` — the
   * fleet-wide "retry once after 2s" behavior. Set `count: 0` to disable.
   */
  retry?: RetryPolicy;
  /** Human name of the upstream service, used in error messages. Defaults to the host. */
  serviceName?: string;
  /**
   * Override the error thrown on a 401. Lets a repo surface its own documented
   * message (e.g. `TEMPO_API_TOKEN is invalid or expired`) without wrapping the
   * client in a try/catch. The factory receives no arguments — it is never
   * passed the token, preserving the no-token-in-message guarantee. Defaults to
   * {@link UnauthorizedError}.
   */
  onUnauthorized?: () => Error;
  /**
   * Override the error thrown when a 429 persists past the retry budget.
   * Defaults to {@link RateLimitedError}.
   */
  onRateLimited?: () => Error;
  /** Injectable fetch (for tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep (for tests). Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/** A request body and/or extra headers for a single call. */
export interface RequestOptions {
  /** JSON-serialized into the request body when present. */
  body?: unknown;
  /**
   * Multipart body (e.g. a file/image upload). Sent verbatim with no
   * `Content-Type` so `fetch` sets the multipart boundary itself. Takes
   * precedence over {@link body} when both are present.
   */
  formData?: FormData;
  /** Extra request headers, merged over the defaults. */
  headers?: Record<string, string>;
  /** Query params appended via {@link buildQueryString} when present. */
  query?: Record<string, unknown>;
}

/** The minimal client surface returned by {@link createApiClient}. */
export interface ApiClient {
  /**
   * Authenticated JSON request. Returns the parsed body, or `undefined` for a
   * 204 / empty body. Throws on 401 (unauthorized), exhausted-429, and other
   * non-2xx responses (with a redacted, truncated message).
   */
  fetchJson: <T = unknown>(method: string, path: string, opts?: RequestOptions) => Promise<T>;
  /** Authenticated request returning the raw response body as text (e.g. HTML scrapes). */
  fetchHtml: (method: string, path: string, opts?: RequestOptions) => Promise<string>;
}

const DEFAULT_RETRY: RetryPolicy = { count: 1, delayMs: 2000 };

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Thrown for an upstream 401. Carries the status so callers can trigger a re-auth. */
export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor(service: string) {
    super(`Unauthorized (401) from ${service} — the token is missing, invalid, or expired.`);
    this.name = 'UnauthorizedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a 429 persists after the retry budget is exhausted. */
export class RateLimitedError extends Error {
  readonly status = 429;
  constructor(service: string) {
    super(`Rate limited (429) by ${service} after retries.`);
    this.name = 'RateLimitedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * Build a bearer-auth fetch client with one-shot 429 retry, 401 mapping, 204 /
 * empty-body handling, and redacted error formatting.
 *
 * Consolidates the structurally-identical `client.ts#doRequest` across
 * splitwise/tempo/ioffice/app-store-connect/zola. The retry/401/429 behavior is
 * the hardened superset: 401 → {@link UnauthorizedError} (never echoing the
 * token), 429 → sleep(`delayMs`) and replay up to `count` times then
 * {@link RateLimitedError}, 204/empty → `undefined`, other non-2xx →
 * {@link formatApiError}.
 */
export function createApiClient(opts: ApiClientOptions): ApiClient {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const retry = opts.retry ?? DEFAULT_RETRY;
  const service = opts.serviceName ?? hostOf(opts.baseUrl);
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const unauthorized = (): Error => (opts.onUnauthorized ? opts.onUnauthorized() : new UnauthorizedError(service));
  const rateLimited = (): Error => (opts.onRateLimited ? opts.onRateLimited() : new RateLimitedError(service));

  async function send(method: string, path: string, opt: RequestOptions): Promise<Response> {
    // formData wins over a JSON body; it's sent verbatim so fetch sets the boundary.
    const isMultipart = opt.formData !== undefined;
    const hasJsonBody = !isMultipart && opt.body !== undefined;
    const reqBody: FormData | string | undefined = isMultipart ? opt.formData : hasJsonBody ? JSON.stringify(opt.body) : undefined;
    const query = opt.query ? buildQueryString(opt.query) : '';
    const url = `${base}${path}${query}`;
    const bodyInit = reqBody !== undefined ? { body: reqBody } : {};

    // One fetch with the given token; Authorization comes last from the auth
    // mechanism, then per-request headers can still override it if needed.
    const fetchWith = (token: string | undefined): Promise<Response> =>
      doFetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(hasJsonBody ? { 'Content-Type': 'application/json' } : {}),
          ...opts.baseHeaders,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...opt.headers,
        },
        ...bodyInit,
      });

    // tokenManager (reactive refresh + 401-replay) takes precedence over getToken.
    const once = opts.tokenManager
      ? (): Promise<Response> => opts.tokenManager!.withAuth(fetchWith)
      : async (): Promise<Response> => fetchWith((await opts.getToken?.()) || undefined);

    let attempt = 0;
    // attempt 0 is the initial request; up to `retry.count` further attempts on 429.
    for (;;) {
      const res = await once();

      if (res.status === 429 && attempt < retry.count) {
        attempt += 1;
        await sleep(retry.delayMs);
        continue;
      }
      return res;
    }
  }

  async function fetchJson<T>(method: string, path: string, opt: RequestOptions = {}): Promise<T> {
    const res = await send(method, path, opt);

    if (res.status === 401) throw unauthorized();
    if (res.status === 429) throw rateLimited();
    if (res.status === 204) return undefined as T;

    const text = await res.text();
    if (!res.ok) {
      throw new Error(formatApiError(res.status, method, path, text, { service }));
    }
    if (text.length === 0) return undefined as T;
    return JSON.parse(text) as T;
  }

  async function fetchHtml(method: string, path: string, opt: RequestOptions = {}): Promise<string> {
    const headers = { Accept: 'text/html,*/*', ...opt.headers };
    const res = await send(method, path, { ...opt, headers });

    if (res.status === 401) throw unauthorized();
    if (res.status === 429) throw rateLimited();

    const text = await res.text();
    if (!res.ok) {
      throw new Error(formatApiError(res.status, method, path, text, { service }));
    }
    return text;
  }

  return { fetchJson, fetchHtml };
}

// ---------------------------------------------------------------------------
// buildQueryString
// ---------------------------------------------------------------------------

/**
 * Build a URL query string from a params object, returning `''` or
 * `?k=v&k2=v2`. Skips `undefined`, `null`, and empty-string values; expands
 * arrays into repeated keys (skipping null/undefined/empty array members); and
 * percent-encodes keys and values.
 *
 * Consolidates the divergent `buildQueryString` / inline `URLSearchParams`
 * variants across compass/redfin/zillow/homes/opentable/tempo/ioffice into one
 * superset (array support + empty-string skipping + encoding).
 */
export function buildQueryString(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined || item === null || item === '') continue;
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
      }
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

// ---------------------------------------------------------------------------
// buildOptionalBody
// ---------------------------------------------------------------------------

/**
 * Build a request body from `args`, including only the `optionalFields` that are
 * actually present (not `undefined`). `null` is preserved — some APIs use it to
 * clear a field — only `undefined` (i.e. "not provided") is dropped.
 *
 * Consolidates tempo's optional-field body builder: lets a tool forward a wide
 * args object and emit a minimal PATCH/POST body.
 */
export function buildOptionalBody<T extends Record<string, unknown>, K extends keyof T>(
  args: T,
  optionalFields: readonly K[],
): Partial<Pick<T, K>> {
  const body: Partial<Pick<T, K>> = {};
  for (const field of optionalFields) {
    if (args[field] !== undefined) {
      body[field] = args[field];
    }
  }
  return body;
}

// ---------------------------------------------------------------------------
// formatApiError
// ---------------------------------------------------------------------------

/** Options for {@link formatApiError}. */
export interface FormatApiErrorOptions {
  /** Service name woven into the prefix. Defaults to `'API'`. */
  service?: string;
  /** Truncation budget for the upstream body. Defaults to the shared 500. */
  max?: number;
}

/**
 * Format a non-2xx upstream response into a single, client-safe error string:
 * `"{service} error {status} for {METHOD} {path}: {body}"`.
 *
 * SECURITY: the upstream `errorText` is run through the shared
 * {@link truncateErrorMessage} (redaction of `Bearer <token>` / JWTs FIRST,
 * then truncation) so a raw body that echoes the request — or an upstream that
 * leaks a token — never reaches the caller. The method is upper-cased; an
 * empty/whitespace body is dropped entirely rather than printing a dangling
 * colon.
 */
export function formatApiError(
  status: number,
  method: string,
  path: string,
  errorText: string,
  opts: FormatApiErrorOptions = {},
): string {
  const service = opts.service ?? 'API';
  const head = `${service} error ${status} for ${method.toUpperCase()} ${path}`;
  const safe = truncateErrorMessage(errorText ?? '', opts.max).trim();
  return safe.length > 0 ? `${head}: ${safe}` : head;
}

// ---------------------------------------------------------------------------
// parseLinkHeader
// ---------------------------------------------------------------------------

/** The RFC 5988 rels callers care about for pagination. */
export interface ParsedLinkHeader {
  next?: string;
  prev?: string;
  first?: string;
  last?: string;
  /** Any other rels present, keyed by rel name. */
  [rel: string]: string | undefined;
}

/**
 * Parse an RFC 5988 `Link` header into a `{ rel: url }` map. Malformed entries
 * are skipped; `rel="next"` and bare `rel=next` are both accepted. A missing or
 * empty header yields `{}`.
 *
 * Consolidates canvas's pagination Link parser.
 */
export function parseLinkHeader(header: string | null | undefined): ParsedLinkHeader {
  const out: ParsedLinkHeader = {};
  if (!header) return out;
  for (const part of header.split(',')) {
    const m = part.trim().match(/^<([^>]+)>\s*;\s*rel="?([^";]+)"?/);
    if (m && m[1] && m[2]) out[m[2].trim()] = m[1];
  }
  return out;
}

// ---------------------------------------------------------------------------
// parseCookieJar
// ---------------------------------------------------------------------------

/** A parsed Set-Cookie jar: deduplicated name→value plus a ready `Cookie` header. */
export interface CookieJar {
  /** Surviving cookies, name → value (last value wins, deletions removed). */
  cookies: Record<string, string>;
  /** Pre-joined `name=value; name2=value2` string for the `Cookie` request header. */
  cookieHeader: string;
}

const MAX_AGE_ZERO_RE = /(?:^|;)\s*Max-Age\s*=\s*0\s*(?:;|$)/i;
const EXPIRES_EPOCH_RE = /(?:^|;)\s*Expires\s*=\s*Thu,\s*01\s*Jan\s*1970/i;

/**
 * Parse `Set-Cookie` headers into a deduplicated {@link CookieJar}.
 *
 * Login responses commonly send deletion markers (`Max-Age=0` or an epoch
 * `Expires`) alongside real cookies; forwarding both the delete and set form of
 * a name makes some upstreams (e.g. IC) reject the request. This parser:
 *  - drops deletion markers (`Max-Age=0`, epoch `Expires`),
 *  - drops empty-value cookies (clearing instructions),
 *  - deduplicates by name with **last value wins**, preserving order.
 *
 * Accepts the array from `Headers.getSetCookie()` (or a single joined string —
 * which it splits defensively, though `getSetCookie()` is strongly preferred
 * since commas inside `Expires` make string-splitting lossy).
 *
 * Consolidates the IC/signupgenius cookie-jar logic.
 */
export function parseCookieJar(setCookieHeaders: string[] | string | null | undefined): CookieJar {
  const entries =
    setCookieHeaders == null
      ? []
      : Array.isArray(setCookieHeaders)
        ? setCookieHeaders
        : splitSetCookie(setCookieHeaders);

  const jar = new Map<string, string>();
  for (const entry of entries) {
    if (MAX_AGE_ZERO_RE.test(entry) || EXPIRES_EPOCH_RE.test(entry)) continue;
    const nameValue = (entry.split(';')[0] ?? '').trim();
    const eqIdx = nameValue.indexOf('=');
    if (eqIdx < 1) continue;
    const name = nameValue.slice(0, eqIdx).trim();
    const value = nameValue.slice(eqIdx + 1).trim();
    if (!value) continue;
    jar.set(name, value);
  }

  const cookies: Record<string, string> = {};
  for (const [k, v] of jar) cookies[k] = v;
  const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  return { cookies, cookieHeader };
}

/** Best-effort split of a single joined `set-cookie` string (no `getSetCookie()`). */
function splitSetCookie(header: string): string[] {
  // Split on commas that are NOT part of an Expires date ("Thu, 01 Jan ...").
  return header
    .split(/,(?=\s*[^;,\s]+\s*=)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

/** Decode the base64url JWT payload to an object, or `null` if it can't be parsed. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    const payload = JSON.parse(json) as unknown;
    if (payload === null || typeof payload !== 'object') return null;
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Decode a JWT's `exp` claim (seconds since epoch). Throws when the structure is
 * invalid or `exp` is missing/non-numeric — the strict variant zola uses for the
 * token it depends on. For a lenient probe, use {@link validateJwtExpiry}.
 */
export function decodeJwtExp(token: string): number {
  const payload = decodeJwtPayload(token);
  if (!payload) {
    throw new Error('Invalid JWT: could not decode payload (expected a 3-part base64url token)');
  }
  const exp = payload['exp'];
  if (typeof exp !== 'number') {
    throw new Error('Invalid JWT: missing numeric "exp" claim');
  }
  return exp;
}

/**
 * Best-effort extraction of a session id from a JWT payload, checking
 * `session_id` then `sid`. Returns `null` for an undecodable token or absent
 * claim (never throws) — the lenient variant zola uses for the WAF session
 * header.
 */
export function decodeJwtSessionId(token: string): string | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const sid = payload['session_id'] ?? payload['sid'];
  return typeof sid === 'string' ? sid : null;
}

/** Result of {@link validateJwtExpiry}. */
export interface JwtExpiryStatus {
  /** True when the token is past its `exp` (or undecodable / lacks `exp`). */
  expired: boolean;
  /** Seconds until expiry (negative once expired); omitted when undecodable. */
  expiresIn?: number;
  /** Human-readable caution when the token is expired or near expiry. */
  warning?: string;
}

/** Tokens within this many seconds of `exp` are flagged as near-expiry. */
const NEAR_EXPIRY_SKEW_SEC = 300;

/**
 * Non-throwing expiry probe for a bearer JWT. Returns `{ expired, expiresIn?,
 * warning? }`. An undecodable token (or one lacking a numeric `exp`) is treated
 * as `expired: true` with a warning — failing closed so a malformed token forces
 * a refresh rather than being sent and bouncing as a 401.
 *
 * Near-expiry (within {@link NEAR_EXPIRY_SKEW_SEC}) yields a warning while still
 * reporting `expired: false`, so callers can refresh proactively.
 */
export function validateJwtExpiry(token: string, nowMs: number = Date.now()): JwtExpiryStatus {
  const payload = decodeJwtPayload(token);
  const exp = payload?.['exp'];
  if (typeof exp !== 'number') {
    return { expired: true, warning: 'Token could not be decoded or has no expiry; treat as expired.' };
  }
  const nowSec = Math.floor(nowMs / 1000);
  const expiresIn = exp - nowSec;
  if (expiresIn <= 0) {
    return { expired: true, expiresIn, warning: 'Token has expired; refresh before use.' };
  }
  if (expiresIn <= NEAR_EXPIRY_SKEW_SEC) {
    return {
      expired: false,
      expiresIn,
      warning: `Token expires in ${expiresIn}s; refresh soon.`,
    };
  }
  return { expired: false, expiresIn };
}
