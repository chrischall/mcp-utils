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
  UnauthorizedError,
  UpstreamHttpError,
  detectEdgeBlock,
  formatApiError,
  parseRetryAfterMs,
  type RateLimitContext,
  type RetryPolicy,
} from '../http/index.js';
import { retryAfterToMs } from '../internal/retry-after.js';
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
  retry?: RetryPolicy;
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
  /** Injectable fetch. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for retries (tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** The client surface {@link createGraphqlClient} returns. */
export interface GraphqlClient {
  /**
   * Send a request and return its parsed envelope, `errors[]` and all — for a
   * raw passthrough tool that shows the caller what the server said. Still
   * throws for everything that is not a GraphQL answer: a transport failure,
   * a CDN/WAF refusal, an exhausted 429, or a body that is not a GraphQL
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

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY: RetryPolicy = { count: 1, delayMs: 2000 };
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.timeout ?? DEFAULT_TIMEOUT_MS;
  const retry = opts.retry ?? DEFAULT_RETRY;
  const retryStatuses = retry.statuses ?? [429];
  const isAuth = opts.isAuthError ?? isGraphqlAuthError;

  async function headersFor(req: GraphqlRequest): Promise<Record<string, string>> {
    const base = typeof opts.headers === 'function' ? await opts.headers() : (opts.headers ?? {});
    return { 'content-type': 'application/json', accept: 'application/json', ...base, ...req.headers };
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
    const work = (async () => {
      const res = await doFetch(opts.endpoint, { ...init, ...(signal ? { signal } : {}) });
      return { res, text: await res.text() };
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
      let sent: { res: Response; text: string };
      try {
        sent = await attempt({ method: 'POST', headers: await headersFor(req), body });
      } catch (err) {
        if (err instanceof TimedOut) throw transportError(err, true, write);
        if (err instanceof Error && err.name === 'AbortError') throw err; // the caller cancelled
        throw transportError(err, false, write);
      }
      const status = sent.res.status;
      const retryable = retryStatuses.includes(status) && (status === 429 || !write);
      if (retryable && tries < retry.count) {
        const delay = retry.honorRetryAfter
          ? parseRetryAfterMs(responseHeader(sent.res, 'retry-after'), {
              defaultMs: retry.delayMs,
              capMs: retry.maxRetryAfterMs ?? 30_000,
            })
          : retry.delayMs;
        await sleep(delay);
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
        if (edge) throw new EdgeBlockedError(status, edge.vendor, { service, method: 'POST', path });
      }
      if (status === 429) {
        const retryAfter = responseHeader(res, 'retry-after');
        const retryAfterMs = retryAfterToMs(retryAfter);
        throw opts.onRateLimited
          ? opts.onRateLimited({ status, retryAfter, retryAfterMs, edgeBlock: null, method: 'POST', path })
          : new RateLimitedError(service, retryAfterMs);
      }
      const envelope = parseEnvelope(text);
      if (envelope === undefined) {
        if (status >= 400 && status !== 401) {
          throw new UpstreamHttpError(status, formatApiError(status, 'POST', path, text, { service }));
        }
        if (status < 400) {
          const edge = detectEdgeBlock({ body: text, headers: res.headers, status });
          if (edge) throw new EdgeBlockedError(status, edge.vendor, { service, method: 'POST', path });
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
