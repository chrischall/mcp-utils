/**
 * Pending calls: the arguments of a gated call that returned a phase-1
 * preview, kept server-side so phase 2 can be the token alone.
 *
 * The token rail (`confirm-token.ts`) always meant "call again with the SAME
 * arguments plus confirmToken". For a write carrying a file — splitwise-mcp's
 * receipt upload takes up to 10 MiB as base64 — that put the file through the
 * model's context twice, and a single dropped character in the copy was a
 * `DRAFT_CHANGED`. With a confirm tool registered ({@link registerConfirmTool}
 * in `confirm-replay.ts`), phase 1 also records `{tool, args}` here under the
 * token it issued, and `<prefix>_confirm({confirmToken})` replays the call.
 *
 * This store is a CACHE, never an authority. The replayed handler runs its own
 * gate, which verifies the token exactly as before — tool, account, target,
 * revision, payload hash, expiry, single use — so a forged, expired or spent
 * token fails there whatever this store holds. And losing an entry (restart,
 * eviction, a different machine) costs only convenience: the full-arguments
 * path still works. That is why it lives in memory, with no file store: keeping
 * arguments on disk would put users' files (receipts) at rest under the data
 * dir — and, on mcp-host, in its snapshots — for a convenience.
 *
 * What it does add is a bearer capability: while an entry lives, its token
 * alone can act. Entries are therefore scoped to the principal that created
 * them ({@link ConfirmToolOptions.principalScope}), held only until the token
 * would expire, and removed by the first replay.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { McpServer } from '@modelcontextprotocol/server';

/** One gated call that returned a phase-1 preview. */
export interface PendingCall {
  /** The REGISTERED tool name the arguments belong to. */
  tool: string;
  /** The validated arguments the handler received, minus `confirmToken`. */
  args: Record<string, unknown>;
  /** The principal that made the call (`''` when the server has one). */
  scope: string;
  /** Epoch ms after which the token is dead, and so is this entry. */
  expiresAt: number;
}

/** Arguments held for phase 2, keyed by the token phase 1 issued. */
export interface PendingCallStore {
  /** Keep `call` under `token`; `false` when it is too large to hold. */
  put(token: string, call: PendingCall): boolean;
  get(token: string): PendingCall | undefined;
  /** Get and remove, so two concurrent confirms cannot both replay. */
  take(token: string): PendingCall | undefined;
  clear(): void;
  readonly size: number;
  readonly bytes: number;
}

/** Bounds for {@link createPendingCallStore}. */
export interface PendingCallStoreOptions {
  /** The largest single entry held, as JSON bytes. Default 16 MiB — a 10 MiB file as base64, with room. */
  maxEntryBytes?: number;
  /** All entries together. Default 64 MiB; the oldest go first. */
  maxBytes?: number;
  /** Default 64; the oldest go first. */
  maxEntries?: number;
}

const MiB = 1024 * 1024;

/**
 * An in-memory {@link PendingCallStore}: least-recently-stored first out,
 * expired entries dropped on every access.
 */
export function createPendingCallStore(options: PendingCallStoreOptions = {}): PendingCallStore {
  const maxEntryBytes = options.maxEntryBytes ?? 16 * MiB;
  const maxBytes = options.maxBytes ?? 64 * MiB;
  const maxEntries = options.maxEntries ?? 64;
  const entries = new Map<string, { call: PendingCall; bytes: number }>();
  let total = 0;

  const remove = (token: string) => {
    const entry = entries.get(token);
    if (!entry) return;
    entries.delete(token);
    total -= entry.bytes;
  };
  const prune = (now: number) => {
    for (const [token, { call }] of entries) if (call.expiresAt < now) remove(token);
  };

  return {
    put(token, call) {
      prune(Date.now());
      const bytes = Buffer.byteLength(JSON.stringify(call.args) ?? '', 'utf8') + Buffer.byteLength(token, 'utf8');
      if (bytes > maxEntryBytes || bytes > maxBytes) return false;
      remove(token);
      // Map iteration is insertion order: the first key is the oldest.
      while (entries.size >= maxEntries || total + bytes > maxBytes) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        remove(oldest);
      }
      entries.set(token, { call, bytes });
      total += bytes;
      return true;
    },
    get(token) {
      prune(Date.now());
      return entries.get(token)?.call;
    },
    take(token) {
      prune(Date.now());
      const call = entries.get(token)?.call;
      remove(token);
      return call;
    },
    clear() {
      entries.clear();
      total = 0;
    },
    get size() {
      return entries.size;
    },
    get bytes() {
      return total;
    },
  };
}

// Process-wide, like the spent-token store: `runMcp` builds a server instance
// per connection (and a discarded one for a `server/discover` probe), and a
// phase-1 call on one instance must be confirmable on the next.
const PROCESS_PENDING = createPendingCallStore();

/** The process-wide {@link PendingCallStore} confirm tools use by default. */
export function processPendingCalls(): PendingCallStore {
  return PROCESS_PENDING;
}

/** Options for {@link registerConfirmTool}. */
export interface ConfirmToolOptions {
  /** The tool's name, `<prefix>_confirm` by fleet convention (e.g. `sw_confirm`). */
  name: string;
  /** Replaces the default description (search finds the tool by it, so keep "confirmToken" in it). */
  description?: string;
  /**
   * Who is calling, when one process serves several principals. Entries are
   * replayed only for the principal that created them. Omit on a server with
   * one credential (every stdio child on mcp-host is one principal).
   */
  principalScope?: () => string | undefined;
  /** Where arguments are kept; default {@link processPendingCalls}. */
  store?: PendingCallStore;
}

type Handler = (...args: unknown[]) => unknown;

/** Per server instance: its tools' wrapped handlers, and its confirm tool if any. */
const handlers = new WeakMap<McpServer, Map<string, Handler>>();
const confirmTools = new WeakMap<McpServer, ConfirmToolOptions & { store: PendingCallStore }>();

/** @internal Record a registered tool's (wrapped) handler; `surfaceToolHints` calls this. */
export function rememberToolHandler(server: McpServer, name: string, handler: Handler): void {
  let map = handlers.get(server);
  if (!map) handlers.set(server, (map = new Map()));
  map.set(name, handler);
}

/** @internal The wrapped handler registered as `name` on `server`. */
export function toolHandler(server: McpServer, name: string): Handler | undefined {
  return handlers.get(server)?.get(name);
}

/** @internal Turn pending calls on for `server`. */
export function setConfirmTool(server: McpServer, options: ConfirmToolOptions & { store: PendingCallStore }): void {
  confirmTools.set(server, options);
}

/** @internal The current principal on `server`'s confirm tool. */
export function currentScope(options: ConfirmToolOptions): string {
  return options.principalScope?.() ?? '';
}

interface CallFrame {
  server: McpServer;
  tool: string;
  args: unknown;
}

const frames = new AsyncLocalStorage<CallFrame>();

/** @internal Run a tool handler with its call ambient, so a gate inside it can record the arguments. */
export function withToolCall<T>(frame: CallFrame, fn: () => T): T {
  return frames.run(frame, fn);
}

function withoutConfirmToken(args: unknown): Record<string, unknown> | undefined {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const { confirmToken, ...rest } = args as Record<string, unknown>;
  void confirmToken;
  return rest;
}

/**
 * Called by the token rail as it issues a phase-1 token: if the current tool
 * call's server has a confirm tool, keep the call's arguments under `token`
 * and return the confirm tool's name for the result to point at. `undefined`
 * — no confirm tool, no tool call in scope, or arguments too large — leaves
 * phase 1 exactly as it always was.
 */
export function recordPendingCall(token: string, expiresAt: number): string | undefined {
  const frame = frames.getStore();
  if (!frame) return undefined;
  const confirm = confirmTools.get(frame.server);
  if (!confirm || frame.tool === confirm.name) return undefined;
  const args = withoutConfirmToken(frame.args);
  if (!args) return undefined;
  const stored = confirm.store.put(token, { tool: frame.tool, args, scope: currentScope(confirm), expiresAt });
  return stored ? confirm.name : undefined;
}
