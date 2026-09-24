/**
 * The fleet's env layer over the confirm-token fallback: the three variables
 * every server documents identically, read in one place so 30 servers cannot
 * spell or interpret them 30 ways.
 *
 * | variable | default | |
 * |---|---|---|
 * | `MCP_CONFIRM_MODE` | `ask-user` | what a gated write does on a client that CANNOT show a confirmation prompt |
 * | `MCP_CONFIRM_TTL_SECONDS` | `600` | how long a token stays valid |
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

/** `MCP_CONFIRM_TTL_SECONDS` as a positive integer, else 600. */
export function confirmTtlFromEnv(env: EnvSource = process.env): number {
  const raw = readEnvVar('MCP_CONFIRM_TTL_SECONDS', { env })?.trim();
  return raw && /^[1-9]\d*$/.test(raw) ? Number(raw) : DEFAULT_TTL_SECONDS;
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
}

/**
 * Turn the fleet env settings into {@link requireConfirmationWithFallback}
 * options:
 *
 * ```ts
 * const gate = await requireConfirmationWithFallback(ctx, confirmationFromEnv({
 *   action: 'thing.delete', message: 'Review and confirm this deletion.', details: { id },
 *   tool: 'thing_delete', confirmToken,
 *   subject: () => ({ target: id, payload: { id }, preview: { id } }),
 * }));
 * if (gate) return gate;
 * ```
 */
export function confirmationFromEnv(options: ConfirmationFromEnvOptions): RequireConfirmationWithFallbackOptions {
  const { tool, account, confirmToken, subject, instruction, spent, env = process.env, ...confirmation } = options;
  const mode = readConfirmMode(env);
  if (mode === 'refuse') {
    return {
      ...confirmation,
      unsupportedNote: confirmation.unsupportedNote ? `${confirmation.unsupportedNote} ${REFUSE_HINT}` : REFUSE_HINT,
    };
  }
  return {
    ...confirmation,
    tokenFallback: {
      key: confirmKeyFromEnv(env),
      tool,
      ...(account === undefined ? {} : { account }),
      ...(confirmToken === undefined ? {} : { confirmToken }),
      subject,
      ttlSeconds: confirmTtlFromEnv(env),
      instruction: mode === 'auto' ? CONFIRM_TOKEN_AUTO_INSTRUCTION : (instruction ?? CONFIRM_TOKEN_INSTRUCTION),
      ...(spent === undefined ? {} : { spent }),
    },
  };
}
