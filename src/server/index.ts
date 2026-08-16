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
 *  - {@link runMcp} — bootstrap + banner + connect + shutdown, the whole boot.
 *
 * It is deliberately transport- and domain-agnostic. The
 * deferred-config-error pattern (server boots before creds exist, so the host's
 * initial `tools/list` always succeeds and the first tool call surfaces the auth
 * error) is preserved by keeping client/transport construction in the caller's
 * `deps`: both Pattern-A (fetchproxy bridge) and Pattern-B (direct/bearer) MCPs
 * build their client themselves and pass it through, so neither is coupled in.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpToolError } from '../errors/index.js';
import { errorResult } from '../response/index.js';

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
   * never connects, so it only matters that the value is accepted. Defaults to
   * `'stdio'`.
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
 * tool registrar (awaiting async ones) — but do **not** connect a transport.
 * Connecting is {@link runMcp}'s job (or the caller's), which keeps this usable
 * from tests and from custom boot sequences.
 */
export async function createMcpServer<TDeps = unknown>(
  opts: CreateMcpServerOptions<TDeps>,
): Promise<McpServer> {
  const server = new McpServer({ name: opts.name, version: opts.version });

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
 * close the client/transport), close the server, then `process.exit(0)` (unless
 * `exit: false`). Idempotent — a second signal mid-shutdown is ignored, and a
 * throwing `onSignal`/`close` is logged but still exits cleanly so a wedged
 * cleanup can't hang the host.
 */
export function withGracefulShutdown(
  server: Pick<McpServer, 'close'>,
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
        await server.close();
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
   * that close the server. `false` skips them. An object is passed straight to
   * {@link withGracefulShutdown} (e.g. `{ onSignal: () => client.close() }`).
   */
  shutdown?: boolean | GracefulShutdownOptions;
}

/**
 * The whole boot in one call: build the server, apply registrars, print the
 * banner, install graceful-shutdown handlers, and connect the transport
 * (defaulting to a {@link StdioServerTransport}). Returns the connected server.
 *
 * Pattern-A and Pattern-B MCPs both build their client/transport in `deps` and
 * pass `onSignal: () => client.close()` via `shutdown`, so this stays agnostic
 * to how creds are resolved.
 */
export async function runMcp<TDeps = unknown>(
  opts: RunMcpOptions<TDeps>,
): Promise<McpServer> {
  const server = await createMcpServer(opts);

  const shutdown = opts.shutdown ?? true;
  if (shutdown !== false) {
    withGracefulShutdown(server, shutdown === true ? {} : shutdown);
  }

  const spec: TransportSpec = opts.transport ?? 'stdio';
  const transport: Transport = spec === 'stdio' ? new StdioServerTransport() : spec;
  await server.connect(transport);

  return server;
}
