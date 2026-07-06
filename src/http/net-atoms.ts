/**
 * Small HTTP/network atoms shared across the fleet: `Retry-After` parsing
 * (getyourguide / musicbrainz / viator / tripadvisor), host splitting
 * (workday's multi-datacenter subdomains), descriptive User-Agent lines
 * (musicbrainz / getyourguide — rate-limited public APIs block generic UAs),
 * and RFC 6266 `Content-Disposition` filename extraction (ofw downloads).
 */

/** Options for {@link parseRetryAfterMs}. */
export interface ParseRetryAfterOptions {
  /** Delay when the header is missing or unparseable. Defaults to 2000 ms. */
  defaultMs?: number;
  /** Upper bound on the honored delay. Defaults to 30 000 ms. */
  capMs?: number;
}

/**
 * Parse an RFC 9110 `Retry-After` header (the delta-seconds form) into a
 * bounded delay in milliseconds. Missing / non-numeric / negative values fall
 * back to `defaultMs` **verbatim** — `capMs` bounds only header-derived delays
 * (an upstream asking for a 10-minute wait shouldn't pin a tool call open, but
 * the caller's own configured fallback is trusted as-is). The HTTP-date form
 * is not parsed (no donor upstream uses it) and falls back to the default.
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  opts: ParseRetryAfterOptions = {},
): number {
  const defaultMs = opts.defaultMs ?? 2000;
  const capMs = opts.capMs ?? 30_000;
  if (header == null) return defaultMs;
  const trimmed = header.trim();
  if (!/^\d+$/.test(trimmed)) return defaultMs;
  return Math.min(Number(trimmed) * 1000, capMs);
}

/** Result of {@link splitHost}. */
export interface SplitHost {
  /** The registrable-ish domain: the last two labels (or the whole host when ≤ 2 labels). */
  domain: string;
  /** Everything left of the domain, when present (`'wd5'`, `'a.b'`). */
  subdomain?: string;
}

/**
 * Split a hostname into `{ domain, subdomain? }` where `domain` is the last
 * two labels: `wd5.myworkday.com` → `{ domain: 'myworkday.com', subdomain:
 * 'wd5' }`. Hosts with ≤ 2 labels return just `{ domain }`. Consolidates
 * workday's `splitHost`, which computes a fetchproxy transport's
 * `domains`/`defaultSubdomain` pair from the configured host. (Naive
 * two-label split — public-suffix domains like `.co.uk` aren't special-cased;
 * no fleet upstream lives on one.)
 */
export function splitHost(host: string): SplitHost {
  const labels = host.split('.');
  if (labels.length <= 2) return { domain: host };
  return {
    domain: labels.slice(-2).join('.'),
    subdomain: labels.slice(0, -2).join('.'),
  };
}

/**
 * Build the descriptive `User-Agent` a rate-limited public API expects:
 * `name/version (+contactUrl)`. MusicBrainz-style APIs block empty/generic
 * UAs, so every fleet client should send one of these.
 */
export function buildUserAgent(name: string, version: string, contactUrl?: string): string {
  return contactUrl ? `${name}/${version} (+${contactUrl})` : `${name}/${version}`;
}

/**
 * Extract the filename from a `Content-Disposition` header, preferring the
 * RFC 6266 `filename*=UTF-8''percent-encoded` form over the quoted
 * `filename="…"` fallback (matching ofw's download path). Returns `undefined`
 * when the header is missing or carries no filename.
 */
export function parseContentDispositionFilename(
  header: string | null | undefined,
): string | undefined {
  if (!header) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // Malformed percent-encoding — fall through to the quoted form.
    }
  }
  const quoted = /filename\s*=\s*"([^"]+)"/.exec(header);
  if (quoted?.[1]) return quoted[1];
  const bare = /filename\s*=\s*([^;\s]+)/.exec(header);
  return bare?.[1];
}
