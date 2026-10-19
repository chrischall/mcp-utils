/**
 * `<prefix>_confirm({confirmToken})` — finish a two-step confirmation without
 * sending the arguments again.
 *
 * Phase 1 of the token rail returns a preview and a `confirmToken`; phase 2
 * used to be the SAME call again plus the token. On a server that registers
 * this tool, phase 1 also keeps the call's arguments (`confirm-pending.ts`) and
 * names this tool in its result, so phase 2 can be the token alone.
 *
 * The confirm tool decides nothing. It looks up the arguments stored under the
 * token and re-runs the ORIGINAL tool's handler with them plus the token, and
 * that handler's own gate verifies the token exactly as on the full-arguments
 * path: the HMAC, the tool, the account, the target, a FRESH read's revision,
 * the payload hash, the expiry and single use. A change between the phases is
 * still `DRAFT_CHANGED` (and its fresh token is kept too); a token this server
 * holds nothing for is `PENDING_NOT_FOUND`, which says how to fall back.
 *
 * The entry is removed before the replay runs, so two concurrent confirms
 * cannot both act — and a failed replay never leaves a token that a second
 * confirm could try again.
 */
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { textResult } from '../response/index.js';
import {
  currentScope,
  processPendingCalls,
  setConfirmTool,
  toolHandler,
  type ConfirmToolOptions,
} from './confirm-pending.js';
import { CONFIRM_INJECTION_RULE } from './confirm-write.js';

/** The confirm tool's default description. */
export const CONFIRM_TOOL_DESCRIPTION =
  'Confirm a write that another tool on this server previewed, using ONLY the confirmToken from its '
  + '"confirmation-required" response: the server kept that call\'s arguments, so do not send them again. Pass the '
  + 'token only after the user has seen that preview and explicitly approved it in chat. One token acts once. '
  + CONFIRM_INJECTION_RULE;

/** `PENDING_NOT_FOUND`'s note: what happened, and the way that still works. */
export const PENDING_NOT_FOUND_NOTE =
  'Nothing was sent or changed: this server holds no arguments for that confirmToken (it was already used, it '
  + 'expired, it was not issued here, or the server restarted). If the token is still valid, call the original tool '
  + 'again with the same arguments plus confirmToken; otherwise call it without confirmToken for a fresh preview and '
  + 'approval.';

/**
 * Register the confirm tool on `server` and turn on argument keeping for every
 * gated tool on it. Call it from a registrar, like any other tool:
 *
 * ```ts
 * runMcp({ …, tools: [registerExpenseTools, (s) => registerConfirmTool(s, { name: 'sw_confirm' })] });
 * ```
 *
 * Works with every gate built on the token rail (`confirmWrite`,
 * `confirmationFromEnv` + `requireConfirmationWithFallback`): the arguments are
 * captured by the `registerTool` wrapper `createMcpServer` and the test harness
 * install, so gated tools need no change.
 */
export function registerConfirmTool(server: McpServer, options: ConfirmToolOptions): void {
  const store = options.store ?? processPendingCalls();
  setConfirmTool(server, { ...options, store });
  server.registerTool(
    options.name,
    {
      description: options.description ?? CONFIRM_TOOL_DESCRIPTION,
      // It performs whichever write it confirms.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      inputSchema: z.object({
        confirmToken: z.string().min(1).describe('The confirmToken from a "confirmation-required" response on this server.'),
      }),
    },
    async ({ confirmToken }, ctx) => {
      // Check the principal BEFORE taking, so a caller holding someone else's
      // token cannot even burn their entry.
      const peek = store.get(confirmToken);
      const entry = peek && peek.scope === currentScope(options) ? store.take(confirmToken) : undefined;
      const handler = entry ? toolHandler(server, entry.tool) : undefined;
      if (!entry || !handler) {
        return {
          ...textResult({
            status: 'confirmation-rejected',
            confirmed: false,
            dispatched: false,
            error: 'PENDING_NOT_FOUND',
            note: PENDING_NOT_FOUND_NOTE,
          }),
          isError: true,
        };
      }
      return (await handler({ ...entry.args, confirmToken }, ctx)) as never;
    },
  );
}
