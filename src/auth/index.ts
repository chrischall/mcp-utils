/**
 * Auth resolver skeletons — the shared *shape* of the credential-resolution
 * logic duplicated across the fleet (resy / opentable / ofw / zola /
 * signupgenius / creditkarma / canvas / infinitecampus auth.ts).
 *
 * This module owns the **skeleton** only. Per-site parameters (which env var,
 * which cookies to declare, how to parse the session blob, which CSRF input to
 * scrape) are *injected*; nothing here branches on site identity. Site-specific
 * OAuth choreographies (e.g. Skylight's `/auth/session` → `/oauth/authorize` →
 * `/oauth/token` dance) stay per-MCP — they are not a shared shape.
 *
 * Four pieces:
 *  - {@link createAuthResolver} — the three-path resolver
 *    (env credential → fetchproxy one-shot read → actionable error).
 *  - {@link resolveAuthPattern} — the four-path variant
 *    (token → OAuth → session-scrape → fetchproxy), each path an injected
 *    resolver tried in priority order.
 *  - {@link sessionLoginFlow} — CSRF-scrape + cookie POST + success-marker,
 *    the shared CSRF+cookie login primitive (canvas / IC / ofw / signupgenius).
 *  - {@link createOAuth2Refresher} — an OAuth2 `refresh_token`-grant refresher
 *    with optional retry and in-flight race-safety.
 *
 * Security posture: env reads go through the hardened {@link readEnvVar}
 * (placeholder / `'null'` / `'undefined'` suppression); thrown errors never
 * echo the offending secret value and run upstream bodies through
 * {@link truncateErrorMessage} (redaction + truncation) before surfacing.
 */

import { readEnvVar, parseBoolEnv, type EnvSource } from '../config/index.js';
import {
  truncateErrorMessage,
  SessionNotAuthenticatedError,
  createHelpfulError,
} from '../errors/index.js';
import { parseCookieJar } from '../http/index.js';

// ---------------------------------------------------------------------------
// createAuthResolver — three-path (env → fetchproxy → helpful error)
// ---------------------------------------------------------------------------

/** A `@fetchproxy/bootstrap` session blob: declared cookies / storage, by key. */
export interface FetchproxySession {
  cookies: Record<string, string>;
  localStorage?: Record<string, string>;
  sessionStorage?: Record<string, string>;
}

/**
 * The injected `@fetchproxy/bootstrap`-shaped function. Kept as a parameter (not
 * a hard import) so the heavy bridge dep stays out of this module and tests can
 * mock the module boundary, exactly as every fleet `auth.ts` does today.
 */
export type BootstrapFn = (opts: unknown) => Promise<FetchproxySession>;

/** Result of {@link createAuthResolver}'s resolver — opaque credential + provenance. */
export interface ResolvedCredential {
  /** The resolved credential (token / cookie header / refresh JWT — opaque). */
  credential: string;
  /** Which path produced it. Diagnostics / cache-keying only — do not branch on it. */
  source: 'env' | 'fetchproxy';
}

/** Options for {@link createAuthResolver}. */
export interface AuthResolverOptions {
  /** Env var holding the credential when the user supplies it directly (path 1). */
  envVar: string;
  /**
   * Env var that, when truthy, disables the fetchproxy fallback (path 2). When
   * omitted, the fallback is always attempted. Mirrors `*_DISABLE_FETCHPROXY`.
   */
  disableEnvVar?: string;
  /** Injected `@fetchproxy/bootstrap` function (mocked at the boundary in tests). */
  bootstrap: BootstrapFn;
  /** The opts object passed verbatim to {@link bootstrap} (domains, declare, …). */
  bootstrapOptions: unknown;
  /**
   * Lift the credential out of the fetchproxy session blob. Returns the
   * credential string, or `undefined`/`''` when the signed-in tab didn't carry
   * it (→ surfaced as a "sign in" error).
   */
  parseTokens: (session: FetchproxySession) => string | undefined;
  /** Human-readable service name for the not-signed-in error (e.g. "Zola"). */
  serviceName?: string;
  /** Host to point the user at when the browser session is missing (e.g. "zola.com"). */
  signInHost?: string;
  /** Env source. Defaults to {@link process.env}. */
  env?: EnvSource;
}

/**
 * Build the canonical **three-path** auth resolver:
 *
 *  1. **Env credential** — `envVar` set (after hardened {@link readEnvVar}
 *     sanitization) → returned directly, no network.
 *  2. **fetchproxy one-shot read** — unless `disableEnvVar` is truthy, call the
 *     injected `bootstrap` to snapshot the user's signed-in browser session,
 *     then `parseTokens` to extract the credential. fetchproxy is invoked once;
 *     it is never in the hot path.
 *  3. **Actionable error** — nothing configured: an error naming the env var
 *     and the sign-in fallback so the user can pick a fix.
 *
 * The returned `source` is for diagnostics; callers must treat the credential
 * as opaque and not branch on it.
 */
export function createAuthResolver(
  opts: AuthResolverOptions,
): () => Promise<ResolvedCredential> {
  const {
    envVar,
    disableEnvVar,
    bootstrap,
    bootstrapOptions,
    parseTokens,
    serviceName,
    signInHost,
    env,
  } = opts;

  return async function resolveAuth(): Promise<ResolvedCredential> {
    // ── Path 1: env-var credential (hardened against placeholder/sentinel leakage).
    const envCredential = readEnvVar(envVar, env ? { env } : {});
    if (envCredential) {
      return { credential: envCredential, source: 'env' };
    }

    // ── Path 2: fetchproxy one-shot fallback (unless explicitly disabled).
    const disabled =
      disableEnvVar !== undefined &&
      parseBoolEnv(disableEnvVar, env ? { env } : {});
    if (!disabled) {
      let session: FetchproxySession;
      try {
        session = await bootstrap(bootstrapOptions);
      } catch (e) {
        // Surface the fallback failure but point back at the env-var escape
        // hatch. Redact + truncate the underlying message.
        throw createHelpfulError(
          `Auth: no ${envVar} set, and fetchproxy fallback failed: ${truncateErrorMessage(messageOf(e))}`,
          { hint: `Set ${envVar}, or sign in in your browser and retry.` },
        );
      }
      const credential = parseTokens(session);
      if (credential) {
        return { credential, source: 'fetchproxy' };
      }
      // Bootstrap succeeded but the declared key wasn't present → the browser
      // tab isn't signed in. This is the stable "go authenticate" condition.
      throw new SessionNotAuthenticatedError(serviceName, signInHost);
    }

    // ── Path 3: nothing configured and fetchproxy disabled.
    throw createHelpfulError(
      `Auth: set ${envVar}${signInHost ? `, or sign in at ${signInHost} in your browser` : ', or sign in in your browser'}` +
        `${disableEnvVar ? ` (unset ${disableEnvVar} if it is set)` : ''}.`,
      { hint: `Set ${envVar} or sign in in your browser.` },
    );
  };
}

// ---------------------------------------------------------------------------
// resolveAuthPattern — four-path (token → OAuth → session-scrape → fetchproxy)
// ---------------------------------------------------------------------------

/** Result of a {@link resolveAuthPattern} path resolver — opaque credential + provenance. */
export interface PatternResult {
  /** The resolved credential (bearer / cookie header — opaque to the caller). */
  credential: string;
  /** Which path produced it. Diagnostics only — callers should not branch on it. */
  source: string;
}

/** A single path resolver. Returning a value claims the path; throwing aborts. */
export type PathResolver = () => Promise<PatternResult>;

/**
 * The four ordered paths of the "Pattern A template" (canvas / IC). A path is
 * **configured** iff its resolver is provided; the *first* configured path, in
 * this fixed priority order, runs. This is the only ordering — it never branches
 * on which site is calling.
 */
export interface AuthPattern {
  /** Path 1: a stateless personal-access-token credential. */
  token?: PathResolver;
  /** Path 2: an OAuth `refresh_token` grant. */
  oauth?: PathResolver;
  /** Path 3: a username/password session-scrape (CSRF + cookie login). */
  sessionScrape?: PathResolver;
  /** Path 4: a fetchproxy one-shot browser-session read. */
  fetchproxy?: PathResolver;
}

/**
 * Resolve auth via the four-path priority **token → OAuth → session-scrape →
 * fetchproxy**. Runs the first *provided* resolver in that order (a missing
 * resolver = an unconfigured path). A resolver that throws propagates — a
 * partial-config error (the user's mistake) must surface, not silently fall
 * through. Throws an actionable error when no path is configured at all.
 */
export async function resolveAuthPattern(pattern: AuthPattern): Promise<PatternResult> {
  const ordered: ReadonlyArray<PathResolver | undefined> = [
    pattern.token,
    pattern.oauth,
    pattern.sessionScrape,
    pattern.fetchproxy,
  ];
  for (const resolver of ordered) {
    if (resolver) return resolver();
  }
  throw createHelpfulError(
    'No auth configured. Provide a token, OAuth credentials, login credentials, ' +
      'or sign in in your browser (fetchproxy fallback).',
    { hint: 'Set one of the supported credential env vars, or sign in in your browser.' },
  );
}

// ---------------------------------------------------------------------------
// sessionLoginFlow — CSRF extract + cookie POST + success marker
// ---------------------------------------------------------------------------

/** Options for {@link sessionLoginFlow}. */
export interface SessionLoginOptions {
  /** URL of the login page to GET (carries the CSRF input + sets a session cookie). */
  loginUrl: string;
  /** URL to POST the credentials to. */
  postUrl: string;
  /** Regex with one capture group that extracts the CSRF token from the page HTML. */
  csrfRegex: RegExp;
  /** Form field name the CSRF token is submitted under. Defaults to `'csrfToken'`. */
  csrfField?: string;
  /**
   * Cookie name that signals a successful login *and* is returned as `token`.
   * Its presence after the POST is the success marker.
   */
  tokenField: string;
  /** Form field name the email/username is submitted under. Defaults to `'email'`. */
  emailField?: string;
  /** Form field name the password is submitted under. Defaults to `'password'`. */
  passwordField?: string;
  /** The user's email / username. */
  email: string;
  /** The user's password. */
  password: string;
  /** Extra static form fields to include in the POST body (per-site form params). */
  extraFields?: Record<string, string>;
  /** Header sent on both requests (e.g. a desktop `User-Agent`). */
  userAgent?: string;
  /** Injectable fetch (defaults to global `fetch`) — for tests. */
  fetchImpl?: typeof fetch;
}

/** Result of {@link sessionLoginFlow}. */
export interface SessionLoginResult {
  /** Value of the `tokenField` cookie set on a successful login. */
  token: string;
  /** Full `Cookie` header (deduped jar) for subsequent authenticated requests. */
  cookies: string;
}

const DEFAULT_LOGIN_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

/** Node's `Headers` may carry multiple `Set-Cookie`s; prefer the spec'd getter. */
function readSetCookies(headers: Headers): string[] {
  const h = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const raw = headers.get('set-cookie');
  return raw ? [raw] : [];
}

/**
 * The shared CSRF + cookie login primitive (canvas / IC / ofw / signupgenius):
 *
 *  1. GET `loginUrl` — capture the session cookie(s) and scrape the CSRF token
 *     out of the page with `csrfRegex`.
 *  2. POST `postUrl` (`application/x-www-form-urlencoded`) with the scraped CSRF
 *     token, credentials, and any `extraFields`, carrying the GET's cookies.
 *  3. Merge `Set-Cookie`s from both responses (deduped, deletions dropped) and
 *     require the `tokenField` cookie as the success marker — its value is the
 *     returned `token`; its absence means the credentials were rejected.
 *
 * Per-site form parameters and the CSRF regex are injected; the flow itself is
 * site-agnostic.
 */
export async function sessionLoginFlow(
  opts: SessionLoginOptions,
): Promise<SessionLoginResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const ua = opts.userAgent ?? DEFAULT_LOGIN_UA;
  const csrfField = opts.csrfField ?? 'csrfToken';
  const emailField = opts.emailField ?? 'email';
  const passwordField = opts.passwordField ?? 'password';

  // Step 1: GET the login page → session cookie + CSRF token.
  const pageRes = await doFetch(opts.loginUrl, {
    headers: { 'User-Agent': ua, Accept: 'text/html' },
  });
  if (!pageRes.ok) {
    throw createHelpfulError(`Login page returned ${pageRes.status} ${pageRes.statusText}`, {
      hint: 'The upstream login page is unreachable; retry later.',
    });
  }
  const pageJar = parseCookieJar(readSetCookies(pageRes.headers));
  const html = await pageRes.text();
  const csrfMatch = opts.csrfRegex.exec(html);
  const csrfToken = csrfMatch?.[1];
  if (!csrfToken) {
    throw createHelpfulError('CSRF token not found on the login page.', {
      hint: 'The login page layout may have changed, or the page failed to load.',
    });
  }

  // Step 2: POST credentials with the scraped CSRF token.
  const body = new URLSearchParams({
    [csrfField]: csrfToken,
    [emailField]: opts.email,
    [passwordField]: opts.password,
    ...opts.extraFields,
  }).toString();

  const postRes = await doFetch(opts.postUrl, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'User-Agent': ua,
      Accept: 'text/html',
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: opts.loginUrl,
      ...(pageJar.cookieHeader ? { Cookie: pageJar.cookieHeader } : {}),
    },
    body,
  });

  // Step 3: merge cookies from both responses; require the success marker.
  const merged = parseCookieJar([
    ...readSetCookies(pageRes.headers),
    ...readSetCookies(postRes.headers),
  ]);
  const token = merged.cookies[opts.tokenField];
  if (!token) {
    throw createHelpfulError(
      `Login did not yield a ${opts.tokenField} cookie (status ${postRes.status}) — the credentials were rejected.`,
      {
        hint: 'Verify the configured email and password. SSO and 2FA-protected accounts are not supported in this mode.',
      },
    );
  }

  return { token, cookies: merged.cookieHeader };
}

// ---------------------------------------------------------------------------
// createOAuth2Refresher — refresh_token grant + retry + race-safety
// ---------------------------------------------------------------------------

/** Options for {@link createOAuth2Refresher}. */
export interface OAuth2RefresherOptions {
  /** Token endpoint to POST the grant to. */
  endpoint: string;
  /** The refresh token to exchange. */
  refreshToken: string;
  /** OAuth2 grant type. Defaults to `'refresh_token'`. */
  grantType?: string;
  /** Extra form params (e.g. `client_id`, `client_secret`, `scope`). */
  params?: Record<string, string>;
  /**
   * Retry policy for a failed exchange. `count` is *additional* attempts after
   * the first; `delayMs` is the fixed wait between attempts. Omit to never retry.
   */
  retry?: { count: number; delayMs: number };
  /** Injectable fetch (defaults to global `fetch`) — for tests. */
  fetchImpl?: typeof fetch;
}

/** Result of an {@link createOAuth2Refresher} exchange. */
export interface OAuth2RefreshResult {
  /** The new access token. */
  accessToken: string;
  /** A rotated refresh token, when the server returned one. */
  refreshToken?: string;
  /** `expires_in` (seconds), when the server returned one. */
  expiresIn?: number;
  /** Absolute expiry (`now + expires_in`), when `expires_in` was present. */
  expiresAt?: Date;
}

interface TokenEndpointResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
}

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

/**
 * Build a race-safe OAuth2 `refresh_token`-grant refresher. The returned
 * function POSTs the form-encoded grant to `endpoint` and parses the standard
 * `{ access_token, refresh_token?, expires_in? }` body.
 *
 * Race-safety: concurrent calls share a single in-flight exchange (the
 * canonical token-refresh-race guard — `skylight`/`canvas`/`creditkarma`/`zola`
 * all hand-roll this). The in-flight promise is cleared once it settles, so a
 * later refresh starts fresh and a *rejected* exchange does not poison the next
 * caller.
 *
 * Errors run through {@link truncateErrorMessage} (redaction + truncation)
 * before surfacing, so an upstream error body can't leak a bearer token or
 * blow up a tool result.
 */
export function createOAuth2Refresher(
  opts: OAuth2RefresherOptions,
): () => Promise<OAuth2RefreshResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const grantType = opts.grantType ?? 'refresh_token';
  const maxRetries = opts.retry?.count ?? 0;
  const retryDelayMs = opts.retry?.delayMs ?? 0;

  let inFlight: Promise<OAuth2RefreshResult> | null = null;

  async function exchangeOnce(): Promise<OAuth2RefreshResult> {
    const body = new URLSearchParams({
      grant_type: grantType,
      refresh_token: opts.refreshToken,
      ...opts.params,
    }).toString();

    const res = await doFetch(opts.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw createHelpfulError(
        `OAuth2 token refresh failed: ${res.status} ${res.statusText}: ${truncateErrorMessage(errText, 200)}`,
        { hint: 'The refresh token may be expired or revoked — re-authenticate.' },
      );
    }

    const data = (await res.json().catch(() => null)) as TokenEndpointResponse | null;
    const accessToken = data?.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw createHelpfulError('OAuth2 token refresh returned no access_token.', {
        hint: 'The token endpoint returned an unexpected body.',
      });
    }

    const result: OAuth2RefreshResult = { accessToken };
    if (typeof data?.refresh_token === 'string' && data.refresh_token.length > 0) {
      result.refreshToken = data.refresh_token;
    }
    if (typeof data?.expires_in === 'number') {
      result.expiresIn = data.expires_in;
      result.expiresAt = new Date(Date.now() + data.expires_in * 1000);
    }
    return result;
  }

  async function exchangeWithRetry(): Promise<OAuth2RefreshResult> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await exchangeOnce();
      } catch (e) {
        lastErr = e;
        if (attempt < maxRetries) await sleep(retryDelayMs);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  return function refresh(): Promise<OAuth2RefreshResult> {
    // Coalesce concurrent callers onto one exchange; clear on settle so the
    // next call starts fresh (and a rejection doesn't stick).
    if (inFlight) return inFlight;
    const p = exchangeWithRetry().finally(() => {
      if (inFlight === p) inFlight = null;
    });
    inFlight = p;
    return p;
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
