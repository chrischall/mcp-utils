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

import { responseHeader } from '../internal/headers.js';
import { currentCallSignal, withAmbientCancellation } from '../cancel/index.js';
import { truncateErrorMessage } from '../errors/index.js';
import { isCloudflareChallenge } from '../scrape/index.js';

export * from './throttle.js';
export * from './response-cache.js';
export * from './net-atoms.js';
export * from './fetch-bounded.js';

import { parseRetryAfterMs } from './net-atoms.js';
import { retryAfterToMs } from '../internal/retry-after.js';

// ---------------------------------------------------------------------------
// createApiClient
// ---------------------------------------------------------------------------

/** Retry policy for transient responses (HTTP 429 by default). */
export interface RetryPolicy {
  /** Number of retries after the initial attempt. The fleet default is 1. */
  count: number;
  /** Delay before each retry, in milliseconds. The fleet default is 2000. */
  delayMs: number;
  /**
   * Statuses that trigger a retry. Defaults to `[429]` — the historical
   * fleet-wide behavior. Add transient 5xx codes (e.g. `[429, 500, 502, 503,
   * 504]`) for upstreams that flake; an exhausted non-429 retried status
   * surfaces through the normal non-2xx path (an {@link ApiError}).
   */
  statuses?: number[];
  /**
   * Honor the response's `Retry-After` header for the retry delay (bounded by
   * {@link maxRetryAfterMs}), falling back to {@link delayMs} when the header
   * is absent or unparseable. Off by default — the historical fixed-delay
   * behavior. Consolidates the hand-rolled Retry-After handling in
   * getyourguide / musicbrainz / viator / tripadvisor.
   */
  honorRetryAfter?: boolean;
  /**
   * Cap on an honored `Retry-After` delay, in ms. Defaults to 30 000 — an
   * upstream demanding a 10-minute wait shouldn't pin a tool call open.
   */
  maxRetryAfterMs?: number;
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
  /**
   * Absolute base URL; request paths are appended verbatim. A trailing slash is trimmed.
   * A path whose result lands on a different origin (e.g. `@other.host/x`,
   * `.other.host`, `:8443/x`) is refused before any credential is attached.
   */
  baseUrl: string;
  /**
   * Resolve the current bearer token. Called per request so the caller can
   * refresh/rotate transparently. May be sync or async. Return `undefined`/`''`
   * to send no `Authorization` header (e.g. cookie-authenticated APIs).
   * Optional when {@link ApiClientOptions.tokenManager} is provided.
   */
  getToken?: () => string | undefined | Promise<string | undefined>;
  /**
   * Send the token in this named request header instead of
   * `Authorization: Bearer <token>`. The raw token is sent verbatim — no
   * `Bearer ` prefix (e.g. `tokenHeader: 'x-goog-api-key'` /
   * `'x-auth-token'` / `'x-api-key'`). Unset keeps the default
   * `Authorization: Bearer` behavior. Applies to both
   * {@link ApiClientOptions.getToken} and
   * {@link ApiClientOptions.tokenManager} tokens.
   */
  tokenHeader?: string;
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
   * {@link UnauthorizedError}. Not called for a 401 that is a CDN/WAF refusal
   * page: that throws {@link EdgeBlockedError}, since no credential was judged.
   */
  onUnauthorized?: () => Error;
  /**
   * Override the error thrown when a 429 persists past the retry budget.
   * Defaults to {@link RateLimitedError}. Receives a {@link RateLimitContext}
   * describing that final 429 — its parsed `Retry-After` and whether a CDN/WAF
   * page answered it — read before the body is discarded, so a consumer no
   * longer has to capture the response at the `fetchImpl` seam (musicbrainz,
   * viator). A zero-argument hook still works.
   */
  onRateLimited?: (ctx: RateLimitContext) => Error;
  /** Injectable fetch (for tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep (for tests). Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Per-attempt request timeout in milliseconds. When set (> 0), each fetch is
   * bounded by an {@link AbortController} — from the request until its body
   * has been read, so a body that stalls after the headers is bounded too; on
   * expiry it throws a {@link RequestTimeoutError} instead of hanging until the
   * host kills the tool call. A 429 retry gets a fresh timeout.
   *
   * Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS} (30 s), matching
   * `createGraphqlClient`. Before 2.16 the default was unbounded, and the
   * clients that never passed one (gemini, simplisafe, tripadvisor's web
   * client — fleet audit 2026-09, cluster 1) held a tool call open on a hung
   * upstream until the host killed it. Pass `0` or `false` to disable — the
   * caller's cancellation still applies either way. A download that
   * legitimately takes longer passes a larger value.
   */
  timeout?: number | false;
}

/**
 * What {@link ApiClientOptions.onRateLimited} is told about the 429 that
 * exhausted the retry budget (the LAST response, not the first).
 */
export interface RateLimitContext {
  /** The response status (429). */
  status: number;
  /** The raw `Retry-After` header, or `null` when absent. */
  retryAfter: string | null;
  /**
   * The wait `Retry-After` asks for, in ms: delta-seconds or an HTTP-date
   * (clamped at 0 once past). Uncapped — `maxRetryAfterMs` bounds the client's
   * own sleep, not this report. `undefined` when absent or unparseable.
   */
  retryAfterMs: number | undefined;
  /**
   * The CDN/WAF that answered, per {@link detectEdgeBlock}, or `null`. A 429
   * can be an edge refusal page rather than the API's rate limit; return an
   * {@link EdgeBlockedError} for it to say so. A JSON body is the API's own
   * answer and is not read (`cf-mitigated` is still honoured); any other body
   * is read under the request timeout, and an unreadable one is no evidence.
   */
  edgeBlock: { vendor: string } | null;
  /** The request method, as passed. */
  method: string;
  /** The request path, as passed. */
  path: string;
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
  /**
   * Form-encoded body, sent as `application/x-www-form-urlencoded;charset=UTF-8`
   * (the same type `fetch` gives a bare `URLSearchParams`). A plain record is
   * encoded with `URLSearchParams`, skipping `undefined` values. Consolidates
   * resy's local `URLSearchParams` branch (its login, favourite, notify and
   * booking writes are all form posts).
   */
  form?: URLSearchParams | Record<string, string | number | boolean | undefined>;
  /**
   * A string body sent verbatim — for upstreams whose writes are neither JSON
   * nor a form, e.g. MusicBrainz's `application/xml` submissions. Its
   * `Content-Type` is {@link contentType}, defaulting to
   * `text/plain; charset=utf-8`. An empty string is still a body.
   */
  rawBody?: string;
  /**
   * The `Content-Type` of {@link rawBody}. Only valid alongside `rawBody` —
   * the other body kinds set their own (a per-request `headers` entry still
   * overrides any of them).
   */
  contentType?: string;
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
  /**
   * Authenticated request returning the raw bytes plus status/headers — the
   * binary path `fetchJson` can't express (gzip reports, PNG maps, file
   * downloads). Same 401/429/non-2xx mapping as `fetchJson`; the error body of
   * a failure is decoded as text and redacted. Consolidates the hand-rolled
   * `requestRaw` / `write()` / `requestBinary` / `requestMobileBinary` in
   * app-store-connect / flightaware / ofw / zola.
   */
  fetchRaw: (method: string, path: string, opts?: RequestOptions) => Promise<RawApiResponse>;
}

/** Result of {@link ApiClient.fetchRaw}. */
export interface RawApiResponse {
  /** The 2xx status of the response. */
  status: number;
  /** The `Content-Type` header, when present. */
  contentType: string | null;
  /** The full response headers (e.g. for `Content-Disposition` / `Location`). */
  headers: Headers;
  /** The response body bytes. */
  bytes: Uint8Array;
}

const DEFAULT_RETRY: RetryPolicy = { count: 1, delayMs: 2000 };

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * The per-attempt timeout {@link createApiClient} (and {@link fetchBounded})
 * apply when the caller names none: 30 s, the same budget
 * `createGraphqlClient` has always used, so every fleet transport bounds a
 * hung upstream the same way.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Thrown for an upstream 401. Carries the status so callers can trigger a re-auth. */
export class UnauthorizedError extends Error {
  readonly status = 401;
  constructor(service: string) {
    super(`Unauthorized (401) from ${service} — the token is missing, invalid, or expired.`);
    this.name = 'UnauthorizedError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a 429 persists after the retry budget is exhausted.
 * `retryAfterMs` is the final response's `Retry-After` as a wait in ms (see
 * {@link RateLimitContext.retryAfterMs}), when it sent a parseable one.
 */
export class RateLimitedError extends Error {
  readonly status = 429;
  readonly retryAfterMs: number | undefined;
  constructor(service: string, retryAfterMs?: number) {
    super(`Rate limited (429) by ${service} after retries.`);
    this.name = 'RateLimitedError';
    this.retryAfterMs = retryAfterMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a request exceeds {@link ApiClientOptions.timeout}. */
export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(service: string, timeoutMs: number) {
    super(`Request to ${service} timed out after ${timeoutMs}ms.`);
    this.name = 'RequestTimeoutError';
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by {@link ApiClient.fetchJson} / {@link ApiClient.fetchHtml} for a
 * non-2xx response that isn't a 401/429 (those map to
 * {@link UnauthorizedError} / {@link RateLimitedError}). The message is exactly
 * the redacted, truncated {@link formatApiError} string the client has always
 * thrown — this class only adds the `status` so callers can branch
 * (`err instanceof ApiError && err.status === 404`) instead of regexing the
 * message.
 */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * A status-carrying HTTP error consumers can `throw new` directly — the
 * directly-constructible parallel to {@link ApiError} (which is only thrown
 * *inside* {@link createApiClient}). Extends {@link ApiError} so the same
 * `err instanceof ApiError && err.status === 404` branch works for both, while
 * its own name/`instanceof UpstreamHttpError` distinguishes the manual throws.
 *
 * Consolidates opentable's local `HttpError` and musescore's
 * `MusescoreHttpError` — structural twins (status-carrying, thrown from a
 * transport/bridge code path that doesn't go through `createApiClient`, used to
 * branch on a 404 fallback). Repos that DO route through `createApiClient`
 * already get {@link ApiError} for free and don't need this.
 */
export class UpstreamHttpError extends ApiError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = 'UpstreamHttpError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The request was refused by a CDN or WAF IN FRONT of the API — a CloudFront
 * "request could not be satisfied" page, a Cloudflare block or challenge, an
 * Akamai or Imperva denial — so it never reached the origin and the credential
 * was never evaluated (chrischall/mcp-host#1015).
 *
 * It extends {@link ApiError} and keeps the real status, so every existing
 * `err instanceof ApiError && err.status === 403` branch behaves exactly as
 * before; what it adds is the vendor and a message that does not send someone
 * to re-sign in. The page itself is left out of the message: it is HTML noise,
 * and {@link detectEdgeBlock} has already said what it was.
 */
export class EdgeBlockedError extends ApiError {
  /** Which edge refused the request, e.g. `'CloudFront'` or `'Cloudflare'`. */
  readonly vendor: string;
  /**
   * @param where The service the request was for, and — when the thrower knows
   *   it — the method and path, which the message names.
   */
  constructor(status: number, vendor: string, where: { service: string; method?: string; path?: string }) {
    const request =
      where.method !== undefined && where.path !== undefined
        ? ` (${where.method.toUpperCase()} ${where.path})`
        : '';
    super(
      status,
      `Request to ${where.service}${request} was blocked at its CDN/WAF (${vendor}) before reaching the API ` +
        `(HTTP ${status}); the credential was not evaluated. This is usually a block on this host's IP address or request ` +
        `fingerprint, not a bad token — re-signing in will not fix it.`,
    );
    this.name = 'EdgeBlockedError';
    this.vendor = vendor;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** The headers {@link detectEdgeBlock} reads: a `Headers` or a plain record. */
export type EdgeBlockHeaders = Headers | Record<string, string | undefined>;

function headerOf(headers: EdgeBlockHeaders | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, string | undefined>)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** How much of a body {@link detectEdgeBlock} reads; see the comment there. */
const EDGE_BLOCK_SCAN_MAX = 8 * 1024;

/**
 * Each vendor's DEFINITIVE marker — a string only that edge's own refusal page
 * carries. Ordered as checked.
 *
 * `anyStatus: false` markers count only on a 4xx (or when no status is known):
 * CloudFront shows the same "request could not be satisfied" page on its 502
 * and 504, and Cloudflare its `cf-error-details` on 52x — and those say the
 * ORIGIN is down, which the `http` diagnosis already describes, not that this
 * host is blocked. A challenge is a block at whatever status it arrives with.
 *
 * Deliberately absent:
 *
 *  - `x-cache: Error from cloudfront` and `via: … (CloudFront)`: CloudFront
 *    stamps those on EVERY error it relays, the origin's own 401 included, so
 *    they would turn a genuinely rejected credential into a "CDN block".
 *  - a bare `Access Denied` or `403 Forbidden` title: origins serve those too.
 *  - "an HTML body on an API endpoint": a sign-in page is exactly that, and it
 *    is the `session_expired` case, not this one.
 *
 * The CloudFront rule must hold on the page's TITLE alone, because
 * `formatApiError` cuts a body at 500 characters and the page's
 * `Generated by cloudfront` footer is past the cut.
 */
const EDGE_BLOCK_MARKERS: ReadonlyArray<{ vendor: string; anyStatus: boolean; test: (body: string) => boolean }> = [
  {
    vendor: 'Cloudflare',
    anyStatus: true,
    test: (b) => isCloudflareChallenge(b),
  },
  {
    vendor: 'CloudFront',
    anyStatus: false,
    test: (b) => /ERROR:\s*The request could not be satisfied/i.test(b) || /Generated by cloudfront \(CloudFront\)/i.test(b),
  },
  {
    vendor: 'Cloudflare',
    anyStatus: false,
    test: (b) =>
      /<title[^>]{0,40}>\s*Attention Required! \| Cloudflare/i.test(b) || /id=["']cf-error-details["']/i.test(b),
  },
  { vendor: 'Akamai', anyStatus: false, test: (b) => /errors(?:\.|&#46;)edgesuite(?:\.|&#46;)net/i.test(b) },
  {
    vendor: 'Imperva',
    anyStatus: false,
    test: (b) => /Incapsula incident ID/i.test(b) || /_Incapsula_Resource/.test(b),
  },
];

/**
 * Was this response refused by a CDN/WAF in front of the API rather than by
 * the API itself? Returns the vendor, or `null` when nothing definitive says
 * so — a `null` is "not shown to be an edge block", never "the origin
 * answered". Reads `cf-mitigated` from the headers (Cloudflare sets it only on
 * a response it mitigated) and each vendor's own page markers from the body,
 * which may be a truncated excerpt such as an error message.
 *
 * Used by {@link createApiClient} to throw {@link EdgeBlockedError}, and by the
 * credential healthcheck so a block is not reported as a rejected credential.
 */
export function detectEdgeBlock(input: {
  body?: string;
  headers?: EdgeBlockHeaders;
  /** The response status, when known. A 5xx admits only challenge markers. */
  status?: number;
}): { vendor: string } | null {
  if (headerOf(input.headers, 'cf-mitigated') !== undefined) return { vendor: 'Cloudflare' };
  // Only the head of the body is read. A refusal page is a few KB with its
  // marker near the top, while this runs on EVERY non-2xx body a client sees,
  // and `isCloudflareChallenge`'s `<title[^>]*>` is quadratic over a body of
  // repeated `<title` — the one-response DoS the redaction chain guards against.
  const body = input.body?.slice(0, EDGE_BLOCK_SCAN_MAX);
  if (!body) return null;
  const refusal = input.status === undefined || (input.status >= 400 && input.status < 500);
  for (const marker of EDGE_BLOCK_MARKERS) {
    if ((marker.anyStatus || refusal) && marker.test(body)) return { vendor: marker.vendor };
  }
  return null;
}

/**
 * The error a non-2xx response becomes: {@link EdgeBlockedError} when an edge
 * refused it, otherwise the {@link ApiError} the client has always thrown.
 */
function httpError(res: Response, text: string, method: string, path: string, service: string): ApiError {
  const edge = detectEdgeBlock({ body: text, headers: res.headers, status: res.status });
  if (edge) return new EdgeBlockedError(res.status, edge.vendor, { service, method, path });
  return new ApiError(res.status, formatApiError(res.status, method, path, text, { service }));
}

/**
 * Turn a request's body options into the bytes sent and their default
 * `Content-Type`. `formData` beside a JSON `body` keeps its historical
 * precedence (multipart wins, no `Content-Type` so `fetch` sets the boundary);
 * the newer kinds — `form`, `rawBody` — refuse to share a request with any
 * other body, since silently dropping one half of a write is never what the
 * caller meant. Strings, not streams, so a retry replays the same body.
 */
function encodeBody(opt: RequestOptions): { body: FormData | string | undefined; contentType: string | undefined } {
  const hasForm = opt.form !== undefined;
  const hasRaw = opt.rawBody !== undefined;
  if (hasForm || hasRaw) {
    const kinds = [hasForm, hasRaw, opt.formData !== undefined, opt.body !== undefined].filter(Boolean).length;
    if (kinds > 1) {
      throw new TypeError('createApiClient: pass only one of `body`, `form`, `rawBody` or `formData` per request.');
    }
  }
  if (opt.contentType !== undefined && !hasRaw) {
    throw new TypeError('createApiClient: `contentType` applies only to `rawBody`; set a `Content-Type` header instead.');
  }
  if (opt.formData !== undefined) return { body: opt.formData, contentType: undefined };
  if (hasRaw) return { body: opt.rawBody, contentType: opt.contentType ?? 'text/plain; charset=utf-8' };
  if (hasForm) {
    const form = opt.form instanceof URLSearchParams ? opt.form : new URLSearchParams();
    if (!(opt.form instanceof URLSearchParams)) {
      for (const [k, v] of Object.entries(opt.form ?? {})) if (v !== undefined) form.append(k, String(v));
    }
    return { body: form.toString(), contentType: 'application/x-www-form-urlencoded;charset=UTF-8' };
  }
  if (opt.body !== undefined) return { body: JSON.stringify(opt.body), contentType: 'application/json' };
  return { body: undefined, contentType: undefined };
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
 * token) unless the 401 is a CDN/WAF refusal page, which is an
 * {@link EdgeBlockedError} like any other blocked status, 429 → sleep(`delayMs`) and replay up to `count` times then
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
  const retryStatuses = retry.statuses ?? [429];
  const timeoutMs = opts.timeout === false ? 0 : (opts.timeout ?? DEFAULT_REQUEST_TIMEOUT_MS);

  // Default: `Authorization: Bearer <token>`. With `tokenHeader`, the raw
  // token goes in that named header instead (no `Bearer ` prefix).
  const authHeader = (token: string | undefined): Record<string, string> =>
    !token ? {} : opts.tokenHeader ? { [opts.tokenHeader]: token } : { Authorization: `Bearer ${token}` };

  /**
   * One in-flight attempt. The timeout does NOT stop at the headers: `fetch`
   * resolves as soon as they arrive, and a body that then stalls would hold
   * the tool call open past `timeout` — the thing the option exists to
   * prevent. So the timer stays armed until the caller has read the body
   * ({@link readBody}) and calls `done()`.
   */
  interface Attempt {
    res: Response;
    /** Disarm the timer. Idempotent. */
    done: () => void;
    /** Rejects with RequestTimeoutError if the timer fires; never resolves. */
    expired: Promise<never> | undefined;
  }

  // Bound `run` with an AbortController when a timeout is configured, mapping the
  // abort to a RequestTimeoutError. No timeout → no timer (the caller's
  // cancellation still applies).
  async function withTimeout(run: (signal?: AbortSignal) => Promise<Response>): Promise<Attempt> {
    // THE CALLER'S CANCELLATION, folded in wherever it exists
    // (`cancel/index.ts`): a request the caller has given up on is the one
    // piece of work it is always safe to stop, and until this the only
    // thing that could abort a fetch here was our own timeout — so a
    // cancelled tool call held its upstream request open for the full
    // budget while the child burned metered CPU for nobody.
    //
    // NO TIMEOUT is no longer "no signal": a service configured without one
    // still honours the caller, which is the case where it matters most,
    // since nothing else was ever going to stop that request.
    if (timeoutMs <= 0) {
      const res = await run(withAmbientCancellation(undefined));
      return { res, done: () => {}, expired: undefined };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await run(withAmbientCancellation(controller.signal));
    } catch (err) {
      clearTimeout(timer);
      // Told apart by WHICH signal fired, not by the error: an abort is an
      // `AbortError` whichever end caused it, so asking the controller is
      // the only way to avoid reporting a caller's cancellation as this
      // service timing out — a diagnosis that sends somebody to raise a
      // timeout that was never reached.
      if (err instanceof Error && err.name === 'AbortError' && controller.signal.aborted) {
        throw new RequestTimeoutError(service, timeoutMs);
      }
      throw err;
    }
    const expired = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new RequestTimeoutError(service, timeoutMs)), {
        once: true,
      });
    });
    // Only observed if a body read is racing it; never an unhandled rejection.
    expired.catch(() => {});
    return { res, done: () => clearTimeout(timer), expired };
  }

  /**
   * Abandon `attempt` without reading its body: disarm the timer AND cancel
   * the body stream. Under undici a Response whose body is neither read nor
   * cancelled keeps its connection reserved until GC, so a burst of 429s —
   * exactly when retry runs — would pin one socket per discarded attempt
   * against the upstream's per-host limit for the whole tool call (fleet
   * audit #1056). Never throws: a custom `fetchImpl` may hand back a body
   * that is null, already consumed, or lacks `cancel()`.
   */
  function discard(attempt: Attempt): void {
    attempt.done();
    try {
      const body = attempt.res.body as { cancel?: () => Promise<void> } | null | undefined;
      body?.cancel?.()?.catch(() => {});
    } catch {
      // A body that refuses cancellation has nothing left to release.
    }
  }

  /**
   * Read the body of `attempt` under its timeout, then disarm the timer.
   * Races the read against the timer rather than trusting the stream to
   * honour the abort signal, so a custom `fetchImpl` whose body ignores the
   * signal is bounded too.
   */
  async function readBody<T>(attempt: Attempt, read: (res: Response) => Promise<T>): Promise<T> {
    try {
      if (!attempt.expired) return await read(attempt.res);
      return await Promise.race([read(attempt.res), attempt.expired]);
    } catch (err) {
      if (err instanceof RequestTimeoutError) {
        attempt.res.body?.cancel().catch(() => {});
      }
      throw err;
    } finally {
      attempt.done();
    }
  }

  // The base's own origin and userinfo. A baseUrl may legitimately carry
  // userinfo (`https://u:pw@host`); a resolved URL must then carry exactly
  // that userinfo, never a different or newly-introduced one.
  const baseParts = ((): { origin: string; username: string; password: string } | undefined => {
    try {
      const u = new URL(base);
      return { origin: u.origin, username: u.username, password: u.password };
    } catch {
      return undefined;
    }
  })();
  const baseOrigin = baseParts?.origin;

  /**
   * Refuse a `path` that would carry the credential off the base origin.
   * The URL is built by concatenation, so a path such as `@other.host/x`
   * turns the base host into userinfo and `fetch` would send the
   * Authorization header to `other.host`. Userinfo is allowed only when it
   * exactly matches the base's own (none, for a base without any), so a path
   * can neither introduce nor change it. Checked before any token is minted.
   */
  function resolveUrl(path: string, query: string): string {
    const url = `${base}${path}${query}`;
    if (baseOrigin === undefined) return url; // unparseable base: nothing to compare against
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Refusing request to ${service}: path ${JSON.stringify(path)} does not form a valid URL.`);
    }
    if (
      parsed.origin !== baseOrigin ||
      parsed.username !== baseParts?.username ||
      parsed.password !== baseParts?.password
    ) {
      throw new Error(
        `Refusing request to ${service}: path ${JSON.stringify(path)} resolves outside the base origin ${baseOrigin}. ` +
          'Paths must be relative to baseUrl (start them with "/").',
      );
    }
    return url;
  }

  async function send(method: string, path: string, opt: RequestOptions): Promise<Attempt> {
    const { body: reqBody, contentType } = encodeBody(opt);
    const query = opt.query ? buildQueryString(opt.query) : '';
    const url = resolveUrl(path, query);
    const bodyInit = reqBody !== undefined ? { body: reqBody } : {};

    // One fetch with the given token; Authorization comes last from the auth
    // mechanism, then per-request headers can still override it if needed.
    const fetchWith = (token: string | undefined, signal?: AbortSignal): Promise<Response> =>
      doFetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          ...(contentType !== undefined ? { 'Content-Type': contentType } : {}),
          ...opts.baseHeaders,
          ...authHeader(token || undefined),
          ...opt.headers,
        },
        ...(signal ? { signal } : {}),
        ...bodyInit,
      });

    // tokenManager (reactive refresh + 401-replay) takes precedence over getToken.
    // Each attempt is wrapped by withTimeout, so the abort signal reaches fetch
    // through whichever auth path is in play.
    const once = (): Promise<Attempt> =>
      withTimeout((signal) =>
        opts.tokenManager
          ? opts.tokenManager.withAuth((token) => fetchWith(token, signal))
          : (async () => fetchWith((await opts.getToken?.()) || undefined, signal))(),
      );

    let attempt = 0;
    // attempt 0 is the initial request; up to `retry.count` further attempts on 429.
    for (;;) {
      const current = await once();
      const res = current.res;

      if (retryStatuses.includes(res.status) && attempt < retry.count) {
        discard(current);
        attempt += 1;
        const delay = retry.honorRetryAfter
          ? parseRetryAfterMs(responseHeader(res, 'retry-after'), {
              defaultMs: retry.delayMs,
              capMs: retry.maxRetryAfterMs ?? 30_000,
            })
          : retry.delayMs;
        await sleep(delay);
        continue;
      }
      return current;
    }
  }

  /**
   * The error a 401 becomes. Usually {@link UnauthorizedError} (or the
   * consumer's `onUnauthorized`), exactly as before — but CloudFront, Akamai
   * and Imperva sometimes refuse at the edge WITH a 401, and calling that a
   * bad token sends somebody to re-sign in with a credential nothing ever
   * looked at. So the refusal is checked for first, by the same
   * {@link detectEdgeBlock} rule every other status gets.
   *
   * A JSON 401 is the API's own answer, so its body is not read at all (no
   * refusal page is JSON); `cf-mitigated` is still honoured from the headers.
   * Any other body is read under the request's timeout, and a body that cannot
   * be read is treated as no evidence of a block. The body is only scanned,
   * never echoed, so the token cannot leak through it.
   */
  async function unauthorizedOrEdge(attempt: Attempt, method: string, path: string): Promise<Error> {
    const res = attempt.res;
    let text = '';
    if (/json/i.test(responseHeader(res, 'content-type') ?? '')) {
      discard(attempt);
    } else {
      text = await readBody(attempt, (r) => r.text()).catch(() => '');
    }
    const edge = detectEdgeBlock({ body: text, headers: res.headers, status: res.status });
    if (edge) return new EdgeBlockedError(res.status, edge.vendor, { service, method, path });
    return unauthorized();
  }

  /**
   * The error an exhausted 429 becomes. Without a hook: a
   * {@link RateLimitedError} carrying the parsed `Retry-After`, the body
   * discarded unread exactly as before. With one: the body is first scanned
   * for an edge refusal page (same rule and JSON short-cut as
   * {@link unauthorizedOrEdge}), then the hook gets the whole context.
   */
  async function rateLimitedError(attempt: Attempt, method: string, path: string): Promise<Error> {
    const res = attempt.res;
    const retryAfter = responseHeader(res, 'retry-after');
    const retryAfterMs = retryAfterToMs(retryAfter);
    if (!opts.onRateLimited) {
      discard(attempt);
      return new RateLimitedError(service, retryAfterMs);
    }
    let text = '';
    if (/json/i.test(responseHeader(res, 'content-type') ?? '')) {
      discard(attempt);
    } else {
      text = await readBody(attempt, (r) => r.text()).catch(() => '');
    }
    const edgeBlock = detectEdgeBlock({ body: text, headers: res.headers, status: res.status });
    return opts.onRateLimited({ status: res.status, retryAfter, retryAfterMs, edgeBlock, method, path });
  }

  async function fetchJson<T>(method: string, path: string, opt: RequestOptions = {}): Promise<T> {
    const attempt = await send(method, path, opt);
    const res = attempt.res;

    if (res.status === 401) throw await unauthorizedOrEdge(attempt, method, path);
    if (res.status === 429) throw await rateLimitedError(attempt, method, path);
    if (res.status === 204) {
      discard(attempt);
      return undefined as T;
    }

    const text = await readBody(attempt, (r) => r.text());
    if (!res.ok) {
      throw httpError(res, text, method, path, service);
    }
    if (text.length === 0) return undefined as T;
    return JSON.parse(text) as T;
  }

  async function fetchHtml(method: string, path: string, opt: RequestOptions = {}): Promise<string> {
    const headers = { Accept: 'text/html,*/*', ...opt.headers };
    const attempt = await send(method, path, { ...opt, headers });
    const res = attempt.res;

    if (res.status === 401) throw await unauthorizedOrEdge(attempt, method, path);
    if (res.status === 429) throw await rateLimitedError(attempt, method, path);

    const text = await readBody(attempt, (r) => r.text());
    if (!res.ok) {
      throw httpError(res, text, method, path, service);
    }
    return text;
  }

  async function fetchRaw(method: string, path: string, opt: RequestOptions = {}): Promise<RawApiResponse> {
    const headers = { Accept: '*/*', ...opt.headers };
    const attempt = await send(method, path, { ...opt, headers });
    const res = attempt.res;

    if (res.status === 401) throw await unauthorizedOrEdge(attempt, method, path);
    if (res.status === 429) throw await rateLimitedError(attempt, method, path);

    if (!res.ok) {
      const text = await readBody(attempt, (r) => r.text()).catch((err: unknown) => {
        if (err instanceof RequestTimeoutError) throw err;
        return '';
      });
      throw httpError(res, text, method, path, service);
    }
    const bytes = new Uint8Array(await readBody(attempt, (r) => r.arrayBuffer()));
    return {
      status: res.status,
      contentType: responseHeader(res, 'content-type'),
      headers: res.headers,
      bytes,
    };
  }

  return { fetchJson, fetchHtml, fetchRaw };
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

/**
 * A parsed Set-Cookie jar: deduplicated name→value plus a ready `Cookie`
 * header. (Renamed from `CookieJar` to free that name for the stateful
 * {@link CookieJar} class; no fleet consumer imported the type.)
 */
export interface ParsedCookieJar {
  /** Surviving cookies, name → value (last value wins, deletions removed). */
  cookies: Record<string, string>;
  /** Pre-joined `name=value; name2=value2` string for the `Cookie` request header. */
  cookieHeader: string;
}

const MAX_AGE_RE = /(?:^|;)\s*Max-Age\s*=\s*(-?\d+)\s*(?:;|$)/i;
const EXPIRES_RE = /(?:^|;)\s*Expires\s*=\s*([^;]+)/i;

/** `Expires` dates before this year are treated as deletion markers. Fixed (not
 * `Date.now()`-relative) so parsing stays deterministic; real session cookies
 * are never legitimately set to expire in the previous millennium. */
const EXPIRES_DELETION_YEAR = 2000;

/**
 * True when a `Set-Cookie` entry is a deletion marker: `Max-Age <= 0`
 * (including the common `Max-Age=-1`), or — when no `Max-Age` is present
 * (RFC 6265 §5.3: `Max-Age` outranks `Expires`) — an `Expires` date that
 * parses to before {@link EXPIRES_DELETION_YEAR}. Both RFC 1123
 * (`Thu, 01 Jan 1970`) and the legacy dash format (`Thu, 01-Jan-1970`) parse.
 */
function isDeletionCookie(entry: string): boolean {
  const maxAge = MAX_AGE_RE.exec(entry);
  if (maxAge) return Number(maxAge[1]) <= 0;
  const expires = EXPIRES_RE.exec(entry);
  if (expires && expires[1]) {
    const when = new Date(expires[1].trim());
    if (!Number.isNaN(when.getTime())) return when.getUTCFullYear() < EXPIRES_DELETION_YEAR;
  }
  return false;
}

/** Parse the leading `name=value` pair of a `Set-Cookie` entry (attrs ignored). */
function parseNameValue(entry: string): { name: string; value: string } | null {
  const nameValue = (entry.split(';')[0] ?? '').trim();
  const eqIdx = nameValue.indexOf('=');
  if (eqIdx < 1) return null;
  return { name: nameValue.slice(0, eqIdx).trim(), value: nameValue.slice(eqIdx + 1).trim() };
}

/**
 * Parse `Set-Cookie` headers into a deduplicated {@link ParsedCookieJar}.
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
export function parseCookieJar(setCookieHeaders: string[] | string | null | undefined): ParsedCookieJar {
  const entries = setCookieEntries(setCookieHeaders);

  const jar = new Map<string, string>();
  for (const entry of entries) {
    if (isDeletionCookie(entry)) continue;
    const pair = parseNameValue(entry);
    if (!pair || !pair.value) continue;
    jar.set(pair.name, pair.value);
  }

  const cookies: Record<string, string> = {};
  for (const [k, v] of jar) cookies[k] = v;
  const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  return { cookies, cookieHeader };
}

// ---------------------------------------------------------------------------
// parseCookieHeader
// ---------------------------------------------------------------------------

/**
 * Parse a *request* `Cookie:` header (`name=value; name2=value2`) into a
 * name→value map. This is the inbound counterpart to {@link parseCookieJar},
 * which parses *response* `Set-Cookie` headers (with their attributes and
 * deletion semantics) — a `Cookie` header has no attributes, just pairs.
 *
 * Semantics (matching creditkarma's hand-rolled `extractCookieValue` ×3):
 *  - splits on `;`, then on the FIRST `=` only, so a value containing `=`
 *    (e.g. base64 padding `ab==`, or `x=y=z`) is preserved verbatim,
 *  - trims surrounding whitespace from both name and value,
 *  - skips fragments with no `=` (bare attributes) or an empty name (`=v`),
 *  - keeps an empty value when the name is present (`a=` → `{ a: '' }`),
 *  - on a duplicate name, the last value wins.
 *
 * A missing / empty / whitespace-only header yields `{}`.
 *
 * Consolidates creditkarma's `extractCookieValue` (single-name lookup ×3) and
 * the cookie-header pattern-matching in two other repos: `extractCookieValue(h,
 * name)` is `parseCookieHeader(h)[name] ?? null`.
 */
export function parseCookieHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx < 0) continue; // bare attribute fragment, no `=`
    const name = part.slice(0, eqIdx).trim();
    if (name === '') continue; // missing name (leading `=`)
    out[name] = part.slice(eqIdx + 1).trim();
  }
  return out;
}

/**
 * Anything {@link CookieJar.absorb} can read `Set-Cookie`s from: the array from
 * `Headers.getSetCookie()`, a single (possibly comma-joined) header string, or
 * a `Headers`-like object (prefers `getSetCookie()`, falls back to splitting
 * `get('set-cookie')` safely around `Expires` commas).
 */
export type SetCookieSource =
  | string[]
  | string
  | null
  | undefined
  | { getSetCookie?: () => string[]; get(name: string): string | null };

/** Normalize a {@link SetCookieSource} to individual `Set-Cookie` strings. */
function setCookieEntries(source: SetCookieSource): string[] {
  if (source == null) return [];
  if (Array.isArray(source)) return source;
  if (typeof source === 'string') return splitSetCookie(source);
  if (typeof source.getSetCookie === 'function') return source.getSetCookie();
  const joined = source.get('set-cookie');
  return joined ? splitSetCookie(joined) : [];
}

/**
 * Stateful cookie jar for multi-step session logins (login page → CSRF prime →
 * credential POST → API calls), built on the {@link parseCookieJar} semantics.
 *
 * Consolidates the five drifted hand-rolled jars across
 * artsonia/canvas-parent/evite/signupgenius/skylight:
 *  - `absorb` merges each response's `Set-Cookie`s into the jar — later values
 *    override earlier ones by name, and deletion markers (`Max-Age <= 0` or a
 *    pre-2000 `Expires`, both comma- and dash-format epochs) **remove** the
 *    name from the jar,
 *  - empty-value non-deletion cookies are ignored (an existing value survives),
 *  - `header()` renders the `Cookie` request-header value in insertion order.
 */
export class CookieJar {
  private readonly jar = new Map<string, string>();

  /** Merge `Set-Cookie`s into the jar (later wins; deletion markers remove). */
  absorb(setCookies: SetCookieSource): void {
    for (const entry of setCookieEntries(setCookies)) {
      const pair = parseNameValue(entry);
      if (!pair) continue;
      if (isDeletionCookie(entry)) {
        this.jar.delete(pair.name);
        continue;
      }
      if (!pair.value) continue;
      this.jar.set(pair.name, pair.value);
    }
  }

  /** The current value of a cookie, or `undefined` when absent/deleted. */
  get(name: string): string | undefined {
    return this.jar.get(name);
  }

  /** Render the `Cookie` request-header value: `name=value; name2=value2`. */
  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /** Number of cookies currently in the jar. */
  get size(): number {
    return this.jar.size;
  }
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

/**
 * Generic single-claim extractor for a JWT payload. Returns the raw claim
 * value (`unknown` — cast or narrow at the call site), or `undefined` for an
 * undecodable token or an absent claim. Never throws.
 *
 * Generalizes the hand-rolled per-claim readers across the fleet (e.g.
 * creditkarma's `extractGlidFromJwt`): `decodeJwtClaim(token, 'glid')` instead
 * of a bespoke decode + payload-field pluck. Reuses the same base64url payload
 * decode as {@link decodeJwtExp} / {@link decodeJwtSessionId}.
 */
export function decodeJwtClaim(token: string, claim: string): unknown {
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;
  return payload[claim];
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

// ---------------------------------------------------------------------------
// runBoundedBatch
// ---------------------------------------------------------------------------

/** Options for {@link runBoundedBatch}. */
export interface RunBoundedBatchOptions<T, R> {
  /**
   * Overall hard deadline for the WHOLE batch, in milliseconds. When it fires,
   * any item that hasn't settled is filled by {@link onTimeout} and the batch
   * returns immediately — unsettled workers are abandoned (left to settle in
   * the background, never awaited), so a permanently-hung item can't wedge the
   * call past this bound.
   */
  deadlineMs: number;
  /**
   * Backfill for an item the deadline cut off before it settled. Receives the
   * original `item` and its `index` so the placeholder stays identifiable and
   * re-runnable (the zillow `pending`-row pattern). Called only for unsettled
   * slots.
   */
  onTimeout: (item: T, index: number) => R;
  /**
   * Backfill for an item whose `worker` REJECTED (threw). A worker error is
   * isolated to its own slot — it never rejects the batch or cascades onto
   * other items. Defaults to `onTimeout(item, index)` (a rejected worker is
   * treated like a timeout) so a caller that doesn't care needn't distinguish;
   * supply `onError` to tell a genuine failure apart from a deadline cutoff.
   */
  onError?: (item: T, index: number, err: unknown) => R;
  /**
   * Max workers in flight at once. Defaults to unbounded (all items started
   * immediately). Use it to bound fan-out against a rate-limited upstream.
   */
  concurrency?: number;
  /**
   * Injectable timer (for tests). Defaults to `setTimeout`. Must invoke `cb`
   * after roughly `ms`, returning a handle passed to {@link clearTimer}.
   */
  setTimer?: (ms: number, cb: () => void) => unknown;
  /** Injectable clear paired with {@link setTimer}. Defaults to `clearTimeout`. */
  clearTimer?: (handle: unknown) => void;
  /**
   * The caller's cancellation. Defaults to the running tool call's
   * ({@link currentCallSignal}). When it aborts the batch answers AT ONCE, as if
   * the deadline had fired: unsettled slots are backfilled by {@link onTimeout},
   * workers' signals abort, and nothing more is dispatched — a client that
   * cancelled is no longer fetched for.
   */
  signal?: AbortSignal;
}

/**
 * Run `worker` over `items` with an overall hard deadline and a per-item
 * timeout-backfill, returning a full-length, input-ordered array with exactly
 * one result per item.
 *
 * Each item gets an index-addressable slot. Work is raced against `deadlineMs`;
 * when the deadline fires first, every still-unsettled slot is filled by
 * `onTimeout(item, index)` and the batch resolves immediately — the in-flight
 * workers are abandoned (and signalled via their `AbortSignal`) rather than
 * awaited, so a single hung row can't keep the whole call (and the MCP request
 * deadline behind it) pinned open. Queued items not yet started are never
 * dispatched after the deadline; a worker that retries or loops internally
 * should still check `signal.aborted` itself to stop mid-item. The caller's
 * cancellation ({@link RunBoundedBatchOptions.signal}, the running tool call's
 * by default) ends the batch the same way, immediately. When everything settles before the deadline,
 * the timer is cleared and every slot holds its real result.
 *
 * Generalises zillow's bulk-tool `runWithDeadline` (`zillow_bulk_get` /
 * `zillow_resolve_addresses`, issues #98/#78): the slot-array + overall-deadline
 * + `pending`-backfill shape, now with the worker + concurrency folded in and an
 * injectable timer for deterministic tests.
 */
export function runBoundedBatch<T, R>(
  items: T[],
  worker: (item: T, signal?: AbortSignal) => Promise<R>,
  opts: RunBoundedBatchOptions<T, R>,
): Promise<R[]> {
  const slots: Array<R | undefined> = Array.from({ length: items.length });
  const settled: boolean[] = new Array(items.length).fill(false);
  // An item whose worker threw: backfilled via onError (default onTimeout) at
  // finish, distinct from a slot the deadline simply never reached.
  const errored: boolean[] = new Array(items.length).fill(false);
  const errorVals: unknown[] = new Array(items.length);

  // Nothing to do — never arm a timer for an empty batch.
  if (items.length === 0) return Promise.resolve([]);
  const callerSignal = opts.signal ?? currentCallSignal();
  // Already cancelled: answer without dispatching a single worker.
  if (callerSignal?.aborted) return Promise.resolve(items.map((item, index) => opts.onTimeout(item, index)));

  const setTimer = opts.setTimer ?? ((ms, cb) => setTimeout(cb, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const controller = new AbortController();

  // Bounded fan-out: a pool of `limit` runners pulling the next index off a
  // shared cursor. limit >= items.length (or unset) means "all at once".
  const limit =
    opts.concurrency && opts.concurrency > 0
      ? Math.min(opts.concurrency, items.length)
      : items.length;

  const runAll = async (): Promise<void> => {
    let cursor = 0;
    const runner = async (): Promise<void> => {
      for (;;) {
        // Once the deadline has answered (finish() aborts the controller),
        // stop dequeuing: nobody will read the remaining slots, so dispatching
        // them only burns upstream requests. Checked before EVERY dequeue, so
        // a worker that settles after the abort also ends its runner.
        if (controller.signal.aborted) return;
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        // Isolate a worker rejection to its own slot: record it and continue
        // pulling the next item, so one bad row neither rejects the batch nor
        // strands the items this runner hasn't reached yet.
        try {
          slots[index] = await worker(items[index]!, controller.signal);
          settled[index] = true;
        } catch (err) {
          errored[index] = true;
          errorVals[index] = err;
        }
      }
    };
    await Promise.all(Array.from({ length: limit }, () => runner()));
  };

  return new Promise<R[]>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimer(handle);
      callerSignal?.removeEventListener('abort', finish);
      // Signal abandoned workers so a cooperative worker can stop early.
      if (!controller.signal.aborted) controller.abort();
      const onError = opts.onError ?? ((item: T, index: number) => opts.onTimeout(item, index));
      resolve(
        items.map((item, index) => {
          if (settled[index]) return slots[index] as R;
          if (errored[index]) return onError(item, index, errorVals[index]);
          return opts.onTimeout(item, index);
        }),
      );
    };

    const handle = setTimer(opts.deadlineMs, finish);
    // The caller going away ends the batch the same way the deadline does.
    callerSignal?.addEventListener('abort', finish, { once: true });

    // Abandon (never await) the fan-out on the deadline path; on full settle,
    // finish() clears the timer and returns the real results.
    void runAll().then(finish, finish);
  });
}
