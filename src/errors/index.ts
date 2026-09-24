/**
 * Shared MCP error classes, error wrapping, and bridge-error discrimination.
 *
 * Consolidates the `instanceof`-chains and remediation-message patterns found
 * in `client.ts` / `auth.ts` across the fleet. Every error carries an optional
 * `hint` — a "here's how to fix it" string the tool surface can show the user.
 *
 * The fetchproxy typed-error hierarchy (`Fetchproxy*Error`) is re-exported, not
 * reimplemented; {@link classifyBridgeError} is a thin discriminator over it.
 */

// NOTE: the fetchproxy typed-error hierarchy (Fetchproxy*Error) and the
// `classifyBridgeError` discriminator live in the `@chrischall/mcp-utils/fetchproxy`
// subpath — NOT here. Keeping `@fetchproxy/server` (an optional peer dep) out of
// this core module is what lets bearer-only MCPs import the core barrel without
// installing fetchproxy.

/** Default seconds to wait before retrying a tripped bot-wall (issue #90 tuning). */
export const DEFAULT_BOT_WALL_RETRY_AFTER_S = 30;

/** Default truncation budget for upstream error bodies surfaced to clients. */
export const DEFAULT_ERROR_MESSAGE_MAX = 500;

/**
 * Base class for every tool-facing error. Carries an optional `hint` —
 * actionable remediation text ("set ZOLA_REFRESH_TOKEN", "sign in at compass.com")
 * the tool surface can present separately from the message.
 */
export class McpToolError extends Error {
  /** Actionable remediation text, when one applies. */
  readonly hint?: string;

  constructor(message: string, opts?: { hint?: string; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'McpToolError';
    if (opts?.hint !== undefined) this.hint = opts.hint;
    // Restore the prototype chain for transpiled `extends Error`.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The user's browser session isn't signed in to the upstream service. Distinct
 * from a transient bot-wall — this is a stable "go authenticate" condition.
 */
export class SessionNotAuthenticatedError extends McpToolError {
  constructor(service?: string, signInHost?: string) {
    const name = service ?? 'the service';
    const where = signInHost ? `Open ${signInHost} in your browser and sign in, then try again.` : 'Sign in in your browser, then try again.';
    super(
      `Not signed in to ${name}. ${where} ` +
        'Saved searches, saved homes, and other account data require a signed-in session.',
      { hint: where },
    );
    this.name = 'SessionNotAuthenticatedError';
  }
}

/**
 * Transient anti-bot interstitial (PerimeterX / DataDome CAPTCHA). The request
 * was rate-limited, NOT a missing resource — back off and retry. Kept distinct
 * from {@link SessionNotAuthenticatedError} so callers don't misclassify a
 * retryable wall as a stale session (issue #90).
 */
export class BotWallError extends McpToolError {
  /** Suggested seconds to wait before retrying the blocked request(s). */
  readonly retryAfterSeconds: number;
  /** The wall vendor when the classifier identified one (e.g. `'DataDome'`, `'Cloudflare'`). */
  readonly vendor?: string;

  constructor(
    path: string,
    retryAfterSeconds: number = DEFAULT_BOT_WALL_RETRY_AFTER_S,
    opts?: { vendor?: string },
  ) {
    // Keep the historical no-vendor message byte-identical ("an anti-bot …").
    const wall = opts?.vendor ? `a ${opts.vendor} anti-bot CAPTCHA wall` : 'an anti-bot CAPTCHA wall';
    const hint = `Back off and retry (suggested wait: ${retryAfterSeconds}s). If it persists, open the site in your browser, clear the CAPTCHA, then retry with a smaller batch.`;
    super(
      `Served ${wall} for ${path} — the request was rate-limited, not a missing resource. ${hint}`,
      { hint },
    );
    this.name = 'BotWallError';
    this.retryAfterSeconds = retryAfterSeconds;
    if (opts?.vendor !== undefined) this.vendor = opts.vendor;
  }
}

/** Upstream returned HTTP 429 (or an equivalent rate-limit signal). */
export class RateLimitError extends McpToolError {
  /** Seconds the upstream asked us to wait, when it told us. */
  readonly retryAfterSeconds?: number;

  constructor(service: string, retryAfterSeconds?: number) {
    const wait =
      retryAfterSeconds !== undefined ? ` Retry after ${retryAfterSeconds}s.` : ' Back off and retry.';
    super(`Rate limited by ${service}.${wait}`, { hint: wait.trim() });
    this.name = 'RateLimitError';
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Upstream is unreachable (5xx / transport failure) — not the caller's fault. */
export class UnreachableError extends McpToolError {
  /** Upstream HTTP status, when one was observed. */
  readonly status?: number;

  constructor(service: string, status?: number) {
    const suffix = status !== undefined ? ` (status ${status})` : '';
    super(`${service} unreachable${suffix}. The service may be down — try again later.`, {
      hint: 'The upstream service is temporarily unavailable; retry later.',
    });
    this.name = 'UnreachableError';
    if (status !== undefined) this.status = status;
  }
}

/**
 * A tool requires a different auth/operation mode than the server is running in
 * (e.g. a Pro key-mode-only report invoked while in session mode).
 */
export class ModeMismatchError extends McpToolError {
  constructor(
    readonly currentMode: string,
    readonly requiredMode: string,
    readonly feature: string,
  ) {
    const hint = `Switch to ${requiredMode} mode to use ${feature}.`;
    super(
      `${feature} requires ${requiredMode} mode but the server is running in ${currentMode} mode. ${hint}`,
      { hint },
    );
    this.name = 'ModeMismatchError';
  }
}

/** Factory for an {@link McpToolError} with a remediation hint. */
export function createHelpfulError(message: string, opts?: { hint?: string }): McpToolError {
  return new McpToolError(message, opts);
}

const BEARER_RE = /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
// A JWT-shaped triple (header.payload.signature), each segment base64url-ish.
// The scan may only START where a base64url run starts (negative lookbehind
// over the segment charset), never at a `\b`: `-` is a non-word character
// but a valid segment character, so `\b` fired before every `x` in a run of
// `x-x-x-…` and each start re-scanned the run for a `.` that never came —
// O(n²), 40 s on 200 KB (fleet audit 2026-09-24 SEC-1). Anchored on the run
// start, each run is scanned once.
const JWT_RE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g;
// `Authorization: Basic <base64 credentials>` — anchored on the full header name
// so prose like "basic principles" never matches.
const BASIC_AUTH_RE = /(authorization\s*:\s*basic\s+)[A-Za-z0-9+/=_-]{6,}/gi;
// `Set-Cookie: name=value; Path=/; …` — redact the cookie VALUE only; the name
// and the (non-secret) attributes stay visible for debuggability.
//
// Cookie NAMES exclude `:` (an RFC 6265 cookie-name is a token, which cannot
// contain it). With `:` allowed, a body of `cookie:cookie:cookie:…` made every
// `cookie:` start scan to the end of the run looking for `=` — O(n²), 5 s on
// 200 KB (fleet audit 2026-09-24 SEC-1). Excluding it stops each scan at the
// next header start. Values keep `:` (base64, URLs).
const SET_COOKIE_RE = /(\bset-cookie\s*:\s*)([^=;,:\s]+)=[^;,\s]*/gi;
// `Cookie: a=1; b=2` — redact every pair's value, keep the names. The lookbehind
// keeps this from re-matching the `Cookie` inside `Set-Cookie:`.
const COOKIE_HEADER_RE =
  /((?<!set-)\bcookie\s*:\s*)((?:[^=;,:\s]+=[^;,\s]*)(?:;\s*[^=;,:\s]+=[^;,\s]*)*)/gi;
// Well-known API-key shapes as standalone tokens, each anchored to its documented
// prefix + length/charset so ordinary prose (short hex ids, version strings,
// UUIDs) never matches. Charsets containing `-` (a non-word character) can end
// on it, where a trailing `\b` has nothing to anchor on — those patterns carry
// a negative lookahead over their own charset instead.
const API_KEY_RE = new RegExp(
  [
    'sk-[A-Za-z0-9_-]{20,}(?![A-Za-z0-9_-])', // OpenAI / Anthropic (incl. sk-ant-…)
    'gh[pousr]_[A-Za-z0-9]{36,}\\b', // GitHub ghp_/gho_/ghu_/ghs_/ghr_
    'xox[baprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])', // Slack
    'AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])', // Google API key (39 chars total)
    'AKIA[0-9A-Z]{16}\\b', // AWS access key id (20 chars total)
    'whsec_[A-Za-z0-9]{16,}\\b', // webhook signing secret (Stripe-style)
  ]
    .map((p) => `\\b${p}`)
    .join('|'),
  'g',
);
// Secret-bearing query params — the value after `=` up to `&`/`#`/quote/space/end.
// Anchored on `?`/`&` so plain prose like `key=primary` (no URL context) never
// matches; that constraint is what makes short names like `key`/`sig` safe.
// Key names allow `_`, `-` or no separator and any case (`accessToken`,
// `client-secret`), since camelCase APIs echo them that way.
// `password`/`passwd` catch an echoed login form.
const QUERY_SECRET_RE =
  /([?&](?:(?:access|refresh|id|auth|session|csrf|xsrf)[_-]?token|client[_-]?secret|api[_-]?secret|api[_-]?key|password|passwd|signature|token|key|sig)=)[^&#\s"'<>`]+/gi;
// An OAuth authorization code (`?code=…` on a redirect). Only values of 16+
// characters: real authorization codes are long opaque strings, while a short
// `code=E123` is an error/status code worth keeping for diagnosis.
const OAUTH_CODE_RE = /([?&]code=)(?=[^&#\s"'<>`]{16,})[^&#\s"'<>`]+/gi;
// A form body echoed without URL context (`password=…&user=…`, after a
// space/newline/quote/bracket): only the password names, which are never
// non-secret.
const FORM_PASSWORD_RE = /((?:^|[\s,;:"'(\[{])(?:password|passwd)=)[^&#\s"'<>`]+/gim;
// Credential-bearing headers beyond Authorization/Cookie: `X-Api-Key: …`,
// `x_api_key: …`, `Api-Key: …`, `X-Auth-Token: …`, `X-Goog-Api-Key: …`.
// Anchored on an `x-`/`x_` prefix (or a bare `api-key`) so prose like
// `token: expired` is untouched.
//
// The header-name quantifiers are BOUNDED ({0,40}). Unbounded, every `x-`
// word start in a long `[a-z0-9_-]` run with no colon scanned to the end of
// the run, so a crafted upstream body of `x-x-x-…` cost O(n²): 200 KB took
// 7.5 s inside redactSecrets, which runs on the whole body BEFORE the 500-char
// cut (fleet audit 2026-09-24 SEC-1). Bounded, each start scans at most 40
// chars; no real header name is longer.
const HEADER_NAME_RUN = '[a-z0-9_-]{0,40}';
const HEADER_SECRET_RE = new RegExp(
  `(\\b(?:x[-_]${HEADER_NAME_RUN}?(?:api[-_]?key|token|secret|auth)${HEADER_NAME_RUN}|api[-_]?key)\\s*:\\s*)[^\\s,;"'<>\`]+`,
  'gi',
);
// AWS SigV4 presigned-URL credential params. Their `X-Amz-` prefix defeats the
// short-name anchoring in QUERY_SECRET_RE (`&X-Amz-Security-Token=` has `-`, not
// `&`, before `token`), so match the full param names explicitly — an S3 error
// body can echo a presigned URL carrying a temporary STS security token.
const AWS_SIGV4_RE =
  /([?&]X-Amz-(?:Signature|Security-Token|Credential)=)[^&#\s"'<>`]+/gi;
// Secret-bearing JSON values — `"refresh_token": "…"` in a token-endpoint or
// upstream error body. The KEY must be a quote-wrapped exact secret name (so
// `"token_type":"Bearer"` and other non-secret keys are untouched), and only
// the string VALUE is redacted. Covers the OAuth/login bodies the query-param
// redactor misses (they arrive as JSON, not a URL).
//
// Two variants — double- vs single-quoted — because the value char class must
// stop at the SAME quote that opened it: a shared `[^"']*` would halt at an
// apostrophe inside a double-quoted value (`"password":"hunter's2"` → leaks
// `'s2`). `client_id` is deliberately NOT in the key set: RFC 6749 §2.2 treats
// it as a public identifier, not a credential (QUERY_SECRET_RE omits it too).
//
// Key names are separator- and case-insensitive (`accessToken`,
// `client-secret`, `API_KEY`) because GraphQL and JS backends echo camelCase.
// Values honour backslash escapes so `"a\"b"` is redacted up to the REAL
// closing quote.
//
// Header names used as JSON keys (`"x-auth-token"`, `"X-Goog-Api-Key"`,
// `"authorization"`) are covered too: a request echo often serialises its
// headers object.
const JSON_SECRET_KEYS = [
  '(?:access|refresh|id|auth|session|bearer|csrf|xsrf)[_-]?token',
  'client[_-]?secret',
  'api[_-]?secret',
  '(?:x[_-])?api[_-]?key',
  'private[_-]?key',
  `x[_-]${HEADER_NAME_RUN}?(?:api[_-]?key|token|secret|auth)${HEADER_NAME_RUN}`, // bounded like HEADER_SECRET_RE
  '(?:proxy-)?authorization',
  'password',
  'passwd',
  'secret',
  'token',
].join('|');
const JSON_SECRET_DQ_RE = new RegExp(`("(?:${JSON_SECRET_KEYS})"\\s*:\\s*")(?:[^"\\\\]|\\\\.)*(")`, 'gi');
const JSON_SECRET_SQ_RE = new RegExp(`('(?:${JSON_SECRET_KEYS})'\\s*:\\s*')(?:[^'\\\\]|\\\\.)*(')`, 'gi');

/**
 * Redact secrets that commonly leak into upstream error bodies before the text
 * is surfaced to a client: `Bearer <token>` / `Authorization: Basic <…>` headers,
 * `Cookie:` / `Set-Cookie:` header values (cookie names stay visible), standalone
 * JWTs, well-known API-key shapes (OpenAI/Anthropic `sk-…`, GitHub `ghp_…`,
 * Slack `xox?-…`, Google `AIza…`, AWS `AKIA…`, `whsec_…`), secret-bearing
 * URL query params (`access_token`/`accessToken`, `api_key`, `token`, `key`,
 * `sig`, `password`, …) and long OAuth `code=` values, echoed form passwords,
 * `X-Api-Key`-style headers (also as JSON keys, like `"authorization"`), and quote-wrapped JSON secret values (`"refresh_token":"…"` /
 * `"accessToken":"…"` in an OAuth/error body — the key must be a secret name
 * in any case or separator style, so `"token_type":"Bearer"` and other
 * non-secret keys stay visible).
 *
 * Exported so fleet repos can redact custom strings (log lines, debug payloads)
 * without taking on {@link truncateErrorMessage}'s length cap.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(BEARER_RE, '$1[REDACTED]')
    .replace(BASIC_AUTH_RE, '$1[REDACTED]')
    .replace(SET_COOKIE_RE, '$1$2=[REDACTED]')
    .replace(
      COOKIE_HEADER_RE,
      (_m, prefix: string, pairs: string) => `${prefix}${pairs.replace(/=[^;,\s]*/g, '=[REDACTED]')}`,
    )
    .replace(API_KEY_RE, '[REDACTED]')
    .replace(HEADER_SECRET_RE, '$1[REDACTED]')
    .replace(QUERY_SECRET_RE, '$1[REDACTED]')
    .replace(OAUTH_CODE_RE, '$1[REDACTED]')
    .replace(FORM_PASSWORD_RE, '$1[REDACTED]')
    .replace(AWS_SIGV4_RE, '$1[REDACTED]')
    .replace(JSON_SECRET_DQ_RE, '$1[REDACTED]$2')
    .replace(JSON_SECRET_SQ_RE, '$1[REDACTED]$2')
    .replace(JWT_RE, '[REDACTED]');
}

/**
 * The most of an upstream body {@link truncateErrorMessage} runs through
 * {@link redactSecrets}: 64 KB. Defence in depth behind the linear patterns —
 * a body past this is cut BEFORE redaction, so no pattern, however it
 * regresses, can be handed megabytes by a hostile upstream. A secret
 * straddling the 64 KB mark is not a realistic leak: the surfaced message is
 * `max` (500) characters from the start.
 */
export const ERROR_REDACTION_INPUT_MAX = 64 * 1024;

/**
 * Redact secrets, then cap an (upstream) error string at `max` characters,
 * appending a `… [truncated]` marker when clipped.
 *
 * Security: redaction runs BEFORE truncation so a token straddling the cut
 * boundary can't survive in a half-form. Untrusted upstream bodies must always
 * go through this before reaching a tool result. The redactor is only ever
 * handed the first {@link ERROR_REDACTION_INPUT_MAX} characters (or `max`,
 * whichever is larger), so a pathological body cannot pin the event loop.
 */
export function truncateErrorMessage(text: string, max: number = DEFAULT_ERROR_MESSAGE_MAX): string {
  const str = text === null || text === undefined ? '' : String(text);
  const cap = Math.max(ERROR_REDACTION_INPUT_MAX, max);
  const redacted = redactSecrets(str.length > cap ? str.slice(0, cap) : str);
  if (redacted.length <= max) return redacted;
  return `${redacted.slice(0, max)}… [truncated]`;
}

/** Extract a string message from any thrown value. */
export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Prepend the tool name to an error's context and return an {@link McpToolError},
 * preserving any `hint` and chaining the original via `cause`. The message is
 * run through {@link truncateErrorMessage} (redaction + truncation). Re-wrapping
 * an already-prefixed error does not double-prefix.
 */
export function wrapToolError(toolName: string, err: unknown): McpToolError {
  const inner = messageOf(err);
  const prefix = `[${toolName}]`;
  const message = inner.includes(prefix) ? inner : `${prefix} ${inner}`;
  const hint = err instanceof McpToolError ? err.hint : undefined;
  return new McpToolError(truncateErrorMessage(message), { hint, cause: err });
}

/** Options for {@link maskSecret}. */
export interface MaskSecretOptions {
  /** Leading characters kept visible. Defaults to 8. */
  head?: number;
  /** Trailing characters kept visible. Defaults to 4. */
  tail?: number;
}

/**
 * Mask a credential for display in a confirmation message: keep the first
 * `head` and last `tail` characters with an ellipsis between
 * (`abcdefgh…wxyz`). A value too short to mask safely (≤ `head + tail` chars)
 * is fully hidden as `…` — a partial reveal of a short secret would leak most
 * of it.
 *
 * Consolidates onehome's `fingerprint()` — for `<svc>_set_session`-style tools
 * that echo back WHICH credential they stored without echoing the credential.
 */
export function maskSecret(value: string, opts: MaskSecretOptions = {}): string {
  const head = opts.head ?? 8;
  const tail = opts.tail ?? 4;
  if (value.length <= head + tail) return '…';
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}
