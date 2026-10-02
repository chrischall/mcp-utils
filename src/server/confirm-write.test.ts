import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { createTestHarness, parseToolResult } from '../test/index.js';
import { textResult } from '../response/index.js';
import { createSpentTokenStore, confirmTokenParam } from './confirm-token.js';
import {
  CONFIRM_FLOW_SENTENCE,
  CONFIRM_INJECTION_RULE,
  confirmWrite,
  type ConfirmWriteOptions,
} from './confirm-write.js';

function ctxDeclaring(capabilities: unknown, mcpReq: Record<string, unknown> = {}): ServerContext {
  return {
    mcpReq: {
      envelope: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': capabilities,
      },
      ...mcpReq,
    },
  } as unknown as ServerContext;
}
const CANNOT_BE_ASKED = ctxDeclaring({ extensions: {} });
const CAN_BE_ASKED = ctxDeclaring({ elicitation: { form: {} } });
const ACCEPTED = { confirmation: { action: 'accept', content: { confirmed: true } } };
const answered = (state: unknown) =>
  ctxDeclaring({ elicitation: { form: {} } }, { inputResponses: ACCEPTED, requestState: () => state });
const text = (r: unknown) => JSON.parse(((r as CallToolResult).content[0] as { text: string }).text);

afterEach(() => vi.restoreAllMocks());

/** tempo-api-mcp's richest call: a PUT with body, query and revision. */
function tempoUpdate(over: Partial<ConfirmWriteOptions> = {}): ConfirmWriteOptions {
  return {
    tool: 'tempo_update_worklog',
    action: 'worklog.update',
    summary: 'Update worklog 5',
    account: undefined,
    target: '5',
    revision: '2024-01-15T10:00:00Z',
    request: {
      method: 'PUT',
      path: '/4/worklogs/5',
      body: { timeSpentSeconds: 7200 },
      query: { notify: true, skip: undefined },
    },
    confirmToken: undefined,
    env: {},
    ...over,
  };
}

/** Phase 1 then phase 2 with `second` (defaults to the same call). */
async function twoPhase(first: ConfirmWriteOptions, second: Partial<ConfirmWriteOptions> = {}) {
  const spent = first.spent ?? createSpentTokenStore();
  const p1 = text(await confirmWrite(CANNOT_BE_ASKED, { ...first, spent }));
  expect(p1.status).toBe('confirmation-required');
  const p2 = await confirmWrite(CANNOT_BE_ASKED, { ...first, ...second, spent, confirmToken: p1.confirmToken });
  return { p1, p2, spent };
}

describe('CONFIRM_FLOW_SENTENCE', () => {
  it('is the sentence the fleet copied verbatim (evite, easytable, resy, groupon, tempo, pickuppatrol, asc, outlook, mhlb)', () => {
    expect(CONFIRM_FLOW_SENTENCE).toBe(
      'Asks the user to confirm first: a confirmation prompt where the client supports one; otherwise the first call '
        + 'returns a preview and a confirmToken, and only a repeat call with that token proceeds (see MCP_CONFIRM_MODE).',
    );
  });

  it('the injection rule names tool-result text and the confirmToken', () => {
    expect(CONFIRM_INJECTION_RULE).toMatch(/confirmToken/);
    expect(CONFIRM_INJECTION_RULE).toMatch(/tool result/);
    expect(CONFIRM_INJECTION_RULE).toMatch(/^Never /);
  });
});

describe('confirmWrite — token rail (a client that cannot be prompted)', () => {
  it('phase 1 previews exactly what will be sent, drops undefined query values, and acts on nothing', async () => {
    const p1 = text(await confirmWrite(CANNOT_BE_ASKED, tempoUpdate({ spent: createSpentTokenStore() })));
    expect(p1).toMatchObject({ status: 'confirmation-required', confirmed: false, dispatched: false, action: 'worklog.update' });
    expect(p1.preview).toEqual({
      action: 'Update worklog 5',
      method: 'PUT',
      path: '/4/worklogs/5',
      willSend: { timeSpentSeconds: 7200 },
      willSendQuery: { notify: true },
    });
    expect(p1.confirmToken).toEqual(expect.any(String));
  });

  it('omits willSend/willSendQuery when there is no body and no (non-undefined) query', async () => {
    const p1 = text(await confirmWrite(CANNOT_BE_ASKED, tempoUpdate({
      request: { method: 'DELETE', path: '/4/worklogs/5', query: { skip: undefined } },
      spent: createSpentTokenStore(),
    })));
    expect(p1.preview).toEqual({ action: 'Update worklog 5', method: 'DELETE', path: '/4/worklogs/5' });
  });

  it('phase 2 with the token and the same call proceeds, exactly once', async () => {
    const { p1, p2, spent } = await twoPhase(tempoUpdate());
    expect(p2).toBeUndefined();
    const again = text(await confirmWrite(CANNOT_BE_ASKED, { ...tempoUpdate(), spent, confirmToken: p1.confirmToken }));
    expect(again.error).toBe('TOKEN_REUSED');
  });

  it('query values that are undefined do not move the binding', async () => {
    const { p2 } = await twoPhase(tempoUpdate(), {
      request: { method: 'PUT', path: '/4/worklogs/5', body: { timeSpentSeconds: 7200 }, query: { notify: true } },
    });
    expect(p2).toBeUndefined();
  });

  it.each<[string, Partial<ConfirmWriteOptions>]>([
    ['body', { request: { method: 'PUT', path: '/4/worklogs/5', body: { timeSpentSeconds: 9999 }, query: { notify: true } } }],
    ['query', { request: { method: 'PUT', path: '/4/worklogs/5', body: { timeSpentSeconds: 7200 }, query: { notify: false } } }],
    ['method', { request: { method: 'DELETE', path: '/4/worklogs/5', body: { timeSpentSeconds: 7200 }, query: { notify: true } } }],
    ['path', { request: { method: 'PUT', path: '/4/worklogs/6', body: { timeSpentSeconds: 7200 }, query: { notify: true } } }],
    ['the displayed preview', { preview: { caveat: 'now public' } }],
    ['args', { args: { id: '5', extra: 1 } }],
  ])('a changed %s is refused as DRAFT_CHANGED (payload-changed) with a fresh token', async (_what, change) => {
    const { p1, p2 } = await twoPhase(tempoUpdate(), change);
    const r = text(p2);
    expect((p2 as CallToolResult).isError).toBe(true);
    expect(r).toMatchObject({ error: 'DRAFT_CHANGED', reason: 'payload-changed', dispatched: false });
    expect(r.confirmToken).not.toBe(p1.confirmToken);
  });

  it('the body is bound even when the preview shows a willSend override instead of it', async () => {
    const base = tempoUpdate({ willSend: { hours: 2 } });
    const { p2 } = await twoPhase(base, {
      request: { method: 'PUT', path: '/4/worklogs/5', body: { timeSpentSeconds: 1 }, query: { notify: true } },
    });
    expect(text(p2)).toMatchObject({ error: 'DRAFT_CHANGED', reason: 'payload-changed' });
  });

  it('a rotated revision is refused as DRAFT_CHANGED (revision-changed)', async () => {
    const { p2 } = await twoPhase(tempoUpdate(), { revision: '2024-01-16T00:00:00Z' });
    expect(text(p2)).toMatchObject({ error: 'DRAFT_CHANGED', reason: 'revision-changed' });
  });

  it('a revision of null binds as absent (pickuppatrol passes null for "no version")', async () => {
    const { p2 } = await twoPhase(tempoUpdate({ revision: null }), { revision: undefined });
    expect(p2).toBeUndefined();
  });

  it.each<[string, Partial<ConfirmWriteOptions>]>([
    ['target', { target: '6' }],
    ['account', { account: 'someone-else@example.test' }],
    ['tool', { tool: 'tempo_delete_worklog' }],
  ])('a token minted for another %s is TOKEN_INVALID', async (_what, change) => {
    const { p2 } = await twoPhase(tempoUpdate({ account: 'me@example.test' }), change);
    expect(text(p2)).toMatchObject({ error: 'TOKEN_INVALID', dispatched: false });
  });

  it('a numeric target (ioffice) binds as its string form', async () => {
    const { p2 } = await twoPhase(tempoUpdate({ target: 42 }), { target: '42' });
    expect(p2).toBeUndefined();
  });

  it('confirmToken inside args is ignored by the binding (it differs between phases)', async () => {
    const { p1, p2 } = await twoPhase(tempoUpdate({ args: { id: '5' } }), { args: { id: '5', confirmToken: 'x' } });
    expect(p1.status).toBe('confirmation-required');
    expect(p2).toBeUndefined();
  });

  it('honours MCP_CONFIRM_MODE=refuse: the write is refused on such clients', async () => {
    const r = text(await confirmWrite(CANNOT_BE_ASKED, tempoUpdate({ env: { MCP_CONFIRM_MODE: 'refuse' } })));
    expect(r).toMatchObject({ reason: 'confirmation-unsupported', dispatched: false });
  });

  it('honours MCP_CONFIRM_TTL_SECONDS', async () => {
    const r = text(await confirmWrite(CANNOT_BE_ASKED, tempoUpdate({ env: { MCP_CONFIRM_TTL_SECONDS: '45' }, spent: createSpentTokenStore() })));
    expect(r.ttlSeconds).toBe(45);
  });

  it('keeps the 2.11.0 hosted defaults: a host secret + absolute MCP_DATA_DIR records spends on disk', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'confirm-write-'));
    try {
      const env = { MCP_HOST_CONFIRM_SECRET: 'h'.repeat(40), MCP_DATA_DIR: dataDir };
      const first = text(await confirmWrite(CANNOT_BE_ASKED, tempoUpdate({ env })));
      expect(await confirmWrite(CANNOT_BE_ASKED, tempoUpdate({ env, confirmToken: first.confirmToken }))).toBeUndefined();
      expect(readdirSync(join(dataDir, '.mcp-confirm', 'spent'))).toHaveLength(1);
      const replay = text(await confirmWrite(CANNOT_BE_ASKED, tempoUpdate({ env, confirmToken: first.confirmToken })));
      expect(replay.error).toBe('TOKEN_REUSED');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('a non-HTTP write binds `payload` and previews `willSend` (defaulting to the payload)', async () => {
    const evite: ConfirmWriteOptions = {
      tool: 'evite_rsvp',
      action: 'evite.rsvp',
      account: undefined,
      target: 'evt-1',
      payload: { eventId: 'evt-1', response: 'yes', adults: 2 },
      willSend: { event_id: 'evt-1', response: 'yes', number_of_adults: 2 },
      preview: { caveat: 'Visible to the host.' },
      confirmToken: undefined,
      env: {},
    };
    const p1 = text(await confirmWrite(CANNOT_BE_ASKED, { ...evite, spent: createSpentTokenStore() }));
    expect(p1.preview).toEqual({ willSend: evite.willSend, caveat: 'Visible to the host.' });
    const { p2 } = await twoPhase(evite, { payload: { eventId: 'evt-1', response: 'no', adults: 2 } });
    expect(text(p2)).toMatchObject({ error: 'DRAFT_CHANGED', reason: 'payload-changed' });

    const plain = text(await confirmWrite(CANNOT_BE_ASKED, { ...evite, willSend: undefined, preview: undefined, spent: createSpentTokenStore() }));
    expect(plain.preview).toEqual({ willSend: evite.payload });
  });
});

describe('confirmWrite — elicitation rail (a client that can be prompted)', () => {
  it('asks with the preview in the prompt and a bound requestState', async () => {
    const r = (await confirmWrite(CAN_BE_ASKED, tempoUpdate())) as {
      resultType: string;
      requestState?: string;
      inputRequests: { confirmation: { params: { message: string } } };
    };
    expect(r.resultType).toBe('input_required');
    expect(typeof r.requestState).toBe('string');
    const msg = r.inputRequests.confirmation.params.message;
    expect(msg.startsWith('Review and confirm: Update worklog 5\n')).toBe(true);
    expect(msg).toContain('"willSend"');
    expect(msg).toContain('/4/worklogs/5');
  });

  it('uses the caller message when given, else a generic one without a summary', async () => {
    const custom = (await confirmWrite(CAN_BE_ASKED, tempoUpdate({ message: 'Review and confirm this Tempo change:' }))) as {
      inputRequests: { confirmation: { params: { message: string } } };
    };
    expect(custom.inputRequests.confirmation.params.message.startsWith('Review and confirm this Tempo change:\n')).toBe(true);
    const generic = (await confirmWrite(CAN_BE_ASKED, tempoUpdate({ summary: undefined }))) as {
      inputRequests: { confirmation: { params: { message: string } } };
    };
    expect(generic.inputRequests.confirmation.params.message.startsWith('Review and confirm this change:\n')).toBe(true);
  });

  async function stateFor(opts: ConfirmWriteOptions): Promise<string> {
    const r = (await confirmWrite(CAN_BE_ASKED, opts)) as { requestState?: string };
    return r.requestState!;
  }

  it('an acceptance carrying the state minted for this exact write proceeds', async () => {
    const state = await stateFor(tempoUpdate());
    expect(await confirmWrite(answered(state), tempoUpdate())).toBeUndefined();
  });

  // None of the fleet copies bound this rail: any accepted `confirmation` on the
  // request passed. The kit binds it to the same thing the token binds.
  it.each<[string, Partial<ConfirmWriteOptions>]>([
    ['body', { request: { method: 'PUT', path: '/4/worklogs/5', body: { timeSpentSeconds: 1 }, query: { notify: true } } }],
    ['query', { request: { method: 'PUT', path: '/4/worklogs/5', body: { timeSpentSeconds: 7200 } } }],
    ['path', { request: { method: 'PUT', path: '/4/worklogs/6', body: { timeSpentSeconds: 7200 }, query: { notify: true } } }],
    ['target', { target: '6' }],
    ['revision', { revision: 'later' }],
    ['account', { account: 'other@example.test' }],
    ['action', { action: 'worklog.delete' }],
  ])('an acceptance replayed onto a different %s is asked again, not honoured', async (_what, change) => {
    const state = await stateFor(tempoUpdate());
    const r = await confirmWrite(answered(state), tempoUpdate(change));
    expect(r).toMatchObject({ resultType: 'input_required' });
  });

  it('an acceptance with no requestState at all is an error, never a proceed', async () => {
    const r = await confirmWrite(answered(undefined), tempoUpdate());
    expect((r as CallToolResult).isError).toBe(true);
  });
});

describe('confirmWrite — misuse is refused loudly', () => {
  it('throws when nothing to bind is given (neither request nor payload)', async () => {
    await expect(confirmWrite(CANNOT_BE_ASKED, tempoUpdate({ request: undefined }))).rejects.toThrow(TypeError);
    await expect(confirmWrite(CAN_BE_ASKED, tempoUpdate({ request: undefined, payload: null }))).rejects.toThrow(TypeError);
  });

  it.each(['action', 'method', 'path', 'willSend', 'willSendQuery'])(
    'throws when preview tries to overwrite the reserved %s field',
    async (key) => {
      await expect(confirmWrite(CANNOT_BE_ASKED, tempoUpdate({ preview: { [key]: 'spoof' } }))).rejects.toThrow(TypeError);
    },
  );

  it('throws on an empty tool or action', async () => {
    await expect(confirmWrite(CANNOT_BE_ASKED, tempoUpdate({ tool: '' }))).rejects.toThrow(TypeError);
    await expect(confirmWrite(CANNOT_BE_ASKED, tempoUpdate({ action: ' ' }))).rejects.toThrow(TypeError);
  });
});

describe('confirmWrite — end to end', () => {
  function register(write: () => CallToolResult) {
    return (server: Parameters<Parameters<typeof createTestHarness>[0]>[0]) => {
      server.registerTool(
        'thing_delete',
        { inputSchema: z.object({ id: z.string(), confirmToken: confirmTokenParam }) },
        async (args, ctx) => {
          const gate = await confirmWrite(ctx, {
            tool: 'thing_delete',
            action: 'thing.delete',
            summary: `Delete thing ${args.id}`,
            account: 'me@example.test',
            target: args.id,
            request: { method: 'DELETE', path: `/things/${args.id}` },
            args,
            confirmToken: args.confirmToken,
            env: {},
            spent: createSpentTokenStore(),
          });
          return gate ?? write();
        },
      );
    };
  }

  it('a client that can be prompted is asked and, on accept, the write runs once', async () => {
    const write = vi.fn(() => textResult({ deleted: true }));
    const h = await createTestHarness(register(write), {
      elicitation: async () => ({ action: 'accept', content: { confirmed: true } }),
    });
    try {
      expect(parseToolResult(await h.callTool('thing_delete', { id: 't1' }))).toEqual({ deleted: true });
      expect(write).toHaveBeenCalledOnce();
    } finally {
      await h.close();
    }
  });

  it('a declined prompt runs nothing', async () => {
    const write = vi.fn(() => textResult({ deleted: true }));
    const h = await createTestHarness(register(write), { elicitation: async () => ({ action: 'decline' }) });
    try {
      expect(parseToolResult(await h.callTool('thing_delete', { id: 't1' }))).toMatchObject({ cancelled: true });
      expect(write).not.toHaveBeenCalled();
    } finally {
      await h.close();
    }
  });
});
