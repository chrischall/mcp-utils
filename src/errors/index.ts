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

  constructor(path: string, retryAfterSeconds: number = DEFAULT_BOT_WALL_RETRY_AFTER_S) {
    const hint = `Back off and retry (suggested wait: ${retryAfterSeconds}s). If it persists, open the site in your browser, clear the CAPTCHA, then retry with a smaller batch.`;
    super(
      `Served an anti-bot CAPTCHA wall for ${path} — the request was rate-limited, not a missing resource. ${hint}`,
      { hint },
    );
    this.name = 'BotWallError';
    this.retryAfterSeconds = retryAfterSeconds;
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
const JWT_RE = /\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g;

/**
 * Redact secrets that commonly leak into upstream error bodies before the text
 * is surfaced to a client: `Bearer <token>` headers and standalone JWTs.
 */
function redactSecrets(text: string): string {
  return text.replace(BEARER_RE, '$1[REDACTED]').replace(JWT_RE, '[REDACTED]');
}

/**
 * Redact secrets, then cap an (upstream) error string at `max` characters,
 * appending a `… [truncated]` marker when clipped.
 *
 * Security: redaction runs BEFORE truncation so a token straddling the cut
 * boundary can't survive in a half-form. Untrusted upstream bodies must always
 * go through this before reaching a tool result.
 */
export function truncateErrorMessage(text: string, max: number = DEFAULT_ERROR_MESSAGE_MAX): string {
  const str = text === null || text === undefined ? '' : String(text);
  const redacted = redactSecrets(str);
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
