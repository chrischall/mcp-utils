import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The caller's cancellation, carried to whatever the tool does — without
 * every tool having to thread it.
 *
 * ## The gap this closes
 *
 * MCP clients cancel. Measured on the mcp-host fleet over the week to
 * 2026-09-20, claude.ai sent `notifications/cancelled` 101 times, and the
 * SDK delivers each one properly: `ctx.mcpReq.signal` is a real
 * `AbortSignal` and it aborts with the caller's reason. Verified against
 * `@modelcontextprotocol/server` 2.0.0 by cancelling a live call —
 * `aborted: true`, reason propagated.
 *
 * And the handler ran to completion anyway, because nothing watched it. That
 * is the whole of the bug: the plumbing is there and unused, so a cancelled
 * call keeps its HTTP request in flight, keeps burning the CPU a hosted
 * child is METERED on, and keeps hitting an upstream that may rate-limit or
 * charge for it. The caller has gone; the work has not.
 *
 * ## Why ambient rather than a parameter
 *
 * The honest alternative is to thread `ctx.mcpReq.signal` from every handler
 * into every call it makes, which across this fleet is several hundred tools
 * — and the ones that would be missed are exactly the ones nobody edits. A
 * store set once, by the wrapper every tool already goes through
 * (`surfaceToolHints`), reaches all of them including the ones written
 * tomorrow.
 *
 * `AsyncLocalStorage` survives `await`, which is what makes this sound: the
 * store set around the handler is still there in a `fetch` three layers
 * down.
 *
 * ## What it deliberately does NOT do
 *
 * It does not cancel anything by itself. It carries a signal; the code that
 * owns an operation decides whether aborting it is safe. `http/index.ts`
 * passes it to `fetch`, which is the case worth having — an in-flight
 * request the caller no longer wants. A tool that must finish what it
 * started (a write it has already committed halfway) should not consult it,
 * and nothing here forces the question.
 */

/** What one tool call carries for as long as it runs. */
interface CallContext {
  signal: AbortSignal;
  /** The SDK request, for progress — absent when the caller supplied none. */
  request?: ProgressCapableRequest;
}

const storage = new AsyncLocalStorage<CallContext>();

/**
 * Run `fn` with `signal` as the ambient cancellation for its whole async
 * extent. Called by `surfaceToolHints` once per tool call.
 *
 * A caller with no signal runs `fn` unwrapped rather than storing
 * `undefined`: an empty store and no store are the same answer to
 * {@link currentCallSignal}, and not entering the context at all is cheaper
 * and easier to reason about.
 */
export function withCallSignal<T>(
  signal: AbortSignal | undefined,
  fn: () => T,
  request?: ProgressCapableRequest,
): T {
  return signal ? storage.run({ signal, ...(request ? { request } : {}) }, fn) : fn();
}

/**
 * The cancellation for the tool call currently running, or `undefined`
 * outside one.
 *
 * Undefined is the ordinary answer in a unit test, in a CLI, and anywhere a
 * helper is used off the tool path — so every consumer has to treat it as
 * "no cancellation" rather than as an error.
 */
export function currentCallSignal(): AbortSignal | undefined {
  return storage.getStore()?.signal;
}

/**
 * Combine the ambient cancellation with a signal of the caller's own.
 *
 * Returns whichever is meaningful, or one that fires when EITHER does. The
 * common shape in this package is a timeout controller that now also has to
 * honour the caller (`http/index.ts`), and `AbortSignal.any` is what makes
 * "first to fire wins" true without either owner knowing about the other.
 */
export function withAmbientCancellation(own: AbortSignal | undefined): AbortSignal | undefined {
  const ambient = currentCallSignal();
  if (!ambient) return own;
  if (!own) return ambient;
  return AbortSignal.any([own, ambient]);
}

/** The part of a spawned child {@link killOnCancel} needs. */
interface Killable {
  kill(signal?: NodeJS.Signals | number): boolean;
}

/**
 * Kill a spawned child when the caller cancels, and stop listening when it
 * ends.
 *
 * The SUBPROCESS case, which is the expensive one and is not covered by
 * passing a signal to `fetch`. A tool that shells out holds a whole process
 * — `gogcli-mcp` runs the `gog` binary this way — so a cancelled call leaves
 * that process running to its own timeout, still talking to the upstream,
 * still charged to the child's metered CPU. Aborting an HTTP request does
 * nothing about it.
 *
 * Returns a disposer the caller MUST run when the child settles. Without it
 * the listener outlives the call, and on a long-lived signal that is a leak
 * per invocation — the reason this hands back a function rather than
 * attaching and hoping.
 *
 * SIGTERM by default: a child gets the chance to exit cleanly, as the
 * supervisor gives its own children. A caller that knows better passes
 * something else.
 */
export function killOnCancel(child: Killable, signal: NodeJS.Signals = 'SIGTERM'): () => void {
  const ambient = currentCallSignal();
  if (!ambient) return () => {};
  // Already gone by the time the child started, which a slow install or a
  // queued spawn makes ordinary rather than theoretical.
  if (ambient.aborted) {
    child.kill(signal);
    return () => {};
  }
  const onAbort = (): void => {
    child.kill(signal);
  };
  ambient.addEventListener('abort', onAbort, { once: true });
  return () => ambient.removeEventListener('abort', onAbort);
}

/**
 * Throw if the caller has gone, for a tool doing its own long work.
 *
 * The `fetch` path needs nothing (it takes the signal directly); this is for
 * a loop — paging an API, walking a tree — where the only way to notice is
 * to ask. Throws the signal's own `reason`, so the error a caller would have
 * seen is the error that propagates.
 */
export function throwIfCancelled(): void {
  const signal = currentCallSignal();
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason));
}

/** The part of the SDK's request context progress needs. */
interface ProgressCapableRequest {
  _meta?: { progressToken?: string | number };
  notify(notification: { method: string; params: Record<string, unknown> }): Promise<void> | void;
}

/**
 * Tell the caller how far along a long tool call is.
 *
 * MEASURED SUPPORT, which is why this exists at all: on the mcp-host fleet
 * claude.ai sends `_meta.progressToken` on its `tools/call` requests
 * (recorded as `meta.progressToken` on the usage row, 2026-09-20), so
 * progress a hosted MCP reports genuinely reaches it. Without a token
 * nothing can be delivered and this is a no-op — which is the ordinary case
 * for a client that did not ask.
 *
 * THREE THINGS ARE EASY TO GET WRONG HERE, and all three were, against
 * `@modelcontextprotocol/server` 2.0.0, before this was written:
 *
 *  1. `notify` takes a NOTIFICATION OBJECT, not `(method, params)`. Passed a
 *     string it spreads it character by character and puts
 *     `{"0":"n","1":"o",…}` on the wire — a frame the peer answers with
 *     `Unknown message type`. It does not throw, so the mistake is invisible
 *     from the server.
 *  2. The caller's token is at `_meta`, NOT `meta`. Reading `meta` yields
 *     `undefined`, and the notification then goes out WITHOUT a
 *     `progressToken` — well-formed, accepted, and dropped by the client
 *     with "progress notification for an unknown token", because the client
 *     routes on that field alone.
 *  3. Neither mistake throws. A tool reporting progress into the void looks
 *     exactly like one reporting progress correctly, from the server's side.
 *
 * AMBIENT, like the cancellation above and for the same reason: the token
 * belongs to the request, `surfaceToolHints` already has it, and threading a
 * reporter through several hundred tools is how most of them end up without
 * one.
 */
export async function reportProgress(progress: number, total?: number, message?: string): Promise<void> {
  const req = storage.getStore()?.request;
  const token = req?._meta?.progressToken;
  // No token means the caller did not ask for progress, which is the
  // ordinary case and not a failure.
  if (req === undefined || token === undefined) return;
  await req.notify({
    method: 'notifications/progress',
    params: {
      progressToken: token,
      progress,
      ...(total === undefined ? {} : { total }),
      ...(message === undefined ? {} : { message }),
    },
  });
}

/** Whether this caller asked for progress — for skipping work nobody will see. */
export function callerWantsProgress(): boolean {
  return storage.getStore()?.request?._meta?.progressToken !== undefined;
}
