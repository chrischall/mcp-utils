import type { McpServer } from '@modelcontextprotocol/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createTestHarness } from '../test/index.js';
import { processPendingCalls } from './confirm-pending.js';
import { registerConfirmTool } from './confirm-replay.js';
import { currentCallSignal } from '../cancel/index.js';
import { defineWrite, registerBatchTool, registerWrite } from './write-batch.js';

// Several writes, one preview, one approval: "create the expense, comment on
// it, attach the receipt" was six calls and three approvals.

type Json = Record<string, unknown>;
const json = (r: { content: unknown[] }): Json => JSON.parse((r.content[0] as { text: string }).text) as Json;

let nextId = 100;
const created = vi.fn(async (name: string) => ({ thing: { id: nextId++, name } }));
const commented = vi.fn(async (_id: number, _text: string) => ({ comment: { id: 1 } }));
let failComment = false;
let account: string | undefined;

const thingCreate = defineWrite({
  name: 'thing_create',
  description: 'Create a thing.',
  inputSchema: z.object({ name: z.string().min(1) }),
  plan: (args) => ({
    gate: {
      action: 'thing.create',
      summary: `Create thing "${args.name}"`,
      account,
      request: { method: 'POST', path: '/things', body: { name: args.name } },
    },
    state: args.name,
  }),
  execute: (name) => created(name),
  produces: { thing_id: (r) => r.thing.id },
});

const thingComment = defineWrite({
  name: 'thing_comment',
  description: 'Comment on a thing.',
  inputSchema: z.object({ thing_id: z.number(), text: z.string() }),
  plan: (args) => {
    if (args.text === 'bad') throw new Error('text may not be "bad"');
    return {
      gate: {
        action: 'thing.comment',
        summary: `Comment on thing ${args.thing_id}`,
        account: undefined,
        target: args.thing_id,
        request: { method: 'POST', path: `/things/${args.thing_id}/comments`, body: { text: args.text } },
      },
      state: args,
    };
  },
  execute: async (args) => {
    if (failComment) throw new Error('upstream said no');
    return commented(args.thing_id, args.text);
  },
});

const thingLocked = defineWrite({
  name: 'thing_lock',
  description: 'Not batchable.',
  inputSchema: z.object({ id: z.number() }),
  batchable: false,
  plan: (args) => ({ gate: { action: 'thing.lock', account: undefined, target: args.id, payload: args }, state: args }),
  execute: async () => ({}),
});

function register(server: McpServer) {
  registerWrite(server, thingCreate);
  registerWrite(server, thingComment);
  registerWrite(server, thingLocked);
  registerBatchTool(server, { name: 'thing_batch' });
}

beforeEach(() => {
  nextId = 100;
  failComment = false;
  account = undefined;
  created.mockClear();
  commented.mockClear();
  processPendingCalls().clear();
});
afterEach(() => vi.restoreAllMocks());

async function confirmBatch(h: Awaited<ReturnType<typeof createTestHarness>>, ops: unknown[]) {
  const phase1 = json(await h.callTool('thing_batch', { ops }));
  expect(phase1.status).toBe('confirmation-required');
  expect(created).not.toHaveBeenCalled();
  expect(commented).not.toHaveBeenCalled();
  const result = await h.callTool('thing_batch', { ops, confirmToken: phase1.confirmToken as string });
  return { phase1, result };
}

describe('registerWrite', () => {
  it('is an ordinary gated tool: preview first, then the write once with the token', async () => {
    const h = await createTestHarness(register);
    const phase1 = json(await h.callTool('thing_create', { name: 'kettle' }));
    expect(phase1.preview).toEqual({ action: 'Create thing "kettle"', method: 'POST', path: '/things', willSend: { name: 'kettle' } });
    const result = await h.callTool('thing_create', { name: 'kettle', confirmToken: phase1.confirmToken as string });
    expect(json(result)).toEqual({ thing: { id: 100, name: 'kettle' } });
    expect(created).toHaveBeenCalledTimes(1);
    await h.close();
  });

  it('adds confirmToken to the schema', async () => {
    const h = await createTestHarness(register);
    const tool = (await h.client.listTools()).tools.find((t) => t.name === 'thing_create')!;
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual(['name', 'confirmToken']);
    await h.close();
  });
});

describe('registerBatchTool', () => {
  it('previews every op under one token, then runs them in order, feeding one op\'s output into the next', async () => {
    const h = await createTestHarness(register);
    const ops = [
      { tool: 'thing_create', args: { name: 'kettle' } },
      { tool: 'thing_comment', args: { text: 'bought at the market' }, refs: { thing_id: '0.thing_id' } },
    ];
    const { phase1, result } = await confirmBatch(h, ops);
    expect(String((phase1.preview as Json).action)).toMatch(/2 writes/);
    expect((phase1.preview as Json).willSend).toEqual([
      { index: 0, tool: 'thing_create', action: 'Create thing "kettle"', method: 'POST', path: '/things', willSend: { name: 'kettle' } },
      {
        index: 1,
        tool: 'thing_comment',
        args: { text: 'bought at the market', thing_id: '<thing_id from op 0>' },
        note: 'Checked and previewed when it runs, after op 0.',
      },
    ]);

    expect(result.isError).toBeFalsy();
    expect(json(result)).toMatchObject({
      status: 'ok',
      results: [
        { index: 0, tool: 'thing_create', applied: true, result: { thing: { id: 100 } } },
        { index: 1, tool: 'thing_comment', applied: true },
      ],
    });
    expect(commented).toHaveBeenCalledWith(100, 'bought at the market');
    await h.close();
  });

  it('stops at the first failure and says what was applied, with no rollback', async () => {
    failComment = true;
    const h = await createTestHarness(register);
    const ops = [
      { tool: 'thing_create', args: { name: 'a' } },
      { tool: 'thing_comment', args: { text: 'x' }, refs: { thing_id: '0.thing_id' } },
      { tool: 'thing_create', args: { name: 'b' } },
    ];
    const { result } = await confirmBatch(h, ops);
    expect(result.isError).toBe(true);
    const body = json(result);
    expect(body).toMatchObject({
      status: 'partial',
      results: [
        { index: 0, applied: true },
        { index: 1, applied: false, error: 'upstream said no' },
      ],
      not_run: [2],
    });
    expect(String(body.note)).toMatch(/No rollback.*op 0.*Do not re-run/);
    expect(created).toHaveBeenCalledTimes(1);
    await h.close();
  });

  it('a check that fails on an op with refs stops the batch at that op', async () => {
    const h = await createTestHarness(register);
    const { result } = await confirmBatch(h, [
      { tool: 'thing_create', args: { name: 'a' } },
      { tool: 'thing_comment', args: { text: 'bad' }, refs: { thing_id: '0.thing_id' } },
    ]);
    expect(json(result)).toMatchObject({ status: 'partial', results: [{ applied: true }, { applied: false, error: 'text may not be "bad"' }] });
    await h.close();
  });

  it.each([
    [[{ tool: 'thing_nope', args: {} }], /ops\[0\].*thing_nope.*thing_create/],
    [[{ tool: 'thing_lock', args: { id: 1 } }], /ops\[0\].*thing_lock/],
    [[{ tool: 'thing_comment', args: { text: 'x' }, refs: { thing_id: '0.thing_id' } }], /ops\[0\].*earlier op/],
    [[{ tool: 'thing_create', args: { name: 'a' } }, { tool: 'thing_comment', args: { text: 'x' }, refs: { thing_id: '0.nope' } }], /ops\[1\].*nope/],
    [[{ tool: 'thing_create', args: { name: 'a' } }, { tool: 'thing_comment', args: { text: 'x', thing_id: 5 }, refs: { thing_id: '0.thing_id' } }], /ops\[1\].*thing_id.*both/],
    [[{ tool: 'thing_create', args: { name: '' } }], /ops\[0\]/],
    [[{ tool: 'thing_comment', args: { thing_id: 1, text: 'bad' } }], /ops\[0\].*bad/],
  ])('refuses a malformed batch before anything is previewed or run: %j', async (ops, message) => {
    const h = await createTestHarness(register);
    const result = await h.callTool('thing_batch', { ops });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(message);
    expect(created).not.toHaveBeenCalled();
    await h.close();
  });

  it('refuses ops that run as different accounts', async () => {
    const h = await createTestHarness((s) => {
      register(s);
      registerWrite(s, defineWrite({
        name: 'thing_other',
        description: 'x',
        inputSchema: z.object({}),
        plan: () => ({ gate: { action: 'x', account: 'other', payload: {} }, state: null }),
        execute: async () => ({}),
      }));
    });
    const result = await h.callTool('thing_batch', { ops: [{ tool: 'thing_create', args: { name: 'a' } }, { tool: 'thing_other', args: {} }] });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(/account/);
    await h.close();
  });

  it('a batch token never works on a single tool', async () => {
    const h = await createTestHarness(register);
    const ops = [{ tool: 'thing_create', args: { name: 'a' } }];
    const { confirmToken } = json(await h.callTool('thing_batch', { ops }));
    const result = await h.callTool('thing_create', { name: 'a', confirmToken: confirmToken as string });
    expect(json(result).error).toBe('TOKEN_INVALID');
    expect(created).not.toHaveBeenCalled();
    await h.close();
  });

  it('changing the ops between the phases is DRAFT_CHANGED', async () => {
    const h = await createTestHarness(register);
    const { confirmToken } = json(await h.callTool('thing_batch', { ops: [{ tool: 'thing_create', args: { name: 'a' } }] }));
    const result = await h.callTool('thing_batch', { ops: [{ tool: 'thing_create', args: { name: 'b' } }], confirmToken: confirmToken as string });
    expect(json(result).error).toBe('DRAFT_CHANGED');
    expect(created).not.toHaveBeenCalled();
    await h.close();
  });

  it('asks an elicitation client once for the whole batch', async () => {
    const elicitation = vi.fn(async () => ({ action: 'accept' as const, content: { confirmed: true } }));
    const h = await createTestHarness(register, { elicitation });
    const result = await h.callTool('thing_batch', {
      ops: [
        { tool: 'thing_create', args: { name: 'a' } },
        { tool: 'thing_comment', args: { text: 'x' }, refs: { thing_id: '0.thing_id' } },
      ],
    });
    expect(elicitation).toHaveBeenCalledTimes(1);
    expect(json(result).status).toBe('ok');
    await h.close();
  });

  it('is confirmable with the token alone where a confirm tool is registered', async () => {
    const h = await createTestHarness((s) => {
      register(s);
      registerConfirmTool(s, { name: 'thing_confirm' });
    });
    const ops = [{ tool: 'thing_create', args: { name: 'a' } }, { tool: 'thing_comment', args: { text: 'x' }, refs: { thing_id: '0.thing_id' } }];
    const phase1 = json(await h.callTool('thing_batch', { ops }));
    expect(phase1.confirmTool).toBe('thing_confirm');
    const result = await h.callTool('thing_confirm', { confirmToken: phase1.confirmToken as string });
    expect(json(result).status).toBe('ok');
    expect(commented).toHaveBeenCalledTimes(1);
    await h.close();
  });

  it('has no op cap by default', async () => {
    const h = await createTestHarness((s) => {
      registerWrite(s, thingCreate);
      registerBatchTool(s, { name: 'thing_batch' });
    });
    const ops = Array.from({ length: 25 }, (_, i) => ({ tool: 'thing_create', args: { name: `t${i}` } }));
    const { result } = await confirmBatch(h, ops);
    expect(json(result).status).toBe('ok');
    expect(created).toHaveBeenCalledTimes(25);
    const tool = (await h.client.listTools()).tools.find((t) => t.name === 'thing_batch')!;
    expect(tool.description).not.toMatch(/up to \d+ writes/);
    await h.close();
  });

  it('takes a cap from MCP_BATCH_MAX_OPS, and the maxOps option over it', async () => {
    vi.stubEnv('MCP_BATCH_MAX_OPS', '2');
    const op = { tool: 'thing_create', args: { name: 'a' } };
    const fromEnv = await createTestHarness((s) => {
      registerWrite(s, thingCreate);
      registerBatchTool(s, { name: 'thing_batch' });
    });
    expect((await fromEnv.callTool('thing_batch', { ops: [op, op, op] })).isError).toBe(true);
    const tool = (await fromEnv.client.listTools()).tools.find((t) => t.name === 'thing_batch')!;
    expect(tool.description).toContain('up to 2 writes');
    await fromEnv.close();

    const fromOption = await createTestHarness((s) => {
      registerWrite(s, thingCreate);
      registerBatchTool(s, { name: 'thing_batch', maxOps: 3 });
    });
    expect(json(await fromOption.callTool('thing_batch', { ops: [op, op, op] })).status).toBe('confirmation-required');
    await fromOption.close();
    vi.unstubAllEnvs();
  });

  // fleet-audit#1447: the one value an operator sets to turn batches OFF
  // must not widen them to unlimited. Unset stays uncapped (#387); 0 refuses
  // every batch; anything unparseable (a negative, a typo) is a config error
  // that refuses every batch with a message naming it, rather than guessing.
  it.each([
    ['0', /turned off/],
    ['-5', /MCP_BATCH_MAX_OPS=\\?"-5\\?" is not a whole number/],
    ['ten', /MCP_BATCH_MAX_OPS=\\?"ten\\?" is not a whole number/],
  ])('MCP_BATCH_MAX_OPS=%s refuses every batch instead of meaning "no cap"', async (raw, message) => {
    vi.stubEnv('MCP_BATCH_MAX_OPS', raw);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const h = await createTestHarness((s) => {
      registerWrite(s, thingCreate);
      registerBatchTool(s, { name: 'thing_batch' });
    });
    const tool = (await h.client.listTools()).tools.find((t) => t.name === 'thing_batch')!;
    expect(tool.description).toMatch(message);
    const result = await h.callTool('thing_batch', { ops: [{ tool: 'thing_create', args: { name: 'a' } }] });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(message);
    expect(created).not.toHaveBeenCalled();
    await h.close();
    vi.unstubAllEnvs();
  });

  it('warns once on stderr about an unparseable MCP_BATCH_MAX_OPS', async () => {
    vi.stubEnv('MCP_BATCH_MAX_OPS', 'eleven');
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const h = await createTestHarness((s) => {
      registerWrite(s, thingCreate);
      registerBatchTool(s, { name: 'thing_batch' });
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('MCP_BATCH_MAX_OPS="eleven"'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('refused'));
    await h.close();
    vi.unstubAllEnvs();
  });

  // fleet-audit#1449: the plan loop runs fresh reads before anything is
  // previewed; a cancelled call must stop there and mint no token.
  it('stops planning and mints no token once the call is cancelled', async () => {
    const controller = new AbortController();
    const planned = vi.fn();
    const h = await createTestHarness((s) => {
      registerWrite(s, defineWrite({
        name: 'thing_slow',
        description: 'x',
        inputSchema: z.object({ n: z.number() }),
        // A swallow-style plan: its advisory read fails on cancel and it
        // carries on, as splitwise's `readExpense().catch(() => undefined)` does.
        plan: async (args) => {
          planned(args.n);
          if (args.n === 0) {
            controller.abort(new Error('caller went away'));
            await vi.waitFor(() => expect(currentCallSignal()?.aborted).toBe(true));
          }
          return { gate: { action: 'thing.slow', account: undefined, payload: args }, state: args };
        },
        execute: async () => ({}),
      }));
      registerBatchTool(s, { name: 'thing_batch' });
      registerConfirmTool(s, { name: 'thing_confirm' });
    });
    const ops = [0, 1, 2].map((n) => ({ tool: 'thing_slow', args: { n } }));
    const call = h.client.callTool({ name: 'thing_batch', arguments: { ops } }, { signal: controller.signal });
    await expect(call).rejects.toThrow(/caller went away/);
    // Let the handler finish what it was doing when the cancel landed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(planned).toHaveBeenCalledTimes(1);
    expect(processPendingCalls().size, 'a phase-1 token was minted for a cancelled call').toBe(0);
    await h.close();
  });

  // fleet-audit#1451: an op with refs is planned when it runs; its gate must
  // still obey the batch's one-account rule rather than being thrown away.
  it('fails a ref\'d op whose plan runs as a different account than the batch', async () => {
    account = 'me';
    const executed = vi.fn(async () => ({}));
    const h = await createTestHarness((s) => {
      registerWrite(s, thingCreate);
      registerWrite(s, defineWrite({
        name: 'thing_elsewhere',
        description: 'x',
        inputSchema: z.object({ thing_id: z.number() }),
        // The account comes from inside plan, not from the previewed args.
        plan: (args) => ({ gate: { action: 'thing.elsewhere', account: 'someone-else', target: args.thing_id, payload: args }, state: args }),
        execute: executed,
      }));
      registerBatchTool(s, { name: 'thing_batch' });
    });
    const { result } = await confirmBatch(h, [
      { tool: 'thing_create', args: { name: 'a' } },
      { tool: 'thing_elsewhere', args: {}, refs: { thing_id: '0.thing_id' } },
    ]);
    expect(result.isError).toBe(true);
    expect(json(result)).toMatchObject({
      status: 'partial',
      results: [{ index: 0, applied: true }, { index: 1, applied: false, error: expect.stringMatching(/account/) }],
    });
    expect(executed).not.toHaveBeenCalled();
    await h.close();
  });

  it('reports the action a ref\'d op\'s own gate described when it ran', async () => {
    const h = await createTestHarness(register);
    const { result } = await confirmBatch(h, [
      { tool: 'thing_create', args: { name: 'a' } },
      { tool: 'thing_comment', args: { text: 'x' }, refs: { thing_id: '0.thing_id' } },
    ]);
    expect(json(result)).toMatchObject({ status: 'ok', results: [{ index: 0 }, { index: 1, action: 'Comment on thing 100' }] });
    await h.close();
  });

  // fleet-audit#1445: prototype-chain names must be refused up front like any
  // other unknown argument or output, not discovered at execute time.
  it.each([
    [{ toString: '0.thing_id' }, /ops\[1\].*no argument toString/],
    [{ constructor: '0.thing_id' }, /ops\[1\].*no argument constructor/],
    [{ thing_id: '0.toString' }, /ops\[1\].*produces no toString/],
    [{ thing_id: '0.constructor' }, /ops\[1\].*produces no constructor/],
    [{ thing_id: '0.hasOwnProperty' }, /ops\[1\].*produces no hasOwnProperty/],
  ])('refuses a ref that names a prototype member before anything is previewed: %j', async (refs, message) => {
    const h = await createTestHarness(register);
    const result = await h.callTool('thing_batch', {
      ops: [{ tool: 'thing_create', args: { name: 'a' } }, { tool: 'thing_comment', args: { text: 'x' }, refs }],
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toMatch(message);
    expect(created).not.toHaveBeenCalled();
    await h.close();
  });

  it('refuses a __proto__ ref before anything is previewed', async () => {
    const h = await createTestHarness(register);
    // JSON.parse makes __proto__ an OWN key, the way it arrives on the wire.
    const ops = JSON.parse('[{"tool":"thing_create","args":{"name":"a"}},{"tool":"thing_comment","args":{"text":"x"},"refs":{"__proto__":"0.thing_id"}}]') as unknown[];
    const result = await h.callTool('thing_batch', { ops });
    expect(result.isError).toBe(true);
    expect(created).not.toHaveBeenCalled();
    await h.close();
  });

  it('refuses a maxOps option that is not a positive whole number', () => {
    expect(() => registerBatchTool({} as McpServer, { name: 'x', maxOps: 0 })).toThrow(/maxOps/);
    expect(() => registerBatchTool({} as McpServer, { name: 'x', maxOps: 2.5 })).toThrow(/maxOps/);
  });

  it('caps the number of ops when maxOps is set', async () => {
    const h = await createTestHarness((s) => {
      registerWrite(s, thingCreate);
      registerBatchTool(s, { name: 'thing_batch', maxOps: 2 });
    });
    const op = { tool: 'thing_create', args: { name: 'a' } };
    const result = await h.callTool('thing_batch', { ops: [op, op, op] });
    expect(result.isError).toBe(true);
    await h.close();
  });

  it('lists the batchable writes in its description', async () => {
    const h = await createTestHarness(register);
    const tool = (await h.client.listTools()).tools.find((t) => t.name === 'thing_batch')!;
    expect(tool.description).toContain('thing_create');
    expect(tool.description).toContain('thing_comment');
    expect(tool.description).not.toContain('thing_lock');
    expect(tool.description).toMatch(/thing_create.*produces thing_id/);
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    await h.close();
  });
});
