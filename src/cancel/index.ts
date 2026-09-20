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
export function withCallSignal<T>(signal: AbortSignal | undefined, fn: () => T): T {
  return signal ? storage.run({ signal }, fn) : fn();
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
