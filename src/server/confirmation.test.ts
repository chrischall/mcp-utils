import { describe, expect, it, vi } from 'vitest';
import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createTestHarness, parseToolResult } from '../test/index.js';
import { textResult } from '../response/index.js';
import { requireConfirmation } from './confirmation.js';

function context(inputResponses?: unknown): ServerContext {
  return { mcpReq: { inputResponses } } as unknown as ServerContext;
}

/**
 * A 2026-07-28 request whose envelope declares the CALLER's capabilities. The
 * envelope is the only place a handler can read them, and on this era a host
 * forwards it per request — so it is the caller's own declaration rather than
 * the connection's.
 */
function contextWithCapabilities(capabilities: unknown): ServerContext {
  return {
    mcpReq: {
      envelope: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': capabilities,
      },
    },
  } as unknown as ServerContext;
}

describe('requireConfirmation', () => {
  it('returns an input_required elicitation containing the action preview', () => {
    const result = requireConfirmation(context(), {
      action: 'calendar.delete',
      message: 'Review and confirm this deletion',
      details: { eventId: 'evt-1', summary: 'Planning meeting' },
    });

    expect(result).toMatchObject({
      resultType: 'input_required',
      inputRequests: {
        confirmation: {
          method: 'elicitation/create',
          params: {
            message: expect.stringContaining('Review and confirm this deletion'),
          },
        },
      },
    });
    expect(JSON.stringify(result)).toContain('evt-1');
  });

  it('allows the write only after an accepted checked confirmation', () => {
    const result = requireConfirmation(context({
      confirmation: { action: 'accept', content: { confirmed: true } },
    }), {
      action: 'calendar.delete',
      message: 'Review and confirm this deletion',
    });

    expect(result).toBeUndefined();
  });

  it.each([
    ['declined', { action: 'decline' }],
    ['cancelled', { action: 'cancel' }],
    ['left unchecked', { action: 'accept', content: { confirmed: false } }],
  ])('returns a standard cancelled result when confirmation is %s', (_label, response) => {
    const result = requireConfirmation(context({
      confirmation: response,
    }), {
      action: 'calendar.delete',
      message: 'Review and confirm this deletion',
    });

    const content = (result as CallToolResult).content[0];
    expect(JSON.parse(content?.type === 'text' ? content.text : '')).toEqual({
      confirmed: false,
      cancelled: true,
      action: 'calendar.delete',
      note: 'Nothing was changed because the confirmation was declined, cancelled, or left unchecked.',
    });
  });

  it('supports a custom request key and confirmation label', () => {
    const result = requireConfirmation(context(), {
      action: 'payment.submit',
      message: 'Review the payment',
      requestKey: 'paymentApproval',
      confirmationLabel: 'Confirm this payment should be submitted now.',
    });

    expect(result).toMatchObject({
      inputRequests: {
        paymentApproval: {
          params: {
            requestedSchema: {
              properties: {
                confirmed: { description: 'Confirm this payment should be submitted now.' },
              },
            },
          },
        },
      },
    });
  });

  it('drives an accepted confirmation through the real client/server path before writing', async () => {
    const write = vi.fn(() => textResult({ deleted: true }));
    const harness = await createTestHarness(
      (server) => {
        server.registerTool('delete_event', { inputSchema: z.object({}) }, async (_args, ctx) => {
          const confirmation = requireConfirmation(ctx, {
            action: 'calendar.delete',
            message: 'Review and confirm this deletion',
          });
          return confirmation ?? write();
        });
      },
      { elicitation: async () => ({ action: 'accept', content: { confirmed: true } }) },
    );

    try {
      expect(parseToolResult(await harness.callTool('delete_event'))).toEqual({ deleted: true });
      expect(write).toHaveBeenCalledOnce();
    } finally {
      await harness.close();
    }
  });

  it('drives a declined confirmation through the real path without writing', async () => {
    const write = vi.fn(() => textResult({ deleted: true }));
    const harness = await createTestHarness(
      (server) => {
        server.registerTool('delete_event', { inputSchema: z.object({}) }, async (_args, ctx) => {
          const confirmation = requireConfirmation(ctx, {
            action: 'calendar.delete',
            message: 'Review and confirm this deletion',
          });
          return confirmation ?? write();
        });
      },
      { elicitation: async () => ({ action: 'decline' }) },
    );

    try {
      expect(parseToolResult(await harness.callTool('delete_event'))).toMatchObject({
        confirmed: false,
        cancelled: true,
      });
      expect(write).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });
});

// ============================================================================
// A caller that cannot be asked. Measured on the mcp-host fleet 2026-09-20:
// claude.ai declares `{"extensions": {...}}` and no `elicitation`, so every
// confirmation-guarded tool answered it with a protocol-level -32021 that the
// surface renders as "Error occurred during tool execution" — an opaque failure
// where the only honest answer is "your client cannot show this prompt".
// ============================================================================
describe('requireConfirmation with a caller that cannot be asked', () => {
  const options = {
    action: 'gmail.forward',
    message: 'Review and confirm this email dispatch:',
    unsupportedNote: 'Use gog_gmail_drafts_forward to stage it instead.',
  };

  it('refuses instead of asking when the caller declares no elicitation', () => {
    const result = requireConfirmation(contextWithCapabilities({ extensions: {} }), options);

    expect(result).not.toMatchObject({ resultType: 'input_required' });
    const content = (result as CallToolResult).content[0];
    expect(JSON.parse(content?.type === 'text' ? content.text : '')).toEqual({
      confirmed: false,
      dispatched: false,
      action: 'gmail.forward',
      reason: 'confirmation-unsupported',
      note: 'Nothing was done because this client cannot show a confirmation prompt '
        + '(it declares no MCP elicitation capability), and this action is never taken '
        + 'without one. Use gog_gmail_drafts_forward to stage it instead.',
    });
  });

  it('refuses when the caller offers only URL elicitation, which cannot carry a form', () => {
    const result = requireConfirmation(contextWithCapabilities({ elicitation: { url: {} } }), options);

    expect(result).not.toMatchObject({ resultType: 'input_required' });
  });

  it.each([
    ['form elicitation', { elicitation: { form: {} } }],
    ['elicitation with no modes listed', { elicitation: {} }],
  ])('still asks a caller that declares %s', (_label, capabilities) => {
    expect(requireConfirmation(contextWithCapabilities(capabilities), options))
      .toMatchObject({ resultType: 'input_required' });
  });

  it('still asks when the era carries no envelope to read', () => {
    // A 2025-era request: the SDK consults the initialize-declared capabilities
    // itself, which this helper cannot see. Guessing "cannot" there would refuse
    // every legacy caller that CAN be asked, so absence is never a verdict.
    expect(requireConfirmation(context(), options))
      .toMatchObject({ resultType: 'input_required' });
  });

  it('omits the note when the caller was given no alternative to suggest', () => {
    const result = requireConfirmation(contextWithCapabilities({}), {
      action: 'gmail.forward',
      message: 'Review and confirm this email dispatch:',
    });

    const content = (result as CallToolResult).content[0];
    expect(JSON.parse(content?.type === 'text' ? content.text : '').note).toBe(
      'Nothing was done because this client cannot show a confirmation prompt '
      + '(it declares no MCP elicitation capability), and this action is never taken without one.',
    );
  });

  it('answers a real unaskable caller instead of throwing, and does not write', async () => {
    // The whole bug in one test: the harness client without an `elicitation`
    // handler declares no capability, which is claude.ai's shape. Before this,
    // `callTool` REJECTED with -32021 and the caller learned nothing.
    const write = vi.fn(() => textResult({ sent: true }));
    const harness = await createTestHarness((server) => {
      server.registerTool('forward_mail', { inputSchema: z.object({}) }, async (_args, ctx) => {
        const confirmation = requireConfirmation(ctx, options);
        return confirmation ?? write();
      });
    });

    try {
      expect(parseToolResult(await harness.callTool('forward_mail'))).toMatchObject({
        confirmed: false,
        dispatched: false,
        reason: 'confirmation-unsupported',
      });
      expect(write).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });
});
