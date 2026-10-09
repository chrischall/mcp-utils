import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import {
  CONFIRM_TOKEN_AUTO_INSTRUCTION,
  confirmationFromEnv,
  confirmKeyFromEnv,
  confirmTtlFromEnv,
  readConfirmElicitation,
  readConfirmMode,
} from './confirm-env.js';
import {
  CONFIRM_TOKEN_INSTRUCTION,
  createSpentTokenStore,
  hashConfirmPayload,
  requireConfirmationWithFallback,
  verifyConfirmToken,
} from './confirm-token.js';
import { createFileSpentTokenStore } from './confirm-spent-file.js';

function ctxDeclaring(capabilities: unknown): ServerContext {
  return {
    mcpReq: {
      envelope: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': capabilities,
      },
    },
  } as unknown as ServerContext;
}
const CANNOT_BE_ASKED = ctxDeclaring({ extensions: {} });
const CAN_BE_ASKED = ctxDeclaring({ elicitation: { form: {} } });
const text = (r: unknown) => JSON.parse(((r as CallToolResult).content[0] as { text: string }).text);

afterEach(() => vi.restoreAllMocks());

describe('readConfirmMode', () => {
  it('defaults to ask-user when MCP_CONFIRM_MODE is absent, blank or an unresolved placeholder', () => {
    expect(readConfirmMode({})).toBe('ask-user');
    expect(readConfirmMode({ MCP_CONFIRM_MODE: '' })).toBe('ask-user');
    expect(readConfirmMode({ MCP_CONFIRM_MODE: '${user_config.confirm_mode}' })).toBe('ask-user');
  });

  it.each([['ask-user', 'ask-user'], [' AUTO ', 'auto'], ['Refuse', 'refuse']] as const)('reads %j as %s', (raw, mode) => {
    expect(readConfirmMode({ MCP_CONFIRM_MODE: raw })).toBe(mode);
  });

  it('fails CLOSED on an unrecognised value, and says so on stderr', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(readConfirmMode({ MCP_CONFIRM_MODE: 'yes-please' })).toBe('refuse');
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/MCP_CONFIRM_MODE="yes-please".*refuse/);
    // Once per bad value, not once per gated call.
    expect(readConfirmMode({ MCP_CONFIRM_MODE: 'yes-please' })).toBe('refuse');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('confirmTtlFromEnv', () => {
  it('reads a positive integer MCP_CONFIRM_TTL_SECONDS, else 600', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(confirmTtlFromEnv({})).toBe(600);
    expect(confirmTtlFromEnv({ MCP_CONFIRM_TTL_SECONDS: '45' })).toBe(45);
    for (const bad of ['0', '-1', '1.5', 'soon']) expect(confirmTtlFromEnv({ MCP_CONFIRM_TTL_SECONDS: bad })).toBe(600);
  });
});

// Fleet audit 2026-09-24 BUG-1 (fleet-audit#1055): a typo in the TTL must not
// silently become a 10-minute token window. Like MCP_CONFIRM_MODE, it warns
// once on stderr and the gate fails CLOSED.
describe('an unparseable MCP_CONFIRM_TTL_SECONDS', () => {
  it.each(['60s', '1e3', '30.0', '000', '-5', ' 4 5 '])('%j warns once on stderr, naming the rejected value', (bad) => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(confirmTtlFromEnv({ MCP_CONFIRM_TTL_SECONDS: bad })).toBe(600);
    expect(confirmTtlFromEnv({ MCP_CONFIRM_TTL_SECONDS: bad })).toBe(600);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('MCP_CONFIRM_TTL_SECONDS'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`"${bad.trim()}"`);
    expect(lines[0]).toMatch(/refuse/);
  });

  it('turns the token fallback off (refuse), and the refusal names the variable', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const opts = confirmationFromEnv({
      action: 'thing.pay', message: 'Pay?', tool: 'thing_pay', account: undefined, args: { id: 't1' },
      subject: () => ({ target: 't1', payload: { id: 't1' }, preview: { id: 't1' } }),
      env: { MCP_CONFIRM_TTL_SECONDS: '60s' },
    });
    expect(opts.tokenFallback).toBeUndefined();
    const r = text(await requireConfirmationWithFallback(CANNOT_BE_ASKED, opts));
    expect(r.reason).toBe('confirmation-unsupported');
    expect(r.note).toMatch(/MCP_CONFIRM_TTL_SECONDS/);
  });

  it('a valid or absent TTL never warns', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    confirmTtlFromEnv({});
    confirmTtlFromEnv({ MCP_CONFIRM_TTL_SECONDS: ' 45 ' });
    confirmTtlFromEnv({ MCP_CONFIRM_TTL_SECONDS: '${user_config.confirm_ttl}' });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('confirmKeyFromEnv', () => {
  it('stretches MCP_CONFIRM_SECRET of any length to a stable 32-byte key', () => {
    const key = confirmKeyFromEnv({ MCP_CONFIRM_SECRET: 'short' });
    expect(Buffer.from(key).equals(createHash('sha256').update('short', 'utf8').digest())).toBe(true);
    expect(confirmKeyFromEnv({ MCP_CONFIRM_SECRET: 'short' })).toEqual(key);
  });

  it('is 32 random bytes, fixed for the life of the process, when no secret is set', () => {
    const key = confirmKeyFromEnv({});
    expect(key).toHaveLength(32);
    expect(confirmKeyFromEnv({})).toBe(key);
    expect(Buffer.from(key).equals(Buffer.from(confirmKeyFromEnv({ MCP_CONFIRM_SECRET: 'x' })))).toBe(false);
  });
});

describe('confirmationFromEnv', () => {
  const base = {
    action: 'thing.delete',
    message: 'Review and confirm this deletion.',
    details: { id: 't1' },
    unsupportedNote: 'Delete it in the app instead.',
    tool: 'thing_delete',
    account: undefined,
    args: { id: 't1' },
    subject: () => ({ target: 't1', payload: { id: 't1' }, preview: { id: 't1' } }),
  };

  it('ask-user (the default): the token fallback with the ask-the-user instruction', async () => {
    const opts = confirmationFromEnv({ ...base, env: {} });
    expect(opts.tokenFallback).toMatchObject({ tool: 'thing_delete', ttlSeconds: 600, instruction: CONFIRM_TOKEN_INSTRUCTION });
    const r = text(await requireConfirmationWithFallback(CANNOT_BE_ASKED, opts));
    expect(r).toMatchObject({ status: 'confirmation-required', instruction: CONFIRM_TOKEN_INSTRUCTION, preview: { id: 't1' } });
  });

  it('ask-user honours a caller\'s own instruction wording', () => {
    expect(confirmationFromEnv({ ...base, instruction: 'Send only after approval.', env: {} }).tokenFallback?.instruction)
      .toBe('Send only after approval.');
  });

  it('auto: the token fallback, telling the model it may proceed after reviewing', async () => {
    const opts = confirmationFromEnv({ ...base, instruction: 'ignored in auto', env: { MCP_CONFIRM_MODE: 'auto' } });
    const r = text(await requireConfirmationWithFallback(CANNOT_BE_ASKED, opts));
    expect(r.instruction).toBe(CONFIRM_TOKEN_AUTO_INSTRUCTION);
    expect(CONFIRM_TOKEN_AUTO_INSTRUCTION).toMatch(/MCP_CONFIRM_MODE=auto/);
  });

  it('refuse: no fallback, and the refusal names the switch after the caller\'s note', async () => {
    const opts = confirmationFromEnv({ ...base, env: { MCP_CONFIRM_MODE: 'refuse' } });
    expect(opts.tokenFallback).toBeUndefined();
    const r = text(await requireConfirmationWithFallback(CANNOT_BE_ASKED, opts));
    expect(r.reason).toBe('confirmation-unsupported');
    expect(r.note).toMatch(/Delete it in the app instead\. Set MCP_CONFIRM_MODE=ask-user/);
  });

  it('refuse with no note of its own still names the switch', () => {
    const { unsupportedNote, ...noNote } = base;
    void unsupportedNote;
    expect(confirmationFromEnv({ ...noNote, env: { MCP_CONFIRM_MODE: 'refuse' } }).unsupportedNote).toMatch(/^Set MCP_CONFIRM_MODE/);
  });

  it('never changes what a client that can be prompted sees', async () => {
    for (const mode of ['ask-user', 'auto', 'refuse']) {
      const subject = vi.fn(base.subject);
      const opts = confirmationFromEnv({ ...base, subject, env: { MCP_CONFIRM_MODE: mode } });
      expect(await requireConfirmationWithFallback(CAN_BE_ASKED, opts)).toMatchObject({ resultType: 'input_required' });
      expect(subject).not.toHaveBeenCalled();
    }
  });

  it('carries the env key, TTL, account, token and store through to the fallback', async () => {
    const spent = createSpentTokenStore();
    const env = { MCP_CONFIRM_SECRET: 'fleet-secret', MCP_CONFIRM_TTL_SECONDS: '30' };
    const p1 = text(await requireConfirmationWithFallback(CANNOT_BE_ASKED, confirmationFromEnv({ ...base, account: 'me', spent, env })));
    expect(p1.ttlSeconds).toBe(30);
    const opts = confirmationFromEnv({ ...base, account: 'me', spent, env, confirmToken: p1.confirmToken });
    expect(opts.tokenFallback?.confirmToken).toBe(p1.confirmToken);
    expect(await requireConfirmationWithFallback(CANNOT_BE_ASKED, opts)).toBeUndefined();
    expect(verifyConfirmToken(confirmKeyFromEnv(env), p1.confirmToken, { tool: 'thing_delete', account: 'me', target: 't1', payloadHash: 'x' }, { spent }))
      .toEqual({ ok: false, error: 'TOKEN_REUSED' });
  });

  it('puts the spent-token store on the token fallback only, never on the options themselves (#312)', () => {
    // `spent` belongs to the token rail; a stray top-level copy is an option
    // RequireConfirmationOptions does not declare, handed to every consumer.
    const spent = createSpentTokenStore();
    for (const env of [{}, { MCP_CONFIRM_MODE: 'refuse' }]) {
      const opts = confirmationFromEnv({ ...base, spent, env });
      expect(Object.keys(opts)).not.toContain('spent');
    }
    expect(confirmationFromEnv({ ...base, spent, env: {} }).tokenFallback?.spent).toBe(spent);
  });

  it('reads process.env when no env is passed', () => {
    const before = process.env.MCP_CONFIRM_MODE;
    process.env.MCP_CONFIRM_MODE = 'refuse';
    try {
      expect(confirmationFromEnv(base).tokenFallback).toBeUndefined();
      expect(readConfirmMode()).toBe('refuse');
      expect(confirmTtlFromEnv()).toBeGreaterThan(0);
      expect(confirmKeyFromEnv()).toHaveLength(32);
    } finally {
      if (before === undefined) delete process.env.MCP_CONFIRM_MODE;
      else process.env.MCP_CONFIRM_MODE = before;
    }
  });
});

// A client can declare elicitation yet never show the prompt — opencode 2.0.x
// files it under a session no view renders, so the gated call hangs. The
// operator turns prompts off for that server; nothing here names a client.
describe('readConfirmElicitation', () => {
  it('defaults to on when MCP_CONFIRM_ELICITATION is absent, blank or an unresolved placeholder', () => {
    expect(readConfirmElicitation({})).toBe('on');
    expect(readConfirmElicitation({ MCP_CONFIRM_ELICITATION: '' })).toBe('on');
    expect(readConfirmElicitation({ MCP_CONFIRM_ELICITATION: '${user_config.confirm_elicitation}' })).toBe('on');
  });

  it.each([['on', 'on'], [' OFF ', 'off'], ['Off', 'off']] as const)('reads %j as %s', (raw, value) => {
    expect(readConfirmElicitation({ MCP_CONFIRM_ELICITATION: raw })).toBe(value);
  });

  it('keeps prompts ON for an unrecognised value — the stronger confirmation — and says so on stderr', () => {
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(readConfirmElicitation({ MCP_CONFIRM_ELICITATION: 'no-thanks' })).toBe('on');
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/MCP_CONFIRM_ELICITATION="no-thanks".*on/);
    // Once per bad value, not once per gated call.
    expect(readConfirmElicitation({ MCP_CONFIRM_ELICITATION: 'no-thanks' })).toBe('on');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('confirmationFromEnv with MCP_CONFIRM_ELICITATION=off', () => {
  const base = {
    action: 'thing.delete',
    message: 'Review and confirm this deletion.',
    details: { id: 't1' },
    tool: 'thing_delete',
    account: undefined,
    args: { id: 't1' },
    subject: () => ({ target: 't1', payload: { id: 't1' }, preview: { id: 't1' } }),
  };
  const OFF = { MCP_CONFIRM_ELICITATION: 'off' };

  it('a client that CAN be prompted gets the token preview instead of a prompt', async () => {
    const r = text(await requireConfirmationWithFallback(CAN_BE_ASKED, confirmationFromEnv({ ...base, env: OFF })));
    expect(r).toMatchObject({ status: 'confirmation-required', instruction: CONFIRM_TOKEN_INSTRUCTION, preview: { id: 't1' } });
  });

  it('and the same call plus that token proceeds', async () => {
    const spent = createSpentTokenStore();
    const p1 = text(await requireConfirmationWithFallback(CAN_BE_ASKED, confirmationFromEnv({ ...base, spent, env: OFF })));
    const opts = confirmationFromEnv({ ...base, spent, env: OFF, confirmToken: p1.confirmToken });
    expect(await requireConfirmationWithFallback(CAN_BE_ASKED, opts)).toBeUndefined();
  });

  it('honours MCP_CONFIRM_MODE=auto', async () => {
    const r = text(await requireConfirmationWithFallback(
      CAN_BE_ASKED, confirmationFromEnv({ ...base, env: { ...OFF, MCP_CONFIRM_MODE: 'auto' } }),
    ));
    expect(r.instruction).toBe(CONFIRM_TOKEN_AUTO_INSTRUCTION);
  });

  it('with MCP_CONFIRM_MODE=refuse, refuses outright and names both switches', async () => {
    const subject = vi.fn(base.subject);
    const opts = confirmationFromEnv({ ...base, subject, env: { ...OFF, MCP_CONFIRM_MODE: 'refuse' } });
    const r = text(await requireConfirmationWithFallback(CAN_BE_ASKED, opts));
    expect(r).toMatchObject({ confirmed: false, dispatched: false, reason: 'confirmation-unsupported' });
    expect(r.note).toMatch(/MCP_CONFIRM_ELICITATION=off/);
    expect(r.note).toMatch(/MCP_CONFIRM_MODE=ask-user/);
    expect(subject).not.toHaveBeenCalled();
  });

  it('on (the default) leaves a promptable client on the prompt', async () => {
    const opts = confirmationFromEnv({ ...base, env: { MCP_CONFIRM_ELICITATION: 'on' } });
    expect(opts.elicitation).toBeUndefined();
    expect(await requireConfirmationWithFallback(CAN_BE_ASKED, opts)).toMatchObject({ resultType: 'input_required' });
  });
});

// Fleet audit 2026-09-24 SEC-2 (fleet-audit#1059): with `args`, both rails are
// bound to the tool's validated arguments without per-tool judgement.
describe('confirmationFromEnv with args', () => {
  const subjectIdOnly = () => ({ target: 'm1', payload: { id: 'm1' }, preview: { id: 'm1' } });
  const opts = (args: Record<string, unknown>, extra: Record<string, unknown> = {}) => confirmationFromEnv({
    action: 'message.send', message: 'Send?', tool: 'message_send', account: undefined,
    subject: subjectIdOnly, args, spent: createSpentTokenStore(), env: {}, ...extra,
  });

  it('elicitation rail: binds the acceptance to the action and the arguments (minus confirmToken)', async () => {
    const o = opts({ id: 'm1', body: 'hello', confirmToken: 'ignored' });
    expect(o.binding?.key).toHaveLength(32);
    expect(o.binding?.args).toEqual({ args: { id: 'm1', body: 'hello' } });
    expect(o.binding?.ttlSeconds).toBe(600);
    const r = await requireConfirmationWithFallback(CAN_BE_ASKED, o);
    expect(r).toMatchObject({ resultType: 'input_required' });
    expect(typeof (r as { requestState?: unknown }).requestState).toBe('string');
  });

  it('elicitation rail is bound in refuse mode too, and an explicit binding wins', () => {
    expect(opts({ id: 'm1' }, { env: { MCP_CONFIRM_MODE: 'refuse' } }).binding?.args).toEqual({ args: { id: 'm1' } });
    const own = { key: 'k'.repeat(32), args: { mine: true } };
    expect(opts({ id: 'm1' }, { binding: own }).binding).toBe(own);
  });

  it('token rail: a token issued for one body does not authorise another, even when subject.payload omits it', async () => {
    const spent = createSpentTokenStore();
    const p1 = text(await requireConfirmationWithFallback(CANNOT_BE_ASKED, opts({ id: 'm1', body: 'hello' }, { spent })));
    expect(p1.status).toBe('confirmation-required');
    const swapped = await requireConfirmationWithFallback(
      CANNOT_BE_ASKED,
      opts({ id: 'm1', body: 'something else', confirmToken: p1.confirmToken }, { spent, confirmToken: p1.confirmToken }),
    );
    expect(text(swapped)).toMatchObject({ error: 'DRAFT_CHANGED', reason: 'payload-changed', dispatched: false });
  });

  it('token rail: the same arguments plus the token (which is not itself bound) proceed', async () => {
    const spent = createSpentTokenStore();
    const p1 = text(await requireConfirmationWithFallback(CANNOT_BE_ASKED, opts({ id: 'm1', body: 'hello' }, { spent })));
    expect(await requireConfirmationWithFallback(
      CANNOT_BE_ASKED,
      opts({ body: 'hello', id: 'm1', confirmToken: p1.confirmToken }, { spent, confirmToken: p1.confirmToken }),
    )).toBeUndefined();
  });

  it('token rail: passes a subject read failure back unchanged', async () => {
    const failure: CallToolResult = { content: [{ type: 'text', text: 'Error: gone' }], isError: true };
    const o = confirmationFromEnv({
      action: 'a', message: 'm', tool: 't', account: undefined, subject: async () => failure, args: { id: 1 }, env: {},
    });
    expect(await requireConfirmationWithFallback(CANNOT_BE_ASKED, o)).toBe(failure);
  });

  // 3.0: `args` is required (fleet-audit#979 and siblings). A caller that
  // slips past the type (plain JS, a cast) is refused at runtime rather than
  // minting a token over nothing but the subject.
  it.each([['undefined', undefined], ['null', null]])('throws when args is %s', (_, args) => {
    expect(() => confirmationFromEnv({
      action: 'a', message: 'm', tool: 't_send', account: undefined, subject: subjectIdOnly, env: {},
      args: args as unknown as object,
    })).toThrow(/confirmationFromEnv: t_send passed no args/);
  });
});

// 3.0 (fleet-audit#979, #986, #1066, #1072, #1086, #1089, #1098): `account`
// and `args` are required keys, and both rails bind both.
describe('confirmationFromEnv binds account and args on both rails', () => {
  const subject = () => ({ target: 'm1', payload: { id: 'm1' }, preview: { id: 'm1' } });
  const opts = (account: string | undefined, args: object, extra: Record<string, unknown> = {}) => confirmationFromEnv({
    action: 'message.send', message: 'Send?', tool: 'message_send', account, args, subject,
    env: { MCP_CONFIRM_SECRET: 'bind-test' }, ...extra,
  });

  it('token rail: a token minted for one account is refused for another', async () => {
    const spent = createSpentTokenStore();
    const p1 = text(await requireConfirmationWithFallback(CANNOT_BE_ASKED, opts('alice', { id: 'm1' }, { spent })));
    expect(p1.status).toBe('confirmation-required');
    const other = text(await requireConfirmationWithFallback(
      CANNOT_BE_ASKED, opts('bob', { id: 'm1' }, { spent, confirmToken: p1.confirmToken }),
    ));
    expect(other).toMatchObject({ status: 'confirmation-rejected', error: 'TOKEN_INVALID', dispatched: false });
    const none = text(await requireConfirmationWithFallback(
      CANNOT_BE_ASKED, opts(undefined, { id: 'm1' }, { spent, confirmToken: p1.confirmToken }),
    ));
    expect(none).toMatchObject({ error: 'TOKEN_INVALID', dispatched: false });
    // Not spent by the refusals: the right account still proceeds.
    expect(await requireConfirmationWithFallback(
      CANNOT_BE_ASKED, opts('alice', { id: 'm1' }, { spent, confirmToken: p1.confirmToken }),
    )).toBeUndefined();
  });

  it('token rail: a token minted for one args set is refused for another', async () => {
    const spent = createSpentTokenStore();
    const p1 = text(await requireConfirmationWithFallback(CANNOT_BE_ASKED, opts('alice', { id: 'm1', to: 'x' }, { spent })));
    const swapped = text(await requireConfirmationWithFallback(
      CANNOT_BE_ASKED, opts('alice', { id: 'm1', to: 'y' }, { spent, confirmToken: p1.confirmToken }),
    ));
    expect(swapped).toMatchObject({ error: 'DRAFT_CHANGED', reason: 'payload-changed', dispatched: false });
  });

  // An accepted elicitation, echoing the requestState minted on the first call.
  const acceptedWith = (state: unknown): ServerContext => ({
    mcpReq: {
      envelope: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
      },
      inputResponses: { confirmation: { action: 'accept', content: { confirmed: true } } },
      requestState: () => state,
    },
  }) as unknown as ServerContext;

  async function mint(account: string | undefined, args: object): Promise<string> {
    const r = await requireConfirmationWithFallback(CAN_BE_ASKED, opts(account, args)) as { requestState?: string };
    expect(typeof r.requestState).toBe('string');
    return r.requestState!;
  }

  it('elicitation rail: the binding commits to the account as well as the args', () => {
    expect(opts('alice', { id: 'm1' }).binding?.args).toEqual({ account: 'alice', args: { id: 'm1' } });
    expect(opts(undefined, { id: 'm1' }).binding?.args).toEqual({ args: { id: 'm1' } });
  });

  it('elicitation rail: an acceptance minted for one account is asked again for another', async () => {
    const state = await mint('alice', { id: 'm1' });
    expect(await requireConfirmationWithFallback(acceptedWith(state), opts('alice', { id: 'm1' }))).toBeUndefined();
    expect(await requireConfirmationWithFallback(acceptedWith(state), opts('bob', { id: 'm1' })))
      .toMatchObject({ resultType: 'input_required' });
    expect(await requireConfirmationWithFallback(acceptedWith(state), opts(undefined, { id: 'm1' })))
      .toMatchObject({ resultType: 'input_required' });
  });

  it('elicitation rail: an acceptance minted for one args set is asked again for another', async () => {
    const state = await mint('alice', { id: 'm1', to: 'x' });
    expect(await requireConfirmationWithFallback(acceptedWith(state), opts('alice', { id: 'm1', to: 'y' })))
      .toMatchObject({ resultType: 'input_required' });
  });
});

describe('a host-provided stable key, and where spends are recorded (fleet audit 2026-09-24, kiaaccess BUG-2)', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'mcpu-confirm-env-')); });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));
  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  const spentDir = () => join(dataDir, '.mcp-confirm', 'spent');
  const base = {
    action: 'thing.delete',
    message: 'Review and confirm this deletion.',
    tool: 'thing_delete',
    account: undefined,
    args: { id: 't1' },
    subject: () => ({ target: 't1', payload: { id: 't1' }, preview: { id: 't1' } }),
  };

  it('honours MCP_HOST_CONFIRM_SECRET when MCP_DATA_DIR names an absolute directory', () => {
    const key = confirmKeyFromEnv({ MCP_HOST_CONFIRM_SECRET: 'host', MCP_DATA_DIR: dataDir });
    expect(Buffer.from(key).equals(sha('host'))).toBe(true);
  });

  it.each([
    ['no MCP_DATA_DIR', {}],
    ['a blank one', { MCP_DATA_DIR: '  ' }],
    ['an unexpanded placeholder', { MCP_DATA_DIR: '${MCP_DATA_DIR}' }],
    ['a relative one', { MCP_DATA_DIR: 'data' }],
  ])('IGNORES MCP_HOST_CONFIRM_SECRET with %s: a stable key with nowhere durable to record spends would re-accept a spent token after a restart', (_, extra) => {
    const key = confirmKeyFromEnv({ MCP_HOST_CONFIRM_SECRET: 'host', ...extra });
    expect(Buffer.from(key).equals(sha('host'))).toBe(false);
    expect(key).toBe(confirmKeyFromEnv({}));
  });

  it('an operator\'s own MCP_CONFIRM_SECRET wins over the host\'s', () => {
    const key = confirmKeyFromEnv({ MCP_CONFIRM_SECRET: 'mine', MCP_HOST_CONFIRM_SECRET: 'host', MCP_DATA_DIR: dataDir });
    expect(Buffer.from(key).equals(sha('mine'))).toBe(true);
  });

  async function spendOnce(env: Record<string, string>) {
    const p1 = text(await requireConfirmationWithFallback(CANNOT_BE_ASKED, confirmationFromEnv({ ...base, env })));
    const confirmToken = p1.confirmToken as string;
    const p2 = await requireConfirmationWithFallback(CANNOT_BE_ASKED, confirmationFromEnv({ ...base, env, confirmToken }));
    expect(p2).toBeUndefined();
    return confirmToken;
  }

  it.each([
    ['the host key', { MCP_HOST_CONFIRM_SECRET: 'host' }],
    ['an operator key', { MCP_CONFIRM_SECRET: 'mine' }],
  ])('with %s and MCP_DATA_DIR, a spend is recorded on disk and survives a restart', async (_, secret) => {
    const env = { ...secret, MCP_DATA_DIR: dataDir };
    const confirmToken = await spendOnce(env);
    expect(readdirSync(spentDir())).toHaveLength(1);
    // A restarted process has no memory of the spend; the directory does.
    const verdict = verifyConfirmToken(
      confirmKeyFromEnv(env),
      confirmToken,
      { tool: 'thing_delete', target: 't1', payloadHash: hashConfirmPayload({ payload: { id: 't1' }, args: { id: 't1' } }) },
      { spent: createFileSpentTokenStore(spentDir()) },
    );
    expect(verdict).toEqual({ ok: false, error: 'TOKEN_REUSED' });
    // And through the env layer itself, the second use is refused.
    const again = text(await requireConfirmationWithFallback(CANNOT_BE_ASKED, confirmationFromEnv({ ...base, env, confirmToken })));
    expect(again).toMatchObject({ status: 'confirmation-rejected', error: 'TOKEN_REUSED' });
  });

  it('a random per-process key never touches the disk: its tokens cannot outlive the process anyway', async () => {
    await spendOnce({ MCP_DATA_DIR: dataDir });
    expect(existsSync(join(dataDir, '.mcp-confirm'))).toBe(false);
  });

  it('a caller\'s own spent store still wins', async () => {
    const spent = createSpentTokenStore();
    const opts = confirmationFromEnv({ ...base, spent, env: { MCP_HOST_CONFIRM_SECRET: 'host', MCP_DATA_DIR: dataDir } });
    expect(opts.tokenFallback?.spent).toBe(spent);
  });
});
