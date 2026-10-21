/**
 * `createGraphqlClient` — the GraphQL-over-HTTP POST transport.
 *
 * Consolidates the hand-rolled GraphQL clients in vibo-mcp (`src/client.ts`
 * `ViboClient.post` / `readGraphQLBody` / `unwrap` / `transportError`, the
 * reference implementation) and thumbtack-mcp (`src/client.ts`
 * `ThumbtackClient.graphql`) — chrischall/fleet-audit#1138, #1128. Both POST
 * `{ query, variables }`, treat `errors[]` on an HTTP 200 as a failure, join
 * and truncate the messages, and refuse a non-JSON 2xx as a challenge page;
 * vibo adds auth-code classification, a refresh-and-replay-once, CDN/WAF
 * detection, a timeout plus the caller's cancellation, and a write-aware
 * transport error.
 *
 * It composes the `http` module's pieces rather than re-deriving them:
 * {@link detectEdgeBlock} / {@link EdgeBlockedError} for refusals in front of
 * the API, {@link RetryPolicy} and `parseRetryAfterMs` for 429s,
 * {@link UnauthorizedError} / {@link RateLimitedError} /
 * {@link UpstreamHttpError} for the statuses `createApiClient` already names,
 * `formatApiError` / `truncateErrorMessage` so no upstream body or message
 * reaches a tool result unredacted, and `withAmbientCancellation` so a
 * cancelled tool call stops its request.
 *
 * Retry and error-shaping hooks for a direct transport that a CDN may wall
 * ({@link GraphqlRetryPolicy}'s transport-error retry, exponential jittered
 * backoff and Retry-After floor; {@link GraphqlClientOptions.onEdgeBlocked} /
 * {@link GraphqlClientOptions.onErrorResponse}; {@link responseDiagnostics})
 * come from hemnet-mcp `src/transport-direct.ts` (the reference) and its
 * booli-mcp twin — chrischall/fleet-audit#1261, #1223.
 *
 * It is not built ON `createApiClient` because a GraphQL server's error
 * answer is a JSON body at whatever status (Apollo validation errors are a
 * 400, vibo's permission denials a 403) and `fetchJson` turns every non-2xx
 * into a message string, losing the `errors[]` this layer exists to read.
 */

import { responseHeader } from '../internal/headers.js';
import { withAmbientCancellation } from '../cancel/index.js';
import { McpToolError, messageOf, truncateErrorMessage } from '../errors/index.js';
import type { McpToolErrorKind } from '../errors/index.js';
import {
  EdgeBlockedError,
  RateLimitedError,
  ResponseTooLargeError,
  UnauthorizedError,
  UpstreamHttpError,
  detectEdgeBlock,
  formatApiError,
  parseRetryAfterMs,
  type RateLimitContext,
  type RetryPolicy,
} from '../http/index.js';
import { readBytesCapped } from '../http/body-limit.js';
import { retryAfterToMs } from '../internal/retry-after.js';
import { cancellableSleep } from '../internal/sleep.js';
import { isReadOnlyGraphqlDocument } from './operation-kind.js';

/** One entry of a GraphQL response's `errors[]`. */
export interface GraphqlError {
  message?: string;
  /** Some servers (vibo) put the code at the top level… */
  code?: string;
  /** …the spec-blessed home is `extensions.code`. */
  extensions?: { code?: string; [key: string]: unknown };
  path?: ReadonlyArray<string | number>;
  [key: string]: unknown;
}

/** A GraphQL request. */
export interface GraphqlRequest {
  /** The document. */
  query: string;
  /** Sent only when given. */
  variables?: Record<string, unknown>;
  /** Sent only when given. */
  operationName?: string;
  /** Extra headers for this request, merged over the client's. */
  headers?: Record<string, string>;
  /**
   * Treat the request as safe to repeat even though the document contains a
   * mutation — a sign-in or token refresh, say. It then gets a read's retry
   * policy and a read's transport-error wording. Defaults to what
   * {@link isReadOnlyGraphqlDocument} says about the document.
   */
  idempotent?: boolean;
}

/** What {@link GraphqlClient.execute} returns: the parsed envelope plus the HTTP status. */
export interface GraphqlResult<T = unknown> {
  status: number;
  headers: Headers;
  data?: T | null;
  /** Normalized to an array of objects when present. */
  errors?: GraphqlError[];
  extensions?: Record<string, unknown>;
}

/**
 * {@link RetryPolicy} plus the knobs a direct transport behind a flaky edge
 * needs. Every added field is optional and off by default, so a plain
 * `RetryPolicy` behaves exactly as before.
 */
export interface GraphqlRetryPolicy extends RetryPolicy {
  /**
   * Also retry a request that got no response — a network error or this
   * client's own timeout — within the same `count`. Read-only and
   * `idempotent` requests only: a mutation that may have committed is never
   * re-sent (it throws {@link GraphqlTransportError} with `outcomeUnknown`).
   * A caller's cancellation and an over-cap body are never retried.
   * Default `false`.
   */
  transportErrors?: boolean;
  /**
   * `'fixed'` (default): `delayMs` before every retry. `'exponential'`:
   * `delayMs × 2^(n−1)` before retry `n` (1 s, 2 s, … for `delayMs: 1000`).
   */
  backoff?: 'fixed' | 'exponential';
  /**
   * Spread each wait over `[wait, wait × (1 + jitter))` so concurrent callers
   * do not retry in lockstep (hemnet: `0.5`). Default `0`. Uses
   * {@link GraphqlClientOptions.random}.
   */
  jitter?: number;
  /**
   * With `honorRetryAfter`: wait the LONGER of the backoff and the (capped)
   * `Retry-After`, instead of `Retry-After` replacing the backoff — so a
   * `Retry-After: 0` cannot turn a backoff into a hot loop (fleet-audit#495).
   * An absent or unparseable header leaves the backoff alone. Default `false`
   * (the historical replace-it behaviour).
   */
  retryAfterAsFloor?: boolean;
  /**
   * The longest one backoff wait may be, jitter included — an
   * `'exponential'` backoff otherwise doubles without bound (`count: 6,
   * delayMs: 2000` would reach 64 s). Default 30 000 (30 s, like
   * `maxRetryAfterMs`) or `delayMs` if that is larger, so a fixed delay is
   * never cut short. A `Retry-After` is bounded by `maxRetryAfterMs`
   * instead. Must be a non-negative number (a `TypeError` otherwise).
   * Every wait also ends early, rejecting with the abort, when the tool call
   * is cancelled (fleet-audit#1443).
   */
  maxBackoffMs?: number;
}

/** What {@link GraphqlClientOptions.onEdgeBlocked} is shown. */
export interface GraphqlEdgeBlockContext {
  /** The response status (any — a challenge can be served as 200, 403, 429 or 503). */
  status: number;
  /** The CDN/WAF {@link detectEdgeBlock} recognised (`'Cloudflare'`, …). */
  vendor: string;
  /** The response headers — `server`, `cf-ray`, `cf-mitigated` ({@link responseDiagnostics}). */
  headers: Headers;
  /** The raw, UNREDACTED body (the refusal page). */
  body: string;
  /** Always `'POST'`. */
  method: string;
  /** The endpoint's path. */
  path: string;
}

/** What {@link GraphqlClientOptions.onErrorResponse} is shown. */
export interface GraphqlErrorResponseContext {
  /** The response status: a 4xx/5xx, or a 2xx whose body is not a GraphQL response. */
  status: number;
  /** The response headers. */
  headers: Headers;
  /** The raw, UNREDACTED body (`''` when it could not be read). Redact before surfacing any of it. */
  body: string;
  /** The parsed GraphQL envelope, when the body was one. */
  envelope: { data?: unknown; errors?: GraphqlError[]; extensions?: Record<string, unknown> } | undefined;
  /** Whether the request was treated as a write (a mutation, not marked `idempotent`). */
  write: boolean;
}

/**
 * The `server` / `cf-ray` / `cf-mitigated` headers present on a response, as
 * `server: cloudflare; cf-ray: a1a7…-ATL; cf-mitigated: challenge` (`''` when
 * none) — the diagnostic hemnet-mcp and booli-mcp put in every edge-block and
 * hard-HTTP message, because a bare "HTTP 403" hides which failure mode (bot
 * wall, moved endpoint, bad request) it is. Pass `names` for other headers.
 * Each value is cut at 100 characters.
 */
export function responseDiagnostics(
  headers: Headers,
  names: readonly string[] = ['server', 'cf-ray', 'cf-mitigated'],
): string {
  return names
    .map((name) => ({ name, value: headers.get(name) }))
    .filter((h): h is { name: string; value: string } => Boolean(h.value))
    .map((h) => `${h.name}: ${h.value.slice(0, 100)}`)
    .join('; ');
}

/** What {@link GraphqlClientOptions.mapError} is shown. */
export interface GraphqlErrorContext {
  status: number;
  errors: readonly GraphqlError[];
  data: unknown;
}

/** Options for {@link createGraphqlClient}. */
export interface GraphqlClientOptions {
  /** Absolute URL of the GraphQL endpoint. */
  endpoint: string;
  /** Human name of the upstream, used in messages. Defaults to the endpoint's host. */
  serviceName?: string;
  /**
   * Headers sent on every request — a record, or a (possibly async) function
   * re-read per request, which is where a rotating credential such as vibo's
   * `x-token` belongs. A request's own `headers` override these.
   */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /**
   * Per-attempt timeout in ms, from the request until the body is read.
   * Defaults to 30 000 (both copies used 30 s); `0` disables it. The caller's
   * cancellation applies either way.
   */
  timeout?: number;
  /**
   * 429 retry policy, as `createApiClient`'s: defaults to one retry after 2 s.
   * Other `statuses` (transient 5xx) are retried only for a read-only or
   * `idempotent` request — a 5xx on a mutation may have committed it. A 429
   * is retried for a write too: a rate-limited request was refused, not run.
   */
  retry?: GraphqlRetryPolicy;
  /** Random source in `[0, 1)` for {@link GraphqlRetryPolicy.jitter} (tests). Defaults to `Math.random`. */
  random?: () => number;
  /**
   * The error a CDN/WAF refusal throws, in place of the default
   * {@link EdgeBlockedError} — return a subclass of it (so
   * `createDirectFirstTransport` still falls back to the bridge on it) that
   * carries the site's own diagnostics, as hemnet's `CloudflareChallengeError`
   * does with {@link responseDiagnostics}. Consulted wherever the client
   * detects a refusal page: any non-2xx, and a non-JSON 2xx.
   */
  onEdgeBlocked?: (ctx: GraphqlEdgeBlockContext) => Error;
  /**
   * Claim a response that is not a usable GraphQL answer before the default
   * mapping — on `execute` as well as `request`: any 4xx/5xx (after the
   * retry budget, the edge-block check, a 429's `onRateLimited` and any auth
   * replay), and a 2xx whose body is not a GraphQL response. Return an error
   * to throw it, or `undefined` for the default. It sees the RAW body; a
   * 2xx GraphQL answer (with or without `errors[]`) never reaches it.
   * hemnet-mcp's "Hemnet GraphQL HTTP 403 (server: nginx) — body starts: …"
   * diagnostics live here.
   */
  onErrorResponse?: (ctx: GraphqlErrorResponseContext) => Error | undefined;
  /**
   * Whether a response is an expired / missing session. Defaults to
   * {@link isGraphqlAuthError}: HTTP 401, or an `UNAUTHENTICATED` /
   * `UNAUTHORIZED` code. Never consulted for a CDN/WAF refusal.
   */
  isAuthError?: (status: number, errors: readonly GraphqlError[]) => boolean;
  /**
   * Re-authenticate after an auth failure (refresh the token, log in again).
   * When set, the request is replayed ONCE with freshly read headers; a second
   * auth failure throws. Single-flighting concurrent refreshes is the
   * caller's job (a `TokenManager` or `createCachedTokenSource` does it).
   */
  onAuthError?: () => Promise<void> | void;
  /** The error an unrecovered auth failure throws. Defaults to {@link UnauthorizedError}. */
  onUnauthorized?: () => Error;
  /**
   * The error an exhausted 429 throws. Defaults to {@link RateLimitedError}.
   * Receives the same {@link RateLimitContext} as `createApiClient`'s hook
   * (`edgeBlock` is always `null` here: an edge-refused 429 has already thrown
   * {@link EdgeBlockedError}). A zero-argument hook still works.
   */
  onRateLimited?: (ctx: RateLimitContext) => Error;
  /**
   * Claim a failed response before the default mapping — return an error to
   * throw it, or `undefined` to fall through. Runs after any auth replay, on
   * every response {@link GraphqlClient.request} would otherwise reject (and
   * on none it would accept). The place for site rules such as vibo's
   * "FORBIDDEN / HTTP 403 is a permission denial, not an expired session".
   */
  mapError?: (ctx: GraphqlErrorContext) => Error | undefined;
  /** Hint attached to the {@link GraphqlResponseError} for an `errors[]` answer. */
  errorHint?: string;
  /**
   * Hint for a write whose outcome is unknown (timed out / connection dropped
   * after sending). Name the tool that checks the state.
   */
  writeOutcomeHint?: string;
  /**
   * Byte cap on every response body. A `Content-Length` over it is refused
   * before reading; a body that grows past it is cancelled mid-stream. Either
   * way {@link ResponseTooLargeError} (`kind: 'too_large'`), never a
   * transport error — the response arrived, only its size was refused.
   * Defaults to {@link GRAPHQL_DEFAULT_MAX_RESPONSE_BYTES} (16 MiB); `Infinity`
   * disables it. Must be a non-negative number (a `TypeError` otherwise).
   * Same implementation as `createApiClient`'s `maxResponseBytes`
   * (fleet-audit#1387).
   */
  maxResponseBytes?: number;
  /** Injectable fetch. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for retries (tests). Raced against the tool call's cancellation either way. */
  sleep?: (ms: number) => Promise<void>;
}

/** The client surface {@link createGraphqlClient} returns. */
export interface GraphqlClient {
  /**
   * Send a request and return its parsed envelope, `errors[]` and all — for a
   * raw passthrough tool that shows the caller what the server said. Still
   * throws for everything that is not a GraphQL answer: a transport failure,
   * a CDN/WAF refusal, an exhausted 429, a body over `maxResponseBytes`
   * ({@link ResponseTooLargeError}), or a body that is not a GraphQL
   * response object (a non-JSON error page is an {@link UpstreamHttpError}).
   * An auth failure is replayed once when `onAuthError` is set, then
   * returned as-is.
   */
  execute<T = unknown>(request: GraphqlRequest): Promise<GraphqlResult<T>>;
  /**
   * Send a request and return its `data`, throwing for any failure: the
   * `execute` failures, an auth failure ({@link UnauthorizedError} or
   * `onUnauthorized`), `errors[]` ({@link GraphqlResponseError}, even beside
   * partial data), a JSON non-2xx with no `errors[]`
   * ({@link UpstreamHttpError}), or a response with no data.
   */
  request<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
    opts?: Omit<GraphqlRequest, 'query' | 'variables'>,
  ): Promise<T>;
}

/**
 * The server answered, but with GraphQL `errors[]` (or with something that is
 * not a GraphQL response at all — then `errors` is empty). The message joins
 * the messages, redacted and truncated; the raw entries, any partial `data`,
 * and the codes ride along for callers that branch.
 *
 * It declares no `kind` unless constructed with one: the client throws
 * `UnauthorizedError` (`kind: 'credential_rejected'`) for an auth answer, so
 * one that reaches here is one the client's `isAuthError` judged NOT to be.
 */
export class GraphqlResponseError extends McpToolError {
  readonly status: number;
  readonly errors: readonly GraphqlError[];
  readonly data: unknown;
  /** Every `code` / `extensions.code` present, in order. */
  readonly codes: readonly string[];

  constructor(
    message: string,
    details: { status: number; errors?: readonly GraphqlError[]; data?: unknown; hint?: string; kind?: McpToolErrorKind },
  ) {
    super(message, {
      ...(details.hint !== undefined ? { hint: details.hint } : {}),
      ...(details.kind !== undefined ? { kind: details.kind } : {}),
    });
    this.name = 'GraphqlResponseError';
    this.status = details.status;
    this.errors = details.errors ?? [];
    this.data = details.data;
    this.codes = this.errors.map(graphqlErrorCode).filter((c): c is string => c !== undefined);
  }
}

/**
 * The request never produced a response: it timed out, or the connection
 * failed. For a read that is safe to retry. For a write the outcome is
 * UNKNOWN — the server may already have committed it — so `outcomeUnknown` is
 * set, the message says so, and the hint asks for a state check before any
 * retry (a confirmation gate cannot stop a blind retry: a fresh preview earns
 * a fresh approval). A caller's cancellation is not this error; its abort is
 * rethrown untouched. Its `kind` is `'timeout'` or `'transport'`, following
 * `timedOut`.
 */
export class GraphqlTransportError extends McpToolError {
  readonly timedOut: boolean;
  readonly outcomeUnknown: boolean;

  constructor(message: string, details: { timedOut: boolean; outcomeUnknown: boolean; hint: string; cause: unknown }) {
    super(message, { hint: details.hint, cause: details.cause, kind: details.timedOut ? 'timeout' : 'transport' });
    this.name = 'GraphqlTransportError';
    this.timedOut = details.timedOut;
    this.outcomeUnknown = details.outcomeUnknown;
  }
}

/** The error code of one `errors[]` entry: top-level `code`, else `extensions.code`. */
export function graphqlErrorCode(error: GraphqlError): string | undefined {
  const code = error.code ?? error.extensions?.code;
  return typeof code === 'string' ? code : undefined;
}

const AUTH_CODES = new Set(['UNAUTHENTICATED', 'UNAUTHORIZED']);

/**
 * The default expired-session test: HTTP 401, or an `UNAUTHENTICATED` /
 * `UNAUTHORIZED` code. `FORBIDDEN` is deliberately not one — it is a
 * permission denial, and refreshing a token cannot fix it.
 */
export function isGraphqlAuthError(status: number, errors: readonly GraphqlError[]): boolean {
  if (status === 401) return true;
  return errors.some((e) => {
    const code = graphqlErrorCode(e);
    return code !== undefined && AUTH_CODES.has(code);
  });
}

/**
 * The default {@link GraphqlClientOptions.maxResponseBytes}: 16 MiB, far above
 * any GraphQL answer the fleet reads, and low enough that a hostile or runaway
 * endpoint cannot make the process buffer an unbounded body.
 */
export const GRAPHQL_DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY: GraphqlRetryPolicy = { count: 1, delayMs: 2000 };
/** Default ceiling on one exponential/jittered backoff wait (fleet-audit#1443). */
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/** Validate {@link GraphqlClientOptions.maxResponseBytes}; `undefined` = no cap. */
function checkMaxBytes(value: number | undefined): number | undefined {
  if (value === undefined) return GRAPHQL_DEFAULT_MAX_RESPONSE_BYTES;
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    throw new TypeError(`createGraphqlClient: maxResponseBytes must be a non-negative number, got ${String(value)}.`);
  }
  return value === Infinity ? undefined : value;
}

/** Thrown internally when our own timer fired. */
class TimedOut extends Error {}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `errors` as an array of objects, whatever shape the server sent. */
function normalizeErrors(raw: unknown): GraphqlError[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((e): GraphqlError => {
    const obj = objectOf(e);
    if (obj) return obj as GraphqlError;
    return { message: typeof e === 'string' ? e : String(e) };
  });
}

/** Parse a body into a GraphQL envelope, or `undefined` when it is not one. */
function parseEnvelope(text: string): Omit<GraphqlResult, 'status' | 'headers'> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const obj = objectOf(parsed);
  if (!obj) return undefined;
  const errors = normalizeErrors(obj.errors);
  const extensions = objectOf(obj.extensions);
  return {
    ...('data' in obj ? { data: obj.data } : {}),
    ...(errors !== undefined ? { errors } : {}),
    ...(extensions !== undefined ? { extensions } : {}),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * Build a GraphQL-over-HTTP client: POST `{ query, variables?, operationName? }`
 * as JSON, read `errors[]` at any status, and map every other outcome onto the
 * package's existing error types. See {@link GraphqlClient} for what each
 * method throws and {@link GraphqlClientOptions} for the hooks.
 *
 * ```ts
 * const gql = createGraphqlClient({
 *   endpoint: 'https://api.vibodj.com/v2/graphql',
 *   serviceName: 'Vibo',
 *   headers: async () => ({ 'x-token': await tokens.current() }),
 *   onAuthError: () => tokens.refresh(),
 *   onUnauthorized: () => new SessionNotAuthenticatedError('Vibo', 'https://web.vibodj.com'),
 * });
 * const { me } = await gql.request<{ me: { id: string } }>('query Me { me { id } }');
 * ```
 */
export function createGraphqlClient(opts: GraphqlClientOptions): GraphqlClient {
  const service = opts.serviceName ?? hostOf(opts.endpoint);
  const path = pathOf(opts.endpoint);
  const doFetch = opts.fetchImpl ?? fetch;
  // A retry's wait stops when the tool call is cancelled (fleet-audit#1443).
  const sleep = (ms: number): Promise<void> => cancellableSleep(ms, opts.sleep);
  const timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const retry = opts.retry ?? DEFAULT_RETRY;
  const retryStatuses = retry.statuses ?? [429];
  const random = opts.random ?? Math.random;
  // Default: 30 s, but never below the policy's own delayMs — a plain fixed
  // RetryPolicy waits exactly what it asked for, as before.
  const maxBackoffMs = retry.maxBackoffMs ?? Math.max(DEFAULT_MAX_BACKOFF_MS, retry.delayMs);
  if (typeof maxBackoffMs !== 'number' || Number.isNaN(maxBackoffMs) || maxBackoffMs < 0) {
    throw new TypeError(`createGraphqlClient: retry.maxBackoffMs must be a non-negative number, got ${String(maxBackoffMs)}.`);
  }

  /** The wait before retry number `n` (1-based), before any Retry-After. */
  function backoffMs(n: number): number {
    const base = retry.backoff === 'exponential' ? retry.delayMs * 2 ** (n - 1) : retry.delayMs;
    const jitter = retry.jitter ?? 0;
    const wait = jitter > 0 ? Math.floor(base + random() * base * jitter) : base;
    return Math.min(wait, maxBackoffMs);
  }

  /** The wait before retry `n` after a retryable RESPONSE (Retry-After applies). */
  function responseDelayMs(n: number, res: Response): number {
    const backoff = backoffMs(n);
    if (!retry.honorRetryAfter) return backoff;
    const header = responseHeader(res, 'retry-after');
    const capMs = retry.maxRetryAfterMs ?? 30_000;
    if (retry.retryAfterAsFloor) return Math.max(backoff, parseRetryAfterMs(header, { defaultMs: 0, capMs }));
    return parseRetryAfterMs(header, { defaultMs: backoff, capMs });
  }

  /** The error a CDN/WAF refusal throws. */
  function edgeError(res: Response, text: string, vendor: string): Error {
    return opts.onEdgeBlocked
      ? opts.onEdgeBlocked({ status: res.status, vendor, headers: res.headers, body: text, method: 'POST', path })
      : new EdgeBlockedError(res.status, vendor, { service, method: 'POST', path });
  }
  const isAuth = opts.isAuthError ?? isGraphqlAuthError;
  const maxBytes = checkMaxBytes(opts.maxResponseBytes);

  async function headersFor(req: GraphqlRequest): Promise<Record<string, string>> {
    const base = typeof opts.headers === 'function' ? await opts.headers() : (opts.headers ?? {});
    return { 'content-type': 'application/json', accept: 'application/json', ...base, ...req.headers };
  }

  /**
   * The body as text under {@link GraphqlClientOptions.maxResponseBytes}. A
   * fetch shim whose response has no readable stream (only `text()`) is read
   * whole and then measured, so the cap still holds for it.
   */
  async function readText(res: Response, race: <T>(p: Promise<T>) => Promise<T>): Promise<string> {
    if (maxBytes === undefined) return res.text();
    const body = (res as { body?: unknown }).body as { getReader?: unknown } | null | undefined;
    if (!body || typeof body.getReader !== 'function') {
      const text = await res.text();
      if (new TextEncoder().encode(text).byteLength > maxBytes) throw new ResponseTooLargeError(service, maxBytes);
      return text;
    }
    return new TextDecoder().decode(await readBytesCapped(res, maxBytes, service, race));
  }

  /**
   * One HTTP attempt, bounded from the request until the body has been read.
   * The read is RACED against the timer rather than trusting the body stream
   * to honour the abort, so a `fetchImpl` that ignores the signal is bounded
   * too.
   */
  async function attempt(init: RequestInit): Promise<{ res: Response; text: string }> {
    const controller = timeoutMs > 0 ? new AbortController() : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired: Promise<never> | undefined;
    if (controller) {
      expired = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new TimedOut()), { once: true });
      });
      expired.catch(() => {});
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }
    const signal = withAmbientCancellation(controller?.signal);
    // Racing each read against the timer makes a stalled read reject too, so
    // readBytesCapped cancels the stream instead of leaving it held.
    const race = <T>(p: Promise<T>): Promise<T> => (expired ? Promise.race([p, expired]) : p);
    const work = (async () => {
      const res = await doFetch(opts.endpoint, { ...init, ...(signal ? { signal } : {}) });
      const text = await readText(res, race).catch((err: unknown) => {
        // An ERROR response arrived; only its body broke off. Its status is
        // the answer, so the body is best-effort ('') rather than turning a
        // 400 into a transport failure. A timeout, a cancellation and an
        // over-cap body still throw.
        const keep =
          err instanceof TimedOut ||
          err instanceof ResponseTooLargeError ||
          (err instanceof Error && err.name === 'AbortError');
        if (res.status >= 400 && !keep) return '';
        throw err;
      });
      return { res, text };
    })();
    work.catch(() => {});
    try {
      return await (expired ? Promise.race([work, expired]) : work);
    } catch (err) {
      // Told apart by WHICH signal fired: an abort is an `AbortError` whichever
      // end caused it, and a caller's cancellation is not this service timing out.
      if (controller?.signal.aborted) throw new TimedOut();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function transportError(err: unknown, timedOut: boolean, write: boolean): GraphqlTransportError {
    const what = timedOut
      ? `Request to ${service} timed out after ${timeoutMs}ms`
      : `Request to ${service} failed: ${truncateErrorMessage(messageOf(err), 200)}`;
    if (write) {
      return new GraphqlTransportError(`${what} — the change may already have been applied (outcome is unknown).`, {
        timedOut,
        outcomeUnknown: true,
        hint:
          opts.writeOutcomeHint ??
          'Do not repeat this write blindly — check the current state first, and retry only if the change is not there.',
        cause: err,
      });
    }
    return new GraphqlTransportError(`${what}.`, {
      timedOut,
      outcomeUnknown: false,
      hint: `The ${service} API may be slow or unreachable — check your connection and retry.`,
      cause: err,
    });
  }

  /** Send with the retry policy; returns the final response and its body. */
  async function send(req: GraphqlRequest, write: boolean): Promise<{ res: Response; text: string }> {
    const body = JSON.stringify({
      query: req.query,
      ...(req.variables !== undefined ? { variables: req.variables } : {}),
      ...(req.operationName !== undefined ? { operationName: req.operationName } : {}),
    });
    for (let tries = 0; ; tries++) {
      // Resolved BEFORE the transport try: a throwing `headers()` hook (a token
      // refresh rejecting with UnauthorizedError, a missing-config error) has
      // sent nothing, so it is rethrown untouched — never reported as a
      // transport failure, nor, for a write, as outcome-unknown
      // (fleet-audit#1196).
      const headers = await headersFor(req);
      let sent: { res: Response; text: string };
      try {
        sent = await attempt({ method: 'POST', headers, body });
      } catch (err) {
        // The response arrived; only its size was refused.
        if (err instanceof ResponseTooLargeError) throw err;
        if (err instanceof Error && err.name === 'AbortError' && !(err instanceof TimedOut)) throw err; // the caller cancelled
        const timedOut = err instanceof TimedOut;
        // A read (or an idempotent request) that got NO response may be
        // re-sent when the policy says so; a write never is — it may have
        // committed.
        if (retry.transportErrors === true && !write && tries < retry.count) {
          await sleep(backoffMs(tries + 1));
          continue;
        }
        throw transportError(err, timedOut, write);
      }
      const status = sent.res.status;
      const retryable = retryStatuses.includes(status) && (status === 429 || !write);
      if (retryable && tries < retry.count) {
        // A refusal page is not a transient status: retrying it only delays
        // the bridge fallback (Cloudflare serves rate-limit blocks as 429 and
        // its legacy JS challenge as 503 — fleet-audit#1019). Hand it to
        // execute(), which throws it.
        if (detectEdgeBlock({ body: sent.text, headers: sent.res.headers, status })) return sent;
        await sleep(responseDelayMs(tries + 1, sent.res));
        continue;
      }
      return sent;
    }
  }

  async function execute<T = unknown>(req: GraphqlRequest): Promise<GraphqlResult<T>> {
    const write = req.idempotent === true ? false : !isReadOnlyGraphqlDocument(req.query);
    for (let replayed = false; ; replayed = true) {
      const { res, text } = await send(req, write);
      const status = res.status;
      if (status >= 400) {
        const edge = detectEdgeBlock({ body: text, headers: res.headers, status });
        if (edge) throw edgeError(res, text, edge.vendor);
      }
      if (status === 429) {
        const retryAfter = responseHeader(res, 'retry-after');
        const retryAfterMs = retryAfterToMs(retryAfter);
        throw opts.onRateLimited
          ? opts.onRateLimited({ status, retryAfter, retryAfterMs, edgeBlock: null, method: 'POST', path })
          : new RateLimitedError(service, retryAfterMs);
      }
      const envelope = parseEnvelope(text);
      const claim = (): Error | undefined =>
        opts.onErrorResponse?.({ status, headers: res.headers, body: text, envelope, write });
      if (envelope === undefined) {
        if (status >= 400 && status !== 401) {
          throw claim() ?? new UpstreamHttpError(status, formatApiError(status, 'POST', path, text, { service }));
        }
        if (status < 400) {
          const edge = detectEdgeBlock({ body: text, headers: res.headers, status });
          if (edge) throw edgeError(res, text, edge.vendor);
          const claimed = claim();
          if (claimed) throw claimed;
          throw new GraphqlResponseError(
            text.trim().length === 0
              ? `${service} GraphQL API returned an empty response (HTTP ${status}).`
              : `${service} GraphQL API returned a non-JSON body (HTTP ${status}) — this is usually a challenge or error page, not data.`,
            { status, hint: 'Retry shortly. If it persists, the endpoint or its request shape has changed.' },
          );
        }
      }
      const result: GraphqlResult<T> = { status, headers: res.headers, ...(envelope as Omit<GraphqlResult<T>, 'status' | 'headers'>) };
      if (!replayed && opts.onAuthError && isAuth(status, result.errors ?? [])) {
        await opts.onAuthError();
        continue;
      }
      if (status >= 400) {
        const claimed = claim();
        if (claimed) throw claimed;
      }
      return result;
    }
  }

  async function request<T = unknown>(
    query: string,
    variables?: Record<string, unknown>,
    more: Omit<GraphqlRequest, 'query' | 'variables'> = {},
  ): Promise<T> {
    const result = await execute<T>({ ...more, query, ...(variables !== undefined ? { variables } : {}) });
    const { status, data } = result;
    const errors = result.errors ?? [];
    const failed = errors.length > 0 || status >= 400 || data === undefined || data === null;
    if (failed && opts.mapError) {
      const mapped = opts.mapError({ status, errors, data });
      if (mapped) throw mapped;
    }
    if (isAuth(status, errors)) throw opts.onUnauthorized ? opts.onUnauthorized() : new UnauthorizedError(service);
    if (errors.length > 0) {
      const detail = errors.map((e) => (typeof e.message === 'string' && e.message ? e.message : 'Unknown error')).join('; ');
      throw new GraphqlResponseError(`${service} GraphQL error: ${truncateErrorMessage(detail)}`, {
        status,
        errors,
        data,
        ...(opts.errorHint !== undefined ? { hint: opts.errorHint } : {}),
      });
    }
    if (status >= 400) throw new UpstreamHttpError(status, `${service} GraphQL API returned HTTP ${status}.`);
    if (data === undefined || data === null) {
      throw new GraphqlResponseError(`${service} GraphQL API returned an empty response.`, { status });
    }
    return data;
  }

  return { execute, request };
}
