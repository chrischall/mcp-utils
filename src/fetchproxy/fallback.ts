/**
 * Direct-first transport with a sticky fallback to the browser bridge when a
 * CDN/WAF walls the direct fetch.
 *
 * ## What it consolidates
 *
 * hemnet-mcp and booli-mcp each carried a `transport-fallback.ts` (111 / 105
 * lines) that differed only in names and log text, plus a
 * `createDefaultTransport` reading `<PREFIX>_TRANSPORT`
 * (chrischall/fleet-audit#1020, #988). Neither is about Swedish real estate:
 * the shape is "a plain server-side fetch is preferred — no extension, no
 * pairing, no open tab — but the site's edge may refuse non-browser clients,
 * and when it does, ride the user's tab instead". Any fleet MCP whose direct
 * client already throws {@link EdgeBlockedError} (viator, getyourguide,
 * onehome, …) can adopt it to gain the fallback, and
 * {@link registerBridgeHealthcheckTool}'s `path` option was already built for
 * exactly this consumer.
 *
 * ## Behaviour
 *
 * - **`auto`** (default): every call tries the direct leg. The first call
 *   whose failure is an edge block — an `EdgeBlockedError`, or any error
 *   carrying a refusal page / `cf-mitigated` (the same `edgeBlockOf` rule the
 *   healthcheck and `bridgeErrorInfo` use) — builds the bridge, re-runs THAT
 *   call on it, and pins every later call to the bridge for the life of the
 *   process: the wall fingerprints the client, so re-probing direct would
 *   only burn a round trip per request. Re-sending the blocked call is safe
 *   even for a write: an edge block means the request never reached the
 *   origin. Any other direct failure propagates unchanged.
 * - **`direct`**: never falls back; the edge block propagates (the
 *   healthcheck reports it as `edge_blocked` with a direct-leg hint).
 * - **`fetchproxy`**: the bridge from the first call; direct is never used.
 *
 * The bridge is built lazily and at most once (concurrent walled calls share
 * one build); a factory that throws is retried on the next call rather than
 * cached. A bridge failure after the switch propagates as the bridge's own
 * typed error, so the healthcheck can classify it.
 *
 * ## Cancellation
 *
 * The effective signal is the caller's `signal` combined with the ambient
 * tool-call signal (`withAmbientCancellation`). A cancelled call runs no leg,
 * and a call cancelled while on the direct leg is never re-sent over the
 * bridge — though a wall it saw is still recorded, so the next call goes
 * straight to the bridge.
 */
import { readEnvVar } from '../config/index.js';
import { withAmbientCancellation } from '../cancel/index.js';
import { edgeBlockOf } from '../internal/edge-block.js';
import type { BridgeHealthcheckTransport } from './index.js';

/** Which leg a consumer is pinned to: `direct`, `fetchproxy`, or `auto` (direct with fallback). */
export type TransportMode = 'direct' | 'fetchproxy' | 'auto';

const TRANSPORT_MODES: readonly TransportMode[] = ['direct', 'fetchproxy', 'auto'];

/** Options for {@link readTransportMode}. */
export interface ReadTransportModeOptions {
  /** The mode when the variable is unset. Default `'auto'`. */
  default?: TransportMode;
  /** Env to read (tests). Default `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Where the unknown-value warning goes. Default `console.error` (stderr — stdout is the MCP pipe). */
  log?: (message: string) => void;
}

/**
 * Read a `<PREFIX>_TRANSPORT` pin (`direct` / `fetchproxy` / `auto`),
 * case-insensitively, through the hardened {@link readEnvVar} (so an
 * unexpanded `${…}` placeholder reads as unset). An unknown value warns —
 * naming the variable — and means the default, rather than failing the boot.
 */
export function readTransportMode(envVar: string, opts: ReadTransportModeOptions = {}): TransportMode {
  const fallback = opts.default ?? 'auto';
  const raw = readEnvVar(envVar, opts.env ? { env: opts.env } : {});
  if (raw === undefined) return fallback;
  const mode = raw.trim().toLowerCase();
  if ((TRANSPORT_MODES as readonly string[]).includes(mode)) return mode as TransportMode;
  (opts.log ?? ((m: string) => console.error(m)))(
    `Unknown ${envVar} value "${raw}" — using "${fallback}". Expected one of: ${TRANSPORT_MODES.join(', ')}.`,
  );
  return fallback;
}

/**
 * Which leg serves calls now, for {@link registerBridgeHealthcheckTool}'s
 * `path` option (a type alias so it is assignable to `HealthcheckPath`).
 * `blocked_by` names the edge vendor that forced the switch, when known.
 */
export type DirectFirstStatus = {
  transport: 'direct' | 'fetchproxy';
  mode: TransportMode;
  blocked_by?: string;
};

/** Request counters for a {@link DirectFirstTransport}; a snapshot. */
export interface DirectFirstStats {
  /** Calls attempted on each leg (a walled call counts once on each). */
  requests: { direct: number; fetchproxy: number };
  /** Of those, how many threw. A wall counts as a direct failure. */
  failures: { direct: number; fetchproxy: number };
  /** Direct failures judged to be an edge block. */
  edge_blocks: number;
  /** Epoch ms of the switch to the bridge, or `null` while still direct. */
  switched_at: number | null;
}

/** What a {@link DirectFirstTransport.run} call is told about its attempt. */
export interface DirectFirstCallContext {
  /** The leg this attempt rides. */
  leg: 'direct' | 'fetchproxy';
  /** The effective cancellation (caller's + ambient), to pass to `fetch`. */
  signal: AbortSignal | undefined;
}

/** Options for {@link createDirectFirstTransport}. */
export interface DirectFirstTransportOptions<D, B> {
  /** The direct leg (e.g. a plain-`fetch` transport). */
  direct: D;
  /**
   * Build the bridge leg. Called lazily — on the first wall in `auto`, on
   * first use in `fetchproxy` — and at most once once it succeeds.
   */
  bridge: () => B;
  /** Default `'auto'`. Typically `readTransportMode('<PREFIX>_TRANSPORT')`. */
  mode?: TransportMode;
  /** Log prefix for the switch notice, e.g. `'hemnet-mcp'`. */
  serverName: string;
  /** The site's host, named in the switch notice (`keep a <host> tab open`). */
  hostLabel?: string;
  /**
   * Which direct failures mean "walled — use the bridge". Default: an edge
   * block by the shared rule (an `EdgeBlockedError`, or a refusal page /
   * `cf-mitigated` on the error).
   */
  shouldFallBack?: (err: unknown) => boolean;
  /** Replaces the default stderr notice when the switch happens. */
  onFallback?: (info: { error: unknown; vendor: string | null }) => void;
  /**
   * The bridge's healthcheck slice (`runProbe` + `status`). Default: the
   * bridge's own `bridgeTransport()` when it has one, else the bridge itself
   * when it has `runProbe` and `status`.
   */
  bridgeHealth?: (bridge: B) => BridgeHealthcheckTransport | undefined;
  /** Where the default notice goes. Default `console.error`. */
  log?: (message: string) => void;
}

/** The router {@link createDirectFirstTransport} returns. */
export interface DirectFirstTransport<D, B> {
  /** The configured mode. */
  readonly mode: TransportMode;
  /**
   * Run one call on the leg currently in charge, falling back as described
   * in the module docs. `call` may run twice (direct, then bridge) — it must
   * not have side effects outside the request it makes.
   */
  run<R>(
    call: (leg: D | B, ctx: DirectFirstCallContext) => Promise<R>,
    opts?: { signal?: AbortSignal },
  ): Promise<R>;
  /** Which leg the NEXT call rides, for the healthcheck's `path`. */
  status(): DirectFirstStatus;
  /**
   * The bridge's healthcheck slice once a bridge exists (always available in
   * `fetchproxy` mode); `undefined` while on direct.
   */
  bridgeTransport(): BridgeHealthcheckTransport | undefined;
  /** A snapshot of the request counters. */
  stats(): DirectFirstStats;
}

function defaultBridgeHealth(bridge: unknown): BridgeHealthcheckTransport | undefined {
  if (typeof bridge !== 'object' || bridge === null) return undefined;
  const b = bridge as { bridgeTransport?: unknown; runProbe?: unknown; status?: unknown };
  if (typeof b.bridgeTransport === 'function') {
    return (b.bridgeTransport as () => BridgeHealthcheckTransport | undefined).call(bridge);
  }
  if (typeof b.runProbe === 'function' && typeof b.status === 'function') {
    return bridge as BridgeHealthcheckTransport;
  }
  return undefined;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
  }
}

/**
 * Build a direct-first transport router. See the module docs for the
 * behaviour; the consumer keeps its own leg types and wraps its one call:
 *
 * @example
 * const legs = createDirectFirstTransport({
 *   direct: new DirectTransport(opts),
 *   bridge: () => new HemnetFetchproxyTransport(opts),
 *   mode: readTransportMode('HEMNET_TRANSPORT'),
 *   serverName: 'hemnet-mcp',
 *   hostLabel: 'www.hemnet.se',
 * });
 * const transport: HemnetTransport = {
 *   graphql: (q, v) => legs.run((leg) => leg.graphql(q, v)),
 *   status: () => legs.status(),
 *   bridgeTransport: () => legs.bridgeTransport(),
 * };
 */
export function createDirectFirstTransport<D, B = D>(
  opts: DirectFirstTransportOptions<D, B>,
): DirectFirstTransport<D, B> {
  const mode = opts.mode ?? 'auto';
  const shouldFallBack = opts.shouldFallBack ?? ((err: unknown) => edgeBlockOf(err) !== null);
  const log = opts.log ?? ((m: string) => console.error(m));
  const project = opts.bridgeHealth ?? defaultBridgeHealth;

  let bridge: B | undefined;
  let walled = mode === 'fetchproxy';
  let blockedBy: string | undefined;
  const counters: DirectFirstStats = {
    requests: { direct: 0, fetchproxy: 0 },
    failures: { direct: 0, fetchproxy: 0 },
    edge_blocks: 0,
    switched_at: null,
  };

  const ensureBridge = (): B => {
    bridge ??= opts.bridge();
    return bridge;
  };

  const recordWall = (error: unknown): void => {
    if (walled) return; // a concurrent call already switched
    walled = true;
    counters.switched_at = Date.now();
    const vendor = edgeBlockOf(error)?.vendor ?? null;
    if (vendor !== null) blockedBy = vendor;
    if (opts.onFallback) {
      opts.onFallback({ error, vendor });
      return;
    }
    const by = vendor ? `refused by ${vendor}` : 'walled by the site';
    const tab = opts.hostLabel ? `Keep a ${opts.hostLabel} tab open` : 'Keep a tab on the site open';
    log(
      `[${opts.serverName}] Direct fetch was ${by} — switching to the ContextMint Bridge browser bridge for the ` +
        `rest of this session. ${tab} and approve the pairing prompt in the extension if one appears.`,
    );
  };

  return {
    mode,

    async run(call, runOpts = {}) {
      const signal = withAmbientCancellation(runOpts.signal);
      throwIfAborted(signal);

      if (!walled) {
        counters.requests.direct += 1;
        try {
          return await call(opts.direct, { leg: 'direct', signal });
        } catch (err) {
          counters.failures.direct += 1;
          const isWall = shouldFallBack(err);
          if (isWall) counters.edge_blocks += 1;
          if (mode !== 'auto' || !isWall) throw err;
          recordWall(err);
          // The caller has gone: do not re-send its call over the bridge.
          throwIfAborted(signal);
        }
      }

      const leg = ensureBridge();
      throwIfAborted(signal);
      counters.requests.fetchproxy += 1;
      try {
        return await call(leg, { leg: 'fetchproxy', signal });
      } catch (err) {
        counters.failures.fetchproxy += 1;
        throw err;
      }
    },

    status() {
      return {
        transport: walled ? 'fetchproxy' : 'direct',
        mode,
        ...(blockedBy !== undefined ? { blocked_by: blockedBy } : {}),
      };
    },

    bridgeTransport() {
      if (bridge === undefined && mode === 'fetchproxy') {
        try {
          ensureBridge();
        } catch {
          return undefined;
        }
      }
      return bridge === undefined ? undefined : project(bridge);
    },

    stats() {
      return {
        requests: { ...counters.requests },
        failures: { ...counters.failures },
        edge_blocks: counters.edge_blocks,
        switched_at: counters.switched_at,
      };
    },
  };
}
