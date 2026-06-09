import { readFileSync } from 'node:fs';
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

/** Options for {@link readPortEnv}. */
export interface ReadPortEnvOptions {
  /** The source to read from. Defaults to {@link process.env}. */
  env?: EnvSource;
}

/**
 * Read a TCP port from an environment variable, hardened the way
 * {@link readEnvVar} hardens any var (trim, treat blank / `'undefined'` /
 * `'null'` / unsubstituted `${...}` placeholder as unset) PLUS numeric
 * validation: the value must parse to an integer in the valid port range
 * `1..65535`.
 *
 * Returns `fallback` when the variable is unset, a placeholder, non-numeric, or
 * out of range. Consolidates the bare `Number(process.env.X_WS_PORT)` pattern
 * across compass/redfin/homes/musescore, which yields `NaN` on an unexpanded
 * `${...}` placeholder or junk and then hands `NaN` to the server.
 *
 * @example readPortEnv('REDFIN_WS_PORT', 37149)
 */
export function readPortEnv(key: string, fallback: number, opts: ReadPortEnvOptions = {}): number {
  const raw = readEnvVar(key, { env: opts.env });
  if (raw === undefined) return fallback;
  // Strict integer parse: reject `12abc`, `1.5`, `0x10`, etc. that `Number`
  // would otherwise coerce or accept.
  if (!/^\d+$/.test(raw)) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fallback;
  return port;
}

/** A minimal injectable file reader: returns the file's UTF-8 contents. */
export type ReadFileSyncFn = (path: string) => string;

/** Options for {@link createCachedJsonArrayLoader}. */
export interface CachedJsonArrayLoaderOptions {
  /** Name of the env var holding the path to a JSON string-array file. */
  envVar: string;
  /** Returned when the var is unset, or the file is missing/unreadable/invalid. */
  defaults: string[];
  /** The source to read env from. Defaults to {@link process.env}. */
  env?: EnvSource;
  /**
   * Injectable file reader (for tests). Defaults to a `node:fs` reader that
   * throws when the file is missing — a missing file is caught and
   * negative-cached like any other read failure.
   */
  readFile?: ReadFileSyncFn;
  /**
   * Label woven into the stderr warning on a missing/invalid file (e.g.
   * `'redfin-mcp'`). Defaults to the env-var name.
   */
  label?: string;
}

/**
 * Build a cached, negative-cached loader for an env-named JSON string-array
 * file — the `loadCommunities` + `DEFAULT_COMMUNITIES` pattern quadruplicated
 * across redfin/zillow/homes/onehome (only the env var differs:
 * `REDFIN_/ZILLOW_/HOMES_/ONEHOME_COMMUNITIES_FILE`).
 *
 * The returned function:
 *  - reads the file path from `envVar` via {@link readEnvVar} (placeholder
 *    hardening), returning `defaults` when unset (and clearing any cache),
 *  - parses the file as a JSON array of strings; on success caches and returns
 *    it (keyed by the env-var value, so a path change re-reads),
 *  - on a missing / unreadable file, invalid JSON, or non-string-array,
 *    logs a single stderr warning and **negative-caches** — it returns
 *    `defaults` without re-reading on subsequent calls for the same path,
 *  - never re-reads a successfully-cached file.
 *
 * @example
 * const loadCommunities = createCachedJsonArrayLoader({
 *   envVar: 'REDFIN_COMMUNITIES_FILE',
 *   defaults: DEFAULT_COMMUNITIES,
 *   label: 'redfin-mcp',
 * });
 */
export function createCachedJsonArrayLoader(opts: CachedJsonArrayLoaderOptions): () => string[] {
  const env = opts.env ?? process.env;
  const label = opts.label ?? opts.envVar;
  // Default reader: `node:fs#readFileSync` (utf8). A missing file throws, which
  // the catch below turns into a negative-cached fallback — mirroring redfin's
  // original `existsSync` guard without the extra stat.
  const readFile = opts.readFile ?? ((path: string): string => readFileSync(path, 'utf8'));

  let cached: string[] | null = null;
  // Path the cache (positive OR negative) is keyed to. A negative cache is
  // `cached === null && cachedPath === <path>`: we resolved that path to
  // defaults and won't re-read it.
  let cachedPath: string | null = null;

  return function load(): string[] {
    const path = readEnvVar(opts.envVar, { env });
    if (!path) {
      // Unset: never cache (the var may be set later) and return defaults.
      cached = null;
      cachedPath = null;
      return opts.defaults;
    }
    if (cachedPath === path) {
      // Same path as last time — positive cache (return it) or negative cache
      // (cached === null → return defaults without re-reading).
      return cached ?? opts.defaults;
    }
    try {
      const raw = readFile(path);
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === 'string')) {
        console.error(
          `[${label}] ${opts.envVar}="${path}" must be a JSON string array — falling back to defaults.`,
        );
        cached = null;
        cachedPath = path; // negative-cache this path
        return opts.defaults;
      }
      cached = parsed;
      cachedPath = path;
      return cached;
    } catch (err) {
      console.error(
        `[${label}] failed to load ${opts.envVar}="${path}": ${
          err instanceof Error ? err.message : String(err)
        } — falling back to defaults.`,
      );
      cached = null;
      cachedPath = path; // negative-cache this path
      return opts.defaults;
    }
  };
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
