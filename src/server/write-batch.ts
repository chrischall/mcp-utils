/**
 * Batched writes: several gated writes under ONE preview and ONE approval.
 *
 * A multi-step change was one confirmation per step. splitwise-mcp's "log the
 * expense, comment on it, attach the receipt" was six calls and three
 * approvals on a client that cannot be prompted — and the user wanted one
 * thing.
 *
 * A batch needs each write split into its two halves, which a tool handler
 * fuses: {@link defineWrite} declares a write as
 *
 * - `plan(args)` — validate, do any fresh read, and describe the gate (the
 *   `confirmWrite` fields: action, summary, request/payload, target,
 *   revision, account). No side effects.
 * - `execute(state)` — perform it. Only ever called after a gate passed.
 * - `produces` — named outputs a LATER op in a batch may take as an argument
 *   (the id a create returned, say).
 *
 * {@link registerWrite} turns a definition into the ordinary single tool —
 * plan, `confirmWrite`, execute — so a tool written this way behaves exactly
 * like a hand-written gated one. {@link registerBatchTool} adds
 * `<prefix>_batch({ops:[{tool, args, refs?}]})` over every batchable write on
 * the server:
 *
 * 1. Every op is checked BEFORE anything is previewed: the tool exists and is
 *    batchable, its args parse, and each ref names an output an EARLIER op
 *    declares. A malformed batch is refused whole.
 * 2. Ops without refs are planned up front, and their gates are shown and
 *    bound. An op with refs cannot be planned yet (its target does not exist
 *    until the op it depends on runs), so it is shown — and bound — by its
 *    arguments, with each ref as `<output from op N>`; its own checks run when
 *    it executes.
 * 3. One `confirmWrite` for the whole list: one elicitation prompt, or one
 *    phase-1 preview + token. The token binds every op, so it cannot be spent
 *    on a different batch, and it is bound to the BATCH tool, so it never acts
 *    as a single write (nor a single write's token as a batch).
 * 4. Ops run in order and the batch STOPS at the first failure. There is no
 *    rollback — most upstream APIs have none to offer — so the result says
 *    exactly which ops were applied, which failed and which never ran, and
 *    tells the model not to re-run the batch.
 *
 * Refs are a separate per-op field (`refs: { expense_id: "0.expense_id" }`)
 * rather than `"$0"` strings inside `args`: a magic string collides with real
 * text, and fails a `z.number()` argument before it could ever be substituted.
 */
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { currentCallSignal } from '../cancel/index.js';
import { messageOf, redactSecrets } from '../errors/index.js';
import { textResult } from '../response/index.js';
import { confirmTokenParam } from './confirm-token.js';
import { CONFIRM_FLOW_SENTENCE, confirmWrite, type ConfirmWriteOptions } from './confirm-write.js';

/** What a plan hands `confirmWrite`: everything but what the tool supplies itself. */
export type WriteGateFields = Omit<ConfirmWriteOptions, 'tool' | 'confirmToken' | 'args'>;

/** The result of {@link WriteDefinition.plan}. */
export interface WritePlan<State> {
  gate: WriteGateFields;
  /** Whatever `execute` needs — the request body, the loaded file, the fresh read. */
  state: State;
}

/** Tool annotations, as `registerTool` takes them. */
export interface WriteAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

/** A gated write in two halves. Build one with {@link defineWrite}. */
export interface WriteDefinition<Schema extends z.ZodObject = z.ZodObject, State = unknown, Result = unknown> {
  name: string;
  /** The tool description; {@link CONFIRM_FLOW_SENTENCE} is appended. */
  description: string;
  /** The arguments, WITHOUT `confirmToken` (added for you). */
  inputSchema: Schema;
  /** Default: a write that reaches other people — `destructiveHint: true`. */
  annotations?: WriteAnnotations;
  /** Validate, read, describe. Must not change anything. */
  plan(args: z.infer<Schema>, ctx: ServerContext): WritePlan<State> | Promise<WritePlan<State>>;
  /** Do it. Called only after the gate passed. */
  execute(state: State, ctx: ServerContext): Promise<Result>;
  /** The single tool's result. Default: the result as JSON text. */
  render?(result: Result): CallToolResult;
  /** Named outputs a later batch op may take as an argument. */
  produces?: Record<string, (result: Result) => unknown>;
  /** `false` keeps it out of batches. Default `true`. */
  batchable?: boolean;
}

/** Identity, for inference: `args` in `plan` is typed from `inputSchema`. */
export function defineWrite<Schema extends z.ZodObject, State, Result>(
  def: WriteDefinition<Schema, State, Result>,
): WriteDefinition<Schema, State, Result> {
  return def;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a registry of heterogeneous definitions
type AnyWrite = WriteDefinition<z.ZodObject, any, any>;

const writes = new WeakMap<McpServer, Map<string, AnyWrite>>();

const DEFAULT_ANNOTATIONS: WriteAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

/**
 * Register `def` as an ordinary gated tool — plan, `confirmWrite`, execute —
 * and make it available to a batch tool on the same server.
 */
export function registerWrite<Schema extends z.ZodObject, State, Result>(
  server: McpServer,
  def: WriteDefinition<Schema, State, Result>,
): void {
  let map = writes.get(server);
  if (!map) writes.set(server, (map = new Map()));
  map.set(def.name, def as AnyWrite);

  server.registerTool(
    def.name,
    {
      description: `${def.description} ${CONFIRM_FLOW_SENTENCE}`,
      annotations: def.annotations ?? DEFAULT_ANNOTATIONS,
      inputSchema: def.inputSchema.extend({ confirmToken: confirmTokenParam }),
    },
    async (input: Record<string, unknown>, ctx: ServerContext) => {
      const { confirmToken, ...args } = input as Record<string, unknown> & { confirmToken?: string };
      const { gate, state } = await def.plan(args as z.infer<Schema>, ctx);
      const confirmed = await confirmWrite(ctx, { ...gate, tool: def.name, confirmToken, args });
      if (confirmed) return confirmed as CallToolResult;
      const result = await def.execute(state, ctx);
      return def.render ? def.render(result) : textResult(result);
    },
  );
}

/** Options for {@link registerBatchTool}. */
export interface BatchToolOptions {
  /** `<prefix>_batch` by fleet convention. */
  name: string;
  /** Most ops in one batch. Default 10. */
  maxOps?: number;
  /** Prepended to the generated description (which lists the batchable writes). */
  description?: string;
}

const REF = /^(\d+)\.([A-Za-z_][A-Za-z0-9_]*)$/;

interface PreparedOp {
  index: number;
  def: AnyWrite;
  /** Parsed args, minus the ref'd ones. */
  args: Record<string, unknown>;
  refs: Array<{ arg: string; from: number; output: string }>;
}

function refuse(message: string): never {
  throw new Error(message);
}

function prepare(ops: Array<{ tool: string; args: Record<string, unknown>; refs?: Record<string, string> }>, registry: Map<string, AnyWrite>): PreparedOp[] {
  const batchable = [...registry.values()].filter((d) => d.batchable !== false).map((d) => d.name);
  const prepared: PreparedOp[] = [];
  ops.forEach((op, index) => {
    const at = `ops[${index}]`;
    const def = registry.get(op.tool);
    if (!def || def.batchable === false) {
      refuse(`${at}: ${op.tool} is not a write this batch can run (one of: ${batchable.join(', ')})`);
    }
    const shape = def.inputSchema.shape as Record<string, unknown>;
    const refs = Object.entries(op.refs ?? {}).map(([arg, ref]) => {
      const m = REF.exec(ref);
      if (!m) refuse(`${at}: ref ${arg}: "${ref}" is not "<op index>.<output>"`);
      const from = Number(m[1]);
      const output = m[2]!;
      if (!(arg in shape)) refuse(`${at}: ref ${arg}: ${op.tool} has no argument ${arg}`);
      if (arg in op.args) refuse(`${at}: ${arg} is given both in args and in refs — pass one`);
      if (from >= index) refuse(`${at}: ref ${arg} must name an earlier op (got op ${from})`);
      const producer = prepared[from]!.def;
      if (!producer.produces?.[output]) {
        const offered = Object.keys(producer.produces ?? {});
        refuse(`${at}: ref ${arg}: op ${from} (${producer.name}) produces no ${output}${offered.length ? ` (it produces ${offered.join(', ')})` : ''}`);
      }
      return { arg, from, output };
    });
    const schema = refs.length > 0
      ? def.inputSchema.omit(Object.fromEntries(refs.map((r) => [r.arg, true])) as never)
      : def.inputSchema;
    const parsed = schema.safeParse(op.args);
    if (!parsed.success) {
      refuse(`${at} (${op.tool}): ${parsed.error.issues.map((i) => `${i.path.join('.') || 'args'}: ${i.message}`).join('; ')}`);
    }
    prepared.push({ index, def, args: parsed.data as Record<string, unknown>, refs });
  });
  return prepared;
}

/** One op's line in the batch preview. */
function opPreview(op: PreparedOp, gate: WriteGateFields | undefined): Record<string, unknown> {
  if (!gate) {
    const args = { ...op.args };
    for (const r of op.refs) args[r.arg] = `<${r.output} from op ${r.from}>`;
    const after = [...new Set(op.refs.map((r) => r.from))].join(', ');
    return { index: op.index, tool: op.def.name, args, note: `Checked and previewed when it runs, after op ${after}.` };
  }
  const shown = gate.willSend !== undefined ? gate.willSend : gate.request?.body !== undefined ? gate.request.body : gate.payload;
  return {
    index: op.index,
    tool: op.def.name,
    ...(gate.summary === undefined ? {} : { action: gate.summary }),
    ...(gate.request === undefined ? {} : { method: gate.request.method, path: gate.request.path }),
    ...(shown === undefined ? {} : { willSend: shown }),
    ...gate.preview,
  };
}

/** What an op's binding commits to: its args, and its whole gate when it was planned. */
function opBinding(op: PreparedOp, gate: WriteGateFields | undefined): Record<string, unknown> {
  return {
    tool: op.def.name,
    args: op.args,
    ...(op.refs.length > 0 ? { refs: op.refs } : {}),
    ...(gate
      ? {
        gate: {
          action: gate.action,
          target: gate.target === undefined ? '' : String(gate.target),
          revision: gate.revision ?? undefined,
          request: gate.request,
          payload: gate.payload,
          willSend: gate.willSend,
          preview: gate.preview,
        },
      }
      : {}),
  };
}

/**
 * Register `<prefix>_batch`: several writes registered with
 * {@link registerWrite} on this server, previewed and approved once. Register
 * it AFTER those writes — its description lists them.
 */
export function registerBatchTool(server: McpServer, options: BatchToolOptions): void {
  const maxOps = options.maxOps ?? 10;
  const registry = writes.get(server) ?? new Map<string, AnyWrite>();
  writes.set(server, registry);

  const listed = [...registry.values()]
    .filter((d) => d.batchable !== false)
    .map((d) => {
      const produces = Object.keys(d.produces ?? {});
      return produces.length > 0 ? `${d.name} (produces ${produces.join(', ')})` : d.name;
    });

  const description =
    `${options.description ? `${options.description} ` : ''}`
    + `Run up to ${maxOps} writes with ONE preview and ONE approval, in order, stopping at the first failure (no rollback: `
    + 'the result says which ops were applied). Each op is {tool, args, refs?}; args are exactly what that tool takes '
    + '(without confirmToken). refs feeds an earlier op\'s output into an argument, e.g. '
    + '{"tool": "…", "args": {…}, "refs": {"expense_id": "0.expense_id"}} takes expense_id from op 0. '
    + `Writes available: ${listed.join(', ')}. ${CONFIRM_FLOW_SENTENCE}`;

  server.registerTool(
    options.name,
    {
      description,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      inputSchema: z.object({
        ops: z
          .array(
            z.object({
              tool: z.string().describe('A write tool on this server'),
              args: z.record(z.string(), z.unknown()).default({}).describe('Its arguments, without confirmToken'),
              refs: z
                .record(z.string(), z.string())
                .optional()
                .describe('Argument name → "<earlier op index>.<output>", e.g. {"expense_id": "0.expense_id"}'),
            }),
          )
          .min(1)
          .max(maxOps),
        confirmToken: confirmTokenParam,
      }),
    },
    async (input, ctx) => {
      const prepared = prepare(input.ops, registry);

      // Plan what can be planned now: every op with no refs.
      const plans = new Map<number, WritePlan<unknown>>();
      for (const op of prepared) {
        if (op.refs.length === 0) {
          try {
            plans.set(op.index, await op.def.plan(op.args, ctx));
          } catch (err) {
            refuse(`ops[${op.index}] (${op.def.name}): ${messageOf(err)}`);
          }
        }
      }
      const accounts = new Set([...plans.values()].map((p) => p.gate.account));
      if (accounts.size > 1) refuse('A batch runs as one account; these ops would run as several. Split it.');
      const account = accounts.values().next().value;

      const previews = prepared.map((op) => opPreview(op, plans.get(op.index)?.gate));
      const summaries = prepared.map((op) => plans.get(op.index)?.gate.summary ?? `${op.def.name} (after op ${op.refs[0]!.from})`);
      const confirmed = await confirmWrite(ctx, {
        tool: options.name,
        action: 'batch.write',
        summary: `${prepared.length} writes: ${summaries.map((s, i) => `(${i}) ${s}`).join('; ')}`,
        account,
        payload: prepared.map((op) => opBinding(op, plans.get(op.index)?.gate)),
        willSend: previews,
        args: { ops: input.ops },
        confirmToken: input.confirmToken,
      });
      if (confirmed) return confirmed as CallToolResult;

      const results: Array<Record<string, unknown>> = [];
      const outputs = new Map<number, unknown>();
      let failedAt: number | undefined;
      for (const op of prepared) {
        if (currentCallSignal()?.aborted) {
          failedAt = op.index;
          results.push({ index: op.index, tool: op.def.name, applied: false, error: 'cancelled before it ran' });
          break;
        }
        try {
          let plan = plans.get(op.index);
          if (!plan) {
            const args: Record<string, unknown> = { ...op.args };
            for (const r of op.refs) {
              args[r.arg] = prepared[r.from]!.def.produces![r.output]!(outputs.get(r.from));
            }
            plan = await op.def.plan(op.def.inputSchema.parse(args), ctx);
          }
          const result = await op.def.execute(plan.state, ctx);
          outputs.set(op.index, result);
          results.push({ index: op.index, tool: op.def.name, applied: true, result });
        } catch (err) {
          failedAt = op.index;
          results.push({ index: op.index, tool: op.def.name, applied: false, error: redactSecrets(messageOf(err)) });
          break;
        }
      }

      const applied = results.filter((r) => r.applied).map((r) => r.index as number);
      if (failedAt === undefined) return textResult({ status: 'ok', results });
      const notRun = prepared.filter((op) => op.index > failedAt).map((op) => op.index);
      return {
        ...textResult({
          status: applied.length > 0 ? 'partial' : 'failed',
          results,
          not_run: notRun,
          note:
            `No rollback: ${applied.length > 0 ? `op ${applied.join(', ')} ${applied.length > 1 ? 'were' : 'was'} applied` : 'nothing was applied'}`
            + `, op ${failedAt} failed${notRun.length > 0 ? ` and op ${notRun.join(', ')} did not run` : ''}. `
            + 'Do not re-run this batch; preview a new one for what remains.',
        }),
        isError: true,
      };
    },
  );
}
