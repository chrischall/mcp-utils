import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createTestHarness } from '../test/index.js';
import { createPendingCallStore, processPendingCalls } from './confirm-pending.js';
import { registerConfirmTool } from './confirm-replay.js';
import { confirmTokenParam } from './confirm-token.js';
import { confirmWrite } from './confirm-write.js';

// Token-only confirmation. A client that cannot be prompted (claude.ai) gets
// the two-step token flow, and phase 2 used to mean "call again with the SAME
// arguments plus the token" — a multi-megabyte base64 receipt crossed the
// model's context twice. With a confirm tool registered, phase 1 also keeps
// the arguments server-side, and phase 2 can be `<prefix>_confirm({confirmToken})`.

type Json = Record<string, unknown>;
const json = (r: { content: unknown[] }): Json => JSON.parse((r.content[0] as { text: string }).text) as Json;

let revision = 'r1';
let scope: string | undefined;
const write = vi.fn(async (_args: Json) => ({ ok: true }));

function registerThing(server: McpServer, opts: { confirmTool?: boolean } = {}) {
  server.registerTool(
    'thing_update',
    {
      description: 'Update a thing',
      inputSchema: z.object({ id: z.number(), body: z.string(), confirmToken: confirmTokenParam }),
    },
    async (args, ctx) => {
      const gate = await confirmWrite(ctx, {
        tool: 'thing_update',
        action: 'thing.update',
        summary: `Update thing ${args.id}`,
        account: undefined,
        target: args.id,
        revision,
        request: { method: 'PUT', path: `/things/${args.id}`, body: { body: args.body } },
        args,
        confirmToken: args.confirmToken,
      });
      if (gate) return gate as never;
      const out = await write(args);
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    },
  );
  if (opts.confirmTool !== false) {
    registerConfirmTool(server, { name: 'thing_confirm', principalScope: () => scope });
  }
}

const savedEnv = { ...process.env };
beforeEach(() => {
  revision = 'r1';
  scope = undefined;
  write.mockClear();
  processPendingCalls().clear();
  delete process.env.MCP_CONFIRM_MODE;
});
afterEach(() => {
  process.env = { ...savedEnv };
});

describe('registerConfirmTool', () => {
  it('phase 1 names the confirm tool, and confirming with only the token runs the original call once', async () => {
    const h = await createTestHarness((s) => registerThing(s));
    const big = 'x'.repeat(200_000);
    const phase1 = json(await h.callTool('thing_update', { id: 7, body: big }));
    expect(phase1).toMatchObject({ status: 'confirmation-required', confirmTool: 'thing_confirm' });
    expect(String(phase1.instruction)).toContain('thing_confirm');
    expect(write).not.toHaveBeenCalled();

    const result = await h.callTool('thing_confirm', { confirmToken: phase1.confirmToken as string });
    expect(result.isError).toBeFalsy();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]![0]).toMatchObject({ id: 7, body: big });
    await h.close();
  });

  it('acts once: a second confirm with the same token does nothing', async () => {
    const h = await createTestHarness((s) => registerThing(s));
    const { confirmToken } = json(await h.callTool('thing_update', { id: 7, body: 'b' }));
    await h.callTool('thing_confirm', { confirmToken: confirmToken as string });
    const again = await h.callTool('thing_confirm', { confirmToken: confirmToken as string });
    expect(again.isError).toBe(true);
    expect(json(again)).toMatchObject({ error: 'PENDING_NOT_FOUND', dispatched: false });
    expect(write).toHaveBeenCalledTimes(1);
    await h.close();
  });

  it('two concurrent confirms with one token: exactly one acts', async () => {
    const h = await createTestHarness((s) => registerThing(s));
    const { confirmToken } = json(await h.callTool('thing_update', { id: 7, body: 'b' }));
    await Promise.all([
      h.callTool('thing_confirm', { confirmToken: confirmToken as string }),
      h.callTool('thing_confirm', { confirmToken: confirmToken as string }),
    ]);
    expect(write).toHaveBeenCalledTimes(1);
    await h.close();
  });

  it('keeps the old path: the same arguments plus the token still work', async () => {
    const h = await createTestHarness((s) => registerThing(s));
    const { confirmToken } = json(await h.callTool('thing_update', { id: 7, body: 'b' }));
    const result = await h.callTool('thing_update', { id: 7, body: 'b', confirmToken: confirmToken as string });
    expect(result.isError).toBeFalsy();
    expect(write).toHaveBeenCalledTimes(1);
    await h.close();
  });

  it('refuses a token it holds no arguments for, telling the model the full-arguments way', async () => {
    const h = await createTestHarness((s) => registerThing(s));
    const result = await h.callTool('thing_confirm', { confirmToken: 'mcpu.token.v1.nope.nope' });
    expect(result.isError).toBe(true);
    const body = json(result);
    expect(body.error).toBe('PENDING_NOT_FOUND');
    expect(String(body.note)).toMatch(/same arguments plus.*confirmToken/);
    expect(write).not.toHaveBeenCalled();
    await h.close();
  });

  it('a change between the phases is still DRAFT_CHANGED, and the fresh token is confirmable too', async () => {
    const h = await createTestHarness((s) => registerThing(s));
    const { confirmToken } = json(await h.callTool('thing_update', { id: 7, body: 'b' }));
    revision = 'r2';
    const changed = await h.callTool('thing_confirm', { confirmToken: confirmToken as string });
    expect(changed.isError).toBe(true);
    const body = json(changed);
    expect(body).toMatchObject({ error: 'DRAFT_CHANGED', confirmTool: 'thing_confirm' });
    expect(write).not.toHaveBeenCalled();

    const result = await h.callTool('thing_confirm', { confirmToken: body.confirmToken as string });
    expect(result.isError).toBeFalsy();
    expect(write).toHaveBeenCalledTimes(1);
    await h.close();
  });

  it('never replays a call for a different principal', async () => {
    const h = await createTestHarness((s) => registerThing(s));
    scope = 'alice';
    const { confirmToken } = json(await h.callTool('thing_update', { id: 7, body: 'b' }));
    scope = 'bob';
    const result = await h.callTool('thing_confirm', { confirmToken: confirmToken as string });
    expect(result.isError).toBe(true);
    expect(json(result).error).toBe('PENDING_NOT_FOUND');
    expect(write).not.toHaveBeenCalled();
    await h.close();
  });

  it('does not change phase 1 at all on a server without a confirm tool', async () => {
    const h = await createTestHarness((s) => registerThing(s, { confirmTool: false }));
    const phase1 = json(await h.callTool('thing_update', { id: 7, body: 'b' }));
    expect(phase1).not.toHaveProperty('confirmTool');
    expect(phase1.instruction).toBe(
      'Show this preview to the user verbatim and proceed only after they explicitly approve in chat. Then call again with confirmToken.',
    );
    expect(processPendingCalls().size).toBe(0);
    await h.close();
  });

  it('does not keep arguments too large to hold, and says only the full-arguments way', async () => {
    const h = await createTestHarness((s) => {
      registerThing(s, { confirmTool: false });
      registerConfirmTool(s, { name: 'thing_confirm', store: createPendingCallStore({ maxEntryBytes: 100 }) });
    });
    const phase1 = json(await h.callTool('thing_update', { id: 7, body: 'x'.repeat(500) }));
    expect(phase1).not.toHaveProperty('confirmTool');
    await h.close();
  });

  it('describes itself for search and is annotated as the write it performs', async () => {
    const h = await createTestHarness((s) => registerThing(s));
    const tool = (await h.client.listTools()).tools.find((t) => t.name === 'thing_confirm')!;
    expect(tool.description).toMatch(/confirmToken/);
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    await h.close();
  });

  it('an elicitation client confirming still gets the real prompt', async () => {
    // The stash only exists on the token rail, so this is the confirm tool
    // reached by a client that should never need it: nothing to replay.
    const elicitation = vi.fn(async () => ({ action: 'accept' as const, content: { confirmed: true } }));
    const h = await createTestHarness((s) => registerThing(s), { elicitation });
    const result = await h.callTool('thing_confirm', { confirmToken: 'mcpu.token.v1.x.y' });
    expect(json(result).error).toBe('PENDING_NOT_FOUND');
    expect(write).not.toHaveBeenCalled();
    await h.close();
  });
});

describe('createPendingCallStore', () => {
  const call = (tool: string, bytes = 10, exp = Date.now() + 60_000) => ({ tool, args: { a: 'x'.repeat(bytes) }, scope: '', expiresAt: exp });

  it('evicts the oldest entry past maxEntries', () => {
    const store = createPendingCallStore({ maxEntries: 2 });
    store.put('t1', call('a'));
    store.put('t2', call('b'));
    store.put('t3', call('c'));
    expect(store.get('t1')).toBeUndefined();
    expect(store.get('t3')?.tool).toBe('c');
    expect(store.size).toBe(2);
  });

  it('evicts the oldest entries to stay under maxBytes, and refuses one entry over maxEntryBytes', () => {
    const store = createPendingCallStore({ maxBytes: 200, maxEntryBytes: 150 });
    expect(store.put('t1', call('a', 100))).toBe(true);
    expect(store.put('t2', call('b', 100))).toBe(true);
    expect(store.get('t1')).toBeUndefined();
    expect(store.put('t3', call('c', 300))).toBe(false);
    expect(store.get('t3')).toBeUndefined();
  });

  it('drops an entry once its token has expired', () => {
    const store = createPendingCallStore();
    store.put('t1', call('a', 10, Date.now() - 1));
    expect(store.get('t1')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('take() removes what it returns', () => {
    const store = createPendingCallStore();
    store.put('t1', call('a'));
    expect(store.take('t1')?.tool).toBe('a');
    expect(store.take('t1')).toBeUndefined();
  });
});
