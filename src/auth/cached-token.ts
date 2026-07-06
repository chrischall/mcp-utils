/**
 * `createCachedTokenSource` — a tiny in-memory cache around any token mint.
 *
 * Consolidates the "cache `{ token, expiresAt }`, refresh a bit before expiry,
 * single-flight the mint" shape hand-rolled in app-store-connect
 * (`ensureToken`, ES256 self-mint), musicbrainz (`accessToken` around
 * `createOAuth2Refresher`), and zola (`ensureSession` JWT refresh). The mint is
 * injected, so the same source fronts an OAuth refresher, a JWT signer, or a
 * login exchange.
 */

/** What a mint returns: the token plus (optionally) when it expires. */
export interface MintedToken {
  /** The bearer/access token. */
  token: string;
  /** Absolute expiry (Date or epoch ms). Takes precedence over {@link ttlMs}. */
  expiresAt?: Date | number;
  /** Relative lifetime in ms, when the mint knows it (e.g. `expires_in * 1000`). */
  ttlMs?: number;
}

/** Options for {@link createCachedTokenSource}. */
export interface CachedTokenSourceOptions {
  /** Mint a fresh token (OAuth exchange, JWT sign, login…). */
  mint: () => Promise<MintedToken>;
  /** Refresh this many ms BEFORE the token's expiry. Defaults to 60 000. */
  bufferMs?: number;
  /** Lifetime assumed when the mint reports no expiry. Defaults to 3 600 000 (1 h). */
  defaultTtlMs?: number;
  /** Injectable clock (defaults to `Date.now`) — for tests. */
  now?: () => number;
}

/** The token source returned by {@link createCachedTokenSource}. */
export interface CachedTokenSource {
  /** A currently-valid token — cached, or freshly minted when absent/near expiry. */
  getToken(): Promise<string>;
  /** Drop the cached token so the next {@link getToken} re-mints (the 401-replay hook). */
  invalidate(): void;
}

/**
 * Build a race-safe cached token source. Concurrent `getToken`s share one
 * in-flight mint; a rejected mint is not cached (the next call retries);
 * `invalidate()` is the reactive hook to call after an upstream 401 before
 * replaying the request.
 */
export function createCachedTokenSource(opts: CachedTokenSourceOptions): CachedTokenSource {
  const now = opts.now ?? Date.now;
  const bufferMs = opts.bufferMs ?? 60_000;
  const defaultTtlMs = opts.defaultTtlMs ?? 3_600_000;

  let cached: { token: string; expiresAt: number } | null = null;
  let inFlight: Promise<string> | null = null;

  const expiryOf = (minted: MintedToken): number => {
    if (minted.expiresAt !== undefined) {
      return minted.expiresAt instanceof Date ? minted.expiresAt.getTime() : minted.expiresAt;
    }
    return now() + (minted.ttlMs ?? defaultTtlMs);
  };

  return {
    getToken(): Promise<string> {
      if (cached && cached.expiresAt - bufferMs > now()) return Promise.resolve(cached.token);
      if (inFlight) return inFlight;
      const p = opts
        .mint()
        .then((minted) => {
          cached = { token: minted.token, expiresAt: expiryOf(minted) };
          return minted.token;
        })
        .finally(() => {
          if (inFlight === p) inFlight = null;
        });
      inFlight = p;
      return p;
    },
    invalidate(): void {
      cached = null;
    },
  };
}
