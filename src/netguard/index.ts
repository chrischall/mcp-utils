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

// ---------------------------------------------------------------------------
// isPublicAddress
// ---------------------------------------------------------------------------

/**
 * Is this textual IP address one the public internet routes?
 *
 * `false` for everything else — and for anything that is not a well-formed
 * IPv4 dotted quad or IPv6 literal (a bracketed `[::1]`, a zone id
 * `fe80::1%eth0`, the `127.1` shorthand): a guard that admits what it does not
 * understand is the wrong default for this control.
 *
 * The ranges:
 *
 *   IPv4  0/8 this-network, 10/8 + 172.16/12 + 192.168/16 RFC 1918,
 *         100.64/10 CGNAT, 127/8 loopback, 169.254/16 link-local (the cloud
 *         metadata service), 192.0.0/24 protocol assignments, 192.0.2/24 +
 *         198.51.100/24 + 203.0.113/24 TEST-NET, 192.88.99/24 6to4 relay
 *         anycast, 198.18/15 benchmarking, 224/4 multicast, 240/4 reserved
 *         including broadcast.
 *   IPv6  ::/96 (unspecified, loopback, and the deprecated IPv4-compatible
 *         form — refused WHOLE, even around a public IPv4), 64:ff9b:1::/48
 *         local-use NAT64, 100::/64 discard, 2001::/32 Teredo, 2001:2::/48
 *         benchmarking, 2001:10::/28 + 2001:20::/28 ORCHID, 2001:db8::/32 +
 *         3fff::/20 documentation, 5f00::/16 SRv6, fc00::/7 ULA (Fly's 6PN
 *         `fdaa::/16` lives here), fe80::/10 link-local, fec0::/10
 *         site-local, ff00::/8 multicast.
 *   Embedded IPv4 — `::ffff:a.b.c.d` (mapped, what a dual-stack resolver
 *         returns for an A record), `::ffff:0:a.b.c.d` (SIIT), 64:ff9b::/96
 *         (NAT64) and 2002::/16 (6to4) — judged by the IPv4 they carry, so
 *         `::ffff:7f00:1` is loopback and `::ffff:8.8.8.8` is public.
 *
 * Consolidates accessoticketing-mcp `isPrivateAddress`, gemini-mcp
 * `isPrivateIpv4`/`isPrivateIpv6` and mcp-host `isPublicAddress`.
 */
export function isPublicAddress(ip: string): boolean {
  const v4 = parseIPv4(ip);
  if (v4) return isPublicIPv4(v4);
  const v6 = parseIPv6(ip);
  if (v6) return isPublicIPv6(v6);
  return false;
}

/** Four octets for a canonical dotted quad, else `undefined`. */
function parseIPv4(text: string): number[] | undefined {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) return undefined;
  const octets = text.split('.').map(Number);
  return octets.every((o) => o <= 255) ? octets : undefined;
}

/** 16 bytes, or `undefined` for anything that is not a well-formed IPv6 literal. */
function parseIPv6(text: string): number[] | undefined {
  if (!/^[0-9a-fA-F:.]+$/.test(text) || !text.includes(':')) return undefined;
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const groups = (part: string): number[] | undefined => {
    if (part === '') return [];
    const out: number[] = [];
    const pieces = part.split(':');
    for (const [i, piece] of pieces.entries()) {
      if (i === pieces.length - 1 && piece.includes('.')) {
        const v4 = parseIPv4(piece);
        if (!v4) return undefined;
        const [a = 0, b = 0, c = 0, d = 0] = v4;
        out.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return undefined;
      out.push(parseInt(piece, 16));
    }
    return out;
  };
  const head = groups(halves[0] ?? '');
  const tail = halves.length === 2 ? groups(halves[1] ?? '') : [];
  if (!head || !tail) return undefined;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return undefined;
  const words = [...head, ...new Array<number>(fill).fill(0), ...tail];
  const bytes: number[] = [];
  for (const w of words) bytes.push(w >> 8, w & 0xff);
  return bytes;
}

function inRange(bytes: readonly number[], prefix: readonly number[], bits: number): boolean {
  for (let i = 0; i < bits; i += 1) {
    const byte = i >> 3;
    const mask = 0x80 >> (i & 7);
    if (((bytes[byte] ?? 0) & mask) !== ((prefix[byte] ?? 0) & mask)) return false;
  }
  return true;
}

const BLOCKED_V4: ReadonlyArray<readonly [readonly number[], number]> = [
  [[0, 0, 0, 0], 8], // this network
  [[10, 0, 0, 0], 8], // RFC 1918
  [[100, 64, 0, 0], 10], // CGNAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local, incl. cloud metadata
  [[172, 16, 0, 0], 12], // RFC 1918
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // TEST-NET-1
  [[192, 88, 99, 0], 24], // 6to4 relay anycast (deprecated)
  [[192, 168, 0, 0], 16], // RFC 1918
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // TEST-NET-2
  [[203, 0, 113, 0], 24], // TEST-NET-3
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved + broadcast
];

function isPublicIPv4(octets: readonly number[]): boolean {
  return !BLOCKED_V4.some(([prefix, bits]) => inRange(octets, prefix, bits));
}

const V6 = (hex: string): number[] => parseIPv6(hex) as number[];
const BLOCKED_V6: ReadonlyArray<readonly [readonly number[], number]> = [
  [V6('::'), 96], // ::, ::1 and the deprecated IPv4-compatible form, refused whole
  [V6('64:ff9b:1::'), 48], // local-use NAT64 (RFC 8215)
  [V6('100::'), 64], // discard-only
  [V6('2001::'), 32], // Teredo
  [V6('2001:2::'), 48], // benchmarking
  [V6('2001:10::'), 28], // ORCHID (deprecated)
  [V6('2001:20::'), 28], // ORCHIDv2
  [V6('2001:db8::'), 32], // documentation
  [V6('3fff::'), 20], // documentation (RFC 9637)
  [V6('5f00::'), 16], // SRv6 SIDs
  [V6('fc00::'), 7], // unique local
  [V6('fe80::'), 10], // link-local
  [V6('fec0::'), 10], // site-local (deprecated)
  [V6('ff00::'), 8], // multicast
];
const MAPPED_V4 = V6('::ffff:0:0');
const SIIT_V4 = V6('::ffff:0:0:0');
const NAT64 = V6('64:ff9b::');
const SIX_TO_FOUR = V6('2002::');

function isPublicIPv6(bytes: readonly number[]): boolean {
  if (inRange(bytes, MAPPED_V4, 96) || inRange(bytes, SIIT_V4, 96) || inRange(bytes, NAT64, 96)) {
    return isPublicIPv4(bytes.slice(12, 16));
  }
  if (inRange(bytes, SIX_TO_FOUR, 16)) return isPublicIPv4(bytes.slice(2, 6));
  return !BLOCKED_V6.some(([prefix, bits]) => inRange(bytes, prefix, bits));
}

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
