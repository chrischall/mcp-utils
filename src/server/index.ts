/**
 * `server` — MCP bootstrap & lifecycle.
 *
 * The single biggest dedup win in the fleet: every `src/index.ts` is described
 * as "byte-identical" — construct an {@link McpServer}, run a fixed list of
 * `registerXTools(server, client)` calls, print a stderr banner, wire
 * SIGINT/SIGTERM to tear the transport down, then connect over stdio.
 *
 * This module collapses that 30–120 lines/MCP into three calls:
 *  - {@link createMcpServer} — build the server and apply the registrars.
 *  - {@link withGracefulShutdown} — SIGINT/SIGTERM → cleanup → exit.
 *  - {@link runMcp} — bootstrap + banner + serve + shutdown, the whole boot.
 *
 * It is deliberately transport- and domain-agnostic. The
 * deferred-config-error pattern (server boots before creds exist, so the host's
 * initial `tools/list` always succeeds and the first tool call surfaces the auth
 * error) is preserved by keeping client/transport construction in the caller's
 * `deps`: both Pattern-A (fetchproxy bridge) and Pattern-B (direct/bearer) MCPs
 * build their client themselves and pass it through, so neither is coupled in.
 *
 * ## Why {@link runMcp} SERVES rather than connects
 *
 * Under the v2 SDK the protocol era is *instance state*, and only a serving
 * ENTRY — `serveStdio` here, `createMcpHandler` over HTTP — marks an instance
 * modern at construction. A hand-wired
 * `server.connect(new StdioServerTransport())` never marks one, so the
 * instance stays 2025-era and the 2026-era `server/discover` is answered
 * `-32601 Method not found`. That was true of every fleet MCP at once, since
 * all of them boot through here; found by @bschrib in
 * chrischall/skylight-mcp#182 and fixed here rather than in the 60 repos
 * that call `runMcp`.
 * `stdio.test.ts` pins it over a real pipe to a real child process, because an
 * in-memory transport cannot see this class of bug — the broken server answers
 * an `InMemoryTransport` perfectly.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { McpServer, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';
import type { Transport, CallToolResult } from '@modelcontextprotocol/server';
import { McpToolError, redactSecrets } from '../errors/index.js';
import { errorResult } from '../response/index.js';

export * from './confirmation.js';

/**
 * The handle {@link runMcp} returns — re-exported so a caller can name the
 * type without importing the SDK's `/stdio` subpath itself.
 */
export type { StdioServerHandle } from '@modelcontextprotocol/server/stdio';

/**
 * Registers one or more tools onto a fresh {@link McpServer}. `deps` is whatever
 * the caller threaded through {@link createMcpServer} / {@link runMcp} — an API
 * client, a session registry, an app context, or `undefined` for tools (like
 * pure mortgage/affordability calculators) that need no shared state.
 *
 * May be async; {@link createMcpServer} awaits each registrar in order.
 */
export type ToolRegistrar<TDeps = unknown> = (
  server: McpServer,
  deps: TDeps,
) => void | Promise<void>;

/** Protocol revisions supported by servers and the shared test harness. */
export const SERVER_PROTOCOL_VERSIONS = Object.freeze([
  '2026-07-28',
  ...SUPPORTED_PROTOCOL_VERSIONS,
]);

/** Either the literal `'stdio'` (the default) or any SDK {@link Transport}. */
export type TransportSpec = 'stdio' | Transport;

/** Options for {@link createMcpServer}. */
export interface CreateMcpServerOptions<TDeps = unknown> {
  /** Server name advertised to the host (e.g. `'splitwise-mcp'`). */
  name: string;
  /** Server version advertised to the host (the `x-release-please-version`). */
  version: string;
  /** The tool registrars to apply, in order. */
  tools: ToolRegistrar<TDeps>[];
  /**
   * Shared state passed as the second argument to every registrar — the API
   * client, app context, session registry, etc. Build it before calling so the
   * deferred-config-error pattern is preserved. Omit for registrar lists that
   * take no deps.
   */
  deps?: TDeps;
  /** A one-line startup banner written to stderr (never stdout — stdout is the JSON-RPC channel). */
  banner?: string;
  /**
   * Transport hint. Carried for API symmetry with {@link runMcp}; this function
   * never connects or serves, so it only matters that the value is accepted.
   * Defaults to `'stdio'`.
   */
  transport?: TransportSpec;
  /**
   * Append an {@link McpToolError}'s `hint` to the text a failing tool returns.
   * Default `true`. Set `false` only for a server that deliberately wants the
   * bare message.
   */
  surfaceHints?: boolean;
}

/**
 * Turn a thrown value into a tool result carrying its remediation `hint`, or
 * rethrow it untouched.
 *
 * Only {@link McpToolError} with a `hint` is converted. Anything else keeps
 * propagating so a genuine bug still reads as one instead of being flattened
 * into advice.
 */
function hintResultOrRethrow(err: unknown): CallToolResult {
  if (err instanceof McpToolError && err.hint) {
    return errorResult(`${err.message}\n\nHint: ${err.hint}`);
  }
  throw err;
}

/**
 * Wrap `server.registerTool` so every tool handler surfaces its error `hint`.
 *
 * Why this lives here rather than in each repo: the MCP tool boundary renders
 * only a thrown error's `message`. `McpToolError` has carried a `hint` — the
 * actionable half ("the available options are …", "set FOO_API_KEY") — since
 * the beginning, and {@link wrapToolError} is careful to preserve it, but
 * nothing ever rendered it, so every hint thrown from a tool handler was
 * invisible to the caller. Two repos had independently grown the same
 * hand-rolled wrapper before this landed.
 *
 * Handlers are invoked variadically because the SDK passes `(args, extra)` for
 * a tool with an `inputSchema` and `(extra)` for one without; forwarding
 * whatever arrived keeps both shapes intact. Both a synchronous throw and a
 * rejected promise are handled, since a handler may fail either way.
 *
 * Exported so `createTestHarness` can apply the same wrapper: a harness that
 * built a bare `McpServer` would show tests a different error surface than
 * production, which is the one thing a harness must never do.
 */
export function surfaceToolHints(server: McpServer): void {
  const register = server.registerTool.bind(server) as (
    ...args: unknown[]
  ) => unknown;

  // The SDK's `registerTool` is heavily generic over the input/output schemas.
  // Re-expressing those generics here would buy nothing — the wrapper is
  // transparent — so the seam is cast once, here, and nowhere else.
  (server as unknown as { registerTool: unknown }).registerTool = (
    name: unknown,
    config: unknown,
    cb: (...args: unknown[]) => CallToolResult | Promise<CallToolResult>,
  ): unknown =>
    register(name, config, (...args: unknown[]) => {
      let result: CallToolResult | Promise<CallToolResult>;
      try {
        result = cb(...args);
      } catch (err) {
        return hintResultOrRethrow(err);
      }
      return result instanceof Promise ? result.catch(hintResultOrRethrow) : result;
    });
}

/**
 * Build an {@link McpServer}, print the optional stderr banner, and apply every
 * tool registrar (awaiting async ones) — but do **not** serve it. Serving is
 * {@link runMcp}'s job (or the caller's), which keeps this usable from tests
 * and from custom boot sequences.
 *
 * This is the **factory body**, and that is how to hand it to a serving entry:
 * `serveStdio(() => createMcpServer({…}))` over stdio,
 * `createMcpHandler(() => createMcpServer({…}))` over HTTP. Do NOT
 * `server.connect(new StdioServerTransport())` the result — an instance no
 * entry constructed stays 2025-era and answers `server/discover` with
 * `-32601 Method not found` (see this module's header). {@link runMcp} is that
 * wiring for the stdio case.
 */
export async function createMcpServer<TDeps = unknown>(
  opts: CreateMcpServerOptions<TDeps>,
): Promise<McpServer> {
  const server = new McpServer(
    { name: opts.name, version: opts.version },
    { supportedProtocolVersions: [...SERVER_PROTOCOL_VERSIONS] },
  );

  // Before the registrars run, so every tool they register is wrapped.
  if (opts.surfaceHints !== false) surfaceToolHints(server);

  if (opts.banner !== undefined) {
    // stderr only: stdout carries the JSON-RPC frames over stdio transport.
    console.error(opts.banner);
  }

  // `deps` is intentionally cast: when omitted, registrars that declare a deps
  // type are the caller's responsibility (they passed deps if they need it).
  const deps = opts.deps as TDeps;
  for (const register of opts.tools) {
    await register(server, deps);
  }

  return server;
}

/** Signals {@link withGracefulShutdown} listens for. */
export type ShutdownSignal = 'SIGINT' | 'SIGTERM';

/**
 * Anything {@link withGracefulShutdown} can tear down. Both shapes it is handed
 * in practice satisfy it identically: an {@link McpServer}, and the
 * {@link StdioServerHandle} {@link runMcp} returns.
 */
export interface Closeable {
  close(): Promise<void>;
}

/** Options for {@link withGracefulShutdown}. */
export interface GracefulShutdownOptions {
  /**
   * Extra cleanup to run on shutdown, before the server is closed — typically
   * `() => client.close()` to release the fetchproxy WebSocket bridge / direct
   * sockets so ports don't leak between host restarts. Receives the signal that
   * triggered shutdown. Errors are logged, never fatal.
   */
  onSignal?: (signal: ShutdownSignal) => void | Promise<void>;
  /**
   * Call `process.exit(0)` after cleanup completes. Default `true` (matches the
   * fleet's `process.exit(0)`). Set `false` in tests so the process survives.
   */
  exit?: boolean;
}

/**
 * Wire SIGINT/SIGTERM to a one-shot graceful shutdown: run `onSignal` (e.g.
 * close the client/transport), close `target`, then `process.exit(0)` (unless
 * `exit: false`). Idempotent — a second signal mid-shutdown is ignored, and a
 * throwing `onSignal`/`close` is logged but still exits cleanly so a wedged
 * cleanup can't hang the host.
 *
 * `target` is the {@link StdioServerHandle} when called from {@link runMcp} —
 * closing the handle closes whichever instance the connection pinned *and* the
 * transport under it, which is strictly more than closing a server was. A bare
 * {@link McpServer} is still accepted and behaves as before.
 */
export function withGracefulShutdown(
  target: Closeable,
  opts: GracefulShutdownOptions = {},
): void {
  const shouldExit = opts.exit ?? true;
  let shuttingDown = false;

  const handler = (signal: ShutdownSignal): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      try {
        if (opts.onSignal) await opts.onSignal(signal);
        await target.close();
      } catch (err) {
        console.error(
          `[mcp-utils] error during graceful shutdown on ${signal}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } finally {
        if (shouldExit) process.exit(0);
      }
    })();
  };

  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}

/** Options for {@link runMcp} — {@link createMcpServer}'s plus lifecycle wiring. */
export interface RunMcpOptions<TDeps = unknown> extends CreateMcpServerOptions<TDeps> {
  /**
   * Graceful-shutdown wiring. `true` (default) installs SIGINT/SIGTERM handlers
   * that close the {@link StdioServerHandle}. `false` skips them. An object is
   * passed straight to {@link withGracefulShutdown}
   * (e.g. `{ onSignal: () => client.close() }`).
   */
  shutdown?: boolean | GracefulShutdownOptions;
  /**
   * How a 2025-era opening (a claim-less `initialize`, or any claim-less
   * message) is handled. Defaults to `'serve'` — the connection is pinned to a
   * 2025-era instance from the same factory and served exactly as a hand-wired
   * stdio server served it.
   *
   * The default is deliberate and should stay: `'reject'` answers such an
   * opening with the unsupported-protocol-version error, which silently drops
   * every host that has not moved to the 2026 revision. A fleet MCP is reached
   * by hosts we do not control, so the cost of serving an old client is a
   * second instance and the cost of rejecting one is an MCP that looks broken.
   */
  legacy?: 'serve' | 'reject';
  /**
   * Out-of-band errors from the stdio entry — a factory that threw, a wire
   * failure, a malformed opening. Defaults to a one-line stderr log.
   *
   * There is a reason this has a default rather than being optional-and-silent:
   * with the factory model a registrar no longer throws out of `runMcp` (there
   * is no instance until a client connects), so without a sink a boot-time
   * misconfiguration would be invisible on both channels.
   *
   * IT ALSO CHANGES WHAT A BOOT FAILURE LOOKS LIKE, and an operator needs to
   * know which signal to watch. Under the old `await runMcp(...)` a throwing
   * registrar rejected and the process exited non-zero — the host saw "server
   * failed to start". Now the entry catches it, reports here, and KEEPS THE
   * CONNECTION OPEN answering `-32603 Internal server error`, re-running the
   * factory on every request. So a misconfigured server presents as connected
   * and broken rather than as dead, and stderr is the only place that says so.
   * The fleet's deferred-config-error pattern means registrars are not supposed
   * to throw at boot, which is why this is a documented consequence and not a
   * defect — but it is the failure mode to recognise.
   */
  onerror?: (error: Error) => void;
}

/**
 * The whole boot in one call: print the banner, serve stdio through
 * {@link serveStdio} with {@link createMcpServer} as the factory, and install
 * graceful-shutdown handlers. Returns the {@link StdioServerHandle}.
 *
 * Pattern-A and Pattern-B MCPs both build their client/transport in `deps` and
 * pass `onSignal: () => client.close()` via `shutdown`, so this stays agnostic
 * to how creds are resolved.
 *
 * ## What callers must know about the factory
 *
 * The serving entry owns the era decision, so **the registrars run per served
 * instance, not once at boot**: once for a connection, and a second time when
 * a client probes with `server/discover` and then falls back to the 2025-era
 * `initialize` (the probe instance is discarded). Anything expensive or
 * credential-bearing therefore belongs in `deps`, built ONCE before this call,
 * exactly as the deferred-config-error pattern already asks — a lazy
 * `getClient` built outside and threaded through `deps` keeps resolving
 * credentials once, while a client constructed inside a registrar would be
 * rebuilt per instance. Registrars must also be side-effect-free beyond
 * registering (no port binds, no `process.on`).
 *
 * `banner` is printed HERE, once, before anything is served — not inside the
 * factory — so a two-instance connection still logs one line.
 *
 * Returns synchronously: there is no server instance yet to return, which is
 * why the old `Promise<McpServer>` could not be kept honest. `await runMcp(…)`
 * still compiles and still means "boot the server", which is what every fleet
 * consumer writes.
 */
export function runMcp<TDeps = unknown>(opts: RunMcpOptions<TDeps>): StdioServerHandle {
  // Hoisted out of the factory: one boot, one banner, however many instances
  // the connection's opening exchange ends up constructing.
  if (opts.banner !== undefined) {
    // stderr only: stdout carries the JSON-RPC frames over stdio transport.
    console.error(opts.banner);
  }

  const spec: TransportSpec = opts.transport ?? 'stdio';

  const handle = serveStdio(() => createMcpServer({ ...opts, banner: undefined }), {
    legacy: opts.legacy ?? 'serve',
    onerror:
      opts.onerror ??
      ((error: Error) => {
        // Through `redactSecrets` like every other error this package formats.
        // It matters more here than most: this sink is the only channel a
        // boot-time failure has left (the entry no longer lets a throwing
        // registrar exit the process), and the things that throw at boot are
        // exactly the credential-shaped ones — a bad token, a malformed
        // connection string — so the unredacted message is the likeliest to
        // carry a secret into a log an operator then pastes somewhere.
        console.error(`[mcp-utils] stdio server error: ${redactSecrets(error.message)}`);
      }),
    // `'stdio'` means "let the entry make its own StdioServerTransport over
    // this process"; anything else is the caller's transport, which the entry
    // then owns (it starts it, pumps it, and closes it with the handle).
    ...(spec === 'stdio' ? {} : { transport: spec }),
  });

  const shutdown = opts.shutdown ?? true;
  if (shutdown !== false) {
    withGracefulShutdown(handle, shutdown === true ? {} : shutdown);
  }

  return handle;
}
