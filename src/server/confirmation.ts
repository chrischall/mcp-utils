import {
  acceptedContent,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type InputRequiredResult,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { callerAcceptsFormElicitation } from '../caller/index.js';
import { textResult } from '../response/index.js';

const DEFAULT_REQUEST_KEY = 'confirmation';
const DEFAULT_CONFIRMATION_LABEL = 'Confirm this action should proceed.';
const UNSUPPORTED_NOTE = 'Nothing was done because this client cannot show a confirmation prompt '
  + '(it declares no MCP elicitation capability), and this action is never taken without one';

/** Options for {@link requireConfirmation}. */
export interface RequireConfirmationOptions {
  /** Stable identifier for the operation being confirmed. */
  action: string;
  /** Human-readable prompt shown before the structured action preview. */
  message: string;
  /** Additional operation details included in the prompt. Never trusted on retry. */
  details?: Record<string, unknown>;
  /** Key used to correlate the elicitation response. Defaults to `confirmation`. */
  requestKey?: string;
  /** Label shown beside the required confirmation checkbox. */
  confirmationLabel?: string;
  /**
   * One sentence appended when the caller cannot be shown a prompt at all,
   * naming what to do instead (typically the tool that stages the same action
   * without dispatching it). Omitted, the refusal still explains itself — this
   * only adds the way forward, which the caller of this helper knows and this
   * helper does not.
   */
  unsupportedNote?: string;
  /**
   * Opt-in: bind the confirmation to THIS action and THESE arguments.
   *
   * Without it, any accepted `confirmation` response on the request passes —
   * nothing ties it to the prompt that was shown, so a client that replays an
   * earlier acceptance on a call with different arguments (or pre-fills one)
   * gets through. With it, the prompt is returned with an HMAC-protected
   * `requestState` committing to `action` and a hash of `args`, and an
   * acceptance only counts when it arrives with a valid, unexpired state that
   * matches the current call. Anything else is asked again.
   *
   * `key` must be at least 32 bytes and the same for every process that may
   * receive the retry. Don't combine with a `ServerOptions.requestState.verify`
   * hook: that hook would reject this helper's state.
   */
  binding?: ConfirmationBinding;
}

/** See {@link RequireConfirmationOptions.binding}. */
export interface ConfirmationBinding {
  /** HMAC key (a string is UTF-8 encoded). At least 32 bytes. */
  key: string | Uint8Array;
  /** The tool's validated arguments. Hashed with keys sorted; never embedded. */
  args: unknown;
  /** How long the prompt stays answerable, in seconds. Default 600. */
  ttlSeconds?: number;
}

const STATE_PREFIX = 'mcpu.confirm.v1.';

/** JSON with object keys sorted, so `{a,b}` and `{b,a}` hash the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function bindingKey(binding: ConfirmationBinding): Buffer {
  const key = typeof binding.key === 'string' ? Buffer.from(binding.key, 'utf8') : Buffer.from(binding.key);
  if (key.length < 32) {
    throw new RangeError('requireConfirmation: binding.key must be at least 32 bytes.');
  }
  return key;
}

function commitment(action: string, args: unknown): string {
  return createHash('sha256').update(`${action}\0${canonicalJson(args)}`).digest('base64url');
}

function mintState(key: Buffer, action: string, binding: ConfirmationBinding): string {
  const exp = Math.floor(Date.now() / 1000) + (binding.ttlSeconds ?? 600);
  const body = Buffer.from(JSON.stringify({ c: commitment(action, binding.args), exp })).toString('base64url');
  const mac = createHmac('sha256', key).update(`${STATE_PREFIX}${body}`).digest('base64url');
  return `${STATE_PREFIX}${body}.${mac}`;
}

/** Whether `state` is a valid, unexpired state minted for this action + args. */
function verifyState(key: Buffer, action: string, binding: ConfirmationBinding, state: unknown): boolean {
  if (typeof state !== 'string' || !state.startsWith(STATE_PREFIX)) return false;
  const rest = state.slice(STATE_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot < 0) return false;
  const body = rest.slice(0, dot);
  const mac = Buffer.from(rest.slice(dot + 1), 'base64url');
  const expected = createHmac('sha256', key).update(`${STATE_PREFIX}${body}`).digest();
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return false;
  let payload: { c?: unknown; exp?: unknown };
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as typeof payload;
  } catch {
    return false;
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return false;
  const want = Buffer.from(commitment(action, binding.args));
  const got = Buffer.from(typeof payload.c === 'string' ? payload.c : '');
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The round's echoed requestState, tolerating contexts without the accessor. */
function echoedState(ctx: ServerContext): unknown {
  const accessor = (ctx.mcpReq as { requestState?: unknown }).requestState;
  return typeof accessor === 'function' ? (accessor as () => unknown)() : undefined;
}

/**
 * Require an explicit, checked form elicitation before a mutating tool proceeds.
 *
 * Return the helper's result immediately when it is defined. `undefined` means
 * the client accepted the elicitation and supplied a schema-validated
 * `confirmed: true`, so the caller may perform the operation.
 *
 * The operation details are a display preview only. Recompute and re-authorize
 * every write from the tool's original validated arguments on each retry.
 *
 * Pass {@link RequireConfirmationOptions.binding} to tie the acceptance to
 * this action and these arguments (recommended for sends, payments and
 * deletes); without it, any accepted response on the request is honoured.
 */
export function requireConfirmation(
  ctx: ServerContext,
  options: RequireConfirmationOptions,
): InputRequiredResult | CallToolResult | undefined {
  const requestKey = options.requestKey ?? DEFAULT_REQUEST_KEY;
  const key = options.binding ? bindingKey(options.binding) : undefined;
  const confirmationSchema = z.object({
    confirmed: z
      .boolean()
      .describe(options.confirmationLabel ?? DEFAULT_CONFIRMATION_LABEL),
  });
  const ask = (): InputRequiredResult => {
    const preview = {
      action: options.action,
      ...(options.details === undefined ? {} : { details: options.details }),
    };
    return inputRequired({
      inputRequests: {
        [requestKey]: inputRequired.elicit({
          message: `${options.message}\n${JSON.stringify(preview, null, 2)}`,
          requestedSchema: confirmationSchema,
        }),
      },
      ...(key && options.binding ? { requestState: mintState(key, options.action, options.binding) } : {}),
    });
  };
  const response = inputResponse(ctx.mcpReq.inputResponses, requestKey);
  const accepted = acceptedContent(
    ctx.mcpReq.inputResponses,
    requestKey,
    confirmationSchema,
  );

  if (response.kind === 'missing') {
    // A CALLER THAT CANNOT BE ASKED IS TOLD SO, rather than being handed a
    // prompt the SDK will refuse to deliver. That refusal is a protocol error
    // (-32021) raised after this function has returned, so it cannot be caught
    // here and the caller sees only an opaque failure: measured on the mcp-host
    // fleet, claude.ai — which declares no `elicitation` — got four of those in
    // a row from `gog_gmail_forward`, each in under 110 ms, having never run.
    //
    // `false` only, never a missing answer: see `callerAcceptsFormElicitation`.
    if (callerAcceptsFormElicitation(ctx) === false) {
      return textResult({
        confirmed: false,
        dispatched: false,
        action: options.action,
        reason: 'confirmation-unsupported',
        note: options.unsupportedNote
          ? `${UNSUPPORTED_NOTE}. ${options.unsupportedNote}`
          : `${UNSUPPORTED_NOTE}.`,
      });
    }
    return ask();
  }

  if (response.kind === 'elicit' && response.action === 'accept' && accepted?.confirmed === true) {
    // Bound mode: an acceptance only counts for the prompt minted for this
    // exact action + arguments. A replayed or pre-filled one is asked again.
    if (key && options.binding && !verifyState(key, options.action, options.binding, echoedState(ctx))) {
      return ask();
    }
    return undefined;
  }

  return textResult({
    confirmed: false,
    cancelled: true,
    action: options.action,
    note: 'Nothing was changed because the confirmation was declined, cancelled, or left unchecked.',
  });
}
