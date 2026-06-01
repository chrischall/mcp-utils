/**
 * Fetchproxy transport adapter — the Pattern-A glue shared by every
 * fetchproxy-backed MCP (redfin/zillow/compass/homes/onehome/resy/opentable/…).
 *
 * `@fetchproxy/server` already owns HTTP proxying, session bootstrap, and the
 * bot-wall / backoff / deadline / concurrency / retry primitives. This module
 * does NOT reimplement any of that — it re-exports the primitives so MCPs have a
 * single import site, and provides two thin factories:
 *
 *  - {@link createFetchproxyTransport} wraps a `FetchproxyServer` in the
 *    `start` / `close` / `status` lifecycle every MCP's transport interface
 *    expects, with optional debug-gated role logging.
 *  - {@link createBootstrapOpts} assembles a multi-domain / capture-header /
 *    storage-pointer declaration fragment of `FetchproxyServerOpts`, deriving
 *    the required `capabilities` from the declared bootstrap so callers can't
 *    forget to unlock the verb they declared.
 *
 * The adapter shape is identical across 12+ fetchproxy MCPs; collapsing it here
 * keeps the per-row / concurrency / deadline helpers as re-exports rather than
 * re-rolled code.
 */

import {
  FetchproxyServer,
  FetchproxyBridgeDownError,
  classifyBridgeError as classifyBridgeErrorKind,
  type FetchproxyServerOpts,
} from '@fetchproxy/server';
import type { Capability } from '@fetchproxy/protocol';
import { truncateErrorMessage, messageOf } from '../errors/index.js';

// ---------------------------------------------------------------------------
// Re-exports — single import site for the bridge primitives (design: re-export,
// never reimplement). MCPs import these from here instead of reaching into
// `@fetchproxy/server` directly, so a version bump is absorbed in one place.
// ---------------------------------------------------------------------------
export {
  FetchproxyServer,
  mapWithConcurrency,
  withDeadline,
  TokenBucket,
  classifyBotWall,
  retryOnceOnTimeout,
  FetchproxyProtocolError,
  FetchproxyHttpError,
  FetchproxyBridgeDownError,
  FetchproxyTimeoutError,
  classifyBridgeError,
  classifyRowError,
  classifyFetchError,
  backoffDelayMs,
  BRIDGE_CONCURRENCY,
  // Page-state / scrape + small async helpers. Re-exported so a consumer can
  // route its ENTIRE `@fetchproxy/server` surface through this subpath (single
  // import site) — the realty MCPs use these alongside the bridge primitives.
  chunk,
  sleep,
  extractGlobalAssign,
  extractBalancedObject,
  extractImgTags,
  lastPathSegment,
} from '@fetchproxy/server';
// NOTE: `classifyBridgeError` and `classifyRowError` above are fetchproxy's RAW
// classifiers (they return a bare kind STRING). They are re-exported verbatim so
// an MCP can swap `from '@fetchproxy/server'` → `from '@chrischall/mcp-utils/fetchproxy'`
// as a pure drop-in. The richer { type, message, hint } envelope is a SEPARATE
// helper exported as `bridgeErrorInfo` (defined below) — it does not squat the
// `classifyBridgeError` name.
export type {
  FetchproxyServerOpts,
  FetchResult,
  FetchResultError,
  HttpResponse,
  RequestOpts,
  BodylessRequestOpts,
  BridgeHealth,
  BridgeProbeResult,
  BridgeError,
  FetchErrorKind,
  BotWallResult,
  BotWallVendor,
  TokenBucketOptions,
  BackoffOptions,
  DeadlineOutcome,
} from '@fetchproxy/server';

/**
 * Matches a value that is *entirely* an unsubstituted shell-style placeholder
 * (`${FOO}`). MCP hosts that forward an env block without expanding it leak
 * these literals; treating them as unset is the canonical placeholder-leakage
 * defense (mirrors `config.readEnvVar`).
 */
const PLACEHOLDER_RE = /^\$\{[^}]*\}$/;

/**
 * Defensive truthiness check for a debug/flag env var: trims, and treats the
 * empty string, `'undefined'`, `'null'`, and unexpanded `${...}` placeholders
 * as unset (falsey). Any other non-empty value enables the flag.
 */
function envFlagEnabled(key: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[key];
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  return (
    trimmed.length > 0 &&
    trimmed !== 'undefined' &&
    trimmed !== 'null' &&
    !PLACEHOLDER_RE.test(trimmed)
  );
}

/**
 * The lifecycle surface every per-MCP fetchproxy transport interface exposes.
 * `createFetchproxyTransport` returns this, typed as the caller's `T` so it can
 * stand in for `RedfinTransport`, `ZillowTransport`, etc. without those
 * interfaces depending on this package.
 */
export interface FetchproxyTransport {
  /**
   * Load identity (creating the 0600 keypair on first run) and prepare the
   * bridge. Does NOT bind the port or dial — connection is lazy on first verb.
   * When `debugEnvVar` is set and truthy, logs the landed role to stderr.
   */
  start(): Promise<void>;
  /** Tear the bridge connection down. Safe to call before {@link start}. */
  close(): Promise<void>;
  /** Process-wide bridge freshness snapshot, for a healthcheck tool. */
  status(): ReturnType<FetchproxyServer['bridgeHealth']>;
  /** Bridge role; `null` until the first verb call / explicit connect. */
  readonly role: FetchproxyServer['role'];
  /**
   * The wrapped `FetchproxyServer` — the verb surface (`request`/`get`/`post`/
   * `getJson`/`getHtml`/`readCookies`/`captureRequestHeader`/…). Exposed so the
   * caller's tool layer can issue requests without this package modelling every
   * verb.
   */
  readonly server: FetchproxyServer;
}

/** Options for {@link createFetchproxyTransport}. */
export type CreateFetchproxyTransportOptions = FetchproxyServerOpts & {
  /**
   * Env var name that gates stderr role/lifecycle logging (e.g. `REDFIN_DEBUG`).
   * The value is read defensively — empty / `'null'` / `${...}` placeholders are
   * treated as unset, so an unexpanded MCP-host env block never enables logging.
   */
  debugEnvVar?: string;
  /** Env source for {@link debugEnvVar}. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
};

/**
 * Wrap a `FetchproxyServer` in the `start`/`close`/`status` lifecycle the
 * per-MCP transport interface expects. The full `FetchproxyServerOpts` is
 * forwarded verbatim (so `fetchTimeoutMs`, `keepAliveIntervalMs`, capture
 * declarations, etc. all pass through); the only added knob is `debugEnvVar`.
 *
 * Returns the wrapper typed as the caller's `T` (defaulting to
 * {@link FetchproxyTransport}) so it can satisfy a structurally-compatible
 * per-MCP interface without that interface importing this package.
 *
 * @example
 * const transport = createFetchproxyTransport<RedfinTransport>({
 *   serverName: 'redfin-mcp', version, domains: ['redfin.com'],
 *   debugEnvVar: 'REDFIN_DEBUG',
 * });
 */
export function createFetchproxyTransport<T = FetchproxyTransport>(
  opts: CreateFetchproxyTransportOptions,
): T {
  const { debugEnvVar, env, ...serverOpts } = opts;

  if (!serverOpts.serverName || serverOpts.serverName.trim().length === 0) {
    throw new Error('createFetchproxyTransport: `serverName` is required.');
  }
  if (!Array.isArray(serverOpts.domains) || serverOpts.domains.length === 0) {
    throw new Error('createFetchproxyTransport: at least one `domains` entry is required.');
  }

  const server = new FetchproxyServer(serverOpts);
  const debug = debugEnvVar !== undefined && envFlagEnabled(debugEnvVar, env ?? process.env);

  const transport: FetchproxyTransport = {
    server,
    get role() {
      return server.role;
    },
    async start() {
      await server.listen();
      if (debug) {
        // Stderr only — stdio MCP transports reserve stdout for JSON-RPC.
        console.error(
          `[${serverOpts.serverName}:bridge] listening ` +
            `(role=${server.role ?? 'unknown'}, version=${serverOpts.version})`,
        );
      }
    },
    async close() {
      await server.close();
    },
    status() {
      return server.bridgeHealth();
    },
  };

  return transport as T;
}

// ---------------------------------------------------------------------------
// createBootstrapOpts — multi-domain + bootstrap-declaration factory
// ---------------------------------------------------------------------------

/** Re-export the protocol declaration shapes so callers have one import site. */
export type {
  Capability,
  CaptureHeaderDecl,
  IndexedDbScopeDecl,
  StoragePointerDecl,
} from '@fetchproxy/protocol';

import type {
  CaptureHeaderDecl,
  IndexedDbScopeDecl,
  StoragePointerDecl,
} from '@fetchproxy/protocol';

/**
 * The bootstrap declarations an MCP needs to extract auth from the user's
 * signed-in tab. Each present, non-empty group unlocks the capability that
 * gates the matching verb — `createBootstrapOpts` derives `capabilities` so the
 * caller can't declare a capture without unlocking it (or vice-versa).
 */
export interface BootstrapDecls {
  /** `read_cookies`: declared cookie names readable via `readCookies({ keys })`. */
  cookieKeys?: string[];
  /** `read_local_storage`: declared localStorage keys. */
  localStorageKeys?: string[];
  /** `read_session_storage`: declared sessionStorage keys. */
  sessionStorageKeys?: string[];
  /** JSON-pointer extractions over localStorage values (implies `read_local_storage`). */
  localStoragePointers?: StoragePointerDecl[];
  /** JSON-pointer extractions over sessionStorage values (implies `read_session_storage`). */
  sessionStoragePointers?: StoragePointerDecl[];
  /** `capture_request_header`: (urlPattern, headerName) pairs to snapshot. */
  captureHeaders?: CaptureHeaderDecl[];
  /** `read_indexed_db`: declared IndexedDB scopes. */
  indexedDbScopes?: IndexedDbScopeDecl[];
}

/** Options for {@link createBootstrapOpts}. */
export interface CreateBootstrapOptsArgs {
  /**
   * Trust-boundary hostname(s). A bare string is accepted for the common
   * single-domain case; multi-domain MCPs pass an array (and must then specify
   * `{ domain }` on each per-call request).
   */
  domains: string | string[];
  /**
   * Documentation hint for *where* the bootstrap reads from (e.g.
   * `portal.onehome.com`). Recorded on the returned fragment as a comment-level
   * concern only — the actual gating is per declaration. Must be a subdomain of
   * (or equal to) one of `domains` if provided.
   */
  storageDomain?: string;
  /** The capture/storage declarations to thread into capabilities + opts. */
  bootstrap?: BootstrapDecls;
}

function nonEmpty<T>(arr: T[] | undefined): arr is T[] {
  return Array.isArray(arr) && arr.length > 0;
}

/**
 * Assemble the multi-domain / bootstrap-declaration fragment of
 * `FetchproxyServerOpts`. Spread the result into
 * {@link createFetchproxyTransport} alongside `serverName` / `version`.
 *
 * The returned `capabilities` is derived from the declared bootstrap: each
 * present declaration group adds exactly the capability that gates its verb
 * (deduped). When no bootstrap declarations are given, `capabilities` is left
 * unset so the server falls back to its default `['fetch']`.
 *
 * @example
 * const opts = createBootstrapOpts({
 *   domains: 'onehome.com',
 *   storageDomain: 'portal.onehome.com',
 *   bootstrap: { captureHeaders: [{ urlPattern: 'https://portal.onehome.com/graphql*', headerName: 'Authorization' }] },
 * });
 * createFetchproxyTransport({ ...opts, serverName: 'onehome-mcp', version });
 */
export function createBootstrapOpts(
  args: CreateBootstrapOptsArgs,
): Pick<
  FetchproxyServerOpts,
  | 'domains'
  | 'capabilities'
  | 'cookieKeys'
  | 'localStorageKeys'
  | 'sessionStorageKeys'
  | 'localStoragePointers'
  | 'sessionStoragePointers'
  | 'captureHeaders'
  | 'indexedDbScopes'
> {
  const domains = Array.isArray(args.domains) ? args.domains : [args.domains];
  if (domains.length === 0 || domains.some((d) => !d || d.trim().length === 0)) {
    throw new Error('createBootstrapOpts: at least one non-empty `domains` entry is required.');
  }

  if (args.storageDomain !== undefined) {
    const host = args.storageDomain.trim();
    const ok = domains.some((d) => host === d || host.endsWith(`.${d}`));
    if (!ok) {
      throw new Error(
        `createBootstrapOpts: storageDomain '${args.storageDomain}' is not within declared domains [${domains.join(', ')}].`,
      );
    }
  }

  const b = args.bootstrap ?? {};
  const capabilities = new Set<Capability>();

  if (nonEmpty(b.cookieKeys)) capabilities.add('read_cookies');
  if (nonEmpty(b.localStorageKeys) || nonEmpty(b.localStoragePointers)) {
    capabilities.add('read_local_storage');
  }
  if (nonEmpty(b.sessionStorageKeys) || nonEmpty(b.sessionStoragePointers)) {
    capabilities.add('read_session_storage');
  }
  if (nonEmpty(b.captureHeaders)) capabilities.add('capture_request_header');
  if (nonEmpty(b.indexedDbScopes)) capabilities.add('read_indexed_db');

  return {
    domains,
    ...(capabilities.size > 0 ? { capabilities: [...capabilities] } : {}),
    ...(nonEmpty(b.cookieKeys) ? { cookieKeys: b.cookieKeys } : {}),
    ...(nonEmpty(b.localStorageKeys) ? { localStorageKeys: b.localStorageKeys } : {}),
    ...(nonEmpty(b.sessionStorageKeys) ? { sessionStorageKeys: b.sessionStorageKeys } : {}),
    ...(nonEmpty(b.localStoragePointers) ? { localStoragePointers: b.localStoragePointers } : {}),
    ...(nonEmpty(b.sessionStoragePointers) ? { sessionStoragePointers: b.sessionStoragePointers } : {}),
    ...(nonEmpty(b.captureHeaders) ? { captureHeaders: b.captureHeaders } : {}),
    ...(nonEmpty(b.indexedDbScopes) ? { indexedDbScopes: b.indexedDbScopes } : {}),
  };
}

// ---------------------------------------------------------------------------
// Bridge-error classification (moved here from core `errors` so the optional
// `@fetchproxy/server` peer dep stays out of the core barrel).
// ---------------------------------------------------------------------------

/** Discriminated classification of a tool-boundary error. */
export interface BridgeErrorInfo {
  type: 'bridge_down' | 'timeout' | 'http' | 'protocol' | 'unknown';
  message: string;
  hint?: string;
}

/**
 * Thin discriminator over the `@fetchproxy/server` typed-error hierarchy. Folds
 * the re-exported raw {@link classifyBridgeError} (which returns a bare kind
 * string) into a `{ type, message, hint? }` envelope, mapping fetchproxy's
 * `'other'` to `'unknown'` and lifting the per-class remediation `hint` where one
 * exists. The surfaced message is redacted + truncated. Use this when you want
 * the structured envelope; use the re-exported `classifyBridgeError` for the raw
 * string kind (drop-in compatible with `@fetchproxy/server`).
 */
export function bridgeErrorInfo(err: unknown): BridgeErrorInfo {
  const kind = classifyBridgeErrorKind(err);
  const message = truncateErrorMessage(messageOf(err));

  switch (kind) {
    case 'timeout':
      return {
        type: 'timeout',
        message,
        hint: 'The fetchproxy bridge timed out. Check the browser tab is open and responsive, then retry.',
      };
    case 'bridge_down': {
      const hint = err instanceof FetchproxyBridgeDownError ? err.hint : undefined;
      return {
        type: 'bridge_down',
        message,
        hint: hint ?? 'The fetchproxy browser bridge is offline. Open a signed-in tab so the extension can relay the request.',
      };
    }
    case 'http':
      return { type: 'http', message };
    case 'protocol':
      return {
        type: 'protocol',
        message,
        hint: 'The fetchproxy bridge could not relay the request (e.g. no signed-in tab or denied domain).',
      };
    case 'other':
    default:
      return { type: 'unknown', message };
  }
}
