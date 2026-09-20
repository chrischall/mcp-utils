import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What the CALLER can do, made readable from inside a tool handler.
 *
 * ## The gap this closes
 *
 * A confirmation-guarded tool returns `input_required`, and the SDK refuses
 * to send it to a client that did not declare `elicitation` — a protocol
 * error (`-32021`) raised AFTER the handler returned, so the handler cannot
 * catch it and the caller is told nothing useful. Measured on the mcp-host
 * fleet 2026-09-20: claude.ai declares `{"extensions": {…}}` and no
 * `elicitation`, so `gog_gmail_forward` answered four attempts in a row with
 * an opaque "Error occurred during tool execution" in 69–107 ms, having never
 * run. The only way out is for the handler to know BEFORE it returns.
 *
 * ## Where the answer lives, and why it takes two sources
 *
 * On protocol revision 2026-07-28 each request carries its own `_meta`
 * envelope, so the caller's capabilities are on `ctx.mcpReq.envelope` — and
 * that is the era the mcp-host relay uses, forwarding the real caller's
 * declaration rather than the connection's. On a 2025-era connection there is
 * no envelope: the capabilities were declared once at `initialize` and only
 * the underlying {@link Server} holds them. `surfaceToolHints` is the one
 * wrapper every tool already passes through AND the one place with a
 * reference to that server, so it reads the second source and stores it here.
 *
 * ## What it deliberately does NOT do
 *
 * It answers `undefined` — never "no" — when neither source is available.
 * A missing answer is not a negative one, and treating it as one would refuse
 * every caller this cannot see, which includes any handler registered outside
 * `surfaceToolHints`. Absence is never a verdict.
 */

/** The capability map a client declares, as far as this module cares about it. */
export interface CallerCapabilities {
  readonly elicitation?: Record<string, unknown>;
  readonly [key: string]: unknown;
}

const storage = new AsyncLocalStorage<CallerCapabilities>();

/**
 * Run `fn` with `capabilities` as the ambient caller declaration for its whole
 * async extent. Called by `surfaceToolHints` once per tool call.
 *
 * A caller whose capabilities could not be resolved runs `fn` unwrapped rather
 * than storing `undefined`: an empty store and no store are the same answer to
 * {@link currentCallerCapabilities}.
 */
export function withCallerCapabilities<T>(
  capabilities: CallerCapabilities | undefined,
  fn: () => T,
): T {
  return capabilities ? storage.run(capabilities, fn) : fn();
}

/** The ambient caller capabilities, or `undefined` outside a wrapped tool call. */
export function currentCallerCapabilities(): CallerCapabilities | undefined {
  return storage.getStore();
}

/** The envelope key the 2026-07-28 revision carries a caller's capabilities under. */
const ENVELOPE_CAPABILITIES_KEY = 'io.modelcontextprotocol/clientCapabilities';

/** The elicitation modes the spec defines; anything else is not a mode. */
const ELICITATION_MODES = ['form', 'url'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The caller's declared capabilities for THIS call: the request's own envelope
 * when the era carries one, else whatever `surfaceToolHints` stored.
 *
 * The envelope wins because it is per request. On the 2026-07-28 era a relay
 * forwards the real caller's declaration with every call, so two callers on
 * one connection can differ — and the ambient value, resolved once from the
 * connection, would answer about the wrong one.
 */
export function callerCapabilities(ctx: unknown): CallerCapabilities | undefined {
  const envelope = isRecord(ctx) && isRecord(ctx.mcpReq) ? ctx.mcpReq.envelope : undefined;
  if (isRecord(envelope)) {
    const declared = envelope[ENVELOPE_CAPABILITIES_KEY];
    if (isRecord(declared)) return declared;
  }
  return currentCallerCapabilities();
}

/**
 * Whether this caller can be shown a FORM elicitation — the shape every
 * {@link requireConfirmation} prompt uses.
 *
 * `undefined` means "cannot tell", which callers must not read as `false`.
 *
 * Mirrors the SDK's own gate, verified against `@modelcontextprotocol/server`
 * 2.0.0 by driving all four shapes through a real client: `elicitation` absent
 * refuses; `{url: {}}` refuses (a URL elicitation cannot carry a schema);
 * `{form: {}}` passes; and `{}` — modes not enumerated — PASSES, because a
 * client that named no mode is not a client that excluded this one.
 */
export function callerAcceptsFormElicitation(ctx: unknown): boolean | undefined {
  const capabilities = callerCapabilities(ctx);
  if (!capabilities) return undefined;
  const elicitation = capabilities.elicitation;
  if (!isRecord(elicitation)) return false;
  const namedModes = ELICITATION_MODES.filter((mode) => mode in elicitation);
  return namedModes.length === 0 || namedModes.includes('form');
}
