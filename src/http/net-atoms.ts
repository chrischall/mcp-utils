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
 * Split a `Content-Disposition` header into its parameters (names lowercased,
 * first occurrence wins), honouring quoted strings and their backslash
 * escapes. A single left-to-right scan — no backtracking regex — so a hostile
 * header costs linear time.
 */
function dispositionParams(header: string): Map<string, string> {
  const params = new Map<string, string>();
  const n = header.length;
  // Normally `type; params`. A non-compliant header that skips the type
  // (`filename="x.pdf"`) starts with a parameter instead: begin before it.
  const firstSemi = header.indexOf(';');
  const firstEq = header.indexOf('=');
  let i = firstEq >= 0 && (firstSemi < 0 || firstEq < firstSemi) ? -1 : firstSemi;
  if (i < 0 && firstEq < 0) return params;
  // The next '=' is cached and only searched for again once passed, so a run
  // of valueless tokens (`;;;;…`) cannot make each step rescan to a far '='.
  let eq = firstEq;
  while (i < n) {
    i += 1; // past the ';'
    if (eq >= 0 && eq < i) eq = header.indexOf('=', i);
    if (eq < 0) break; // no '=' left: no more parameters
    const semi = header.indexOf(';', i);
    if (semi >= 0 && semi < eq) {
      // A valueless token (`; foo;`) — skip to the next parameter.
      i = semi;
      continue;
    }
    const name = header.slice(i, eq).trim().toLowerCase();
    let j = eq + 1;
    while (j < n && (header[j] === ' ' || header[j] === '\t')) j += 1;
    let value = '';
    if (header[j] === '"') {
      j += 1;
      while (j < n && header[j] !== '"') {
        if (header[j] === '\\' && j + 1 < n) j += 1;
        value += header[j];
        j += 1;
      }
      const next = header.indexOf(';', j);
      i = next < 0 ? n : next;
    } else {
      const next = header.indexOf(';', j);
      const stop = next < 0 ? n : next;
      value = header.slice(j, stop).trim();
      i = stop;
    }
    if (name && !params.has(name)) params.set(name, value);
  }
  return params;
}

/** Percent-decode `s` as ISO-8859-1 bytes; throws on a malformed escape like `decodeURIComponent`. */
function decodeLatin1(s: string): string {
  return s.replace(/%([0-9A-Fa-f]{2})|%/g, (m, hex: string | undefined) => {
    if (hex === undefined) throw new URIError('malformed percent-encoding');
    return String.fromCharCode(parseInt(hex, 16));
  });
}

/**
 * Extract the filename from a `Content-Disposition` header. Returns
 * `undefined` when the header is missing or names no (non-empty) file.
 *
 * Order, per RFC 6266: the extended `filename*=` (RFC 8187
 * `charset'lang'percent-encoded`; the charset prefix is optional, `UTF-8` and
 * `ISO-8859-1` are decoded, quotes some servers wrap it in are dropped), then
 * the plain `filename=` (quoted, with backslash escapes, or a bare token). A
 * `filename*=` whose percent-encoding is broken loses to a plain `filename=`
 * and is otherwise returned raw rather than dropped. Parameter names are
 * case-insensitive and matched whole, so `xfilename=` is not a filename.
 *
 * Widened to ofw-mcp's local parser (its pinned cases: no charset prefix, raw
 * fallback, unquoted legacy form) — chrischall/fleet-audit#1076. The result is
 * an untrusted upstream string: confine any path built from it.
 */
export function parseContentDispositionFilename(
  header: string | null | undefined,
): string | undefined {
  if (!header) return undefined;
  const params = dispositionParams(header);
  let rawExt: string | undefined;
  const ext = params.get('filename*');
  if (ext !== undefined) {
    const parts = /^([^']*)'[^']*'([\s\S]*)$/.exec(ext);
    const charset = (parts?.[1] ?? '').trim().toLowerCase();
    const encoded = (parts ? parts[2]! : ext).trim();
    try {
      const decoded = charset === 'iso-8859-1' || charset === 'latin1' ? decodeLatin1(encoded) : decodeURIComponent(encoded);
      if (decoded) return decoded;
    } catch {
      rawExt = encoded || undefined;
    }
  }
  const plain = params.get('filename');
  if (plain) return plain;
  return rawExt;
}
