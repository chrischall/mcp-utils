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
  FetchproxySessionNotReadyError,
  classifyBridgeError as classifyBridgeErrorKind,
  classifyFetchError as classifyFetchErrorKind,
  type FetchproxyServerOpts,
  // Type-only — erased at compile, no runtime `@fetchproxy/server` reference
  // beyond the values already imported above.
  type HttpResponse,
  type BridgeProbeResult,
} from '@fetchproxy/server';
import type { Capability } from '@fetchproxy/protocol';
import type { McpServer } from '@modelcontextprotocol/server';
import { truncateErrorMessage, messageOf } from '../errors/index.js';
import { edgeBlockOf } from '../internal/edge-block.js';

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
  FetchproxySessionNotReadyError,
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
  /**
   * Re-send this request once if it times out (fetchproxy >= 3.2.0). Omit it to
   * keep fetchproxy's default: GET/HEAD/OPTIONS retry, writes are sent exactly
   * once. Pass `true` ONLY for a read that uses POST (a search, a GraphQL
   * query) — re-sending a real write after a timeout can double-book or
   * double-pay. `false` turns the retry off for a read.
   */
  retryOnTimeout?: boolean;
}

/** The success-arm `{status, body, url}` triple every consumer returns. */
export type FetchproxyFetchResult = HttpResponse;

/** Options for {@link FetchproxyTransport.requestJson}. */
export interface FetchproxyRequestJsonInit {
  headers?: Record<string, string>;
  body?: unknown;
  subdomain?: string;
  domain?: string;
  /** See {@link FetchproxyFetchInit.retryOnTimeout}. */
  retryOnTimeout?: boolean;
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

/**
 * The margin between a waiting verb's window and the transport deadline that
 * bounds its reply.
 *
 * It is not padding. It keeps the EXTENSION's timer the one that fires, which
 * decides WHICH ERROR the caller sees: the extension answers a closed window
 * with `{ok:false, error:'timeout'}`, which `@fetchproxy/server` types as
 * `FetchproxyWaitedError` carrying the remedy ("a capture resolves on the next
 * matching request the PAGE makes, so an idle tab times out"). Lose the race
 * and the caller gets a bare transport deadline naming a number nobody chose,
 * and — because it classifies as a protocol error — historically the advice to
 * go update the extension.
 *
 * 15 s, matching the value `resy-mcp` arrived at independently.
 */
/**
 * `FetchproxyServer`'s own default deadline, mirrored from
 * `fetchTimeoutMs: opts.fetchTimeoutMs ?? 30_000` at its construction.
 *
 * Mirrored because an omitted `fetchTimeoutMs` is not "unbounded" — it is a
 * bounded 30 s decided downstream — so this is the number a declared window has
 * to clear when the caller named none.
 */
export const SERVER_DEFAULT_FETCH_TIMEOUT_MS = 30_000;

export const CAPTURE_DEADLINE_MARGIN_MS = 15_000;

/**
 * The transport deadline a declared capture window needs.
 *
 * One-directional by construction: it can only ever LENGTHEN a deadline. A
 * caller that set a deliberately short `fetchTimeoutMs` and declares a window
 * that already fits inside it keeps their own bound — otherwise "stop capping
 * the caller" would become "ignore the caller", which is the same defect
 * facing the other way.
 */
export function deadlineForCaptureWindow(
  fetchTimeoutMs: number | undefined,
  captureWindowMs: number | undefined,
): number | undefined {
  if (captureWindowMs === undefined || captureWindowMs <= 0) return fetchTimeoutMs;
  // `0` — and ONLY `0` — is an explicit opt-out of bounding: `_withVerbTimeout`
  // returns the pending promise unraced when the deadline is `<= 0`. A declared
  // window must not switch bounding back ON, or this would bound a call the
  // caller deliberately left unbounded.
  //
  // `undefined` is NOT that, which is the distinction worth spelling out
  // because the two read alike at a call site: it means "say nothing and take
  // the server's default", and `FetchproxyServer` resolves it to 30 s at
  // construction (`fetchTimeoutMs: opts.fetchTimeoutMs ?? 30_000`). So an
  // omitted deadline is a bounded 30 s, and 30 s is the number to compare the
  // floor against — not "no deadline".
  if (fetchTimeoutMs === 0) return 0;
  const floor = captureWindowMs + CAPTURE_DEADLINE_MARGIN_MS;
  return Math.max(fetchTimeoutMs ?? SERVER_DEFAULT_FETCH_TIMEOUT_MS, floor);
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
   * The longest window this MCP will pass as `timeoutMs` to a WAITING verb —
   * `captureRequestHeader`, `captureRedirect`, `download`.
   *
   * Declare it and the transport deadline is raised to clear it. Omit it and
   * nothing changes.
   *
   * This exists because the two timeouts are not independent and the
   * relationship is invisible at the call site. A waiting verb's `timeoutMs`
   * is forwarded to the extension, but the reply is ALSO raced against this
   * server's `fetchTimeoutMs` (default 30 s) — and a per-call value cannot
   * raise that, so the shorter one wins silently. `@fetchproxy/server` says so
   * in the timeout it throws ("raise fetchTimeoutMs on the transport to wait
   * longer"); this is that instruction, applied once, here.
   *
   * Four callers got it wrong independently, which is why it is worth a named
   * option rather than a line in a README:
   *
   * - `onehome-mcp` asks for 120 s and its own comment calls it "the 120s
   *   user-interaction timeout". It receives 30 s — a quarter of the window it
   *   believes it has, and the capture it exists to make is cut off.
   * - `alltrails-mcp` and `remind-mcp` name no window, so the extension's 30 s
   *   default ties with the transport's 30 s. The transport's timer starts
   *   first, so it wins, and the extension's rejection — the one carrying the
   *   remedy the user needs — is lost every time.
   * - `resy-mcp` is the only one that gets it right, and only because it hit
   *   the trap and hand-rolled `Math.max(CAPTURE_TIMEOUT_MS + 15_000, 30_000)`.
   *   The `fpx` CLI shipped the same bug and the same hand-rolled fix.
   *
   * Set it to the largest window you will ask for, not the typical one — the
   * deadline is per transport, and one long capture is enough to need it.
   */
  captureWindowMs?: number;
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
   * [<serverName>:bridge] ready — 127.0.0.1:<port> binds on the first request (version=<version>)
   * ```
   *
   * `<port>` is the bridge's resolved port (from `bridgeHealth()` after
   * `listen()`), so it reflects an overridden port rather than a literal.
   *
   * The wording is load-bearing. `start()` no longer opens anything:
   * @fetchproxy/server defers role election and the port bind to the first verb
   * (0.5.3+, so that a configured-but-unused MCP claims no bridge resources at
   * client boot). This banner said `listening on 127.0.0.1:<port>
   * (role=unknown)` for as long as that has been true, which describes a socket
   * that does not exist — and `role=unknown` is not a bridge whose role is
   * unclear, it is a bridge that has not run an election. A maintainer read the
   * old line as a hosted MCP opening a browser bridge it had no business
   * opening, and went looking for the connection. The role is omitted rather
   * than reported, because at boot there is nothing to report.
   *
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
  const {
    debugEnvVar, env, defaultSubdomain, logListening, createServer, captureWindowMs, ...rest
  } = opts;
  // Raise the transport deadline to clear the declared capture window, so a
  // waiting verb actually gets the window it asks for and the extension's
  // informative rejection is the one that arrives. A no-op when
  // `captureWindowMs` is absent, which is every existing consumer.
  const derivedDeadline = deadlineForCaptureWindow(rest.fetchTimeoutMs, captureWindowMs);
  const serverOpts: FetchproxyServerOpts = {
    ...rest,
    ...(derivedDeadline !== undefined ? { fetchTimeoutMs: derivedDeadline } : {}),
  };

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
        // Canonical fleet banner. Stderr only — stdio MCP transports reserve
        // stdout for JSON-RPC. The port comes from the live bridge health so an
        // overridden port is reflected, and the tense comes from what `listen()`
        // actually did: loaded an identity. See `logListening` for why this no
        // longer claims to be listening.
        console.error(
          `[${serverOpts.serverName}:bridge] ready — 127.0.0.1:${server.bridgeHealth().port} ` +
            `binds on the first request (version=${serverOpts.version})`,
        );
      }
      else if (debug) {
        // Only when logListening didn't already print the (richer, port-bearing)
        // canonical banner — this debug line is a strict subset of it, so emitting
        // both is redundant. Stderr only — stdout is the JSON-RPC channel.
        console.error(
          `[${serverOpts.serverName}:bridge] ready — binds on the first request ` +
            `(version=${serverOpts.version})`,
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
        ...(init.retryOnTimeout !== undefined ? { retryOnTimeout: init.retryOnTimeout } : {}),
      }));
      return { status: response.status, body: response.body, url: response.url };
    },
    async requestJson<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, init: FetchproxyRequestJsonInit = {}) {
      const { data, result } = await server.requestJson<T>(method, path, withSubdomain({
        ...(init.headers !== undefined ? { headers: init.headers } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(init.subdomain !== undefined ? { subdomain: init.subdomain } : {}),
        ...(init.domain !== undefined ? { domain: init.domain } : {}),
        ...(init.retryOnTimeout !== undefined ? { retryOnTimeout: init.retryOnTimeout } : {}),
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
 * (deduped), ALWAYS alongside `fetch`. When no bootstrap declarations are
 * given, `capabilities` is left unset so the server falls back to its default
 * `['fetch']`.
 *
 * `fetch` is included because `capabilities` REPLACES the server's default
 * rather than extending it. A fragment derived from declarations alone
 * therefore declared (say) `['capture_request_header']`, and the transport
 * that spread it lost the fetch verb silently — surfacing only at runtime, on
 * the first request, as `capability "fetch" not granted (declared:
 * [capture_request_header])`. Every fetchproxy transport carries the fetch
 * verbs, so no bootstrap declaration can imply their absence.
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
  // (fetch is added below, only once something else is declared — see the
  // `capabilities.size > 0` guard on the return.)
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
    // `fetch` FIRST, so a reader sees the default plus what the declarations
    // added rather than a set that appears to have replaced it. Emitted only
    // when something was declared: with no declarations the key stays absent
    // and the server keeps its own default, which is a stronger statement
    // than handing it a one-element restatement of that default.
    ...(capabilities.size > 0 ? { capabilities: ['fetch' as Capability, ...capabilities] } : {}),
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
  /**
   * `capability_unavailable` (the BROWSER can't serve the verb — not the
   * MCP's fault) and `capability_denied` (the MCP used a capability it never
   * declared — a bug in the MCP) arrived with @fetchproxy 3.3 support; a consumer that
   * `switch`es exhaustively on this union gains two cases.
   *
   * `edge_blocked` (a CDN/WAF refused the request before the site saw it, so
   * the session was never evaluated — chrischall/mcp-host#1015) is judged as
   * {@link runBridgeHealthcheck} judges it: only over an `http` or
   * unclassified error that carries a refusal page or `cf-mitigated`.
   */
  type:
    | 'session_not_ready'
    | 'bridge_down'
    | 'timeout'
    | 'http'
    | 'protocol'
    | 'capability_unavailable'
    | 'capability_denied'
    | 'edge_blocked'
    | 'unknown';
  message: string;
  hint?: string;
}

/** Where users get the extension. No store listing exists yet — never invent one. */
const CONTEXTMINT_BRIDGE_RELEASES = 'https://github.com/nullnet-app/contextmint-bridge/releases';

/**
 * The fixed wire wording for a capability the browser lacks
 * (`@fetchproxy/protocol`'s `capabilityUnavailableMessage`), matched anywhere
 * in the message because callers wrap it. Also accepts the pre-3.3 form that
 * named no browser. Duplicated rather than imported so this works against a
 * `@fetchproxy/server` that predates it.
 */
const CAPABILITY_UNAVAILABLE_RE = /capability "([^"]{1,64})" is not available in this browser(?: \(([^)]{1,32})\))?/;
/** The `hello-rejected` reason sent when NOTHING the MCP declared is servable here. */
const UNSUPPORTED_CAPABILITY_RE = /unsupported-capability:\s*([^()]+?)\s*\(not available in this browser\)/;
/** The extension's wording for a capability the MCP never declared (`capability_denied`). */
const CAPABILITY_DENIED_RE = /\bcapability \S.* not granted/;

/**
 * The server-classifier kinds a capability error can arrive under: a bare or
 * hinted protocol error, a refused hello, or (from a foreign copy of the
 * package) nothing it recognises. Never an upstream HTTP error, a timeout or a
 * dead service worker — their messages can quote anything.
 */
function mayBeCapabilityError(kind: string): boolean {
  return kind === 'protocol' || kind === 'hello_rejected' || kind === 'other';
}

/** What a browser-gap error tells us: the capabilities it lacks and which browser, when known. */
interface CapabilityGap {
  capabilities: string[];
  platform: string | null;
  /** The extension's raw rejection, when the error carried it apart from a folded-in hint. */
  originalError?: string;
}

function stringField(err: unknown, key: string): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const v = (err as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Detect "this browser cannot serve that capability" (@fetchproxy 3.3+, #418)
 * on ANY installed `@fetchproxy/server`: by the typed error's name and fields,
 * by the wire `code`, by the `unsupported-capability:` hello rejection, and by
 * the fixed wording — the last being all a pre-3.3 server passes through (as a
 * bare `FetchproxyProtocolError`, which its classifier calls `'protocol'`).
 * Duck-typed on purpose: importing the 3.3 classes would fail to link against
 * the older servers the peer range still accepts.
 */
function capabilityGapOf(err: unknown): CapabilityGap | null {
  const name = err instanceof Error ? err.name : undefined;
  const message = messageOf(err);
  const originalError = stringField(err, 'originalError');
  const platformField = stringField(err, 'platform') ?? null;

  if (name === 'FetchproxyHelloRejectedError') {
    const listed = (err as { unavailableCapabilities?: unknown }).unavailableCapabilities;
    const parsed = UNSUPPORTED_CAPABILITY_RE.exec(stringField(err, 'reason') ?? message);
    const capabilities =
      Array.isArray(listed) && listed.length > 0
        ? listed.map(String)
        : parsed
          ? parsed[1]!.split(',').map((c) => c.trim()).filter(Boolean)
          : [];
    return capabilities.length > 0 ? { capabilities, platform: platformField } : null;
  }

  const wording = CAPABILITY_UNAVAILABLE_RE.exec(originalError ?? message);
  const typed = name === 'FetchproxyCapabilityUnavailableError';
  const coded = stringField(err, 'code') === 'capability_unavailable';
  // The server's own string classifier, where the installed one knows the kind
  // (3.3+). Harmless on older servers — it answers something else.
  const classified = classifyFetchErrorKind(originalError ?? message) === ('capability_unavailable' as string);
  if (!typed && !coded && !wording && !classified) return null;

  const capability = stringField(err, 'capability') ?? wording?.[1];
  return {
    capabilities: capability ? [capability] : [],
    platform: platformField ?? wording?.[2] ?? null,
    ...(originalError !== undefined ? { originalError } : {}),
  };
}

/** `capability_denied`: the MCP asked for a capability it never declared. */
function isCapabilityDenied(err: unknown): boolean {
  const text = stringField(err, 'originalError') ?? messageOf(err);
  if (CAPABILITY_UNAVAILABLE_RE.test(text)) return false;
  return classifyFetchErrorKind(text) === 'capability_denied' || CAPABILITY_DENIED_RE.test(text);
}

function capabilityUnavailableHint(gap: { capabilities: string[]; platform: string | null }): string {
  const where = gap.platform ? `This browser (${gap.platform})` : 'This browser';
  const what =
    gap.capabilities.length === 0
      ? 'what this tool needs'
      : gap.capabilities.length === 1
        ? `the "${gap.capabilities[0]}" capability this tool needs`
        : `the capabilities this MCP needs (${gap.capabilities.map((c) => `"${c}"`).join(', ')})`;
  return (
    `${where} can't serve ${what} — ContextMint Bridge checked for the browser API and it is missing. ` +
    `The MCP isn't at fault, and re-pairing or updating won't change it: use a browser that supports it ` +
    `(for example Chrome) for this.`
  );
}

/** {@link bridgeErrorInfo}'s copy for `edge_blocked`; it has no host label to name. */
function edgeBlockedHint(vendor: string): string {
  return (
    `The site's CDN/WAF (${vendor}) refused the request before it reached the site, so the session was never ` +
    'evaluated — signing in again or re-pairing ContextMint Bridge will not help. This is usually a block on the ' +
    "browser's IP address or fingerprint (a VPN, a flagged network, a challenge the tab has not passed): open the " +
    'site in the tab and clear any challenge, or retry later from a different network.'
  );
}

const CAPABILITY_DENIED_HINT =
  'The MCP asked ContextMint Bridge for a capability it never declared, so the request was refused. ' +
  'This is a bug in the MCP, not in your browser or pairing — please report it to the maintainer of the MCP.';

/**
 * Thin discriminator over the `@fetchproxy/server` typed-error hierarchy. Folds
 * the re-exported raw {@link classifyBridgeError} (which returns a bare kind
 * string) into a `{ type, message, hint? }` envelope, mapping fetchproxy's
 * `'other'` to `'unknown'` and lifting the per-class remediation `hint` where one
 * exists. The surfaced message is redacted + truncated. Use this when you want
 * the structured envelope; use the re-exported `classifyBridgeError` for the raw
 * string kind (drop-in compatible with `@fetchproxy/server`).
 *
 * `capability_unavailable` / `capability_denied` are detected ahead of the
 * server's classifier, which files both under `'protocol'` (or, for a
 * browser that refused the hello outright, `'hello_rejected'`).
 */
export function bridgeErrorInfo(err: unknown): BridgeErrorInfo {
  if (err instanceof FetchproxySessionNotReadyError) {
    // Checked here rather than through the server's classifier so it holds on
    // a 2.4 server too (2.5.0 classifies it; before that it fell to 'other').
    // The server folds the hint into the message — split it back out so a
    // consumer that appends `hint` to `message` does not say it twice.
    return {
      type: 'session_not_ready',
      message: truncateErrorMessage(messageOf(err).replace(err.hint, '').trim()),
      hint: err.hint,
    };
  }
  const kind = classifyBridgeErrorKind(err);
  const gap = mayBeCapabilityError(kind) ? capabilityGapOf(err) : null;
  if (gap) {
    return {
      type: 'capability_unavailable',
      // A hinted server error folds its own remedy into the message; keep the
      // wire rejection so a consumer appending `hint` doesn't say it twice.
      message: truncateErrorMessage(gap.originalError ?? messageOf(err)),
      hint: capabilityUnavailableHint(gap),
    };
  }
  if (mayBeCapabilityError(kind) && isCapabilityDenied(err)) {
    return {
      type: 'capability_denied',
      message: truncateErrorMessage(stringField(err, 'originalError') ?? messageOf(err)),
      hint: CAPABILITY_DENIED_HINT,
    };
  }
  const message = truncateErrorMessage(messageOf(err));

  // Same rule, same gate as runBridgeHealthcheck's edge_blocked arm, so the
  // tool-boundary envelope and the healthcheck never disagree about one error.
  if (kind === 'http' || kind === 'other') {
    const edge = edgeBlockOf(err);
    if (edge !== null) return { type: 'edge_blocked', message, hint: edgeBlockedHint(edge.vendor) };
  }

  switch (kind) {
    case 'timeout':
      return {
        type: 'timeout',
        message,
        hint: 'The request through ContextMint Bridge timed out. Check the browser tab is open and responsive, then retry.',
      };
    case 'bridge_down': {
      const hint = err instanceof FetchproxyBridgeDownError ? err.hint : undefined;
      return {
        type: 'bridge_down',
        message,
        hint: hint ?? 'ContextMint Bridge is offline. Open a signed-in tab so the extension can relay the request.',
      };
    }
    case 'http':
      return { type: 'http', message };
    case 'protocol':
      return {
        type: 'protocol',
        message,
        hint: 'ContextMint Bridge could not relay the request (e.g. no signed-in tab or denied domain).',
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
  /**
   * The bridge projection. Present whenever a bridge transport exists —
   * always, except on the direct leg of a {@link RegisterBridgeHealthcheckToolArgs.path}
   * consumer, where no bridge has been built. `session_state` /
   * `pending_pair_code` / `extension_connected` arrive with `@fetchproxy/server`
   * 2.5.0+ (`bridgeHealth().session`) and are absent on older servers.
   */
  bridge?: BridgeProbeResult['bridge'] & {
    last_extension_message_at: number | null;
    session_state?: 'not_listening' | 'linked' | 'pair_pending' | 'extension_disconnected' | 'no_session';
    pending_pair_code?: string | null;
    extension_connected?: boolean;
    /**
     * Capabilities the browser behind the current session said it cannot
     * serve, and which browser that is (`@fetchproxy/server` 3.3+,
     * `bridgeHealth().session`). Absent on older servers.
     */
    unavailable_capabilities?: string[];
    platform?: string | null;
  };
  /** Which leg served the probe — present when {@link RegisterBridgeHealthcheckToolArgs.path} is supplied. */
  transport?: HealthcheckPath;
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
     * `'edge_blocked'` means a CDN/WAF refused the probe before the site saw
     * it (a refusal page or `cf-mitigated` on the thrown error); its vendor is
     * in `detail.vendor`.
     */
    kind: string;
    message: string;
    /** Server-authored next-step hint (`FetchproxyBridgeDownError.hint`), when present. */
    bridge_hint?: string;
    /**
     * Extra structured diagnostics supplied by
     * {@link RegisterBridgeHealthcheckToolArgs.classifyThrown} (e.g. a repo's
     * `elapsed_ms_at_timeout` / `retry_attempted` / `role_at_failure`). The
     * shared envelope carries no fixed slots for these, so a consumer that wants
     * the richer detail its hand-rolled healthcheck used to return injects it
     * here. Omitted when the classifier supplies none.
     */
    detail?: Record<string, unknown>;
  };
  /** Plain-English next-step suggestion derived from the result. */
  hint: string;
}

/** The hint-ladder arms whose copy {@link RegisterBridgeHealthcheckToolArgs.hints} can override. */
export type HealthcheckHintArm =
  | 'ok'
  | 'session_not_ready'
  | 'bridge_down'
  | 'no_role'
  | 'timeout'
  | 'protocol'
  | 'capability_unavailable'
  | 'capability_denied'
  | 'edge_blocked'
  | 'direct'
  | 'unknown';

/**
 * Which leg a direct-first consumer is serving calls on. `transport` is the
 * path the next call rides; `mode` is the configured pin (e.g. hemnet's
 * `HEMNET_TRANSPORT`: `direct` / `fetchproxy` / `auto`). Extra fields pass
 * through to the result untouched.
 */
export interface HealthcheckPath {
  transport: 'direct' | 'fetchproxy' | 'unknown';
  mode?: string;
  [key: string]: unknown;
}

/** The slice of {@link FetchproxyTransport} the healthcheck drives. */
export type BridgeHealthcheckTransport = Pick<FetchproxyTransport, 'runProbe' | 'status'>;

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
   * `'www.redfin.com'`. The probe URL is `https://<hostLabel>/<probePath>`,
   * with the separator inserted only when `probePath` does not already begin
   * with one — a transport whose app root sits under the host takes a bare
   * `Home`, and gluing that on rendered `https://my.atriumhealth.orgHome`.
   * Display only: `probeFn` receives `probePath` verbatim.
   */
  hostLabel: string;
  /**
   * The bridge transport — supplies `runProbe` (the probe loop + classification
   * + post-probe bridge projection) and `status()` (for the liveness counter the
   * projection omits). Any {@link FetchproxyTransport}-shaped object works.
   *
   * A direct-first consumer (see {@link path}) builds its bridge lazily — often
   * the probe itself is what flips the fallback — so it may pass a getter
   * instead, returning the bridge once it exists and `undefined` before. The
   * getter is read AFTER the probe.
   */
  transport: BridgeHealthcheckTransport | (() => BridgeHealthcheckTransport | undefined);
  /**
   * Direct-first consumers (hemnet, booli: a plain fetch that falls back to the
   * bridge when a bot wall answers): report which leg serves calls now. Read
   * after the probe. When supplied, the probe runs through `probeFn` directly —
   * `runProbe` needs a bridge up front and there may be none — and the bridge
   * block is projected from `transport().status()` only if a bridge exists.
   * The result carries the path as `transport`.
   */
  path?: () => HealthcheckPath;
  /**
   * Performs the actual probe fetch for `probePath`. Required — most consumers
   * pass `(path) => client.fetchHtml(path)` so the probe exercises the same
   * client path real tools use (sign-in guards and all).
   */
  probeFn: (path: string) => Promise<string>;
  /**
   * Map the error the probe THREW to a site-specific `{ kind, hint?, detail? }` —
   * e.g. workday classifies its `SessionNotAuthenticatedError` as
   * `session_expired` with SSO re-sign-in copy. Return `undefined` to keep the
   * default classification. A returned `hint` wins the whole result hint; a
   * returned `detail` object is merged into the result's `error.detail` (the
   * hook zillow/etix use to re-attach the structured diagnostics —
   * `elapsed_ms_at_timeout` etc. — the shared envelope has no fixed slots for).
   * Absorbs the error-kind special cases that kept workday / zillow / etix on
   * hand-rolled healthchecks.
   */
  classifyThrown?: (err: unknown) => { kind: string; hint?: string; detail?: Record<string, unknown> } | undefined;
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
  port: number | null;
  hostLabel: string;
  prefix: string;
  probePath: string;
  errorKind?: string;
  bridgeHint?: string;
  /** 2.5.0 session snapshot (when the server reports one), plus the thrown error's pair code. */
  session?: { state?: string; pairCode: string | null };
  /** Set when the probe rode a direct fetch with no bridge in play. */
  direct?: boolean;
  /** The browser gap, when the probe failed with `capability_unavailable`. */
  capabilityGap?: { capabilities: string[]; platform: string | null };
  /** The CDN/WAF that refused the probe, when it failed with `edge_blocked`. */
  edgeVendor?: string;
}): string {
  const { hostLabel, prefix, probePath, port } = args;
  // Never a literal 37149: when no bridge exists yet there is no port to
  // name, and guessing the default is the bug this factory exists to remove.
  const portNote = port === null ? '' : ` (port ${port})`;
  if (args.ok) {
    if (args.direct) {
      return `Direct fetch round-tripped ${probePath} successfully — the browser bridge wasn't used for this probe. If real tools still fail, the problem is on the ${hostLabel} side (a bot wall answering some calls but not this one, a field that moved, …), not the transport.`;
    }
    return `Bridge round-tripped ${probePath} successfully. If real tools still fail, the problem is downstream of ContextMint Bridge (${hostLabel} redirecting on login, a bot-wall / behavioral challenge, etc.) — not the bridge.`;
  }
  if (args.errorKind === 'capability_unavailable') {
    return capabilityUnavailableHint(args.capabilityGap ?? { capabilities: [], platform: null });
  }
  if (args.errorKind === 'capability_denied') {
    return CAPABILITY_DENIED_HINT;
  }
  if (args.errorKind === 'edge_blocked') {
    const edge = args.edgeVendor ? `its CDN/WAF (${args.edgeVendor})` : 'its CDN/WAF';
    if (args.direct) {
      return `${hostLabel} refused the probe at ${edge} before it reached the site, so the session was never evaluated — signing in again will not help. The probe rode the direct fetch, and this is usually a block on this host's IP address or request fingerprint: route through ContextMint Bridge (pin the consumer's transport env var to the bridge) so the request leaves from your browser instead.`;
    }
    return `${hostLabel} refused the probe at ${edge} before it reached the site, so the session was never evaluated — signing in again or re-pairing will not help. The bridge itself worked: the request rode your browser and came back with the edge's refusal page. This is usually a block on that browser's IP address or fingerprint (a VPN, a flagged network, a challenge the tab has not passed): open ${hostLabel} in the tab and clear any challenge, or retry later from a different network.`;
  }
  if (args.errorKind === 'session_not_ready') {
    const s = args.session;
    if (s?.pairCode) {
      return `ContextMint Bridge is waiting for you to approve pair code ${s.pairCode} for ${prefix}-mcp. Open the ContextMint Bridge popup, approve it, then retry.`;
    }
    if (s?.state === 'extension_disconnected') {
      return `ContextMint Bridge isn't attached to this bridge${portNote}. Open a browser with ContextMint Bridge installed and a ${hostLabel} tab, then retry. (Chrome: load the extension from ${CONTEXTMINT_BRIDGE_RELEASES}; Safari: it ships inside the ContextMint app.)`;
    }
    return `ContextMint Bridge is attached but never confirmed a session for ${prefix}-mcp — its hello got no answer within the session-ready timeout. Reload the extension (chrome://extensions) or reopen the ${hostLabel} tab, then retry. On a hosted bridge this is also what a relay that dialled the child before it bound its port${portNote} looks like.`;
  }
  if (args.errorKind === 'bridge_down') {
    const base = `The ContextMint Bridge extension's service worker is not responding. Chrome evicts extension service workers after ~30s idle by default — this looks like that case. Wake it by clicking the ContextMint Bridge icon in the toolbar (or opening any ${hostLabel} tab and reloading), then retry. If it keeps happening, reload the extension from chrome://extensions.`;
    return args.bridgeHint ? `${args.bridgeHint} ${base}` : base;
  }
  if (args.direct) {
    return `The probe ran over the direct fetch — the browser bridge wasn't used for this probe — and failed; see error.message. If ${hostLabel} is answering with a bot wall, pin the bridge (the consumer's transport env var) or leave the default fallback to switch on the next challenge.`;
  }
  if (args.role === null) {
    return `The bridge never bound a role. listen() may have failed silently on startup. Check stderr from ${prefix}-mcp for an error during start, and confirm ${port === null ? 'the bridge port' : `port ${port}`} isn't blocked.`;
  }
  if (args.errorKind === 'timeout') {
    return `Bridge is alive (role=${args.role}), but the request didn't get a response in time. Either (a) ContextMint Bridge isn't connected to this MCP yet — open the ContextMint Bridge popup and check for a green dot next to "${prefix}-mcp", or (b) the signed-in ${hostLabel} tab is sleeping / closed. Open ${hostLabel} in your browser, then retry.`;
  }
  if (args.errorKind === 'protocol' || args.errorKind === 'http') {
    return `The bridge returned a protocol error before any HTTP response. Most commonly: no ${hostLabel} tab is open, or ContextMint Bridge declined the request. Open ${hostLabel}, sign in, and retry.`;
  }
  return `Unexpected error — see the error.message field for details.`;
}

/** Redact + truncate a bridge failure reason, keeping `null`/absent as-is. */
function redactReason<T>(reason: T): T {
  return (typeof reason === 'string' ? truncateErrorMessage(reason) : reason) as T;
}

/**
 * Snake-case a live `status()` snapshot into the same shape `runProbe`'s
 * `bridge` projection has — used on the path-aware route, where the probe
 * did not go through `runProbe`. Tolerates a pre-2.5.0 server (no `session`).
 */
function projectBridgeStatus(
  health: ReturnType<FetchproxyTransport['status']>,
): NonNullable<BridgeHealthcheckResult['bridge']> {
  const session = (
    health as {
      session?: {
        state: string;
        pairCode: string | null;
        extensionConnected: boolean;
        unavailableCapabilities?: string[];
        platform?: string | null;
      };
    }
  ).session;
  return {
    role: health.role,
    port: health.port,
    server_version: health.serverVersion,
    fetch_timeout_ms: health.fetchTimeoutMs,
    last_success_at: health.lastSuccessAt,
    last_failure_at: health.lastFailureAt,
    last_failure_reason: redactReason(health.lastFailureReason),
    consecutive_failures: health.consecutiveFailures,
    last_extension_message_at: health.lastExtensionMessageAt,
    ...(session
      ? {
          session_state: session.state as NonNullable<BridgeHealthcheckResult['bridge']>['session_state'],
          pending_pair_code: session.pairCode,
          extension_connected: session.extensionConnected,
          // 3.3+ only; absent keys stay absent on an older server.
          ...(session.unavailableCapabilities !== undefined
            ? { unavailable_capabilities: session.unavailableCapabilities }
            : {}),
          ...(session.platform !== undefined ? { platform: session.platform } : {}),
        }
      : {}),
  } as NonNullable<BridgeHealthcheckResult['bridge']>;
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
/** The bridge arm's one-line description, shared with the adaptive tool. */
/**
 * The display URL for a probe path.
 *
 * `probePath` is dual-purpose on the bridge arm: it is shown to the caller AND
 * handed to `probeFn`, which wants whatever form that consumer's client takes.
 * A transport with an app root under the host takes a bare `Home`, and joining
 * that on gave `https://my.atriumhealth.orgHome` — a URL that reads as broken
 * in the one output people paste into a bug report. Only the display is
 * normalised; the value the probe receives is untouched.
 */
function probeDisplayUrl(hostLabel: string, probePath: string): string {
  return `https://${hostLabel}${probePath.startsWith('/') ? '' : '/'}${probePath}`;
}

export function bridgeHealthcheckDescription(hostLabel: string, probePath: string): string {
  return `Round-trips a small public ${hostLabel} URL (${probePath}) through ContextMint Bridge (your signed-in browser tab) and returns diagnostics: the bridge's role (host/peer/null), port, version, the extension link (linked / pair pending / not attached / never answered), the elapsed round-trip time, and a plain-English hint distinguishing 'bridge never came up' from 'extension not connected' from 'this browser can't serve a capability' from 'real ${hostLabel}-side problem'. Read-only, no auth required.`;
}

/**
 * The bridge healthcheck's whole body, without the registration.
 *
 * Split out for {@link registerAdaptiveHealthcheckTool}, so a server with two
 * transports can answer one tool from whichever arm is actually carrying its
 * requests. {@link registerBridgeHealthcheckTool} is unchanged.
 */
export async function runBridgeHealthcheck(
  args: RegisterBridgeHealthcheckToolArgs,
): Promise<HealthcheckToolResult> {
  const { prefix, probePath, hostLabel, probeFn, classifyThrown, hints, path } = args;
  const probeUrl = probeDisplayUrl(hostLabel, probePath);
  const resolveTransport = (): BridgeHealthcheckTransport | undefined =>
    typeof args.transport === 'function' ? args.transport() : args.transport;
  let probeBody = '';
  let thrown: unknown;
  const wrappedProbe = async (p: string): Promise<string> => {
    try {
      probeBody = await probeFn(p);
      return probeBody;
    } catch (e) {
      thrown = e;
      throw e;
    }
  };

  let ok: boolean;
  let elapsedMs: number;
  let bridge: BridgeHealthcheckResult['bridge'];
  let rawError: { kind: string; message: string } | undefined;
  let pathNow: HealthcheckPath | undefined;

  if (path) {
    // Direct-first route: the probe itself may be what flips the fallback,
    // so run it plainly, then read the path and the bridge AFTER it.
    const start = Date.now();
    try {
      await wrappedProbe(probePath);
      ok = true;
    } catch (e) {
      ok = false;
      // Redaction first, then truncation — `probeFn` is consumer code and
      // its throw is the one place an arbitrary upstream message reaches
      // the tool result on this route.
      rawError = { kind: classifyBridgeErrorKind(e), message: truncateErrorMessage(messageOf(e)) };
    }
    elapsedMs = Date.now() - start;
    pathNow = path();
    const transport = resolveTransport();
    bridge = transport ? projectBridgeStatus(transport.status()) : undefined;
  } else {
    const transport = resolveTransport();
    if (!transport) {
      throw new Error(
        'bridge healthcheck: transport() returned nothing and no `path` was supplied — a bridge-only healthcheck needs its bridge.',
      );
    }
    const probeResult = await transport.runProbe(wrappedProbe, probePath);
    ok = probeResult.ok;
    elapsedMs = probeResult.elapsed_ms;
    // The post-probe bridge projection omits `lastExtensionMessageAt` before
    // 2.5.0; read it off the live status snapshot (same call, so it's current).
    bridge = {
      ...probeResult.bridge,
      last_failure_reason: redactReason(probeResult.bridge.last_failure_reason),
      last_extension_message_at: transport.status().lastExtensionMessageAt,
    };
    // `runProbe` copies the thrown message verbatim; `probeFn` is consumer
    // code whose errors can quote upstream bodies. Same redaction as the
    // direct route.
    rawError = probeResult.error
      ? { ...probeResult.error, message: truncateErrorMessage(probeResult.error.message) }
      : undefined;
  }

  const probe: BridgeHealthcheckResult['probe'] = ok
    ? { url: probeUrl, elapsed_ms: elapsedMs, status: 200, body_length: probeBody.length }
    : { url: probeUrl, elapsed_ms: elapsedMs };

  let error: BridgeHealthcheckResult['error'];
  let bridgeHint: string | undefined;
  let customHint: string | undefined;
  let customDetail: Record<string, unknown> | undefined;
  let capabilityGap: CapabilityGap | undefined;
  let edge: { vendor: string } | null = null;
  if (rawError) {
    // `runProbe` (or classifyBridgeError on the direct route) already
    // classified the throw in fetchproxy's raw vocabulary. Trust that as
    // the discriminator — mapping `'other'` → `'unknown'` to match the
    // envelope — except for a session-not-ready throw, which a 2.4 server
    // still files under 'other': the typed `thrown` settles it either way.
    let kind: string = rawError.kind === 'other' ? 'unknown' : rawError.kind;
    if (thrown instanceof FetchproxySessionNotReadyError) {
      kind = 'session_not_ready';
      bridgeHint = thrown.hint;
    } else if (thrown instanceof FetchproxyBridgeDownError) {
      bridgeHint = thrown.hint;
    } else if (thrown !== undefined && mayBeCapabilityError(rawError.kind)) {
      // The server's classifier files a browser gap under 'protocol' (or
      // 'hello_rejected'); name it, so the ladder can say whose fault it isn't.
      const gap = capabilityGapOf(thrown);
      if (gap) {
        kind = 'capability_unavailable';
        capabilityGap = gap;
      } else if (isCapabilityDenied(thrown)) {
        kind = 'capability_denied';
      }
    }
    // A CDN/WAF refusal page that came back through the probe — on a
    // FetchproxyHttpError's response, or as a consumer client's
    // EdgeBlockedError — is neither a bridge fault nor a dead session: the
    // request was refused before the site saw it. Named by the same rule the
    // credential healthcheck uses, and only over an `http`/unclassified
    // failure, so a bridge that is down, unpaired, timed out or missing a
    // capability keeps its own answer.
    if (thrown !== undefined && (kind === 'http' || kind === 'unknown')) {
      edge = edgeBlockOf(thrown);
      if (edge !== null) {
        kind = 'edge_blocked';
        customDetail = { vendor: edge.vendor };
      }
    }
    // A consumer classifier can re-kind the thrown error (e.g. workday's
    // session_expired) and supply site-specific next-step copy.
    if (thrown !== undefined && classifyThrown) {
      const custom = classifyThrown(thrown);
      if (custom) {
        kind = custom.kind;
        customHint = custom.hint;
        // The consumer's detail wins when it gave one; otherwise the edge
        // vendor seen above is kept, since it is a fact about the response.
        customDetail = custom.detail ?? customDetail;
      }
    }
    error = {
      kind,
      message: rawError.message,
      ...(bridgeHint !== undefined ? { bridge_hint: bridgeHint } : {}),
      ...(customDetail !== undefined ? { detail: customDetail } : {}),
    };
  }

  // Which leg served the probe: `path()` is authoritative when supplied — a
  // consumer may hold an eagerly-built bridge while riding direct — and
  // only without it does "no bridge" mean "direct".
  const direct = pathNow ? pathNow.transport === 'direct' : bridge === undefined;
  // Which ladder arm applies — mirrors healthcheckHint's precedence order —
  // so per-arm `hints` overrides land on the same arm the default copy would.
  const arm: HealthcheckHintArm = ok
    ? 'ok'
    : error?.kind === 'capability_unavailable' || error?.kind === 'capability_denied' || error?.kind === 'edge_blocked'
      ? error.kind
      : error?.kind === 'session_not_ready'
      ? 'session_not_ready'
      : error?.kind === 'bridge_down'
        ? 'bridge_down'
        : direct
          ? 'direct'
          : bridge === undefined || bridge.role === null
            ? 'no_role'
            : error?.kind === 'timeout'
              ? 'timeout'
              : error?.kind === 'protocol' || error?.kind === 'http'
                ? 'protocol'
                : 'unknown';

  const defaultHint = healthcheckHint({
    ok,
    role: bridge?.role ?? null,
    // The real configured port from bridgeHealth(), never a literal 37149.
    port: bridge?.port ?? null,
    hostLabel,
    prefix,
    probePath,
    errorKind: error?.kind,
    bridgeHint: error?.kind === 'bridge_down' ? bridgeHint : undefined,
    session: {
      ...(bridge?.session_state !== undefined ? { state: bridge.session_state } : {}),
      pairCode:
        bridge?.pending_pair_code ??
        (thrown instanceof FetchproxySessionNotReadyError ? thrown.pairCode : null),
    },
    direct,
    ...(edge !== null ? { edgeVendor: edge.vendor } : {}),
    ...(capabilityGap
      ? {
          capabilityGap: {
            capabilities: capabilityGap.capabilities,
            // The error may not name the browser; the session snapshot can.
            platform: capabilityGap.platform ?? bridge?.platform ?? null,
          },
        }
      : {}),
  });

  const result: BridgeHealthcheckResult = {
    ok,
    ...(bridge ? { bridge } : {}),
    ...(pathNow ? { transport: pathNow } : {}),
    probe,
    ...(error ? { error } : {}),
    // Precedence: classifyThrown's hint > per-arm override > default ladder.
    hint: customHint ?? hints?.[arm] ?? defaultHint,
  };

  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  };
}

/**
 * Register a `<prefix>_healthcheck` MCP tool that round-trips `probePath`
 * through the bridge. The body is {@link runBridgeHealthcheck}.
 */
export function registerBridgeHealthcheckTool(args: RegisterBridgeHealthcheckToolArgs): void {
  args.server.registerTool(
    `${args.prefix}_healthcheck`,
    {
      title: 'Verify the ContextMint Bridge connection end-to-end',
      description: `${bridgeHealthcheckDescription(args.hostLabel, args.probePath)} Call this when a real tool fails and you want to know which hop broke.`,
      annotations: {
        title: 'Verify the ContextMint Bridge connection end-to-end',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({}),
    },
    async () => runBridgeHealthcheck(args),
  );
}

/**
 * The credential-arm types this subpath's OWN API is expressed in, so a caller
 * of `registerAdaptiveHealthcheckTool` or `runBridgeHealthcheck` can name every
 * type it hands over or gets back without a second import.
 *
 * These are NOT the 0.19-era compatibility re-export that used to sit below
 * them and was removed in 1.0.0: `RegisterCredentialHealthcheckToolArgs` is
 * what `RegisterAdaptiveHealthcheckToolArgs['credential']` is expressed in, so
 * removing it would break a NON-deprecated API. An export whose removal breaks
 * a live API is not a compatibility shim, which is why it stayed.
 */
export type {
  HealthcheckToolResult,
  RegisterCredentialHealthcheckToolArgs,
} from '../healthcheck/index.js';

import {
  credentialHealthcheckDescription,
  runCredentialHealthcheck,
  type HealthcheckToolResult,
  type RegisterCredentialHealthcheckToolArgs,
} from '../healthcheck/index.js';
import { z } from 'zod';

/**
 * Arguments for {@link registerAdaptiveHealthcheckTool}.
 *
 * The two arms are the SAME option bags the single-arm factories take, minus
 * the three fields the tool itself owns (`server`, `prefix`, `hostLabel`), so
 * a server adopting this does not restate them.
 */
export interface RegisterAdaptiveHealthcheckToolArgs {
  server: RegisterBridgeHealthcheckToolArgs['server'];
  /** Tool-name prefix; the tool is `${prefix}_healthcheck`. */
  prefix: string;
  hostLabel: string;
  /**
   * Whether the browser bridge is on the request path, read PER CALL rather
   * than captured at registration. A server that decides its transport at boot
   * can pass a constant thunk; one that can switch reports the truth at the
   * moment somebody asks.
   */
  usingBridge: () => boolean;
  bridge: Omit<RegisterBridgeHealthcheckToolArgs, 'server' | 'prefix' | 'hostLabel'>;
  credential: Omit<RegisterCredentialHealthcheckToolArgs, 'server' | 'prefix' | 'hostLabel'>;
}

/**
 * ONE `${prefix}_healthcheck` for a server with TWO transports, answering from
 * whichever arm is actually carrying requests.
 *
 * A server that picks its transport from what is configured — credentials, so
 * sign in directly; otherwise relay through the browser — used to register one
 * of the two single-arm factories at boot. Same tool NAME either way, so no
 * client ever saw two healthchecks; but the tool's title, description and
 * result shape changed with the environment it happened to start in. That is a
 * tool surface that depends on configuration, and it misleads twice over: a
 * host that enumerates tools from a child spawned without credentials
 * publishes a bridge tool for a server that will never use a bridge, and the
 * description promises whichever hop the boot happened to pick rather than the
 * one the caller is actually on.
 *
 * So the identity is fixed here and only the BODY varies: the description names
 * both paths and says the answer follows the live one, and `usingBridge()`
 * decides which body runs when the tool is called.
 *
 * Both arms keep their own diagnostics verbatim — this is a dispatcher, not a
 * third implementation.
 *
 * @example
 * registerAdaptiveHealthcheckTool({
 *   server, prefix: 'mah', hostLabel: 'my.atriumhealth.org',
 *   usingBridge: () => bridge !== undefined,
 *   bridge: { probePath: 'Home', transport, probeFn: (p) => client.page(p) },
 *   credential: { probePath: '/Home', resolveCredential, probeFn },
 * });
 */
export function registerAdaptiveHealthcheckTool(args: RegisterAdaptiveHealthcheckToolArgs): void {
  const { server, prefix, hostLabel, usingBridge, bridge, credential } = args;

  server.registerTool(
    `${prefix}_healthcheck`,
    {
      title: 'Verify this server can reach its upstream',
      description:
        `Reports which hop is broken when a real tool fails, for whichever path this server is actually using. ` +
        `Relaying through your signed-in browser tab: ${bridgeHealthcheckDescription(hostLabel, bridge.probePath)} ` +
        `Signing in server-side with configured credentials: ${credentialHealthcheckDescription(hostLabel)}`,
      annotations: {
        title: 'Verify this server can reach its upstream',
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
      inputSchema: z.object({}),
    },
    async () =>
      usingBridge()
        ? runBridgeHealthcheck({ server, prefix, hostLabel, ...bridge })
        : runCredentialHealthcheck({ server, prefix, hostLabel, ...credential }),
  );
}
