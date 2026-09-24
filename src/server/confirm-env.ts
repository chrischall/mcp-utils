/**
 * The fleet's env layer over the confirm-token fallback: the three variables
 * every server documents identically, read in one place so 30 servers cannot
 * spell or interpret them 30 ways.
 *
 * | variable | default | |
 * |---|---|---|
 * | `MCP_CONFIRM_MODE` | `ask-user` | what a gated write does on a client that CANNOT show a confirmation prompt |
 * | `MCP_CONFIRM_TTL_SECONDS` | `600` | how long a token stays valid; unparseable → `refuse` + a stderr warning |
 * | `MCP_CONFIRM_SECRET` | random per process | HMAC key; set only if tokens must survive a restart |
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
 * The confirm-token module itself stays env-free; this is the opt-in layer a
 * server uses when it wants the fleet defaults.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readEnvVar, type EnvSource } from '../config/index.js';
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

/**
 * The HMAC key: `MCP_CONFIRM_SECRET` of any length stretched through SHA-256 to
 * the 32 bytes the token functions require, or 32 random bytes fixed for the
 * life of the process (so a restart invalidates every outstanding token).
 */
export function confirmKeyFromEnv(env: EnvSource = process.env): Uint8Array {
  const secret = readEnvVar('MCP_CONFIRM_SECRET', { env });
  if (secret) return createHash('sha256').update(secret, 'utf8').digest();
  processKey ??= randomBytes(32);
  return processKey;
}

/** Phase 1's instruction under `MCP_CONFIRM_MODE=auto`. */
export const CONFIRM_TOKEN_AUTO_INSTRUCTION =
  'Nothing has been done yet. Review this preview; if it is what was intended, call again with the same arguments '
  + 'plus confirmToken. (This server runs with MCP_CONFIRM_MODE=auto, so the user\'s approval in chat is not required.)';

const REFUSE_HINT = 'Set MCP_CONFIRM_MODE=ask-user on the server to allow two-step confirmation instead.';
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
  /** The account the action runs as. */
  account?: string;
  /** The phase-2 token from the tool's input, or undefined on phase 1. */
  confirmToken?: string;
  /** Builds the subject from a FRESH read; see {@link ConfirmTokenFallback.subject}. */
  subject: ConfirmTokenFallback['subject'];
  /** Phase 1's instruction in `ask-user` mode; defaults to {@link CONFIRM_TOKEN_INSTRUCTION}. */
  instruction?: string;
  /** Spent-token store; defaults to the process-wide one. */
  spent?: SpentTokenStore;
  /** Environment to read; defaults to `process.env`. */
  env?: EnvSource;
  /**
   * The tool's validated arguments. Pass them: both rails are then bound to
   * them without per-tool judgement (fleet audit 2026-09-24 SEC-2).
   * - Elicitation: sets {@link RequireConfirmationOptions.binding} (unless one
   *   is given) with the env key and TTL, so an acceptance minted for one call
   *   cannot be replayed on a call with different arguments.
   * - Token: the token binds `{ payload: subject().payload, args }`, so a
   *   `subject()` whose payload covers only some arguments (say `{ id }` while
   *   the body is a separate argument) still cannot authorise a different body.
   * A `confirmToken` key is dropped first: it differs between the two phases.
   */
  args?: unknown;
}

/**
 * Turn the fleet env settings into {@link requireConfirmationWithFallback}
 * options:
 *
 * ```ts
 * const gate = await requireConfirmationWithFallback(ctx, confirmationFromEnv({
 *   action: 'thing.delete', message: 'Review and confirm this deletion.', details: { id },
 *   tool: 'thing_delete', confirmToken, args,
 *   subject: () => ({ target: id, payload: { id }, preview: { id } }),
 * }));
 * if (gate) return gate;
 * ```
 */
export function confirmationFromEnv(options: ConfirmationFromEnvOptions): RequireConfirmationWithFallbackOptions {
  const { tool, account, confirmToken, subject, instruction, spent, args, env = process.env, ...rest } = options;
  const mode = readConfirmMode(env);
  const ttlSeconds = readConfirmTtl(env);
  const bound = args === undefined ? undefined : boundArgs(args);
  const confirmation: RequireConfirmationOptions = bound === undefined || rest.binding
    ? rest
    : { ...rest, binding: { key: confirmKeyFromEnv(env), args: bound, ttlSeconds: ttlSeconds ?? DEFAULT_TTL_SECONDS } };
  if (mode === 'refuse' || ttlSeconds === undefined) {
    const hint = mode === 'refuse' ? REFUSE_HINT : BAD_TTL_HINT;
    return {
      ...confirmation,
      unsupportedNote: confirmation.unsupportedNote ? `${confirmation.unsupportedNote} ${hint}` : hint,
    };
  }
  const boundSubject: ConfirmTokenFallback['subject'] = bound === undefined
    ? subject
    : async () => {
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
