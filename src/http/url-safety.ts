/**
 * URL-safety atoms: confine where a credential-bearing request can go.
 *
 * Fleet audit 2026-09, clusters 5 and 6.
 *
 * Cluster 5 (alltrails, compass, eventbrite, flightaware, freshbooks, homes,
 * redfin, zillow): a tool argument interpolated into an API path steered an
 * authenticated GET somewhere else on the same host. The shared root cause is
 * that `encodeURIComponent('..') === '..'`, and URL normalisation then
 * resolves the dot segment — so even a repo that encoded every value (and
 * eventbrite forgot to on three tools) was exposed. {@link apiPath} encodes
 * each value AND refuses a value that is a dot segment; `createApiClient`
 * refuses any path that normalisation would rewrite ({@link findPathHazard}),
 * so a consumer that never adopts `apiPath` is covered too.
 *
 * Cluster 6 (groupon, ioffice, myhotlunchbox, schoolpass, workday,
 * accessoticketing, housecallpro, infinitecampus, flightaware, thumbtack,
 * gemini): a base-URL env override or a link taken from a tool / the upstream
 * was used without checking its scheme or host, so a session cookie or a
 * password could be sent over http or to any host. {@link readOriginEnv} and
 * {@link assertAllowedUrl} are the one check; `createApiClient`'s
 * `redirect: 'same-origin'` keeps a redirect from carrying the bearer off the
 * base origin.
 *
 * Errors here are value-free where the value could be a secret (an env var)
 * and name only the host where the value is a link (whose path and query may
 * carry a token).
 */

import { McpToolError } from '../errors/index.js';
import { readEnvVar } from '../config/index.js';
import type { EnvSource } from '../config/index.js';

// ---------------------------------------------------------------------------
// Dot segments
// ---------------------------------------------------------------------------

/** True for a WHATWG single- or double-dot path segment, in any `%2e` spelling. */
function isDotSegment(segment: string): boolean {
  const s = segment.replace(/%2e/gi, '.');
  return s === '.' || s === '..';
}

/**
 * Why URL normalisation would rewrite the path portion of `path` (everything
 * before the first `?` or `#`), or `undefined` when it would not: a dot
 * segment (`.`, `..`, `%2e%2e` and the mixed spellings) or a backslash (which
 * special schemes treat as `/`). The query and fragment are not judged.
 *
 * `createApiClient` refuses a path for which this returns a reason; exported
 * for hand-rolled clients that build URLs themselves.
 */
export function findPathHazard(path: string): 'dot segment' | 'backslash' | undefined {
  const end = path.search(/[?#]/);
  const pathPart = end === -1 ? path : path.slice(0, end);
  if (pathPart.includes('\\')) return 'backslash';
  if (pathPart.split('/').some(isDotSegment)) return 'dot segment';
  return undefined;
}

/** A value {@link apiPath} accepts as one path segment. */
export type ApiPathValue = string | number | bigint;

/**
 * Tagged template that builds an API path from trusted literal text and
 * untrusted values, encoding each value as exactly ONE path segment:
 *
 * ```ts
 * api.fetchJson('GET', apiPath`/trails/${id}/reviews`);
 * ```
 *
 * Each value goes through `encodeURIComponent` (so `/`, `?`, `#`, `\` and `%`
 * cannot add structure), and a value that is empty, `.` or `..` throws a
 * `TypeError` — `encodeURIComponent` leaves dots alone, so `..` would
 * otherwise survive encoding and be resolved by the URL parser. Only strings,
 * finite numbers and bigints are accepted; anything else is a programming
 * error and throws.
 *
 * The literal parts are not touched: they are the author's own.
 */
export function apiPath(strings: TemplateStringsArray, ...values: ApiPathValue[]): string {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i += 1) {
    const v: unknown = values[i];
    let text: string;
    if (typeof v === 'string') text = v;
    else if ((typeof v === 'number' && Number.isFinite(v)) || typeof v === 'bigint') text = String(v);
    else throw new TypeError(`apiPath: value ${i + 1} must be a string, a finite number or a bigint.`);
    if (text === '' || text === '.' || text === '..') {
      throw new TypeError(
        `apiPath: value ${i + 1} is ${text === '' ? 'empty' : `the dot segment "${text}"`}, which cannot be a path segment.`,
      );
    }
    out += encodeURIComponent(text) + (strings[i + 1] ?? '');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Origins and allowed hosts
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link readOriginEnv} and {@link assertAllowedUrl} when a URL is
 * refused. `reason` is a stable code for branching; the message never quotes
 * an env value, and for a link names only its host.
 */
export class UrlNotAllowedError extends McpToolError {
  readonly reason: 'invalid' | 'scheme' | 'insecure' | 'userinfo' | 'not-origin' | 'host';

  constructor(message: string, reason: UrlNotAllowedError['reason']) {
    super(message);
    this.name = 'UrlNotAllowedError';
    this.reason = reason;
  }
}

/**
 * A host allowlist entry: an exact hostname (case-insensitive), `*.suffix`
 * for any subdomain of `suffix` (not `suffix` itself), or a RegExp tested
 * against the lower-case hostname — anchor it (`/^eu\d\.example\.com$/`).
 */
export type AllowedHost = string | RegExp;

/** Scheme rules shared by {@link readOriginEnv} and {@link assertAllowedUrl}. */
export interface SchemeRules {
  /** Require `https:`. Default `true`. `false` allows `http:` to any host. */
  requireHttps?: boolean;
  /** With `requireHttps`, still allow `http:` to `localhost`, `127.0.0.0/8` and `[::1]` (local dev). Default `false`. */
  allowHttpLoopback?: boolean;
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function hostAllowed(hostname: string, allowHosts: readonly AllowedHost[]): boolean {
  const host = hostname.toLowerCase();
  return allowHosts.some((entry) => {
    if (entry instanceof RegExp) {
      entry.lastIndex = 0;
      return entry.test(host);
    }
    const e = entry.toLowerCase();
    if (e.startsWith('*.')) return host.endsWith(e.slice(1)) && host.length > e.length - 1;
    return host === e;
  });
}

/**
 * The checks both entry points share, on an already-parsed URL. `subject`
 * names what was checked in the message (the env key, or the link's host).
 */
function checkUrl(u: URL, subject: string, rules: SchemeRules & { allowHosts?: readonly AllowedHost[] }): void {
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new UrlNotAllowedError(`${subject} must be an http(s) URL.`, 'scheme');
  }
  if (u.protocol === 'http:' && (rules.requireHttps ?? true) && !(rules.allowHttpLoopback && isLoopback(u.hostname))) {
    throw new UrlNotAllowedError(`${subject} must use https.`, 'insecure');
  }
  if (u.username !== '' || u.password !== '') {
    throw new UrlNotAllowedError(`${subject} must not carry credentials (userinfo) in the URL.`, 'userinfo');
  }
  if (rules.allowHosts !== undefined && !hostAllowed(u.hostname, rules.allowHosts)) {
    throw new UrlNotAllowedError(`${subject} is not an allowed host for this service.`, 'host');
  }
}

/** Options for {@link readOriginEnv}. */
export interface ReadOriginEnvOptions extends SchemeRules {
  /** The source to read from. Defaults to `process.env`. */
  env?: EnvSource;
  /** Used when the variable is unset; checked by the same rules. */
  default?: string;
  /** When set, the host must match one of these. */
  allowHosts?: readonly AllowedHost[];
}

/**
 * Read a base-URL override from the environment and return its origin
 * (`https://host[:port]`, lower-cased, no trailing slash), hardened like
 * {@link readEnvVar} (blank / `'null'` / `${...}` placeholders are unset).
 *
 * Accepts a bare `host[:port]` (https is assumed) or an origin URL. Refuses
 * with {@link UrlNotAllowedError} — naming only the variable, never its value —
 * a value that:
 *  - is not http(s), or is `http:` while `requireHttps` (default `true`) holds
 *    (loopback excepted under `allowHttpLoopback`);
 *  - carries userinfo;
 *  - has a path, query or fragment (so a mangled `https://https://host` is
 *    refused instead of becoming host `https`);
 *  - names a host outside `allowHosts`, when given.
 *
 * Returns `opts.default` (checked by the same rules) or `undefined` when
 * unset.
 */
export function readOriginEnv(key: string, opts: ReadOriginEnvOptions & { default: string }): string;
export function readOriginEnv(key: string, opts?: ReadOriginEnvOptions): string | undefined;
export function readOriginEnv(key: string, opts: ReadOriginEnvOptions = {}): string | undefined {
  const raw = readEnvVar(key, opts.env ? { env: opts.env } : {});
  const value = raw ?? opts.default;
  if (value === undefined) return undefined;
  const subject = raw === undefined ? `The default for ${key}` : `The environment variable ${key}`;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[^:/]+:\d+$/.test(value) ? value : `https://${value}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new UrlNotAllowedError(`${subject} is not a valid URL or host.`, 'invalid');
  }
  checkUrl(u, subject, opts);
  if (u.pathname !== '/' || u.search !== '' || u.hash !== '' || /[?#]$/.test(value)) {
    throw new UrlNotAllowedError(
      `${subject} must be an origin (scheme://host[:port]) with no path, query or fragment.`,
      'not-origin',
    );
  }
  return u.origin;
}

/** Options for {@link assertAllowedUrl}. */
export interface AssertAllowedUrlOptions extends SchemeRules {
  /** Hosts the URL may point at. Must be non-empty. */
  allowHosts: readonly AllowedHost[];
}

/**
 * Check a URL that came from a tool argument or an upstream response before
 * sending anything — a cookie, a token, a password — to it. Returns the
 * parsed `URL`; throws {@link UrlNotAllowedError} (naming the host, never the
 * path or query) when it is not http(s), is `http:` while `requireHttps`
 * (default `true`) holds, carries userinfo, or its host is not in
 * `allowHosts`. Re-check every redirect hop you follow by hand.
 */
export function assertAllowedUrl(url: string | URL, opts: AssertAllowedUrlOptions): URL {
  if (opts.allowHosts.length === 0) throw new TypeError('assertAllowedUrl: allowHosts must not be empty.');
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    throw new UrlNotAllowedError('The link is not a valid URL.', 'invalid');
  }
  checkUrl(u, `The link to ${u.host || u.protocol}`, opts);
  return u;
}

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

/**
 * Thrown by `createApiClient({ redirect: 'same-origin' })` when a redirect
 * points off the base origin (or adds userinfo), or the hop limit is reached.
 * Nothing is sent to the refused target. The message names only the target's
 * origin.
 */
export class RedirectRefusedError extends McpToolError {
  constructor(message: string) {
    super(message);
    this.name = 'RedirectRefusedError';
  }
}
