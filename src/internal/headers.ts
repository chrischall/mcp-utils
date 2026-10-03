/**
 * Header reads that tolerate a response with no usable `headers`.
 *
 * A real `Response` always has a `Headers` object, but a hand-rolled test
 * double or a non-standard fetch shim may hand the library `{ status, text }`
 * and nothing else. Reading a header off that must mean "the header is
 * absent", never a TypeError that replaces the error the caller was about to
 * get (a RateLimitedError became "Cannot read properties of undefined" in
 * ioffice-mcp and splitwise-mcp after 2.13.0 started reading Retry-After).
 */

type MaybeHeaders = { get?: unknown; getSetCookie?: unknown } | null | undefined;

/** `headers.get(name)`, or `null` when there is no usable `headers`. */
export function responseHeader(res: { headers?: unknown } | null | undefined, name: string): string | null {
  return getHeader(res?.headers as MaybeHeaders, name);
}

/** `headers.get(name)` on a possibly-missing headers object. */
export function getHeader(headers: MaybeHeaders, name: string): string | null {
  if (!headers || typeof headers.get !== 'function') return null;
  const value: unknown = (headers.get as (n: string) => unknown).call(headers, name);
  return typeof value === 'string' ? value : null;
}

/** Every `Set-Cookie` value, preferring the spec'd `getSetCookie()`; `[]` when there are no headers. */
export function setCookiesOf(headers: MaybeHeaders): string[] {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') {
    const all: unknown = (headers.getSetCookie as () => unknown).call(headers);
    return Array.isArray(all) ? all.filter((c): c is string => typeof c === 'string') : [];
  }
  const raw = getHeader(headers, 'set-cookie');
  return raw ? [raw] : [];
}
