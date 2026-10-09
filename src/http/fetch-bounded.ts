/**
 * `fetchBounded` — one bounded `fetch` for the clients that cannot use
 * {@link createApiClient}.
 *
 * Fleet audit 2026-09, cluster 1: about twenty servers call `fetch` bare —
 * cookie scrapers, multi-host clients, HTML/RSC readers and file downloads,
 * none of which fit a single-base bearer client. Each one hand-rolled (or
 * forgot) the same four things, and the audit found every combination
 * missing: no timeout (a hung upstream holds the tool call until the host
 * kills it), no cancellation (a cancelled call keeps its request in flight),
 * a timeout that stops at the headers (a body that stalls afterwards is
 * unbounded — #534, #584, #783), and no size cap (#989 and #1026 buffer
 * whole downloads into memory).
 *
 * `createApiClient` already had every piece internally; this exports them as
 * one call:
 *  - a timer (default {@link DEFAULT_REQUEST_TIMEOUT_MS}, 30 s) that stays
 *    armed until the body has been read, raced rather than trusted to the
 *    stream, so a custom `fetchImpl` whose body ignores the abort is bounded
 *    too;
 *  - the caller's cancellation — `init.signal` and the ambient tool-call
 *    signal ({@link currentCallSignal}) — folded in, either one firing aborts;
 *  - an optional `maxBytes` cap, checked against `Content-Length` before any
 *    read and counted while streaming;
 *  - a typed body read (`text`, `json`, `bytes`, or `none`).
 *
 * It does NOT judge the status: a 404 or a 500 comes back like a 200, body
 * read and bounded, because these clients each have their own idea of what a
 * non-2xx means (a login redirect, an edge block, a soft miss).
 */

import { withAmbientCancellation } from '../cancel/index.js';
import { McpToolError } from '../errors/index.js';
import { DEFAULT_REQUEST_TIMEOUT_MS, RequestTimeoutError } from './index.js';

/** How {@link fetchBounded} reads the body. */
export type BoundedRead = 'text' | 'json' | 'bytes' | 'none';

/** The body type {@link fetchBounded} returns for each {@link BoundedRead}. */
export type BoundedBody<R extends BoundedRead> = R extends 'json'
  ? unknown
  : R extends 'bytes'
    ? Uint8Array
    : R extends 'none'
      ? undefined
      : string;

/** Options for {@link fetchBounded}. */
export interface FetchBoundedOptions<R extends BoundedRead = 'text'> {
  /**
   * Milliseconds from the request until the body has been read. Defaults to
   * {@link DEFAULT_REQUEST_TIMEOUT_MS} (30 s). `0` or `false` disables the
   * timer; the caller's cancellation still applies. Expiry throws
   * {@link RequestTimeoutError}.
   */
  timeoutMs?: number | false;
  /**
   * Largest body, in bytes, this call will read. A `Content-Length` over it
   * is refused before reading; a body that grows past it is cancelled as soon
   * as it does. Either way {@link ResponseTooLargeError}. Omit for no cap.
   * Not consulted for `read: 'none'`, which reads nothing.
   */
  maxBytes?: number;
  /**
   * How to read the body. `'text'` (default) decodes UTF-8; `'json'` parses
   * it (an empty body is `undefined`; an unparseable one is an
   * {@link McpToolError} that never echoes the body); `'bytes'` returns a
   * `Uint8Array`; `'none'` cancels the body unread and returns `undefined` —
   * for a status/headers check. A caller that must stream the body itself
   * should call `fetch` with `signal: currentCallSignal()` instead.
   */
  read?: R;
  /** Name of the upstream in error messages. Defaults to the URL's host. */
  service?: string;
  /** Injectable fetch (defaults to the global `fetch`) — for tests. */
  fetchImpl?: typeof fetch;
}

/** What {@link fetchBounded} resolves to. */
export interface BoundedResponse<B> {
  /** The response. Its body has already been consumed (or cancelled). */
  res: Response;
  /** `res.status`. */
  status: number;
  /** `res.ok`. */
  ok: boolean;
  /** `res.headers`. */
  headers: Headers;
  /** The body, read as {@link FetchBoundedOptions.read} asked. */
  body: B;
}

/** Thrown by {@link fetchBounded} when a body is larger than `maxBytes`. */
export class ResponseTooLargeError extends Error {
  readonly maxBytes: number;
  constructor(service: string, maxBytes: number) {
    super(`Response from ${service} is larger than the ${maxBytes}-byte limit.`);
    this.name = 'ResponseTooLargeError';
    this.maxBytes = maxBytes;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * `fetch` with a timeout that covers the body read, the caller's
 * cancellation (`init.signal` + the ambient tool-call signal), an optional
 * byte cap, and a typed body read. See the module header for why.
 *
 * Errors: {@link RequestTimeoutError} when the timer fires; the caller's own
 * abort reason (as an `Error`) when the caller cancels;
 * {@link ResponseTooLargeError} over `maxBytes`; an {@link McpToolError} for
 * unparseable JSON; anything else `fetch` throws, unchanged.
 */
export async function fetchBounded<R extends BoundedRead = 'text'>(
  url: string | URL,
  init?: RequestInit,
  opts: FetchBoundedOptions<R> = {},
): Promise<BoundedResponse<BoundedBody<R>>> {
  const doFetch = opts.fetchImpl ?? fetch;
  const service = opts.service ?? hostOf(url);
  const read: BoundedRead = opts.read ?? 'text';
  const timeoutMs = opts.timeoutMs === false ? 0 : (opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

  // The caller's side: its own signal and the ambient tool-call signal.
  const caller = withAmbientCancellation(init?.signal ?? undefined);
  if (caller?.aborted) throw reasonOf(caller);

  const timer = timeoutMs > 0 ? new AbortController() : undefined;
  const signal = combine(timer?.signal, caller);
  let handle: ReturnType<typeof setTimeout> | undefined;
  let detach = (): void => {};
  // Rejects the moment either side gives up; raced against every await.
  const stop = signal
    ? new Promise<never>((_resolve, reject) => {
        const onAbort = (): void =>
          reject(timer?.signal.aborted ? new RequestTimeoutError(service, timeoutMs) : reasonOf(caller!));
        signal.addEventListener('abort', onAbort, { once: true });
        detach = () => signal.removeEventListener('abort', onAbort);
      })
    : undefined;
  stop?.catch(() => {});
  const bounded = <T>(p: Promise<T>): Promise<T> => (stop ? Promise.race([p, stop]) : p);
  if (timer) handle = setTimeout(() => timer.abort(), timeoutMs);

  try {
    let res: Response;
    try {
      res = await bounded(doFetch(url, { ...init, ...(signal ? { signal } : {}) }));
    } catch (err) {
      // An abort surfaces from fetch as an AbortError whichever side caused
      // it; name it by WHICH side fired, so a caller's cancellation is never
      // reported as this upstream timing out.
      if (timer?.signal.aborted) throw new RequestTimeoutError(service, timeoutMs);
      if (caller?.aborted) throw reasonOf(caller);
      throw err;
    }

    if (read === 'none') {
      cancelBody(res.body);
      return done(res, undefined);
    }

    const bytes = await readBytes(res, opts.maxBytes, service, bounded);
    if (read === 'bytes') return done(res, bytes);
    const text = new TextDecoder().decode(bytes);
    if (read === 'text') return done(res, text);
    if (text.length === 0) return done(res, undefined);
    try {
      return done(res, JSON.parse(text) as unknown);
    } catch (cause) {
      const type = res.headers.get('content-type') ?? 'no content-type';
      throw new McpToolError(`${service} returned a non-JSON response (HTTP ${res.status}, ${type}).`, {
        hint: 'The upstream may have served an error or sign-in page instead of data.',
        cause,
      });
    }
  } finally {
    clearTimeout(handle);
    detach();
  }

  function done(res: Response, body: unknown): BoundedResponse<BoundedBody<R>> {
    return { res, status: res.status, ok: res.ok, headers: res.headers, body: body as BoundedBody<R> };
  }
}

/**
 * Read `res`'s body under `bounded`, refusing more than `maxBytes`. On any
 * failure — the cap, the timer, the caller — the stream is cancelled so its
 * connection is released rather than held until GC.
 */
async function readBytes(
  res: Response,
  maxBytes: number | undefined,
  service: string,
  bounded: <T>(p: Promise<T>) => Promise<T>,
): Promise<Uint8Array> {
  if (maxBytes !== undefined) {
    const declared = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) {
      cancelBody(res.body);
      throw new ResponseTooLargeError(service, maxBytes);
    }
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await bounded(reader.read());
      if (done) break;
      total += value.byteLength;
      if (maxBytes !== undefined && total > maxBytes) throw new ResponseTooLargeError(service, maxBytes);
      chunks.push(value);
    }
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Release a body unread. Never throws: a custom body may be odd. */
function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  try {
    body?.cancel().catch(() => {});
  } catch {
    // Nothing left to release.
  }
}

/** One signal for "either fired", or whichever exists. */
function combine(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  if (a && b) return AbortSignal.any([a, b]);
  return a ?? b;
}

/** The signal's own reason as an Error, as `throwIfCancelled` reports it. */
function reasonOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error(String(reason));
}

function hostOf(url: string | URL): string {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}
