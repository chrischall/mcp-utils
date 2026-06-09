/**
 * Session scaffolding for the MCP fleet — three related-but-distinct surfaces
 * consolidated behind one subpath (`@chrischall/mcp-utils/session`):
 *
 *  1. {@link SessionRegistry} — an *ephemeral, in-memory* registry of signed-in
 *     sessions keyed by account identity, plus {@link registerSessionTools} for
 *     the structurally-identical `*_register_session` / `*_set_active_session` /
 *     `*_get_session_context` MCP tool trio. Used by the realty MCPs
 *     (zillow/redfin/compass/homes/onehome).
 *
 *  2. {@link SessionStore} — a *disk-persisted* store with hardened file perms
 *     (0600 file / 0700 dir), normalized keys, and a most-recently-used "active"
 *     pointer. Used by ofw/creditkarma/honeybook.
 *
 *  3. {@link TokenManager} — a bearer-token lifecycle manager: proactive refresh
 *     inside a 5-minute skew window, reactive 401-replay, and a single-flight
 *     semaphore so concurrent callers coalesce into ONE refresh. Used by
 *     skylight/canvas/creditkarma/honeybook/zola.
 *
 * Security-sensitive by design (file perms + token-refresh races), so this is
 * the one audited implementation the fleet shares.
 */

import { z } from 'zod';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  renameSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from '../response/index.js';

// ===========================================================================
// 1. In-memory SessionRegistry + MCP tools
// ===========================================================================

/** How a session was authenticated. Open-ended so per-MCP modes slot in. */
export type AuthMode = 'browser_session' | 'unknown' | (string & {});

/** A registered, signed-in session as surfaced to tools and clients. */
export interface SessionToken {
  /** Opaque label id (`Date.now().toString(36)` + random). Stable across re-registration. */
  session_id: string;
  /**
   * Caller-supplied identity for the signed-in account (usually the saved
   * email). Re-registering the same identity updates the existing entry in
   * place rather than creating a duplicate.
   */
  account_identity: string;
  auth_mode: AuthMode;
  /** Whether the session is currently usable for tool calls. */
  auth_ready: boolean;
  /** ISO timestamp of when the session was last registered/refreshed. */
  registered_at: string;
  /** ISO expiry, or `null` for "no known expiry". */
  auth_expires_at: string | null;
}

/** Snapshot returned by {@link SessionRegistry.getContext}. */
export interface SessionContext {
  active_session_id: string | null;
  sessions: SessionToken[];
}

/** Arguments to {@link SessionRegistry.register}. */
export interface RegisterArgs {
  account_identity: string;
  auth_mode?: AuthMode;
  /**
   * `undefined` keeps any existing expiry on re-registration; an explicit
   * value (including `null`) replaces it. This distinction matters — coercing
   * with `?? null` would silently wipe a previously-set expiry.
   */
  auth_expires_at?: string | null;
}

/** Generate a short, collision-resistant label id. */
function makeSessionId(): string {
  return Date.now().toString(36) + randomBytes(6).toString('hex');
}

/**
 * Per-process, in-memory registry of signed-in sessions. The constructor takes
 * no arguments, so it's safe to instantiate per test. Sessions are keyed by
 * `session_id` but de-duplicated by `account_identity`.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionToken>();
  private activeId: string | null = null;

  /**
   * Register a new session, or refresh the existing one keyed by
   * `account_identity`. The first session registered becomes the active one.
   */
  register(args: RegisterArgs): SessionToken {
    const identity = args.account_identity.trim();
    if (identity.length === 0) {
      throw new Error('register: account_identity must be non-empty.');
    }
    for (const existing of this.sessions.values()) {
      if (existing.account_identity === identity) {
        if (args.auth_mode !== undefined) existing.auth_mode = args.auth_mode;
        existing.auth_ready = true;
        existing.registered_at = new Date().toISOString();
        if (args.auth_expires_at !== undefined) {
          existing.auth_expires_at = args.auth_expires_at;
        }
        return { ...existing };
      }
    }
    const sess: SessionToken = {
      session_id: makeSessionId(),
      account_identity: identity,
      auth_mode: args.auth_mode ?? 'browser_session',
      auth_ready: true,
      registered_at: new Date().toISOString(),
      auth_expires_at: args.auth_expires_at ?? null,
    };
    this.sessions.set(sess.session_id, sess);
    if (this.activeId === null) this.activeId = sess.session_id;
    return { ...sess };
  }

  /** Switch the active session. Returns `false` if the id is unknown. */
  setActive(sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) return false;
    this.activeId = sessionId;
    return true;
  }

  /** Look up a session by id (returns a copy, or `null`). */
  get(sessionId: string): SessionToken | null {
    const s = this.sessions.get(sessionId);
    return s ? { ...s } : null;
  }

  /** Snapshot of the full registry plus the active id. */
  getContext(): SessionContext {
    return {
      active_session_id: this.activeId,
      sessions: Array.from(this.sessions.values()).map((s) => ({ ...s })),
    };
  }

  /** The active session id, if any. */
  activeSessionId(): string | null {
    return this.activeId;
  }

  /** Number of registered sessions. */
  size(): number {
    return this.sessions.size;
  }

  /**
   * Resolve which session a tool call should route through:
   * - `requested` set and known → it;
   * - `requested` set but unknown → throws;
   * - `requested` undefined → the active session;
   * - no sessions registered → `null` (caller uses the default transport).
   */
  resolve(requested: string | undefined): string | null {
    if (requested !== undefined) {
      if (!this.sessions.has(requested)) {
        throw new Error(
          `Unknown session_id "${requested}". Call the get_session_context tool to see registered sessions.`,
        );
      }
      return requested;
    }
    return this.activeId;
  }

  /** Clear all state. Test helper. */
  reset(): void {
    this.sessions.clear();
    this.activeId = null;
  }
}

/** Construct a fresh in-memory {@link SessionRegistry}. */
export function createSessionRegistry(): SessionRegistry {
  return new SessionRegistry();
}

/** Options for {@link registerSessionTools}. */
export interface RegisterSessionToolsOptions {
  /**
   * Tool-name prefix, e.g. `'zillow'` → `zillow_register_session`. This is the
   * one per-MCP knob; everything else is identical across the fleet.
   */
  prefix: string;
  /** Human label for the service (defaults to the prefix). */
  serviceLabel?: string;
}

/**
 * Register the structurally-identical session tool trio against `server`,
 * backed by `registry`. Replaces every MCP's hand-rolled `src/tools/sessions.ts`.
 */
export function registerSessionTools(
  server: McpServer,
  registry: SessionRegistry,
  opts: RegisterSessionToolsOptions,
): void {
  const { prefix } = opts;
  const label = opts.serviceLabel ?? prefix;
  const ctxTool = `${prefix}_get_session_context`;

  server.registerTool(
    `${prefix}_register_session`,
    {
      title: `Register a signed-in ${label} session`,
      description:
        `Register (or refresh) an authenticated ${label} session keyed by signed-in account identity. ` +
        'Re-registering the same `account_identity` updates the existing session rather than creating a duplicate. ' +
        'Returns the `session_id` to use when routing per-tool calls. ' +
        'The first registered session becomes the default `active_session_id`.',
      annotations: {
        title: `Register a signed-in ${label} session`,
        readOnlyHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        account_identity: z
          .string()
          .min(1)
          .describe('Caller-supplied identifier for the signed-in account (typically the saved-account email).'),
        auth_expires_at: z
          .string()
          .optional()
          .describe('Optional ISO timestamp at which the session expires.'),
      },
    },
    async ({ account_identity, auth_expires_at }) => {
      // Pass `auth_expires_at` through as-is: `undefined` means "keep existing",
      // never coerce with `?? null` (that would wipe a prior expiry).
      const session = registry.register({ account_identity, auth_expires_at });
      return textResult({ session, active_session_id: registry.activeSessionId() });
    },
  );

  server.registerTool(
    `${prefix}_set_active_session`,
    {
      title: `Set the active ${label} session`,
      description:
        'Switch which registered session subsequent tool calls route through by default. ' +
        `Pass a \`session_id\` previously returned by \`${prefix}_register_session\`. ` +
        'Tools that accept an explicit `session_id` parameter override this default per-call.',
      annotations: {
        title: `Set the active ${label} session`,
        readOnlyHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {
        session_id: z.string().min(1).describe('Session id to make active.'),
      },
    },
    async ({ session_id }) => {
      if (!registry.setActive(session_id)) {
        throw new Error(`Unknown session_id "${session_id}". Call ${ctxTool} to see registered sessions.`);
      }
      return textResult({
        active_session_id: registry.activeSessionId(),
        context: registry.getContext(),
      });
    },
  );

  server.registerTool(
    ctxTool,
    {
      title: `List all registered ${label} sessions`,
      description:
        'Return the full set of registered sessions plus the current `active_session_id`. ' +
        'When no sessions are registered, `sessions` is empty and `active_session_id` is null.',
      annotations: {
        title: `List all registered ${label} sessions`,
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: {},
    },
    async () => textResult(registry.getContext()),
  );
}

// ===========================================================================
// 2. Disk-persisted SessionStore
// ===========================================================================

/**
 * Given a full URL or just an origin, return the origin without a trailing
 * slash. Falls back to trimming a trailing slash for non-URL input.
 */
export function normalizeOrigin(input: string): string {
  try {
    return new URL(input).origin.replace(/\/$/, '');
  } catch {
    return input.replace(/\/$/, '');
  }
}

/** Options for {@link SessionStore}. `T` is the persisted record shape. */
export interface SessionStoreOptions<T> {
  /** Absolute path to the JSON file. Parent dirs are created as needed. */
  filePath: string;
  /** Extract the unique key (e.g. origin / account id) from a record. */
  keyOf: (session: T) => string;
  /**
   * Normalize a key before storing/looking up. Defaults to
   * {@link normalizeOrigin}. The stored record's key field is also normalized.
   */
  normalizeKey?: (key: string) => string;
}

/**
 * Disk-persisted session store with hardened file permissions. Records are kept
 * in a `Map` keyed by their normalized key, persisted as a JSON array (insertion
 * order). The file is written with mode `0600` and its directory `0700` so other
 * users on the machine cannot read captured credentials.
 *
 * `add` marks the record most-recently-used; {@link SessionStore.getActiveSession}
 * (and `get()` with no argument) returns it, so a tool call that omits an explicit
 * key picks up the latest session automatically.
 */
export class SessionStore<T extends Record<string, unknown>> {
  private sessions = new Map<string, T>();
  private mostRecentKey: string | null = null;
  private readonly filePath: string;
  private readonly keyOf: (session: T) => string;
  private readonly normalizeKey: (key: string) => string;

  constructor(opts: SessionStoreOptions<T>) {
    this.filePath = opts.filePath;
    this.keyOf = opts.keyOf;
    this.normalizeKey = opts.normalizeKey ?? normalizeOrigin;
    this.loadFromDisk();
  }

  private loadFromDisk(): void {
    if (!existsSync(this.filePath)) return;
    try {
      this.sessions = this.deserialize(readFileSync(this.filePath, 'utf8'));
      const keys = Array.from(this.sessions.keys());
      this.mostRecentKey = keys[keys.length - 1] ?? null;
    } catch (err) {
      // A corrupt cache must not brick the server, but it also must not be
      // silently destroyed: the next save() would otherwise overwrite the file
      // and permanently lose the prior credentials. Preserve the original
      // bytes out of the way first, then start empty.
      const backupPath = this.preserveCorruptFile();
      const detail = err instanceof Error ? err.message : String(err);
      // stderr only — stdout is reserved for JSON-RPC in MCP servers.
      console.error(
        `[mcp-utils] SessionStore: failed to parse ${this.filePath} (${detail}); ` +
          (backupPath !== null
            ? `preserved the corrupt file at ${backupPath}; `
            : 'could not preserve the corrupt file; ') +
          'starting with an empty store.',
      );
      this.sessions = new Map();
      this.mostRecentKey = null;
    }
  }

  /**
   * Move a corrupt store file to `<filePath>.corrupt` (or `.corrupt-<n>` if a
   * previous backup exists) so a subsequent save cannot overwrite the only
   * copy of the prior credentials. Best-effort: returns the backup path, or
   * `null` if the rename failed.
   */
  private preserveCorruptFile(): string | null {
    try {
      let candidate = `${this.filePath}.corrupt`;
      for (let n = 1; existsSync(candidate) && n <= 100; n++) {
        candidate = `${this.filePath}.corrupt-${n}`;
      }
      // All 101 slots taken — refuse rather than clobber the last backup.
      if (existsSync(candidate)) return null;
      renameSync(this.filePath, candidate);
      return candidate;
    } catch {
      return null;
    }
  }

  /** Serialize the store to its on-disk JSON form (array, insertion order). */
  serialize(): string {
    return JSON.stringify(Array.from(this.sessions.values()), null, 2);
  }

  /** Parse on-disk JSON back into a keyed `Map`; empty map on invalid input. */
  private deserialize(body: string): Map<string, T> {
    const map = new Map<string, T>();
    const arr = JSON.parse(body) as unknown;
    if (!Array.isArray(arr)) return map;
    for (const raw of arr) {
      if (raw && typeof raw === 'object') {
        const s = raw as T;
        const key = this.normalizeKey(this.keyOf(s));
        map.set(key, s);
      }
    }
    return map;
  }

  private saveToDisk(): void {
    const dir = dirname(this.filePath);
    // mode applies to every directory this call creates, so intermediate dirs
    // are never left at the umask default (0755).
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Tighten a pre-existing file BEFORE writing new secret content — the
    // write-then-chmod ordering leaves a window where fresh secrets sit in a
    // file that may still be world-readable.
    if (existsSync(this.filePath)) {
      try {
        chmodSync(this.filePath, 0o600);
      } catch {
        /* best-effort */
      }
    }
    writeFileSync(this.filePath, this.serialize(), { mode: 0o600 });
    // Re-assert file + dir perms (writeFileSync's mode and mkdirSync's mode
    // only apply on creation, not to pre-existing loose entries).
    try {
      chmodSync(this.filePath, 0o600);
      chmodSync(dir, 0o700);
    } catch {
      /* best-effort */
    }
  }

  /** Insert or replace a record, normalizing its key and marking it active. */
  add(session: T): void {
    const key = this.normalizeKey(this.keyOf(session));
    this.sessions.set(key, session);
    this.mostRecentKey = key;
    this.saveToDisk();
  }

  /** Look up by key; with no key, returns the active (most-recent) session. */
  get(key?: string): T | null {
    if (key !== undefined) return this.sessions.get(this.normalizeKey(key)) ?? null;
    if (this.mostRecentKey !== null) return this.sessions.get(this.mostRecentKey) ?? null;
    return null;
  }

  /** The most-recently-added session, or `null`. */
  getActiveSession(): T | null {
    return this.get();
  }

  /** All sessions in insertion order. */
  list(): T[] {
    return Array.from(this.sessions.values());
  }

  /** Remove a session; fixes up the active pointer. Returns whether it existed. */
  remove(key: string): boolean {
    const normalized = this.normalizeKey(key);
    const had = this.sessions.delete(normalized);
    if (had) {
      if (this.mostRecentKey === normalized) {
        const keys = Array.from(this.sessions.keys());
        this.mostRecentKey = keys[keys.length - 1] ?? null;
      }
      this.saveToDisk();
    }
    return had;
  }

  /** Clear in-memory state without touching disk. Test helper. */
  resetForTest(): void {
    this.sessions.clear();
    this.mostRecentKey = null;
  }
}

// ===========================================================================
// 3. TokenManager — bearer lifecycle (skew, proactive + reactive, race-safe)
// ===========================================================================

/** Refresh proactively this many ms before the access token expires. */
export const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** A bearer access token + (optional) refresh token + absolute expiry. */
export interface BearerTokens {
  accessToken: string;
  /** Refresh token, if the flow uses one. */
  refreshToken?: string;
  /** Absolute expiry in epoch milliseconds. */
  expiresAt: number;
}

/** Result a {@link TokenManagerOptions.refresh} call must return. */
export interface RefreshedTokens {
  accessToken: string;
  /** Omit to keep the current refresh token (rotation is optional). */
  refreshToken?: string;
  expiresAt: number;
}

/** Options for {@link TokenManager}. */
export interface TokenManagerOptions {
  /** Initial tokens (typically from env or a one-shot bootstrap). */
  initial: BearerTokens;
  /**
   * Exchange the current refresh token for fresh tokens. Called at most once
   * per concurrent burst (the in-flight promise is shared).
   */
  refresh: (refreshToken: string) => Promise<RefreshedTokens>;
  /**
   * Override the skew window (ms before expiry that triggers a proactive
   * refresh). Defaults to {@link TOKEN_REFRESH_SKEW_MS} (5 minutes).
   */
  skewMs?: number;
}

/**
 * Manages a bearer access token's lifecycle:
 *
 * - **Proactive:** {@link TokenManager.getAccessToken} refreshes when the token
 *   is within `skewMs` (default 5 min) of expiry, returning a still-valid token.
 * - **Reactive:** {@link TokenManager.withAuth} runs a request, and on a `401`
 *   refreshes once and replays exactly once (no infinite loop).
 * - **Race-safe:** concurrent refreshes coalesce onto a single in-flight promise
 *   (semaphore), so a burst of callers triggers exactly ONE token exchange. The
 *   in-flight promise is cleared on settle so a later refresh can run again.
 */
export class TokenManager {
  private accessToken: string;
  private refreshToken: string | undefined;
  private expiresAt: number;
  private readonly refreshFn: (refreshToken: string) => Promise<RefreshedTokens>;
  private readonly skewMs: number;
  private inFlight: Promise<void> | undefined;

  constructor(opts: TokenManagerOptions) {
    this.accessToken = opts.initial.accessToken;
    this.refreshToken = opts.initial.refreshToken;
    this.expiresAt = opts.initial.expiresAt;
    this.refreshFn = opts.refresh;
    this.skewMs = opts.skewMs ?? TOKEN_REFRESH_SKEW_MS;
  }

  /** Whether the token is within the skew window of (or past) expiry. */
  private needsRefresh(): boolean {
    return Date.now() >= this.expiresAt - this.skewMs;
  }

  /**
   * Single-flight refresh. Concurrent callers share one in-flight promise; it is
   * cleared on settle (success or failure) so a subsequent refresh can proceed.
   */
  refreshNow(): Promise<void> {
    if (!this.inFlight) {
      const rt = this.refreshToken;
      if (rt === undefined) {
        return Promise.reject(
          new Error('TokenManager: cannot refresh — no refresh token is available.'),
        );
      }
      this.inFlight = (async () => {
        const tok = await this.refreshFn(rt);
        this.accessToken = tok.accessToken;
        if (tok.refreshToken !== undefined && tok.refreshToken !== '') {
          this.refreshToken = tok.refreshToken;
        }
        this.expiresAt = tok.expiresAt;
      })().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  /** Get a valid access token, refreshing proactively inside the skew window. */
  async getAccessToken(): Promise<string> {
    if (this.needsRefresh()) await this.refreshNow();
    return this.accessToken;
  }

  /** Current absolute expiry (epoch ms). */
  getExpiresAt(): number {
    return this.expiresAt;
  }

  /**
   * Run an authenticated request with reactive 401-replay. `call` receives a
   * valid access token and returns a `Response`. On `401`, the token is
   * refreshed once and `call` is invoked again exactly once.
   *
   * Guarded against double-refresh: if a concurrent caller already rotated the
   * token while this request was in flight (single-flight settled and cleared),
   * a late `401` from a request sent under the OLD token does NOT trigger a
   * second refresh — under refresh-token rotation that would consume and
   * invalidate the freshly-issued refresh token. It just replays with the
   * current token.
   */
  async withAuth(call: (accessToken: string) => Promise<Response>): Promise<Response> {
    const usedToken = await this.getAccessToken();
    let res = await call(usedToken);
    if (res.status === 401) {
      if (this.accessToken === usedToken) await this.refreshNow();
      res = await call(this.accessToken);
    }
    return res;
  }
}
