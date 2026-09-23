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

// ============================================================================
// audit 2026-09 (SEC-4): opt-in binding of the confirmation to the arguments.
// Without `binding` any accepted `confirmation` response passes; with it, the
// acceptance must arrive with the integrity-protected requestState minted for
// THIS action and THESE arguments.
// ============================================================================
describe('requireConfirmation with binding', () => {
  const KEY = 'k'.repeat(32);
  const accepted = { confirmation: { action: 'accept', content: { confirmed: true } } };

  function ctxWith(inputResponses: unknown, state: unknown): ServerContext {
    return { mcpReq: { inputResponses, requestState: () => state } } as unknown as ServerContext;
  }

  function mintFor(args: unknown, action = 'mail.send'): string {
    const first = requireConfirmation(ctxWith(undefined, undefined), {
      action,
      message: 'Send?',
      binding: { key: KEY, args },
    }) as { resultType: string; requestState?: string };
    expect(first.resultType).toBe('input_required');
    expect(typeof first.requestState).toBe('string');
    return first.requestState!;
  }

  it('proceeds when the acceptance carries the state minted for the same action and arguments', () => {
    const state = mintFor({ to: 'a@x.test', body: 'hi' });
    expect(
      requireConfirmation(ctxWith(accepted, state), {
        action: 'mail.send',
        message: 'Send?',
        // key order must not matter
        binding: { key: KEY, args: { body: 'hi', to: 'a@x.test' } },
      }),
    ).toBeUndefined();
  });

  it.each([
    ['undefined state', ctxWith(accepted, undefined)],
    ['null state', ctxWith(accepted, null)],
    ['no requestState accessor', { mcpReq: { inputResponses: accepted } } as unknown as ServerContext],
  ])('fails with an explicit error (not a re-ask loop) when an acceptance arrives with %s', (_label, ctx) => {
    const r = requireConfirmation(ctx, {
      action: 'mail.send',
      message: 'Send?',
      binding: { key: KEY, args: { to: 'a@x.test' } },
    }) as CallToolResult;
    expect(r).toBeDefined();
    expect(r).not.toMatchObject({ resultType: 'input_required' });
    expect(r.isError).toBe(true);
    const text = r.content[0]?.type === 'text' ? r.content[0].text : '';
    expect(text).toMatch(/requestState/);
    expect(text).toMatch(/round-trip|echo/i);
    expect(text).toContain('mail.send');
  });

  it('re-asks (does not error) when a present state is empty or malformed', () => {
    for (const s of ['', 'mcpu.confirm.v1.nodot']) {
      const r = requireConfirmation(ctxWith(accepted, s), {
        action: 'mail.send',
        message: 'Send?',
        binding: { key: KEY, args: { to: 'a@x.test' } },
      });
      expect(r).toMatchObject({ resultType: 'input_required' });
    }
  });

  it('re-asks when the acceptance was for different arguments (replay)', () => {
    const state = mintFor({ to: 'a@x.test' });
    const r = requireConfirmation(ctxWith(accepted, state), {
      action: 'mail.send',
      message: 'Send?',
      binding: { key: KEY, args: { to: 'attacker@x.test' } },
    });
    expect(r).toMatchObject({ resultType: 'input_required' });
  });

  it('re-asks when the acceptance was for a different action', () => {
    const state = mintFor({ id: 1 }, 'event.update');
    const r = requireConfirmation(ctxWith(accepted, state), {
      action: 'event.delete',
      message: 'Delete?',
      binding: { key: KEY, args: { id: 1 } },
    });
    expect(r).toMatchObject({ resultType: 'input_required' });
  });

  it('re-asks on a tampered or foreign state', () => {
    const state = mintFor({ to: 'a@x.test' });
    const tampered = state.slice(0, -2) + (state.endsWith('AA') ? 'BB' : 'AA');
    for (const s of [tampered, 'garbage', 42]) {
      const r = requireConfirmation(ctxWith(accepted, s), {
        action: 'mail.send',
        message: 'Send?',
        binding: { key: KEY, args: { to: 'a@x.test' } },
      });
      expect(r).toMatchObject({ resultType: 'input_required' });
    }
  });

  it('re-asks once the state has expired', () => {
    vi.useFakeTimers();
    try {
      const state = mintFor({ to: 'a@x.test' });
      vi.advanceTimersByTime(601_000);
      const r = requireConfirmation(ctxWith(accepted, state), {
        action: 'mail.send',
        message: 'Send?',
        binding: { key: KEY, args: { to: 'a@x.test' } },
      });
      expect(r).toMatchObject({ resultType: 'input_required' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('still returns the cancelled result for a declined prompt', () => {
    const state = mintFor({ to: 'a@x.test' });
    const r = requireConfirmation(ctxWith({ confirmation: { action: 'decline' } }, state), {
      action: 'mail.send',
      message: 'Send?',
      binding: { key: KEY, args: { to: 'a@x.test' } },
    });
    expect(r).toMatchObject({ content: [{ type: 'text' }] });
    expect(JSON.stringify(r)).toContain('cancelled');
  });

  it('rejects a key shorter than 32 bytes', () => {
    expect(() =>
      requireConfirmation(ctxWith(undefined, undefined), {
        action: 'a',
        message: 'm',
        binding: { key: 'short', args: {} },
      }),
    ).toThrow(RangeError);
  });

  it('works end to end through the real client/server path', async () => {
    const write = vi.fn(() => textResult({ sent: true }));
    const harness = await createTestHarness(
      (server) => {
        server.registerTool('send', { inputSchema: z.object({ to: z.string() }) }, async (args, ctx) => {
          const confirmation = requireConfirmation(ctx, {
            action: 'mail.send',
            message: 'Send?',
            binding: { key: KEY, args },
          });
          return confirmation ?? write();
        });
      },
      { elicitation: async () => ({ action: 'accept', content: { confirmed: true } }) },
    );
    try {
      expect(parseToolResult(await harness.callTool('send', { to: 'a@x.test' }))).toEqual({ sent: true });
      expect(write).toHaveBeenCalledOnce();
    } finally {
      await harness.close();
    }
  });
});

// Review follow-up: non-plain argument values must change the commitment, and
// bad TTLs are refused.
describe('requireConfirmation binding — faithful canonicalisation', () => {
  const KEY = 'k'.repeat(32);
  const accepted = { confirmation: { action: 'accept', content: { confirmed: true } } };
  const ctxWith = (inputResponses: unknown, state: unknown): ServerContext =>
    ({ mcpReq: { inputResponses, requestState: () => state } }) as unknown as ServerContext;

  function stateFor(args: unknown): string {
    const r = requireConfirmation(ctxWith(undefined, undefined), {
      action: 'a',
      message: 'm',
      binding: { key: KEY, args },
    }) as { requestState?: string };
    return r.requestState!;
  }
  function passes(state: string, args: unknown): boolean {
    return (
      requireConfirmation(ctxWith(accepted, state), { action: 'a', message: 'm', binding: { key: KEY, args } }) ===
      undefined
    );
  }

  const pairs: Array<[string, unknown, unknown]> = [
    ['Date', { when: new Date('2026-01-01T00:00:00Z') }, { when: new Date('2027-06-01T00:00:00Z') }],
    ['Buffer', { blob: Buffer.from('one') }, { blob: Buffer.from('two') }],
    ['Uint8Array', { blob: new Uint8Array([1]) }, { blob: new Uint8Array([2]) }],
    ['Map', { m: new Map([['k', 1]]) }, { m: new Map([['k', 2]]) }],
    ['Set', { s: new Set([1]) }, { s: new Set([2]) }],
    ['bigint', { n: 1n }, { n: 2n }],
  ];
  for (const [label, a, b] of pairs) {
    it(`an acceptance for one ${label} does not verify for a different ${label}`, () => {
      const state = stateFor(a);
      expect(passes(state, a)).toBe(true);
      expect(passes(state, b)).toBe(false);
    });
  }

  // A plain object whose keys look like a type tag must never share a
  // commitment with the typed value it imitates (in either direction).
  const lookalikes: Array<[string, unknown, unknown]> = [
    ['Buffer', { blob: Buffer.from('two') }, { blob: { $bytes: 'dHdv' } }],
    ['Uint8Array', { blob: new Uint8Array([1, 2]) }, { blob: { $bytes: Buffer.from([1, 2]).toString('base64') } }],
    ['ArrayBuffer', { blob: new Uint8Array([3]).buffer }, { blob: { $bytes: Buffer.from([3]).toString('base64') } }],
    ['Date', { when: new Date('2026-01-01T00:00:00Z') }, { when: { $date: '2026-01-01T00:00:00.000Z' } }],
    ['invalid Date', { when: new Date(Number.NaN) }, { when: { $date: 'Invalid Date' } }],
    ['Map', { m: new Map([['k', 1]]) }, { m: { $map: [['k', 1]] } }],
    ['Set', { s: new Set([1]) }, { s: { $set: [1] } }],
    ['bigint', { n: 1n }, { n: { $bigint: '1' } }],
    ['NaN', { n: Number.NaN }, { n: { $num: 'NaN' } }],
    ['Infinity', { n: Number.POSITIVE_INFINITY }, { n: { $num: 'Infinity' } }],
    ['-Infinity', { n: Number.NEGATIVE_INFINITY }, { n: { $num: '-Infinity' } }],
  ];
  for (const [label, typed, plain] of lookalikes) {
    it(`a plain object imitating the ${label} tag does not share its commitment`, () => {
      expect(passes(stateFor(typed), typed)).toBe(true);
      expect(passes(stateFor(plain), plain)).toBe(true);
      expect(passes(stateFor(typed), plain)).toBe(false);
      expect(passes(stateFor(plain), typed)).toBe(false);
    });
  }

  it('keeps distinct $-prefixed plain keys distinct after escaping', () => {
    const pairsOfKeys: Array<[unknown, unknown]> = [
      [{ $x: 1 }, { $$x: 1 }],
      [{ $bytes: 'dHdv' }, { $$bytes: 'dHdv' }],
      [{ $: 1 }, { $$: 1 }],
    ];
    for (const [a, b] of pairsOfKeys) {
      expect(passes(stateFor(a), a)).toBe(true);
      expect(passes(stateFor(a), b)).toBe(false);
      expect(passes(stateFor(b), a)).toBe(false);
    }
  });

  it('treats Map and Set insertion order as irrelevant', () => {
    const state = stateFor({ m: new Map([['a', 1], ['b', 2]]), s: new Set(['x', 'y']) });
    expect(passes(state, { m: new Map([['b', 2], ['a', 1]]), s: new Set(['y', 'x']) })).toBe(true);
  });

  it('refuses to bind a value it cannot canonicalise (class instance, function)', () => {
    class Thing {
      constructor(readonly v: number) {}
    }
    for (const args of [{ t: new Thing(1) }, { f: () => 1 }]) {
      expect(() => stateFor(args)).toThrow(TypeError);
    }
  });

  it.each([[0], [-5], [Number.NaN], [Number.POSITIVE_INFINITY]])('rejects ttlSeconds %s', (ttl) => {
    expect(() =>
      requireConfirmation(ctxWith(undefined, undefined), {
        action: 'a',
        message: 'm',
        binding: { key: KEY, args: {}, ttlSeconds: ttl },
      }),
    ).toThrow(RangeError);
  });
});
