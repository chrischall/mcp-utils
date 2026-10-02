/**
 * Pins docs/CONFIRM-TOKEN.md — the reference spec non-TypeScript ports
 * implement (fleet-audit#1168) — to the source, so the two cannot drift:
 * refusal codes, env variables, token prefixes, every model-facing string
 * (taken from REAL gate results, not re-typed), and the test vector.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson } from './canonical.js';
import { CONFIRM_TOKEN_AUTO_INSTRUCTION, confirmationFromEnv } from './confirm-env.js';
import {
  CONFIRM_TOKEN_INSTRUCTION,
  confirmTokenParam,
  createSpentTokenStore,
  hashConfirmPayload,
  requireConfirmationWithFallback,
  verifyConfirmToken,
} from './confirm-token.js';
import { CONFIRM_FLOW_SENTENCE, CONFIRM_INJECTION_RULE } from './confirm-write.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const DOC = read('../../docs/CONFIRM-TOKEN.md');
const SOURCES = ['./confirm-token.ts', './confirm-env.ts', './confirm-write.ts', './confirmation.ts', './confirm-spent-file.ts']
  .map(read)
  .join('\n');

const CANNOT_BE_ASKED = {
  mcpReq: {
    envelope: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': { extensions: {} },
    },
  },
} as unknown as ServerContext;

function json(result: unknown): Record<string, unknown> {
  const r = result as CallToolResult;
  const first = r.content[0];
  if (first?.type !== 'text') throw new Error('expected a text result');
  return JSON.parse(first.text) as Record<string, unknown>;
}

/** Run the env-layer gate once against a cannot-be-prompted caller. */
async function gate(opts: {
  env?: Record<string, string>;
  confirmToken?: string;
  payload?: unknown;
  revision?: string;
  spent: ReturnType<typeof createSpentTokenStore>;
}) {
  return requireConfirmationWithFallback(
    CANNOT_BE_ASKED,
    confirmationFromEnv({
      action: 'thing.delete',
      message: 'Review and confirm this deletion.',
      tool: 'thing_delete',
      ...(opts.confirmToken === undefined ? {} : { confirmToken: opts.confirmToken }),
      args: { id: 'item-42' },
      subject: () => ({
        target: 'item-42',
        ...(opts.revision === undefined ? {} : { revision: opts.revision }),
        payload: opts.payload ?? { id: 'item-42' },
        preview: { id: 'item-42' },
      }),
      spent: opts.spent,
      env: { MCP_CONFIRM_SECRET: 'doc-test-secret', ...opts.env },
    }),
  );
}

afterEach(() => vi.useRealTimers());

describe('docs/CONFIRM-TOKEN.md matches the implementation', () => {
  it('names exactly the refusal codes the source defines', () => {
    const union = /export type ConfirmTokenError = ([^;]+);/.exec(read('./confirm-token.ts'))?.[1] ?? '';
    const inSource = new Set([...union.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]));
    const inDoc = new Set([...DOC.matchAll(/\b(DRAFT_CHANGED|TOKEN_[A-Z]+)\b/g)].map((m) => m[1]));
    expect(inSource.size).toBe(4);
    expect([...inDoc].sort()).toEqual([...inSource].sort());
    for (const reason of ['revision-changed', 'payload-changed', 'confirmation-unsupported']) {
      expect(SOURCES).toContain(`'${reason}'`);
      expect(DOC).toContain(reason);
    }
  });

  it('documents exactly the env variables the env layer reads', () => {
    const inSource = new Set([...read('./confirm-env.ts').matchAll(/readEnvVar\('(MCP_[A-Z_]+)'/g)].map((m) => m[1]));
    const inDoc = new Set([...DOC.matchAll(/\b(MCP_[A-Z_]*[A-Z])\b/g)].map((m) => m[1]));
    expect([...inSource].sort()).toEqual(['MCP_CONFIRM_MODE', 'MCP_CONFIRM_SECRET', 'MCP_CONFIRM_TTL_SECONDS', 'MCP_DATA_DIR', 'MCP_HOST_CONFIRM_SECRET']);
    expect([...inDoc].sort()).toEqual([...inSource].sort());
  });

  it('uses the token and binding-state prefixes and the spent-store path of the source', () => {
    for (const literal of ["'mcpu.token.v1.'", "'mcpu.confirm.v1.'", "'.mcp-confirm', 'spent'"]) expect(SOURCES).toContain(literal);
    expect(DOC).toContain('"mcpu.token.v1."');
    expect(DOC).toContain('"mcpu.confirm.v1."');
    expect(DOC).toContain('$MCP_DATA_DIR/.mcp-confirm/spent');
  });

  it('quotes the exported model-facing strings verbatim', () => {
    for (const text of [
      confirmTokenParam.description,
      CONFIRM_TOKEN_INSTRUCTION,
      CONFIRM_TOKEN_AUTO_INSTRUCTION,
      CONFIRM_FLOW_SENTENCE,
      CONFIRM_INJECTION_RULE,
    ]) {
      expect(text).toBeTruthy();
      expect(DOC).toContain(text);
    }
  });

  it('shows the phase-1 shape and quotes the refusal notes a real gate returns', async () => {
    const spent = createSpentTokenStore();
    const phase1 = json(await gate({ spent }));
    expect(phase1.status).toBe('confirmation-required');
    for (const key of Object.keys(phase1)) expect(DOC).toContain(`"${key}"`);
    const token = phase1.confirmToken as string;

    expect(await gate({ spent, confirmToken: token })).toBeUndefined(); // accepted, spent
    const reused = json(await gate({ spent, confirmToken: token }));
    const invalid = json(await gate({ spent, confirmToken: 'mcpu.token.v1.nope.nope' }));
    for (const r of [reused, invalid]) {
      expect(r.status).toBe('confirmation-rejected');
      for (const key of Object.keys(r)) expect(DOC).toContain(`"${key}"`);
      expect(DOC).toContain(r.note as string);
    }
    expect([reused.error, invalid.error]).toEqual(['TOKEN_REUSED', 'TOKEN_INVALID']);

    const suffix = ' The current preview and a fresh confirmToken are below.';
    const t2 = json(await gate({ spent, revision: 'v1' })).confirmToken as string;
    const revised = json(await gate({ spent, revision: 'v2', confirmToken: t2 }));
    const changed = json(await gate({ spent, revision: 'v1', payload: { id: 'other' }, confirmToken: t2 }));
    expect([revised.reason, changed.reason]).toEqual(['revision-changed', 'payload-changed']);
    for (const r of [revised, changed]) {
      for (const key of Object.keys(r)) expect(DOC).toContain(`"${key}"`);
      const note = r.note as string;
      expect(note.endsWith(suffix)).toBe(true);
      expect(DOC).toContain(note.slice(0, -suffix.length));
    }
    expect(DOC).toContain(suffix.trim());

    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const t3 = json(await gate({ spent })).confirmToken as string;
    vi.setSystemTime(1_800_000_000_000 + 601_000);
    const expired = json(await gate({ spent, confirmToken: t3 }));
    expect(expired.error).toBe('TOKEN_EXPIRED');
    expect(DOC).toContain(expired.note as string);
  });

  it('quotes the refusal a refuse-mode server gives a client that cannot be prompted', async () => {
    const refused = json(await gate({ spent: createSpentTokenStore(), env: { MCP_CONFIRM_MODE: 'refuse' } }));
    expect(refused.reason).toBe('confirmation-unsupported');
    for (const key of Object.keys(refused)) expect(DOC).toContain(`"${key}"`);
    // The note is the fixed sentence plus the mode's hint; the doc carries both.
    const [sentence, hint] = (refused.note as string).split('. Set ');
    expect(DOC.replace(/\s+/g, ' ')).toContain(sentence!.replace(/\s+/g, ' '));
    expect(DOC.replace(/\s+/g, ' ')).toContain(`Set ${hint}`);
  });

  it("the doc's test vector verifies with the real implementation", () => {
    const vector = DOC.slice(DOC.indexOf('**Test vector.**'));
    const line = (name: string) => new RegExp(`^${name}\\s+= (.+)$`, 'm').exec(vector)?.[1]?.trim();
    const secret = line('MCP_CONFIRM_SECRET')!;
    const key = createHash('sha256').update(secret, 'utf8').digest();
    expect(key.toString('hex')).toBe(line('key \\(hex\\)'));
    const payload = JSON.parse(line('payload')!) as unknown;
    expect(canonicalJson(payload)).toBe(line('canonical\\(payload\\)'));
    const h = hashConfirmPayload(payload);
    expect(h).toBe(line('h'));
    const token = line('token')!;
    const body = token.slice('mcpu.token.v1.'.length).split('.')[0]!;
    expect(Buffer.from(body, 'base64url').toString('utf8')).toBe(line('claims'));
    expect(
      verifyConfirmToken(key, token, {
        tool: 'thing_delete', account: 'me@example.com', target: 'item-42', revision: 'etag-7', payloadHash: h,
      }, { now: 1_800_000_000_000, spent: createSpentTokenStore() }),
    ).toEqual({ ok: true });
  });

  it("the doc's type-tagged canonical example is what canonicalJson produces", () => {
    const out = canonicalJson({
      $id: 1, when: new Date(0), raw: Buffer.from('two'), n: Number.NaN, big: 10n, s: new Set([2, 1]),
    });
    expect(DOC).toContain(out);
  });
});
