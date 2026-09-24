import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { createTestHarness, parseToolResult } from '../test/index.js';
import { textResult } from '../response/index.js';
import {
  CONFIRM_TOKEN_INSTRUCTION,
  confirmTokenParam,
  createSpentTokenStore,
  hashConfirmPayload,
  issueConfirmToken,
  requireConfirmationWithFallback,
  verifyConfirmToken,
  type ConfirmSubject,
  type ConfirmTokenBinding,
  type ConfirmTokenFallback,
} from './confirm-token.js';

const KEY = 'k'.repeat(32);
const NOW = 1_800_000_000_000;

const BINDING: ConfirmTokenBinding = {
  tool: 'mail_send_draft',
  account: 'me@example.com',
  target: 'draft-1',
  revision: 'msg-1',
  payloadHash: hashConfirmPayload({ to: 'a@example.com', body: 'hello' }),
};

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

afterEach(() => vi.useRealTimers());

describe('hashConfirmPayload', () => {
  it('ignores key order and undefined fields, but not array order or null', () => {
    expect(hashConfirmPayload({ a: 1, b: { c: 2 } })).toBe(hashConfirmPayload({ b: { c: 2 }, a: 1, z: undefined }));
    expect(hashConfirmPayload({ to: ['a', 'b'] })).not.toBe(hashConfirmPayload({ to: ['b', 'a'] }));
    expect(hashConfirmPayload({ a: null })).not.toBe(hashConfirmPayload({}));
  });

  it('distinguishes bytes from a look-alike string (typed canonicalisation)', () => {
    expect(hashConfirmPayload({ f: Buffer.from('two') })).not.toBe(hashConfirmPayload({ f: 'dHdv' }));
  });
});

describe('canonicalisation errors say where they came from', () => {
  it.each([
    ['a function', { f: () => 1 }, /^confirmation: cannot bind a function argument value\.$/],
    ['a class instance', { d: new (class Thing {})() }, /^confirmation: cannot bind a non-plain object argument value \(class instance\)\.$/],
  ])('%s', (_label, payload, message) => {
    expect(() => hashConfirmPayload(payload)).toThrow(message);
  });
});

describe('issueConfirmToken / verifyConfirmToken', () => {
  const store = () => createSpentTokenStore();

  it('accepts a fresh token for exactly its binding, once', () => {
    const spent = store();
    const { token, expiresAt } = issueConfirmToken(KEY, BINDING, { now: NOW });
    expect(expiresAt).toBe(new Date(NOW + 600_000).toISOString());
    expect(verifyConfirmToken(KEY, token, BINDING, { spent, now: NOW })).toEqual({ ok: true });
    expect(verifyConfirmToken(KEY, token, BINDING, { spent, now: NOW })).toEqual({ ok: false, error: 'TOKEN_REUSED' });
  });

  it('expires after ttlSeconds', () => {
    const { token } = issueConfirmToken(KEY, BINDING, { now: NOW, ttlSeconds: 5 });
    expect(verifyConfirmToken(KEY, token, BINDING, { spent: store(), now: NOW + 5_001 })).toEqual({ ok: false, error: 'TOKEN_EXPIRED' });
  });

  it('reports a rotated revision and a changed payload as DRAFT_CHANGED, without spending the token', () => {
    const spent = store();
    const { token } = issueConfirmToken(KEY, BINDING, { now: NOW });
    expect(verifyConfirmToken(KEY, token, { ...BINDING, revision: 'msg-2' }, { spent, now: NOW }))
      .toEqual({ ok: false, error: 'DRAFT_CHANGED', reason: 'revision-changed' });
    expect(verifyConfirmToken(KEY, token, { ...BINDING, payloadHash: hashConfirmPayload({ x: 1 }) }, { spent, now: NOW }))
      .toEqual({ ok: false, error: 'DRAFT_CHANGED', reason: 'payload-changed' });
    expect(verifyConfirmToken(KEY, token, BINDING, { spent, now: NOW })).toEqual({ ok: true });
  });

  it.each([
    ['tool', { tool: 'other' }],
    ['account', { account: 'other@example.com' }],
    ['target', { target: 'draft-2' }],
  ] as const)('never accepts a token issued for a different %s', (_l, override) => {
    const { token } = issueConfirmToken(KEY, BINDING, { now: NOW });
    expect(verifyConfirmToken(KEY, token, { ...BINDING, ...override }, { spent: store(), now: NOW }))
      .toEqual({ ok: false, error: 'TOKEN_INVALID' });
  });

  it('binds a missing account and revision as absent, not as a wildcard', () => {
    const bare = { tool: 't', target: 'x', payloadHash: 'h' };
    const { token } = issueConfirmToken(KEY, bare, { now: NOW });
    expect(verifyConfirmToken(KEY, token, bare, { spent: store(), now: NOW })).toEqual({ ok: true });
    expect(verifyConfirmToken(KEY, token, { ...bare, account: 'a' }, { spent: store(), now: NOW })).toMatchObject({ error: 'TOKEN_INVALID' });
    expect(verifyConfirmToken(KEY, token, { ...bare, revision: 'r' }, { spent: store(), now: NOW })).toMatchObject({ error: 'DRAFT_CHANGED' });
  });

  it('rejects a forged, tampered, foreign-key or malformed token as TOKEN_INVALID', () => {
    const { token } = issueConfirmToken(KEY, BINDING, { now: NOW });
    const [prefix, body, sig] = token.split('.').reduce<string[]>((acc, part, i, all) => {
      // prefix is "mcpu.token.v1" (three dot-separated words)
      if (i < 3) acc[0] = acc[0] ? `${acc[0]}.${part}` : part;
      else if (i === all.length - 1) acc[2] = part;
      else acc[1] = part;
      return acc;
    }, []);
    const claims = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'));
    claims.exp += 3_600;
    const forged = `${prefix}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
    const signed = (claimsText: string) => {
      const b = Buffer.from(claimsText).toString('base64url');
      return `mcpu.token.v1.${b}.${createHmac('sha256', KEY).update(`mcpu.token.v1.${b}`).digest('base64url')}`;
    };
    for (const bad of [
      forged,
      `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`,
      issueConfirmToken('z'.repeat(32), BINDING, { now: NOW }).token,
      '', 'garbage', 'mcpu.token.v1.', 'mcpu.token.v1.abc', 'mcpu.token.v1..sig',
      signed('not json'),
      signed('null'),
    ]) {
      expect(verifyConfirmToken(KEY, bad, BINDING, { spent: store(), now: NOW })).toEqual({ ok: false, error: 'TOKEN_INVALID' });
    }
  });

  it('forgets spent tokens once they would have expired anyway', () => {
    const spent = store();
    const first = issueConfirmToken(KEY, BINDING, { now: NOW });
    verifyConfirmToken(KEY, first.token, BINDING, { spent, now: NOW });
    expect(spent.size).toBe(1);
    const later = NOW + 700_000;
    verifyConfirmToken(KEY, issueConfirmToken(KEY, BINDING, { now: later }).token, BINDING, { spent, now: later });
    expect(spent.size).toBe(1);
    expect(verifyConfirmToken(KEY, first.token, BINDING, { spent, now: later })).toEqual({ ok: false, error: 'TOKEN_EXPIRED' });
    spent.clear();
    expect(spent.size).toBe(0);
  });

  it('validates the key and TTL', () => {
    expect(() => issueConfirmToken('short', BINDING)).toThrow(/at least 32 bytes/);
    expect(() => issueConfirmToken(KEY, BINDING, { ttlSeconds: 0 })).toThrow(/ttlSeconds/);
    expect(() => issueConfirmToken(KEY, BINDING, { ttlSeconds: Number.NaN })).toThrow(/ttlSeconds/);
    expect(issueConfirmToken(new Uint8Array(32).fill(7), BINDING).token).toMatch(/^mcpu\.token\.v1\./);
  });

  it('defaults to the real clock and a process-wide store', () => {
    const { token } = issueConfirmToken(KEY, { ...BINDING, target: 'default-store' });
    expect(verifyConfirmToken(KEY, token, { ...BINDING, target: 'default-store' })).toEqual({ ok: true });
    expect(verifyConfirmToken(KEY, token, { ...BINDING, target: 'default-store' })).toEqual({ ok: false, error: 'TOKEN_REUSED' });
  });
});

describe('confirmTokenParam', () => {
  it('is an optional string that says where it comes from', () => {
    expect(confirmTokenParam.parse(undefined)).toBeUndefined();
    expect(confirmTokenParam.parse('x')).toBe('x');
    expect(confirmTokenParam.description).toMatch(/phase-1/);
  });
});

describe('requireConfirmationWithFallback', () => {
  const subject = (overrides: Partial<ConfirmSubject> = {}): ConfirmSubject => ({
    target: 'draft-1',
    revision: 'msg-1',
    payload: { to: 'a@example.com', body: 'hello' },
    preview: { to: 'a@example.com', body: 'hello' },
    ...overrides,
  });
  const base = { action: 'mail.send', message: 'Review and confirm this send:', details: { to: 'a@example.com' } };
  const fallback = (over: Partial<ConfirmTokenFallback> = {}): ConfirmTokenFallback => ({
    key: KEY,
    tool: 'mail_send_draft',
    account: 'me@example.com',
    spent: store,
    subject: vi.fn(() => subject()),
    ...over,
  });
  let store = createSpentTokenStore();
  const parse = (r: unknown) => JSON.parse((r as CallToolResult).content[0]!.type === 'text'
    ? ((r as CallToolResult).content[0] as { text: string }).text : '{}');

  afterEach(() => { store = createSpentTokenStore(); });

  it('without a fallback behaves exactly like requireConfirmation', async () => {
    expect(await requireConfirmationWithFallback(CAN_BE_ASKED, base)).toMatchObject({ resultType: 'input_required' });
    expect(parse(await requireConfirmationWithFallback(CANNOT_BE_ASKED, { ...base, unsupportedNote: 'Use the draft tool.' })))
      .toMatchObject({ reason: 'confirmation-unsupported', note: expect.stringContaining('Use the draft tool.') });
  });

  it('leaves a client that can be prompted on elicitation, never reading the subject', async () => {
    const fb = fallback({ confirmToken: 'mcpu.token.v1.x.y' });
    expect(await requireConfirmationWithFallback(CAN_BE_ASKED, { ...base, tokenFallback: fb })).toMatchObject({ resultType: 'input_required' });
    expect(fb.subject).not.toHaveBeenCalled();
  });

  it('phase 1: previews, issues a token, does not proceed', async () => {
    const r = parse(await requireConfirmationWithFallback(CANNOT_BE_ASKED, { ...base, tokenFallback: fallback() }));
    expect(r).toMatchObject({
      status: 'confirmation-required', confirmed: false, dispatched: false, action: 'mail.send',
      preview: { to: 'a@example.com', body: 'hello' }, ttlSeconds: 600, instruction: CONFIRM_TOKEN_INSTRUCTION,
    });
    expect(r.confirmToken).toMatch(/^mcpu\.token\.v1\./);
  });

  it('phase 2 with a valid token proceeds; a second use is TOKEN_REUSED', async () => {
    const { confirmToken } = parse(await requireConfirmationWithFallback(CANNOT_BE_ASKED, { ...base, tokenFallback: fallback() }));
    expect(await requireConfirmationWithFallback(CANNOT_BE_ASKED, { ...base, tokenFallback: fallback({ confirmToken }) })).toBeUndefined();
    const again = await requireConfirmationWithFallback(CANNOT_BE_ASKED, { ...base, tokenFallback: fallback({ confirmToken }) });
    expect((again as CallToolResult).isError).toBe(true);
    expect(parse(again)).toMatchObject({ status: 'confirmation-rejected', error: 'TOKEN_REUSED', dispatched: false, action: 'mail.send' });
  });

  it('DRAFT_CHANGED carries the fresh preview and a new token that works', async () => {
    const { confirmToken } = parse(await requireConfirmationWithFallback(CANNOT_BE_ASKED, { ...base, tokenFallback: fallback() }));
    const rotated = () => subject({ revision: 'msg-2', preview: { body: 'edited' } });
    const r = await requireConfirmationWithFallback(CANNOT_BE_ASKED, { ...base, tokenFallback: fallback({ confirmToken, subject: rotated }) });
    expect((r as CallToolResult).isError).toBe(true);
    const body = parse(r);
    expect(body).toMatchObject({ error: 'DRAFT_CHANGED', reason: 'revision-changed', preview: { body: 'edited' } });
    expect(body.note).toMatch(/edited since/);
    expect(await requireConfirmationWithFallback(CANNOT_BE_ASKED, { ...base, tokenFallback: fallback({ confirmToken: body.confirmToken, subject: rotated }) }))
      .toBeUndefined();
    const edited = () => subject({ payload: { body: 'x' } });
    expect(parse(await requireConfirmationWithFallback(CANNOT_BE_ASKED, { ...base, tokenFallback: fallback({ confirmToken, subject: edited }) })))
      .toMatchObject({ error: 'DRAFT_CHANGED', reason: 'payload-changed' });
  });

  it('TOKEN_EXPIRED and TOKEN_INVALID send nothing and say what to do', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { confirmToken } = parse(await requireConfirmationWithFallback(CANNOT_BE_ASKED, { ...base, tokenFallback: fallback({ ttlSeconds: 60 }) }));
    vi.setSystemTime(NOW + 61_000);
    expect(parse(await requireConfirmationWithFallback(CANNOT_BE_ASKED, { ...base, tokenFallback: fallback({ confirmToken }) })))
      .toMatchObject({ error: 'TOKEN_EXPIRED', note: expect.stringContaining('WITHOUT confirmToken') });
    expect(parse(await requireConfirmationWithFallback(CANNOT_BE_ASKED, { ...base, tokenFallback: fallback({ confirmToken: 'nope' }) })))
      .toMatchObject({ error: 'TOKEN_INVALID' });
  });

  it('passes a subject read failure back unchanged, and honours a custom instruction', async () => {
    const failure: CallToolResult = { content: [{ type: 'text', text: 'Error: gone' }], isError: true };
    expect(await requireConfirmationWithFallback(CANNOT_BE_ASKED, { ...base, tokenFallback: fallback({ subject: async () => failure }) })).toBe(failure);
    expect(parse(await requireConfirmationWithFallback(CANNOT_BE_ASKED, { ...base, tokenFallback: fallback({ instruction: 'Send only after approval.' }) })))
      .toMatchObject({ instruction: 'Send only after approval.' });
  });

  it('uses the process-wide store when none is given', async () => {
    const fb = (confirmToken?: string) => fallback({ spent: undefined, confirmToken, subject: () => subject({ target: 'default-store-2' }) });
    const { confirmToken } = parse(await requireConfirmationWithFallback(CANNOT_BE_ASKED, { ...base, tokenFallback: fb() }));
    expect(await requireConfirmationWithFallback(CANNOT_BE_ASKED, { ...base, tokenFallback: fb(confirmToken) })).toBeUndefined();
  });

  it('drives both phases through the real client/server path', async () => {
    const write = vi.fn();
    const spent = createSpentTokenStore();
    const harness = await createTestHarness((server) => {
      server.registerTool('send', {
        inputSchema: z.object({ body: z.string(), confirmToken: confirmTokenParam }),
      }, async ({ body, confirmToken }, ctx) => {
        const gate = await requireConfirmationWithFallback(ctx, {
          ...base,
          tokenFallback: { key: KEY, tool: 'send', confirmToken, spent, subject: () => ({ target: '', payload: { body }, preview: { body } }) },
        });
        if (gate) return gate as CallToolResult;
        write(body);
        return textResult({ sent: body });
      });
    });
    const p1 = parseToolResult(await harness.callTool('send', { body: 'hi' })) as { confirmToken: string };
    expect(write).not.toHaveBeenCalled();
    expect(parseToolResult(await harness.callTool('send', { body: 'hi', confirmToken: p1.confirmToken }))).toEqual({ sent: 'hi' });
    expect(write).toHaveBeenCalledTimes(1);
  });
});
