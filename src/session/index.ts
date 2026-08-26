/**
 * Session scaffolding for the MCP fleet — five related-but-distinct surfaces
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
 *  3. {@link StatePersistence} — the opt-in seam that lets the two managers
 *     below survive a process restart, with {@link createFileStatePersistence}
 *     (atomic, 0600) and {@link resolveStateDir} (`MCP_DATA_DIR` → `HOME`) as
 *     the disk-backed default. Without it a scale-to-zero host re-runs a full
 *     login on every cold start, against endpoints that often rate-limit it.
 *
 *  4. {@link TokenManager} — a bearer-token lifecycle manager: a lazily
 *     bootstrapped login, proactive refresh inside a 5-minute skew window,
 *     reactive 401-replay, and a single-flight semaphore so concurrent callers
 *     coalesce into ONE exchange. Used by skylight/canvas/creditkarma/honeybook/zola.
 *
 *  5. {@link CookieSessionManager} — the cookie-session analog of TokenManager:
 *     a single-flight login + reactive expiry-replay (with heuristic, not just
 *     status-code, expiry detection) + clear-on-settle so a rejected login never
 *     sticks. Used by artsonia/canvas/evite/signupgenius/skylight.
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
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { textResult } from '../response/index.js';
import { readEnvVar } from '../config/index.js';
import { ApiError, RateLimitedError, RequestTimeoutError } from '../http/index.js';

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
 *
 * `${prefix}_register_session` accepts an optional `mark_active` boolean
 * (default `false`): when `true`, the newly-registered session is immediately
 * made active in the same call (equivalent to a follow-up
 * `${prefix}_set_active_session`). Omitting it preserves the
 * first-registered-wins active-session behaviour.
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
        'The first registered session becomes the default `active_session_id`. ' +
        'Pass `mark_active: true` to make the newly-registered session active in the same call.',
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
        mark_active: z
          .boolean()
          .optional()
          .default(false)
          .describe('When true, immediately make the newly-registered session the active one.'),
      },
    },
    async ({ account_identity, auth_expires_at, mark_active }) => {
      // Pass `auth_expires_at` through as-is: `undefined` means "keep existing",
      // never coerce with `?? null` (that would wipe a prior expiry).
      const session = registry.register({ account_identity, auth_expires_at });
      // `mark_active` defaults to false, so callers that omit it keep the prior
      // active session (the first-registered-wins behaviour) byte-for-byte.
      if (mark_active) registry.setActive(session.session_id);
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
// 3. StatePersistence — surviving a process restart
// ===========================================================================

/**
 * A place to keep a credential between processes.
 *
 * Why this exists: {@link TokenManager} and {@link CookieSessionManager} own a
 * credential's lifecycle *within* a process, and every fleet server used to
 * throw that credential away on exit — so a cold start re-ran the full login
 * even when a valid refresh token had been minted seconds earlier. On
 * `mcp-host` that is the normal case, not the exception: children idle out
 * after ten minutes and the machine scales to zero behind them. Several
 * services rate-limit the login endpoint, and at least one (per the kiaaccess
 * notes) escalates repeated attempts to a captcha that breaks server-side auth
 * for the account permanently. Re-login is not always a free retry.
 *
 * Deliberately opt-in: a manager given no `persistence` behaves exactly as it
 * did before, and no credential reaches a disk because a package was upgraded.
 *
 * Both methods may be sync or async. The fleet's own implementation
 * ({@link createFileStatePersistence}) is sync — it writes one small file — but
 * the async signature leaves room for a backend that has to go over a wire.
 *
 * **Implementations must not throw.** The managers guard every call anyway, but
 * the contract is that a persistence failure degrades to in-memory operation:
 * a read-only or full disk must cost a re-login, never a failed request.
 */
export interface StatePersistence<T> {
  /** Read the stored state; `null` when absent, unparseable, or unusable. */
  load(): T | null | Promise<T | null>;
  /** Write state, replacing whatever was there. */
  save(state: T): void | Promise<void>;
  /**
   * Discard the stored state. Optional, but a manager that detects its stored
   * credential is no good calls this — without it, an expired session is read
   * straight back off disk and the expiry loops.
   */
  clear?(): void | Promise<void>;
}

/** Options for {@link createFileStatePersistence}. */
export interface FileStatePersistenceOptions<T> {
  /** Absolute path to the JSON file. Parent directories are created as needed. */
  filePath: string;
  /**
   * Narrow the parsed JSON to `T`, returning `null` to reject it. Without this
   * any well-formed JSON is handed back and the caller must check the shape —
   * the managers do, but a custom consumer should pass a guard.
   */
  validate?: (raw: unknown) => T | null;
}

/**
 * File-backed {@link StatePersistence}. The file is `0600`, re-asserted after
 * the write because `mode` only applies on creation. A directory is created
 * `0700` and re-asserted the same way — but ONLY one this call creates: a bare
 * {@link resolveStateDir} is `$HOME`, and on `mcp-host` the data dir exists
 * before the child starts, so re-permissioning a pre-existing directory would
 * be an invasive side effect of writing one token file rather than hardening.
 *
 * Two differences from {@link SessionStore}, which is why this is its own
 * implementation rather than a wrapper over it. It holds ONE record rather than
 * a keyed collection; and it replaces the file **atomically** — written to a
 * temp file beside it, then renamed over the target — because two children of
 * the same registration can share a data directory, and a half-written token
 * file that parses as valid JSON is worse than none.
 *
 * Nothing here throws. A load failure (absent, corrupt, rejected by `validate`)
 * returns `null`; a save failure is swallowed and leaves the previous file
 * intact. On `mcp-host` this belongs under {@link resolveStateDir}, which needs
 * the registration to declare `state.dataDir: true` — the runner's
 * unpersisted-state detector will report the omission rather than let the
 * writes silently vanish on the next idle-stop.
 */
export function createFileStatePersistence<T>(
  opts: FileStatePersistenceOptions<T>,
): Required<StatePersistence<T>> {
  const { filePath, validate } = opts;

  return {
    load(): T | null {
      if (!existsSync(filePath)) return null;
      try {
        const raw: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
        if (validate !== undefined) return validate(raw);
        return raw as T;
      } catch {
        // Corrupt or unreadable: the caller re-authenticates. Unlike
        // SessionStore this does NOT preserve a `.corrupt` copy — the file
        // holds one refreshable credential, not an irreplaceable capture.
        return null;
      }
    },

    save(state: T): void {
      const dir = dirname(filePath);
      // A unique temp name so two writers cannot share (and tear) one temp file.
      const tmp = `${filePath}.tmp-${randomBytes(6).toString('hex')}`;
      // Only a directory THIS call creates gets tightened. `resolveStateDir()`
      // without a `subdir` is `$HOME`, and chmodding a user's home directory to
      // 0700 is not an acceptable side effect of writing one token file.
      const dirExisted = existsSync(dir);
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        // mkdir's mode is subject to the umask, so re-assert it on what we made.
        if (!dirExisted) chmodSync(dir, 0o700);
        writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
        // Tighten BEFORE the rename: the window where fresh secrets sit in a
        // possibly-loose file should not exist at all.
        chmodSync(tmp, 0o600);
        renameSync(tmp, filePath);
        chmodSync(filePath, 0o600);
      } catch {
        // Degrade to in-memory. Best-effort cleanup of the temp file so a
        // failed write does not litter the data dir.
        try {
          if (existsSync(tmp)) unlinkSync(tmp);
        } catch {
          /* best-effort */
        }
      }
    },

    clear(): void {
      try {
        if (existsSync(filePath)) unlinkSync(filePath);
      } catch {
        /* best-effort */
      }
    },
  };
}

/** Options for {@link resolveStateDir}. */
export interface ResolveStateDirOptions {
  /** Environment to read (defaults to `process.env`) — injectable for tests. */
  env?: Record<string, string | undefined>;
  /** Optional service-scoped subdirectory to join onto the base. */
  subdir?: string;
}

/**
 * Where a server should keep state that must survive a restart.
 *
 * `MCP_DATA_DIR` first — that is the variable `mcp-host` injects for a
 * registration with `state.dataDir: true`, pointing at a path on the Fly volume
 * keyed by the registration itself (a slot `$HOME` is handed out by arrival
 * order and moves between boots, which is why the data dir is the fix and a
 * bigger rootfs is not). Then `HOME`, then the OS home directory.
 *
 * Blank and unexpanded-placeholder values (`${MCP_DATA_DIR}`, the shape a host
 * config leaves behind when a variable was never substituted) are ignored
 * rather than used as a literal directory name — the same hardening
 * {@link readEnvVar} applies.
 */
export function resolveStateDir(opts: ResolveStateDirOptions = {}): string {
  // Delegated rather than re-implemented: readEnvVar is the fleet's one place
  // that suppresses blank, `'null'`, `'undefined'` AND `${...}` placeholders.
  // The sentinels matter as much as the placeholders here — `MCP_DATA_DIR=null`
  // is a RELATIVE `./null` directory, so the credential would be written under
  // the process cwd and silently stop surviving restarts.
  const env = opts.env;
  const base =
    readEnvVar('MCP_DATA_DIR', { env }) ?? readEnvVar('HOME', { env }) ?? homedir();
  return opts.subdir !== undefined ? join(base, opts.subdir) : base;
}

// ===========================================================================
// 4. TokenManager — bearer lifecycle (skew, proactive + reactive, race-safe)
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
  /**
   * The starting tokens — either the tokens themselves, or a **bootstrap
   * function** that mints them (typically a full login).
   *
   * Pass the function form to get the persistence benefit: it is invoked only
   * when {@link TokenManagerOptions.persistence} has nothing usable, so a
   * restart that finds a stored token never logs in at all, and one that finds
   * an expired token with a refresh token spends a refresh instead of a login.
   * It is single-flighted like every other credential operation here, so a
   * burst of first calls hits a rate-limited login endpoint exactly once.
   *
   * The eager object form is unchanged: the caller already paid for the login,
   * so persistence is not consulted and the tokens are used as given.
   */
  initial: BearerTokens | (() => Promise<BearerTokens>);
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
  /**
   * Keep tokens across process restarts. Read once on the bootstrap path
   * (function-form `initial` only), written after every successful bootstrap
   * and refresh, including rotation. Omit for the previous in-memory-only
   * behaviour. See {@link StatePersistence}.
   */
  persistence?: StatePersistence<BearerTokens>;
  /**
   * Decide whether a {@link TokenManagerOptions.refresh} rejection means the
   * credential itself is dead (re-mint via the bootstrap) or the endpoint was
   * merely unreachable (surface it, keep the token).
   *
   * The distinction matters in both directions. Treating a transient failure as
   * revocation deletes a still-VALID refresh token and burns a login against an
   * endpoint that may rate-limit or escalate to a captcha — the exact cost this
   * whole feature exists to avoid. Treating a real revocation as transient
   * leaves the server broken until someone deletes the stored file by hand.
   *
   * The default resolves that by only excusing failures that are transient *by
   * construction* — a {@link RateLimitedError}, a {@link RequestTimeoutError},
   * or an {@link ApiError} with a 5xx status. Anything else is assumed to be a
   * dead credential, which keeps the recover-from-revocation guarantee. Override
   * it for a service that signals revocation some other way (or, conversely, one
   * that answers a live token with a 5xx). Mirrors the permanent-vs-transient
   * split {@link CookieSessionManagerOptions.isPermanentError} already makes.
   */
  isRefreshRevoked?: (err: unknown) => boolean;
  /** Injectable clock (defaults to `Date.now`) — for tests. */
  now?: () => number;
}

/**
 * The default {@link TokenManagerOptions.isRefreshRevoked}: everything except
 * the failures mcp-utils itself can prove are transient. Deliberately
 * conservative — an unrecognised error is treated as a dead credential, because
 * a needless re-login costs one request and an unrecoverable one costs the
 * server until a human intervenes.
 */
function defaultIsRefreshRevoked(err: unknown): boolean {
  if (err instanceof RateLimitedError || err instanceof RequestTimeoutError) return false;
  if (err instanceof ApiError && err.status >= 500) return false;
  return true;
}

/** Whether a parsed record has the shape of {@link BearerTokens}. */
function isBearerTokens(raw: unknown): raw is BearerTokens {
  if (raw === null || typeof raw !== 'object') return false;
  const t = raw as Partial<BearerTokens>;
  if (typeof t.accessToken !== 'string' || t.accessToken === '') return false;
  if (typeof t.expiresAt !== 'number' || !Number.isFinite(t.expiresAt)) return false;
  return t.refreshToken === undefined || typeof t.refreshToken === 'string';
}

/**
 * Manages a bearer access token's lifecycle:
 *
 * - **Lazy bootstrap:** with a function-form {@link TokenManagerOptions.initial}
 *   the login runs on first use, and only if {@link TokenManagerOptions.persistence}
 *   has no usable token — the difference between a cold start costing a login
 *   and costing nothing.
 * - **Proactive:** {@link TokenManager.getAccessToken} refreshes when the token
 *   is within `skewMs` (default 5 min) of expiry, returning a still-valid token.
 * - **Reactive:** {@link TokenManager.withAuth} runs a request, and on a `401`
 *   refreshes once and replays exactly once (no infinite loop).
 * - **Race-safe:** concurrent refreshes (and concurrent bootstraps) coalesce
 *   onto a single in-flight promise, so a burst of callers triggers exactly ONE
 *   exchange. The in-flight promise is cleared on settle so a later attempt can
 *   run again — a rejected bootstrap never sticks.
 * - **Recoverable:** when a refresh fails and a bootstrap function is available,
 *   the stored credential is discarded and the login re-runs. A refresh token
 *   revoked between two runs of the process must not brick the server.
 */
export class TokenManager {
  private tokens: BearerTokens | undefined;
  private readonly bootstrapFn: (() => Promise<BearerTokens>) | undefined;
  private readonly refreshFn: (refreshToken: string) => Promise<RefreshedTokens>;
  private readonly skewMs: number;
  private readonly persistence: StatePersistence<BearerTokens> | undefined;
  private readonly now: () => number;
  private readonly isRefreshRevokedFn: (err: unknown) => boolean;
  private inFlight: Promise<void> | undefined;
  private bootstrapInFlight: Promise<BearerTokens> | undefined;
  /**
   * Persistence is consulted at most once per process. Without this the
   * revoked-token recovery below re-reads the SAME rejected record — `clear()`
   * is optional on {@link StatePersistence} and its failures are swallowed, so
   * recovery must not depend on it. After the first read the in-memory tokens
   * (or their deliberate absence) are the truth.
   */
  private persistenceRead = false;

  constructor(opts: TokenManagerOptions) {
    if (typeof opts.initial === 'function') {
      this.bootstrapFn = opts.initial;
    } else {
      this.tokens = { ...opts.initial };
    }
    this.refreshFn = opts.refresh;
    this.skewMs = opts.skewMs ?? TOKEN_REFRESH_SKEW_MS;
    this.persistence = opts.persistence;
    this.now = opts.now ?? Date.now;
    this.isRefreshRevokedFn = opts.isRefreshRevoked ?? defaultIsRefreshRevoked;
  }

  /** Whether the token is within the skew window of (or past) expiry. */
  private needsRefresh(): boolean {
    if (this.tokens === undefined) return false;
    return this.now() >= this.tokens.expiresAt - this.skewMs;
  }

  /**
   * A stored token is worth using when it is still valid, OR when it carries a
   * refresh token — an expired-but-refreshable token still saves the login,
   * which is the expensive half.
   */
  private isUsable(t: BearerTokens): boolean {
    return this.now() < t.expiresAt - this.skewMs || t.refreshToken !== undefined;
  }

  /** Read persisted tokens, guarding shape and usability. Never throws. */
  private async loadPersisted(): Promise<BearerTokens | null> {
    if (this.persistence === undefined || this.persistenceRead) return null;
    this.persistenceRead = true;
    try {
      const raw = await this.persistence.load();
      if (!isBearerTokens(raw) || !this.isUsable(raw)) return null;
      return raw;
    } catch {
      return null;
    }
  }

  /** Write tokens. Never throws — a failed write costs a login, not a request. */
  private async persist(t: BearerTokens): Promise<void> {
    if (this.persistence === undefined) return;
    try {
      await this.persistence.save(t);
    } catch {
      /* in-memory tokens are still valid for this process */
    }
  }

  /** Discard persisted tokens (a refresh they could not satisfy). Never throws. */
  private async clearPersisted(): Promise<void> {
    if (this.persistence?.clear === undefined) return;
    try {
      await this.persistence.clear();
    } catch {
      /* best-effort */
    }
  }

  /** The current tokens, single-flighting the bootstrap if there are none. */
  private ensureTokens(): Promise<BearerTokens> {
    if (this.tokens !== undefined) return Promise.resolve(this.tokens);
    if (this.bootstrapInFlight === undefined) {
      this.bootstrapInFlight = this.runBootstrap().finally(() => {
        this.bootstrapInFlight = undefined;
      });
    }
    return this.bootstrapInFlight;
  }

  /** One bootstrap attempt: persisted tokens if usable, else the login. */
  private async runBootstrap(): Promise<BearerTokens> {
    const stored = await this.loadPersisted();
    if (stored !== null) {
      this.tokens = stored;
      return stored;
    }
    if (this.bootstrapFn === undefined) {
      throw new Error('TokenManager: no tokens and no bootstrap function to mint them.');
    }
    const fresh = await this.bootstrapFn();
    this.tokens = fresh;
    await this.persist(fresh);
    return fresh;
  }

  /**
   * Single-flight refresh. Concurrent callers share one in-flight promise; it is
   * cleared on settle (success or failure) so a subsequent refresh can proceed.
   */
  refreshNow(): Promise<void> {
    if (this.inFlight === undefined) {
      this.inFlight = this.runRefresh().finally(() => {
        this.inFlight = undefined;
      });
    }
    return this.inFlight;
  }

  /** One refresh attempt against the current refresh token. */
  private async runRefresh(): Promise<void> {
    const current = this.tokens ?? (await this.ensureTokens());
    const rt = current.refreshToken;
    if (rt === undefined) {
      throw new Error('TokenManager: cannot refresh — no refresh token is available.');
    }
    const tok = await this.refreshFn(rt);
    this.tokens = {
      accessToken: tok.accessToken,
      // Rotation is optional: keep the current refresh token when none comes back.
      refreshToken:
        tok.refreshToken !== undefined && tok.refreshToken !== '' ? tok.refreshToken : rt,
      expiresAt: tok.expiresAt,
    };
    await this.persist(this.tokens);
  }

  /**
   * Recover from a refresh the current credential could not satisfy — commonly
   * a refresh token restored from a previous process and revoked since. Without
   * a bootstrap to fall back on this is terminal; with one, re-minting beats
   * staying broken forever. Shared so the two entry points cannot diverge.
   */
  private async reBootstrap(err: unknown): Promise<BearerTokens> {
    if (this.bootstrapFn === undefined) throw err;
    // Only a credential we believe is DEAD is worth destroying. A 5xx or a
    // timeout leaves a perfectly good refresh token that the next call can use.
    if (!this.isRefreshRevokedFn(err)) throw err;
    this.tokens = undefined;
    await this.clearPersisted();
    return this.ensureTokens();
  }

  /** Get a valid access token, refreshing proactively inside the skew window. */
  async getAccessToken(): Promise<string> {
    // Not `await this.ensureTokens()` unconditionally: with tokens already in
    // hand that await would defer the refresh below by a microtask, and callers
    // rely on a concurrent burst reaching the single-flight in the SAME tick.
    let tokens = this.tokens ?? (await this.ensureTokens());
    if (this.needsRefresh()) {
      try {
        await this.refreshNow();
      } catch (err) {
        return (await this.reBootstrap(err)).accessToken;
      }
      tokens = this.tokens ?? tokens;
    }
    return tokens.accessToken;
  }

  /** Current absolute expiry (epoch ms), or `0` before the first bootstrap. */
  getExpiresAt(): number {
    return this.tokens?.expiresAt ?? 0;
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
      if (this.tokens?.accessToken === usedToken) {
        // Same revoked-credential recovery getAccessToken has: a 401 replay must
        // not be the one entry point that throws where the other re-mints.
        try {
          await this.refreshNow();
        } catch (err) {
          await this.reBootstrap(err);
        }
      }
      res = await call(this.tokens?.accessToken ?? usedToken);
    }
    return res;
  }
}

// ===========================================================================
// 5. CookieSessionManager — cookie-session lifecycle (single-flight, replay)
// ===========================================================================

/**
 * The minimal cookie-session shape the manager understands. Callers usually
 * supply a richer `S` (extra cookies, a parsed JWT, a frame id, …) — only
 * `cookieHeader` is structurally required, `csrfToken` is the common optional
 * second field (Django/Rails CSRF rotation).
 */
export interface CookieSession {
  /** The `Cookie:` request header value for authenticated calls. */
  cookieHeader: string;
  /** A rotating CSRF token, when the site uses one (e.g. Evite's `X-CSRFToken`). */
  csrfToken?: string;
}

/**
 * Options for {@link CookieSessionManager}. `S` is the caller-defined session
 * shape; `R` is the response type `withSession`'s `call` resolves to, defaulting
 * to the web {@link Response} (override it for a custom/non-fetch transport).
 */
export interface CookieSessionManagerOptions<S, R = Response> {
  /**
   * Site-specific login that mints a fresh cookie session. The manager owns
   * *when* this runs — lazily on first {@link CookieSessionManager.ensure},
   * and again after {@link CookieSessionManager.invalidate} (or an expiry
   * detected by {@link CookieSessionManagerOptions.isExpired}). Called at most
   * once per concurrent burst (the in-flight promise is shared, single-flight).
   */
  login: () => Promise<S>;
  /**
   * Decide whether a response indicates the session expired and a re-login is
   * warranted. This is the injection point for body/URL heuristics: status
   * codes alone are insufficient — SignUpGenius serves a `200` HTML login page
   * on expiry, and Artsonia expires by redirecting away from the target URL.
   * May read the body/headers (return a promise) or just the status (sync).
   * When `R` is the web `Response` (the default), the body is NOT consumed for
   * you — if you read it, pass a clone (`res.clone()`) so the caller can still
   * read the original. (A custom `R` has whatever read semantics you give it.)
   *
   * **Optional.** Omit it for ensure-only consumers with no per-request expiry
   * path (e.g. Skylight, whose re-auth lives in {@link TokenManager}): the
   * default `() => false` treats every response as non-expired, so
   * {@link CookieSessionManager.withSession}'s replay path simply never triggers.
   */
  isExpired?: (res: R) => boolean | Promise<boolean>;
  /**
   * Distinguish a *permanent* configuration error (missing/invalid credentials)
   * from a *transient* login failure (network blip, 5xx, login rate-limit). A
   * permanent error is cached and rethrown on every subsequent {@link ensure}
   * (the server can never recover without new config); a transient error leaves
   * state unset so the next {@link ensure} retries the login. Mirrors Skylight's
   * `NO_ENV_CONFIG_MARKER` check. Defaults to treating ALL failures as transient
   * (always retry) — the safe default for sites with no config/transient split.
   */
  isPermanentError?: (err: unknown) => boolean;
  /**
   * Proactive session TTL, in milliseconds. A session older than this (by
   * login/seed time) is treated as stale: the next {@link ensure} invalidates
   * and re-logs-in (single-flight — a stale burst coalesces onto ONE login).
   * Omit for reactive-only expiry via {@link isExpired}. Mirrors
   * infinitecampus's 5-hour `SESSION_TTL_MS` (which hand-rolled an
   * `ensureFresh` wrapper for exactly this) and {@link TokenManager}'s
   * proactive-refresh discipline.
   */
  maxAgeMs?: number;
  /** Injectable clock for {@link maxAgeMs} staleness (defaults to `Date.now`) — for tests. */
  now?: () => number;
  /**
   * Called when {@link CookieSessionManager.withSession}'s expiry-replay
   * re-login FAILS — by default that failure is swallowed and the original
   * expired-looking response is returned, which hides an actionable login
   * error (e.g. "fetchproxy bridge down — open a signed-in tab") behind a
   * generic 401. Use this hook to record the error (infinitecampus's
   * `lastLoginError` bookkeeping) or `throw err` inside it to surface the
   * login failure to the caller instead of the stale response.
   */
  onReplayLoginError?: (err: unknown) => void;
  /**
   * Keep the session across process restarts. Read ONCE, on the first login
   * path, and written after every successful login and {@link
   * CookieSessionManager.seed}. {@link CookieSessionManager.invalidate} clears
   * it — without that, a session detected as expired would be read straight
   * back off disk and the expiry would loop.
   *
   * The stored envelope carries the login time alongside the session so
   * {@link CookieSessionManagerOptions.maxAgeMs} keeps counting from the
   * original login rather than restarting at the restore. Omit for the previous
   * in-memory-only behaviour. See {@link StatePersistence}.
   */
  persistence?: StatePersistence<PersistedCookieSession<S>>;
}

/** What {@link CookieSessionManagerOptions.persistence} stores: a session plus its login time. */
export interface PersistedCookieSession<S> {
  session: S;
  /** Epoch ms the session was minted or seeded — the `maxAgeMs` clock. */
  sessionAt: number;
}

/** Whether a parsed record has the shape of {@link PersistedCookieSession}. */
function isPersistedCookieSession<S>(raw: unknown): raw is PersistedCookieSession<S> {
  if (raw === null || typeof raw !== 'object') return false;
  const r = raw as Partial<PersistedCookieSession<S>>;
  if (typeof r.sessionAt !== 'number' || !Number.isFinite(r.sessionAt)) return false;
  // Field-by-field, like isBearerTokens: a primitive is not a session shape.
  return typeof r.session === 'object' && r.session !== null;
}

/**
 * Cookie-session analog of {@link TokenManager}: owns a site's cookie-session
 * lifecycle with the same single-flight / replay / clear-on-settle discipline,
 * so the fleet's cookie-session MCPs stop re-implementing (and subtly
 * mis-implementing) it. Structurally prevents the audit-flagged class of bugs:
 *
 * - **Single-flight:** concurrent {@link ensure} callers coalesce onto ONE
 *   in-flight {@link CookieSessionManagerOptions.login} (no thundering-herd
 *   re-login against a rate-limited endpoint).
 * - **Clear-on-settle:** the in-flight promise is cleared whether it resolves
 *   or rejects, so a *rejected* login never sticks — the next {@link ensure}
 *   retries (fixes Evite's poisoned-promise H1 and Skylight's gap).
 * - **Exactly-one replay:** {@link withSession} re-logs-in and replays a request
 *   AT MOST once on expiry; a persistent expiry surfaces rather than looping.
 * - **Heuristic expiry:** {@link CookieSessionManagerOptions.isExpired} is the
 *   injection point for body/URL detection (SignUpGenius's 200-HTML-login-page,
 *   Artsonia's redirect-away), not just status codes.
 * - **Permanent vs. transient:** only a permanent config error is cached
 *   ({@link CookieSessionManagerOptions.isPermanentError}); transient login
 *   failures stay retryable (Skylight's marker discipline).
 *
 * Two type parameters: `S` is the caller-defined session shape, and `R` is the
 * response type {@link CookieSessionManager.withSession}'s `call` resolves to,
 * defaulting to the web {@link Response}. The manager is response-agnostic — it
 * only hands `R` to {@link CookieSessionManagerOptions.isExpired} and never
 * inspects it — so override `R` for a custom/non-fetch transport (e.g.
 * Artsonia's `{ setCookie?, location?, url, body }`). Existing adopters that
 * write `CookieSessionManager<MySession>` keep `R = Response` unchanged.
 *
 * {@link CookieSessionManagerOptions.isExpired} is **optional** and defaults to
 * `() => false`, so ensure-only consumers with no per-request expiry path
 * (Skylight) can omit it; `withSession` then simply never replays.
 *
 * Target consumers (the 5 cohort MCPs whose hand-rolled re-login this replaces):
 * `artsonia-mcp` (`AuthManager`), `canvas-parent-mcp` (`ensureAuth` + 401-replay,
 * the reference impl), `evite-mcp` (`getSession`/`reauthenticate` + CSRF),
 * `signupgenius-mcp` (`ensureAuth` + 401/403/200-HTML replay), and `skylight-mcp`
 * (`makeGetClient` single-flight + `NO_ENV_CONFIG_MARKER` caching).
 */
export class CookieSessionManager<S = CookieSession, R = Response> {
  private session: S | undefined;
  private inFlight: Promise<S> | undefined;
  /** A cached *permanent* config error: once set, every `ensure` rethrows it. */
  private permanentError: unknown | undefined;
  /** When the current session was minted (login) or installed (seed) — for maxAgeMs. */
  private sessionAt = 0;
  private readonly loginFn: () => Promise<S>;
  private readonly isExpiredFn: (res: R) => boolean | Promise<boolean>;
  private readonly isPermanentErrorFn: (err: unknown) => boolean;
  private readonly maxAgeMs: number | undefined;
  private readonly now: () => number;
  private readonly onReplayLoginErrorFn: ((err: unknown) => void) | undefined;
  private readonly persistence: StatePersistence<PersistedCookieSession<S>> | undefined;
  /** Persistence is consulted once per process; a miss must not be re-read. */
  private persistenceRead = false;
  /**
   * Serializes persistence writes. `seed()` and `invalidate()` are synchronous
   * by contract and so fire-and-forget their save/clear; with an async backend a
   * slow save could otherwise land AFTER the clear that followed it and leave an
   * invalidated session on disk.
   */
  private persistChain: Promise<void> = Promise.resolve();

  constructor(opts: CookieSessionManagerOptions<S, R>) {
    this.loginFn = opts.login;
    // Optional: ensure-only consumers (no per-request expiry path) omit it; the
    // `() => false` default makes withSession's replay path never trigger.
    this.isExpiredFn = opts.isExpired ?? (() => false);
    this.isPermanentErrorFn = opts.isPermanentError ?? (() => false);
    this.maxAgeMs = opts.maxAgeMs;
    this.now = opts.now ?? Date.now;
    this.onReplayLoginErrorFn = opts.onReplayLoginError;
    this.persistence = opts.persistence;
  }

  /** The current session, or `undefined` before the first successful login. */
  get current(): S | undefined {
    return this.session;
  }

  /** True when {@link CookieSessionManagerOptions.maxAgeMs} says the session is too old. */
  private isStale(): boolean {
    return this.maxAgeMs !== undefined && this.now() - this.sessionAt >= this.maxAgeMs;
  }

  /**
   * Return the current session, or single-flight a login if there is none.
   *
   * Concurrent callers share one in-flight login; the in-flight promise is
   * cleared on settle (success OR failure) so a rejected login never sticks and
   * the next call retries. A login error classified permanent by
   * {@link CookieSessionManagerOptions.isPermanentError} is cached and rethrown
   * on every later call; a transient error is not cached (next call retries).
   * With {@link CookieSessionManagerOptions.maxAgeMs} set, a session past its
   * TTL is invalidated first, so the call falls through to a (single-flight)
   * re-login.
   */
  async ensure(): Promise<S> {
    if (this.session !== undefined) {
      if (!this.isStale()) return this.session;
      this.invalidate(); // proactive TTL expiry → fall through to re-login
    }
    if (this.permanentError !== undefined) throw this.permanentError;
    if (this.inFlight === undefined) {
      this.inFlight = this.runLogin();
    }
    return this.inFlight;
  }

  /**
   * Install an externally-minted session (e.g. infinitecampus's CUPS linked-
   * district discovery, which mints sessions outside {@link
   * CookieSessionManagerOptions.login}). The seed becomes the current session
   * with a fresh {@link CookieSessionManagerOptions.maxAgeMs} clock, and any
   * in-flight login is DETACHED: its waiters still receive its result, but a
   * late resolution will not overwrite the seed. A cached permanent config
   * error is left intact — the login path is still misconfigured, and the next
   * post-seed re-login should keep saying so.
   */
  seed(session: S): void {
    this.session = session;
    this.sessionAt = this.now();
    this.inFlight = undefined; // detach any in-flight login (it won't re-stamp)
    // The caller has installed a session, so the stored one is superseded and
    // must never be restored over it (or over a later invalidate()).
    this.persistenceRead = true;
    // Fire-and-forget: seed() is synchronous by contract, and a persistence
    // failure must not change what the caller just installed.
    void this.persist(session, this.sessionAt);
  }

  /**
   * One login attempt. Self-clears `inFlight` on settle so a rejected login
   * never sticks, and stamps the resulting session only while it's still the
   * live attempt (an `invalidate()` mid-flight cleared `inFlight` — a stale
   * resolution must not re-stamp the dropped session over the new state).
   */
  private runLogin(): Promise<S> {
    // `holder.p` is assigned the attempt promise synchronously before any of the
    // closure's awaits resume, so the `this.inFlight === holder.p` identity
    // checks (which run as microtasks) always see the real reference.
    const holder: { p?: Promise<S> } = {};
    holder.p = (async () => {
      try {
        // A restored session is the whole point: skip the login entirely.
        // Guarded rather than awaited unconditionally — with no persistence the
        // await would defer loginFn() past the tick a concurrent burst needs.
        const restored =
          this.persistence !== undefined && !this.persistenceRead
            ? await this.restoreFromPersistence()
            : null;
        if (restored !== null) {
          if (this.inFlight === holder.p) {
            this.session = restored.session;
            this.sessionAt = restored.sessionAt;
          }
          return restored.session;
        }
        const session = await this.loginFn();
        const at = this.now();
        if (this.inFlight === holder.p) {
          this.session = session;
          this.sessionAt = at;
        }
        await this.persist(session, at);
        return session;
      } catch (err) {
        if (this.isPermanentErrorFn(err)) this.permanentError = err;
        throw err;
      } finally {
        if (this.inFlight === holder.p) this.inFlight = undefined;
      }
    })();
    return holder.p;
  }

  /**
   * Drop the current session (and any in-flight login) so the next
   * {@link ensure} re-runs {@link CookieSessionManagerOptions.login}. Does NOT
   * clear a cached permanent config error — that only clears on a fresh process
   * (new config). Used to recover from a detected session expiry.
   */
  invalidate(): void {
    this.session = undefined;
    this.inFlight = undefined;
    // Fire-and-forget, and unconditional: the stored copy is the same session
    // that just proved unusable. Leaving it would have the next ensure() read
    // it back and loop on the very expiry that caused this call.
    void this.clearPersisted();
  }

  /**
   * The persisted session, if there is one worth using. Read at most once per
   * process — after that the in-memory session (or its absence) is the truth,
   * so an invalidate() cannot be undone by a stale file.
   */
  private async restoreFromPersistence(): Promise<PersistedCookieSession<S> | null> {
    if (this.persistence === undefined || this.persistenceRead) return null;
    this.persistenceRead = true;
    try {
      // Through the chain, not around it: `invalidate()` queues its `clear()`,
      // and a read that jumped that queue would restore the very session the
      // clear is about to remove.
      let raw: unknown = null;
      await this.enqueuePersist(async () => {
        raw = await this.persistence?.load();
      });
      if (!isPersistedCookieSession<S>(raw)) return null;
      // Honour the proactive TTL against the ORIGINAL login time.
      if (this.maxAgeMs !== undefined && this.now() - raw.sessionAt >= this.maxAgeMs) return null;
      return raw;
    } catch {
      return null;
    }
  }

  /** Append a persistence op to the chain, preserving call order. Never throws. */
  private enqueuePersist(op: () => Promise<void>): Promise<void> {
    const next = this.persistChain.then(op);
    this.persistChain = next.catch(() => undefined);
    return next;
  }

  /** Write the session. Never throws — a failed write costs a login, not a request. */
  private persist(session: S, sessionAt: number): Promise<void> {
    return this.enqueuePersist(async () => {
      if (this.persistence === undefined) return;
      try {
        await this.persistence.save({ session, sessionAt });
      } catch {
        /* the in-memory session is still usable for this process */
      }
    });
  }

  /** Discard the persisted session. Never throws. */
  private clearPersisted(): Promise<void> {
    return this.enqueuePersist(async () => {
      if (this.persistence?.clear === undefined) return;
      try {
        await this.persistence.clear();
      } catch {
        /* best-effort */
      }
    });
  }

  /**
   * Run an authenticated `call` with the current session and reactive
   * expiry-replay. `call` receives the session and returns a `Response`. If
   * {@link CookieSessionManagerOptions.isExpired} flags the response, the
   * session is invalidated, a single-flight re-login runs, and `call` is
   * replayed EXACTLY once. A persistent expiry surfaces the (second) response
   * rather than looping. If the re-login itself fails, the original
   * (expired-looking) response is returned so the caller can surface a clean
   * sign-in error rather than the login failure.
   *
   * `call` resolves to `R` (the generic response type, default {@link Response});
   * the manager passes it untouched to {@link CookieSessionManagerOptions.isExpired}
   * and returns it untouched, so a custom transport type flows through cleanly.
   */
  async withSession(call: (session: S) => Promise<R>): Promise<R> {
    const session = await this.ensure();
    const res = await call(session);
    if (!(await this.isExpiredFn(res))) return res;

    // Expired: re-login (single-flight) + exactly ONE replay.
    //
    // Guard against a double-invalidate race (mirrors TokenManager.withAuth):
    // only drop the session if it's STILL the one this request used. If a
    // concurrent caller already detected the same expiry and swapped in a fresh
    // session, invalidating again would wipe that fresh session out from under
    // them — so instead we leave it and let ensure() return the already-fresh
    // one. This keeps a burst of expired-session requests to ONE re-login.
    if (this.current === session) this.invalidate();
    let fresh: S;
    try {
      fresh = await this.ensure();
    } catch (err) {
      // Re-login failed (no creds, login rejected, …): by default surface the
      // original expired response so the caller maps it to a clean sign-in
      // error. The hook lets a consumer record the login error — or throw it
      // to surface the actionable failure instead of the stale response.
      this.onReplayLoginErrorFn?.(err);
      return res;
    }
    return call(fresh);
  }
}

/** Construct a {@link CookieSessionManager}. */
export function createCookieSessionManager<S = CookieSession, R = Response>(
  opts: CookieSessionManagerOptions<S, R>,
): CookieSessionManager<S, R> {
  return new CookieSessionManager<S, R>(opts);
}
