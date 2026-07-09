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
 *    expects, with optional debug-gated role logging, PLUS the opt-in verb
 *    passthroughs (`fetch` / `requestJson` / `runProbe`) that redfin / homes /
 *    compass / musescore had each hand-rolled over the server.
 *  - {@link registerBridgeHealthcheckTool} registers a `<prefix>_healthcheck`
 *    tool that round-trips a probe path through the bridge and surfaces the
 *    actionable hint ladder compass + musescore had each copied (with drifted
 *    internals + a hardcoded-port bug) into `src/tools/healthcheck.ts`.
 *  - {@link createBootstrapOpts} assembles a multi-domain / capture-header /
 *    storage-pointer declaration fragment of `FetchproxyServerOpts`, deriving
 *    the required `capabilities` from the declared bootstrap so callers can't
 *    forget to unlock the verb they declared.
 *
 * The adapter shape is identical across 12+ fetchproxy MCPs; collapsing it here
 * keeps the per-row / concurrency / deadline helpers as re-exports rather than
 * re-rolled code.
 *
 * Lazy-import note: this whole subpath is gated behind the OPTIONAL
 * `@fetchproxy/server` peer dep — a consumer only resolves it by importing
 * `@chrischall/mcp-utils/fetchproxy`, never via the core barrel. The eager
 * top-level import below therefore never reaches a `.mcpb` bundle that
 * externalizes `@fetchproxy/server` unless that consumer actually opted into
 * the bridge. Everything added here routes through that same already-imported
 * `FetchproxyServer` instance (no NEW top-level `@fetchproxy/server` import),
 * so the bundle-load smoke posture is unchanged.
 */

import {
  FetchproxyServer,
  FetchproxyBridgeDownError,
  classifyBridgeError as classifyBridgeErrorKind,
  type FetchproxyServerOpts,
  // Type-only — erased at compile, no runtime `@fetchproxy/server` reference
  // beyond the values already imported above.
  type HttpResponse,
  type BridgeProbeResult,
} from '@fetchproxy/server';
import type { Capability } from '@fetchproxy/protocol';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
 * One request to round-trip through the bridge. The path is resolved relative
 * to the transport's declared domain (a `defaultSubdomain` — e.g. `'www'` — is
 * applied unless the caller overrides it per-call). This is the common
 * `FetchInit` redfin / homes / compass / musescore each declared verbatim in
 * their `src/transport.ts`.
 */
export interface FetchproxyFetchInit {
  /** Path-and-query relative to the declared domain, e.g. `/robots.txt`. */
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  /** Serialized request body. JSON callers stringify before calling. */
  body?: string;
  /**
   * Per-call subdomain override. Defaults to the transport's `defaultSubdomain`
   * (and, absent that, the apex). Absolute `http(s)://` paths self-describe
   * their host, so this is ignored for them.
   */
  subdomain?: string;
  /** Per-call base-domain selector (required only for multi-domain MCPs). */
  domain?: string;
}

/** The success-arm `{status, body, url}` triple every consumer returns. */
export type FetchproxyFetchResult = HttpResponse;

/** Options for {@link FetchproxyTransport.requestJson}. */
export interface FetchproxyRequestJsonInit {
  headers?: Record<string, string>;
  body?: unknown;
  subdomain?: string;
  domain?: string;
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
  /**
   * Process-wide bridge freshness snapshot, for a healthcheck tool. The
   * factory additively pins `serverVersion` to the caller's `version` opt — the
   * field homes / redfin / compass each projected by hand — so consumers can
   * delegate `status()` straight through without re-wrapping.
   */
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
  /**
   * Verb passthrough: round-trip one request through `server.request(...)`,
   * applying the transport's `defaultSubdomain`, and return the success-arm
   * `{status, body, url}` triple. Bridge failures throw the typed errors
   * (`FetchproxyBridgeDownError` / `FetchproxyTimeoutError` / …), exactly like
   * `server.request`. This is the `fetch(init)` redfin / homes / compass /
   * musescore each wrote by hand.
   */
  fetch(init: FetchproxyFetchInit): Promise<FetchproxyFetchResult>;
  /**
   * Verb passthrough over `server.requestJson(...)` (serialization + header
   * defaults + 204→null + JSON.parse). Returns BOTH the parsed `data` and the
   * raw success-arm `result`, so the caller keeps its per-site `throwIfNotOk` /
   * sign-in guards over `result`. `defaultSubdomain` is applied.
   */
  requestJson<T = unknown>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    init?: FetchproxyRequestJsonInit,
  ): Promise<{ data: T | null; result: FetchproxyFetchResult }>;
  /**
   * Verb passthrough over `server.runProbe(...)` — run one healthcheck probe,
   * measure elapsed ms, classify any thrown error, and project the post-probe
   * `bridgeHealth()`. Powers {@link registerBridgeHealthcheckTool}.
   */
  runProbe(
    fetchFn: (path: string) => Promise<unknown>,
    probePath: string,
  ): Promise<BridgeProbeResult>;
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
  /**
   * Subdomain the verb adapters (`fetch` / `requestJson`) apply per call unless
   * the caller overrides it. This is the ONE per-site bit of the verb surface:
   * redfin / homes / compass pin `'www'`; apex-served sites (musescore) omit it
   * to hit the bare domain. Absolute `http(s)://` paths self-describe their host
   * and ignore this entirely.
   */
  defaultSubdomain?: string;
  /**
   * When `true`, {@link FetchproxyTransport.start} emits a one-line startup
   * banner to **stderr** (stdout is reserved for the JSON-RPC channel) in the
   * canonical fleet format:
   *
   * ```
   * [<serverName>:bridge] listening on 127.0.0.1:<port> (role=<role ?? 'unknown'>, version=<version>)
   * ```
   *
   * `<port>` is the bridge's resolved port (from `bridgeHealth()` after
   * `listen()`), so it reflects an overridden port rather than a literal.
   * Default `false` keeps existing consumers silent — they opt in to drop the
   * hand-rolled banner redfin / homes / compass each wrote verbatim. Independent
   * of {@link debugEnvVar} (which gates the richer per-request debug logging).
   */
  logListening?: boolean;
  /**
   * Test seam: factory that constructs the underlying `FetchproxyServer` from
   * the forwarded `FetchproxyServerOpts`. Defaults to
   * `(o) => new FetchproxyServer(o)`. A consumer's vitest passes a factory
   * returning a mock so it can capture the constructor opts and stub verbs
   * (e.g. `download`) WITHOUT `vi.mock('@fetchproxy/server')` — which can't
   * reach the `new FetchproxyServer` call buried inside this package's prebuilt
   * dist. The default path is unchanged: it routes through the already-imported
   * `FetchproxyServer`, adding no new eager `@fetchproxy/server` import.
   */
  createServer?: (opts: FetchproxyServerOpts) => FetchproxyServer;
};

/**
 * Wrap a `FetchproxyServer` in the `start`/`close`/`status` lifecycle the
 * per-MCP transport interface expects. The full `FetchproxyServerOpts` is
 * forwarded verbatim (so `fetchTimeoutMs`, `keepAliveIntervalMs`, capture
 * declarations, etc. all pass through). The added knobs are:
 *
 *  - `debugEnvVar` — env-gated per-request debug logging;
 *  - `defaultSubdomain` — the per-call subdomain the verb adapters apply;
 *  - `logListening` — opt-in canonical startup banner on `start()` (stderr);
 *  - `createServer` — a test seam to inject a mock `FetchproxyServer`.
 *
 * `status()` additively pins `serverVersion` to the `version` opt, so consumers
 * no longer re-wrap `bridgeHealth()` just to project it.
 *
 * Returns the wrapper typed as the caller's `T` (defaulting to
 * {@link FetchproxyTransport}) so it can satisfy a structurally-compatible
 * per-MCP interface without that interface importing this package.
 *
 * @example
 * const transport = createFetchproxyTransport<RedfinTransport>({
 *   serverName: 'redfin-mcp', version, domains: ['redfin.com'],
 *   debugEnvVar: 'REDFIN_DEBUG', logListening: true,
 * });
 */
export function createFetchproxyTransport<T = FetchproxyTransport>(
  opts: CreateFetchproxyTransportOptions,
): T {
  const { debugEnvVar, env, defaultSubdomain, logListening, createServer, ...serverOpts } = opts;

  if (!serverOpts.serverName || serverOpts.serverName.trim().length === 0) {
    throw new Error('createFetchproxyTransport: `serverName` is required.');
  }
  if (!Array.isArray(serverOpts.domains) || serverOpts.domains.length === 0) {
    throw new Error('createFetchproxyTransport: at least one `domains` entry is required.');
  }

  // Default path is identical to before — route through the already-imported
  // `FetchproxyServer` (no new eager `@fetchproxy/server` import). A test seam
  // (`createServer`) lets a consumer inject a mock instead.
  const construct = createServer ?? ((o: FetchproxyServerOpts) => new FetchproxyServer(o));
  const server = construct(serverOpts);
  const debug = debugEnvVar !== undefined && envFlagEnabled(debugEnvVar, env ?? process.env);

  // Apply `defaultSubdomain` only when the call didn't override it AND a
  // default exists — so an apex-served MCP (no default) sends no `subdomain`
  // and a per-call override always wins.
  const withSubdomain = <O extends { subdomain?: string }>(callOpts: O): O => {
    if (callOpts.subdomain !== undefined || defaultSubdomain === undefined) {
      return callOpts;
    }
    return { ...callOpts, subdomain: defaultSubdomain };
  };

  const transport: FetchproxyTransport = {
    server,
    get role() {
      return server.role;
    },
    async start() {
      await server.listen();
      if (logListening) {
        // Canonical fleet banner (compass's restored format). Stderr only —
        // stdio MCP transports reserve stdout for JSON-RPC. The port comes
        // from the live bridge health so an overridden port is reflected.
        console.error(
          `[${serverOpts.serverName}:bridge] listening on 127.0.0.1:${server.bridgeHealth().port} ` +
            `(role=${server.role ?? 'unknown'}, version=${serverOpts.version})`,
        );
      }
      else if (debug) {
        // Only when logListening didn't already print the (richer, port-bearing)
        // canonical banner — this debug line is a strict subset of it, so emitting
        // both is redundant. Stderr only — stdout is the JSON-RPC channel.
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
      // Additively guarantee `serverVersion` from the caller's `version` opt.
      // `bridgeHealth()` already carries `serverVersion` (the server is built
      // with `version: opts.version`), so this is value-preserving — but
      // pinning it here lets the factory own the contract consumers projected
      // by hand (homes/redfin/compass), so they don't have to re-wrap.
      return { ...server.bridgeHealth(), serverVersion: serverOpts.version };
    },
    async fetch(init) {
      const response: HttpResponse = await server.request(init.method, init.path, withSubdomain({
        ...(init.headers !== undefined ? { headers: init.headers } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(init.subdomain !== undefined ? { subdomain: init.subdomain } : {}),
        ...(init.domain !== undefined ? { domain: init.domain } : {}),
      }));
      return { status: response.status, body: response.body, url: response.url };
    },
    async requestJson<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, init: FetchproxyRequestJsonInit = {}) {
      const { data, result } = await server.requestJson<T>(method, path, withSubdomain({
        ...(init.headers !== undefined ? { headers: init.headers } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(init.subdomain !== undefined ? { subdomain: init.subdomain } : {}),
        ...(init.domain !== undefined ? { domain: init.domain } : {}),
      }));
      return {
        data,
        result: { status: result.status, body: result.body, url: result.url },
      };
    },
    runProbe(fetchFn, probePath) {
      return server.runProbe(fetchFn, probePath);
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
  DomSelectorDecl,
  StoragePointerDecl,
} from '@fetchproxy/protocol';

import type {
  CaptureHeaderDecl,
  IndexedDbScopeDecl,
  DomSelectorDecl,
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
  /** `capture_request_header`: (host, path?, headerName) decls to snapshot. */
  captureHeaders?: CaptureHeaderDecl[];
  /** `read_indexed_db`: declared IndexedDB scopes. */
  indexedDbScopes?: IndexedDbScopeDecl[];
  /** `read_dom`: declared CSS-selector DOM reads (e.g. a Turnstile token input). */
  domSelectors?: DomSelectorDecl[];
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
 *   bootstrap: { captureHeaders: [{ host: 'portal.onehome.com', path: '/graphql*', headerName: 'Authorization' }] },
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
  | 'domSelectors'
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
  if (nonEmpty(b.domSelectors)) capabilities.add('read_dom');

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
    ...(nonEmpty(b.domSelectors) ? { domSelectors: b.domSelectors } : {}),
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

// ---------------------------------------------------------------------------
// registerBridgeHealthcheckTool — the `<prefix>_healthcheck` tool factory
//
// compass `tools/healthcheck.ts` (225 lines) and musescore's (180 lines)
// produced the SAME result shape via the SAME hint ladder, with drifted
// internals — and BOTH hardcoded the default port `37149` into a hint, so a
// consumer that overrode the port (e.g. `REDFIN_WS_PORT`) got a wrong number in
// its "confirm port N isn't blocked" message. This factory folds the common
// ladder + result shape into one registrar; the per-site bits (prefix, probe
// path, host label) are options, and the port in the hint comes from the ACTUAL
// bridge status (`probeResult.bridge.port`) — never a literal.
// ---------------------------------------------------------------------------

/** The diagnostic result a `<prefix>_healthcheck` tool returns. */
export interface BridgeHealthcheckResult {
  ok: boolean;
  bridge: BridgeProbeResult['bridge'] & {
    last_extension_message_at: number | null;
  };
  probe: {
    url: string;
    elapsed_ms: number;
    status?: number;
    body_length?: number;
  };
  error?: {
    /**
     * The classified error kind. Normally one of `BridgeErrorInfo['type']`;
     * a consumer-supplied {@link RegisterBridgeHealthcheckToolArgs.classifyThrown}
     * can introduce site-specific kinds (e.g. workday's `'session_expired'`).
     */
    kind: string;
    message: string;
    /** Server-authored next-step hint (`FetchproxyBridgeDownError.hint`), when present. */
    bridge_hint?: string;
  };
  /** Plain-English next-step suggestion derived from the result. */
  hint: string;
}

/** The hint-ladder arms whose copy {@link RegisterBridgeHealthcheckToolArgs.hints} can override. */
export type HealthcheckHintArm = 'ok' | 'bridge_down' | 'no_role' | 'timeout' | 'protocol' | 'unknown';

/** Options for {@link registerBridgeHealthcheckTool}. */
export interface RegisterBridgeHealthcheckToolArgs {
  /** The `McpServer` to register the tool on. */
  server: McpServer;
  /** Tool-name + host-banner prefix, e.g. `'compass'` → `compass_healthcheck`. */
  prefix: string;
  /** Public probe path to round-trip, e.g. `'/robots.txt'`. */
  probePath: string;
  /**
   * Display host for the probe URL + hint copy, e.g. `'compass.com'` or
   * `'www.redfin.com'`. The probe URL is `https://<hostLabel><probePath>`.
   */
  hostLabel: string;
  /**
   * The bridge transport — supplies `runProbe` (the probe loop + classification
   * + post-probe bridge projection) and `status()` (for the liveness counter the
   * projection omits). Any {@link FetchproxyTransport}-shaped object works.
   */
  transport: Pick<FetchproxyTransport, 'runProbe' | 'status'>;
  /**
   * Performs the actual probe fetch for `probePath`. Required — most consumers
   * pass `(path) => client.fetchHtml(path)` so the probe exercises the same
   * client path real tools use (sign-in guards and all).
   */
  probeFn: (path: string) => Promise<string>;
  /**
   * Map the error the probe THREW to a site-specific `{ kind, hint? }` —
   * e.g. workday classifies its `SessionNotAuthenticatedError` as
   * `session_expired` with SSO re-sign-in copy. Return `undefined` to keep the
   * default classification. A returned `hint` wins the whole result hint.
   * Absorbs the error-kind special cases that kept workday / zillow / etix on
   * hand-rolled healthchecks.
   */
  classifyThrown?: (err: unknown) => { kind: string; hint?: string } | undefined;
  /**
   * Per-arm overrides for the default hint copy (e.g. etix replacing the
   * generic timeout hint with DataDome-specific guidance). A
   * {@link classifyThrown} hint takes precedence over these.
   */
  hints?: Partial<Record<HealthcheckHintArm, string>>;
}

/**
 * Build the actionable next-step hint from a probe outcome. Order matters:
 * the specific error kinds win over the generic role-based message, because a
 * `bridge_down` can fire with `role === null` (the bridge can hand back the
 * SW-eviction error before `listen()` resolves a role) and the specific hint
 * must beat the "never bound a role" fallback.
 *
 * `port` is the ACTUAL configured bridge port (from `bridgeHealth()`), NOT a
 * hardcoded literal — this is the audit-bug fix both copies shared.
 */
function healthcheckHint(args: {
  ok: boolean;
  role: 'host' | 'peer' | null;
  port: number;
  hostLabel: string;
  prefix: string;
  probePath: string;
  errorKind?: string;
  bridgeHint?: string;
}): string {
  const { hostLabel, prefix, probePath, port } = args;
  if (args.ok) {
    return `Bridge round-tripped ${probePath} successfully. If real tools still fail, the problem is downstream of fetchproxy (${hostLabel} redirecting on login, a bot-wall / behavioral challenge, etc.) — not the bridge.`;
  }
  if (args.errorKind === 'bridge_down') {
    const base = `The fetchproxy browser extension's service worker is not responding. Chrome evicts extension service workers after ~30s idle by default — this looks like that case. Wake it by clicking the fetchproxy extension icon (or opening any ${hostLabel} tab and reloading), then retry. If it keeps happening, reload the extension from chrome://extensions.`;
    return args.bridgeHint ? `${args.bridgeHint} ${base}` : base;
  }
  if (args.role === null) {
    return `The bridge never bound a role. listen() may have failed silently on startup. Check stderr from ${prefix}-mcp for an error during start, and confirm port ${port} isn't blocked.`;
  }
  if (args.errorKind === 'timeout') {
    return `Bridge is alive (role=${args.role}), but the request didn't get a response in time. Either (a) the fetchproxy browser extension isn't connected to this MCP yet — open the extension popup and check for a green dot next to "${prefix}-mcp", or (b) the signed-in ${hostLabel} tab is sleeping / closed. Open ${hostLabel} in your browser, then retry.`;
  }
  if (args.errorKind === 'protocol' || args.errorKind === 'http') {
    return `The bridge returned a protocol error before any HTTP response. Most commonly: no ${hostLabel} tab is open, or the extension declined the request. Open ${hostLabel}, sign in, and retry.`;
  }
  return `Unexpected error — see the error.message field for details.`;
}

/**
 * Register a `<prefix>_healthcheck` MCP tool that round-trips `probePath`
 * through the bridge and reports bridge status + role + timing, plus an
 * actionable hint ladder on failure.
 *
 * The probe loop / error classification / post-probe bridge projection all live
 * in `transport.runProbe` (the `@fetchproxy/server` primitive); this factory
 * owns only the tool registration, the result shape, and the hint ladder. The
 * per-site bits (`prefix`, `probePath`, `hostLabel`, the probe `fetchFn`) are
 * options.
 *
 * @example
 * registerBridgeHealthcheckTool({
 *   server, prefix: 'compass', probePath: '/robots.txt',
 *   hostLabel: 'compass.com', transport,
 *   probeFn: (p) => client.fetchHtml(p),
 * });
 */
export function registerBridgeHealthcheckTool(args: RegisterBridgeHealthcheckToolArgs): void {
  const { server, prefix, probePath, hostLabel, transport, probeFn, classifyThrown, hints } = args;
  const probeUrl = `https://${hostLabel}${probePath}`;

  server.registerTool(
    `${prefix}_healthcheck`,
    {
      title: 'Verify the fetchproxy bridge end-to-end',
      description:
        `Round-trips a small public ${hostLabel} URL (${probePath}) through the fetchproxy bridge and returns diagnostics: the bridge's role (host/peer/null), port, version, the elapsed round-trip time, and a plain-English hint distinguishing 'bridge never came up' from 'extension not connected' from 'real ${hostLabel}-side problem'. Call this when a real tool fails and you want to know which hop broke. Read-only, no auth required.`,
      annotations: {
        title: 'Verify the fetchproxy bridge end-to-end',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: {},
    },
    async () => {
      let probeBody = '';
      let thrown: unknown;
      const probeResult = await transport.runProbe(async (path) => {
        try {
          probeBody = await probeFn(path);
          return probeBody;
        } catch (e) {
          thrown = e;
          throw e;
        }
      }, probePath);

      const ok = probeResult.ok;
      const probe: BridgeHealthcheckResult['probe'] = ok
        ? {
            url: probeUrl,
            elapsed_ms: probeResult.elapsed_ms,
            status: 200,
            body_length: probeBody.length,
          }
        : { url: probeUrl, elapsed_ms: probeResult.elapsed_ms };

      let error: BridgeHealthcheckResult['error'];
      let bridgeHint: string | undefined;
      let customHint: string | undefined;
      if (probeResult.error) {
        // `runProbe` already classified the throw into `probeResult.error.kind`
        // (fetchproxy's raw vocabulary). Trust that as the discriminator —
        // mapping `'other'` → `'unknown'` to match the envelope — rather than
        // re-classifying a plain `{kind,message}` object. Use the typed `thrown`
        // (set by our probe wrapper) only to lift the server-authored
        // `FetchproxyBridgeDownError.hint`.
        let kind: string =
          probeResult.error.kind === 'other' ? 'unknown' : probeResult.error.kind;
        bridgeHint =
          thrown instanceof FetchproxyBridgeDownError ? thrown.hint : undefined;
        // A consumer classifier can re-kind the thrown error (e.g. workday's
        // session_expired) and supply site-specific next-step copy.
        if (thrown !== undefined && classifyThrown) {
          const custom = classifyThrown(thrown);
          if (custom) {
            kind = custom.kind;
            customHint = custom.hint;
          }
        }
        error = {
          kind,
          message: probeResult.error.message,
          ...(bridgeHint !== undefined ? { bridge_hint: bridgeHint } : {}),
        };
      }

      // The post-probe bridge projection omits `lastExtensionMessageAt`; read it
      // off the live status snapshot (same call, so it's current).
      const lastExtensionMessageAt = transport.status().lastExtensionMessageAt;

      // Which ladder arm applies — mirrors healthcheckHint's precedence order —
      // so per-arm `hints` overrides land on the same arm the default copy would.
      const arm: HealthcheckHintArm = ok
        ? 'ok'
        : error?.kind === 'bridge_down'
          ? 'bridge_down'
          : probeResult.bridge.role === null
            ? 'no_role'
            : error?.kind === 'timeout'
              ? 'timeout'
              : error?.kind === 'protocol' || error?.kind === 'http'
                ? 'protocol'
                : 'unknown';

      const defaultHint = healthcheckHint({
        ok,
        role: probeResult.bridge.role,
        // FIX: the real configured port from bridgeHealth(), not a literal 37149.
        port: probeResult.bridge.port,
        hostLabel,
        prefix,
        probePath,
        errorKind: error?.kind,
        bridgeHint: error?.kind === 'bridge_down' ? bridgeHint : undefined,
      });

      const result: BridgeHealthcheckResult = {
        ok,
        bridge: {
          ...probeResult.bridge,
          last_extension_message_at: lastExtensionMessageAt,
        },
        probe,
        ...(error ? { error } : {}),
        // Precedence: classifyThrown's hint > per-arm override > default ladder.
        hint: customHint ?? hints?.[arm] ?? defaultHint,
      };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
