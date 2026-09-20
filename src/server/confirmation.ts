import {
  acceptedContent,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type InputRequiredResult,
  type ServerContext,
} from '@modelcontextprotocol/server';
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
 */
export function requireConfirmation(
  ctx: ServerContext,
  options: RequireConfirmationOptions,
): InputRequiredResult | CallToolResult | undefined {
  const requestKey = options.requestKey ?? DEFAULT_REQUEST_KEY;
  const confirmationSchema = z.object({
    confirmed: z
      .boolean()
      .describe(options.confirmationLabel ?? DEFAULT_CONFIRMATION_LABEL),
  });
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
    });
  }

  if (response.kind === 'elicit' && response.action === 'accept' && accepted?.confirmed === true) {
    return undefined;
  }

  return textResult({
    confirmed: false,
    cancelled: true,
    action: options.action,
    note: 'Nothing was changed because the confirmation was declined, cancelled, or left unchecked.',
  });
}
