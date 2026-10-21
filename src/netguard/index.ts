/**
 * SSRF guard for fetching a URL somebody else chose — a link from a tool
 * argument, an email click-tracker, an `images_url`, every redirect any of
 * them issue — so it can only reach the public internet.
 *
 * Fleet audit 2026-09-24 (chrischall/fleet-audit#1150). Three repos had grown
 * three copies of the same table and none closed the gap the audit named:
 *
 *  - accessoticketing-mcp `src/netguard.ts` resolved the name, checked every
 *    address, then let `fetch` resolve it AGAIN — so a DNS-rebinding name
 *    could answer public at check time and `169.254.169.254` at connect time
 *    (its own header comment said so) — and its redirect loop ran
 *    `hops <= MAX_REDIRECTS`, i.e. eleven requests for a limit of ten;
 *  - gemini-mcp `src/fetch-image.ts` judged only IP LITERALS ("closing
 *    [rebinding] needs resolve-then-pin, which neither Node's nor workerd's
 *    fetch exposes"), so any name pointing inward passed;
 *  - mcp-host `packages/core/src/egress.ts` had the most complete table, and
 *    the pin, but inside its own CONNECT proxy.
 *
 * This module is the one table and the pin:
 *
 *  - {@link isPublicAddress} — one IPv4 + IPv6 block table (private,
 *    loopback, link-local / cloud metadata, CGNAT, ULA, multicast, reserved,
 *    documentation, and the forms that EMBED an IPv4 judged by that IPv4).
 *    Hand-parsed rather than `node:net`, and FAILS CLOSED on anything it
 *    cannot parse.
 *  - {@link createPublicOnlyDispatcher} — an undici `Agent` whose connector
 *    resolves the name itself (injectable resolver), refuses the connection
 *    with `UrlNotAllowedError` when ANY address is not public, and hands the
 *    socket exactly the addresses it vetted. There is no second resolution,
 *    so there is no lookup-to-connect window to rebind in. An IP-literal host
 *    (which Node never looks up) is judged directly.
 *  - {@link fetchPublic} — `fetch` through that dispatcher with MANUAL
 *    redirects: `assertAllowedUrl` on the first URL and on every hop, at most
 *    `maxRedirects` follow-up requests (so `maxRedirects + 1` requests in
 *    all), credential headers dropped on a cross-origin hop, one deadline
 *    over the whole exchange, and an optional byte cap.
 *
 * A SUBPATH (`@chrischall/mcp-utils/netguard`), never the root barrel: it
 * imports `undici` (an optional peer), and only the few servers that fetch
 * third-party URLs should have to install it.
 *
 * TLS still validates the certificate against the NAME (undici sets SNI /
 * `servername` from the URL host), so pinning the address costs no
 * certificate checking.
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Agent, buildConnector, fetch as undiciFetch, Headers } from 'undici';
import type { Dispatcher, RequestInit as UndiciRequestInit } from 'undici';
import { McpToolError } from '../errors/index.js';
import {
  assertAllowedUrl,
  RedirectRefusedError,
  RequestTimeoutError,
  UrlNotAllowedError,
  type AllowedHost,
} from '../http/index.js';
import { readBytesCapped } from '../http/body-limit.js';
import { isPublicAddress } from './address.js';

// isPublicAddress lives in ./address.ts (no imports) so http can share it.
export { isPublicAddress };

// ---------------------------------------------------------------------------
// createPublicOnlyDispatcher
// ---------------------------------------------------------------------------

/**
 * Resolves a hostname to every address it has. Injectable so tests never
 * touch DNS (the same shape as accessoticketing-mcp's `Lookup`).
 */
export type Resolver = (hostname: string) => Promise<string[]>;

/** The default {@link Resolver}: the OS resolver, every address, in resolver order. */
export const systemResolver: Resolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/** Options for {@link createPublicOnlyDispatcher}. */
export interface PublicOnlyDispatcherOptions {
  /** How a name becomes addresses. Default {@link systemResolver}. */
  resolve?: Resolver;
  /**
   * Which addresses may be connected to. Default {@link isPublicAddress}.
   * Widen it only deliberately (a test server on loopback; an allowlisted
   * internal range) — every address a name resolves to must pass.
   */
  isAllowedAddress?: (ip: string) => boolean;
  /** Passed through to undici's `Agent` (timeouts, pool sizes, …). `connect` is owned by this function. */
  agent?: Omit<Agent.Options, 'connect'>;
  /** Passed through to undici's `buildConnector` (TLS options, connect timeout, …). `lookup` is owned by this function. */
  connect?: Omit<buildConnector.BuildOptions, 'lookup'>;
}

function refuseHost(hostname: string): UrlNotAllowedError {
  return new UrlNotAllowedError(
    `Refusing to connect to ${hostname}: it is, or resolves to, a private, loopback, link-local or reserved address.`,
    'host',
  );
}

/**
 * An undici `Agent` that can only connect to public addresses.
 *
 * Its connector resolves each new connection's host with `resolve`, refuses
 * the connection with `UrlNotAllowedError` (reason `'host'`, naming the host —
 * never the address it resolved to) when the name resolves to nothing or ANY
 * address fails `isAllowedAddress`, and gives the socket exactly the addresses
 * it checked. Node never resolves the name a second time, which closes the
 * lookup-to-connect DNS-rebinding window a check-then-`fetch` guard leaves
 * open. An IP-literal host is judged as itself and never resolved.
 *
 * Use it as the `dispatcher` of undici's `fetch`/`request` (or via
 * {@link fetchPublic}). Close it (`await agent.close()`) when done.
 */
export function createPublicOnlyDispatcher(opts: PublicOnlyDispatcherOptions = {}): Agent {
  const resolve = opts.resolve ?? systemResolver;
  const allowed = opts.isAllowedAddress ?? isPublicAddress;

  const lookup: LookupFunction = (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || !addresses.every(allowed)) {
          callback(refuseHost(hostname), '', 0);
          return;
        }
        const entries = addresses.map((address) => ({ address, family: isIP(address) }));
        if (options.all) {
          (callback as unknown as (err: null, all: typeof entries) => void)(null, entries);
          return;
        }
        const wanted = options.family === 4 || options.family === 6 ? options.family : 0;
        const pick = entries.find((e) => wanted === 0 || e.family === wanted) ?? entries[0]!;
        callback(null, pick.address, pick.family);
      },
      (err: unknown) => callback(err as NodeJS.ErrnoException, '', 0),
    );
  };

  const inner = buildConnector({ ...opts.connect, lookup } as buildConnector.BuildOptions);
  const connect: buildConnector.connector = (options, callback) => {
    const host = options.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) !== 0 && !allowed(host)) {
      callback(refuseHost(options.hostname), null);
      return;
    }
    inner(options, callback);
  };
  return new Agent({ ...opts.agent, connect });
}

// ---------------------------------------------------------------------------
// fetchPublic
// ---------------------------------------------------------------------------

/** Options for {@link fetchPublic}: undici `RequestInit` (minus what it owns) plus the guard's own. */
export interface FetchPublicOptions
  extends Omit<UndiciRequestInit, 'redirect' | 'dispatcher' | 'signal' | 'window'>,
    Pick<PublicOnlyDispatcherOptions, 'resolve' | 'isAllowedAddress'> {
  /**
   * Redirect follow-ups allowed — at most this many requests after the first,
   * so `maxRedirects + 1` in all. A redirect past the limit is refused
   * (`RedirectRefusedError`) without being requested. Default 10; 0 refuses
   * every redirect.
   */
  maxRedirects?: number;
  /** One deadline over every hop and the body read. Omit for none. Throws `RequestTimeoutError`. */
  timeoutMs?: number;
  /** Byte cap on the final body; over it throws `ResponseTooLargeError`. Omit for none. */
  maxBytes?: number;
  /** The caller's cancellation; an abort rejects with its reason. */
  signal?: AbortSignal;
  /**
   * The dispatcher to send through. Default: a fresh
   * {@link createPublicOnlyDispatcher} built from `resolve` /
   * `isAllowedAddress`, destroyed when the call settles. One you pass is used
   * as-is and left open — it must be public-only itself.
   */
  dispatcher?: Dispatcher;
  /** Require `https:` on the first URL and every hop. Default `true` (as `assertAllowedUrl`). */
  requireHttps?: boolean;
  /** When given, every hop's host must match (as `assertAllowedUrl`'s `allowHosts`). */
  allowHosts?: readonly AllowedHost[];
  /**
   * Asked about the first URL and every redirect target BEFORE it is
   * requested; `true` returns `{ stopped: true, url, hops }` without fetching
   * it — e.g. a click-tracker resolver stopping at the first link on its own
   * service. The target has already passed `assertAllowedUrl`.
   */
  stopBefore?: (url: URL) => boolean;
}

/** A {@link fetchPublic} that ran to a final response. */
export interface PublicFetchResponse {
  stopped: false;
  /** The URL of the final response (after redirects). */
  url: string;
  /** Redirects followed. */
  hops: number;
  status: number;
  headers: Headers;
  body: Uint8Array;
}

/** A {@link fetchPublic} that `stopBefore` ended before requesting `url`. */
export interface PublicFetchStopped {
  stopped: true;
  /** The URL `stopBefore` stopped at — not requested. */
  url: string;
  /** Redirects followed to reach it. */
  hops: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CROSS_ORIGIN_DROPPED = ['authorization', 'cookie', 'proxy-authorization'];

function findUrlRefusal(err: unknown): UrlNotAllowedError | undefined {
  let e: unknown = err;
  for (let i = 0; i < 8 && e; i += 1) {
    if (e instanceof UrlNotAllowedError) return e;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * `fetch` a URL somebody else chose, reaching only public addresses.
 *
 * Every request goes through a {@link createPublicOnlyDispatcher} (so a name
 * that resolves — or REBINDS — inward is refused at connect), redirects are
 * followed by hand with `assertAllowedUrl` on each target and at most
 * `maxRedirects` follow-ups, and credential headers (`authorization`,
 * `cookie`, `proxy-authorization`) are dropped once a hop leaves the
 * original origin. 303 (and 301/302 after a POST) becomes a body-less GET, as
 * in the Fetch standard; 307/308 resend the method and body (a stream body
 * cannot be resent — pass bytes or a string if the target may 307).
 *
 * Returns the final response's status, headers and body bytes (capped by
 * `maxBytes`). A 3xx with no `Location` is a final response. Throws
 * `UrlNotAllowedError` for a refused URL or address, `RedirectRefusedError`
 * past the limit, `RequestTimeoutError` past `timeoutMs`,
 * `ResponseTooLargeError` past `maxBytes`, the caller's abort reason, and an
 * `McpToolError` of kind `'transport'` (naming only the host) when the host
 * cannot be reached.
 */
export function fetchPublic(
  url: string | URL,
  opts: FetchPublicOptions & { stopBefore: (url: URL) => boolean },
): Promise<PublicFetchResponse | PublicFetchStopped>;
export function fetchPublic(url: string | URL, opts?: Omit<FetchPublicOptions, 'stopBefore'>): Promise<PublicFetchResponse>;
export async function fetchPublic(
  url: string | URL,
  opts: FetchPublicOptions = {},
): Promise<PublicFetchResponse | PublicFetchStopped> {
  const {
    maxRedirects = 10,
    timeoutMs,
    maxBytes,
    signal: callerSignal,
    dispatcher: given,
    requireHttps,
    allowHosts,
    stopBefore,
    resolve,
    isAllowedAddress,
    headers: initHeaders,
    method: initMethod,
    body: initBody,
    ...init
  } = opts;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0) {
    throw new TypeError('fetchPublic: maxRedirects must be a non-negative integer.');
  }

  const check = (target: string | URL): URL =>
    assertAllowedUrl(target, {
      allowHosts: allowHosts ?? [/(?:)/],
      ...(requireHttps !== undefined ? { requireHttps } : {}),
    });

  let current = check(url);
  const origin = current.origin;
  if (stopBefore?.(current)) return { stopped: true, url: current.href, hops: 0 };

  const timeout = timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined;
  const signals = [callerSignal, timeout].filter((s): s is AbortSignal => s !== undefined);
  const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;

  const owned =
    given === undefined
      ? createPublicOnlyDispatcher({
          ...(resolve ? { resolve } : {}),
          ...(isAllowedAddress ? { isAllowedAddress } : {}),
        })
      : undefined;
  const dispatcher = given ?? owned!;

  let method = (initMethod ?? 'GET').toUpperCase();
  let body = initBody;
  const headers = new Headers(initHeaders);

  const fail = (err: unknown): never => {
    if (callerSignal?.aborted) throw callerSignal.reason;
    if (timeout?.aborted) throw new RequestTimeoutError(current.host, timeoutMs!);
    const refused = findUrlRefusal(err);
    if (refused) throw refused;
    if (err instanceof McpToolError) throw err;
    throw new McpToolError(`Could not reach ${current.host}.`, {
      kind: 'transport',
      hint: 'Check the link is reachable from the server.',
      cause: err,
    });
  };

  try {
    for (let hops = 0; ; ) {
      let res: Awaited<ReturnType<typeof undiciFetch>>;
      try {
        res = await undiciFetch(current, {
          ...init,
          method,
          headers,
          ...(body !== undefined && body !== null ? { body } : {}),
          redirect: 'manual',
          dispatcher,
          ...(signal ? { signal } : {}),
        });
      } catch (err) {
        return fail(err);
      }

      const location = REDIRECT_STATUSES.has(res.status) ? res.headers.get('location') : null;
      if (location === null) {
        let bytes: Uint8Array;
        try {
          bytes = await readBytesCapped(res as unknown as Response, maxBytes, current.host, (p) => p);
        } catch (err) {
          return fail(err);
        }
        return { stopped: false, url: current.href, hops, status: res.status, headers: res.headers, body: bytes };
      }

      await res.body?.cancel().catch(() => {});
      if (hops >= maxRedirects) {
        throw new RedirectRefusedError(`Refusing to follow more than ${maxRedirects} redirects (last from ${current.host}).`);
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new UrlNotAllowedError('The redirect target is not a valid URL.', 'invalid');
      }
      next = check(next);
      hops += 1;

      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        if (method !== 'HEAD') method = 'GET';
        body = undefined;
        for (const h of ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location']) {
          headers.delete(h);
        }
      }
      if (next.origin !== origin) for (const h of CROSS_ORIGIN_DROPPED) headers.delete(h);

      current = next;
      if (stopBefore?.(current)) return { stopped: true, url: current.href, hops };
    }
  } finally {
    if (owned) await owned.destroy().catch(() => {});
  }
}
