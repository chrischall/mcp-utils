import { describe, expect, it, vi } from 'vitest';
import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createTestHarness, parseToolResult } from '../test/index.js';
import { textResult } from '../response/index.js';
import { requireConfirmation } from './confirmation.js';

function context(inputResponses?: unknown): ServerContext {
  return { mcpReq: { inputResponses } } as unknown as ServerContext;
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
