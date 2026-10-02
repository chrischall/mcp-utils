/**
 * Internal (not exported from any entry point): read a `Retry-After` header as
 * the wait it asks for, in ms, for the rate-limit context the HTTP and GraphQL
 * clients hand to `onRateLimited`.
 *
 * Unlike `parseRetryAfterMs` (which picks a SLEEP, so it defaults and caps),
 * this REPORTS what the upstream said: delta-seconds or an HTTP-date (clamped
 * at 0 once past), uncapped, and `undefined` when the header is absent or
 * unparseable — a caller should be able to tell "no hint" from "0".
 */
export function retryAfterToMs(header: string | null | undefined, now: number = Date.now()): number | undefined {
  if (header == null) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  // An HTTP-date always names a weekday ("Wed, 21 Oct 2015 07:28:00 GMT");
  // requiring a letter keeps `Date.parse` from reading "-5" or "2" as a year.
  if (!/^[A-Za-z]/.test(trimmed)) return undefined;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}
