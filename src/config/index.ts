import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

/** An environment-variable source: typically `process.env`. */
export type EnvSource = Record<string, string | undefined>;

/** Options shared by the env-reading helpers. */
export interface ReadEnvOptions {
  /** The source to read from. Defaults to {@link process.env}. */
  env?: EnvSource;
  /** Value to return when the variable is unset. */
  default?: string;
}

/**
 * Matches a value that is *entirely* an unsubstituted shell-style placeholder,
 * e.g. `${FOO}` or `${}`. MCP hosts that forward a `.mcp.json` env block without
 * expanding it can leak these literals into credential slots — treating them as
 * unset is the canonical defense against the placeholder-leakage class of bugs.
 *
 * Only a value that is the placeholder *and nothing else* is suppressed; a real
 * secret that happens to embed `${` is preserved.
 */
const PLACEHOLDER_RE = /^\$\{[^}]*\}$/;

/**
 * Read an environment variable defensively.
 *
 * The value is trimmed of surrounding whitespace and treated as **unset** when
 * it is:
 *  - absent or a non-string,
 *  - empty / whitespace-only,
 *  - the literal string `'undefined'` or `'null'`, or
 *  - an unsubstituted `${...}` placeholder.
 *
 * When unset, returns `opts.default` if provided, otherwise `undefined`.
 *
 * Consolidates the `readVar`/`readEnv`/`readEnvString`/`sanitizeEnvVar` snippet
 * duplicated across 12+ MCP servers.
 */
export function readEnvVar(key: string, opts: ReadEnvOptions = {}): string | undefined {
  const env = opts.env ?? process.env;
  const raw = env[key];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (
      trimmed.length > 0 &&
      trimmed !== 'undefined' &&
      trimmed !== 'null' &&
      !PLACEHOLDER_RE.test(trimmed)
    ) {
      return trimmed;
    }
  }
  return opts.default;
}

/** Options for {@link requireEnvVar}. */
export interface RequireEnvOptions {
  /** The source to read from. Defaults to {@link process.env}. */
  env?: EnvSource;
  /** Remediation text appended to the thrown error ("here's how to fix it"). */
  hint?: string;
}

/**
 * Like {@link readEnvVar} but throws a helpful, value-free error when the
 * variable is unset (or a placeholder/sentinel). The error names only the
 * variable and the optional `hint` — never the offending value — so a leaked
 * placeholder is not echoed back to the caller.
 */
export function requireEnvVar(key: string, opts: RequireEnvOptions = {}): string {
  const value = readEnvVar(key, { env: opts.env });
  if (value === undefined) {
    const base = `Missing required environment variable ${key}`;
    throw new Error(opts.hint ? `${base}. ${opts.hint}` : base);
  }
  return value;
}

/** Options for {@link parseBoolEnv}. */
export interface ParseBoolEnvOptions {
  /** The source to read from. Defaults to {@link process.env}. */
  env?: EnvSource;
  /** Result when the variable is unset or unrecognised. Defaults to `false`. */
  default?: boolean;
}

const TRUE_TOKENS = new Set(['1', 'true', 'yes', 'on']);
const FALSE_TOKENS = new Set(['0', 'false', 'no', 'off']);

/**
 * Parse a boolean-ish environment variable. Recognises (case-insensitively)
 * `1/true/yes/on` as `true` and `0/false/no/off` as `false`. Anything unset,
 * placeholder/sentinel, or unrecognised falls back to `opts.default` (`false`).
 *
 * Consolidates the `['1','true','yes','on'].includes(...)` `*_DISABLE_*` flag
 * pattern duplicated across the fleet.
 */
export function parseBoolEnv(key: string, opts: ParseBoolEnvOptions = {}): boolean {
  const fallback = opts.default ?? false;
  const raw = readEnvVar(key, { env: opts.env });
  if (raw === undefined) return fallback;
  const token = raw.toLowerCase();
  if (TRUE_TOKENS.has(token)) return true;
  if (FALSE_TOKENS.has(token)) return false;
  return fallback;
}

/**
 * Expand a user-provided filesystem path:
 *  - a leading `~` or `~/...` expands to the user's home directory, and
 *  - any remaining relative path is resolved against the current working dir.
 *
 * Note: `~user` (other-user home lookup) and mid-path `~` are intentionally
 * NOT expanded — only the current user's home is ever substituted.
 */
export function expandPath(p: string): string {
  let expanded = p;
  if (p === '~') {
    expanded = homedir();
  } else if (p.startsWith('~/')) {
    expanded = join(homedir(), p.slice(2));
  }
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** Options for {@link loadDotenvSafely}. */
export interface LoadDotenvOptions {
  /** Path to the `.env` file. Defaults to dotenv's own resolution (CWD). */
  path?: string;
  /**
   * When `true`, `.env` values overwrite already-set `process.env` entries.
   * Defaults to `false` so real host-provided env always wins.
   */
  override?: boolean;
}

/**
 * Load a `.env` file for local development, swallowing any failure.
 *
 * `dotenv` is imported dynamically and the whole thing is wrapped so that a
 * missing module (e.g. inside an mcpb bundle, where credentials arrive via the
 * host's `mcp_config.env`) is a silent no-op rather than a crash. Real
 * environment values take precedence unless `override` is set.
 *
 * @returns `true` if a `.env` file was loaded without error, `false` otherwise.
 */
export async function loadDotenvSafely(opts: LoadDotenvOptions = {}): Promise<boolean> {
  try {
    // dotenv is an optional, dev-only dependency — it is absent in bundled
    // (mcpb) runtimes. Import it through a computed specifier so the type
    // checker does not require its declarations to be installed, and so a
    // missing module degrades to the catch below rather than a build error.
    type DotenvConfig = (o: {
      path?: string;
      override?: boolean;
      quiet?: boolean;
    }) => { error?: unknown };
    const mod = (await import(/* @vite-ignore */ 'dotenv' as string)) as {
      config: DotenvConfig;
    };
    const result = mod.config({
      ...(opts.path !== undefined ? { path: opts.path } : {}),
      override: opts.override ?? false,
      quiet: true,
    });
    return result.error === undefined;
  } catch {
    // dotenv unavailable (bundled runtime) — rely on process.env.
    return false;
  }
}
