/**
 * The fleet's env layer over the confirm-token fallback: the three variables
 * every server documents identically, read in one place so 30 servers cannot
 * spell or interpret them 30 ways.
 *
 * | variable | default | |
 * |---|---|---|
 * | `MCP_CONFIRM_MODE` | `ask-user` | what a gated write does on a client that CANNOT show a confirmation prompt |
 * | `MCP_CONFIRM_ELICITATION` | `on` | `off` never sends a prompt: every client gets the `MCP_CONFIRM_MODE` path |
 * | `MCP_CONFIRM_TTL_SECONDS` | `600` | how long a token stays valid; unparseable → `refuse` + a stderr warning |
 * | `MCP_CONFIRM_SECRET` | random per process | HMAC key; set only if tokens must survive a restart |
 * | `MCP_HOST_CONFIRM_SECRET` | unset | the same, set by a HOST (mcp-host); honoured only beside an absolute `MCP_DATA_DIR` |
 *
 * Whenever the key is stable (either secret) and `MCP_DATA_DIR` is absolute,
 * spent tokens are recorded under `$MCP_DATA_DIR/.mcp-confirm/spent`
 * ({@link createFileSpentTokenStore}), so a restart cannot re-accept one
 * within its TTL. The host's secret has a name of its own so that a child on an
 * mcp-utils that predates the durable store ignores it — keeping its random,
 * restart-invalidated key — rather than pairing a stable key with an in-memory
 * store, and it is ignored without a data dir for the same reason.
 *
 * `MCP_CONFIRM_MODE`:
 * - `ask-user`: two steps. Phase 1 returns the preview and a token and tells the
 *   model to show it to the user and continue only after they approve in chat.
 * - `auto`: the same two steps, but the model may use the token itself after
 *   reviewing the preview. The token still forces a preview first, binds the
 *   exact arguments and is single-use — strictly more than `confirm: true`.
 * - `refuse`: no fallback; the write is refused on such clients.
 * A client that CAN be prompted always gets the real prompt, whatever the mode.
 * An unrecognised value fails CLOSED to `refuse` (fleet convention: a typo must
 * not widen what the server will do), with a warning on stderr.
 *
 * `MCP_CONFIRM_ELICITATION=off` is for a client that DECLARES elicitation but
 * never shows the prompt, so a gated call hangs (opencode 2.0.x files it under a
 * session no view renders). The server cannot tell such a client from one that
 * works, so the operator says so per server. An unrecognised value stays `on` —
 * the prompt is the stronger confirmation, so a typo must not trade it away —
 * with a warning on stderr.
 *
 * The confirm-token module itself stays env-free; this is the opt-in layer a
 * server uses when it wants the fleet defaults.
 */
import { createHash, randomBytes } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { readEnvVar, type EnvSource } from '../config/index.js';
import { createFileSpentTokenStore } from './confirm-spent-file.js';
import type { RequireConfirmationOptions } from './confirmation.js';
import {
  CONFIRM_TOKEN_INSTRUCTION,
  type ConfirmTokenFallback,
  type RequireConfirmationWithFallbackOptions,
  type SpentTokenStore,
} from './confirm-token.js';

/** See the module header. */
export type ConfirmMode = 'ask-user' | 'auto' | 'refuse';

const MODES: ReadonlySet<string> = new Set<ConfirmMode>(['ask-user', 'auto', 'refuse']);
const DEFAULT_TTL_SECONDS = 600;
const warned = new Set<string>();

/** `MCP_CONFIRM_MODE`, defaulting to `ask-user`; an unrecognised value is `refuse`. */
export function readConfirmMode(env: EnvSource = process.env): ConfirmMode {
  const raw = readEnvVar('MCP_CONFIRM_MODE', { env })?.trim().toLowerCase();
  if (!raw) return 'ask-user';
  if (MODES.has(raw)) return raw as ConfirmMode;
  if (!warned.has(raw)) {
    warned.add(raw);
    process.stderr.write(
      `MCP_CONFIRM_MODE="${raw}" is not one of ask-user, auto, refuse; treating it as refuse.\n`,
    );
  }
  return 'refuse';
}

/** `MCP_CONFIRM_ELICITATION`, defaulting to `on`; an unrecognised value is `on`. */
export function readConfirmElicitation(env: EnvSource = process.env): 'on' | 'off' {
  const raw = readEnvVar('MCP_CONFIRM_ELICITATION', { env })?.trim().toLowerCase();
  if (!raw || raw === 'on') return 'on';
  if (raw === 'off') return 'off';
  const key = `elicitation:${raw}`;
  if (!warned.has(key)) {
    warned.add(key);
    process.stderr.write(`MCP_CONFIRM_ELICITATION="${raw}" is not one of on, off; treating it as on.\n`);
  }
  return 'on';
}

/**
 * `MCP_CONFIRM_TTL_SECONDS`: absent → the default; a positive integer → that;
 * anything else → `undefined`, with a once-per-value stderr warning. Invalid
 * is NOT silently the default: an operator who typed `60s` for a payment tool
 * must not get a 10-minute token window without knowing (fleet audit
 * 2026-09-24 BUG-1).
 */
function readConfirmTtl(env: EnvSource): number | undefined {
  const raw = readEnvVar('MCP_CONFIRM_TTL_SECONDS', { env })?.trim();
  if (!raw) return DEFAULT_TTL_SECONDS;
  if (/^[1-9]\d*$/.test(raw)) return Number(raw);
  const key = `ttl:${raw}`;
  if (!warned.has(key)) {
    warned.add(key);
    process.stderr.write(
      `MCP_CONFIRM_TTL_SECONDS="${raw}" is not a positive whole number of seconds; `
      + 'gated writes will refuse on clients that cannot show a confirmation prompt until it is fixed.\n',
    );
  }
  return undefined;
}

/**
 * `MCP_CONFIRM_TTL_SECONDS` as a positive integer, else 600. An unparseable
 * value warns once on stderr, and {@link confirmationFromEnv} treats it as
 * `refuse` (fail closed, like an unrecognised `MCP_CONFIRM_MODE`).
 */
export function confirmTtlFromEnv(env: EnvSource = process.env): number {
  return readConfirmTtl(env) ?? DEFAULT_TTL_SECONDS;
}

let processKey: Uint8Array | undefined;

/** `MCP_DATA_DIR` when it names an absolute directory; a relative one is the process cwd's, not durable. */
function durableDataDir(env: EnvSource): string | undefined {
  const dir = readEnvVar('MCP_DATA_DIR', { env });
  return dir && isAbsolute(dir) ? dir : undefined;
}

/** The stable secret in force, if any: the operator's, else the host's when spends can be recorded. */
function stableSecret(env: EnvSource): string | undefined {
  return readEnvVar('MCP_CONFIRM_SECRET', { env })
    ?? (durableDataDir(env) ? readEnvVar('MCP_HOST_CONFIRM_SECRET', { env }) : undefined);
}

/**
 * The HMAC key: `MCP_CONFIRM_SECRET` — else `MCP_HOST_CONFIRM_SECRET`, but only
 * beside an absolute `MCP_DATA_DIR` — of any length stretched through SHA-256 to
 * the 32 bytes the token functions require, or 32 random bytes fixed for the
 * life of the process (so a restart invalidates every outstanding token).
 */
export function confirmKeyFromEnv(env: EnvSource = process.env): Uint8Array {
  const secret = stableSecret(env);
  if (secret) return createHash('sha256').update(secret, 'utf8').digest();
  processKey ??= randomBytes(32);
  return processKey;
}

const fileStores = new Map<string, SpentTokenStore>();

/**
 * Where {@link confirmationFromEnv} records spent tokens by default: a
 * {@link createFileSpentTokenStore} under `$MCP_DATA_DIR/.mcp-confirm/spent`
 * when the key is stable and the data dir is absolute, else `undefined` (the
 * process-wide in-memory store — enough for a random key, whose tokens cannot
 * outlive the process; with an operator's secret and no data dir, a restart can
 * re-accept a spent token until it expires).
 */
export function spentTokenStoreFromEnv(env: EnvSource = process.env): SpentTokenStore | undefined {
  const dataDir = durableDataDir(env);
  if (!dataDir || !stableSecret(env)) return undefined;
  const dir = join(dataDir, '.mcp-confirm', 'spent');
  let store = fileStores.get(dir);
  if (!store) {
    store = createFileSpentTokenStore(dir);
    fileStores.set(dir, store);
  }
  return store;
}

/** Phase 1's instruction under `MCP_CONFIRM_MODE=auto`. */
export const CONFIRM_TOKEN_AUTO_INSTRUCTION =
  'Nothing has been done yet. Review this preview; if it is what was intended, call again with the same arguments '
  + 'plus confirmToken. (This server runs with MCP_CONFIRM_MODE=auto, so the user\'s approval in chat is not required.)';

const REFUSE_HINT = 'Set MCP_CONFIRM_MODE=ask-user on the server to allow two-step confirmation instead.';
const ELICITATION_OFF_HINT = 'MCP_CONFIRM_ELICITATION=off on the server turns confirmation prompts off.';
const BAD_TTL_HINT = 'MCP_CONFIRM_TTL_SECONDS on the server is not a positive whole number of seconds; fix it to allow '
  + 'two-step confirmation.';

/** The arguments a binding commits to: the tool's input minus the token itself (it differs between phases). */
function boundArgs(args: unknown): unknown {
  if (args === null || typeof args !== 'object' || Array.isArray(args) || !('confirmToken' in args)) return args;
  const { confirmToken, ...rest } = args as Record<string, unknown>;
  void confirmToken;
  return rest;
}

/** {@link confirmationFromEnv}'s input: the confirmation options plus what the token binds. */
export interface ConfirmationFromEnvOptions extends RequireConfirmationOptions {
  /** The tool name the token is bound to. */
  tool: string;
  /**
   * The account / principal the action runs as — bound into BOTH rails (the
   * token's claims and the elicitation acceptance), so an approval for one
   * account never acts as another. REQUIRED as a key since 3.0: pass
   * `undefined` explicitly on a single-account server, as with `confirmWrite`.
   */
  account: string | undefined;
  /** The phase-2 token from the tool's input, or undefined on phase 1. */
  confirmToken?: string;
  /** Builds the subject from a FRESH read; see {@link ConfirmTokenFallback.subject}. */
  subject: ConfirmTokenFallback['subject'];
  /** Phase 1's instruction in `ask-user` mode; defaults to {@link CONFIRM_TOKEN_INSTRUCTION}. */
  instruction?: string;
  /** Spent-token store; defaults to {@link spentTokenStoreFromEnv}, else the process-wide one. */
  spent?: SpentTokenStore;
  /** Environment to read; defaults to `process.env`. */
  env?: EnvSource;
  /**
   * The tool's validated arguments — REQUIRED since 3.0 (`undefined`/`null`
   * throws). Both rails are bound to them without per-tool judgement (fleet
   * audit 2026-09-24 SEC-2; fleet-audit#979 and siblings were all a token
   * minted without them).
   * - Elicitation: sets {@link RequireConfirmationOptions.binding} (unless one
   *   is given) to `{ account, args }` with the env key and TTL, so an
   *   acceptance minted for one call cannot be replayed on a call with
   *   different arguments or as a different account.
   * - Token: the token binds `{ payload: subject().payload, args }`, so a
   *   `subject()` whose payload covers only some arguments (say `{ id }` while
   *   the body is a separate argument) still cannot authorise a different body.
   * A `confirmToken` key is dropped first: it differs between the two phases.
   * A tool with no arguments passes `{}`.
   */
  args: object;
}

/**
 * Turn the fleet env settings into {@link requireConfirmationWithFallback}
 * options:
 *
 * ```ts
 * const gate = await requireConfirmationWithFallback(ctx, confirmationFromEnv({
 *   action: 'thing.delete', message: 'Review and confirm this deletion.', details: { id },
 *   tool: 'thing_delete', account: undefined, confirmToken, args,
 *   subject: () => ({ target: id, payload: { id }, preview: { id } }),
 * }));
 * if (gate) return gate;
 * ```
 */
export function confirmationFromEnv(options: ConfirmationFromEnvOptions): RequireConfirmationWithFallbackOptions {
  const { tool, account, confirmToken, subject, instruction, args, env = process.env, spent: callerSpent, ...rest } = options;
  if (args === undefined || args === null) {
    // A token over the subject alone authorises whatever the subject omits, and
    // an unbound acceptance authorises anything (fleet-audit#979 and siblings).
    throw new TypeError(
      `confirmationFromEnv: ${tool} passed no args; pass the tool's validated arguments ({} for a tool with none).`,
    );
  }
  // Destructured out of `rest` so it rides the token fallback only, never the
  // returned options (#312).
  const spent = callerSpent ?? spentTokenStoreFromEnv(env);
  const mode = readConfirmMode(env);
  const ttlSeconds = readConfirmTtl(env);
  const elicitationOff = readConfirmElicitation(env) === 'off';
  const bound = boundArgs(args);
  // The elicitation acceptance commits to the account as well as the
  // arguments; the token already carries the account in its own claims.
  const elicitationBound = account === undefined ? { args: bound } : { account, args: bound };
  const bindingAdded: RequireConfirmationOptions = rest.binding
    ? rest
    : {
      ...rest,
      binding: { key: confirmKeyFromEnv(env), args: elicitationBound, ttlSeconds: ttlSeconds ?? DEFAULT_TTL_SECONDS },
    };
  const confirmation: RequireConfirmationOptions = elicitationOff ? { ...bindingAdded, elicitation: false } : bindingAdded;
  if (mode === 'refuse' || ttlSeconds === undefined) {
    const reason = mode === 'refuse' ? REFUSE_HINT : BAD_TTL_HINT;
    const hint = elicitationOff ? `${ELICITATION_OFF_HINT} ${reason}` : reason;
    return {
      ...confirmation,
      unsupportedNote: confirmation.unsupportedNote ? `${confirmation.unsupportedNote} ${hint}` : hint,
    };
  }
  const boundSubject: ConfirmTokenFallback['subject'] = async () => {
    const read = await subject();
    // A CallToolResult (a failed read) passes back unchanged.
    if ('content' in read) return read;
    return { ...read, payload: { payload: read.payload, args: bound } };
  };
  return {
    ...confirmation,
    tokenFallback: {
      key: confirmKeyFromEnv(env),
      tool,
      ...(account === undefined ? {} : { account }),
      ...(confirmToken === undefined ? {} : { confirmToken }),
      subject: boundSubject,
      ttlSeconds,
      instruction: mode === 'auto' ? CONFIRM_TOKEN_AUTO_INSTRUCTION : (instruction ?? CONFIRM_TOKEN_INSTRUCTION),
      ...(spent === undefined ? {} : { spent }),
    },
  };
}
